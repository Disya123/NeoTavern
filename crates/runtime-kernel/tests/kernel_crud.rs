//! Phase 3 kernel product-CRUD integration tests (ТЗ §78 Фаза 3).
//!
//! Exercises the product operations over a durable data root. Characters,
//! chats and messages are created/updated/deleted over the wire
//! (`chats_and_messages_crud_round_trip`); `chats_and_messages_flow` and the
//! list-only tests still seed lorebooks/presets/cursor fixtures directly
//! through `neotavern_storage` BEFORE the kernel opens (the kernel then holds
//! the single writable connection for its lifetime).

use contracts_generated::generated::{
    CharacterDto, ChatDto, MessageDto, MessageRole, PagedCharacters, PagedChats, PagedMessages,
    ResultEmpty, ResultListLorebooks, ResultListPresets,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};
use rusqlite::params;
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

/// Opens a fresh data root with `neotavern_storage`, runs `seed` against a
/// transaction, and releases the lease so a kernel can take it over.
fn seed_data_root(root: &std::path::Path, seed: impl FnOnce(&rusqlite::Transaction<'_>)) {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("fresh data root must open");
    db.transaction(|tx| {
        seed(tx);
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
    drop(db); // release the lease before the kernel takes the root
}

#[test]
fn character_create_get_update_delete_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let created = dispatch_json(
        &kernel,
        "characters.create",
        json!({ "name": "Aria", "description": "A wandering bard", "tags": ["bard", "music"] }),
    )
    .expect("create must succeed");
    let character: CharacterDto =
        serde_json::from_value(created).expect("create response must be a CharacterDto");
    assert!(
        uuid::Uuid::parse_str(&character.id).is_ok(),
        "id must be a uuid: {}",
        character.id
    );
    assert_eq!(character.name, "Aria");
    assert_eq!(character.description.as_deref(), Some("A wandering bard"));
    assert_eq!(
        character.tags,
        vec!["bard".to_string(), "music".to_string()]
    );
    assert_eq!(character.avatar_asset_id, None);
    assert_eq!(character.updated_at, character.created_at);
    let character_id = character.id.clone();
    let created_at = character.created_at.clone();

    // get → identical
    let fetched = dispatch_decoded::<CharacterDto>(
        &kernel,
        "characters.get",
        json!({ "characterId": character_id }),
    )
    .expect("get must succeed");
    assert_eq!(fetched, character);

    // Wait for the RFC3339 second to tick so the updatedAt change is
    // observable (timestamps are seconds precision).
    std::thread::sleep(std::time::Duration::from_millis(1100));

    // update name + tags only; description must be preserved
    let updated = dispatch_decoded::<CharacterDto>(
        &kernel,
        "characters.update",
        json!({ "characterId": character_id, "name": "Aria the Swift", "tags": ["bard", "rogue"] }),
    )
    .expect("update must succeed");
    assert_eq!(updated.name, "Aria the Swift");
    assert_eq!(
        updated.description.as_deref(),
        Some("A wandering bard"),
        "description must be preserved by a partial update"
    );
    assert_eq!(updated.tags, vec!["bard".to_string(), "rogue".to_string()]);
    assert_ne!(updated.updated_at, created_at, "updatedAt must change");
    assert_eq!(updated.created_at, created_at, "createdAt must not change");

    // delete → empty result
    let deleted = dispatch_decoded::<ResultEmpty>(
        &kernel,
        "characters.delete",
        json!({ "characterId": character_id }),
    )
    .expect("delete must succeed");
    assert_eq!(deleted, ResultEmpty {});

    // get after delete → product error with stable code + params
    let err = dispatch_json(
        &kernel,
        "characters.get",
        json!({ "characterId": character_id }),
    )
    .expect_err("get after delete must fail");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    let product = err.product.expect("product error must carry the wire dto");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");
    assert_eq!(product.params["characterId"], json!(character_id));

    // delete again → same product error
    let err = dispatch_json(
        &kernel,
        "characters.delete",
        json!({ "characterId": character_id }),
    )
    .expect_err("delete after delete must fail");
    let product = err.product.expect("product error must carry the wire dto");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");
    assert_eq!(product.params["characterId"], json!(character_id));
}

#[test]
fn characters_list_cursor_pagination() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    for i in 0..5 {
        let created = dispatch_decoded::<CharacterDto>(
            &kernel,
            "characters.create",
            json!({ "name": format!("Character {i}") }),
        )
        .expect("create must succeed");
        assert!(!created.id.is_empty());
    }

    // page 1: limit 2 → 2 items + a cursor
    let page1 =
        dispatch_decoded::<PagedCharacters>(&kernel, "characters.list", json!({ "limit": 2 }))
            .expect("page 1");
    assert_eq!(page1.items.len(), 2);
    let cursor1 = page1
        .next_cursor
        .clone()
        .expect("non-final page must carry a cursor");

    // follow the cursor twice → all 5 ids exactly once; final page has no cursor
    let page2 = dispatch_decoded::<PagedCharacters>(
        &kernel,
        "characters.list",
        json!({ "limit": 2, "cursor": cursor1 }),
    )
    .expect("page 2");
    assert_eq!(page2.items.len(), 2);
    let cursor2 = page2
        .next_cursor
        .clone()
        .expect("page 2 must carry a cursor");
    let page3 = dispatch_decoded::<PagedCharacters>(
        &kernel,
        "characters.list",
        json!({ "limit": 2, "cursor": cursor2 }),
    )
    .expect("page 3");
    assert_eq!(page3.items.len(), 1);
    assert!(
        page3.next_cursor.is_none(),
        "final page must not carry a cursor"
    );

    let mut seen: Vec<String> = page1
        .items
        .iter()
        .chain(page2.items.iter())
        .chain(page3.items.iter())
        .map(|item| item.id.clone())
        .collect();
    seen.sort();
    seen.dedup();
    assert_eq!(
        seen.len(),
        5,
        "all five characters must be returned exactly once across pages"
    );

    // default limit: no limit → everything on one page, no cursor
    let all = dispatch_decoded::<PagedCharacters>(&kernel, "characters.list", json!({}))
        .expect("unpaginated list");
    assert_eq!(all.items.len(), 5);
    assert!(all.next_cursor.is_none());

    // cursor stability: a 6th character created after page 1 must NOT appear
    // when following the original cursor (ids are time-ordered).
    let sixth = dispatch_decoded::<CharacterDto>(
        &kernel,
        "characters.create",
        json!({ "name": "Late arrival" }),
    )
    .expect("create 6th");
    let page2_again = dispatch_decoded::<PagedCharacters>(
        &kernel,
        "characters.list",
        json!({ "limit": 2, "cursor": cursor1 }),
    )
    .expect("page 2 after insert");
    assert!(
        page2_again.items.iter().all(|item| item.id != sixth.id),
        "a row created after the cursor was taken must not appear on later pages"
    );
}

#[test]
fn chats_and_messages_flow() {
    let root = tempfile::tempdir().expect("tempdir");
    let character_id = "11111111-1111-4111-8111-111111111111";
    let chat_id = "22222222-2222-4222-8222-222222222222";
    let chat_id2 = "33333333-3333-4333-8333-333333333333";
    // Seed BEFORE the kernel opens: chats/messages have no create wire
    // operation in the frozen registry.
    seed_data_root(root.path(), |tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES (?1, 'Aria', NULL, NULL, '[]', '{}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
            params![character_id],
        )
        .expect("seed character");
        for (id, title) in [(chat_id, "First chat"), (chat_id2, "Second chat")] {
            tx.execute(
                "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
                params![id, title, character_id],
            )
            .expect("seed chat");
        }
        for (i, (msg_id, role, content)) in [
            ("44444444-4444-4444-8444-444444444444", "user", "Hello"),
            (
                "55555555-5555-4555-8555-555555555555",
                "assistant",
                "Hi there",
            ),
            (
                "66666666-6666-4666-8666-666666666666",
                "user",
                "Tell me a story",
            ),
            (
                "77777777-7777-4777-8777-777777777777",
                "assistant",
                "Once upon a time",
            ),
        ]
        .iter()
        .enumerate()
        {
            tx.execute(
                "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, '2026-08-13T00:02:00Z')",
                params![msg_id, chat_id, role, content, i as i64],
            )
            .expect("seed message");
        }
    });

    let kernel = open_kernel_with_root(root.path());

    // a character created over the wire has no chats yet
    let wire_character = dispatch_decoded::<CharacterDto>(
        &kernel,
        "characters.create",
        json!({ "name": "Via wire" }),
    )
    .expect("create must succeed");
    let empty = dispatch_decoded::<PagedChats>(
        &kernel,
        "chats.list",
        json!({ "characterId": wire_character.id }),
    )
    .expect("chats.list for a chatless character");
    assert!(empty.items.is_empty());

    // chats.list: both seeded chats for the seeded character, newest first
    // (equal created_at → id DESC tiebreak).
    let listed = dispatch_decoded::<PagedChats>(
        &kernel,
        "chats.list",
        json!({ "characterId": character_id }),
    )
    .expect("chats.list must succeed");
    assert_eq!(listed.items.len(), 2);
    assert_eq!(listed.items[0].id, chat_id2);
    assert_eq!(listed.items[0].message_count, 0);
    assert_eq!(listed.items[1].id, chat_id);
    assert_eq!(listed.items[1].message_count, 4);
    assert!(listed.next_cursor.is_none());

    // chats.get: message_count via subquery
    let chat = dispatch_decoded::<ChatDto>(&kernel, "chats.get", json!({ "chatId": chat_id }))
        .expect("chats.get must succeed");
    assert_eq!(chat.title, "First chat");
    assert_eq!(chat.character_id, character_id);
    assert_eq!(chat.message_count, 4);

    // messages.list: sequence ASC, roles decoded
    let messages = dispatch_decoded::<PagedMessages>(
        &kernel,
        "chats.messages.list",
        json!({ "chatId": chat_id }),
    )
    .expect("messages.list must succeed");
    assert_eq!(messages.items.len(), 4);
    assert!(messages.next_cursor.is_none());
    for (i, message) in messages.items.iter().enumerate() {
        assert_eq!(message.sequence, i as i64);
        assert_eq!(message.chat_id, chat_id);
        assert_eq!(message.generation_run_id, None);
    }
    assert_eq!(messages.items[0].role, MessageRole::User);
    assert_eq!(messages.items[1].role, MessageRole::Assistant);

    // cursor pagination over (sequence, id) — ascending pages of 2
    let page1 = dispatch_decoded::<PagedMessages>(
        &kernel,
        "chats.messages.list",
        json!({ "chatId": chat_id, "limit": 2 }),
    )
    .expect("messages page 1");
    assert_eq!(page1.items.len(), 2);
    assert_eq!(page1.items[0].sequence, 0);
    assert_eq!(page1.items[1].sequence, 1);
    let cursor = page1.next_cursor.clone().expect("cursor");
    let page2 = dispatch_decoded::<PagedMessages>(
        &kernel,
        "chats.messages.list",
        json!({ "chatId": chat_id, "limit": 2, "cursor": cursor }),
    )
    .expect("messages page 2");
    assert_eq!(page2.items.len(), 2);
    assert_eq!(page2.items[0].sequence, 2);
    assert_eq!(page2.items[1].sequence, 3);
    assert!(page2.next_cursor.is_none());

    // missing chat → CHAT_NOT_FOUND (not an empty page)
    let missing_chat = "99999999-9999-4999-8999-999999999999";
    let err = dispatch_json(
        &kernel,
        "chats.messages.list",
        json!({ "chatId": missing_chat }),
    )
    .expect_err("messages for a missing chat must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "CHAT_NOT_FOUND");
    assert_eq!(product.params["chatId"], json!(missing_chat));
}

#[test]
fn chats_and_messages_crud_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    // --- chats.create.
    let character =
        dispatch_decoded::<CharacterDto>(&kernel, "characters.create", json!({ "name": "Aria" }))
            .expect("character must be created");
    let character_id = character.id.clone();

    // default title when omitted
    let default_chat = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.create",
        json!({ "characterId": character_id }),
    )
    .expect("chats.create with default title");
    assert_eq!(default_chat.title, "New chat");
    assert_eq!(default_chat.character_id, character_id);
    assert_eq!(default_chat.message_count, 0);
    assert!(uuid::Uuid::parse_str(&default_chat.id).is_ok());

    // explicit title
    let chat = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.create",
        json!({ "characterId": character_id, "title": "The journey" }),
    )
    .expect("chats.create with explicit title");
    assert_eq!(chat.title, "The journey");
    assert_eq!(chat.message_count, 0);
    let chat_id = chat.id.clone();

    // missing character → CHARACTER_NOT_FOUND
    let missing_character = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let err = dispatch_json(
        &kernel,
        "chats.create",
        json!({ "characterId": missing_character }),
    )
    .expect_err("chats.create for a missing character must fail");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    let product = err.product.expect("product error must carry the wire dto");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");
    assert_eq!(product.params["characterId"], json!(missing_character));

    // --- chats.update.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let renamed = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.update",
        json!({ "chatId": chat_id, "title": "The journey, part two" }),
    )
    .expect("chats.update must succeed");
    assert_eq!(renamed.title, "The journey, part two");
    assert_eq!(renamed.message_count, 0);
    assert_ne!(renamed.updated_at, chat.updated_at, "updatedAt must change");
    assert_eq!(
        renamed.created_at, chat.created_at,
        "createdAt must not change"
    );

    let missing_chat = "99999999-9999-4999-8999-999999999999";
    let err = dispatch_json(
        &kernel,
        "chats.update",
        json!({ "chatId": missing_chat, "title": "Ghost" }),
    )
    .expect_err("chats.update on a missing chat must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "CHAT_NOT_FOUND");
    assert_eq!(product.params["chatId"], json!(missing_chat));

    // --- chats.messages.create: sequences are allocated atomically 0..2.
    let m0 = dispatch_decoded::<MessageDto>(
        &kernel,
        "chats.messages.create",
        json!({ "chatId": chat_id, "role": "user", "content": "Hello" }),
    )
    .expect("first message");
    assert_eq!(m0.sequence, 0);
    assert_eq!(m0.role, MessageRole::User);
    assert_eq!(m0.generation_run_id, None);

    let m1 = dispatch_decoded::<MessageDto>(
        &kernel,
        "chats.messages.create",
        json!({ "chatId": chat_id, "role": "assistant", "content": "Hi there" }),
    )
    .expect("second message");
    assert_eq!(m1.sequence, 1);
    assert_eq!(m1.role, MessageRole::Assistant);

    // generationRunId passthrough
    let run_id = "6e7f8091-ab2c-4d3e-9f4a-5b6c7d8e9f01";
    let m2 = dispatch_decoded::<MessageDto>(
        &kernel,
        "chats.messages.create",
        json!({
            "chatId": chat_id,
            "role": "tool",
            "content": "{\"ok\":true}",
            "generationRunId": run_id
        }),
    )
    .expect("third message");
    assert_eq!(m2.sequence, 2);
    assert_eq!(m2.role, MessageRole::Tool);
    assert_eq!(m2.generation_run_id.as_deref(), Some(run_id));

    // chat messageCount now reflects the three appended messages
    let chat_after =
        dispatch_decoded::<ChatDto>(&kernel, "chats.get", json!({ "chatId": chat_id }))
            .expect("chats.get after append");
    assert_eq!(chat_after.message_count, 3);

    // missing chat → CHAT_NOT_FOUND
    let err = dispatch_json(
        &kernel,
        "chats.messages.create",
        json!({ "chatId": missing_chat, "role": "user", "content": "x" }),
    )
    .expect_err("messages.create for a missing chat must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "CHAT_NOT_FOUND");
    assert_eq!(product.params["chatId"], json!(missing_chat));

    // --- chats.messages.update: content edit, role/sequence preserved.
    let edited = dispatch_decoded::<MessageDto>(
        &kernel,
        "chats.messages.update",
        json!({ "chatId": chat_id, "messageId": m1.id, "content": "Hello yourself" }),
    )
    .expect("messages.update must succeed");
    assert_eq!(edited.content, "Hello yourself");
    assert_eq!(edited.role, MessageRole::Assistant);
    assert_eq!(edited.sequence, 1);
    assert_eq!(edited.id, m1.id);

    // update with the wrong chatId → MESSAGE_NOT_FOUND
    let err = dispatch_json(
        &kernel,
        "chats.messages.update",
        json!({ "chatId": missing_chat, "messageId": m1.id, "content": "x" }),
    )
    .expect_err("messages.update scoped to a missing chat must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "MESSAGE_NOT_FOUND");
    assert_eq!(product.params["messageId"], json!(m1.id));

    // --- chats.messages.delete.
    let deleted = dispatch_decoded::<ResultEmpty>(
        &kernel,
        "chats.messages.delete",
        json!({ "chatId": chat_id, "messageId": m2.id }),
    )
    .expect("messages.delete must succeed");
    assert_eq!(deleted, ResultEmpty {});
    let remaining = dispatch_decoded::<PagedMessages>(
        &kernel,
        "chats.messages.list",
        json!({ "chatId": chat_id }),
    )
    .expect("messages.list after delete");
    assert_eq!(remaining.items.len(), 2);
    assert!(remaining.items.iter().all(|m| m.id != m2.id));

    // delete again → MESSAGE_NOT_FOUND
    let err = dispatch_json(
        &kernel,
        "chats.messages.delete",
        json!({ "chatId": chat_id, "messageId": m2.id }),
    )
    .expect_err("messages.delete after delete must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "MESSAGE_NOT_FOUND");
    assert_eq!(product.params["messageId"], json!(m2.id));

    // --- chats.delete cascades to messages.
    let deleted =
        dispatch_decoded::<ResultEmpty>(&kernel, "chats.delete", json!({ "chatId": chat_id }))
            .expect("chats.delete must succeed");
    assert_eq!(deleted, ResultEmpty {});

    let err = dispatch_json(&kernel, "chats.get", json!({ "chatId": chat_id }))
        .expect_err("chats.get after delete must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "CHAT_NOT_FOUND");
    assert_eq!(product.params["chatId"], json!(chat_id));

    // the default-title chat survives; its message count stays 0
    let survived =
        dispatch_decoded::<ChatDto>(&kernel, "chats.get", json!({ "chatId": default_chat.id }))
            .expect("the other chat must survive");
    assert_eq!(survived.message_count, 0);

    // chats.delete again → CHAT_NOT_FOUND
    let err = dispatch_json(&kernel, "chats.delete", json!({ "chatId": chat_id }))
        .expect_err("chats.delete after delete must fail");
    let product = err.product.expect("product error");
    assert_eq!(product.code, "CHAT_NOT_FOUND");
    assert_eq!(product.params["chatId"], json!(chat_id));
}

#[test]
fn lorebooks_and_presets_list() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_data_root(root.path(), |tx| {
        for (id, name, entries) in [
            (
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "World lore",
                r#"[{"name":"capital"},{"name":"guilds"}]"#,
            ),
            ("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Companions", "[]"),
        ] {
            tx.execute(
                "INSERT INTO lorebooks (id, name, description, entries_json, created_at, updated_at) \
                 VALUES (?1, ?2, NULL, ?3, '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
                params![id, name, entries],
            )
            .expect("seed lorebook");
        }
        for (id, name) in [
            ("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Balanced"),
            ("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "Creative"),
        ] {
            tx.execute(
                "INSERT INTO presets (id, name, settings_json, created_at, updated_at) \
                 VALUES (?1, ?2, '{}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
                params![id, name],
            )
            .expect("seed preset");
        }
    });
    let kernel = open_kernel_with_root(root.path());

    // lorebooks.list: entry_count == json_array_length(entries_json),
    // newest first (equal created_at → id DESC tiebreak).
    let lorebooks = dispatch_decoded::<ResultListLorebooks>(&kernel, "lorebooks.list", json!({}))
        .expect("lorebooks.list must succeed");
    assert_eq!(lorebooks.items.len(), 2);
    assert_eq!(
        lorebooks.items[0].id,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    );
    assert_eq!(lorebooks.items[0].name, "Companions");
    assert_eq!(lorebooks.items[0].entry_count, 0);
    assert_eq!(
        lorebooks.items[1].id,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
    assert_eq!(lorebooks.items[1].name, "World lore");
    assert_eq!(lorebooks.items[1].entry_count, 2);
    assert_eq!(lorebooks.items[1].description, None);

    // presets.list: same ordering rules
    let presets = dispatch_decoded::<ResultListPresets>(&kernel, "presets.list", json!({}))
        .expect("presets.list must succeed");
    assert_eq!(presets.items.len(), 2);
    assert_eq!(presets.items[0].id, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    assert_eq!(presets.items[0].name, "Creative");
    assert_eq!(presets.items[1].id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    assert_eq!(presets.items[1].name, "Balanced");
}

#[test]
fn product_errors_have_stable_codes_and_params() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let missing = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let err = dispatch_json(&kernel, "characters.get", json!({ "characterId": missing }))
        .expect_err("missing character must fail");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    let product = err.product.expect("product error must carry the wire dto");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");
    assert_eq!(product.params["characterId"], json!(missing));
    assert_eq!(product.trace_id, None);
    assert_eq!(product.correlation_id, None);

    // malformed cursor → ContractViolation (no product payload), no panic
    let err = dispatch_json(
        &kernel,
        "characters.list",
        json!({ "cursor": "%%%not-base64%%%" }),
    )
    .expect_err("malformed cursor must fail");
    assert_eq!(err.code, KernelErrorCode::ContractViolation);
    assert!(err.product.is_none());

    // well-formed base64 without the "created_at|id" separator
    let err = dispatch_json(
        &kernel,
        "characters.list",
        json!({ "cursor": "bm8tc2VwYXJhdG9y" }),
    )
    .expect_err("cursor without separator must fail");
    assert_eq!(err.code, KernelErrorCode::ContractViolation);

    // non-uuid characterId → ContractViolation from the generated checker
    let err = dispatch_json(
        &kernel,
        "characters.get",
        json!({ "characterId": "not-a-uuid" }),
    )
    .expect_err("non-uuid id must fail");
    assert_eq!(err.code, KernelErrorCode::ContractViolation);
}

#[test]
fn stateless_kernel_rejects_product_ops() {
    let kernel = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: None,
    })
    .expect("stateless kernel must open");

    let err = dispatch_json(&kernel, "characters.list", json!({}))
        .expect_err("stateless kernel must reject product ops");
    assert_eq!(err.code, KernelErrorCode::StorageFailure);
    assert!(err.product.is_none());
    assert!(
        err.message.contains("durable storage"),
        "message should explain the storage requirement: {}",
        err.message
    );

    // writes are rejected the same way
    let err = dispatch_json(&kernel, "characters.create", json!({ "name": "Ghost" }))
        .expect_err("stateless kernel must reject product writes");
    assert_eq!(err.code, KernelErrorCode::StorageFailure);

    // meta.get stays stateless-capable
    let meta = dispatch_json(&kernel, "meta.get", json!({})).expect("meta.get must stay stateless");
    assert_eq!(meta["appVersion"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn update_on_missing_returns_product_error() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let missing = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let err = dispatch_json(
        &kernel,
        "characters.update",
        json!({ "characterId": missing, "name": "Ghost" }),
    )
    .expect_err("update on a missing character must fail");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    let product = err.product.expect("product error must carry the wire dto");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");
    assert_eq!(product.params["characterId"], json!(missing));
}
