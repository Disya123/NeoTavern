//! Этап 4 slice 6: canonical Extensions-context registry over Product Wire
//! (ТЗ §8.1 Extensions, §SEC-05, ARC-08).
//!
//! The kernel durably records what the host ALREADY verified (SEC-05
//! signature/digest/ZIP checks) and what the user consented to: version,
//! trust state, publisher key fingerprint and the GRANTED permission set
//! (the install/update request is the consent moment). Fail-closed rules:
//! an install that would LOWER the recorded trust rank is rejected
//! (PLUGIN_TRUST_DOWNGRADE), same id+version re-install is idempotent,
//! uninstall of an unknown plugin is PLUGIN_NOT_FOUND. Execution and
//! cleanup live in the isolated host executor, not here.

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

fn install(kernel: &Kernel, id: &str, version: &str, trust: &str, permissions: &[&str]) -> Value {
    let request = json!({
        "id": id,
        "name": id,
        "version": version,
        "trustState": trust,
        "permissions": permissions,
        "manifest": { "id": id },
    });
    dispatch(kernel, "plugins.install", request).expect("plugins.install must succeed")
}

#[test]
fn plugins_install_list_enable_disable_uninstall_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Fresh install: trust + granted permissions recorded, disabled by default.
    let installed = install(
        &kernel,
        "lorebook-searcher",
        "1.2.0",
        "verified-publisher",
        &["plugin.storage", "lorebooks.list"],
    );
    let plugin = &installed["plugin"];
    assert_eq!(plugin["id"], "lorebook-searcher");
    assert_eq!(plugin["version"], "1.2.0");
    assert_eq!(plugin["enabled"], false);
    assert_eq!(plugin["trustState"], "verified-publisher");
    assert_eq!(plugin["permissions"][0], "plugin.storage");
    assert_eq!(plugin["manifest"]["id"], "lorebook-searcher");

    // List sees it.
    let list = dispatch(&kernel, "plugins.list", json!({})).expect("plugins.list must succeed");
    assert_eq!(list["items"][0]["id"], "lorebook-searcher");

    // Enable → flag flips; disable → back off (both idempotent).
    let enabled = dispatch(
        &kernel,
        "plugins.enable",
        json!({ "id": "lorebook-searcher" }),
    )
    .expect("plugins.enable must succeed");
    assert_eq!(enabled["enabled"], true);
    let enabled_again = dispatch(
        &kernel,
        "plugins.enable",
        json!({ "id": "lorebook-searcher" }),
    )
    .expect("plugins.enable must be idempotent");
    assert_eq!(enabled_again["enabled"], true);
    let disabled = dispatch(
        &kernel,
        "plugins.disable",
        json!({ "id": "lorebook-searcher" }),
    )
    .expect("plugins.disable must succeed");
    assert_eq!(disabled["enabled"], false);

    // Uninstall → gone; second uninstall → PLUGIN_NOT_FOUND.
    dispatch(
        &kernel,
        "plugins.uninstall",
        json!({ "id": "lorebook-searcher" }),
    )
    .expect("plugins.uninstall must succeed");
    let err = dispatch(
        &kernel,
        "plugins.uninstall",
        json!({ "id": "lorebook-searcher" }),
    )
    .expect_err("double uninstall must fail");
    let product = err.product.expect("product dto");
    assert_eq!(product.code, "PLUGIN_NOT_FOUND");
    assert_eq!(
        product.params.get("pluginId").and_then(|v| v.as_str()),
        Some("lorebook-searcher")
    );
}

#[test]
fn plugins_install_is_idempotent_for_same_version() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let first = install(&kernel, "silly-dice", "0.3.0", "unsigned-untrusted", &[]);
    let second = install(
        &kernel,
        "silly-dice",
        "0.3.0",
        "unsigned-untrusted",
        &["dice.roll"],
    );

    // Same id+version: idempotent — the row is updated in place (the request
    // is the consent moment), same plugin returned.
    assert_eq!(first["plugin"]["id"], second["plugin"]["id"]);
    assert_eq!(second["plugin"]["version"], "0.3.0");
    assert_eq!(second["plugin"]["permissions"][0], "dice.roll");

    let list = dispatch(&kernel, "plugins.list", json!({})).expect("list");
    assert_eq!(
        list["items"].as_array().expect("items").len(),
        1,
        "no duplicate rows"
    );
}

#[test]
fn plugins_install_never_downgrades_trust() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    install(&kernel, "proven-plugin", "1.0.0", "verified-publisher", &[]);

    // A version change that would lower the trust rank is rejected (SEC-05:
    // an unsigned package can never silently replace a verified one).
    let err = dispatch(
        &kernel,
        "plugins.install",
        json!({
            "id": "proven-plugin",
            "name": "proven-plugin",
            "version": "2.0.0",
            "trustState": "unsigned-untrusted",
            "permissions": [],
        }),
    )
    .expect_err("trust downgrade must be rejected");
    let product = err.product.expect("product dto");
    assert_eq!(product.code, "PLUGIN_TRUST_DOWNGRADE");

    // The recorded row is untouched.
    let list = dispatch(&kernel, "plugins.list", json!({})).expect("list");
    assert_eq!(list["items"][0]["version"], "1.0.0");
    assert_eq!(list["items"][0]["trustState"], "verified-publisher");

    // Same rank upgrade is fine.
    let upgraded = dispatch(
        &kernel,
        "plugins.install",
        json!({
            "id": "proven-plugin",
            "name": "proven-plugin",
            "version": "2.0.0",
            "trustState": "verified-publisher",
            "permissions": [],
        }),
    )
    .expect("same-rank update must succeed");
    assert_eq!(upgraded["plugin"]["version"], "2.0.0");
}

#[test]
fn plugins_wire_validation_rejects_bad_input() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Unknown trust state violates the closed enum → ContractViolation.
    let err = dispatch(
        &kernel,
        "plugins.install",
        json!({
            "id": "x",
            "name": "x",
            "version": "1.0.0",
            "trustState": "super-trusted",
            "permissions": [],
        }),
    )
    .expect_err("bad trust state must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);

    // Uppercase plugin id violates the id pattern → ContractViolation.
    let err = dispatch(
        &kernel,
        "plugins.install",
        json!({
            "id": "UPPER",
            "name": "x",
            "version": "1.0.0",
            "trustState": "built-in",
            "permissions": [],
        }),
    )
    .expect_err("uppercase id must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);

    // Enable on an unknown plugin → PLUGIN_NOT_FOUND.
    let err = dispatch(&kernel, "plugins.enable", json!({ "id": "missing" }))
        .expect_err("unknown plugin must fail");
    assert_eq!(err.product.expect("product dto").code, "PLUGIN_NOT_FOUND");
}
