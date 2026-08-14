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

// --- offline migration flow (ТЗ §10.3) ---------------------------------------

/// Builds a minimal legacy Drizzle database (five product tables, no kernel
/// meta) with one character and one chat+message.
fn build_legacy(path: &std::path::Path) -> rusqlite::Result<()> {
    let conn = rusqlite::Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE characters (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, avatar TEXT,
            ext TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE chats (
            id TEXT PRIMARY KEY, title TEXT, character_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT, content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE lorebooks (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE presets (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE provider_configs (
            id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, config TEXT, api_key TEXT
        );",
    )?;
    conn.execute(
        "INSERT INTO characters (id, name, created_at, updated_at) \
         VALUES ('c1c1c1c1-0000-4000-8000-000000000001', 'Migrated', 1700000000000, 1700000001000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
         VALUES ('c1c1c1c1-0000-4000-8000-000000000002', 'Chat', 'c1c1c1c1-0000-4000-8000-000000000001', 1700000002000, 1700000003000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO messages (id, chat_id, role, content, created_at) \
         VALUES ('c1c1c1c1-0000-4000-8000-000000000003', 'c1c1c1c1-0000-4000-8000-000000000002', 'user', 'Hello', 1700000004000)",
        [],
    )?;
    Ok(())
}

/// 11. `--migrate-legacy` runs the offline staged migration: progress on
///     stderr, the committed report on stdout, then the kernel opens on the
///     activated (versioned) root — the canonical data-root switch.
#[test]
fn migrate_legacy_switches_the_canonical_data_root() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    let source = dir.path().join("legacy.db");
    build_legacy(&source).expect("build legacy db");

    let output = cli(
        &[
            "--root",
            data_root.to_str().unwrap(),
            "--migrate-legacy",
            source.to_str().unwrap(),
        ],
        None,
    );
    assert_eq!(exit_code(&output), 0, "stderr: {}", stderr_text(&output));
    let stdout = stdout_text(&output);
    assert!(stdout.contains("migration committed"), "stdout: {stdout}");
    assert!(stdout.contains("characters=1"), "stdout: {stdout}");
    assert!(stdout.contains("chats=1"), "stdout: {stdout}");
    assert!(stdout.contains("messages=1"), "stdout: {stdout}");
    assert!(
        stdout.contains("kernel opened on the active root"),
        "stdout: {stdout}"
    );
    assert!(
        stdout.contains("active_root:"),
        "stdout reports the active root path"
    );
    let stderr = stderr_text(&output);
    for stage in ["preflight", "convert", "validate", "activate"] {
        assert!(
            stderr.contains(stage),
            "stderr reports the {stage} stage: {stderr}"
        );
    }

    // The kernel really opens on the active root and reads migrated data
    // through the generated wire client (characters.get round-trip).
    let kernel = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
        data_root: Some(data_root.clone()),
    })
    .expect("kernel opens on the migrated root");
    let payload = serde_json::to_vec(
        &serde_json::json!({ "characterId": "c1c1c1c1-0000-4000-8000-000000000001" }),
    )
    .expect("payload");
    let result = kernel
        .dispatch(
            "characters.get",
            &payload,
            &runtime_kernel::CancellationFlag::new(),
        )
        .expect("characters.get after migration");
    let value: serde_json::Value = serde_json::from_slice(&result).expect("result JSON");
    assert_eq!(value["name"], "Migrated", "result: {value}");
    drop(kernel);

    // The previous (flat) root is retained as the rollback pointer and the
    // pointer file points into roots/.
    let journal = neotavern_storage::activation::read_journal(&data_root).expect("journal");
    let entry = journal.entries.last().expect("migration entry");
    assert_eq!(entry.kind, "migration");
    let active = neotavern_storage::activation::active_root(&data_root).expect("active root");
    assert_ne!(
        active, data_root,
        "active root is a versioned root, not the flat root"
    );
    assert!(
        active.starts_with(data_root.join("roots")),
        "active root under roots/: {}",
        active.display()
    );
}

/// 12. `--migrate-legacy` without `--root` is a usage error (exit 2).
#[test]
fn migrate_legacy_requires_root() {
    let output = cli(&["--migrate-legacy", "whatever.db"], None);
    assert_eq!(exit_code(&output), 2);
    assert!(
        stdout_text(&output).is_empty(),
        "no envelope on usage error"
    );
}

/// 13. Migrating a non-legacy source fails with exit 1 and a controlled
///     storage diagnostic (fail-closed, ТЗ §10.3); the data root is left
///     without any journal (no writes before validation).
#[test]
fn migrate_legacy_rejects_non_legacy_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_root = dir.path().join("data");
    let foreign = dir.path().join("foreign.db");
    {
        let conn = rusqlite::Connection::open(&foreign).expect("open foreign");
        conn.execute_batch("CREATE TABLE foo (id TEXT PRIMARY KEY)")
            .expect("create");
    }

    let output = cli(
        &[
            "--root",
            data_root.to_str().unwrap(),
            "--migrate-legacy",
            foreign.to_str().unwrap(),
        ],
        None,
    );
    assert_eq!(exit_code(&output), 1, "stderr: {}", stderr_text(&output));
    assert!(
        stderr_text(&output).contains("UnsupportedStorageFormat")
            || stderr_text(&output).contains("unsupported"),
        "diagnostic names the incompatibility: {}",
        stderr_text(&output)
    );
    assert!(
        !data_root.join("activation-journal.json").exists(),
        "no journal written for a refused migration"
    );
}
