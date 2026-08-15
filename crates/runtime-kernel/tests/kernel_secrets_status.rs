//! Этап 4 slice 7 remainder: SEC-01.1 value-free secret-backend surface.
//!
//! `secrets.status` reports the explicit secret-store mode (portable
//! encrypted / session-only / env / unavailable), persistence, writability,
//! availability, record count and the portable `secrets.enc` format version
//! — WITHOUT ever invoking `get`. The sentinel test proves a stored value
//! never appears in the response bytes (a value can only cross the boundary
//! through `get`, which this operation never calls).

use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use secret_store::file::FileEncryptedSecretStore;
use secret_store::memory::MemorySecretStore;
use secret_store::SecretStore;
use serde_json::{json, Value};
use std::sync::Arc;

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch_json(
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
fn secrets_status_reports_unavailable_without_a_store() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let status = dispatch_json(&kernel, "secrets.status", json!({}))
        .expect("secrets.status must be stateless and succeed");
    assert_eq!(status["kind"], "unavailable");
    assert_eq!(status["persistent"], false);
    assert_eq!(status["writable"], false);
    assert_eq!(status["available"], false);
    assert_eq!(status["recordCount"], 0);
    assert!(status.get("formatVersion").is_none());
}

#[test]
fn secrets_status_reports_session_mode_and_never_leaks_values() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Wire a session-only (memory) store and store a sentinel value.
    let store: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
    store
        .put("provider:fake", "local", "sk-sentinel-c0ffee")
        .expect("put must succeed");
    kernel.set_secret_store(store);

    let status =
        dispatch_json(&kernel, "secrets.status", json!({})).expect("secrets.status must succeed");
    assert_eq!(status["kind"], "session");
    assert_eq!(status["persistent"], false);
    assert_eq!(status["writable"], true);
    assert_eq!(status["available"], true);
    assert_eq!(status["recordCount"], 1);
    assert!(status.get("formatVersion").is_none());

    // Value-free surface: the sentinel never appears in the response bytes.
    let bytes = serde_json::to_vec(&status).expect("serialize");
    let text = String::from_utf8(bytes).expect("utf8");
    assert!(
        !text.contains("sk-sentinel-c0ffee"),
        "secrets.status must never leak a value"
    );
    assert!(
        !text.contains("local"),
        "secrets.status must not leak ids either"
    );
}

#[test]
fn secrets_status_reports_portable_mode_and_format_version() {
    // A real portable encrypted store (FileEncryptedSecretStore, secrets.enc
    // format v2) wired into the kernel: status must report kind 'portable',
    // persistent, writable, available, the record count and formatVersion —
    // and never the passphrase or any value.
    let root = tempfile::tempdir().expect("tempdir");
    let secrets_path = root.path().join("secrets.enc");
    let store = FileEncryptedSecretStore::new(&secrets_path);
    store
        .create("test-master-passphrase")
        .expect("create must initialize the encrypted store");
    store
        .put("provider:fake", "local", "sk-portable-sentinel-77")
        .expect("put must write a record");
    let store: Arc<dyn SecretStore> = Arc::new(store);
    let kernel = open_kernel(root.path());
    kernel.set_secret_store(store);

    let status =
        dispatch_json(&kernel, "secrets.status", json!({})).expect("secrets.status must succeed");
    assert_eq!(status["kind"], "portable");
    assert_eq!(status["persistent"], true);
    assert_eq!(status["writable"], true);
    assert_eq!(status["available"], true);
    assert_eq!(status["recordCount"], 1);
    assert_eq!(status["formatVersion"], 2);

    let bytes = serde_json::to_vec(&status).expect("serialize");
    let text = String::from_utf8(bytes).expect("utf8");
    assert!(
        !text.contains("sk-portable-sentinel-77"),
        "secrets.status must never leak a portable value"
    );
}
