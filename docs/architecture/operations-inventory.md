# Operations Inventory — current `/api/v2` server surface

> **Status.** This document characterizes the **current** HTTP server surface as
> it exists today (Phase 0 start): a single Fastify process serving `/api/v2`
> with TypeBox-validated JSON and SSE. Entries marked **[PLANNED]** describe
> Phase 0 targets (Product Wire, Runtime Kernel, codegen) that are being built
> but are **not yet implemented**. The inventory itself is ground truth taken
> from `apps/server/src` — do not edit it from memory; re-verify against the
> route modules when it disagrees with code.

Related documents: [Wire contracts](wire-contracts.md), [Version axes](version-axes.md),
[ADR-0029](../adr/0029-wire-contract-toolchain.md), [API reference](../api/README.md),
[Data and SQLite](../data/README.md).

## 1. Scope and method

- Every route below is registered from a module in `apps/server/src/plugins/*.ts`;
  the full registration order is in `apps/server/src/app.ts` (`buildApp`).
  ST plugin compatibility removed 2026-10-31 (ADR-0059 slice): the former
  `apps/server/src/legacy/host.ts` Express compatibility host is deleted, and
  its routes below are marked removed.
- Route schemas (request/response) are TypeBox schemas in `packages/contracts/src`
  (single source of truth per ADR-0004) and are never hand-duplicated.
- Data access is Drizzle ORM over better-sqlite3 (WAL) through repositories in
  `packages/db/src/repositories/`; schema DDL in `packages/db/src/schema/tables.ts`;
  migrations in `packages/db/src/migrations/`.
- The HTTP surface is documented for humans in `docs/api/README.md`; that
  document is the user-facing counterpart of this inventory.

## 2. Current server architecture (summary)

> ST plugin compatibility removed 2026-10-31 (ADR-0059 slice): the Express
> compatibility host (`apps/server/src/legacy/host.ts`) is deleted; the
> former "Legacy compat" row was removed from this table.

| Aspect                                  | Current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process                                 | Single Node.js Fastify process (`apps/server/src/main.ts` → `app.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Transport                               | HTTP on `127.0.0.1` by default; optional explicit remote access (`NEOTA_REMOTE_ACCESS`, session + CSRF, `apps/server/src/plugins/remoteAuth.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Validation                              | Fastify schema validation against TypeBox schemas; typed error envelope on failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Storage                                 | SQLite `app.db` (WAL) via `@neotavern/db` (Drizzle repositories) + filesystem under `data/` (`apps/server/src/lib/paths.ts`: `files/{avatars,backgrounds,attachments,audio,generated}`, `cache/thumbnails`, `backups/`, `plugins/`, `themes/`, `logs/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Real-time                               | SSE: `GET /api/v2/events` (app events) and `POST /api/v2/chats/:id/generate` (generation stream)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Target (ТЗ §7)                          | **[IN PROGRESS]** Runtime Kernel in `crates/runtime-kernel` becomes the authoritative writer for product operations; facades `LocalBackend`/`RemoteBackend`/`LegacyBackend` in `packages/neobackend`, transport SDK in `packages/client-sdk`. The web UI routes **every** API call through the `NeoBackend` facade singleton (`apps/web/src/api/backend.ts`): typed wire operations go through `LegacyBackend` mappings in a browser, unmigrated `/api/v2` routes through the temporary `raw` passthrough (removed per-slice in Фаза 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Desktop local (ТЗ §11.1/§15.1, Phase 3) | **[IN PROGRESS — honest staged default]** Backend selection is decided by `desktop_mode()` in `apps/desktop/src-tauri/src/lib.rs` (ADR-0038): **public release builds run the tested legacy Node sidecar** while the Runtime Kernel is an explicit Preview; nightly/internal and debug builds default to the Kernel (`React → LocalBackend → Tauri IPC → Runtime Kernel` over `neotavern-tauri-local` commands `kernel_dispatch` / `kernel_stream_start` / `kernel_stream_abort`, window loads bundled web assets via `tauri://localhost`, no HTTP server/listener, §11.1). Explicit overrides: `NEOTA_LEGACY_SERVER=1` forces the sidecar, `NEOTA_KERNEL=1` forces the Kernel, and when both are set `NEOTA_KERNEL=1` wins (conflict policy, ADR-0038; unit-tested mode matrix). The legacy Node sidecar stays as the public-release default and the explicit `NEOTA_LEGACY_SERVER=1` transition bridge for unmigrated routes. Shared envelope layer moved to `crates/adapters/envelope` (byte-identical envelopes across CLI/HTTP/Tauri, §6.3). First vertical slice shipped: DiagnosticsPanel kernel section (kernel meta + backups via NeoBackend, marked **Kernel Preview**). Read-surface cutover (character/chat browse) is the next slice — the frozen wire registry carries no avatar URL/chat-create ops, so those UI paths stay legacy until the contract grows. |

## 3. Error model

All errors cross the HTTP boundary as a stable machine-readable envelope
(never a ready-made English string):

```json
{ "code": "CHARACTER_NOT_FOUND", "params": { "characterId": "..." }, "traceId": "..." }
```

- `code` — SCREAMING_SNAKE_CASE, canonical set in `ErrorCodes`
  (`packages/shared/src/error.ts`), grouped by domain (generic, characters,
  chats/messages, personas, lorebooks, presets, profiles, connection profiles,
  providers/generation, provider secrets, plugins/themes, resource governance,
  files/storage, backup/migration, search).
- `params` — serializable structured parameters used for client localization.
- `traceId` — added by the API layer, not by `AppError.toJSON()` (which emits
  only `{ code, params }`); generated per request in
  `apps/server/src/lib/errors.ts` (`registerErrorHandler`).
- HTTP status is derived from the code (`DEFAULT_STATUS` in
  `packages/shared/src/error.ts`); `AppError` may carry an explicit `httpStatus`.
- Notable handler branches (`apps/server/src/lib/errors.ts`):
  - `FST_REQ_FILE_TOO_LARGE` / `FST_ERR_CTP_BODY_TOO_LARGE` → 413 `FILE_TOO_LARGE`;
  - Fastify schema validation failure → 422 `VALIDATION` with up to 20
    `{ path, message }` issues;
  - other Fastify-native client errors (malformed JSON, unsupported content
    type) → 4xx `BAD_REQUEST`;
  - everything else → `AppError` (`toAppError` normalizes unknown values to
    INTERNAL) with the mapped status.
- **[PLANNED]** The Product Wire error model (`packages/contracts/src/wire/errors.ts`)
  adds wire-level codes (`INTERNAL`, `VALIDATION`, `CONTRACT_VIOLATION`,
  `NOT_FOUND`, `CONFLICT`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`,
  `OUTCOME_UNKNOWN`, `DATA_ROOT_IN_USE`, `UNSUPPORTED_SCHEMA`,
  `RECOVERY_REQUIRED`, `CANCELLED`, `PROVIDER_ERROR`, `QUOTA_EXCEEDED`) and a
  `ContractViolation` payload for validation failures inside the kernel
  (see [wire-contracts.md](wire-contracts.md)).

## 4. Route families (overview)

| Family             | Source module                     | Endpoints                                                                                        |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| meta               | `apps/server/src/plugins/meta.ts` | health, version                                                                                  |
| characters         | `plugins/characters.ts`           | list, create, get, patch, delete, restore, versions                                              |
| characterGallery   | `plugins/characterGallery.ts`     | avatar-original, gallery CRUD                                                                    |
| characterTransfer  | `plugins/characterTransfer.ts`    | import, export, asset serving                                                                    |
| backgrounds        | `plugins/backgrounds.ts`          | list, create, delete, asset serving                                                              |
| backups            | `plugins/backups.ts`              | create, list, delete, restore                                                                    |
| chats              | `plugins/chats.ts`                | chats CRUD + restore, messages, revisions, drafts, swipes, variants, snapshots, branches, export |
| messageBlocks      | `plugins/messageBlocks.ts`        | block list/create/patch/delete                                                                   |
| connectionProfiles | `plugins/connectionProfiles.ts`   | CRUD + apply                                                                                     |
| dataImports        | `plugins/dataImports.ts`          | SillyTavern analyze/execute/delete/direct import                                                 |
| diagnostics        | `plugins/diagnostics.ts`          | snapshot, cache cleanup (diagnostics.export partial + diagnostics.cache.clear M7)                |
| events             | `plugins/events.ts`               | SSE event stream                                                                                 |
| generate           | `plugins/generate.ts`             | generation SSE, context-audit, context-preview, plugin-intercepts                                |
| lorebooks          | `plugins/lorebooks.ts`            | CRUD + restore, entries CRUD                                                                     |
| memories           | `plugins/memories.ts`             | CRUD                                                                                             |
| personas           | `plugins/personas.ts`             | CRUD                                                                                             |
| presets            | `plugins/presets.ts`              | CRUD                                                                                             |
| profiles           | `plugins/profiles.ts`             | list, export, patch                                                                              |
| providers          | `plugins/providers.ts`            | catalog, CRUD, models, test, speech, images, transcribe                                          |
| secrets            | `plugins/secrets.ts`              | exposure flag, provider secret CRUD + reveal                                                     |
| settings           | `plugins/settings.ts`             | get, instruct-formats, patch                                                                     |
| search             | `plugins/search.ts`               | search, FTS rebuild                                                                              |
| themes             | `plugins/themes.ts`               | list, boot, install, activate, settings, assets, user.css                                        |
| plugins            | `plugins/plugins.ts`              | install, lifecycle, sandbox, capabilities, assets                                                |
| pluginAuth         | `plugins/pluginAuth.ts`           | OAuth connections                                                                                |
| pluginData         | `plugins/pluginData.ts`           | state, blobs                                                                                     |
| pluginJobs         | `plugins/pluginJobs.ts`           | job list/create/ack/retry/cancel/delete                                                          |
| remoteAuth         | `plugins/remoteAuth.ts`           | auth session                                                                                     |

## 5. Endpoints by family

> ST plugin compatibility removed 2026-10-31 (ADR-0059 slice): the `legacy`
> route module and `GET /api/v2/plugins/:id/legacy.js` are gone from the
> lists below.

### meta — `apps/server/src/plugins/meta.ts`

- `GET /api/v2/health` → `{ status: "ok", uptime }`
- `GET /api/v2/version` → `{ name: "NeoTavern", version: APP_VERSION, apiVersion: API_VERSION }`

Constants live here: `APP_VERSION = '0.1.0'`, `API_VERSION = 2`.

### characters — `apps/server/src/plugins/characters.ts`

- `GET /api/v2/characters` — cursor-paginated list; querystring supports
  `cursor`, `limit`, `tag`, `q` (character search syntax), `sort`,
  `includeDeleted` (`CharacterListQuerySchema`).
- `POST /api/v2/characters` — create (`CharacterCreateSchema`).
- `GET /api/v2/characters/:id` — get.
- `PATCH /api/v2/characters/:id` — update.
- `DELETE /api/v2/characters/:id` — soft delete (trash); `?purge=true`
  empties the trash entry (kernel plane: `characters.delete` `purge` flag,
  M7 Etap-4 cluster 26).
- `POST /api/v2/characters/:id/restore` — restore from trash (kernel plane:
  `characters.restore`).
- `GET /api/v2/characters/:id/versions` — version history (kernel plane:
  `characters.versions.list`).
- `POST /api/v2/characters/:id/versions/:versionId/restore` — restore a
  version; the current state is snapshotted first (kernel plane:
  `characters.versions.restore`).

### characterGallery — `apps/server/src/plugins/characterGallery.ts`

- `GET /api/v2/characters/:id/avatar-original` — original avatar file
  (redirects/streams from `files/avatars/`).
- `GET /api/v2/characters/:id/gallery` — gallery list.
- `POST /api/v2/characters/:id/gallery` — add image (multipart).
- `DELETE /api/v2/characters/:id/gallery/:imageId` — remove image.

### characterTransfer — `apps/server/src/plugins/characterTransfer.ts`

- `POST /api/v2/characters/import` — Character Card import (multipart; accepts
  JSON Character Card V1/V2 and PNGs with `chara` metadata; input limited to
  25 MiB).
- `GET /api/v2/characters/:id/export` — export as Character Card.
- `GET /api/v2/assets/avatars/:filename` — immutable avatar asset.
- `GET /api/v2/assets/thumbnails/:filename` — regenerable thumbnail asset.

### backgrounds — `apps/server/src/plugins/backgrounds.ts`

**Transport-blocked on the kernel plane (Этап-4 registry cluster 13).** The
upload is multipart up to the legacy 25 MiB cap (a wire request is JSON and
`assets.put` admits 1 MiB), and serving originals above the 4 MiB
`assets.content` cap would fail for real wallpapers — the same large-file
ingestion contract gap as clusters 8-tail/10. `list`/`delete` alone would ship
a wallpaper manager that cannot add wallpapers, so the four routes stay
legacy-side until that contract exists.

- `GET /api/v2/backgrounds` — catalog (directory scan of `files/backgrounds/`).
- `POST /api/v2/backgrounds` — upload (multipart).
- `DELETE /api/v2/backgrounds/:id` — delete.
- `GET /api/v2/assets/backgrounds/:filename` — asset serving.

### backups — `apps/server/src/plugins/backups.ts`

- `POST /api/v2/backups` — create: SQLite online-backup snapshot copy of
  `app.db` into `data/backups/` as `backup-<timestamp>.db`.
- `GET /api/v2/backups` — list (`{ items: Backup[] }`); `Backup` =
  `{ id, kind: 'manual' | 'auto', createdAt, sizeBytes }`
  (`packages/contracts/src/backup.ts`).
- `DELETE /api/v2/backups/:id` — delete a snapshot.
- `POST /api/v2/backups/:id/restore` — restore; a safety backup of the current
  database is always taken before restoring. Runs exclusively under the global
  maintenance lock (ТЗ §10.4): while held, new product mutations are rejected
  with `MAINTENANCE_MODE` (503) and no second restore can enter
  (`apps/server/src/lib/maintenance.ts`).

### chats — `apps/server/src/plugins/chats.ts`

Chats:

- `GET /api/v2/chats` — cursor-paginated list (`sort=manual|recent`).
- `POST /api/v2/chats` — create (`ChatCreateSchema`).
- `GET /api/v2/chats/:id` — get.
- `PATCH /api/v2/chats/:id` — update (title, character, `backgroundId`, …).
- `DELETE /api/v2/chats/:id` — soft delete.
- `POST /api/v2/chats/:id/restore` — restore.
- `GET /api/v2/chats/:id/branches` — list branches.
- `GET /api/v2/chats/:id/export` — chat export.
- `PUT /api/v2/chats/order` — persist the manual chat order
  (`ChatReorderSchema`; the drag-and-drop order used by `sort=manual`).

Messages:

- `GET /api/v2/chats/:id/messages` — cursor-paginated list (optional
  `branchId`).
- `POST /api/v2/chats/:id/messages` — create.
- `PATCH /api/v2/chats/:id/messages/:messageId` — update.
- `DELETE /api/v2/chats/:id/messages/:messageId` — delete.
- `GET /api/v2/chats/:id/messages/:messageId/revisions` — manual-edit history
  (migration 0021).
- `POST /api/v2/chats/:id/messages/:messageId/revisions/:revisionId/restore` —
  restore a revision.

Drafts:

- `POST /api/v2/chats/:id/drafts` — create draft.
- `PATCH /api/v2/chats/:id/drafts/:draftId` — update draft.
- `POST /api/v2/chats/:id/drafts/:draftId/commit` — commit draft to a message.
- `DELETE /api/v2/chats/:id/drafts/:draftId` — discard draft.

Swipes / variants / snapshots:

- `POST /api/v2/chats/:id/messages/:messageId/swipe` — regenerate (new
  variant).
- `GET /api/v2/chats/:id/messages/:messageId/variants` — variant list.
- `POST /api/v2/chats/:id/messages/:messageId/variants/:variantId/activate` —
  activate a variant.
- `POST /api/v2/chats/:id/snapshots` — create a checkpoint snapshot
  (freezes the active branch prefix; branching off an inactive branch is
  refused).

### messageBlocks — `apps/server/src/plugins/messageBlocks.ts`

**Covered (M7 Этап-4 cluster 15).** The four routes are served by the kernel
(`chats.blocks.list`, `chats.blocks.attach`, `blocks.update`,
`blocks.delete`; schema v25 `message_blocks`, attach order = `created_at,
id`). The attachment is durable DATA — owning plugin, block type, renderer id,
immutable attach-time descriptor and the renderer state captured by
`blocks.freeze` — and cascades from both the message and the plugin, so an
uninstall leaves no orphans. `apps/web/src/plugins/kernel/blocks.ts` reaches
them through the wire bridge (`readMessageBlocks` / `attachMessageBlock` /
`updateMessageBlock` / `deleteMessageBlock`); the legacy plane keeps these
routes.

- `GET /api/v2/chats/:id/blocks` — batch block read for a page of messages
  (wire `chats.blocks.list`; ≤100 message ids, only attachments of messages
  that belong to the chat are returned).
- `POST /api/v2/chats/:id/messages/:messageId/blocks` — attach a block (wire
  `chats.blocks.attach`; `CHAT_NOT_FOUND` / `MESSAGE_NOT_FOUND` /
  `PLUGIN_NOT_FOUND`).
- `PATCH /api/v2/blocks/:blockId` — update the descriptor and/or persist the
  renderer state (wire `blocks.update`; the legacy `serializedState: null`
  clearing patch is the wire `clearSerializedState: true`, and supplying both
  is a `VALIDATION`).
- `DELETE /api/v2/blocks/:blockId` — delete (wire `blocks.delete`;
  `BLOCK_NOT_FOUND` when already gone).

Honest boundaries: `descriptor`/`serializedState` are free-form JSON OBJECTS
on the wire (the legacy plane stored any JSON value; a scalar is refused with
`VALIDATION`/`UnsupportedError`, never coerced), and the cross-client
`chat.message.block.changed` event is not pushed on the kernel plane yet — it
belongs to the kernel event plane (cluster 18), so another client sees a block
change on its next load.

### connectionProfiles — `apps/server/src/plugins/connectionProfiles.ts`

Legacy-only surface, documented **N/A** in the Этап-4 registry (cluster 9):
no React consumer (the AI Settings API tab manages provider configs through
`providers.config.*`), and the bundle semantics depend on the legacy provider
model (`chat`/`text` mode, `assistantPrefill`, provider `settings.source`)
that the kernel replaced. The rows reference provider configs, which the
legacy→kernel conversion never copies, so the routes retire with the sidecar.
Canonical equivalents: `providers.config.*` + `providers.secrets.*` +
`presets.*`.

- `GET /api/v2/connection-profiles` — list (N/A).
- `POST /api/v2/connection-profiles` — create (N/A).
- `GET /api/v2/connection-profiles/:id` — get (N/A).
- `PATCH /api/v2/connection-profiles/:id` — update (N/A).
- `DELETE /api/v2/connection-profiles/:id` — delete (N/A).
- `POST /api/v2/connection-profiles/:id/apply` — apply a profile (provider +
  secret + generation configuration; N/A — writes legacy provider `settings`
  keys the kernel adapters do not read).

### dataImports — `apps/server/src/plugins/dataImports.ts`

**Transport-blocked on the kernel plane (Этап-4 registry cluster 10).** The
archive is multipart and may reach the legacy 4 GiB cap, while a wire request
is JSON (`assets.put` admits 1 MiB) and the kernel is a synchronous single
writer, so the kernel cannot own this flow until a large-file ingestion
contract exists (host-staged path or chunked upload ops). The React hooks
refuse honestly in kernel mode (`UnsupportedError`) instead of falling back to
the sidecar.

SillyTavern full-backup transfer (two-phase):

- `POST /api/v2/imports/sillytavern/analyze` — stream, hash and safely unpack
  the archive into temporary staging; read-only analysis (no `import_jobs`,
  no library writes). Staging TTL 30 minutes, at most 3 analyses kept.
- `POST /api/v2/imports/sillytavern/:analysisId/execute` — creates a protective
  SQLite backup, then writes the selected data.
- `DELETE /api/v2/imports/sillytavern/:analysisId` — cancel/cleanup staging.
- `POST /api/v2/imports/sillytavern` — direct (one-shot) import.
- Size limits: single entry 1 GiB; Character Card/avatar 25 MiB
  (`MAX_SILLYTAVERN_ARCHIVE_BYTES`).

### diagnostics — `apps/server/src/plugins/diagnostics.ts`

- `GET /api/v2/diagnostics` — read-only `DiagnosticsSnapshot` (runtime/API
  version, `PRAGMA quick_check`, migration `schemaVersion`/`migrationCount`,
  entity counts, directory usage, disk). Kernel plane: `diagnostics.export`
  returns the SEC-07 allowlist bundle instead of the legacy rich snapshot, so
  this route stays a documented **partial** — the panel maps both planes
  honestly rather than fabricating legacy fields.
- `DELETE /api/v2/diagnostics/cache` — cache cleanup (thumbnails; kernel
  plane: `diagnostics.cache.clear`, M7 Этап-4 cluster 23 — deletes the
  regenerable `<data-root>/cache/` tree only, recreates it empty, never
  touches `files/`, and reports `metadataRowsRemoved: 0` because the kernel
  keeps no cache-metadata rows).

### events — `apps/server/src/plugins/events.ts`

- `GET /api/v2/events` — SSE stream of relayed app events for TanStack Query
  invalidation and multi-tab sync. Envelope and whitelist are defined once in
  `packages/contracts/src/events.ts` (`AppEventEnvelopeSchema`,
  `BROWSER_APP_EVENTS`); see [Streaming surface](#6-streaming-surface-sse).

### generate — `apps/server/src/plugins/generate.ts`

- `POST /api/v2/chats/:id/generate` — SSE streaming generation: runs the prompt
  pipeline, streams provider events, persists user and assistant messages,
  aborts on client disconnect.
- `GET /api/v2/chats/:id/context-audit` — M7 Etap-4 cluster 17 part 1: covered
  on the kernel plane by `chats.context.audit` — the chat's LATEST durable
  `wire.prompt.plan` (same shape as `generation.prompt.plan`; the plan is
  omitted when the chat has no generation yet, unknown chats get
  `CHAT_NOT_FOUND`). Honest boundary: the kernel plan is the leaner
  kernel-pipeline contract (system blocks, selected history, token budget,
  excluded ids) and does not carry the legacy audit's per-template-block
  entries — the template editor keeps its local estimates in kernel mode,
  while the PromptPlanPanel falls back to the chat's latest plan when a
  requested run has none.
- `POST /api/v2/context-preview` — covered by `chats.prompt.preview` (M7
  cluster 17 part 2): the SAME planning pipeline the durable plan records
  (character/persona/lorebook/memory blocks, bounded history, token budget,
  context shifting) built WITHOUT a generation run — nothing persisted, no
  message created, no provider contacted. It answers `wire.prompt.preview`,
  the plan shape minus the run identity (a preview can never masquerade as a
  run), with `CHAT_NOT_FOUND` for an unknown chat and
  `PROVIDER_CONFIG_NOT_FOUND` for a dangling active profile. Honest
  boundaries: the kernel planner is chat-scoped, so the legacy NEW-chat branch
  (character + greeting, no chat yet) has no kernel counterpart — the
  composer meter keeps its labeled local estimate there — and the preview
  budgets with the kernel's own heuristic tokenizer
  (`approximateTokens: true`), never the sidecar's model tokenizer.
- `POST /api/v2/plugin-intercepts/:requestId` — plugin intercept callback
  (`requestId` 16..200 chars); blocked on the kernel plugin host (clusters
  20–21) — nothing runs interceptors on the kernel plane yet.

### lorebooks — `apps/server/src/plugins/lorebooks.ts`

- `GET /api/v2/lorebooks` — list (with optional filtering).
- `POST /api/v2/lorebooks` — create.
- `GET /api/v2/lorebooks/:id` — get.
- `PATCH /api/v2/lorebooks/:id` — update.
- `DELETE /api/v2/lorebooks/:id` — soft delete.
- `POST /api/v2/lorebooks/:id/restore` — restore.
- `GET /api/v2/lorebooks/:id/entries` — list entries.
- `POST /api/v2/lorebooks/:id/entries` — create entry.
- `PATCH /api/v2/lorebooks/:id/entries/:entryId` — update entry.
- `DELETE /api/v2/lorebooks/:id/entries/:entryId` — delete entry.

### memories — `apps/server/src/plugins/memories.ts`

- `GET /api/v2/memories` — list (filtered).
- `POST /api/v2/memories` — create (character-scoped memories require
  `characterId`).
- `PATCH /api/v2/memories/:id` — update.
- `DELETE /api/v2/memories/:id` — delete.

### personas — `apps/server/src/plugins/personas.ts`

- `GET /api/v2/personas` — list.
- `POST /api/v2/personas` — create.
- `GET /api/v2/personas/:id` — get.
- `PATCH /api/v2/personas/:id` — update.
- `DELETE /api/v2/personas/:id` — delete.

### presets — `apps/server/src/plugins/presets.ts`

- `GET /api/v2/presets` — list.
- `POST /api/v2/presets` — create.
- `GET /api/v2/presets/:id` — get.
- `PATCH /api/v2/presets/:id` — update.
- `DELETE /api/v2/presets/:id` — delete.

### profiles — `apps/server/src/plugins/profiles.ts`

- `GET /api/v2/profiles` — list.
- `GET /api/v2/profiles/export` — portable profile export archive
  (SEC-02 logical allowlist, format v2: `manifest.json` with the exported
  tables/counts, exclusions and redactions, one `data/<table>.jsonl` per
  allowlisted table, and `files/`; no DB snapshot; see
  [version-axes.md](version-axes.md)).
- `PATCH /api/v2/profiles/:id` — update.

### providers — `apps/server/src/plugins/providers.ts`

- `GET /api/v2/providers/catalog` — built-in catalog
  (`adapterKind` per source, default URL, key requirements; kernel plane:
  `providers.catalog` — only the sources the kernel can materialize, M7
  Etap-4 cluster 7).
- `GET /api/v2/providers` — configured providers (kernel plane:
  `providers.config.list`, value-free `hasApiKey`).
- `POST /api/v2/providers` — create (kernel plane: `providers.config.set`).
- `PATCH /api/v2/providers/:id` — update (`providers.config.set`).
- `DELETE /api/v2/providers/:id` — delete (`providers.config.delete`; also
  revokes the named key values through the SecretStore).
- `GET /api/v2/providers/:id/models` — model discovery (validates
  connectivity; kernel plane: `providers.models`, M7 Etap-4 cluster 8 — live
  `GET {baseUrl}/models` for the addressed config, `CAPABILITY_UNAVAILABLE`
  when the adapter cannot enumerate rather than a synthesized list).
- `POST /api/v2/providers/:id/test` — message test (kernel plane:
  `providers.test` — one non-streaming message through the addressed model,
  bounded, returning text + attempt accounting).
- `POST /api/v2/providers/:id/speech` — TTS (no kernel counterpart yet: binary
  payloads need a media transport contract).
- `POST /api/v2/providers/:id/images` — image generation (same tail).
- `POST /api/v2/providers/:id/transcribe` — STT (same tail).

### secrets — `apps/server/src/plugins/secrets.ts`

- `GET /api/v2/secrets/exposure` — whether plaintext exposure is allowed
  (`NEOTA_ALLOW_SECRETS_EXPOSURE`; kernel plane: `secrets.exposure`, the host
  maps the same flag through `Kernel::set_secrets_exposure`, default off).
- `GET /api/v2/providers/:id/secrets` — list (masked values; kernel plane:
  `providers.secrets.list` — the mask derives from the opaque reference).
- `POST /api/v2/providers/:id/secrets` — create (several named keys, one
  active; `providers.secrets.create`).
- `PATCH /api/v2/providers/:id/secrets/:secretId` — update
  (`providers.secrets.update`; activating one key deactivates its siblings).
- `DELETE /api/v2/providers/:id/secrets/:secretId` — delete
  (`providers.secrets.delete`; the most recent remaining key is reactivated).
- `POST /api/v2/providers/:id/secrets/:secretId/reveal` — plaintext reveal
  (behind the explicit exposure flag; off by default; `providers.secrets.reveal`
  is the only value-carrying wire operation and fails closed with
  `SECRETS_EXPOSURE_DISABLED` when the policy is off).

### settings — `apps/server/src/plugins/settings.ts`

- `GET /api/v2/settings` — `AppSettings`.
- `GET /api/v2/settings/instruct-formats` — available instruct formats
  (ChatML/Llama3/Alpaca/…).
- `PATCH /api/v2/settings` — update.

### search — `apps/server/src/plugins/search.ts`

- `GET /api/v2/search` — FTS5 search across characters/chats/messages
  (kernel plane: `search.query` over the v23 FTS5 indexes; the trash filter
  stays a query-time concern, M7 Etap-4 cluster 16).
- `POST /api/v2/search/rebuild` — manual FTS index rebuild (ТЗ §12; kernel
  plane: `search.rebuild`, transactional wipe + repopulation).

### themes — `apps/server/src/plugins/themes.ts`

**Partially covered (М7 Этап-4 cluster 14).** The settings pair is served by
the kernel (`themes.settings.get` / `themes.settings.update`; the persisted
values live in the kernel's shared non-secret `settings` table under the
legacy `theme.settings.<id>` key — no schema change). Reads return the
manifest-merged view: every manifest-declared setting id resolved to its
persisted value when that value still validates against the declared type,
else the manifest default (or null); undeclared stored keys are never
surfaced. Updates are a validated PARTIAL merge — every supplied key must be
declared in the theme manifest and pass its type validation (a color is a
≤100-char string without CSS constructs — THEME-45; booleans, finite numbers
and declared select options pass), and one bad key refuses the whole patch
before any write. `apps/web/src/api/wireBridge.ts` reaches them through
`readThemeSettings` / `updateThemeSettings`; `ThemeSync` applies the merged
values as the manifest-declared CSS custom properties on both planes.

- `GET /api/v2/themes` — installed themes (wire `themes.list`).
- `GET /api/v2/themes/boot` — **transport-blocked, not wire-closable**: the
  consumer is a pre-hydration inline `index.html` fetch (anti-FOUC), which
  cannot ride the app-bundle wire bridge; the kernel plane needs a
  host-native HTTP route (the same family as the cluster-18 events SSE). The
  client paints defaults when the fetch fails.
- `POST /api/v2/themes/install` — wire `themes.install`, partial (the host
  package verifier / SEC-05 publish step has no web-transport command; the
  React plane refuses honestly).
- `POST /api/v2/themes/:id/activate` — wire `themes.activate`.
- `DELETE /api/v2/themes/active` — wire `themes.deactivate`.
- `GET /api/v2/themes/:id/settings` — wire `themes.settings.get` (cluster
  14).
- `PATCH /api/v2/themes/:id/settings` — wire `themes.settings.update`
  (cluster 14).
- `DELETE /api/v2/themes/:id` — wire `themes.uninstall`.
- `GET /api/v2/themes/:id/assets/*` — **N/A on the kernel plane**: the wire
  theme model carries exactly one content-addressed CSS asset
  (`assets.put` kind `theme-css`, resolved by the bridge to a `data:` URI
  through `assets.content`); the legacy per-theme file tree has no kernel
  counterpart and retires with the sidecar.
- `GET /api/v2/user.css` — **transport-blocked**: a data-root FILE served
  raw as a stylesheet; the kernel owns no user stylesheet until the
  file-serving contract lands, so kernel mode honestly loads none
  (`userCssUrl()` → null).

### plugins — `apps/server/src/plugins/plugins.ts`

- `GET /api/v2/plugins` — installed plugins.
- `POST /api/v2/plugins/install` — install `.stplugin` package (constrained ZIP
  with `plugin.json`).
- `POST /api/v2/plugins/install-git` — install from git source.
- `POST /api/v2/plugins/:id/activate` — activate.
- `POST /api/v2/plugins/:id/disable` — disable.
- `DELETE /api/v2/plugins/:id` — uninstall.
- `POST /api/v2/plugins/runtime/safe-mode` — enable safe mode.
- `DELETE /api/v2/plugins/runtime/safe-mode` — disable safe mode.
- `GET /api/v2/plugins/:id/sandbox` — sandbox status.
- `GET /api/v2/plugins/:id/sandbox.js` — sandbox script (CORS `*`, GET).
- `GET /api/v2/plugins/:id/capabilities` — capability grants.
- `POST /api/v2/plugins/:id/capabilities` — update grants.
- `GET /api/v2/plugins/:id/assets/*` — plugin assets (CORS `*`, GET).

### pluginAuth — `apps/server/src/plugins/pluginAuth.ts`

- `GET /api/v2/plugins/:id/auth/connections` — OAuth connection list.
- `POST /api/v2/plugins/:id/auth/connect` — start connect flow.
- `POST /api/v2/plugins/:id/auth/revoke` — revoke.
- `POST /api/v2/plugins/:id/auth/fetch` — fetch a token for a backend RPC
  (token payload never leaves the server module).
- `GET /api/v2/plugins/:id/auth/callback` — OAuth callback
  (`redirect_uri` = `{publicOrigin}/api/v2/plugins/:id/auth/callback`).

### pluginData — `apps/server/src/plugins/pluginData.ts`

- `GET /api/v2/plugins/:id/state` — plugin state (CAS-guarded).
- `PUT /api/v2/plugins/:id/state` — write state.
- `DELETE /api/v2/plugins/:id/state` — delete state.
- `GET /api/v2/plugins/:id/blobs` — blob list.
- `GET /api/v2/plugins/:id/blobs/:blobId` — blob download.
- `DELETE /api/v2/plugins/:id/blobs/:blobId` — delete blob.

### pluginJobs — `apps/server/src/plugins/pluginJobs.ts`

- `GET /api/v2/plugins/:id/jobs` — job list.
- `POST /api/v2/plugins/:id/jobs` — create job.
- `POST /api/v2/plugins/:id/jobs/:jobId/ack` — acknowledge.
- `POST /api/v2/plugins/:id/jobs/:jobId/retry` — retry.
- `POST /api/v2/plugins/:id/jobs/:jobId/cancel` — cancel.
- `DELETE /api/v2/plugins/:id/jobs/:jobId` — delete.

### pluginSecrets — `apps/server/src/plugins/pluginSecrets.ts`

(Mounted inside `registerPluginRoutes`, like pluginAuth/pluginData/pluginJobs.)

- `PUT /api/v2/plugins/:id/secrets/:key` — store a plugin secret
  (SecretStore reference, value never persisted in app.db).
- `GET /api/v2/plugins/:id/secrets` — masked secret list.
- `DELETE /api/v2/plugins/:id/secrets/:key` — delete a secret.
- `POST /api/v2/plugins/:id/secrets/:key/reveal` — reveal once
  (consent-gated; the value is returned in the response body by design).

### remoteAuth — `apps/server/src/plugins/remoteAuth.ts`

**N/A on the kernel plane (Этап-4 registry cluster 22):** the three routes are
the legacy HTTP transport's browser-session layer (bootstrap token → bounded
HttpOnly cookie + in-memory CSRF). Cookies and CSRF headers are not
expressible in transport-neutral Product Wire DTOs, and the kernel plane
already authenticates at the layer where this belongs: the `remote-http`
adapter's pairing credentials (random bearer token returned exactly once,
revocable, capped, constant-time verification, audit events) carried by the
Web Client's HostConnect flow as `Authorization: Bearer`; local planes (Tauri
IPC, loopback) need no auth, and the session hook reports the honest
`{ required: false, authenticated: true }` there. The routes retire with the
sidecar.

- `GET /api/v2/auth/session` — current session (N/A).
- `POST /api/v2/auth/session` — create session (login; N/A).
- `DELETE /api/v2/auth/session` — destroy session (N/A).

Loopback mode needs no auth; non-loopback startup requires
`NEOTA_REMOTE_ACCESS=true`, a token and a trusted public origin
(bounded HttpOnly/SameSite session + in-memory CSRF token).

### legacy — removed

ST plugin compatibility removed 2026-10-31 (ADR-0059 slice). The Express
compatibility host (`apps/server/src/legacy/host.ts`), the
`/api/v2/legacy/extension-settings` routes, and trusted legacy server plugins
(`legacy.trusted`, each mounted under its own Express router) no longer
exist. SillyTavern user-data import (characters, chats, backups) is
unaffected and remains on `plugins/dataImports.ts`.

## 6. Streaming surface (SSE)

Two SSE surfaces exist today; both are plain text/event-stream responses
(`apps/server/src/lib/sse.ts`):

1. **App events** — `GET /api/v2/events`: relays whitelisted app events for
   cache invalidation/multi-tab sync. The envelope and whitelist are the single
   source in `packages/contracts/src/events.ts`:
   `{ type: "event", event: "<name>", payload?: unknown }`, with
   `BROWSER_APP_EVENTS` = `chat.created`, `chat.opened`,
   `chat.message.created`, `chat.message.updated`, `chat.message.deleted`,
   `character.selected`, `generation.started`, `generation.delta`,
   `generation.finished`, `generation.error`.
2. **Generation stream** — `POST /api/v2/chats/:id/generate`: streams provider
   events; aborts when the client disconnects.

**[PLANNED]** The Product Wire replaces ad-hoc frames with typed envelopes
(`wire.event.envelope` with `streamId`, `sequence`, `type`, `payload`) and a
typed `generation.*` event union (`wire.generation.event` discriminated on
`type`: delta / checkpoint / completed / failed / cancelled / consumer_lagged)
— see [wire-contracts.md](wire-contracts.md#2-envelopes).

## 7. Ownership and routing table

Current authoritative writer vs Phase 0 target per feature family. "Migration
status" is **legacy** for every family at Phase 0 start: no route has moved to
the kernel yet. Phase 3 added the **desktop local transport** (kernel embedded,
LocalBackend over Tauri IPC, server off by default) — the frozen-registry
operations are now kernel-writer-capable on desktop. Этап 2.10 cut over the
golden-flow UI reads: the library/chat CRUD hooks route through the facade
(`apps/web/src/api/wireBridge.ts`) in kernel mode and keep the legacy routes in
browser/sidecar mode (transport branch confined to the API layer, ТЗ §13.1).

> ST plugin compatibility removed 2026-10-31 (ADR-0059 slice): the
> `legacy (extension-settings)` row below is historical — the Express host
> and its routes were removed.

| Feature family                        | Current authoritative writer (status quo)                                                                                                                                                                                                                                                                                                                                                                                                               | Target writer (ТЗ §7)                                                                          | Migration status (Phase 0) | Product Wire operation(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| meta (health/version)                 | `plugins/meta.ts` (Fastify)                                                                                                                                                                                                                                                                                                                                                                                                                             | Runtime Kernel `meta.get`                                                                      | legacy                     | `meta.get`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| characters                            | `plugins/characters.ts` + `@neotavern/db` `repositories/characters.ts` (Drizzle/SQLite)                                                                                                                                                                                                                                                                                                                                                                 | Runtime Kernel                                                                                 | legacy                     | `characters.list`, `characters.get`, `characters.create`, `characters.update`, `characters.delete` (soft by default + `purge`), `characters.restore`, `characters.versions.list`, `characters.versions.restore`, `characters.gallery.{list,add,delete}`                                                                                                                                                                                                                                                   |
| characterGallery                      | `plugins/characterGallery.ts` + file store                                                                                                                                                                                                                                                                                                                                                                                                              | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry; characters family)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| characterTransfer                     | `plugins/characterTransfer.ts` + `lib/fileStore.ts`                                                                                                                                                                                                                                                                                                                                                                                                     | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry; characters family)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| backgrounds                           | `plugins/backgrounds.ts` + `files/backgrounds/`                                                                                                                                                                                                                                                                                                                                                                                                         | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| backups                               | `plugins/backups.ts` + `data/backups/` (SQLite online backup)                                                                                                                                                                                                                                                                                                                                                                                           | Runtime Kernel                                                                                 | legacy                     | `backups.create`, `backups.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| chats                                 | `plugins/chats.ts` + `repositories/chats.ts`, `messages.ts`, `messageDrafts.ts`, `snapshots.ts`                                                                                                                                                                                                                                                                                                                                                         | Runtime Kernel                                                                                 | legacy                     | `chats.list`, `chats.get`, `chats.messages.list`, `chats.messages.variants.*`, `chats.messages.revisions.*`, `chats.messages.drafts.*` (Этап 4 slice 2)                                                                                                                                                                                                                                                                                                                                                   |
| messageBlocks                         | `plugins/messageBlocks.ts` + `repositories/messageBlocks.ts`                                                                                                                                                                                                                                                                                                                                                                                            | Runtime Kernel                                                                                 | legacy (routes kept)       | `chats.blocks.list`, `chats.blocks.attach`, `blocks.update`, `blocks.delete` (cluster 15; schema v25 `message_blocks`; descriptor/state are wire JSON objects, cross-client change event waits for cluster 18)                                                                                                                                                                                                                                                                                            |
| connectionProfiles                    | `plugins/connectionProfiles.ts` + `repositories/connectionProfiles.ts`                                                                                                                                                                                                                                                                                                                                                                                  | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| dataImports                           | `plugins/dataImports.ts` + `lib/sillyTavernImport.ts`                                                                                                                                                                                                                                                                                                                                                                                                   | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| diagnostics                           | `plugins/diagnostics.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| events (SSE)                          | `plugins/events.ts` + `@neotavern/plugin-sdk` EventBus                                                                                                                                                                                                                                                                                                                                                                                                  | Runtime Kernel                                                                                 | legacy                     | — (event envelopes land in Phase 0; typed `wire.event.envelope`)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| generate                              | `plugins/generate.ts` + pipeline (`lib/pipeline/`) + `provider-sdk` adapters                                                                                                                                                                                                                                                                                                                                                                            | Runtime Kernel                                                                                 | legacy                     | `generation.start` (workflow, SSE events), `generation.cancel`, `chats.context.audit` (cluster 17 part 1: the chat latest durable plan)                                                                                                                                                                                                                                                                                                                                                                   |     |
| lorebooks                             | `plugins/lorebooks.ts` + `repositories/lorebooks.ts`                                                                                                                                                                                                                                                                                                                                                                                                    | Runtime Kernel                                                                                 | legacy                     | `lorebooks.list`, `lorebooks.get`, `lorebooks.create`, `lorebooks.update`, `lorebooks.delete`, `lorebooks.entries.list`, `lorebooks.entries.create`, `lorebooks.entries.update`, `lorebooks.entries.delete`                                                                                                                                                                                                                                                                                               |
| memories                              | `plugins/memories.ts` + `repositories/memories.ts`                                                                                                                                                                                                                                                                                                                                                                                                      | Runtime Kernel                                                                                 | legacy                     | `memories.list`, `memories.create`, `memories.update`, `memories.delete` (Этап 4 slice 3)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| personas                              | `plugins/personas.ts` + `repositories/personas.ts`                                                                                                                                                                                                                                                                                                                                                                                                      | Runtime Kernel                                                                                 | legacy                     | `personas.list`, `personas.get`, `personas.create`, `personas.update`, `personas.delete`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| presets                               | `plugins/presets.ts` + `repositories/presets.ts`                                                                                                                                                                                                                                                                                                                                                                                                        | Runtime Kernel                                                                                 | legacy                     | `presets.list`, `presets.get`, `presets.create`, `presets.update`, `presets.delete` (Этап 4 slice 3)                                                                                                                                                                                                                                                                                                                                                                                                      |
| profiles                              | `plugins/profiles.ts` + `repositories/profiles.ts` + `lib/profileExport.ts`                                                                                                                                                                                                                                                                                                                                                                             | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| providers                             | `plugins/providers.ts` + `provider-sdk`                                                                                                                                                                                                                                                                                                                                                                                                                 | Runtime Kernel                                                                                 | legacy → Phase 7           | `providers.list`, `providers.catalog`, `providers.config.{set,get,list,delete}` (Этап 4 cluster 7), `providers.models` + `providers.test` (cluster 8; speech/images/transcribe stay legacy until a media transport contract exists)                                                                                                                                                                                                                                                                       |
| secrets                               | `plugins/secrets.ts` + `repositories/providerSecrets.ts`                                                                                                                                                                                                                                                                                                                                                                                                | Runtime Kernel                                                                                 | legacy                     | `secrets.exposure`, `providers.secrets.{list,create,update,delete,reveal}` (Этап 4 cluster 7; schema v24 `provider_secrets`; reveal is the only value-carrying op and is host-gated)                                                                                                                                                                                                                                                                                                                      |
| settings                              | `plugins/settings.ts` + `repositories/settings.ts`                                                                                                                                                                                                                                                                                                                                                                                                      | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| search                                | `plugins/search.ts` + `repositories/search.ts` (FTS5)                                                                                                                                                                                                                                                                                                                                                                                                   | Runtime Kernel                                                                                 | legacy                     | `search.query`, `search.rebuild` (Этап 4 slice 16; schema v23 FTS5 indexes)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| themes                                | `plugins/themes.ts` + `data/themes/`                                                                                                                                                                                                                                                                                                                                                                                                                    | Runtime Kernel                                                                                 | legacy (routes kept)       | `themes.list`, `themes.install` (partial: host verifier), `themes.activate`, `themes.deactivate`, `themes.uninstall`, `themes.settings.get` + `themes.settings.update` (cluster 14; persisted under the legacy `theme.settings.<id>` settings key), `themes.boot` + `themes/:id/assets/*` + `user.css` stay legacy (boot: pre-hydration inline fetch needs a host-native route; assets: N/A — the wire model carries one content-addressed CSS asset; user.css: a data-root file the kernel does not own) |
| plugins (install/lifecycle)           | `plugins/plugins.ts` + `plugin/` sandbox runtime                                                                                                                                                                                                                                                                                                                                                                                                        | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| pluginAuth                            | `plugins/pluginAuth.ts` + `plugin/authConnections.ts`                                                                                                                                                                                                                                                                                                                                                                                                   | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| pluginData                            | `plugins/pluginData.ts` + `repositories/pluginCapabilities.ts`                                                                                                                                                                                                                                                                                                                                                                                          | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| pluginJobs                            | `plugins/pluginJobs.ts` + `data/cache/plugin-jobs/`                                                                                                                                                                                                                                                                                                                                                                                                     | Runtime Kernel                                                                                 | legacy                     | — (beyond Phase 0 wire registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| remoteAuth                            | `plugins/remoteAuth.ts` (session + CSRF)                                                                                                                                                                                                                                                                                                                                                                                                                | facade `RemoteBackend` (transport concern, `packages/neobackend`)                              | legacy                     | — (auth scope on wire ops: `app.read`/`app.write`)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| legacy (extension-settings)           | **REMOVED 2026-10-31** (was `legacy/host.ts`, Express host; ST plugin compat removed, ADR-0059 slice)                                                                                                                                                                                                                                                                                                                                                   | — (no replacement writer; the surface was deleted)                                             | removed                    | — (SillyTavern plugin compat is gone; user-data import stays on `plugins/dataImports.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **remote (Phase 4 adapter)**          | `crates/adapters/remote-http` (tiny_http, envelope-over-HTTP; **no SQLite, no product rules**)                                                                                                                                                                                                                                                                                                                                                          | **Runtime Kernel — same instance as local IPC, one writer coordinator (`Arc<Mutex<Kernel>>`)** | **kernel (Phase 4)**       | **all registry operations over `wire.request.envelope` / `wire.response.envelope`; `GET /meta`, `POST /rpc`, `POST /rpc/stream` (SSE)**                                                                                                                                                                                                                                                                                                                                                                   |
| **headless host (M6 / ТЗ §11.3)**     | `crates/adapters/headless` (`neotavern-headless`) — composition root that binds `remote-http` over a data-root Kernel; **loopback default**, `--remote-exposure` + `--auth` for a public bind, documented `env`/`session`/`unavailable` SecretStore policy                                                                                                                                                                                              | **Runtime Kernel — exclusive data-root lease, one writer**                                     | **host (M6)**              | same frozen registry via `remote-http` (ADR-0030); host is argv/env, not a wire op                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **desktop remote (Phase 9 host)**     | `crates/adapters/desktop-remote` (`neotavern-desktop-remote`) — host service wrapping `remote-http` on the shared kernel; **off by default, no listener**; config at `app_config_dir/remote-access.json` (host-owned, atomic)                                                                                                                                                                                                                           | **Runtime Kernel — same instance, one writer coordinator**                                     | **kernel (Phase 9)**       | same frozen registry via `remote-http` (ADR-0030); host controls `kernel_remote_*` Tauri commands (**not** wire ops, no registry change)                                                                                                                                                                                                                                                                                                                                                                  |
| **android background (Phase 8 host)** | `apps/android` host services: `GenerationService` (bounded `FOREGROUND_SERVICE_TYPE_DATA_SYNC` for user-visible active generation; shared kernel handle via `KernelHolder` refcount, status-only notification + Stop action, never message content §85) and `MaintenanceScheduler` (WorkManager unique one-time work `neotavern-maintenance` → `backups.create`, `BATTERY_NOT_LOW` + `STORAGE_NOT_LOW`, no exact schedule §66, no boot-time daemon §87) | **Runtime Kernel — same session, one lease, one writer**                                       | **host (Phase 8)**         | same frozen registry over the mobile-ffi envelope channel (`generation.start`/`retry`/`cancel`, `backups.create`); no new wire ops, no JNI additions, no codegen                                                                                                                                                                                                                                                                                                                                          |

Notes:

- "Product Wire operation(s)" uses the registry operationIds from the Phase 0
  contract ([wire-contracts.md](wire-contracts.md#phase-0-registry-buildproductwireregistry)). Families
  without a mapped operation keep serving via the Fastify route modules until
  later phases add registry operations.
- Wire operations carry an `authScope` (`none` for `meta.get`, `app.read` for
  reads, `app.write` for writes) that maps onto today's loopback-trust /
  remote-session model when the facade layer lands.
- **Phase 4:** the headless/remote surface is served by
  `crates/adapters/remote-http` (ADR-0030) on the **same Runtime Kernel
  instance** as local IPC — the adapter never opens SQLite and implements no
  product rules; it maps HTTP/SSE onto the frozen envelopes (§6.1 of
  [wire-contracts.md](wire-contracts.md)). The legacy Fastify `/api/v2` rows
  above remain the authoritative writers for every **unmigrated** family;
  families already moved to the kernel (Phase 3/4) are updated per-slice in
  this table.
- **Phase 9:** the desktop Remote Access host service
  (`crates/adapters/desktop-remote`, [ADR-0035](../adr/0035-desktop-remote-access.md))
  wraps the Phase 4 adapter on the same kernel instance for the desktop
  shell — off by default (no listener), loopback default, non-loopback
  requires trusted proxy AND auth (fail-closed pre-bind), pairing/revoke via
  `kernel_remote_*` Tauri commands that never touch the frozen wire registry.
- **M6 / ТЗ §11.3:** the Headless host (`crates/adapters/headless`,
  `neotavern-headless`) is the composition root that binds the Phase 4
  adapter over a data-root Kernel for VPS/LAN use — loopback default,
  `--remote-exposure` + `--auth` for a public bind, documented
  `env`/`session`/`unavailable` SecretStore policy. It is not a second
  product core and does not open SQLite itself.
- **M6 / ТЗ §11.4:** the Android host packages production `apps/web` assets
  into APK `assets/web/` (Gradle `packageWebAssets`, fail-closed without
  `index.html`). CI `assembleRelease` (debug-signed) plus
  `scripts/check-android-apk-web-assets.mjs` confirm Packaged. The Tauri
  Android / `mobile-connect` remote-connect APK path is removed.
  `WebViewUserFlowInstrumentedTest` covers HostConnect local → catalog /
  settings / composer and generation process-death on the JS→JNI path.
- **Phase 8:** the Android host adds a background lifecycle adapter on the
  **same kernel session** ([ADR-0036](../adr/0036-android-background-execution.md)) —
  `KernelHolder` refcounts the one kernel handle between the activity and
  the services (a second writable kernel is rejected by the data-root
  lease, §22); a bounded `dataSync` foreground service continues
  user-visible generation streams (status-only notification + explicit
  Stop `PendingIntent.getService` → `GenerationService`, §85) and maps stop/expiration onto `generation.cancel`, while process
  death recovers through kernel startup recovery + `generation.retry`;
  maintenance is WorkManager unique one-time work (`backups.create`,
  battery/storage constraints, no exact schedule §66). No wire-registry,
  JNI or codegen change — runtime-neutral, host-side only.

## 8. Product Wire mapping (Phase 0 registry)

The Phase 0 wire registry (`packages/contracts/src/wire/registry.ts`, exported
by `buildProductWireRegistry()`) started at 21 operations and grew to the full
M2 registry (characters/chats/messages CRUD, generation run/step + tools,
prompt plan, backups, providers, presets, lorebooks). Mapping to today's
routes; rows marked "migration shim" are Этап 2.10 facade bridges that keep
the browser/sidecar mode working over the legacy server while the kernel mode
uses the canonical wire ops:

| Wire operation                     | Class                 | Current HTTP counterpart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta.get`                         | transactional         | `GET /api/v2/version` + `GET /api/v2/health` (kernel `meta()` builds the same shape: `appVersion`, `api`, `productWire`, `features`)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `characters.list`                  | transactional         | `GET /api/v2/characters`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `characters.get`                   | transactional         | `GET /api/v2/characters/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `characters.create`                | transactional         | `POST /api/v2/characters`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `characters.update`                | transactional         | `PATCH /api/v2/characters/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `characters.delete`                | transactional         | `DELETE /api/v2/characters/:id` (M7 Etap-4 cluster 26: soft delete by default — the request `purge: true` flag keeps the legacy `?purge=true` hard mode; the soft mode leaves chats/messages untouched)                                                                                                                                                                                                                                                                                                                                                        |
| `characters.restore`               | transactional         | `POST /api/v2/characters/:id/restore` (M7 Etap-4 cluster 26; schema v22 `characters.deleted_at`)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `characters.versions.list`         | transactional         | `GET /api/v2/characters/:id/versions` (M7 Etap-4 cluster 26; schema v22 `character_versions`, newest first, `truncated` past 500 snapshots)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `characters.versions.restore`      | transactional         | `POST /api/v2/characters/:id/versions/:versionId/restore` (M7 Etap-4 cluster 26; the pre-restore state is snapshotted first, so a restore is reversible)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `chats.list`                       | transactional         | `GET /api/v2/chats`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `chats.get`                        | transactional         | `GET /api/v2/chats/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `chats.create`                     | transactional         | `POST /api/v2/chats` (kernel mode: accepts optional `personaId` linking the user persona — `PERSONA_NOT_FOUND` for an unknown reference; Этап 4 slice 3)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `chats.update`                     | transactional         | `PATCH /api/v2/chats/:id` (kernel mode: rename and/or re-link `personaId`; at least one field must be present, an empty update is a no-op; a `null` persona clear is not expressible on the wire — Этап 4 slice 3)                                                                                                                                                                                                                                                                                                                                             |
| `chats.delete`                     | transactional         | `DELETE /api/v2/chats/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `chats.reorder`                    | transactional         | `PUT /api/v2/chats/order` (manual drag-and-drop order of a character's chats: listed chats take the leading block, unlisted chats keep their relative order below it; duplicates → VALIDATION, foreign/unknown id → CHAT_NOT_FOUND; `chats.list sort=manual` walks `sort_order ASC, updated_at DESC, id DESC` over the schema-v21 `sort_order` column)                                                                                                                                                                                                         |
| `chats.messages.list`              | transactional         | `GET /api/v2/chats/:id/messages` (wire request gained additive `order: 'asc'\|'desc'`, Этап 2.10: `desc` walks the durable `(sequence,id)` cursor backward from the newest message, matching the UI history loading; both directions share the same opaque cursor encoding)                                                                                                                                                                                                                                                                                    |
| `chats.messages.create`            | transactional         | `POST /api/v2/chats/:id/messages` (bridge; the kernel-mode send flow uses it before `generation.start`)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `chats.messages.update`            | transactional         | `PATCH /api/v2/chats/:id/messages/:mid` (migration shim on `LegacyBackend`, Этап 2.10; wire contract is content-only — the legacy `expectedRevision` CAS is not part of the wire contract)                                                                                                                                                                                                                                                                                                                                                                     |
| `chats.messages.delete`            | transactional         | `DELETE /api/v2/chats/:id/messages/:mid` (migration shim on `LegacyBackend`, Этап 2.10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `chats.messages.variants.list`     | transactional         | `GET /api/v2/chats/:id/messages/:mid/variants` (browser mode; kernel mode: kernel-owned swipe rows, positions ascending)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `chats.messages.variants.create`   | transactional         | kernel mode only (Этап 4 slice 2: `chats.messages.variants.create`, position `MAX+1`); legacy has no create-variant route — browser mode is CAPABILITY_UNAVAILABLE                                                                                                                                                                                                                                                                                                                                                                                             |
| `chats.messages.variants.delete`   | transactional         | kernel mode only (Этап 4 slice 2); legacy has no delete-variant route — browser mode is CAPABILITY_UNAVAILABLE                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `chats.messages.variants.activate` | transactional         | `POST /api/v2/chats/:id/messages/:mid/variants/:variantId/activate` (browser mode; legacy activates by variant id too, optional `expectedRevision` CAS is legacy-only); kernel mode records the replaced text as an immutable revision. UI: `swipeMessageToPosition` maps the legacy swipe position onto the canonical variant id in kernel mode (the active text is the implicit last item — swiping onto it is a no-op); ChatPage uses the variants query for the swipe counter (kernel mode), falling back to the message permutation fields in legacy mode |
| `chats.messages.revisions.list`    | transactional         | `GET /api/v2/chats/:id/messages/:mid/revisions` (browser mode: cursor-paginated; kernel mode: full list in one page)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `chats.messages.revisions.restore` | transactional         | `POST /api/v2/chats/:id/messages/:mid/revisions/:revisionId/restore` (browser mode); kernel mode maps onto `chats.messages.update` with the revision content (canonical restore semantics — the replaced text becomes a new revision)                                                                                                                                                                                                                                                                                                                          |
| `chats.messages.drafts.get`        | transactional         | kernel mode only (Этап 4 slice 2); legacy has no read-draft route — browser mode is CAPABILITY_UNAVAILABLE                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `chats.messages.drafts.save`       | transactional         | `POST /api/v2/chats/:id/drafts` (create) / `PATCH /api/v2/chats/:id/drafts/:draftId` (update, idempotent stale-sequence no-op) (browser mode); kernel mode: single upsert op `chats.messages.drafts.save`                                                                                                                                                                                                                                                                                                                                                      |
| `chats.messages.drafts.commit`     | transactional         | `POST /api/v2/chats/:id/drafts/:draftId/commit` (browser mode: returns `{messageId, alreadyCommitted}`); kernel mode: wire op resolves the committed `MessageDto`, replay-safe via the outbox `committed_message_id`                                                                                                                                                                                                                                                                                                                                           |
| `chats.messages.drafts.discard`    | transactional         | `DELETE /api/v2/chats/:id/drafts/:draftId` (browser mode); kernel mode: wire op `chats.messages.drafts.discard` (never touches the committed message)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `generation.start`                 | workflow (SSE events) | `POST /api/v2/chats/:id/generate` (legacy mode); kernel mode: `chats.messages.create` + wire stream over Tauri IPC (Этап 2.10)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `generation.cancel`                | transactional         | client abort on disconnect (no HTTP route today)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `generation.get`                   | transactional         | none (kernel-native durable run snapshot)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `generation.events`                | transactional         | none (kernel-native durable event-log page; `/rpc/stream` resume)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `generation.retry`                 | workflow (SSE events) | none (kernel-native; new attempt over a failed/cancelled/interrupted run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `generation.keep`                  | transactional         | none (kernel-native; keep partial artifact as a message)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `generation.discard`               | transactional         | none (kernel-native; discard partial artifact)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `generation.tools.list`            | transactional         | none (kernel-native tool registry; facade `generation.tools.list`, Этап 2.10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `generation.tool.result`           | transactional         | none (kernel-native; resumes the waiting run; facade `generation.tool.result`, Этап 2.10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `providers.list`                   | transactional         | kernel-native built-in adapter report; config CRUD/models/test are the kernel ops below; speech/images/transcribe stay `/api/v2/providers/*` until a media transport contract exists                                                                                                                                                                                                                                                                                                                                                                           |
| `providers.catalog`                | transactional         | `GET /api/v2/providers/catalog` (M7 Etap-4 cluster 7: kernel-native catalog of the sources the kernel can materialize — openai/openai-compatible/fake; the legacy 20-source registry is not mirrored)                                                                                                                                                                                                                                                                                                                                                          |
| `providers.secrets.list`           | transactional         | `GET /api/v2/providers/:id/secrets` (M7 Etap-4 cluster 7: masked from the opaque reference; no values)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `providers.secrets.create`         | transactional         | `POST /api/v2/providers/:id/secrets` (value → SecretStore before the transaction; the new key becomes the only active one)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `providers.secrets.update`         | transactional         | `PATCH /api/v2/providers/:id/secrets/:secretId` (activate/deactivate or rename; blank label clears)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `providers.secrets.delete`         | transactional         | `DELETE /api/v2/providers/:id/secrets/:secretId` (revokes the stored value; reactivates the most recent remaining key)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `providers.secrets.reveal`         | transactional         | `POST /api/v2/providers/:id/secrets/:secretId/reveal` (M7 Etap-4 cluster 7: the only plaintext-carrying op; fail-closed `SECRETS_EXPOSURE_DISABLED` unless the host set the exposure policy)                                                                                                                                                                                                                                                                                                                                                                   |
| `providers.models`                 | transactional         | `GET /api/v2/providers/:id/models` (M7 Etap-4 cluster 8: live `GET {baseUrl}/models` for the ADDRESSED config — per-config adapter + key; `CAPABILITY_UNAVAILABLE` for adapters without discovery; bounded at 256 models / 1 MiB)                                                                                                                                                                                                                                                                                                                              |
| `providers.test`                   | transactional         | `POST /api/v2/providers/:id/test` (M7 Etap-4 cluster 8: one non-streaming message through the addressed model, 120 s / 60k chars; product codes PROVIDER_* carry provider failures, the key never reaches the wire)                                                                                                                                                                                                                                                                                                                                            |
| `secrets.exposure`                 | transactional         | `GET /api/v2/secrets/exposure` (host policy, value-free; legacy `NEOTA_ALLOW_SECRETS_EXPOSURE` parity)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `backups.create`                   | workflow              | `POST /api/v2/backups`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `backups.list`                     | transactional         | `GET /api/v2/backups`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `backups.delete`                   | transactional         | `DELETE /api/v2/backups/:id` (M7 follow-up: idempotent uuid-gated container removal; kernel arm + storage `delete_backup`)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `characters.gallery.list`          | transactional         | `GET /api/v2/characters/:id/gallery` (M7 Etap-4: links into the immutable asset store; bytes via `assets.content`)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `characters.gallery.add`           | transactional         | `POST /api/v2/characters/:id/gallery` (content-addressed publish + link; 1 MiB wire cap)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `characters.gallery.delete`        | transactional         | `DELETE /api/v2/characters/:id/gallery/:imageId` (idempotent link removal; asset bytes never destroyed)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `settings.instructformats.list`    | transactional         | `GET /api/v2/settings/instruct-formats` (static built-in catalog: chatml/llama3/alpaca/mistral/command-r — ids, versions, stop strings; no database)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `search.query`                     | transactional         | `GET /api/v2/search` (M7 Etap-4 slice 16: FTS5 over the v23 indexes — characters/chats/messages/lorebooks; per-scope rank merge, `relevance`/`date`/`name` sort, characters-only `tag` filter, trash excluded at query time)                                                                                                                                                                                                                                                                                                                                   |
| `search.rebuild`                   | transactional         | `POST /api/v2/search/rebuild` (M7 Etap-4 slice 16: transactional wipe + repopulation of every index from the base tables; sync triggers resume afterwards)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `diagnostics.cache.clear`          | transactional         | `DELETE /api/v2/diagnostics/cache` (M7 Etap-4 cluster 23: removes the regenerable `<data-root>/cache/` tree only and recreates it empty; originals under `files/` are never touched; no cache-metadata rows → `metadataRowsRemoved: 0`; idempotent on an empty cache)                                                                                                                                                                                                                                                                                          |
| `lorebooks.list`                   | transactional         | `GET /api/v2/lorebooks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lorebooks.get`                    | transactional         | `GET /api/v2/lorebooks/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lorebooks.create`                 | transactional         | `POST /api/v2/lorebooks` (kernel mode: entries as `wire.lorebook.entry.input` array; character link unsupported)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `lorebooks.update`                 | transactional         | `PATCH /api/v2/lorebooks/:id` (kernel mode: name/description only; character link unsupported)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lorebooks.delete`                 | transactional         | `DELETE /api/v2/lorebooks/:id` (kernel mode is permanent; legacy route is soft delete)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lorebooks.entries.list`           | transactional         | `GET /api/v2/lorebooks/:id/entries` (kernel mode: kernel-owned ids; wire DTO has no position/metadata)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lorebooks.entries.create`         | transactional         | `POST /api/v2/lorebooks/:id/entries` (kernel mode: appends; kernel assigns id/position/metadata/timestamps)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lorebooks.entries.update`         | transactional         | `PATCH /api/v2/lorebooks/:id/entries/:entryId` (kernel mode: partial patch incl. position/metadata — wire fields since the M7 Etap-4 slice)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lorebooks.entries.delete`         | transactional         | `DELETE /api/v2/lorebooks/:id/entries/:entryId` (kernel mode: permanent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `personas.list`                    | transactional         | `GET /api/v2/personas`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `personas.get`                     | transactional         | `GET /api/v2/personas/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `personas.create`                  | transactional         | `POST /api/v2/personas`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `personas.update`                  | transactional         | `PATCH /api/v2/personas/:id` (avatar clear rides the explicit `clearAvatar` flag — the legacy `avatar: null`; `avatar` + `clearAvatar` together → VALIDATION)                                                                                                                                                                                                                                                                                                                                                                                                  |
| `personas.delete`                  | transactional         | `DELETE /api/v2/personas/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `presets.list`                     | transactional         | `GET /api/v2/presets?kind=` (browser mode; kernel mode: wire op gained the `kind` filter — `wire.request.list-presets`)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `presets.get`                      | transactional         | `GET /api/v2/presets/:id` (kernel mode: wire op `presets.get`, Этап 4 slice 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `presets.create`                   | transactional         | `POST /api/v2/presets` (kernel mode: wire op `presets.create`, Этап 4 slice 3; `kind` is part of the wire contract, duplicate `(kind,name)` → `PRESET_CONFLICT`)                                                                                                                                                                                                                                                                                                                                                                                               |
| `presets.update`                   | transactional         | `PATCH /api/v2/presets/:id` (kernel mode: wire op `presets.update`, Этап 4 slice 3; rename onto a duplicate `(kind,name)` → `PRESET_CONFLICT`)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `presets.delete`                   | transactional         | `DELETE /api/v2/presets/:id` (kernel mode: wire op `presets.delete`, Этап 4 slice 3; permanent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `memories.list`                    | transactional         | `GET /api/v2/memories?scope=&characterId=&enabled=` (browser mode; kernel mode: wire op `memories.list`, Этап 4 slice 3, ordered by `position, created_at, id`)                                                                                                                                                                                                                                                                                                                                                                                                |
| `memories.create`                  | transactional         | `POST /api/v2/memories` (kernel mode: wire op `memories.create`, Этап 4 slice 3; character scope requires `characterId`, unknown character → `CHARACTER_NOT_FOUND`)                                                                                                                                                                                                                                                                                                                                                                                            |
| `memories.update`                  | transactional         | `PATCH /api/v2/memories/:id` (kernel mode: wire op `memories.update`, Этап 4 slice 3; `characterId: null` un-scoping is expressed as `scope=global` — the kernel clears the stored owner; `global` + `characterId` and `characterId` without a scope switch on a stored global row reject with VALIDATION)                                                                                                                                                                                                                                                     |
| `memories.delete`                  | transactional         | `DELETE /api/v2/memories/:id` (kernel mode: wire op `memories.delete`, Этап 4 slice 3; permanent)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 9. Related documents

- [Wire contracts](wire-contracts.md) — the Phase 0 Product Wire surface.
- [Version axes](version-axes.md) — independent version axes and compatibility.
- [ADR-0029](../adr/0029-wire-contract-toolchain.md) — TypeBox single source →
  deterministic codegen → Rust DTOs.
- [API reference](../api/README.md) — user-facing endpoint documentation.
- [Data and SQLite](../data/README.md) — storage layout, backups, imports.
- [Architecture overview](README.md) — stack and data flow.
