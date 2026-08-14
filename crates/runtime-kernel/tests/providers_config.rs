//! Provider-config CRUD with secrets out of the database (ТЗ §9.4, §SEC-01,
//! Этап 2.4).
//!
//! Verifies the fail-closed secret boundary over the dispatch surface:
//! `providers.config.set` stores an API key through the SecretStore seam and
//! the row keeps only the opaque reference; the wire DTO reports `hasApiKey`
//! and never the value; a missing seam yields `SECRET_UNAVAILABLE`; delete
//! revokes the stored secret.

use contracts_generated::generated::{ProviderConfigDto, ResultEmpty, ResultListProviderConfigs};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};
use secret_store::memory::MemorySecretStore;
use secret_store::SecretStore;
use serde_json::{json, Value};
use std::sync::Arc;

fn open_kernel_with_root(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

fn dispatch_decoded<T: serde::de::DeserializeOwned>(
    kernel: &Kernel,
    op: &str,
    request: Value,
) -> Result<T, KernelError> {
    dispatch_json(kernel, op, request).map(|value| {
        serde_json::from_value(value).expect("response must decode as the expected DTO")
    })
}

#[test]
fn config_round_trip_without_secrets() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let set = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "local", "config": { "temperature": 0.7 } }),
    )
    .expect("set without a secret must succeed");
    assert_eq!(set.provider, "fake");
    assert_eq!(set.name, "local");
    assert_eq!(set.config["temperature"], json!(0.7));
    assert!(!set.has_api_key, "no secret was provided");

    // get returns the same config, still without a key
    let got = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.get",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect("get must succeed");
    assert_eq!(got.config, set.config);
    assert!(!got.has_api_key, "no secret was provided");
    assert_eq!(got.created_at, set.created_at);

    // list: one row
    let listed =
        dispatch_decoded::<ResultListProviderConfigs>(&kernel, "providers.config.list", json!({}))
            .expect("list must succeed");
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].id, set.id);

    // list filtered by provider
    let filtered = dispatch_decoded::<ResultListProviderConfigs>(
        &kernel,
        "providers.config.list",
        json!({ "provider": "fake" }),
    )
    .expect("filtered list must succeed");
    assert_eq!(filtered.items.len(), 1);
    let filtered_other = dispatch_decoded::<ResultListProviderConfigs>(
        &kernel,
        "providers.config.list",
        json!({ "provider": "openai" }),
    )
    .expect("filtered list for another provider must be empty");
    assert!(filtered_other.items.is_empty());

    // update config without touching a (nonexistent) key
    let updated = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "local", "config": { "temperature": 0.2 } }),
    )
    .expect("second set must succeed");
    assert_eq!(updated.config["temperature"], json!(0.2));
    assert!(!updated.has_api_key);
    assert_eq!(
        updated.created_at, set.created_at,
        "createdAt must not change"
    );

    // delete
    let deleted = dispatch_decoded::<ResultEmpty>(
        &kernel,
        "providers.config.delete",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect("delete must succeed");
    assert_eq!(deleted, ResultEmpty {});

    let err = dispatch_json(
        &kernel,
        "providers.config.get",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect_err("get after delete must fail");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    let product = err.product.expect("product error must carry the wire dto");
    assert_eq!(product.code, "PROVIDER_CONFIG_NOT_FOUND");
    assert_eq!(product.params["provider"], json!("fake"));
    assert_eq!(product.params["name"], json!("local"));
}

#[test]
fn api_key_never_lands_in_the_database() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());
    let api_key = "sk-super-secret-sentinel-9f3a";

    let set = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "local", "apiKey": api_key }),
    )
    .expect("set with a secret must succeed");
    assert!(
        set.has_api_key,
        "hasApiKey must be true after storing a key"
    );

    // the wire never returns the value — only the flag
    let got = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.get",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect("get must succeed");
    assert!(got.has_api_key);
    let serialized = serde_json::to_string(&got).expect("dto serializes");
    assert!(
        !serialized.contains(api_key),
        "the wire DTO must never carry the secret value"
    );

    // the secret lives in the store, not the database
    assert!(store.has("provider:fake", "local").expect("store query"));
    assert_eq!(
        store
            .get("provider:fake", "local")
            .expect("store get")
            .as_deref(),
        Some(api_key)
    );

    drop(kernel);
    let raw = std::fs::read(root.path().join("database.sqlite")).expect("database file");
    assert!(
        !raw.windows(api_key.len()).any(|w| w == api_key.as_bytes()),
        "the plaintext API key must not appear anywhere in the database file"
    );
}

#[test]
fn api_key_without_a_seam_fails_closed() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let err = dispatch_json(
        &kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "local", "apiKey": "sk-nope" }),
    )
    .expect_err("set with a secret without a store must fail");
    let product = err.product.expect("product error must carry the wire dto");
    assert_eq!(product.code, "SECRET_UNAVAILABLE");

    // nothing was written
    let listed =
        dispatch_decoded::<ResultListProviderConfigs>(&kernel, "providers.config.list", json!({}))
            .expect("list must succeed");
    assert!(listed.items.is_empty(), "failed set must not leave a row");
}

#[test]
fn api_key_update_replaces_the_stored_secret() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());

    let first = "sk-first-key";
    dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "local", "apiKey": first }),
    )
    .expect("first set");
    assert_eq!(
        store
            .get("provider:fake", "local")
            .expect("store get")
            .as_deref(),
        Some(first)
    );

    let second = "sk-second-key";
    let updated = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "local", "apiKey": second }),
    )
    .expect("second set");
    assert!(updated.has_api_key);
    assert_eq!(
        store
            .get("provider:fake", "local")
            .expect("store get")
            .as_deref(),
        Some(second),
        "the store record must be overwritten, not duplicated"
    );
}

#[test]
fn delete_revokes_the_stored_secret() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());

    dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "local", "apiKey": "sk-to-revoke" }),
    )
    .expect("set");
    assert!(store.has("provider:fake", "local").expect("store has"));

    dispatch_decoded::<ResultEmpty>(
        &kernel,
        "providers.config.delete",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect("delete must succeed");
    assert!(
        !store.has("provider:fake", "local").expect("store has"),
        "delete must revoke the stored secret"
    );
}
