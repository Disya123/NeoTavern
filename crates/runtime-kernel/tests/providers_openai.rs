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
