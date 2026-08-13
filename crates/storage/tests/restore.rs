//! Open-path restore resolution tests (Phase 11, ТЗ §42): an interrupted
//! activation must be completed or discarded by `open::open` itself, on every
//! supported platform (the Windows lock-handle regression is covered here).

use std::fs;
use std::path::Path;

use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::open;
use neotavern_storage::restore::{self, Candidate};

fn nop_progress(_: neotavern_storage::migrations::MigrationProgress) {}

/// Seeds one character row and returns the root.
fn seed_root(root: &Path, name: &str) {
    let mut db =
        open::open(root, &ConnectionPolicy::default(), &mut nop_progress).expect("open seed root");
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES ('11111111-1111-7111-8111-111111111111', ?1, NULL, NULL, '[]', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![name],
        )
        .map_err(|e| neotavern_storage::StorageError::from_sqlite(e, "seed"))
    })
    .expect("seed character");
    drop(db); // releases the data-root lease
}

fn character_name(root: &Path) -> String {
    let db = open::open(root, &ConnectionPolicy::default(), &mut nop_progress)
        .expect("open root for read");
    let name: String = db
        .conn()
        .query_row(
            "SELECT name FROM characters WHERE id = '11111111-1111-7111-8111-111111111111'",
            [],
            |row| row.get(0),
        )
        .expect("read seeded character");
    drop(db);
    name
}

/// Writes the pending-activation marker the way `activate` would (simulating
/// a kill between finalize and swap).
fn write_marker(root: &Path, candidate: &Candidate) {
    let parent = root.parent().expect("root parent");
    let body = serde_json::json!({
        "root": root.to_string_lossy(),
        "candidate": candidate.path.to_string_lossy(),
        "createdAt": "2026-01-01T00:00:00Z",
    });
    fs::write(parent.join(restore::PENDING_MARKER_FILE), body.to_string())
        .expect("write pending marker");
}

/// Kill after finalize, before swap: `open::open` completes the activation
/// (Windows included — the lease is released across the resolution).
#[test]
fn open_completes_interrupted_swap() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    let source = temp.path().join("source");
    seed_root(&root, "current");
    seed_root(&source, "restored");

    let candidate = restore::stage_candidate(&root).expect("stage");
    restore::copy_data_root_into(&source, &candidate).expect("copy into candidate");
    restore::finalize_candidate(&candidate).expect("finalize");
    write_marker(&root, &candidate);

    // The interrupted activation is resolved inside open: the swap completes.
    let db = open::open(&root, &ConnectionPolicy::default(), &mut nop_progress)
        .expect("open resolves pending restore");
    drop(db);

    assert_eq!(character_name(&root), "restored", "swap completed by open");
    assert!(!candidate.path.exists(), "candidate consumed by the swap");
    let parent = root.parent().expect("root parent");
    assert!(
        !parent.join(restore::PENDING_MARKER_FILE).exists(),
        "marker cleared"
    );
}

/// Kill before finalize (marker present, candidate not ready): open discards
/// the candidate and keeps the current root untouched.
#[test]
fn open_discards_unready_candidate() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    let source = temp.path().join("source");
    seed_root(&root, "current");
    seed_root(&source, "restored");

    let candidate = restore::stage_candidate(&root).expect("stage");
    restore::copy_data_root_into(&source, &candidate).expect("copy into candidate");
    // NO finalize: the kill landed before the ready file.
    write_marker(&root, &candidate);

    let db = open::open(&root, &ConnectionPolicy::default(), &mut nop_progress)
        .expect("open discards unready candidate");
    drop(db);

    assert_eq!(character_name(&root), "current", "current root kept");
    assert!(!candidate.path.exists(), "unready candidate discarded");
}

/// No marker: open is a plain open (and stale previous dirs prune to ≤1).
#[test]
fn open_without_marker_is_plain_open() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    seed_root(&root, "current");

    let db =
        open::open(&root, &ConnectionPolicy::default(), &mut nop_progress).expect("plain open");
    drop(db);

    assert_eq!(character_name(&root), "current");
}
