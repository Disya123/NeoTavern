//! Tauri local IPC adapter (ТЗ §11.1, §15.1).
//!
//! ```text
//! React → LocalBackend → Tauri IPC → Runtime Kernel → SQLite
//! ```
//!
//! The Desktop Host embeds the Runtime Kernel in the Tauri process. Every
//! command accepts a `wire.request.envelope` JSON body and answers a
//! validated `wire.response.envelope` JSON built by the shared
//! `neotavern-envelope` layer — byte-identical to what the CLI and the
//! remote-http adapter answer for the same operation (§6.3: transports do
//! not define their own DTOs). No HTTP, no sockets, no server lifecycle:
//! with Remote Access off the desktop process owns no listener at all.
//!
//! Contract handshake: [`KernelHost::open`] requires the caller's expected
//! `schemaHash` and FFI ABI version to equal the embedded contract manifest
//! (§6.5) — a stale WebView bundle or mismatched native library is caught
//! before any product write.
//!
//! Streaming: `kernel_stream_start` opens the kernel's live
//! [`EventStream`](runtime_kernel::EventStream) and a background poller
//! forwards the durable `generation.events` log to a Tauri [`Channel`]
//! (notice → bounded page → emit), mirroring the remote-http SSE worker.
//! The run stays durable: dropping the consumer or aborting the stream
//! dispatches `generation.cancel` so the workflow lands in a recoverable
//! terminal state (§63).

use contracts_generated::generated::{
    EventEnvelope, PagedGenerationEvents, RequestListGenerationEvents, ToolSpec,
};
use neotavern_envelope::{self as envelope, EnvelopeFailure, ProtocolVerdict};
use runtime_kernel::{CancellationFlag, EventStream, Kernel, KernelConfig, KernelError};
use std::collections::HashMap;

use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Host-provided secret seams (ТЗ §SEC-01, М5 slice 49): the writable
/// session store and the execution-time resolver.
pub mod secrets;

/// How long each polling iteration waits for a stream notice before
/// re-dispatching `generation.events` (mirrors the remote-http SSE worker).
const STREAM_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Maximum `generation.events` items fetched per poll (bounded memory — one
/// ≤200-event batch in flight, design §6).
const STREAM_PAGE_LIMIT: i64 = 200;

/// Event types that terminate a generation stream (§63). The executor always
/// emits exactly one of these as its final durable event.
const STREAM_TERMINAL_TYPES: [&str; 3] = [
    "generation.completed",
    "generation.failed",
    "generation.cancelled",
];

/// A per-stream cancellation flag registered under the stream id so the UI
/// can abort a live stream by id (`kernel_stream_abort`).
type StreamFlags = Arc<Mutex<HashMap<String, CancellationFlag>>>;

/// Builds a `wire.request.envelope` for the embedded protocol version.
///
/// Transport-level helper shared by the shell's smoke self-check and
/// integration tests; mirrors the CLI's envelope construction (§6.3).
pub fn build_request_envelope(
    operation_id: &str,
    payload: serde_json::Value,
    request_id: &str,
) -> Vec<u8> {
    let (major, minor) = contracts_generated::wire_protocol();
    let envelope = serde_json::json!({
        "wireProtocol": { "major": major, "minor": minor },
        "schemaHash": contracts_generated::contract_schema_hash(),
        "requestId": request_id,
        "operationId": operation_id,
        "payload": payload,
    });
    serde_json::to_vec(&envelope).unwrap_or_else(|_| b"{}".to_vec())
}

/// The kernel host shared with every local IPC command.
///
/// `Clone` is cheap: commands and stream pollers clone the `Arc`s. The
/// kernel mutex is held only for short dispatch calls — never across the
/// 250 ms stream polling waits (mirrors the remote-http adapter's locking
/// discipline).
#[derive(Clone)]
pub struct KernelHost {
    kernel: Arc<Mutex<Kernel>>,
    streams: StreamFlags,
}

/// Configuration for opening the host. The contract handshake constants are
/// taken from the embedded manifest by the crate itself — the shell never
/// duplicates `schemaHash`/FFI ABI versions (§6.5).
pub struct KernelHostConfig {
    /// Optional local data root. `None` keeps the kernel stateless.
    pub data_root: Option<std::path::PathBuf>,
}

/// A wire-valid fallback for unreachable envelope-build invariants.
const INTERNAL_FALLBACK: &[u8] =
    b"{\"kind\":\"error\",\"requestId\":\"00000000-0000-4000-8000-000000000000\",\"error\":{\"code\":\"INTERNAL\",\"params\":{}}}";

impl KernelHost {
    /// Opens the kernel with the exact local handshake (§6.5): the caller's
    /// schema hash and FFI ABI version must equal the embedded manifest,
    /// enforced inside [`Kernel::open`].
    pub fn open(config: KernelHostConfig) -> Result<Self, KernelError> {
        let kernel = Kernel::open(KernelConfig {
            expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
            ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
            data_root: config.data_root,
        })?;
        // ТЗ §SEC-01: the kernel only holds SecretStore/SecretResolver port
        // handles; the host provides the backends. Session-only for now (М5
        // slice 49) — explicit, no plaintext fallback; the OS-vault adapter
        // is a follow-up slice and only `wire_session_secrets` changes.
        secrets::wire_session_secrets(&kernel);
        Ok(Self {
            kernel: Arc::new(Mutex::new(kernel)),
            streams: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// The shared kernel handle, for transports that dispatch directly to
    /// the same kernel the IPC surface serves. Used by the Phase 9 Remote
    /// Access service so the remote listener and the WebView share one
    /// single-writer kernel (§22) — `Clone` is cheap and the mutex is held
    /// only for short dispatch calls.
    pub fn kernel_handle(&self) -> Arc<Mutex<Kernel>> {
        Arc::clone(&self.kernel)
    }

    /// Executes one unary wire operation: decode envelope → protocol check →
    /// kernel dispatch → validated response envelope.
    ///
    /// Returns `Err(EnvelopeFailure)` only for pre-envelope transport
    /// failures (unparseable body), which the caller maps to an IPC-level
    /// error — the same split the CLI makes between stderr diagnostics and
    /// stdout envelopes. Every protocol, kernel and product error comes back
    /// as `Ok` response-envelope bytes.
    pub fn dispatch_envelope(&self, envelope_bytes: &[u8]) -> Result<Vec<u8>, EnvelopeFailure> {
        let env = envelope::decode_request_envelope(envelope_bytes)?;
        let request_id = env.request_id.clone();
        match envelope::check_protocol(&env) {
            ProtocolVerdict::Compatible => {}
            ProtocolVerdict::MajorMismatch {
                client_major,
                server_major,
            } => {
                return Ok(envelope_or_fallback(envelope::build_error_response(
                    &request_id,
                    "PROTOCOL_MISMATCH",
                    vec![
                        ("client_major".to_string(), client_major.to_string()),
                        ("server_major".to_string(), server_major.to_string()),
                    ],
                )));
            }
            ProtocolVerdict::MinorTooNew {
                client_minor,
                server_minor,
            } => {
                return Ok(envelope_or_fallback(envelope::build_error_response(
                    &request_id,
                    "PROTOCOL_MISMATCH",
                    vec![
                        ("client_minor".to_string(), client_minor.to_string()),
                        ("server_minor".to_string(), server_minor.to_string()),
                    ],
                )));
            }
        }
        let payload = envelope::operation_payload_bytes(&env)?;
        let guard = match self.kernel.lock() {
            Ok(guard) => guard,
            Err(_) => return Ok(poisoned_envelope(&request_id)),
        };
        match guard.dispatch(&env.operation_id, &payload, &CancellationFlag::new()) {
            Ok(result_bytes) => {
                let result = match serde_json::from_slice::<serde_json::Value>(&result_bytes) {
                    Ok(result) => result,
                    // The kernel's result bytes are its own DTO serialization;
                    // a parse failure is an internal bug, never a payload issue.
                    Err(_) => {
                        return Ok(error_envelope(
                            &request_id,
                            "INTERNAL",
                            &[("rule", "result_json_parse_failed")],
                        ));
                    }
                };
                Ok(envelope_or_fallback(envelope::build_ok_response(
                    &request_id,
                    result,
                )))
            }
            Err(err) => Ok(envelope::kernel_error_envelope(&err, &request_id)),
        }
    }

    /// Opens a live wire stream (`generation.start` / `generation.retry`)
    /// and spawns the durable-log poller, forwarding each committed
    /// `wire.event.envelope` to `emit`.
    ///
    /// `emit` returns `Err` when the consumer is gone; the run is then
    /// cancelled durably (never silently abandoned mid-flight). The response
    /// envelope carries `{"streamId": ...}` so the caller can abort the
    /// stream by id later (the operation declares no response schema).
    pub fn open_stream(
        &self,
        envelope_bytes: &[u8],
        emit: impl Fn(serde_json::Value) -> Result<(), ()> + Send + 'static,
    ) -> Result<Vec<u8>, EnvelopeFailure> {
        let env = envelope::decode_request_envelope(envelope_bytes)?;
        let request_id = env.request_id.clone();
        match envelope::check_protocol(&env) {
            ProtocolVerdict::Compatible => {}
            ProtocolVerdict::MajorMismatch {
                client_major,
                server_major,
            } => {
                return Ok(envelope_or_fallback(envelope::build_error_response(
                    &request_id,
                    "PROTOCOL_MISMATCH",
                    vec![
                        ("client_major".to_string(), client_major.to_string()),
                        ("server_major".to_string(), server_major.to_string()),
                    ],
                )));
            }
            ProtocolVerdict::MinorTooNew {
                client_minor,
                server_minor,
            } => {
                return Ok(envelope_or_fallback(envelope::build_error_response(
                    &request_id,
                    "PROTOCOL_MISMATCH",
                    vec![
                        ("client_minor".to_string(), client_minor.to_string()),
                        ("server_minor".to_string(), server_minor.to_string()),
                    ],
                )));
            }
        }
        if envelope::operation_event_schema_id(&env.operation_id).is_none() {
            return Ok(error_envelope(
                &request_id,
                "CONTRACT_VIOLATION",
                &[
                    ("rule", "operation_not_streamable"),
                    ("operationId", &env.operation_id),
                ],
            ));
        }
        let payload = envelope::operation_payload_bytes(&env)?;
        let cancel = CancellationFlag::new();
        let stream = {
            let guard = match self.kernel.lock() {
                Ok(guard) => guard,
                Err(_) => return Ok(poisoned_envelope(&request_id)),
            };
            match guard.dispatch_stream(&env.operation_id, &payload, &cancel) {
                Ok(stream) => stream,
                Err(err) => return Ok(envelope::kernel_error_envelope(&err, &request_id)),
            }
        };
        let stream_id = stream.stream_id().to_string();
        {
            let mut flags = match self.streams.lock() {
                Ok(flags) => flags,
                Err(_) => return Ok(poisoned_envelope(&request_id)),
            };
            flags.insert(stream_id.clone(), cancel.clone());
        }
        let kernel = Arc::clone(&self.kernel);
        let streams = Arc::clone(&self.streams);
        let poll_stream_id = stream_id.clone();
        let spawn = std::thread::Builder::new()
            .name("kernel-stream".to_string())
            .spawn(move || {
                poll_loop(kernel, streams, stream, poll_stream_id, cancel, emit);
            });
        if spawn.is_err() {
            self.abort_stream(&stream_id);
            return Ok(error_envelope(
                &request_id,
                "INTERNAL",
                &[("rule", "stream_spawn_failed")],
            ));
        }
        Ok(envelope_or_fallback(envelope::build_ok_response(
            &request_id,
            serde_json::json!({ "streamId": stream_id }),
        )))
    }

    /// Requests cancellation of a live stream by id (idempotent; a missing
    /// or already-finished stream is a no-op). The poller turns the flag into
    /// a durable `generation.cancel` dispatch.
    pub fn abort_stream(&self, stream_id: &str) {
        let Ok(flags) = self.streams.lock() else {
            return;
        };
        if let Some(flag) = flags.get(stream_id) {
            flag.cancel();
        }
    }

    /// Registers a declarative tool contract (`wire.tool.spec`) with the
    /// shared kernel — the host-side seam for `Kernel::register_tool`
    /// (Этап 2.7). Deserialization into the generated DTO validates the spec;
    /// a malformed spec is an IPC-level error, never a kernel write. The
    /// registry is in-memory per kernel: hosts re-register after restart.
    pub fn register_tool(&self, spec: serde_json::Value) -> Result<(), String> {
        let spec: ToolSpec =
            serde_json::from_value(spec).map_err(|e| format!("invalid wire.tool.spec: {e}"))?;
        let guard = self
            .kernel
            .lock()
            .map_err(|_| "kernel lock poisoned".to_string())?;
        guard.register_tool(spec);
        Ok(())
    }
}

/// Pushes a bounded page of the durable `generation.events` log to the
/// consumer until a terminal event, consumer drop, abort or kernel shutdown.
///
/// Mirrors the remote-http SSE worker: poll the notice channel (250 ms
/// timeout), then dispatch `generation.events` for the current cursor, emit
/// every event, advance the cursor. A consumer error or abort dispatches
/// `generation.cancel` once — the run is durable and recoverable (§63).
fn poll_loop(
    kernel: Arc<Mutex<Kernel>>,
    streams: StreamFlags,
    mut stream: EventStream,
    stream_id: String,
    cancel: CancellationFlag,
    emit: impl Fn(serde_json::Value) -> Result<(), ()>,
) {
    let mut last_sent: i64 = -1;
    let mut cancel_requested = false;
    loop {
        if cancel.is_cancelled() && !cancel_requested {
            cancel_requested = true;
            let request = serde_json::json!({ "workflowId": stream_id });
            let _ = dispatch_unary(&kernel, "generation.cancel", &request);
        }
        // Wait for the next notice (or the poll timeout) before re-reading
        // the durable log; a dropped notice is never a correctness problem.
        let notice = stream.next_notice(STREAM_POLL_INTERVAL);
        let request = RequestListGenerationEvents {
            workflow_id: stream_id.clone(),
            after_sequence: Some(last_sent),
            limit: Some(STREAM_PAGE_LIMIT),
        };
        let Ok(result_bytes) = dispatch_unary(&kernel, "generation.events", &request) else {
            // The writer thread terminated (shutdown/crash): stop polling.
            break;
        };
        let Ok(paged) = serde_json::from_slice::<PagedGenerationEvents>(&result_bytes) else {
            // The kernel answered something that is not the paged-events DTO;
            // an internal invariant break, stop the poller.
            break;
        };
        for event in paged.items {
            if emit(event_json(&event)).is_err() {
                cancel_once(&kernel, &stream_id, &mut cancel_requested);
                unregister_stream(&streams, &stream_id);
                return;
            }
            last_sent = event.sequence;
            if is_terminal(&event) {
                // End-of-stream sentinel (transport framing, like the SSE
                // `stream.closed` frame): the consumer stops iterating.
                let _ = emit(serde_json::Value::Null);
                unregister_stream(&streams, &stream_id);
                return;
            }
        }
        if matches!(notice, Some(runtime_kernel::StreamNotice::Terminal { .. })) {
            // The run's stream session ended — terminal (completed/failed/
            // cancelled) OR durably waiting for a tool result (§8.3). The
            // durable log has no further events (this page was the final
            // drain), so close the consumer stream; waiting runs are followed
            // via `generation.events` / `generation.get` from here on.
            let _ = emit(serde_json::Value::Null);
            unregister_stream(&streams, &stream_id);
            return;
        }
    }
    let _ = emit(serde_json::Value::Null);
    unregister_stream(&streams, &stream_id);
}

/// Dispatches a unary operation through the shared kernel, returning the
/// kernel's raw result bytes. `Err` covers a poisoned lock and a terminated
/// writer; the operation never runs with a cancelled flag.
fn dispatch_unary(
    kernel: &Arc<Mutex<Kernel>>,
    operation_id: &str,
    request: &impl serde::Serialize,
) -> Result<Vec<u8>, ()> {
    let payload = serde_json::to_vec(request).map_err(|_| ())?;
    let guard = kernel.lock().map_err(|_| ())?;
    guard
        .dispatch(operation_id, &payload, &CancellationFlag::new())
        .map_err(|_| ())
}

/// Best-effort durable cancel; errors are ignored (the poller may be racing
/// shutdown). Only dispatched once per stream.
fn cancel_once(kernel: &Arc<Mutex<Kernel>>, stream_id: &str, cancel_requested: &mut bool) {
    if *cancel_requested {
        return;
    }
    *cancel_requested = true;
    let request = serde_json::json!({ "workflowId": stream_id });
    let _ = dispatch_unary(kernel, "generation.cancel", &request);
}

/// Removes the stream's flag so the id no longer resolves (idempotent).
fn unregister_stream(streams: &StreamFlags, stream_id: &str) {
    if let Ok(mut flags) = streams.lock() {
        flags.remove(stream_id);
    }
}

/// Serializes a committed event envelope to its wire JSON value.
fn event_json(event: &EventEnvelope) -> serde_json::Value {
    serde_json::to_value(event).unwrap_or(serde_json::Value::Null)
}

/// Whether the event terminates its generation stream (§63).
fn is_terminal(event: &EventEnvelope) -> bool {
    STREAM_TERMINAL_TYPES.contains(&event.r#type.as_str())
}

/// Error envelope with string params, built and validated via the shared
/// layer; falls back to the static envelope on an internal build failure.
fn error_envelope(request_id: &str, code: &str, params: &[(&str, &str)]) -> Vec<u8> {
    envelope_or_fallback(envelope::build_error_response(
        request_id,
        code,
        params
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect(),
    ))
}

/// `INTERNAL kernel_poisoned` envelope, mirroring the remote-http adapter.
fn poisoned_envelope(request_id: &str) -> Vec<u8> {
    error_envelope(request_id, "INTERNAL", &[("rule", "kernel_poisoned")])
}

/// Adapter-internal envelope-build failures are unreachable (string-only
/// params always validate); the static fallback keeps every path panic-free.
fn envelope_or_fallback(result: Result<Vec<u8>, EnvelopeFailure>) -> Vec<u8> {
    result.unwrap_or_else(|_| INTERNAL_FALLBACK.to_vec())
}

// ---------------------------------------------------------------------------
// Tauri command surface (ТЗ §11.1: WebView gets only product operations).
// Compiled with the `tauri` feature (enabled by the Desktop shell).
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri")]
pub mod commands;

/// Phase 9 Remote Access host surface (ТЗ §10): the service state wrapper
/// managed by the Desktop shell and the wire DTOs the `kernel_remote_*`
/// commands answer. The module itself is Tauri-free (pure serde DTOs) so
/// the crate builds with `--features remote` alone; the command surface
/// lives in [`commands`] behind the `tauri` feature.
#[cfg(feature = "remote")]
pub mod remote;

/// Human-readable transport failure for the IPC error surface (never
/// includes payload or secrets).
#[cfg(feature = "tauri")]
pub(crate) fn describe_failure(failure: &EnvelopeFailure) -> String {
    let params = failure
        .params
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    if params.is_empty() {
        format!("{}", failure.code)
    } else {
        format!("{}: {}", failure.code, params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts_generated::generated::{decode_response_envelope, ResponseEnvelope};
    use serde_json::json;

    const REQUEST_ID: &str = "00000000-0000-4000-8000-000000000001";

    fn stateless_host() -> KernelHost {
        KernelHost::open(KernelHostConfig { data_root: None }).expect("stateless kernel must open")
    }

    /// Builds a wire request envelope JSON for the embedded protocol version.
    fn request_envelope(operation_id: &str, payload: serde_json::Value) -> serde_json::Value {
        let (major, minor) = contracts_generated::wire_protocol();
        json!({
            "wireProtocol": { "major": major, "minor": minor },
            "schemaHash": contracts_generated::contract_schema_hash(),
            "requestId": REQUEST_ID,
            "operationId": operation_id,
            "payload": payload,
        })
    }

    fn dispatch(
        host: &KernelHost,
        operation_id: &str,
        payload: serde_json::Value,
    ) -> ResponseEnvelope {
        let body = host
            .dispatch_envelope(
                &serde_json::to_vec(&request_envelope(operation_id, payload)).unwrap(),
            )
            .expect("valid envelope must dispatch");
        decode_response_envelope(&body).expect("response must be a valid wire envelope")
    }

    #[test]
    fn dispatch_meta_round_trip() {
        let host = stateless_host();
        match dispatch(&host, "meta.get", json!({})) {
            ResponseEnvelope::Ok { request_id, result } => {
                assert_eq!(request_id, REQUEST_ID);
                assert!(
                    result.get("productWire").is_some(),
                    "meta result must carry productWire"
                );
            }
            other => panic!("expected ok envelope, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_unknown_operation_maps_to_not_found() {
        let host = stateless_host();
        match dispatch(&host, "nope.nope", json!({})) {
            ResponseEnvelope::Error { request_id, error } => {
                assert_eq!(request_id, REQUEST_ID);
                assert_eq!(error.code, "NOT_FOUND");
            }
            other => panic!("expected error envelope, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_protocol_mismatch_is_controlled() {
        let host = stateless_host();
        let (server_major, _) = contracts_generated::wire_protocol();
        let mut request = request_envelope("meta.get", json!({}));
        request["wireProtocol"]["major"] = json!(server_major + 1);
        let body = host
            .dispatch_envelope(&serde_json::to_vec(&request).unwrap())
            .expect("protocol mismatch must answer an envelope, not fail the transport");
        match decode_response_envelope(&body).expect("valid wire envelope") {
            ResponseEnvelope::Error { error, .. } => assert_eq!(error.code, "PROTOCOL_MISMATCH"),
            other => panic!("expected error envelope, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_garbage_body_is_a_transport_failure() {
        let host = stateless_host();
        let failure = host
            .dispatch_envelope(b"{not json")
            .expect_err("garbage JSON must not produce an envelope");
        assert_eq!(failure.code, "CONTRACT_VIOLATION");
    }

    #[test]
    fn stream_rejects_non_streamable_operation() {
        let host = stateless_host();
        let body = host
            .open_stream(
                &serde_json::to_vec(&request_envelope("characters.list", json!({}))).unwrap(),
                |_| Ok(()),
            )
            .expect("non-streamable op must answer an envelope");
        match decode_response_envelope(&body).expect("valid wire envelope") {
            ResponseEnvelope::Error { error, .. } => {
                assert_eq!(error.code, "CONTRACT_VIOLATION");
                assert_eq!(
                    error.params.get("rule").and_then(|v| v.as_str()),
                    Some("operation_not_streamable")
                );
            }
            other => panic!("expected error envelope, got {other:?}"),
        }
    }

    #[test]
    fn stream_on_stateless_kernel_is_a_controlled_error() {
        let host = stateless_host();
        let body = host
            .open_stream(
                &serde_json::to_vec(&request_envelope("generation.start", json!({}))).unwrap(),
                |_| Ok(()),
            )
            .expect("stateless stream must answer an envelope");
        match decode_response_envelope(&body).expect("valid wire envelope") {
            ResponseEnvelope::Error { error, .. } => {
                // generation.start needs durable storage; a stateless kernel
                // answers INTERNAL — a controlled error, never a panic.
                assert_eq!(error.code, "INTERNAL");
            }
            other => panic!("expected error envelope, got {other:?}"),
        }
    }

    #[test]
    fn stream_protocol_mismatch_is_controlled() {
        let host = stateless_host();
        let mut request = request_envelope("generation.start", json!({}));
        request["wireProtocol"]["minor"] = json!(i64::MAX);
        let body = host
            .open_stream(&serde_json::to_vec(&request).unwrap(), |_| Ok(()))
            .expect("protocol mismatch must answer an envelope");
        match decode_response_envelope(&body).expect("valid wire envelope") {
            ResponseEnvelope::Error { error, .. } => assert_eq!(error.code, "PROTOCOL_MISMATCH"),
            other => panic!("expected error envelope, got {other:?}"),
        }
    }

    #[test]
    fn abort_unknown_stream_is_idempotent() {
        let host = stateless_host();
        host.abort_stream("00000000-0000-4000-8000-000000000099");
        // No panic, no error — the stream simply does not exist anymore.
    }

    /// The poller must CLOSE the consumer stream when the run durably waits
    /// for a tool result (§8.3): the kernel's stream session ends at the
    /// waiting transition with a `Terminal` notice, and waiting runs are
    /// followed via `generation.events` / `generation.get` from then on —
    /// never an unbounded poll loop.
    #[test]
    fn stream_closes_at_durable_waiting_for_tool() {
        let root = std::env::temp_dir().join(format!(
            "neotavern-tauri-local-waiting-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp root");
        let host = KernelHost::open(KernelHostConfig {
            data_root: Some(root.clone()),
        })
        .expect("kernel");

        // Seed character + chat through the real wire surface.
        let character = match dispatch(
            &host,
            "characters.create",
            json!({
                "name": "Aria", "description": "test", "tags": []
            }),
        ) {
            ResponseEnvelope::Ok { result, .. } => result,
            other => panic!("character create: {other:?}"),
        };
        let character_id = character["id"].as_str().expect("id").to_string();
        let chat = match dispatch(
            &host,
            "chats.create",
            json!({
                "characterId": character_id, "title": "waiting"
            }),
        ) {
            ResponseEnvelope::Ok { result, .. } => result,
            other => panic!("chat create: {other:?}"),
        };
        let chat_id = chat["id"].as_str().expect("id").to_string();

        // Register the tool the fake provider will call.
        host.register_tool(json!({
            "id": "lookup-weather",
            "name": "lookup_weather",
            "description": "Weather lookup",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }
        }))
        .expect("register tool");

        // Open the live stream; collect forwarded events until the sentinel.
        let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
        let body = host
            .open_stream(
                &serde_json::to_vec(&request_envelope(
                    "generation.start",
                    json!({
                        "chatId": chat_id,
                        "message": "Weather in Kyiv",
                        "provider": "fake",
                        "model": "tool=lookup_weather",
                    }),
                ))
                .unwrap(),
                move |event| {
                    let _ = tx.send(event);
                    Ok(())
                },
            )
            .expect("open_stream must answer");
        let stream_id = match decode_response_envelope(&body).expect("valid envelope") {
            ResponseEnvelope::Ok { result, .. } => {
                result["streamId"].as_str().expect("streamId").to_string()
            }
            other => panic!("expected ok envelope, got {other:?}"),
        };

        let mut events = Vec::new();
        let mut closed = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(value) if value.is_null() => {
                    closed = true;
                    break;
                }
                Ok(value) => events.push(value),
                Err(_) => continue,
            }
        }
        assert!(
            closed,
            "stream must close at waiting_for_tool; events: {events:?}"
        );

        // The journal carries the provider_turn + tool_call steps, and the
        // run is durably waiting.
        let step_types: Vec<&str> = events
            .iter()
            .filter(|e| e["type"] == "generation.step")
            .filter_map(|e| e["payload"]["step"]["type"].as_str())
            .collect();
        assert!(
            step_types.contains(&"provider_turn"),
            "provider_turn step missing: {events:?}"
        );
        assert!(
            step_types.contains(&"tool_call"),
            "tool_call step missing: {events:?}"
        );
        let run = match dispatch(&host, "generation.get", json!({ "workflowId": stream_id })) {
            ResponseEnvelope::Ok { result, .. } => result,
            other => panic!("generation.get: {other:?}"),
        };
        assert_eq!(run["status"], "waiting_for_tool");

        let _ = std::fs::remove_dir_all(&root);
    }
}
