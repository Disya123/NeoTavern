//! Phase 11 kernel backup-operation tests (ТЗ §40–§41): `backups.create` /
//! `backups.list` over the dispatch surface — wire-valid DTOs on a seeded
//! storage kernel, stateless-kernel rejection, and the QUOTA_EXCEEDED
//! product error surfaced from the storage quota.

use contracts_generated::generated::{BackupDto, ResultListBackups};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};
use serde_json::{json, Value};

/// A kernel over `root` with the correct, manifest-derived contract
/// expectations.
fn open_kernel_with_root(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

/// A stateless kernel (no data root).
fn open_stateless_kernel() -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: None,
    })
    .expect("stateless kernel must open")
}

/// Serializes `request`, dispatches `op`, and decodes the response bytes to
/// JSON.
fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

/// True when `s` is 64 lowercase hex digits.
fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

#[test]
fn backups_create_on_seeded_storage_returns_completed_dto() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    // Seed product data through the real wire surface so the backup has a
    // non-trivial payload.
    for name in ["Aria", "Rook"] {
        dispatch_json(
            &kernel,
            "characters.create",
            json!({ "name": name, "tags": ["party"] }),
        )
        .expect("character create must succeed");
    }

    let created =
        dispatch_json(&kernel, "backups.create", json!({})).expect("backups.create must succeed");
    let dto: BackupDto = serde_json::from_value(created).expect("response must be a BackupDto");
    assert_eq!(dto.status, "completed");
    assert_eq!(dto.format_version, 1.0);
    assert!(
        dto.size_bytes > 0,
        "a seeded database must not back up to zero bytes: {}",
        dto.size_bytes
    );
    assert!(
        is_sha256_hex(&dto.checksum_sha256),
        "checksum is sha256 hex"
    );
    assert!(
        uuid::Uuid::parse_str(&dto.id).is_ok(),
        "id must be a uuid: {}",
        dto.id
    );
    assert!(!dto.created_at.is_empty(), "createdAt recorded");

    // The response also passes the generated DTO validator directly.
    let value = serde_json::to_value(&dto).expect("dto serializes");
    contracts_generated::generated::validate_backup_dto(&value)
        .expect("created backup DTO is wire-valid");
    let backup_id = dto.id.clone();
    let created_at = dto.created_at.clone();

    // backups.list returns it, matching every field.
    let listed =
        dispatch_json(&kernel, "backups.list", json!({})).expect("backups.list must succeed");
    let result: ResultListBackups =
        serde_json::from_value(listed).expect("list response must decode");
    assert_eq!(result.items.len(), 1, "exactly one backup exists");
    assert_eq!(result.items[0].id, backup_id);
    assert_eq!(result.items[0].created_at, created_at);
    assert_eq!(result.items[0].format_version, 1.0);
    assert_eq!(result.items[0].size_bytes, dto.size_bytes);
    assert_eq!(result.items[0].checksum_sha256, dto.checksum_sha256);
    assert_eq!(result.items[0].status, "completed");
}

#[test]
fn second_backup_create_ok_and_list_returns_both() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let first =
        dispatch_json(&kernel, "backups.create", json!({})).expect("first create must succeed");
    let first: BackupDto = serde_json::from_value(first).expect("first BackupDto");
    let second =
        dispatch_json(&kernel, "backups.create", json!({})).expect("second create must succeed");
    let second: BackupDto = serde_json::from_value(second).expect("second BackupDto");
    assert_ne!(first.id, second.id, "distinct backup ids");

    let listed =
        dispatch_json(&kernel, "backups.list", json!({})).expect("backups.list must succeed");
    let result: ResultListBackups =
        serde_json::from_value(listed).expect("list response must decode");
    assert_eq!(result.items.len(), 2, "both backups listed");
    assert!(
        result.items.iter().any(|b| b.id == first.id),
        "first backup listed"
    );
    assert!(
        result.items.iter().any(|b| b.id == second.id),
        "second backup listed"
    );
}

#[test]
fn stateless_kernel_rejects_backup_ops_with_storage_failure() {
    let kernel = open_stateless_kernel();

    for op in ["backups.create", "backups.list", "backups.restore"] {
        let err = dispatch_json(
            &kernel,
            op,
            json!({ "backupId": "00000000-0000-4000-8000-000000000001" }),
        )
        .expect_err(&format!("stateless kernel must reject {op}"));
        assert_eq!(err.code, KernelErrorCode::StorageFailure, "{op}");
        assert!(err.product.is_none(), "{op} has no product payload");
        assert!(
            err.message.contains("durable storage"),
            "{op} message explains the storage requirement: {}",
            err.message
        );
    }
}

/// М5 slice 39: `backups.restore` round trip over the wire surface — create
/// characters, back up, mutate the library, restore the backup and verify
/// the library is back at the snapshotted state while the SAME kernel keeps
/// serving (the writer closed + reopened the database across the activation,
/// ТЗ §10.4).
#[test]
fn backups_restore_round_trip_through_the_kernel() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    // Seed two characters.
    dispatch_json(
        &kernel,
        "characters.create",
        json!({ "name": "Aria", "tags": ["party"] }),
    )
    .expect("character create must succeed");
    dispatch_json(
        &kernel,
        "characters.create",
        json!({ "name": "Rook", "tags": ["party"] }),
    )
    .expect("character create must succeed");

    // Snapshot: create a backup container and remember its id.
    let created =
        dispatch_json(&kernel, "backups.create", json!({})).expect("backups.create must succeed");
    let backup_id = created["id"].as_str().expect("backup id").to_string();

    // Mutate the library after the snapshot.
    let listed = dispatch_json(&kernel, "characters.list", json!({ "limit": 10 }))
        .expect("characters.list must succeed");
    let first_id = listed["items"][0]["id"]
        .as_str()
        .expect("character id")
        .to_string();
    dispatch_json(
        &kernel,
        "characters.delete",
        json!({ "characterId": first_id }),
    )
    .expect("character delete must succeed");
    let after_delete = dispatch_json(&kernel, "characters.list", json!({ "limit": 10 }))
        .expect("characters.list must succeed");
    assert_eq!(
        after_delete["items"].as_array().unwrap().len(),
        1,
        "one character deleted"
    );

    // Restore the snapshot through the wire op; the same kernel instance
    // re-opens the database on the swapped root.
    let restored = dispatch_json(&kernel, "backups.restore", json!({ "backupId": backup_id }))
        .expect("backups.restore must succeed");
    assert_eq!(restored["status"], json!("committed"));

    // The library is back at the snapshotted state and the kernel still
    // serves (the writer re-opened the database).
    let final_list = dispatch_json(&kernel, "characters.list", json!({ "limit": 10 }))
        .expect("characters.list after restore must succeed");
    assert_eq!(
        final_list["items"].as_array().unwrap().len(),
        2,
        "restore replayed the snapshot"
    );
}

/// М5 slice 39: an unknown backup id yields the wire `NOT_FOUND` product
/// error before any staged work, and the kernel stays usable afterwards.
#[test]
fn backups_restore_unknown_id_yields_not_found() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let err = dispatch_json(
        &kernel,
        "backups.restore",
        json!({ "backupId": "00000000-0000-4000-8000-0000000000ff" }),
    )
    .expect_err("unknown backup must fail");
    let product = err.product.expect("NOT_FOUND carries the wire product DTO");
    assert_eq!(product.code, "NOT_FOUND");
    assert_eq!(
        product.params["backupId"],
        json!("00000000-0000-4000-8000-0000000000ff")
    );

    // Kernel still usable.
    let meta = dispatch_json(&kernel, "meta.get", json!({})).expect("kernel alive after failure");
    assert!(meta["appVersion"].is_string());
}

/// М5 slice 39: a non-uuid backupId is a contract violation rejected before
/// any transport or staged work.
#[test]
fn backups_restore_rejects_non_uuid_id_before_work() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let err = dispatch_json(&kernel, "backups.restore", json!({ "backupId": "nope" }))
        .expect_err("non-uuid id must fail");
    assert_eq!(err.code, KernelErrorCode::ContractViolation);
}

#[test]
fn quota_exhaustion_surfaces_quota_exceeded_product_error() {
    let root = tempfile::tempdir().expect("tempdir");

    // Seed MAX_BACKUPS completed backups directly at the storage layer
    // (the kernel quota test — looping 16 wire round-trips would test the
    // same code path with far more noise).
    {
        let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
        let mut db = neotavern_storage::open::open(
            root.path(),
            &neotavern_storage::baseline::ConnectionPolicy::default(),
            &mut progress,
        )
        .expect("storage open for seeding");
        for i in 0..neotavern_storage::backup::MAX_BACKUPS {
            // Wire-valid uuid literal (version 4, variant 8) — distinct per
            // backup; the storage layer only needs the key grammar.
            let id = format!("00000000-0000-4000-8000-{i:012x}");
            neotavern_storage::backup::create_backup(&mut db, &id)
                .expect("backup within quota must succeed");
        }
        assert_eq!(
            neotavern_storage::backup::list_backups(root.path())
                .expect("list seeded backups")
                .len(),
            neotavern_storage::backup::MAX_BACKUPS
        );
        drop(db);
    }

    let kernel = open_kernel_with_root(root.path());
    let err = dispatch_json(&kernel, "backups.create", json!({}))
        .expect_err("create beyond the quota must fail");
    let product = err
        .product
        .expect("quota failure carries the wire product DTO");
    assert_eq!(product.code, "QUOTA_EXCEEDED");
    assert_eq!(
        product.params["limit"],
        json!(neotavern_storage::backup::MAX_BACKUPS.to_string()),
        "limit param mirrors MAX_BACKUPS"
    );
}
