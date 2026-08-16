//! Host tool executor integration tests (ТЗ §8.3, §9.3, M5 slice 57).
//!
//! The desktop host performs the effects of registered safe tools: a
//! `generation.start` stream whose provider emits a `tool_call` step is
//! auto-resumed by the host executor (`generation.tool.result`), and the
//! poller keeps forwarding the durable journal until the run completes —
//! WITHOUT the UI or any external actor submitting the result. The no-executor
//! control keeps the pre-slice behavior: the run stays durably waiting and
//! the consumer stream closes.

use neotavern_tauri_local::executor::BuiltinToolExecutor;
use neotavern_tauri_local::{build_request_envelope, KernelHost, KernelHostConfig};
use std::sync::Arc;
use std::time::{Duration, Instant};

const REQ_ID: &str = "00000000-0000-4000-8000-000000000001";

fn open_host(root: &tempfile::TempDir) -> KernelHost {
    KernelHost::open(KernelHostConfig {
        data_root: Some(root.path().to_path_buf()),
    })
    .expect("host opens on a fresh data root")
}

fn dispatch_ok(
    host: &KernelHost,
    operation_id: &str,
    payload: serde_json::Value,
) -> serde_json::Value {
    let request = build_request_envelope(operation_id, payload, REQ_ID);
    let body = host
        .dispatch_envelope(&request)
        .expect("transport accepts the envelope");
    let envelope: serde_json::Value = serde_json::from_slice(&body).expect("response is JSON");
    match envelope.get("kind").and_then(|k| k.as_str()) {
        Some("ok") => envelope
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        _ => panic!(
            "{}: error envelope {}",
            operation_id,
            envelope
                .get("error")
                .map(|e| e.to_string())
                .unwrap_or_default()
        ),
    }
}

fn setup_chat(host: &KernelHost) -> String {
    let character = dispatch_ok(
        host,
        "characters.create",
        serde_json::json!({ "name": "Aria", "description": "host tool test", "tags": [] }),
    );
    let chat = dispatch_ok(
        host,
        "chats.create",
        serde_json::json!({
            "characterId": character["id"].as_str().expect("character id"),
            "title": "host tool test",
        }),
    );
    let chat_id = chat["id"].as_str().expect("chat id").to_string();
    dispatch_ok(
        host,
        "chats.messages.create",
        serde_json::json!({ "chatId": chat_id, "role": "user", "content": "What time is it?" }),
    );
    chat_id
}

/// Runs a `generation.start` stream through the REAL host path and collects
/// every forwarded event envelope until the end-of-stream sentinel.
fn run_stream(host: &KernelHost, payload: serde_json::Value) -> (String, Vec<serde_json::Value>) {
    let request = build_request_envelope("generation.start", payload, REQ_ID);
    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
    let body = host
        .open_stream(&request, move |event| {
            let _ = tx.send(event);
            Ok(())
        })
        .expect("stream opens");
    let envelope: serde_json::Value = serde_json::from_slice(&body).expect("stream response JSON");
    assert_eq!(
        envelope.get("kind").and_then(|k| k.as_str()),
        Some("ok"),
        "stream must open: {envelope}"
    );
    let stream_id = envelope["result"]["streamId"]
        .as_str()
        .expect("streamId")
        .to_string();
    let mut events = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "stream did not terminate in time");
        let event = rx
            .recv_timeout(remaining.min(Duration::from_secs(5)))
            .expect("channel closed without a terminal sentinel");
        if event.is_null() {
            break;
        }
        events.push(event);
    }
    (stream_id, events)
}

#[test]
fn host_executor_completes_the_safe_tool_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let host = open_host(&root);
    let chat_id = setup_chat(&host);

    // The host registers the declarative contract AND the effect executor.
    host.register_tool(serde_json::json!({
        "id": "app.now",
        "name": "app_now",
        "description": "Return the current UTC date and time.",
        "inputSchema": { "type": "object" },
    }))
    .expect("app_now spec registers");
    host.set_tool_executor(Some(Arc::new(BuiltinToolExecutor)));

    // The fake provider's tool grammar emits `app_now` after the first turn.
    let (run_id, events) = run_stream(
        &host,
        serde_json::json!({
            "chatId": chat_id,
            "message": "What time is it?",
            "provider": "fake",
            "model": "tool=app_now",
        }),
    );

    // The stream forwarded the durable steps, including the resumed turn —
    // the executor's submission happened inside the poller.
    let step_types: Vec<&str> = events
        .iter()
        .filter_map(|event| event["payload"]["step"]["type"].as_str())
        .collect();
    assert!(
        step_types.contains(&"tool_call"),
        "journal must contain a tool_call step: {step_types:?}"
    );
    assert!(
        step_types.contains(&"tool_result"),
        "journal must contain a tool_result step: {step_types:?}"
    );
    assert!(
        step_types.contains(&"final_commit"),
        "journal must contain the final_commit step: {step_types:?}"
    );

    // The run completed durably with the resumed text.
    let run = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": run_id }),
    );
    assert_eq!(run["status"], serde_json::json!("completed"), "{run}");

    let messages = dispatch_ok(
        &host,
        "chats.messages.list",
        serde_json::json!({ "chatId": chat_id, "limit": 200 }),
    );
    let assistant = messages["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|m| m["role"] == "assistant")
        .expect("one assistant message");
    let content = assistant["content"].as_str().expect("content");
    assert!(
        content.starts_with("[tool-result 1]"),
        "the resumed turn received the tool result: {content}"
    );
}

#[test]
fn without_an_executor_the_run_stays_durably_waiting() {
    let root = tempfile::tempdir().expect("tempdir");
    let host = open_host(&root);
    let chat_id = setup_chat(&host);

    // Tool contract registered, NO executor — the pre-slice behavior.
    host.register_tool(serde_json::json!({
        "id": "app.now",
        "name": "app_now",
        "description": "Return the current UTC date and time.",
        "inputSchema": { "type": "object" },
    }))
    .expect("app_now spec registers");

    let (run_id, events) = run_stream(
        &host,
        serde_json::json!({
            "chatId": chat_id,
            "message": "What time is it?",
            "provider": "fake",
            "model": "tool=app_now",
        }),
    );

    // The stream closed at the waiting point (no tool_result was produced).
    let step_types: Vec<&str> = events
        .iter()
        .filter_map(|event| event["payload"]["step"]["type"].as_str())
        .collect();
    assert!(step_types.contains(&"tool_call"));
    assert!(!step_types.contains(&"tool_result"));

    // The run is durably waiting for the tool result (derived wire status).
    let run = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": run_id }),
    );
    assert_eq!(
        run["status"],
        serde_json::json!("waiting_for_tool"),
        "{run}"
    );
}
