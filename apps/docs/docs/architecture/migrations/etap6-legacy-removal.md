---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/migrations/etap6-legacy-removal.md
---

# Этап 6 — Legacy removal (M7)

This is the **migration / deprecation guide** for ТЗ §20 Этап 6 (ledger
`M7-etap6-legacy-removal`). Cutover executes on `pr-m7-etap6-slices`
(after M6 accepted at `f5c37ea`).

## Target state

- One core: the Rust Runtime Kernel.
- One schema: `database.sqlite` (Kernel-owned). `app.db` / Drizzle product
  tables are gone.
- One UI facade: `NeoBackend` (`LocalBackend` / `RemoteBackend` only).
  `LegacyBackend`, `legacyRaw()`, and `/api/v2` product routes are deleted.
- There is **no legacy full-data Compatibility API to preserve**: legacy full-data-era
  plugin compatibility was removed outright by owner decision (2026-10-31,
  ADR-0059 slice) — no Express compatibility host, no `legacy` manifest
  block, no `legacy.trusted` permission, and no migration guide. Only
  legacy full-data **user data** (character cards, chats, backups) keeps
  importing through Settings → Data.

## Status after rounds 60a–60c-1 (2026-11-04)

Done and committed:

- **The public desktop build runs the Kernel by default** (60a): the mode
  resolver no longer consults the build channel, and the sidecar is reachable only
  through `NEOTA_LEGACY_SERVER=1` for one transition window;
- **the shell ships only the kernel** (60a): `DesktopMode`, the spawn/stop
  lifecycle, `tauri-plugin-shell`, the `pkg` snapshot, the `sharp`/`better-sqlite3`
  trees and the `externalBin` entry are deleted; the portable artifact contains no
  `neotavern-server.exe`;
- **`apps/server` and `packages/db` are deleted** (60b), with
  `playwright.legacy.config.ts`, `e2e/legacy/**`, `test:e2e:legacy` and the vitest
  SQLite probe. The starter assets the kernel embeds moved to
  `crates/runtime-kernel/assets/starter`;
- **`UnsupportedError` moved out of `legacyBackend.ts`** (60c-1) into
  `packages/neobackend/src/errors.ts`, so the backend file can be deleted without
  taking the error class with it.

What remains of the legacy plane is **gone from the code** (round 64):

| Surface                         | State                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LegacyBackend` / `legacyRaw()` | deleted. A page without a host gets `createClosedBackend()` from `packages/neobackend/src/closedBackend.ts`: it constructs, and every call rejects with a typed `UnsupportedError` naming the surface (`no-host:chats.get`). The closed nodes are memoized and materialize properties, so `vi.spyOn` can still patch a method in tests. |
| `/api/v2` generation            | deleted with the SSE rendezvous; `streamGeneration` has one transport (`streamWireGeneration`).                                                                                                                                                                                                                                         |
| `isKernelMode()` branches       | still present in hooks as defence in depth, but the false arm can only be reached by a closed backend, which rejects anyway.                                                                                                                                                                                                            |
| Legacy-plane tests              | 15 of them asserted the deleted transport and were removed with it (web suite 872 → 857, root 1158 → 1127).                                                                                                                                                                                                                             |

### Contract gap found while planning 60c-3

The plugin bridge's `chat.messages.append` forwards a plugin-provided
`idempotencyKey` to the legacy REST route, and the outbox retry logic depends on
it (a retried append returns the original message). The wire
`chats.messages.create` request has no such field, and the only `idempotencyKey`
in the contract belongs to generation steps. Converting the handler therefore
requires a decision, not a rewrite:

- **preferred:** add an optional `idempotencyKey` to `chats.messages.create` and
  dedupe in the kernel (unique `(chat_id, idempotency_key)`), so plugin appends
  keep their retry guarantee on the canonical plane;
- alternative: accept the loss explicitly and delete the outbox expectation —
  a behaviour regression, so it needs an owner decision rather than a silent drop.

**Resolved in round 61 (schema v34):** `chats.messages.create` now accepts an
optional `idempotencyKey` (1–128 chars); the kernel answers the ORIGINAL message
for a repeated key in the same chat, and a partial unique index
`(chat_id, idempotency_key)` is the authority. A second gap surfaced with it: the
wire `message.role` union is `system|user|assistant|tool`, so the legacy
`plugin` role has no wire spelling — the bridge will have to map it explicitly
(e.g. to `assistant` with plugin metadata) when 60c-3 lands.

### Packaged proof (round 66)

`apps/desktop/src-tauri/target/release/neotavern.exe` was rebuilt with the legacy
transport gone and the plugin job timer in place, packed by
`scripts/package-portable-windows.mjs` (`NeoTavern_0.1.0_x64-portable.zip`,
SHA-256 `57fd627466e16062f2eca8f6089bbc982c6f6236f845b2a556a4833fb08a8901`) and smoked by
`scripts/smoke-desktop-shell.mjs` (`OK — portable data path, readiness and
kernel-owned database`, exit 0). The MSI branch still fails with `os error 32`
(a file held by the previous build), which is why the portable zip is the
official artifact — unchanged from earlier rounds.

## Plugin install: what works and what does not

Round 75 replaced the dead ZIP upload with a manifest descriptor: the user picks
`manifest.json`, the UI validates the fields the wire requires, and `plugins.install`
records the plugin with `trustState: locally-trusted`. Round 76 deleted
`crates/adapters/package-verify`, which verified signed ZIPs that no plane ever
read.

What that means for a user:

- a plugin **whose code is already in the web bundle** installs by descriptor and
  runs;
- a plugin **shipped as a separate package** cannot be installed, because the
  runtime loads plugin code from the bundle and nothing stages or serves external
  package bytes. Git install refuses with `UnsupportedError` for the same reason.

This is a product gap, not a hidden one: `security.plugin-package-trust` stays
`Implemented` in the capability matrix, and closing it needs a real decision about
where third-party code lives (asset-staged + verified in the kernel, or a host
side loader), plus signing keys the build does not have.

## Migration notes for users of the removed contour

1. **Nothing to migrate by hand for product data.** The kernel opens
   `database.sqlite` in the data root; a legacy `app.db` is imported through
   Settings → Data (ADR-0062 staged-root lifecycle: plan → stage → validate →
   activate → rollback). A failed import keeps the previous root active.
2. **A stale `app.db` is not read implicitly.** There is no silent fallback: a data
   root without `database.sqlite` is an error, and the packaged smoke treats it that
   way.
3. **The sidecar is gone.** `NEOTA_LEGACY_SERVER` no longer exists (round 60a
   removed the switch together with the mode); the desktop shell always embeds the
   kernel. `apps/server/data/` in a developer checkout is untouched user data and
   can be deleted by the owner.
4. **The portable artifact is the release.** `NeoTavern_0.1.0_x64-portable.zip`
   (built by `scripts/package-portable-windows.mjs`, smoked by
   `scripts/smoke-desktop-shell.mjs`) contains the executable, `resources/` and
   `portable.flag`; user data is created in `data/` beside it.

## Cutover sequence (historical)

1. Playwright default boots `neotavern-headless` + `apps/web/dist`; the Fastify
   suite was quarantined as `test:e2e:legacy` and is now deleted.
2. The desktop public default moved to the Kernel (60a).
3. Drizzle product tables and the legacy writer were deleted (60b).
4. `legacyRaw()` removal is the open item: the plugin bridge must become
   kernel-only first (g6, see the table above).
