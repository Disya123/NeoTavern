//! Adapter tests against a raw TCP mock of an OpenAI-compatible endpoint
//! (РўР— В§9.3, Р­С‚Р°Рї 2.5).
//!
//! The mock speaks real HTTP/1.1 + SSE over a local socket вЂ” no HTTP client
//! library, no network: the adapter's full path (connect в†’ POST в†’ chunked
//! decode в†’ SSE parse в†’ deltas) is exercised exactly as against a real
//! server, including slow responses for cancellation/deadline tests.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use provider_sdk::policy::{Deadline, Usage};
use provider_sdk::{
    CancelToken, EmitStatus, ProviderAdapter, ProviderError, ProviderErrorCode, ProviderEvent,
    ProviderRequest,
};

use crate::{OpenAICompatProvider, ProviderConfig};

/// A single-shot mock HTTP server with a scripted response writer.
///
/// The accept loop is non-blocking and exits on [`MockServer::close`]/Drop,
/// so tests where the adapter never connects (missing API key, rejected
/// config) do not leak a blocked listener thread.
struct MockServer {
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
}

impl MockServer {
    /// Spawns a server that accepts ONE connection and hands it to
    /// `handler(request_text, stream)`. The handler writes the raw response.
    fn spawn<F>(handler: F) -> Self
    where
        F: Fn(String, TcpStream) -> std::io::Result<()> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock binds");
        listener
            .set_nonblocking(true)
            .expect("mock listener nonblocking");
        let addr = listener.local_addr().expect("mock addr");
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = Arc::clone(&shutdown);
        let handle = std::thread::spawn(move || loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let request = read_request(&mut stream);
                    let _ = handler(request, stream);
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
        // The listener thread is deliberately detached: `close`/Drop stops
        // it via the shutdown flag.
        let _ = handle;
        Self { addr, shutdown }
    }

    fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Stops the accept loop; the listener thread exits on its next poll.
    fn close(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.close();
    }
}

/// Reads one HTTP request (head + content-length body).
fn read_request(stream: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).expect("head read") == 0 {
            break;
        }
        head.push(byte[0]);
        if head.len() > 16 * 1024 {
            panic!("mock request head too long");
        }
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
        stream.read_exact(&mut body).expect("mock body read");
    }
    format!("{head_text}{}", String::from_utf8_lossy(&body))
}

/// Renders one SSE event as `data: <payload>\n\n`.
fn sse_event(payload: &str) -> String {
    format!("data: {payload}\n\n")
}

/// Renders a chunked-transfer SSE response with per-event delays.
fn chunked_sse_response(events: &[(String, Duration)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (payload, _) in events {
        let chunk = sse_event(payload).into_bytes();
        body.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
        body.extend_from_slice(&chunk);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(b"0\r\n\r\n");
    body
}

/// A simple content-length response for the non-chunked test.
fn content_length_response(body: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    );
    out.extend_from_slice(body.as_bytes());
    out
}

const CHUNKED_HEAD: &str =
    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";

fn delta_payload(text: &str) -> String {
    format!(r#"{{"choices":[{{"delta":{{"content":"{text}"}},"finish_reason":null}}]}}"#)
}

fn test_provider(base_url: &str) -> OpenAICompatProvider {
    OpenAICompatProvider::from_config_json(
        "openai",
        &format!(
            r#"{{"baseUrl": "{base_url}", "models": [{{"id": "mock-1", "name": "Mock 1"}}]}}"#
        ),
    )
    .expect("provider config valid")
}

fn generate_collect(
    provider: &dyn ProviderAdapter,
    api_key: Option<&str>,
    deadline: Option<Deadline>,
    flag: &AtomicBool,
) -> (Result<Usage, ProviderError>, Vec<String>) {
    let request = ProviderRequest {
        provider_id: provider.id(),
        model: "mock-1",
        input: "hello",
        run_key: "chat-123|1",
        deadline,
        api_key,
        messages: None,
        tools: None,
    };
    let mut texts = Vec::new();
    let result = provider.generate(&request, CancelToken::new(flag), &mut |event| {
        let ProviderEvent::Delta { text } = event else {
            return EmitStatus::Continue;
        };
        texts.push(text);
        EmitStatus::Continue
    });
    (result, texts)
}

#[test]
fn streams_text_deltas_over_chunked_sse() {
    let server = MockServer::spawn(move |request, mut stream| {
        assert!(request.contains("POST /chat/completions HTTP/1.1"));
        assert!(request.contains("Authorization: Bearer sk-test"));
        assert!(request.contains("\"model\":\"mock-1\""));
        assert!(request.contains("\"stream\":true"));
        stream.write_all(CHUNKED_HEAD.as_bytes())?;
        let events = [
            (delta_payload("Hello"), Duration::ZERO),
            (delta_payload(" world"), Duration::ZERO),
            ("[DONE]".to_string(), Duration::ZERO),
        ];
        stream.write_all(&chunked_sse_response(&events))?;
        stream.flush()
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let (result, texts) = generate_collect(&provider, Some("sk-test"), None, &flag);
    let usage = result.expect("happy path succeeds");
    assert_eq!(texts, vec!["Hello", " world"]);
    assert_eq!(usage.steps, 2);
    assert_eq!(usage.output_chars, 11);
}

#[test]
fn streams_over_content_length_sse() {
    let server = MockServer::spawn(move |_request, mut stream| {
        let body = format!("{}{}", sse_event(&delta_payload("A")), sse_event("[DONE]"));
        stream.write_all(&content_length_response(&body))?;
        stream.flush()
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let (result, texts) = generate_collect(&provider, Some("sk-test"), None, &flag);
    result.expect("content-length path succeeds");
    assert_eq!(texts, vec!["A"]);
}

#[test]
fn rendered_plan_messages_serialize_into_the_body() {
    let server = MockServer::spawn(move |request, mut stream| {
        // The kernel's prompt plan arrives as `messages` and must be
        // serialized verbatim (system + history + user), not replaced by the
        // single `input` fallback.
        let body = request
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        let parsed: serde_json::Value =
            serde_json::from_str(&body).expect("request body must be JSON");
        let messages = parsed["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "You are Aria.");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "earlier");
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"], "hello");
        stream.write_all(CHUNKED_HEAD.as_bytes())?;
        let events = [
            (delta_payload("Hi"), Duration::ZERO),
            ("[DONE]".to_string(), Duration::ZERO),
        ];
        stream.write_all(&chunked_sse_response(&events))?;
        stream.flush()
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let plan = [
        provider_sdk::PromptMessage {
            role: "system",
            content: "You are Aria.",
            tool_calls: None,
            tool_call_id: None,
        },
        provider_sdk::PromptMessage {
            role: "user",
            content: "earlier",
            tool_calls: None,
            tool_call_id: None,
        },
        provider_sdk::PromptMessage {
            role: "user",
            content: "hello",
            tool_calls: None,
            tool_call_id: None,
        },
    ];
    let request = ProviderRequest {
        provider_id: provider.id(),
        model: "mock-1",
        input: "hello",
        run_key: "chat-123|1",
        deadline: None,
        api_key: Some("sk-test"),
        messages: Some(&plan),
        tools: None,
    };
    let mut texts = Vec::new();
    let result = provider.generate(&request, CancelToken::new(&flag), &mut |event| {
        let ProviderEvent::Delta { text } = event else {
            return EmitStatus::Continue;
        };
        texts.push(text);
        EmitStatus::Continue
    });
    let usage = result.expect("plan-driven run succeeds");
    assert_eq!(texts, vec!["Hi"]);
    assert_eq!(usage.steps, 1);
}

#[test]
fn missing_api_key_is_request_invalid_without_network() {
    let connected = Arc::new(AtomicBool::new(false));
    let connected_clone = Arc::clone(&connected);
    let server = MockServer::spawn(move |_request, stream| {
        connected_clone.store(true, Ordering::SeqCst);
        let _ = stream;
        Ok(())
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(&provider, None, None, &flag);
    let err = result.expect_err("no key must fail before any network I/O");
    assert_eq!(err.code, ProviderErrorCode::RequestInvalid);
    assert!(
        !connected.load(Ordering::SeqCst),
        "adapter must not connect without a key"
    );
}

#[test]
fn http_error_status_maps_to_normalized_code() {
    let server = MockServer::spawn(move |_request, mut stream| {
        stream.write_all(
            b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        )?;
        stream.flush()
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(&provider, Some("sk-bad"), None, &flag);
    let err = result.expect_err("401 must fail");
    assert_eq!(err.code, ProviderErrorCode::Unavailable);
    assert_eq!(
        err.params,
        vec![("httpStatus".to_string(), "401".to_string())]
    );
    assert!(!err.retryable);
}

#[test]
fn sse_error_event_maps_to_normalized_code() {
    let server = MockServer::spawn(move |_request, mut stream| {
        stream.write_all(CHUNKED_HEAD.as_bytes())?;
        let event = r#"{"error": {"code": "rate_limit_exceeded", "message": "slow down"}}"#;
        stream.write_all(&chunked_sse_response(&[(
            event.to_string(),
            Duration::ZERO,
        )]))?;
        stream.flush()
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(&provider, Some("sk-test"), None, &flag);
    let err = result.expect_err("error event must fail");
    assert_eq!(err.code, ProviderErrorCode::StepFailed);
    assert!(err.retryable, "rate limits are advisory-retryable");
    assert_eq!(
        err.params,
        vec![("errorCode".to_string(), "rate_limit_exceeded".to_string())]
    );
}

#[test]
fn cancel_mid_stream_stops_emission() {
    let server = MockServer::spawn(move |_request, mut stream| {
        stream.write_all(CHUNKED_HEAD.as_bytes())?;
        stream.write_all(&chunked_sse_response(&[(
            delta_payload("first"),
            Duration::ZERO,
        )]))?;
        stream.flush()?;
        std::thread::sleep(Duration::from_millis(400));
        // The adapter must have stopped; writing this second event fails
        // silently if the peer closed.
        let _ = stream.write_all(&chunked_sse_response(&[(
            delta_payload("second"),
            Duration::ZERO,
        )]));
        let _ = stream.flush();
        Ok(())
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let request = ProviderRequest {
        provider_id: provider.id(),
        model: "mock-1",
        input: "hello",
        run_key: "chat-123|1",
        deadline: None,
        api_key: Some("sk-test"),
        messages: None,
        tools: None,
    };
    let mut texts = Vec::new();
    let result = provider.generate(&request, CancelToken::new(&flag), &mut |event| {
        let ProviderEvent::Delta { text } = event else {
            return EmitStatus::Continue;
        };
        texts.push(text);
        flag.store(true, Ordering::SeqCst);
        EmitStatus::Continue
    });
    let err = result.expect_err("mid-stream cancel must fail the attempt");
    assert_eq!(err.code, ProviderErrorCode::Cancelled);
    assert_eq!(texts, vec!["first"], "no delta after cancellation");
}

#[test]
fn deadline_expiry_returns_timeout() {
    let server = MockServer::spawn(move |_request, mut stream| {
        std::thread::sleep(Duration::from_millis(400));
        stream.write_all(CHUNKED_HEAD.as_bytes())?;
        let _ = stream.write_all(&chunked_sse_response(&[
            (delta_payload("late"), Duration::ZERO),
            ("[DONE]".to_string(), Duration::ZERO),
        ]));
        let _ = stream.flush();
        Ok(())
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(
        &provider,
        Some("sk-test"),
        Some(Deadline::after(Duration::from_millis(50))),
        &flag,
    );
    let err = result.expect_err("deadline must fail the attempt");
    assert_eq!(err.code, ProviderErrorCode::Timeout);
}

#[test]
fn response_over_byte_budget_is_destroyed() {
    let big_payload = delta_payload(&"x".repeat(4096));
    let server = MockServer::spawn(move |_request, mut stream| {
        stream.write_all(CHUNKED_HEAD.as_bytes())?;
        stream.write_all(&chunked_sse_response(&[(
            big_payload.clone(),
            Duration::ZERO,
        )]))?;
        stream.flush()
    });
    let provider = OpenAICompatProvider::from_config_json(
        "openai",
        &format!(
            r#"{{"baseUrl": "{}", "models": [{{"id": "mock-1"}}], "maxResponseBytes": 64}}"#,
            server.base_url()
        ),
    )
    .expect("provider config valid");
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(&provider, Some("sk-test"), None, &flag);
    let err = result.expect_err("over-budget response must fail");
    assert_eq!(err.code, ProviderErrorCode::StepFailed);
    assert_eq!(err.params, vec![("kind".to_string(), "budget".to_string())]);
}

#[test]
fn config_parsing_and_defaults() {
    let config = serde_json::json!({
        "baseUrl": "https://api.openai.com/v1",
        "models": [{ "id": "gpt-4o", "contextLimit": 128000 }],
        "organization": "org-1",
    });
    let provider = OpenAICompatProvider::from_config("openai", &config).expect("valid config");
    assert_eq!(provider.id(), "openai");
    assert_eq!(provider.name(), "OpenAI Compatible");
    assert!(!provider.builtin());
    assert_eq!(provider.models().len(), 1);
    let model = &provider.models()[0];
    assert_eq!(model.id, "gpt-4o");
    assert_eq!(model.name, "gpt-4o", "name defaults to the id");
    assert_eq!(model.context_limit, Some(128000));
    assert_eq!(
        provider.availability(),
        provider_sdk::Availability::Available
    );

    // Empty models в†’ the default model.
    let minimal = serde_json::json!({ "baseUrl": "http://localhost:8080/v1" });
    let provider = OpenAICompatProvider::from_config("openai", &minimal).expect("valid");
    assert_eq!(provider.models().len(), 1);
    assert_eq!(provider.models()[0].id, "gpt-4o-mini");

    // Invalid configs are rejected without panics.
    for bad in [
        serde_json::json!({ "baseUrl": "ftp://example.com" }),
        serde_json::json!({ "baseUrl": "no-scheme" }),
        serde_json::json!({ "baseUrl": "" }),
        serde_json::json!({ "baseUrl": "https://" }),
    ] {
        assert!(
            OpenAICompatProvider::from_config("openai", &bad).is_err(),
            "invalid baseUrl must be rejected: {bad}"
        );
    }
    assert!(
        OpenAICompatProvider::from_config("openai", &serde_json::json!({})).is_err(),
        "missing baseUrl must be rejected"
    );
}

#[test]
fn provider_config_serde_round_trip() {
    let json = serde_json::json!({
        "baseUrl": "http://127.0.0.1:8080/v1",
        "models": [{ "id": "m", "name": "M", "contextLimit": 4096, "maxOutputTokens": 512 }],
        "timeoutMs": 12345,
        "organization": "org-9",
        "maxResponseBytes": 1024,
        "maxTokens": 128,
    });
    let config: ProviderConfig = serde_json::from_value(json).expect("deserializes");
    assert_eq!(config.base_url, "http://127.0.0.1:8080/v1");
    assert_eq!(config.timeout_ms, 12345);
    assert_eq!(config.organization.as_deref(), Some("org-9"));
    assert_eq!(config.max_response_bytes, 1024);
    assert_eq!(config.max_tokens, Some(128));
    assert_eq!(config.models[0].max_output_tokens, Some(512));
}

/// Guards against accidental unbounded blocking in CI: the whole suite must
/// finish quickly.
#[test]
fn mock_server_never_hangs_without_a_connection() {
    let server = MockServer::spawn(move |_request, stream| {
        let _ = stream;
        Ok(())
    });
    let base_url = server.base_url();
    let provider = test_provider(&base_url);
    let flag = AtomicBool::new(false);
    let request = ProviderRequest {
        provider_id: provider.id(),
        model: "mock-1",
        input: "hi",
        run_key: "chat-123|1",
        deadline: Some(Deadline::after(Duration::from_millis(200))),
        api_key: Some("sk-test"),
        messages: None,
        tools: None,
    };
    let result = provider.generate(&request, CancelToken::new(&flag), &mut |_| {
        EmitStatus::Continue
    });
    let err = result.expect_err("unreachable server must fail");
    assert!(matches!(
        err.code,
        ProviderErrorCode::NetworkFault | ProviderErrorCode::Timeout
    ));
}

/// Proves the mocked request BODY never contains the API key (the key only
/// rides the Authorization header вЂ” В§9.4 transport hygiene).
#[test]
fn api_key_never_in_the_request_body() {
    let observed = Arc::new(Mutex::new(String::new()));
    let observed_clone = Arc::clone(&observed);
    let server = MockServer::spawn(move |request, mut stream| {
        // Capture only the body (everything after the head separator).
        let body = request
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        *observed_clone.lock().expect("lock") = body;
        stream.write_all(CHUNKED_HEAD.as_bytes())?;
        stream.write_all(&chunked_sse_response(&[
            (delta_payload("ok"), Duration::ZERO),
            ("[DONE]".to_string(), Duration::ZERO),
        ]))?;
        stream.flush()
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(&provider, Some("sk-header-only"), None, &flag);
    result.expect("generation succeeds");
    let body = observed.lock().expect("lock").clone();
    assert!(
        !body.contains("sk-header-only"),
        "the API key must never appear in the request body"
    );
    assert!(
        body.contains("\"model\":\"mock-1\""),
        "body carries the model"
    );
}

/// One chat-completions `delta.tool_calls[]` chunk (fragmentable arguments).
fn tool_call_chunk_payload(
    index: u64,
    id: Option<&str>,
    name: Option<&str>,
    arguments: &str,
) -> String {
    let id_json = match id {
        Some(id) => format!(r#""id":"{id}","#),
        None => String::new(),
    };
    let name_json = match name {
        Some(name) => format!(r#""name":"{name}","#),
        None => String::new(),
    };
    format!(
        r#"{{"choices":[{{"delta":{{"tool_calls":[{{"index":{index},{id_json}"function":{{{name_json}"arguments":"{arguments}"}}}}]}},"finish_reason":null}}]}}"#
    )
}

/// §8.3: a stream carrying a tool call (with fragmented JSON arguments) emits
/// `ProviderEvent::ToolCall` with the accumulated arguments, and the request
/// body declares `tools` plus the resumed-turn tool context.
#[test]
fn streams_tool_call_and_serializes_tool_context() {
    let observed = Arc::new(Mutex::new(String::new()));
    let observed_clone = Arc::clone(&observed);
    let server = MockServer::spawn(move |request, mut stream| {
        let body = request
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        // Parse BEFORE moving the body into the observed slot.
        let parsed: serde_json::Value =
            serde_json::from_str(&body).expect("request body must be JSON");
        *observed_clone.lock().expect("lock") = body;
        let tools = parsed["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["function"]["name"], "lookup_weather");
        assert!(tools[0]["function"]["parameters"].is_object());
        let messages = parsed["messages"].as_array().expect("messages array");
        let assistant = &messages[0];
        assert_eq!(assistant["role"], "assistant");
        assert_eq!(assistant["tool_calls"][0]["id"], "call-1");
        assert_eq!(
            assistant["tool_calls"][0]["function"]["name"],
            "lookup_weather"
        );
        let tool_msg = &messages[1];
        assert_eq!(tool_msg["role"], "tool");
        assert_eq!(tool_msg["tool_call_id"], "call-1");
        assert_eq!(tool_msg["content"], "{\"celsius\":22}");
        stream.write_all(CHUNKED_HEAD.as_bytes())?;
        let events = [
            // Fragment 1: id + name + first half of the JSON-encoded
            // arguments (`{\"city\":\"Ky`).
            (
                tool_call_chunk_payload(
                    0,
                    Some("call-1"),
                    Some("lookup_weather"),
                    r#"{\"city\":\"Ky"#,
                ),
                Duration::ZERO,
            ),
            // Fragment 2: arguments continuation (`iv\"}`).
            (
                tool_call_chunk_payload(0, None, None, r#"iv\"}"#),
                Duration::ZERO,
            ),
            ("[DONE]".to_string(), Duration::ZERO),
        ];
        stream.write_all(&chunked_sse_response(&events))?;
        stream.flush()
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let scratch_json = r#"{"city":"Kyiv"}"#.to_string();
    let scratch_result = r#"{"celsius":22}"#.to_string();
    let tool_calls = [provider_sdk::PromptToolCall {
        id: "call-1",
        name: "lookup_weather",
        arguments: &scratch_json,
    }];
    let plan = [
        provider_sdk::PromptMessage {
            role: "assistant",
            content: "",
            tool_calls: Some(&tool_calls),
            tool_call_id: None,
        },
        provider_sdk::PromptMessage {
            role: "tool",
            content: &scratch_result,
            tool_calls: None,
            tool_call_id: Some("call-1"),
        },
    ];
    let spec = provider_sdk::ToolSpec {
        id: "lookup-weather",
        name: "lookup_weather",
        description: "weather lookup",
        input_schema: &serde_json::json!({ "type": "object" }),
    };
    let tools = [spec];
    let request = ProviderRequest {
        provider_id: provider.id(),
        model: "mock-1",
        input: "what is the weather?",
        run_key: "chat-123|1",
        deadline: None,
        api_key: Some("sk-test"),
        messages: Some(&plan),
        tools: Some(&tools),
    };
    let mut events = Vec::new();
    let result = provider.generate(&request, CancelToken::new(&flag), &mut |event| {
        events.push(event);
        EmitStatus::Continue
    });
    let usage = result.expect("tool-call stream succeeds");
    assert_eq!(usage.steps, 0, "no text deltas in the tool-call stream");
    assert_eq!(events.len(), 1, "exactly one emitted event");
    match &events[0] {
        ProviderEvent::ToolCall {
            id,
            name,
            arguments,
        } => {
            assert_eq!(id, "call-1");
            assert_eq!(name, "lookup_weather");
            assert_eq!(arguments, &serde_json::json!({ "city": "Kyiv" }));
        }
        other => panic!("expected ToolCall, got {other:?}"),
    }
}

/// §8.3: a stream with BOTH content and a later tool call emits the deltas
/// first, then the tool call (the kernel commits deltas before waiting).
#[test]
fn streams_text_then_tool_call() {
    let server = MockServer::spawn(move |_request, mut stream| {
        stream.write_all(CHUNKED_HEAD.as_bytes())?;
        let events = [
            (delta_payload("Let me check"), Duration::ZERO),
            (
                tool_call_chunk_payload(
                    0,
                    Some("call-9"),
                    Some("lookup_weather"),
                    r#"{\"city\":\"Oslo\"}"#,
                ),
                Duration::ZERO,
            ),
            ("[DONE]".to_string(), Duration::ZERO),
        ];
        stream.write_all(&chunked_sse_response(&events))?;
        stream.flush()
    });
    let provider = test_provider(&server.base_url());
    let flag = AtomicBool::new(false);
    let request = ProviderRequest {
        provider_id: provider.id(),
        model: "mock-1",
        input: "weather in Oslo",
        run_key: "chat-123|1",
        deadline: None,
        api_key: Some("sk-test"),
        messages: None,
        tools: None,
    };
    let mut events = Vec::new();
    let result = provider.generate(&request, CancelToken::new(&flag), &mut |event| {
        events.push(event);
        EmitStatus::Continue
    });
    let usage = result.expect("mixed stream succeeds");
    assert_eq!(usage.steps, 1);
    assert_eq!(usage.output_chars, 12);
    assert_eq!(events.len(), 2);
    assert!(matches!(&events[0], ProviderEvent::Delta { text } if text == "Let me check"));
    assert!(matches!(
        &events[1],
        ProviderEvent::ToolCall { id, name, .. } if id == "call-9" && name == "lookup_weather"
    ));
}
