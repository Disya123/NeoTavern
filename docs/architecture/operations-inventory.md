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

- Every route below is registered from a module in `apps/server/src/plugins/*.ts`
  or `apps/server/src/legacy/host.ts`; the full registration order is in
  `apps/server/src/app.ts` (`buildApp`).
- Route schemas (request/response) are TypeBox schemas in `packages/contracts/src`
  (single source of truth per ADR-0004) and are never hand-duplicated.
- Data access is Drizzle ORM over better-sqlite3 (WAL) through repositories in
  `packages/db/src/repositories/`; schema DDL in `packages/db/src/schema/tables.ts`;
  migrations in `packages/db/src/migrations/`.
- The HTTP surface is documented for humans in `docs/api/README.md`; that
  document is the user-facing counterpart of this inventory.

## 2. Current server architecture (summary)

| Aspect         | Current state                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process        | Single Node.js Fastify process (`apps/server/src/main.ts` → `app.ts`)                                                                                                                                                                                   |
| Transport      | HTTP on `127.0.0.1` by default; optional explicit remote access (`NEOTA_REMOTE_ACCESS`, session + CSRF, `apps/server/src/plugins/remoteAuth.ts`)                                                                                                        |
| Validation     | Fastify schema validation against TypeBox schemas; typed error envelope on failure                                                                                                                                                                      |
| Storage        | SQLite `app.db` (WAL) via `@neotavern/db` (Drizzle repositories) + filesystem under `data/` (`apps/server/src/lib/paths.ts`: `files/{avatars,backgrounds,attachments,audio,generated}`, `cache/thumbnails`, `backups/`, `plugins/`, `themes/`, `logs/`) |
| Real-time      | SSE: `GET /api/v2/events` (app events) and `POST /api/v2/chats/:id/generate` (generation stream)                                                                                                                                                        |
| Legacy compat  | Express host for legacy server plugins and SillyTavern-style extension settings (`apps/server/src/legacy/host.ts`)                                                                                                                                      |
| Target (ТЗ §7) | **[IN PROGRESS]** Runtime Kernel in `crates/runtime-kernel` becomes the authoritative writer for product operations; facades `LocalBackend`/`RemoteBackend`/`LegacyBackend` in `packages/neobackend`, transport SDK in `packages/client-sdk`. The web UI already routes **every** API call through the `NeoBackend` facade singleton (`apps/web/src/api/backend.ts`): typed wire operations go through `LegacyBackend` mappings, unmigrated `/api/v2` routes through the temporary `raw` passthrough (removed per-slice in Фаза 3). |

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
| diagnostics        | `plugins/diagnostics.ts`          | snapshot, cache cleanup                                                                          |
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
| legacy             | `legacy/host.ts`                  | legacy extension settings (SillyTavern compat)                                                   |

## 5. Endpoints by family

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
- `DELETE /api/v2/characters/:id` — soft delete (trash).
- `POST /api/v2/characters/:id/restore` — restore from trash.
- `GET /api/v2/characters/:id/versions` — version history.
- `POST /api/v2/characters/:id/versions/:versionId/restore` — restore a
  version; the current state is snapshotted first.

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
  database is always taken before restoring.

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

- `GET /api/v2/chats/:id/blocks` — batch block read for a page of messages.
- `POST /api/v2/chats/:id/messages/:messageId/blocks` — attach a block.
- `PATCH /api/v2/blocks/:blockId` — update.
- `DELETE /api/v2/blocks/:blockId` — delete.

### connectionProfiles — `apps/server/src/plugins/connectionProfiles.ts`

- `GET /api/v2/connection-profiles` — list.
- `POST /api/v2/connection-profiles` — create.
- `GET /api/v2/connection-profiles/:id` — get.
- `PATCH /api/v2/connection-profiles/:id` — update.
- `DELETE /api/v2/connection-profiles/:id` — delete.
- `POST /api/v2/connection-profiles/:id/apply` — apply a profile (provider +
  secret + generation configuration).

### dataImports — `apps/server/src/plugins/dataImports.ts`

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
  entity counts, directory usage, disk).
- `DELETE /api/v2/diagnostics/cache` — cache cleanup (thumbnails).

### events — `apps/server/src/plugins/events.ts`

- `GET /api/v2/events` — SSE stream of relayed app events for TanStack Query
  invalidation and multi-tab sync. Envelope and whitelist are defined once in
  `packages/contracts/src/events.ts` (`AppEventEnvelopeSchema`,
  `BROWSER_APP_EVENTS`); see [Streaming surface](#6-streaming-surface-sse).

### generate — `apps/server/src/plugins/generate.ts`

- `POST /api/v2/chats/:id/generate` — SSE streaming generation: runs the prompt
  pipeline, streams provider events, persists user and assistant messages,
  aborts on client disconnect.
- `GET /api/v2/chats/:id/context-audit` — prompt context audit.
- `POST /api/v2/context-preview` — preview the rendered prompt context.
- `POST /api/v2/plugin-intercepts/:requestId` — plugin intercept callback
  (`requestId` 16..200 chars).

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
  (ZIP with `manifest.json` `{ format: "neotavern-profile-export", version: 1,
appVersion, exportedAt, profile }`, a consistent `app.db` snapshot, and
  `files/`; see [version-axes.md](version-axes.md#export-format)).
- `PATCH /api/v2/profiles/:id` — update.

### providers — `apps/server/src/plugins/providers.ts`

- `GET /api/v2/providers/catalog` — built-in catalog
  (`adapterKind` per source, default URL, key requirements).
- `GET /api/v2/providers` — configured providers.
- `POST /api/v2/providers` — create.
- `PATCH /api/v2/providers/:id` — update.
- `DELETE /api/v2/providers/:id` — delete.
- `GET /api/v2/providers/:id/models` — model discovery (validates connectivity).
- `POST /api/v2/providers/:id/test` — message test.
- `POST /api/v2/providers/:id/speech` — TTS.
- `POST /api/v2/providers/:id/images` — image generation.
- `POST /api/v2/providers/:id/transcribe` — STT.

### secrets — `apps/server/src/plugins/secrets.ts`

- `GET /api/v2/secrets/exposure` — whether plaintext exposure is allowed
  (`NEOTA_ALLOW_SECRETS_EXPOSURE`).
- `GET /api/v2/providers/:id/secrets` — list (masked values).
- `POST /api/v2/providers/:id/secrets` — create (several named keys, one active).
- `PATCH /api/v2/providers/:id/secrets/:secretId` — update.
- `DELETE /api/v2/providers/:id/secrets/:secretId` — delete.
- `POST /api/v2/providers/:id/secrets/:secretId/reveal` — plaintext reveal
  (behind the explicit exposure flag; off by default).

### settings — `apps/server/src/plugins/settings.ts`

- `GET /api/v2/settings` — `AppSettings`.
- `GET /api/v2/settings/instruct-formats` — available instruct formats
  (ChatML/Llama3/Alpaca/…).
- `PATCH /api/v2/settings` — update.

### search — `apps/server/src/plugins/search.ts`

- `GET /api/v2/search` — FTS5 search across characters/chats/messages.
- `POST /api/v2/search/rebuild` — manual FTS index rebuild (ТЗ §12).

### themes — `apps/server/src/plugins/themes.ts`

- `GET /api/v2/themes` — installed themes.
- `GET /api/v2/themes/boot` — boot theme (client falls back to defaults).
- `POST /api/v2/themes/install` — install theme package.
- `POST /api/v2/themes/:id/activate` — activate.
- `DELETE /api/v2/themes/active` — deactivate.
- `GET /api/v2/themes/:id/settings` — theme settings.
- `PATCH /api/v2/themes/:id/settings` — update theme settings.
- `DELETE /api/v2/themes/:id` — uninstall.
- `GET /api/v2/themes/:id/assets/*` — theme assets.
- `GET /api/v2/user.css` — user CSS overlay (absent/non-file/symlink → 404;
  size-bounded).

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
- `GET /api/v2/plugins/:id/legacy.js` — legacy bundle.
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

### remoteAuth — `apps/server/src/plugins/remoteAuth.ts`

- `GET /api/v2/auth/session` — current session.
- `POST /api/v2/auth/session` — create session (login).
- `DELETE /api/v2/auth/session` — destroy session.

Loopback mode needs no auth; non-loopback startup requires
`NEOTA_REMOTE_ACCESS=true`, a token and a trusted public origin
(bounded HttpOnly/SameSite session + in-memory CSRF token).

### legacy — `apps/server/src/legacy/host.ts`

SillyTavern compatibility surface (AGENTS.md §18 / ТЗ §8.3), served by the
Express compatibility host mounted onto Fastify:

- `GET /api/v2/legacy/extension-settings` — read legacy extension settings.
- `PATCH /api/v2/legacy/extension-settings/:namespace` — update
  (`LegacyExtensionNamespaceSchema`; 1 MiB limit).

The host also runs trusted legacy server plugins (`legacy.trusted` permission),
each mounted under its own Express router.

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
— see [wire-contracts.md](wire-contracts.md#envelopes).

## 7. Ownership and routing table

Current authoritative writer vs Phase 0 target per feature family. "Migration
status" is **legacy** for every family at Phase 0 start: no route has moved to
the kernel yet.

| Feature family              | Current authoritative writer (status quo)                                                       | Target writer (ТЗ §7)                                             | Migration status (Phase 0) | Product Wire operation(s)                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| meta (health/version)       | `plugins/meta.ts` (Fastify)                                                                     | Runtime Kernel `meta.get`                                         | legacy                     | `meta.get`                                                                                         |
| characters                  | `plugins/characters.ts` + `@neotavern/db` `repositories/characters.ts` (Drizzle/SQLite)         | Runtime Kernel                                                    | legacy                     | `characters.list`, `characters.get`, `characters.create`, `characters.update`, `characters.delete` |
| characterGallery            | `plugins/characterGallery.ts` + file store                                                      | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry; characters family)                                                |
| characterTransfer           | `plugins/characterTransfer.ts` + `lib/fileStore.ts`                                             | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry; characters family)                                                |
| backgrounds                 | `plugins/backgrounds.ts` + `files/backgrounds/`                                                 | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| backups                     | `plugins/backups.ts` + `data/backups/` (SQLite online backup)                                   | Runtime Kernel                                                    | legacy                     | `backups.create`, `backups.list`                                                                   |
| chats                       | `plugins/chats.ts` + `repositories/chats.ts`, `messages.ts`, `messageDrafts.ts`, `snapshots.ts` | Runtime Kernel                                                    | legacy                     | `chats.list`, `chats.get`, `chats.messages.list`                                                   |
| messageBlocks               | `plugins/messageBlocks.ts` + `repositories/messageBlocks.ts`                                    | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry; chats family)                                                     |
| connectionProfiles          | `plugins/connectionProfiles.ts` + `repositories/connectionProfiles.ts`                          | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| dataImports                 | `plugins/dataImports.ts` + `lib/sillyTavernImport.ts`                                           | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| diagnostics                 | `plugins/diagnostics.ts`                                                                        | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| events (SSE)                | `plugins/events.ts` + `@neotavern/plugin-sdk` EventBus                                          | Runtime Kernel                                                    | legacy                     | — (event envelopes land in Phase 0; typed `wire.event.envelope`)                                   |
| generate                    | `plugins/generate.ts` + pipeline (`lib/pipeline/`) + `provider-sdk` adapters                    | Runtime Kernel                                                    | legacy                     | `generation.start` (workflow, SSE events), `generation.cancel`                                     |
| lorebooks                   | `plugins/lorebooks.ts` + `repositories/lorebooks.ts`                                            | Runtime Kernel                                                    | legacy                     | `lorebooks.list`                                                                                   |
| memories                    | `plugins/memories.ts` + `repositories/memories.ts`                                              | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| personas                    | `plugins/personas.ts` + `repositories/personas.ts`                                              | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| presets                     | `plugins/presets.ts` + `repositories/presets.ts`                                                | Runtime Kernel                                                    | legacy                     | `presets.list`                                                                                     |
| profiles                    | `plugins/profiles.ts` + `repositories/profiles.ts` + `lib/profileExport.ts`                     | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| providers                   | `plugins/providers.ts` + `provider-sdk`                                                         | Runtime Kernel                                                    | legacy → Phase 7           | `providers.list` (kernel built-in adapter report); CRUD/models/test remain legacy until provider-config slices |
| secrets                     | `plugins/secrets.ts` + `repositories/providerSecrets.ts`                                        | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| settings                    | `plugins/settings.ts` + `repositories/settings.ts`                                              | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| search                      | `plugins/search.ts` + `repositories/search.ts` (FTS5)                                           | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| themes                      | `plugins/themes.ts` + `data/themes/`                                                            | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| plugins (install/lifecycle) | `plugins/plugins.ts` + `plugin/` sandbox runtime                                                | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| pluginAuth                  | `plugins/pluginAuth.ts` + `plugin/authConnections.ts`                                           | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| pluginData                  | `plugins/pluginData.ts` + `repositories/pluginCapabilities.ts`                                  | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| pluginJobs                  | `plugins/pluginJobs.ts` + `data/cache/plugin-jobs/`                                             | Runtime Kernel                                                    | legacy                     | — (beyond Phase 0 wire registry)                                                                   |
| remoteAuth                  | `plugins/remoteAuth.ts` (session + CSRF)                                                        | facade `RemoteBackend` (transport concern, `packages/neobackend`) | legacy                     | — (auth scope on wire ops: `app.read`/`app.write`)                                                 |
| legacy (extension-settings) | `legacy/host.ts` (Express host)                                                                 | facade `LegacyBackend` (SillyTavern compat)                       | legacy                     | — (kept for compat)                                                                                |
| **remote (Phase 4 adapter)**| `crates/adapters/remote-http` (tiny_http, envelope-over-HTTP; **no SQLite, no product rules**) | **Runtime Kernel — same instance as local IPC, one writer coordinator (`Arc<Mutex<Kernel>>`)** | **kernel (Phase 4)** | **all 15 registry operations over `wire.request.envelope` / `wire.response.envelope`; `GET /meta`, `POST /rpc`, `POST /rpc/stream` (SSE)** |

Notes:

- "Product Wire operation(s)" uses the registry operationIds from the Phase 0
  contract ([wire-contracts.md](wire-contracts.md#phase-0-registry)). Families
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

## 8. Product Wire mapping (Phase 0 registry)

The Phase 0 wire registry (`packages/contracts/src/wire/registry.ts`, exported
by `buildProductWireRegistry()`) covers 21 operations. Mapping to today's
routes:

| Wire operation        | Class                 | Current HTTP counterpart                                                                                                             |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `meta.get`            | transactional         | `GET /api/v2/version` + `GET /api/v2/health` (kernel `meta()` builds the same shape: `appVersion`, `api`, `productWire`, `features`) |
| `characters.list`     | transactional         | `GET /api/v2/characters`                                                                                                             |
| `characters.get`      | transactional         | `GET /api/v2/characters/:id`                                                                                                         |
| `characters.create`   | transactional         | `POST /api/v2/characters`                                                                                                            |
| `characters.update`   | transactional         | `PATCH /api/v2/characters/:id`                                                                                                       |
| `characters.delete`   | transactional         | `DELETE /api/v2/characters/:id`                                                                                                      |
| `chats.list`          | transactional         | `GET /api/v2/chats`                                                                                                                  |
| `chats.get`           | transactional         | `GET /api/v2/chats/:id`                                                                                                              |
| `chats.messages.list` | transactional         | `GET /api/v2/chats/:id/messages`                                                                                                     |
| `generation.start`    | workflow (SSE events) | `POST /api/v2/chats/:id/generate`                                                                                                    |
| `generation.cancel`   | transactional         | client abort on disconnect (no HTTP route today)                                                                                     |
| `generation.get`      | transactional         | none (kernel-native durable run snapshot)                                                                                            |
| `generation.events`   | transactional         | none (kernel-native durable event-log page; `/rpc/stream` resume)                                                                   |
| `generation.retry`    | workflow (SSE events) | none (kernel-native; new attempt over a failed/cancelled/interrupted run)                                                          |
| `generation.keep`     | transactional         | none (kernel-native; keep partial artifact as a message)                                                                             |
| `generation.discard`  | transactional         | none (kernel-native; discard partial artifact)                                                                                       |
| `providers.list`      | transactional         | kernel-native built-in adapter report; legacy CRUD/models/test stay `/api/v2/providers/*` until later slices                          |
| `backups.create`      | workflow              | `POST /api/v2/backups`                                                                                                               |
| `backups.list`        | transactional         | `GET /api/v2/backups`                                                                                                                |
| `lorebooks.list`      | transactional         | `GET /api/v2/lorebooks`                                                                                                              |
| `presets.list`        | transactional         | `GET /api/v2/presets`                                                                                                                |

## 9. Related documents

- [Wire contracts](wire-contracts.md) — the Phase 0 Product Wire surface.
- [Version axes](version-axes.md) — independent version axes and compatibility.
- [ADR-0029](../adr/0029-wire-contract-toolchain.md) — TypeBox single source →
  deterministic codegen → Rust DTOs.
- [API reference](../api/README.md) — user-facing endpoint documentation.
- [Data and SQLite](../data/README.md) — storage layout, backups, imports.
- [Architecture overview](README.md) — stack and data flow.
