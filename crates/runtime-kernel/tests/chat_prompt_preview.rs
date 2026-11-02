//! `chats.prompt.preview` вЂ” side-effect-free prompt preview (Р­С‚Р°Рї-4 registry
//! cluster 17, part 2).
//!
//! The preview runs the SAME planning pipeline the durable `wire.prompt.plan`
//! records (character/persona/lorebook/memory blocks, bounded history, token
//! budget, context shifting) but WITHOUT a generation run: no `generation_runs`
//! row, no `prompt_plans` row, no message, no provider contact. The response is
//! `wire.prompt.preview` вЂ” the one-plan shape minus the run identity вЂ” so a
//! preview can never masquerade as a run.

use contracts_generated::generated::{
    decode_result_chat_context_audit, decode_result_chat_prompt_preview, MessageRole,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelErrorCode};
use std::time::Duration;

const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000002";
const UNKNOWN_CHAT_ID: &str = "99999999-9999-4999-8999-999999999998";

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

/// Seeds a character + chat + two history messages (mirrors `prompt_plan.rs`).
fn seed_chat(root: &std::path::Path) {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("fresh data root must open");
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES (?1, 'Aria', 'Aria the cheerful guide.', NULL, '[]', \
             '{\"personality\":\"playful and witty\"}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
            rusqlite::params![CHARACTER_ID],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
             VALUES (?1, 'Preview test', ?2, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
            rusqlite::params![CHAT_ID, CHARACTER_ID],
        )
        .expect("seed chat");
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) VALUES \
             ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ?1, 'user', 'Hello Aria', 1, '2026-08-13T00:02:00Z'), \
             ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ?1, 'assistant', 'Hi there!', 2, '2026-08-13T00:03:00Z')",
            rusqlite::params![CHAT_ID],
        )
        .expect("seed messages");
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
    drop(db);
}

fn dispatch_bytes(kernel: &Kernel, op: &str, request: serde_json::Value) -> Vec<u8> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .expect("dispatch must succeed")
}

/// Raw JSON of one preview dispatch (the wire payload as the client sees it).
fn preview_json(kernel: &Kernel, user_message: &str) -> serde_json::Value {
    let bytes = dispatch_bytes(
        kernel,
        "chats.prompt.preview",
        serde_json::json!({ "chatId": CHAT_ID, "userMessage": user_message }),
    );
    serde_json::from_slice(&bytes).expect("preview response must be JSON")
}

/// Counts rows of one table through the kernel's own database file.
fn count_rows(root: &std::path::Path, table: &str) -> i64 {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("reopen root");
    db.conn()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count rows")
}

#[test]
fn chat_prompt_preview_builds_the_next_prompt_without_a_run() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    let value = preview_json(&kernel, "draft question");
    let result = decode_result_chat_prompt_preview(
        &serde_json::to_vec(&value).expect("re-serialize preview"),
    )
    .expect("preview must be a schema-valid wire.result.chat-prompt-preview");
    let plan = result.plan;

    assert_eq!(plan.chat_id, CHAT_ID);
    assert!(
        !plan.created_at.is_empty(),
        "preview plan carries its build time"
    );
    assert!(
        plan.system_blocks
            .iter()
            .any(|block| block.text.contains("Aria")),
        "character system blocks enter the preview: {:?}",
        plan.system_blocks
    );
    let contents: Vec<&str> = plan.messages.iter().map(|m| m.content.as_str()).collect();
    assert!(
        contents.contains(&"Hello Aria") && contents.contains(&"Hi there!"),
        "chat history enters the preview: {contents:?}"
    );
    assert_eq!(
        plan.messages.last().map(|m| m.content.as_str()),
        Some("draft question"),
        "the unsent composer draft is the trailing user message"
    );
    assert!(
        plan.input_tokens > 0,
        "the preview reports its token budget"
    );
    assert!(plan.context_limit > 0);
    assert!(
        plan.tokenizer_profile == "heuristic-v1" && plan.approximate_tokens,
        "the heuristic tokenizer is reported honestly"
    );

    // The run identity is NOT part of a preview: the payload has no `runId`,
    // so a preview cannot be mistaken for an executed generation.
    assert!(
        value
            .get("plan")
            .and_then(|plan| plan.get("runId"))
            .is_none(),
        "preview payload must not carry a runId: {value:?}"
    );
}

#[test]
fn chat_prompt_preview_is_side_effect_free() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    // Repeated previews are safe: read-only, idempotent.
    let first = preview_json(&kernel, "same draft");
    let second = preview_json(&kernel, "same draft");
    assert_eq!(
        first.get("plan").and_then(|p| p.get("messages")),
        second.get("plan").and_then(|p| p.get("messages")),
        "repeated previews of the same draft must agree"
    );

    drop(kernel);
    assert_eq!(
        count_rows(root.path(), "generation_runs"),
        0,
        "a preview never creates a generation run"
    );
    assert_eq!(
        count_rows(root.path(), "prompt_plans"),
        0,
        "a preview never persists a plan"
    );
    assert_eq!(
        count_rows(root.path(), "messages"),
        2,
        "a preview never creates a message"
    );
}

#[test]
fn chat_prompt_preview_accepts_an_empty_draft() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    let result = decode_result_chat_prompt_preview(&dispatch_bytes(
        &kernel,
        "chats.prompt.preview",
        serde_json::json!({ "chatId": CHAT_ID, "userMessage": "" }),
    ))
    .expect("an empty composer draft is a legitimate preview request");
    let plan = result.plan;

    assert!(
        plan.messages
            .iter()
            .all(|m| m.role != MessageRole::User || !m.content.is_empty()),
        "no fabricated empty user message: {:?}",
        plan.messages
    );
    assert_eq!(
        plan.messages.last().map(|m| m.content.as_str()),
        Some("Hi there!"),
        "history is budgeted as-is when the draft is empty"
    );
}

#[test]
fn chat_prompt_preview_rejects_unknown_chat() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    let flag = CancellationFlag::new();
    let request = serde_json::to_vec(&serde_json::json!({
        "chatId": UNKNOWN_CHAT_ID,
        "userMessage": "hello",
    }))
    .expect("serialize");
    let err = kernel
        .dispatch("chats.prompt.preview", &request, &flag)
        .expect_err("unknown chat must fail");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    let product = err.product.expect("product error carries the code");
    assert_eq!(product.code, "CHAT_NOT_FOUND");
}

#[test]
fn chat_prompt_preview_matches_the_durable_plan_of_a_real_run() {
    // The preview and the durable plan run the same pipeline: after a real
    // run whose input equals the preview draft, the durable plan's messages
    // (minus the run identity and the new history tail) agree on the draft.
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    let preview = decode_result_chat_prompt_preview(&dispatch_bytes(
        &kernel,
        "chats.prompt.preview",
        serde_json::json!({ "chatId": CHAT_ID, "userMessage": "shared question" }),
    ))
    .expect("preview must succeed");
    assert_eq!(
        preview.plan.messages.last().map(|m| m.content.as_str()),
        Some("shared question")
    );

    let flag = CancellationFlag::new();
    let request = serde_json::to_vec(&serde_json::json!({
        "chatId": CHAT_ID,
        "message": "shared question",
        "provider": "fake",
        "model": "steps=2",
    }))
    .expect("serialize");
    let mut stream = kernel
        .dispatch_stream("generation.start", &request, &flag)
        .expect("generation.start must open a stream");
    loop {
        match stream.next_notice(Duration::from_secs(30)) {
            Some(runtime_kernel::StreamNotice::Terminal { .. }) => break,
            Some(runtime_kernel::StreamNotice::Committed { .. }) => {}
            None => panic!("stream ended without a terminal notice"),
        }
    }

    let plan = decode_result_chat_context_audit(&dispatch_bytes(
        &kernel,
        "chats.context.audit",
        serde_json::json!({ "chatId": CHAT_ID }),
    ))
    .expect("audit must decode")
    .plan
    .expect("the run stored its plan");
    assert_eq!(
        plan.messages.last().map(|m| m.content.as_str()),
        Some("shared question"),
        "the durable plan of a real run ends with the same draft the preview showed"
    );
}
