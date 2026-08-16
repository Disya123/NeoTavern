//! Integration tests for the `neotavern-headless` binary (ТЗ §11.3).
//!
//! Every scenario spawns the REAL built binary (`CARGO_BIN_EXE_...`) as a
//! child process. The host prints one `listening <ip:port>` line on stdout
//! and waits for stdin EOF before draining the listener. Scenarios:
//!
//! 1. Loopback ephemeral bind → `GET /meta` 200, then stdin EOF → exit 0.
//! 2. Character create/get round-trip over `/rpc` through the host.
//! 3. Non-loopback bind without `--remote-exposure` → exit 1 `InsecureBind`.
//! 4. Public bind with exposure but no `--auth` → exit 1 `PublicBindRequiresAuth`.
//! 5. `--auth` on loopback → `/rpc` 401 without a token; bootstrap token works.
//! 6. Missing `--root` → exit 2.
//! 7. `--help` → exit 0.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use contracts_generated::generated;
use serde_json::{json, Value};

fn bin() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_neotavern-headless"));
    for key in [
        "NEOTA_DATA_ROOT",
        "NEOTA_BIND",
        "NEOTA_REMOTE_EXPOSURE",
        "NEOTA_HEADLESS_AUTH",
        "NEOTA_ALLOWED_ORIGINS",
        "NEOTA_SECRET_BACKEND",
    ] {
        command.env_remove(key);
    }
    command
}

/// Spawn the host with piped stdio. Caller owns the child (must kill/wait).
fn spawn(root: &Path, extra: &[&str]) -> (Child, mpsc::Receiver<String>) {
    let mut command = bin();
    command
        .arg("--root")
        .arg(root)
        .arg("--bind")
        .arg("127.0.0.1:0")
        .args(extra)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("spawn neotavern-headless");
    let stderr = child.stderr.take().expect("stderr pipe");
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    (child, rx)
}

/// Read the `listening <addr>` line from stdout with a timeout.
fn wait_listening(child: &mut Child) -> SocketAddr {
    let stdout = child.stdout.take().expect("stdout pipe");
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx
        .recv_timeout(Duration::from_secs(30))
        .unwrap_or_else(|_| panic!("host did not print listening (still running?)"));
    let addr = line
        .trim()
        .strip_prefix("listening ")
        .unwrap_or_else(|| panic!("stdout must be `listening <addr>`, got {line:?}"));
    addr.parse()
        .unwrap_or_else(|err| panic!("listening addr {addr:?} parse failed: {err}"))
}

/// Close stdin (EOF) and wait for a clean drain.
fn shutdown(mut child: Child) -> std::process::Output {
    drop(child.stdin.take());
    child
        .wait_with_output()
        .expect("wait for neotavern-headless")
}

fn run_failing(args: &[&str]) -> std::process::Output {
    bin()
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run neotavern-headless")
}

fn stderr_text(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn exit_code(output: &std::process::Output) -> i32 {
    output.status.code().expect("child exited with a code")
}

// ---------------------------------------------------------------------------
// Minimal std-only HTTP client (mirrors remote-http / desktop-remote tests)
// ---------------------------------------------------------------------------

struct HttpResponse {
    status: u16,
    body: Vec<u8>,
}

fn http_request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> HttpResponse {
    let mut stream = TcpStream::connect(addr).expect("connect to the headless host");
    stream
        .set_read_timeout(Some(Duration::from_millis(800)))
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
    if !body.is_empty() {
        let _ = stream.write_all(body);
    }

    let raw = read_response(&mut stream).expect("read the response");
    parse_response(&raw)
}

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
                        "host did not finish the response",
                    ));
                }
            }
            Err(e) => return Err(e),
        }
    }
}

fn body_complete(raw: &[u8]) -> bool {
    let Some(head_end) = find_subslice(raw, b"\r\n\r\n") else {
        return false;
    };
    let head = std::str::from_utf8(&raw[..head_end]).unwrap_or("");
    for line in head.lines() {
        if let Some(value) = line.strip_prefix("Content-Length:") {
            if let Ok(len) = value.trim().parse::<usize>() {
                return raw.len() >= head_end + 4 + len;
            }
        }
    }
    false
}

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
    let body_start = (head_end + 4).min(raw.len());
    HttpResponse {
        status,
        body: raw[body_start..].to_vec(),
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn envelope_body(request_id: &str, operation_id: &str, payload: Value) -> Vec<u8> {
    let (major, minor) = contracts_generated::wire_protocol();
    serde_json::to_vec(&json!({
        "wireProtocol": { "major": major, "minor": minor },
        "schemaHash": contracts_generated::contract_schema_hash(),
        "requestId": request_id,
        "operationId": operation_id,
        "payload": payload,
    }))
    .expect("envelope serializes")
}

fn expect_ok(body: &[u8]) -> serde_json::Value {
    match generated::decode_response_envelope(body) {
        Ok(generated::ResponseEnvelope::Ok { result, .. }) => result,
        other => panic!("expected ok envelope, got {other:?}"),
    }
}

fn recv_token(rx: &mpsc::Receiver<String>) -> String {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        let remain = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(remain) {
            Ok(line) => {
                if let Some(token) = line.strip_prefix("neotavern-headless: token ") {
                    return token.to_string();
                }
            }
            Err(_) => break,
        }
    }
    panic!("bootstrap token was not printed on stderr");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn help_exits_zero() {
    let output = run_failing(&["--help"]);
    assert_eq!(exit_code(&output), 0, "stderr={}", stderr_text(&output));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("neotavern-headless"), "{stdout}");
}

#[test]
fn missing_root_exits_two() {
    let output = run_failing(&[]);
    assert_eq!(exit_code(&output), 2);
    assert!(
        stderr_text(&output).contains("--root"),
        "{}",
        stderr_text(&output)
    );
}

#[test]
fn loopback_serves_meta_and_drains_on_stdin_eof() {
    let temp = tempfile::tempdir().expect("data-root");
    let (mut child, _stderr) = spawn(temp.path(), &[]);
    let addr = wait_listening(&mut child);
    assert!(addr.ip().is_loopback(), "{addr}");

    let meta = http_request(addr, "GET", "/meta", &[], &[]);
    assert_eq!(meta.status, 200, "GET /meta through the headless host");

    let output = shutdown(child);
    assert_eq!(
        exit_code(&output),
        0,
        "drain exit 0; stderr={}",
        stderr_text(&output)
    );
}

#[test]
fn character_round_trip_over_rpc() {
    let temp = tempfile::tempdir().expect("data-root");
    let (mut child, _stderr) = spawn(temp.path(), &[]);
    let addr = wait_listening(&mut child);

    let create = http_request(
        addr,
        "POST",
        "/rpc",
        &[("Content-Type", "application/json")],
        &envelope_body(
            "00000000-0000-4000-8000-000000000001",
            "characters.create",
            json!({ "name": "Ada" }),
        ),
    );
    assert_eq!(create.status, 200, "create HTTP");
    let created = expect_ok(&create.body);
    let character_id = created
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("create result id: {created:?}"))
        .to_string();

    let get = http_request(
        addr,
        "POST",
        "/rpc",
        &[("Content-Type", "application/json")],
        &envelope_body(
            "00000000-0000-4000-8000-000000000002",
            "characters.get",
            json!({ "characterId": character_id }),
        ),
    );
    assert_eq!(get.status, 200, "get HTTP");
    let fetched = expect_ok(&get.body);
    let name = fetched.get("name").and_then(Value::as_str);
    assert_eq!(name, Some("Ada"));

    let output = shutdown(child);
    assert_eq!(exit_code(&output), 0, "{}", stderr_text(&output));
}

#[test]
fn non_loopback_without_exposure_is_insecure_bind() {
    let temp = tempfile::tempdir().expect("data-root");
    let output = run_failing(&[
        "--root",
        temp.path().to_str().expect("utf-8 temp path"),
        "--bind",
        "0.0.0.0:0",
    ]);
    assert_eq!(exit_code(&output), 1);
    assert!(
        stderr_text(&output).contains("InsecureBind"),
        "{}",
        stderr_text(&output)
    );
}

#[test]
fn public_bind_without_auth_is_startup_error() {
    let temp = tempfile::tempdir().expect("data-root");
    let output = run_failing(&[
        "--root",
        temp.path().to_str().expect("utf-8 temp path"),
        "--bind",
        "0.0.0.0:0",
        "--remote-exposure",
    ]);
    assert_eq!(exit_code(&output), 1);
    assert!(
        stderr_text(&output).contains("PublicBindRequiresAuth"),
        "{}",
        stderr_text(&output)
    );
}

#[test]
fn auth_gate_rejects_rpc_then_accepts_bootstrap_token() {
    let temp = tempfile::tempdir().expect("data-root");
    let (mut child, stderr_rx) = spawn(temp.path(), &["--auth"]);
    let addr = wait_listening(&mut child);

    let denied = http_request(
        addr,
        "POST",
        "/rpc",
        &[("Content-Type", "application/json")],
        &envelope_body(
            "00000000-0000-4000-8000-000000000003",
            "meta.get",
            json!({}),
        ),
    );
    assert_eq!(denied.status, 401, "unauthenticated /rpc");

    let meta = http_request(addr, "GET", "/meta", &[], &[]);
    assert_eq!(meta.status, 200, "/meta stays public");

    let token = recv_token(&stderr_rx);

    let allowed = http_request(
        addr,
        "POST",
        "/rpc",
        &[
            ("Content-Type", "application/json"),
            ("Authorization", &format!("Bearer {token}")),
        ],
        &envelope_body(
            "00000000-0000-4000-8000-000000000004",
            "meta.get",
            json!({}),
        ),
    );
    assert_eq!(allowed.status, 200, "authed /rpc");
    let result = expect_ok(&allowed.body);
    assert!(result.is_object(), "meta.get result: {result:?}");

    let output = shutdown(child);
    assert_eq!(exit_code(&output), 0, "{}", stderr_text(&output));
}
