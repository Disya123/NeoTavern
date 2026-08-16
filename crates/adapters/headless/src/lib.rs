//! # neotavern-headless — Headless host over the shared Runtime Kernel
//!
//! ТЗ §11.3: the Headless server is a **transport adapter over the Kernel**.
//! It owns no product database and no domain rules. This crate is the
//! composition root the library `remote-http-adapter` never was: it opens a
//! data-root, wires an explicit SecretStore backend, binds
//! [`remote_http_adapter::RemoteAdapter`] (loopback by default) and drains
//! the listener on stdin EOF.
//!
//! Security defaults match the adapter (ТЗ §10 / §11.3.1):
//!
//! - loopback bind (`127.0.0.1:8080`) unless `--bind` / `NEOTA_BIND`;
//! - a non-loopback bind is refused unless `--remote-exposure`
//!   (`NEOTA_REMOTE_EXPOSURE=1`) opts in;
//! - a public bind still requires `--auth` (`NEOTA_HEADLESS_AUTH=1`) —
//!   enforced inside the adapter before any listener exists;
//! - CORS deny-by-default (`--allowed-origin` / `NEOTA_ALLOWED_ORIGINS`).
//!
//! Secret policy (SEC-01, documented at deployment): default `env`
//! (`NEOTA_SECRET_*`, read-only). `session` and `unavailable` are explicit
//! alternatives; there is never a plaintext fallback.

use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use remote_http_adapter::auth::AuthConfig;
use remote_http_adapter::{AdapterError, RemoteAdapter, RemoteAdapterConfig};
use runtime_kernel::{Kernel, KernelConfig};
use secret_store::{EnvSecretStore, MemorySecretStore, SecretStore, UnavailableSecretStore};

/// Stable exit codes (documented contract, see the crate README).
pub const EXIT_OK: u8 = 0;
pub const EXIT_ERROR: u8 = 1;
pub const EXIT_USAGE: u8 = 2;

/// Default loopback bind — a stable operator port, unlike the adapter
/// library's ephemeral `:0` (tests pass `--bind 127.0.0.1:0`).
const DEFAULT_BIND: &str = "127.0.0.1:8080";

/// Pairing store cap (same bound as the Desktop Remote Access host).
const MAX_CREDENTIALS: usize = 16;

/// Usage text printed for `--help` and usage errors.
pub const USAGE: &str = "\
usage: neotavern-headless --root <data-root> [options]
       neotavern-headless --help

options:
  --root <path>                 canonical data-root (or NEOTA_DATA_ROOT)
  --bind <ip:port>              listen address (default 127.0.0.1:8080; NEOTA_BIND)
  --remote-exposure             allow a non-loopback bind (NEOTA_REMOTE_EXPOSURE=1)
  --auth                        pairing gate on /rpc and /rpc/stream (NEOTA_HEADLESS_AUTH=1)
  --allowed-origin <origin>     CORS allowlist entry (repeatable; NEOTA_ALLOWED_ORIGINS)
  --secret-backend <kind>       env | session | unavailable (default env; NEOTA_SECRET_BACKEND)

stdout: one `listening <ip:port>` line, then the process waits for stdin EOF
        and drains the listener (exit 0). Ctrl+C kills the process; durable
        generation runs recover on the next open (ТЗ §8.3 interrupted).
stderr: diagnostics; with --auth, `credential-id` and `token` (token once).";

/// Explicit Headless secret-backend kinds (SEC-01: no silent plaintext).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretBackend {
    /// Read-only `NEOTA_SECRET_*` (VPS / Headless default).
    Env,
    /// Process-memory only; gone after restart.
    Session,
    /// Fail-closed: every secret op is unavailable.
    Unavailable,
}

/// Parsed Headless host configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadlessConfig {
    /// Required canonical data-root (exclusive kernel lease).
    pub data_root: PathBuf,
    /// Listen address. Default [`DEFAULT_BIND`].
    pub bind_addr: SocketAddr,
    /// Opt-in for a non-loopback bind (`trusted_proxy` on the adapter).
    pub remote_exposure: bool,
    /// Pairing gate. Required for a public bind.
    pub auth: bool,
    /// CORS exact-match allowlist; empty = deny-by-default.
    pub allowed_origins: Vec<String>,
    /// SecretStore backend wired into the kernel.
    pub secret_backend: SecretBackend,
}

/// Why argument parsing failed, or a request for `--help`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// `--help` / `-h` — the caller should print [`USAGE`] and exit 0.
    Help,
    /// Bad arguments: exit 2.
    Usage(String),
}

/// Parse `args` (including argv[0]) plus the process environment into a config.
///
/// CLI flags override the matching `NEOTA_*` environment variables. `--help`
/// returns [`ParseError::Help`] without requiring `--root`.
pub fn parse_args<I, S>(args: I) -> Result<HeadlessConfig, ParseError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let env: Vec<(String, String)> = std::env::vars().collect();
    parse_args_with(args, &env)
}

/// Parse `args` against an explicit env snapshot (unit tests pass `[]`).
pub fn parse_args_with<I, S>(
    args: I,
    env: &[(impl AsRef<str>, impl AsRef<str>)],
) -> Result<HeadlessConfig, ParseError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut argv = args.into_iter();
    let _argv0 = argv.next();

    let mut root: Option<PathBuf> = None;
    let mut bind: Option<String> = None;
    let mut remote_exposure_flag = false;
    let mut auth_flag = false;
    let mut allowed_origins: Vec<String> = Vec::new();
    let mut secret_backend: Option<String> = None;

    let mut rest = argv;
    while let Some(arg) = rest.next() {
        match arg.as_ref() {
            "--help" | "-h" => return Err(ParseError::Help),
            "--root" => {
                let value = rest
                    .next()
                    .ok_or_else(|| ParseError::Usage("--root requires a path".to_string()))?;
                root = Some(PathBuf::from(value.as_ref()));
            }
            "--bind" => {
                let value = rest
                    .next()
                    .ok_or_else(|| ParseError::Usage("--bind requires ip:port".to_string()))?;
                bind = Some(value.as_ref().to_string());
            }
            "--remote-exposure" => remote_exposure_flag = true,
            "--auth" => auth_flag = true,
            "--allowed-origin" => {
                let value = rest.next().ok_or_else(|| {
                    ParseError::Usage("--allowed-origin requires an origin".to_string())
                })?;
                allowed_origins.push(value.as_ref().to_string());
            }
            "--secret-backend" => {
                let value = rest.next().ok_or_else(|| {
                    ParseError::Usage(
                        "--secret-backend requires env|session|unavailable".to_string(),
                    )
                })?;
                secret_backend = Some(value.as_ref().to_string());
            }
            other => {
                return Err(ParseError::Usage(format!("unknown argument {other:?}")));
            }
        }
    }

    if root.is_none() {
        if let Some(from_env) = env_value(env, "NEOTA_DATA_ROOT") {
            root = Some(PathBuf::from(from_env));
        }
    }
    let data_root = root.ok_or_else(|| {
        ParseError::Usage("--root <data-root> is required (or NEOTA_DATA_ROOT)".to_string())
    })?;

    if bind.is_none() {
        if let Some(from_env) = env_value(env, "NEOTA_BIND") {
            bind = Some(from_env);
        }
    }
    let bind_text = bind.unwrap_or_else(|| DEFAULT_BIND.to_string());
    let bind_addr: SocketAddr = bind_text
        .parse()
        .map_err(|err| ParseError::Usage(format!("--bind {bind_text:?} is not ip:port: {err}")))?;

    let remote_exposure = remote_exposure_flag || env_flag(env, "NEOTA_REMOTE_EXPOSURE");
    let auth = auth_flag || env_flag(env, "NEOTA_HEADLESS_AUTH");

    if allowed_origins.is_empty() {
        if let Some(from_env) = env_value(env, "NEOTA_ALLOWED_ORIGINS") {
            allowed_origins = from_env
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(str::to_string)
                .collect();
        }
    }

    if secret_backend.is_none() {
        if let Some(from_env) = env_value(env, "NEOTA_SECRET_BACKEND") {
            secret_backend = Some(from_env);
        }
    }
    let secret_backend = parse_secret_backend(secret_backend.as_deref().unwrap_or("env"))?;

    Ok(HeadlessConfig {
        data_root,
        bind_addr,
        remote_exposure,
        auth,
        allowed_origins,
        secret_backend,
    })
}

fn parse_secret_backend(raw: &str) -> Result<SecretBackend, ParseError> {
    match raw.to_ascii_lowercase().as_str() {
        "env" => Ok(SecretBackend::Env),
        "session" => Ok(SecretBackend::Session),
        "unavailable" => Ok(SecretBackend::Unavailable),
        other => Err(ParseError::Usage(format!(
            "unknown --secret-backend {other:?} (env|session|unavailable)"
        ))),
    }
}

fn env_value(env: &[(impl AsRef<str>, impl AsRef<str>)], name: &str) -> Option<String> {
    env.iter().find_map(|(key, value)| {
        if key.as_ref() == name && !value.as_ref().is_empty() {
            Some(value.as_ref().to_string())
        } else {
            None
        }
    })
}

fn env_flag(env: &[(impl AsRef<str>, impl AsRef<str>)], name: &str) -> bool {
    env_value(env, name)
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
}

/// Run the host from an argv iterator. Returns a process exit code.
pub fn run<I, S>(args: I) -> u8
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    match parse_args(args) {
        Err(ParseError::Help) => {
            println!("neotavern-headless — Headless Kernel host (ТЗ §11.3)");
            println!("{USAGE}");
            EXIT_OK
        }
        Err(ParseError::Usage(message)) => {
            eprintln!("neotavern-headless: {message}");
            eprintln!("{USAGE}");
            EXIT_USAGE
        }
        Ok(config) => match serve(config) {
            Ok(()) => EXIT_OK,
            Err(message) => {
                eprintln!("neotavern-headless: {message}");
                EXIT_ERROR
            }
        },
    }
}

/// Opens the kernel, binds the adapter, prints `listening <addr>`, waits for
/// stdin EOF, then drains the listener.
pub fn serve(config: HeadlessConfig) -> Result<(), String> {
    let kernel = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
        data_root: Some(config.data_root.clone()),
    })
    .map_err(|err| format!("kernel open failed: {err}"))?;
    kernel.set_secret_store(secret_store_for(config.secret_backend));
    let kernel = Arc::new(Mutex::new(kernel));

    let adapter_config = RemoteAdapterConfig {
        bind_addr: config.bind_addr,
        trusted_proxy: config.remote_exposure,
        auth: if config.auth {
            Some(AuthConfig {
                max_credentials: MAX_CREDENTIALS,
            })
        } else {
            None
        },
        allowed_origins: config.allowed_origins.clone(),
        ..RemoteAdapterConfig::default()
    };

    let adapter = RemoteAdapter::start(kernel, adapter_config).map_err(format_adapter_error)?;
    let addr = adapter.local_addr();

    if config.auth {
        match adapter.pair(Some("headless-bootstrap".to_string())) {
            Ok((id, token)) => {
                // Token is returned once and never stored; stderr only.
                eprintln!("neotavern-headless: credential-id {id}");
                eprintln!("neotavern-headless: token {token}");
            }
            Err(err) => {
                let _ = adapter.shutdown();
                return Err(format!("pairing failed: {err:?}"));
            }
        }
    }

    {
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "listening {addr}")
            .map_err(|err| format!("stdout write failed: {err}"))?;
        stdout
            .flush()
            .map_err(|err| format!("stdout flush failed: {err}"))?;
    }

    wait_for_stdin_eof();
    adapter.shutdown().map_err(format_adapter_error)
}

fn secret_store_for(kind: SecretBackend) -> Arc<dyn SecretStore> {
    match kind {
        SecretBackend::Env => Arc::new(EnvSecretStore::from_process("NEOTA_SECRET_")),
        SecretBackend::Session => Arc::new(MemorySecretStore::new()),
        SecretBackend::Unavailable => Arc::new(UnavailableSecretStore),
    }
}

fn format_adapter_error(err: AdapterError) -> String {
    match err {
        AdapterError::InsecureBind { addr } => {
            format!("InsecureBind: non-loopback {addr} requires --remote-exposure")
        }
        AdapterError::PublicBindRequiresAuth { addr } => {
            format!("PublicBindRequiresAuth: public bind {addr} requires --auth")
        }
        AdapterError::BindFailed { addr, message } => {
            format!("BindFailed on {addr}: {message}")
        }
        AdapterError::ShutdownFailed { message } => format!("ShutdownFailed: {message}"),
    }
}

/// Blocks until stdin reaches EOF (tests close the pipe; operators Ctrl+D).
fn wait_for_stdin_eof() {
    let mut stdin = io::stdin().lock();
    let mut buf = [0u8; 256];
    loop {
        match stdin.read(&mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn parse(args: &[&str]) -> Result<HeadlessConfig, ParseError> {
        let mut argv = vec!["neotavern-headless"];
        argv.extend(args);
        let env: &[(&str, &str)] = &[];
        parse_args_with(argv, env)
    }

    #[test]
    fn env_snapshot_fills_root_bind_and_flags() {
        let env = [
            ("NEOTA_DATA_ROOT", "/from-env"),
            ("NEOTA_BIND", "127.0.0.1:0"),
            ("NEOTA_REMOTE_EXPOSURE", "1"),
            ("NEOTA_HEADLESS_AUTH", "true"),
            (
                "NEOTA_ALLOWED_ORIGINS",
                "https://a.example, https://b.example",
            ),
            ("NEOTA_SECRET_BACKEND", "unavailable"),
        ];
        let config = parse_args_with(["neotavern-headless"], &env).expect("parse env");
        assert_eq!(config.data_root, PathBuf::from("/from-env"));
        assert_eq!(config.bind_addr.port(), 0);
        assert!(config.remote_exposure);
        assert!(config.auth);
        assert_eq!(
            config.allowed_origins,
            vec![
                "https://a.example".to_string(),
                "https://b.example".to_string()
            ]
        );
        assert_eq!(config.secret_backend, SecretBackend::Unavailable);
    }

    #[test]
    fn help_is_a_distinct_outcome() {
        assert_eq!(parse(&["--help"]), Err(ParseError::Help));
        assert_eq!(parse(&["-h"]), Err(ParseError::Help));
    }

    #[test]
    fn missing_root_is_usage() {
        match parse(&[]) {
            Err(ParseError::Usage(message)) => {
                assert!(message.contains("--root"), "{message}");
            }
            other => panic!("expected usage, got {other:?}"),
        }
    }

    #[test]
    fn defaults_are_loopback_8080_env_store_no_auth() {
        let config = parse(&["--root", "/tmp/nt-data"]).expect("parse");
        assert_eq!(config.data_root, PathBuf::from("/tmp/nt-data"));
        assert_eq!(
            config.bind_addr,
            SocketAddr::from((Ipv4Addr::LOCALHOST, 8080))
        );
        assert!(!config.remote_exposure);
        assert!(!config.auth);
        assert!(config.allowed_origins.is_empty());
        assert_eq!(config.secret_backend, SecretBackend::Env);
    }

    #[test]
    fn flags_set_bind_auth_exposure_origin_and_backend() {
        let config = parse(&[
            "--root",
            "C:\\data",
            "--bind",
            "127.0.0.1:0",
            "--remote-exposure",
            "--auth",
            "--allowed-origin",
            "https://app.example",
            "--secret-backend",
            "session",
        ])
        .expect("parse");
        assert_eq!(config.bind_addr.port(), 0);
        assert!(config.bind_addr.ip().is_loopback());
        assert!(config.remote_exposure);
        assert!(config.auth);
        assert_eq!(
            config.allowed_origins,
            vec!["https://app.example".to_string()]
        );
        assert_eq!(config.secret_backend, SecretBackend::Session);
    }

    #[test]
    fn unknown_backend_and_unknown_flag_are_usage() {
        assert!(matches!(
            parse(&["--root", "x", "--secret-backend", "plaintext"]),
            Err(ParseError::Usage(_))
        ));
        assert!(matches!(
            parse(&["--root", "x", "--serve"]),
            Err(ParseError::Usage(_))
        ));
        assert!(matches!(
            parse(&["--bind", "not-an-addr", "--root", "x"]),
            Err(ParseError::Usage(_))
        ));
    }

    #[test]
    fn unspecified_bind_is_not_loopback() {
        let config = parse(&["--root", "x", "--bind", "0.0.0.0:9"]).expect("parse");
        assert_eq!(config.bind_addr.ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert!(!config.bind_addr.ip().is_loopback());
    }
}
