//! Remote HTTP adapter (Phase 4): maps HTTP/SSE traffic onto the shared
//! in-process [`runtime_kernel::Kernel`] through a `tiny_http` server.
//!
//! The adapter is deliberately thin: it owns no storage and no product
//! rules. Every operation request is decoded from the wire envelope,
//! validated against the embedded contract manifest, and dispatched to the
//! SAME [`Kernel`] instance the local hosts use — the kernel mutex is the
//! single-writer coordinator (ТЗ §22).
//!
//! Security default: the adapter binds loopback-only (`127.0.0.1`) with an
//! ephemeral port. A non-loopback bind is rejected at startup unless
//! [`RemoteAdapterConfig::trusted_proxy`] opts in explicitly (ТЗ §10).
//!
//! Wire semantics (see the Phase 4 contract, sections 1–8): HTTP status is
//! reserved for transport-level failures that happen before a usable
//! envelope exists (400/404/405/413/426); once the envelope parses and
//! passes the protocol check the adapter always answers HTTP 200 with a
//! validated ok/error response envelope.

pub mod audit;
pub mod auth;
pub mod cors;

pub mod rate_limit;
pub mod sse;

use std::collections::HashSet;
use std::io::{Cursor, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use audit::{AuditEvent, AuditKind, AuditLog};
use auth::{AuthConfig, AuthError, CredentialInfo, PairingStore};
use contracts_generated::generated;
use cors::CorsPolicy;
use neotavern_envelope::{EnvelopeFailure, ProtocolVerdict};
use rate_limit::{RateLimitConfig, RateLimiter};
use runtime_kernel::{
    CancellationFlag, EventStream, Kernel, KernelError, KernelErrorCode, StreamNotice,
};
use sse::SseFrame;
use tiny_http::{Header, Method, Request, Response, Server};

/// Configuration for [`RemoteAdapter::start`].
///
/// Defaults enforce the loopback-only security posture: ephemeral loopback
/// bind, no trusted proxy, no pairing gate, no rate limit, a 1 MiB request
/// cap, 64 worker connections and a 5s drain budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteAdapterConfig {
    /// Address to bind. Default `127.0.0.1:0` — loopback only; port 0 lets
    /// the OS pick an ephemeral port, resolved via
    /// [`RemoteAdapter::local_addr`].
    pub bind_addr: SocketAddr,

    /// When `false`, a non-loopback [`Self::bind_addr`] fails with
    /// [`AdapterError::InsecureBind`] before any listener is created.
    pub trusted_proxy: bool,

    /// Maximum request body size in bytes. Larger requests are rejected with
    /// HTTP 413 `QUOTA_EXCEEDED` (header check first, then a bounded read
    /// for chunked/unknown-length bodies).
    pub max_request_bytes: u64,

    /// Number of worker threads pulling requests from the shared listener.
    pub max_connections: usize,

    /// Graceful-drain budget: how long [`RemoteAdapter::shutdown`] waits for
    /// in-flight requests before abandoning the remaining workers.
    pub drain_timeout: Duration,

    /// Pairing/credential gate. `None` (default) = open access (loopback
    /// dev posture). `Some(cfg)` = every `/rpc` and `/rpc/stream` request
    /// must carry a valid `Authorization: Bearer <token>`; credentials are
    /// issued via [`RemoteAdapter::pair`] and revoked via
    /// [`RemoteAdapter::revoke`] (§10, Phase 4 hardening / Phase 9).
    pub auth: Option<AuthConfig>,

    /// Token-bucket rate limiting keyed by credential id (when auth is on)
    /// or peer IP (when auth is off). `None` (default) = unlimited.
    pub rate_limit: Option<RateLimitConfig>,

    /// Maximum concurrently open SSE streams. `None`-style unbounded
    /// streaming is forbidden (§10: bounded stream limits); default 8.
    pub max_streams: usize,

    /// Audit ring capacity (bounded, FIFO). Default 256 events.
    pub audit_capacity: usize,

    /// CORS/Origin allowlist (exact-match, case-sensitive). Empty (default)
    /// is deny-by-default: any request carrying an `Origin` header is
    /// rejected 403 `ORIGIN_NOT_ALLOWED` before dispatch; no
    /// `Access-Control-*` header is ever emitted. Non-browser clients (no
    /// `Origin` header) are unaffected.
    pub allowed_origins: Vec<String>,

    /// Addresses of reverse proxies this adapter trusts to append
    /// `X-Forwarded-For` (§10: "forwarded client/proto headers принимаются
    /// только от configured proxy addresses"). Empty (default) = forwarded
    /// headers are ignored entirely; rate limiting keys by the peer socket
    /// IP. When the peer is trusted, the client IP for rate-limit keying is
    /// taken from `X-Forwarded-For` (rightmost entry not added by a trusted
    /// proxy). Forwarded headers from any other peer are never honored.
    pub trusted_proxies: Vec<IpAddr>,
}

impl Default for RemoteAdapterConfig {
    fn default() -> Self {
        Self {
            bind_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            trusted_proxy: false,
            max_request_bytes: 1024 * 1024,
            max_connections: 64,
            drain_timeout: Duration::from_secs(5),
            auth: None,
            rate_limit: None,
            max_streams: 8,
            audit_capacity: 256,
            allowed_origins: Vec::new(),
            trusted_proxies: Vec::new(),
        }
    }
}

/// Errors surfaced by [`RemoteAdapter::start`] and
/// [`RemoteAdapter::shutdown`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterError {
    /// A non-loopback bind was requested without
    /// [`RemoteAdapterConfig::trusted_proxy`]. Returned BEFORE any listener
    /// is created.
    InsecureBind {
        /// The rejected bind address.
        addr: SocketAddr,
    },
    /// A non-loopback bind was requested with `trusted_proxy` but without
    /// [`RemoteAdapterConfig::auth`] — a public listener without configured
    /// auth is a startup error (ТЗ §10).
    PublicBindRequiresAuth {
        /// The rejected bind address.
        addr: SocketAddr,
    },
    /// The listener could not be created on `addr`, or the worker pool could
    /// not start.
    BindFailed {
        /// The address that failed to bind.
        addr: SocketAddr,
        /// Human-readable OS/threading detail.
        message: String,
    },
    /// Graceful shutdown failed. In practice this only happens when a worker
    /// panicked during the drain — an adapter-internal bug, never a
    /// payload-driven failure.
    ShutdownFailed {
        /// Human-readable detail.
        message: String,
    },
}

/// A running remote HTTP adapter over one shared [`Kernel`].
///
/// [`start`](Self::start) validates the security posture, binds the
/// listener, resolves the actual address (port 0 → ephemeral) and spawns the
/// worker pool. [`shutdown`](Self::shutdown) drains in-flight requests and
/// releases the listener; dropping the adapter without `shutdown` leaves the
/// workers blocked on the shared listener until the process exits — always
/// prefer `shutdown`.
pub struct RemoteAdapter {
    /// Shared listener; workers call [`Server::recv`] on it.
    server: Arc<Server>,
    /// Resolved listen address (port fixed when the config used port 0).
    local_addr: SocketAddr,
    /// Snapshot of the start configuration (drain budget at shutdown).
    config: RemoteAdapterConfig,
    /// Set by `shutdown`; workers observe it and stop pulling new requests.
    stop: Arc<AtomicBool>,
    /// Worker threads, joined during `shutdown`.
    workers: Vec<thread::JoinHandle<()>>,
    /// State shared with every worker: kernel, optional pairing store,
    /// optional rate limiter, bounded audit log and the concurrent-stream
    /// counter. Also the pairing/audit surface the host drives (§10).
    shared: Arc<Shared>,
}

/// State shared by every worker: the kernel plus the security gates (§10,
/// Phase 4 hardening / Phase 9).
struct Shared {
    /// The single writer coordinator every transport shares (§22).
    kernel: Arc<Mutex<Kernel>>,
    /// Optional pairing gate; `None` = open loopback-dev posture.
    auth: Option<Arc<PairingStore>>,
    /// Optional token-bucket rate limiter.
    rate: Option<Arc<RateLimiter>>,
    /// Bounded structured audit log (never token/secret/payload material).
    audit: Arc<AuditLog>,
    /// Currently open SSE streams (bounded by `max_streams`).
    streams: AtomicUsize,
    /// Concurrent-stream cap.
    max_streams: usize,
    /// Request body cap enforced per request.
    max_request_bytes: u64,
    /// CORS/Origin policy (deny-by-default).
    cors: CorsPolicy,
    /// Reverse proxies trusted to append `X-Forwarded-For` (§10). Empty =
    /// forwarded headers ignored.
    trusted_proxies: HashSet<IpAddr>,
}

impl RemoteAdapter {
    /// Validates the configuration, binds the listener and spawns the worker
    /// pool.
    ///
    /// The security check runs BEFORE binding: a non-loopback
    /// [`RemoteAdapterConfig::bind_addr`] without
    /// [`RemoteAdapterConfig::trusted_proxy`] returns
    /// [`AdapterError::InsecureBind`] without ever creating a listener.
    ///
    /// # Errors
    ///
    /// [`AdapterError::InsecureBind`] for the security check;
    /// [`AdapterError::BindFailed`] when the listener cannot be created or a
    /// worker thread cannot be spawned (spawned workers are joined before
    /// the error is returned).
    pub fn start(
        kernel: Arc<Mutex<Kernel>>,
        config: RemoteAdapterConfig,
    ) -> Result<Self, AdapterError> {
        if !config.bind_addr.ip().is_loopback() {
            if !config.trusted_proxy {
                return Err(AdapterError::InsecureBind {
                    addr: config.bind_addr,
                });
            }
            if config.auth.is_none() {
                // ТЗ §10: "Публичное включение listener без настроенных
                // auth и transport security является startup error."
                return Err(AdapterError::PublicBindRequiresAuth {
                    addr: config.bind_addr,
                });
            }
        }

        let server =
            Arc::new(
                Server::http(config.bind_addr).map_err(|err| AdapterError::BindFailed {
                    addr: config.bind_addr,
                    message: err.to_string(),
                })?,
            );
        // `Server::http` with a `SocketAddr` always yields an IP listener;
        // the Unix variant is unreachable here (program invariant).
        let local_addr = server
            .server_addr()
            .to_ip()
            .expect("Server::http(SocketAddr) binds an IP listener");

        let audit = Arc::new(AuditLog::new(config.audit_capacity));
        audit.record(AuditKind::Started, "adapter.start");

        let shared = Arc::new(Shared {
            kernel,
            auth: config
                .auth
                .as_ref()
                .map(|cfg| Arc::new(PairingStore::new(cfg.max_credentials))),
            rate: config
                .rate_limit
                .as_ref()
                .map(|cfg| Arc::new(RateLimiter::new(*cfg))),
            audit,
            streams: AtomicUsize::new(0),
            max_streams: config.max_streams,
            max_request_bytes: config.max_request_bytes,
            cors: CorsPolicy::new(&config.allowed_origins),
            trusted_proxies: config.trusted_proxies.iter().copied().collect(),
        });

        let stop = Arc::new(AtomicBool::new(false));
        let mut workers = Vec::with_capacity(config.max_connections);
        for _ in 0..config.max_connections {
            // A dedicated clone so the error arm below can unblock the
            // listener even though the worker clone was moved into the
            // spawn closure.
            let unblock_server = Arc::clone(&server);
            let server = Arc::clone(&server);
            let shared = Arc::clone(&shared);
            // Another dedicated clone: the error arm sets the flag even
            // though the worker clone moved into the spawn closure.
            let stop_signal = Arc::clone(&stop);
            let stop = Arc::clone(&stop);
            let builder = thread::Builder::new().name("remote-http-worker".to_string());
            match builder.spawn(move || worker_loop(server, shared, stop)) {
                Ok(handle) => workers.push(handle),
                Err(err) => {
                    // Partial spawn failure: stop the workers that did start,
                    // wake any blocked in recv(), join them, then fail the
                    // start. The listener closes when the server Arc drops.
                    stop_signal.store(true, Ordering::SeqCst);
                    for _ in &workers {
                        unblock_server.unblock();
                    }
                    for handle in workers {
                        let _ = handle.join();
                    }
                    return Err(AdapterError::BindFailed {
                        addr: config.bind_addr,
                        message: format!("failed to spawn worker thread: {err}"),
                    });
                }
            }
        }

        Ok(Self {
            server,
            local_addr,
            config,
            stop,
            workers,
            shared,
        })
    }

    /// The address the adapter is actually listening on; the port is
    /// resolved when [`RemoteAdapterConfig::bind_addr`] used port 0.
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Whether the adapter is still accepting requests. `false` once
    /// [`Self::shutdown`] has stopped the worker pool.
    pub fn is_listening(&self) -> bool {
        !self.stop.load(Ordering::SeqCst)
    }

    /// Issues a new pairing credential. The token is returned exactly once;
    /// only its verifier is stored. `Err([`AuthError::LimitReached`])` when
    /// the store is at its configured cap (§10: bounded credential store).
    /// `Err([`AuthError::AuthDisabled`])` when the adapter was started
    /// without [`RemoteAdapterConfig::auth`].
    pub fn pair(&self, label: Option<String>) -> Result<(String, String), AuthError> {
        match &self.shared.auth {
            Some(store) => {
                let issued = store.pair(label)?;
                self.shared
                    .audit
                    .record(AuditKind::PairCreated, issued.0.clone());
                Ok(issued)
            }
            None => Err(AuthError::AuthDisabled),
        }
    }

    /// Revokes a credential; `true` when the id existed. Audit records the
    /// revocation (id only, never token material).
    pub fn revoke(&self, id: &str) -> bool {
        let revoked = match &self.shared.auth {
            Some(store) => store.revoke(id),
            None => false,
        };
        if revoked {
            self.shared
                .audit
                .record(AuditKind::PairRevoked, id.to_string());
        }
        revoked
    }

    /// Current credentials (ids, labels, revocation flags — no tokens).
    pub fn credentials(&self) -> Vec<CredentialInfo> {
        match &self.shared.auth {
            Some(store) => store.list(),
            None => Vec::new(),
        }
    }

    /// A snapshot of the bounded audit log (oldest first).
    pub fn audit_events(&self) -> Vec<AuditEvent> {
        self.shared.audit.snapshot()
    }

    /// Graceful drain: stops accepting new requests, wakes every worker
    /// blocked in `recv()`, and joins the worker threads within the
    /// [`RemoteAdapterConfig::drain_timeout`] budget. In-flight requests
    /// complete before their workers exit; when the budget runs out the
    /// remaining workers are abandoned — their socket writes fail
    /// client-side once the listener is released. Returns only once the
    /// listening port is provably released (rebindable).
    ///
    /// # Errors
    ///
    /// [`AdapterError::ShutdownFailed`] when a worker panicked during the
    /// drain (an adapter-internal bug) or when the listener was not released
    /// within the drain budget (abandoned workers still hold it).
    pub fn shutdown(self) -> Result<(), AdapterError> {
        let Self {
            server,
            config,
            local_addr,
            stop,
            workers,
            shared,
        } = self;
        let deadline = Instant::now() + config.drain_timeout;

        shared.audit.record(AuditKind::Shutdown, "adapter.shutdown");
        stop.store(true, Ordering::SeqCst);
        // Each unblock() token wakes one worker blocked in recv(); the
        // workers that are mid-request finish them first (drain semantics).
        for _ in &workers {
            server.unblock();
        }
        // Drop the listener Arc now: `Server::drop` signals tiny_http's
        // accept thread (close flag + self-connect), so the listening socket
        // starts closing while the workers drain. The socket itself is owned
        // by that thread and only released when it exits, which the
        // port-release wait below observes.
        drop(server);

        let mut panicked: Option<String> = None;
        for handle in workers {
            if Instant::now() >= deadline {
                // Drain budget exhausted; abandon the rest.
                break;
            }
            while !handle.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if !handle.is_finished() {
                // This worker's in-flight request outlasted the budget;
                // abandon it (its socket writes fail once the listener is
                // released) along with any remaining workers.
                break;
            }
            if let Err(panic_payload) = handle.join() {
                let message = panic_payload
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| panic_payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "worker panicked".to_string());
                panicked = Some(message);
            }
        }

        // The accept thread exits asynchronously after Server::drop; wait
        // until the port is actually bindable again so `shutdown()` returns
        // with the listener provably released. When workers were abandoned
        // above, their Arc clones keep the Server alive and the port stays
        // bound — report that honestly instead of pretending success.
        //
        // tiny_http's `Server::drop` wakes its accept thread by connecting
        // to the bind address; that destination is INVALID on Windows for
        // unspecified binds (0.0.0.0/::), leaving the thread stuck in
        // accept() with the port held. Wake it via the loopback address of
        // the same port instead. For loopback binds `Server::drop` already
        // wakes the thread, and connecting to a dying listener can stall for
        // the OS connect timeout — so only loopback-substitute connects are
        // issued, bounded by a short timeout.
        if local_addr.ip().is_unspecified() {
            let _ = std::net::TcpStream::connect_timeout(
                &wake_addr(local_addr),
                Duration::from_millis(100),
            );
        }
        loop {
            match std::net::TcpListener::bind(local_addr) {
                Ok(probe) => {
                    drop(probe);
                    break;
                }
                Err(_err) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(err) => {
                    return Err(AdapterError::ShutdownFailed {
                        message: format!("listener not released within drain budget: {err}"),
                    })
                }
            }
        }

        match panicked {
            Some(message) => Err(AdapterError::ShutdownFailed { message }),
            None => Ok(()),
        }
    }
}

// ---------------------------------------------------------------------------
// Worker pool and routing
// ---------------------------------------------------------------------------

/// Worker body: pull requests from the shared listener until `stop` is set,
/// routing each request to the kernel. `recv()` errors only after
/// `unblock()` (shutdown) or when the accept thread dies — either way the
/// worker exits.
fn worker_loop(server: Arc<Server>, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        match server.recv() {
            Ok(request) => handle_request(&shared, request),
            Err(_) => break,
        }
    }
}

/// Routes one request: `GET /meta`, `POST /rpc`, `POST /rpc/stream`; any
/// other path is 404 NOT_FOUND and any other method on a known path is 405
/// VALIDATION. Query strings are ignored for routing.
///
/// The pairing gate (§10) is enforced BEFORE the body is read: when auth is
/// configured, a request without a valid `Authorization: Bearer <token>`
/// header is rejected with 401 `UNAUTHORIZED` without consuming the body.
/// `/meta` stays open (handshake surface, no secrets); `/rpc` and
/// `/rpc/stream` are gated.
fn handle_request(shared: &Arc<Shared>, request: Request) {
    let method = request.method().clone();
    let url = request.url().to_owned();
    let path = url.split_once('?').map_or(url.as_str(), |(p, _)| p);

    // CORS gate (§10): deny-by-default. A browser cross-origin request is
    // admitted only when its `Origin` exactly matches the configured
    // allowlist; disallowed origins get 403 before any body read or
    // dispatch. `OPTIONS` with an allowed origin answers the preflight.
    // Non-browser clients (no Origin header) are unaffected.
    let cors_origin: Option<String> = match request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Origin"))
        .map(|header| header.value.as_str().trim().to_string())
        .filter(|value| !value.is_empty())
    {
        None => None,
        Some(origin) => {
            if !shared.cors.allows(&origin) {
                shared
                    .audit
                    .record(AuditKind::OriginDenied, "origin_not_allowed");
                respond_transport_error(
                    request,
                    403,
                    "ORIGIN_NOT_ALLOWED",
                    &[("rule".to_string(), "origin_not_allowed".to_string())],
                    None,
                );
                return;
            }
            if method == Method::Options {
                respond_cors_preflight(request, &origin);
                return;
            }
            Some(origin)
        }
    };
    let origin = cors_origin.as_deref();

    match (path, method) {
        ("/meta", Method::Get) => respond_meta(shared, request, origin),
        ("/meta", _) => respond_transport_error(request, 405, "VALIDATION", &[], origin),
        ("/rpc", Method::Post) => match gate_request(shared, &request) {
            GateOutcome::Admitted(credential) => {
                respond_envelope(shared, request, false, credential, origin)
            }
            GateOutcome::Rejected { .. } => gate_respond(request, shared, origin),
        },
        ("/rpc", _) => respond_transport_error(request, 405, "VALIDATION", &[], origin),
        ("/rpc/stream", Method::Post) => match gate_request(shared, &request) {
            GateOutcome::Admitted(credential) => {
                respond_envelope(shared, request, true, credential, origin)
            }
            GateOutcome::Rejected { .. } => gate_respond(request, shared, origin),
        },
        ("/rpc/stream", _) => respond_transport_error(request, 405, "VALIDATION", &[], origin),
        _ => respond_transport_error(request, 404, "NOT_FOUND", &[], origin),
    }
}

/// Answers an `OPTIONS` preflight for an allowed origin: 204 + the CORS
/// headers a browser needs to perform the actual request. Disallowed
/// origins never reach this point (denied in [`handle_request`]).
fn respond_cors_preflight(request: Request, origin: &str) {
    let response = Response::empty(204)
        .with_header(header("Access-Control-Allow-Origin", origin))
        .with_header(header("Vary", "Origin"))
        .with_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
        .with_header(header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, Last-Event-ID",
        ))
        .with_header(header("Access-Control-Max-Age", "600"));
    let _ = request.respond(response);
}

/// Outcome of the pre-body security gate (§10): either admitted (with the
/// authenticated credential id, if any) or rejected with a transport-level
/// response (401 UNAUTHORIZED / 429 RATE_LIMITED).
enum GateOutcome {
    /// Admitted. `Some(credential_id)` when the pairing store verified the
    /// bearer token; `None` when auth is disabled.
    Admitted(Option<String>),
    /// Rejected: the request must be answered and dropped.
    Rejected {
        /// HTTP status (401 for auth, 429 for rate limit).
        status: u16,
        /// Transport error code (`UNAUTHORIZED` / `RATE_LIMITED`).
        code: &'static str,
        /// Error params (`rule` and friends).
        params: Vec<(String, String)>,
    },
}

/// Runs the pairing + rate-limit gate WITHOUT reading the request body
/// (§10: "auth проверяется до чтения body сверх минимального лимита").
///
/// Order: bearer credential check (401 before anything else), then the
/// token-bucket rate limit keyed by credential id (authed) or peer IP
/// (unauthed) — 429 `RATE_LIMITED` with `Retry-After`.
fn gate_request(shared: &Arc<Shared>, request: &Request) -> GateOutcome {
    // Pairing gate.
    let credential = match &shared.auth {
        Some(store) => {
            let header = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Authorization"));
            let token = header.and_then(|header| bearer_token(header.value.as_str()));
            match token {
                Some(token) => match store.verify(&token) {
                    Some(id) => {
                        shared.audit.record(AuditKind::AuthGranted, id.clone());
                        Some(id)
                    }
                    None => {
                        shared
                            .audit
                            .record(AuditKind::AuthDenied, "invalid_credential");
                        return GateOutcome::Rejected {
                            status: 401,
                            code: "UNAUTHORIZED",
                            params: vec![("rule".to_string(), "invalid_credential".to_string())],
                        };
                    }
                },
                None => {
                    shared
                        .audit
                        .record(AuditKind::AuthDenied, "missing_credential");
                    return GateOutcome::Rejected {
                        status: 401,
                        code: "UNAUTHORIZED",
                        params: vec![("rule".to_string(), "missing_credential".to_string())],
                    };
                }
            }
        }
        None => None,
    };

    // Rate limit: key = credential id when authed, else the client IP —
    // the peer socket IP, or the `X-Forwarded-For` value when the peer is a
    // configured trusted proxy (§10: forwarded headers are honored only
    // from configured proxy addresses).
    if let Some(limiter) = &shared.rate {
        let key = credential
            .clone()
            .unwrap_or_else(|| client_ip_for_rate_limit(request, shared));
        if limiter.allow(&key).is_err() {
            shared.audit.record(AuditKind::RateLimited, "rate_limited");
            return GateOutcome::Rejected {
                status: 429,
                code: "RATE_LIMITED",
                params: vec![
                    ("rule".to_string(), "rate_limited".to_string()),
                    ("retry_after_seconds".to_string(), "1".to_string()),
                ],
            };
        }
    }

    GateOutcome::Admitted(credential)
}

/// Answers a rejected gate outcome (401 with `WWW-Authenticate: Bearer`,
/// 429 with `Retry-After`) — transport-level, no envelope exists yet.
fn gate_respond(request: Request, shared: &Arc<Shared>, origin: Option<&str>) {
    let outcome = match gate_request(shared, &request) {
        GateOutcome::Admitted(_) => return, // not rejected; unreachable here
        GateOutcome::Rejected {
            status,
            code,
            params,
        } => (status, code, params),
    };
    let (status, code, params) = outcome;
    let mut response = json_response(
        status,
        "application/json",
        transport_error_json(code, &params),
    );
    if status == 401 {
        response = response.with_header(header("WWW-Authenticate", "Bearer"));
    }
    if status == 429 {
        response = response.with_header(header("Retry-After", "1"));
    }
    let _ = request.respond(with_cors(response, origin));
}

/// The rate-limit key for an unauthenticated request: the client IP.
///
/// The peer socket IP is used unless the peer is a configured trusted proxy
/// (§10: "forwarded client/proto headers принимаются только от configured
/// proxy addresses"). For a trusted peer the `X-Forwarded-For` chain is
/// honored — the client is the rightmost entry NOT appended by a trusted
/// proxy (multi-hop proxies append one entry each); garbage entries are
/// skipped, and a missing/unusable header falls back to the peer IP. Any
/// other peer's forwarded header is ignored entirely, so a client cannot
/// self-spoof the bucket key.
fn client_ip_for_rate_limit(request: &Request, shared: &Shared) -> String {
    let peer = request.remote_addr().map(|addr| addr.ip());
    let xff = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("X-Forwarded-For"))
        .map(|header| header.value.as_str());
    client_ip_resolve(peer, xff, &shared.trusted_proxies)
}

/// Pure resolution of the rate-limit client key. Tested directly so the
/// multi-hop chain rules are pinned without a live socket.
fn client_ip_resolve(
    peer: Option<IpAddr>,
    x_forwarded_for: Option<&str>,
    trusted: &HashSet<IpAddr>,
) -> String {
    let Some(peer) = peer else {
        return "unknown-peer".to_string();
    };
    if !trusted.contains(&peer) {
        return peer.to_string();
    }
    let Some(header) = x_forwarded_for else {
        return peer.to_string();
    };
    let entries: Vec<&str> = header
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    // Rightmost entry not appended by a trusted proxy; skip unparsable junk.
    for entry in entries.iter().rev() {
        match entry.parse::<IpAddr>() {
            Ok(ip) if trusted.contains(&ip) => continue,
            Ok(ip) => return ip.to_string(),
            Err(_) => continue,
        }
    }
    // Every entry was trusted or garbage: key by the immediate peer.
    peer.to_string()
}

/// Extracts the bearer token from an `Authorization` header value
/// (`Bearer <token>`); anything else is rejected (no scheme fallback).
fn bearer_token(value: &str) -> Option<String> {
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") || token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

/// Serves `GET /meta`: the kernel [`MetaDto`](generated::MetaDto) with the
/// schema-hash and protocol diagnostic headers. A poisoned kernel mutex is a
/// 500 `INTERNAL`, never a panic.
fn respond_meta(shared: &Arc<Shared>, request: Request, origin: Option<&str>) {
    let meta = match shared.kernel.lock() {
        Ok(guard) => serde_json::to_vec(&guard.meta()).ok(),
        Err(_) => None,
    };
    let response = match meta {
        Some(body) => json_response(200, "application/json", body)
            .with_header(header(
                "X-Neota-Schema-Hash",
                contracts_generated::contract_schema_hash(),
            ))
            .with_header(header("X-Neota-Protocol", &protocol_header_value())),
        None => json_response(
            500,
            "application/json",
            transport_error_json(
                "INTERNAL",
                &[("rule".to_string(), "kernel_unavailable".to_string())],
            ),
        ),
    };
    let _ = request.respond(with_cors(response, origin));
}

/// `"<major>.<minor>"` from the embedded contract manifest (diagnostics
/// only, §6).
fn protocol_header_value() -> String {
    let (major, minor) = contracts_generated::wire_protocol();
    format!("{major}.{minor}")
}

/// Core envelope flow shared by `POST /rpc` and `POST /rpc/stream`.
///
/// The body limit is enforced first (413 before any parse), then the
/// envelope is decoded (transport failures answer the mapped status), the
/// wire protocol is checked (426), and the request is dispatched to the
/// shared kernel. With `streaming` false the outcome is answered as a JSON
/// response envelope; with `streaming` true the operation is served as an
/// SSE stream: `generation.start`/`generation.retry` open a live stream,
/// `generation.events` resumes a durable stream from the `Last-Event-ID`
/// header or payload cursor, and every other operation answers the existing
/// `operation_not_streamable` SSE error sequence (design §6).
///
/// The auth gate ran in [`handle_request`] BEFORE this function (401/429 are
/// answered without reading the body); here the concurrent-stream cap is
/// enforced for long-lived streams (§10: bounded stream limits).
fn respond_envelope(
    shared: &Arc<Shared>,
    mut request: Request,
    streaming: bool,
    credential: Option<String>,
    origin: Option<&str>,
) {
    let max_request_bytes = shared.max_request_bytes;
    let body = match read_body_limited(&mut request, max_request_bytes) {
        Ok(body) => body,
        Err(BodyReadError::TooLarge) => {
            respond_transport_error(
                request,
                413,
                "QUOTA_EXCEEDED",
                &[
                    ("limit".to_string(), max_request_bytes.to_string()),
                    ("rule".to_string(), "request_too_large".to_string()),
                ],
                origin,
            );
            return;
        }
        Err(BodyReadError::Io) => {
            respond_transport_error(
                request,
                400,
                "CONTRACT_VIOLATION",
                &[("rule".to_string(), "body_read_failed".to_string())],
                origin,
            );
            return;
        }
    };
    let env = match neotavern_envelope::decode_request_envelope(&body) {
        Ok(env) => env,
        Err(failure) => {
            respond_envelope_failure(request, &failure, origin);
            return;
        }
    };

    if let Err((status, body)) = protocol_check_response(&env) {
        let _ = request.respond(with_cors(
            json_response(status, "application/json", body),
            origin,
        ));
        return;
    }

    let payload = match neotavern_envelope::operation_payload_bytes(&env) {
        Ok(payload) => payload,
        Err(failure) => {
            respond_envelope_failure(request, &failure, origin);
            return;
        }
    };

    // Unary `/rpc`: the outcome is a plain JSON response envelope. The
    // kernel mutex is held only for the single dispatch.
    if !streaming {
        let guard = match shared.kernel.lock() {
            Ok(guard) => guard,
            Err(_) => {
                // Poisoned mutex: the kernel state is unknown — answer with
                // a controlled INTERNAL envelope instead of panicking.
                respond_kernel_poisoned(request, &env.request_id, false, origin);
                return;
            }
        };
        let answer = match guard.dispatch(&env.operation_id, &payload, &CancellationFlag::new()) {
            Ok(result_bytes) => match serde_json::from_slice::<serde_json::Value>(&result_bytes) {
                Ok(result) => {
                    match neotavern_envelope::build_ok_response(&env.request_id, result) {
                        Ok(body) => EnvelopeAnswer::Json(body),
                        Err(_) => EnvelopeAnswer::Json(error_envelope_body(
                            &env.request_id,
                            "INTERNAL",
                            &[("rule".to_string(), "envelope_build_failed".to_string())],
                        )),
                    }
                }
                // The kernel's result bytes are its own DTO serialization; a
                // parse failure is an internal bug, never a payload issue.
                Err(_) => EnvelopeAnswer::Json(error_envelope_body(
                    &env.request_id,
                    "INTERNAL",
                    &[("rule".to_string(), "result_json_parse_failed".to_string())],
                )),
            },
            Err(err) => EnvelopeAnswer::Json(neotavern_envelope::kernel_error_envelope(
                &err,
                &env.request_id,
            )),
        };
        send_answer(request, &env.request_id, answer, origin);
        return;
    }

    // Streaming `/rpc/stream`: generation.start/retry are LIVE streams
    // (design §6), generation.events is a durable RESUME; every other
    // operation keeps the Phase 4 `operation_not_streamable` answer.
    match env.operation_id.as_str() {
        "generation.start" | "generation.retry" | "generation.events" => {
            // Concurrent-stream cap (§10): a worker is held for the whole
            // stream, so bound how many can be open at once.
            let previous = shared.streams.fetch_add(1, Ordering::SeqCst);
            if previous >= shared.max_streams {
                shared.streams.fetch_sub(1, Ordering::SeqCst);
                shared
                    .audit
                    .record(AuditKind::StreamLimitReached, "stream_limit");
                respond_transport_error(
                    request,
                    429,
                    "RATE_LIMITED",
                    &[
                        ("rule".to_string(), "stream_limit".to_string()),
                        ("max_streams".to_string(), shared.max_streams.to_string()),
                    ],
                    origin,
                );
                return;
            }
            let _stream_slot = StreamSlot {
                streams: &shared.streams,
            };
            respond_generation_stream(shared, request, &env, &payload, credential, origin);
        }
        _ => respond_stream_unavailable(shared, request, &env, &payload, origin),
    }
}

/// RAII release for the concurrent-stream counter.
struct StreamSlot<'a> {
    streams: &'a AtomicUsize,
}

impl Drop for StreamSlot<'_> {
    fn drop(&mut self) {
        self.streams.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Dispatches the three streaming operations through the shared kernel.
fn respond_generation_stream(
    shared: &Arc<Shared>,
    request: Request,
    env: &generated::RequestEnvelope,
    payload: &[u8],
    credential: Option<String>,
    origin: Option<&str>,
) {
    match env.operation_id.as_str() {
        "generation.start" | "generation.retry" => {
            respond_generation_live(shared, request, env, payload, credential, origin)
        }
        "generation.events" => {
            respond_generation_resume(shared, request, env, payload, credential, origin)
        }
        _ => respond_stream_unavailable(shared, request, env, payload, origin),
    }
}

// ---------------------------------------------------------------------------
// Streaming generation responses (Phase 6, design §6)
// ---------------------------------------------------------------------------

/// How long each polling iteration waits for a stream notice (live mode) or
/// sleeps (resume mode) before re-dispatching `generation.events`.
const STREAM_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Maximum `generation.events` items fetched per poll (design §6: bounded
/// memory — one ≤200-event batch in flight).
const STREAM_PAGE_LIMIT: i64 = 200;

/// Event types that terminate a generation stream (design §6). The executor
/// always emits exactly one of these as its final durable event.
const STREAM_TERMINAL_TYPES: [&str; 3] = [
    "generation.completed",
    "generation.failed",
    "generation.cancelled",
];

/// Serves a LIVE SSE stream for `generation.start` / `generation.retry`.
///
/// The kernel opens the stream under a SHORT lock ([`Kernel::dispatch_stream`]
/// runs until the run is created and the executor starts); then this worker
/// writes SSE frames pulled from the durable `generation.events` log — the
/// kernel mutex is taken only for each short poll dispatch, never across the
/// 250ms waits. The stream ends after the terminal event with a
/// `stream.closed` frame; a client write error drops the stream without
/// cancelling the executor (the run is durable, design §6).
fn respond_generation_live(
    shared: &Arc<Shared>,
    request: Request,
    env: &generated::RequestEnvelope,
    payload: &[u8],
    credential: Option<String>,
    origin: Option<&str>,
) {
    let cancel = CancellationFlag::new();
    let stream = match shared.kernel.lock() {
        Ok(guard) => match guard.dispatch_stream(&env.operation_id, payload, &cancel) {
            Ok(stream) => stream,
            Err(err) => {
                send_answer(
                    request,
                    &env.request_id,
                    EnvelopeAnswer::Sse(neotavern_envelope::kernel_error_envelope(
                        &err,
                        &env.request_id,
                    )),
                    origin,
                );
                return;
            }
        },
        Err(_) => {
            respond_kernel_poisoned(request, &env.request_id, true, origin);
            return;
        }
    };
    let stream_id = stream.stream_id().to_string();
    let poll_dto = generated::RequestListGenerationEvents {
        workflow_id: stream_id.clone(),
        after_sequence: Some(-1),
        limit: Some(STREAM_PAGE_LIMIT),
    };
    respond_sse_stream(
        request,
        StreamingResponseReader {
            kernel: Arc::clone(&shared.kernel),
            stream: Some(stream),
            workflow_id: stream_id,
            request_id: env.request_id.clone(),
            poll_dto,
            last_sent: -1,
            cancel,
            pending: String::new(),
            finished: false,
            terminal: false,
            auth: auth_recheck(shared, credential),
        },
        origin,
    );
}

/// Serves a RESUME SSE stream for `generation.events` (design §6).
///
/// The initial cursor comes from the `Last-Event-ID` header when present,
/// otherwise from the request payload's `afterSequence` (the kernel defaults
/// to `-1`). With no stream handle, the server polls the durable event log
/// every 250ms until a terminal event is emitted, then writes
/// `stream.closed`. A run that already reached its terminal event (resume
/// past the log head) closes immediately via its `generation.get` status.
fn respond_generation_resume(
    shared: &Arc<Shared>,
    request: Request,
    env: &generated::RequestEnvelope,
    payload: &[u8],
    credential: Option<String>,
    origin: Option<&str>,
) {
    let header_cursor = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Last-Event-ID"))
        .and_then(|header| sse::parse_last_event_id(Some(header.value.as_str())));
    let decoded = match generated::decode_request_list_generation_events(payload) {
        Ok(dto) => dto,
        Err(wire) => {
            // Same contract-violation envelope the kernel would answer for a
            // malformed unary `generation.events` payload.
            let err = KernelError::from(wire);
            send_answer(
                request,
                &env.request_id,
                EnvelopeAnswer::Sse(neotavern_envelope::kernel_error_envelope(
                    &err,
                    &env.request_id,
                )),
                origin,
            );
            return;
        }
    };
    // The header cursor is a u64 per the SSE spec; the wire `afterSequence`
    // is an i64. Saturate an over-wide header instead of panicking.
    let cursor = header_cursor
        .map(|header| i64::try_from(header).unwrap_or(i64::MAX))
        .unwrap_or_else(|| decoded.after_sequence.unwrap_or(-1));
    let poll_dto = generated::RequestListGenerationEvents {
        workflow_id: decoded.workflow_id.clone(),
        after_sequence: Some(cursor),
        limit: Some(STREAM_PAGE_LIMIT),
    };
    respond_sse_stream(
        request,
        StreamingResponseReader {
            kernel: Arc::clone(&shared.kernel),
            stream: None,
            workflow_id: decoded.workflow_id,
            request_id: env.request_id.clone(),
            poll_dto,
            last_sent: cursor,
            cancel: CancellationFlag::new(),
            pending: String::new(),
            finished: false,
            terminal: false,
            auth: auth_recheck(shared, credential),
        },
        origin,
    );
}

/// The per-stream credential re-check state: `Some((store, id))` when auth
/// is enabled (the gate guarantees a live credential at open time); `None`
/// when auth is disabled. The reader re-validates liveness on every poll
/// batch so revocation terminates long-lived streams (§10).
fn auth_recheck(
    shared: &Arc<Shared>,
    credential: Option<String>,
) -> Option<(Arc<PairingStore>, String)> {
    match (&shared.auth, credential) {
        (Some(store), Some(id)) => Some((Arc::clone(store), id)),
        _ => None,
    }
}

/// `/rpc/stream` for a non-streamable operation (design §6: "any other op →
/// existing 400 `operation_not_streamable`"): the operation still dispatches
/// (Phase 4 semantics — the 24 Phase 4 scenarios lock this in), then the
/// adapter answers the SSE error sequence classifying it as not streamable.
fn respond_stream_unavailable(
    shared: &Arc<Shared>,
    request: Request,
    env: &generated::RequestEnvelope,
    payload: &[u8],
    origin: Option<&str>,
) {
    let guard = match shared.kernel.lock() {
        Ok(guard) => guard,
        Err(_) => {
            respond_kernel_poisoned(request, &env.request_id, true, origin);
            return;
        }
    };
    let answer = match guard.dispatch(&env.operation_id, payload, &CancellationFlag::new()) {
        Ok(_) => {
            let (code, rule) =
                match neotavern_envelope::operation_event_schema_id(&env.operation_id) {
                    // A manifest-streamable operation executed — unreachable:
                    // generation.start/retry are handled in the streaming branch
                    // above and no other frozen op declares an event schema.
                    Some(_) => ("INTERNAL", "streaming_unimplemented"),
                    None => ("CONTRACT_VIOLATION", "operation_not_streamable"),
                };
            let mut params = vec![("rule".to_string(), rule.to_string())];
            if code == "CONTRACT_VIOLATION" {
                params.push(("operationId".to_string(), env.operation_id.clone()));
            }
            EnvelopeAnswer::Sse(error_envelope_body(&env.request_id, code, &params))
        }
        Err(err) => EnvelopeAnswer::Sse(neotavern_envelope::kernel_error_envelope(
            &err,
            &env.request_id,
        )),
    };
    send_answer(request, &env.request_id, answer, origin);
}

/// Answers an INTERNAL error envelope when the kernel mutex is poisoned.
fn respond_kernel_poisoned(
    request: Request,
    request_id: &str,
    streaming: bool,
    origin: Option<&str>,
) {
    let body = error_envelope_body(
        request_id,
        "INTERNAL",
        &[("rule".to_string(), "kernel_poisoned".to_string())],
    );
    let answer = if streaming {
        EnvelopeAnswer::Sse(body)
    } else {
        EnvelopeAnswer::Json(body)
    };
    send_answer(request, request_id, answer, origin);
}

/// Answers an SSE stream from a [`StreamingResponseReader`]: HTTP 200
/// `text/event-stream`, chunked, written directly to the connection.
///
/// tiny_http's `respond` path buffers a chunked body entirely (its chunked
/// encoder only flushes once the buffer fills or the response ends), which
/// would defeat live SSE — so the streaming responses take raw control of
/// the socket via [`Request::into_writer`] and flush every frame. This
/// worker blocks until the stream closes (terminal frame) or the client
/// disconnects; the reader drives the polling loop.
fn respond_sse_stream(request: Request, mut reader: StreamingResponseReader, origin: Option<&str>) {
    let mut writer = request.into_writer();
    let cors_head = match origin {
        Some(origin) => format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"),
        None => String::new(),
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n{cors_head}\r\n"
    );
    if writer
        .write_all(head.as_bytes())
        .and_then(|()| writer.flush())
        .is_err()
    {
        // Client gone before the head: nothing to stream.
        return;
    }
    loop {
        reader.produce_next_batch();
        let frames = reader.drain_pending();
        if !frames.is_empty() {
            // One RFC 7230 chunk per frame batch; flushed immediately so the
            // client observes deltas as they commit (not at stream end).
            let mut chunk = String::with_capacity(frames.len() + 16);
            chunk.push_str(&format!("{:x}\r\n", frames.len()));
            chunk.push_str(&frames);
            chunk.push_str("\r\n");
            if writer
                .write_all(chunk.as_bytes())
                .and_then(|()| writer.flush())
                .is_err()
            {
                // Client write error: drop the stream. The executor keeps
                // running — the run is durable (design §6).
                return;
            }
        }
        if reader.is_finished() {
            break;
        }
    }
    // Terminal chunk; dropping the writer releases the connection.
    let _ = writer.write_all(b"0\r\n\r\n");
    let _ = writer.flush();
    drop(writer);
}

/// Streaming SSE body producer for generation streams (design §6).
///
/// [`produce_next_batch`](Self::produce_next_batch) runs one poll: pace
/// (stream notice in live mode, sleep in resume mode) → dispatch
/// `generation.events` under a SHORT kernel lock → append `event:` frames
/// with the event envelope JSON as `data:` → after the terminal event append
/// the `stream.closed` frame and finish. The durable log is the source of
/// truth; the stream handle (live mode) only paces the loop.
///
/// The kernel mutex is never held across a wait, and every payload-driven
/// path answers a controlled frame instead of panicking (design §9: no
/// unwrap/expect/panic on transport payload).
struct StreamingResponseReader {
    /// The shared kernel, re-locked for every short `generation.events` poll.
    kernel: Arc<Mutex<Kernel>>,
    /// Live stream handle (`generation.start`/`generation.retry`); `None`
    /// in resume mode (no stream handle exists for a replay).
    stream: Option<EventStream>,
    /// The generation run id (== stream id).
    workflow_id: String,
    /// The request id echoed in any error-envelope frame.
    request_id: String,
    /// `generation.events` request template; `after_sequence` is updated to
    /// [`Self::last_sent`] before every poll dispatch.
    poll_dto: generated::RequestListGenerationEvents,
    /// Highest event sequence already written; the next poll asks for more.
    last_sent: i64,
    /// Cancellation flag shared by the poll dispatches (never cancelled by
    /// the adapter — cancel is its own unary operation).
    cancel: CancellationFlag,
    /// SSE frames produced by polls but not yet written to the socket.
    pending: String,
    /// `stream.closed` produced; the stream is complete.
    finished: bool,
    /// A terminal generation event was written; the stream must close.
    terminal: bool,
    /// Per-stream credential re-check: `Some((store, credential_id))` when
    /// auth is enabled; the poll loop re-validates liveness every batch so
    /// revocation terminates the stream (§10).
    auth: Option<(Arc<PairingStore>, String)>,
}

impl StreamingResponseReader {
    /// One poll iteration: pace, then dispatch `generation.events` under a
    /// short lock and append the resulting frames to [`Self::pending`].
    fn produce_next_batch(&mut self) {
        // Credential liveness re-check (§10: SSE re-validates the credential;
        // a revoked credential terminates long-lived streams).
        if let Some((store, id)) = &self.auth {
            if !store.is_live(id) {
                let body = transport_error_json(
                    "UNAUTHORIZED",
                    &[("rule".to_string(), "credential_revoked".to_string())],
                );
                self.pending.push_str(&sse::encode_frame(&SseFrame {
                    event: "error".to_string(),
                    id: Some(self.next_sequence()),
                    data: String::from_utf8_lossy(&body).into_owned(),
                }));
                self.close_stream();
                return;
            }
        }

        // Pace: in live mode wait for the next commit notice (or the poll
        // timeout); in resume mode sleep a fixed interval. Notices coalesce;
        // the durable log is authoritative. `session_ended` records whether
        // the kernel's stream session terminated — terminal (completed /
        // failed / cancelled) OR durably waiting for a tool result (§8.3) —
        // which closes the SSE stream after the final drain; waiting runs
        // are then followed via `generation.events` / `generation.get`.
        let session_ended = match &mut self.stream {
            Some(stream) => {
                let started = Instant::now();
                let notice = stream.next_notice(STREAM_POLL_INTERVAL);
                if notice.is_none() && started.elapsed() < STREAM_POLL_INTERVAL / 2 {
                    // The notice channel closed WITHOUT a terminal notice
                    // (the kernel writer thread died mid-run, so no more
                    // events will ever commit). `next_notice` returns None
                    // instantly after a close — pace the final polls instead
                    // of hot-spinning on an unrecoverable stream.
                    thread::sleep(STREAM_POLL_INTERVAL);
                }
                matches!(notice, Some(StreamNotice::Terminal { .. }))
            }
            // Resume mode: no stream handle — poll the durable log directly.
            None => {
                thread::sleep(STREAM_POLL_INTERVAL);
                false
            }
        };

        match self.poll_events() {
            Ok(page) => {
                let was_empty = page.items.is_empty();
                for item in page.items {
                    self.pending.push_str(&sse::encode_envelope_frame(&item));
                    self.last_sent = item.sequence;
                    if STREAM_TERMINAL_TYPES.contains(&item.r#type.as_str()) {
                        self.terminal = true;
                    }
                }
                if self.terminal {
                    self.close_stream();
                } else if session_ended {
                    // The run's stream session ended without a terminal event
                    // type (durable `waiting_for_tool`): this page was the
                    // final drain — close with `stream.closed`.
                    self.close_stream();
                } else if self.stream.is_none() && was_empty && self.run_finished() {
                    // Resume at/after the terminal event: the log holds no
                    // more events and the run will never emit one — close
                    // without a duplicate event frame.
                    self.close_stream();
                }
            }
            Err(err) => {
                // The stream cannot continue (e.g. kernel shutting down or a
                // poll decode invariant broke). Answer a controlled error
                // frame + terminal instead of hanging the worker.
                self.pending.push_str(&sse::encode_frame(&SseFrame {
                    event: "error".to_string(),
                    id: Some(self.next_sequence()),
                    data: String::from_utf8(neotavern_envelope::kernel_error_envelope(
                        &err,
                        &self.request_id,
                    ))
                    .unwrap_or_default(),
                }));
                self.close_stream();
            }
        }
    }

    /// Takes the produced SSE bytes for writing.
    fn drain_pending(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }

    /// Whether the terminal frame has been produced.
    fn is_finished(&self) -> bool {
        self.finished
    }

    /// Dispatches `generation.events` under one short kernel lock and
    /// decodes the paged result.
    fn poll_events(&mut self) -> Result<generated::PagedGenerationEvents, KernelError> {
        self.poll_dto.after_sequence = Some(self.last_sent);
        let payload = serde_json::to_vec(&self.poll_dto).map_err(|_| {
            KernelError::with_params(
                KernelErrorCode::Internal,
                "failed to serialize generation.events poll",
                Vec::new(),
            )
        })?;
        let guard = self.kernel.lock().map_err(|_| {
            KernelError::with_params(
                KernelErrorCode::Internal,
                "kernel mutex poisoned during stream poll",
                Vec::new(),
            )
        })?;
        let bytes = guard.dispatch("generation.events", &payload, &self.cancel)?;
        // The kernel built the DTO; a decode failure is an internal bug.
        generated::decode_paged_generation_events(&bytes).map_err(|_| {
            KernelError::with_params(
                KernelErrorCode::Internal,
                "generation.events poll result failed to decode",
                Vec::new(),
            )
        })
    }

    /// Whether the run is in a state that will never emit more events
    /// (resume mode only, consulted when a poll came back empty).
    fn run_finished(&self) -> bool {
        let payload = match serde_json::to_vec(&generated::RequestGetGenerationRun {
            workflow_id: self.workflow_id.clone(),
        }) {
            Ok(bytes) => bytes,
            Err(_) => return false,
        };
        let guard = match self.kernel.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        let bytes = match guard.dispatch("generation.get", &payload, &self.cancel) {
            Ok(bytes) => bytes,
            Err(_) => return false,
        };
        match generated::decode_generation_run(&bytes) {
            Ok(run) => matches!(
                run.status,
                generated::GenerationStatus::Completed
                    | generated::GenerationStatus::Failed
                    | generated::GenerationStatus::Cancelled
                    | generated::GenerationStatus::Interrupted
            ),
            Err(_) => false,
        }
    }

    /// Appends the `stream.closed` terminal frame and marks the stream done.
    fn close_stream(&mut self) {
        self.pending.push_str(&sse::encode_terminal_frame(
            &self.workflow_id,
            self.next_sequence(),
            "stream.closed",
            serde_json::json!({}),
        ));
        self.finished = true;
    }

    /// The next sequence number to hand out: one past the last written event.
    fn next_sequence(&self) -> u64 {
        u64::try_from(self.last_sent.saturating_add(1)).unwrap_or(u64::MAX)
    }
}

/// Applies the wire-protocol check; `Ok(())` when compatible, otherwise the
/// HTTP status (426) and the PROTOCOL_MISMATCH error-envelope body.
fn protocol_check_response(env: &generated::RequestEnvelope) -> Result<(), (u16, Vec<u8>)> {
    match neotavern_envelope::check_protocol(env) {
        ProtocolVerdict::Compatible => Ok(()),
        ProtocolVerdict::MajorMismatch {
            client_major,
            server_major,
        } => Err((
            426,
            error_envelope_body(
                &env.request_id,
                "PROTOCOL_MISMATCH",
                &[
                    ("client_major".to_string(), client_major.to_string()),
                    ("server_major".to_string(), server_major.to_string()),
                ],
            ),
        )),
        ProtocolVerdict::MinorTooNew {
            client_minor,
            server_minor,
        } => Err((
            426,
            error_envelope_body(
                &env.request_id,
                "PROTOCOL_MISMATCH",
                &[
                    ("client_minor".to_string(), client_minor.to_string()),
                    ("server_minor".to_string(), server_minor.to_string()),
                ],
            ),
        )),
    }
}

/// The address used to wake tiny_http's accept thread during shutdown: the
/// bind address itself, except for unspecified binds (0.0.0.0/::) where the
/// loopback address of the same port is used (connecting to an unspecified
/// destination is invalid on Windows).
fn wake_addr(local: SocketAddr) -> SocketAddr {
    match local.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => {
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), local.port())
        }
        IpAddr::V6(ip) if ip.is_unspecified() => {
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), local.port())
        }
        _ => local,
    }
}

// ---------------------------------------------------------------------------
// Request body limiting
// ---------------------------------------------------------------------------

/// Why reading the request body failed.
enum BodyReadError {
    /// The body exceeds the configured limit.
    TooLarge,
    /// The connection failed mid-read.
    Io,
}

/// Reads the request body enforcing
/// [`RemoteAdapterConfig::max_request_bytes`].
///
/// With a parseable Content-Length the header is compared BEFORE any read;
/// otherwise (chunked or absent length) at most `max_request_bytes + 1`
/// bytes are read and the body is rejected when more are available (§8).
fn read_body_limited(
    request: &mut Request,
    max_request_bytes: u64,
) -> Result<Vec<u8>, BodyReadError> {
    // Per RFC 7230 §3.3.3, Content-Length must be ignored when a
    // Transfer-Encoding is present (tiny_http applies the same rule).
    let transfer_encoded = request
        .headers()
        .iter()
        .any(|header| header.field.equiv("Transfer-Encoding"));
    let content_length = if transfer_encoded {
        None
    } else {
        request
            .headers()
            .iter()
            .find(|header| header.field.equiv("Content-Length"))
            .and_then(|header| header.value.as_str().parse::<u64>().ok())
    };

    if let Some(length) = content_length {
        if length > max_request_bytes {
            return Err(BodyReadError::TooLarge);
        }
        let capacity = usize::try_from(length).map_err(|_| BodyReadError::TooLarge)?;
        let mut body = vec![0u8; capacity];
        request
            .as_reader()
            .read_exact(&mut body)
            .map_err(|_| BodyReadError::Io)?;
        return Ok(body);
    }

    let mut body: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let remaining = max_request_bytes
            .saturating_add(1)
            .saturating_sub(body.len() as u64);
        let want = usize::try_from(remaining)
            .unwrap_or(chunk.len())
            .min(chunk.len());
        let read = request
            .as_reader()
            .read(&mut chunk[..want])
            .map_err(|_| BodyReadError::Io)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
        if body.len() as u64 > max_request_bytes {
            return Err(BodyReadError::TooLarge);
        }
    }
    Ok(body)
}

// ---------------------------------------------------------------------------
// Response building
// ---------------------------------------------------------------------------

/// How to answer a processed envelope: as a plain JSON response envelope
/// (`/rpc`) or as an SSE error frame sequence (`/rpc/stream`, Phase 4).
enum EnvelopeAnswer {
    /// HTTP 200 + `application/json` envelope body.
    Json(Vec<u8>),
    /// HTTP 200 + `text/event-stream` with an `error` frame and a terminal
    /// `stream.closed` frame.
    Sse(Vec<u8>),
}

/// Sends the prepared envelope answer.
fn send_answer(request: Request, request_id: &str, answer: EnvelopeAnswer, origin: Option<&str>) {
    match answer {
        EnvelopeAnswer::Json(body) => {
            let _ = request.respond(with_cors(
                json_response(200, "application/json", body),
                origin,
            ));
        }
        EnvelopeAnswer::Sse(body) => respond_sse_error(request, request_id, body, origin),
    }
}

/// Answers with `text/event-stream`: one `error` frame carrying the error
/// envelope JSON, then the terminal `stream.closed` frame (§7).
fn respond_sse_error(
    request: Request,
    request_id: &str,
    error_body: Vec<u8>,
    origin: Option<&str>,
) {
    // Envelope bodies are built by this adapter (or the kernel) as JSON, so
    // they are always UTF-8 (program invariant).
    let error_text =
        String::from_utf8(error_body).expect("envelope bodies are adapter-built UTF-8 JSON");
    let body = format!(
        "{}{}",
        sse::encode_frame(&SseFrame {
            event: "error".to_string(),
            id: Some(0),
            data: error_text,
        }),
        sse::encode_terminal_frame(request_id, 1, "stream.closed", serde_json::json!({})),
    );
    let _ = request.respond(with_cors(
        json_response(200, "text/event-stream", body.into_bytes()),
        origin,
    ));
}

/// Builds a validated error-envelope body; on an internal build failure
/// (unreachable for validated request ids and plain string params) falls
/// back to a transport-level INTERNAL JSON body.
fn error_envelope_body(request_id: &str, code: &str, params: &[(String, String)]) -> Vec<u8> {
    match neotavern_envelope::build_error_response(request_id, code, params.to_vec()) {
        Ok(body) => body,
        Err(_) => transport_error_json(
            "INTERNAL",
            &[("rule".to_string(), "envelope_build_failed".to_string())],
        ),
    }
}

/// Builds the transport-level error body — no requestId, because no usable
/// envelope exists yet: `{"kind":"error","error":{"code":...,"params":{...}}}`.
fn transport_error_json(code: &str, params: &[(String, String)]) -> Vec<u8> {
    let params_value: serde_json::Map<String, serde_json::Value> = params
        .iter()
        .map(|(key, value)| (key.clone(), serde_json::Value::String(value.clone())))
        .collect();
    let envelope = serde_json::json!({
        "kind": "error",
        "error": { "code": code, "params": params_value },
    });
    envelope.to_string().into_bytes()
}

/// Answers a transport-level failure: an HTTP status with the error JSON
/// body (400/404/405/413/426/500 — no response envelope exists yet).
fn respond_transport_error(
    request: Request,
    status: u16,
    code: &str,
    params: &[(String, String)],
    origin: Option<&str>,
) {
    let response = json_response(
        status,
        "application/json",
        transport_error_json(code, params),
    );
    let _ = request.respond(with_cors(response, origin));
}

/// Answers an envelope decode failure with the status/code/params carried by
/// the [`EnvelopeFailure`].
fn respond_envelope_failure(request: Request, failure: &EnvelopeFailure, origin: Option<&str>) {
    respond_transport_error(
        request,
        failure.http_status,
        failure.code,
        &failure.params,
        origin,
    );
}

/// A response with an explicit status and content type.
fn json_response(
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
) -> Response<Cursor<Vec<u8>>> {
    Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
}

/// Appends the CORS headers a browser needs to read the response when the
/// request origin is explicitly allowed. `None` (no `Origin` header /
/// non-browser client) leaves the response untouched; disallowed origins
/// never reach a responder (they are 403'd in [`handle_request`]).
fn with_cors(
    response: Response<Cursor<Vec<u8>>>,
    origin: Option<&str>,
) -> Response<Cursor<Vec<u8>>> {
    match origin {
        Some(origin) => response
            .with_header(header("Access-Control-Allow-Origin", origin))
            .with_header(header("Vary", "Origin")),
        None => response,
    }
}

/// Builds a response header from ASCII input. Infallible because every
/// header this adapter emits is fixed ASCII (tiny_http rejects non-ASCII
/// header names and values).
fn header(name: &'static str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("header names/values are ASCII literals (program invariant)")
}

#[cfg(test)]
mod tests {
    use super::wake_addr;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    fn v4(octets: [u8; 4], port: u16) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::from(octets)), port)
    }

    fn v6(segments: [u16; 8], port: u16) -> SocketAddr {
        SocketAddr::new(IpAddr::V6(Ipv6Addr::from(segments)), port)
    }

    #[test]
    fn wake_addr_passes_loopback_and_specific_binds_through() {
        assert_eq!(
            wake_addr(v4([127, 0, 0, 1], 8080)),
            v4([127, 0, 0, 1], 8080)
        );
        assert_eq!(
            wake_addr(v4([192, 168, 1, 10], 8080)),
            v4([192, 168, 1, 10], 8080)
        );
        assert_eq!(
            wake_addr(v6([0, 0, 0, 0, 0, 0, 0, 1], 8080)),
            v6([0, 0, 0, 0, 0, 0, 0, 1], 8080)
        );
    }

    #[test]
    fn wake_addr_substitutes_loopback_for_unspecified_binds() {
        // 0.0.0.0 → 127.0.0.1, same port.
        assert_eq!(wake_addr(v4([0, 0, 0, 0], 9000)), v4([127, 0, 0, 1], 9000));
        // :: → ::1, same port.
        assert_eq!(
            wake_addr(v6([0, 0, 0, 0, 0, 0, 0, 0], 9000)),
            v6([0, 0, 0, 0, 0, 0, 0, 1], 9000)
        );
    }

    #[test]
    fn protocol_header_value_matches_manifest() {
        let (major, minor) = contracts_generated::wire_protocol();
        assert_eq!(super::protocol_header_value(), format!("{major}.{minor}"));
    }

    fn trusted(ips: &[&str]) -> std::collections::HashSet<IpAddr> {
        ips.iter()
            .map(|ip| ip.parse().expect("test IP parses"))
            .collect()
    }

    #[test]
    fn client_ip_ignores_forwarded_headers_from_untrusted_peers() {
        let peer = v4([127, 0, 0, 1], 5555).ip();
        // Untrusted peer: X-Forwarded-For must be ignored entirely — a
        // client cannot self-spoof the rate-limit bucket key.
        assert_eq!(
            super::client_ip_resolve(Some(peer), Some("203.0.113.9"), &trusted(&[])),
            "127.0.0.1"
        );
    }

    #[test]
    fn client_ip_uses_forwarded_chain_from_trusted_peer() {
        let proxy = v4([10, 0, 0, 1], 80).ip();
        let allowed = trusted(&["10.0.0.1"]);
        // Single trusted proxy appended the client IP.
        assert_eq!(
            super::client_ip_resolve(Some(proxy), Some("203.0.113.9"), &allowed),
            "203.0.113.9"
        );
        // Multi-hop: two trusted proxies append one entry each; the client
        // is the rightmost entry NOT appended by a trusted proxy.
        let chain = trusted(&["10.0.0.1", "10.0.0.2"]);
        assert_eq!(
            super::client_ip_resolve(Some(proxy), Some("203.0.113.9, 10.0.0.2"), &chain),
            "203.0.113.9"
        );
    }

    #[test]
    fn client_ip_falls_back_to_peer_on_garbage_or_missing_chain() {
        let proxy = v4([10, 0, 0, 1], 80).ip();
        let allowed = trusted(&["10.0.0.1"]);
        // Missing header → peer.
        assert_eq!(
            super::client_ip_resolve(Some(proxy), None, &allowed),
            "10.0.0.1"
        );
        // Garbage entries are skipped; nothing usable → peer.
        assert_eq!(
            super::client_ip_resolve(Some(proxy), Some("not-an-ip, , 1.2.3"), &allowed),
            "10.0.0.1"
        );
        // Every entry was appended by a trusted proxy (no client entry):
        // key by the immediate peer rather than guessing.
        assert_eq!(
            super::client_ip_resolve(Some(proxy), Some("10.0.0.1"), &allowed),
            "10.0.0.1"
        );
        // No peer at all → stable fallback key.
        assert_eq!(
            super::client_ip_resolve(None, Some("203.0.113.9"), &allowed),
            "unknown-peer"
        );
    }
}
