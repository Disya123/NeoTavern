//! Optional Desktop Remote Access host service (Phase 9, ТЗ §10).
//!
//! A thin, host-owned wrapper around the hardened Phase 4
//! [`remote_http_adapter::RemoteAdapter`] that lets the Desktop app expose
//! the SAME in-process [`runtime_kernel::Kernel`] over HTTP/SSE without
//! owning any product state. The kernel stays the single writer: every
//! transport — local Tauri IPC, CLI, remote HTTP — dispatches through the one
//! `Arc<Mutex<Kernel>>`, so concurrent local and remote operations share the
//! same transaction invariants.
//!
//! Security posture (ТЗ §10):
//!
//! - **Off by default.** `RemoteAccessService` owns no listener until
//!   [`start`](RemoteAccessService::start) is called.
//! - **Loopback by default.** The default config binds `127.0.0.1` on an
//!   ephemeral port. A non-loopback bind is rejected with
//!   [`ServiceError::InsecureBind`] unless `trusted_proxy` is explicitly
//!   enabled — the adapter enforces this BEFORE any listener is created.
//! - **Auth on by default.** Pairing (`auth_enabled: true`) gates every
//!   `/rpc` and `/rpc/stream` call behind a scoped, revocable bearer token;
//!   tokens are never stored or logged (the adapter keeps only SHA-256
//!   verifiers). Revocation stops new calls and long-lived streams.
//! - **CORS deny-by-default.** An empty `allowed_origins` list rejects any
//!   request carrying an `Origin` header.
//!
//! Configuration lives in a host-owned JSON file (outside the kernel data
//! root). The file is loaded at [`new`](RemoteAccessService::new); a missing
//! file falls back to defaults, a corrupt one falls back to defaults AND
//! records the failure in [`ServiceStatus::last_error`]. `#[serde(default)]`
//! on every field means old or partial config files degrade field-by-field.
//! The file is written atomically (temp file + rename in the same directory)
//! and the parent directory is created lazily on save.
//!
//! Lifecycle: `new` → `set_config` (only while stopped) → `start` (idempotent;
//! returns the resolved address) → `pair`/`revoke` → `stop` (idempotent).
//! `start` → `stop` → `start` cycles cleanly; the adapter holds no durable
//! state, so restarting does not disturb the kernel.

use remote_http_adapter::auth::AuthConfig;
use remote_http_adapter::{AdapterError, RemoteAdapter, RemoteAdapterConfig};
use runtime_kernel::Kernel;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, UNIX_EPOCH};

/// How many live credentials the pairing store accepts (bounded store, ТЗ
/// §10). One credential per paired client; 16 covers a small fleet of
/// devices while keeping the store firmly bounded.
const MAX_CREDENTIALS: usize = 16;

/// Monotonic suffix for temp files so concurrent writers in the same
/// directory never collide.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Host-owned, persisted configuration for the Desktop Remote Access
/// service.
///
/// Every field carries `#[serde(default)]` (or a default function) so a
/// missing, partial or older-format file degrades to defaults field-by-field
/// instead of failing the whole load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteAccessConfig {
    /// Address to bind. Default `127.0.0.1` (loopback only).
    #[serde(default = "default_bind")]
    pub bind: IpAddr,
    /// Port to bind; `0` lets the OS pick an ephemeral port (resolved via
    /// [`ServiceStatus::addr`]).
    #[serde(default)]
    pub port: u16,
    /// Opt-in for a non-loopback bind. `false` (default) makes
    /// [`RemoteAccessService::start`] fail with
    /// [`ServiceError::InsecureBind`] before any listener exists.
    #[serde(default)]
    pub trusted_proxy: bool,
    /// Pairing gate. `true` (default): every `/rpc` and `/rpc/stream`
    /// request must carry a valid `Authorization: Bearer <token>` issued by
    /// [`RemoteAccessService::pair`].
    #[serde(default = "default_auth_enabled")]
    pub auth_enabled: bool,
    /// CORS/Origin allowlist (exact match, case-sensitive). Empty (default)
    /// is deny-by-default.
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// Maximum concurrently open SSE streams (bounded streams, ТЗ §10).
    #[serde(default = "default_max_streams")]
    pub max_streams: usize,
}

impl Default for RemoteAccessConfig {
    fn default() -> Self {
        Self {
            bind: default_bind(),
            port: 0,
            trusted_proxy: false,
            auth_enabled: default_auth_enabled(),
            allowed_origins: Vec::new(),
            max_streams: default_max_streams(),
        }
    }
}

fn default_bind() -> IpAddr {
    IpAddr::V4(Ipv4Addr::LOCALHOST)
}

fn default_auth_enabled() -> bool {
    true
}

fn default_max_streams() -> usize {
    8
}

/// Diagnostic view of one paired credential.
///
/// A local DTO, NOT a product wire type: the adapter's
/// [`remote_http_adapter::auth::CredentialInfo`] carries a
/// `std::time::SystemTime`, which serde cannot serialize, and this status
/// shape is host-service diagnostics for the Remote Access UI. Token
/// material never leaves the adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialInfoDto {
    /// Stable credential id (32 hex chars).
    pub id: String,
    /// Optional human label set at pairing time.
    pub label: Option<String>,
    /// Whether the credential was revoked.
    pub revoked: bool,
    /// Issue time as unix epoch milliseconds (diagnostics only).
    pub created_at_unix_millis: u64,
}

/// A snapshot of the host service state for the Remote Access UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceStatus {
    /// Whether the adapter listener is currently up.
    pub running: bool,
    /// The resolved listen address (port fixed when config used port 0).
    pub addr: Option<SocketAddr>,
    /// Concurrently open SSE streams. Always 0 while running: the remote
    /// adapter exposes no live-stream counter (only cap rejections are
    /// audited), so this field is reserved for diagnostics.
    pub streams: usize,
    /// Paired credentials (ids, labels, revocation — never tokens).
    pub credentials: Vec<CredentialInfoDto>,
    /// Number of recorded audit events (bounded log, oldest first).
    pub audit_events: usize,
    /// Whether the pairing gate is on (mirrors `config().auth_enabled`).
    pub auth_enabled: bool,
    /// Last error surfaced by the service (config load, start failure), or
    /// `None` after a successful start.
    pub last_error: Option<String>,
}

/// Stable service errors. Variants are fixed so the Tauri shell and the UI
/// can map them without string matching.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError {
    /// A non-loopback bind was requested with `trusted_proxy` off; rejected
    /// before any listener exists.
    InsecureBind,
    /// A non-loopback bind was requested without the pairing gate; rejected
    /// before any listener exists (public exposure requires auth, ТЗ §10).
    PublicBindRequiresAuth,
    /// Pairing was requested but the service is running with auth disabled.
    AuthDisabled,
    /// The operation requires a running adapter.
    NotRunning,
    /// Configuration cannot change while the adapter is running.
    MustStopFirst,
    /// Reading/writing the config file failed.
    ConfigIo(String),
    /// The adapter failed to start (bind failure, worker spawn failure, or a
    /// public bind without configured auth).
    Start(String),
    /// An adapter-internal failure (shutdown, pairing store limits).
    Internal(String),
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ServiceError::InsecureBind => write!(
                f,
                "insecure bind rejected: non-loopback bind requires trusted_proxy"
            ),
            ServiceError::PublicBindRequiresAuth => write!(
                f,
                "public bind rejected: non-loopback exposure requires the pairing gate"
            ),
            ServiceError::AuthDisabled => write!(f, "pairing requires auth to be enabled"),
            ServiceError::NotRunning => write!(f, "remote access is not running"),
            ServiceError::MustStopFirst => {
                write!(f, "stop remote access before changing its configuration")
            }
            ServiceError::ConfigIo(detail) => write!(f, "config I/O failure: {detail}"),
            ServiceError::Start(detail) => write!(f, "failed to start remote access: {detail}"),
            ServiceError::Internal(detail) => write!(f, "remote access internal error: {detail}"),
        }
    }
}

impl std::error::Error for ServiceError {}

/// The Desktop Remote Access host service.
///
/// All methods take `&self` so the service works both as Tauri managed
/// state and in plain tests; an internal mutex serializes lifecycle
/// operations. The kernel is passed to
/// [`start`](RemoteAccessService::start) and handed to the adapter — the
/// service itself never stores or locks it, so the kernel mutex remains the
/// single-writer coordinator shared with the local hosts.
pub struct RemoteAccessService {
    inner: Mutex<Inner>,
}

struct Inner {
    config: RemoteAccessConfig,
    config_file: PathBuf,
    adapter: Option<RemoteAdapter>,
    last_error: Option<String>,
}

impl RemoteAccessService {
    /// Loads the persisted config from `config_file` (missing → defaults;
    /// corrupt or unreadable → defaults with `last_error` recorded) and
    /// returns a stopped service. The parent directory is created lazily on
    /// the next save.
    pub fn new(config_file: PathBuf) -> Self {
        let (config, last_error) = load_config(&config_file);
        Self {
            inner: Mutex::new(Inner {
                config,
                config_file,
                adapter: None,
                last_error,
            }),
        }
    }

    /// The currently active configuration (in-memory copy).
    pub fn config(&self) -> RemoteAccessConfig {
        self.lock_inner().config.clone()
    }

    /// Atomically persists the current configuration (temp file + rename in
    /// the same directory, creating parent dirs as needed).
    pub fn persist(&self) -> Result<(), ServiceError> {
        let inner = self.lock_inner();
        persist_config(&inner.config_file, &inner.config)
    }

    /// Replaces the configuration and persists it.
    ///
    /// Fails with [`ServiceError::MustStopFirst`] while the adapter is
    /// running (the listener binds the current config); on persistence
    /// failure the in-memory config is left unchanged.
    pub fn set_config(&self, cfg: RemoteAccessConfig) -> Result<(), ServiceError> {
        let mut inner = self.lock_inner();
        if inner.adapter.is_some() {
            return Err(ServiceError::MustStopFirst);
        }
        persist_config(&inner.config_file, &cfg)?;
        inner.config = cfg;
        Ok(())
    }

    /// A snapshot of the service state (running, address, credentials,
    /// audit count, last error).
    pub fn status(&self) -> ServiceStatus {
        let inner = self.lock_inner();
        match &inner.adapter {
            Some(adapter) => ServiceStatus {
                running: true,
                addr: Some(adapter.local_addr()),
                streams: 0,
                credentials: adapter
                    .credentials()
                    .into_iter()
                    .map(|info| CredentialInfoDto {
                        id: info.id,
                        label: info.label,
                        revoked: info.revoked,
                        created_at_unix_millis: info
                            .created_at
                            .duration_since(UNIX_EPOCH)
                            .map(|duration| duration.as_millis() as u64)
                            .unwrap_or(0),
                    })
                    .collect(),
                audit_events: adapter.audit_events().len(),
                auth_enabled: inner.config.auth_enabled,
                last_error: inner.last_error.clone(),
            },
            None => ServiceStatus {
                running: false,
                addr: None,
                streams: 0,
                credentials: Vec::new(),
                audit_events: 0,
                auth_enabled: inner.config.auth_enabled,
                last_error: inner.last_error.clone(),
            },
        }
    }

    /// Starts the remote HTTP adapter over `kernel`.
    ///
    /// Idempotent: when already running, returns the current listen address
    /// and ignores the kernel argument. Otherwise builds the adapter config
    /// from the current service config (1 MiB request cap, 5s drain, 64
    /// worker connections, bounded pairing store when auth is on, no rate
    /// limit, no trusted proxies) and starts the listener. A non-loopback
    /// bind without `trusted_proxy` fails with
    /// [`ServiceError::InsecureBind`] before any listener exists.
    pub fn start(&self, kernel: Arc<Mutex<Kernel>>) -> Result<SocketAddr, ServiceError> {
        let mut inner = self.lock_inner();
        if let Some(adapter) = &inner.adapter {
            return Ok(adapter.local_addr());
        }
        let config = inner.config.clone();
        let adapter_config = RemoteAdapterConfig {
            bind_addr: SocketAddr::new(config.bind, config.port),
            trusted_proxy: config.trusted_proxy,
            max_request_bytes: 1024 * 1024,
            max_connections: 64,
            drain_timeout: Duration::from_secs(5),
            auth: if config.auth_enabled {
                Some(AuthConfig {
                    max_credentials: MAX_CREDENTIALS,
                })
            } else {
                None
            },
            rate_limit: None,
            max_streams: config.max_streams,
            audit_capacity: 256,
            allowed_origins: config.allowed_origins.clone(),
            trusted_proxies: Vec::new(),
        };
        match RemoteAdapter::start(kernel, adapter_config) {
            Ok(adapter) => {
                let addr = adapter.local_addr();
                inner.adapter = Some(adapter);
                inner.last_error = None;
                Ok(addr)
            }
            Err(AdapterError::InsecureBind { .. }) => {
                inner.last_error = Some(ServiceError::InsecureBind.to_string());
                Err(ServiceError::InsecureBind)
            }
            Err(AdapterError::PublicBindRequiresAuth { .. }) => {
                inner.last_error = Some(ServiceError::PublicBindRequiresAuth.to_string());
                Err(ServiceError::PublicBindRequiresAuth)
            }
            Err(other) => {
                let message = format!("{other:?}");
                inner.last_error = Some(message.clone());
                Err(ServiceError::Start(message))
            }
        }
    }

    /// Stops the adapter, draining in-flight requests. Idempotent: a stopped
    /// service answers `Ok`.
    pub fn stop(&self) -> Result<(), ServiceError> {
        let mut inner = self.lock_inner();
        if let Some(adapter) = inner.adapter.take() {
            adapter.shutdown().map_err(|err| {
                ServiceError::Internal(format!("adapter shutdown failed: {err:?}"))
            })?;
        }
        Ok(())
    }

    /// Issues a new pairing credential, returning `(id, token)`. The token
    /// is returned exactly once and never stored.
    ///
    /// Requires a running adapter ([`ServiceError::NotRunning`]) with auth
    /// enabled ([`ServiceError::AuthDisabled`] otherwise).
    pub fn pair(&self, label: Option<String>) -> Result<(String, String), ServiceError> {
        let inner = self.lock_inner();
        let adapter = inner.adapter.as_ref().ok_or(ServiceError::NotRunning)?;
        adapter.pair(label).map_err(|err| match err {
            remote_http_adapter::auth::AuthError::AuthDisabled => ServiceError::AuthDisabled,
            other => ServiceError::Internal(format!("pairing failed: {other:?}")),
        })
    }

    /// Revokes a credential by id; subsequent calls with its token are
    /// rejected and long-lived streams terminate. Returns whether the id
    /// existed. Requires a running adapter.
    pub fn revoke(&self, id: &str) -> Result<bool, ServiceError> {
        let inner = self.lock_inner();
        let adapter = inner.adapter.as_ref().ok_or(ServiceError::NotRunning)?;
        Ok(adapter.revoke(id))
    }

    /// Locks the inner state, recovering from a poisoned mutex instead of
    /// panicking (the service never unwraps or expects on external input).
    fn lock_inner(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Loads the persisted config. A missing file yields defaults with no error;
/// a corrupt or unreadable file yields defaults AND a recorded error so the
/// UI can surface it via `last_error`.
fn load_config(path: &Path) -> (RemoteAccessConfig, Option<String>) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return (RemoteAccessConfig::default(), None);
        }
        Err(err) => {
            return (
                RemoteAccessConfig::default(),
                Some(format!("failed to read config file: {err}")),
            );
        }
    };
    match serde_json::from_slice::<RemoteAccessConfig>(&bytes) {
        Ok(config) => (config, None),
        Err(err) => (
            RemoteAccessConfig::default(),
            Some(format!("corrupt config file, using defaults: {err}")),
        ),
    }
}

/// Atomically writes `config` to `path`: serialize → temp file in the same
/// directory (unique per writer) → fsync → rename over the target. Parent
/// directories are created on demand.
fn persist_config(path: &Path, config: &RemoteAccessConfig) -> Result<(), ServiceError> {
    let json = serde_json::to_vec_pretty(config)
        .map_err(|err| ServiceError::ConfigIo(format!("serialize config: {err}")))?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|err| {
        ServiceError::ConfigIo(format!("create config dir {}: {err}", parent.display()))
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        ServiceError::ConfigIo(format!("config path has no file name: {}", path.display()))
    })?;
    let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
    let tmp = parent.join(format!(
        ".{}.{}.{}.tmp",
        file_name.to_string_lossy(),
        std::process::id(),
        seq
    ));

    let write_result = (|| -> Result<(), ServiceError> {
        let mut file = fs::File::create(&tmp)
            .map_err(|err| ServiceError::ConfigIo(format!("create temp file: {err}")))?;
        file.write_all(&json)
            .map_err(|err| ServiceError::ConfigIo(format!("write temp file: {err}")))?;
        file.sync_all()
            .map_err(|err| ServiceError::ConfigIo(format!("sync temp file: {err}")))?;
        drop(file);
        fs::rename(&tmp, path)
            .map_err(|err| ServiceError::ConfigIo(format!("atomic rename: {err}")))
    })();
    if write_result.is_err() {
        // Best-effort cleanup of the temp file; never masks the original
        // error.
        let _ = fs::remove_file(&tmp);
    }
    write_result
}
