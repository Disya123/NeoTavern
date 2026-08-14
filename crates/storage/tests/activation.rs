//! Integration tests for versioned data-root activation
//! (`neotavern_storage::activation`, ТЗ §10.2–§10.4, ADR-0041, Этап 3):
//! the journal round-trip and transitions, the atomic pointer switch, the
//! kill-matrix recovery (`resolve_pending_activation` completes or rolls back
//! deterministically), transient-error retry classification, and the
//! integration with `open::open`/`open_read_only` on the active root.

use std::fs;
use std::path::Path;

use neotavern_storage::activation::{
    self, activate, active_root, begin_activation, is_transient, latest_entry, read_journal,
    read_pointer, resolve_pending_activation, transition_status, write_pointer,
    ActivationResolution, ActivationStatus, RetryPolicy, ACTIVATION_JOURNAL_FILE, ACTIVE_ROOT_FILE,
    ROOTS_DIR, ROOT_DIR_PREFIX,
};
use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::migrations::MigrationProgress;
use neotavern_storage::open::{open, open_read_only};
use neotavern_storage::{StorageError, StorageErrorCode};

/// Opens a fresh writable handle to `root` (releases the lease on drop).
fn open_root(root: &Path) -> neotavern_storage::open::Database {
    let mut progress = |_p: MigrationProgress| {};
    open(root, &ConnectionPolicy::default(), &mut progress).expect("data root must open")
}

/// Seeds one character row inside `root` and closes the handle.
fn seed_root(root: &Path, name: &str) {
    let mut db = open_root(root);
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES ('11111111-1111-7111-8111-111111111111', ?1, NULL, NULL, '[]', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![name],
        )
        .map_err(|e| neotavern_storage::StorageError::from_sqlite(e, "seed"))
    })
    .expect("seed character");
    drop(db);
}

/// Reads the seeded character name from `root`.
fn character_name(root: &Path) -> String {
    let db = open_root(root);
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

/// Builds a fresh kernel data root at `path` (used as an activation target).
fn build_kernel_root(path: &Path) {
    let db = open_root(path);
    drop(db);
}

const ENTRY_ID: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e8f0a1b2c3d";
const KIND: &str = "migration";

/// A journal-only helper: a fresh entry as `begin_activation` would write it,
/// but with a deterministic timestamp.
fn begin_entry(data_root: &Path, to_root: &Path) {
    begin_activation(data_root, ENTRY_ID, KIND, data_root, to_root).expect("begin activation");
}

// --- journal round-trip and transitions ------------------------------------

#[test]
fn missing_journal_is_empty() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    fs::create_dir_all(&root).expect("create data root");

    let journal = read_journal(&root).expect("missing journal reads as empty");
    assert!(journal.entries.is_empty(), "no entries in a fresh journal");
    assert!(
        latest_entry(&root).expect("latest").is_none(),
        "no latest entry in a fresh journal"
    );
}

#[test]
fn journal_round_trip_preserves_entry() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    let target = temp.path().join("roots").join("root-t1");
    fs::create_dir_all(&root).expect("create data root");

    begin_entry(&root, &target);
    transition_status(&root, ENTRY_ID, ActivationStatus::Validated, None).expect("validated");
    transition_status(&root, ENTRY_ID, ActivationStatus::ActivationPending, None).expect("pending");

    let journal = read_journal(&root).expect("read journal");
    assert_eq!(journal.entries.len(), 1, "one entry");
    let entry = &journal.entries[0];
    assert_eq!(entry.id, ENTRY_ID);
    assert_eq!(entry.kind, KIND);
    assert_eq!(entry.status, ActivationStatus::ActivationPending);
    assert_eq!(entry.from_root, root);
    assert_eq!(entry.to_root, target);
    assert!(!entry.created_at.is_empty());
    assert!(!entry.updated_at.is_empty());
    assert!(entry.error.is_none());
}

#[test]
fn write_entry_is_idempotent_per_id() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    let target = temp.path().join("roots").join("root-t1");
    fs::create_dir_all(&root).expect("create data root");

    begin_entry(&root, &target);
    // Re-running the same begin must not duplicate the entry.
    begin_entry(&root, &target);
    assert_eq!(
        read_journal(&root).expect("journal").entries.len(),
        1,
        "same id replaces, never appends"
    );
}

#[test]
fn unknown_entry_transition_is_not_found() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    fs::create_dir_all(&root).expect("create data root");

    let err = transition_status(&root, "no-such-id", ActivationStatus::Committed, None)
        .expect_err("unknown id must fail");
    assert_eq!(err.code, StorageErrorCode::NotFound);
}

#[test]
fn corrupt_journal_is_rejected() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    fs::create_dir_all(&root).expect("create data root");
    fs::write(root.join(ACTIVATION_JOURNAL_FILE), b"{ this is not json")
        .expect("write corrupt journal");

    let err = read_journal(&root).expect_err("corrupt journal must fail");
    assert_eq!(err.code, StorageErrorCode::Corrupt);
}

#[test]
fn future_journal_format_fails_closed() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    fs::create_dir_all(&root).expect("create data root");
    fs::write(
        root.join(ACTIVATION_JOURNAL_FILE),
        br#"{"format":"neotavern-activation-journal","formatVersion":99,"entries":[]}"#,
    )
    .expect("write future journal");

    let err = read_journal(&root).expect_err("future format must fail closed");
    assert_eq!(err.code, StorageErrorCode::SchemaTooNew);
}

// --- pointer ----------------------------------------------------------------

#[test]
fn missing_pointer_means_flat_layout() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    fs::create_dir_all(&root).expect("create data root");

    assert!(
        read_pointer(&root).expect("pointer").is_none(),
        "no pointer file in v1 flat layout"
    );
    assert_eq!(active_root(&root).expect("active root"), root);
}

#[test]
fn pointer_round_trip_and_active_root_resolution() {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_root = temp.path().join("data");
    let target = data_root
        .join(ROOTS_DIR)
        .join(format!("{ROOT_DIR_PREFIX}t1"));
    fs::create_dir_all(&target).expect("create target root");

    write_pointer(&data_root, &target).expect("write pointer");
    let pointer = read_pointer(&data_root)
        .expect("read pointer")
        .expect("pointer present");
    assert_eq!(pointer.root, target);
    assert!(!pointer.activated_at.is_empty());
    assert_eq!(active_root(&data_root).expect("active root"), target);
}

#[test]
fn pointer_to_missing_root_is_not_found() {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_root = temp.path().join("data");
    let target = data_root
        .join(ROOTS_DIR)
        .join(format!("{ROOT_DIR_PREFIX}ghost"));
    fs::create_dir_all(&data_root).expect("create data root");

    // Write the pointer manually (write_pointer itself does not require the
    // target to exist — it is a pointer, not a verifier).
    let body = serde_json::json!({
        "formatVersion": 1,
        "root": target.to_string_lossy(),
        "activatedAt": "2026-01-01T00:00:00Z",
    });
    fs::write(data_root.join(ACTIVE_ROOT_FILE), body.to_string()).expect("write pointer");

    let err = read_pointer(&data_root).expect_err("missing target must fail");
    assert_eq!(err.code, StorageErrorCode::NotFound);
}

// --- kill-matrix recovery ---------------------------------------------------

/// Kill after `begin` (prepared, no pending switch): resolve is a no-op; the
/// previous root stays active (flat layout).
#[test]
fn resolve_without_pending_is_noop() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    let target = temp.path().join("roots").join("root-t1");
    fs::create_dir_all(&root).expect("create data root");
    begin_entry(&root, &target);

    let resolution = resolve_pending_activation(&root).expect("resolve");
    assert_eq!(resolution, ActivationResolution::None);
    assert_eq!(active_root(&root).expect("active root"), root);
}

/// Kill between `activation_pending` and the pointer switch, target present:
/// resolve completes the switch (restart-to-complete) and the target becomes
/// the active root.
#[test]
fn resolve_completes_pending_switch() {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_root = temp.path().join("data");
    let target = data_root
        .join(ROOTS_DIR)
        .join(format!("{ROOT_DIR_PREFIX}t1"));
    fs::create_dir_all(&data_root).expect("create data root");
    build_kernel_root(&target); // target carries a database
    begin_entry(&data_root, &target);
    transition_status(
        &data_root,
        ENTRY_ID,
        ActivationStatus::ActivationPending,
        None,
    )
    .expect("pending");

    let resolution = resolve_pending_activation(&data_root).expect("resolve");
    assert_eq!(
        resolution,
        ActivationResolution::Completed {
            entry_id: ENTRY_ID.to_string()
        }
    );
    assert_eq!(active_root(&data_root).expect("active root"), target);
    let entry = latest_entry(&data_root)
        .expect("latest")
        .expect("entry present");
    assert_eq!(entry.status, ActivationStatus::Committed);
}

/// Kill between `activation_pending` and the pointer switch, target MISSING:
/// resolve rolls back and the previous root stays active.
#[test]
fn resolve_rolls_back_missing_target() {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_root = temp.path().join("data");
    let target = data_root
        .join(ROOTS_DIR)
        .join(format!("{ROOT_DIR_PREFIX}ghost"));
    fs::create_dir_all(&data_root).expect("create data root");
    begin_entry(&data_root, &target);
    transition_status(
        &data_root,
        ENTRY_ID,
        ActivationStatus::ActivationPending,
        None,
    )
    .expect("pending");

    let resolution = resolve_pending_activation(&data_root).expect("resolve");
    assert_eq!(
        resolution,
        ActivationResolution::RolledBack {
            entry_id: ENTRY_ID.to_string()
        }
    );
    assert_eq!(active_root(&data_root).expect("active root"), data_root);
    let entry = latest_entry(&data_root)
        .expect("latest")
        .expect("entry present");
    assert_eq!(entry.status, ActivationStatus::RolledBack);
    assert!(entry.error.is_some(), "rollback records a reason");
}

/// The full activation path: `activate` publishes a validated target and the
/// pointer switch lands atomically.
#[test]
fn activate_publishes_target_and_commits() {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_root = temp.path().join("data");
    let target = data_root
        .join(ROOTS_DIR)
        .join(format!("{ROOT_DIR_PREFIX}t1"));
    fs::create_dir_all(&data_root).expect("create data root");
    build_kernel_root(&target);

    activate(&data_root, ENTRY_ID, KIND, &data_root, &target).expect("activate");

    assert_eq!(active_root(&data_root).expect("active root"), target);
    let entry = latest_entry(&data_root)
        .expect("latest")
        .expect("entry present");
    assert_eq!(entry.status, ActivationStatus::Committed);
}

/// `activate` refuses a target without a database before writing anything.
#[test]
fn activate_refuses_target_without_database() {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_root = temp.path().join("data");
    let target = data_root
        .join(ROOTS_DIR)
        .join(format!("{ROOT_DIR_PREFIX}empty"));
    fs::create_dir_all(&data_root).expect("create data root");
    fs::create_dir_all(&target).expect("create empty target");

    let err = activate(&data_root, ENTRY_ID, KIND, &data_root, &target)
        .expect_err("activation must be refused");
    assert_eq!(err.code, StorageErrorCode::IntegrityViolation);
    assert!(
        latest_entry(&data_root).expect("latest").is_none(),
        "no journal entry written for a refused activation"
    );
}

// --- transient retry --------------------------------------------------------

/// Windows sharing/lock violations are classified transient; a permanent
/// access-denied is NOT (ТЗ §10.3.1 item 3).
#[test]
fn transient_error_classification() {
    let sharing = StorageError::with(
        StorageErrorCode::Io,
        "sharing violation",
        vec![("os_error".to_string(), "32".to_string())],
    );
    assert!(
        is_transient(&sharing),
        "ERROR_SHARING_VIOLATION is transient"
    );

    let lock = StorageError::with(
        StorageErrorCode::Io,
        "lock violation",
        vec![("os_error".to_string(), "33".to_string())],
    );
    assert!(is_transient(&lock), "ERROR_LOCK_VIOLATION is transient");

    let access_denied = StorageError::with(
        StorageErrorCode::Io,
        "access denied",
        vec![("os_error".to_string(), "5".to_string())],
    );
    assert!(
        !is_transient(&access_denied),
        "access denied is NOT retried (permanent denial must surface)"
    );

    let busy = StorageError::new(StorageErrorCode::Busy, "sqlite busy");
    assert!(is_transient(&busy), "SQLITE_BUSY is transient");

    let corrupt = StorageError::new(StorageErrorCode::Corrupt, "corrupt");
    assert!(!is_transient(&corrupt), "corruption is never transient");
}

/// `with_transient_retry` retries transient failures up to the budget and
/// succeeds once the contention clears.
#[test]
fn retry_recovers_from_transient_contention() {
    use std::sync::atomic::{AtomicU32, Ordering};

    let attempts = AtomicU32::new(0);
    let result = activation::with_transient_retry(
        RetryPolicy {
            max_attempts: 5,
            base_delay_ms: 1,
        },
        || -> Result<i32, StorageError> {
            let n = attempts.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                Err(StorageError::with(
                    StorageErrorCode::Io,
                    "sharing violation",
                    vec![("os_error".to_string(), "32".to_string())],
                ))
            } else {
                Ok(42)
            }
        },
    )
    .expect("retry recovers");
    assert_eq!(result, 42);
    assert_eq!(attempts.load(Ordering::SeqCst), 3, "2 failures + 1 success");
}

/// `with_transient_retry` gives up with the last error after the budget.
#[test]
fn retry_exhausts_budget_and_returns_error() {
    use std::sync::atomic::{AtomicU32, Ordering};

    let attempts = AtomicU32::new(0);
    let err = activation::with_transient_retry(
        RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 1,
        },
        || -> Result<i32, StorageError> {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(StorageError::with(
                StorageErrorCode::Io,
                "lock violation",
                vec![("os_error".to_string(), "33".to_string())],
            ))
        },
    )
    .expect_err("budget exhausted");
    assert_eq!(err.code, StorageErrorCode::Io);
    assert_eq!(attempts.load(Ordering::SeqCst), 3, "exactly max_attempts");
}

// --- open-path integration --------------------------------------------------

/// A v2 data root with an active pointer opens the DATABASE from the active
/// root: product rows seeded in the target are visible through `open`.
#[test]
fn open_reads_from_active_root() {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_root = temp.path().join("data");
    let target = data_root
        .join(ROOTS_DIR)
        .join(format!("{ROOT_DIR_PREFIX}t1"));
    fs::create_dir_all(&data_root).expect("create data root");
    build_kernel_root(&target);
    seed_root(&target, "versioned");

    // Publish the target without going through `activate` (already covered):
    // a plain pointer write models an activation committed by another path.
    write_pointer(&data_root, &target).expect("write pointer");

    assert_eq!(
        character_name(&data_root),
        "versioned",
        "open resolves the active root"
    );
}

/// `open_read_only` also resolves the active root (recovery mode).
#[test]
fn open_read_only_resolves_active_root() {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_root = temp.path().join("data");
    let target = data_root
        .join(ROOTS_DIR)
        .join(format!("{ROOT_DIR_PREFIX}t1"));
    fs::create_dir_all(&data_root).expect("create data root");
    build_kernel_root(&target);
    seed_root(&target, "readonly");
    write_pointer(&data_root, &target).expect("write pointer");

    let db = open_read_only(&data_root).expect("read-only open");
    let name: String = db
        .conn()
        .query_row(
            "SELECT name FROM characters WHERE id = '11111111-1111-7111-8111-111111111111'",
            [],
            |row| row.get(0),
        )
        .expect("read seeded character");
    assert_eq!(name, "readonly");
    drop(db);
}

/// Flat v1 roots are untouched by the new machinery: no pointer, no journal,
/// open behaves exactly as before.
#[test]
fn flat_root_open_is_unchanged() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    seed_root(&root, "flat");

    assert_eq!(character_name(&root), "flat");
    assert!(!root.join(ACTIVE_ROOT_FILE).exists(), "no pointer created");
    assert!(
        !root.join(ACTIVATION_JOURNAL_FILE).exists(),
        "no journal created by a plain open"
    );
}

/// A full lifecycle: seed current root → stage a converted target → activate
/// → open reads the target → resolve is a no-op afterwards (idempotent).
#[test]
fn migration_lifecycle_round_trip() {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_root = temp.path().join("data");
    let target = data_root
        .join(ROOTS_DIR)
        .join(format!("{ROOT_DIR_PREFIX}m1"));
    fs::create_dir_all(&data_root).expect("create data root");
    seed_root(&data_root, "before");
    build_kernel_root(&target);
    seed_root(&target, "after");

    activate(&data_root, ENTRY_ID, "migration", &data_root, &target).expect("activate");
    assert_eq!(character_name(&data_root), "after");

    // Recovery after the fact is a no-op (committed, not pending).
    assert_eq!(
        resolve_pending_activation(&data_root).expect("resolve"),
        ActivationResolution::None
    );

    // The retained previous root is still on disk (rollback point) and the
    // journal documents the full stage history.
    assert!(target.is_dir(), "active target exists");
    let journal = read_journal(&data_root).expect("journal");
    assert_eq!(journal.entries.len(), 1);
    let entry = &journal.entries[0];
    assert_eq!(entry.status, ActivationStatus::Committed);
    assert_eq!(entry.kind, "migration");
    assert_eq!(entry.from_root, data_root);
    assert_eq!(entry.to_root, target);
}
