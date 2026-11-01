//! Live provider access through the kernel (M7 Etap-4 cluster 8):
//! `providers.models` (model discovery) and `providers.test` (one
//! non-streaming test message).
//!
//! Proves the addressing contract (a config id, not "the provider kind"), the
//! per-config endpoint and key resolution, the honest `CAPABILITY_UNAVAILABLE`
//! for adapters without discovery, the normalized product codes on provider
//! failures, and that the test op runs one message through the addressed
//! config's model without ever echoing the key.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use contracts_generated::generated::{ProviderConfigDto, ResultProviderModels, ResultProviderTest};
use provider_sdk::secret::{SecretRef, SecretResolver, SecretValue};
use provider_sdk::ProviderError;
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError};
use secret_store::memory::MemorySecretStore;
use serde_json::{json, Value};

/// Resolver handing back the reference itself: a captured provider request then
/// reveals WHICH stored reference was resolved (never a real key).
struct RefEchoResolver;

impl SecretResolver for RefEchoResolver {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        Ok(SecretValue::new(reference.0.clone()))
    }
}

/// A single-shot raw-TCP mock answering either a model listing (GET /models) or
/// a chat-completions stream, capturing the request for assertions.
struct MockUpstream {
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    captured: Arc<std::sync::Mutex<Option<String>>>,
}

impl MockUpstream {
    fn spawn(response: String) -> Self {
        MockUpstream::spawn_with(move |_request| response.clone())
    }

    /// `render` receives the request text and returns the raw HTTP response, so
    /// a handler can branch on the path.
    fn spawn_with<F>(render: F) -> Self
    where
        F: Fn(String) -> String + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock binds");
        listener.set_nonblocking(true).expect("nonblocking");
        let addr = listener.local_addr().expect("addr");
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = Arc::clone(&shutdown);
        let captured = Arc::new(std::sync::Mutex::new(None));
        let captured_clone = Arc::clone(&captured);
        std::thread::spawn(move || loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let request = read_request(&mut stream);
                    let response = render(request.clone());
                    *captured_clone.lock().expect("lock") = Some(request);
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

impl Drop for MockUpstream {
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

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
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
) -> Result<T, KernelError> {
    dispatch_json(kernel, op, request).map(|value| {
        serde_json::from_value(value).expect("response must decode as the expected DTO")
    })
}

fn set_config(kernel: &Kernel, provider: &str, name: &str, config: Value) -> ProviderConfigDto {
    set_config_with_key(kernel, provider, name, config, None)
}

/// Creates a config, optionally storing a secret through the SecretStore seam
/// (the key rides the request's top-level `apiKey`, never `config`).
fn set_config_with_key(
    kernel: &Kernel,
    provider: &str,
    name: &str,
    config: Value,
    api_key: Option<&str>,
) -> ProviderConfigDto {
    let mut request = json!({ "provider": provider, "name": name, "config": config });
    if let Some(api_key) = api_key {
        request["apiKey"] = json!(api_key);
    }
    dispatch_decoded::<ProviderConfigDto>(kernel, "providers.config.set", request)
        .expect("config set must succeed")
}

fn product_code(err: &KernelError) -> String {
    err.product
        .as_ref()
        .expect("expected a product error")
        .code
        .clone()
}

fn listing(ids: &[&str]) -> String {
    let data: Vec<String> = ids.iter().map(|id| format!(r#"{{"id":"{id}"}}"#)).collect();
    let body = format!(r#"{{"object":"list","data":[{}]}}"#, data.join(","));
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn sse_reply(text: &str) -> String {
    let body = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({ "choices": [{ "delta": { "content": text }, "finish_reason": null }] })
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
        body.len(),
        body
    )
}

// ---------------------------------------------------------------------------
// providers.models
// ---------------------------------------------------------------------------

/// A built-in adapter that can enumerate models answers from the addressed
/// config, and an unknown config id is a stable product error.
#[test]
fn models_lists_the_addressed_config_and_unknown_ids_fail_closed() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let config = set_config(&kernel, "fake", "local", json!({ "model": "steps=1" }));

    let models = dispatch_decoded::<ResultProviderModels>(
        &kernel,
        "providers.models",
        json!({ "providerId": config.id }),
    )
    .expect("fake discovery succeeds");
    assert_eq!(models.models.len(), 1);
    assert_eq!(models.models[0].id, "fake-1");
    assert_eq!(models.models[0].name, "Fake 1");
    assert_eq!(models.models[0].context_limit, Some(8192));

    let err = dispatch_json(
        &kernel,
        "providers.models",
        json!({ "providerId": "00000000-0000-4000-8000-0000000000ff" }),
    )
    .expect_err("unknown config must fail");
    assert_eq!(product_code(&err), "PROVIDER_CONFIG_NOT_FOUND");
}

/// The openai-compatible adapter discovers over `GET /models` from the
/// addressed config's endpoint, sending the resolved key only in the
/// Authorization header.
#[test]
fn models_discovers_over_the_addressed_openai_config_with_the_resolved_key() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    kernel.set_secret_resolver(Arc::new(RefEchoResolver));
    kernel.set_secret_store(Arc::new(MemorySecretStore::new()));
    let upstream = MockUpstream::spawn(listing(&["alpha", "beta"]));
    let config = set_config_with_key(
        &kernel,
        "openai",
        "mini",
        json!({ "baseUrl": upstream.base_url(), "model": "gpt-4o-mini" }),
        Some("sk-live"),
    );
    assert!(config.has_api_key, "the key must be stored opaquely");

    let models = dispatch_decoded::<ResultProviderModels>(
        &kernel,
        "providers.models",
        json!({ "providerId": config.id }),
    )
    .expect("discovery succeeds");
    let ids: Vec<&str> = models.models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["alpha", "beta"]);
    // Discovery carries ids only; the name mirrors the id.
    assert_eq!(models.models[0].name, "alpha");

    let request = upstream.captured_request();
    assert!(
        request.starts_with("GET /models HTTP/1.1"),
        "discovery must use GET /models, got: {}",
        request.lines().next().unwrap_or_default()
    );
    assert!(
        request.contains("Authorization: Bearer session:provider:openai:mini"),
        "the resolved reference rides the Authorization header"
    );
    assert!(
        !request.contains("sk-live"),
        "the raw key must never reach the wire twice"
    );
}

/// An adapter without discovery is reported honestly and never synthesized.
#[test]
fn models_for_an_adapter_without_discovery_is_capability_unavailable() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let config = set_config(&kernel, "unknown-kind", "x", json!({}));
    let err = dispatch_json(
        &kernel,
        "providers.models",
        json!({ "providerId": config.id }),
    )
    .expect_err("unknown kind must fail");
    assert_eq!(product_code(&err), "CAPABILITY_UNAVAILABLE");
}

/// An openai config without a key fails before any network round-trip with the
/// adapter's normalized code.
#[test]
fn models_without_a_key_fails_before_the_network() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    // A closed port: a network attempt would surface PROVIDER_NETWORK_FAULT.
    let config = set_config(
        &kernel,
        "openai",
        "nokey",
        json!({ "baseUrl": "http://127.0.0.1:9", "model": "gpt-4o-mini" }),
    );
    let err = dispatch_json(
        &kernel,
        "providers.models",
        json!({ "providerId": config.id }),
    )
    .expect_err("missing key must fail");
    assert_eq!(product_code(&err), "PROVIDER_MODEL_INVALID");
}

// ---------------------------------------------------------------------------
// providers.test
// ---------------------------------------------------------------------------

/// One message through the fake provider comes back with the answer text and
/// the attempt accounting; the addressed config's model is used by default.
#[test]
fn test_runs_one_message_through_the_addressed_config() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let config = set_config(&kernel, "fake", "local", json!({ "model": "steps=1" }));

    let reply = dispatch_decoded::<ResultProviderTest>(
        &kernel,
        "providers.test",
        json!({ "providerId": config.id, "message": "ping" }),
    )
    .expect("the fake provider must answer");
    assert!(!reply.text.is_empty(), "the fake adapter streams deltas");
    assert!(reply.usage.steps >= 1);
    assert!(reply.usage.output_chars >= 1);

    // An explicit model override is honored (the same addressed config).
    let overridden = dispatch_decoded::<ResultProviderTest>(
        &kernel,
        "providers.test",
        json!({ "providerId": config.id, "message": "ping", "model": "steps=2" }),
    )
    .expect("override succeeds");
    assert!(!overridden.text.is_empty());
}

/// The test op is honest about configs that name no model, unknown ids and
/// provider-side failures (the product code travels, the message does not).
#[test]
fn test_reports_missing_model_unknown_config_and_provider_errors() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let no_model = set_config(&kernel, "fake", "empty", json!({}));
    let err = dispatch_json(
        &kernel,
        "providers.test",
        json!({ "providerId": no_model.id, "message": "ping" }),
    )
    .expect_err("no model must fail");
    assert_eq!(product_code(&err), "PROVIDER_MODEL_REQUIRED");

    let err = dispatch_json(
        &kernel,
        "providers.test",
        json!({
            "providerId": "00000000-0000-4000-8000-0000000000ff",
            "message": "ping"
        }),
    )
    .expect_err("unknown config must fail");
    assert_eq!(product_code(&err), "PROVIDER_CONFIG_NOT_FOUND");

    // A live endpoint that answers 401 → normalized PROVIDER_UNAVAILABLE.
    let upstream = MockUpstream::spawn(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
            .to_string(),
    );
    kernel.set_secret_resolver(Arc::new(RefEchoResolver));
    kernel.set_secret_store(Arc::new(MemorySecretStore::new()));
    let config = set_config_with_key(
        &kernel,
        "openai",
        "bad-key",
        json!({ "baseUrl": upstream.base_url(), "model": "gpt-4o-mini" }),
        Some("sk-wrong"),
    );
    let err = dispatch_json(
        &kernel,
        "providers.test",
        json!({ "providerId": config.id, "message": "ping" }),
    )
    .expect_err("401 must fail");
    assert_eq!(product_code(&err), "PROVIDER_UNAVAILABLE");
}

/// The test message travels as the sanitized user input; a successful stream
/// returns only the text and the accounting (no key material anywhere).
#[test]
fn test_streams_only_text_and_usage_from_the_upstream() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    kernel.set_secret_resolver(Arc::new(RefEchoResolver));
    kernel.set_secret_store(Arc::new(MemorySecretStore::new()));
    let upstream = MockUpstream::spawn(sse_reply("pong"));
    let config = set_config_with_key(
        &kernel,
        "openai",
        "mini",
        json!({ "baseUrl": upstream.base_url(), "model": "gpt-4o-mini" }),
        Some("sk-live"),
    );

    let reply = dispatch_decoded::<ResultProviderTest>(
        &kernel,
        "providers.test",
        json!({ "providerId": config.id, "message": "ping" }),
    )
    .expect("stream succeeds");
    assert_eq!(reply.text, "pong");
    assert_eq!(reply.usage.steps, 1);
    assert_eq!(reply.usage.output_chars, 4);

    let request = upstream.captured_request();
    assert!(request.starts_with("POST /chat/completions HTTP/1.1"));
    assert!(request.contains(r#""role":"user""#));
    assert!(request.contains(r#""content":"ping""#));
    assert!(
        !request.contains("sk-live"),
        "the key never enters the body"
    );
}
