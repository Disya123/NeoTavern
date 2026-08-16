//! Bundled Hazel / Vesper starter pack (writer-thread seed).
//!
//! Product hosts set `NEOTA_SEED_STARTER=1` before `Kernel::open`. Other
//! kernel tests leave the env unset so they keep an empty library.

use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, SEED_STARTER_ENV};
use serde_json::{json, Value};
use std::path::Path;

fn open_kernel(root: &Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open")
}

fn dispatch(kernel: &Kernel, op: &str, request: Value) -> Value {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization");
    let response = kernel
        .dispatch(op, &bytes, &flag)
        .unwrap_or_else(|err| panic!("{op} failed: {err}"));
    serde_json::from_slice(&response).expect("response JSON")
}

fn list_characters(kernel: &Kernel) -> Vec<Value> {
    dispatch(kernel, "characters.list", json!({}))["items"]
        .as_array()
        .expect("items")
        .clone()
}

fn list_lorebooks(kernel: &Kernel) -> Vec<Value> {
    dispatch(kernel, "lorebooks.list", json!({}))["items"]
        .as_array()
        .expect("items")
        .clone()
}

#[test]
fn seeds_hazel_once_and_does_not_restore_after_delete() {
    let empty_root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(empty_root.path());
    assert!(
        list_characters(&kernel).is_empty(),
        "seeding must not run without {SEED_STARTER_ENV}"
    );
    drop(kernel);

    std::env::set_var(SEED_STARTER_ENV, "1");

    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let characters = list_characters(&kernel);
    assert_eq!(characters.len(), 1, "first open must seed Hazel");
    assert_eq!(characters[0]["name"], "Hazel");
    assert!(
        characters[0]["avatarAssetId"].as_str().is_some(),
        "starter avatar must be linked"
    );
    let character_id = characters[0]["id"].as_str().expect("id").to_string();

    let books = list_lorebooks(&kernel);
    assert_eq!(books.len(), 1, "first open must seed Vesper");
    assert_eq!(books[0]["name"], "Vesper");
    assert_eq!(books[0]["characterId"], character_id);
    assert_eq!(books[0]["entryCount"], 4);
    drop(kernel);

    let kernel = open_kernel(root.path());
    assert_eq!(
        list_characters(&kernel).len(),
        1,
        "second open must not duplicate Hazel"
    );
    dispatch(
        &kernel,
        "characters.delete",
        json!({ "characterId": character_id }),
    );
    drop(kernel);

    let kernel = open_kernel(root.path());
    assert!(
        list_characters(&kernel).is_empty(),
        "complete marker must prevent restoring a deleted starter character"
    );
}
