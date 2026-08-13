//! Integration tests for internal recovery snapshots
//! (`neotavern_storage::snapshot`): create, verify, revision, and integrity.

use neotavern_storage::assets::{publish_asset, sha256_hex};
use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::open::{open, open_read_only};
use neotavern_storage::paths::snapshots_dir;
use neotavern_storage::recovery::integrity_check;
use neotavern_storage::snapshot::{create_snapshot, verify_snapshot};
use neotavern_storage::{APPLICATION_ID, CURRENT_SCHEMA};

#[test]
fn snapshot_create_verify_and_integrity() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let mut db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    publish_asset(&mut db, "s1", "image", "a.png", b"AAA")?;
    publish_asset(&mut db, "s2", "image", "b.png", b"BBB")?;

    let info = create_snapshot(&db)?;

    // The snapshot is a file under <root>/snapshots/.
    assert!(info.path.is_file(), "snapshot file must exist");
    assert!(
        info.path.starts_with(snapshots_dir(root)),
        "snapshot must live in the snapshots dir"
    );
    assert_eq!(info.schema_revision, CURRENT_SCHEMA);
    assert!(!info.created_at.is_empty(), "created_at must be recorded");

    // The recorded checksum is the sha256 of the snapshot file bytes.
    let file_bytes = std::fs::read(&info.path)?;
    assert_eq!(info.checksum_sha256, sha256_hex(&file_bytes));

    // verify_snapshot re-opens, quick-checks and compares the checksum.
    let revision = verify_snapshot(&info)?;
    assert_eq!(revision, CURRENT_SCHEMA);

    // The snapshot is a fully valid NeoTavern database on its own.
    let snap = rusqlite::Connection::open(&info.path)?;
    let quick_check: String = snap.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    assert_eq!(quick_check, "ok");
    let user_version: i64 = snap.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    assert_eq!(user_version, CURRENT_SCHEMA);
    let application_id: i64 = snap.query_row("PRAGMA application_id", [], |r| r.get(0))?;
    assert_eq!(application_id, i64::from(APPLICATION_ID));
    let count: i64 = snap.query_row("SELECT COUNT(*) FROM __neotavern_assets", [], |r| r.get(0))?;
    assert_eq!(count, 2, "snapshot must contain the published asset rows");
    drop(snap);

    // The live database passes a full integrity_check via the read-only path.
    let ro = open_read_only(root)?;
    let rows = integrity_check(&ro)?;
    assert!(!rows.is_empty(), "integrity_check must return rows");
    assert!(
        rows.iter().any(|row| row == "ok"),
        "integrity rows: {rows:?}"
    );
    Ok(())
}
