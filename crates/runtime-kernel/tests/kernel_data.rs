//! M5 slice 38 kernel tests: `data.activation.status` over the dispatch
//! surface — the honest layout/journal report (ТЗ §10.2–§10.3): v1 flat
//! layout with an empty journal, a pending activation surfaced from the
//! durable journal, v2 layout detection, and stateless-kernel rejection.

use contracts_generated::generated::ResultDataActivationStatus;
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};
use serde_json::{json, Value};

fn open_kernel_with_root(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn open_stateless_kernel() -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: None,
    })
    .expect("stateless kernel must open")
}

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

#[test]
fn activation_status_reports_v1_flat_layout_with_empty_journal() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let value = dispatch_json(&kernel, "data.activation.status", json!({}))
        .expect("data.activation.status must succeed");
    let dto: ResultDataActivationStatus =
        serde_json::from_value(value).expect("response must be a ResultDataActivationStatus");

    // A fresh flat data root: no `roots/` directory, no root id, no journal.
    assert_eq!(dto.layout_version, 1);
    assert!(dto.active_root_id.is_none());
    assert_eq!(dto.active_root, root.path().display().to_string());
    assert_eq!(dto.journal_format, "neotavern-activation-journal");
    assert_eq!(dto.journal_format_version, 2);
    assert!(dto.entries.is_empty());
    assert!(dto.pending.is_none());
}

#[test]
fn activation_status_surfaces_a_pending_journal_entry() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    // Simulate an interrupted activation by writing a durable journal entry
    // at `activation_pending` (the recovery source of truth, ТЗ §10.3).
    let entry = neotavern_storage::activation::JournalEntry {
        id: "entry-1".to_string(),
        kind: "restore".to_string(),
        status: neotavern_storage::activation::ActivationStatus::ActivationPending,
        from_root: root.path().to_path_buf(),
        to_root: root.path().join("roots/root-next"),
        created_at: "2026-08-13T10:00:00Z".to_string(),
        updated_at: "2026-08-13T10:00:00Z".to_string(),
        error: None,
    };
    neotavern_storage::activation::write_entry(root.path(), entry)
        .expect("journal entry must be written");

    let value = dispatch_json(&kernel, "data.activation.status", json!({}))
        .expect("data.activation.status must succeed");
    let dto: ResultDataActivationStatus =
        serde_json::from_value(value).expect("response must be a ResultDataActivationStatus");

    assert_eq!(dto.entries.len(), 1);
    assert_eq!(dto.entries[0].kind, "restore");
    assert_eq!(dto.entries[0].status, "activation_pending");
    let pending = dto.pending.expect("pending must be reported");
    assert_eq!(pending.kind, "restore");
    assert_eq!(pending.entry_id, "entry-1");
    assert_eq!(pending.created_at, "2026-08-13T10:00:00Z");
}

#[test]
fn activation_status_detects_v2_layout() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    // A `roots/` directory marks the versioned v2 layout (ADR-0041). With no
    // pointer the active root is still the data root itself.
    std::fs::create_dir(root.path().join("roots")).expect("create roots dir");

    let value = dispatch_json(&kernel, "data.activation.status", json!({}))
        .expect("data.activation.status must succeed");
    let dto: ResultDataActivationStatus =
        serde_json::from_value(value).expect("response must be a ResultDataActivationStatus");

    assert_eq!(dto.layout_version, 2);
}

#[test]
fn activation_status_requires_durable_storage() {
    let kernel = open_stateless_kernel();
    let err = dispatch_json(&kernel, "data.activation.status", json!({}))
        .expect_err("stateless kernel must reject the operation");
    assert_eq!(err.code, KernelErrorCode::StorageFailure);
}
