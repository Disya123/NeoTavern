# Data and SQLite

## SQLite settings

- `foreign_keys = ON`;
- `journal_mode = WAL` (readers are not blocked by writes);
- `busy_timeout`, `synchronous = NORMAL`;
- prepared statements (Drizzle);
- transactional migrations;
- STRICT tables where possible;
- FTS5 for full-text search.

## Core tables

`app_meta`, `profiles`, `settings`, `characters`, `tags`, `character_tags`,
`personas`, `chats`, `chat_branches`, `messages`, `message_variants`,
`provider_configs`, `provider_secrets`, `plugin_registry`, `plugin_settings`,
`plugin_storage`, `plugin_state`, `plugin_capability_grants`,
`plugin_auth_connections`, `theme_registry`,
`lorebooks`, `lore_entries`, `presets`, `prompt_context_audits`,
`cache_metadata`, `import_jobs`, `import_artifacts`.

Rules:

- stable string IDs (UUIDv7), never array indices;
- soft delete (`deleted_at`) where a trash bin is needed;
- unknown character card fields and extension metadata are stored in `ext` and
  survive export/import;
- images/audio are not stored as BLOBs in the main database.

### Plugin state and grants

`plugin_state` stores user plugin state separately from `plugin_registry`
(installation/metadata): scope `user|workspace|chat|installation` +
`owner_id`, `schema_version` (plugin data format) and
`revision` (CAS) — different versions, do not mix them. `plugin_capability_grants`
holds issued capability grants with `scope` (JSON), `revision`, `granted_at`,
`expires_at`, `revoked_at`; revocation marks the row instead of deleting it.
Both are STRICT, CASCADE on `plugin_id`, with UNIQUE indexes; migration 0016
(`docs/migrations/README.md`).

`plugin_auth_connections` — plugin OAuth connections: the only place access
tokens are stored on the server (`token_json`, statuses
`pending|connected|expired|revoked`). Tokens are never serialized in the API
and never reach the sandbox; authorized requests go through a server-side
fetch proxy. The one-time `state` and the PKCE `code_verifier` are stored in
the row; migration 0017 (`docs/migrations/README.md`).

### Provider secrets

Since migration 0024 (ТЗ §SEC-01) `provider_secrets` stores **opaque
references**, never plaintext: the `value_ref` column holds
`portable:<namespace>:<id>` / `session:<namespace>:<id>` / `env:<namespace>:<id>`
and the actual value lives in the SecretStore (`packages/secret-store`,
`apps/server/src/lib/secretStore.ts`). The legacy `value` column exists only
as the import source for pre-migration rows — the bootstrap importer moves
them into the store and rewrites them as references (idempotent, skipped
while the store is locked). The value is write-only: the repository only
exposes a masked preview (`masked`) to the outside; the plaintext resolves
through `ctx.secrets.resolve()` for the provider runtime and the `/reveal`
route when `NEOTA_ALLOW_SECRETS_EXPOSURE` is enabled. A reference whose
backend cannot produce the value (store moved to another device, session
ended) returns the stable `SECRET_UNAVAILABLE_ON_THIS_DEVICE` error — never
a plaintext fallback. The legacy column `provider_configs.api_key` is not
used for writes — only as a read fallback for non-migrated databases (see
migration 0009). Cascade: deleting a provider deletes its secret
references.

Plugin secrets (`plugin_secrets`, migration 0022) follow the same pattern
since migration 0024: `value_ref` holds the reference, per-plugin namespace
`plugin:<plugin-id>`, and the gated reveal route resolves it through the
store. Plugin OAuth material in `plugin_auth_connections` (tokens, PKCE
state/verifier) is the documented residual — it moves behind the SecretStore
in a dedicated slice.

### SecretStore and secrets.enc

`packages/secret-store` implements the ТЗ §SEC-01 port with three explicit
backends (there is no silent plaintext fallback):

- **portable** — `secrets.enc` inside the data root (`NEOTA_SECRET_MODE=portable`
  plus `NEOTA_SECRET_PASSPHRASE` or `NEOTA_SECRET_PASSPHRASE_FILE`):
  AES-256-GCM, versioned scrypt KDF (salt/parameters authenticated as AAD, a
  tampered header can never downgrade), fresh nonce per write, atomic
  temp+rename writes, machine-independent key derivation (copy the file plus
  the passphrase to any machine), `lock()` and staged `reEncrypt()`.
- **session** (default when no passphrase is configured) — values live in
  process memory only and are gone after restart; the DB keeps references and
  the provider reports `SECRET_UNAVAILABLE_ON_THIS_DEVICE` until the user
  re-enters the key.
- **env** — read-only headless provider (`NEOTA_SECRET_*` variables).

`secrets.enc` is never included in profile exports, backups or diagnostics.
The canonical kernel-plane port (`crates/secret-store`, ADR-0040) implements
the same invariants with the **v2** portable format — AES-256-GCM + Argon2id
(m=64 MiB / t=3 / p=1), authenticated header, staged re-encryption, atomic
writes — plus session/env/unavailable backends. Full OS-vault / Android
Keystore adapters and the passphrase UX belong to the kernel-plane M3 slice.

## FTS5

Virtual tables `characters_fts`, `chats_fts`, `messages_fts`
(`unicode61 remove_diacritics`). `AFTER INSERT/UPDATE/DELETE` triggers keep
them synchronized transactionally. Search: prefix (`token*`), tag filtering,
bm25 relevance sorting. Rebuild from the UI:
`POST /api/v2/search/rebuild`.

Character search (`GET /api/v2/characters?q=...`) parses the query on the
backend (`packages/db/src/repositories/characterQuery.ts`): free text and
exact phrases, `tag:`/`author:`/`name:`/`-tag:`/`-author:`/`-name:` filters and
full-text column filters `desc:`/`persona:`/`scenario:`. Queries with positive
terms go through `characters_fts` with bm25 ranking; queries with only
negative filters and queries after degrading invalid FTS syntax are handled as
SQL filters without ranking. Since migration 0011 `characters_fts` contains a
`tags` column (tag names separated by spaces), so free text also finds
characters by tags; the column is synchronized by triggers on
`character_tags`. The `tag:` filter from `q` matches the beginning of the tag
name, `-tag:` excludes by the beginning; the `tag` query parameter remains
exact. The syntax is documented in `docs/api/README.md`.

Migration 0012 adds three derived columns to `characters` for catalog sorting:
`favorite` (mirror of `ext.favorite` / `ext.legacy.favorite`,
synchronized in `characters.update()` when `ext` changes; `ext` remains the
source of truth, the API contract does not change), `chat_count` (number of
non-deleted chats) and `token_count` (total length of `messages.content` in
characters — a volume measure, not real tokens; the trash bin is excluded).
`chat_count` and `token_count` are maintained by SQL triggers on `chats` and
`messages` so that any write path (repositories, import) stays consistent:
creating/soft-deleting/restoring/hard-deleting a chat moves both counters at
once, while inserting/deleting/editing a message moves only `token_count` of
a live chat. The `characters_chat_count_ad` trigger runs `BEFORE DELETE`
because `ON DELETE CASCADE` deletes messages before `AFTER DELETE`. For
`favorites`, `chats-most`/`chats-least`, `tokens-most`/
`tokens-least` sorts, indexes `(col DESC, name, id)` are added to match the
browser's exact `ORDER BY`; `random` sorts via `ORDER BY random() LIMIT n` and
is not paginated by cursor. The deprecated aliases `recent`/`created`/`usage`
map to `newest`/`oldest`/`used` in the repository.

## Chats and manual ordering

Migration 0013 adds the `sort_order` column (INTEGER NOT NULL DEFAULT 0) to
`chats` and the index `chats_character_sort_idx (character_id, sort_order,
updated_at, id)` to match the chat list's exact `ORDER BY`. New chats get
`sort_order = 0` and land on top thanks to the `updated_at DESC` tie-break.
Manual ordering (`PUT /api/v2/chats/order`) writes monotonically increasing
values for the listed chats of a character; unlisted chats keep their relative
order below the rearranged block. The column has a non-null default, so no
backfill is required and the existing "newest first" order is preserved.

Chat search (`GET /api/v2/chats?q=...`) merges hits from `chats_fts`
(titles/summaries) and `messages_fts` (message contents), both restricted to
the selected `characterId` and non-deleted chats.

Migration 0014 adds the `background_id` column (TEXT, nullable) to `chats` —
the background filename from the `files/backgrounds/` catalog, or `NULL` for
the default theme. The column has no foreign key: the file system is
authoritative (backgrounds imported from ST1 do not pass through the DB).
Deleting a background (`DELETE /api/v2/backgrounds/:id`) resets
`background_id` in chats via `clearBackgroundReference`.

## Swipe history and child chats (migration 0020)

Migration `0020_swipe_history_and_child_chats` (version 20) introduces the
permutation-based swipe history model for messages and child chat provenance.
Additive DDL + backfill-`UPDATE`; rollback is only a pre-migration backup
restore (see [migrations](../migrations/README.md)).

### Variant permutation

- `message_variants.position` — 0-based variant position; backfill orders
  variants by `(created_at, id)`, the UNIQUE index
  `idx_message_variants_position (message_id, position)` forbids duplicates.
- `messages.variant_count` — total variants **including the active one** (`>= 1`
  after backfill: `1 + number of message_variants rows`); the active text
  lives in `messages.content`.
- `messages.active_variant_position` — the active text's position in the
  permutation `0..variant_count-1` with exactly one "hole" — the position of
  the active content (variants occupy the remaining positions). Backfill makes
  the current text the newest variant at position N.
- Switching (`swipe`) — a non-destructive exchange: the variant at the target
  position becomes active, the previous active text is archived at the freed
  position, `revision` increments. The optional CAS guard `expectedRevision`
  yields `MESSAGE_CONFLICT` instead of overwriting someone else's edit.
- Regeneration archives the old answer **only at `done`** in a single
  transaction (`replaceContentAsVariant`): on error or stream cancellation
  nothing is saved — the previous text stays on disk.

### Child chats: checkpoints and branches

- `chats.parent_chat_id` / `chats.origin` (`'checkpoint'|'branch'|NULL`) /
  `chats.source_message_id` — snapshot provenance (badge in the chat catalog).
- Snapshot (`POST /chats/:id/snapshots`) copies, in one transaction, the
  **active-branch prefix** of the parent up to and including the target
  message: batches by keyset `(created_at, id)` of 500 rows each with an
  in-memory old→new id map; `parent_id` is remapped (unknown → `NULL`),
  `meta` is copied as raw text losslessly, variants (with positions) and
  persistent `message_block_attachments` are copied together with messages.
- A child chat inherits `character_id`/`persona_id`/`background_id`/
  `summary` from the parent, gets a `main` branch (`active_branch_id`), the
  title `"{parent title} — checkpoint|branch"` (or a passed `title`) and
  `message_count = copiedMessages`.
- For `kind: 'checkpoint'`, the `messages.checkpoint_chat_id` flag is set on
  the source message; `replace: true` re-points it at the fresh snapshot —
  the previous child chat is **not deleted** (replacement only changes the
  reference). `PATCH /messages/:messageId` can clear the flag
  (`checkpointChatId: null`).

## Generation metadata (`messages.meta.generation`)

`messages.meta` is a JSON column (open `Record<string, unknown>`), so typed
generation metadata requires no DB migration. With every completed generation
the server stores the terminal run book in `meta.generation` (schema
`MessageGenerationMetaSchema` in `@neotavern/contracts`):

- `generationId` — UUIDv7 of the run (matches the `generationId` of the
  `prompt_context_audits` row);
- `providerConfigId` / `providerKind` — provider configuration, `null` on
  echo fallback (provider not configured — values are not invented);
- `providerSource` — resolved `settings.source` (string or `null`);
- `model` — actual model (`echo` on fallback);
- `durationMs` — provider call duration (whole stream), integer ms;
- `usage` — run tokens `{promptTokens, completionTokens, totalTokens}`
  (or `null` if the provider did not report them).

Top-level `meta` fields stay open: next to `generation` live legacy `model`
(compatibility with old messages), `diagnostics`, `tokenBudget`,
`contextStrategy`, `excludedContextCount`, etc. Regeneration rewrites
`meta.generation` entirely (new `generationId`); the legacy `meta.model` is
kept. Reading uses the safe parser `parseMessageGenerationMeta` (null for
missing/corrupt values, never throws): such messages stay fully readable.

## Files and cache

```text
data/
  app.db
  files/{avatars,backgrounds,attachments,audio,generated}/
  plugins/  themes/  cache/thumbnails/  backups/  logs/
```

- originals live in `files/`, regenerable content in `cache/`;
- thumbnails keyed by original hash + size + algorithm version;
- writes are atomic (temp file + rename);
- cache cleanup never deletes originals; missing thumbnails are regenerated
  automatically.

The character gallery uses the existing `attachments` table with
`owner_type = character.gallery`. Metadata contains the original and thumbnail
URLs; the bytes themselves stay in content-addressed `files/avatars/`. Deleting
from the gallery removes the attachment record but not the original: this
keeps the action reversible and preserves deduplication. No new migration is
needed for the gallery.

The diagnostics screen calls `DELETE /api/v2/diagnostics/cache`: only the
`cache/thumbnails/` files and their `cache_metadata` rows are deleted. The
`cache/` root is not removed, so active/repeatable migration staging
directories are not interrupted. The result reports the number and size of
deleted files; calling again is safe and returns zeros.

### Chat backgrounds

The `files/backgrounds/` catalog is the source of truth: the list is built by
scanning the directory, so originals imported from SillyTavern 1 are visible
without any transfer. Uploaded files are stored content-addressed
(`{sha256}{ext}`, deduplicated by content) and never modified; originals are
not cached and never deleted by cache cleanup.

Background thumbnails live in `cache/thumbnails/` and are regenerable. Unlike
avatar thumbnails, their key is derived from the SHA-256 of the **file name**
rather than the content — this allows building thumbnails for ST1-imported
originals with arbitrary names and aligns upload/list/delete on a single key.
A file that `sharp` cannot decode or that exceeds the 64 MiB limit is skipped
by the list without a thumbnail, but the original itself stays available.
`DELETE /api/v2/backgrounds/:id` deletes both the original and its thumbnail
from the cache.

### Installed themes

Theme packages are stored in `themes/{themeId}/`, metadata in the existing
`theme_registry`; no DB schema change is required. At most one row is active.
Activation and `settings.themeId` are updated in a single transaction.

Installation unpacks the archive into a hidden staging directory inside
`themes/`, validates the manifest and assets, renames the current directory to
a rollback, atomically promotes the new one, and only then updates the
registry. On a DB write error the previous directory is restored.
Staging/rollback are housekeeping data, not user content; a successful
operation removes them.

### Bundled themes

On first launch the server seeds the bundled theme set from
`apps/server/assets/themes/` into `data/themes/<id>/` and `theme_registry`
(`seedBundledThemes`). The `app_meta` marker `themes.bundled.v1` stores the
already-installed ids, so new themes from an update are installed in addition,
while themes deleted by the user are not restored. Seeding does not activate a
theme and does not change `settings.themeId`. See
[Theme SDK — bundled themes](../theme-sdk/README.md#bundled-themes).

## Character Card import

`POST /api/v2/characters/import` accepts JSON Character Card V1/V2 and PNGs
with `chara` metadata. Input is limited to 25 MiB and recognized by content.

- SHA-256 of the whole source file is written to `ext._st2.importHash`;
- re-importing the same file returns the existing record;
- unknown V1/V2 fields and `extensions` are saved in `ext`;
- PNG is validated by the image decoder;
- the original is written atomically to `files/avatars/`;
- a WebP thumbnail is created in `cache/thumbnails/` with the key
  `{hash}-{size}-v{algorithmVersion}`;
- a missing thumbnail is repaired by regenerating it from the original.

The current idempotency scope is the exact file content. Semantically
identical cards with different bytes count as separate imports.

## Starter character pack

The distribution contains the original V3 card of Hazel and four author
entries of the Vesper lorebook — original starter content in a cyberpunk
setting, not borrowed from SillyTavern.

On the **legacy Fastify** contour, startup performs a resumable local
import (`apps/server/src/lib/starterContent.ts`): it creates the
character, saves the original avatar image and the content-addressed
thumbnail, and creates the linked lorebook. Unknown V3 fields, greeting
arrays, extension metadata, and the original lore text are preserved.
Stage state is stored in `app_meta`.

On the **canonical Kernel** contour the same files are seeded from
`apps/server/assets/starter/` at writer-thread startup when the host sets
`NEOTA_SEED_STARTER=1` (Android `nt_kernel_open` with a data root, and
Desktop kernel mode). The avatar PNG is larger than the wire `assets.put`
limit, so the kernel publishes it directly through the asset store rather
than dispatch. Markers live in `__neotavern_meta` under the same keys
(`starter.hazel.v1.characterId` / `lorebookId` / `complete`).

Before the `.complete` marker, a restart only finishes the missing
stages; a corrupted bundled asset leaves a retry log line and does not
block the host. After `.complete` the starter content is never restored:
deleting or editing it is considered user intent. The import runs once,
for both new and existing databases after an update. Kernel unit tests
leave the env unset so they keep an empty library.

## SillyTavern data import

The "Settings → Data and backups" screen uses a two-phase transfer of a full
SillyTavern ZIP backup:

1. `POST /api/v2/imports/sillytavern/analyze` streams, hashes and safely
   unpacks the archive into temporary disk staging, then only reads data.
2. The user selects categories and a conflict policy.
3. `POST /api/v2/imports/sillytavern/:analysisId/execute` creates a protective
   SQLite backup and only then writes the selected data.

Read-only analysis does not create `import_jobs`, library entities, or a
backup. It returns object counts, nested records, corruptions, conflicts, and
bytes per category. Staging lives for 30 minutes, no more than three analyses
are kept at once; it is removed after a successful import, an explicit cancel,
or TTL expiry. Directories left over after an aborted run are cleaned up on
the next start.

Supported:

- JSON/PNG Character Card V1/V2 and unknown extension metadata;
- single JSONL chats, participant names, `extra`, `chat_metadata`, and swipe variants;
- personas from `settings.json` and their avatars from `User Avatars`;
- `worlds/*.json` as lorebooks with unknown fields preserved;
- JSON presets from the `instruct`, `context`, `sysprompt`, `reasoning`, and
  provider settings directories.

Secrets, third-party plugins, themes, groups and group chats are not imported.
They are listed as warnings in the final report. `settings.json` is used only
for the supported non-secret persona data and is not stored in the DB as a
whole.

Safety boundaries:

- up to 4 GiB compressed ZIP, 16 GiB uncompressed data, 500 000 entries;
- traversal paths, absolute paths, backslashes, symlinks, and encrypted
  entries are forbidden;
- a single entry is limited to 1 GiB, a Character Card/avatar to 25 MiB;
- after confirmation and before writing, a protective SQLite backup is created;
- the temporary archive and unpacked files are deleted after success, explicit
  cancel, or TTL expiry; after an execution error, staging can be retried up
  to the TTL;
- client disconnect and the cancel button are propagated via `AbortSignal`.

The conflict policy applies to all selected categories:

- `skip` matches the source to an existing object without changing data;
- `copy` creates separate entities and separate source keys;
- `merge` keeps populated local fields and adds missing incoming data; an
  existing chat is never merged with another transcript;
- `replace` updates the object in place. Before replacing a Character Card a
  `character_versions` snapshot is created; for a chat, the old transcript
  stays available until the new one is fully read, then is atomically replaced
  by the new chat entity.

`import_artifacts` maps a logical source key to a local UUID. For a streaming
chat, an `importing` marker is created first: after an interruption, a rerun
removes only the unfinished transcript and starts it over. `import_jobs`
stores every confirmed execution; multiple runs of the same SHA-256 are
allowed for different categories and policies. The compatible one-step
endpoint `POST /api/v2/imports/sillytavern` is kept: it reuses the last
successful report of the exact archive and skips the preflight.

See also: [migrations](../migrations/README.md).

## Manual message edit history (migration 0021)

`messages.content_revision_count` stores the number of archived manual text revisions.
`message_content_revisions` is a STRICT table with stable ids, a cascading
`message_id` foreign key, chronological `position`, the previous `content`, and
`created_at`. `UNIQUE (message_id, position)` makes pagination deterministic.

A successful PATCH that actually changes `content` inserts the previous text and
increments the counter in the same transaction. Metadata updates, no-op PATCHes,
greeting swipes, swipe activation, and regeneration do not write this table.
Restoring a revision archives the current text and retains every existing revision.

Swipe variants and manual revisions are deliberately separate histories. Both are
copied into checkpoint/branch snapshots. Chat export schema version 2 serializes
`messageVariants` and `messageRevisions` alongside messages so neither history
depends on the source database.

Deleting a message cascades to both histories. Repositories page revisions newest
first and never load a complete long history into memory.
