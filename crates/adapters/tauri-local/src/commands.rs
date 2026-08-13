//! Tauri command surface for the local kernel transport (ТЗ §11.1).
//!
//! WebView gets only product operations: unary dispatch, live streams and
//! stream abort — no shell, no arbitrary filesystem, no server lifecycle.
//! Every command answers a validated `wire.response.envelope` JSON built by
//! the shared envelope layer; pre-envelope failures surface as IPC-level
//! errors (the JS transport maps them to typed transport errors, mirroring
//! how the CLI separates stderr diagnostics from stdout envelopes).

use super::{describe_failure, KernelHost};
use tauri::ipc::Channel;
use tauri::State;

/// Unary wire operation: envelope JSON in, response-envelope JSON out.
#[tauri::command]
pub fn kernel_dispatch(host: State<'_, KernelHost>, envelope: String) -> Result<String, String> {
    let body = host
        .dispatch_envelope(envelope.as_bytes())
        .map_err(|failure| describe_failure(&failure))?;
    String::from_utf8(body).map_err(|_| "kernel response was not UTF-8".to_string())
}

/// Live stream operation: opens the kernel stream, spawns the durable-log
/// poller and returns the response envelope JSON (with `streamId` in the
/// result). Committed `wire.event.envelope` values are pushed to `on_event`;
/// dropping the channel cancels the run durably.
#[tauri::command]
pub fn kernel_stream_start(
    host: State<'_, KernelHost>,
    envelope: String,
    on_event: Channel<serde_json::Value>,
) -> Result<String, String> {
    let body = host
        .open_stream(envelope.as_bytes(), move |value| {
            on_event.send(value).map_err(|_| ())
        })
        .map_err(|failure| describe_failure(&failure))?;
    String::from_utf8(body).map_err(|_| "kernel response was not UTF-8".to_string())
}

/// Requests cancellation of a live stream by id (idempotent).
#[tauri::command]
pub fn kernel_stream_abort(host: State<'_, KernelHost>, stream_id: String) -> Result<(), String> {
    host.abort_stream(&stream_id);
    Ok(())
}
