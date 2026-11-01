//! Kernel character trash + version history tests (M7 Etap-4 cluster 26):
//! `characters.delete` is the SOFT delete the product UI uses (the row moves
//! to the trash, its chats and messages survive), `characters.restore` is its
//! inverse, `characters.versions.list` exposes the snapshot history every
//! edit records (ТЗ §10.2) and `characters.versions.restore` applies one
//! snapshot back — snapshotting the current state first, so a restore is
//! itself reversible. `purge: true` keeps the legacy hard-delete mode.

use contracts_generated::generated::{
    CharacterDto, PagedCharacters, PagedChats, ResultCharacterVersions, ResultEmpty,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};
use serde_json::{json, Value};

fn open_kernel_with_root(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

fn dispatch_decoded<T: serde::de::DeserializeOwned>(
    kernel: &Kernel,
    op: &str,
    request: Value,
) -> Result<T, KernelError> {
    dispatch_json(kernel, op, request)
        .map(|value| serde_json::from_value(value).expect("response must decode as the DTO"))
}

fn create_character(kernel: &Kernel, name: &str) -> String {
    let created: Value = dispatch_decoded(kernel, "characters.create", json!({ "name": name }))
        .expect("characters.create must succeed");
    created["id"].as_str().expect("id").to_string()
}

fn create_chat(kernel: &Kernel, character_id: &str, title: &str) -> String {
    let created: Value = dispatch_decoded(
        kernel,
        "chats.create",
        json!({ "characterId": character_id, "title": title }),
    )
    .expect("chats.create must succeed");
    created["id"].as_str().expect("chat id").to_string()
}

fn list_ids(kernel: &Kernel, include_deleted: bool) -> Vec<String> {
    let request = if include_deleted {
        json!({ "includeDeleted": true })
    } else {
        json!({})
    };
    let page: PagedCharacters =
        dispatch_decoded(kernel, "characters.list", request).expect("characters.list must succeed");
    page.items.into_iter().map(|item| item.id).collect()
}

/// Soft delete → trash → restore round trip: the character leaves the
/// library, keeps its chats and messages, and comes back unchanged.
#[test]
fn character_soft_delete_and_restore_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let character_id = create_character(&kernel, "Trashable");
    let chat_id = create_chat(&kernel, &character_id, "Kept chat");
    dispatch_decoded::<Value>(
        &kernel,
        "chats.messages.create",
        json!({ "chatId": chat_id, "role": "user", "content": "Survives the trash" }),
    )
    .expect("message must be created");

    // Soft delete (the default mode).
    dispatch_decoded::<ResultEmpty>(
        &kernel,
        "characters.delete",
        json!({ "characterId": character_id }),
    )
    .expect("soft delete must succeed");

    assert_eq!(
        list_ids(&kernel, false),
        Vec::<String>::new(),
        "a trashed character must leave the library list"
    );
    assert_eq!(
        list_ids(&kernel, true),
        vec![character_id.clone()],
        "includeDeleted must show the trash"
    );

    // The chats of a trashed character survive the soft delete (data
    // preservation, AGENTS.md §1.1) — they are simply not destroyed.
    let chats: PagedChats = dispatch_decoded(
        &kernel,
        "chats.list",
        json!({ "characterId": character_id }),
    )
    .expect("chats.list must succeed");
    assert_eq!(chats.items.len(), 1, "the chat must survive the trash");
    let messages: Value =
        dispatch_decoded(&kernel, "chats.messages.list", json!({ "chatId": chat_id }))
            .expect("messages must survive the trash");
    assert_eq!(messages["items"].as_array().map(Vec::len), Some(1));

    // Restore: the character returns to the library.
    let restored: CharacterDto = dispatch_decoded(
        &kernel,
        "characters.restore",
        json!({ "characterId": character_id }),
    )
    .expect("characters.restore must succeed");
    assert_eq!(restored.id, character_id);
    assert_eq!(restored.name, "Trashable");
    assert_eq!(list_ids(&kernel, false), vec![character_id.clone()]);

    // Restoring an active character is an idempotent no-op that still
    // answers with the character.
    let again: CharacterDto = dispatch_decoded(
        &kernel,
        "characters.restore",
        json!({ "characterId": character_id }),
    )
    .expect("restore of an active character must stay a no-op success");
    assert_eq!(again.id, character_id);

    // An unknown character is a stable product error.
    let err = dispatch_json(
        &kernel,
        "characters.restore",
        json!({ "characterId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
    )
    .expect_err("restore of an unknown character must fail");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    let product = err.product.expect("product error must carry the wire dto");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");
}

/// `purge: true` keeps the legacy hard-delete mode: the row and its chats
/// cascade away irreversibly.
#[test]
fn character_purge_deletes_permanently() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let character_id = create_character(&kernel, "Condemned");
    let chat_id = create_chat(&kernel, &character_id, "Doomed chat");

    dispatch_decoded::<ResultEmpty>(
        &kernel,
        "characters.delete",
        json!({ "characterId": character_id, "purge": true }),
    )
    .expect("purge must succeed");

    assert!(
        list_ids(&kernel, true).is_empty(),
        "a purged character is gone even from the trash"
    );
    let err = dispatch_json(
        &kernel,
        "characters.get",
        json!({ "characterId": character_id }),
    )
    .expect_err("a purged character must be unknown");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    let err = dispatch_json(&kernel, "chats.messages.list", json!({ "chatId": chat_id }))
        .expect_err("the chats of a purged character cascade away");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    // An unknown purge is still CHARACTER_NOT_FOUND.
    let err = dispatch_json(
        &kernel,
        "characters.delete",
        json!({ "characterId": character_id, "purge": true }),
    )
    .expect_err("purge of an unknown character must fail");
    assert_eq!(
        err.product.expect("product dto").code,
        "CHARACTER_NOT_FOUND"
    );
}

/// Version history: every edit snapshots the pre-edit state, the list is
/// newest-first, and restoring a snapshot applies it back while snapshotting
/// the state it replaced (a restore is reversible).
#[test]
fn character_version_history_and_restore() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let character_id = create_character(&kernel, "Original");

    // Two edits → two snapshots of the states they replaced.
    dispatch_decoded::<CharacterDto>(
        &kernel,
        "characters.update",
        json!({ "characterId": character_id, "name": "Second" }),
    )
    .expect("first edit must succeed");
    dispatch_decoded::<CharacterDto>(
        &kernel,
        "characters.update",
        json!({ "characterId": character_id, "description": "Third state" }),
    )
    .expect("second edit must succeed");

    let history: ResultCharacterVersions = dispatch_decoded(
        &kernel,
        "characters.versions.list",
        json!({ "characterId": character_id }),
    )
    .expect("versions.list must succeed");
    assert_eq!(
        history.items.len(),
        2,
        "each edit snapshots the state it replaced"
    );
    assert!(!history.truncated);
    // Newest first: version 2 is the pre-second-edit state ("Second").
    assert_eq!(history.items[0].version, 2);
    assert_eq!(history.items[1].version, 1);
    assert!(history
        .items
        .iter()
        .all(|item| item.character_id == character_id));

    // Restore version 1 (the pre-first-edit state: name "Original").
    let restored: CharacterDto = dispatch_decoded(
        &kernel,
        "characters.versions.restore",
        json!({ "characterId": character_id, "versionId": history.items[1].id }),
    )
    .expect("versions.restore must succeed");
    assert_eq!(restored.name, "Original");
    assert_eq!(restored.id, character_id, "the id never changes");

    // The restore itself was snapshotted: one more entry, newest first.
    let after: ResultCharacterVersions = dispatch_decoded(
        &kernel,
        "characters.versions.list",
        json!({ "characterId": character_id }),
    )
    .expect("versions.list after restore must succeed");
    assert_eq!(after.items.len(), 3, "the restore snapshots its pre-image");
    assert_eq!(after.items[0].version, 3);

    // Restoring that pre-image undoes the restore (reversibility).
    let undone: CharacterDto = dispatch_decoded(
        &kernel,
        "characters.versions.restore",
        json!({ "characterId": character_id, "versionId": after.items[0].id }),
    )
    .expect("restoring the pre-image must succeed");
    assert_eq!(undone.name, "Second");
    assert_eq!(undone.description.as_deref(), Some("Third state"));

    // Unknown version of a known character → product not-found.
    let err = dispatch_json(
        &kernel,
        "characters.versions.restore",
        json!({
            "characterId": character_id,
            "versionId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        }),
    )
    .expect_err("unknown version must fail");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    let product = err.product.expect("product error must carry the wire dto");
    assert_eq!(product.code, "CHARACTER_VERSION_NOT_FOUND");

    // Version history of an unknown character → CHARACTER_NOT_FOUND.
    let err = dispatch_json(
        &kernel,
        "characters.versions.list",
        json!({ "characterId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
    )
    .expect_err("versions of an unknown character must fail");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    assert_eq!(
        err.product.expect("product dto").code,
        "CHARACTER_NOT_FOUND"
    );
}

/// Card edits are versioned too: restoring a card snapshot brings the
/// previous card document back (unknown extension keys included).
#[test]
fn character_card_edit_versions_restore() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let character_id = create_character(&kernel, "Cardholder");

    dispatch_decoded::<Value>(
        &kernel,
        "characters.card.update",
        json!({
            "characterId": character_id,
            "card": { "name": "Cardholder", "first_mes": "First greeting", "x_custom": { "kept": true } }
        }),
    )
    .expect("first card write must succeed");
    dispatch_decoded::<Value>(
        &kernel,
        "characters.card.update",
        json!({
            "characterId": character_id,
            "card": { "name": "Cardholder", "first_mes": "Second greeting" }
        }),
    )
    .expect("second card write must succeed");

    let history: ResultCharacterVersions = dispatch_decoded(
        &kernel,
        "characters.versions.list",
        json!({ "characterId": character_id }),
    )
    .expect("versions.list must succeed");
    assert_eq!(history.items.len(), 2);

    // The old snapshot is the first card (empty before the first write).
    let restored: CharacterDto = dispatch_decoded(
        &kernel,
        "characters.versions.restore",
        json!({ "characterId": character_id, "versionId": history.items[1].id }),
    )
    .expect("restoring the pre-first-write state must succeed");
    assert_eq!(restored.id, character_id);
    let card: Value = dispatch_decoded(
        &kernel,
        "characters.card.get",
        json!({ "characterId": character_id }),
    )
    .expect("card.get must succeed");
    assert_eq!(
        card["card"],
        json!({}),
        "the first snapshot predates every card write"
    );

    // Restoring the state that carried the custom extension brings it back.
    let history_after: ResultCharacterVersions = dispatch_decoded(
        &kernel,
        "characters.versions.list",
        json!({ "characterId": character_id }),
    )
    .expect("versions.list after restore must succeed");
    assert_eq!(history_after.items.len(), 3);
    let with_extension = history_after
        .items
        .iter()
        .find(|item| item.version == 2)
        .expect("version 2 is the pre-second-write snapshot");
    dispatch_decoded::<CharacterDto>(
        &kernel,
        "characters.versions.restore",
        json!({ "characterId": character_id, "versionId": with_extension.id }),
    )
    .expect("restoring the card with the extension must succeed");
    let card: Value = dispatch_decoded(
        &kernel,
        "characters.card.get",
        json!({ "characterId": character_id }),
    )
    .expect("card.get must succeed");
    assert_eq!(card["card"]["first_mes"], json!("First greeting"));
    assert_eq!(card["card"]["x_custom"], json!({ "kept": true }));
}
