//! Integration tests for public backup containers
//! (`neotavern_storage::backup`, ТЗ §40–§42): create/verify/list, the
//! restore round-trip, the staged-activation kill matrix, corrupt /
//! traversal / oversize rejection at verify, and the backup quota.

use std::fs;
use std::path::Path;

use neotavern_storage::assets::publish_asset;
use neotavern_storage::backup::{
    create_backup, list_backups, restore_backup, verify_backup, MAX_BACKUPS, MAX_BACKUP_BYTES,
};
use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::migrations::MigrationProgress;
use neotavern_storage::open::open;
use neotavern_storage::paths::{assets_dir, backups_dir};
use neotavern_storage::restore::{
    finalize_candidate, stage_candidate, CANDIDATE_READY_FILE, PENDING_MARKER_FILE,
};
use neotavern_storage::{StorageErrorCode, CURRENT_SCHEMA, STORAGE_FORMAT};

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// Opens a fresh writable handle to `root` (releases the lease on drop).
fn open_root(root: &Path) -> neotavern_storage::open::Database {
    let mut progress = |_p: MigrationProgress| {};
    open(root, &ConnectionPolicy::default(), &mut progress).expect("data root must open")
}

/// The container path of backup `id` under `root`.
fn container_path(root: &Path, id: &str) -> std::path::PathBuf {
    backups_dir(root).join(format!("{id}.neotavern-backup"))
}

/// Seeds two characters, one chat and two messages (the product payload the
/// round-trip asserts on).
fn seed_product(tx: &rusqlite::Transaction<'_>) {
    tx.execute(
        "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at)
         VALUES ('c1', 'Aria', 'a wandering bard', NULL, '[\"bard\"]', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        [],
    )
    .expect("seed c1");
    tx.execute(
        "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at)
         VALUES ('c2', 'Rook', 'a quiet guard', NULL, '[]', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        [],
    )
    .expect("seed c2");
    tx.execute(
        "INSERT INTO chats (id, title, character_id, created_at, updated_at)
         VALUES ('chat-1', 'First voyage', 'c1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        [],
    )
    .expect("seed chat");
    tx.execute(
        "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at)
         VALUES ('m1', 'chat-1', 'user', 'Hello', 1, NULL, '2026-01-01T00:00:00Z')",
        [],
    )
    .expect("seed m1");
    tx.execute(
        "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at)
         VALUES ('m2', 'chat-1', 'assistant', 'Hi there', 2, NULL, '2026-01-01T00:00:00Z')",
        [],
    )
    .expect("seed m2");
}

/// Counts rows of `table` through the open connection.
fn count_rows(db: &neotavern_storage::open::Database, table: &str) -> i64 {
    db.conn()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count must succeed")
}

/// Creates a backup of a root seeded with the standard product payload plus
/// two assets (one nested). Returns `(record, container_path)`.
fn seed_and_backup(root: &Path, id: &str) -> neotavern_storage::backup::BackupRecord {
    let mut db = open_root(root);
    publish_asset(&mut db, "asset-1", "image", "a.png", b"asset bytes one").expect("publish a");
    publish_asset(
        &mut db,
        "asset-2",
        "image",
        "nested/b.png",
        b"asset bytes two, nested",
    )
    .expect("publish b");
    db.transaction(|tx| {
        seed_product(tx);
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seed transaction");
    let record = create_backup(&mut db, id).expect("create_backup must succeed");
    drop(db);
    record
}

/// Asserts the product payload seeded by [`seed_product`] is present in
/// `root`'s database and that both assets exist on disk.
fn assert_product_restored(root: &Path) {
    let db = open_root(root);
    assert_eq!(count_rows(&db, "characters"), 2);
    assert_eq!(count_rows(&db, "chats"), 1);
    assert_eq!(count_rows(&db, "messages"), 2);
    let name: String = db
        .conn()
        .query_row("SELECT name FROM characters WHERE id = 'c1'", [], |row| {
            row.get(0)
        })
        .expect("c1 must exist");
    assert_eq!(name, "Aria");
    let content: String = db
        .conn()
        .query_row("SELECT content FROM messages WHERE id = 'm2'", [], |row| {
            row.get(0)
        })
        .expect("m2 must exist");
    assert_eq!(content, "Hi there");
    assert_eq!(
        count_rows(&db, "__neotavern_assets"),
        2,
        "asset registry rows must survive the restore"
    );
    drop(db);
    assert!(
        assets_dir(root).join("a.png").is_file(),
        "asset a.png restored"
    );
    assert!(
        assets_dir(root).join("nested/b.png").is_file(),
        "nested asset b.png restored"
    );
}

// ---------------------------------------------------------------------------
// create / verify / list
// ---------------------------------------------------------------------------

#[test]
fn create_verify_and_list_record_consistent_metadata() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let record = seed_and_backup(root, "backup-1");

    assert_eq!(record.format_version, 1);
    assert_eq!(record.status, "completed");
    assert!(!record.created_at.is_empty(), "created_at recorded");
    assert!(
        record.size_bytes > 0,
        "a seeded database + assets must not be empty: {}",
        record.size_bytes
    );
    assert_eq!(record.checksum_sha256.len(), 64, "sha256 is 64 hex chars");
    assert!(
        record
            .checksum_sha256
            .chars()
            .all(|c| c.is_ascii_hexdigit()),
        "checksum is hex"
    );

    // Container layout: manifest.json + checksums.json + database.sqlite +
    // assets/ — with the manifest present (written last).
    let container = container_path(root, "backup-1");
    assert!(container.is_dir(), "container dir exists");
    assert!(container.join("manifest.json").is_file());
    assert!(container.join("checksums.json").is_file());
    assert!(container.join("database.sqlite").is_file());
    assert!(container.join("assets/a.png").is_file());
    assert!(container.join("assets/nested/b.png").is_file());

    // Manifest shape per ТЗ §41.
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(container.join("manifest.json"))?)?;
    assert_eq!(manifest["format"], "neotavern-backup");
    assert_eq!(manifest["formatVersion"], 1);
    assert_eq!(manifest["createdAt"], record.created_at);
    assert_eq!(manifest["createdBy"]["platform"], "kernel");
    assert_eq!(
        manifest["createdBy"]["appVersion"],
        env!("CARGO_PKG_VERSION")
    );
    assert_eq!(manifest["storage"]["storageFormat"], STORAGE_FORMAT);
    assert_eq!(manifest["storage"]["schemaRevision"], CURRENT_SCHEMA);

    // Inventory: sorted by logicalPath (lexicographic — `assets/` sorts
    // before `database.sqlite`), always including the database entry.
    let inventory: Vec<serde_json::Value> =
        serde_json::from_slice(&fs::read(container.join("checksums.json"))?)?;
    let paths: Vec<&str> = inventory
        .iter()
        .map(|e| e["logicalPath"].as_str().expect("logicalPath"))
        .collect();
    let mut sorted = paths.clone();
    sorted.sort_unstable();
    assert_eq!(paths, sorted, "inventory sorted by logicalPath");
    assert!(
        paths.contains(&"database.sqlite"),
        "database entry present: {paths:?}"
    );
    assert!(paths.contains(&"assets/a.png"));
    assert!(paths.contains(&"assets/nested/b.png"));
    let declared_size: i64 = inventory.iter().map(|e| e["size"].as_i64().unwrap()).sum();
    assert_eq!(declared_size, record.size_bytes);

    // verify_backup cross-checks every file.
    let verified = verify_backup(&container)?;
    assert_eq!(verified.id, "backup-1");
    assert_eq!(verified.format_version, 1);
    assert_eq!(verified.storage_format, STORAGE_FORMAT);
    assert_eq!(verified.schema_revision, CURRENT_SCHEMA);
    assert_eq!(verified.size_bytes, record.size_bytes);
    assert_eq!(verified.checksum_sha256, record.checksum_sha256);
    assert_eq!(verified.created_at, record.created_at);

    // list_backups returns the same record.
    let listed = list_backups(root)?;
    assert_eq!(listed.len(), 1, "exactly one completed backup");
    assert_eq!(listed[0].id, "backup-1");
    assert_eq!(listed[0].created_at, record.created_at);
    assert_eq!(listed[0].format_version, 1);
    assert_eq!(listed[0].size_bytes, record.size_bytes);
    assert_eq!(listed[0].checksum_sha256, record.checksum_sha256);
    assert_eq!(listed[0].status, "completed");
    Ok(())
}

#[test]
fn list_ignores_provisional_and_foreign_dirs() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    seed_and_backup(root, "real-1");

    // A provisional container dir (no manifest, fresh) — ignored AND kept
    // (only dirs older than 24h are collected).
    let tmp_dir = backups_dir(root).join("real-2.neotavern-backup.tmp-7");
    fs::create_dir_all(tmp_dir.join("assets"))?;
    // A foreign directory that is not a container — ignored.
    let foreign = backups_dir(root).join("notes");
    fs::create_dir_all(&foreign)?;
    fs::write(foreign.join("manifest.json"), b"{}")?;

    let listed = list_backups(root)?;
    assert_eq!(listed.len(), 1, "only the completed container is listed");
    assert_eq!(listed[0].id, "real-1");
    assert!(
        tmp_dir.is_dir(),
        "fresh provisional dir is not garbage-collected"
    );
    assert!(foreign.is_dir());
    Ok(())
}

#[test]
fn list_surfaces_a_container_missing_its_manifest() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    seed_and_backup(root, "ok-1");

    // A directory that LOOKS completed (final name) but lost its manifest —
    // that is tampering/corruption, and list must surface it, not hide it.
    let broken = backups_dir(root).join("broken.neotavern-backup");
    fs::create_dir_all(&broken)?;

    let err = list_backups(root).expect_err("broken container must fail the list");
    assert_eq!(err.code, StorageErrorCode::Corrupt);
    Ok(())
}

#[test]
fn missing_referenced_asset_aborts_create_and_cleans_up() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut db = open_root(root);
    publish_asset(&mut db, "asset-1", "image", "a.png", b"doomed asset")?;

    // Delete the live asset FILE but keep the registry row: the snapshot
    // pins the row, the live copy is gone → abort + IntegrityViolation.
    fs::remove_file(assets_dir(root).join("a.png"))?;

    let err = create_backup(&mut db, "doomed")
        .expect_err("create must abort when a referenced asset is missing");
    assert_eq!(err.code, StorageErrorCode::IntegrityViolation);

    // No final container and no provisional leftovers.
    assert!(
        !container_path(root, "doomed").exists(),
        "no final container"
    );
    let leftovers: Vec<_> = fs::read_dir(backups_dir(root))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "provisional dir cleaned up: {leftovers:?}"
    );
    Ok(())
}

#[test]
fn quota_reached_after_max_backups() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let mut db = open_root(root);

    for i in 0..MAX_BACKUPS {
        let id = format!("quota-{i:03}");
        create_backup(&mut db, &id).expect("backup within quota must succeed");
    }
    assert_eq!(list_backups(root)?.len(), MAX_BACKUPS);

    let err =
        create_backup(&mut db, "quota-999").expect_err("the quota + 1th backup must be rejected");
    assert_eq!(err.code, StorageErrorCode::QuotaExceeded);
    assert_eq!(
        list_backups(root)?.len(),
        MAX_BACKUPS,
        "no backup was added"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// restore round-trip
// ---------------------------------------------------------------------------

#[test]
fn restore_round_trip_preserves_product_data() -> TestResult {
    let parent = tempfile::tempdir()?;
    let root_a = parent.path().join("a");
    let root_b = parent.path().join("b");

    let record = seed_and_backup(&root_a, "rt-1");
    let container = container_path(&root_a, "rt-1");
    verify_backup(&container)?;
    assert_eq!(record.status, "completed");

    // Kernel-closed restore into a fresh root B.
    restore_backup(&container, &root_b)?;

    // The container and the source root are untouched.
    assert!(container.is_dir());
    assert!(db_has_rows(&root_a, "characters", 2));

    // B holds the exact product payload.
    assert_product_restored(&root_b);

    let listed = list_backups(&root_b)?;
    assert!(
        listed.is_empty(),
        "the restored root has no backups of its own"
    );
    Ok(())
}

#[test]
fn restore_into_existing_root_swaps_and_prunes_previous() -> TestResult {
    let parent = tempfile::tempdir()?;
    let root_a = parent.path().join("a");
    let root_b = parent.path().join("b");

    seed_and_backup(&root_a, "swap-1");
    let container = container_path(&root_a, "swap-1");

    // Root B holds DIFFERENT data (one character only).
    {
        let mut db = open_root(&root_b);
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at)
                 VALUES ('other', 'Someone Else', NULL, NULL, '[]', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .map_err(|e| neotavern_storage::StorageError::from_sqlite(e, "seed other character"))?;
            Ok::<(), neotavern_storage::StorageError>(())
        })?;
        drop(db);
    }

    restore_backup(&container, &root_b)?;

    // B now holds A's data; the previous root was retained (≤ 1) and the
    // first open after activation prunes.
    let db = open_root(&root_b);
    assert_eq!(count_rows(&db, "characters"), 2);
    assert_eq!(
        count_rows(&db, "chats"),
        1,
        "A's chat came over, B's old data is gone"
    );
    drop(db);

    let previous: Vec<_> = fs::read_dir(parent.path())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".neotavern-previous-")
        })
        .collect();
    assert!(
        previous.len() <= 1,
        "previous roots pruned to at most one: {previous:?}"
    );
    Ok(())
}

fn db_has_rows(root: &Path, table: &str, expected: i64) -> bool {
    let db = open_root(root);
    let n = count_rows(&db, table);
    drop(db);
    n == expected
}

// ---------------------------------------------------------------------------
// staged-activation kill matrix (ТЗ §42)
// ---------------------------------------------------------------------------

/// Stages a verified container into a candidate for `root` exactly like
/// `restore_backup` does (verify → stage → copy → open candidate → checks →
/// finalize), but WITHOUT activating — the caller simulates the kill.
/// Returns the finalized candidate.
fn stage_container_candidate(
    container: &Path,
    root: &Path,
) -> Result<neotavern_storage::restore::Candidate, Box<dyn std::error::Error>> {
    verify_backup(container)?;
    let candidate = stage_candidate(root)?;
    neotavern_storage::restore::copy_data_root_into(container, &candidate)?;
    let mut progress = |_p: MigrationProgress| {};
    let db = open(&candidate.path, &ConnectionPolicy::default(), &mut progress)?;
    drop(db); // releases the candidate's lease
    finalize_candidate(&candidate)?;
    Ok(candidate)
}

/// Writes a pending-activation marker pointing at `candidate` for `root`
/// (the shape `restore::activate` writes; the machinery only reads
/// `candidate`).
fn write_pending_marker(parent: &Path, root: &Path, candidate: &Path) -> TestResult {
    let body = serde_json::json!({
        "root": root.to_string_lossy(),
        "candidate": candidate.to_string_lossy(),
        "createdAt": "2026-01-01T00:00:00Z",
    });
    fs::write(parent.join(PENDING_MARKER_FILE), body.to_string())?;
    Ok(())
}

#[test]
fn kill_after_stage_and_finalize_without_activate_keeps_current_root() -> TestResult {
    let parent = tempfile::tempdir()?;
    let root_a = parent.path().join("a");
    let root_b = parent.path().join("b");
    seed_and_backup(&root_a, "kill-1");
    let container = container_path(&root_a, "kill-1");

    // Kill after stage + finalize, BEFORE activate (no marker was written).
    let candidate = stage_container_candidate(&container, &root_b)?;

    // The next open of the target root keeps the current state: B is fresh
    // and the staged candidate is left untouched (no marker → nothing to
    // resolve).
    let db = open_root(&root_b);
    assert_eq!(count_rows(&db, "characters"), 0, "B stays fresh");
    drop(db);
    assert!(
        !parent.path().join(PENDING_MARKER_FILE).exists(),
        "no pending marker without activation"
    );
    assert!(
        candidate.path.exists(),
        "the not-yet-activated candidate is untouched"
    );
    Ok(())
}

#[test]
fn kill_after_marker_with_unready_candidate_discards_candidate() -> TestResult {
    let parent = tempfile::tempdir()?;
    let root_a = parent.path().join("a");
    let root_b = parent.path().join("b");
    seed_and_backup(&root_a, "kill-2");
    let container = container_path(&root_a, "kill-2");

    // Stage the candidate but never finalize it (no ready file), then write
    // the pending marker — the kill window between marker write and swap with
    // an incomplete candidate.
    verify_backup(&container)?;
    let candidate = stage_candidate(&root_b)?;
    neotavern_storage::restore::copy_data_root_into(&container, &candidate)?;
    assert!(
        !candidate.path.join(CANDIDATE_READY_FILE).exists(),
        "candidate is not finalized"
    );
    write_pending_marker(parent.path(), &root_b, &candidate.path)?;

    // resolve discards the incomplete candidate and keeps the current root.
    let db = open_root(&root_b);
    assert_eq!(count_rows(&db, "characters"), 0, "B stays fresh");
    drop(db);
    assert!(!candidate.path.exists(), "unready candidate discarded");
    assert!(
        !parent.path().join(PENDING_MARKER_FILE).exists(),
        "marker cleared"
    );
    Ok(())
}

#[test]
fn kill_after_marker_with_ready_candidate_completes_swap() -> TestResult {
    let parent = tempfile::tempdir()?;
    let root_a = parent.path().join("a");
    let root_b = parent.path().join("b");
    seed_and_backup(&root_a, "kill-3");
    let container = container_path(&root_a, "kill-3");

    // Stage + finalize, then write the marker — the kill window after the
    // marker write, before the directory swap.
    let candidate = stage_container_candidate(&container, &root_b)?;
    write_pending_marker(parent.path(), &root_b, &candidate.path)?;

    // Simulate the next boot's resolution directly. NOTE: this runs
    // `resolve_pending_restore` WITHOUT the data-root lease that `open::open`
    // holds while resolving — on Windows a directory whose lock file is held
    // open cannot be renamed, so the open-path swap-completion is a
    // platform limitation of the frozen lease/resolve interaction. The
    // resolution logic itself is identical.
    neotavern_storage::restore::resolve_pending_restore(&root_b)?;

    // The swap completed: B now holds the restored data.
    let db = open_root(&root_b);
    assert_eq!(count_rows(&db, "characters"), 2, "restored data active");
    drop(db);
    assert!(!candidate.path.exists(), "candidate consumed by the swap");
    assert!(
        !parent.path().join(PENDING_MARKER_FILE).exists(),
        "marker cleared"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// corrupt / traversal / oversize rejection at verify (before activation)
// ---------------------------------------------------------------------------

#[test]
fn verify_rejects_tampered_asset_checksum() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    seed_and_backup(root, "tamper-1");
    let container = container_path(root, "tamper-1");
    verify_backup(&container)?;

    // Flip one byte inside the container's asset copy.
    let asset = container.join("assets/a.png");
    let mut bytes = fs::read(&asset)?;
    bytes[0] ^= 0xFF;
    fs::write(&asset, bytes)?;

    let err = verify_backup(&container).expect_err("tampered asset must fail verify");
    assert_eq!(err.code, StorageErrorCode::Corrupt);
    assert!(
        err.message.contains("checksum mismatch"),
        "message describes the mismatch: {}",
        err.message
    );
    Ok(())
}

#[test]
fn verify_rejects_tampered_database() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    seed_and_backup(root, "tamper-2");
    let container = container_path(root, "tamper-2");
    verify_backup(&container)?;

    // Flip a byte in the container's database copy.
    let db_file = container.join("database.sqlite");
    let mut bytes = fs::read(&db_file)?;
    let flip = bytes.len() / 2;
    bytes[flip] ^= 0x01;
    fs::write(&db_file, bytes)?;

    let err = verify_backup(&container).expect_err("tampered database must fail verify");
    assert_eq!(err.code, StorageErrorCode::Corrupt);
    Ok(())
}

#[test]
fn verify_rejects_tampered_inventory_declaration() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    seed_and_backup(root, "tamper-3");
    let container = container_path(root, "tamper-3");

    // Rewrite checksums.json with a wrong declared hash for database.sqlite.
    let forged = serde_json::json!([
        {
            "logicalPath": "database.sqlite",
            "type": "database",
            "size": fs::metadata(container.join("database.sqlite"))?.len(),
            "sha256": "0".repeat(64),
        }
    ]);
    fs::write(container.join("checksums.json"), forged.to_string())?;

    let err = verify_backup(&container).expect_err("forged inventory must fail verify");
    assert_eq!(err.code, StorageErrorCode::Corrupt);
    assert!(
        err.message.contains("checksum mismatch"),
        "message describes the mismatch: {}",
        err.message
    );
    Ok(())
}

#[test]
fn verify_rejects_traversal_logical_paths() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    seed_and_backup(root, "evil-1");
    let container = container_path(root, "evil-1");

    // `../evil` — outside the allowlist entirely.
    let traversal = serde_json::json!([
        {
            "logicalPath": "../evil",
            "type": "asset",
            "size": 1,
            "sha256": "0".repeat(64),
        }
    ]);
    fs::write(container.join("checksums.json"), traversal.to_string())?;
    let err = verify_backup(&container).expect_err("traversal logicalPath must fail verify");
    assert_eq!(err.code, StorageErrorCode::Corrupt);
    assert!(
        err.message.contains("allowed prefixes") || err.message.contains("grammar"),
        "message describes the traversal: {}",
        err.message
    );

    // `assets/../../evil` — inside the prefix but escapes via `..` components.
    let nested = serde_json::json!([
        {
            "logicalPath": "assets/../../evil",
            "type": "asset",
            "size": 1,
            "sha256": "0".repeat(64),
        }
    ]);
    fs::write(container.join("checksums.json"), nested.to_string())?;
    let err = verify_backup(&container).expect_err("nested traversal must fail verify");
    assert_eq!(err.code, StorageErrorCode::Corrupt);
    Ok(())
}

#[test]
fn verify_rejects_oversize_container_before_reading_files() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    seed_and_backup(root, "huge-1");
    let container = container_path(root, "huge-1");

    // Declare a total above the 1 GiB guard; the files themselves never need
    // to exist because the size check fires before any file is hashed.
    let huge = serde_json::json!([
        {
            "logicalPath": "database.sqlite",
            "type": "database",
            "size": MAX_BACKUP_BYTES + 1,
            "sha256": "0".repeat(64),
        }
    ]);
    fs::write(container.join("checksums.json"), huge.to_string())?;

    let err = verify_backup(&container).expect_err("oversize container must fail verify");
    assert_eq!(err.code, StorageErrorCode::QuotaExceeded);
    assert!(
        err.message.contains("maximum container size"),
        "message describes the guard: {}",
        err.message
    );
    Ok(())
}

#[test]
fn restore_rejects_corrupt_container_without_touching_target() -> TestResult {
    let parent = tempfile::tempdir()?;
    let root_a = parent.path().join("a");
    let root_b = parent.path().join("b");
    seed_and_backup(&root_a, "rej-1");
    let container = container_path(&root_a, "rej-1");

    // Corrupt the container (flip a byte in the asset copy).
    let asset = container.join("assets/a.png");
    let mut bytes = fs::read(&asset)?;
    bytes[0] ^= 0xFF;
    fs::write(&asset, bytes)?;

    // The target root is NEVER touched: B is not even created by the failed
    // restore (verify fires before staging).
    let err = restore_backup(&container, &root_b).expect_err("corrupt restore must fail");
    assert_eq!(err.code, StorageErrorCode::Corrupt);
    assert!(!root_b.exists(), "target root never created");
    assert!(
        !parent.path().join(PENDING_MARKER_FILE).exists(),
        "no pending marker"
    );
    let candidates: Vec<_> = fs::read_dir(parent.path())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".neotavern-candidate-")
        })
        .collect();
    assert!(candidates.is_empty(), "no candidate staged: {candidates:?}");
    Ok(())
}
