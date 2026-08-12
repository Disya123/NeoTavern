//! Integration tests for the asset store (`neotavern_storage::assets`):
//! publish, path resolution, conflict and key-validation errors, delete, and
//! orphan garbage collection.

use std::time::Duration;

use neotavern_storage::assets::{
    delete_asset, gc_orphans, publish_asset, resolve_asset_path, sha256_hex,
};
use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::open::open;
use neotavern_storage::paths::assets_dir;
use neotavern_storage::{StorageErrorCode, MAX_RELATIVE_KEY_LEN};

#[test]
fn publish_creates_row_file_and_hash() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let mut db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    let content = b"hello asset";
    let record = publish_asset(&mut db, "asset-1", "image", "avatar/a.png", content)?;
    assert_eq!(record.id, "asset-1");
    assert_eq!(record.kind, "image");
    assert_eq!(record.relative_key, "avatar/a.png");
    assert_eq!(record.checksum_sha256, sha256_hex(content));
    assert_eq!(record.size_bytes, content.len() as i64);
    assert!(!record.created_at.is_empty(), "created_at must be recorded");

    // Row exists in the assets table.
    let row_key: String = db.conn().query_row(
        "SELECT relative_key FROM __neotavern_assets WHERE id = 'asset-1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(row_key, "avatar/a.png");

    // File exists with the exact published bytes.
    let path = resolve_asset_path(&db, "avatar/a.png")?;
    assert!(path.is_file(), "published file must exist on disk");
    assert_eq!(std::fs::read(&path)?, content.as_slice());
    Ok(())
}

#[test]
fn duplicate_relative_key_conflicts() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let mut db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    publish_asset(&mut db, "a1", "image", "shared/key.png", b"one")?;
    let err = match publish_asset(&mut db, "a2", "image", "shared/key.png", b"two") {
        Ok(_) => panic!("a duplicate relative_key must conflict"),
        Err(e) => e,
    };
    assert_eq!(err.code, StorageErrorCode::Conflict);

    let count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM __neotavern_assets", [], |r| r.get(0))?;
    assert_eq!(count, 1, "the original row must be untouched");
    Ok(())
}

#[test]
fn duplicate_id_conflicts() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let mut db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    publish_asset(&mut db, "same", "image", "first.png", b"one")?;
    let err = match publish_asset(&mut db, "same", "image", "second.png", b"two") {
        Ok(_) => panic!("publishing the same id twice must conflict"),
        Err(e) => e,
    };
    assert_eq!(err.code, StorageErrorCode::Conflict);

    let count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM __neotavern_assets", [], |r| r.get(0))?;
    assert_eq!(count, 1);
    Ok(())
}

#[test]
fn invalid_keys_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let mut db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    let too_long = "x".repeat(MAX_RELATIVE_KEY_LEN + 1);
    let invalid_keys: &[&str] = &[
        "",          // empty
        "..",        // parent component
        "a\\b",      // backslash component separator
        "CON",       // Windows reserved device name
        "file.txt.", // trailing dot
        &too_long,   // exceeds MAX_RELATIVE_KEY_LEN
    ];
    for (i, key) in invalid_keys.iter().enumerate() {
        let id = format!("invalid-{i}");
        let err = match publish_asset(&mut db, &id, "image", key, b"x") {
            Ok(_) => panic!("key {key:?} must be rejected"),
            Err(e) => e,
        };
        assert_eq!(err.code, StorageErrorCode::InvalidAssetKey, "key {key:?}");
    }

    // No partial state may remain after rejected publishes.
    let count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM __neotavern_assets", [], |r| r.get(0))?;
    assert_eq!(count, 0);
    Ok(())
}

#[test]
fn delete_removes_row_and_file() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let mut db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    publish_asset(&mut db, "d1", "image", "del/me.png", b"data")?;
    let path = resolve_asset_path(&db, "del/me.png")?;
    assert!(path.is_file());

    delete_asset(&mut db, "d1")?;
    let count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM __neotavern_assets WHERE id = 'd1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(count, 0, "delete must remove the row");
    assert!(
        !path.exists(),
        "delete must remove the file on the success path"
    );
    Ok(())
}

#[test]
fn gc_removes_stray_old_files() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let mut db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    publish_asset(&mut db, "g1", "image", "kept.png", b"keep")?;

    // A stray file not referenced by any asset row.
    let stray = assets_dir(root).join("stray.bin");
    std::fs::create_dir_all(assets_dir(root))?;
    std::fs::write(&stray, b"stray")?;

    // ZERO grace: the stray is older than the grace period by construction.
    let report = gc_orphans(&db, Duration::ZERO)?;
    assert!(
        report.removed.iter().any(|key| key == "stray.bin"),
        "stray must be reported removed, got {:?}",
        report.removed
    );
    assert!(!stray.exists(), "stray file must be deleted");
    assert!(
        report.missing.is_empty(),
        "no referenced files were missing"
    );

    // The referenced file is untouched.
    let kept = resolve_asset_path(&db, "kept.png")?;
    assert!(kept.is_file());
    Ok(())
}

#[test]
fn gc_keeps_fresh_strays_within_grace() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    let stray = assets_dir(root).join("fresh.bin");
    std::fs::create_dir_all(assets_dir(root))?;
    std::fs::write(&stray, b"fresh")?;

    // A generous grace period keeps files created moments ago.
    let report = gc_orphans(&db, Duration::from_secs(86400 * 365))?;
    assert!(
        report.removed.is_empty(),
        "fresh stray must be kept, got {:?}",
        report.removed
    );
    assert!(stray.exists());
    Ok(())
}

#[test]
fn gc_reports_referenced_but_missing_files() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut noop = |_| {};
    let mut db = open(root, &ConnectionPolicy::default(), &mut noop)?;

    publish_asset(&mut db, "m1", "image", "lost/asset.png", b"gone")?;
    let path = resolve_asset_path(&db, "lost/asset.png")?;
    std::fs::remove_file(&path)?;

    let report = gc_orphans(&db, Duration::ZERO)?;
    assert!(
        report.missing.iter().any(|key| key == "lost/asset.png"),
        "referenced-but-missing file must be reported, got {:?}",
        report.missing
    );
    Ok(())
}
