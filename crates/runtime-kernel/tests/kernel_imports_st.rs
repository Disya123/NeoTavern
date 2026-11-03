//! Этап 4.5 cluster 10: SillyTavern archive analysis
//! (`imports.sillytavern.analyze`).
//!
//! The archive is staged through `assets.put` (kind `backup`) — the same
//! staged-asset path a multi-gigabyte backup takes through the chunked
//! ingestion contract (ADR-0061) — and the analysis walks it read-only:
//! category counts, nested record counts, honest warnings, and a stable hash.

use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::{json, Value};
use std::io::{Cursor, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

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

/// Builds a stored (uncompressed) ZIP from `(path, bytes)` entries.
fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for (name, bytes) in entries {
        writer.start_file(*name, options).expect("zip entry");
        writer.write_all(bytes).expect("zip body");
    }
    writer.finish().expect("zip finish").into_inner()
}

fn put_backup_asset(kernel: &Kernel, bytes: &[u8]) -> String {
    let asset = dispatch(
        kernel,
        "assets.put",
        json!({
            "kind": "backup",
            "filename": "chat-backup.zip",
            "contentType": "application/zip",
            "contentBase64": base64_encode(bytes),
        }),
    )
    .expect("assets.put must succeed");
    asset["asset"]["id"].as_str().expect("asset id").to_string()
}

fn analyze(kernel: &Kernel, asset_id: &str) -> Value {
    dispatch(
        kernel,
        "imports.sillytavern.analyze",
        json!({ "assetId": asset_id }),
    )
    .expect("imports.sillytavern.analyze must succeed")
}

fn category<'a>(result: &'a Value, id: &str) -> &'a Value {
    result["categories"]
        .as_array()
        .expect("categories")
        .iter()
        .find(|row| row["id"] == json!(id))
        .unwrap_or_else(|| panic!("category {id} missing from {result}"))
}

fn warning_codes(result: &Value) -> Vec<String> {
    result["warnings"]
        .as_array()
        .expect("warnings")
        .iter()
        .map(|warning| warning["code"].as_str().unwrap_or_default().to_string())
        .collect()
}

const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nfake-\x00-png-body";
const CHAT_JSONL: &str =
    "{\"name\":\"Ada\",\"mes\":\"hello\"}\n{\"name\":\"Ada\",\"mes\":\"again\"}\n";
const WORLD_JSON: &str = "{\"name\":\"Test World\",\"entries\":{\"0\":{\"key\":[\"a\"]},\"1\":{\"key\":[\"b\"]},\"2\":\"broken\"}}";

fn fixture_archive() -> Vec<u8> {
    zip_bytes(&[
        (
            "backup/default-user/settings.json",
            br#"{"power_user":{"personas":{"persona1":{"name":"P"}}},"extension_settings":{"alpha":{},"beta":{}}}"#,
        ),
        ("backup/default-user/characters/ada.png", PNG_BYTES),
        ("backup/default-user/characters/ada.json", b"{\"name\":\"Ada\"}"),
        ("backup/default-user/chats/ada.jsonl", CHAT_JSONL.as_bytes()),
        ("backup/default-user/worlds/world.json", WORLD_JSON.as_bytes()),
        ("backup/default-user/backgrounds/scene.png", PNG_BYTES),
        ("backup/default-user/themes/custom.css", b"body{color:red}"),
        ("backup/default-user/groups/group.json", br#"{"id":"g1","name":"Group"}"#),
        ("backup/default-user/group chats/g1.jsonl", CHAT_JSONL.as_bytes()),
        ("backup/default-user/extensions/ext-a/index.js", b"// plugin"),
        ("backup/default-user/secrets.json", br#"{"openai":"sk-test"}"#),
    ])
}

#[test]
fn analyze_counts_categories_and_nested_records() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let asset_id = put_backup_asset(&kernel, &fixture_archive());

    let result = analyze(&kernel, &asset_id);

    let hash = result["sourceHash"].as_str().expect("source hash");
    assert_eq!(hash.len(), 64);
    assert!(hash
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert!(result["totalExpandedBytes"].as_i64().expect("expanded") > 0);
    assert!(result["totalCompressedBytes"].as_i64().expect("compressed") > 0);
    assert_eq!(result["categories"].as_array().expect("array").len(), 11);

    // The `.json` sibling of a `.png` card is not counted twice.
    let characters = category(&result, "characters");
    assert_eq!(characters["discovered"], json!(1));
    assert_eq!(characters["invalid"], json!(0));

    // Two chat records → two dependent messages.
    let chats = category(&result, "chats");
    assert_eq!(chats["discovered"], json!(1));
    assert_eq!(chats["dependentRecords"], json!(2));
    assert_eq!(chats["invalid"], json!(0));

    // Three lore entries, one of them not an object.
    let lorebooks = category(&result, "lorebooks");
    assert_eq!(lorebooks["discovered"], json!(1));
    assert_eq!(lorebooks["dependentRecords"], json!(2));
    assert_eq!(lorebooks["invalid"], json!(1));

    assert_eq!(category(&result, "personas")["discovered"], json!(1));
    assert_eq!(
        category(&result, "extensionSettings")["discovered"],
        json!(2)
    );
    assert_eq!(category(&result, "backgrounds")["discovered"], json!(1));
    assert_eq!(category(&result, "themes")["discovered"], json!(1));
    assert_eq!(
        category(&result, "legacyExtensions")["discovered"],
        json!(1)
    );
    let groups = category(&result, "groups");
    assert_eq!(groups["discovered"], json!(1));
    assert_eq!(groups["dependentRecords"], json!(2));

    let codes = warning_codes(&result);
    assert!(codes.contains(&"SECRETS_SKIPPED".to_string()), "{codes:?}");
    assert!(
        codes.contains(&"SETTINGS_PARTIALLY_IMPORTED".to_string()),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"LEGACY_EXTENSIONS_SKIPPED".to_string()),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"LORE_ENTRY_INVALID".to_string()),
        "{codes:?}"
    );
    // Secrets are never counted into a category.
    assert_eq!(category(&result, "apiSettings")["discovered"], json!(0));
}

#[test]
fn analyze_is_idempotent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let asset_id = put_backup_asset(&kernel, &fixture_archive());

    let first = analyze(&kernel, &asset_id);
    let second = analyze(&kernel, &asset_id);
    assert_eq!(first, second, "analysis writes nothing and must be stable");
}

#[test]
fn analyze_flags_unsafe_entry_paths() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let archive = zip_bytes(&[
        ("default-user/characters/ada.png", PNG_BYTES),
        ("../escape.txt", b"escaped"),
    ]);
    let asset_id = put_backup_asset(&kernel, &archive);

    let result = analyze(&kernel, &asset_id);
    let codes = warning_codes(&result);
    assert!(
        codes.contains(&"ARCHIVE_ENTRY_UNSAFE".to_string()),
        "{codes:?}"
    );
    // The traversal entry never lands in a category.
    assert_eq!(category(&result, "characters")["discovered"], json!(1));
}

#[test]
fn analyze_rejects_a_non_zip_asset() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let asset_id = put_backup_asset(&kernel, b"this is not a zip archive");

    let error = dispatch(
        &kernel,
        "imports.sillytavern.analyze",
        json!({ "assetId": asset_id }),
    )
    .expect_err("a non-zip asset must be refused");
    let message = format!("{error:?}");
    assert!(
        message.contains("SILLYTAVERN_ARCHIVE_INVALID"),
        "unexpected error: {message}"
    );
}

#[test]
fn analyze_rejects_an_unknown_asset() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let error = dispatch(
        &kernel,
        "imports.sillytavern.analyze",
        json!({ "assetId": "00000000-0000-4000-8000-000000000000" }),
    )
    .expect_err("an unknown asset must be refused");
    let message = format!("{error:?}");
    assert!(
        message.contains("ASSET_NOT_FOUND"),
        "unexpected error: {message}"
    );
}

#[test]
fn analyze_reports_invalid_chat_records() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let archive = zip_bytes(&[
        ("default-user/chats/broken.jsonl", b"{\"ok\":1}\nnot-json\n"),
        ("default-user/characters/ada.png", PNG_BYTES),
    ]);
    let asset_id = put_backup_asset(&kernel, &archive);

    let result = analyze(&kernel, &asset_id);
    let chats = category(&result, "chats");
    assert_eq!(chats["discovered"], json!(1));
    assert_eq!(chats["dependentRecords"], json!(2));
    assert_eq!(chats["invalid"], json!(1));
    let codes = warning_codes(&result);
    assert!(
        codes.contains(&"CHAT_RECORD_INVALID".to_string()),
        "{codes:?}"
    );
}

#[test]
fn analyze_finds_the_user_root_under_a_backup_wrapper() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    // `default-user` wins over the shallow wrapper directory.
    let archive = zip_bytes(&[
        ("backup/default-user/characters/ada.png", PNG_BYTES),
        ("backup/default-user/chats/ada.jsonl", CHAT_JSONL.as_bytes()),
    ]);
    let asset_id = put_backup_asset(&kernel, &archive);

    let result = analyze(&kernel, &asset_id);
    assert_eq!(category(&result, "characters")["discovered"], json!(1));
    assert_eq!(category(&result, "chats")["dependentRecords"], json!(2));
}
