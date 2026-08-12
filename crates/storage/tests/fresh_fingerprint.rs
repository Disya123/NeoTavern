//! Integration tests for the fresh-install schema fingerprint
//! (`neotavern_storage::schema`, `neotavern_storage::migrations`):
//! `schema_fingerprint()` must equal both the value returned by
//! `fresh_install` and an independent sha256 of `FRESH_SCHEMA_SQL`.

use neotavern_storage::assets::sha256_hex;
use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::migrations::{fresh_install, MIGRATIONS};
use neotavern_storage::open::open;
use neotavern_storage::paths::db_path;
use neotavern_storage::schema::{
    schema_fingerprint, FRESH_SCHEMA_SQL, MIGRATION_1_CHECKSUM, MIGRATION_1_NAME, MIGRATION_1_SQL,
};
use neotavern_storage::{APPLICATION_ID, CURRENT_SCHEMA, META_KEY_STORAGE_FORMAT, STORAGE_FORMAT};

#[test]
fn fingerprint_matches_independent_sha256() {
    let fingerprint = schema_fingerprint();
    assert_eq!(fingerprint.len(), 64, "sha256 hex must be 64 chars");
    let independent = sha256_hex(FRESH_SCHEMA_SQL.as_bytes());
    assert_eq!(fingerprint, independent);
}

#[test]
fn fresh_install_returns_fingerprint() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let conn = rusqlite::Connection::open(db_path(dir.path()))?;
    let mut noop = |_| {};
    let returned = fresh_install(&conn, &mut noop)?;
    assert_eq!(returned, schema_fingerprint());
    assert_eq!(returned, sha256_hex(FRESH_SCHEMA_SQL.as_bytes()));

    // The install recorded the initial migration with the declared checksum.
    let (name, checksum): (String, String) = conn.query_row(
        "SELECT name, checksum FROM __neotavern_migrations WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(name, MIGRATION_1_NAME);
    assert_eq!(checksum, MIGRATION_1_CHECKSUM);

    // storageFormat meta row and user_version are part of the fresh state.
    let storage_format: String = conn.query_row(
        "SELECT value FROM __neotavern_meta WHERE key = 'storageFormat'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(storage_format, "1");
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    assert_eq!(user_version, CURRENT_SCHEMA);
    Ok(())
}

#[test]
fn migrated_v1_fingerprint_matches_fresh_install() -> Result<(), Box<dyn std::error::Error>> {
    let mut noop = |_| {};

    // Root A: fresh install at CURRENT_SCHEMA.
    let dir_a = tempfile::tempdir()?;
    let root_a = dir_a.path();
    let db_a = open(root_a, &ConnectionPolicy::default(), &mut noop)?;
    drop(db_a);
    let fresh_fingerprint = schema_fingerprint();

    // Root B: hand-build a v1 database (schema revision 1) with raw rusqlite —
    // MIGRATION_1_SQL, application_id, user_version=1, the storageFormat meta
    // row and the ledger row for migration 1 — then let `open` migrate it to
    // CURRENT_SCHEMA.
    let dir_b = tempfile::tempdir()?;
    let root_b = dir_b.path();
    {
        let conn = rusqlite::Connection::open(db_path(root_b))?;
        conn.execute_batch(MIGRATION_1_SQL)?;
        conn.pragma_update(None, "application_id", APPLICATION_ID)?;
        conn.pragma_update(None, "user_version", 1)?;
        conn.execute(
            "INSERT INTO __neotavern_meta (key, value) VALUES (?1, ?2)",
            rusqlite::params![META_KEY_STORAGE_FORMAT, STORAGE_FORMAT.to_string()],
        )?;
        conn.execute(
            "INSERT INTO __neotavern_migrations (id, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![1, MIGRATION_1_NAME, MIGRATION_1_CHECKSUM, "2026-01-01T00:00:00Z"],
        )?;
    }
    let db_b = open(root_b, &ConnectionPolicy::default(), &mut noop)?;

    // Fresh and migrated databases report the same schema fingerprint
    // (ТЗ §33: fresh fingerprint == migrated fingerprint).
    assert_eq!(schema_fingerprint(), fresh_fingerprint);
    assert_eq!(db_b.schema_revision()?, CURRENT_SCHEMA);

    // The migration to v2 recorded a second ledger row with the declared
    // checksum; the complete ledger matches MIGRATIONS.
    let mut stmt = db_b
        .conn()
        .prepare("SELECT id, name, checksum FROM __neotavern_migrations ORDER BY id")?;
    let rows: Vec<(i64, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(rows.len(), MIGRATIONS.len());
    for ((id, name, checksum), declared) in rows.iter().zip(MIGRATIONS) {
        assert_eq!(*id, declared.id);
        assert_eq!(*name, declared.name);
        assert_eq!(*checksum, declared.checksum);
    }
    Ok(())
}
