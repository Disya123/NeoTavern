//! Prompt pipeline integration tests (ТЗ §9.2, Этап 2.6).
//!
//! Covers the durable `PromptPlan` end to end: a `generation.start` run
//! builds the plan (character/persona system blocks + bounded history + the
//! user message, heuristic token budget) BEFORE the provider attempt, stores
//! it in `prompt_plans`, executes the run, and `generation.prompt.plan`
//! serves the stored plan for inspection (§9.2: the user can see what
//! context was included or excluded).

use contracts_generated::generated::{
    decode_prompt_plan, GenerationRun, GenerationStatus, MessageRole,
};
use runtime_kernel::{
    CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode, StreamNotice,
};
use std::time::Duration;

const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000002";

// ---------------------------------------------------------------------------
// Helpers (mirror providers.rs)
// ---------------------------------------------------------------------------

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

/// Seeds a character (with a persona card field) + chat + two history
/// messages through `neotavern_storage`, then releases the lease.
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
             VALUES (?1, 'Plan test', ?2, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
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

fn start_stream(
    kernel: &Kernel,
    op: &str,
    request: serde_json::Value,
) -> Result<runtime_kernel::EventStream, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel.dispatch_stream(op, &bytes, &flag)
}

fn drain_until_terminal(
    stream: &mut runtime_kernel::EventStream,
    timeout: Duration,
) -> (Vec<i64>, i64) {
    let mut committed = Vec::new();
    loop {
        match stream.next_notice(timeout) {
            Some(StreamNotice::Committed { through_sequence }) => committed.push(through_sequence),
            Some(StreamNotice::Terminal { last_sequence }) => return (committed, last_sequence),
            None => panic!("stream ended without a terminal notice"),
        }
    }
}

fn get_run(kernel: &Kernel, run_id: &str) -> GenerationRun {
    serde_json::from_slice(&dispatch_bytes(
        kernel,
        "generation.get",
        serde_json::json!({ "workflowId": run_id }),
    ))
    .expect("get response must be a GenerationRun")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn generation_builds_and_serves_the_prompt_plan() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({
            "chatId": CHAT_ID,
            "message": "hello from plan test",
            "provider": "fake",
            "model": "steps=4",
        }),
    )
    .expect("generation.start must open a stream");
    let run_id = stream.stream_id().to_string();
    let (committed, terminal) = drain_until_terminal(&mut stream, Duration::from_secs(30));
    assert!(!committed.is_empty(), "run emits deltas");
    assert!(terminal >= 0, "terminal sequence present");

    let run = get_run(&kernel, &run_id);
    assert_eq!(
        run.status,
        GenerationStatus::Completed,
        "fake run must complete"
    );

    // The plan is durable and served by generation.prompt.plan.
    let plan_bytes = dispatch_bytes(
        &kernel,
        "generation.prompt.plan",
        serde_json::json!({ "runId": run_id }),
    );
    let plan = decode_prompt_plan(&plan_bytes).expect("schema-valid plan");

    assert_eq!(plan.chat_id, CHAT_ID);
    assert_eq!(plan.provider, "fake");
    assert_eq!(plan.model, "steps=4");
    assert_eq!(plan.instruct_format, "plain-messages-v1");
    assert_eq!(plan.tokenizer_profile, "heuristic-v1");
    assert!(
        plan.approximate_tokens,
        "heuristic tokenizer is approximate"
    );
    assert!(plan.context_limit > 0, "fallback context window");
    assert!(plan.response_reserved > 0, "response room reserved");
    assert!(plan.input_tokens > 0, "input tokens counted");

    // System blocks: character description + persona from the card.
    assert!(
        plan.system_blocks
            .iter()
            .any(|b| b.source == "character" && b.text.contains("cheerful guide")),
        "character block: {:?}",
        plan.system_blocks
    );
    assert!(
        plan.system_blocks
            .iter()
            .any(|b| b.source == "persona" && b.text.contains("playful")),
        "persona block: {:?}",
        plan.system_blocks
    );

    // Messages: system (merged blocks) + both history messages + user.
    assert_eq!(plan.messages[0].role, MessageRole::System);
    assert!(
        plan.messages[0].content.contains("cheerful guide"),
        "system message carries the character block"
    );
    let roles: Vec<&MessageRole> = plan.messages.iter().map(|m| &m.role).collect();
    assert!(
        roles.contains(&&MessageRole::Assistant),
        "history assistant selected: {roles:?}"
    );
    let contents: Vec<&str> = plan.messages.iter().map(|m| m.content.as_str()).collect();
    assert!(contents.contains(&"Hello Aria"), "history user selected");
    assert_eq!(
        plan.messages.last().unwrap().content,
        "hello from plan test",
        "user message is pinned last"
    );
    assert!(
        plan.excluded.is_empty(),
        "no truncation at the default budget: {:?}",
        plan.excluded
    );

    // Durability: after the kernel closes, the plan row survives in
    // database.sqlite.
    drop(kernel);
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let db = neotavern_storage::open::open(
        root.path(),
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("reopen root");
    let count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM prompt_plans WHERE run_id = ?1",
            rusqlite::params![run_id],
            |row| row.get(0),
        )
        .expect("count query");
    assert_eq!(count, 1, "prompt_plans row must be durable");
}

#[test]
fn prompt_plan_not_found_for_unknown_run() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    let flag = CancellationFlag::new();
    let request = serde_json::to_vec(&serde_json::json!({
        "runId": "99999999-9999-4999-8999-999999999999"
    }))
    .expect("serialize");
    let err = kernel
        .dispatch("generation.prompt.plan", &request, &flag)
        .expect_err("unknown run must fail");
    assert_eq!(
        err.code,
        KernelErrorCode::NotFound,
        "product code PROMPT_PLAN_NOT_FOUND maps to NotFound class"
    );
}
