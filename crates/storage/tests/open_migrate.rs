//! Integration tests for the open/migration sequence
//! (`neotavern_storage::open`, `neotavern_storage::migrations`):
//! fresh install, idempotent reopen, missing-file creation, foreign
//! `application_id`, too-new schema, and tampered migration ledger.

use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::migrations::{verify_ledger, MIGRATIONS};
use neotavern_storage::open::open;
use neotavern_storage::paths::db_path;
use neotavern_storage::{StorageErrorCode, APPLICATION_ID, CURRENT_SCHEMA};

#[test]
fn fresh_install_initializes_schema() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    // user_version == CURRENT_SCHEMA, both via pragma and the public accessor.
    let user_version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |r| r.get(0))?;
    assert_eq!(user_version, CURRENT_SCHEMA);
    assert_eq!(db.schema_revision()?, CURRENT_SCHEMA);

    // storageFormat meta row == 1.
    let storage_format: String = db.conn().query_row(
        "SELECT value FROM __neotavern_meta WHERE key = 'storageFormat'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(storage_format, "1");
    assert_eq!(db.storage_format()?, 1);

    // Migration ledger records every declared migration with its checksum.
    let mut stmt = db
        .conn()
        .prepare("SELECT id, name, checksum FROM __neotavern_migrations ORDER BY id")?;
    let ledger: Vec<(i64, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(ledger.len(), MIGRATIONS.len());
    for ((id, name, checksum), declared) in ledger.iter().zip(MIGRATIONS) {
        assert_eq!(*id, declared.id);
        assert_eq!(*name, declared.name);
        assert_eq!(*checksum, declared.checksum);
    }
    verify_ledger(db.conn())?;

    // application_id identifies the database as ours.
    let application_id: i64 = db
        .conn()
        .query_row("PRAGMA application_id", [], |r| r.get(0))?;
    assert_eq!(application_id, i64::from(APPLICATION_ID));

    // quick_check must report a healthy database.
    let quick_check: String = db
        .conn()
        .query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    assert_eq!(quick_check, "ok");

    // The database file exists on disk.
    assert!(db_path(root).is_file());
    Ok(())
}

#[test]
fn reopen_does_not_remigrate() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    {
        let db = open(root, &ConnectionPolicy::default(), &mut noop)?;
        let count: i64 =
            db.conn()
                .query_row("SELECT COUNT(*) FROM __neotavern_migrations", [], |r| {
                    r.get(0)
                })?;
        assert_eq!(
            count,
            neotavern_storage::migrations::MIGRATIONS.len() as i64
        );
    }
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;
    let count: i64 =
        db.conn()
            .query_row("SELECT COUNT(*) FROM __neotavern_migrations", [], |r| {
                r.get(0)
            })?;
    assert_eq!(
        count,
        neotavern_storage::migrations::MIGRATIONS.len() as i64,
        "reopen must not re-apply migrations"
    );
    let quick_check: String = db
        .conn()
        .query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    assert_eq!(quick_check, "ok");
    Ok(())
}

#[test]
fn open_creates_missing_database() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    assert!(
        !db_path(root).exists(),
        "tempdir must start without a database"
    );
    let mut noop = |_| {};
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;
    assert!(db_path(root).is_file());
    assert_eq!(db.schema_revision()?, CURRENT_SCHEMA);
    Ok(())
}

#[test]
fn foreign_application_id_is_corrupt() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;
    drop(db);

    // Point the file at a different application, as a foreign tool would.
    let conn = rusqlite::Connection::open(db_path(root))?;
    conn.execute_batch("PRAGMA application_id = 0x12345678;")?;
    drop(conn);

    let err = match open(root, &ConnectionPolicy::default(), &mut noop) {
        Ok(_) => panic!("open must reject a database with a foreign application_id"),
        Err(e) => e,
    };
    assert_eq!(err.code, StorageErrorCode::Corrupt);
    Ok(())
}

#[test]
fn newer_schema_revision_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;
    drop(db);

    // Simulate a database written by a future schema revision.
    let conn = rusqlite::Connection::open(db_path(root))?;
    conn.execute_batch(&format!("PRAGMA user_version = {};", CURRENT_SCHEMA + 1))?;
    drop(conn);

    let err = match open(root, &ConnectionPolicy::default(), &mut noop) {
        Ok(_) => panic!("open must reject a schema revision newer than CURRENT_SCHEMA"),
        Err(e) => e,
    };
    assert_eq!(err.code, StorageErrorCode::SchemaTooNew);
    Ok(())
}

#[test]
fn tampered_ledger_checksum_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;
    drop(db);

    // Corrupt the recorded migration checksum.
    let conn = rusqlite::Connection::open(db_path(root))?;
    conn.execute_batch(
        "UPDATE __neotavern_migrations \
         SET checksum = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' \
         WHERE id = 1;",
    )?;
    drop(conn);

    let err = match open(root, &ConnectionPolicy::default(), &mut noop) {
        Ok(_) => panic!("open must reject a tampered migration ledger"),
        Err(e) => e,
    };
    assert_eq!(err.code, StorageErrorCode::MigrationChecksumMismatch);
    Ok(())
}

#[test]
fn verify_ledger_detects_tampering() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;
    verify_ledger(db.conn())?;
    drop(db);

    let conn = rusqlite::Connection::open(db_path(root))?;
    conn.execute_batch(
        "UPDATE __neotavern_migrations \
         SET checksum = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
         WHERE id = 1;",
    )?;
    let err = match verify_ledger(&conn) {
        Ok(()) => panic!("verify_ledger must reject a tampered checksum"),
        Err(e) => e,
    };
    assert_eq!(err.code, StorageErrorCode::MigrationChecksumMismatch);
    Ok(())
}

/// Builds a database at schema v5 (migrations 1..5 applied, ledger + meta +
/// `application_id` set) and seeds it with a chat, a generation run, its
/// event log and its prompt plan — the upgrade path migration 6 must preserve.
fn build_v5_with_data(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use neotavern_storage::schema::{
        MIGRATION_1_SQL, MIGRATION_2_SQL, MIGRATION_3_SQL, MIGRATION_4_SQL, MIGRATION_5_SQL,
    };
    let conn = rusqlite::Connection::open(db_path(root))?;
    conn.execute_batch(MIGRATION_1_SQL)?;
    conn.execute_batch(MIGRATION_2_SQL)?;
    conn.execute_batch(MIGRATION_3_SQL)?;
    conn.execute_batch(MIGRATION_4_SQL)?;
    conn.execute_batch(MIGRATION_5_SQL)?;
    conn.execute_batch(&format!(
        "PRAGMA application_id = {}; PRAGMA user_version = 5;",
        neotavern_storage::APPLICATION_ID
    ))?;
    conn.execute(
        "INSERT INTO __neotavern_meta (key, value) VALUES ('storageFormat', '1')",
        [],
    )?;
    for (id, name, checksum) in [
        (
            1i64,
            "001_initial_schema",
            neotavern_storage::schema::MIGRATION_1_CHECKSUM,
        ),
        (
            2i64,
            "002_product_core",
            neotavern_storage::schema::MIGRATION_2_CHECKSUM,
        ),
        (
            3i64,
            "003_generation_durability",
            neotavern_storage::schema::MIGRATION_3_CHECKSUM,
        ),
        (
            4i64,
            "004_provider_configs",
            neotavern_storage::schema::MIGRATION_4_CHECKSUM,
        ),
        (
            5i64,
            "005_prompt_plans",
            neotavern_storage::schema::MIGRATION_5_CHECKSUM,
        ),
    ] {
        conn.execute(
            "INSERT INTO __neotavern_migrations (id, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, name, checksum, "2026-08-13T10:00:00Z"],
        )?;
    }
    // Seed: a character + chat + run + event + plan the rebuild must keep.
    conn.execute(
        "INSERT INTO characters (id, name, description, tags_json, ext_json, created_at, updated_at) \
         VALUES ('c1c1c1c1-0000-4000-8000-000000000001', 'Aria', 'A cheerful guide.', '[]', '{}', '2026-08-13T10:00:00Z', '2026-08-13T10:00:00Z')",
        [],
    )?;
    conn.execute(
        "INSERT INTO chats (id, character_id, title, created_at, updated_at) \
         VALUES ('c1c1c1c1-0000-4000-8000-000000000002', 'c1c1c1c1-0000-4000-8000-000000000001', 'Chat', '2026-08-13T10:00:00Z', '2026-08-13T10:00:00Z')",
        [],
    )?;
    conn.execute(
        "INSERT INTO generation_runs \
         (id, chat_id, attempt, status, provider, model, request_snapshot_json, revision, \
          last_event_sequence, partial_length, started_at, updated_at) \
         VALUES ('c1c1c1c1-0000-4000-8000-000000000003', 'c1c1c1c1-0000-4000-8000-000000000002', 1, 'streaming', 'fake', 'steps=2', '{}', 7, 3, 42, '2026-08-13T10:00:00Z', '2026-08-13T10:00:00Z')",
        [],
    )?;
    conn.execute(
        "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
         VALUES ('c1c1c1c1-0000-4000-8000-000000000003', 0, 'generation.delta', '{\"type\":\"generation.delta\",\"text\":\"hi\"}', '2026-08-13T10:00:00Z')",
        [],
    )?;
    conn.execute(
        "INSERT INTO prompt_plans (run_id, chat_id, plan_json, created_at) \
         VALUES ('c1c1c1c1-0000-4000-8000-000000000003', 'c1c1c1c1-0000-4000-8000-000000000002', '{}', '2026-08-13T10:00:00Z')",
        [],
    )?;
    drop(conn);
    Ok(())
}

#[test]
fn migration_6_adds_steps_and_pending_tool_column() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    build_v5_with_data(root)?;

    // open() migrates 5 → 6 (the ledger verifies before migration).
    let mut noop = |_| {};
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;
    assert_eq!(db.schema_revision()?, CURRENT_SCHEMA);
    verify_ledger(db.conn())?;

    // The seeded run survived the upgrade with every column intact.
    let (status, revision, partial, last_seq): (String, i64, i64, i64) = db.conn().query_row(
        "SELECT status, revision, partial_length, last_event_sequence FROM generation_runs WHERE id = ?1",
        ["c1c1c1c1-0000-4000-8000-000000000003"],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    assert_eq!(status, "streaming");
    assert_eq!(revision, 7);
    assert_eq!(partial, 42);
    assert_eq!(last_seq, 3);

    // The child tables still reference generation_runs and kept their rows.
    let event_count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM generation_events WHERE run_id = ?1",
        ["c1c1c1c1-0000-4000-8000-000000000003"],
        |r| r.get(0),
    )?;
    assert_eq!(event_count, 1);
    let plan_count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM prompt_plans", [], |r| r.get(0))?;
    assert_eq!(plan_count, 1);

    // The new pending-tool column exists and round-trips; the waiting state
    // is expressed by the marker, not by a CHECK value.
    db.conn().execute(
        "UPDATE generation_runs SET pending_tool_call_json = '{\"id\":\"tc-1\"}' WHERE id = ?1",
        ["c1c1c1c1-0000-4000-8000-000000000003"],
    )?;
    let pending: String = db.conn().query_row(
        "SELECT pending_tool_call_json FROM generation_runs WHERE id = ?1",
        ["c1c1c1c1-0000-4000-8000-000000000003"],
        |r| r.get(0),
    )?;
    assert_eq!(pending, "{\"id\":\"tc-1\"}");

    // The steps journal accepts the full v6 contract, and FK/integrity hold.
    db.conn().execute(
        "INSERT INTO generation_steps \
         (run_id, sequence, step_id, step_type, status, attempt, idempotency_key, input_json, created_at, updated_at) \
         VALUES (?1, 0, 's1', 'tool_call', 'waiting', 1, 'ik-1', '{}', '2026-08-13T10:00:00Z', '2026-08-13T10:00:00Z')",
        ["c1c1c1c1-0000-4000-8000-000000000003"],
    )?;
    let fk: i64 =
        db.conn()
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })?;
    assert_eq!(fk, 0, "no FK violations after the v6 migration");
    let quick_check: String = db
        .conn()
        .query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    assert_eq!(quick_check, "ok");
    Ok(())
}
