//! Этап 4 slice 5 remainder part 2: canonical Configuration profiles over
//! Product Wire (ТЗ §8.1 Configuration — "profiles, non-secret settings,
//! capabilities").
//!
//! `profiles` (schema v14) mirrors the legacy minimal shape
//! (id/name/created_at) plus updated_at; a row is a named user context and
//! nothing references it yet. The per-profile FK columns on product tables
//! and SEC-02 export filtering (ADR-0047 waiver 4) are the slice-5
//! remainder follow-up this model unblocks. Errors: PROFILE_NOT_FOUND with
//! a `profileId` param; wire validation rejects bad ids/names.

use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::{json, Value};
use std::path::Path;

fn open_kernel(root: &Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch(
    kernel: &Kernel,
    op: &str,
    request: Value,
) -> Result<Value, runtime_kernel::KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

#[test]
fn profiles_create_list_rename_delete_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Empty at first.
    let list = dispatch(&kernel, "profiles.list", json!({})).expect("profiles.list must succeed");
    assert_eq!(list["items"].as_array().expect("items").len(), 0);

    // Create: uuid id + timestamps present, name echoed.
    let created = dispatch(&kernel, "profiles.create", json!({ "name": "Main" }))
        .expect("profiles.create must succeed");
    let profile = &created["profile"];
    let id = profile["id"].as_str().expect("id").to_string();
    assert_eq!(profile["name"], "Main");
    assert!(profile["createdAt"].as_str().expect("createdAt").len() >= 20);
    assert_eq!(profile["updatedAt"], profile["createdAt"]);

    // Second profile; list is ordered by name (case-insensitive).
    dispatch(&kernel, "profiles.create", json!({ "name": "archive" }))
        .expect("profiles.create must succeed");
    let list = dispatch(&kernel, "profiles.list", json!({})).expect("profiles.list must succeed");
    let items = list["items"].as_array().expect("items");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["name"], "archive");
    assert_eq!(items[1]["name"], "Main");

    // Rename updates name + updated_at.
    let renamed = dispatch(
        &kernel,
        "profiles.rename",
        json!({ "id": id, "name": "Primary" }),
    )
    .expect("profiles.rename must succeed");
    assert_eq!(renamed["name"], "Primary");
    assert_eq!(renamed["id"], id);
    assert_ne!(renamed["updatedAt"], renamed["createdAt"]);

    // Delete → gone.
    dispatch(&kernel, "profiles.delete", json!({ "id": id })).expect("delete must succeed");
    let list = dispatch(&kernel, "profiles.list", json!({})).expect("profiles.list must succeed");
    assert_eq!(list["items"].as_array().expect("items").len(), 1);
}

#[test]
fn profiles_unknown_ids_are_not_found() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let err = dispatch(
        &kernel,
        "profiles.rename",
        json!({ "id": "00000000-0000-4000-8000-000000000000", "name": "x" }),
    )
    .expect_err("rename of unknown profile must fail");
    let product = err.product.expect("product dto");
    assert_eq!(product.code, "PROFILE_NOT_FOUND");
    assert_eq!(
        product.params.get("profileId").and_then(|v| v.as_str()),
        Some("00000000-0000-4000-8000-000000000000")
    );

    let err = dispatch(
        &kernel,
        "profiles.delete",
        json!({ "id": "00000000-0000-4000-8000-000000000000" }),
    )
    .expect_err("delete of unknown profile must fail");
    assert_eq!(err.product.expect("product dto").code, "PROFILE_NOT_FOUND");
}

#[test]
fn profiles_wire_validation_rejects_bad_input() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Empty name → ContractViolation.
    let err = dispatch(&kernel, "profiles.create", json!({ "name": "" }))
        .expect_err("empty name must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);

    // Non-uuid id → ContractViolation.
    let err = dispatch(
        &kernel,
        "profiles.rename",
        json!({ "id": "nope", "name": "x" }),
    )
    .expect_err("non-uuid id must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);

    // Unknown extra field → ContractViolation (additionalProperties: false).
    let err = dispatch(
        &kernel,
        "profiles.create",
        json!({ "name": "x", "surprise": true }),
    )
    .expect_err("extra field must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);
}
