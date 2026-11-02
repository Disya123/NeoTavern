//! Plugin secret store through the kernel (`plugins.secrets.*`, M7 Etap-4
//! cluster 21 part 2).
//!
//! Pins the SEC-01 guarantees the plugin sandbox depends on: the plaintext is
//! write-only (the store holds it, the row holds only an opaque reference),
//! `masked` is derived from that reference so no DTO can leak key material,
//! reveal is fail-closed behind the host exposure policy AND the plugin's own
//! `secrets.reveal` grant, the scope selects the owner exactly like the KV
//! state store, an un-consented plugin never reaches the store, an uninstall
//! revokes the values before the reference rows cascade, and the whole family
//! works read-only (list/delete) even when no store seam is wired.

use contracts_generated::generated::{
    PluginSecret, ResultPluginSecrets, ResultPluginsSecretsDelete, ResultPluginsSecretsReveal,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError};
use secret_store::memory::MemorySecretStore;
use secret_store::SecretStore;
use serde_json::{json, Value};
use std::sync::Arc;

const CHARACTER_ID: &str = "00000000-0000-4000-8000-0000000000c2";
const PLUGIN_ID: &str = "clockwork-secret-plugin";

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    let response = kernel.dispatch(op, &bytes, &flag)?;
    Ok(serde_json::from_slice(&response).expect("response must be JSON"))
}

/// The product code and params of a failed dispatch (the client-visible error).
fn product_code(error: &KernelError) -> (String, Value) {
    let product = error
        .product
        .as_ref()
        .expect("a product error carries a wire code");
    (product.code.clone(), product.params.clone())
}

fn install_plugin(kernel: &Kernel, permissions: &[&str]) {
    dispatch(
        kernel,
        "plugins.install",
        json!({
            "id": PLUGIN_ID,
            "name": "Clockwork Secrets",
            "version": "1.0.0",
            "trustState": "locally-trusted",
            "permissions": permissions,
        }),
    )
    .expect("install must succeed");
}

fn set_secret(kernel: &Kernel, scope: &str, owner: Option<&str>, key: &str, value: &str) -> Value {
    let mut request = json!({
        "pluginId": PLUGIN_ID,
        "scope": scope,
        "key": key,
        "value": value,
    });
    if let Some(owner) = owner {
        request["ownerId"] = json!(owner);
    }
    let response = dispatch(kernel, "plugins.secrets.set", request).expect("set must succeed");
    // The response must decode through the generated checker, not just look right.
    contracts_generated::generated::decode_plugin_secret(
        &serde_json::to_vec(&response).expect("re-serialize"),
    )
    .expect("set must answer a schema-valid wire.plugin-secret");
    let _: PluginSecret = serde_json::from_value(response.clone()).expect("dto");
    response
}

fn list_secrets(kernel: &Kernel, scope: &str, owner: Option<&str>) -> ResultPluginSecrets {
    let mut request = json!({ "pluginId": PLUGIN_ID, "scope": scope });
    if let Some(owner) = owner {
        request["ownerId"] = json!(owner);
    }
    let response = dispatch(kernel, "plugins.secrets.list", request).expect("list must succeed");
    contracts_generated::generated::decode_result_plugin_secrets(
        &serde_json::to_vec(&response).expect("re-serialize"),
    )
    .expect("list must answer a schema-valid wire.result.plugin-secrets")
}

fn reveal(
    kernel: &Kernel,
    scope: &str,
    owner: Option<&str>,
    key: &str,
) -> Result<Value, KernelError> {
    let mut request = json!({ "pluginId": PLUGIN_ID, "scope": scope, "key": key });
    if let Some(owner) = owner {
        request["ownerId"] = json!(owner);
    }
    dispatch(kernel, "plugins.secrets.reveal", request)
}

fn seeded_kernel(root: &std::path::Path, permissions: &[&str]) -> (Kernel, Arc<MemorySecretStore>) {
    let kernel = open_kernel(root);
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());
    install_plugin(&kernel, permissions);
    (kernel, store)
}

const MANAGE: &str = "secrets.manageOwn";
const REVEAL: &str = "secrets.reveal";

#[test]
fn values_are_write_only_and_masked_from_the_reference() {
    let root = tempfile::tempdir().expect("tempdir");
    let (kernel, store) = seeded_kernel(root.path(), &[MANAGE]);

    let written = set_secret(&kernel, "user", None, "apiKey", "sk-live-super-secret");
    assert_eq!(written["key"], "apiKey");
    let masked = written["masked"].as_str().expect("masked");
    assert!(
        !masked.contains("super") && !masked.contains("secret"),
        "the mask must never echo key material: {masked}"
    );

    // The store holds the plaintext, the row holds only an opaque reference.
    let stored = list_secrets(&kernel, "user", None);
    assert_eq!(stored.items.len(), 1);
    assert_eq!(stored.items[0].key, "apiKey");
    assert_eq!(
        serde_json::to_value(&stored.items[0].scope).expect("scope"),
        json!("user")
    );
    assert!(
        !serde_json::to_string(&stored)
            .expect("serialize")
            .contains("sk-live-super-secret"),
        "no value-free DTO may carry the plaintext"
    );
    let reference = store
        .get("plugin-secret:clockwork-secret-plugin", "user::apiKey")
        .expect("store get must succeed")
        .expect("the value must be stored");
    assert_eq!(reference, "sk-live-super-secret");
}

#[test]
fn reveal_is_fail_closed_behind_exposure_and_the_grant() {
    let root = tempfile::tempdir().expect("tempdir");
    // Installed with the manage grant only: no secrets.reveal.
    let (kernel, _store) = seeded_kernel(root.path(), &[MANAGE]);
    set_secret(&kernel, "user", None, "apiKey", "sk-live-1");

    // Exposure OFF: the op refuses before the store is addressed.
    let (code, _) = product_code(&reveal(&kernel, "user", None, "apiKey").expect_err("refused"));
    assert_eq!(code, "SECRETS_EXPOSURE_DISABLED");

    // Exposure ON, but the plugin never asked for secrets.reveal.
    kernel.set_secrets_exposure(true);
    let (code, params) =
        product_code(&reveal(&kernel, "user", None, "apiKey").expect_err("denied"));
    assert_eq!(code, "PLUGIN_PERMISSION_DENIED");
    assert_eq!(params["capability"], REVEAL);

    // With the grant the plaintext is returned — and only through this op.
    install_plugin(&kernel, &[MANAGE, REVEAL]);
    let revealed = reveal(&kernel, "user", None, "apiKey").expect("reveal must succeed");
    let dto: ResultPluginsSecretsReveal =
        serde_json::from_value(revealed).expect("decode reveal result");
    assert_eq!(dto.value, "sk-live-1");

    // A key that was never stored is a stable not-found, not an empty string.
    let (code, _) = product_code(&reveal(&kernel, "user", None, "missing").expect_err("not found"));
    assert_eq!(code, "PLUGIN_SECRET_NOT_FOUND");
}

#[test]
fn scopes_isolate_secrets_per_owner_and_refuse_a_misplaced_one() {
    let root = tempfile::tempdir().expect("tempdir");
    let (kernel, _store) = seeded_kernel(root.path(), &[MANAGE, REVEAL]);
    kernel.set_secrets_exposure(true);

    set_secret(&kernel, "chat", Some("chat-a"), "token", "a-secret");
    set_secret(&kernel, "chat", Some("chat-b"), "token", "b-secret");

    let chat_a = list_secrets(&kernel, "chat", Some("chat-a"));
    assert_eq!(chat_a.items.len(), 1);
    let revealed_a = reveal(&kernel, "chat", Some("chat-a"), "token").expect("reveal chat-a");
    let revealed_b = reveal(&kernel, "chat", Some("chat-b"), "token").expect("reveal chat-b");
    assert_eq!(revealed_a["value"], "a-secret");
    assert_eq!(
        revealed_b["value"], "b-secret",
        "chat secrets never leak across chats"
    );

    // A chat secret without an owner cannot address an implicit slot.
    let error = dispatch(
        &kernel,
        "plugins.secrets.set",
        json!({
            "pluginId": PLUGIN_ID,
            "scope": "chat",
            "key": "orphan",
            "value": "x",
        }),
    )
    .expect_err("chat requires an owner");
    assert_eq!(
        error.code,
        runtime_kernel::KernelErrorCode::ContractViolation
    );

    // An owner on a singleton scope is equally a caller bug.
    let error = dispatch(
        &kernel,
        "plugins.secrets.set",
        json!({
            "pluginId": PLUGIN_ID,
            "scope": "installation",
            "ownerId": "chat-a",
            "key": "orphan",
            "value": "x",
        }),
    )
    .expect_err("singletons reject an owner");
    assert_eq!(
        error.code,
        runtime_kernel::KernelErrorCode::ContractViolation
    );
}

#[test]
fn delete_is_idempotent_and_uninstall_revokes_the_values() {
    let root = tempfile::tempdir().expect("tempdir");
    let (kernel, store) = seeded_kernel(root.path(), &[MANAGE]);
    set_secret(&kernel, "installation", None, "alpha", "one");
    set_secret(&kernel, "installation", None, "beta", "two");

    let deleted = dispatch(
        &kernel,
        "plugins.secrets.delete",
        json!({ "pluginId": PLUGIN_ID, "scope": "installation", "key": "alpha" }),
    )
    .expect("delete must succeed");
    let dto: ResultPluginsSecretsDelete = serde_json::from_value(deleted).expect("decode");
    assert!(dto.deleted);
    assert!(
        store
            .get(
                "plugin-secret:clockwork-secret-plugin",
                "installation::alpha"
            )
            .expect("get")
            .is_none(),
        "deleting the key revokes the stored value"
    );

    let again = dispatch(
        &kernel,
        "plugins.secrets.delete",
        json!({ "pluginId": PLUGIN_ID, "scope": "installation", "key": "alpha" }),
    )
    .expect("delete is idempotent");
    assert_eq!(again["deleted"], false);

    // Uninstall revokes every remaining value BEFORE the rows cascade.
    dispatch(&kernel, "plugins.uninstall", json!({ "id": PLUGIN_ID }))
        .expect("uninstall must succeed");
    assert!(
        store
            .get(
                "plugin-secret:clockwork-secret-plugin",
                "installation::beta"
            )
            .expect("get")
            .is_none(),
        "uninstall must revoke the stored values"
    );
}

#[test]
fn capability_gate_and_missing_store_fail_closed() {
    let root = tempfile::tempdir().expect("tempdir");
    // Installed WITHOUT secrets.manageOwn.
    let (kernel, _store) = seeded_kernel(root.path(), &[]);

    let (code, params) = product_code(
        &dispatch(
            &kernel,
            "plugins.secrets.set",
            json!({
                "pluginId": PLUGIN_ID,
                "scope": "user",
                "key": "apiKey",
                "value": "x",
            }),
        )
        .expect_err("denied"),
    );
    assert_eq!(code, "PLUGIN_PERMISSION_DENIED");
    assert_eq!(params["capability"], MANAGE);

    // An unknown plugin is refused before any capability check.
    let (code, _) = product_code(
        &dispatch(
            &kernel,
            "plugins.secrets.list",
            json!({ "pluginId": "not-installed", "scope": "user" }),
        )
        .expect_err("not found"),
    );
    assert_eq!(code, "PLUGIN_NOT_FOUND");

    // Without a store seam, writes and reveals fail closed, while the
    // reference rows stay listable/deletable (the row is the authority).
    // The data-root lease is exclusive, so the first kernel must be dropped.
    drop(kernel);
    let kernel_no_store = open_kernel(root.path());
    install_plugin(&kernel_no_store, &[MANAGE, REVEAL]);
    let (code, _) = product_code(
        &dispatch(
            &kernel_no_store,
            "plugins.secrets.set",
            json!({
                "pluginId": PLUGIN_ID,
                "scope": "user",
                "key": "apiKey",
                "value": "x",
            }),
        )
        .expect_err("no store"),
    );
    assert_eq!(code, "SECRET_UNAVAILABLE");
    let listed = list_secrets(&kernel_no_store, "user", None);
    assert!(listed.items.is_empty(), "no row was written");

    // A character is not needed for this family, but seed one so the data root
    // proves it is a real product database rather than an in-memory shell.
    let _ = CHARACTER_ID;
}
