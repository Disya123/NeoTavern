//! Этап 4.5: character-card import (`imports.character.card`).
//!
//! A SillyTavern-compatible card (V2 JSON, or a PNG carrying the `chara`
//! tEXt chunk with base64-encoded JSON) is staged through `assets.put`
//! (kind `card`); the import parses it, deduplicates by the sha256 of the
//! original bytes and creates the character. Card fields beyond the canonical
//! columns are preserved under `ext_json._card`; PNG cards link the staged
//! asset as the avatar.

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

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn put_card_asset(kernel: &Kernel, bytes: &[u8]) -> Value {
    let request = json!({
        "kind": "card",
        "filename": "card.png",
        "contentType": "image/png",
        "contentBase64": base64_encode(bytes),
    });
    dispatch(kernel, "assets.put", request).expect("assets.put must succeed")
}

fn import_card(kernel: &Kernel, asset_id: &str) -> Value {
    dispatch(
        kernel,
        "imports.character.card",
        json!({ "assetId": asset_id }),
    )
    .expect("imports.character.card must succeed")
}

/// Builds a minimal PNG: signature, IHDR, one `tEXt` chunk carrying
/// `chara\0<base64 JSON>` and IEND. The kernel parser ignores CRCs.
fn png_with_chara_card(card: &Value) -> Vec<u8> {
    let encoded = base64_encode(&serde_json::to_vec(card).expect("card serialization"));
    let mut text = Vec::from(b"chara\0");
    text.extend_from_slice(encoded.as_bytes());
    let mut png = Vec::from(b"\x89PNG\r\n\x1a\n");
    png.extend_from_slice(&chunk(b"IHDR", &[0u8; 13]));
    png.extend_from_slice(&chunk(b"tEXt", &text));
    png.extend_from_slice(&chunk(b"IEND", &[]));
    png
}

fn chunk(chunk_type: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(chunk_type);
    out.extend_from_slice(data);
    out.extend_from_slice(&[0, 0, 0, 0]); // CRC placeholder; the parser ignores it
    out
}

const CARD_JSON: &str = r#"{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "name": "Ada Lovelace",
  "description": "First programmer of the analytical engine.",
  "personality": "Meticulous, visionary",
  "first_mes": "Good evening, Charles.",
  "tags": ["analytical", "historical"],
  "creator": "unit-test",
  "extensions": { "custom": { "kind": "kept" } }
}"#;

#[test]
fn imports_json_card_creates_character_and_preserves_fields() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let asset = put_card_asset(&kernel, CARD_JSON.as_bytes());
    let asset_id = asset["asset"]["id"].as_str().expect("asset id");

    let result = import_card(&kernel, asset_id);
    assert_eq!(result["created"], true);
    assert_eq!(result["character"]["name"], "Ada Lovelace");
    assert_eq!(
        result["character"]["description"],
        "First programmer of the analytical engine."
    );
    assert_eq!(
        result["character"]["tags"],
        json!(["analytical", "historical"])
    );
    let hash = result["sourceHash"].as_str().expect("source hash");
    assert_eq!(hash.len(), 64);

    // Card fields beyond the canonical columns survive under ext_json._card
    // (verified after the kernel releases the data root).
    drop(kernel);
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let db = neotavern_storage::open::open(
        dir.path(),
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("data root must reopen after kernel release");
    let ext: String = db
        .conn()
        .query_row(
            "SELECT ext_json FROM characters WHERE name = ?1",
            rusqlite::params!["Ada Lovelace"],
            |row| row.get(0),
        )
        .expect("character ext_json");
    drop(db);
    let ext: Value = serde_json::from_str(&ext).expect("ext_json must be JSON");
    assert_eq!(ext["_card"]["personality"], "Meticulous, visionary");
    assert_eq!(ext["_card"]["extensions"]["custom"]["kind"], "kept");
}

#[test]
fn reimporting_the_same_card_returns_the_existing_character() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let asset = put_card_asset(&kernel, CARD_JSON.as_bytes());
    let asset_id = asset["asset"]["id"].as_str().expect("asset id");

    let first = import_card(&kernel, asset_id);
    assert_eq!(first["created"], true);
    let second = import_card(&kernel, asset_id);
    assert_eq!(second["created"], false);
    assert_eq!(second["character"]["id"], first["character"]["id"]);
    assert_eq!(second["sourceHash"], first["sourceHash"]);
}

#[test]
fn imports_png_card_and_links_the_staged_asset_as_avatar() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let card: Value = serde_json::from_str(CARD_JSON).expect("card json");
    let png = png_with_chara_card(&card);
    let asset = put_card_asset(&kernel, &png);
    let asset_id = asset["asset"]["id"].as_str().expect("asset id");

    let result = import_card(&kernel, asset_id);
    assert_eq!(result["created"], true);
    assert_eq!(result["character"]["name"], "Ada Lovelace");
    assert_eq!(
        result["character"]["avatarAssetId"].as_str(),
        Some(asset_id)
    );
}

#[test]
fn rejects_unparseable_card_bytes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    // Not PNG, not JSON.
    let asset = put_card_asset(&kernel, b"plain text, definitely not a card");
    let asset_id = asset["asset"]["id"].as_str().expect("asset id");

    let err = dispatch(
        &kernel,
        "imports.character.card",
        json!({ "assetId": asset_id }),
    )
    .expect_err("unparseable card must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "CHARACTER_CARD_INVALID");
    let reason = product.params.get("reason").expect("reason param");
    assert_eq!(reason, "INVALID_JSON");
}

#[test]
fn missing_asset_is_asset_not_found() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let err = dispatch(
        &kernel,
        "imports.character.card",
        json!({ "assetId": "00000000-0000-4000-8000-000000000000" }),
    )
    .expect_err("missing asset must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "ASSET_NOT_FOUND");
}
