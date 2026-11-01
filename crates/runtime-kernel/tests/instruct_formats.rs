//! Kernel `settings.instructformats.list` tests (M7 Etap-4 slice, cluster
//! 27): the static built-in catalog is wire-valid, complete (the five
//! AGENTS.md §9 formats) and served identically on stateful and stateless
//! kernels — pure metadata, no database.

use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
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

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Value {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    let response = kernel
        .dispatch(op, &bytes, &flag)
        .expect("instruct-formats list must succeed");
    serde_json::from_slice(&response).expect("response must be valid JSON")
}

fn assert_catalog(value: &Value) {
    contracts_generated::generated::validate_result_instruct_formats(value)
        .expect("catalog is wire-valid");
    let items = value["formats"].as_array().expect("formats array");
    assert_eq!(items.len(), 5, "the five AGENTS.md §9 formats");
    let ids: Vec<&str> = items
        .iter()
        .map(|f| f["id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids, ["chatml", "llama3", "alpaca", "mistral", "command-r"]);
    for item in items {
        assert_eq!(item["version"], json!(1), "every built-in is version 1");
        let stops = item["stopStrings"].as_array().expect("stopStrings");
        assert!(!stops.is_empty(), "every format declares a stop string");
    }
    // Stop strings are exact — the generation path stops streams on them.
    assert_eq!(items[0]["stopStrings"], json!(["<|im_end|>"]));
    assert_eq!(items[1]["stopStrings"], json!(["<|eot_id|>"]));
    assert_eq!(items[4]["stopStrings"], json!(["<|END_OF_TURN_TOKEN|>"]));
}

#[test]
fn instruct_formats_catalog_on_seeded_kernel() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let value = dispatch_json(&kernel, "settings.instructformats.list", json!({}));
    assert_catalog(&value);
}

#[test]
fn instruct_formats_catalog_on_stateless_kernel() {
    let kernel = open_stateless_kernel();
    let value = dispatch_json(&kernel, "settings.instructformats.list", json!({}));
    assert_catalog(&value);
}
