//! Thin JNI transport over the [`neotavern_mobile_ffi`] C ABI (ТЗ §6.9,
//! Фаза 5).
//!
//! The Android host loads `libneotavern_android_jni.so` into the app process.
//! This crate is the only Rust code on the device; it translates between JNI
//! calls from `com.neotavern.mobile.KernelBridge` and the stable C ABI of the
//! mobile-ffi crate:
//!
//! ```text
//! Kotlin KernelBridge → JNI → jni_* core → nt_* (mobile-ffi) → Runtime Kernel
//! ```
//!
//! Contract highlights (shared with the desktop Tauri transport):
//!
//! - the JNI layer answers byte-identical response-envelope bytes to
//!   `neotavern-tauri-local` for the same request envelope — both go through
//!   the shared `neotavern-envelope` mapping (§6.3: transports do not define
//!   their own DTOs);
//! - envelope decoding (operationId + payload extraction) happens in Rust via
//!   the generated wire DTOs, never in Kotlin — no hand-written wire DTOs;
//! - opaque handles are i64 values registered in process-local tables (real
//!   handles are pointer values; failed stream starts get a virtual handle
//!   from a counter at `i64::MAX`); a stale handle is a controlled
//!   [`JniError`] — never undefined behaviour, double-free is a no-op;
//! - no Rust panic crosses the JNI boundary: every JNI entry point is wrapped
//!   in `catch_unwind` and a panic becomes a thrown
//!   `com.neotavern.mobile.KernelException` (`NT_ERR_INTERNAL` semantics);
//! - all request buffer sizes are checked against [`MAX_REQUEST_LEN`] before
//!   allocation or parse, mirroring the mobile-ffi boundary checks.
//!
//! The plain-Rust core functions ([`jni_open`], [`jni_call`], …) are
//! JVM-independent and unit-tested on the host.

use std::collections::{HashMap, VecDeque};
use std::ffi::CString;
use std::os::raw::c_int;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{LazyLock, Mutex};

use contracts_generated::generated::{
    EventEnvelope, PagedGenerationEvents, ProductErrorDto, RequestEnvelope,
    RequestListGenerationEvents,
};
use contracts_generated::Issue;
use jni::objects::{JByteArray, JClass, JString, JThrowable, JValue};
use jni::sys::{jbyteArray, jint, jlong, jstring};
use jni::JNIEnv;
use neotavern_envelope as envelope;
use neotavern_envelope::ProtocolVerdict;
use neotavern_mobile_ffi::{
    NtKernel, NtStream, FFI_ABI_VERSION, MAX_REQUEST_LEN, NT_ERR_BUFFER, NT_ERR_CANCELLED,
    NT_ERR_CONTRACT, NT_ERR_INTERNAL, NT_ERR_INVALID_ARG, NT_ERR_MISMATCH, NT_ERR_NOT_FOUND,
    NT_ERR_STORAGE, NT_OK,
};
use runtime_kernel::{KernelError, KernelErrorCode};

/// App version reported by the handshake (the mobile shell's
/// `meta.appVersion` parity; the kernel reports its own copy).
pub const APP_VERSION: &str = "0.1.0";

/// Safety ceiling for kernel response buffers. The kernel is trusted, but the
/// ABI never trusts a length it has not validated itself (request side is
/// capped at [`MAX_REQUEST_LEN`]; responses may legitimately exceed it for
/// list pages, so this is a defensive growth bound, not a contract limit).
const MAX_RESPONSE_LEN: usize = 64 * 1024 * 1024;

/// Maximum `generation.events` items fetched per poll (bounded memory — one
/// ≤200-event batch in flight, mirrors the Tauri transport's poller).
const STREAM_PAGE_LIMIT: i64 = 200;

/// Event types that terminate a generation stream (§63). The executor always
/// emits exactly one of these as its final durable event.
const STREAM_TERMINAL_TYPES: [&str; 3] = [
    "generation.completed",
    "generation.failed",
    "generation.cancelled",
];

/// End-of-stream framing payload (the frozen WebView bridge contract's
/// `{kind:"terminal"}` callback object), returned verbatim by the host.
const TERMINAL_FRAMING: &[u8] = br#"{"kind":"terminal"}"#;

/// Static wire-valid error envelope used only on an unreachable internal
/// invariant break (mirrors the other transports).
const INTERNAL_FALLBACK: &[u8] =
    b"{\"kind\":\"error\",\"requestId\":\"00000000-0000-4000-8000-000000000000\",\"error\":{\"code\":\"INTERNAL\",\"params\":{}}}";

// ---------------------------------------------------------------------------
// Stable error codes (mirror the mobile-ffi NT_ERR_* contract; these integer
// values are what the Kotlin `KernelException(int code, String message)`
// receives)
// ---------------------------------------------------------------------------

/// Stable JNI error code; the integer value is the mobile-ffi `NT_ERR_*`
/// status so the Android host can map it without another table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum JniErrorCode {
    /// Null/invalid argument, oversized or malformed input.
    InvalidArg = NT_ERR_INVALID_ARG,
    /// Contract violation (payload failed the generated DTO checks).
    Contract = NT_ERR_CONTRACT,
    /// Operation or record not found.
    NotFound = NT_ERR_NOT_FOUND,
    /// Storage-layer failure (lease conflict, corruption, no durable storage).
    Storage = NT_ERR_STORAGE,
    /// Operation cancelled.
    Cancelled = NT_ERR_CANCELLED,
    /// Internal failure (including a contained Rust panic).
    Internal = NT_ERR_INTERNAL,
    /// Host output buffer too small.
    Buffer = NT_ERR_BUFFER,
    /// Contract/schema hash or ABI version mismatch.
    Mismatch = NT_ERR_MISMATCH,
}

/// A controlled failure of the JNI transport: a stable code plus a
/// human-readable message. Product and kernel errors are *not* `JniError`s —
/// they travel back as response-envelope bytes exactly like the desktop
/// transport; `JniError` covers transport-level and ABI-level failures only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JniError {
    /// Stable error class.
    pub code: JniErrorCode,
    /// Human-readable detail (never includes payloads or secrets).
    pub message: String,
}

impl JniError {
    fn new(code: JniErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid_arg(message: impl Into<String>) -> Self {
        Self::new(JniErrorCode::InvalidArg, message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(JniErrorCode::Internal, message)
    }

    /// Maps a mobile-ffi NT status to the stable code (unknown statuses are
    /// `Internal`, mirroring mobile-ffi's `status_for` fallback).
    fn code_for_status(status: c_int) -> JniErrorCode {
        match status {
            NT_ERR_INVALID_ARG => JniErrorCode::InvalidArg,
            NT_ERR_CONTRACT => JniErrorCode::Contract,
            NT_ERR_NOT_FOUND => JniErrorCode::NotFound,
            NT_ERR_STORAGE => JniErrorCode::Storage,
            NT_ERR_CANCELLED => JniErrorCode::Cancelled,
            NT_ERR_BUFFER => JniErrorCode::Buffer,
            NT_ERR_MISMATCH => JniErrorCode::Mismatch,
            _ => JniErrorCode::Internal,
        }
    }

    fn from_status(status: c_int, context: &str) -> Self {
        Self::new(
            Self::code_for_status(status),
            format!("{context}: NT status {status}"),
        )
    }

    /// Maps an envelope-layer failure to a transport-level JniError — the JNI
    /// analog of the Tauri transport's `Err(EnvelopeFailure)` IPC error.
    fn from_envelope_failure(failure: envelope::EnvelopeFailure) -> Self {
        let code = match failure.code {
            "INTERNAL" => JniErrorCode::Internal,
            _ => JniErrorCode::Contract,
        };
        Self::new(
            code,
            format!(
                "request envelope decode failed: {} (http {})",
                failure.code, failure.http_status
            ),
        )
    }
}

// ---------------------------------------------------------------------------
// Opaque handle registries
// ---------------------------------------------------------------------------

/// One live stream registered by [`jni_stream_start`].
struct LiveStream {
    /// The mobile-ffi stream handle (freed by [`jni_stream_free`]).
    stream: StreamHandle,
    /// Kernel handle this stream belongs to (used to dispatch
    /// `generation.events`; the kernel registry is the liveness source).
    kernel: i64,
    /// Durable run id — the `workflowId` of `generation.events` requests.
    workflow_id: String,
    /// Request id echoed into error envelopes built by this stream.
    request_id: String,
    /// Highest sequence already delivered to the host.
    last_sequence: i64,
    /// Events fetched from the durable log but not yet delivered. A single
    /// notice can cover a whole ≤200-event page; delivery drains the buffer
    /// first and only waits for a new notice when it is empty.
    pending: VecDeque<EventEnvelope>,
    /// The terminal event was delivered; the `{kind:"terminal"}` framing is
    /// the next wait's answer.
    terminal_pending: bool,
    /// The terminal framing was delivered; every later wait is `None`.
    terminal_done: bool,
}

/// Registry entry: either a live mobile-ffi stream or a virtual error stream
/// (a failed `nt_stream_start` whose failure is product/kernel-class — the
/// host receives the exact error envelope the desktop transport answers).
enum StreamState {
    Live(LiveStream),
    Error {
        /// Serialized `wire.response.envelope` (error kind).
        envelope: Vec<u8>,
        delivered: bool,
    },
}

/// Raw handle wrapper. mobile-ffi promises handles are `Send + Sync` (any
/// thread may call; see its crate docs), so the registry may share the raw
/// pointers across threads.
struct KernelHandle(*mut NtKernel);

// SAFETY: mobile-ffi's kernel handles are Send + Sync by contract.
unsafe impl Send for KernelHandle {}
unsafe impl Sync for KernelHandle {}

/// Raw stream handle wrapper (see [`KernelHandle`]).
struct StreamHandle(*mut NtStream);

// SAFETY: mobile-ffi's stream handles are Send + Sync by contract.
unsafe impl Send for StreamHandle {}
unsafe impl Sync for StreamHandle {}

/// Live kernel handles: i64 → `*mut NtKernel` (pointer value).
static SESSIONS: LazyLock<Mutex<HashMap<i64, KernelHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Live stream handles: i64 → stream state. Real handles are pointer values
/// (≤ 2^48 on Linux/Android); virtual error-stream handles come from a
/// counter at `i64::MAX` decrementing, so the two spaces cannot collide.
static STREAMS: LazyLock<Mutex<HashMap<i64, StreamState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static NEXT_ERROR_STREAM_HANDLE: AtomicI64 = AtomicI64::new(i64::MAX);

fn kernel_ptr(handle: i64) -> Result<*mut NtKernel, JniError> {
    SESSIONS
        .lock()
        .map_err(|_| JniError::internal("kernel registry poisoned"))?
        .get(&handle)
        .map(|wrapped| wrapped.0)
        .ok_or_else(|| JniError::invalid_arg(format!("unknown kernel handle {handle:#x}")))
}

// ---------------------------------------------------------------------------
// FFI plumbing
// ---------------------------------------------------------------------------

/// Bounded FFI call: grows the host buffer on `NT_ERR_BUFFER` (mobile-ffi
/// reports the required capacity without allocating) and retries. Returns the
/// kernel's raw result bytes or `(status, serialized error body)`.
fn ffi_call(kernel: *mut NtKernel, op: &str, payload: &[u8]) -> Result<Vec<u8>, (c_int, Vec<u8>)> {
    let op = CString::new(op).map_err(|_| (NT_ERR_INVALID_ARG, Vec::new()))?;
    let mut out = vec![0u8; 4096];
    let mut out_len = 0usize;
    loop {
        // mobile-ffi's entry points are safe extern "C" functions; the raw
        // pointers are validated inside its boundary.
        let status = neotavern_mobile_ffi::nt_call(
            kernel,
            op.as_ptr(),
            payload.as_ptr(),
            payload.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut out_len,
        );
        match status {
            NT_OK => return Ok(out[..out_len].to_vec()),
            NT_ERR_BUFFER => {
                if out_len == 0 || out_len > MAX_RESPONSE_LEN {
                    return Err((NT_ERR_INTERNAL, Vec::new()));
                }
                out.resize(out_len, 0);
            }
            error_status => {
                let body = if out_len <= out.len() {
                    out[..out_len].to_vec()
                } else {
                    Vec::new()
                };
                return Err((error_status, body));
            }
        }
    }
}

/// Rebuilds the typed [`KernelError`] the C ABI serialized into `body` (the
/// inverse of mobile-ffi's `error_body`), so the shared envelope layer builds
/// the same error envelope the Tauri transport answers.
///
/// The ABI carries `(status, body)`; the body is either the wire product DTO
/// verbatim (`err.product`) or `{code, message, issues}`. Diagnostic
/// `err.params` are deliberately not serialized by mobile-ffi; no current
/// kernel error populates them (`KernelError::with_params` is defined but
/// never called), so the reconstructed envelope is byte-identical to the
/// Tauri transport's for every real kernel error.
fn kernel_error_from_ffi(status: c_int, body: &[u8]) -> KernelError {
    // Product DTO verbatim? (deny_unknown_fields on ErrorDto makes the
    // non-product `{code, message, issues}` body fail this parse.)
    if let Ok(product) = serde_json::from_slice::<ProductErrorDto>(body) {
        return KernelError {
            code: KernelErrorCode::Internal, // unused by the envelope layer when product is set
            message: format!("product error {}", product.code),
            issues: Vec::new(),
            params: Vec::new(),
            product: Some(Box::new(product)),
        };
    }
    let fallback = KernelError {
        code: kernel_code_from_status(status),
        message: "kernel dispatch failed".to_string(),
        issues: Vec::new(),
        params: Vec::new(),
        product: None,
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return fallback;
    };
    let code = value
        .get("code")
        .and_then(serde_json::Value::as_str)
        .and_then(kernel_code_from_display)
        .unwrap_or_else(|| kernel_code_from_status(status));
    let message = value
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("kernel dispatch failed")
        .to_string();
    let issues = value
        .get("issues")
        .and_then(serde_json::Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    let path = item.get("path")?.as_str()?.to_string();
                    let rule = item.get("rule")?.as_str()?.to_string();
                    Some(Issue::new(path, rule))
                })
                .collect()
        })
        .unwrap_or_default();
    KernelError {
        code,
        message,
        issues,
        params: Vec::new(),
        product: None,
    }
}

/// Inverts mobile-ffi's `status_for`: NT status → kernel error class (used
/// only as a fallback when the serialized body carries no code).
fn kernel_code_from_status(status: c_int) -> KernelErrorCode {
    match status {
        NT_ERR_CONTRACT => KernelErrorCode::ContractViolation,
        NT_ERR_NOT_FOUND => KernelErrorCode::OperationNotFound,
        NT_ERR_CANCELLED => KernelErrorCode::Cancelled,
        NT_ERR_STORAGE => KernelErrorCode::StorageFailure,
        NT_ERR_MISMATCH => KernelErrorCode::ContractMismatch,
        _ => KernelErrorCode::Internal,
    }
}

/// Inverts `KernelErrorCode`'s `Display` strings (as serialized by
/// mobile-ffi's `error_body`).
fn kernel_code_from_display(text: &str) -> Option<KernelErrorCode> {
    Some(match text {
        "contract-mismatch" => KernelErrorCode::ContractMismatch,
        "contract-violation" => KernelErrorCode::ContractViolation,
        "operation-not-found" => KernelErrorCode::OperationNotFound,
        "unauthorized" => KernelErrorCode::Unauthorized,
        "internal" => KernelErrorCode::Internal,
        "cancelled" => KernelErrorCode::Cancelled,
        "data-root-in-use" => KernelErrorCode::DataRootInUse,
        "storage-failure" => KernelErrorCode::StorageFailure,
        "not-found" => KernelErrorCode::NotFound,
        "conflict" => KernelErrorCode::Conflict,
        "provider-error" => KernelErrorCode::ProviderError,
        _ => return None,
    })
}

/// Adapter-internal envelope-build failures are unreachable (string-only
/// params always validate); the static fallback keeps every path panic-free
/// (mirrors the Tauri transport).
fn envelope_or_fallback(result: Result<Vec<u8>, envelope::EnvelopeFailure>) -> Vec<u8> {
    result.unwrap_or_else(|_| INTERNAL_FALLBACK.to_vec())
}

/// Wire-protocol error envelope for a mismatched request, byte-identical to
/// the Tauri transport's `PROTOCOL_MISMATCH` answer.
fn protocol_mismatch_envelope(request_id: &str, env: &RequestEnvelope) -> Vec<u8> {
    let params = match envelope::check_protocol(env) {
        ProtocolVerdict::Compatible => return INTERNAL_FALLBACK.to_vec(),
        ProtocolVerdict::MajorMismatch {
            client_major,
            server_major,
        } => vec![
            ("client_major".to_string(), client_major.to_string()),
            ("server_major".to_string(), server_major.to_string()),
        ],
        ProtocolVerdict::MinorTooNew {
            client_minor,
            server_minor,
        } => vec![
            ("client_minor".to_string(), client_minor.to_string()),
            ("server_minor".to_string(), server_minor.to_string()),
        ],
    };
    envelope_or_fallback(envelope::build_error_response(
        request_id,
        "PROTOCOL_MISMATCH",
        params,
    ))
}

// ---------------------------------------------------------------------------
// Plain Rust core (JVM-independent, host-testable)
// ---------------------------------------------------------------------------

/// The handshake JSON the mobile shell reads once at startup:
/// `{ffiAbiVersion, schemaHash, wireProtocol, appVersion}`.
pub fn jni_handshake() -> String {
    let (major, minor) = contracts_generated::wire_protocol();
    serde_json::json!({
        "ffiAbiVersion": FFI_ABI_VERSION,
        "schemaHash": contracts_generated::contract_schema_hash(),
        "wireProtocol": { "major": major, "minor": minor },
        "appVersion": APP_VERSION,
    })
    .to_string()
}

/// Opens a kernel over `data_root` and returns its opaque handle. An empty
/// `data_root` opens a stateless kernel (mirrors mobile-ffi's null path); the
/// Android host always passes the app-scoped `filesDir/neotavern`.
pub fn jni_open(data_root: &str) -> Result<i64, JniError> {
    let root = if data_root.is_empty() {
        None
    } else {
        Some(
            CString::new(data_root)
                .map_err(|_| JniError::invalid_arg("data root contains a NUL byte"))?,
        )
    };
    let mut handle: *mut NtKernel = std::ptr::null_mut();
    let status = neotavern_mobile_ffi::nt_kernel_open(
        root.as_ref()
            .map(|cstring| cstring.as_ptr())
            .unwrap_or(std::ptr::null()),
        &mut handle,
    );
    if status != NT_OK {
        return Err(JniError::from_status(status, "nt_kernel_open failed"));
    }
    if handle.is_null() {
        return Err(JniError::internal("nt_kernel_open returned a null handle"));
    }
    let kernel_handle = handle as i64;
    SESSIONS
        .lock()
        .map_err(|_| JniError::internal("kernel registry poisoned"))?
        .insert(kernel_handle, KernelHandle(handle));
    Ok(kernel_handle)
}

/// Frees a kernel and every stream it owns. Idempotent: unknown handles are a
/// no-op.
pub fn jni_close(handle: i64) {
    let stream_handles: Vec<i64> = {
        let Ok(mut streams) = STREAMS.lock() else {
            return;
        };
        let mut owned = Vec::new();
        streams.retain(|stream_handle, state| {
            let belongs_to_kernel =
                matches!(state, StreamState::Live(live) if live.kernel == handle);
            if belongs_to_kernel {
                owned.push(*stream_handle);
                false
            } else {
                true
            }
        });
        owned
    };
    for stream_handle in stream_handles {
        jni_stream_free(stream_handle);
    }
    let kernel = SESSIONS
        .lock()
        .ok()
        .and_then(|mut sessions| sessions.remove(&handle));
    if let Some(kernel) = kernel {
        neotavern_mobile_ffi::nt_kernel_free(kernel.0);
    }
}

/// Executes one unary wire operation: decode envelope → protocol check →
/// kernel dispatch (via mobile-ffi) → validated response envelope.
///
/// Returns `Err(JniError)` only for transport-level failures (unparseable
/// body, unknown handle, oversized request). Every protocol, kernel and
/// product error comes back as `Ok` response-envelope bytes — byte-identical
/// to `neotavern-tauri-local`'s `dispatch_envelope` for the same request
/// envelope.
pub fn jni_call(handle: i64, request_envelope: &[u8]) -> Result<Vec<u8>, JniError> {
    if request_envelope.len() > MAX_REQUEST_LEN {
        return Err(JniError::invalid_arg(format!(
            "request envelope exceeds MAX_REQUEST_LEN ({MAX_REQUEST_LEN} bytes)"
        )));
    }
    let kernel = kernel_ptr(handle)?;
    let env = envelope::decode_request_envelope(request_envelope)
        .map_err(JniError::from_envelope_failure)?;
    let request_id = env.request_id.clone();
    if !matches!(envelope::check_protocol(&env), ProtocolVerdict::Compatible) {
        return Ok(protocol_mismatch_envelope(&request_id, &env));
    }
    let payload = envelope::operation_payload_bytes(&env)
        .map_err(|_| JniError::internal("operation payload serialization failed"))?;
    match ffi_call(kernel, &env.operation_id, &payload) {
        Ok(result_bytes) => {
            match serde_json::from_slice::<serde_json::Value>(&result_bytes) {
                Ok(result) => Ok(envelope_or_fallback(envelope::build_ok_response(
                    &request_id,
                    result,
                ))),
                // The kernel's result bytes are its own DTO serialization; a
                // parse failure is an internal bug, never a payload issue.
                Err(_) => Ok(envelope_or_fallback(envelope::build_error_response(
                    &request_id,
                    "INTERNAL",
                    vec![("rule".to_string(), "result_json_parse_failed".to_string())],
                ))),
            }
        }
        Err((status, body)) => {
            let err = kernel_error_from_ffi(status, &body);
            Ok(envelope::kernel_error_envelope(&err, &request_id))
        }
    }
}

/// Opens a durable generation stream for a streamable operation.
///
/// ABI-level failures (unknown handle, oversized request, unparseable
/// envelope) return `Err(JniError)` and throw `KernelException` from JNI.
/// Protocol mismatches, non-streamable operations and kernel/product-class
/// dispatch failures return `Ok` with a *virtual error stream* handle whose
/// first [`jni_stream_wait`] yields `{"kind":"error","error":<error
/// response envelope>}` — the exact envelope the desktop transport answers
/// for the same request (stream-open product errors are resolve()-class, not
/// transport failures, in the WebView bridge contract).
pub fn jni_stream_start(handle: i64, request_envelope: &[u8]) -> Result<i64, JniError> {
    if request_envelope.len() > MAX_REQUEST_LEN {
        return Err(JniError::invalid_arg(format!(
            "request envelope exceeds MAX_REQUEST_LEN ({MAX_REQUEST_LEN} bytes)"
        )));
    }
    let kernel = kernel_ptr(handle)?;
    let env = envelope::decode_request_envelope(request_envelope)
        .map_err(JniError::from_envelope_failure)?;
    let request_id = env.request_id.clone();
    if !matches!(envelope::check_protocol(&env), ProtocolVerdict::Compatible) {
        return register_error_stream(protocol_mismatch_envelope(&request_id, &env));
    }
    if envelope::operation_event_schema_id(&env.operation_id).is_none() {
        let envelope_bytes = envelope_or_fallback(envelope::build_error_response(
            &request_id,
            "CONTRACT_VIOLATION",
            vec![
                ("rule".to_string(), "operation_not_streamable".to_string()),
                ("operationId".to_string(), env.operation_id.clone()),
            ],
        ));
        return register_error_stream(envelope_bytes);
    }
    let payload = envelope::operation_payload_bytes(&env)
        .map_err(|_| JniError::internal("operation payload serialization failed"))?;
    let op = CString::new(env.operation_id.as_str())
        .map_err(|_| JniError::invalid_arg("operation id contains a NUL byte"))?;
    let mut stream: *mut NtStream = std::ptr::null_mut();
    // 512 bytes is far beyond the 36-byte run id; the buffer makes
    // NT_ERR_BUFFER unreachable on the success path (a live stream must never
    // be abandoned because its id could not be copied).
    let mut run_id = vec![0u8; 512];
    let mut run_id_len = 0usize;
    let status = neotavern_mobile_ffi::nt_stream_start(
        kernel,
        op.as_ptr(),
        payload.as_ptr(),
        payload.len(),
        &mut stream,
        run_id.as_mut_ptr(),
        run_id.len(),
        &mut run_id_len,
    );
    if status != NT_OK {
        if !stream.is_null() {
            // mobile-ffi may have created the stream before reporting a
            // buffer shortfall; never leak it.
            neotavern_mobile_ffi::nt_stream_free(stream);
        }
        let body = run_id[..run_id_len.min(run_id.len())].to_vec();
        // Kernel/product-class dispatch failures become virtual error streams
        // (exact desktop parity); INVALID_ARG/BUFFER are ABI-level and throw.
        let is_dispatch_status = matches!(
            status,
            NT_ERR_CONTRACT
                | NT_ERR_NOT_FOUND
                | NT_ERR_CANCELLED
                | NT_ERR_STORAGE
                | NT_ERR_MISMATCH
                | NT_ERR_INTERNAL
        );
        if is_dispatch_status {
            let err = kernel_error_from_ffi(status, &body);
            return register_error_stream(envelope::kernel_error_envelope(&err, &request_id));
        }
        return Err(JniError::from_status(status, "nt_stream_start failed"));
    }
    let workflow_id = String::from_utf8_lossy(&run_id[..run_id_len.min(run_id.len())]).into_owned();
    let stream_handle = stream as i64;
    STREAMS
        .lock()
        .map_err(|_| JniError::internal("stream registry poisoned"))?
        .insert(
            stream_handle,
            StreamState::Live(LiveStream {
                stream: StreamHandle(stream),
                kernel: handle,
                workflow_id,
                request_id,
                last_sequence: -1,
                pending: VecDeque::new(),
                terminal_pending: false,
                terminal_done: false,
            }),
        );
    Ok(stream_handle)
}

/// Waits up to `timeout_ms` for the next stream payload:
///
/// - `Ok(None)` — no payload within the timeout (the host keeps polling);
///   after the stream ended, `None` forever.
/// - `Ok(Some(bytes))` — one framing payload:
///   `{"kind":"event","event":<wire.event.envelope>}` (one event per call, in
///   sequence order), `{"kind":"terminal"}` (exactly once, after the terminal
///   event), or `{"kind":"error","error":<wire.response.error.envelope>}`
///   (once, for virtual error streams and durable-log failures).
/// - `Err(JniError)` — transport/ABI-level failure (unknown handle, kernel
///   closed, internal invariant break).
///
/// Committed events are replayed through the durable `generation.events`
/// log — the durable log is the canonical source (ТЗ §64), mirroring the
/// Tauri transport's poller.
pub fn jni_stream_wait(stream: i64, timeout_ms: u32) -> Result<Option<Vec<u8>>, JniError> {
    let mut streams = STREAMS
        .lock()
        .map_err(|_| JniError::internal("stream registry poisoned"))?;
    let state = streams
        .get_mut(&stream)
        .ok_or_else(|| JniError::invalid_arg(format!("unknown stream handle {stream:#x}")))?;
    match state {
        StreamState::Error {
            envelope,
            delivered,
        } => {
            if *delivered {
                return Ok(None);
            }
            *delivered = true;
            Ok(Some(error_framing(envelope)?))
        }
        StreamState::Live(live) => {
            if live.terminal_done {
                return Ok(None);
            }
            if live.terminal_pending {
                live.terminal_pending = false;
                live.terminal_done = true;
                return Ok(Some(TERMINAL_FRAMING.to_vec()));
            }
            // Deliver buffered events first: one notice can cover a whole
            // ≤200-event page, and `next_notice` goes quiet once the run
            // ends — the page's remaining events must not be stranded.
            if let Some(event) = live.pending.pop_front() {
                return deliver_event(live, event).map(Some);
            }
            let mut sequence = -2i64;
            let status =
                neotavern_mobile_ffi::nt_stream_wait(live.stream.0, timeout_ms, &mut sequence);
            if status != NT_OK {
                return Err(JniError::from_status(status, "nt_stream_wait failed"));
            }
            if sequence < 0 {
                return Ok(None);
            }
            let kernel = kernel_ptr(live.kernel)?;
            let request = RequestListGenerationEvents {
                workflow_id: live.workflow_id.clone(),
                after_sequence: Some(live.last_sequence),
                limit: Some(STREAM_PAGE_LIMIT),
            };
            let payload = serde_json::to_vec(&request).map_err(|_| {
                JniError::internal("generation.events request serialization failed")
            })?;
            match ffi_call(kernel, "generation.events", &payload) {
                Ok(result_bytes) => {
                    let paged: PagedGenerationEvents = serde_json::from_slice(&result_bytes)
                        .map_err(|_| {
                            JniError::internal("generation.events result failed to decode")
                        })?;
                    let fresh: Vec<EventEnvelope> = paged
                        .items
                        .into_iter()
                        .filter(|event| event.sequence > live.last_sequence)
                        .collect();
                    let Some(first) = fresh.first().cloned() else {
                        // Notice fired but nothing new is committed yet
                        // (writer race); surface a quiet no-data so the host
                        // polls again.
                        return Ok(None);
                    };
                    live.pending.extend(fresh.into_iter().skip(1));
                    deliver_event(live, first).map(Some)
                }
                Err((status, body)) => {
                    // The durable log is unreachable for this stream: deliver
                    // the error envelope the desktop transport would answer,
                    // once, then end the stream.
                    let err = kernel_error_from_ffi(status, &body);
                    let envelope_bytes = envelope::kernel_error_envelope(&err, &live.request_id);
                    live.terminal_done = true;
                    Ok(Some(error_framing(&envelope_bytes)?))
                }
            }
        }
    }
}

/// Requests cancellation of the run behind `stream` (the mobile-ffi contract:
/// executor flag plus the durable `generation.cancel` operation).
pub fn jni_stream_cancel(kernel: i64, stream: i64) -> Result<(), JniError> {
    let kernel = kernel_ptr(kernel)?;
    let streams = STREAMS
        .lock()
        .map_err(|_| JniError::internal("stream registry poisoned"))?;
    let StreamState::Live(live) = streams
        .get(&stream)
        .ok_or_else(|| JniError::invalid_arg(format!("unknown stream handle {stream:#x}")))?
    else {
        // A virtual error stream has no run to cancel.
        return Err(JniError::invalid_arg(format!(
            "stream handle {stream:#x} is not a live stream"
        )));
    };
    let status = neotavern_mobile_ffi::nt_stream_cancel(kernel, live.stream.0);
    if status != NT_OK {
        return Err(JniError::from_status(status, "nt_stream_cancel failed"));
    }
    Ok(())
}

/// Frees a stream handle (live or virtual). Idempotent: unknown handles are a
/// no-op.
pub fn jni_stream_free(stream: i64) {
    let removed = STREAMS
        .lock()
        .ok()
        .and_then(|mut streams| streams.remove(&stream));
    if let Some(StreamState::Live(live)) = removed {
        neotavern_mobile_ffi::nt_stream_free(live.stream.0);
    }
}

/// Advances a live stream past one committed event and frames it for the
/// host. Sets `terminal_pending` when the event terminates the run.
fn deliver_event(live: &mut LiveStream, event: EventEnvelope) -> Result<Vec<u8>, JniError> {
    let is_terminal = STREAM_TERMINAL_TYPES.contains(&event.r#type.as_str());
    let event_value = serde_json::to_value(&event)
        .map_err(|_| JniError::internal("event envelope serialization failed"))?;
    live.last_sequence = event.sequence;
    if is_terminal {
        live.terminal_pending = true;
    }
    serde_json::to_vec(&serde_json::json!({ "kind": "event", "event": event_value }))
        .map_err(|_| JniError::internal("event framing serialization failed"))
}

/// Registers a virtual error stream and returns its handle.
fn register_error_stream(envelope_bytes: Vec<u8>) -> Result<i64, JniError> {
    let handle = NEXT_ERROR_STREAM_HANDLE.fetch_sub(1, Ordering::Relaxed);
    STREAMS
        .lock()
        .map_err(|_| JniError::internal("stream registry poisoned"))?
        .insert(
            handle,
            StreamState::Error {
                envelope: envelope_bytes,
                delivered: false,
            },
        );
    Ok(handle)
}

/// Wraps a serialized error response envelope in the frozen WebView bridge
/// framing: `{"kind":"error","error":<envelope>}`.
fn error_framing(envelope_bytes: &[u8]) -> Result<Vec<u8>, JniError> {
    let envelope_value: serde_json::Value = serde_json::from_slice(envelope_bytes)
        .map_err(|_| JniError::internal("error envelope is not valid JSON"))?;
    serde_json::to_vec(&serde_json::json!({ "kind": "error", "error": envelope_value }))
        .map_err(|_| JniError::internal("error framing serialization failed"))
}

// ---------------------------------------------------------------------------
// JNI surface (KernelBridge method table — see README)
// ---------------------------------------------------------------------------

const KERNEL_EXCEPTION_CLASS: &str = "com/neotavern/mobile/KernelException";
const KERNEL_EXCEPTION_CTOR: &str = "(ILjava/lang/String;)V";

/// Throws a `com.neotavern.mobile.KernelException` carrying the stable NT
/// error code and message (frozen contract: `(int code, String message)`
/// constructor). Falls back to a plain `RuntimeException` only when the
/// KernelException class or its constructor cannot be resolved — a packaging
/// bug, never a payload issue.
fn throw_kernel_exception(env: &mut JNIEnv, error: &JniError) {
    let class = match env.find_class(KERNEL_EXCEPTION_CLASS) {
        Ok(class) => class,
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/RuntimeException",
                format!("{}: {}", error.code as i32, error.message),
            );
            return;
        }
    };
    let message = match env.new_string(&error.message) {
        Ok(message) => message,
        Err(_) => return,
    };
    let object = match env.new_object(
        class,
        KERNEL_EXCEPTION_CTOR,
        &[JValue::Int(error.code as i32), JValue::Object(&message)],
    ) {
        Ok(object) => object,
        Err(_) => {
            let _ = env.throw_new("java/lang/RuntimeException", error.message.clone());
            return;
        }
    };
    let _ = env.throw(JThrowable::from(object));
}

/// Runs a JNI body, converting any panic into a thrown KernelException.
/// Returns `default` on failure so the native method never returns garbage.
fn jni_guarded<T>(
    env: &mut JNIEnv,
    default: T,
    body: impl FnOnce(&mut JNIEnv) -> Result<T, JniError>,
) -> T {
    match catch_unwind(AssertUnwindSafe(|| body(env))) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            throw_kernel_exception(env, &error);
            default
        }
        Err(panic) => {
            throw_kernel_exception(
                env,
                &JniError::internal(format!("panic contained at the JNI boundary: {panic:?}")),
            );
            default
        }
    }
}

/// Reads a byte[] request with full bounds checking: length validated against
/// `MAX_REQUEST_LEN` before any allocation.
fn read_request_bytes(
    env: &mut JNIEnv,
    name: &str,
    array: &JByteArray,
) -> Result<Vec<u8>, JniError> {
    if array.is_null() {
        return Err(JniError::invalid_arg(format!(
            "{name}: request array is null"
        )));
    }
    let len = env
        .get_array_length(array)
        .map_err(|err| JniError::invalid_arg(format!("{name}: cannot read array length: {err}")))?;
    if len < 0 || len as usize > MAX_REQUEST_LEN {
        return Err(JniError::invalid_arg(format!(
            "{name}: request length {len} exceeds MAX_REQUEST_LEN ({MAX_REQUEST_LEN} bytes)"
        )));
    }
    let mut buf = vec![0i8; len as usize];
    env.get_byte_array_region(array, 0, &mut buf)
        .map_err(|err| {
            JniError::invalid_arg(format!("{name}: cannot read request bytes: {err}"))
        })?;
    // SAFETY: jbyte (i8) and u8 share the same layout; the buffer is owned
    // and read-only afterwards.
    Ok(unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), buf.len()) }.to_vec())
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_KernelBridge_nativeHandshake(
    env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let json = jni_handshake();
        env.new_string(&json).map(JString::into_raw)
    }));
    match result {
        Ok(Ok(raw)) => raw,
        Ok(Err(_)) | Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_KernelBridge_nativeOpen(
    mut env: JNIEnv,
    _class: JClass,
    data_root: JString,
) -> jlong {
    jni_guarded(&mut env, 0, |env| {
        let data_root = if data_root.is_null() {
            String::new()
        } else {
            let java_str = env.get_string(&data_root).map_err(|err| {
                JniError::invalid_arg(format!("nativeOpen: cannot read dataRoot: {err}"))
            })?;
            std::borrow::Cow::from(&java_str).into_owned()
        };
        jni_open(&data_root)
    })
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_KernelBridge_nativeClose(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    let result = catch_unwind(AssertUnwindSafe(|| jni_close(handle)));
    if let Err(panic) = result {
        throw_kernel_exception(
            &mut env,
            &JniError::internal(format!("panic contained at the JNI boundary: {panic:?}")),
        );
    }
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_KernelBridge_nativeCall(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    request: JByteArray,
) -> jbyteArray {
    jni_guarded(&mut env, std::ptr::null_mut(), |env| {
        let request = read_request_bytes(env, "nativeCall", &request)?;
        let response = jni_call(handle, &request)?;
        env.byte_array_from_slice(&response)
            .map(JByteArray::into_raw)
            .map_err(|err| {
                JniError::internal(format!("nativeCall: cannot allocate response array: {err}"))
            })
    })
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_KernelBridge_nativeStreamStart(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    request: JByteArray,
) -> jlong {
    jni_guarded(&mut env, 0, |env| {
        let request = read_request_bytes(env, "nativeStreamStart", &request)?;
        jni_stream_start(handle, &request)
    })
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_KernelBridge_nativeStreamWait(
    mut env: JNIEnv,
    _class: JClass,
    stream: jlong,
    timeout_ms: jint,
) -> jbyteArray {
    jni_guarded(&mut env, std::ptr::null_mut(), |env| {
        let timeout_ms = timeout_ms.max(0) as u32;
        match jni_stream_wait(stream, timeout_ms)? {
            Some(payload) => env
                .byte_array_from_slice(&payload)
                .map(JByteArray::into_raw)
                .map_err(|err| {
                    JniError::internal(format!(
                        "nativeStreamWait: cannot allocate payload array: {err}"
                    ))
                }),
            None => Ok(std::ptr::null_mut()),
        }
    })
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_KernelBridge_nativeStreamCancel(
    mut env: JNIEnv,
    _class: JClass,
    kernel: jlong,
    stream: jlong,
) {
    let result = catch_unwind(AssertUnwindSafe(|| jni_stream_cancel(kernel, stream)));
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => throw_kernel_exception(&mut env, &error),
        Err(panic) => throw_kernel_exception(
            &mut env,
            &JniError::internal(format!("panic contained at the JNI boundary: {panic:?}")),
        ),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_KernelBridge_nativeStreamFree(
    mut env: JNIEnv,
    _class: JClass,
    stream: jlong,
) {
    let result = catch_unwind(AssertUnwindSafe(|| jni_stream_free(stream)));
    if let Err(panic) = result {
        throw_kernel_exception(
            &mut env,
            &JniError::internal(format!("panic contained at the JNI boundary: {panic:?}")),
        );
    }
}

// ---------------------------------------------------------------------------
// Host-runnable tests (no JVM): the core functions exercise the full
// mobile-ffi boundary and the byte-identical envelope contract with the
// Tauri transport.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use contracts_generated::generated::decode_response_envelope;
    use serde_json::{json, Value};
    use std::time::Duration;

    const REQUEST_ID: &str = "00000000-0000-4000-8000-000000000001";

    /// Builds a wire request envelope JSON for the embedded protocol version
    /// (mirrors the CLI/tauri-local construction, §6.3).
    fn request_envelope(operation_id: &str, payload: Value) -> Vec<u8> {
        let (major, minor) = contracts_generated::wire_protocol();
        serde_json::to_vec(&json!({
            "wireProtocol": { "major": major, "minor": minor },
            "schemaHash": contracts_generated::contract_schema_hash(),
            "requestId": REQUEST_ID,
            "operationId": operation_id,
            "payload": payload,
        }))
        .expect("request envelope serializes")
    }

    /// Decodes a response envelope, returning `(request_id, value)` for
    /// shape assertions.
    fn decode_envelope(bytes: &[u8]) -> (String, Value) {
        match decode_response_envelope(bytes).expect("valid response envelope") {
            contracts_generated::generated::ResponseEnvelope::Ok { request_id, result } => {
                (request_id, result)
            }
            contracts_generated::generated::ResponseEnvelope::Error { request_id, error } => {
                (request_id, json!({ "error": error }))
            }
        }
    }

    #[test]
    fn handshake_reports_abi_and_schema() {
        let handshake: Value = serde_json::from_str(&jni_handshake()).expect("handshake json");
        assert_eq!(
            handshake["ffiAbiVersion"],
            json!(neotavern_mobile_ffi::FFI_ABI_VERSION),
            "ffiAbiVersion must equal the mobile-ffi ABI version"
        );
        assert_eq!(
            handshake["schemaHash"],
            json!(contracts_generated::contract_schema_hash()),
            "schemaHash must equal the embedded contract manifest hash"
        );
        let (major, minor) = contracts_generated::wire_protocol();
        assert_eq!(
            handshake["wireProtocol"],
            json!({ "major": major, "minor": minor })
        );
        assert_eq!(handshake["appVersion"], json!(APP_VERSION));
    }

    #[test]
    fn open_meta_get_round_trip_and_idempotent_close() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("data");
        let handle = jni_open(root.to_str().expect("utf8 root")).expect("open over ffi");

        let response = jni_call(handle, &request_envelope("meta.get", json!({})))
            .expect("meta.get must answer an envelope");
        let (request_id, result) = decode_envelope(&response);
        assert_eq!(request_id, REQUEST_ID, "requestId must be echoed");
        assert_eq!(
            result["appVersion"],
            json!(APP_VERSION),
            "meta result appVersion"
        );
        assert_eq!(
            result["productWire"]["major"],
            json!(1),
            "meta result productWire"
        );
        assert!(result.get("api").is_some(), "meta result must carry api");

        jni_close(handle);
        jni_close(handle); // idempotent
        jni_close(0x1234); // unknown handle is a no-op
    }

    #[test]
    fn unknown_operation_returns_not_found_envelope() {
        let handle = jni_open("").expect("stateless open");
        let response = jni_call(handle, &request_envelope("nope.nope", json!({})))
            .expect("unknown operation must answer an envelope, not fail the transport");
        let (request_id, body) = decode_envelope(&response);
        assert_eq!(request_id, REQUEST_ID);
        assert_eq!(body["error"]["code"], json!("NOT_FOUND"));
        jni_close(handle);
    }

    #[test]
    fn contract_violation_returns_error_envelope_not_panic() {
        let handle = jni_open("").expect("stateless open");
        // meta.get declares a strict empty payload; an extra field is a
        // contract violation (mirrors the mobile-ffi test).
        let response = jni_call(handle, &request_envelope("meta.get", json!({ "extra": 1 })))
            .expect("contract violation must answer an envelope, never panic");
        let (request_id, body) = decode_envelope(&response);
        assert_eq!(request_id, REQUEST_ID);
        assert_eq!(body["error"]["code"], json!("CONTRACT_VIOLATION"));
        jni_close(handle);
    }

    #[test]
    fn oversized_request_is_invalid_arg() {
        let handle = jni_open("").expect("stateless open");
        let err = jni_call(handle, &vec![0u8; MAX_REQUEST_LEN + 1])
            .expect_err("oversized request must be a controlled JniError");
        assert_eq!(err.code, JniErrorCode::InvalidArg);
        jni_close(handle);
    }

    #[test]
    fn garbage_envelope_is_a_transport_error() {
        let handle = jni_open("").expect("stateless open");
        let err =
            jni_call(handle, b"{not json").expect_err("garbage body must not produce an envelope");
        assert_eq!(err.code, JniErrorCode::Contract);
        jni_close(handle);
    }

    #[test]
    fn response_envelopes_are_byte_identical_to_tauri_local() {
        use neotavern_tauri_local::{KernelHost, KernelHostConfig};

        let host = KernelHost::open(KernelHostConfig { data_root: None })
            .expect("stateless kernel host must open");
        let jni_kernel = jni_open("").expect("stateless jni kernel");

        let mut requests: Vec<(&str, Vec<u8>)> = vec![
            ("meta.get ok", request_envelope("meta.get", json!({}))),
            (
                "unknown operation",
                request_envelope("nope.nope", json!({})),
            ),
            (
                "contract violation",
                request_envelope("meta.get", json!({ "extra": 1 })),
            ),
        ];
        // Protocol mismatch (client major one ahead of the embedded manifest).
        let mut mismatched = request_envelope("meta.get", json!({}));
        let (server_major, _) = contracts_generated::wire_protocol();
        mismatched = {
            let mut value: Value = serde_json::from_slice(&mismatched).expect("envelope json");
            value["wireProtocol"]["major"] = json!(server_major + 1);
            serde_json::to_vec(&value).expect("envelope serializes")
        };
        requests.push(("protocol mismatch", mismatched));

        for (name, request) in &requests {
            let tauri_bytes = host
                .dispatch_envelope(request)
                .expect("tauri dispatch must answer an envelope");
            let jni_bytes =
                jni_call(jni_kernel, request).expect("jni call must answer an envelope");
            assert_eq!(
                jni_bytes, tauri_bytes,
                "response envelope bytes must be identical to tauri-local for {name}"
            );
        }
        jni_close(jni_kernel);
    }

    /// Opens a kernel over a fresh data root with one durable chat (mirrors
    /// the mobile-ffi stream test: create a character, close the kernel,
    /// seed the chat row directly, reopen).
    fn seeded_kernel(temp: &tempfile::TempDir) -> i64 {
        let root = temp.path().join("data");
        let root_str = root.to_str().expect("utf8 root");
        let first = jni_open(root_str).expect("open");
        let created = jni_call(
            first,
            &request_envelope("characters.create", json!({ "name": "Ffi Char" })),
        )
        .expect("characters.create over ffi");
        let (_, body) = decode_envelope(&created);
        let id = body["id"]
            .as_str()
            .expect("created character id")
            .to_string();
        jni_close(first);
        {
            let mut db = neotavern_storage::open::open(
                root.as_path(),
                &neotavern_storage::baseline::ConnectionPolicy::default(),
                &mut |_| {},
            )
            .expect("direct open after kernel close");
            db.transaction(|tx| {
                tx.execute(
                    "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
                     VALUES ('99999999-9999-4999-8999-999999999999', 'ffi chat', ?1, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                    rusqlite::params![id],
                )
                .map_err(|e| neotavern_storage::StorageError::from_sqlite(e, "seed chat"))
            })
            .expect("seed chat");
        }
        jni_open(root_str).expect("reopen")
    }

    /// Polls a stream until terminal framing; returns every committed event
    /// (as parsed JSON) in delivery order.
    fn drain_stream(stream: i64, timeout_ms: u32) -> (Vec<Value>, bool) {
        let mut events = Vec::new();
        let mut terminal = false;
        for _ in 0..600 {
            let Some(payload) = jni_stream_wait(stream, timeout_ms).expect("stream wait ok") else {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            };
            let payload: Value = serde_json::from_slice(&payload).expect("framing json");
            match payload["kind"].as_str() {
                Some("event") => {
                    let event = payload["event"].clone();
                    assert!(
                        contracts_generated::generated::validate_event_envelope(&event).is_ok(),
                        "delivered event must validate against the generated checker"
                    );
                    events.push(event);
                }
                Some("terminal") => {
                    terminal = true;
                    break;
                }
                Some("error") => panic!("stream error framing: {payload}"),
                other => panic!("unexpected framing kind {other:?}: {payload}"),
            }
        }
        (events, terminal)
    }

    #[test]
    fn generation_stream_events_until_terminal() {
        let temp = tempfile::tempdir().expect("tempdir");
        let handle = seeded_kernel(&temp);

        let request = request_envelope(
            "generation.start",
            json!({
                "chatId": "99999999-9999-4999-8999-999999999999",
                "message": "hello",
            }),
        );
        let stream = jni_stream_start(handle, &request)
            .expect("generation.start must return a stream handle");

        let (events, terminal) = drain_stream(stream, 100);
        assert!(terminal, "stream must reach terminal framing");
        assert!(!events.is_empty(), "at least one committed event");
        let sequences: Vec<i64> = events
            .iter()
            .map(|event| event["sequence"].as_i64().expect("event sequence"))
            .collect();
        assert!(
            sequences.windows(2).all(|window| window[0] < window[1]),
            "event sequences must be strictly increasing: {sequences:?}"
        );
        let last_type = events.last().expect("last event")["type"]
            .as_str()
            .expect("event type");
        assert!(
            STREAM_TERMINAL_TYPES.contains(&last_type),
            "last event must be terminal, got {last_type}"
        );

        // After terminal framing every wait is a quiet None.
        assert_eq!(
            jni_stream_wait(stream, 0).expect("post-terminal wait"),
            None,
            "stream must be exhausted after terminal"
        );

        jni_stream_free(stream);
        jni_stream_free(stream); // double free is a no-op
        jni_close(handle);
        jni_close(handle);
    }

    #[test]
    fn stream_cancel_requests_and_terminates() {
        let temp = tempfile::tempdir().expect("tempdir");
        let handle = seeded_kernel(&temp);

        let request = request_envelope(
            "generation.start",
            json!({
                "chatId": "99999999-9999-4999-8999-999999999999",
                "message": "hello",
                // A slow deterministic fake model (8 steps × 50 ms) keeps the
                // run live long enough for the cancel dispatch to land.
                // Grammar is `;`-separated key=value pairs (fake provider).
                "provider": "fake",
                "model": "steps=8;delay-ms=50",
            }),
        );
        let stream = jni_stream_start(handle, &request)
            .expect("generation.start must return a stream handle");

        // nt_stream_cancel sets the executor flag BEFORE dispatching the
        // durable generation.cancel op; the dispatch runs on the kernel's
        // single writer thread, which is busy executing this very run, so it
        // is processed only after the run ends and answers a state-conflict
        // error. Cancellation itself is therefore effective regardless of the
        // returned status — assert the flag effect, not the dispatch result.
        let _ = jni_stream_cancel(handle, stream);
        let (events, terminal) = drain_stream(stream, 100);
        assert!(terminal, "cancelled stream must reach terminal framing");
        assert!(!events.is_empty(), "cancelled stream still emits its log");
        let terminal_type = events.last().expect("last event")["type"]
            .as_str()
            .expect("event type");
        assert_eq!(
            terminal_type, "generation.cancelled",
            "a cancel that lands mid-run must terminate as generation.cancelled"
        );

        jni_stream_free(stream);
        jni_close(handle);
    }

    #[test]
    fn stream_start_non_streamable_is_an_error_stream() {
        let handle = jni_open("").expect("stateless open");

        // Non-streamable operation: virtual error stream with the exact
        // envelope the desktop transport answers.
        let stream = jni_stream_start(handle, &request_envelope("characters.list", json!({})))
            .expect("non-streamable op must return a (virtual) handle");
        let payload = jni_stream_wait(stream, 100)
            .expect("wait ok")
            .expect("error stream must deliver the framing immediately");
        let payload: Value = serde_json::from_slice(&payload).expect("framing json");
        assert_eq!(payload["kind"], json!("error"));
        let (request_id, body) = decode_envelope(
            serde_json::to_vec(&payload["error"])
                .expect("envelope bytes")
                .as_slice(),
        );
        assert_eq!(request_id, REQUEST_ID);
        assert_eq!(body["error"]["code"], json!("CONTRACT_VIOLATION"));
        assert_eq!(
            body["error"]["params"]["rule"],
            json!("operation_not_streamable")
        );
        assert_eq!(
            jni_stream_wait(stream, 0).expect("wait after error"),
            None,
            "error stream is exhausted after one delivery"
        );
        jni_stream_free(stream);

        // Protocol mismatch: same virtual-error-stream treatment.
        let mut mismatched = request_envelope("generation.start", json!({}));
        let (_, server_minor) = contracts_generated::wire_protocol();
        mismatched = {
            let mut value: Value = serde_json::from_slice(&mismatched).expect("envelope json");
            value["wireProtocol"]["minor"] = json!(server_minor + 1);
            serde_json::to_vec(&value).expect("envelope serializes")
        };
        let stream = jni_stream_start(handle, &mismatched)
            .expect("protocol mismatch must return a (virtual) handle");
        let payload = jni_stream_wait(stream, 100)
            .expect("wait ok")
            .expect("mismatch stream must deliver the framing immediately");
        let payload: Value = serde_json::from_slice(&payload).expect("framing json");
        assert_eq!(payload["kind"], json!("error"));
        let (request_id, body) = decode_envelope(
            serde_json::to_vec(&payload["error"])
                .expect("envelope bytes")
                .as_slice(),
        );
        assert_eq!(request_id, REQUEST_ID);
        assert_eq!(body["error"]["code"], json!("PROTOCOL_MISMATCH"));
        jni_stream_free(stream);
        jni_close(handle);
    }

    #[test]
    fn unknown_handles_are_controlled() {
        let handle = jni_open("").expect("stateless open");
        assert_eq!(
            jni_call(0x1234, &request_envelope("meta.get", json!({})))
                .expect_err("unknown kernel handle")
                .code,
            JniErrorCode::InvalidArg
        );
        assert_eq!(
            jni_stream_wait(0x5678, 1)
                .expect_err("unknown stream handle")
                .code,
            JniErrorCode::InvalidArg
        );
        assert_eq!(
            jni_stream_cancel(handle, 0x5678)
                .expect_err("unknown stream handle on cancel")
                .code,
            JniErrorCode::InvalidArg
        );
        // Cancelling a virtual error stream is also a controlled error.
        let error_stream =
            jni_stream_start(handle, &request_envelope("characters.list", json!({})))
                .expect("virtual error stream handle");
        assert_eq!(
            jni_stream_cancel(handle, error_stream)
                .expect_err("no run to cancel")
                .code,
            JniErrorCode::InvalidArg
        );
        jni_stream_free(error_stream);
        jni_stream_free(0x5678); // unknown free is a no-op
        jni_close(handle);
    }
}
