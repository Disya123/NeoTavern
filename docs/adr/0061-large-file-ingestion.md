# ADR-0061 — Chunked upload as the large-file ingestion contract

**Status:** proposed (implemented on the kernel plane; consumers land per cluster)
**Date:** 2026-11-02
**Supersedes:** nothing. **Related:** ADR-0038 (legacy contour), ADR-0059
(React-primary), ТЗ §5.1 (AssetStore), ТЗ §10.4 (backups), AGENTS.md §12.

## Context

Product Wire requests are JSON, and the contract compiler caps
`requestLimitBytes` at 1 MiB (`packages/contracts/src/wire/registry.ts`). Several
features cannot fit: character cards and wallpapers can reach tens of megabytes,
audio/image inputs are binary, and a SillyTavern backup import is up to 4 GiB.
These are the 22 legacy routes still classified "transport-blocked" in
`docs/architecture/etap4-ui-cutover-registry.md` (clusters 8-tail, 10, 13, 21a,
plus the asset half of cluster 20). Until now the React plane refused them in
kernel mode with `UnsupportedError` and the legacy sidecar kept the feature —
which is precisely the blocker that prevents removing the sidecar.

Two candidate contracts were recorded in §4 of the cutover registry:

1. **Host-staged path** — the host streams the file into the data root itself
   and calls a wire op with a staged id or relative path. Small wire surface, no
   kernel streaming, but the remote Web Client has no such host path (its only
   channel is Product Wire), so the Web Client would need a second, non-canonical
   upload endpoint.
2. **Chunked upload ops** — bounded chunks over Product Wire, assembled by the
   kernel. Uniform for every client (desktop, headless, Android, remote Web),
   keeps Product Wire canonical, at the cost of a mutable staged resource the
   kernel must own, bound and clean up.

## Decision

Adopt **option 2**: a four-operation chunked-upload family, because only it
keeps a single canonical transport for every host and client — the constraint
that ADR-0059 (React-primary, remote Web Client is a product) and ADR-0038
(no second backend surface for new product logic) actually impose.

Contract:

| Op                     | Request                                          | Result                                    | Notes                                                                                                |
| ---------------------- | ------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `assets.upload.begin`  | `kind`, `filename`, `contentType?`, `totalBytes` | `uploadId`, `chunkSizeBytes`, `expiresAt` | `totalBytes` ≤ 4 GiB; sweeps expired uploads                                                         |
| `assets.upload.append` | `uploadId`, `index`, `contentBase64`             | `uploadId`, `receivedBytes`, `nextIndex`  | ≤ 512 KiB raw per chunk; `index` must equal `nextIndex`; over-declared length is a stable refusal    |
| `assets.upload.finish` | `uploadId`                                       | same DTO as `assets.put`                  | refuses an upload whose staged bytes ≠ `totalBytes`; publishes ONE immutable content-addressed asset |
| `assets.upload.abort`  | `uploadId`                                       | `deleted`                                 | idempotent; reclaims staged bytes                                                                    |

Invariants that make the staged resource safe to own:

- **Bytes never enter SQLite.** Chunks grow in
  `<data_root>/staged/<uploadId>/data.part`; the `asset_uploads` row (schema v29)
  is bookkeeping only, so AGENTS.md §11 ("do not store images and audio as BLOBs
  in the main database") holds and a database copy can never contain a
  half-written upload.
- **The declared length is authoritative.** Over-size chunks are refused on
  `append`; `finish` refuses a length mismatch, and the storage layer re-checks
  the file length against the registered size before inserting the asset row, so
  a truncated transfer can never be published.
- **Sequential staging.** `index` must be the upload's `nextIndex`, and the
  staged file length must agree with `receivedBytes` before a chunk is appended;
  a crash between the file write and the row update surfaces as a stable product
  error instead of silently shifting every later chunk.
- **Bounded lifetime.** Uploads expire after 24 h; `begin` sweeps expired rows
  with their bytes, `finish`/`abort` always remove the staged directory.
- **One asset contract.** `finish` returns `wire.result.assets.put`, so a caller
  cannot distinguish a chunked publish from a single-shot one, dedupe by
  `(kind, sha256)` works unchanged, and `assets.content` serves the result.

## Consequences

- The 22 transport-blocked routes become implementable on the kernel plane
  (backup import, wallpapers, plugin blobs, sandbox assets) without a second
  transport, and the legacy sidecar loses its last structural reason to exist.
- The kernel now owns a mutable staging area. It is bounded (4 GiB per upload,
  24 h TTL), self-cleaning, and excluded from the asset plane until `finish`, so
  the data-root invariants (content addressing, GC of orphaned assets) are
  untouched.
- Cost: an extra round trip per 512 KiB and a client that must resume from
  `nextIndex` after a lost chunk. Both are handled by the stable error codes
  (`ASSET_UPLOAD_OUT_OF_ORDER`, `ASSET_UPLOAD_INCOMPLETE`,
  `ASSET_UPLOAD_EXPIRED`, `ASSET_UPLOAD_SIZE_EXCEEDED`,
  `ASSET_UPLOAD_NOT_FOUND`).
- The host-staged variant is not forbidden forever: a local host MAY still hand
  the kernel a path for its own imports, but it is an optimization, not the
  contract, and it cannot be the only path while the remote Web Client is a
  product.

## Alternatives

- **Raise the 1 MiB wire cap** instead of chunking — rejected: it moves the
  limit rather than removing it, and a 4 GiB JSON request cannot be parsed
  incrementally by the current envelope decoder.
- **multipart/form-data on the wire** — rejected: the envelope is JSON with
  typed schemas; multipart would bypass the contract compiler, the size gates
  and the generated DTOs.
- **Store the upload in SQLite as BLOBs** — rejected by AGENTS.md §11 and by the
  backup/rollback story.

## Consumer: chat wallpapers (round 4)

The first feature flipped onto the family is the chat wallpaper picker, and
it is the template for the remaining ones:

- the catalog is a `kind` agreement, not a second store — `assets.list` with
  `kind: "background"` replaces the sidecar directory scan;
- the upload is the same file the legacy route accepted (25 MiB), streamed as
  bounded `assets.upload.append` chunks instead of one multipart body;
- the wallpaper reference moved into the product model:
  `chats.backgroundAssetId` (schema v30, no FK, detached by `assets.delete`),
  with `clearBackground` as the unset spelling because the wire has no
  nullable fields;
- rendering follows the kernel rule "no URL surface": the full image comes
  from `assets.content` as a data URL and grid previews from `assets.thumb`.

What this proves for the rest of the list (backup import, plugin blobs,
sandbox assets, TTS audio): the contract is reusable as-is; only the
consumer-side composition (chunk loop, progress, kind name) is per-feature
work.
