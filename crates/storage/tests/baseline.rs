//! Integration tests for the SQLite baseline and connection configuration
//! (`neotavern_storage::baseline`): `assert_baseline` version gating,
//! `sqlite_libversion`, and `configure_connection`/`verify_connection`
//! applying and echoing every element of `ConnectionPolicy`.

use neotavern_storage::baseline::{
    assert_baseline, configure_connection, sqlite_libversion, verify_connection, ConnectionPolicy,
    JournalMode, REQUIRED_MIN_SQLITE,
};
use neotavern_storage::paths::db_path;
use neotavern_storage::StorageErrorCode;

/// Read an integer-valued pragma and return its value.
fn pragma_i64(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<i64> {
    conn.query_row(sql, [], |row| row.get(0))
}

/// Read a text-valued pragma and return its value.
fn pragma_string(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<String> {
    conn.query_row(sql, [], |row| row.get(0))
}

#[test]
fn assert_baseline_accepts_current_and_required_versions() -> Result<(), Box<dyn std::error::Error>>
{
    // The bundled SQLite (libsqlite3-sys 0.38.2) is 3.53.2.
    assert_baseline("3.53.2")?;
    // Exactly the minimum must pass too.
    assert_baseline(REQUIRED_MIN_SQLITE)?;
    Ok(())
}

#[test]
fn assert_baseline_rejects_older_version() {
    let err = match assert_baseline("3.51.2") {
        Ok(()) => panic!("assert_baseline must reject a version below the required minimum"),
        Err(e) => e,
    };
    assert_eq!(err.code, StorageErrorCode::BaselineViolation);
    assert!(
        err.params
            .iter()
            .any(|(k, v)| k == "required" && v == REQUIRED_MIN_SQLITE),
        "params must record the required version: {:?}",
        err.params
    );
    assert!(
        err.params
            .iter()
            .any(|(k, v)| k == "found" && v == "3.51.2"),
        "params must record the offending version: {:?}",
        err.params
    );
}

#[test]
fn lib_version_satisfies_baseline() -> Result<(), Box<dyn std::error::Error>> {
    let version = sqlite_libversion();
    assert!(!version.is_empty(), "sqlite_libversion must not be empty");
    assert_baseline(version)?;
    Ok(())
}

#[test]
fn configure_file_backed_wal() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let conn = rusqlite::Connection::open(db_path(dir.path()))?;
    let policy = ConnectionPolicy::default();
    configure_connection(&conn, &policy)?;
    assert_eq!(pragma_i64(&conn, "PRAGMA foreign_keys")?, 1);
    assert_eq!(
        pragma_i64(&conn, "PRAGMA busy_timeout")?,
        policy.busy_timeout_ms as i64
    );
    assert_eq!(pragma_string(&conn, "PRAGMA journal_mode")?, "wal");
    assert_eq!(pragma_i64(&conn, "PRAGMA synchronous")?, 2); // FULL
    assert_eq!(pragma_i64(&conn, "PRAGMA trusted_schema")?, 0);
    verify_connection(&conn)?;
    Ok(())
}

#[test]
fn configure_in_memory_allows_memory_journal() -> Result<(), Box<dyn std::error::Error>> {
    let conn = rusqlite::Connection::open_in_memory()?;
    configure_connection(&conn, &ConnectionPolicy::default())?;
    let journal = pragma_string(&conn, "PRAGMA journal_mode")?;
    assert!(
        journal == "memory" || journal == "wal",
        "in-memory journal must be 'memory' (or wal-equivalent), got {journal:?}"
    );
    assert_eq!(pragma_i64(&conn, "PRAGMA foreign_keys")?, 1);
    assert_eq!(pragma_i64(&conn, "PRAGMA trusted_schema")?, 0);
    Ok(())
}

#[test]
fn configure_delete_mode_and_normal_sync() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let conn = rusqlite::Connection::open(db_path(dir.path()))?;
    let policy = ConnectionPolicy {
        busy_timeout_ms: 1234,
        journal_mode: JournalMode::Delete,
        synchronous_full: false,
    };
    configure_connection(&conn, &policy)?;
    assert_eq!(pragma_i64(&conn, "PRAGMA busy_timeout")?, 1234);
    assert_eq!(pragma_string(&conn, "PRAGMA journal_mode")?, "delete");
    assert_eq!(pragma_i64(&conn, "PRAGMA synchronous")?, 1); // NORMAL
    verify_connection(&conn)?;
    Ok(())
}
