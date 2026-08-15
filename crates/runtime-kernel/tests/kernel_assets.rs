//! Этап 4 slice 5 remainder: canonical content-addressed AssetStore over
//! Product Wire (ТЗ §5.1 AssetStore port, AGENTS.md §11/§12).
//!
//! `assets.put` publishes immutable bytes under a content-derived managed key
//! (`<kind>/<sha256>[.<ext>]`) and is an idempotent re-import: identical
//! bytes under the same kind return the existing record with
//! `deduplicated: true` (no duplicate). `assets.get` returns metadata,
//! `assets.content` returns the ORIGINAL bytes (base64), `assets.delete`
//! removes the registry row (file best-effort, orphan GC covers). Character
//! avatar linkage is validated: `characters.create/update` accept
//! `avatarAssetId` only when the asset exists.

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

fn put_png(kernel: &Kernel, kind: &str, bytes: &[u8]) -> Value {
    let request = json!({
        "kind": kind,
        "filename": "a.png",
        "contentType": "image/png",
        "contentBase64": base64_encode(bytes),
    });
    dispatch(kernel, "assets.put", request).expect("assets.put must succeed")
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01";

#[test]
fn assets_put_get_content_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let put = put_png(&kernel, "avatar", PNG);
    let asset = &put["asset"];
    let id = asset["id"].as_str().expect("asset id").to_string();
    assert_eq!(asset["kind"], "avatar");
    assert_eq!(asset["sizeBytes"], PNG.len() as i64);
    let relative_key = asset["relativeKey"].as_str().expect("relative key");
    assert!(relative_key.starts_with("avatar/"), "key: {relative_key}");
    assert_eq!(
        asset["checksumSha256"],
        neotavern_storage::assets::sha256_hex(PNG)
    );
    assert_eq!(put["deduplicated"], false);

    // Metadata read by id.
    let got =
        dispatch(&kernel, "assets.get", json!({ "assetId": id })).expect("assets.get must succeed");
    assert_eq!(got["asset"]["id"], id);
    assert_eq!(got["asset"]["relativeKey"], relative_key);

    // Original bytes round-trip through assets.content (never lossy).
    let content = dispatch(&kernel, "assets.content", json!({ "assetId": id }))
        .expect("assets.content must succeed");
    assert_eq!(content["assetId"], id);
    assert_eq!(content["contentType"], "image/png");
    assert_eq!(content["contentBase64"], base64_encode(PNG));

    // The published file is really on disk under the data root's assets dir.
    let path = root.path().join("assets").join(relative_key);
    assert_eq!(std::fs::read(&path).expect("asset file"), PNG);
}

#[test]
fn assets_put_is_idempotent_reimport() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let first = put_png(&kernel, "avatar", PNG);
    let second = put_png(&kernel, "avatar", PNG);

    assert_eq!(first["asset"]["id"], second["asset"]["id"]);
    assert_eq!(second["deduplicated"], true);
    assert_eq!(second["deduplicatedFromId"], first["asset"]["id"]);

    // Same bytes under a DIFFERENT kind are a different asset (dedupe is
    // (checksum, kind)); same kind + different bytes are also distinct.
    let other_kind = put_png(&kernel, "card", PNG);
    assert_ne!(first["asset"]["id"], other_kind["asset"]["id"]);
    let other_bytes = put_png(&kernel, "avatar", b"\x89PNG different bytes");
    assert_ne!(first["asset"]["id"], other_bytes["asset"]["id"]);
}

#[test]
fn character_avatar_linkage_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let put = put_png(&kernel, "avatar", PNG);
    let asset_id = put["asset"]["id"].as_str().expect("asset id");

    // create with avatarAssetId.
    let created = dispatch(
        &kernel,
        "characters.create",
        json!({ "name": "Aveline", "avatarAssetId": asset_id }),
    )
    .expect("characters.create must succeed");
    let character_id = created["id"].as_str().expect("character id").to_string();
    assert_eq!(created["avatarAssetId"], asset_id);

    // update replaces the avatar.
    let updated = dispatch(
        &kernel,
        "characters.update",
        json!({ "characterId": character_id, "avatarAssetId": asset_id }),
    )
    .expect("characters.update must succeed");
    assert_eq!(updated["avatarAssetId"], asset_id);

    // Referencing a missing asset fails with the stable product code.
    let missing = "00000000-0000-4000-8000-000000000000";
    let err = dispatch(
        &kernel,
        "characters.update",
        json!({ "characterId": character_id, "avatarAssetId": missing }),
    )
    .expect_err("unknown asset must fail");
    let product = err.product.expect("product error dto");
    assert_eq!(product.code, "ASSET_NOT_FOUND");
    assert_eq!(
        product.params.get("assetId").and_then(|v| v.as_str()),
        Some(missing)
    );
}

#[test]
fn assets_delete_then_get_not_found() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let put = put_png(&kernel, "avatar", PNG);
    let id = put["asset"]["id"].as_str().expect("asset id").to_string();

    dispatch(&kernel, "assets.delete", json!({ "assetId": id }))
        .expect("assets.delete must succeed");

    let err = dispatch(&kernel, "assets.get", json!({ "assetId": id }))
        .expect_err("deleted asset must be gone");
    let product = err.product.expect("product error dto");
    assert_eq!(product.code, "ASSET_NOT_FOUND");
    assert_eq!(
        product.params.get("assetId").and_then(|v| v.as_str()),
        Some(id.as_str())
    );
}

#[test]
fn assets_validation_rejects_bad_input() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Invalid base64 (also blocked by the wire pattern) → ContractViolation.
    let err = dispatch(
        &kernel,
        "assets.put",
        json!({
            "kind": "avatar",
            "filename": "a.png",
            "contentBase64": "!!!not-base64!!!",
        }),
    )
    .expect_err("invalid base64 must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);

    // Uppercase kind violates the wire pattern → ContractViolation.
    let err = dispatch(
        &kernel,
        "assets.put",
        json!({
            "kind": "AVATAR",
            "filename": "a.png",
            "contentBase64": base64_encode(PNG),
        }),
    )
    .expect_err("uppercase kind must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);

    // Unknown asset id on get → stable ASSET_NOT_FOUND product code.
    let err = dispatch(
        &kernel,
        "assets.get",
        json!({ "assetId": "00000000-0000-4000-8000-000000000000" }),
    )
    .expect_err("unknown asset must fail");
    assert_eq!(err.product.expect("product dto").code, "ASSET_NOT_FOUND");
}
