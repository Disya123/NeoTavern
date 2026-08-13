//! Phase 9 Remote Access host surface (ТЗ §10, §15.1): the service state
//! wrapper the Desktop shell manages as Tauri state, plus the wire DTOs the
//! `kernel_remote_*` commands answer.
//!
//! This module is deliberately Tauri-free — pure serde DTOs and a thin
//! wrapper over [`RemoteAccessService`] — so the crate builds with
//! `--features remote` alone. The command surface itself lives in
//! [`super::commands`] behind the `tauri` feature (the Desktop shell enables
//! both).
//!
//! Host diagnostics only: Remote Access is a host surface (ТЗ §10), never
//! product wire — these DTOs carry no `wire.response.envelope` framing and
//! no secrets (credential tokens are returned exactly once at pairing time
//! and never stored).

#[cfg(feature = "tauri")]
use neotavern_desktop_remote::{CredentialInfoDto, ServiceError, ServiceStatus};

/// Re-exported so the Desktop shell can construct the service without a
/// direct dependency on the adapter crate.
pub use neotavern_desktop_remote::RemoteAccessService;

/// The Remote Access service managed as Tauri state.
///
/// The service owns an interior mutex, so the wrapper is `Send + Sync` and
/// cheap to construct; it is not `Clone` (the service is a singleton). The
/// Desktop shell constructs it in `setup_local_kernel_mode` through the
/// `pub` field.
pub struct RemoteAccessState(pub RemoteAccessService);

/// Status snapshot answered by `kernel_remote_status` / `kernel_remote_start`.
///
/// `createdAt` (inside [`CredentialDto`]) is unix millis since UNIX_EPOCH as
/// a decimal string: the service DTO already carries millis (`SystemTime` is
/// not serde-serializable), and the UI parses it with
/// `new Date(Number(createdAt))`.
///
/// Command-surface type: only compiled when the `tauri` feature is on (the
/// pure-service `remote` feature alone needs just [`RemoteAccessState`]).
#[cfg(feature = "tauri")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatusDto {
    /// Whether the adapter listener is currently bound.
    pub running: bool,
    /// Resolved bind address IP, if running.
    pub bind: Option<String>,
    /// Resolved bind port, if running (port 0 → OS-assigned ephemeral).
    pub port: Option<u16>,
    /// Concurrently open SSE streams (host diagnostics; the underlying
    /// adapter exposes no live counter, so this is the service's bounded
    /// cap state).
    pub streams: usize,
    /// Whether the bearer-token pairing gate is enforced.
    pub auth_enabled: bool,
    /// Issued credentials (ids, labels, revocation flags — never tokens).
    pub credentials: Vec<CredentialDto>,
    /// Number of recorded audit events (bounded ring, FIFO).
    pub audit_events: usize,
    /// Last service error detail, if any.
    pub last_error: Option<String>,
}

/// One issued credential, without token material.
#[cfg(feature = "tauri")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialDto {
    /// Stable credential id (32 hex chars).
    pub id: String,
    /// Optional human label set at pairing time.
    pub label: Option<String>,
    /// Whether the credential was revoked.
    pub revoked: bool,
    /// Issue time as unix millis since UNIX_EPOCH, decimal string.
    pub created_at: String,
}

/// Result of a pairing: the credential id plus the one-time bearer token.
#[cfg(feature = "tauri")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairDto {
    /// Stable credential id (32 hex chars).
    pub id: String,
    /// One-time bearer token (returned exactly once, never stored).
    pub token: String,
}

/// `kernel_remote_start` payload: only the fields present override the
/// service configuration. `trusted_proxy` and `max_streams` always keep
/// their persisted values (there is no UI for either — both are ops-level
/// settings).
#[cfg(feature = "tauri")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStartPayload {
    /// Bind address as an IPv4/IPv6 string. `None` defaults to loopback
    /// `127.0.0.1` (ТЗ §10: loopback default).
    pub bind: Option<String>,
    /// Bind port. `None` defaults to 0 (OS-assigned ephemeral port).
    pub port: Option<u16>,
    /// Whether the pairing gate is enforced. `None` defaults to true.
    pub auth_enabled: Option<bool>,
    /// Exact-match CORS origin allowlist. `None` keeps the persisted value.
    pub allowed_origins: Option<Vec<String>>,
}

/// Maps a [`ServiceError`] to the stable `REMOTE_*` machine-readable code +
/// message convention (frozen contract 7): the web UI maps the code prefix
/// to i18n text, so codes are stable and messages never carry secrets.
#[cfg(feature = "tauri")]
pub(crate) fn remote_error(error: ServiceError) -> String {
    match error {
        ServiceError::InsecureBind => {
            "REMOTE_INSECURE_BIND: non-loopback bind requires trusted_proxy".to_string()
        }
        ServiceError::PublicBindRequiresAuth => {
            "REMOTE_PUBLIC_BIND_REQUIRES_AUTH: public bind requires auth_enabled".to_string()
        }
        ServiceError::AuthDisabled => {
            "REMOTE_AUTH_DISABLED: authentication is disabled".to_string()
        }
        ServiceError::NotRunning => "REMOTE_NOT_RUNNING: remote access is not running".to_string(),
        ServiceError::MustStopFirst => {
            "REMOTE_MUST_STOP_FIRST: stop remote access before changing its configuration"
                .to_string()
        }
        ServiceError::Start(message) => format!("REMOTE_START_FAILED: {message}"),
        ServiceError::ConfigIo(message) => format!("REMOTE_IO: {message}"),
        ServiceError::Internal(message) => format!("REMOTE_INTERNAL: {message}"),
    }
}

/// Maps the service status snapshot to the wire DTO.
#[cfg(feature = "tauri")]
pub(crate) fn status_dto(status: &ServiceStatus) -> RemoteStatusDto {
    RemoteStatusDto {
        running: status.running,
        bind: status.addr.map(|addr| addr.ip().to_string()),
        port: status.addr.map(|addr| addr.port()),
        streams: status.streams,
        auth_enabled: status.auth_enabled,
        credentials: status.credentials.iter().map(credential_dto).collect(),
        audit_events: status.audit_events,
        last_error: status.last_error.clone(),
    }
}

/// Maps one service credential DTO (already serde-ready) to the wire DTO.
#[cfg(feature = "tauri")]
fn credential_dto(credential: &CredentialInfoDto) -> CredentialDto {
    CredentialDto {
        id: credential.id.clone(),
        label: credential.label.clone(),
        revoked: credential.revoked,
        // Unix millis since UNIX_EPOCH (the service DTO's lossy u64 cast of
        // SystemTime); decimal string keeps the wire field a String per the
        // frozen contract.
        created_at: credential.created_at_unix_millis.to_string(),
    }
}
