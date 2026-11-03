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

// --- imports.sillytavern.execute (the destructive half) ---------------------

/// One archive that exercises every supported category at least once.
const EXEC_CHAT: &str =
    "{\"user_name\":\"me\",\"chat_metadata\":{\"persona\":\"p1\",\"create_date\":1700000000000}}\n\
{\"name\":\"Ada\",\"mes\":\"hello\",\"is_user\":false}\n\
{\"name\":\"me\",\"mes\":\"hi\",\"is_user\":true}\n";

fn execute_archive() -> Vec<u8> {
    zip_bytes(&[
        (
            "backup/default-user/settings.json",
            br#"{"power_user":{"personas":{"p1":{"name":"Narrator","description":"inner voice"}},"default_persona":"p1"},"extension_settings":{"alpha":{"enabled":true}}}"#,
        ),
        (
            "backup/default-user/characters/ada.json",
            br#"{"name":"Ada","description":"Archive Ada","tags":["math"]}"#,
        ),
        ("backup/default-user/chats/ada/hello.jsonl", EXEC_CHAT.as_bytes()),
        ("backup/default-user/worlds/world.json", WORLD_JSON.as_bytes()),
        (
            "backup/default-user/instruct/brief.json",
            br#"{"name":"Brief","system_prompt":"be brief"}"#,
        ),
        (
            "backup/default-user/groups/group.json",
            br#"{"id":"g1","name":"Group"}"#,
        ),
        ("backup/default-user/backgrounds/scene.png", PNG_BYTES),
        ("backup/default-user/themes/custom.css", b"body{color:red}"),
        (
            "backup/default-user/openai settings/api1.json",
            br#"{"openai_model":"gpt-x","api_url":"https://example.invalid"}"#,
        ),
        ("backup/default-user/extensions/ext-a/index.js", b"// plugin"),
        ("backup/default-user/secrets.json", br#"{"openai":"sk-test"}"#),
    ])
}

fn execute(
    kernel: &Kernel,
    asset_id: &str,
    policy: &str,
) -> Result<Value, runtime_kernel::KernelError> {
    dispatch(
        kernel,
        "imports.sillytavern.execute",
        json!({ "assetId": asset_id, "conflictPolicy": policy }),
    )
}

fn exec_category<'a>(result: &'a Value, id: &str) -> &'a Value {
    result["categories"]
        .as_array()
        .expect("categories")
        .iter()
        .find(|row| row["id"] == json!(id))
        .unwrap_or_else(|| panic!("category {id} missing from {result}"))
}

#[test]
fn execute_imports_characters_and_chats() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let asset_id = put_backup_asset(&kernel, &execute_archive());

    let result = execute(&kernel, &asset_id, "skip").expect("execute must succeed");

    let characters = exec_category(&result, "characters");
    assert_eq!(characters["imported"], json!(1), "{result}");
    assert_eq!(characters["invalid"], json!(0));

    let chats = exec_category(&result, "chats");
    assert_eq!(chats["imported"], json!(1), "{result}");
    // The `chat_metadata` header is not a message, so the two transcript
    // records import as two messages.
    assert_eq!(chats["dependentImported"], json!(2), "{result}");

    let listed = dispatch(&kernel, "characters.list", json!({})).expect("characters.list");
    let items = listed["items"].as_array().expect("characters");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], json!("Ada"));
    assert_eq!(items[0]["description"], json!("Archive Ada"));

    let chats_list = dispatch(&kernel, "chats.list", json!({})).expect("chats.list");
    let chat_id = chats_list["items"][0]["id"]
        .as_str()
        .expect("chat id")
        .to_string();
    let messages = dispatch(&kernel, "chats.messages.list", json!({ "chatId": chat_id }))
        .expect("chats.messages.list");
    let rows = messages["items"].as_array().expect("messages");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["role"], json!("assistant"));
    assert_eq!(rows[0]["content"], json!("hello"));
    assert_eq!(rows[1]["role"], json!("user"));
    assert_eq!(rows[1]["content"], json!("hi"));
}

#[test]
fn execute_imports_every_supported_category() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let asset_id = put_backup_asset(&kernel, &execute_archive());

    let result = execute(&kernel, &asset_id, "skip").expect("execute must succeed");

    assert_eq!(exec_category(&result, "personas")["imported"], json!(1));
    assert_eq!(exec_category(&result, "lorebooks")["imported"], json!(1));
    assert_eq!(
        exec_category(&result, "lorebooks")["dependentImported"],
        json!(2)
    );
    // Two presets: `instruct/brief.json` and the `openai settings` file, which
    // feeds both the preset and the API-settings buckets (legacy behaviour).
    assert_eq!(exec_category(&result, "presets")["imported"], json!(2));
    assert_eq!(exec_category(&result, "groups")["imported"], json!(1));
    assert_eq!(exec_category(&result, "backgrounds")["imported"], json!(1));
    assert_eq!(
        exec_category(&result, "extensionSettings")["imported"],
        json!(1)
    );
    assert_eq!(exec_category(&result, "apiSettings")["imported"], json!(1));
    assert_eq!(exec_category(&result, "themes")["imported"], json!(1));
    // Never imported (ADR-0059), but never silently ignored either.
    assert_eq!(
        exec_category(&result, "legacyExtensions")["imported"],
        json!(0)
    );
    assert_eq!(result["totals"]["imported"], json!(11), "{result}");

    let codes = warning_codes(&result);
    for expected in [
        "SECRETS_SKIPPED",
        "LEGACY_EXTENSIONS_SKIPPED",
        "SETTINGS_PARTIALLY_IMPORTED",
        "GROUPS_PRESERVED_NOT_MODELED",
        "API_SETTINGS_NO_SECRETS",
    ] {
        assert!(
            codes.contains(&expected.to_string()),
            "{expected} not in {codes:?}"
        );
    }

    for (op, expected) in [
        ("lorebooks.list", 1),
        ("presets.list", 2),
        ("personas.list", 1),
    ] {
        let listed = dispatch(&kernel, op, json!({})).expect(op);
        assert_eq!(
            listed["items"].as_array().map(|items| items.len()),
            Some(expected),
            "{op}: {listed}"
        );
    }

    let settings = dispatch(
        &kernel,
        "settings.get",
        json!({ "keys": ["sillytavern.groups", "sillytavern.extension_settings", "sillytavern.api_settings"] }),
    )
    .expect("settings.get");
    let documents = settings["items"].as_array().expect("settings items");
    assert_eq!(documents.len(), 3, "{settings}");
    let groups = documents
        .iter()
        .find(|item| item["key"] == json!("sillytavern.groups"))
        .expect("groups document");
    assert_eq!(groups["value"]["g1"]["name"], json!("Group"));
}

#[test]
fn execute_preserves_an_existing_character_under_skip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    dispatch(
        &kernel,
        "characters.create",
        json!({ "name": "Ada", "description": "local copy" }),
    )
    .expect("characters.create");

    let asset_id = put_backup_asset(&kernel, &execute_archive());
    let result = execute(&kernel, &asset_id, "skip").expect("execute must succeed");

    let characters = exec_category(&result, "characters");
    assert_eq!(characters["imported"], json!(0), "{result}");
    assert_eq!(characters["skipped"], json!(1));
    assert_eq!(characters["conflicted"], json!(1));

    let listed = dispatch(&kernel, "characters.list", json!({})).expect("characters.list");
    let items = listed["items"].as_array().expect("characters");
    assert_eq!(items.len(), 1, "skip must not duplicate the row");
    assert_eq!(items[0]["description"], json!("local copy"));
}

#[test]
fn execute_replaces_a_character_and_snapshots_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let created = dispatch(
        &kernel,
        "characters.create",
        json!({ "name": "Ada", "description": "local copy" }),
    )
    .expect("characters.create");
    let character_id = created["id"].as_str().expect("character id").to_string();

    let asset_id = put_backup_asset(&kernel, &execute_archive());
    let result = execute(&kernel, &asset_id, "replace").expect("execute must succeed");
    let characters = exec_category(&result, "characters");
    assert_eq!(characters["imported"], json!(1), "{result}");
    assert_eq!(characters["conflicted"], json!(1));

    let fetched = dispatch(
        &kernel,
        "characters.get",
        json!({ "characterId": character_id }),
    )
    .expect("characters.get");
    assert_eq!(fetched["description"], json!("Archive Ada"));

    // `replace` is reversible: the overwritten state is a version snapshot.
    let versions = dispatch(
        &kernel,
        "characters.versions.list",
        json!({ "characterId": character_id }),
    )
    .expect("characters.versions.list");
    let items = versions["items"].as_array().expect("versions");
    assert_eq!(items.len(), 1, "{versions}");
}

#[test]
fn execute_is_idempotent_via_receipts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let asset_id = put_backup_asset(&kernel, &execute_archive());

    let first = execute(&kernel, &asset_id, "skip").expect("first execute");
    assert_eq!(first["archiveAlreadyImported"], json!(false));
    let before = dispatch(&kernel, "characters.list", json!({})).expect("characters.list");

    let second = execute(&kernel, &asset_id, "skip").expect("second execute");
    assert_eq!(second["totals"]["imported"], json!(0), "{second}");
    assert!(
        second["totals"]["reused"].as_i64().expect("reused") >= 5,
        "{second}"
    );
    assert_eq!(second["archiveAlreadyImported"], json!(true));

    let after = dispatch(&kernel, "characters.list", json!({})).expect("characters.list");
    assert_eq!(
        before, after,
        "re-running the same archive must not add rows"
    );
}

#[test]
fn execute_rejects_an_unknown_asset() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());

    let error = execute(&kernel, "00000000-0000-4000-8000-000000000000", "skip")
        .expect_err("an unknown asset must be refused");
    assert!(
        format!("{error:?}").contains("ASSET_NOT_FOUND"),
        "unexpected error: {error:?}"
    );
}

#[test]
fn execute_rejects_a_non_zip_asset_as_validation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let asset_id = put_backup_asset(&kernel, b"this is not a zip archive");

    let error = execute(&kernel, &asset_id, "skip").expect_err("a non-zip must be refused");
    let debug = format!("{error:?}");
    assert!(debug.contains("VALIDATION"), "unexpected error: {debug}");
    assert!(
        debug.contains("SILLYTAVERN_ARCHIVE_INVALID"),
        "unexpected error: {debug}"
    );
}

#[test]
fn execute_refuses_legacy_extensions_explicitly() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let asset_id = put_backup_asset(&kernel, &execute_archive());

    let error = dispatch(
        &kernel,
        "imports.sillytavern.execute",
        json!({
            "assetId": asset_id,
            "conflictPolicy": "skip",
            "categories": ["legacyExtensions"],
        }),
    )
    .expect_err("legacy extensions are not importable");
    let debug = format!("{error:?}");
    assert!(
        debug.contains("SILLYTAVERN_CATEGORY_UNSUPPORTED"),
        "unexpected error: {debug}"
    );
}

#[test]
fn execute_counts_reconcile_with_the_analysis() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let asset_id = put_backup_asset(&kernel, &execute_archive());

    let analysis = analyze(&kernel, &asset_id);
    let result = execute(&kernel, &asset_id, "skip").expect("execute must succeed");

    for id in [
        "characters",
        "chats",
        "personas",
        "lorebooks",
        "presets",
        "groups",
        "backgrounds",
        "extensionSettings",
        "apiSettings",
        "themes",
    ] {
        let discovered = category(&analysis, id)["discovered"]
            .as_i64()
            .expect("discovered");
        let executed = exec_category(&result, id);
        let total = ["imported", "reused", "skipped", "invalid"]
            .iter()
            .map(|key| executed[key].as_i64().expect(key))
            .sum::<i64>();
        assert_eq!(
            discovered, total,
            "category {id}: analysis {discovered} != execute {executed}"
        );
    }

    // `legacyExtensions` is analysed but never imported (ADR-0059).
    assert_eq!(
        category(&analysis, "legacyExtensions")["discovered"],
        json!(1)
    );
    assert_eq!(
        exec_category(&result, "legacyExtensions")["imported"],
        json!(0)
    );
}
