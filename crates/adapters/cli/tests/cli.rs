//! Integration tests for the `neotavern-cli` binary (ТЗ §6.3, Phase 4 CLI
//! hooks).
//!
//! Every scenario spawns the REAL built binary (`CARGO_BIN_EXE_...`) as a
//! child process and asserts on its exit code + stdout envelope, through the
//! SAME generated envelope decoders the HTTP adapter tests use. Scenarios:
//!
//! 1. `--operation meta.get` → exit 0, ok envelope, generated request id.
//! 2. `--envelope` from stdin (full request envelope) → exit 0, request id
//!    echoed verbatim — byte-identical envelope semantics to the adapter.
//! 3. `characters.create` → `characters.get` round-trip over a real data
//!    root (the CLI owns the exclusive lease during the run).
//! 4. Schema-violating payload → exit 1, `CONTRACT_VIOLATION` envelope.
//! 5. Unknown operation → exit 1, `NOT_FOUND` envelope.
//! 6. Protocol major mismatch (envelope says major 2) → exit 1,
//!    `PROTOCOL_MISMATCH` envelope with the client/server majors.
//! 7. Data-root lease held by another kernel → exit 1, `DATA_ROOT_IN_USE`
//!    envelope (single-writer rule, §22).
//! 8. Usage errors (unknown flag / missing payload / invalid JSON /
//!    conflicting modes) → exit 2, diagnostic on stderr, empty stdout.
//! 9. Malformed stdin envelope → exit 1, diagnostic on stderr, empty stdout.
//! 10. Oversized stdin (> 1 MiB) → exit 1, bounded parser (§10).

use std::path::Path;
use std::process::{Command, Output, Stdio};

use contracts_generated::generated;
use runtime_kernel::{Kernel, KernelConfig};

/// Runs the CLI binary with the given args and optional stdin.
fn cli(args: &[&str], stdin: Option<&[u8]>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_neotavern-cli"));
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(bytes) = stdin {
        use std::io::Write;
        let mut child = command
            .stdin(Stdio::piped())
            .spawn()
            .expect("spawn the CLI binary");
        child
            .stdin
            .as_mut()
            .expect("stdin pipe")
            .write_all(bytes)
            .expect("write CLI stdin");
        child.wait_with_output().expect("wait for the CLI")
    } else {
        command.output().expect("run the CLI binary")
    }
}

fn stdout_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The exit code of the child process.
fn exit_code(output: &Output) -> i32 {
    output.status.code().expect("child exited with a code")
}

/// Decodes the CLI stdout as a response envelope.
fn decode_stdout(output: &Output) -> generated::ResponseEnvelope {
    let body = stdout_text(output);
    let trimmed = body.trim_end();
    generated::decode_response_envelope(trimmed.as_bytes())
        .unwrap_or_else(|err| panic!("stdout must be a response envelope: {err:?}\n{trimmed}"))
}

/// A minimal valid request envelope JSON for stdin mode.
fn request_envelope(request_id: &str, operation_id: &str, payload: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "wireProtocol": { "major": 1, "minor": 0 },
        "schemaHash": contracts_generated::contract_schema_hash(),
        "requestId": request_id,
        "operationId": operation_id,
        "payload": payload,
    }))
    .expect("envelope serializes")
}

fn kernel_config(root: &Path) -> KernelConfig {
    KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
        data_root: Some(root.to_path_buf()),
    }
}

/// 1. `--operation meta.get` builds the envelope (protocol + hash from the
///    embedded manifest), dispatches and prints an ok envelope; exit 0.
#[test]
fn meta_get_via_operation_exits_zero() {
    let output = cli(&["--operation", "meta.get", "{}"], None);
    assert_eq!(exit_code(&output), 0, "stderr: {}", stderr_text(&output));
    let envelope = decode_stdout(&output);
    match envelope {
        generated::ResponseEnvelope::Ok { request_id, result } => {
            assert!(!request_id.is_empty(), "request id generated");
            assert!(
                result.get("productWire").is_some(),
                "meta result carries productWire: {result}"
            );
        }
        generated::ResponseEnvelope::Error { error, .. } => {
            panic!("meta.get must succeed, got error envelope: {error:?}")
        }
    }
}

/// 2. `--envelope` from stdin dispatches the exact envelope; the request id
///    is echoed verbatim (adapter-identical envelope semantics).
#[test]
fn envelope_from_stdin_echoes_request_id() {
    let request_id = "00000000-0000-4000-8000-0000000000aa";
    let output = cli(
        &["--envelope"],
        Some(&request_envelope(
            request_id,
            "meta.get",
            serde_json::json!({}),
        )),
    );
    assert_eq!(exit_code(&output), 0, "stderr: {}", stderr_text(&output));
    match decode_stdout(&output) {
        generated::ResponseEnvelope::Ok {
            request_id: echoed, ..
        } => {
            assert_eq!(echoed, request_id, "request id echoed verbatim");
        }
        generated::ResponseEnvelope::Error { error, .. } => {
            panic!("meta.get must succeed, got error envelope: {error:?}")
        }
    }
}

/// 3. Character create → get round-trip over a real data root (the CLI opens
///    the kernel with the exclusive lease for its one-shot run).
#[test]
fn character_crud_round_trip_over_data_root() {
    let temp = tempfile::tempdir().expect("temp data root");
    let root = temp.path().to_str().expect("temp path is UTF-8");

    let create = cli(
        &[
            "--root",
            root,
            "--operation",
            "characters.create",
            r#"{"name":"Ada Lovelace"}"#,
        ],
        None,
    );
    assert_eq!(exit_code(&create), 0, "stderr: {}", stderr_text(&create));
    let created = match decode_stdout(&create) {
        generated::ResponseEnvelope::Ok { result, .. } => result,
        generated::ResponseEnvelope::Error { error, .. } => {
            panic!("create must succeed, got error envelope: {error:?}")
        }
    };
    let character_id = created
        .get("id")
        .and_then(serde_json::Value::as_str)
        .expect("created character carries an id");

    let get = cli(
        &[
            "--root",
            root,
            "--operation",
            "characters.get",
            &format!(r#"{{"characterId":"{character_id}"}}"#),
        ],
        None,
    );
    assert_eq!(exit_code(&get), 0, "stderr: {}", stderr_text(&get));
    match decode_stdout(&get) {
        generated::ResponseEnvelope::Ok { result, .. } => {
            assert_eq!(
                result.get("name").and_then(serde_json::Value::as_str),
                Some("Ada Lovelace")
            );
        }
        generated::ResponseEnvelope::Error { error, .. } => {
            panic!("get must succeed, got error envelope: {error:?}")
        }
    }
}

/// 4. A schema-violating operation payload → exit 1 + `CONTRACT_VIOLATION`
///    error envelope (the kernel validates before any write).
#[test]
fn schema_violation_answers_error_envelope() {
    let temp = tempfile::tempdir().expect("temp data root");
    let root = temp.path().to_str().expect("temp path is UTF-8");
    // `name` must be a string; a number violates the characters.create schema.
    let output = cli(
        &[
            "--root",
            root,
            "--operation",
            "characters.create",
            r#"{"name":42}"#,
        ],
        None,
    );
    assert_eq!(exit_code(&output), 1);
    match decode_stdout(&output) {
        generated::ResponseEnvelope::Error { error, .. } => {
            assert_eq!(error.code, "CONTRACT_VIOLATION");
        }
        generated::ResponseEnvelope::Ok { .. } => {
            panic!("schema violation must answer an error envelope")
        }
    }
}

/// 5. Unknown operationId → exit 1 + `NOT_FOUND` envelope.
#[test]
fn unknown_operation_answers_not_found() {
    let output = cli(&["--operation", "nope.nope", "{}"], None);
    assert_eq!(exit_code(&output), 1);
    match decode_stdout(&output) {
        generated::ResponseEnvelope::Error { error, .. } => {
            assert_eq!(error.code, "NOT_FOUND");
        }
        generated::ResponseEnvelope::Ok { .. } => {
            panic!("unknown operation must answer an error envelope")
        }
    }
}

/// 6. A request envelope speaking a different protocol major → exit 1 +
///    `PROTOCOL_MISMATCH` envelope with the client/server majors (the same
///    semantics the HTTP adapter answers as 426).
#[test]
fn protocol_major_mismatch_answers_protocol_error() {
    let mut raw = request_envelope(
        "00000000-0000-4000-8000-0000000000bb",
        "meta.get",
        serde_json::json!({}),
    );
    // Rewrite the major to 2 (client speaks a different protocol generation).
    let mut value: serde_json::Value =
        serde_json::from_slice(&raw).expect("built envelope is JSON");
    value["wireProtocol"]["major"] = serde_json::json!(2);
    raw = serde_json::to_vec(&value).expect("rewritten envelope serializes");

    let output = cli(&["--envelope"], Some(&raw));
    assert_eq!(exit_code(&output), 1);
    match decode_stdout(&output) {
        generated::ResponseEnvelope::Error { error, .. } => {
            assert_eq!(error.code, "PROTOCOL_MISMATCH");
            assert_eq!(
                error
                    .params
                    .get("client_major")
                    .and_then(serde_json::Value::as_str),
                Some("2"),
                "params: {:?}",
                error.params
            );
        }
        generated::ResponseEnvelope::Ok { .. } => {
            panic!("major mismatch must answer an error envelope")
        }
    }
}

/// 7. A second writable kernel on the same data root is refused: while the
///    test process holds the exclusive lease, the CLI child gets a controlled
///    `DATA_ROOT_IN_USE` envelope (§22 — one writable kernel per data root).
#[test]
fn data_root_in_use_when_lease_held() {
    let temp = tempfile::tempdir().expect("temp data root");
    let _holder = Kernel::open(kernel_config(temp.path())).expect("test holds the lease");

    let root = temp.path().to_str().expect("temp path is UTF-8");
    let output = cli(&["--root", root, "--operation", "meta.get", "{}"], None);
    assert_eq!(exit_code(&output), 1, "stderr: {}", stderr_text(&output));
    match decode_stdout(&output) {
        generated::ResponseEnvelope::Error { error, .. } => {
            assert_eq!(error.code, "DATA_ROOT_IN_USE");
        }
        generated::ResponseEnvelope::Ok { .. } => {
            panic!("a held lease must refuse the second writable kernel")
        }
    }
}

/// 8. Usage errors exit 2 with a stderr diagnostic and empty stdout.
#[test]
fn usage_errors_exit_two() {
    // Unknown flag.
    let unknown = cli(&["--frobnicate"], None);
    assert_eq!(exit_code(&unknown), 2);
    assert!(stdout_text(&unknown).is_empty());
    assert!(
        !stderr_text(&unknown).is_empty(),
        "usage diagnostic on stderr"
    );

    // --operation without a payload argument.
    let missing_payload = cli(&["--operation", "meta.get"], None);
    assert_eq!(exit_code(&missing_payload), 2);

    // --operation with invalid JSON payload.
    let bad_json = cli(&["--operation", "meta.get", "{not json"], None);
    assert_eq!(exit_code(&bad_json), 2);

    // Conflicting modes.
    let conflict = cli(&["--envelope", "--operation", "meta.get", "{}"], None);
    assert_eq!(exit_code(&conflict), 2);

    // Nothing to run.
    let nothing = cli(&[], None);
    assert_eq!(exit_code(&nothing), 2);
}

/// 9. Malformed stdin envelope → exit 1, diagnostic on stderr, empty stdout
///    (no envelope existed).
#[test]
fn malformed_stdin_envelope_exits_one() {
    let output = cli(&["--envelope"], Some(b"not json at all"));
    assert_eq!(exit_code(&output), 1);
    assert!(stdout_text(&output).is_empty(), "no envelope before decode");
    assert!(!stderr_text(&output).is_empty(), "diagnostic on stderr");
}

/// 10. Oversized stdin is refused by the bounded parser (§10).
#[test]
fn oversized_stdin_is_bounded() {
    let huge = vec![b'x'; 1024 * 1024 + 1];
    let output = cli(&["--envelope"], Some(&huge));
    assert_eq!(exit_code(&output), 1);
    assert!(stdout_text(&output).is_empty());
    assert!(
        stderr_text(&output).contains("limit"),
        "diagnostic names the limit: {}",
        stderr_text(&output)
    );
}
