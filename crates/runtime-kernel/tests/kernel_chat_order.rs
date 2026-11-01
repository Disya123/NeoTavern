//! Kernel `chats.reorder` + `chats.list sort=manual` tests (M7 Etap-4
//! cluster 25): the persisted drag-and-drop order of a character's chats вЂ”
//! the leading block in the requested order, unlisted chats keep their
//! relative order below it; the manual list walk is cursor-paginated over
//! `(sort_order ASC, updated_at DESC, id DESC)`. Error paths mirror the
//! legacy plugin: duplicates в†’ VALIDATION, unknown character в†’
//! CHARACTER_NOT_FOUND, an id that is not that character's chat в†’
//! CHAT_NOT_FOUND.

use contracts_generated::generated::{ChatDto, PagedChats};
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

fn create_chat(kernel: &Kernel, character_id: &str, title: &str) -> ChatDto {
    dispatch_decoded::<ChatDto>(
        kernel,
        "chats.create",
        json!({ "characterId": character_id, "title": title }),
    )
    .expect("chats.create must succeed")
}

fn list_titles(kernel: &Kernel, character_id: &str, sort: Option<&str>) -> Vec<String> {
    let mut request = json!({ "characterId": character_id });
    if let Some(sort) = sort {
        request["sort"] = json!(sort);
    }
    let page: PagedChats =
        dispatch_decoded(kernel, "chats.list", request).expect("chats.list must succeed");
    page.items.iter().map(|chat| chat.title.clone()).collect()
}

#[test]
fn chats_reorder_round_trip_and_manual_list() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let character_id = create_character(&kernel, "Reorderer");

    let first = create_chat(&kernel, &character_id, "First");
    let second = create_chat(&kernel, &character_id, "Second");
    let third = create_chat(&kernel, &character_id, "Third");

    // Recent order (default): newest first.
    assert_eq!(
        list_titles(&kernel, &character_id, None),
        vec!["Third", "Second", "First"]
    );

    // Reorder a partial leading block [third, first]; the unlisted second
    // keeps its relative order below the block.
    let reordered: Value = dispatch_decoded(
        &kernel,
        "chats.reorder",
        json!({ "characterId": character_id, "order": [third.id, first.id] }),
    )
    .expect("chats.reorder must succeed");
    assert_eq!(reordered["reordered"], json!(2));

    // Manual order: [third, first, second].
    assert_eq!(
        list_titles(&kernel, &character_id, Some("manual")),
        vec!["Third", "First", "Second"]
    );
    // Recent order ignores the manual order.
    assert_eq!(
        list_titles(&kernel, &character_id, Some("recent")),
        vec!["Third", "Second", "First"]
    );

    // A NEW chat defaults to sort_order = 0 and surfaces on top ("manual
    // order + new on top").
    let _fourth = create_chat(&kernel, &character_id, "Fourth");
    assert_eq!(
        list_titles(&kernel, &character_id, Some("manual")),
        vec!["Fourth", "Third", "First", "Second"]
    );

    // Cursor pagination over the manual walk (limit 2 в†’ two pages).
    let page1: PagedChats = dispatch_decoded(
        &kernel,
        "chats.list",
        json!({ "characterId": character_id, "sort": "manual", "limit": 2 }),
    )
    .expect("manual page 1 must succeed");
    let titles1: Vec<String> = page1.items.iter().map(|chat| chat.title.clone()).collect();
    assert_eq!(titles1, vec!["Fourth", "Third"]);
    let cursor = page1.next_cursor.as_ref().expect("page 1 has a cursor");
    let page2: PagedChats = dispatch_decoded(
        &kernel,
        "chats.list",
        json!({
            "characterId": character_id,
            "sort": "manual",
            "limit": 2,
            "cursor": cursor
        }),
    )
    .expect("manual page 2 must succeed");
    let titles2: Vec<String> = page2.items.iter().map(|chat| chat.title.clone()).collect();
    assert_eq!(titles2, vec!["First", "Second"]);
    assert!(page2.next_cursor.is_none(), "last page carries no cursor");

    // A malformed manual cursor is a contract violation, never a panic.
    let malformed = dispatch_json(
        &kernel,
        "chats.list",
        json!({ "characterId": character_id, "sort": "manual", "cursor": "!!!" }),
    )
    .expect_err("malformed cursor must fail");
    assert_eq!(malformed.code, KernelErrorCode::ContractViolation);

    // Other characters are unaffected by the manual order.
    let other_id = create_character(&kernel, "Bystander");
    let _other_chat = create_chat(&kernel, &other_id, "Solo");
    assert_eq!(
        list_titles(&kernel, &other_id, Some("manual")),
        vec!["Solo"]
    );
}

#[test]
fn chats_reorder_error_paths() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let character_id = create_character(&kernel, "Owner");
    let chat = create_chat(&kernel, &character_id, "Owned");

    // Duplicate ids в†’ VALIDATION product error.
    let duplicate = dispatch_json(
        &kernel,
        "chats.reorder",
        json!({ "characterId": character_id, "order": [chat.id, chat.id] }),
    )
    .expect_err("duplicate ids must fail");
    assert_eq!(duplicate.product.expect("product dto").code, "VALIDATION");

    // Unknown character в†’ CHARACTER_NOT_FOUND.
    let unknown_character = dispatch_json(
        &kernel,
        "chats.reorder",
        json!({
            "characterId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "order": [chat.id]
        }),
    )
    .expect_err("unknown character must fail");
    assert_eq!(unknown_character.code, KernelErrorCode::NotFound);
    assert_eq!(
        unknown_character.product.expect("product dto").code,
        "CHARACTER_NOT_FOUND"
    );

    // An id that is not that character's chat в†’ CHAT_NOT_FOUND (parity with
    // the legacy plugin throwing on the first invalid id).
    let foreign = create_character(&kernel, "Foreign");
    let foreign_chat = create_chat(&kernel, &foreign, "Foreign chat");
    let not_owned = dispatch_json(
        &kernel,
        "chats.reorder",
        json!({ "characterId": character_id, "order": [foreign_chat.id] }),
    )
    .expect_err("a foreign chat id must fail");
    assert_eq!(not_owned.code, KernelErrorCode::NotFound);
    assert_eq!(
        not_owned.product.expect("product dto").code,
        "CHAT_NOT_FOUND"
    );

    // A partial-list reorder is idempotent: applying it twice converges.
    for _ in 0..2 {
        let result: Value = dispatch_decoded(
            &kernel,
            "chats.reorder",
            json!({ "characterId": character_id, "order": [chat.id] }),
        )
        .expect("idempotent reorder must succeed");
        assert_eq!(result["reordered"], json!(1));
    }
    let chats: PagedChats = dispatch_decoded(
        &kernel,
        "chats.list",
        json!({ "characterId": character_id, "sort": "manual" }),
    )
    .expect("manual list must succeed");
    assert_eq!(chats.items.len(), 1);
    assert_eq!(chats.items[0].title, "Owned");
}
