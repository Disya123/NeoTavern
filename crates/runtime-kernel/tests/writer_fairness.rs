//! Wave 3: writer-thread fairness and shutdown bounds.
//!
//! Covers two P1 defects:
//! 1. `generation.tool.result` executed INLINE inside another run's emit
//!    drain stalled that stream for a full provider turn (head-of-line
//!    blocking); it must be queued for the writer loop instead.
//! 2. `Drop for Kernel` waited unboundedly for the writer; a hung provider
//!    adapter would hang the whole process on exit — Drop must be bounded
//!    and detach the wedged writer.

use provider_sdk::policy::Usage;
use provider_sdk::{
    Availability, CancelToken, EmitStatus, ProviderAdapter, ProviderCapabilities, ProviderError,
    ProviderEvent, ProviderModel, ProviderRequest,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, StreamNotice};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000002";

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

/// First turn: emit the tool call and wait. Resumed turn: run a SLOW final
/// turn (sleep) so an inline execution would be observable.
struct SlowToolAdapter {
    id: &'static str,
    resumed_turn_delay: Duration,
    calls: Arc<AtomicUsize>,
}

impl ProviderAdapter for SlowToolAdapter {
    fn id(&self) -> &str {
        self.id
    }
    fn name(&self) -> &str {
        "Slow Tool Adapter"
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
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
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
            return Ok(Usage::default());
        }
        // Resumed turn: deliberately slow.
        std::thread::sleep(self.resumed_turn_delay);
        for chunk in ["resumed ", "final"] {
            if emit(ProviderEvent::Delta {
                text: chunk.to_string(),
            }) == EmitStatus::Stop
            {
                return Err(ProviderError::new(
                    provider_sdk::ProviderErrorCode::Cancelled,
                    "stopped",
                ));
            }
        }
        let mut usage = Usage::default();
        usage.steps += 1;
        Ok(usage)
    }
}

/// A steady independent stream: one delta every `interval`.
struct DripAdapter {
    id: &'static str,
    interval: Duration,
    deltas: usize,
}

impl ProviderAdapter for DripAdapter {
    fn id(&self) -> &str {
        self.id
    }
    fn name(&self) -> &str {
        "Drip Adapter"
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
        emit: &mut dyn FnMut(ProviderEvent) -> EmitStatus,
    ) -> Result<Usage, ProviderError> {
        for index in 0..self.deltas {
            std::thread::sleep(self.interval);
            if emit(ProviderEvent::Delta {
                text: format!("d{index} "),
            }) == EmitStatus::Stop
            {
                return Err(ProviderError::new(
                    provider_sdk::ProviderErrorCode::Cancelled,
                    "stopped",
                ));
            }
        }
        Ok(Usage::default())
    }
}

/// Never returns: models a hung provider adapter (stuck socket).
struct HungAdapter {
    id: &'static str,
}

impl ProviderAdapter for HungAdapter {
    fn id(&self) -> &str {
        self.id
    }
    fn name(&self) -> &str {
        "Hung Adapter"
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
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
}

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
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \n             VALUES (?1, 'Aria', NULL, NULL, '[]', '{}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
            rusqlite::params![CHARACTER_ID],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) \n             VALUES (?1, 'Fairness test', ?2, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
            rusqlite::params![CHAT_ID, CHARACTER_ID],
        )
        .expect("seed chat");
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seed transaction");
}

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Value {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    let response = kernel
        .dispatch(op, &bytes, &flag)
        .unwrap_or_else(|e| panic!("{op} must succeed: {e:?}"));
    serde_json::from_slice(&response).unwrap_or_else(|e| panic!("{op} response must parse: {e}"))
}

fn start_stream(kernel: &Kernel, request: Value) -> runtime_kernel::EventStream {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch_stream("generation.start", &bytes, &flag)
        .expect("generation.start must succeed")
}

fn waiting_tool_call_id(kernel: &Kernel, run_id: &str) -> String {
    let events = dispatch_json(kernel, "generation.events", json!({ "workflowId": run_id }));
    let step = events["items"]
        .as_array()
        .expect("items array")
        .iter()
        .find(|e| {
            e["type"] == json!("generation.step")
                && e["payload"]["step"]["type"] == json!("tool_call")
                && e["payload"]["step"]["status"] == json!("waiting")
        })
        .unwrap_or_else(|| panic!("no waiting tool_call step event: {events:#?}"));
    step["payload"]["step"]["input"]["toolCall"]["id"]
        .as_str()
        .expect("toolCall.id string")
        .to_string()
}

/// A tool result submitted while a DIFFERENT run's stream is executing must
/// not stall that stream: the resumed provider turn runs on the writer loop
/// after the active executor finishes, and the active stream's notices keep
/// flowing at their own cadence.
#[test]
fn tool_result_resume_does_not_block_another_stream() {
    let resumed_delay = Duration::from_millis(1500);
    let drip_interval = Duration::from_millis(150);

    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    let spec: contracts_generated::generated::ToolSpec =
        serde_json::from_str(TOOL_SPEC).expect("tool spec parses");
    kernel.register_tool(spec);
    let calls = Arc::new(AtomicUsize::new(0));
    kernel.register_provider(Arc::new(SlowToolAdapter {
        id: "slow-tool",
        resumed_turn_delay: resumed_delay,
        calls: Arc::clone(&calls),
    }));
    kernel.register_provider(Arc::new(DripAdapter {
        id: "drip",
        interval: drip_interval,
        deltas: 4,
    }));

    // Run B drives to the durable waiting-for-tool state.
    let mut stream_b = start_stream(
        &kernel,
        json!({ "chatId": CHAT_ID, "message": "weather in Kyiv", "provider": "slow-tool", "model": "m1" }),
    );
    let run_b = stream_b.stream_id().to_string();
    loop {
        match stream_b
            .next_notice(Duration::from_secs(30))
            .expect("waiting terminal")
        {
            StreamNotice::Terminal { .. } => break,
            StreamNotice::Committed { .. } => {}
        }
    }
    let tool_call_id = waiting_tool_call_id(&kernel, &run_b);

    // Stream A starts dripping. While it is mid-stream, submit B's tool
    // result on another thread.
    let mut stream_a = start_stream(
        &kernel,
        json!({ "chatId": CHAT_ID, "message": "independent stream", "provider": "drip", "model": "m1" }),
    );
    std::thread::sleep(drip_interval / 2);
    let submit = json!({
        "runId": run_b,
        "toolCallId": tool_call_id,
        "result": { "celsius": 22, "city": "Kyiv" }
    });
    let resumed = std::thread::scope(|scope| {
        let submitter = scope.spawn(|| dispatch_json(&kernel, "generation.tool.result", submit));

        // A's notices keep arriving at the drip cadence. Under the old inline
        // execution the writer would stall inside the first drain for the
        // whole resumed turn (~1.5s), and the 700ms notice budget below
        // would expire.
        let budget = Duration::from_millis(700);
        let mut saw_terminal = false;
        while let Some(notice) = stream_a.next_notice(budget) {
            match notice {
                StreamNotice::Committed { .. } => {}
                StreamNotice::Terminal { .. } => {
                    saw_terminal = true;
                    break;
                }
            }
        }
        assert!(
            saw_terminal,
            "the independent stream stalled: a tool result turn ran inline in its drain"
        );

        // The deferred tool result applies after the active stream finishes.
        submitter.join().expect("submitter thread")
    });
    assert_eq!(
        resumed["status"],
        json!("completed"),
        "run B resumed: {resumed}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "resumed turn ran exactly once"
    );
}

/// Drop must return in bounded time even when the writer is wedged inside a
/// provider turn that never returns (hung adapter). The wedged writer is
/// detached instead of joining forever.
#[test]
fn drop_is_bounded_with_a_hung_provider() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    kernel.register_provider(Arc::new(HungAdapter { id: "hung" }));

    let stream = start_stream(
        &kernel,
        json!({ "chatId": CHAT_ID, "message": "hang forever", "provider": "hung", "model": "m1" }),
    );
    // The writer is now inside the hung generate; give it a moment to get
    // there before dropping.
    std::thread::sleep(Duration::from_millis(300));
    assert!(!stream.stream_id().is_empty());

    let started = Instant::now();
    drop(kernel);
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(20),
        "Drop blocked {elapsed:?} on a wedged writer"
    );
}
