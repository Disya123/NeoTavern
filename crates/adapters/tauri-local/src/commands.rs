//! Tauri command surface for the local kernel transport (ТЗ §11.1).
//!
//! WebView gets only product operations: unary dispatch, live streams and
//! stream abort — no shell, no arbitrary filesystem. With `NEOTA_LEGACY_SERVER`
//! unset the desktop process owns no server lifecycle at all (§11.1); the
//! Phase 9 `kernel_remote_*` commands (`remote` feature) are the explicit,
//! opt-in exception — they start/stop the Remote Access listener on user
//! action, off by default (ТЗ §10).
//! Every command answers a validated `wire.response.envelope` JSON built by
//! the shared envelope layer; pre-envelope failures surface as IPC-level
//! errors (the JS transport maps them to typed transport errors, mirroring
//! how the CLI separates stderr diagnostics from stdout envelopes).

use super::{describe_failure, KernelHost};
use tauri::ipc::Channel;
use tauri::State;

/// Phase 9 Remote Access command surface (ТЗ §10): compiled when the `remote`
/// feature is enabled alongside `tauri` (the Desktop shell enables both).
#[cfg(feature = "remote")]
use super::remote::{
    remote_error, status_dto, PairDto, RemoteAccessState, RemoteStartPayload, RemoteStatusDto,
};

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

// ---------------------------------------------------------------------------
// Phase 9 Remote Access (ТЗ §10) — compiled with the `remote` feature.
// Every error is `CODE: message` per the frozen contract (codes in
// [`super::remote::remote_error`]); the web UI maps codes to i18n text.
// ---------------------------------------------------------------------------

/// Status snapshot of the Remote Access service (never mutates anything).
#[cfg(feature = "remote")]
#[tauri::command]
pub fn kernel_remote_status(
    state: State<'_, RemoteAccessState>,
) -> Result<RemoteStatusDto, String> {
    Ok(status_dto(&state.0.status()))
}

/// Applies the payload overrides to the service configuration and starts the
/// listener on the shared kernel. `trusted_proxy` and `max_streams` keep
/// their persisted values. Fails `REMOTE_MUST_STOP_FIRST` while running;
/// security rejections surface as `REMOTE_INSECURE_BIND` /
/// `REMOTE_PUBLIC_BIND_REQUIRES_AUTH`; an unparseable bind address is
/// `REMOTE_START_FAILED`. Answers the fresh status (start returns the
/// resolved address, surfaced via `bind`/`port`).
#[cfg(feature = "remote")]
#[tauri::command]
pub fn kernel_remote_start(
    host: State<'_, KernelHost>,
    state: State<'_, RemoteAccessState>,
    payload: RemoteStartPayload,
) -> Result<RemoteStatusDto, String> {
    let mut config = state.0.config();
    config.bind = match payload.bind {
        Some(bind) => bind.parse().map_err(|error| {
            format!("REMOTE_START_FAILED: invalid bind address `{bind}`: {error}")
        })?,
        None => std::net::IpAddr::from([127, 0, 0, 1]),
    };
    config.port = payload.port.unwrap_or(0);
    config.auth_enabled = payload.auth_enabled.unwrap_or(true);
    if let Some(allowed_origins) = payload.allowed_origins {
        config.allowed_origins = allowed_origins;
    }
    state.0.set_config(config).map_err(remote_error)?;
    state.0.start(host.kernel_handle()).map_err(remote_error)?;
    Ok(status_dto(&state.0.status()))
}

/// Stops Remote Access and releases the listener (idempotent: stopping an
/// already-stopped service is a no-op).
#[cfg(feature = "remote")]
#[tauri::command]
pub fn kernel_remote_stop(state: State<'_, RemoteAccessState>) -> Result<(), String> {
    state.0.stop().map_err(remote_error)?;
    Ok(())
}

/// Issues a scoped bearer credential with an optional human label. The token
/// is returned exactly once (the service keeps only its verifier); pairing
/// fails with `REMOTE_AUTH_DISABLED` when the gate is off.
#[cfg(feature = "remote")]
#[tauri::command]
pub fn kernel_remote_pair(
    state: State<'_, RemoteAccessState>,
    label: Option<String>,
) -> Result<PairDto, String> {
    let (id, token) = state.0.pair(label).map_err(remote_error)?;
    Ok(PairDto { id, token })
}

/// Revokes a credential by id. Answers `false` for an unknown id (already
/// revoked ids stay unknown — no oracle, per the pairing-store contract).
#[cfg(feature = "remote")]
#[tauri::command]
pub fn kernel_remote_revoke(
    state: State<'_, RemoteAccessState>,
    id: String,
) -> Result<bool, String> {
    state.0.revoke(&id).map_err(remote_error)
}
