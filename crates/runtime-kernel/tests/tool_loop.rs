//! Этап 2.7 (ТЗ §8.3): durable run/step journal + tool-call loop.
//!
//! Covers the golden tool round trip (waiting_for_tool → tool result →
//! completed), the declarative tool registry (`generation.tools.list`),
//! rejection paths (unknown tool, invalid arguments, stale result, loop
//! limit) and crash-at-wait recovery (fresh lease → reopen → resume).

use contracts_generated::generated::{GenerationRun, GenerationStatus, PagedGenerationEvents};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, StreamNotice};
use std::time::Duration;

/// Fixed chat id (wire-uuid-shaped) for deterministic fake deltas.
const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000002";

/// The registered tool contract for the GOLDEN flow (id `lookup-weather`,
/// name `lookup_weather`). Its schema accepts exactly what the fake adapter
/// produces: `{"query": "<input>"}`.
const TOOL_SPEC: &str = r#"{
  "id": "lookup-weather",
  "name": "lookup_weather",
  "description": "Look up the current weather for a city.",
  "inputSchema": {
    "type": "object",
    "properties": { "query": { "type": "string" } },
    "required": ["query"],
    "additionalProperties": false
  }
}"#;

/// A strict contract used by the invalid-arguments test: requires `city`,
/// which the fake adapter's `{"query": ...}` call violates.
const STRICT_SPEC: &str = r#"{
  "id": "lookup-weather",
  "name": "lookup_weather",
  "description": "Look up the current weather for a city.",
  "inputSchema": {
    "type": "object",
    "properties": { "city": { "type": "string" } },
    "required": ["city"],
    "additionalProperties": false
  }
}"#;

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
             VALUES (?1, 'Tool test', ?2, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
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

fn list_events(kernel: &Kernel, run_id: &str) -> PagedGenerationEvents {
    let value = dispatch_json(
        kernel,
        "generation.events",
        serde_json::json!({ "workflowId": run_id }),
    )
    .expect("generation.events must succeed");
    serde_json::from_value(value).expect("events response must be PagedGenerationEvents")
}

/// Registers the golden lookup_weather tool contract.
fn register_weather_tool(kernel: &Kernel) {
    let spec: contracts_generated::generated::ToolSpec =
        serde_json::from_str(TOOL_SPEC).expect("tool spec parses");
    kernel.register_tool(spec);
}

/// Registers the strict contract used by the invalid-arguments test.
fn register_strict_tool(kernel: &Kernel) {
    let spec: contracts_generated::generated::ToolSpec =
        serde_json::from_str(STRICT_SPEC).expect("strict tool spec parses");
    kernel.register_tool(spec);
}

/// Starts a `tool=<name>` run and drives it to the durable waiting state,
/// returning `(root, kernel, run_id, terminal_sequence)`.
fn run_to_waiting(model: &str) -> (tempfile::TempDir, Kernel, String, i64) {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    register_weather_tool(&kernel);
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "weather in Kyiv", "model": model }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    let (committed, terminal) = drain_until_terminal(&mut stream, Duration::from_secs(30));
    assert!(
        committed.len() >= 2,
        "provider_turn + tool_call step events must be committed"
    );
    assert_eq!(terminal, *committed.last().unwrap());
    (root, kernel, run_id, terminal)
}

/// Extracts the durable toolCallId from the `tool_call` step event.
fn waiting_tool_call_id(kernel: &Kernel, run_id: &str) -> String {
    let events = list_events(kernel, run_id);
    let step = events
        .items
        .iter()
        .find(|e| {
            e.r#type == "generation.step"
                && e.payload["step"]["type"] == serde_json::json!("tool_call")
                && e.payload["step"]["status"] == serde_json::json!("waiting")
        })
        .unwrap_or_else(|| panic!("no waiting tool_call step event: {events:#?}"));
    step.payload["step"]["input"]["toolCall"]["id"]
        .as_str()
        .expect("toolCall.id must be a string")
        .to_string()
}

/// The step types journaled for a run, in sequence order.
fn step_types(kernel: &Kernel, run_id: &str) -> Vec<String> {
    let events = list_events(kernel, run_id);
    let mut steps: Vec<(i64, String)> = events
        .items
        .iter()
        .filter(|e| e.r#type == "generation.step")
        .map(|e| {
            (
                e.payload["step"]["sequence"].as_i64().unwrap_or(-1),
                e.payload["step"]["type"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            )
        })
        .collect();
    steps.sort_by_key(|(sequence, _)| *sequence);
    steps.into_iter().map(|(_, r#type)| r#type).collect()
}

// ---------------------------------------------------------------------------
// Golden tool round trip
// ---------------------------------------------------------------------------

#[test]
fn golden_tool_round_trip() {
    let (_root, kernel, run_id, terminal) = run_to_waiting("tool=lookup_weather");

    // The run is durably waiting; the wire status derives waiting_for_tool.
    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::WaitingForTool);
    assert_eq!(run.message_id, None, "no message before the tool result");

    // Step journal after turn 1: provider_turn + tool_call (waiting).
    assert_eq!(
        step_types(&kernel, &run_id),
        vec!["provider_turn", "tool_call"]
    );

    // The kernel replaced the adapter's non-uuid call id with a fresh uuid.
    let tool_call_id = waiting_tool_call_id(&kernel, &run_id);
    assert!(
        tool_call_id.contains('-'),
        "kernel-assigned toolCallId must be uuid-shaped, got {tool_call_id}"
    );
    assert!(
        !tool_call_id.starts_with("fake"),
        "the adapter id must not leak: {tool_call_id}"
    );

    // The declared tool is visible through the registry listing.
    let listed = dispatch_json(&kernel, "generation.tools.list", serde_json::json!({}))
        .expect("generation.tools.list must succeed");
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        listed["items"][0]["name"],
        serde_json::json!("lookup_weather")
    );

    // Submit the tool result: the resumed turn completes the run.
    let response = dispatch_json(
        &kernel,
        "generation.tool.result",
        serde_json::json!({
            "runId": run_id,
            "toolCallId": tool_call_id,
            "result": { "celsius": 22, "city": "Kyiv" }
        }),
    )
    .expect("generation.tool.result must succeed");
    let resumed: GenerationRun = serde_json::from_value(response).expect("response shape");
    assert_eq!(resumed.status, GenerationStatus::Completed);
    assert_eq!(resumed.run_id, run_id);
    let message_id = resumed
        .message_id
        .as_ref()
        .expect("completed run has a message");

    // The resumed turn journaled its own provider_turn + the final_commit.
    assert_eq!(
        step_types(&kernel, &run_id),
        vec![
            "provider_turn",
            "tool_call",
            "tool_result",
            "provider_turn",
            "final_commit"
        ]
    );

    // Exactly one assistant message persisted; its content is the fake
    // provider's deterministic tool-mode final text.
    let messages = dispatch_json(
        &kernel,
        "chats.messages.list",
        serde_json::json!({ "chatId": CHAT_ID, "limit": 200 }),
    )
    .expect("chats.messages.list must succeed");
    let items = messages["items"].as_array().expect("messages array");
    assert_eq!(items.len(), 1, "exactly one assistant message");
    assert_eq!(items[0]["id"], serde_json::json!(message_id));
    assert_eq!(items[0]["generationRunId"], serde_json::json!(run_id));
    let content = items[0]["content"].as_str().expect("content string");
    assert!(
        content.starts_with("[tool-result 1] final "),
        "resumed final text, got {content}"
    );

    // Events after the resume: the terminal completed event ends the log.
    let events = list_events(&kernel, &run_id);
    assert_eq!(events.items.last().unwrap().r#type, "generation.completed");
    // terminal (waiting seq) + tool_result + resumed delta + turn2
    // provider_turn + final_commit + the completed event.
    assert_eq!(events.items.last().unwrap().sequence, terminal + 5);
}

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

#[test]
fn unregistered_tool_fails_the_run() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    // NOTE: no tool registered — the call names a tool the kernel never saw.
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "hi", "model": "tool=ghost_tool" }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));
    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Failed);
    let error = run.error.as_ref().expect("failed run carries an error");
    assert_eq!(error.code, "TOOL_NOT_FOUND");
    assert_eq!(error.params["toolName"], serde_json::json!("ghost_tool"));
    assert_eq!(run.message_id, None);
}

#[test]
fn invalid_arguments_fail_the_run() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    register_strict_tool(&kernel);
    // The fake adapter calls with {"query": ...} — the strict schema requires
    // the `city` property and forbids additional properties.
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "hi", "model": "tool=lookup_weather" }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));
    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Failed);
    let error = run.error.as_ref().expect("failed run carries an error");
    assert_eq!(error.code, "TOOL_ARGS_INVALID");
    assert_eq!(
        error.params["toolName"],
        serde_json::json!("lookup_weather")
    );
}

#[test]
fn stale_tool_result_is_rejected() {
    let (_root, kernel, run_id, _terminal) = run_to_waiting("tool=lookup_weather");
    let real_call_id = waiting_tool_call_id(&kernel, &run_id);

    // A result for a tool call this run never issued → TOOL_RESULT_STALE.
    let err = dispatch_json(
        &kernel,
        "generation.tool.result",
        serde_json::json!({
            "runId": run_id,
            "toolCallId": "00000000-0000-4000-8000-00000000dead",
            "result": { "celsius": 1 }
        }),
    )
    .expect_err("stale tool call id must be rejected");
    assert_eq!(err.product.as_ref().unwrap().code, "TOOL_RESULT_STALE");

    // The run is STILL waiting and the correct id still resumes it.
    assert_eq!(
        get_run(&kernel, &run_id).status,
        GenerationStatus::WaitingForTool
    );
    let response = dispatch_json(
        &kernel,
        "generation.tool.result",
        serde_json::json!({
            "runId": run_id,
            "toolCallId": real_call_id,
            "result": { "celsius": 22 }
        }),
    )
    .expect("correct tool call id resumes the run");
    let resumed: GenerationRun = serde_json::from_value(response).expect("response shape");
    assert_eq!(resumed.status, GenerationStatus::Completed);
}

#[test]
fn tool_result_on_non_waiting_run_is_stale() {
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
    drain_until_terminal(&mut stream, Duration::from_secs(30));
    assert_eq!(
        get_run(&kernel, &run_id).status,
        GenerationStatus::Completed
    );

    let err = dispatch_json(
        &kernel,
        "generation.tool.result",
        serde_json::json!({
            "runId": run_id,
            "toolCallId": "00000000-0000-4000-8000-00000000dead",
            "result": { "celsius": 1 }
        }),
    )
    .expect_err("result on a completed run must be rejected");
    assert_eq!(err.product.as_ref().unwrap().code, "TOOL_RESULT_STALE");
}

#[test]
fn tool_loop_limit_fails_the_run() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    register_weather_tool(&kernel);
    // tool-loop: EVERY turn emits a call — the loop guard must fail the run
    // after MAX_TOOL_CALLS (8) round trips.
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "hi", "model": "tool-loop=lookup_weather" }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();

    // The stream session ends at the first waiting transition (provider_turn
    // + tool_call step events); every resumed turn runs inside the
    // generation.tool.result unary op.
    let (committed, _terminal) = drain_until_terminal(&mut stream, Duration::from_secs(60));
    assert_eq!(committed.len(), 2, "provider_turn + tool_call step events");

    // Each waiting state is fed its tool result. The kernel assigns a fresh
    // uuid per call, so the CURRENT pending call is the highest-sequence
    // waiting tool_call step.
    let mut submitted = std::collections::HashSet::new();
    for round in 0..8 {
        let events = list_events(&kernel, &run_id);
        let mut waiting: Vec<(i64, String)> = events
            .items
            .iter()
            .filter(|e| {
                e.r#type == "generation.step"
                    && e.payload["step"]["type"] == serde_json::json!("tool_call")
                    && e.payload["step"]["status"] == serde_json::json!("waiting")
            })
            .filter_map(|e| {
                e.payload["step"]["sequence"].as_i64().zip(
                    e.payload["step"]["input"]["toolCall"]["id"]
                        .as_str()
                        .map(str::to_string),
                )
            })
            .collect();
        waiting.sort_by_key(|(sequence, _)| *sequence);
        let (_, call_id) = waiting.last().expect("a waiting tool_call step exists");
        let call_id = call_id.clone();
        assert!(
            submitted.insert(call_id.clone()),
            "each round submits a distinct tool call id"
        );
        let run = get_run(&kernel, &run_id);
        assert_eq!(
            run.status,
            GenerationStatus::WaitingForTool,
            "round {round}: the run must keep waiting while under the loop limit"
        );
        let response = dispatch_json(
            &kernel,
            "generation.tool.result",
            serde_json::json!({
                "runId": run_id,
                "toolCallId": call_id,
                "result": { "celsius": 22 }
            }),
        )
        .expect("tool result within the budget must succeed");
        let resumed: GenerationRun = serde_json::from_value(response).expect("response shape");
        // The 8th result drives turn 9, whose call trips the loop guard — the
        // run fails inside that submission.
        assert!(
            matches!(
                resumed.status,
                GenerationStatus::WaitingForTool | GenerationStatus::Failed
            ),
            "round {round}: unexpected status {:?}",
            resumed.status
        );
    }

    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Failed);
    let error = run.error.as_ref().expect("failed run carries an error");
    assert_eq!(error.code, "TOOL_LOOP_LIMIT");
    assert_eq!(error.params["limit"], serde_json::json!("8"));
    assert_eq!(run.message_id, None, "no message after the loop guard");
}

// ---------------------------------------------------------------------------
// Crash-at-wait recovery
// ---------------------------------------------------------------------------

#[test]
fn crash_at_wait_reopens_and_resumes() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    register_weather_tool(&kernel);
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({ "chatId": CHAT_ID, "message": "weather in Kyiv", "model": "tool=lookup_weather" }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));
    let tool_call_id = waiting_tool_call_id(&kernel, &run_id);

    // Simulate a crash: drop the kernel WITHOUT submitting the result. The
    // waiting state is durable (pending marker + fresh lease), so recovery on
    // the next open must NOT interrupt the run.
    drop(kernel);
    let reopened = open_kernel(root.path());
    register_weather_tool(&reopened);
    let run = get_run(&reopened, &run_id);
    assert_eq!(
        run.status,
        GenerationStatus::WaitingForTool,
        "a fresh lease survives a reopen; the waiting state is durable"
    );

    // The host resubmits the result on the reopened kernel; the run completes.
    let response = dispatch_json(
        &reopened,
        "generation.tool.result",
        serde_json::json!({
            "runId": run_id,
            "toolCallId": tool_call_id,
            "result": { "celsius": 18 }
        }),
    )
    .expect("generation.tool.result after reopen must succeed");
    let resumed: GenerationRun = serde_json::from_value(response).expect("response shape");
    assert_eq!(resumed.status, GenerationStatus::Completed);
    assert_eq!(
        step_types(&reopened, &run_id),
        vec![
            "provider_turn",
            "tool_call",
            "tool_result",
            "provider_turn",
            "final_commit"
        ]
    );
}

// ---------------------------------------------------------------------------
// Registry guards
// ---------------------------------------------------------------------------

#[test]
fn tools_list_is_empty_without_registration() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    let listed = dispatch_json(&kernel, "generation.tools.list", serde_json::json!({}))
        .expect("generation.tools.list must succeed");
    assert_eq!(listed["items"].as_array().unwrap().len(), 0);
}
