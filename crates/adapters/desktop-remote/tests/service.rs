//! Integration tests for the Desktop Remote Access host service (Phase 9).
//!
//! Every scenario drives a REAL stateless [`runtime_kernel::Kernel`]
//! (`data_root: None`) wrapped in `Arc<Mutex<Kernel>>` exactly like the
//! local hosts hold it, with the service bound to an ephemeral loopback
//! port. The HTTP client is a deliberately tiny std-only implementation
//! (`TcpStream` + manual request writing + read-to-close) mirroring the
//! `remote-http-adapter` integration-test helper, so this crate adds no test
//! dependencies beyond `tempfile` and `contracts-generated`.
//!
//! Kernel dispatch mirrors `tauri-local`'s `dispatch_envelope`: the same
//! `kernel.lock() -> guard.dispatch(operation_id, payload,
//! CancellationFlag::new())` call the local IPC adapter makes.

use neotavern_desktop_remote::{RemoteAccessConfig, RemoteAccessService, ServiceError};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/// Opens the same stateless kernel the local hosts use: expected schema hash
/// from the embedded manifest, FFI ABI version from runtime-kernel, no data
/// root (meta.get and providers.list work without durable storage).
fn test_kernel() -> Arc<Mutex<Kernel>> {
    let kernel = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
        data_root: None,
    })
    .expect("stateless kernel opens");
    Arc::new(Mutex::new(kernel))
}

/// A config file path inside a fresh temp dir, kept alive for the test.
fn config_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir for config");
    let path = dir.path().join("remote-access.json");
    (dir, path)
}

/// Builds a `wire.request.envelope` body for the embedded protocol version,
/// mirroring `tauri-local::build_request_envelope` (§6.3).
fn envelope_body(request_id: &str, operation_id: &str, payload: Value) -> Vec<u8> {
    let (major, minor) = contracts_generated::wire_protocol();
    let envelope = json!({
        "wireProtocol": { "major": major, "minor": minor },
        "schemaHash": contracts_generated::contract_schema_hash(),
        "requestId": request_id,
        "operationId": operation_id,
        "payload": payload,
    });
    serde_json::to_vec(&envelope).expect("envelope serializes")
}

// ---------------------------------------------------------------------------
// Minimal std-only HTTP client (mirrors remote-http's test helper)
// ---------------------------------------------------------------------------

/// A parsed HTTP response.
struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    /// First header value matching `name` (case-insensitive).
    #[allow(dead_code)]
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// The `kind` field of a JSON body, if any.
    fn body_kind(&self) -> Option<String> {
        serde_json::from_slice::<Value>(&self.body)
            .ok()
            .and_then(|value| value.get("kind").and_then(Value::as_str).map(String::from))
    }
}

/// Sends one HTTP/1.1 request with a Content-Length body and `Connection:
/// close`, returning the parsed response.
fn http_request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> HttpResponse {
    let mut stream = TcpStream::connect(addr).expect("connect to the adapter");
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .expect("set read timeout");

    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (key, value) in headers {
        request.push_str(&format!("{key}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .expect("write the request head");

    // The adapter may answer (e.g. 401/413) and close before the whole body
    // is sent; a failing body write must not mask the response.
    if !body.is_empty() {
        let _ = stream.write_all(body);
    }

    let raw = read_response(&mut stream).expect("read the response");
    parse_response(&raw)
}

/// Reads until EOF or until a Content-Length-delimited body is complete,
/// retrying on read timeouts instead of sleeping (deterministic).
fn read_response(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let mut stalled = 0u32;
    loop {
        if body_complete(&raw) {
            return Ok(raw);
        }
        match stream.read(&mut buf) {
            Ok(0) => return Ok(raw),
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                stalled = 0;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                stalled += 1;
                if stalled > 20 {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "server did not finish the response",
                    ));
                }
            }
            Err(e) => return Err(e),
        }
    }
}

/// True once a full Content-Length-delimited response has been read.
fn body_complete(raw: &[u8]) -> bool {
    let head_end = find_subslice(raw, b"\r\n\r\n");
    let Some(head_end) = head_end else {
        return false;
    };
    let head = std::str::from_utf8(&raw[..head_end]).unwrap_or("");
    for line in head.lines().rev() {
        if let Some(value) = line.strip_prefix("Content-Length:") {
            if let Ok(len) = value.trim().parse::<usize>() {
                return raw.len() >= head_end + 4 + len;
            }
        }
    }
    false
}

/// Splits raw response bytes into status, headers and body.
fn parse_response(raw: &[u8]) -> HttpResponse {
    let head_end = find_subslice(raw, b"\r\n\r\n").unwrap_or(raw.len());
    let head = String::from_utf8_lossy(&raw[..head_end]);
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let headers = lines
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    let body = raw[head_end.min(raw.len())..].to_vec();
    HttpResponse {
        status,
        headers,
        body,
    }
}

/// First index of `needle` in `haystack`, or `None`.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// A fresh service owns no listener: not running, no address, no credentials.
#[test]
fn fresh_service_is_not_running() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    let status = service.status();
    assert!(!status.running, "remote access is off by default");
    assert_eq!(status.addr, None, "no listener address");
    assert!(status.credentials.is_empty());
    assert_eq!(status.audit_events, 0);
    assert_eq!(status.last_error, None);
    assert_eq!(service.config(), RemoteAccessConfig::default());
}

/// start binds loopback ephemeral and status reflects the resolved address.
#[test]
fn start_binds_loopback_ephemeral() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    let addr = service.start(test_kernel()).expect("service starts");
    assert_ne!(addr.port(), 0, "ephemeral port resolved");
    assert!(addr.ip().is_loopback(), "loopback bind");

    // The listener is really up: a plain TCP connect succeeds.
    let probe = TcpStream::connect(addr).expect("listener accepts connections");
    drop(probe);

    let status = service.status();
    assert!(status.running);
    assert_eq!(status.addr, Some(addr), "status addr mirrors local_addr");
    assert_eq!(service.config(), RemoteAccessConfig::default());
    service.stop().expect("stop succeeds");
}

/// start is idempotent: a second call returns the same address.
#[test]
fn start_is_idempotent() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    let kernel = test_kernel();
    let first = service.start(kernel.clone()).expect("first start");
    let second = service.start(kernel).expect("second start is a no-op");
    assert_eq!(first, second, "same listener on repeat start");
    service.stop().expect("stop succeeds");
}

/// A public bind without trusted_proxy is rejected BEFORE any listener.
#[test]
fn insecure_public_bind_is_rejected() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    let mut cfg = service.config();
    cfg.bind = IpAddr::V4(Ipv4Addr::UNSPECIFIED); // 0.0.0.0
    cfg.trusted_proxy = false;
    service
        .set_config(cfg)
        .expect("config updates while stopped");

    let err = service
        .start(test_kernel())
        .expect_err("insecure bind rejected");
    assert_eq!(err, ServiceError::InsecureBind);

    let status = service.status();
    assert!(!status.running, "no listener after rejected start");
    assert!(status.last_error.is_some(), "start failure is recorded");
    service.stop().expect("stop stays idempotent");
}

/// A public bind WITH trusted_proxy but WITHOUT the pairing gate is rejected
/// before any listener exists (ТЗ §10: public exposure requires auth).
#[test]
fn public_bind_without_auth_is_rejected() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    let mut cfg = service.config();
    cfg.bind = IpAddr::V4(Ipv4Addr::UNSPECIFIED); // 0.0.0.0
    cfg.trusted_proxy = true; // proxy boundary in place…
    cfg.auth_enabled = false; // …but the pairing gate is off
    service
        .set_config(cfg)
        .expect("config updates while stopped");

    let err = service
        .start(test_kernel())
        .expect_err("public bind without auth rejected");
    assert_eq!(err, ServiceError::PublicBindRequiresAuth);

    let status = service.status();
    assert!(!status.running, "no listener after rejected start");
    assert!(status.last_error.is_some(), "start failure is recorded");
    service.stop().expect("stop stays idempotent");
}

/// Full auth round trip: 401 without a token, 200 ok with a paired token,
/// 401 again after revocation. `/rpc` (not `/meta`, which is open) is gated.
#[test]
fn auth_round_trip() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    let addr = service.start(test_kernel()).expect("starts with auth on");
    assert!(service.status().auth_enabled);

    let body = envelope_body(
        "00000000-0000-4000-8000-000000000001",
        "meta.get",
        json!({}),
    );

    // No token → 401 at the gate, before the body is processed.
    let anonymous = http_request(addr, "POST", "/rpc", &[], &body);
    assert_eq!(anonymous.status, 401, "no token is rejected");
    assert_eq!(
        anonymous.body_kind().as_deref(),
        Some("error"),
        "transport-level error JSON, no response envelope"
    );
    let parsed: Value = serde_json::from_slice(&anonymous.body).expect("error body parses");
    assert_eq!(parsed["error"]["code"], "UNAUTHORIZED");

    // Paired token → HTTP 200 with a validated ok envelope.
    let (id, token) = service
        .pair(Some("round-trip".to_string()))
        .expect("pair succeeds");
    let authed = http_request(
        addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        &body,
    );
    assert_eq!(authed.status, 200, "valid token is admitted");
    assert_eq!(authed.body_kind().as_deref(), Some("ok"), "ok envelope");
    let parsed: Value = serde_json::from_slice(&authed.body).expect("ok body parses");
    assert_eq!(
        parsed["requestId"], "00000000-0000-4000-8000-000000000001",
        "envelope echoes the request id"
    );

    // Status reflects the paired credential and the audit trail.
    let status = service.status();
    assert_eq!(status.credentials.len(), 1);
    let dto = &status.credentials[0];
    assert_eq!(dto.id, id);
    assert_eq!(dto.label.as_deref(), Some("round-trip"));
    assert!(!dto.revoked);
    assert!(status.audit_events > 0, "gate events are audited");

    // Revocation stops new calls.
    assert!(service.revoke(&id).expect("revoke succeeds"));
    let revoked = http_request(
        addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        &body,
    );
    assert_eq!(revoked.status, 401, "revoked token is rejected");
    assert!(service.status().credentials[0].revoked);

    service.stop().expect("stop succeeds");
}

/// The same kernel serves local dispatch and remote HTTP concurrently: one
/// `Arc<Mutex<Kernel>>` single writer, no deadlock.
#[test]
fn concurrent_local_and_remote_operations_succeed() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    let kernel = test_kernel();
    let addr = service.start(kernel.clone()).expect("service starts");
    let (_, token) = service
        .pair(Some("concurrent".to_string()))
        .expect("pair succeeds");

    let body = envelope_body(
        "00000000-0000-4000-8000-000000000002",
        "meta.get",
        json!({}),
    );

    // Remote path: POST /rpc with the paired token.
    let remote = {
        let token = token.clone();
        let body = body.clone();
        std::thread::spawn(move || {
            for _ in 0..8 {
                let response = http_request(
                    addr,
                    "POST",
                    "/rpc",
                    &[("Authorization", &format!("Bearer {token}"))],
                    &body,
                );
                assert_eq!(response.status, 200, "remote call succeeds");
                assert_eq!(response.body_kind().as_deref(), Some("ok"));
            }
        })
    };

    // Local path: the SAME kernel through the dispatch API tauri-local uses
    // (`kernel.lock() -> guard.dispatch(op, payload, CancellationFlag)`).
    let local = {
        let kernel = kernel.clone();
        std::thread::spawn(move || {
            for _ in 0..8 {
                let guard = kernel.lock().expect("kernel mutex not poisoned");
                let result = guard
                    .dispatch("meta.get", b"{}", &CancellationFlag::new())
                    .expect("kernel dispatch succeeds");
                let value: Value = serde_json::from_slice(&result).expect("result is JSON");
                assert!(value.is_object(), "meta dto is an object");
            }
        })
    };

    remote.join().expect("remote thread joins");
    local.join().expect("local thread joins");
    service.stop().expect("stop succeeds");
}

/// set_config persists; a fresh service over the same file reloads it.
#[test]
fn config_persistence_round_trip() {
    let (_dir, path) = config_file();
    let custom = RemoteAccessConfig {
        bind: IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
        port: 4321,
        trusted_proxy: true,
        auth_enabled: false,
        allowed_origins: vec!["https://app.example.com".to_string()],
        max_streams: 4,
    };
    {
        let service = RemoteAccessService::new(path.clone());
        service.set_config(custom.clone()).expect("persists config");
    }
    let service = RemoteAccessService::new(path);
    assert_eq!(service.config(), custom, "config survives a reload");
    assert_eq!(service.status().last_error, None);
}

/// A corrupt config file degrades to defaults and records last_error.
#[test]
fn corrupt_config_falls_back_to_defaults() {
    let (_dir, path) = config_file();
    std::fs::write(
        &path,
        b"{\"bind\": \"this is not an ip\", \"port\": \"not a number\"",
    )
    .expect("writes garbage");
    let service = RemoteAccessService::new(path);
    assert_eq!(service.config(), RemoteAccessConfig::default());
    assert!(
        service.status().last_error.is_some(),
        "corrupt load records last_error"
    );
}

/// A partial config file degrades field-by-field via #[serde(default)].
#[test]
fn partial_config_file_degrades_field_by_field() {
    let (_dir, path) = config_file();
    std::fs::write(&path, br#"{"port": 8080}"#).expect("writes partial config");
    let service = RemoteAccessService::new(path);
    let cfg = service.config();
    assert_eq!(cfg.port, 8080, "present field is honored");
    assert_eq!(
        cfg.bind,
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        "missing bind defaults"
    );
    assert!(cfg.auth_enabled, "missing auth_enabled defaults on");
    assert_eq!(cfg.max_streams, 8, "missing max_streams defaults");
    assert!(!cfg.trusted_proxy);
    assert!(cfg.allowed_origins.is_empty());
}

/// stop is idempotent and start→stop→start cycles cleanly.
#[test]
fn stop_idempotent_and_restart_works() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    service.stop().expect("stop on a fresh service is a no-op");

    let first = service.start(test_kernel()).expect("first start");
    assert_ne!(first.port(), 0);
    assert!(service.status().running);

    service.stop().expect("stop succeeds");
    let status = service.status();
    assert!(!status.running);
    assert_eq!(status.addr, None, "listener is released");

    let second = service.start(test_kernel()).expect("restart succeeds");
    assert_ne!(second.port(), 0);
    assert!(service.status().running);
    assert_eq!(service.status().addr, Some(second));
    service.stop().expect("final stop succeeds");
}

/// pair requires a running adapter.
#[test]
fn pair_requires_running_service() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    assert_eq!(
        service.pair(None).expect_err("pair fails when stopped"),
        ServiceError::NotRunning
    );
}

/// pair with auth disabled is rejected.
#[test]
fn pair_with_auth_disabled_is_rejected() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    let mut cfg = service.config();
    cfg.auth_enabled = false;
    service
        .set_config(cfg)
        .expect("config updates while stopped");
    service.start(test_kernel()).expect("starts without auth");
    assert!(!service.status().auth_enabled);
    assert_eq!(
        service.pair(None).expect_err("pair requires auth"),
        ServiceError::AuthDisabled
    );
    service.stop().expect("stop succeeds");
}

/// Configuration cannot change while the adapter is running.
#[test]
fn set_config_requires_stopped_service() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    service.start(test_kernel()).expect("starts");
    let err = service
        .set_config(RemoteAccessConfig::default())
        .expect_err("config change while running is rejected");
    assert_eq!(err, ServiceError::MustStopFirst);
    service.stop().expect("stop succeeds");
}

/// revoke requires a running adapter.
#[test]
fn revoke_requires_running_service() {
    let (_dir, path) = config_file();
    let service = RemoteAccessService::new(path);
    assert_eq!(
        service
            .revoke("00000000000000000000000000000000")
            .expect_err("revoke fails when stopped"),
        ServiceError::NotRunning
    );
}
