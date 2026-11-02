//! Integration tests for the legacy `app.db` import ledger (v31,
//! `031_import_receipts`, ADR-0062): the receipts table is what makes a
//! resumed staged-root import re-runnable instead of duplicating.

use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::migrations::MigrationProgress;
use neotavern_storage::open::open;

/// A fresh staging root migrates straight to `CURRENT_SCHEMA` and the
/// `import_receipts` table exists there (created by `FRESH_SCHEMA_SQL`).
#[test]
fn fresh_root_has_the_import_ledger_at_current_schema() {
    let dir = tempfile::tempdir().expect("tempdir");
    let staging = dir.path().join("roots").join("root-import");
    std::fs::create_dir_all(&staging).expect("create staging");

    let db = {
        let mut progress = |_: MigrationProgress| {};
        open(&staging, &ConnectionPolicy::default(), &mut progress).expect("open staging")
    };
    let revision: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .expect("user_version");
    assert_eq!(revision, neotavern_storage::CURRENT_SCHEMA);

    let counted: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM import_receipts", [], |r| r.get(0))
        .expect("count receipts");
    assert_eq!(counted, 0);
}

/// The `(entity_family, source_id)` unique pair is the re-run contract: a
/// resumed run skips by checksum, and an accidental double-import of the same
/// source row is a hard constraint failure, never a duplicate.
#[test]
fn the_same_family_and_source_cannot_be_imported_twice() {
    let dir = tempfile::tempdir().expect("tempdir");
    let staging = dir.path().join("roots").join("root-import");
    std::fs::create_dir_all(&staging).expect("create staging");

    let db = {
        let mut progress = |_: MigrationProgress| {};
        open(&staging, &ConnectionPolicy::default(), &mut progress).expect("open staging")
    };

    let insert = |conn: &rusqlite::Connection, run: &str| {
        conn.execute(
            "INSERT INTO import_receipts
             (id, run_id, entity_family, source_id, target_id, source_checksum, imported_at)
             VALUES ('r1', ?1, 'characters', 'legacy-char-1', '0190 uuid', 'abc123', '2026-01-01T00:00:00Z')",
            rusqlite::params![run],
        )
    };

    let conn = db.conn();
    insert(conn, "run-1").expect("first import commits its receipt");
    let duplicate = insert(conn, "run-2");
    let error = duplicate.expect_err("the same (family, source) must refuse a second row");
    assert!(
        matches!(error, rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation),
        "expected a UNIQUE constraint violation, got: {error:?}"
    );

    // A different family in the same run is a different source row: allowed.
    conn.execute(
        "INSERT INTO import_receipts
         (id, run_id, entity_family, source_id, target_id, source_checksum, imported_at)
         VALUES ('r2', 'run-1', 'chats', 'legacy-chat-1', '0190 uuid', 'def456', '2026-01-01T00:00:00Z')",
        [],
    )
    .expect("a different family imports independently");

    let counted: i64 = conn
        .query_row("SELECT COUNT(*) FROM import_receipts", [], |r| r.get(0))
        .expect("count receipts");
    assert_eq!(counted, 2);
    drop(db);
}
