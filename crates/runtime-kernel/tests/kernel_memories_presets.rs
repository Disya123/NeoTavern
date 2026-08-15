//! Этап 4 slice 3 kernel integration tests (ТЗ §4.4 Memory/RAG + presets):
//! memories CRUD over the wire (`memories.list/create/update/delete`) and
//! presets CRUD (`presets.list/get/create/update/delete`), including the
//! character-scope validation and the `(kind, name)` uniqueness conflict.

use contracts_generated::generated::{CharacterDto, MemoryDto, PresetDto, ResultListMemories, ResultListPresets};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};
use serde_json::{json, Value};

/// A kernel over `root` with the correct, manifest-derived contract
/// expectations.
fn open_kernel_with_root(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

/// Serializes `request`, dispatches `op`, and decodes the response bytes to
/// JSON.
fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

/// Like [`dispatch_json`] but decodes a successful response as `T`.
fn dispatch_decoded<T: serde::de::DeserializeOwned>(
    kernel: &Kernel,
    op: &str,
    request: Value,
) -> Result<T, KernelError> {
    dispatch_json(kernel, op, request).map(|value| {
        serde_json::from_value(value).expect("response must decode as the expected DTO")
    })
}

/// M5 slice 3: presets CRUD round trip over the wire.
#[test]
fn preset_crud_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    // create a generation preset with data.
    let created = dispatch_decoded::<PresetDto>(
        &kernel,
        "presets.create",
        json!({
            "kind": "generation",
            "name": "Balanced",
            "data": { "maxContextTokens": 8192, "generationDefaults": { "temperature": 0.8 } }
        }),
    )
    .expect("presets.create must succeed");
    assert_eq!(created.kind, "generation");
    assert_eq!(created.name, "Balanced");
    assert_eq!(created.data["maxContextTokens"], json!(8192));

    // list → the created row, newest first.
    let list = dispatch_decoded::<ResultListPresets>(&kernel, "presets.list", json!({}))
        .expect("presets.list must succeed");
    assert_eq!(list.items.len(), 1);
    assert_eq!(list.items[0].id, created.id);

    // list filtered by kind → present; unknown kind → empty.
    let by_kind = dispatch_decoded::<ResultListPresets>(
        &kernel,
        "presets.list",
        json!({ "kind": "generation" }),
    )
    .expect("presets.list with kind must succeed");
    assert_eq!(by_kind.items.len(), 1);
    let other = dispatch_decoded::<ResultListPresets>(
        &kernel,
        "presets.list",
        json!({ "kind": "prompt-template" }),
    )
    .expect("presets.list with other kind must succeed");
    assert!(other.items.is_empty());

    // get → equal.
    let fetched =
        dispatch_decoded::<PresetDto>(&kernel, "presets.get", json!({ "presetId": created.id }))
            .expect("presets.get must succeed");
    assert_eq!(fetched.id, created.id);
    assert_eq!(fetched.data["generationDefaults"]["temperature"], json!(0.8));

    // update name + data.
    let updated = dispatch_decoded::<PresetDto>(
        &kernel,
        "presets.update",
        json!({ "presetId": created.id, "name": "Balanced v2", "data": { "maxContextTokens": 16384 } }),
    )
    .expect("presets.update must succeed");
    assert_eq!(updated.name, "Balanced v2");
    assert_eq!(updated.data["maxContextTokens"], json!(16384));
    assert_eq!(updated.created_at, created.created_at, "created_at untouched");

    // delete → empty result; follow-up get answers PRESET_NOT_FOUND.
    dispatch_decoded::<contracts_generated::generated::ResultEmpty>(
        &kernel,
        "presets.delete",
        json!({ "presetId": created.id }),
    )
    .expect("presets.delete must succeed");
    let get_err = dispatch_json(&kernel, "presets.get", json!({ "presetId": created.id }))
        .expect_err("get on a deleted preset must fail");
    assert_eq!(get_err.code, KernelErrorCode::NotFound);
    let product = get_err.product.expect("product dto");
    assert_eq!(product.code, "PRESET_NOT_FOUND");
    assert_eq!(product.params["presetId"], json!(created.id));
}

/// M5 slice 3: duplicate `(kind, name)` and missing-record error paths.
#[test]
fn preset_conflict_and_error_paths() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let missing = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    dispatch_decoded::<PresetDto>(
        &kernel,
        "presets.create",
        json!({ "kind": "generation", "name": "Balanced" }),
    )
    .expect("first presets.create must succeed");

    // duplicate create → PRESET_CONFLICT.
    let conflict = dispatch_json(
        &kernel,
        "presets.create",
        json!({ "kind": "generation", "name": "Balanced" }),
    )
    .expect_err("duplicate preset must conflict");
    assert_eq!(conflict.code, KernelErrorCode::Conflict);
    let product = conflict.product.expect("product dto");
    assert_eq!(product.code, "PRESET_CONFLICT");

    // rename onto an existing (kind, name) → PRESET_CONFLICT.
    let other = dispatch_decoded::<PresetDto>(
        &kernel,
        "presets.create",
        json!({ "kind": "generation", "name": "Creative" }),
    )
    .expect("second presets.create must succeed");
    let rename_conflict = dispatch_json(
        &kernel,
        "presets.update",
        json!({ "presetId": other.id, "name": "Balanced" }),
    )
    .expect_err("renaming onto a duplicate (kind, name) must conflict");
    assert_eq!(rename_conflict.code, KernelErrorCode::Conflict);

    // update/delete on a missing preset → PRESET_NOT_FOUND.
    let update_err = dispatch_json(
        &kernel,
        "presets.update",
        json!({ "presetId": missing, "name": "Ghost" }),
    )
    .expect_err("update on a missing preset must fail");
    assert_eq!(update_err.code, KernelErrorCode::NotFound);
    let delete_err = dispatch_json(&kernel, "presets.delete", json!({ "presetId": missing }))
        .expect_err("delete on a missing preset must fail");
    assert_eq!(delete_err.code, KernelErrorCode::NotFound);

    // malformed kind pattern → contract violation.
    let violation = dispatch_json(
        &kernel,
        "presets.create",
        json!({ "kind": "Bad Kind!", "name": "Invalid" }),
    )
    .expect_err("bad kind pattern must be a contract violation");
    assert_eq!(violation.code, KernelErrorCode::ContractViolation);
}

/// M5 slice 3: memories CRUD round trip over the wire, character-scoped and
/// global, with list filters.
#[test]
fn memory_crud_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    // a character to scope memories against.
    let character = dispatch_decoded::<CharacterDto>(
        &kernel,
        "characters.create",
        json!({ "name": "Aria" }),
    )
    .expect("characters.create must succeed");

    // character-scoped memory (requires the character id).
    let scoped = dispatch_decoded::<MemoryDto>(
        &kernel,
        "memories.create",
        json!({
            "scope": "character",
            "characterId": character.id,
            "keys": ["aria", "clockwork"],
            "content": "Aria guards the clockwork orchard.",
            "position": 1
        }),
    )
    .expect("memories.create (character scope) must succeed");
    assert_eq!(scoped.scope, contracts_generated::generated::MemoryScope::Character);
    assert_eq!(scoped.character_id.as_deref(), Some(character.id.as_str()));
    assert_eq!(scoped.keys, vec!["aria".to_string(), "clockwork".to_string()]);
    assert!(scoped.enabled, "enabled defaults to true");
    assert_eq!(scoped.position, 1);

    // global memory (no character, default scope).
    let global = dispatch_decoded::<MemoryDto>(
        &kernel,
        "memories.create",
        json!({ "content": "The orchard blooms only at midnight.", "keys": ["orchard"] }),
    )
    .expect("memories.create (global) must succeed");
    assert_eq!(global.scope, contracts_generated::generated::MemoryScope::Global);
    assert!(global.character_id.is_none());

    // list filters: all / by scope / by character / by enabled.
    let all = dispatch_decoded::<ResultListMemories>(&kernel, "memories.list", json!({}))
        .expect("memories.list must succeed");
    assert_eq!(all.items.len(), 2);

    let globals = dispatch_decoded::<ResultListMemories>(
        &kernel,
        "memories.list",
        json!({ "scope": "global" }),
    )
    .expect("memories.list (scope=global) must succeed");
    assert_eq!(globals.items.len(), 1);
    assert_eq!(globals.items[0].id, global.id);

    let scoped_list = dispatch_decoded::<ResultListMemories>(
        &kernel,
        "memories.list",
        json!({ "characterId": character.id }),
    )
    .expect("memories.list (characterId) must succeed");
    assert_eq!(scoped_list.items.len(), 1);
    assert_eq!(scoped_list.items[0].id, scoped.id);

    let disabled = dispatch_decoded::<ResultListMemories>(
        &kernel,
        "memories.list",
        json!({ "enabled": false }),
    )
    .expect("memories.list (enabled=false) must succeed");
    assert!(disabled.items.is_empty());

    // update content/enabled/position/keys on the scoped memory.
    let updated = dispatch_decoded::<MemoryDto>(
        &kernel,
        "memories.update",
        json!({
            "memoryId": scoped.id,
            "content": "Aria guards the clockwork orchard and its brass trees.",
            "enabled": false,
            "position": 0,
            "keys": ["aria", "brass", "orchard"]
        }),
    )
    .expect("memories.update must succeed");
    assert_eq!(updated.content, "Aria guards the clockwork orchard and its brass trees.");
    assert!(!updated.enabled, "enabled: false is honoured");
    assert_eq!(updated.position, 0);
    assert_eq!(updated.keys, vec!["aria".to_string(), "brass".to_string(), "orchard".to_string()]);
    assert_eq!(updated.created_at, scoped.created_at, "created_at untouched");

    // now visible under enabled=false.
    let disabled_now = dispatch_decoded::<ResultListMemories>(
        &kernel,
        "memories.list",
        json!({ "enabled": false }),
    )
    .expect("memories.list (enabled=false) after update must succeed");
    assert_eq!(disabled_now.items.len(), 1);

    // delete → empty result; list no longer contains the id.
    dispatch_decoded::<contracts_generated::generated::ResultEmpty>(
        &kernel,
        "memories.delete",
        json!({ "memoryId": scoped.id }),
    )
    .expect("memories.delete must succeed");
    let after = dispatch_decoded::<ResultListMemories>(&kernel, "memories.list", json!({}))
        .expect("memories.list after delete must succeed");
    assert_eq!(after.items.len(), 1);
    assert_eq!(after.items[0].id, global.id);
}

/// M5 slice 3: memory error paths — unknown character, character scope
/// without id, missing record, malformed request.
#[test]
fn memory_error_paths() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let missing_memory = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let missing_character = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    // character scope without characterId → VALIDATION product error.
    let no_id = dispatch_json(
        &kernel,
        "memories.create",
        json!({ "scope": "character", "content": "orphaned" }),
    )
    .expect_err("character scope without characterId must fail");
    let product = no_id.product.expect("product dto");
    assert_eq!(product.code, "VALIDATION");

    // character scope with an unknown character → CHARACTER_NOT_FOUND.
    let unknown = dispatch_json(
        &kernel,
        "memories.create",
        json!({ "scope": "character", "characterId": missing_character, "content": "ghost" }),
    )
    .expect_err("character scope with unknown character must fail");
    assert_eq!(unknown.code, KernelErrorCode::NotFound);
    let product = unknown.product.expect("product dto");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");

    // update/delete on a missing memory → MEMORY_NOT_FOUND.
    let update_err = dispatch_json(
        &kernel,
        "memories.update",
        json!({ "memoryId": missing_memory, "content": "x" }),
    )
    .expect_err("update on a missing memory must fail");
    assert_eq!(update_err.code, KernelErrorCode::NotFound);
    let delete_err = dispatch_json(&kernel, "memories.delete", json!({ "memoryId": missing_memory }))
        .expect_err("delete on a missing memory must fail");
    assert_eq!(delete_err.code, KernelErrorCode::NotFound);

    // malformed request → contract violation.
    let violation = dispatch_json(
        &kernel,
        "memories.create",
        json!({ "content": 42 }),
    )
    .expect_err("non-string content must be a contract violation");
    assert_eq!(violation.code, KernelErrorCode::ContractViolation);
}
