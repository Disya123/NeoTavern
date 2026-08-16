//! М5 slice 44: `chats.snapshots.rollback` over Product Wire — atomically
//! rolling a chat back to a kept message.
//!
//! Proven behaviorally: the removed suffix is FIRST frozen into an
//! auto-created checkpoint child chat (a recoverable safety copy) and only
//! then deleted, in ONE transaction; a no-op rollback creates no checkpoint
//! and is a safe repeat; variants/revisions cascade with their messages;
//! missing chat/message fail with stable product errors; and the target
//! message itself survives.

use contracts_generated::generated::{
    CharacterDto, ChatDto, MessageDto, MessageVariantDto, PagedMessages, ResultMessageRevisionList,
    ResultMessageVariantList, ResultSnapshotsRollback,
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
/// Returns `(chat_id, [m0, m1, m2])` in sequence order.
fn seed_chat(kernel: &Kernel) -> (String, Vec<MessageDto>) {
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
    (chat.id.clone(), messages)
}

fn list_messages(kernel: &Kernel, chat_id: &str) -> Vec<MessageDto> {
    dispatch_decoded::<PagedMessages>(kernel, "chats.messages.list", json!({ "chatId": chat_id }))
        .expect("messages must list")
        .items
}

#[test]
fn rollback_removes_the_suffix_and_keeps_the_target_message() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let (chat_id, messages) = seed_chat(&kernel);

    let result = dispatch_decoded::<ResultSnapshotsRollback>(
        &kernel,
        "chats.snapshots.rollback",
        json!({ "chatId": chat_id, "toMessageId": messages[1].id }),
    )
    .expect("rollback must succeed");

    assert_eq!(result.deleted, 1, "exactly the third message is removed");
    let checkpoint_chat_id = result
        .checkpoint_chat_id
        .as_deref()
        .expect("a checkpoint must be created when something was deleted");

    let remaining = list_messages(&kernel, &chat_id);
    assert_eq!(remaining.len(), 2, "the target message and the first stay");
    assert_eq!(remaining[0].content, "Hello");
    assert_eq!(remaining[1].content, "Greetings, traveler.");
    assert!(remaining.iter().all(|m| m.id != messages[2].id));

    // The auto-checkpoint holds the removed suffix as a recoverable copy.
    let checkpoint_messages = list_messages(&kernel, checkpoint_chat_id);
    assert_eq!(
        checkpoint_messages.len(),
        1,
        "removed suffix frozen in checkpoint"
    );
    assert_eq!(checkpoint_messages[0].content, "Tell me a story");
    let checkpoint_chat = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.get",
        json!({ "chatId": checkpoint_chat_id }),
    )
    .expect("checkpoint chat must be readable");
    assert_eq!(
        checkpoint_chat.parent_chat_id.as_deref(),
        Some(chat_id.as_str()),
        "checkpoint links back to the rolled-back chat"
    );
    assert_eq!(
        checkpoint_chat.source_message_id.as_deref(),
        Some(messages[1].id.as_str()),
        "checkpoint source is the kept message"
    );
}

#[test]
fn noop_rollback_creates_no_checkpoint_and_is_safe_to_repeat() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let (chat_id, messages) = seed_chat(&kernel);

    let first = dispatch_decoded::<ResultSnapshotsRollback>(
        &kernel,
        "chats.snapshots.rollback",
        json!({ "chatId": chat_id, "toMessageId": messages[2].id }),
    )
    .expect("rollback at the last message is a no-op");
    assert_eq!(first.deleted, 0);
    assert!(
        first.checkpoint_chat_id.is_none(),
        "nothing was removed, so no checkpoint may be invented"
    );

    // Repeat the exact same request: still a safe no-op, no duplicate effect.
    let again = dispatch_decoded::<ResultSnapshotsRollback>(
        &kernel,
        "chats.snapshots.rollback",
        json!({ "chatId": chat_id, "toMessageId": messages[2].id }),
    )
    .expect("repeat must not fail");
    assert_eq!(again.deleted, 0);
    assert!(again.checkpoint_chat_id.is_none());

    assert_eq!(
        list_messages(&kernel, &chat_id).len(),
        3,
        "nothing was touched"
    );
}

#[test]
fn rollback_after_a_previous_rollback_is_a_normal_suffix_removal() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let (chat_id, messages) = seed_chat(&kernel);

    let first = dispatch_decoded::<ResultSnapshotsRollback>(
        &kernel,
        "chats.snapshots.rollback",
        json!({ "chatId": chat_id, "toMessageId": messages[1].id }),
    )
    .expect("first rollback");
    assert_eq!(first.deleted, 1);

    // Append a fresh message, then roll back again to the same point.
    dispatch_decoded::<MessageDto>(
        &kernel,
        "chats.messages.create",
        json!({ "chatId": chat_id, "role": "user", "content": "One more" }),
    )
    .expect("append must succeed");

    let second = dispatch_decoded::<ResultSnapshotsRollback>(
        &kernel,
        "chats.snapshots.rollback",
        json!({ "chatId": chat_id, "toMessageId": messages[1].id }),
    )
    .expect("second rollback");
    assert_eq!(
        second.deleted, 1,
        "only the newly appended message is removed"
    );
    assert!(
        second.checkpoint_chat_id.is_some(),
        "a fresh checkpoint is created for the new suffix"
    );

    let remaining = list_messages(&kernel, &chat_id);
    assert_eq!(remaining.len(), 2);
    assert!(remaining.iter().all(|m| m.content != "One more"));
}

#[test]
fn rollback_cascades_variants_and_revisions_of_removed_messages() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let (chat_id, messages) = seed_chat(&kernel);

    // Add a swipe variant + a content revision to the message being removed.
    dispatch_decoded::<MessageVariantDto>(
        &kernel,
        "chats.messages.variants.create",
        json!({ "chatId": chat_id, "messageId": messages[2].id, "content": "Swipe" }),
    )
    .expect("variant must be created");
    dispatch_decoded::<MessageDto>(
        &kernel,
        "chats.messages.update",
        json!({ "chatId": chat_id, "messageId": messages[2].id, "content": "Edited" }),
    )
    .expect("revision must be created");

    let result = dispatch_decoded::<ResultSnapshotsRollback>(
        &kernel,
        "chats.snapshots.rollback",
        json!({ "chatId": chat_id, "toMessageId": messages[1].id }),
    )
    .expect("rollback must succeed");
    assert_eq!(result.deleted, 1);

    // The checkpoint preserved the message WITH its variant/revision fan-out.
    let checkpoint_chat_id = result.checkpoint_chat_id.as_deref().unwrap();
    let checkpoint_messages = list_messages(&kernel, checkpoint_chat_id);
    assert_eq!(checkpoint_messages.len(), 1);
    let frozen = &checkpoint_messages[0];
    let variants = dispatch_decoded::<ResultMessageVariantList>(
        &kernel,
        "chats.messages.variants.list",
        json!({ "chatId": checkpoint_chat_id, "messageId": frozen.id }),
    )
    .expect("variants must list");
    assert_eq!(
        variants.items.len(),
        1,
        "the swipe variant followed its message"
    );
    assert_eq!(variants.items[0].content, "Swipe");
    let revisions = dispatch_decoded::<ResultMessageRevisionList>(
        &kernel,
        "chats.messages.revisions.list",
        json!({ "chatId": checkpoint_chat_id, "messageId": frozen.id }),
    )
    .expect("revisions must list");
    assert_eq!(
        revisions.items.len(),
        1,
        "the revision followed its message"
    );
    assert_eq!(
        revisions.items[0].content, "Tell me a story",
        "revisions are the previous texts; the single edit froze the original"
    );
}

#[test]
fn rollback_fails_honestly_for_missing_chat_and_missing_message() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let (chat_id, messages) = seed_chat(&kernel);

    let missing_chat = "99999999-9999-4999-8999-999999999999";
    let err = dispatch_json(
        &kernel,
        "chats.snapshots.rollback",
        json!({ "chatId": missing_chat, "toMessageId": messages[0].id }),
    )
    .expect_err("rollback of a missing chat must fail");
    assert_eq!(err.product.as_ref().unwrap().code, "CHAT_NOT_FOUND");

    let foreign_message = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let err = dispatch_json(
        &kernel,
        "chats.snapshots.rollback",
        json!({ "chatId": chat_id, "toMessageId": foreign_message }),
    )
    .expect_err("rollback to a missing message must fail");
    assert_eq!(err.product.as_ref().unwrap().code, "MESSAGE_NOT_FOUND");
}
