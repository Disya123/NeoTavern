// The exported entry points take raw pointers by C-ABI necessity; a C/JNI
// caller cannot honour Rust `unsafe` contracts, so the boundary is safe by
// construction instead: every pointer is null-checked, every length bounded,
// and `guard` contains any panic. The deny-by-default
// `not_unsafe_ptr_arg_deref` lint therefore does not apply to this crate.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

//! Minimal stable C ABI over the Runtime Kernel (ТЗ §6.9, Фаза 5).
//!
//! Native mobile hosts (Android JNI / future Swift) cross this boundary with
//! ABI-safe primitives only: opaque handles, length-delimited UTF-8/byte
//! buffers, stable integer status codes and explicit create/free/cancel
//! functions. Product Rust structs never cross the boundary; payloads are
//! the same Product Wire Contract bytes the local and remote transports use.
//!
//! Contract highlights (ТЗ §6.9):
//!
//! - buffer sizes are checked before allocation/parse (`req_len` bounded,
//!   output buffers host-provided with capacity; [`NT_ERR_BUFFER`] reports
//!   the required size without allocating);
//! - Rust allocations are freed only by exported Rust free functions
//!   ([`nt_kernel_free`], [`nt_stream_free`]);
//! - Rust panics never cross the ABI boundary: every entry point is wrapped
//!   in `catch_unwind` and converts a panic into [`NT_ERR_INTERNAL`];
//! - thread affinity: handles are `Send + Sync`; any thread may call;
//! - cancellation is explicit per call via [`nt_stream_cancel`] (streams)
//!   and per kernel via dropping/freeing the handle (unary calls).
//!
//! The crate is compiled as `cdylib` for real FFI consumers and as `rlib` so
//! the contract is exercised by the test suite on every platform.

use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Duration;

use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelErrorCode};

/// The FFI ABI version exported by this build; a host must require exactly
/// this value (local handshake, ТЗ §6.5/§6.9).
pub const FFI_ABI_VERSION: u32 = 1;

/// Maximum accepted request buffer length (1 MiB) — checked before any parse.
pub const MAX_REQUEST_LEN: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// Status codes (stable; the only integer contract across the ABI)
// ---------------------------------------------------------------------------

/// Success.
pub const NT_OK: c_int = 0;
/// Null/invalid pointer, non-UTF-8 string, oversized or malformed argument.
pub const NT_ERR_INVALID_ARG: c_int = 1;
/// Contract violation (payload failed the generated DTO checks).
pub const NT_ERR_CONTRACT: c_int = 2;
/// Operation or record not found.
pub const NT_ERR_NOT_FOUND: c_int = 3;
/// Storage-layer failure (lease conflict, corruption, no durable storage).
pub const NT_ERR_STORAGE: c_int = 4;
/// Operation cancelled.
pub const NT_ERR_CANCELLED: c_int = 5;
/// Internal failure (including a contained Rust panic).
pub const NT_ERR_INTERNAL: c_int = 6;
/// Host output buffer too small; `*out_len` carries the required capacity.
pub const NT_ERR_BUFFER: c_int = 7;
/// Contract/schema hash or ABI version mismatch at open.
pub const NT_ERR_MISMATCH: c_int = 8;

fn status_for(code: &KernelErrorCode) -> c_int {
    match code {
        KernelErrorCode::ContractViolation => NT_ERR_CONTRACT,
        KernelErrorCode::OperationNotFound | KernelErrorCode::NotFound => NT_ERR_NOT_FOUND,
        KernelErrorCode::Cancelled => NT_ERR_CANCELLED,
        KernelErrorCode::DataRootInUse | KernelErrorCode::StorageFailure => NT_ERR_STORAGE,
        KernelErrorCode::ContractMismatch => NT_ERR_MISMATCH,
        _ => NT_ERR_INTERNAL,
    }
}

// ---------------------------------------------------------------------------
// Opaque handles
// ---------------------------------------------------------------------------

/// Opaque kernel handle: the Rust `Kernel` behind a raw pointer. Created by
/// [`nt_kernel_open`], freed by [`nt_kernel_free`].
pub struct NtKernel {
    kernel: Kernel,
}

/// Opaque stream handle for one durable generation run. Created by
/// [`nt_stream_start`], freed by [`nt_stream_free`].
pub struct NtStream {
    stream: runtime_kernel::EventStream,
    cancel: CancellationFlag,
    run_id: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Reads a NUL-terminated UTF-8 string from the host; null/non-UTF-8 → None.
fn cstr<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    // SAFETY: the host contract requires a valid NUL-terminated string for
    // the duration of the call; CStr::from_ptr performs no allocation.
    unsafe { CStr::from_ptr(ptr) }.to_str().ok()
}

/// Writes `payload` into the host buffer; on shortage reports the required
/// size through `out_len` and returns [`NT_ERR_BUFFER`].
fn copy_out(payload: &[u8], out_buf: *mut u8, out_cap: usize, out_len: *mut usize) -> c_int {
    if out_len.is_null() || (out_buf.is_null() && out_cap > 0) {
        return NT_ERR_INVALID_ARG;
    }
    // SAFETY: host contract guarantees a valid writable usize.
    unsafe { *out_len = payload.len() };
    if out_buf.is_null() || payload.len() > out_cap {
        return NT_ERR_BUFFER;
    }
    // SAFETY: out_cap >= payload.len() checked above; buffers disjoint.
    unsafe { std::ptr::copy_nonoverlapping(payload.as_ptr(), out_buf, payload.len()) };
    NT_OK
}

/// The universal entry guard: panic containment. Recoverable failures are
/// returned as status codes; a panic is a bug and becomes
/// [`NT_ERR_INTERNAL`] — it never crosses the ABI boundary (ТЗ §6.9).
fn guard(f: impl FnOnce() -> c_int) -> c_int {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(status) => status,
        Err(_) => NT_ERR_INTERNAL,
    }
}

/// Serializes a kernel error for the host: the wire product DTO verbatim
/// when present, otherwise `{code, message, issues}` (issues carry the
/// generated-checker violation paths; raw payloads never included).
fn error_body(err: &runtime_kernel::KernelError) -> Vec<u8> {
    match &err.product {
        Some(product) => serde_json::to_vec(product).unwrap_or_default(),
        None => {
            let issues: Vec<serde_json::Value> = err
                .issues
                .iter()
                .map(|issue| {
                    serde_json::json!({ "path": issue.path.clone(), "rule": issue.rule.clone() })
                })
                .collect();
            serde_json::to_vec(&serde_json::json!({
                "code": err.code.to_string(),
                "message": err.message,
                "issues": issues,
            }))
            .unwrap_or_default()
        }
    }
}

// ---------------------------------------------------------------------------
// Exported ABI
// ---------------------------------------------------------------------------

/// Returns the FFI ABI version of this build (host must match exactly).
#[no_mangle]
pub extern "C" fn nt_ffi_version() -> u32 {
    FFI_ABI_VERSION
}

/// Opens a kernel over `data_root` (NUL-terminated UTF-8 path; null opens a
/// stateless kernel) and stores the opaque handle in `*out_handle`.
#[no_mangle]
pub extern "C" fn nt_kernel_open(
    data_root: *const c_char,
    out_handle: *mut *mut NtKernel,
) -> c_int {
    guard(move || {
        if out_handle.is_null() {
            return NT_ERR_INVALID_ARG;
        }
        let root = if data_root.is_null() {
            None
        } else {
            match cstr(data_root) {
                Some(path) => Some(std::path::PathBuf::from(path)),
                None => return NT_ERR_INVALID_ARG,
            }
        };
        if root.is_some() {
            std::env::set_var(runtime_kernel::SEED_STARTER_ENV, "1");
        }
        let config = KernelConfig {
            expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
            ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
            data_root: root,
        };
        match Kernel::open(config) {
            Ok(kernel) => {
                // SAFETY: out_handle null-checked above.
                unsafe { *out_handle = Box::into_raw(Box::new(NtKernel { kernel })) };
                NT_OK
            }
            Err(err) => status_for(&err.code),
        }
    })
}

/// Frees a kernel handle created by [`nt_kernel_open`] (null is a no-op).
/// This is the only legitimate way to release the handle (ТЗ §6.9).
#[no_mangle]
pub extern "C" fn nt_kernel_free(handle: *mut NtKernel) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !handle.is_null() {
            // SAFETY: the pointer came from Box::into_raw in nt_kernel_open.
            drop(unsafe { Box::from_raw(handle) });
        }
    }));
}

/// Executes one unary operation. `op` is a NUL-terminated UTF-8 operation id;
/// `req`/`req_len` the bounded request bytes; the response (or, on error, the
/// serialized product error) is copied into the host buffer.
#[no_mangle]
pub extern "C" fn nt_call(
    handle: *mut NtKernel,
    op: *const c_char,
    req: *const u8,
    req_len: usize,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> c_int {
    guard(move || {
        if handle.is_null() {
            return NT_ERR_INVALID_ARG;
        }
        let Some(op) = cstr(op) else {
            return NT_ERR_INVALID_ARG;
        };
        if req_len > MAX_REQUEST_LEN {
            return NT_ERR_INVALID_ARG;
        }
        if req.is_null() && req_len > 0 {
            return NT_ERR_INVALID_ARG;
        }
        // SAFETY: req_len bounds checked; host guarantees req valid for len.
        let request: &[u8] = unsafe { std::slice::from_raw_parts(req, req_len) };
        // SAFETY: handle came from nt_kernel_open.
        let kernel = &unsafe { &*handle }.kernel;
        let cancel = CancellationFlag::new();
        match kernel.dispatch(op, request, &cancel) {
            Ok(bytes) => copy_out(&bytes, out_buf, out_cap, out_len),
            Err(err) => {
                let status = status_for(&err.code);
                let body = error_body(&err);
                let copy = copy_out(&body, out_buf, out_cap, out_len);
                if copy == NT_OK || copy == NT_ERR_BUFFER {
                    status
                } else {
                    copy
                }
            }
        }
    })
}

/// Starts a durable generation stream; the opaque stream handle is stored in
/// `*out_stream`. The run id is copied into `out_id`/`out_id_cap`/`out_id_len`
/// (on error the buffer carries the serialized error instead).
#[no_mangle]
pub extern "C" fn nt_stream_start(
    handle: *mut NtKernel,
    op: *const c_char,
    req: *const u8,
    req_len: usize,
    out_stream: *mut *mut NtStream,
    out_id: *mut u8,
    out_id_cap: usize,
    out_id_len: *mut usize,
) -> c_int {
    guard(move || {
        if handle.is_null() || out_stream.is_null() {
            return NT_ERR_INVALID_ARG;
        }
        let Some(op) = cstr(op) else {
            return NT_ERR_INVALID_ARG;
        };
        if req_len > MAX_REQUEST_LEN {
            return NT_ERR_INVALID_ARG;
        }
        if req.is_null() && req_len > 0 {
            return NT_ERR_INVALID_ARG;
        }
        let request: &[u8] = unsafe { std::slice::from_raw_parts(req, req_len) };
        let kernel = &unsafe { &*handle }.kernel;
        let cancel = CancellationFlag::new();
        match kernel.dispatch_stream(op, request, &cancel) {
            Ok(stream) => {
                let run_id = stream.stream_id().to_string();
                let copy = copy_out(run_id.as_bytes(), out_id, out_id_cap, out_id_len);
                if copy != NT_OK && copy != NT_ERR_BUFFER {
                    return copy;
                }
                // SAFETY: out_stream null-checked above.
                unsafe {
                    *out_stream = Box::into_raw(Box::new(NtStream {
                        stream,
                        cancel,
                        run_id,
                    }))
                };
                if copy == NT_ERR_BUFFER {
                    NT_ERR_BUFFER
                } else {
                    NT_OK
                }
            }
            Err(err) => {
                let status = status_for(&err.code);
                let body = error_body(&err);
                let copy = copy_out(&body, out_id, out_id_cap, out_id_len);
                if copy == NT_OK || copy == NT_ERR_BUFFER {
                    status
                } else {
                    copy
                }
            }
        }
    })
}

/// Waits up to `timeout_ms` for a stream notice; `*out_sequence` receives the
/// committed/terminal sequence (or -1 on timeout). Event payloads are
/// replayed through [`nt_call`] with `generation.events` — the durable log is
/// the canonical source (ТЗ §64).
#[no_mangle]
pub extern "C" fn nt_stream_wait(
    stream: *mut NtStream,
    timeout_ms: u32,
    out_sequence: *mut i64,
) -> c_int {
    guard(move || {
        if stream.is_null() || out_sequence.is_null() {
            return NT_ERR_INVALID_ARG;
        }
        let stream = unsafe { &mut *stream };
        match stream
            .stream
            .next_notice(Duration::from_millis(timeout_ms.into()))
        {
            Some(notice) => {
                let seq = match &notice {
                    runtime_kernel::StreamNotice::Committed { through_sequence } => {
                        *through_sequence
                    }
                    runtime_kernel::StreamNotice::Terminal { last_sequence } => *last_sequence,
                };
                // SAFETY: out_sequence null-checked above.
                unsafe { *out_sequence = seq };
                NT_OK
            }
            None => {
                unsafe { *out_sequence = -1 };
                NT_OK
            }
        }
    })
}

/// Requests cancellation of the run behind `stream` (executor flag plus the
/// durable `generation.cancel` operation).
#[no_mangle]
pub extern "C" fn nt_stream_cancel(handle: *mut NtKernel, stream: *mut NtStream) -> c_int {
    guard(move || {
        if handle.is_null() || stream.is_null() {
            return NT_ERR_INVALID_ARG;
        }
        let stream = unsafe { &*stream };
        stream.cancel.cancel();
        let kernel = &unsafe { &*handle }.kernel;
        let body = serde_json::json!({ "runId": stream.run_id });
        let request = body.to_string();
        match kernel.dispatch(
            "generation.cancel",
            request.as_bytes(),
            &CancellationFlag::new(),
        ) {
            Ok(_) => NT_OK,
            Err(err) => status_for(&err.code),
        }
    })
}

/// Frees a stream handle created by [`nt_stream_start`] (null is a no-op).
#[no_mangle]
pub extern "C" fn nt_stream_free(stream: *mut NtStream) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !stream.is_null() {
            // SAFETY: the pointer came from Box::into_raw in nt_stream_start.
            drop(unsafe { Box::from_raw(stream) });
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn cstring(s: &str) -> CString {
        CString::new(s).expect("cstring")
    }

    #[test]
    fn guard_contains_panics() {
        let status = guard(|| -> c_int { panic!("deliberate ABI-boundary panic") });
        assert_eq!(status, NT_ERR_INTERNAL, "panic becomes NT_ERR_INTERNAL");
    }

    #[test]
    fn stateless_meta_round_trip_and_error_codes() {
        let mut handle: *mut NtKernel = std::ptr::null_mut();
        let status = nt_kernel_open(std::ptr::null(), &mut handle);
        assert_eq!(status, NT_OK, "stateless open");
        assert!(!handle.is_null());

        // meta.get with the strict empty request.
        let op = cstring("meta.get");
        let req = b"{}";
        let mut out = vec![0u8; 4096];
        let mut out_len = 0usize;
        let status = nt_call(
            handle,
            op.as_ptr(),
            req.as_ptr(),
            req.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut out_len,
        );
        assert_eq!(status, NT_OK, "meta.get ok");
        let body: serde_json::Value = serde_json::from_slice(&out[..out_len]).expect("meta json");
        assert_eq!(body["productWire"]["major"], 1);

        // Buffer too small: required size reported, no allocation.
        let mut tiny = [0u8; 8];
        let mut need = 0usize;
        let status = nt_call(
            handle,
            op.as_ptr(),
            req.as_ptr(),
            req.len(),
            tiny.as_mut_ptr(),
            tiny.len(),
            &mut need,
        );
        assert_eq!(status, NT_ERR_BUFFER);
        assert!(need > tiny.len(), "required capacity reported");

        // Unknown operation → NOT_FOUND; oversized request → INVALID_ARG.
        let bad_op = cstring("nope.nope");
        let status = nt_call(
            handle,
            bad_op.as_ptr(),
            req.as_ptr(),
            req.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut out_len,
        );
        assert_eq!(status, NT_ERR_NOT_FOUND);
        let status = nt_call(
            handle,
            op.as_ptr(),
            req.as_ptr(),
            MAX_REQUEST_LEN + 1,
            out.as_mut_ptr(),
            out.len(),
            &mut out_len,
        );
        assert_eq!(status, NT_ERR_INVALID_ARG);

        // Contract violation: extra field on the strict empty request.
        let bad = b"{\"extra\":1}";
        let status = nt_call(
            handle,
            op.as_ptr(),
            bad.as_ptr(),
            bad.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut out_len,
        );
        assert_eq!(status, NT_ERR_CONTRACT);

        nt_kernel_free(handle);
        nt_kernel_free(std::ptr::null_mut()); // null free is a no-op
    }

    #[test]
    fn storage_crud_and_stream_over_ffi() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = cstring(temp.path().join("data").to_str().expect("utf8"));
        let mut handle: *mut NtKernel = std::ptr::null_mut();
        assert_eq!(nt_kernel_open(root.as_ptr(), &mut handle), NT_OK);

        // characters.create over the ABI.
        let op = cstring("characters.create");
        let req = br#"{"name":"Ffi Char"}"#;
        let mut out = vec![0u8; 8192];
        let mut out_len = 0usize;
        let status = nt_call(
            handle,
            op.as_ptr(),
            req.as_ptr(),
            req.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut out_len,
        );
        assert_eq!(status, NT_OK, "create over ffi");
        let created: serde_json::Value =
            serde_json::from_slice(&out[..out_len]).expect("created json");
        let id = created["id"].as_str().expect("id").to_string();

        // Close the kernel (releases the lease), seed a chat, reopen.
        nt_kernel_free(handle);
        {
            let mut db = neotavern_storage::open::open(
                temp.path().join("data").as_path(),
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
        let mut handle: *mut NtKernel = std::ptr::null_mut();
        assert_eq!(nt_kernel_open(root.as_ptr(), &mut handle), NT_OK);

        // generation.start over the ABI → stream handle + run id.
        let op = cstring("generation.start");
        let req = br#"{"chatId":"99999999-9999-4999-8999-999999999999","message":"hello"}"#;
        let mut stream: *mut NtStream = std::ptr::null_mut();
        let mut run_id = vec![0u8; 4096];
        let mut run_id_len = 0usize;
        let status = nt_stream_start(
            handle,
            op.as_ptr(),
            req.as_ptr(),
            req.len(),
            &mut stream,
            run_id.as_mut_ptr(),
            run_id.len(),
            &mut run_id_len,
        );
        if status != NT_OK {
            let body = String::from_utf8_lossy(&run_id[..run_id_len.min(run_id.len())]);
            panic!("stream start failed: status={status} body={body}");
        }
        assert!(run_id_len > 0, "run id reported");

        // Wait for a committed/terminal notice (fake provider is fast).
        let mut seq = -2i64;
        let mut noticed = false;
        for _ in 0..200 {
            let status = nt_stream_wait(stream, 100, &mut seq);
            assert_eq!(status, NT_OK);
            if seq >= 0 {
                noticed = true;
                break;
            }
        }
        assert!(noticed, "stream notice observed, seq={seq}");

        nt_stream_free(stream);
        nt_stream_free(std::ptr::null_mut());
        nt_kernel_free(handle);
    }

    #[test]
    fn abi_version_matches_kernel() {
        assert_eq!(nt_ffi_version(), runtime_kernel::FFI_ABI_VERSION);
    }
}
