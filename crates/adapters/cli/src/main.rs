//! # neotavern-cli — CLI transport for the Runtime Kernel (ТЗ §6.3, Phase 4
//! CLI hooks)
//!
//! Maps **one** wire request envelope → **one** wire response envelope
//! through the SAME [`runtime_kernel::Kernel`] instance the local IPC and
//! HTTP/SSE adapters use. The CLI owns no storage and no product rules: the
//! request is decoded with the generated contract decoder, checked against
//! the embedded wire protocol, and dispatched to the kernel; the response is
//! a validated `wire.response.envelope` — byte-identical to what the
//! `remote-http-adapter` answers (the shared envelope layer guarantees the
//! transports cannot drift, §6.3).
//!
//! ## Usage
//!
//! ```text
//! neotavern-cli --root <data-root> --operation <operationId> '<payload JSON>' [--request-id <uuid>]
//! neotavern-cli --root <data-root> --envelope            # read a full request envelope JSON from stdin
//! neotavern-cli --help
//! ```
//!
//! Without `--root` the kernel is stateless: `meta.get` works, storage
//! operations answer a controlled error envelope.
//!
//! ## Exit codes (stable contract)
//!
//! | Code | Meaning |
//! |---|---|
//! | `0` | The response envelope was produced with `kind: ok` (printed to stdout). |
//! | `1` | A response envelope with `kind: error` was produced (product/contract error, printed to stdout), OR a transport failure occurred before any envelope existed (diagnostic on stderr, stdout empty). |
//! | `2` | Usage error (bad arguments). |
//!
//! The response envelope JSON is always printed to stdout followed by a
//! newline; pre-envelope failures print a diagnostic to stderr only.

use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

use remote_http_adapter::envelope::{self, EnvelopeFailure, ProtocolVerdict};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use uuid::Uuid;

/// Bounded stdin cap (ТЗ §87: bounded parsers; matches the HTTP adapter's
/// 1 MiB request limit).
const MAX_STDIN_BYTES: usize = 1024 * 1024;

/// Stable exit codes (documented contract, see the module docs).
const EXIT_OK: u8 = 0;
const EXIT_ERROR: u8 = 1;
const EXIT_USAGE: u8 = 2;

/// A pre-envelope CLI failure. `Usage` is a caller mistake (exit 2);
/// `Transport` is an I/O or envelope-decode failure (exit 1).
enum CliError {
    /// Bad arguments: exit 2.
    Usage(String),
    /// I/O or envelope-decode failure before any envelope existed: exit 1.
    Transport(String),
}

/// What the invocation asks for.
enum Invocation {
    /// Read a full request envelope JSON from stdin.
    EnvelopeFromStdin,
    /// Build the request envelope from `--operation <operationId> <payload>`.
    Operation {
        operation_id: String,
        payload: serde_json::Value,
        request_id: String,
    },
}

/// Parsed command line.
struct Args {
    /// Optional data root; `None` = stateless kernel.
    root: Option<PathBuf>,
    invocation: Invocation,
}

const USAGE: &str = "\
usage: neotavern-cli [--root <data-root>] \
(--operation <operationId> '<payload JSON>' [--request-id <uuid>] | --envelope)";

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(CliError::Usage(message)) => {
            eprintln!("neotavern-cli: {message}");
            eprintln!("{USAGE}");
            ExitCode::from(EXIT_USAGE)
        }
        Err(CliError::Transport(message)) => {
            eprintln!("neotavern-cli: {message}");
            ExitCode::from(EXIT_ERROR)
        }
    }
}

fn run() -> Result<u8, CliError> {
    let args = parse_args()?;

    // Build the request envelope bytes from the invocation.
    let envelope_bytes = match &args.invocation {
        Invocation::EnvelopeFromStdin => read_stdin_bounded()?,
        Invocation::Operation {
            operation_id,
            payload,
            request_id,
        } => {
            let (major, minor) = contracts_generated::wire_protocol();
            let envelope = serde_json::json!({
                "wireProtocol": { "major": major, "minor": minor },
                "schemaHash": contracts_generated::contract_schema_hash(),
                "requestId": request_id,
                "operationId": operation_id,
                "payload": payload,
            });
            serde_json::to_vec(&envelope).map_err(|_| {
                CliError::Transport("failed to build the request envelope".to_string())
            })?
        }
    };

    // Decode + protocol check — the same boundary checks the HTTP adapter
    // runs (§6.4: the transport boundary is untrusted even locally).
    let env = envelope::decode_request_envelope(&envelope_bytes)
        .map_err(|failure| CliError::Transport(describe_failure(&failure)))?;
    let request_id = env.request_id.clone();
    match envelope::check_protocol(&env) {
        ProtocolVerdict::Compatible => {}
        ProtocolVerdict::MajorMismatch {
            client_major,
            server_major,
        } => {
            let body = envelope::build_error_response(
                &request_id,
                "PROTOCOL_MISMATCH",
                vec![
                    ("client_major".to_string(), client_major.to_string()),
                    ("server_major".to_string(), server_major.to_string()),
                ],
            )
            .unwrap_or_else(|_| INTERNAL_FALLBACK_BODY.as_bytes().to_vec());
            write_stdout(&body);
            return Ok(EXIT_ERROR);
        }
        ProtocolVerdict::MinorTooNew {
            client_minor,
            server_minor,
        } => {
            let body = envelope::build_error_response(
                &request_id,
                "PROTOCOL_MISMATCH",
                vec![
                    ("client_minor".to_string(), client_minor.to_string()),
                    ("server_minor".to_string(), server_minor.to_string()),
                ],
            )
            .unwrap_or_else(|_| INTERNAL_FALLBACK_BODY.as_bytes().to_vec());
            write_stdout(&body);
            return Ok(EXIT_ERROR);
        }
    }
    let payload = envelope::operation_payload_bytes(&env)
        .map_err(|failure| CliError::Transport(describe_failure(&failure)))?;

    // Open the kernel (exclusive data-root lease for `--root`) and dispatch.
    let kernel = match Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
        data_root: args.root.clone(),
    }) {
        Ok(kernel) => kernel,
        Err(err) => {
            // A controlled kernel error (e.g. `data_root_in_use`) still
            // produces a real error envelope with the request id echoed.
            let body = envelope::kernel_error_envelope(&err, &request_id);
            write_stdout(&body);
            return Ok(EXIT_ERROR);
        }
    };

    match kernel.dispatch(&env.operation_id, &payload, &CancellationFlag::new()) {
        Ok(result_bytes) => {
            let result = match serde_json::from_slice::<serde_json::Value>(&result_bytes) {
                Ok(result) => result,
                // The kernel's result bytes are its own DTO serialization; a
                // parse failure is an internal bug, never a payload issue.
                Err(_) => {
                    let body = error_envelope_body("INTERNAL", "result_json_parse_failed");
                    write_stdout(&body);
                    return Ok(EXIT_ERROR);
                }
            };
            let body = envelope::build_ok_response(&request_id, result)
                .map_err(|failure| CliError::Transport(describe_failure(&failure)))?;
            write_stdout(&body);
            Ok(EXIT_OK)
        }
        Err(err) => {
            let body = envelope::kernel_error_envelope(&err, &request_id);
            write_stdout(&body);
            Ok(EXIT_ERROR)
        }
    }
}

/// A static error-envelope fallback for program-invariant build failures
/// (never payload-driven).
const INTERNAL_FALLBACK_BODY: &str = r#"{"kind":"error","requestId":"","error":{"code":"INTERNAL","params":{"rule":"envelope_build_failed"}}}"#;

/// Builds a `{"kind":"error", ...}` envelope body with the given code/rule.
fn error_envelope_body(code: &str, rule: &str) -> Vec<u8> {
    envelope::build_error_response("", code, vec![("rule".to_string(), rule.to_string())])
        .unwrap_or_else(|_| INTERNAL_FALLBACK_BODY.as_bytes().to_vec())
}

/// Reads stdin up to [`MAX_STDIN_BYTES`]; larger input is a transport error
/// (§10: bounded parsers).
fn read_stdin_bounded() -> Result<Vec<u8>, CliError> {
    let mut bytes = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let mut stdin = std::io::stdin().lock();
    loop {
        match stdin.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.len() > MAX_STDIN_BYTES {
                    return Err(CliError::Transport(format!(
                        "stdin exceeds the {} byte envelope limit",
                        MAX_STDIN_BYTES
                    )));
                }
            }
            Err(err) => return Err(CliError::Transport(format!("stdin read failed: {err}"))),
        }
    }
    Ok(bytes)
}

/// Writes the envelope JSON to stdout followed by a newline. A broken pipe
/// is not an error the CLI can recover from; it is silently ignored like the
/// HTTP adapter's `request.respond` failures.
fn write_stdout(body: &[u8]) {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(body);
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

/// Human-readable transport-failure description for stderr.
fn describe_failure(failure: &EnvelopeFailure) -> String {
    let params = failure
        .params
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{} (status {}): {}",
        failure.code, failure.http_status, params
    )
}

/// Minimal std-only argument parser (no clap dependency).
fn parse_args() -> Result<Args, CliError> {
    let mut args = env::args().skip(1);
    let mut root: Option<PathBuf> = None;
    let mut operation: Option<(String, serde_json::Value)> = None;
    let mut request_id: Option<String> = None;
    let mut from_stdin = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("neotavern-cli — Runtime Kernel CLI transport (ТЗ §6.3)");
                println!("{USAGE}");
                std::process::exit(i32::from(EXIT_OK));
            }
            "--root" => {
                let value = args
                    .next()
                    .ok_or_else(|| CliError::Usage("--root requires a path".to_string()))?;
                root = Some(PathBuf::from(value));
            }
            "--operation" => {
                let operation_id = args.next().ok_or_else(|| {
                    CliError::Usage("--operation requires an operationId".to_string())
                })?;
                let payload_text = args.next().ok_or_else(|| {
                    CliError::Usage("--operation requires a payload JSON argument".to_string())
                })?;
                let payload: serde_json::Value = serde_json::from_str(&payload_text)
                    .map_err(|err| CliError::Usage(format!("payload is not valid JSON: {err}")))?;
                operation = Some((operation_id, payload));
            }
            "--request-id" => {
                let value = args
                    .next()
                    .ok_or_else(|| CliError::Usage("--request-id requires a UUID".to_string()))?;
                Uuid::parse_str(&value)
                    .map_err(|err| CliError::Usage(format!("--request-id is not a UUID: {err}")))?;
                request_id = Some(value);
            }
            "--envelope" => from_stdin = true,
            other => {
                return Err(CliError::Usage(format!("unknown argument {other:?}")));
            }
        }
    }

    let invocation = match (operation, from_stdin) {
        (Some((operation_id, payload)), false) => Invocation::Operation {
            operation_id,
            payload,
            request_id: request_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        },
        (None, true) => {
            if request_id.is_some() {
                return Err(CliError::Usage(
                    "--request-id applies only to --operation".to_string(),
                ));
            }
            Invocation::EnvelopeFromStdin
        }
        (Some(_), true) => {
            return Err(CliError::Usage(
                "--operation and --envelope are mutually exclusive".to_string(),
            ));
        }
        (None, false) => {
            return Err(CliError::Usage(
                "nothing to run: pass --operation or --envelope".to_string(),
            ));
        }
    };

    Ok(Args { root, invocation })
}
