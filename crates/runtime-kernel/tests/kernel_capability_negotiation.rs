//! ТЗ §9.3 — provider capability declaration + `CAPABILITY_UNAVAILABLE`
//! pre-negotiation (M5 slice 4).
//!
//! Behavioral proofs, not greps:
//! - `providers.list` surfaces each adapter's honest capability declaration
//!   (`wire.provider.capabilities`);
//! - when a run would send tool calls, a provider that does NOT declare tool
//!   support fails with `CAPABILITY_UNAVAILABLE` BEFORE the network request
//!   (the adapter's `generate` is never invoked — probe counter stays 0) and
//!   the run terminates durably `failed` with the capability in `params`;
//! - a provider that DOES declare tools passes negotiation and reaches the
//!   durable `waiting_for_tool` state (the golden tool round trip start).

use contracts_generated::generated::{GenerationRun, GenerationStatus, ToolSpec};
use provider_sdk::policy::Usage;
use provider_sdk::{
    Availability, CancelToken, EmitStatus, ProviderAdapter, ProviderCapabilities, ProviderError,
    ProviderEvent, ProviderModel, ProviderRequest,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, StreamNotice};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000002";

/// The registered tool contract (same shape as the tool_loop golden spec).
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

/// A test adapter WITHOUT tool support; `generate` increments a probe counter
/// so tests can prove it was never reached.
struct NoToolsAdapter {
    id: &'static str,
    generate_calls: Arc<AtomicUsize>,
}

impl ProviderAdapter for NoToolsAdapter {
    fn id(&self) -> &str {
        self.id
    }
    fn name(&self) -> &str {
        "No-Tools Test Adapter"
    }
    fn builtin(&self) -> bool {
        false
    }
    fn models(&self) -> Vec<ProviderModel> {
        vec![ProviderModel {
            id: "m1".to_string(),
            name: "M1".to_string(),
            context_limit: None,
            max_output_tokens: None,
        }]
    }
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            tools: false,
            vision: false,
            thinking: false,
            json_mode: false,
            streaming: true,
        }
    }
    fn generate(
        &self,
        _request: &ProviderRequest<'_>,
        _cancel: CancelToken<'_>,
        _emit: &mut dyn FnMut(ProviderEvent) -> EmitStatus,
    ) -> Result<Usage, ProviderError> {
        self.generate_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Usage::default())
    }
}

/// A test adapter WITH tool support: emits one normalized tool request.
struct ToolAdapter {
    id: &'static str,
    generate_calls: Arc<AtomicUsize>,
}

impl ProviderAdapter for ToolAdapter {
    fn id(&self) -> &str {
        self.id
    }
    fn name(&self) -> &str {
        "Tool Test Adapter"
    }
    fn builtin(&self) -> bool {
        false
    }
    fn models(&self) -> Vec<ProviderModel> {
        vec![ProviderModel {
            id: "m1".to_string(),
            name: "M1".to_string(),
            context_limit: None,
            max_output_tokens: None,
        }]
    }
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            tools: true,
            vision: false,
            thinking: false,
            json_mode: false,
            streaming: true,
        }
    }
    fn generate(
        &self,
        _request: &ProviderRequest<'_>,
        _cancel: CancelToken<'_>,
        emit: &mut dyn FnMut(ProviderEvent) -> EmitStatus,
    ) -> Result<Usage, ProviderError> {
        self.generate_calls.fetch_add(1, Ordering::SeqCst);
        let mut usage = Usage::default();
        if emit(ProviderEvent::ToolCall {
            id: "call-1".to_string(),
            name: "lookup_weather".to_string(),
            arguments: json!({ "query": "Kyiv" }),
        }) == EmitStatus::Stop
        {
            return Err(ProviderError::new(
                provider_sdk::ProviderErrorCode::Cancelled,
                "stopped",
            ));
        }
        usage.steps += 1;
        Ok(usage)
    }
}

// ---------------------------------------------------------------------------
// Helpers (mirror tool_loop.rs)
// ---------------------------------------------------------------------------

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

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
             VALUES (?1, 'Capability test', ?2, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
            rusqlite::params![CHAT_ID, CHARACTER_ID],
        )
        .expect("seed chat");
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
    drop(db);
}

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

fn start_stream(
    kernel: &Kernel,
    op: &str,
    request: Value,
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
    let value = dispatch_json(kernel, "generation.get", json!({ "workflowId": run_id }))
        .expect("generation.get must succeed");
    serde_json::from_value(value).expect("get response must be a GenerationRun")
}

fn register_weather_tool(kernel: &Kernel) {
    let spec: ToolSpec = serde_json::from_str(TOOL_SPEC).expect("tool spec parses");
    kernel.register_tool(spec);
}

fn failed_event_code(kernel: &Kernel, run_id: &str) -> (String, Value) {
    let value = dispatch_json(kernel, "generation.events", json!({ "workflowId": run_id }))
        .expect("generation.events must succeed");
    let items = value["items"].as_array().expect("items array");
    let failed = items
        .iter()
        .find(|e| e["type"] == json!("generation.failed"))
        .unwrap_or_else(|| panic!("no generation.failed event: {items:#?}"));
    let code = failed["payload"]["error"]["code"]
        .as_str()
        .expect("error code string")
        .to_string();
    let params = failed["payload"]["error"]["params"].clone();
    (code, params)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn providers_list_declares_honest_capabilities() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let calls = Arc::new(AtomicUsize::new(0));
    kernel.register_provider(Arc::new(NoToolsAdapter {
        id: "no-tools",
        generate_calls: calls,
    }));

    let value = dispatch_json(&kernel, "providers.list", json!({})).expect("list must succeed");
    let items = value["items"].as_array().expect("items array");

    let fake = items
        .iter()
        .find(|p| p["id"] == json!("fake"))
        .unwrap_or_else(|| panic!("built-in fake provider must be listed: {items:#?}"));
    assert_eq!(
        fake["capabilities"]["tools"],
        json!(true),
        "fake declares tools (tool-loop mode)"
    );
    assert_eq!(fake["capabilities"]["streaming"], json!(true));
    assert_eq!(fake["capabilities"]["vision"], json!(false));

    let no_tools = items
        .iter()
        .find(|p| p["id"] == json!("no-tools"))
        .unwrap_or_else(|| panic!("registered no-tools provider must be listed: {items:#?}"));
    assert_eq!(
        no_tools["capabilities"]["tools"],
        json!(false),
        "no-tools must be honest"
    );
    assert_eq!(no_tools["capabilities"]["jsonMode"], json!(false));
}

#[test]
fn capability_negotiation_fails_before_the_network_request() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    let calls = Arc::new(AtomicUsize::new(0));
    kernel.register_provider(Arc::new(NoToolsAdapter {
        id: "no-tools",
        generate_calls: calls.clone(),
    }));
    register_weather_tool(&kernel);

    let mut stream = start_stream(
        &kernel,
        "generation.start",
        json!({ "chatId": CHAT_ID, "message": "weather in Kyiv", "provider": "no-tools", "model": "m1" }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    let (_committed, terminal) = drain_until_terminal(&mut stream, Duration::from_secs(30));
    // Pre-negotiation fails the run BEFORE any delta, so no checkpoint
    // notice precedes the terminal; the failed event itself is the run's
    // first durable event (sequence 0 — a fresh run starts at -1).
    assert_eq!(terminal, 0, "the failed terminal event is the first event");

    // The run terminated durably failed with CAPABILITY_UNAVAILABLE.
    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Failed);
    let (code, params) = failed_event_code(&kernel, &run_id);
    assert_eq!(code, "CAPABILITY_UNAVAILABLE");
    assert_eq!(params["capability"], json!("tools"));
    assert_eq!(params["provider"], json!("no-tools"));

    // The probe proves the network request never happened: `generate` was
    // never invoked (pre-negotiation, ТЗ §9.3 — no silent downgrade).
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "adapter.generate must never run for a capability the provider lacks"
    );
}

#[test]
fn capability_negotiation_passes_and_reaches_waiting_for_tool() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    let calls = Arc::new(AtomicUsize::new(0));
    kernel.register_provider(Arc::new(ToolAdapter {
        id: "tool-adapter",
        generate_calls: calls.clone(),
    }));
    register_weather_tool(&kernel);

    let mut stream = start_stream(
        &kernel,
        "generation.start",
        json!({ "chatId": CHAT_ID, "message": "weather in Kyiv", "provider": "tool-adapter", "model": "m1" }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));

    // Negotiation passed: the adapter ran once and the run waits durably.
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "tools-capable adapter runs exactly once"
    );
    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::WaitingForTool);
    assert_eq!(run.message_id, None, "no message before the tool result");
}
