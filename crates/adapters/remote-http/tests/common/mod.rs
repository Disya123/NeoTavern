//! Shared integration-test helpers for the `remote-http-adapter` crate
//! (Phase 4 + Phase 6 generation streaming).
//!
//! Every scenario drives a REAL [`runtime_kernel::Kernel`] opened on a fresh
//! temporary data root (`tempfile::TempDir`), wrapped in
//! `Arc<Mutex<Kernel>>` as the adapter API requires, with
//! [`remote_http_adapter::RemoteAdapter`] bound to an ephemeral loopback
//! port (`127.0.0.1:0`).
//!
//! The HTTP client is a deliberately tiny std-only implementation
//! (`TcpStream` + manual request writing + read-to-close) so the test crate
//! adds no dependencies beyond `tempfile`.
//!
//! Wire assertions go through the generated decoders and DTO validators
//! (`contracts_generated::generated::{decode_response_envelope,
//! validate_character_dto, ...}`) so the tests exercise the same structural
//! checks the product hosts rely on.
//!
//! Determinism: reads are bounded by a short `read_timeout` + retry loop
//! instead of sleeps; request ids / character ids are fixed literal UUIDs
//! matching the wire pattern (no `uuid` dependency).
//!
//! The helpers are compiled into every integration-test binary
//! (`remote_http.rs`, `generation_stream.rs`), and each binary uses only a
//! subset of them — per-binary unused-item lints on the shared exports are
//! expected noise, so they are allowed at the module level.
#![allow(unused_imports, dead_code)]

pub use contracts_generated::generated as gen;
pub use remote_http_adapter::audit::{AuditEvent, AuditKind};
pub use remote_http_adapter::auth::{AuthConfig, AuthError};
pub use remote_http_adapter::rate_limit::RateLimitConfig;
pub use remote_http_adapter::sse::{
    encode_envelope_frame, encode_frame, encode_terminal_frame, parse_last_event_id, SseFrame,
};
pub use remote_http_adapter::{AdapterError, RemoteAdapter, RemoteAdapterConfig};
pub use runtime_kernel::{Kernel, KernelConfig, KernelErrorCode};
pub use serde_json::{json, Value};
pub use std::io::{self, Read, Write};
pub use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
pub use std::path::Path;
pub use std::sync::{Arc, Mutex};
pub use std::time::Duration;
pub use tempfile::TempDir;

/// A schema hash that is definitely wrong (64 zeros) — remote clients are not
/// required to match the embedded manifest hash (§6.5).
pub const ZERO_SCHEMA_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Kernel / adapter setup
// ---------------------------------------------------------------------------

/// Fixed literal UUID request ids (`00000000-0000-4000-8000-<12 digits>`),
/// distinct per request for readable test transcripts.
pub fn rid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

/// The adapter config with all contract defaults.
pub fn default_config() -> RemoteAdapterConfig {
    RemoteAdapterConfig {
        bind_addr: "127.0.0.1:0".parse().expect("loopback ephemeral parses"),
        trusted_proxy: false,
        max_request_bytes: 1024 * 1024,
        max_connections: 8,
        drain_timeout: Duration::from_secs(5),
        auth: None,
        rate_limit: None,
        max_streams: 8,
        audit_capacity: 256,
        allowed_origins: Vec::new(),
        trusted_proxies: Vec::new(),
    }
}

/// Kernel config that satisfies the kernel's open-time contract checks
/// (expected schema hash + FFI ABI version) over `root` as the data root.
pub fn kernel_config(root: &Path) -> KernelConfig {
    KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
        data_root: Some(root.to_path_buf()),
    }
}

/// A running adapter over one real kernel on a tempfile data root.
///
/// Field order matters for teardown: on drop the adapter is shut down first
/// (workers joined), then the kernel Arc, then the temp dir — so the data
/// root is never removed while the SQLite connection is still open.
pub struct TestServer {
    pub kernel: Arc<Mutex<Kernel>>,
    pub adapter: Option<RemoteAdapter>,
    pub addr: SocketAddr,
    _temp: TempDir,
}

impl TestServer {
    pub fn spawn() -> TestServer {
        TestServer::spawn_with(default_config())
    }

    /// Spawns a server whose data root was seeded BEFORE the kernel opened
    /// (the kernel takes the exclusive data-root lease at open, so direct
    /// seeding must happen first). `seed` receives the open SQLite
    /// transaction.
    pub fn spawn_seeded(seed: impl FnOnce(&rusqlite::Transaction<'_>)) -> TestServer {
        let temp = tempfile::tempdir().expect("temp dir for the kernel data root");
        seed_data_root(temp.path(), seed);
        let kernel = Kernel::open(kernel_config(temp.path()))
            .expect("kernel opens over the seeded data root (migrations run)");
        let kernel = Arc::new(Mutex::new(kernel));
        let adapter = RemoteAdapter::start(kernel.clone(), default_config())
            .expect("adapter starts on the ephemeral loopback port");
        let addr = adapter.local_addr();
        TestServer {
            kernel,
            adapter: Some(adapter),
            addr,
            _temp: temp,
        }
    }

    pub fn spawn_with(config: RemoteAdapterConfig) -> TestServer {
        let temp = tempfile::tempdir().expect("temp dir for the kernel data root");
        let kernel = Kernel::open(kernel_config(temp.path()))
            .expect("kernel opens on the temp data root (migrations run)");
        let kernel = Arc::new(Mutex::new(kernel));
        let adapter = RemoteAdapter::start(kernel.clone(), config)
            .expect("adapter starts on the ephemeral loopback port");
        let addr = adapter.local_addr();
        TestServer {
            kernel,
            adapter: Some(adapter),
            addr,
            _temp: temp,
        }
    }

    /// Spawns a server with an explicit config over a PRE-SEEDED data root
    /// (seeding must happen before the kernel takes the exclusive lease).
    pub fn spawn_with_config_and_seed(
        config: RemoteAdapterConfig,
        seed: impl FnOnce(&rusqlite::Transaction<'_>),
    ) -> TestServer {
        let temp = tempfile::tempdir().expect("temp dir for the kernel data root");
        seed_data_root(temp.path(), seed);
        let kernel = Kernel::open(kernel_config(temp.path()))
            .expect("kernel opens over the seeded data root (migrations run)");
        let kernel = Arc::new(Mutex::new(kernel));
        let adapter = RemoteAdapter::start(kernel.clone(), config)
            .expect("adapter starts on the ephemeral loopback port");
        let addr = adapter.local_addr();
        TestServer {
            kernel,
            adapter: Some(adapter),
            addr,
            _temp: temp,
        }
    }

    /// The data root path (the tempdir the kernel's SQLite database lives
    /// in) — read-only access for direct assertions the wire ops cannot
    /// express (e.g. "no generation run row was created").
    pub fn data_root(&self) -> &Path {
        self._temp.path()
    }

    /// Gracefully shuts the adapter down (drain + listener release). The
    /// kernel and temp dir are dropped with the server.
    pub fn shutdown(&mut self) {
        if let Some(adapter) = self.adapter.take() {
            adapter.shutdown().expect("graceful shutdown");
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(adapter) = self.adapter.take() {
            let _ = adapter.shutdown();
        }
    }
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

/// A `wire.request.envelope` JSON body with the current protocol and the
/// embedded schema hash.
pub fn envelope_body(request_id: &str, operation_id: &str, payload: Value) -> Vec<u8> {
    envelope_body_full(
        1,
        0,
        contracts_generated::contract_schema_hash(),
        request_id,
        operation_id,
        payload,
    )
}

/// A `wire.request.envelope` JSON body with explicit protocol / schema hash,
/// used by the protocol-gate and schema-hash-tolerance scenarios.
pub fn envelope_body_full(
    major: i64,
    minor: i64,
    schema_hash: &str,
    request_id: &str,
    operation_id: &str,
    payload: Value,
) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "wireProtocol": { "major": major, "minor": minor },
        "schemaHash": schema_hash,
        "requestId": request_id,
        "operationId": operation_id,
        "payload": payload,
    }))
    .expect("request envelope serializes")
}

/// Decodes a `wire.response.envelope` through the generated three-stage
/// pipeline (parse → structural check → typed decode).
pub fn decode_envelope(body: &[u8]) -> gen::ResponseEnvelope {
    gen::decode_response_envelope(body).expect("response envelope decodes")
}

/// Unwraps an ok envelope into `(requestId, result JSON)`.
pub fn expect_ok(env: gen::ResponseEnvelope) -> (String, Value) {
    match env {
        gen::ResponseEnvelope::Ok { request_id, result } => (request_id, result),
        gen::ResponseEnvelope::Error { error, .. } => {
            panic!("expected ok envelope, got error {}", error.code)
        }
    }
}

/// Unwraps an error envelope into `(requestId, ErrorDto)`.
pub fn expect_error(env: gen::ResponseEnvelope) -> (String, gen::ErrorDto) {
    match env {
        gen::ResponseEnvelope::Error { request_id, error } => (request_id, error),
        gen::ResponseEnvelope::Ok { .. } => panic!("expected error envelope, got ok"),
    }
}

// ---------------------------------------------------------------------------
// Minimal std-only HTTP client
// ---------------------------------------------------------------------------

/// A parsed HTTP response.
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// First header value matching `name` (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Sends one HTTP/1.1 request with a Content-Length body and `Connection:
/// close`, returning the parsed response.
pub fn http_request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> HttpResponse {
    http_request_with(addr, method, path, headers, body, 500, 20)
}

/// Sends one HTTP/1.1 request like [`http_request`] but with a configurable
/// per-read timeout and stall budget — used for streaming responses, where
/// the body can take longer than the default 10s budget to complete.
pub fn http_request_with(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    read_timeout_ms: u64,
    max_stalls: u32,
) -> HttpResponse {
    let mut stream = TcpStream::connect(addr).expect("connect to the adapter");
    stream
        .set_read_timeout(Some(Duration::from_millis(read_timeout_ms)))
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

    // The adapter may answer (e.g. 413) and close before the whole body is
    // sent; a failing body write must not mask the response.
    if !body.is_empty() {
        let _ = stream.write_all(body);
    }

    let raw = read_response_with(&mut stream, max_stalls).expect("read the response");
    parse_response(&raw)
}

/// Sends one chunked POST request (no Content-Length) — exercises the
/// chunked-body limit path in the adapter.
pub fn http_request_chunked(addr: SocketAddr, path: &str, body: &[u8]) -> HttpResponse {
    let mut stream = TcpStream::connect(addr).expect("connect to the adapter");
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .expect("set read timeout");

    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n"
    );
    for chunk in body.chunks(64) {
        request.push_str(&format!("{:x}\r\n", chunk.len()));
        request.push_str(std::str::from_utf8(chunk).expect("envelope body is ASCII"));
        request.push_str("\r\n");
    }
    request.push_str("0\r\n\r\n");

    // Same tolerance as above: the adapter may close mid-body on 413.
    let _ = stream.write_all(request.as_bytes());
    let raw = read_response(&mut stream).expect("read the response");
    parse_response(&raw)
}

/// Reads until EOF or until a Content-Length-delimited body is complete,
/// retrying on read timeouts instead of sleeping (default stall budget).
pub fn read_response(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    read_response_with(stream, 20)
}

/// Reads until EOF or until a Content-Length-delimited body is complete,
/// retrying on read timeouts instead of sleeping, with a configurable stall
/// budget for slow streaming responses.
pub fn read_response_with(stream: &mut TcpStream, max_stalls: u32) -> io::Result<Vec<u8>> {
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
                if stalled > max_stalls {
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
/// Chunked responses are completed by EOF (we always send `Connection:
/// close`, so the server closes after the response).
fn body_complete(raw: &[u8]) -> bool {
    let Some(separator) = find_subslice(raw, b"\r\n\r\n") else {
        return false;
    };
    let head = std::str::from_utf8(&raw[..separator]).unwrap_or_default();
    for line in head.split("\r\n").skip(1) {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                if let Ok(len) = value.trim().parse::<usize>() {
                    return raw.len() >= separator + 4 + len;
                }
            }
        }
    }
    false
}

/// Splits raw response bytes into status, headers and body; decodes a chunked
/// body when the server used `Transfer-Encoding: chunked`.
pub fn parse_response(raw: &[u8]) -> HttpResponse {
    let separator = find_subslice(raw, b"\r\n\r\n").expect("response header terminator");
    let head = std::str::from_utf8(&raw[..separator]).expect("response headers are UTF-8");
    let mut lines = head.split("\r\n");
    let status_line = lines.next().expect("status line present");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|part| part.parse().ok())
        .expect("status code parses");

    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.push((key.trim().to_string(), value.trim().to_string()));
        }
    }

    let mut body = raw[separator + 4..].to_vec();
    let chunked = headers.iter().any(|(key, value)| {
        key.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
    });
    if chunked {
        body = decode_chunked(&body);
    } else if let Some((_, value)) = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
    {
        if let Ok(len) = value.parse::<usize>() {
            body.truncate(len);
        }
    }

    HttpResponse {
        status,
        headers,
        body,
    }
}

/// Decodes an RFC 7230 chunked body (the bytes after the header block).
fn decode_chunked(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut pos = 0;
    loop {
        let line_end = find_subslice(&body[pos..], b"\r\n").expect("chunk size line");
        let size_line = std::str::from_utf8(&body[pos..pos + line_end]).expect("chunk size ASCII");
        let size = usize::from_str_radix(size_line.trim(), 16).expect("chunk size is hex");
        pos += line_end + 2;
        if size == 0 {
            break;
        }
        out.extend_from_slice(&body[pos..pos + size]);
        pos += size + 2; // chunk data + trailing CRLF
    }
    out
}

/// First index of `needle` in `haystack`, or `None`.
pub fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// A currently free TCP port on loopback (used to prove listener release).
pub fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    listener
        .local_addr()
        .expect("read the ephemeral port")
        .port()
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/// One SSE frame split into its `event` / `id` / `data` fields.
#[derive(Debug, Clone)]
pub struct ParsedSseFrame {
    pub event: String,
    pub id: Option<u64>,
    pub data: String,
}

/// Parses an SSE body into frames (frames separated by a blank line).
pub fn parse_sse(body: &str) -> Vec<ParsedSseFrame> {
    body.split("\n\n")
        .filter(|frame| !frame.trim().is_empty())
        .map(|frame| {
            let mut event = String::new();
            let mut id = None;
            let mut data_lines: Vec<&str> = Vec::new();
            for line in frame.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    event = value.trim().to_string();
                } else if let Some(value) = line.strip_prefix("id:") {
                    id = value.trim().parse().ok();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data_lines.push(value.trim_start());
                }
            }
            ParsedSseFrame {
                event,
                id,
                data: data_lines.join("\n"),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Direct storage seeding (chats/messages have no wire create op)
// ---------------------------------------------------------------------------

/// Seeds product rows directly through `neotavern_storage` (before the kernel
/// takes the data-root lease) — the frozen wire registry has no create
/// operation for chats/messages/lorebooks/presets, so the rows are inserted
/// here and served back through the adapter exactly like the kernel serves
/// its own writes.
pub fn seed_data_root(root: &Path, seed: impl FnOnce(&rusqlite::Transaction<'_>)) {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("fresh data root opens for seeding");
    db.transaction(|tx| {
        seed(tx);
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction commits");
    drop(db); // release the lease before the kernel takes the root
}

/// A fixed RFC 3339 UTC timestamp (seconds precision, as the kernel writes).
pub const T0: &str = "2026-01-01T00:00:00Z";

/// Seeds one character + one chat row — the minimal chat context
/// `generation.start` requires (chats have no wire create op).
pub fn seed_chat(tx: &rusqlite::Transaction<'_>, character_id: &str, chat_id: &str) {
    tx.execute(
        "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at)
         VALUES (?1, ?2, NULL, NULL, '[]', '{}', ?3, ?3)",
        rusqlite::params![character_id, "Seeded Character", T0],
    )
    .expect("seed character for generation");
    tx.execute(
        "INSERT INTO chats (id, title, character_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![chat_id, "Seeded Chat", character_id, T0],
    )
    .expect("seed chat for generation");
}

// ---------------------------------------------------------------------------
// Keep-alive client (Phase 4 scenario 23)
// ---------------------------------------------------------------------------

/// Sends multiple HTTP/1.1 requests over ONE keep-alive connection and reads
/// each response before sending the next (no pipelining) — proves the
/// adapter reuses persistent connections instead of forcing `Connection:
/// close` per request.
///
/// tiny_http serves a connection from one worker sequentially; pipelined
/// second requests are not guaranteed to be read promptly under full
/// workspace contention, so the helper is deliberately request→response.
pub fn http_requests_keepalive(
    addr: SocketAddr,
    requests: &[(&str, &str, &[u8])],
) -> Vec<HttpResponse> {
    let mut stream = TcpStream::connect(addr).expect("connect to the adapter");
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .expect("set read timeout");

    let mut raw: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    let mut stalled = 0u32;
    let mut responses = Vec::with_capacity(requests.len());
    for (method, path, body) in requests {
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: keep-alive\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        request.push_str(&String::from_utf8_lossy(body));
        stream.write_all(request.as_bytes()).expect("write request");

        // Read until exactly this response is complete in the buffer.
        loop {
            if let Some((response, rest)) = take_one_response(&raw) {
                responses.push(response);
                raw = rest;
                stalled = 0;
                break;
            }
            match stream.read(&mut buf) {
                Ok(0) => panic!("server closed the keep-alive connection early"),
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
                    if stalled > 40 {
                        panic!(
                            "keep-alive response stalled after {} read timeouts ({} bytes buffered)",
                            stalled,
                            raw.len()
                        );
                    }
                }
                Err(e) => panic!("keep-alive read failed: {e}"),
            }
        }
    }
    responses
}

/// Parses the FIRST complete response (headers + Content-Length body) off the
/// front of `raw`, returning it plus the untouched remainder.
pub fn take_one_response(raw: &[u8]) -> Option<(HttpResponse, Vec<u8>)> {
    let separator = find_subslice(raw, b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..separator]).ok()?;
    let mut content_length = None;
    for line in head.split("\r\n").skip(1) {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let len = content_length?;
    if raw.len() < separator + 4 + len {
        return None; // body not fully buffered yet
    }
    let end = separator + 4 + len;
    let response = parse_response(&raw[..end]);
    Some((response, raw[end..].to_vec()))
}
