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
        assert_eq!(count, 3);
    }
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;
    let count: i64 =
        db.conn()
            .query_row("SELECT COUNT(*) FROM __neotavern_migrations", [], |r| {
                r.get(0)
            })?;
    assert_eq!(count, 3, "reopen must not re-apply migrations");
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
