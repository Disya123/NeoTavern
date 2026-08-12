//! Phase 6 generation durability tests (design §8 items 1–9).
//!
//! Covers: happy path + cross-root determinism, mid-run cancel via a second
//! thread, provider failure, kill injection (process death) with recovery and
//! the keep/discard cleanup ops, terminal replay, state guards, pagination,
//! stateless StorageFailure, and concurrent unary reads during a stream.

use contracts_generated::generated::{
    GenerationRun, MessageDto, PagedGenerationEvents, PagedMessages,
};
use runtime_kernel::{
    CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode, StreamNotice,
};
use std::io::{BufRead, BufReader};
use std::process::{Command as StdCommand, Stdio};
use std::sync::Arc;
use std::time::Duration;

/// Fixed chat id (wire-uuid-shaped) reused across roots so the deterministic
/// fake-provider deltas match byte-for-byte.
const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000002";
const UNKNOWN_UUID: &str = "00000000-0000-4000-8000-000000000099";

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

fn open_stateless() -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: None,
    })
    .expect("stateless kernel must open")
}

/// Seeds a character + chat through `neotavern_storage`, then releases the
/// lease so the kernel under test can take the root.
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
             VALUES (?1, 'Aria', NULL, NULL, '[]', '{}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
            rusqlite::params![CHARACTER_ID],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
             VALUES (?1, 'Gen test', ?2, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
            rusqlite::params![CHAT_ID, CHARACTER_ID],
        )
        .expect("seed chat");
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
    drop(db);
}

fn dispatch_json(
    kernel: &Kernel,
    op: &str,
    request: serde_json::Value,
) -> Result<serde_json::Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
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

/// Drains a stream until the terminal notice, returning the committed
/// sequences and the terminal sequence.
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
    let value = dispatch_json(
        kernel,
        "generation.get",
        serde_json::json!({ "workflowId": run_id }),
    )
    .expect("generation.get must succeed");
    serde_json::from_value(value).expect("get response must be a GenerationRun")
}

fn list_events(
    kernel: &Kernel,
    run_id: &str,
    after: i64,
    limit: Option<i64>,
) -> PagedGenerationEvents {
    let mut request = serde_json::json!({ "workflowId": run_id });
    if let Some(after) = (after >= 0).then_some(after) {
        request["afterSequence"] = serde_json::json!(after);
    }
    if let Some(limit) = limit {
        request["limit"] = serde_json::json!(limit);
    }
    let value = dispatch_json(kernel, "generation.events", request)
        .expect("generation.events must succeed");
    serde_json::from_value(value).expect("events response must be PagedGenerationEvents")
}

fn list_messages(kernel: &Kernel, chat_id: &str) -> Vec<MessageDto> {
    let value = dispatch_json(
        kernel,
        "chats.messages.list",
        serde_json::json!({ "chatId": chat_id, "limit": 200 }),
    )
    .expect("chats.messages.list must succeed");
    let paged: PagedMessages = serde_json::from_value(value).expect("messages response shape");
    paged.items
}

// ---------------------------------------------------------------------------
// 1. Happy path + determinism
// ---------------------------------------------------------------------------

#[test]
fn generation_happy_path_and_determinism() {
    let model = "steps=4;tokens-per-step=48";
    let (root1, kernel1, run1, notices1) = run_to_completion(CHAT_ID, model);
    let (root2, kernel2, run2, notices2) = run_to_completion(CHAT_ID, model);
    let _ = (root1, root2);

    // Both streams committed every delta and terminated.
    let (committed1, terminal1) = notices1;
    let (committed2, terminal2) = notices2;
    assert_eq!(committed1.len(), 4, "four deltas must be committed");
    assert_eq!(committed2.len(), 4);
    assert_eq!(
        terminal1, terminal2,
        "terminal sequences must match across roots"
    );

    // Events replay: the streamed content (deltas + checkpoints) is
    // byte-identical across two fresh roots with the same chat id, model and
    // attempt. The terminal `generation.completed` payload embeds a fresh
    // message id + wall-clock timestamp, so it is compared structurally.
    let events1 = list_events(&kernel1, &run1, -1, None);
    let events2 = list_events(&kernel2, &run2, -1, None);
    assert_eq!(events1.items.len(), events2.items.len());
    // 4 deltas (seq 0..=3) + 1 checkpoint (after delta index 3) + 1 completed.
    assert_eq!(events1.items.len(), 6);
    let deterministic1: Vec<_> = events1
        .items
        .iter()
        .filter(|e| e.r#type != "generation.completed")
        .map(|e| e.payload.clone())
        .collect();
    let deterministic2: Vec<_> = events2
        .items
        .iter()
        .filter(|e| e.r#type != "generation.completed")
        .map(|e| e.payload.clone())
        .collect();
    assert_eq!(
        deterministic1, deterministic2,
        "delta/checkpoint payloads must be byte-identical across roots"
    );
    let completed1 = &events1.items.last().unwrap().payload;
    let completed2 = &events2.items.last().unwrap().payload;
    assert_eq!(
        completed1["type"],
        serde_json::json!("generation.completed")
    );
    assert_eq!(
        completed1["finalMessage"]["content"], completed2["finalMessage"]["content"],
        "final message content is deterministic"
    );
    assert_eq!(events1.items.last().unwrap().sequence, terminal1);

    // The envelope streamId is the run id.
    assert!(events1.items.iter().all(|e| e.stream_id == run1));

    // The last committed notice is the terminal sequence minus one (the
    // terminal event is committed atomically with the terminal state).
    assert_eq!(*committed1.last().unwrap() + 1, terminal1);

    // Run completed with a message.
    let run1_dto = get_run(&kernel1, &run1);
    assert_eq!(
        run1_dto.status,
        contracts_generated::generated::GenerationStatus::Completed
    );
    let message_id = run1_dto
        .message_id
        .as_ref()
        .expect("completed run has a message");

    // Exactly one assistant message persisted with generationRunId == run id.
    let messages = list_messages(&kernel1, CHAT_ID);
    assert_eq!(messages.len(), 1);
    let message = &messages[0];
    assert_eq!(
        message.role,
        contracts_generated::generated::MessageRole::Assistant
    );
    assert_eq!(message.generation_run_id.as_deref(), Some(run1.as_str()));
    assert_eq!(message.id, message_id.as_str());

    // Message content == concatenation of the committed delta texts == the
    // partialText preview (untruncated here); partialTextLength tracks it.
    let expected: String = events1
        .items
        .iter()
        .filter(|e| e.r#type == "generation.delta")
        .map(|e| e.payload["text"].as_str().expect("delta payload text"))
        .collect();
    assert_eq!(message.content, expected);
    assert_eq!(run1_dto.partial_text.as_deref(), Some(expected.as_str()));
    assert_eq!(
        run1_dto.partial_text_length,
        expected.chars().count() as i64
    );
    assert!(!run1_dto.partial_truncated);

    // The other root produced the identical message.
    let messages2 = list_messages(&kernel2, CHAT_ID);
    assert_eq!(messages2.len(), 1);
    assert_eq!(messages2[0].content, expected);
}

fn run_to_completion(
    chat_id: &str,
    model: &str,
) -> (tempfile::TempDir, Kernel, String, (Vec<i64>, i64)) {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": chat_id, "message": "Hello", "model": model }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    let notices = drain_until_terminal(&mut stream, Duration::from_secs(30));
    (root, kernel, run_id, notices)
}

// ---------------------------------------------------------------------------
// 2. Cancel mid-run
// ---------------------------------------------------------------------------

#[test]
fn generation_cancel_mid_run() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = Arc::new(open_kernel(root.path()));
    let flag = CancellationFlag::new();
    let mut stream = kernel
        .dispatch_stream(
            "generation.start",
            &serde_json::to_vec(&serde_json::json!({
                "chatId": CHAT_ID,
                "message": "Hello",
                "model": "steps=8;delay-ms=50;tokens-per-step=48"
            }))
            .expect("serialize"),
            &flag,
        )
        .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();

    // Wait for the first committed delta, then cancel from a second thread
    // through the SAME kernel (a second kernel on the same root is lease-
    // forbidden).
    let mut committed = Vec::new();
    match stream.next_notice(Duration::from_secs(30)) {
        Some(StreamNotice::Committed { through_sequence }) => committed.push(through_sequence),
        other => panic!("expected a committed delta, got {other:?}"),
    }
    let cancel_kernel = Arc::clone(&kernel);
    let cancel_run_id = run_id.clone();
    let cancel_thread = std::thread::spawn(move || {
        let flag = CancellationFlag::new();
        let bytes = serde_json::to_vec(&serde_json::json!({ "workflowId": cancel_run_id }))
            .expect("serialize");
        cancel_kernel.dispatch("generation.cancel", &bytes, &flag)
    });

    let (rest, terminal) = drain_until_terminal(&mut stream, Duration::from_secs(30));
    committed.extend(rest);
    cancel_thread
        .join()
        .expect("cancel thread must not panic")
        .expect("generation.cancel must succeed");

    assert!(
        !committed.is_empty(),
        "at least one delta before the cancel"
    );
    assert!(
        committed.len() < 8,
        "the run must be cancelled before all 8 steps"
    );

    // Run is cancelled, not completed.
    let run = get_run(&kernel, &run_id);
    assert_eq!(
        run.status,
        contracts_generated::generated::GenerationStatus::Cancelled
    );
    assert_eq!(run.message_id, None, "cancelled runs have no final message");

    // Events stop at the cancel point: deltas only, then exactly one
    // generation.cancelled terminal event at the terminal sequence.
    let events = list_events(&kernel, &run_id, -1, None);
    let types: Vec<&str> = events.items.iter().map(|e| e.r#type.as_str()).collect();
    assert!(
        types.iter().all(|t| *t != "generation.completed"),
        "no completed event"
    );
    assert_eq!(
        types
            .iter()
            .filter(|t| **t == "generation.cancelled")
            .count(),
        1,
        "exactly one terminal event"
    );
    assert_eq!(
        types.iter().filter(|t| **t == "generation.delta").count(),
        committed.len()
    );
    assert_eq!(events.items.last().unwrap().sequence, terminal);

    // No message row for the cancelled run.
    assert!(list_messages(&kernel, CHAT_ID).is_empty());
}

// ---------------------------------------------------------------------------
// 3. fail-at-3
// ---------------------------------------------------------------------------

#[test]
fn generation_fails_at_provider_step() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "Hello", "model": "steps=6;fail-at=3;tokens-per-step=48" }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    let (committed, terminal) = drain_until_terminal(&mut stream, Duration::from_secs(30));

    // Steps 1 and 2 committed; step 3 failed before producing.
    assert_eq!(committed.len(), 2);

    // Failed run with the provider error in error_json.
    let run = get_run(&kernel, &run_id);
    assert_eq!(
        run.status,
        contracts_generated::generated::GenerationStatus::Failed
    );
    let error = run.error.as_ref().expect("failed run carries an error");
    assert_eq!(error.code, "PROVIDER_STEP_FAILED");
    assert_eq!(error.params["runId"], serde_json::json!(run_id));
    assert_eq!(error.params["step"], serde_json::json!("3"));

    // Terminal generation.failed event mirrors the error.
    let events = list_events(&kernel, &run_id, -1, None);
    assert_eq!(events.items.len(), 3, "2 deltas + 1 failed");
    let failed = events
        .items
        .iter()
        .find(|e| e.r#type == "generation.failed")
        .expect("terminal failed event");
    assert_eq!(failed.sequence, terminal);
    assert_eq!(
        failed.payload["error"]["code"],
        serde_json::json!("PROVIDER_STEP_FAILED")
    );

    // No message row.
    assert!(list_messages(&kernel, CHAT_ID).is_empty());
}

#[test]
fn generation_provider_validation() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    // Unknown provider → failed run, PROVIDER_UNAVAILABLE.
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "Hello", "provider": "openai" }),
    )
    .expect("start with unknown provider must still open a stream");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));
    let run = get_run(&kernel, &run_id);
    assert_eq!(
        run.status,
        contracts_generated::generated::GenerationStatus::Failed
    );
    assert_eq!(run.error.as_ref().unwrap().code, "PROVIDER_UNAVAILABLE");
    assert_eq!(
        run.error.as_ref().unwrap().params["provider"],
        serde_json::json!("openai")
    );

    // Malformed model grammar → failed run, PROVIDER_MODEL_INVALID.
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "Hello", "model": "steps=nope" }),
    )
    .expect("start with a malformed model must still open a stream");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));
    let run = get_run(&kernel, &run_id);
    assert_eq!(
        run.status,
        contracts_generated::generated::GenerationStatus::Failed
    );
    assert_eq!(run.error.as_ref().unwrap().code, "PROVIDER_MODEL_INVALID");
    assert_eq!(
        run.error.as_ref().unwrap().params["model"],
        serde_json::json!("steps=nope")
    );
}

// ---------------------------------------------------------------------------
// 4. Kill injection: process death → recovery → retry/keep/discard
// ---------------------------------------------------------------------------

#[test]
fn kill_injection_recovery_and_cleanup_ops() {
    if std::env::var_os("NEOTAUNGER_KILL_CHILD").is_some() {
        child_kill();
        unreachable!();
    }

    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());

    // Spawn a child process that opens the kernel, starts a slow generation,
    // commits one delta and then aborts (process death). The child runs only
    // this exact test via --exact, so no recursion.
    let exe = std::env::current_exe().expect("test binary path");
    let mut child = StdCommand::new(exe)
        // --nocapture: the child's println must reach the pipe directly;
        // libtest's default capture would swallow it when the child aborts.
        .args([
            "--exact",
            "kill_injection_recovery_and_cleanup_ops",
            "--nocapture",
        ])
        .env("NEOTAUNGER_KILL_CHILD", "1")
        .env("NEOTAUNGER_KILL_ROOT", root.path())
        .env("NEOTAUNGER_KILL_CHAT", CHAT_ID)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kill child");
    let stdout = child.stdout.take().expect("child stdout");
    let stderr = child.stderr.take().expect("child stderr");
    let mut run_id = None;
    let mut child_stdout: Vec<String> = Vec::new();
    for line in BufReader::new(stdout).lines() {
        let line = line.expect("read child stdout");
        if let Some(id) = line.strip_prefix("NEOTAUNGER_RUN_ID=") {
            run_id = Some(id.to_string());
        }
        child_stdout.push(line);
    }
    let _status = child.wait().expect("child wait");
    let child_stderr: String = BufReader::new(stderr)
        .lines()
        .map(|l| l.unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n");
    let run_id = run_id.unwrap_or_else(|| {
        panic!(
            "child must report the run id (status {_status});\nchild stdout:\n{}\nchild stderr:\n{child_stderr}",
            child_stdout.join("\n")
        )
    });

    // The exclusive data-root lease is released by the OS on process death;
    // the run's executor lease expires 30s after its last write. Wait for the
    // expiry so startup recovery can mark the run interrupted.
    std::thread::sleep(Duration::from_secs(31));

    let kernel = open_kernel(root.path());

    // Recovery marked the stale run interrupted; events are durable; no
    // message row.
    let run = get_run(&kernel, &run_id);
    assert_eq!(
        run.status,
        contracts_generated::generated::GenerationStatus::Interrupted
    );
    assert_eq!(run.message_id, None);
    assert!(
        run.partial_text_length > 0,
        "the committed delta must survive"
    );
    let events = list_events(&kernel, &run_id, -1, None);
    let types: Vec<&str> = events.items.iter().map(|e| e.r#type.as_str()).collect();
    assert!(!types.is_empty(), "events are durable across the kill");
    assert!(
        types.iter().all(|t| *t != "generation.completed"),
        "no terminal event"
    );
    assert!(
        list_messages(&kernel, CHAT_ID).is_empty(),
        "no message row after the kill"
    );

    // Retry → attempt 2 completes.
    let mut retry_stream = start_stream(
        &kernel,
        "generation.retry",
        serde_json::json!({ "sourceRunId": run_id }),
    )
    .expect("retry on an interrupted run must succeed");
    let retry_id = retry_stream.stream_id().to_string();
    drain_until_terminal(&mut retry_stream, Duration::from_secs(30));
    let retry_run = get_run(&kernel, &retry_id);
    assert_eq!(
        retry_run.status,
        contracts_generated::generated::GenerationStatus::Completed
    );
    assert_eq!(retry_run.attempt, 2);
    assert_eq!(retry_run.source_run_id.as_deref(), Some(run_id.as_str()));
    assert_eq!(retry_run.chat_id, CHAT_ID);
    assert!(
        retry_run.message_id.is_some(),
        "attempt 2 completed with a message"
    );

    // keep on the interrupted source: message from the partial output.
    let kept: GenerationRun = serde_json::from_value(
        dispatch_json(
            &kernel,
            "generation.keep",
            serde_json::json!({ "workflowId": run_id }),
        )
        .expect("keep must succeed"),
    )
    .expect("keep response shape");
    let kept_message_id = kept.message_id.as_ref().expect("keep sets a message id");
    assert_eq!(
        kept.status,
        contracts_generated::generated::GenerationStatus::Interrupted
    );
    let messages = list_messages(&kernel, CHAT_ID);
    assert_eq!(
        messages.len(),
        2,
        "attempt-2 message + kept partial message"
    );
    let kept_message = messages
        .iter()
        .find(|m| m.id == *kept_message_id)
        .expect("kept message row exists");
    assert_eq!(
        kept_message.generation_run_id.as_deref(),
        Some(run_id.as_str())
    );
    assert_eq!(kept_message.content.len() as i64, kept.partial_text_length);

    // keep is idempotent: same message id on the second call.
    let kept_again: GenerationRun = serde_json::from_value(
        dispatch_json(
            &kernel,
            "generation.keep",
            serde_json::json!({ "workflowId": run_id }),
        )
        .expect("second keep must succeed"),
    )
    .expect("keep response shape");
    assert_eq!(kept_again.message_id, kept.message_id);

    // discard: events gone, partial length zeroed; idempotent.
    let discarded: GenerationRun = serde_json::from_value(
        dispatch_json(
            &kernel,
            "generation.discard",
            serde_json::json!({ "workflowId": run_id }),
        )
        .expect("discard must succeed"),
    )
    .expect("discard response shape");
    assert_eq!(discarded.partial_text_length, 0);
    assert_eq!(discarded.partial_text, None);
    assert!(
        list_events(&kernel, &run_id, -1, None).items.is_empty(),
        "events purged"
    );
    let discarded_again: GenerationRun = serde_json::from_value(
        dispatch_json(
            &kernel,
            "generation.discard",
            serde_json::json!({ "workflowId": run_id }),
        )
        .expect("second discard must succeed"),
    )
    .expect("discard response shape");
    assert_eq!(discarded_again.partial_text_length, 0);
}

/// Child role: open the kernel, start a slow generation, report the run id,
/// wait for one committed delta, then abort — simulating an abrupt process
/// death (no graceful Shutdown, no Drop).
fn child_kill() {
    let root = std::env::var_os("NEOTAUNGER_KILL_ROOT").expect("child root env");
    let chat_id = std::env::var("NEOTAUNGER_KILL_CHAT").expect("child chat env");
    let kernel = open_kernel(std::path::Path::new(&root));
    let flag = CancellationFlag::new();
    let mut stream = kernel
        .dispatch_stream(
            "generation.start",
            &serde_json::to_vec(&serde_json::json!({
                "chatId": chat_id,
                "message": "Hello",
                "model": "steps=8;delay-ms=50;tokens-per-step=48"
            }))
            .expect("serialize"),
            &flag,
        )
        .expect("child generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    println!("NEOTAUNGER_RUN_ID={run_id}");
    match stream.next_notice(Duration::from_secs(30)) {
        Some(StreamNotice::Committed { .. }) => {}
        other => {
            eprintln!("child: expected a committed delta, got {other:?}");
            std::process::abort();
        }
    }
    std::process::abort();
}

// ---------------------------------------------------------------------------
// 5. Terminal replay: exactly one terminal event + one message row
// ---------------------------------------------------------------------------

#[test]
fn terminal_replay_exactly_one_terminal_event_and_message() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "Hello", "model": "steps=2;tokens-per-step=48" }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    let (committed, terminal) = drain_until_terminal(&mut stream, Duration::from_secs(30));
    assert_eq!(committed, vec![0, 1]);

    let events = list_events(&kernel, &run_id, -1, None);
    assert_eq!(events.items.len(), 3, "2 deltas + 1 terminal event");
    let terminal_events: Vec<_> = events
        .items
        .iter()
        .filter(|e| {
            matches!(
                e.r#type.as_str(),
                "generation.completed" | "generation.failed" | "generation.cancelled"
            )
        })
        .collect();
    assert_eq!(terminal_events.len(), 1, "exactly one terminal event");
    assert_eq!(terminal_events[0].r#type, "generation.completed");
    assert_eq!(terminal_events[0].sequence, terminal);

    // The terminal event payload carries the final message.
    assert!(terminal_events[0].payload["finalMessage"]["generationRunId"].is_string());

    // Exactly one message row for the run.
    let messages = list_messages(&kernel, CHAT_ID);
    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0].generation_run_id.as_deref(),
        Some(run_id.as_str())
    );
}

// ---------------------------------------------------------------------------
// 6. State guards
// ---------------------------------------------------------------------------

#[test]
fn generation_state_guards() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    // start with an unknown chat → CHAT_NOT_FOUND.
    let err = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": UNKNOWN_UUID, "message": "Hello" }),
    )
    .expect_err("unknown chat must be rejected");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    assert_eq!(err.product.as_ref().unwrap().code, "CHAT_NOT_FOUND");
    assert_eq!(
        err.product.as_ref().unwrap().params["chatId"],
        serde_json::json!(UNKNOWN_UUID)
    );

    // Unknown runs → GENERATION_RUN_NOT_FOUND on every unary op.
    for op in [
        "generation.get",
        "generation.events",
        "generation.cancel",
        "generation.keep",
        "generation.discard",
    ] {
        let err = dispatch_json(
            &kernel,
            op,
            serde_json::json!({ "workflowId": UNKNOWN_UUID }),
        )
        .expect_err("unknown run must be rejected");
        assert_eq!(err.code, KernelErrorCode::NotFound);
        assert_eq!(
            err.product.as_ref().unwrap().code,
            "GENERATION_RUN_NOT_FOUND"
        );
    }
    let err = start_stream(
        &kernel,
        "generation.retry",
        serde_json::json!({ "sourceRunId": UNKNOWN_UUID }),
    )
    .expect_err("retry with an unknown source must be rejected");
    assert_eq!(
        err.product.as_ref().unwrap().code,
        "GENERATION_RUN_NOT_FOUND"
    );

    // Completed run: retry/keep/cancel → CONFLICT.
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "Hello", "model": "steps=2;tokens-per-step=48" }),
    )
    .expect("start");
    let completed_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));

    let err = start_stream(
        &kernel,
        "generation.retry",
        serde_json::json!({ "sourceRunId": completed_id }),
    )
    .expect_err("retry on a completed run must conflict");
    assert_eq!(err.code, KernelErrorCode::Conflict);
    assert_eq!(
        err.product.as_ref().unwrap().code,
        "GENERATION_RUN_STATE_CONFLICT"
    );
    assert_eq!(
        err.product.as_ref().unwrap().params["status"],
        serde_json::json!("completed")
    );

    for op in ["generation.keep", "generation.cancel"] {
        let err = dispatch_json(
            &kernel,
            op,
            serde_json::json!({ "workflowId": completed_id }),
        )
        .expect_err("completed run must conflict");
        assert_eq!(
            err.product.as_ref().unwrap().code,
            "GENERATION_RUN_STATE_CONFLICT"
        );
        assert_eq!(
            err.product.as_ref().unwrap().params["status"],
            serde_json::json!("completed")
        );
    }

    // Streaming run: keep → CONFLICT while the executor is mid-run.
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "Hello", "model": "steps=10;delay-ms=200;tokens-per-step=48" }),
    )
    .expect("slow start");
    let streaming_id = stream.stream_id().to_string();
    match stream.next_notice(Duration::from_secs(30)) {
        Some(StreamNotice::Committed { .. }) => {}
        other => panic!("expected a committed delta, got {other:?}"),
    }
    let err = dispatch_json(
        &kernel,
        "generation.keep",
        serde_json::json!({ "workflowId": streaming_id }),
    )
    .expect_err("keep on a streaming run must conflict");
    assert_eq!(
        err.product.as_ref().unwrap().code,
        "GENERATION_RUN_STATE_CONFLICT"
    );
    assert_eq!(
        err.product.as_ref().unwrap().params["status"],
        serde_json::json!("streaming")
    );

    // Cleanup: cancel the streaming run and drain it.
    dispatch_json(
        &kernel,
        "generation.cancel",
        serde_json::json!({ "workflowId": streaming_id }),
    )
    .expect("cancel must succeed");
    drain_until_terminal(&mut stream, Duration::from_secs(30));
    assert_eq!(
        get_run(&kernel, &streaming_id).status,
        contracts_generated::generated::GenerationStatus::Cancelled
    );
}

// ---------------------------------------------------------------------------
// 7. Pagination
// ---------------------------------------------------------------------------

#[test]
fn generation_events_pagination() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "Hello", "model": "steps=20;tokens-per-step=8" }),
    )
    .expect("start");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));

    // 20 deltas + 5 checkpoints (delta indices 3,7,11,15,19) + 1 terminal.
    let all = list_events(&kernel, &run_id, -1, None);
    assert_eq!(all.items.len(), 26);
    assert!(!all.has_more, "one page holds everything");
    let checkpoint_count = all
        .items
        .iter()
        .filter(|e| e.r#type == "generation.checkpoint")
        .count();
    assert_eq!(checkpoint_count, 5);

    // Walk the log in pages of 10 with an afterSequence cursor.
    let page1 = list_events(&kernel, &run_id, -1, Some(10));
    assert_eq!(page1.items.len(), 10);
    assert!(page1.has_more);
    let page2 = list_events(
        &kernel,
        &run_id,
        page1.items.last().unwrap().sequence,
        Some(10),
    );
    assert_eq!(page2.items.len(), 10);
    assert!(page2.has_more);
    let page3 = list_events(
        &kernel,
        &run_id,
        page2.items.last().unwrap().sequence,
        Some(10),
    );
    assert_eq!(page3.items.len(), 6);
    assert!(!page3.has_more);

    // The union is the full log: strictly increasing sequences, no gaps,
    // no duplicates.
    let mut seqs: Vec<i64> = Vec::new();
    for page in [&page1, &page2, &page3] {
        for item in &page.items {
            seqs.push(item.sequence);
        }
    }
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "strictly increasing");
    assert_eq!(
        seqs,
        all.items.iter().map(|e| e.sequence).collect::<Vec<_>>()
    );
    assert_eq!(seqs.first(), Some(&0));
    assert_eq!(seqs.last().copied(), all.items.last().map(|e| e.sequence));

    // Limit edge: 1 and 200 both behave.
    let one = list_events(&kernel, &run_id, -1, Some(1));
    assert_eq!(one.items.len(), 1);
    assert!(one.has_more);
    let big = list_events(&kernel, &run_id, -1, Some(200));
    assert_eq!(big.items.len(), 26);

    // afterSequence = last event → empty page, no hasMore.
    let after_last = list_events(
        &kernel,
        &run_id,
        all.items.last().unwrap().sequence,
        Some(10),
    );
    assert!(after_last.items.is_empty());
    assert!(!after_last.has_more);
}

// ---------------------------------------------------------------------------
// 8. Stateless kernel
// ---------------------------------------------------------------------------

#[test]
fn stateless_kernel_generation_ops_storage_failure() {
    let kernel = open_stateless();
    let flag = CancellationFlag::new();

    let err = kernel
        .dispatch_stream(
            "generation.start",
            &serde_json::to_vec(&serde_json::json!({ "chatId": CHAT_ID, "message": "Hello" }))
                .expect("serialize"),
            &flag,
        )
        .expect_err("stateless kernel must reject generation.start");
    assert_eq!(err.code, KernelErrorCode::StorageFailure);
    assert!(
        err.message.contains("durable storage"),
        "message: {}",
        err.message
    );

    let err = kernel
        .dispatch_stream(
            "generation.retry",
            &serde_json::to_vec(&serde_json::json!({ "sourceRunId": UNKNOWN_UUID }))
                .expect("serialize"),
            &flag,
        )
        .expect_err("stateless kernel must reject generation.retry");
    assert_eq!(err.code, KernelErrorCode::StorageFailure);

    for op in [
        "generation.cancel",
        "generation.get",
        "generation.events",
        "generation.keep",
        "generation.discard",
    ] {
        let err = dispatch_json(
            &kernel,
            op,
            serde_json::json!({ "workflowId": UNKNOWN_UUID }),
        )
        .expect_err("stateless kernel must reject the op");
        assert_eq!(err.code, KernelErrorCode::StorageFailure);
    }

    // meta.get still works stateless.
    let meta = dispatch_json(&kernel, "meta.get", serde_json::json!({})).expect("meta.get works");
    assert_eq!(meta["appVersion"], env!("CARGO_PKG_VERSION"));
}

// ---------------------------------------------------------------------------
// 9. Concurrent unary reads during a slow generation
// ---------------------------------------------------------------------------

#[test]
fn concurrent_characters_list_during_stream() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = Arc::new(open_kernel(root.path()));
    let flag = CancellationFlag::new();
    let mut stream = kernel
        .dispatch_stream(
            "generation.start",
            &serde_json::to_vec(&serde_json::json!({
                "chatId": CHAT_ID,
                "message": "Hello",
                "model": "steps=10;delay-ms=30;tokens-per-step=48"
            }))
            .expect("serialize"),
            &flag,
        )
        .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();

    // Wait for the executor to reach streaming (writer loop draining works).
    let mut committed = Vec::new();
    match stream.next_notice(Duration::from_secs(30)) {
        Some(StreamNotice::Committed { through_sequence }) => committed.push(through_sequence),
        other => panic!("expected a committed delta, got {other:?}"),
    }

    // Unary operations stay serviced while the generation streams.
    for _ in 0..10 {
        let value = dispatch_json(&kernel, "characters.list", serde_json::json!({}))
            .expect("characters.list must succeed during a generation");
        assert_eq!(value["items"][0]["id"], serde_json::json!(CHARACTER_ID));
        std::thread::sleep(Duration::from_millis(15));
    }

    // And the run still completes normally.
    let (rest, _terminal) = drain_until_terminal(&mut stream, Duration::from_secs(30));
    committed.extend(rest);
    assert_eq!(committed.len(), 10);
    assert_eq!(
        get_run(&kernel, &run_id).status,
        contracts_generated::generated::GenerationStatus::Completed
    );
}

// ---------------------------------------------------------------------------
// Dispatch-entry guards
// ---------------------------------------------------------------------------

#[test]
fn stream_ops_rejected_by_dispatch_and_vice_versa() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    let flag = CancellationFlag::new();

    // generation.start / retry through dispatch → OperationNotFound.
    let err = dispatch_json(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID }),
    )
    .expect_err("start via dispatch must be rejected");
    assert_eq!(err.code, KernelErrorCode::OperationNotFound);
    assert!(
        err.message.contains("dispatch_stream"),
        "message: {}",
        err.message
    );

    // Non-stream ops through dispatch_stream → OperationNotFound.
    for op in [
        "generation.cancel",
        "generation.get",
        "characters.list",
        "meta.get",
    ] {
        let bytes = serde_json::to_vec(&serde_json::json!({})).expect("serialize");
        let err = kernel
            .dispatch_stream(op, &bytes, &flag)
            .expect_err("non-stream op via dispatch_stream must be rejected");
        assert_eq!(err.code, KernelErrorCode::OperationNotFound);
    }
}
