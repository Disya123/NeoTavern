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
    migration_4_sql!()
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
