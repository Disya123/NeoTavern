//! Phase 6 generation-streaming integration tests (design §8 items 10–14).
//!
//! These scenarios drive REAL SSE streams over the adapter's `/rpc/stream`
//! endpoint against a REAL [`runtime_kernel::Kernel`] on a seeded data root:
//!
//! 10. SSE live stream over HTTP: frames in order, terminal `stream.closed`,
//!     payloads == the kernel's durable event log (Local/Remote equivalence).
//! 11. Reconnect resume via `Last-Event-ID`: the second connection gets only
//!     newer events; the union == the full log with no duplicates; the
//!     payload `afterSequence` cursor works without the header too.
//! 12. Slow consumer: a client that reads with pauses still receives the
//!     complete stream (TCP backpressure, notice coalescing) and ends with
//!     the terminal frame.
//! 13. Unary generation ops (`generation.get` / `generation.events`) over
//!     `/rpc` match kernel-direct dispatch results byte-for-byte.
//! 14. The 426 wire-protocol gate blocks `generation.start` BEFORE dispatch:
//!     no generation run row is ever created.
//!
//! Chat rows cannot be created through the wire registry (no `chats.create`
//! op), so every server is spawned over a rusqlite-seeded data root via the
//! shared [`common`] helpers, exactly like the Phase 4 seed scenario.

mod common;

use common::{
    decode_envelope, envelope_body, envelope_body_full, expect_error, expect_ok, find_subslice,
    gen, http_request, http_request_with, json, parse_response, parse_sse, rid, seed_chat,
    Duration, ParsedSseFrame, SocketAddr, TcpStream, TestServer, Value,
};
use runtime_kernel::CancellationFlag;
use std::io::{self, Read, Write};
use std::thread;

/// Fixed seeded chat context (see [`common::seed_chat`]).
const CHARACTER_ID: &str = "00000000-0000-4000-8000-0000000000a1";
const CHAT_ID: &str = "00000000-0000-4000-8000-0000000000a2";

/// A server whose data root holds one seeded chat for `generation.start`.
fn spawn_seeded_server() -> TestServer {
    TestServer::spawn_seeded(|tx| seed_chat(tx, CHARACTER_ID, CHAT_ID))
}

/// Starts `generation.start` over `/rpc/stream` and reads the response to
/// EOF. Returns the decoded streamed [`gen::EventEnvelope`]s (the frames
/// BEFORE `stream.closed`) and the run's workflow id (== stream id).
fn run_generation(
    server: &TestServer,
    request_id: &str,
    model: &str,
) -> (String, Vec<gen::EventEnvelope>) {
    let body = envelope_body(
        request_id,
        "generation.start",
        json!({
            "chatId": CHAT_ID,
            "message": "hello model",
            "provider": "fake",
            "model": model,
        }),
    );
    let response = http_request_with(
        server.addr,
        "POST",
        "/rpc/stream",
        &[("Content-Type", "application/json")],
        &body,
        2000,
        200,
    );
    assert_eq!(response.status, 200, "generation.start answers HTTP 200");
    let content_type = response.header("content-type").unwrap_or_default();
    assert!(
        content_type
            .to_ascii_lowercase()
            .starts_with("text/event-stream"),
        "content-type was {content_type:?}"
    );
    streamed_envelopes(&response.body)
}

/// Parses an SSE body and decodes every non-`stream.closed` frame's `data:`
/// line as an [`gen::EventEnvelope`], asserting the terminal frame shape.
fn streamed_envelopes(body: &[u8]) -> (String, Vec<gen::EventEnvelope>) {
    let text = String::from_utf8(body.to_vec()).expect("SSE body is UTF-8");
    let frames = parse_sse(&text);
    assert!(
        frames.len() >= 2,
        "a stream must carry at least one event frame + stream.closed, got {}",
        frames.len()
    );
    let terminal = frames.last().expect("last frame is stream.closed");
    assert_eq!(terminal.event, "stream.closed");
    assert_eq!(terminal.data, "{}", "terminal frame payload is empty");
    let terminal_id = terminal.id.expect("terminal frame carries an id");

    let mut events = Vec::with_capacity(frames.len() - 1);
    for frame in &frames[..frames.len() - 1] {
        let id = frame.id.expect("every event frame carries a sequence id");
        let env = gen::decode_event_envelope(frame.data.as_bytes())
            .unwrap_or_else(|e| panic!("frame data must decode as an EventEnvelope: {e:?}"));
        assert_eq!(
            env.r#type, frame.event,
            "the SSE event name must equal the envelope type"
        );
        assert_eq!(u64::try_from(env.sequence).expect("sequence fits u64"), id);
        gen::validate_event_envelope(&serde_json::to_value(&env).expect("envelope serializes"))
            .expect("streamed envelope is wire-valid");
        events.push(env);
    }
    assert_eq!(
        terminal_id,
        events.last().expect("events present").sequence as u64 + 1,
        "stream.closed id is one past the last event sequence"
    );
    let stream_id = events
        .first()
        .expect("at least one event")
        .stream_id
        .clone();
    (stream_id, events)
}

/// Fetches the durable `generation.events` log via kernel-direct dispatch.
fn durable_log(
    server: &TestServer,
    workflow_id: &str,
    after_sequence: i64,
) -> Vec<gen::EventEnvelope> {
    let payload = serde_json::to_vec(&json!({
        "workflowId": workflow_id,
        "afterSequence": after_sequence,
        "limit": 200,
    }))
    .expect("events request serializes");
    let guard = server.kernel.lock().expect("kernel lock");
    let bytes = guard
        .dispatch("generation.events", &payload, &CancellationFlag::new())
        .expect("generation.events dispatches directly");
    drop(guard);
    gen::decode_paged_generation_events(&bytes)
        .expect("direct events result decodes")
        .items
}

/// Asserts two envelope lists are equal (streamId, sequence, type, payload).
fn assert_envelopes_equal(
    streamed: &[gen::EventEnvelope],
    log: &[gen::EventEnvelope],
    label: &str,
) {
    assert_eq!(
        streamed.len(),
        log.len(),
        "{label}: streamed and durable log sizes differ"
    );
    for (streamed, log) in streamed.iter().zip(log) {
        assert_eq!(streamed.stream_id, log.stream_id, "{label}: streamId");
        assert_eq!(streamed.sequence, log.sequence, "{label}: sequence");
        assert_eq!(streamed.r#type, log.r#type, "{label}: type");
        assert_eq!(streamed.payload, log.payload, "{label}: payload");
    }
}

/// The concatenated `text` fields of every delta event, in stream order.
fn delta_text(events: &[gen::EventEnvelope]) -> String {
    events
        .iter()
        .filter(|env| env.r#type == "generation.delta")
        .filter_map(|env| env.payload.get("text").and_then(|t| t.as_str()))
        .collect()
}

// ---------------------------------------------------------------------------
// 10. SSE live stream: ordering, terminal frame, durable-log equality
// ---------------------------------------------------------------------------

#[test]
fn live_stream_frames_match_durable_log_and_terminate() {
    let server = spawn_seeded_server();

    // steps=4: deltas at sequences 0..3, one checkpoint (after delta 3),
    // one completed terminal event — deterministic, instant.
    let (stream_id, streamed) = run_generation(&server, &rid(1), "steps=4;tokens-per-step=64");

    // Frames arrive in exactly the executor's commit order.
    let types: Vec<&str> = streamed.iter().map(|env| env.r#type.as_str()).collect();
    assert_eq!(
        types,
        [
            "generation.delta",
            "generation.delta",
            "generation.delta",
            "generation.delta",
            "generation.checkpoint",
            "generation.completed",
        ],
        "frames arrive in commit order"
    );

    // Sequences are globally monotonic with no gaps (0..=5 here).
    let sequences: Vec<i64> = streamed.iter().map(|env| env.sequence).collect();
    assert_eq!(
        sequences,
        (0..6).collect::<Vec<i64>>(),
        "sequences are gapless"
    );
    assert_eq!(
        streamed.last().expect("terminal event").r#type,
        "generation.completed"
    );

    // Delta payloads are deterministic (1-based step display per the design
    // grammar); the checkpoint reports the partial length after the 4th.
    for (i, env) in streamed.iter().enumerate().take(4) {
        let text = env.payload["text"].as_str().expect("delta text");
        assert!(
            text.starts_with(&format!("[attempt 1] step {}/4: ", i + 1)),
            "delta {i} text was {text:?}"
        );
        assert_eq!(text.len(), 30, "22-char prefix + 8 hex chars");
    }
    assert_eq!(streamed[4].payload["sequence"], json!(4));
    assert_eq!(streamed[4].payload["partialLength"], json!(120));

    // The completed event carries the persisted assistant message: full
    // concatenated text, linked to the run, in this chat.
    let completed = &streamed[5].payload;
    let full_text = delta_text(&streamed);
    assert_eq!(full_text.len(), 120);
    let final_message = &completed["finalMessage"];
    assert_eq!(final_message["content"], json!(full_text));
    assert_eq!(final_message["chatId"], json!(CHAT_ID));
    assert_eq!(final_message["role"], json!("assistant"));
    assert_eq!(final_message["generationRunId"], json!(stream_id));

    // Local/Remote equivalence: the streamed payloads equal the durable log
    // read back both kernel-direct (local) and over /rpc (remote).
    let direct = durable_log(&server, &stream_id, -1);
    assert_envelopes_equal(&streamed, &direct, "kernel-direct log");

    let events_body = envelope_body(
        &rid(2),
        "generation.events",
        json!({ "workflowId": stream_id, "afterSequence": -1, "limit": 200 }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &events_body);
    assert_eq!(response.status, 200);
    let (_, result) = expect_ok(decode_envelope(&response.body));
    gen::validate_paged_generation_events(&result).expect("paged generation events is wire-valid");
    let remote_items: Vec<gen::EventEnvelope> = result["items"]
        .as_array()
        .expect("items array")
        .iter()
        .map(|item| {
            gen::decode_event_envelope(&serde_json::to_vec(item).expect("item serializes"))
                .expect("remote item decodes as an EventEnvelope")
        })
        .collect();
    assert_eq!(result["hasMore"], json!(false));
    assert_envelopes_equal(&streamed, &remote_items, "remote /rpc log");
}

// ---------------------------------------------------------------------------
// 11. Reconnect resume via Last-Event-ID (and payload cursor fallback)
// ---------------------------------------------------------------------------

/// Incremental RFC 7230 chunked-body decoder: feed raw bytes, read decoded
/// bytes back. The adapter streams SSE with unknown length, so tiny_http
/// writes the body chunked; a mid-stream disconnect needs incremental
/// decoding to know how many frames were actually received.
struct IncrementalChunked {
    raw: Vec<u8>,
    decoded: Vec<u8>,
    done: bool,
}

impl IncrementalChunked {
    fn new() -> Self {
        Self {
            raw: Vec::new(),
            decoded: Vec::new(),
            done: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        if self.done {
            return;
        }
        self.raw.extend_from_slice(bytes);
        loop {
            let Some(line_end) = find_subslice(&self.raw, b"\r\n") else {
                return; // chunk size line not complete yet
            };
            let line = std::str::from_utf8(&self.raw[..line_end]).unwrap_or_default();
            let Ok(size) = usize::from_str_radix(line.trim(), 16) else {
                return; // partial size line
            };
            if self.raw.len() < line_end + 2 + size + 2 {
                return; // chunk data + trailing CRLF not complete yet
            }
            if size == 0 {
                self.done = true;
                return;
            }
            self.decoded
                .extend_from_slice(&self.raw[line_end + 2..line_end + 2 + size]);
            self.raw.drain(..line_end + 2 + size + 2);
        }
    }
}

/// Sends a streaming POST, reads the SSE body incrementally until at least
/// `min_frames` frames are buffered, then CLOSES the connection mid-stream —
/// the client write error must drop the stream without cancelling the
/// executor (the run stays durable, design §6). Returns the received frames.
fn read_stream_partial(addr: SocketAddr, body: &[u8], min_frames: usize) -> Vec<ParsedSseFrame> {
    let mut stream = TcpStream::connect(addr).expect("connect to the adapter");
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set read timeout");

    let mut request = format!(
        "POST /rpc/stream HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    request.push_str(&String::from_utf8_lossy(body));
    stream.write_all(request.as_bytes()).expect("write request");

    let mut head_buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut decoder = IncrementalChunked::new();
    let mut stalls = 0u32;
    let body_start = loop {
        if let Some(separator) = find_subslice(&head_buf, b"\r\n\r\n") {
            break separator + 4;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break usize::MAX,
            Ok(n) => {
                head_buf.extend_from_slice(&chunk[..n]);
                stalls = 0;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                stalls += 1;
                if stalls > 150 {
                    break usize::MAX; // ~15s cap: treat as no more frames
                }
            }
            Err(_) => break usize::MAX,
        }
    };

    if body_start != usize::MAX {
        decoder.push(&head_buf[body_start..]);
        loop {
            let frames = parse_sse(&String::from_utf8_lossy(&decoder.decoded));
            if frames.len() >= min_frames || decoder.done {
                break;
            }
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    decoder.push(&chunk[..n]);
                    stalls = 0;
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    stalls += 1;
                    if stalls > 150 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }

    // Close mid-stream on purpose: the executor must keep running.
    drop(stream);
    parse_sse(&String::from_utf8_lossy(&decoder.decoded))
}

/// Decodes the event frames (excluding `stream.closed`) of a partial read.
fn partial_events(frames: &[ParsedSseFrame]) -> Vec<gen::EventEnvelope> {
    frames
        .iter()
        .filter(|frame| frame.event != "stream.closed")
        .map(|frame| {
            gen::decode_event_envelope(frame.data.as_bytes())
                .unwrap_or_else(|e| panic!("partial frame data must decode: {e:?}"))
        })
        .collect()
}

#[test]
fn resume_via_last_event_id_replays_only_newer_events() {
    let server = spawn_seeded_server();

    // Slow enough that a client can disconnect mid-stream: ~480ms of deltas.
    let body = envelope_body(
        &rid(1),
        "generation.start",
        json!({ "chatId": CHAT_ID, "message": "hi", "model": "steps=8;delay-ms=60" }),
    );
    let first = read_stream_partial(server.addr, &body, 2);
    let first_events = partial_events(&first);
    assert!(
        first_events.len() >= 2,
        "the client must receive at least 2 frames before disconnecting, got {}",
        first_events.len()
    );
    let stream_id = first_events[0].stream_id.clone();
    let last_received = first_events.last().expect("received events").sequence;
    assert!(
        !first_events
            .iter()
            .any(|env| env.r#type == "generation.completed"),
        "the disconnect must happen before the run completes"
    );

    // Reconnect with Last-Event-ID = last received sequence. The header wins
    // over the payload cursor (payload says -1, which would replay
    // everything if the header were ignored).
    let resume_body = envelope_body(
        &rid(2),
        "generation.events",
        json!({ "workflowId": stream_id, "afterSequence": -1, "limit": 200 }),
    );
    let response = http_request_with(
        server.addr,
        "POST",
        "/rpc/stream",
        &[
            ("Content-Type", "application/json"),
            ("Last-Event-ID", &last_received.to_string()),
        ],
        &resume_body,
        2000,
        200,
    );
    assert_eq!(response.status, 200);
    let (_, resumed) = streamed_envelopes(&response.body);

    // The resumed connection replays only events newer than the header
    // cursor — and the union of both connections equals the full durable
    // log, exactly once each, in order.
    assert!(
        resumed.iter().all(|env| env.sequence > last_received),
        "resume must not replay events at or before the Last-Event-ID cursor"
    );
    let full_log = durable_log(&server, &stream_id, -1);
    assert_envelopes_equal(
        &full_log[..first_events.len()],
        &first_events,
        "first connection",
    );
    assert_envelopes_equal(
        &full_log[first_events.len()..],
        &resumed,
        "resumed connection",
    );
    assert_eq!(
        resumed.last().expect("resumed terminal event").r#type,
        "generation.completed"
    );

    // The payload-only cursor (no header) is the fallback path: replaying
    // from the same cursor yields the identical tail.
    let resume_body = envelope_body(
        &rid(3),
        "generation.events",
        json!({ "workflowId": stream_id, "afterSequence": last_received, "limit": 200 }),
    );
    let response = http_request_with(
        server.addr,
        "POST",
        "/rpc/stream",
        &[("Content-Type", "application/json")],
        &resume_body,
        2000,
        200,
    );
    let (_, replayed) = streamed_envelopes(&response.body);
    assert_envelopes_equal(&resumed, &replayed, "payload-cursor resume");
}

// ---------------------------------------------------------------------------
// 12. Slow consumer: delayed reads complete without error
// ---------------------------------------------------------------------------

#[test]
fn slow_consumer_stream_completes() {
    let server = spawn_seeded_server();

    let body = envelope_body(
        &rid(1),
        "generation.start",
        json!({ "chatId": CHAT_ID, "message": "hi", "model": "steps=8;delay-ms=40" }),
    );
    let mut stream = TcpStream::connect(server.addr).expect("connect to the adapter");
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .expect("set read timeout");
    let mut request = format!(
        "POST /rpc/stream HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        server.addr,
        body.len()
    );
    request.push_str(&String::from_utf8_lossy(&body));
    stream.write_all(request.as_bytes()).expect("write request");

    // Read in tiny chunks with a pause after every read: TCP backpressure
    // must not stall or corrupt the stream, and the response must complete.
    let mut raw: Vec<u8> = Vec::new();
    let mut buf = [0u8; 64];
    let mut stalls = 0u32;
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                stalls = 0;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                stalls += 1;
                assert!(
                    stalls < 60,
                    "slow consumer stalled for too long ({} bytes buffered)",
                    raw.len()
                );
            }
            Err(e) => panic!("slow consumer read failed: {e}"),
        }
        thread::sleep(Duration::from_millis(150));
    }
    drop(stream);

    // The server writes chunked (unknown length upfront) — decode the
    // framing before parsing SSE frames.
    let response = parse_response(&raw);
    assert_eq!(response.status, 200);
    let (stream_id, streamed) = streamed_envelopes(&response.body);
    assert_eq!(
        streamed.last().expect("terminal event").r#type,
        "generation.completed"
    );
    let full_log = durable_log(&server, &stream_id, -1);
    assert_envelopes_equal(&streamed, &full_log, "slow consumer stream");
}

// ---------------------------------------------------------------------------
// 13. Unary generation ops over /rpc match kernel-direct results
// ---------------------------------------------------------------------------

/// Dispatches one unary op kernel-direct and returns the raw result bytes.
fn direct_dispatch(server: &TestServer, operation_id: &str, payload: Value) -> Vec<u8> {
    let payload = serde_json::to_vec(&payload).expect("payload serializes");
    let guard = server.kernel.lock().expect("kernel lock");
    guard
        .dispatch(operation_id, &payload, &CancellationFlag::new())
        .expect("direct dispatch succeeds")
}

#[test]
fn unary_generation_ops_over_rpc_match_kernel_direct() {
    let server = spawn_seeded_server();
    let (stream_id, streamed) = run_generation(&server, &rid(1), "steps=4;tokens-per-step=64");

    // generation.get: the /rpc result equals the kernel-direct DTO.
    let get_payload = json!({ "workflowId": stream_id });
    let direct = direct_dispatch(&server, "generation.get", get_payload.clone());
    let direct_value: Value = serde_json::from_slice(&direct).expect("direct result is JSON");
    let response = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[],
        &envelope_body(&rid(2), "generation.get", get_payload),
    );
    assert_eq!(response.status, 200);
    let (request_id, result) = expect_ok(decode_envelope(&response.body));
    assert_eq!(request_id, rid(2));
    gen::validate_generation_run(&result).expect("generation run is wire-valid");
    assert_eq!(
        result, direct_value,
        "remote generation.get == kernel-direct"
    );

    let run = gen::decode_generation_run(&direct).expect("direct run decodes");
    assert_eq!(run.run_id, stream_id);
    assert_eq!(run.chat_id, CHAT_ID);
    assert_eq!(run.attempt, 1);
    assert_eq!(run.status, gen::GenerationStatus::Completed);
    assert_eq!(run.provider.as_deref(), Some("fake"));
    assert_eq!(run.model.as_deref(), Some("steps=4;tokens-per-step=64"));
    assert_eq!(run.source_run_id, None);
    assert_eq!(run.error, None);
    let full_text = delta_text(&streamed);
    assert_eq!(run.partial_text.as_deref(), Some(full_text.as_str()));
    assert_eq!(run.partial_text_length, full_text.len() as i64);
    assert!(!run.partial_truncated, "short output is not truncated");
    assert!(
        run.message_id.is_some(),
        "a completed run must link the persisted assistant message"
    );
    assert_eq!(
        run.last_event_sequence,
        streamed.last().expect("terminal event").sequence,
        "last event sequence matches the terminal event"
    );

    // generation.events: same equivalence over the full log.
    let events_payload = json!({
        "workflowId": stream_id,
        "afterSequence": -1,
        "limit": 200,
    });
    let direct_events = direct_dispatch(&server, "generation.events", events_payload.clone());
    let direct_page: Value = serde_json::from_slice(&direct_events).expect("direct page is JSON");
    let response = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[],
        &envelope_body(&rid(3), "generation.events", events_payload),
    );
    assert_eq!(response.status, 200);
    let (_, page) = expect_ok(decode_envelope(&response.body));
    gen::validate_paged_generation_events(&page).expect("paged events is wire-valid");
    assert_eq!(
        page, direct_page,
        "remote generation.events == kernel-direct"
    );
    let items: Vec<gen::EventEnvelope> = page["items"]
        .as_array()
        .expect("items array")
        .iter()
        .map(|item| {
            gen::decode_event_envelope(&serde_json::to_vec(item).expect("item serializes"))
                .expect("item decodes")
        })
        .collect();
    assert_envelopes_equal(&streamed, &items, "unary events replay");
}

// ---------------------------------------------------------------------------
// 14. The 426 wire-protocol gate blocks generation BEFORE dispatch
// ---------------------------------------------------------------------------

#[test]
fn protocol_gate_blocks_generation_before_dispatch() {
    let server = spawn_seeded_server();

    // A perfectly valid generation.start request with a WRONG protocol major:
    // the gate must reject it before any kernel dispatch.
    let body = envelope_body_full(
        2,
        0,
        contracts_generated::contract_schema_hash(),
        &rid(1),
        "generation.start",
        json!({ "chatId": CHAT_ID, "message": "must not run", "model": "steps=2" }),
    );
    let response = http_request(server.addr, "POST", "/rpc/stream", &[], &body);
    assert_eq!(response.status, 426, "major mismatch is HTTP 426");
    let content_type = response.header("content-type").unwrap_or_default();
    assert!(
        content_type
            .to_ascii_lowercase()
            .starts_with("application/json"),
        "the 426 body is a JSON error envelope, not SSE: {content_type:?}"
    );
    let (request_id, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1));
    assert_eq!(error.code, "PROTOCOL_MISMATCH");
    assert_eq!(error.params["client_major"], json!("2"));
    assert_eq!(error.params["server_major"], json!("1"));

    // The operation must NOT have dispatched: no generation run row exists.
    // (The wire registry has no run-list op, so count rows through a
    // read-only SQLite connection — WAL allows concurrent readers.)
    let db = rusqlite::Connection::open_with_flags(
        server.data_root().join("database.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("read-only open of the kernel database");
    let runs: i64 = db
        .query_row("SELECT COUNT(*) FROM generation_runs", [], |row| row.get(0))
        .expect("count generation runs");
    assert_eq!(runs, 0, "the 426-gated generation must not have dispatched");
}
