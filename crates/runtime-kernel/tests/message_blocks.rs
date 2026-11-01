//! Durable message block attachment tests (rev4 stage 4, M7 Этап-4
//! cluster 15).
//!
//! Covers the four `blocks` wire operations end to end: attach a block to a
//! message of a chat, read a page of attachments with one batched call, patch
//! (and explicitly clear) the persisted renderer state, detach by id — plus
//! the honest refusals: an unknown chat/message/plugin/block never becomes a
//! silent success, ids from another chat are never leaked, the conflicting
//! state patch is a VALIDATION, and uninstalling the plugin cascades its
//! attachments away.

use contracts_generated::generated::{
    decode_message_block_item, decode_result_chats_blocks_list, MessageBlockItem,
    ResultChatsBlocksList,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};

const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const OTHER_CHAT_ID: &str = "00000000-0000-4000-8000-000000000002";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000003";
const MESSAGE_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_MESSAGE_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLUGIN_ID: &str = "lorebook-searcher";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

/// Seeds a character, two chats (each with one message) and the plugin
/// registry row the attachment FK points at, then releases the lease.
fn seed(root: &std::path::Path) {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("fresh data root must open");
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, tags_json, ext_json, created_at, updated_at) \
             VALUES (?1, 'Aria', 'Aria the cheerful guide.', '[]', '{}', \
             '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
            rusqlite::params![CHARACTER_ID],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) VALUES \
             (?1, 'Blocks', ?3, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z'), \
             (?2, 'Other', ?3, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
            rusqlite::params![CHAT_ID, OTHER_CHAT_ID, CHARACTER_ID],
        )
        .expect("seed chats");
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) VALUES \
             (?1, ?3, 'user', 'Hello Aria', 1, '2026-08-13T00:02:00Z'), \
             (?2, ?4, 'user', 'Hello elsewhere', 1, '2026-08-13T00:02:00Z')",
            rusqlite::params![MESSAGE_ID, OTHER_MESSAGE_ID, CHAT_ID, OTHER_CHAT_ID],
        )
        .expect("seed messages");
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
    drop(db);
}

fn install_plugin(kernel: &Kernel) {
    dispatch(
        kernel,
        "plugins.install",
        serde_json::json!({
            "id": PLUGIN_ID,
            "name": "Lorebook Searcher",
            "version": "1.2.0",
            "trustState": "verified-publisher",
            "permissions": ["plugin.storage", "ui.messageBlock"],
        }),
    );
}

fn dispatch(kernel: &Kernel, op: &str, request: serde_json::Value) -> Vec<u8> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .expect("dispatch must succeed")
}

fn dispatch_error(kernel: &Kernel, op: &str, request: serde_json::Value) -> KernelError {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .expect_err("dispatch must fail")
}

fn attach(kernel: &Kernel, chat_id: &str, message_id: &str) -> MessageBlockItem {
    attach_with(
        kernel,
        chat_id,
        message_id,
        serde_json::json!({ "title": "Context meter" }),
    )
}

fn attach_with(
    kernel: &Kernel,
    chat_id: &str,
    message_id: &str,
    descriptor: serde_json::Value,
) -> MessageBlockItem {
    let bytes = dispatch(
        kernel,
        "chats.blocks.attach",
        serde_json::json!({
            "chatId": chat_id,
            "messageId": message_id,
            "blockType": "meter",
            "rendererId": "blk:meter",
            "pluginId": PLUGIN_ID,
            "descriptor": descriptor,
        }),
    );
    decode_message_block_item(&bytes).expect("attach response must decode")
}

fn list(kernel: &Kernel, chat_id: &str, message_ids: &[&str]) -> ResultChatsBlocksList {
    let bytes = dispatch(
        kernel,
        "chats.blocks.list",
        serde_json::json!({ "chatId": chat_id, "messageIds": message_ids }),
    );
    decode_result_chats_blocks_list(&bytes).expect("list response must decode")
}

/// Product code of a kernel error (`product` payload), or the error class.
fn product_code(err: &KernelError) -> String {
    match &err.product {
        Some(dto) => dto.code.clone(),
        None => format!("{:?}", err.code),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn blocks_attach_list_update_clear_delete_roundtrip() {
    let root = tempfile::tempdir().expect("tempdir");
    seed(root.path());
    let kernel = open_kernel(root.path());
    install_plugin(&kernel);

    let attached = attach(&kernel, CHAT_ID, MESSAGE_ID);
    assert_eq!(attached.plugin_id, PLUGIN_ID);
    assert_eq!(attached.block_type, "meter");
    assert_eq!(attached.renderer_id, "blk:meter");
    assert_eq!(attached.message_id, MESSAGE_ID);
    assert_eq!(attached.descriptor.payload["title"], "Context meter");
    assert!(
        attached.serialized_state.is_none(),
        "fresh attachment has no state"
    );

    let page = list(&kernel, CHAT_ID, &[MESSAGE_ID]);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, attached.id);

    // Patch: persist the renderer state captured by `blocks.freeze`.
    let updated = decode_message_block_item(&dispatch(
        &kernel,
        "blocks.update",
        serde_json::json!({ "blockId": attached.id, "serializedState": { "count": 9 } }),
    ))
    .expect("update response must decode");
    assert_eq!(
        updated
            .serialized_state
            .as_ref()
            .map(|state| &state.payload),
        Some(&serde_json::json!({ "count": 9 }))
    );
    assert_eq!(updated.descriptor, attached.descriptor, "descriptor kept");

    // The stored state is durable: a second read sees it.
    let page = list(&kernel, CHAT_ID, &[MESSAGE_ID]);
    assert_eq!(
        page.items[0]
            .serialized_state
            .as_ref()
            .map(|state| &state.payload),
        Some(&serde_json::json!({ "count": 9 }))
    );

    // Explicit clear (the wire spelling of the legacy `serializedState: null`).
    let cleared = decode_message_block_item(&dispatch(
        &kernel,
        "blocks.update",
        serde_json::json!({ "blockId": attached.id, "clearSerializedState": true }),
    ))
    .expect("clear response must decode");
    assert!(cleared.serialized_state.is_none(), "state must be cleared");

    // Detach, then the batch read is empty again.
    let empty = dispatch(
        &kernel,
        "blocks.delete",
        serde_json::json!({ "blockId": attached.id }),
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&empty).expect("empty result decodes"),
        serde_json::json!({})
    );
    assert!(list(&kernel, CHAT_ID, &[MESSAGE_ID]).items.is_empty());
}

#[test]
fn blocks_attach_defaults_the_descriptor_to_an_empty_object() {
    let root = tempfile::tempdir().expect("tempdir");
    seed(root.path());
    let kernel = open_kernel(root.path());
    install_plugin(&kernel);

    let bytes = dispatch(
        &kernel,
        "chats.blocks.attach",
        serde_json::json!({
            "chatId": CHAT_ID,
            "messageId": MESSAGE_ID,
            "blockType": "meter",
            "rendererId": "blk:meter",
            "pluginId": PLUGIN_ID,
        }),
    );
    let attached = decode_message_block_item(&bytes).expect("attach response must decode");
    assert_eq!(attached.descriptor.payload, serde_json::json!({}));
}

#[test]
fn blocks_list_never_leaks_another_chats_messages() {
    let root = tempfile::tempdir().expect("tempdir");
    seed(root.path());
    let kernel = open_kernel(root.path());
    install_plugin(&kernel);

    attach(&kernel, OTHER_CHAT_ID, OTHER_MESSAGE_ID);

    // Asking chat A for a message id that lives in chat B returns nothing: the
    // attachment exists, but it is not this chat's business.
    let page = list(&kernel, CHAT_ID, &[OTHER_MESSAGE_ID]);
    assert!(
        page.items.is_empty(),
        "foreign message attachments must not leak"
    );
    // The owner chat still sees it.
    assert_eq!(
        list(&kernel, OTHER_CHAT_ID, &[OTHER_MESSAGE_ID])
            .items
            .len(),
        1
    );
}

#[test]
fn blocks_attach_refuses_unknown_chat_message_and_plugin() {
    let root = tempfile::tempdir().expect("tempdir");
    seed(root.path());
    let kernel = open_kernel(root.path());
    install_plugin(&kernel);

    let unknown_chat = dispatch_error(
        &kernel,
        "chats.blocks.attach",
        serde_json::json!({
            "chatId": "00000000-0000-4000-8000-0000000000ff",
            "messageId": MESSAGE_ID,
            "blockType": "meter",
            "rendererId": "blk:meter",
            "pluginId": PLUGIN_ID,
        }),
    );
    assert_eq!(unknown_chat.code, KernelErrorCode::NotFound);
    assert_eq!(product_code(&unknown_chat), "CHAT_NOT_FOUND");

    // A message that exists but belongs to another chat is MESSAGE_NOT_FOUND,
    // exactly like the legacy route.
    let foreign_message = dispatch_error(
        &kernel,
        "chats.blocks.attach",
        serde_json::json!({
            "chatId": CHAT_ID,
            "messageId": OTHER_MESSAGE_ID,
            "blockType": "meter",
            "rendererId": "blk:meter",
            "pluginId": PLUGIN_ID,
        }),
    );
    assert_eq!(foreign_message.code, KernelErrorCode::NotFound);
    assert_eq!(product_code(&foreign_message), "MESSAGE_NOT_FOUND");

    // An attachment may only belong to a plugin the registry knows; the
    // refusal is explicit instead of an opaque FK failure.
    let unknown_plugin = dispatch_error(
        &kernel,
        "chats.blocks.attach",
        serde_json::json!({
            "chatId": CHAT_ID,
            "messageId": MESSAGE_ID,
            "blockType": "meter",
            "rendererId": "blk:meter",
            "pluginId": "never-installed",
        }),
    );
    assert_eq!(unknown_plugin.code, KernelErrorCode::NotFound);
    assert_eq!(product_code(&unknown_plugin), "PLUGIN_NOT_FOUND");

    assert!(list(&kernel, CHAT_ID, &[MESSAGE_ID]).items.is_empty());
}

#[test]
fn blocks_update_refuses_conflicting_state_patch_and_unknown_block() {
    let root = tempfile::tempdir().expect("tempdir");
    seed(root.path());
    let kernel = open_kernel(root.path());
    install_plugin(&kernel);
    let attached = attach(&kernel, CHAT_ID, MESSAGE_ID);

    let conflict = dispatch_error(
        &kernel,
        "blocks.update",
        serde_json::json!({
            "blockId": attached.id,
            "serializedState": { "count": 1 },
            "clearSerializedState": true,
        }),
    );
    assert_eq!(product_code(&conflict), "VALIDATION");

    let unknown = dispatch_error(
        &kernel,
        "blocks.update",
        serde_json::json!({
            "blockId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "serializedState": { "count": 1 },
        }),
    );
    assert_eq!(unknown.code, KernelErrorCode::NotFound);
    assert_eq!(product_code(&unknown), "BLOCK_NOT_FOUND");

    let delete_unknown = dispatch_error(
        &kernel,
        "blocks.delete",
        serde_json::json!({ "blockId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    );
    assert_eq!(delete_unknown.code, KernelErrorCode::NotFound);
    assert_eq!(product_code(&delete_unknown), "BLOCK_NOT_FOUND");

    // Nothing above touched the real attachment.
    let page = list(&kernel, CHAT_ID, &[MESSAGE_ID]);
    assert_eq!(page.items.len(), 1);
    assert!(page.items[0].serialized_state.is_none());
}

#[test]
fn blocks_cascade_with_plugin_uninstall() {
    let root = tempfile::tempdir().expect("tempdir");
    seed(root.path());
    let kernel = open_kernel(root.path());
    install_plugin(&kernel);
    attach(&kernel, CHAT_ID, MESSAGE_ID);
    assert_eq!(list(&kernel, CHAT_ID, &[MESSAGE_ID]).items.len(), 1);

    dispatch(
        &kernel,
        "plugins.uninstall",
        serde_json::json!({ "id": PLUGIN_ID }),
    );

    // The FK cascade removes the plugin's attachments: no orphans after an
    // uninstall (rev4 stage 4).
    assert!(list(&kernel, CHAT_ID, &[MESSAGE_ID]).items.is_empty());
}
