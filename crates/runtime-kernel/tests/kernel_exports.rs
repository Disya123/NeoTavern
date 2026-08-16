//! Этап 4.5: character-card export (`characters.export.card`).
//!
//! Symmetric to the import suite: imported characters round-trip their
//! original card object verbatim (preserved under `ext_json._card`),
//! characters created without a container are rebuilt from the canonical
//! columns with an honest warning, the PNG format produces a container the
//! kernel's own import parser accepts, and a missing character answers the
//! stable `CHARACTER_NOT_FOUND` product error.

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

fn base64_decode(value: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .expect("exported base64 must decode")
}

fn put_card_asset(kernel: &Kernel, bytes: &[u8]) -> Value {
    let request = json!({
        "kind": "card",
        "filename": "card.bin",
        "contentType": "application/octet-stream",
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

fn export_card(kernel: &Kernel, character_id: &str, format: &str) -> Value {
    dispatch(
        kernel,
        "characters.export.card",
        json!({ "characterId": character_id, "format": format }),
    )
    .expect("characters.export.card must succeed")
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
fn export_round_trips_the_imported_card_verbatim() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let asset = put_card_asset(&kernel, CARD_JSON.as_bytes());
    let imported = import_card(&kernel, asset["asset"]["id"].as_str().expect("asset id"));
    let character_id = imported["character"]["id"].as_str().expect("character id");

    let exported = export_card(&kernel, character_id, "json");
    assert_eq!(exported["contentType"], "application/json");
    assert_eq!(exported["warnings"], json!([]));
    let filename = exported["filename"].as_str().expect("filename");
    assert!(filename.ends_with(".json"), "filename was {filename}");

    // Verbatim round trip: the original card object (spec + unknown fields)
    // survives byte-for-byte in JSON form.
    let card: Value =
        serde_json::from_slice(&base64_decode(exported["contentBase64"].as_str().unwrap()))
            .expect("exported JSON parses");
    assert_eq!(card["spec"], "chara_card_v2");
    assert_eq!(card["name"], "Ada Lovelace");
    assert_eq!(card["personality"], "Meticulous, visionary");
    assert_eq!(card["extensions"]["custom"]["kind"], "kept");
}

#[test]
fn export_rebuilds_a_character_created_without_a_container_with_warning() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let created = dispatch(
        &kernel,
        "characters.create",
        json!({
            "name": "Grace Hopper",
            "description": "Compiler pioneer",
            "tags": ["technical"],
        }),
    )
    .expect("characters.create must succeed");
    let character_id = created["id"].as_str().expect("character id");

    let exported = export_card(&kernel, character_id, "json");
    assert_eq!(
        exported["warnings"],
        json!(["no original card container; rebuilt from canonical fields"])
    );
    let card: Value =
        serde_json::from_slice(&base64_decode(exported["contentBase64"].as_str().unwrap()))
            .expect("exported JSON parses");
    assert_eq!(card["spec"], "chara_card_v2");
    assert_eq!(card["spec_version"], "2.0");
    assert_eq!(card["data"]["name"], "Grace Hopper");
    assert_eq!(card["data"]["description"], "Compiler pioneer");
    assert_eq!(card["data"]["tags"], json!(["technical"]));
    // Honest defaults for fields the canonical schema does not model.
    assert_eq!(card["data"]["personality"], "");
    assert_eq!(card["data"]["alternate_greetings"], json!([]));
}

#[test]
fn export_png_produces_a_container_the_kernel_import_accepts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let asset = put_card_asset(&kernel, CARD_JSON.as_bytes());
    let imported = import_card(&kernel, asset["asset"]["id"].as_str().expect("asset id"));
    let character_id = imported["character"]["id"].as_str().expect("character id");

    let exported = export_card(&kernel, character_id, "png");
    assert_eq!(exported["contentType"], "image/png");
    assert!(exported["filename"]
        .as_str()
        .expect("filename")
        .ends_with(".png"));
    let png = base64_decode(exported["contentBase64"].as_str().expect("contentBase64"));
    // Valid PNG signature.
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

    // The exported PNG re-imports as a new character carrying the same data:
    // the `chara` tEXt chunk is base64-encoded JSON, exactly what
    // imports.character.card parses (the container data round-trips, even
    // though the file bytes differ from the original JSON import).
    let re_asset = put_card_asset(&kernel, &png);
    let re_imported = import_card(&kernel, re_asset["asset"]["id"].as_str().expect("asset id"));
    assert_eq!(re_imported["created"], true);
    assert_eq!(re_imported["character"]["name"], "Ada Lovelace");
}

#[test]
fn export_missing_character_is_character_not_found() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let err = dispatch(
        &kernel,
        "characters.export.card",
        json!({ "characterId": "00000000-0000-4000-8000-000000000000", "format": "json" }),
    )
    .expect_err("missing character must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");
    assert_eq!(
        product.params.get("characterId").and_then(|v| v.as_str()),
        Some("00000000-0000-4000-8000-000000000000")
    );
}

#[test]
fn export_png_round_trips_card_fields_through_ext_json() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let asset = put_card_asset(&kernel, CARD_JSON.as_bytes());
    let imported = import_card(&kernel, asset["asset"]["id"].as_str().expect("asset id"));
    let character_id = imported["character"]["id"].as_str().expect("character id");

    let exported = export_card(&kernel, character_id, "png");
    let png = base64_decode(exported["contentBase64"].as_str().expect("contentBase64"));
    // Re-import the exported PNG and verify the full field set survives.
    let re_asset = put_card_asset(&kernel, &png);
    let re_imported = import_card(&kernel, re_asset["asset"]["id"].as_str().expect("asset id"));
    assert_eq!(
        re_imported["character"]["description"],
        "First programmer of the analytical engine."
    );
    assert_eq!(
        re_imported["character"]["tags"],
        json!(["analytical", "historical"])
    );
}

/// Helper: create a character + chat and return the chat id.
fn create_chat(kernel: &Kernel) -> String {
    let created = dispatch(
        kernel,
        "characters.create",
        json!({ "name": "Ada Lovelace", "description": "First programmer" }),
    )
    .expect("characters.create must succeed");
    let character_id = created["id"].as_str().expect("character id");
    let chat = dispatch(
        kernel,
        "chats.create",
        json!({ "characterId": character_id, "title": "Analytical engine" }),
    )
    .expect("chats.create must succeed");
    chat["id"].as_str().expect("chat id").to_string()
}

#[test]
fn export_chat_dumps_messages_variants_and_revisions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let chat_id = create_chat(&kernel);

    let first = dispatch(
        &kernel,
        "chats.messages.create",
        json!({ "chatId": chat_id, "role": "user", "content": "Good evening." }),
    )
    .expect("message create must succeed");
    let message_id = first["id"].as_str().expect("message id");
    dispatch(
        &kernel,
        "chats.messages.create",
        json!({ "chatId": chat_id, "role": "assistant", "content": "Good evening, Charles." }),
    )
    .expect("message create must succeed");

    // A swipe variant plus activation records an immutable content revision.
    let variant = dispatch(
        &kernel,
        "chats.messages.variants.create",
        json!({ "chatId": chat_id, "messageId": message_id, "content": "Hello there (swipe)" }),
    )
    .expect("variant create must succeed");
    let variant_id = variant["id"].as_str().expect("variant id");
    dispatch(
        &kernel,
        "chats.messages.variants.activate",
        json!({ "chatId": chat_id, "messageId": message_id, "variantId": variant_id }),
    )
    .expect("variant activate must succeed");

    let exported = dispatch(
        &kernel,
        "chats.export",
        json!({ "chatId": chat_id }),
    )
    .expect("chats.export must succeed");
    assert_eq!(exported["contentType"], "application/json");
    assert_eq!(exported["warnings"], json!([]));
    assert_eq!(
        exported["filename"],
        json!(format!("chat-{chat_id}.json"))
    );
    let container: Value = serde_json::from_slice(
        &base64_decode(exported["contentBase64"].as_str().expect("contentBase64")),
    )
    .expect("container JSON parses");
    assert_eq!(container["kind"], "neotavern-chat-export");
    assert_eq!(container["version"], 2);
    assert_eq!(container["characterName"], "Ada Lovelace");
    assert_eq!(container["chat"]["id"], chat_id);
    assert_eq!(container["chat"]["title"], "Analytical engine");
    assert_eq!(container["chat"]["characterId"].as_str().is_some(), true);
    assert_eq!(container["messages"].as_array().expect("messages").len(), 2);
    // The activated swipe became the message text; the previous text lives on
    // as an immutable content revision.
    assert_eq!(container["messages"][0]["role"], "user");
    assert_eq!(container["messages"][0]["content"], "Hello there (swipe)");
    assert_eq!(container["messages"][1]["role"], "assistant");
    assert_eq!(container["messages"][1]["content"], "Good evening, Charles.");
    // Wire-visible fields only: meta is present, no fabricated `name`.
    assert_eq!(container["messages"][0]["meta"], json!({}));
    assert!(container["messages"][0].get("name").is_none());
    assert_eq!(
        container["messageVariants"].as_array().expect("variants").len(),
        1
    );
    assert_eq!(container["messageVariants"][0]["content"], "Hello there (swipe)");
    assert_eq!(
        container["messageRevisions"].as_array().expect("revisions").len(),
        1
    );
    assert_eq!(
        container["messageRevisions"][0]["content"],
        "Good evening."
    );
}

#[test]
fn export_empty_chat_warns_but_succeeds() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let chat_id = create_chat(&kernel);

    let exported = dispatch(&kernel, "chats.export", json!({ "chatId": chat_id }))
        .expect("chats.export must succeed");
    assert_eq!(
        exported["warnings"],
        json!(["chat has no messages; the container carries an empty dump"])
    );
    let container: Value = serde_json::from_slice(
        &base64_decode(exported["contentBase64"].as_str().expect("contentBase64")),
    )
    .expect("container JSON parses");
    assert_eq!(container["messages"].as_array().expect("messages").len(), 0);
}

#[test]
fn export_missing_chat_is_chat_not_found() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let err = dispatch(
        &kernel,
        "chats.export",
        json!({ "chatId": "00000000-0000-4000-8000-000000000000" }),
    )
    .expect_err("missing chat must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "CHAT_NOT_FOUND");
    assert_eq!(
        product.params.get("chatId").and_then(|v| v.as_str()),
        Some("00000000-0000-4000-8000-000000000000")
    );
}
