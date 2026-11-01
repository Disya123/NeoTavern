//! Integration tests for the character-gallery links (schema v20,
//! `neotavern_storage::gallery`, M7 Etap-4 gallery slice): add/list/delete
//! round trip, owner scoping, FK integrity, cascade semantics and
//! asset-preserving deletes.

use std::path::Path;

use neotavern_storage::assets::publish_asset;
use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::error::StorageErrorCode;
use neotavern_storage::gallery::{
    add_character_image, asset_exists, list_character_images, remove_character_image, GallerySort,
};
use neotavern_storage::migrations::MigrationProgress;
use neotavern_storage::open::open;
use neotavern_storage::CURRENT_SCHEMA;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn open_root(root: &Path) -> neotavern_storage::open::Database {
    let mut progress = |_p: MigrationProgress| {};
    open(root, &ConnectionPolicy::default(), &mut progress).expect("data root must open")
}

fn seed_character(db: &neotavern_storage::open::Database, id: &str) {
    db.conn()
        .execute(
            "INSERT INTO characters (id, name, description, tags_json, ext_json, created_at, updated_at) \
             VALUES (?1, 'Gallery Char', NULL, '[]', '{}', '2026-08-13T10:00:00Z', '2026-08-13T10:00:00Z')",
            rusqlite::params![id],
        )
        .expect("seed character");
}

fn publish(db: &mut neotavern_storage::open::Database, name: &str, bytes: &[u8]) -> String {
    let id = format!("asset-{name}");
    publish_asset(db, &id, "gallery", &format!("gallery/{name}.png"), bytes)
        .expect("publish asset")
        .id
}

#[test]
fn gallery_add_list_delete_round_trip() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut db = open_root(root);
    assert_eq!(db.schema_revision()?, CURRENT_SCHEMA);
    seed_character(&db, "char-1");

    let a1 = publish(&mut db, "img-1", b"one");
    let a2 = publish(&mut db, "img-2", b"two");
    assert_ne!(a1, a2, "distinct bytes → distinct asset ids");

    let r1 = add_character_image(&mut db, "img-link-1", "char-1", &a1, "one.png")?;
    assert_eq!(r1.character_id, "char-1");
    assert_eq!(r1.asset_id, a1);
    assert_eq!(r1.size_bytes, 3);
    assert_eq!(r1.filename, "one.png");
    assert_eq!(r1.checksum_sha256.len(), 64);

    let r2 = add_character_image(&mut db, "img-link-2", "char-1", &a2, "two.png")?;

    let oldest = list_character_images(&db, "char-1", GallerySort::Oldest)?;
    assert_eq!(oldest.len(), 2);
    let newest = list_character_images(&db, "char-1", GallerySort::Newest)?;
    assert_eq!(newest.len(), 2);
    // Both orderings are complete permutations of the same set.
    let mut ids_oldest: Vec<&str> = oldest.iter().map(|r| r.id.as_str()).collect();
    ids_oldest.sort_unstable();
    let mut ids_newest: Vec<&str> = newest.iter().map(|r| r.id.as_str()).collect();
    ids_newest.sort_unstable();
    assert_eq!(ids_oldest, ids_newest);
    assert_eq!(
        newest[0].id, r2.id,
        "newest first puts the later link on top"
    );

    let removed = remove_character_image(&mut db, "char-1", &r1.id)?;
    assert!(removed);
    let after = list_character_images(&db, "char-1", GallerySort::Oldest)?;
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, r2.id);

    // Idempotent: removing again reports false.
    assert!(!remove_character_image(&mut db, "char-1", &r1.id)?);
    Ok(())
}

#[test]
fn gallery_delete_is_owner_scoped() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut db = open_root(root);
    seed_character(&db, "char-A");
    seed_character(&db, "char-B");

    let asset = publish(&mut db, "shared", b"shared-bytes");
    let link_a = add_character_image(&mut db, "link-a", "char-A", &asset, "a.png")?;
    let _link_b = add_character_image(&mut db, "link-b", "char-B", &asset, "b.png")?;

    // char-B cannot delete char-A's link even for the same asset.
    assert!(!remove_character_image(&mut db, "char-B", &link_a.id)?);
    assert_eq!(
        list_character_images(&db, "char-A", GallerySort::Oldest)?.len(),
        1
    );

    // Deleting char-A's link leaves char-B's link AND the asset intact.
    assert!(remove_character_image(&mut db, "char-A", &link_a.id)?);
    assert!(asset_exists(&db, &asset)?);
    assert_eq!(
        list_character_images(&db, "char-B", GallerySort::Oldest)?.len(),
        1
    );
    Ok(())
}

#[test]
fn gallery_rejects_missing_owner_or_asset() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut db = open_root(root);
    seed_character(&db, "char-1");
    let asset = publish(&mut db, "img", b"bytes");

    let err = add_character_image(&mut db, "link-x", "ghost", &asset, "x.png")
        .expect_err("missing character must fail");
    assert_eq!(err.code, StorageErrorCode::NotFound);

    let err = add_character_image(&mut db, "link-x", "char-1", "ghost-asset", "x.png")
        .expect_err("missing asset must fail");
    assert_eq!(err.code, StorageErrorCode::NotFound);

    let err = list_character_images(&db, "ghost", GallerySort::Oldest)
        .expect_err("list of a missing character must fail");
    assert_eq!(err.code, StorageErrorCode::NotFound);
    Ok(())
}

#[test]
fn gallery_links_cascade_with_their_owner() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut db = open_root(root);
    seed_character(&db, "char-1");
    let asset = publish(&mut db, "img", b"bytes");
    let link = add_character_image(&mut db, "link-1", "char-1", &asset, "c.png")?;

    db.conn()
        .execute("DELETE FROM characters WHERE id = 'char-1'", [])
        .expect("delete character");

    let left: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM character_images WHERE id = ?1",
            rusqlite::params![link.id],
            |r| r.get(0),
        )
        .expect("count links");
    assert_eq!(left, 0, "the link cascaded away with its owner");
    // The asset survives its link's cascade (immutable store).
    assert!(asset_exists(&db, &asset)?);
    Ok(())
}
