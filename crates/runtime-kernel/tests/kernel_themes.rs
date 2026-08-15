//! Этап 4 slice 6 part 2: canonical Theme-SDK registry over Product Wire
//! (ТЗ §5.2 theme-sdk, §SEC-05, AGENTS.md §19).
//!
//! A theme is DATA, never code: the opaque manifest plus a content-
//! addressed CSS asset reference (published through `assets.put` with kind
//! `theme-css`, existence validated at install). The single `active` flag
//! names the applied theme; uninstalling the active theme clears it so the
//! shell falls back to the default (a broken theme must never block the
//! interface reset). Fail-closed rules mirror plugins: a version change
//! that would LOWER the recorded SEC-05 trust rank is rejected
//! (THEME_TRUST_DOWNGRADE), same id+version re-install is idempotent,
//! install never activates, uninstall of an unknown theme is
//! THEME_NOT_FOUND.

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

/// Publishes the theme CSS through `assets.put` and returns its asset id.
fn publish_css(kernel: &Kernel) -> String {
    let response = dispatch(
        kernel,
        "assets.put",
        json!({
            "kind": "theme-css",
            "filename": "theme.css",
            "contentType": "text/css",
            "contentBase64": "Ym9keXt9",
        }),
    )
    .expect("assets.put must succeed");
    response["asset"]["id"]
        .as_str()
        .expect("asset id")
        .to_string()
}

fn install_theme(
    kernel: &Kernel,
    id: &str,
    version: &str,
    trust: &str,
    css: Option<&str>,
) -> Value {
    let mut request = json!({
        "id": id,
        "name": id,
        "version": version,
        "trustState": trust,
        "manifest": { "id": id },
    });
    if let Some(css) = css {
        request["cssAssetId"] = json!(css);
    }
    dispatch(kernel, "themes.install", request).expect("themes.install must succeed")
}

#[test]
fn themes_install_list_activate_uninstall_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let css = publish_css(&kernel);

    // Fresh install: inactive by default, trust + CSS ref recorded.
    let installed = install_theme(
        &kernel,
        "wii-u-dark",
        "2.0.1",
        "verified-publisher",
        Some(&css),
    );
    let theme = &installed["theme"];
    assert_eq!(theme["id"], "wii-u-dark");
    assert_eq!(theme["version"], "2.0.1");
    assert_eq!(theme["active"], false);
    assert_eq!(theme["trustState"], "verified-publisher");
    assert_eq!(theme["cssAssetId"], css);

    // A second theme; list shows both, none active.
    install_theme(
        &kernel,
        "flat-light",
        "1.0.0",
        "locally-trusted",
        Some(&css),
    );
    let list = dispatch(&kernel, "themes.list", json!({})).expect("themes.list must succeed");
    let items = list["items"].as_array().expect("items");
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|t| t["active"] == false));

    // Activate → single active flag flips, others cleared; idempotent.
    let activated = dispatch(&kernel, "themes.activate", json!({ "id": "wii-u-dark" }))
        .expect("themes.activate must succeed");
    assert_eq!(activated["active"], true);
    let again = dispatch(&kernel, "themes.activate", json!({ "id": "wii-u-dark" }))
        .expect("themes.activate must be idempotent");
    assert_eq!(again["active"], true);
    let list = dispatch(&kernel, "themes.list", json!({})).expect("themes.list must succeed");
    let active: Vec<&Value> = list["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter(|t| t["active"] == true)
        .collect();
    assert_eq!(active.len(), 1, "exactly one active theme");
    assert_eq!(active[0]["id"], "wii-u-dark");

    // Switch active theme → flag moves.
    dispatch(&kernel, "themes.activate", json!({ "id": "flat-light" }))
        .expect("switch must succeed");
    let list = dispatch(&kernel, "themes.list", json!({})).expect("themes.list must succeed");
    let wii = list["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|t| t["id"] == "wii-u-dark")
        .expect("wii-u-dark");
    let flat = list["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|t| t["id"] == "flat-light")
        .expect("flat-light");
    assert_eq!(wii["active"], false);
    assert_eq!(flat["active"], true);

    // Uninstall the ACTIVE theme → active flag cleared (default fallback).
    dispatch(&kernel, "themes.uninstall", json!({ "id": "flat-light" }))
        .expect("themes.uninstall must succeed");
    let list = dispatch(&kernel, "themes.list", json!({})).expect("themes.list must succeed");
    let items = list["items"].as_array().expect("items");
    assert_eq!(items.len(), 1);
    assert!(items.iter().all(|t| t["active"] == false));
}

#[test]
fn themes_uninstall_unknown_is_not_found() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let err = dispatch(&kernel, "themes.uninstall", json!({ "id": "missing" }))
        .expect_err("unknown theme must fail");
    let product = err.product.expect("product dto");
    assert_eq!(product.code, "THEME_NOT_FOUND");
    assert_eq!(
        product.params.get("themeId").and_then(|v| v.as_str()),
        Some("missing")
    );

    let err = dispatch(&kernel, "themes.activate", json!({ "id": "missing" }))
        .expect_err("unknown theme must fail");
    assert_eq!(err.product.expect("product dto").code, "THEME_NOT_FOUND");
}

#[test]
fn themes_install_never_downgrades_trust() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let css = publish_css(&kernel);

    install_theme(
        &kernel,
        "proven-theme",
        "1.0.0",
        "verified-publisher",
        Some(&css),
    );

    let err = dispatch(
        &kernel,
        "themes.install",
        json!({
            "id": "proven-theme",
            "name": "proven-theme",
            "version": "2.0.0",
            "trustState": "unsigned-untrusted",
            "cssAssetId": css,
        }),
    )
    .expect_err("trust downgrade must be rejected");
    assert_eq!(
        err.product.expect("product dto").code,
        "THEME_TRUST_DOWNGRADE"
    );

    let list = dispatch(&kernel, "themes.list", json!({})).expect("list");
    assert_eq!(list["items"][0]["version"], "1.0.0");
    assert_eq!(list["items"][0]["trustState"], "verified-publisher");

    let upgraded = dispatch(
        &kernel,
        "themes.install",
        json!({
            "id": "proven-theme",
            "name": "proven-theme",
            "version": "2.0.0",
            "trustState": "verified-publisher",
            "cssAssetId": css,
        }),
    )
    .expect("same-rank update must succeed");
    assert_eq!(upgraded["theme"]["version"], "2.0.0");
}

#[test]
fn themes_install_is_idempotent_for_same_version() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let css = publish_css(&kernel);

    install_theme(
        &kernel,
        "silly-skin",
        "0.3.0",
        "unsigned-untrusted",
        Some(&css),
    );
    install_theme(&kernel, "silly-skin", "0.3.0", "unsigned-untrusted", None);

    let list = dispatch(&kernel, "themes.list", json!({})).expect("list");
    assert_eq!(
        list["items"].as_array().expect("items").len(),
        1,
        "no duplicate rows"
    );
    // The second request carried no CSS ref; the update path applied it.
    assert_eq!(list["items"][0]["cssAssetId"], Value::Null);
}

#[test]
fn themes_install_validates_css_asset() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Unknown cssAssetId → ASSET_NOT_FOUND (same stable code as avatars).
    let err = dispatch(
        &kernel,
        "themes.install",
        json!({
            "id": "xi",
            "name": "x",
            "version": "1.0.0",
            "trustState": "built-in",
            "cssAssetId": "00000000-0000-4000-8000-000000000000",
        }),
    )
    .expect_err("unknown css asset must fail");
    assert_eq!(err.product.expect("product dto").code, "ASSET_NOT_FOUND");

    // Bad trust state / non-uuid cssAssetId → ContractViolation.
    let err = dispatch(
        &kernel,
        "themes.install",
        json!({
            "id": "xi",
            "name": "x",
            "version": "1.0.0",
            "trustState": "super-trusted",
        }),
    )
    .expect_err("bad trust state must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);

    let err = dispatch(
        &kernel,
        "themes.install",
        json!({
            "id": "xi",
            "name": "x",
            "version": "1.0.0",
            "trustState": "built-in",
            "cssAssetId": "not-a-uuid",
        }),
    )
    .expect_err("non-uuid css asset must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);
}
