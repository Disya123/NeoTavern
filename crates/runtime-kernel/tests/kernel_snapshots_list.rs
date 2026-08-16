//! М5 slice 46: `chats.snapshots.list` over Product Wire — the paginated
//! child-chat (checkpoint/branch) view of one chat.
//!
//! Proven behaviorally: the list returns child chats newest-first with their
//! message counts and snapshot markers; snapshots created by both
//! `chats.snapshots.create` and the rollback auto-checkpoint appear; the
//! parent's existence is required (`CHAT_NOT_FOUND`); and cursor pagination
//! walks the whole set exactly once.

use contracts_generated::generated::{
    CharacterDto, ChatDto, MessageDto, PagedMessages, ResultChatSnapshot, ResultSnapshotsList,
    ResultSnapshotsRollback,
};
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

fn dispatch_json(
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

fn dispatch_decoded<T: serde::de::DeserializeOwned>(
    kernel: &Kernel,
    op: &str,
    request: Value,
) -> Result<T, runtime_kernel::KernelError> {
    dispatch_json(kernel, op, request).map(|value| {
        serde_json::from_value(value).expect("response must decode as the expected DTO")
    })
}

/// Builds a library in `kernel`: one character, one chat, three messages.
/// Returns `(character_id, chat_id, [m0, m1, m2])` in sequence order.
fn seed_chat(kernel: &Kernel) -> (String, String, Vec<MessageDto>) {
    let character = dispatch_decoded::<CharacterDto>(
        kernel,
        "characters.create",
        json!({ "name": "Aria", "description": "A wandering bard" }),
    )
    .expect("character must be created");
    let chat = dispatch_decoded::<ChatDto>(
        kernel,
        "chats.create",
        json!({ "characterId": character.id }),
    )
    .expect("chat must be created");
    let mut messages = Vec::new();
    for (role, content) in [
        ("user", "Hello"),
        ("assistant", "Greetings, traveler."),
        ("user", "Tell me a story"),
    ] {
        let message = dispatch_decoded::<MessageDto>(
            kernel,
            "chats.messages.create",
            json!({ "chatId": chat.id, "role": role, "content": content }),
        )
        .expect("message must be created");
        messages.push(message);
    }
    (character.id.clone(), chat.id.clone(), messages)
}

fn list_snapshots(kernel: &Kernel, chat_id: &str) -> ResultSnapshotsList {
    dispatch_decoded::<ResultSnapshotsList>(
        kernel,
        "chats.snapshots.list",
        json!({ "chatId": chat_id }),
    )
    .expect("snapshots must list")
}

#[test]
fn list_returns_child_chats_newest_first_with_snapshot_markers() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let (character_id, chat_id, messages) = seed_chat(&kernel);

    // Two explicit checkpoints, one at m1 and one at m2.
    let first = dispatch_decoded::<ResultChatSnapshot>(
        &kernel,
        "chats.snapshots.create",
        json!({ "chatId": chat_id, "messageId": messages[1].id, "kind": "checkpoint" }),
    )
    .expect("first snapshot must be created");
    let second = dispatch_decoded::<ResultChatSnapshot>(
        &kernel,
        "chats.snapshots.create",
        json!({ "chatId": chat_id, "messageId": messages[2].id, "kind": "checkpoint" }),
    )
    .expect("second snapshot must be created");

    let result = list_snapshots(&kernel, &chat_id);
    assert!(result.next_cursor.is_none(), "both fit on one page");
    assert_eq!(result.items.len(), 2, "two child chats are listed");

    // Newest first: the second checkpoint was created after the first.
    assert_eq!(result.items[0].id, second.chat.id);
    assert_eq!(result.items[1].id, first.chat.id);

    for item in &result.items {
        assert_eq!(
            item.parent_chat_id.as_deref(),
            Some(chat_id.as_str()),
            "each snapshot links back to the parent"
        );
        assert_eq!(
            item.origin.as_ref(),
            Some(&contracts_generated::generated::SnapshotOrigin::Checkpoint),
            "explicit snapshots are marked as checkpoints"
        );
        assert!(
            item.source_message_id.is_some(),
            "the frozen source message is recorded"
        );
        assert_eq!(item.character_id, character_id, "same character");
    }
    assert_eq!(
        result.items[0].message_count, 3,
        "prefix up to m2 is copied"
    );
    assert_eq!(
        result.items[1].message_count, 2,
        "prefix up to m1 is copied"
    );

    // Message counts match the snapshot content.
    let first_messages = dispatch_decoded::<PagedMessages>(
        &kernel,
        "chats.messages.list",
        json!({ "chatId": first.chat.id }),
    )
    .expect("first snapshot messages must list");
    assert_eq!(first_messages.items.len(), 2);
}

#[test]
fn rollback_auto_checkpoint_is_listed_as_a_snapshot() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let (_, chat_id, messages) = seed_chat(&kernel);

    let rollback = dispatch_decoded::<ResultSnapshotsRollback>(
        &kernel,
        "chats.snapshots.rollback",
        json!({ "chatId": chat_id, "toMessageId": messages[1].id }),
    )
    .expect("rollback must succeed");
    let checkpoint_chat_id = rollback
        .checkpoint_chat_id
        .as_deref()
        .expect("auto-checkpoint must be created")
        .to_string();

    let result = list_snapshots(&kernel, &chat_id);
    assert_eq!(result.items.len(), 1, "the auto-checkpoint is a child chat");
    assert_eq!(result.items[0].id, checkpoint_chat_id);
    assert_eq!(result.items[0].message_count, 1, "removed suffix frozen");
    assert_eq!(
        result.items[0].source_message_id.as_deref(),
        Some(messages[1].id.as_str()),
        "checkpoint source is the kept message"
    );
}

#[test]
fn list_requires_an_existing_parent() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let (_, _, _) = seed_chat(&kernel);

    let missing = "00000000-0000-4000-8000-000000000000";
    let error = dispatch_json(
        &kernel,
        "chats.snapshots.list",
        json!({ "chatId": missing }),
    )
    .expect_err("missing parent must fail");
    assert_eq!(
        error.product.as_ref().expect("product error").code,
        "CHAT_NOT_FOUND"
    );
}

#[test]
fn cursor_pagination_walks_every_snapshot_exactly_once() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let (_, chat_id, messages) = seed_chat(&kernel);

    // Four snapshots at m1..m2 (m2 reused: the source only needs to exist).
    let mut ids = Vec::new();
    for message in &messages[0..2] {
        for kind in ["checkpoint", "branch"] {
            let created = dispatch_decoded::<ResultChatSnapshot>(
                &kernel,
                "chats.snapshots.create",
                json!({ "chatId": chat_id, "messageId": message.id, "kind": kind }),
            )
            .expect("snapshot must be created");
            ids.push(created.chat.id);
        }
    }
    assert_eq!(ids.len(), 4);

    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut request = json!({ "chatId": chat_id, "limit": 2 });
        if let Some(c) = &cursor {
            request["cursor"] = json!(c);
        }
        let page =
            dispatch_decoded::<ResultSnapshotsList>(&kernel, "chats.snapshots.list", request)
                .expect("page must list");
        for item in &page.items {
            seen.push(item.id.clone());
        }
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    assert_eq!(seen.len(), 4, "all four snapshots are visited");
    for id in &ids {
        assert!(seen.contains(id), "snapshot {id} is visited exactly once");
    }
    // The page walk is duplicate-free.
    let unique: std::collections::HashSet<&String> = seen.iter().collect();
    assert_eq!(unique.len(), 4, "no snapshot is returned twice");
}
