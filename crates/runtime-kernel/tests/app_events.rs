//! App-event log (`events.poll`, M7 Этап-4 cluster 18).
//!
//! The durable counterpart of the legacy SSE relay: every client-relevant
//! mutation appends an id-only event inside the same transaction as the data
//! change, and a subscriber resumes from the last `sequence` it saw. These
//! tests pin the delivery guarantees the Web Client's cache invalidation
//! relies on: events exist after the fact (not only while connected), the
//! cursor is exclusive and monotonic, a poll writes nothing, message-block
//! changes publish their three ids, and a cursor below retention is reported
//! as `truncated` instead of silently skipping changes.

use contracts_generated::generated::decode_result_app_events_page;
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::Value;

const CHARACTER_ID: &str = "00000000-0000-4000-8000-0000000000c2";
const PLUGIN_ID: &str = "clockwork-block-plugin";

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn with_db<T>(
    root: &std::path::Path,
    f: impl FnOnce(&mut neotavern_storage::open::Database) -> T,
) -> T {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("data root must open");
    f(&mut db)
}

/// Seeds one character (the chat and plugin are created through the wire, so
/// the events for them are produced by the same code a client would hit).
fn seed_character(root: &std::path::Path) {
    with_db(root, |db| {
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
                 VALUES (?1, 'Wren', 'A clockwork mechanic.', NULL, '[]', \
                 '{\"personality\":\"patient\"}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
                rusqlite::params![CHARACTER_ID],
            )
            .expect("seed character");
            Ok::<(), neotavern_storage::StorageError>(())
        })
        .expect("seeding transaction must succeed");
    });
}

fn dispatch(kernel: &Kernel, op: &str, request: serde_json::Value) -> Value {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    let response = kernel
        .dispatch(op, &bytes, &flag)
        .expect("dispatch must succeed");
    serde_json::from_slice(&response).expect("response must be JSON")
}

fn poll(kernel: &Kernel, after_sequence: Option<i64>) -> Value {
    let mut request = serde_json::json!({});
    if let Some(after) = after_sequence {
        request["afterSequence"] = serde_json::json!(after);
    }
    dispatch(kernel, "events.poll", request)
}

/// The page must decode through the generated checker, not just look right.
fn decode_page(value: &Value) -> contracts_generated::generated::ResultAppEventsPage {
    decode_result_app_events_page(&serde_json::to_vec(value).expect("re-serialize page"))
        .expect("page must be a schema-valid wire.result.app-events-page")
}

fn events_of<'a>(page: &'a Value, event: &str) -> Vec<&'a Value> {
    page["items"]
        .as_array()
        .expect("items array")
        .iter()
        .filter(|item| item["event"] == event)
        .collect()
}

fn seeded_kernel(root: &std::path::Path) -> Kernel {
    seed_character(root);
    open_kernel(root)
}

#[test]
fn app_events_are_durable_and_replay_after_the_fact() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());
    assert!(
        poll(&kernel, Some(-1))["items"]
            .as_array()
            .expect("items")
            .is_empty(),
        "a fresh log has no events"
    );

    // Nothing is subscribed while these mutations happen: a subscriber that
    // starts afterwards must still see them.
    let chat = dispatch(
        &kernel,
        "chats.create",
        serde_json::json!({ "characterId": CHARACTER_ID, "title": "Wren's workshop" }),
    );
    let chat_id = chat["id"].as_str().expect("chat id").to_string();
    let message = dispatch(
        &kernel,
        "chats.messages.create",
        serde_json::json!({ "chatId": chat_id, "role": "user", "content": "Wind the clock." }),
    );
    let message_id = message["id"].as_str().expect("message id").to_string();

    let page = poll(&kernel, Some(-1));
    let decoded = decode_page(&page);
    assert!(!decoded.has_more, "two events fit one page");
    assert!(!decoded.truncated, "a fresh cursor is never truncated");

    let created = events_of(&page, "chat.created");
    assert_eq!(created.len(), 1, "one chat.created");
    assert_eq!(created[0]["payload"]["chatId"], chat_id.as_str());
    assert_eq!(created[0]["payload"]["characterId"], CHARACTER_ID);

    let sent = events_of(&page, "chat.message.created");
    assert_eq!(sent.len(), 1, "one chat.message.created");
    assert_eq!(sent[0]["payload"]["chatId"], chat_id.as_str());
    assert_eq!(sent[0]["payload"]["messageId"], message_id.as_str());

    // Monotonic, contiguous cursors (the client resumes by echo).
    let sequences: Vec<i64> = decoded.items.iter().map(|item| item.sequence).collect();
    assert_eq!(sequences, vec![1, 2]);
}

#[test]
fn app_event_cursor_is_exclusive_and_monotonic() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());
    let chat = dispatch(
        &kernel,
        "chats.create",
        serde_json::json!({ "characterId": CHARACTER_ID }),
    );
    let chat_id = chat["id"].as_str().expect("chat id").to_string();

    let first = decode_page(&poll(&kernel, Some(-1)));
    let cursor = first.items.last().expect("one event").sequence;

    let message = dispatch(
        &kernel,
        "chats.messages.create",
        serde_json::json!({ "chatId": chat_id, "role": "user", "content": "Hello" }),
    );
    let message_id = message["id"].as_str().expect("message id").to_string();

    let second = decode_page(&poll(&kernel, Some(cursor)));
    assert_eq!(second.items.len(), 1, "only the new event");
    assert!(second.items[0].sequence > cursor);
    assert_eq!(second.items[0].event, "chat.message.created");
    assert_eq!(
        second.items[0].payload.payload["messageId"],
        serde_json::json!(message_id)
    );

    // Polling at the tip is an empty, non-truncated page.
    let tip = second.items[0].sequence;
    let idle = decode_page(&poll(&kernel, Some(tip)));
    assert!(idle.items.is_empty());
    assert!(!idle.has_more);
    assert!(!idle.truncated);
}

#[test]
fn app_event_poll_writes_nothing() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());
    dispatch(
        &kernel,
        "chats.create",
        serde_json::json!({ "characterId": CHARACTER_ID }),
    );
    let first = poll(&kernel, Some(-1));
    let second = poll(&kernel, Some(-1));
    assert_eq!(first, second, "repeated polls agree");
    // A poll never appends: the tip the client would echo is unchanged, so a
    // subscriber that re-polls after a failed request sees the same page.
    let tip = first["items"]
        .as_array()
        .expect("items")
        .last()
        .expect("one event")["sequence"]
        .clone();
    assert_eq!(second["items"].as_array().expect("items").len(), 1);
    assert_eq!(second["items"][0]["sequence"], tip);
}

#[test]
fn message_block_changes_publish_their_three_ids() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());
    let chat = dispatch(
        &kernel,
        "chats.create",
        serde_json::json!({ "characterId": CHARACTER_ID }),
    );
    let chat_id = chat["id"].as_str().expect("chat id").to_string();
    let message = dispatch(
        &kernel,
        "chats.messages.create",
        serde_json::json!({ "chatId": chat_id, "role": "assistant", "content": "Tick." }),
    );
    let message_id = message["id"].as_str().expect("message id").to_string();
    dispatch(
        &kernel,
        "plugins.install",
        serde_json::json!({
            "id": PLUGIN_ID,
            "name": "Clockwork",
            "version": "1.0.0",
            "trustState": "locally-trusted",
            "permissions": [],
        }),
    );

    let block = dispatch(
        &kernel,
        "chats.blocks.attach",
        serde_json::json!({
            "chatId": chat_id,
            "messageId": message_id,
            "pluginId": PLUGIN_ID,
            "blockType": "clock",
            "rendererId": "clockwork-renderer",
            "descriptor": { "tickSeconds": 1 },
        }),
    );
    let block_id = block["id"].as_str().expect("block id").to_string();

    let page = poll(&kernel, Some(-1));
    let changed = events_of(&page, "chat.message.block.changed");
    assert_eq!(changed.len(), 1, "attach publishes one block event");
    assert_eq!(changed[0]["payload"]["chatId"], chat_id.as_str());
    assert_eq!(changed[0]["payload"]["messageId"], message_id.as_str());
    assert_eq!(changed[0]["payload"]["blockId"], block_id.as_str());

    dispatch(
        &kernel,
        "blocks.update",
        serde_json::json!({ "blockId": block_id, "clearSerializedState": true }),
    );
    let page = poll(&kernel, Some(-1));
    assert_eq!(
        events_of(&page, "chat.message.block.changed").len(),
        2,
        "update publishes a second block event"
    );
    // The plugin lifecycle is visible to other clients too.
    assert_eq!(events_of(&page, "plugin.installed").len(), 1);
}

#[test]
fn app_event_truncation_is_reported_for_an_aged_out_cursor() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());
    for _ in 0..3 {
        dispatch(
            &kernel,
            "chats.create",
            serde_json::json!({ "characterId": CHARACTER_ID }),
        );
    }
    let page = decode_page(&poll(&kernel, Some(-1)));
    assert_eq!(page.items.len(), 3);
    assert!(!page.truncated);

    // Simulate retention aging out the first two events (the writer prunes by
    // the same rule; producing 2048 mutations here would only slow the suite).
    // The kernel lease is exclusive, so it is released before the prune.
    drop(kernel);
    with_db(root.path(), |db| {
        db.transaction(|tx| {
            tx.execute("DELETE FROM app_events WHERE sequence <= 2", [])
                .expect("prune");
            Ok::<(), neotavern_storage::StorageError>(())
        })
        .expect("prune transaction");
    });
    let kernel = open_kernel(root.path());

    let aged = decode_page(&poll(&kernel, Some(0)));
    assert!(aged.truncated, "a cursor below retention is flagged");
    assert_eq!(aged.items.len(), 1, "the retained event is still delivered");

    // A fresh subscriber starts at the oldest retained row and is not flagged.
    let fresh = decode_page(&poll(&kernel, Some(-1)));
    assert!(!fresh.truncated, "-1 never claims a gap");
    assert_eq!(fresh.items.len(), 1);
}
