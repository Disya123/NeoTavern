//! OpenAI-compatible provider through the kernel (ТЗ §9.3/§9.4, Этап 2.5).
//!
//! Golden slice: a configured OpenAI-compatible provider is registered in the
//! kernel registry, `providers.config.set` stores its API key through the
//! SecretStore seam (never in the DB), and a full `generation.start` run
//! streams deltas from a raw-TCP mock endpoint, resolves the key at execution
//! time, and saves the assistant message durably — proving the
//! config → secret → provider → streaming → durable-save path end to end.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use contracts_generated::generated::{GenerationRun, GenerationStatus, MessageRole, PagedMessages};
use provider_sdk::secret::{SecretRef, SecretResolver, SecretValue};
use provider_sdk::ProviderError;
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelErrorCode, StreamNotice};
use secret_store::memory::MemorySecretStore;
use secret_store::SecretStore;
use serde_json::json;

const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000002";
const RESOLVED_KEY: &str = "sk-resolved-at-execution";

/// Resolver that hands out the sentinel key for any reference — stands in for
/// the host's OS vault / Keystore seam.
struct FixedSecretResolver;

impl SecretResolver for FixedSecretResolver {
    fn resolve(&self, _reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        Ok(SecretValue::new(RESOLVED_KEY))
    }
}

/// A single-shot raw-TCP mock of an OpenAI-compatible chat-completions
/// endpoint. Captures the full request for assertions.
struct MockEndpoint {
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    captured: Arc<Mutex<Option<String>>>,
}

impl MockEndpoint {
    fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock binds");
        listener.set_nonblocking(true).expect("nonblocking");
        let addr = listener.local_addr().expect("addr");
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = Arc::clone(&shutdown);
        let captured = Arc::new(Mutex::new(None));
        let captured_clone = Arc::clone(&captured);
        // Detached listener thread: Drop closes it via the shutdown flag.
        std::thread::spawn(move || loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let request = read_request(&mut stream);
                    *captured_clone.lock().expect("lock") = Some(request);
                    let body = format!(
                        "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                        delta("Hello"),
                        delta(" world"),
                        delta("!")
                    );
                    let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                            body.len(),
                            body
                        );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    return;
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    if shutdown_clone.load(Ordering::SeqCst) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        });
        Self {
            addr,
            shutdown,
            captured,
        }
    }

    fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn captured_request(&self) -> String {
        self.captured
            .lock()
            .expect("lock")
            .clone()
            .unwrap_or_default()
    }
}

impl Drop for MockEndpoint {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).expect("head read") == 0 {
            break;
        }
        head.push(byte[0]);
    }
    let head_text = String::from_utf8_lossy(&head).to_string();
    let content_length: usize = head_text
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        stream.read_exact(&mut body).expect("body read");
    }
    format!("{head_text}{}", String::from_utf8_lossy(&body))
}

fn delta(text: &str) -> String {
    format!(r#"{{"choices":[{{"delta":{{"content":"{text}"}},"finish_reason":null}}]}}"#)
}

// ---------------------------------------------------------------------------
// Helpers (mirror crates/runtime-kernel/tests/providers.rs)
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
             VALUES (?1, 'OpenAI test', ?2, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
            rusqlite::params![CHAT_ID, CHARACTER_ID],
        )
        .expect("seed chat");
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

fn drain_until_terminal(stream: &mut runtime_kernel::EventStream) -> Vec<i64> {
    let mut committed = Vec::new();
    loop {
        match stream.next_notice(Duration::from_secs(30)) {
            Some(StreamNotice::Committed { through_sequence }) => committed.push(through_sequence),
            Some(StreamNotice::Terminal { .. }) => return committed,
            None => panic!("stream ended without a terminal notice"),
        }
    }
}

fn get_run(kernel: &Kernel, run_id: &str) -> GenerationRun {
    serde_json::from_slice(&dispatch_bytes(
        kernel,
        "generation.get",
        json!({ "workflowId": run_id }),
    ))
    .expect("get response must be a GenerationRun")
}

fn list_messages(kernel: &Kernel, chat_id: &str) -> PagedMessages {
    serde_json::from_slice(&dispatch_bytes(
        kernel,
        "chats.messages.list",
        json!({ "chatId": chat_id, "limit": 200 }),
    ))
    .expect("messages response shape")
}

/// A raw-TCP mock endpoint that serves TWO scripted chat-completions
/// responses (first provider turn → tool call; resumed turn → final text),
/// capturing each request body for assertions.
struct MockToolServer {
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    captured: Arc<Mutex<Vec<String>>>,
}

impl MockToolServer {
    fn spawn(script: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock binds");
        listener.set_nonblocking(true).expect("nonblocking");
        let addr = listener.local_addr().expect("addr");
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = Arc::clone(&shutdown);
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);
        std::thread::spawn(move || {
            for (index, body) in script.iter().enumerate() {
                // Block until the adapter connects for this turn.
                loop {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let request = read_request(&mut stream);
                            captured_clone.lock().expect("lock").push(request);
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes());
                            let _ = stream.flush();
                            break;
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            if shutdown_clone.load(Ordering::SeqCst) {
                                return;
                            }
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => return,
                    }
                }
                let _ = index;
            }
        });
        Self {
            addr,
            shutdown,
            captured,
        }
    }

    fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn captured_requests(&self) -> Vec<String> {
        self.captured.lock().expect("lock").clone()
    }
}

impl Drop for MockToolServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

fn tool_call_sse(id: &str, name: &str, arguments_json: &str) -> String {
    format!(
        r#"{{"choices":[{{"delta":{{"tool_calls":[{{"index":0,"id":"{id}","type":"function","function":{{"name":"{name}","arguments":"{arguments_json}"}}}}]}},"finish_reason":"tool_calls"}}]}}"#
    )
}

/// The SSE event streamed for the FIRST provider turn: one tool call for
/// `lookup_weather({"city":"Kyiv"})` (JSON-encoded arguments).
fn tool_turn_body() -> String {
    format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        tool_call_sse("call_abc123", "lookup_weather", r#"{\"city\":\"Kyiv\"}"#),
        "{\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}"
    )
}

/// The SSE event stream for the RESUMED turn: deterministic final text.
fn resumed_turn_body() -> String {
    format!(
        "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        delta("The weather in Kyiv is "),
        delta("22"),
        delta("°C.")
    )
}

/// The registered tool contract for the golden tool round trip.
const TOOL_SPEC: &str = r#"{
  "id": "lookup-weather",
  "name": "lookup_weather",
  "description": "Look up the current weather for a city.",
  "inputSchema": {
    "type": "object",
    "properties": { "city": { "type": "string" } },
    "required": ["city"]
  }
}"#;

/// The kernel-side implementation of `generation.tools.list`.
fn list_tools(kernel: &Kernel) -> serde_json::Value {
    serde_json::from_slice(&dispatch_bytes(kernel, "generation.tools.list", json!({})))
        .expect("tools list response")
}

/// The toolCallId of the run's waiting tool_call step (kernel-assigned uuid).
fn waiting_tool_call_id(kernel: &Kernel, run_id: &str) -> String {
    let page: serde_json::Value = serde_json::from_slice(&dispatch_bytes(
        kernel,
        "generation.events",
        json!({ "workflowId": run_id, "limit": 200 }),
    ))
    .expect("events response");
    let step = page["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|e| {
            e["type"] == json!("generation.step")
                && e["payload"]["step"]["type"] == json!("tool_call")
        })
        .unwrap_or_else(|| panic!("no tool_call step event: {page:#?}"));
    step["payload"]["step"]["input"]["toolCall"]["id"]
        .as_str()
        .expect("toolCall.id string")
        .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn openai_provider_streams_and_saves_durably() {
    let endpoint = MockEndpoint::spawn();
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    // Secret seams: resolver (execution-time) + writable store (config time).
    kernel.set_secret_resolver(Arc::new(FixedSecretResolver));
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());

    // Store the provider config WITH its API key: only the opaque reference
    // reaches the database (§9.4).
    let config_dto: serde_json::Value = serde_json::from_slice(&dispatch_bytes(
        &kernel,
        "providers.config.set",
        json!({
            "provider": "openai",
            "name": "local",
            "config": { "baseUrl": endpoint.base_url(), "models": [{ "id": "mock-1" }] },
            "apiKey": RESOLVED_KEY,
        }),
    ))
    .expect("set must succeed");
    assert_eq!(config_dto["hasApiKey"], json!(true));
    assert!(store.has("provider:openai", "local").expect("store has"));

    // Register the production adapter built from that non-secret config.
    let adapter =
        provider_openai_compat::OpenAICompatProvider::from_config("openai", &config_dto["config"])
            .expect("adapter builds from the stored config");
    kernel.register_provider(Arc::new(adapter));

    // providers.list shows the configured OpenAI provider with its models.
    let listed: serde_json::Value =
        serde_json::from_slice(&dispatch_bytes(&kernel, "providers.list", json!({})))
            .expect("list must succeed");
    let openai = listed["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|p| p["id"] == "openai")
        .expect("openai registered");
    assert_eq!(openai["availability"]["status"], json!("available"));
    assert_eq!(openai["models"][0]["id"], json!("mock-1"));

    // Full generation through the kernel: the executor resolves the key at
    // execution time, the adapter streams, the assistant message is saved.
    let flag = CancellationFlag::new();
    let mut stream = kernel
        .dispatch_stream(
            "generation.start",
            &serde_json::to_vec(&json!({
                "chatId": CHAT_ID,
                "message": "Hello from the OpenAI path",
                "provider": "openai",
                "model": "mock-1"
            }))
            .expect("serialize"),
            &flag,
        )
        .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    let committed = drain_until_terminal(&mut stream);
    assert!(!committed.is_empty(), "deltas were committed");

    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Completed);

    // The durable assistant message concatenates the streamed deltas.
    let messages = list_messages(&kernel, CHAT_ID);
    let assistant: Vec<_> = messages
        .items
        .iter()
        .filter(|m| m.role == MessageRole::Assistant)
        .collect();
    assert_eq!(assistant.len(), 1, "exactly one assistant message");
    assert_eq!(assistant[0].content, "Hello world!");

    // Transport hygiene: the Authorization header carried the resolved key
    // and the key never appeared in the request body.
    let request = endpoint.captured_request();
    assert!(
        request.contains(&format!("Authorization: Bearer {RESOLVED_KEY}")),
        "adapter authenticated with the resolved key"
    );
    let body = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    assert!(
        !body.contains(RESOLVED_KEY),
        "the API key must never appear in the request body"
    );

    // The raw database file never contains the plaintext key.
    drop(kernel);
    let raw = std::fs::read(root.path().join("database.sqlite")).expect("database file");
    assert!(
        !raw.windows(RESOLVED_KEY.len())
            .any(|w| w == RESOLVED_KEY.as_bytes()),
        "the plaintext key must not appear in the database file"
    );
}

#[test]
fn openai_provider_without_secret_store_fails_closed() {
    let endpoint = MockEndpoint::spawn();
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    // A resolver seam only — no writable store. Setting an apiKey must fail
    // with SECRET_UNAVAILABLE (no plaintext fallback, §87).
    kernel.set_secret_resolver(Arc::new(FixedSecretResolver));
    let flag = CancellationFlag::new();
    let err = kernel
        .dispatch(
            "providers.config.set",
            &serde_json::to_vec(&json!({
                "provider": "openai",
                "name": "local",
                "apiKey": RESOLVED_KEY,
            }))
            .expect("serialize"),
            &flag,
        )
        .expect_err("set with a key without a store must fail");
    assert_eq!(err.code, KernelErrorCode::Conflict, "product error code");
    let product = err.product.expect("product dto");
    assert_eq!(product.code, "SECRET_UNAVAILABLE");
    drop(endpoint);
}

#[test]
fn openai_provider_run_without_config_key_fails_with_typed_error() {
    let endpoint = MockEndpoint::spawn();
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    kernel.set_secret_resolver(Arc::new(FixedSecretResolver));
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());

    // A config WITHOUT a secret (no apiKey at set time).
    let config_dto: serde_json::Value = serde_json::from_slice(&dispatch_bytes(
        &kernel,
        "providers.config.set",
        json!({
            "provider": "openai",
            "name": "local",
            "config": { "baseUrl": endpoint.base_url(), "models": [{ "id": "mock-1" }] },
        }),
    ))
    .expect("set must succeed");
    assert_eq!(config_dto["hasApiKey"], json!(false));

    let adapter =
        provider_openai_compat::OpenAICompatProvider::from_config("openai", &config_dto["config"])
            .expect("adapter builds");
    kernel.register_provider(Arc::new(adapter));

    // A run against this provider fails with PROVIDER_MODEL_INVALID
    // (adapter-side: requires an API key), never a hang or a partial save.
    let flag = CancellationFlag::new();
    let mut stream = kernel
        .dispatch_stream(
            "generation.start",
            &serde_json::to_vec(&json!({
                "chatId": CHAT_ID,
                "message": "Hi",
                "provider": "openai",
                "model": "mock-1"
            }))
            .expect("serialize"),
            &flag,
        )
        .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream);

    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Failed);
    assert_eq!(
        run.error.as_ref().expect("error").code,
        "PROVIDER_MODEL_INVALID",
        "error payload: {:?}",
        run.error
    );
    assert!(
        list_messages(&kernel, CHAT_ID).items.is_empty(),
        "no message row for the failed run"
    );
}

/// Golden tool round trip through the REAL OpenAI-compatible adapter and the
/// production SSE path (Этап 2.5 + Этап 2.7/§8.3):
///
/// 1. `generation.start` with the registered `openai` provider → the adapter
///    streams a normalized `tool_calls` delta from the mock endpoint;
/// 2. the kernel validates the call against the registered tool spec and
///    commits the durable waiting transition (kernel-assigned uuid call id);
/// 3. `generation.tool.result` resumes the SAME provider with the tool
///    context (assistant tool_calls + tool message) → the adapter's second
///    SSE turn streams the final text;
/// 4. the run completes with exactly one assistant message, and both HTTP
///    request bodies prove the serialization (`tools` on turn 1, resumed
///    tool context on turn 2).
#[test]
fn openai_provider_tool_round_trip_through_the_kernel() {
    let endpoint = MockToolServer::spawn(vec![tool_turn_body(), resumed_turn_body()]);
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    // Secret seams: execution-time resolver + writable store (config time).
    kernel.set_secret_resolver(Arc::new(FixedSecretResolver));
    kernel.set_secret_store(Arc::new(MemorySecretStore::new()));

    let config_dto: serde_json::Value = serde_json::from_slice(&dispatch_bytes(
        &kernel,
        "providers.config.set",
        json!({
            "provider": "openai",
            "name": "local",
            "config": { "baseUrl": endpoint.base_url(), "models": [{ "id": "mock-1" }] },
            "apiKey": RESOLVED_KEY,
        }),
    ))
    .expect("set must succeed");
    let adapter =
        provider_openai_compat::OpenAICompatProvider::from_config("openai", &config_dto["config"])
            .expect("adapter builds from the stored config");
    kernel.register_provider(Arc::new(adapter));

    // Register the tool the mock will call (schema validation is kernel-side).
    let spec: contracts_generated::generated::ToolSpec =
        serde_json::from_str(TOOL_SPEC).expect("tool spec JSON");
    kernel.register_tool(spec);

    // Turn 1: stream → the run durably waits on the validated tool call.
    let flag = CancellationFlag::new();
    let mut stream = kernel
        .dispatch_stream(
            "generation.start",
            &serde_json::to_vec(&json!({
                "chatId": CHAT_ID,
                "message": "What is the weather in Kyiv?",
                "provider": "openai",
                "model": "mock-1"
            }))
            .expect("serialize"),
            &flag,
        )
        .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream);

    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::WaitingForTool);
    assert_eq!(run.error, None);
    // The kernel assigns its own uuid call id (adapter ids are not uuids).
    let tool_call_id = waiting_tool_call_id(&kernel, &run_id);
    assert_ne!(tool_call_id, "call_abc123");
    assert_eq!(tool_call_id.len(), 36, "kernel call id is a uuid");

    // The tool registry serves the registered contract.
    let tools = list_tools(&kernel);
    assert_eq!(tools["items"].as_array().expect("items").len(), 1);
    assert_eq!(tools["items"][0]["name"], json!("lookup_weather"));

    // Turn 2: submit the tool result → the same provider resumes → completed.
    let _result: serde_json::Value = serde_json::from_slice(&dispatch_bytes(
        &kernel,
        "generation.tool.result",
        json!({
            "runId": run_id,
            "toolCallId": tool_call_id,
            "result": { "celsius": 22 }
        }),
    ))
    .expect("tool.result must succeed");
    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Completed);
    assert_eq!(run.error, None);

    // Exactly one assistant message, from the resumed turn's final text.
    let messages = list_messages(&kernel, CHAT_ID);
    let assistant: Vec<_> = messages
        .items
        .iter()
        .filter(|m| m.role == MessageRole::Assistant)
        .collect();
    assert_eq!(assistant.len(), 1, "exactly one assistant message");
    assert_eq!(
        assistant[0].content, "The weather in Kyiv is 22°C.",
        "final message content"
    );
    assert_eq!(
        assistant[0].generation_run_id.as_deref(),
        Some(run_id.as_str()),
        "message links the run"
    );

    // Wire serialization proof: turn 1 declares the tool, turn 2 resumes
    // with the kernel-assigned tool_call id and the tool result message.
    let requests = endpoint.captured_requests();
    assert_eq!(requests.len(), 2, "two provider turns happened");
    let turn1 = &requests[0];
    assert!(
        turn1.contains(r#""tools""#) && turn1.contains("lookup_weather"),
        "turn 1 declares tools, got: {turn1}"
    );
    assert!(
        turn1.contains(r#""city""#),
        "turn 1 serializes the input schema, got: {turn1}"
    );
    let turn2 = &requests[1];
    assert!(
        turn2.contains(&format!(r#""tool_call_id":"{tool_call_id}""#)),
        "turn 2 resumes with the kernel call id, got: {turn2}"
    );
    assert!(
        turn2.contains(&format!(r#""id":"{tool_call_id}""#)),
        "turn 2 replays the assistant tool_calls, got: {turn2}"
    );
    assert!(
        turn2.contains(r#""role":"tool""#),
        "turn 2 carries the tool result message, got: {turn2}"
    );
    assert!(
        turn2.contains("22") && turn2.contains("celsius"),
        "turn 2 carries the tool result payload, got: {turn2}"
    );
}
