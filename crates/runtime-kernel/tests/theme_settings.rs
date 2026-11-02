//! М7 Этап-4 cluster 14: theme-owned settings over Product Wire (ТЗ §6.5).
//!
//! Persisted values live in the shared non-secret `settings` table under the
//! legacy `theme.settings.<id>` key (no schema change). Reads return the
//! manifest-merged view (every declared setting id → stored value or the
//! manifest default); updates are validated PARTIAL merges — one unknown key
//! or one type-violating value (THEME-45: a color must not smuggle CSS
//! constructs) refuses the whole update before any write, and the merged
//! view never surfaces undeclared stored keys.

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

/// A manifest with the four declared setting kinds the legacy validator
/// knows: color, boolean, select, number.
fn settings_manifest(id: &str) -> Value {
    json!({
        "id": id,
        "settings": {
            "accent": { "type": "color", "default": "#7c4dff" },
            "compact": { "type": "boolean", "default": false },
            "density": {
                "type": "select",
                "default": "comfortable",
                "options": ["comfortable", "cozy"]
            },
            "blur": { "type": "number", "default": 12 }
        }
    })
}

fn install_theme_with_manifest(kernel: &Kernel, id: &str, manifest: Value) -> Value {
    let css = publish_css(kernel);
    dispatch(
        kernel,
        "themes.install",
        json!({
            "id": id,
            "name": id,
            "version": "1.0.0",
            "trustState": "built-in",
            "cssAssetId": css,
            "manifest": manifest,
        }),
    )
    .expect("themes.install must succeed")
}

#[test]
fn theme_settings_default_merge_and_partial_update_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    install_theme_with_manifest(&kernel, "wii-u-dark", settings_manifest("wii-u-dark"));

    // Fresh read: every declared setting resolves to its manifest default.
    let view = dispatch(
        &kernel,
        "themes.settings.get",
        json!({ "id": "wii-u-dark" }),
    )
    .expect("themes.settings.get must succeed");
    assert_eq!(
        view["values"],
        json!({
            "accent": "#7c4dff",
            "compact": false,
            "density": "comfortable",
            "blur": 12
        })
    );

    // A partial update changes ONLY the supplied key and answers with the
    // merged view.
    let updated = dispatch(
        &kernel,
        "themes.settings.update",
        json!({ "id": "wii-u-dark", "values": { "accent": "#00c853" } }),
    )
    .expect("themes.settings.update must succeed");
    assert_eq!(
        updated["values"],
        json!({
            "accent": "#00c853",
            "compact": false,
            "density": "comfortable",
            "blur": 12
        })
    );

    // The merge persists across reads and later partial updates.
    let reread = dispatch(
        &kernel,
        "themes.settings.get",
        json!({ "id": "wii-u-dark" }),
    )
    .expect("themes.settings.get must succeed");
    assert_eq!(reread["values"]["accent"], "#00c853");

    let second = dispatch(
        &kernel,
        "themes.settings.update",
        json!({ "id": "wii-u-dark", "values": { "density": "cozy", "blur": 0.5 } }),
    )
    .expect("second update must succeed");
    assert_eq!(
        second["values"],
        json!({
            "accent": "#00c853",
            "compact": false,
            "density": "cozy",
            "blur": 0.5
        })
    );

    // Re-applying the same patch is an idempotent no-op.
    let again = dispatch(
        &kernel,
        "themes.settings.update",
        json!({ "id": "wii-u-dark", "values": { "density": "cozy", "blur": 0.5 } }),
    )
    .expect("themes.settings.update must be idempotent");
    assert_eq!(again["values"], second["values"]);
}

#[test]
fn theme_settings_update_refuses_unknown_and_type_violating_values() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    install_theme_with_manifest(&kernel, "wii-u-dark", settings_manifest("wii-u-dark"));

    // Unknown setting id → VALIDATION with the legacy `path` param.
    let err = dispatch(
        &kernel,
        "themes.settings.update",
        json!({ "id": "wii-u-dark", "values": { "nope": 1 } }),
    )
    .expect_err("unknown setting must fail");
    let product = err.product.expect("product dto");
    assert_eq!(product.code, "VALIDATION");
    assert_eq!(
        product.params.get("path").and_then(|v| v.as_str()),
        Some("nope")
    );

    // A color that smuggles CSS constructs is refused (THEME-45).
    for smuggled in [
        "red url(https://evil)",
        "red  url ( https://evil )",
        "#fff; background:red",
        "#fff{--x:1}",
        "javascript:alert(1)",
    ] {
        let err = dispatch(
            &kernel,
            "themes.settings.update",
            json!({ "id": "wii-u-dark", "values": { "accent": smuggled } }),
        )
        .expect_err("CSS-smuggling color must fail");
        assert_eq!(err.product.expect("product dto").code, "VALIDATION");
    }

    // A select must be one of the declared options; wrong types fail too.
    for bad in [
        json!({ "density": "spooky" }),
        json!({ "compact": "yes" }),
        json!({ "blur": "12" }),
    ] {
        let err = dispatch(
            &kernel,
            "themes.settings.update",
            json!({ "id": "wii-u-dark", "values": bad }),
        )
        .expect_err("type-violating value must fail");
        assert_eq!(err.product.expect("product dto").code, "VALIDATION");
    }

    // A refused patch must not have touched the store: the merged view
    // still shows the pristine defaults.
    let view = dispatch(
        &kernel,
        "themes.settings.get",
        json!({ "id": "wii-u-dark" }),
    )
    .expect("read after refusals must succeed");
    assert_eq!(view["values"]["accent"], "#7c4dff");
    assert_eq!(view["values"]["density"], "comfortable");

    // The store keeps answering updates after refusals.
    dispatch(
        &kernel,
        "themes.settings.update",
        json!({ "id": "wii-u-dark", "values": { "compact": true } }),
    )
    .expect("valid update after refusals must succeed");
}

#[test]
fn theme_settings_unknown_theme_is_not_found() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let err = dispatch(&kernel, "themes.settings.get", json!({ "id": "missing" }))
        .expect_err("unknown theme read must fail");
    assert_eq!(err.product.expect("product dto").code, "THEME_NOT_FOUND");

    let err = dispatch(
        &kernel,
        "themes.settings.update",
        json!({ "id": "missing", "values": { "accent": "#fff" } }),
    )
    .expect_err("unknown theme update must fail");
    assert_eq!(err.product.expect("product dto").code, "THEME_NOT_FOUND");
}

#[test]
fn theme_without_settings_section_has_empty_view_and_refuses_updates() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    install_theme_with_manifest(&kernel, "plain", json!({ "id": "plain" }));

    let view = dispatch(&kernel, "themes.settings.get", json!({ "id": "plain" }))
        .expect("themes.settings.get must succeed");
    assert_eq!(view["values"], json!({}));

    let err = dispatch(
        &kernel,
        "themes.settings.update",
        json!({ "id": "plain", "values": { "accent": "#fff" } }),
    )
    .expect_err("undeclared setting must fail");
    assert_eq!(err.product.expect("product dto").code, "VALIDATION");
}
