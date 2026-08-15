//! Database schema (ТЗ §22-§25, Фаза 2; ТЗ §78 Фаза 3).
//!
//! Defines the ordered migrations: v1 (`001_initial_schema`) — the three
//! STRICT foundation tables — v2 (`002_product_core`) — the STRICT product
//! tables — v3 (`003_generation_durability`) — the recoverable generation
//! tables — and v4 (`004_provider_configs`) — the user-configured provider
//! table — plus the fresh-install fingerprint used to detect schema drift.
//! `FRESH_SCHEMA_SQL` is the concatenation of all migration literals, so a
//! fresh install produces exactly the schema that running the migrations in
//! order would produce.
//!
//! The migration SQL lives in `macro_rules!` bodies rather than bare `const`
//! literals because `concat!` only accepts literals — not `const` items — so
//! `FRESH_SCHEMA_SQL` cannot be written as `concat!(MIGRATION_1_SQL, …)`. The
//! macros expand to the literal both in the standalone migration consts and in
//! the `concat!`-based `FRESH_SCHEMA_SQL`, so the SQL text exists exactly once
//! and can never drift between the two.

use sha2::{Digest, Sha256};

/// Literal body of the initial (v1) schema migration, verbatim per
/// `storage-design.md` §S3: a single statement list building the three STRICT
/// foundation tables; nothing else.
macro_rules! migration_1_sql {
    () => {
        r#"CREATE TABLE __neotavern_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;
CREATE TABLE __neotavern_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE __neotavern_assets (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    relative_key TEXT NOT NULL UNIQUE,
    checksum_sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
) STRICT;"#
    };
}

/// Literal body of the product-core (v2) schema migration, verbatim per
/// `phase3-design.md` §StorageMig2: the five STRICT product tables
/// (`characters`, `chats`, `messages`, `lorebooks`, `presets`) plus the
/// message-ordering index; nothing else.
macro_rules! migration_2_sql {
    () => {
        r#"CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    avatar_asset_id TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    ext_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    generation_run_id TEXT,
    created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_messages_chat_seq ON messages(chat_id, sequence);
CREATE TABLE lorebooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    entries_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;"#
    };
}

/// Literal body of the generation-durability (v3) schema migration
/// (ТЗ §62, Фаза 6): the two STRICT tables backing recoverable generation
/// workflows — `generation_runs` (durable state machine row with CAS
/// `revision`, cancel flag, event cursor, partial length, error payload,
/// message link and executor lease) and `generation_events` (append-only
/// sequenced durable event log per run) — plus the chat-scoped run index.
macro_rules! migration_3_sql {
    () => {
        r#"CREATE TABLE generation_runs (
  id TEXT PRIMARY KEY,
  source_run_id TEXT REFERENCES generation_runs(id),
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','preparing','streaming','completed','failed','cancelling','cancelled','interrupted')),
  provider TEXT,
  model TEXT,
  request_snapshot_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  last_event_sequence INTEGER NOT NULL DEFAULT -1,
  partial_length INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  message_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_generation_runs_chat ON generation_runs(chat_id, started_at);
CREATE TABLE generation_events (
  run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
) STRICT;"#
    };
}

/// Literal body of the provider-configs (v4) schema migration
/// (ТЗ §78, Фаза 7): the STRICT `provider_configs` table holding
/// user-configured provider instances — per-provider display name, opaque
/// JSON config, optional secret reference and timestamps — plus the unique
/// `(provider, name)` index; nothing else.
macro_rules! migration_4_sql {
    () => {
        r#"CREATE TABLE provider_configs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_provider_configs_provider_name ON provider_configs(provider, name);"#
    };
}

/// Literal body of the prompt-plans (v5) schema migration (ТЗ §9.2,
/// Этап 2.6): the STRICT `prompt_plans` table holding one immutable
/// [`PromptPlan`] per generation run — the kernel's durable record of what
/// context entered the provider request (selected history, excluded
/// messages, token counts) so the user can later inspect what was included
/// or cut (§9.2). A run carries at most one plan; retry attempts create new
/// runs and therefore new plans.
macro_rules! migration_5_sql {
    () => {
        r#"CREATE TABLE prompt_plans (
  run_id TEXT PRIMARY KEY REFERENCES generation_runs(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_prompt_plans_chat ON prompt_plans(chat_id);"#
    };
}

/// Literal body of the generation-steps (v6) schema migration (ТЗ §8.3,
/// Этап 2.7): the durable `generation_steps` journal — one immutable row per
/// provider turn, tool call and tool result with a monotonic per-run
/// `sequence`, type, status, attempt, idempotency key and bounded JSON
/// input/output — plus the run's `pending_tool_call_json` column: the
/// outstanding normalized tool request a run waits on. A waiting run keeps
/// the v3 `status = 'streaming'` (the CHECK is untouched); the wire status
/// `waiting_for_tool` is DERIVED by the kernel from
/// `pending_tool_call_json IS NOT NULL`, so no `CHECK` rebuild is needed and
/// the child tables (events, prompt plans) are never at risk.
macro_rules! migration_6_sql {
    () => {
        r#"ALTER TABLE generation_runs ADD COLUMN pending_tool_call_json TEXT;
CREATE TABLE generation_steps (
  run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
) STRICT;
CREATE INDEX idx_generation_steps_run ON generation_steps(run_id);"#
    };
}

/// Literal body of the personas (v7) schema migration (ТЗ §8.1 Library
/// context, Этап 4.1): the STRICT `personas` table — the "user" identity
/// injected into the prompt pipeline as `{{user}}`. `is_default` is a
/// plain boolean flag; the single-default invariant is enforced by the
/// kernel on create/update (clearing any previous default), matching the
/// legacy `PersonaRepository`.
macro_rules! migration_7_sql {
    () => {
        r#"CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  avatar TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;"#
    };
}

macro_rules! migration_8_sql {
    () => {
        r#"ALTER TABLE messages ADD COLUMN updated_at TEXT;

CREATE TABLE message_variants (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_message_variants_position ON message_variants(message_id, position);

CREATE TABLE message_content_revisions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_message_content_revisions_position
  ON message_content_revisions(message_id, position);

CREATE TABLE message_drafts (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  committed_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_message_drafts_chat ON message_drafts(chat_id);"#
    };
}

/// Literal body of the memories/presets-kind (v9) schema migration (ТЗ §4.4
/// Memory/RAG, Этап 4 slice 3): the STRICT `memories` table — long-lived
/// knowledge fragments the prompt pipeline injects by keyword match, scoped
/// `global` or `character` (character references are preserved, not
/// cascade-deleted, so unknown legacy references survive conversion) — plus
/// the `presets.kind` column (the v2 `presets` table predates kinds; the
/// legacy `presets` repo enforces kind + data and a unique `(kind, name)`,
/// mirrored here with `settings_json` carrying the wire `data` payload).
macro_rules! migration_9_sql {
    () => {
        r#"ALTER TABLE presets ADD COLUMN kind TEXT NOT NULL DEFAULT 'generation';
CREATE UNIQUE INDEX idx_presets_kind_name ON presets(kind, name);
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'character')),
  character_id TEXT,
  keys_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_memories_character ON memories(character_id);"#
    };
}

/// Literal body of the chat-persona (v10) schema migration (Этап 4 slice 3,
/// ADR-0047 waiver 5): `chats.persona_id` — the "user persona" applied by the
/// prompt pipeline. Mirrors the legacy Drizzle layout
/// (`packages/db` migration 0000: `persona_id REFERENCES personas(id) ON
/// DELETE SET NULL`); `SET NULL` keeps chats alive when a persona is deleted.
macro_rules! migration_10_sql {
    () => {
        r#"ALTER TABLE chats ADD COLUMN persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL;"#
    };
}

/// Literal body of the settings (v11) schema migration — the
/// `migration_11_sql!()` literal. Adds the STRICT `settings` table: the
/// canonical non-secret settings store (key → JSON object value, ТЗ §8.1
/// Configuration). Secrets NEVER live here — provider keys live in the
/// SecretStore (ТЗ §9.4, SEC-01); the table carries no secret material.
macro_rules! migration_11_sql {
    () => {
        r#"CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;"#
    };
}

/// Literal body of the plugins (v12) schema migration — the
/// `migration_12_sql!()` literal. Adds the STRICT `plugins` table: the
/// canonical Extensions-context registry (ТЗ §8.1 Extensions, §SEC-05,
/// Этап 4 slice 6). Each row is the DURABLE lifecycle state of one plugin:
/// version, `enabled`, the package-trust state (`built-in` /
/// `verified-publisher` / `locally-trusted` / `unsigned-untrusted`), the
/// optional publisher key fingerprint, the GRANTED permission set (recorded
/// at install/update — the install/update request IS the consent moment) and
/// the opaque manifest. The table holds NO code, NO secrets and NO handles —
/// execution and cleanup live in the isolated host executor behind the
/// versioned capability protocol (ТЗ §14.1); the kernel only records what
/// was verified and consented.
macro_rules! migration_12_sql {
    () => {
        r#"CREATE TABLE plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    manifest_json TEXT NOT NULL DEFAULT '{}',
    permissions_json TEXT NOT NULL DEFAULT '[]',
    last_error_code TEXT,
    source_json TEXT,
    trust_state TEXT NOT NULL DEFAULT 'unsigned-untrusted',
    publisher_key_id TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;"#
    };
}

/// Literal body of the themes (v13) schema migration — the
/// `migration_13_sql!()` literal. Adds the STRICT `themes` table: the
/// canonical Theme-SDK registry (ТЗ §5.2 theme-sdk, Этап 4 slice 6 part 2).
/// A theme is DATA, never code: the manifest (opaque JSON) plus a
/// content-addressed CSS asset reference (`css_asset_id` → an asset
/// published through `assets.put` with kind `theme-css`; the kernel
/// validates existence at install). The single `active` flag names the
/// applied theme (uninstalling the active theme clears it — the shell falls
/// back to the default, AGENTS.md §19: a broken theme must never block
/// interface reset). SEC-05 trust state is recorded the same way as for
/// plugins (themes get no access to chats, keys or the filesystem — the
/// table stores no CSS bytes and no secrets).
macro_rules! migration_13_sql {
    () => {
        r#"CREATE TABLE themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    manifest_json TEXT NOT NULL DEFAULT '{}',
    css_asset_id TEXT,
    trust_state TEXT NOT NULL DEFAULT 'unsigned-untrusted',
    publisher_key_id TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;"#
    };
}

/// Literal body of the profiles (v14) schema migration — the
/// `migration_14_sql!()` literal. Adds the STRICT `profiles` table: the
/// canonical Configuration bounded context (ТЗ §8.1 Configuration —
/// "profiles, non-secret settings, capabilities"; Этап 4 slice 5 remainder
/// part 2). Mirrors the legacy minimal shape (`profiles.id/name/created_at`,
/// packages/db schema tables.ts) plus `updated_at` for renames; the default
/// profile for single-user local mode stays a host-side convention (a
/// profile row is a named user context; nothing references it yet). The
/// per-profile FK columns on product tables and SEC-02 export filtering
/// (ADR-0047 waiver 4) are the slice-5 remainder follow-up this model
/// unblocks.
macro_rules! migration_14_sql {
    () => {
        r#"CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;"#
    };
}

/// `migration_15_sql!()` literal. Binds the character library to the
/// Configuration bounded context (ТЗ §8.1 Configuration, SEC-02, ADR-0047
/// waiver 4, Этап 4 slice 5 remainder part 2): adds the nullable
/// `profile_id` FK on `characters` (`ON DELETE SET NULL` — deleting a
/// profile keeps the characters, they just become unassigned). Chats and
/// messages follow transitively through the character; lorebooks and presets
/// stay the shared library. The index backs both the FK enforcement and the
/// scoped `profile.export` filter.
macro_rules! migration_15_sql {
    () => {
        r#"ALTER TABLE characters ADD COLUMN profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL;
CREATE INDEX idx_characters_profile_id ON characters(profile_id);"#
    };
}

/// Literal body of the character-lorebook scoping (v16) schema migration —
/// the `migration_16_sql!()` literal. Adds the STRICT `character_lorebooks`
/// link table (ТЗ §8.1 Library context, ADR-0047 waiver 2): one optional
/// character per lorebook, so a book is either part of the shared library
/// (no link row) or bound to exactly one character. The unique index on
/// `lorebook_id` enforces one-owner-per-book (a book cannot be shared and
/// character-bound at once), and the composite PK + `character_id` index back
/// the scoped list/retrieval filters.
macro_rules! migration_16_sql {
    () => {
        r#"CREATE TABLE character_lorebooks (
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
    PRIMARY KEY (lorebook_id, character_id),
    UNIQUE (lorebook_id)
) STRICT;
CREATE INDEX idx_character_lorebooks_character_id ON character_lorebooks(character_id);"#
    };
}

/// Name of the initial (v1) schema migration.
pub const MIGRATION_1_NAME: &str = "001_initial_schema";

/// Exact SQL of the initial schema migration (v1) — the `migration_1_sql!()`
/// literal. A single statement list building the three STRICT foundation
/// tables; nothing else.
pub const MIGRATION_1_SQL: &str = migration_1_sql!();

/// Lowercase sha256 hex of the `MIGRATION_1_SQL` string bytes.
///
/// Computed on 2026-08-12: the exact `r#"..."#` literal was extracted from this
/// source file (python, dotall regex between `r#"` and the first `"#;`) and
/// hashed with `hashlib.sha256`; the resulting bytes were independently
/// re-hashed with the `sha256sum` and `openssl dgst -sha256` utilities. All
/// three agree on `e4dd661a…`.
pub const MIGRATION_1_CHECKSUM: &str =
    "e4dd661aca6b25a4174f5ff0313484386a08f87674bf1ec78abc2852bfc8b411";

/// Name of the product-core (v2) schema migration.
pub const MIGRATION_2_NAME: &str = "002_product_core";

/// Exact SQL of the product-core schema migration (v2) — the
/// `migration_2_sql!()` literal.
pub const MIGRATION_2_SQL: &str = migration_2_sql!();

/// Lowercase sha256 hex of the `MIGRATION_2_SQL` string bytes.
///
/// Computed on 2026-08-13: the exact `r#"..."#` literal was extracted from the
/// `migration_2_sql!` macro body in this source file (python, dotall regex
/// between `r#"` and the first `"#;`) and hashed with `hashlib.sha256`; the
/// resulting bytes were independently re-hashed with the `sha256sum` utility.
/// Both agree on `da122add…`.
pub const MIGRATION_2_CHECKSUM: &str =
    "da122add51bf3a6a01cb5e6bff4eec68cdce4836697721331c6a9ca71e59f424";

/// Name of the generation-durability (v3) schema migration.
pub const MIGRATION_3_NAME: &str = "003_generation_durability";

/// Exact SQL of the generation-durability schema migration (v3) — the
/// `migration_3_sql!()` literal.
pub const MIGRATION_3_SQL: &str = migration_3_sql!();

/// Lowercase sha256 hex of the `MIGRATION_3_SQL` string bytes.
///
/// Computed on 2026-08-13: the exact `r#"..."#` literal was extracted from the
/// `migration_3_sql!` macro body in this source file (python, dotall regex
/// between `r#"` and the first `"#;`) and hashed with `hashlib.sha256`; the
/// resulting bytes were independently re-hashed with the `sha256sum` utility.
/// Both agree on the value below.
pub const MIGRATION_3_CHECKSUM: &str =
    "54e7657d9032c4ff1f59980c277d8a78d793a72391841e585366b3332efc0280";

/// Name of the provider-configs (v4) schema migration.
pub const MIGRATION_4_NAME: &str = "004_provider_configs";

/// Exact SQL of the provider-configs schema migration (v4) — the
/// `migration_4_sql!()` literal.
pub const MIGRATION_4_SQL: &str = migration_4_sql!();

/// Lowercase sha256 hex of the `MIGRATION_4_SQL` string bytes.
///
/// Computed on 2026-08-13: the exact `r#"..."#` literal was written to a temp
/// file via node (`crypto.createHash('sha256')` over the literal bytes, no
/// trailing newline) and independently re-hashed with the `sha256sum`
/// utility on that same file. Both agree on `b36e2bc7…`.
pub const MIGRATION_4_CHECKSUM: &str =
    "b36e2bc70f6ee448ede6957b7df538a66de2e0ff04cd5df9c840f6cd4833eaa2";

/// Name of the prompt-plans (v5) schema migration.
pub const MIGRATION_5_NAME: &str = "005_prompt_plans";

/// Exact SQL of the prompt-plans schema migration (v5) — the
/// `migration_5_sql!()` literal.
pub const MIGRATION_5_SQL: &str = migration_5_sql!();

/// Lowercase sha256 hex of the `MIGRATION_5_SQL` string bytes.
///
/// Computed on 2026-08-13: the exact `r#"..."#` literal was written to a temp
/// file via node (`crypto.createHash('sha256')` over the literal bytes, no
/// trailing newline) and independently re-hashed with the `sha256sum`
/// utility on that same file.
pub const MIGRATION_5_CHECKSUM: &str =
    "439d56c8050e27d1373d12df90fdc16c54a423945e0c9c2d51f08b0df58c4fd0";

/// Name of the generation-steps (v6) schema migration.
pub const MIGRATION_6_NAME: &str = "006_generation_steps";

/// Exact SQL of the generation-steps schema migration (v6) — the
/// `migration_6_sql!()` literal.
pub const MIGRATION_6_SQL: &str = migration_6_sql!();

/// Lowercase sha256 hex of the `MIGRATION_6_SQL` string bytes.
///
/// Computed on 2026-08-13: the exact `r#"..."#` literal was written to a temp
/// file via node (`crypto.createHash('sha256')` over the literal bytes, no
/// trailing newline) and independently re-hashed with the `sha256sum`
/// utility on that same file.
pub const MIGRATION_6_CHECKSUM: &str =
    "4e7d2912dea3fb36233d89e77fe282d16a5cad95eb3d338c8b22f6b887aff166";

/// Name of the personas (v7) schema migration.
pub const MIGRATION_7_NAME: &str = "007_personas";

/// Exact SQL of the personas schema migration (v7) — the
/// `migration_7_sql!()` literal.
pub const MIGRATION_7_SQL: &str = migration_7_sql!();

/// Lowercase sha256 hex of the `MIGRATION_7_SQL` string bytes.
///
/// Computed on 2026-08-14 via node (`crypto.createHash('sha256')` over the
/// literal bytes, no trailing newline) and asserted by the migration test
/// suite against the ledger.
pub const MIGRATION_7_CHECKSUM: &str =
    "43535151094b3e5c1b18ea38c4024e4c3edfb86489755ecb6d1374a3b9b9b9cb";

/// Name of the message variants/revisions/drafts (v8) schema migration.
pub const MIGRATION_8_NAME: &str = "008_message_variants_revisions_drafts";

/// Exact SQL of the message variants/revisions/drafts schema migration (v8) —
/// the `migration_8_sql!()` literal. Adds the STRICT child tables for swipe
/// variants, immutable manual content revisions and server-side streaming
/// drafts (Этап 4 slice 2), plus `messages.updated_at`. Variant/revision
/// counts are derived (COUNT over the child tables), so no counter columns.
pub const MIGRATION_8_SQL: &str = migration_8_sql!();

/// Lowercase sha256 hex of the `MIGRATION_8_SQL` string bytes.
///
/// Computed on 2026-08-15 via node (`crypto.createHash('sha256')` over the
/// literal bytes, no trailing newline) and asserted by the migration test
/// suite against the ledger.
pub const MIGRATION_8_CHECKSUM: &str =
    "d8af5103543deaced7f1eabf9b35d4ad528df4645fffe4a45f506a569bdea653";

/// Name of the memories/presets-kind (v9) schema migration.
pub const MIGRATION_9_NAME: &str = "009_memories_presets_kind";

/// Exact SQL of the memories/presets-kind schema migration (v9) — the
/// `migration_9_sql!()` literal. Adds the STRICT `memories` table and the
/// `presets.kind` column + `(kind, name)` uniqueness (Этап 4 slice 3).
pub const MIGRATION_9_SQL: &str = migration_9_sql!();

/// Lowercase sha256 hex of the `MIGRATION_9_SQL` string bytes.
///
/// Computed on 2026-08-17 via node (`crypto.createHash('sha256')` over the
/// literal bytes, no trailing newline) and asserted by the migration test
/// suite against the ledger.
pub const MIGRATION_9_CHECKSUM: &str =
    "0a27e95db6afa600c87900fcd6052c1070a9fc485eae0b141818f9e4a9f77aff";

/// Name of the chat-persona (v10) schema migration.
pub const MIGRATION_10_NAME: &str = "010_chat_persona";

/// Exact SQL of the chat-persona schema migration (v10) — the
/// `migration_10_sql!()` literal. Adds `chats.persona_id` (the user persona
/// applied by the prompt pipeline, ON DELETE SET NULL).
pub const MIGRATION_10_SQL: &str = migration_10_sql!();

/// Lowercase sha256 hex of the `MIGRATION_10_SQL` string bytes.
///
/// Computed via node (`crypto.createHash('sha256')` over the exact literal
/// bytes, no trailing newline) and asserted by the migration test suite
/// against the ledger.
pub const MIGRATION_10_CHECKSUM: &str =
    "72ed2c1fc51ba5f5c0f722bd2b98aeda371caa0c45745ee9fd5e945cf22f1c2c";

/// Name of the settings (v11) schema migration.
pub const MIGRATION_11_NAME: &str = "011_settings";

/// Exact SQL of the settings schema migration (v11) — the
/// `migration_11_sql!()` literal. Adds the STRICT `settings` table (key →
/// JSON object value) for non-secret application settings (Этап 4 slice 7).
pub const MIGRATION_11_SQL: &str = migration_11_sql!();

/// Lowercase sha256 hex of the `MIGRATION_11_SQL` string bytes.
///
/// Computed via node (`crypto.createHash('sha256')` over the exact literal
/// bytes, no trailing newline) and asserted by the migration test suite
/// against the ledger.
pub const MIGRATION_11_CHECKSUM: &str =
    "6f0cc38177e6c0dc14c8c2522f01fe671d64dad61ded5ba0a1e9752456cf595a";

/// Name of the plugins (v12) schema migration.
pub const MIGRATION_12_NAME: &str = "012_plugins";

/// Exact SQL of the plugins schema migration (v12) — the
/// `migration_12_sql!()` literal. Adds the STRICT `plugins` registry table
/// (ТЗ §8.1 Extensions, §SEC-05, Этап 4 slice 6).
pub const MIGRATION_12_SQL: &str = migration_12_sql!();

/// Lowercase sha256 hex of the `MIGRATION_12_SQL` string bytes.
///
/// Computed via node (`crypto.createHash('sha256')` over the exact literal
/// bytes, no trailing newline) and asserted by the migration test suite
/// against the ledger.
pub const MIGRATION_12_CHECKSUM: &str =
    "d6c71609e5e9bf2496123313a7a43151d8a9b0f98cc4082f488cfd0e2dfcfad9";

/// Name of the themes (v13) schema migration.
pub const MIGRATION_13_NAME: &str = "013_themes";

/// Exact SQL of the themes schema migration (v13) — the
/// `migration_13_sql!()` literal. Adds the STRICT `themes` registry table
/// (ТЗ §5.2 theme-sdk, §SEC-05, Этап 4 slice 6 part 2).
pub const MIGRATION_13_SQL: &str = migration_13_sql!();

/// Lowercase sha256 hex of the `MIGRATION_13_SQL` string bytes.
///
/// Computed via node (`crypto.createHash('sha256')` over the exact literal
/// bytes, no trailing newline) and asserted by the migration test suite
/// against the ledger.
pub const MIGRATION_13_CHECKSUM: &str =
    "9ea93630aba3d711ecfa2b85e5240d779724970b938827634b66776e7806cb5d";

/// Name of the profiles (v14) schema migration.
pub const MIGRATION_14_NAME: &str = "014_profiles";

/// Exact SQL of the profiles schema migration (v14) — the
/// `migration_14_sql!()` literal. Adds the STRICT `profiles` table (ТЗ
/// §8.1 Configuration, Этап 4 slice 5 remainder part 2).
pub const MIGRATION_14_SQL: &str = migration_14_sql!();

/// Lowercase sha256 hex of the `MIGRATION_14_SQL` string bytes.
///
/// Computed via node (`crypto.createHash('sha256')` over the exact literal
/// bytes, no trailing newline) and asserted by the migration test suite
/// against the ledger.
pub const MIGRATION_14_CHECKSUM: &str =
    "7be80c2213d0f3abd95af819c4cd86b6b9b65567d953d277c9efef3465c9561d";

/// Name of the character-profile (v15) schema migration.
pub const MIGRATION_15_NAME: &str = "015_character_profiles";

/// Exact SQL of the character-profile schema migration (v15) — the
/// `migration_15_sql!()` literal. Adds the nullable `profile_id` FK on
/// `characters` plus its index (SEC-02 scoped export, ADR-0047 waiver 4).
pub const MIGRATION_15_SQL: &str = migration_15_sql!();

/// Lowercase sha256 hex of the `MIGRATION_15_SQL` string bytes.
///
/// Computed via node (`crypto.createHash('sha256')` over the exact literal
/// bytes, no trailing newline) and asserted by the migration test suite
/// against the ledger.
pub const MIGRATION_15_CHECKSUM: &str =
    "6f7d896fcfb67e9c7036a58a448e67286af5b7b612d25e44f88d1c86ae9c37f2";

/// Name of the character-lorebook scoping (v16) schema migration.
pub const MIGRATION_16_NAME: &str = "016_character_lorebooks";

/// Exact SQL of the character-lorebook scoping schema migration (v16) — the
/// `migration_16_sql!()` literal. Adds the STRICT `character_lorebooks` link
/// (ADR-0047 waiver 2).
pub const MIGRATION_16_SQL: &str = migration_16_sql!();

/// Lowercase sha256 hex of the `MIGRATION_16_SQL` string bytes.
///
/// Computed via node (`crypto.createHash('sha256')` over the exact literal
/// bytes, no trailing newline) and asserted by the migration test suite
/// against the ledger.
pub const MIGRATION_16_CHECKSUM: &str =
    "8f8309b986b3152b5e14207b2ade95e8a2d32d0f5922abf6af41a86a7d8c0778";

/// A fresh install runs every migration in order, so `FRESH_SCHEMA_SQL` is the
/// concatenation of all migration literals with a single newline between them
/// (the same statement separator `execute_batch` applies).
///
/// `concat!` requires literals rather than `const` items, hence the
/// `migration_{1,2,3,4}_sql!()` macro indirection; the SQL text itself is not
/// duplicated here.
pub const FRESH_SCHEMA_SQL: &str = concat!(
    migration_1_sql!(),
    "\n",
    migration_2_sql!(),
    "\n",
    migration_3_sql!(),
    "\n",
    migration_4_sql!(),
    "\n",
    migration_5_sql!(),
    "\n",
    migration_6_sql!(),
    "\n",
    migration_7_sql!(),
    "\n",
    migration_8_sql!(),
    "\n",
    migration_9_sql!(),
    "\n",
    migration_10_sql!(),
    "\n",
    migration_11_sql!(),
    "\n",
    migration_12_sql!(),
    "\n",
    migration_13_sql!(),
    "\n",
    migration_14_sql!(),
    "\n",
    migration_15_sql!(),
    "\n",
    migration_16_sql!()
);

/// sha256 hex of the `FRESH_SCHEMA_SQL` bytes — the fresh-install fingerprint.
///
/// Computed at runtime with the `sha2` crate so the fingerprint can never
/// drift from the actual schema text.
pub fn schema_fingerprint() -> String {
    sha256_hex(FRESH_SCHEMA_SQL.as_bytes())
}

/// Lowercase sha256 hex of `bytes`.
fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing to a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}
