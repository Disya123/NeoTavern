//! Integration tests for the staged legacy→kernel migration
//! (`neotavern_storage::migration`, ТЗ §10.3, ADR-0041, Этап 3): the full
//! prepare→commit lifecycle, idempotent re-run, cancel before activation,
//! preflight failures, the verified safety copy, the retained rollback
//! pointer, and the journal stage history.

use std::fs;
use std::path::Path;

use neotavern_storage::activation::{
    active_root, latest_entry, ActivationStatus, ACTIVATION_JOURNAL_FILE,
};
use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::legacy::convert_legacy;
use neotavern_storage::migration::{cancel, commit, migrate, prepare, MigrationStage};
use neotavern_storage::migrations::MigrationProgress;
use neotavern_storage::open::open;
use neotavern_storage::restore::Candidate;
use neotavern_storage::StorageErrorCode;

/// Builds a legacy Drizzle-schema database (shared fixture with the legacy
/// converter tests): two characters, one chat + one orphan chat, three
/// messages in the kept chat + one in the orphan chat, two lorebooks with one
/// entry, one preset, and a provider_configs row carrying a fake api key.
fn build_legacy(path: &Path) -> rusqlite::Result<()> {
    let conn = rusqlite::Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE characters (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, avatar TEXT,
            ext TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE chats (
            id TEXT PRIMARY KEY, title TEXT, character_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT, content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE lorebooks (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE lore_entries (
            id TEXT PRIMARY KEY, lorebook_id TEXT NOT NULL, keys_json TEXT, secondary_keys TEXT,
            content TEXT NOT NULL, enabled INTEGER DEFAULT 1, position INTEGER DEFAULT 0,
            constant INTEGER DEFAULT 0, selective INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE presets (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE provider_configs (
            id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, config TEXT, api_key TEXT
        );",
    )?;
    conn.execute(
        "INSERT INTO characters (id, name, description, avatar, ext, created_at, updated_at) \
         VALUES ('leg-c1', 'Alice', 'A legacy character', 'avatar.png', '{\"legacy\":true}', 1700000000000, 1700000001000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO characters (id, name, created_at, updated_at) \
         VALUES ('leg-c2', 'Bob', 1700000002000, 1700000003000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
         VALUES ('leg-h1', 'First chat', 'leg-c1', 1700000004000, 1700000005000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
         VALUES ('leg-h2', 'Orphan chat', NULL, 1700000006000, 1700000007000)",
        [],
    )?;
    for (id, chat, role, content, created) in [
        ("leg-m1", "leg-h1", "user", "Hello", 1_700_000_008_000i64),
        ("leg-m2", "leg-h1", "assistant", "Hi!", 1_700_000_009_000i64),
        (
            "leg-m3",
            "leg-h1",
            "plugin",
            "Tool result",
            1_700_000_010_000i64,
        ),
        (
            "leg-m4",
            "leg-h2",
            "user",
            "In orphan chat",
            1_700_000_011_000i64,
        ),
    ] {
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, chat, role, content, created],
        )?;
    }
    conn.execute(
        "INSERT INTO lorebooks (id, name, description, created_at, updated_at) \
         VALUES ('leg-l1', 'Sword lore', 'Lore about swords', 1700000012000, 1700000013000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO lore_entries (id, lorebook_id, keys_json, secondary_keys, content, enabled, \
         position, constant, selective, metadata, created_at, updated_at) \
         VALUES ('leg-e1', 'leg-l1', '[\"sword\"]', '[]', 'A sharp sword.', 1, 0, 0, 0, '{}', 1700000016000, 1700000017000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO presets (id, kind, name, data, created_at, updated_at) \
         VALUES ('leg-p1', 'default', 'Preset A', '{\"temp\":0.7}', 1700000018000, 1700000019000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO provider_configs (id, provider, name, config, api_key) \
         VALUES ('pc1', 'openai', 'default', '{}', 'sk-fake-api-key-123')",
        [],
    )?;
    Ok(())
}

fn nop_stage(_: MigrationStage) {}

fn read_name(root: &Path, id: &str) -> String {
    let mut progress = |_: MigrationProgress| {};
    let db = open(root, &ConnectionPolicy::default(), &mut progress).expect("open");
    let name: String = db
        .conn()
        .query_row("SELECT name FROM characters WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .expect("read character");
    drop(db);
    name
}

/// Full lifecycle: prepare → commit → the versioned root becomes active and
/// product reads see the migrated rows; the previous (flat) root is retained.
#[test]
fn prepare_commit_full_lifecycle() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    let prepared = prepare(&data_root, &source, true, &mut nop_stage).expect("prepare");
    assert_eq!(prepared.report.characters, 2);
    assert_eq!(prepared.report.chats, 1, "orphan chat skipped");
    assert_eq!(prepared.report.messages, 3, "orphan message skipped");
    assert!(prepared.backup_path.is_some(), "safety copy created");

    // Journal has a single `validated` entry; nothing is active yet.
    let entry = latest_entry(&data_root)
        .expect("latest")
        .expect("entry present");
    assert_eq!(entry.status, ActivationStatus::Validated);
    assert_eq!(entry.kind, "migration");
    assert_eq!(active_root(&data_root).expect("active root"), data_root);

    let outcome = commit(&data_root, &prepared.entry_id, &mut nop_stage).expect("commit");
    assert_eq!(outcome.active_root, prepared.staging_root);
    assert_eq!(
        active_root(&data_root).expect("active root"),
        prepared.staging_root,
        "pointer switched to the staging root"
    );

    // Product data visible through the active (versioned) root.
    assert_eq!(read_name(&data_root, "leg-c1"), "Alice");
    assert_eq!(read_name(&data_root, "leg-c2"), "Bob");

    // Journal committed.
    let entry = latest_entry(&data_root)
        .expect("latest")
        .expect("entry present");
    assert_eq!(entry.status, ActivationStatus::Committed);
}

/// Idempotent re-run: after a committed migration, `prepare` reports the
/// existing committed entry without staging a second root.
#[test]
fn prepare_after_commit_is_idempotent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    let outcome = migrate(&data_root, &source, true, &mut nop_stage).expect("migrate");
    let roots_before = fs::read_dir(data_root.join("roots"))
        .expect("roots dir")
        .count();

    let again = prepare(&data_root, &source, true, &mut nop_stage).expect("prepare again");
    assert_eq!(
        again.entry_id, outcome.entry_id,
        "same committed entry reported"
    );
    assert_eq!(
        fs::read_dir(data_root.join("roots"))
            .expect("roots dir")
            .count(),
        roots_before,
        "no second staging root created"
    );
}

/// Cancel before activation: `rolled_back`, the previous root stays active,
/// the staging root is removed, the safety copy is retained.
#[test]
fn cancel_before_activation_keeps_previous_root() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    let prepared = prepare(&data_root, &source, true, &mut nop_stage).expect("prepare");
    let staging = prepared.staging_root.clone();
    let backup = prepared.backup_path.clone().expect("backup path");

    cancel(&data_root, &prepared.entry_id).expect("cancel");

    let entry = latest_entry(&data_root)
        .expect("latest")
        .expect("entry present");
    assert_eq!(entry.status, ActivationStatus::RolledBack);
    assert_eq!(
        active_root(&data_root).expect("active root"),
        data_root,
        "previous root stays active"
    );
    assert!(!staging.exists(), "staging root removed on cancel");
    assert!(backup.is_dir(), "safety copy retained");
}

/// Commit requires a validated entry: committing a never-prepared entry is
/// `NotFound`; committing a rolled-back entry is refused.
#[test]
fn commit_validates_entry_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");

    let err =
        commit(&data_root, "no-such-entry", &mut nop_stage).expect_err("unknown entry must fail");
    assert_eq!(err.code, StorageErrorCode::NotFound);

    // A rolled-back entry cannot be committed.
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");
    let prepared = prepare(&data_root, &source, false, &mut nop_stage).expect("prepare");
    cancel(&data_root, &prepared.entry_id).expect("cancel");
    let err = commit(&data_root, &prepared.entry_id, &mut nop_stage)
        .expect_err("rolled-back entry must be refused");
    assert_eq!(err.code, StorageErrorCode::IntegrityViolation);
}

/// Cancel of a committed migration is refused.
#[test]
fn cancel_after_commit_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    let outcome = migrate(&data_root, &source, false, &mut nop_stage).expect("migrate");
    let err = cancel(&data_root, &outcome.entry_id).expect_err("cancel must fail");
    assert_eq!(err.code, StorageErrorCode::IntegrityViolation);
}

/// The safety copy is verified: the copied database bytes match the source.
#[test]
fn safety_copy_matches_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    let prepared = prepare(&data_root, &source, true, &mut nop_stage).expect("prepare");
    let backup = prepared.backup_path.expect("backup path");
    let copy_db = backup.join("database.sqlite");
    assert_eq!(
        fs::read(&copy_db).expect("read copy"),
        fs::read(&source).expect("read source"),
        "safety copy is byte-identical"
    );
    let checksum = fs::read_to_string(backup.join("checksum.sha256")).expect("checksum file");
    let bytes = fs::read(&copy_db).expect("read copy");
    let expected = neotavern_storage::assets::sha256_hex(&bytes);
    assert_eq!(checksum.trim(), expected);
}

/// Non-legacy sources are rejected by the converter inside `prepare` before
/// any staging or journal writes (fail-closed, ТЗ §10.3).
#[test]
fn prepare_rejects_non_legacy_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let foreign = dir.path().join("foreign.db");
    {
        let conn = rusqlite::Connection::open(&foreign).expect("open foreign");
        conn.execute_batch("CREATE TABLE foo (id TEXT PRIMARY KEY)")
            .expect("create table");
    }

    let err =
        prepare(&data_root, &foreign, false, &mut nop_stage).expect_err("non-legacy must fail");
    assert_eq!(err.code, StorageErrorCode::UnsupportedStorageFormat);
    assert!(
        !data_root.join(ACTIVATION_JOURNAL_FILE).exists(),
        "no journal written for a refused migration"
    );
}

/// A missing source is a controlled NotFound from preflight (no writes).
#[test]
fn prepare_rejects_missing_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");

    let err = prepare(
        &data_root,
        &dir.path().join("does-not-exist.db"),
        false,
        &mut nop_stage,
    )
    .expect_err("missing source must fail");
    assert_eq!(err.code, StorageErrorCode::NotFound);
}

/// The `migrate` convenience runs prepare+commit in one call and records the
/// full stage history in the journal.
#[test]
fn migrate_convenience_records_full_history() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    let stages = std::sync::Mutex::new(Vec::new());
    let mut record = |stage: MigrationStage| {
        stages
            .lock()
            .expect("lock")
            .push(stage.as_str().to_string());
    };
    let outcome = migrate(&data_root, &source, true, &mut record).expect("migrate");
    assert_eq!(
        *stages.lock().expect("lock"),
        vec![
            "preflight".to_string(),
            "backup".to_string(),
            "convert".to_string(),
            "validate".to_string(),
            "activate".to_string(),
        ],
        "progress sequence follows ТЗ §10.3"
    );

    let journal = neotavern_storage::activation::read_journal(&data_root).expect("journal");
    let entry = journal.entries.last().expect("last entry");
    assert_eq!(entry.status, ActivationStatus::Committed);
    assert_eq!(entry.id, outcome.entry_id);
    assert!(outcome.previous_root.is_some(), "rollback pointer retained");
}

/// Converted rows carry no provider secrets (the legacy api_key row is not
/// copied) — checked through the migrated root.
#[test]
fn migrated_root_has_no_provider_secrets() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    migrate(&data_root, &source, false, &mut nop_stage).expect("migrate");

    let mut progress = |_: MigrationProgress| {};
    let db = open(&data_root, &ConnectionPolicy::default(), &mut progress).expect("open");
    let secrets: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM provider_configs", [], |r| r.get(0))
        .expect("count provider configs");
    assert_eq!(secrets, 0, "provider configs must never be copied");
    drop(db);
}

/// The converted staging root can also be produced directly through
/// `convert_legacy` into a versioned path — the migration path and the raw
/// converter agree on the target shape.
#[test]
fn migration_target_is_a_convertible_kernel_root() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    let staging = data_root.join("roots").join("root-manual");
    fs::create_dir_all(&data_root).expect("create data root");
    fs::create_dir_all(&staging).expect("create staging");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    let report = convert_legacy(
        &source,
        &Candidate {
            path: staging.clone(),
        },
    )
    .expect("convert");
    assert_eq!(report.characters, 2);
    let db = {
        let mut progress = |_: MigrationProgress| {};
        open(&staging, &ConnectionPolicy::default(), &mut progress).expect("open staging")
    };
    let revision: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .expect("user_version");
    assert_eq!(revision, neotavern_storage::CURRENT_SCHEMA);
    drop(db);
}

// --- migration corpus (ТЗ §17.4) --------------------------------------------

/// Builds a kernel database at schema `version` (migrations 1..=version
/// applied, ledger + meta + application_id set) with a seeded character.
/// Uses the same technique as the open_migrate suite: apply the public
/// migration SQL directly, then record the ledger rows and pragmas.
fn build_kernel_version(root: &Path, version: i64) -> rusqlite::Result<()> {
    use neotavern_storage::schema::{
        MIGRATION_1_CHECKSUM, MIGRATION_1_NAME, MIGRATION_1_SQL, MIGRATION_2_CHECKSUM,
        MIGRATION_2_NAME, MIGRATION_2_SQL, MIGRATION_3_CHECKSUM, MIGRATION_3_NAME, MIGRATION_3_SQL,
        MIGRATION_4_CHECKSUM, MIGRATION_4_NAME, MIGRATION_4_SQL, MIGRATION_5_CHECKSUM,
        MIGRATION_5_NAME, MIGRATION_5_SQL, MIGRATION_6_CHECKSUM, MIGRATION_6_NAME, MIGRATION_6_SQL,
    };
    let conn = rusqlite::Connection::open(neotavern_storage::paths::db_path(root))?;
    let migrations: &[(i64, &str, &str, &str)] = &[
        (1, MIGRATION_1_NAME, MIGRATION_1_CHECKSUM, MIGRATION_1_SQL),
        (2, MIGRATION_2_NAME, MIGRATION_2_CHECKSUM, MIGRATION_2_SQL),
        (3, MIGRATION_3_NAME, MIGRATION_3_CHECKSUM, MIGRATION_3_SQL),
        (4, MIGRATION_4_NAME, MIGRATION_4_CHECKSUM, MIGRATION_4_SQL),
        (5, MIGRATION_5_NAME, MIGRATION_5_CHECKSUM, MIGRATION_5_SQL),
        (6, MIGRATION_6_NAME, MIGRATION_6_CHECKSUM, MIGRATION_6_SQL),
    ];
    for (id, name, checksum, sql) in migrations.iter().take(version as usize) {
        conn.execute_batch(sql)?;
        conn.execute(
            "INSERT INTO __neotavern_migrations (id, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, name, checksum, "2026-08-13T10:00:00Z"],
        )?;
    }
    conn.execute_batch(&format!(
        "PRAGMA application_id = {}; PRAGMA user_version = {version};",
        neotavern_storage::APPLICATION_ID
    ))?;
    conn.execute(
        "INSERT INTO __neotavern_meta (key, value) VALUES ('storageFormat', '1')",
        [],
    )?;
    // A character survives in every version that has the product table (v2+).
    if version >= 2 {
        conn.execute(
            "INSERT INTO characters (id, name, description, tags_json, ext_json, created_at, updated_at) \
             VALUES ('corpus-c1', 'Corpus', NULL, '[]', '{}', '2026-08-13T10:00:00Z', '2026-08-13T10:00:00Z')",
            [],
        )?;
    }
    drop(conn);
    Ok(())
}

/// Corpus: every released schema version (1..=CURRENT) opens and migrates to
/// the current revision with its seed preserved (ТЗ §17.4 "чистые БД всех
/// released schema versions").
#[test]
fn corpus_all_released_schema_versions_upgrade() {
    for version in 1..=neotavern_storage::CURRENT_SCHEMA {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        build_kernel_version(&root, version).expect("build kernel version");

        let mut progress = |_: MigrationProgress| {};
        let db = open(&root, &ConnectionPolicy::default(), &mut progress)
            .unwrap_or_else(|e| panic!("version {version} must open: {e}"));
        assert_eq!(
            db.schema_revision().expect("revision"),
            neotavern_storage::CURRENT_SCHEMA,
            "version {version} migrates to current"
        );
        if version >= 2 {
            let count: i64 = db
                .conn()
                .query_row("SELECT COUNT(*) FROM characters", [], |r| r.get(0))
                .expect("count characters");
            assert_eq!(count, 1, "version {version} keeps its seed");
        }
        drop(db);
    }
}

/// Corpus: a future schema version fails closed with SchemaTooNew and the
/// database is never written (ТЗ §17.4 "future schema version").
#[test]
fn corpus_future_schema_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    build_kernel_version(&root, neotavern_storage::CURRENT_SCHEMA).expect("build current");
    let conn = rusqlite::Connection::open(neotavern_storage::paths::db_path(&root))
        .expect("open for tampering");
    conn.pragma_update(None, "user_version", neotavern_storage::CURRENT_SCHEMA + 1)
        .expect("bump user_version");
    drop(conn);

    let mut progress = |_: MigrationProgress| {};
    let err = open(&root, &ConnectionPolicy::default(), &mut progress)
        .expect_err("future schema must fail");
    assert_eq!(err.code, StorageErrorCode::SchemaTooNew);
}

/// Corpus: a corrupted database page is detected by quick_check on open and
/// reported as Corrupt — never silently repaired (ТЗ §17.4 "corrupted
/// page/WAL").
#[test]
fn corpus_corrupted_database_is_detected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    build_kernel_version(&root, neotavern_storage::CURRENT_SCHEMA).expect("build current");

    // Flip bytes mid-file to corrupt a page; quick_check must catch it.
    let path = neotavern_storage::paths::db_path(&root);
    let mut bytes = fs::read(&path).expect("read db");
    let corrupt_at = bytes.len() / 2;
    bytes[corrupt_at] = bytes[corrupt_at].wrapping_add(0x5A);
    fs::write(&path, bytes).expect("write corrupted db");

    let mut progress = |_: MigrationProgress| {};
    let err = open(&root, &ConnectionPolicy::default(), &mut progress)
        .expect_err("corrupt database must fail");
    assert_eq!(err.code, StorageErrorCode::Corrupt);
}

/// Corpus: legacy migration is interrupted at `prepared` (kill between
/// convert and validated) and the next `prepare` recovers — a new staging
/// root is created and the old one is not committed (ТЗ §17.4 "interrupted
/// legacy migration").
#[test]
fn corpus_interrupted_migration_recovers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    // First run stages + validates but the "host" dies before commit: the
    // entry is left at `validated` (a kill between validate and commit).
    let prepared = prepare(&data_root, &source, false, &mut nop_stage).expect("prepare");
    let first_staging = prepared.staging_root.clone();
    assert!(first_staging.is_dir(), "staging exists before the kill");

    // The next run creates a fresh staging root and commits it.
    let outcome = migrate(&data_root, &source, false, &mut nop_stage).expect("migrate");
    assert_ne!(
        outcome.active_root, first_staging,
        "fresh staging on recovery"
    );
    assert_eq!(
        active_root(&data_root).expect("active root"),
        outcome.active_root
    );
    assert!(read_name(&data_root, "leg-c1") == "Alice", "data migrated");
}

// --- migration corpus: real Drizzle schema (ТЗ §17.4) ------------------------

/// Builds a legacy database matching the REAL Drizzle layout (0000_init +
/// later ALTERs): the inline `tags` column is absent, tags live in the
/// `character_tags`/`tags` join, characters carry the known card columns
/// (personality, scenario, first_message, example_dialogues, system_prompt,
/// post_history_instructions, creator, creator_notes), and rows can be
/// soft-deleted via `deleted_at`.
fn build_real_legacy(path: &Path) -> rusqlite::Result<()> {
    let conn = rusqlite::Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE characters (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, description TEXT NOT NULL DEFAULT '',
            personality TEXT NOT NULL DEFAULT '', scenario TEXT NOT NULL DEFAULT '',
            first_message TEXT NOT NULL DEFAULT '', example_dialogues TEXT NOT NULL DEFAULT '',
            system_prompt TEXT, post_history_instructions TEXT, creator TEXT, creator_notes TEXT,
            ext TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            deleted_at INTEGER
        );
        CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        CREATE TABLE character_tags (
            character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
            tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (character_id, tag_id)
        );
        CREATE TABLE chats (
            id TEXT PRIMARY KEY, character_id TEXT, persona_id TEXT,
            title TEXT NOT NULL DEFAULT 'New chat', active_branch_id TEXT,
            summary TEXT NOT NULL DEFAULT '', message_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, branch_id TEXT NOT NULL, parent_id TEXT,
            role TEXT NOT NULL, content TEXT NOT NULL, name TEXT, meta TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE lorebooks (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE lore_entries (
            id TEXT PRIMARY KEY, lorebook_id TEXT NOT NULL, keys_json TEXT, secondary_keys TEXT,
            content TEXT NOT NULL, enabled INTEGER DEFAULT 1, position INTEGER DEFAULT 0,
            constant INTEGER DEFAULT 0, selective INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE presets (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE provider_configs (
            id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, config TEXT, api_key TEXT
        );",
    )?;
    conn.execute(
        "INSERT INTO characters (id, name, description, personality, scenario, first_message, \
         example_dialogues, system_prompt, post_history_instructions, creator, creator_notes, \
         ext, created_at, updated_at) VALUES \
         ('real-c1', 'שרה', 'RTL: تَقْدِيم', 'Brave heart', 'A far land', 'Hello there', \
          'Example: *waves*', 'System: be kind', 'After: continue', 'creator@example.com', \
          'notes in Hebrew עברית', '{\"unknown\":\"kept\",\"nested\":{\"a\":1}}', \
          1700000000000, 1700000001000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO characters (id, name, description, ext, created_at, updated_at, deleted_at) \
         VALUES ('real-c2', 'Deleted', '', '{}', 1700000002000, 1700000003000, 1700000004000)",
        [],
    )?;
    for (id, name) in [("t1", "knight"), ("t2", "NSFW"), ("t3", "עברית")] {
        conn.execute(
            "INSERT INTO tags (id, name) VALUES (?1, ?2)",
            rusqlite::params![id, name],
        )?;
    }
    for (character, tag) in [("real-c1", "t1"), ("real-c1", "t3"), ("real-c1", "t1")] {
        conn.execute(
            "INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![character, tag],
        )?;
    }
    conn.execute(
        "INSERT INTO chats (id, character_id, persona_id, title, active_branch_id, summary, \
         message_count, created_at, updated_at) VALUES \
         ('real-h1', 'real-c1', NULL, 'חדר המבחן', 'b1', 'summary', 2, 1700000005000, 1700000006000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO chats (id, character_id, title, created_at, updated_at, deleted_at) \
         VALUES ('real-h2', 'real-c1', 'Deleted chat', 1700000007000, 1700000008000, 1700000009000)",
        [],
    )?;
    // A very long message (unicode/RTL/long-value corpus item).
    let long = "ל".repeat(20_000);
    conn.execute(
        "INSERT INTO messages (id, chat_id, branch_id, parent_id, role, content, name, meta, created_at) \
         VALUES ('real-m1', 'real-h1', 'b1', NULL, 'user', ?1, 'name', '{\"swipes\":2}', 1700000010000)",
        [&long],
    )?;
    conn.execute(
        "INSERT INTO messages (id, chat_id, branch_id, parent_id, role, content, name, meta, created_at) \
         VALUES ('real-m2', 'real-h1', 'b1', 'real-m1', 'assistant', 'ردّ بالعربية', NULL, '{}', 1700000011000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO presets (id, kind, name, data, created_at, updated_at) \
         VALUES ('real-p1', 'default', 'Preset', '{\"temp\":0.7}', 1700000012000, 1700000013000)",
        [],
    )?;
    Ok(())
}

fn read_ext_json(root: &Path, id: &str) -> serde_json::Value {
    let mut progress = |_: MigrationProgress| {};
    let db = open(root, &ConnectionPolicy::default(), &mut progress).expect("open");
    let ext: String = db
        .conn()
        .query_row(
            "SELECT ext_json FROM characters WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("read ext_json");
    drop(db);
    serde_json::from_str(&ext).expect("valid ext_json")
}

fn read_tags_json(root: &Path, id: &str) -> Vec<String> {
    let mut progress = |_: MigrationProgress| {};
    let db = open(root, &ConnectionPolicy::default(), &mut progress).expect("open");
    let tags: String = db
        .conn()
        .query_row(
            "SELECT tags_json FROM characters WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("read tags_json");
    drop(db);
    serde_json::from_str(&tags).expect("valid tags_json")
}

/// Corpus: the REAL Drizzle layout converts completely — known card fields
/// land in `ext_json` under stable keys, join-table tags land in `tags_json`,
/// unknown ext fields are preserved, soft-deleted characters/chats are
/// skipped and reported (ТЗ §17.4 "unknown extension fields", "orphaned
/// records", "unicode/RTL/длинные значения").
#[test]
fn corpus_real_drizzle_schema_maps_completely() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_real_legacy(&source).expect("build real legacy");

    let prepared = prepare(&data_root, &source, false, &mut nop_stage).expect("prepare");
    assert_eq!(
        prepared.report.characters, 1,
        "soft-deleted character skipped"
    );
    assert_eq!(prepared.report.chats, 1, "soft-deleted chat skipped");
    assert_eq!(prepared.report.messages, 2);
    assert_eq!(
        prepared.report.skipped, 2,
        "both soft-deleted rows reported"
    );
    assert!(
        prepared
            .report
            .orphans
            .iter()
            .any(|o| o.contains("soft-deleted")),
        "orphans describe the skips: {:?}",
        prepared.report.orphans
    );

    commit(&data_root, &prepared.entry_id, &mut nop_stage).expect("commit");

    // Known fields preserved under stable keys.
    let ext = read_ext_json(&data_root, "real-c1");
    assert_eq!(ext["personality"], "Brave heart");
    assert_eq!(ext["scenario"], "A far land");
    assert_eq!(ext["first_message"], "Hello there");
    assert_eq!(ext["example_dialogues"], "Example: *waves*");
    assert_eq!(ext["system_prompt"], "System: be kind");
    assert_eq!(ext["post_history_instructions"], "After: continue");
    assert_eq!(ext["creator"], "creator@example.com");
    assert_eq!(ext["creator_notes"], "notes in Hebrew עברית");
    // Unknown ext fields preserved (ТЗ §10.3).
    assert_eq!(ext["unknown"], "kept");
    assert_eq!(ext["nested"]["a"], 1);
    // Join-table tags merged into tags_json, deduplicated.
    let tags = read_tags_json(&data_root, "real-c1");
    assert_eq!(tags, vec!["knight", "עברית"], "sorted deduplicated tags");

    // Description/name preserved; unicode round-trips.
    assert_eq!(read_name(&data_root, "real-c1"), "שרה");
    let mut progress = |_: MigrationProgress| {};
    let db = open(&data_root, &ConnectionPolicy::default(), &mut progress).expect("open");
    let len: i64 = db
        .conn()
        .query_row(
            "SELECT length(content) FROM messages WHERE id = 'real-m1'",
            [],
            |r| r.get(0),
        )
        .expect("message length");
    assert_eq!(len, 20_000, "long unicode message preserved");
    let rtl: String = db
        .conn()
        .query_row(
            "SELECT content FROM messages WHERE id = 'real-m2'",
            [],
            |r| r.get(0),
        )
        .expect("rtl message");
    assert_eq!(rtl, "ردّ بالعربية");
    drop(db);
}

/// Corpus: a large library (1000 characters, 1000 chats, 3000 messages)
/// converts in one pass with exact counts (ТЗ §17.4 "большие библиотеки").
#[test]
fn corpus_large_library_converts_with_exact_counts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    {
        let conn = rusqlite::Connection::open(&source).expect("open");
        conn.execute_batch(
            "CREATE TABLE characters (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, ext TEXT DEFAULT '{}',
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE chats (
                id TEXT PRIMARY KEY, title TEXT, character_id TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE messages (
                id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT, content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE lorebooks (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE presets (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT DEFAULT '{}',
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE provider_configs (
                id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, config TEXT, api_key TEXT
            );",
        )
        .expect("schema");
        let n = 1_000usize;
        for i in 0..n {
            let id = format!("big-c{i}");
            conn.execute(
                "INSERT INTO characters (id, name, description, ext, created_at, updated_at) \
                 VALUES (?1, ?2, '', '{}', 1700000000000, 1700000000000)",
                rusqlite::params![id, format!("Character {i}")],
            )
            .expect("insert character");
            conn.execute(
                "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 1700000000000, 1700000000000)",
                rusqlite::params![format!("big-h{i}"), format!("Chat {i}"), id],
            )
            .expect("insert chat");
            for m in 0..3 {
                conn.execute(
                    "INSERT INTO messages (id, chat_id, role, content, created_at) \
                     VALUES (?1, ?2, 'user', ?3, 1700000000000)",
                    rusqlite::params![
                        format!("big-m{i}_{m}"),
                        format!("big-h{i}"),
                        format!("Message {i}-{m}"),
                    ],
                )
                .expect("insert message");
            }
        }
    }

    let prepared = prepare(&data_root, &source, false, &mut nop_stage).expect("prepare");
    assert_eq!(prepared.report.characters, 1_000);
    assert_eq!(prepared.report.chats, 1_000);
    assert_eq!(prepared.report.messages, 3_000);
    assert_eq!(prepared.report.skipped, 0);
}

/// Corpus: a message referencing a branch that does not exist is converted
/// anyway (the kernel flattens legacy branches; branch id is not a kernel
/// column) — the corpus item "orphaned records" for messages.
#[test]
fn corpus_message_branch_is_flattened() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_real_legacy(&source).expect("build real legacy");

    let prepared = prepare(&data_root, &source, false, &mut nop_stage).expect("prepare");
    assert_eq!(
        prepared.report.messages, 2,
        "branch references are flattened"
    );
}

// --- Windows platform corpus (ТЗ §17.4, §10.3.1) ----------------------------

/// Windows-only: a file handle held WITHOUT `FILE_SHARE_DELETE` on the data
/// root's lock/target makes the pointer switch fail with a classified
/// transient error; `commit` exhausts the bounded retry budget and returns
/// the stable recoverable `ActivationPending`. Releasing the handle lets the
/// next `open` (restart-to-complete) resolve the pending activation.
#[cfg(target_os = "windows")]
#[test]
fn windows_held_handle_leads_to_activation_pending_and_resolves() {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    fs::create_dir_all(&data_root).expect("create data root");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy");

    let prepared = prepare(&data_root, &source, false, &mut nop_stage).expect("prepare");
    let staging = prepared.staging_root.clone();

    // Hold the staging root's database file open without delete sharing —
    // exactly the Windows contention ТЗ §10.3.1 describes (Defender/indexer/
    // sync client). The pointer switch does not touch that file, so to make
    // the *activation* itself contend we instead hold the journal's target
    // resolution: commit's pointer write replaces `active-root.json`, which
    // we create and hold open without FILE_SHARE_DELETE.
    let pointer = neotavern_storage::activation::pointer_path(&data_root);
    fs::write(
        &pointer,
        b"{\"formatVersion\":1,\"root\":\"\",\"activatedAt\":\"\"}",
    )
    .expect("pre-create pointer");
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0) // no FILE_SHARE_READ/WRITE/DELETE
        .open(&pointer)
        .expect("open pointer without sharing");
    let _raw = held.as_raw_handle(); // keep the handle alive for the retry loop

    let err = commit(&data_root, &prepared.entry_id, &mut nop_stage)
        .expect_err("commit must exhaust the retry budget");
    assert_eq!(err.code, StorageErrorCode::ActivationPending);
    assert_eq!(
        latest_entry(&data_root)
            .expect("latest")
            .expect("entry")
            .status,
        ActivationStatus::ActivationPending,
        "journal stays activation_pending after budget exhaustion"
    );
    assert_eq!(
        active_root(&data_root).expect("active root"),
        data_root,
        "previous root still active during contention"
    );

    // Release the handle → the next open resolves the pending activation
    // (restart-to-complete, ТЗ §10.3.1 item 5).
    drop(held);
    let mut progress = |_: MigrationProgress| {};
    let db = open(&data_root, &ConnectionPolicy::default(), &mut progress).expect("open");
    assert_eq!(
        active_root(&data_root).expect("active root"),
        staging,
        "pending activation completed at next open"
    );
    drop(db);
}
