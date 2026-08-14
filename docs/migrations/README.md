# Migrations

## 0020 — swipe history & child chats

Migration `0020_swipe_history_and_child_chats` (version 20) — the
permutation-based swipe history model and child chat provenance (ST1 message
actions):

- `message_variants.position INTEGER NOT NULL DEFAULT 0` — 0-based variant
  position; backfill orders variants by `(created_at, id)`;
  `CREATE UNIQUE INDEX idx_message_variants_position (message_id, position)`;
- `messages.variant_count` (INTEGER NOT NULL DEFAULT 0) and
  `messages.active_variant_position` (INTEGER) — the variant count includes the
  active text (`variant_count >= 1`); backfill:
  `variant_count = 1 + COUNT(variants)`,
  `active_variant_position = COUNT(variants)` (the current text becomes the
  newest variant);
- `messages.checkpoint_chat_id TEXT` — flag-reference to the child
  checkpoint chat;
- `chats.parent_chat_id TEXT`, `chats.origin TEXT`
  (`'checkpoint'|'branch'|NULL`), `chats.source_message_id TEXT` — snapshot
  chat provenance.

The migration is additive (only `ALTER TABLE ADD COLUMN` + `UPDATE`-backfill,
no table rebuilds) and transactional. There is no automatic `down`: rollback
is a pre-migration backup restore, which the runner creates for a populated
database per the general rules. The model and repositories (`setActiveVariant`,
`activateVariant`, `replaceContentAsVariant`, `linkCheckpoint`,
`SnapshotRepository`) are described in [data](../data/README.md#swipe-history-and-child-chats-migration-0020);
API — `docs/api/README.md` § "Chats and messages".

## 0017 — plugin auth connections

Migration `0017_plugin_auth_connections` creates the
`plugin_auth_connections` table — plugin OAuth connections (rev4 §K5):

- `id` — UUIDv7 `connectionId`, visible to the sandbox and the plugin;
- `plugin_id` (CASCADE), `service_id`, `service_name` — descriptor from the
  `authClients` manifest;
- `scopes_json` — requested scopes;
- `status` — `pending|connected|expired|revoked` (CHECK);
- `token_json` — the only place the access token is stored on the server;
  never serialized in the API and never passed into the sandbox;
- `state` — one-time OAuth `state` (indexed, burned on a successful
  callback), `code_verifier` — PKCE verifier; both are required for the
  server-side code exchange and make a repeated callback impossible;
- `created_at`, `updated_at`.

The migration is additive (`CREATE TABLE IF NOT EXISTS` + indexes on
`plugin_id` and `state`), it does not change data — pre-migration backup per
the general rules (the runner creates it for a populated database); rollback
is a backup restore. No backfill is needed. Repository: `repos.authConnections`
(`packages/db/src/repositories/pluginAuth.ts`). Contract and lifecycle —
`docs/api/README.md` § "Plugin OAuth connections" and
`docs/plugin-sdk/rev4-api.md` § "auth".

## 0016 — plugin state & capability grants

Migration `0016_plugin_state_and_grants` creates two STRICT tables:

- `plugin_state` — user plugin state, separated from `plugin_registry`
  (installation/metadata): `id`, `plugin_id` (CASCADE),
  `scope` (`user|workspace|chat|installation`), `owner_id`, `schema_version`,
  `revision` (monotonic CAS, distinct from schema_version), `data` (JSON),
  `updated_at`; UNIQUE `(plugin_id, scope, COALESCE(owner_id,''))`.
- `plugin_capability_grants` — issued capability grants: `id`,
  `plugin_id` (CASCADE), `name`, `scope` (JSON), `revision`, `granted_at`,
  `expires_at`, `revoked_at`; UNIQUE `(plugin_id, name)`.

Both tables use `CREATE TABLE IF NOT EXISTS` + indexes on `plugin_id`; the
migration is additive, idempotent, does not change data — no pre-migration
backup required. Rollback — backup restore per the general rules. No backfill
is needed: grants are recreated from the confirmed manifest at the next
activation, plugin state starts from a clean slate. Repositories:
`repos.pluginState`, `repos.capabilityGrants`
(`packages/db/src/repositories/pluginCapabilities.ts`). Semantics —
`docs/plugin-sdk/README.md` § "Capability kernel (rev4)".

## 0015 — plugin source & dependencies

Migration `0015_plugin_source` adds two nullable columns to `plugin_registry`:

- `source TEXT` — JSON of the installation source: `{"type":"zip"}` for manual
  upload or `{"type":"git","url":"…","ref":"…"}` for installation from a
  repository (`POST /api/v2/plugins/install-git`);
- `dependencies TEXT` — JSON list of npm packages that the built-in installer
  placed in the package's `node_modules` (name/version/tarball/integrity).
  The list is shown in the consent UI before activation.

Existing rows stay NULL; the UI treats a missing `source` as a zip
installation and a missing `dependencies` as a package without dependencies.
The migration is additive (`ALTER TABLE ADD COLUMN`) and transactional, does
not change data, so a mandatory pre-migration backup is not required;
rollback — backup restore per the general rules. No backfill is needed.

## 0013 — chat sort order

Migration `0013_chat_sort_order` adds the `sort_order` column
(INTEGER NOT NULL DEFAULT 0) to `chats` and the index
`chats_character_sort_idx (character_id, sort_order, updated_at, id)` to match
the exact `ORDER BY` of the chat list. New chats get `sort_order = 0` and end
up at the top of the character's list thanks to the `updated_at DESC`
tie-break. Manual drag ordering is overridden via
`PUT /api/v2/chats/order`, which writes monotonically increasing values for
the listed chats. The migration is additive (`ALTER TABLE ADD COLUMN` +
`CREATE INDEX IF NOT EXISTS`) and idempotent; rollback — pre-migration backup
restore. No backfill is required: the column has a non-null default and the
existing order stays "newest first".

## 0012 — character sort columns

Migration `0012_character_sort_columns` adds three derived columns to
`characters` for extended catalog sorting: `favorite`
(INTEGER NOT NULL DEFAULT 0), `chat_count`, and `token_count` (both INTEGER
NOT NULL DEFAULT 0). `favorite` is backfilled from `ext.favorite` /
`ext.legacy.favorite` (mirror; `ext` remains the source of truth and is
synchronized in `characters.update()` when `ext` changes).
`chat_count` is backfilled with the number of the character's non-deleted
chats, `token_count` with the sum of `length(content)` of messages in
non-deleted chats (a volume metric, not real tokens). The
`chat_count`/`token_count` columns are maintained by SQL triggers on `chats`
(`AFTER INSERT`, `BEFORE DELETE`, `AFTER UPDATE OF character_id, deleted_at`)
and `messages` (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE OF content`);
`BEFORE DELETE` on `chats` is needed because `ON DELETE CASCADE` deletes
messages before `AFTER DELETE`. Indexes `characters_favorite_idx`,
`characters_chat_count_idx`, `characters_token_count_idx` are added to match
the browser's exact `ORDER BY`. The migration is additive
(`ALTER TABLE ADD COLUMN` + `CREATE INDEX/TRIGGER IF NOT EXISTS`) and
idempotent; rollback — pre-migration backup restore, which the runner creates
for a populated database.

## 0011 — character FTS tags

Migration `0011_character_fts_tags` makes character tags full-text searchable:
it recreates `characters_fts` with the `tags` column (tag names separated by
spaces), fills it from `character_tags`/`tags`, recreates the
`characters_ai`/`characters_au` triggers with tags in mind, and adds
`character_tags_ai`/`character_tags_ad` triggers that synchronize the index
when tag links change. FTS5 does not support `ALTER TABLE ADD COLUMN`, so the
index is rebuilt from the base tables; this is derived data, and the runner's
transaction makes the swap atomic. Free text now also finds characters by tag
names; the `tag:` SQL filter in the character repository is unaffected. There
is no automatic `down`; rollback — pre-migration backup restore (the runner
creates it when upgrading a populated database per the general rules).

## 0010 — connection profiles

Migration `0010_connection_profiles` owns the `connection_profiles` table
used by the connection-profile repository. This audit enables the existing
table; it does not introduce another migration and does not rewrite or delete
old profile rows. The Drizzle declaration is intentionally retained because it
is the shared runtime/schema source for the repository. Migration tests verify
that the declaration is available after both a clean migration and an existing
database upgrade.

Migrations are versioned SQL scripts (`packages/db/src/migrations/`), applied
automatically at server startup, and tracked in the `_migrations` table
(version, name, time). Each runs exactly once.

## Guarantees

- transactionality: a failed migration rolls back and the database stays on
  the previous version;
- idempotency via `IF NOT EXISTS` + a strict version;
- a backup is created before a dangerous migration;
- data reads never perform hidden destructive changes.

## Backup and restore

- `POST /api/v2/backups` — online backup via the SQLite Backup API (safe with WAL);
- `GET /api/v2/backups` — list (cache/logs not included);
- `POST /api/v2/backups/:id/restore` — creates a safety snapshot of the
  current state, checks the selected database via `PRAGMA quick_check`, and
  copies it into the live database via the SQLite Online Backup API. The
  connection and repository stay open; the response contains
  `restartRequired: false`, and subsequent reads and writes work without a
  restart;
- restore requires no external SQLite tools. A snapshot or copy error returns
  `RESTORE_FAILED`, and the safety backup is kept.
- restore runs exclusively under a global maintenance lock (ТЗ §10.4): while
  it is held, new product mutations — including plugin activation — are
  rejected with `MAINTENANCE_MODE` (503), and a second restore is refused.
  Read-only requests and backup/diagnostics tooling keep working; the lock is
  released on every exit path (success and failure).

## Manual run

```bash
pnpm db:migrate     # apply migrations to data/app.db (NEOTA_DATA_DIR)
```

## Compatibility

A schema change is accompanied by a migration and an entry in
[CHANGELOG](../../CHANGELOG.md); breaking data changes get an explicit note on
the presence/absence of rollback.

## 0001 — content and imports

Adds without rewriting existing tables:

- character versions;
- attachment metadata;
- lorebooks and lore entries with FTS5;
- presets;
- regenerable cache metadata;
- a journal of idempotent imports.

The migration is additive, so an automatic pre-migration backup is not
required. On error, the whole version is rolled back by the transaction.
There is no automatic `down`: rollback is done by restoring a backup or by
deleting only the new tables when the absence of needed data is confirmed. The
migration test checks upgrading a populated version-0 database, a rerun, and
rollback of erroneous SQL.

## 0002 — import artifacts

Adds the STRICT table `import_artifacts`:

- `(source_kind, source_key)` — stable identity of the external object;
- `source_hash` — content control;
- `target_kind`, `target_id` — local entity;
- `status` — `importing` or `complete`;
- `metadata` — unknown source fields and diagnostic context without secrets.

The migration is additive: existing tables and rows are not changed, so an
automatic pre-migration backup is not required. The SQL runs transactionally.
There is no automatic `down`; rollback — backup restore or deleting
`import_artifacts` if the imported data is no longer needed. Deleting only the
mapping table does not delete created characters, chats, or other user
entities.

## 0003 — repeatable import jobs

Replaces the unique partial index `import_jobs_completed_source_idx` with a
regular partial index on `(source_hash, completed_at DESC)`. This allows
deliberately running one ZIP several times with different category selections
or conflict policies while keeping fast lookup of the last successful run for
the compatible one-step API.

`import_jobs` rows, user entities, and summaries are not changed. The
migration runs transactionally and does not require an automatic
pre-migration backup. There is no automatic `down`; manual rollback is only
possible after deleting repeated completed jobs with the same `source_hash`,
otherwise the unique index cannot be restored. The migration test checks a
populated-database upgrade, a rerun, and the allowance of two completed jobs
for one archive.

## 0004 — plugin consent

Adds two fields to the existing `plugin_registry`:

- `granted_permissions TEXT NOT NULL DEFAULT '[]'` separates the permissions
  requested by the current manifest from the set explicitly confirmed by the
  user;
- `last_error_code TEXT` stores the stable machine code of the last runtime
  error without serializing the developer message into the UI.

Existing plugins do not get permissions automatically after the update: the
empty default moves a package with requested capabilities into
`needs-consent`. The migration is additive and transactional, does not change
plugin user files, so a mandatory pre-migration backup is not required.
There is no automatic `down`. For manual rollback you must first disable the
plugins, export the needed consent/error data, and restore a version-3 schema
backup; SQLite does not support safely dropping these columns without a table
rebuild.

## 0008 — prompt context audits

Adds the STRICT table `prompt_context_audits` for the last complete
generation audit of each chat:

- `chat_id` — primary key and `ON DELETE CASCADE` reference to the chat;
- `generation_id` — attempt identifier with an index for diagnostics;
- `payload` — validated JSON `PromptContextAudit`;
- `created_at` — audit preparation time.

One row per chat limits prompt-content duplication: the next attempt
atomically replaces the previous one. The migration is additive, does not
change existing chats and messages, so a pre-migration backup is not required.
There is no automatic `down`; manual rollback deletes only the table and its
index, thereby losing diagnostic audits but not user chats or messages.

## 0009 — provider secrets

Moves provider API keys into the separate STRICT table `provider_secrets` so
that each provider can hold several named keys:

- `id` — primary key (UUIDv7 for runtime rows);
- `provider_id` — `ON DELETE CASCADE` reference to `provider_configs(id)`;
- `label` — optional human-readable label;
- `value` — the plaintext key (written/read only by the server, masked outside);
- `active` — exactly one active key per provider;
- `created_at` — creation time (used for reactivation order).

Index `provider_secrets_provider_idx` on `provider_id`.

The migration moves data: a non-empty legacy `provider_configs.api_key` value
becomes the provider's single active secret (`label = 'migrated'`), after
which the column is nulled. Key material is not lost; runtime reads
(`getFullConfig`) prefer the active secret and use the column only as a
fallback for non-migrated databases. Empty or NULL keys are not moved.

The migration changes existing rows, so the runner makes a pre-migration
backup per the general rules. There is no automatic `down`; the documented
manual rollback — moving the active secret back into the `api_key` column and
dropping the table — is destructive for additional (inactive) keys and must
be performed deliberately, not silently.

## 0021 — message content revisions

`0021_message_content_revisions` adds `messages.content_revision_count` with a
non-null zero default, then creates the STRICT `message_content_revisions` table:

- `id`, `message_id`, `position`, `content`, `created_at`;
- `FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE`;
- a lookup index on `message_id` and a unique `(message_id, position)` index.

The migration is additive and does not backfill a historical value that did not exist:
all pre-migration messages start with revision count zero. Fresh-schema parity and a
populated version-0 upgrade are covered by migration tests.

There is intentionally no destructive SQL down migration. Before applying a newer
schema to an on-disk database, the migration runner creates its versioned
`pre-migration` backup. Rollback means closing the app and restoring that automatically
created database backup; copying the backup first preserves the failed-upgrade evidence.
