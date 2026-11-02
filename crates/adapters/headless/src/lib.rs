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
//! (`NEOTA_SECRET_*`, read-only). `session`, `unavailable` and `portable`
//! (`secrets.enc` v2, ADR-0040 — passphrase supplied via a file) are explicit
//! alternatives; there is never a plaintext fallback. Every backend wires
//! BOTH kernel seams: the writable store (so `providers.config.set apiKey`
//! commits) and the execution-time resolver (so a generation run resolves
//! the key at the point of use).

use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use remote_http_adapter::auth::AuthConfig;
use remote_http_adapter::{AdapterError, RemoteAdapter, RemoteAdapterConfig};
use runtime_kernel::{Kernel, KernelConfig};

mod secrets;

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
       neotavern-headless legacy-import --source <app.db> --root <data-root> [--activate]
       neotavern-headless legacy-rollback --root <data-root> [--to <path>]
       neotavern-headless --help

options:
  --root <path>                 canonical data-root (or NEOTA_DATA_ROOT)
  --bind <ip:port>              listen address (default 127.0.0.1:8080; NEOTA_BIND)
  --remote-exposure             allow a non-loopback bind (NEOTA_REMOTE_EXPOSURE=1)
  --auth                        pairing gate on /rpc and /rpc/stream (NEOTA_HEADLESS_AUTH=1)
  --allowed-origin <origin>     CORS allowlist entry (repeatable; NEOTA_ALLOWED_ORIGINS)
  --secret-backend <kind>       env | session | unavailable | portable
                                (default env; NEOTA_SECRET_BACKEND)
  --secrets-enc <path>          portable: secrets.enc path (NEOTA_SECRETS_ENC);
                                created on first launch when absent
  --secret-passphrase-file <p>  portable: file with the master passphrase
                                (NEOTA_SECRET_PASSPHRASE_FILE); the file's
                                single trailing newline is stripped; a wrong
                                passphrase fails closed at startup
  --allow-secrets-exposure      enable plaintext API-key reveal
                                (NEOTA_ALLOW_SECRETS_EXPOSURE=1; default OFF —
                                every other secret surface stays value-free)

stdout: one `listening <ip:port>` line, then the process waits for stdin EOF
        and drains the listener (exit 0). Ctrl+C kills the process; durable
        generation runs recover on the next open (ТЗ §8.3 interrupted).
stderr: diagnostics; with --auth, `credential-id` and `token` (token once).";

/// Explicit Headless secret-backend kinds (SEC-01: no silent plaintext).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretBackend {
    /// Read-only `NEOTA_SECRET_*` (VPS / Headless default).
    Env,
    /// Process-memory only; gone after restart.
    Session,
    /// Fail-closed: every secret op is unavailable.
    Unavailable,
    /// Portable `secrets.enc` v2 (ADR-0040): the encrypted file plus the
    /// master-passphrase file. The file is created on first launch when
    /// absent; a wrong passphrase fails closed at startup.
    Portable {
        /// `secrets.enc` path (created when absent).
        enc_path: PathBuf,
        /// File holding the master passphrase (never argv, never an env
        /// value — the path is the only thing the environment carries).
        passphrase_path: PathBuf,
    },
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
    /// Plaintext reveal policy for provider secrets (`secrets.exposure`).
    /// `false` (default) makes `providers.secrets.reveal` fail closed; the
    /// legacy `NEOTA_ALLOW_SECRETS_EXPOSURE` gate.
    pub allow_secrets_exposure: bool,
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
    let mut allow_secrets_exposure_flag = false;
    let mut allowed_origins: Vec<String> = Vec::new();
    let mut secret_backend: Option<String> = None;
    let mut secrets_enc: Option<PathBuf> = None;
    let mut secret_passphrase_file: Option<PathBuf> = None;

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
            "--allow-secrets-exposure" => allow_secrets_exposure_flag = true,
            "--allowed-origin" => {
                let value = rest.next().ok_or_else(|| {
                    ParseError::Usage("--allowed-origin requires an origin".to_string())
                })?;
                allowed_origins.push(value.as_ref().to_string());
            }
            "--secret-backend" => {
                let value = rest.next().ok_or_else(|| {
                    ParseError::Usage(
                        "--secret-backend requires env|session|unavailable|portable".to_string(),
                    )
                })?;
                secret_backend = Some(value.as_ref().to_string());
            }
            "--secrets-enc" => {
                let value = rest.next().ok_or_else(|| {
                    ParseError::Usage("--secrets-enc requires a path".to_string())
                })?;
                secrets_enc = Some(PathBuf::from(value.as_ref()));
            }
            "--secret-passphrase-file" => {
                let value = rest.next().ok_or_else(|| {
                    ParseError::Usage("--secret-passphrase-file requires a path".to_string())
                })?;
                secret_passphrase_file = Some(PathBuf::from(value.as_ref()));
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
    let allow_secrets_exposure =
        allow_secrets_exposure_flag || env_flag(env, "NEOTA_ALLOW_SECRETS_EXPOSURE");

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
    if secrets_enc.is_none() {
        if let Some(from_env) = env_value(env, "NEOTA_SECRETS_ENC") {
            secrets_enc = Some(PathBuf::from(from_env));
        }
    }
    if secret_passphrase_file.is_none() {
        if let Some(from_env) = env_value(env, "NEOTA_SECRET_PASSPHRASE_FILE") {
            secret_passphrase_file = Some(PathBuf::from(from_env));
        }
    }
    let secret_backend = assemble_secret_backend(
        secret_backend.as_deref().unwrap_or("env"),
        secrets_enc,
        secret_passphrase_file,
    )?;

    Ok(HeadlessConfig {
        data_root,
        bind_addr,
        remote_exposure,
        auth,
        allowed_origins,
        secret_backend,
        allow_secrets_exposure,
    })
}

/// Combines the `--secret-backend` kind with the portable path flags,
/// rejecting incomplete or contradictory selections (usage errors — never a
/// silently ignored flag).
fn assemble_secret_backend(
    raw: &str,
    secrets_enc: Option<PathBuf>,
    passphrase_file: Option<PathBuf>,
) -> Result<SecretBackend, ParseError> {
    match raw.to_ascii_lowercase().as_str() {
        "env" | "session" | "unavailable" => {
            if secrets_enc.is_some() || passphrase_file.is_some() {
                return Err(ParseError::Usage(
                    "--secrets-enc/--secret-passphrase-file are only valid with \
                     --secret-backend portable"
                        .to_string(),
                ));
            }
            match raw.to_ascii_lowercase().as_str() {
                "env" => Ok(SecretBackend::Env),
                "session" => Ok(SecretBackend::Session),
                _ => Ok(SecretBackend::Unavailable),
            }
        }
        "portable" => {
            let enc_path = secrets_enc.ok_or_else(|| {
                ParseError::Usage(
                    "--secret-backend portable requires --secrets-enc <path>".to_string(),
                )
            })?;
            let passphrase_path = passphrase_file.ok_or_else(|| {
                ParseError::Usage(
                    "--secret-backend portable requires --secret-passphrase-file <path>"
                        .to_string(),
                )
            })?;
            Ok(SecretBackend::Portable {
                enc_path,
                passphrase_path,
            })
        }
        other => Err(ParseError::Usage(format!(
            "unknown --secret-backend {other:?} (env|session|unavailable|portable)"
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
    let all: Vec<String> = args.into_iter().map(|a| a.as_ref().to_string()).collect();
    match all.get(1).map(String::as_str) {
        Some("legacy-import") => return legacy_import_run(all),
        Some("legacy-rollback") => return legacy_rollback_run(all),
        _ => {}
    }
    match parse_args(all) {
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

/// The `legacy-import` subcommand (ADR-0062, release-gate G7): a local
/// kernel entry point for migrating a legacy `app.db` into a staged data
/// root. Default = plan + stage + validate; `--activate` additionally runs
/// the ADR-0041 activation (`kind: "import"`). Never an HTTP route; the
/// remote Web Client cannot trigger it.
fn legacy_import_run(argv: Vec<String>) -> u8 {
    match legacy_import_parse(&argv) {
        Err(ParseError::Help) => {
            println!("{LEGACY_IMPORT_USAGE}");
            EXIT_OK
        }
        Err(ParseError::Usage(message)) => {
            eprintln!("neotavern-headless legacy-import: {message}");
            eprintln!("{LEGACY_IMPORT_USAGE}");
            EXIT_USAGE
        }
        Ok(options) => match legacy_import_exec(&options) {
            Ok(()) => EXIT_OK,
            Err(message) => {
                eprintln!("neotavern-headless legacy-import: {message}");
                EXIT_ERROR
            }
        },
    }
}

/// `legacy-import` options.
struct LegacyImportOptions {
    source: PathBuf,
    data_root: PathBuf,
    activate: bool,
}

fn legacy_import_parse(argv: &[String]) -> Result<LegacyImportOptions, ParseError> {
    let mut source: Option<PathBuf> = None;
    let mut data_root: Option<PathBuf> = None;
    let mut activate = false;
    let mut rest = argv.iter().skip(2); // argv[0] + the subcommand
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--help" | "-h" => return Err(ParseError::Help),
            "--source" => {
                let value = rest
                    .next()
                    .ok_or_else(|| ParseError::Usage("--source requires a path".to_string()))?;
                source = Some(PathBuf::from(value.as_str()));
            }
            "--root" => {
                let value = rest
                    .next()
                    .ok_or_else(|| ParseError::Usage("--root requires a path".to_string()))?;
                data_root = Some(PathBuf::from(value.as_str()));
            }
            "--activate" => activate = true,
            other => {
                return Err(ParseError::Usage(format!("unknown argument {other:?}")));
            }
        }
    }
    let source =
        source.ok_or_else(|| ParseError::Usage("--source <app.db> is required".to_string()))?;
    let data_root =
        data_root.ok_or_else(|| ParseError::Usage("--root <data-root> is required".to_string()))?;
    Ok(LegacyImportOptions {
        source,
        data_root,
        activate,
    })
}

fn legacy_import_exec(options: &LegacyImportOptions) -> Result<(), String> {
    use neotavern_storage::legacy_import;

    let staged_plan =
        legacy_import::plan(&options.source).map_err(|err| format!("plan failed: {err}"))?;
    for family in &staged_plan.families {
        println!("family {} {}", family.family, family.count);
    }
    if !staged_plan.ready {
        for problem in &staged_plan.problems {
            eprintln!("problem: {problem}");
        }
        return Err("legacy source fails the mandatory run group; nothing staged".into());
    }

    let staged = legacy_import::stage(&options.source, &options.data_root)
        .map_err(|err| format!("stage failed: {err}"))?;
    let report = &staged.report;
    println!(
        "converted characters {} chats {} messages {} lorebooks {} presets {}",
        report.characters, report.chats, report.messages, report.lorebooks, report.presets,
    );
    println!("staged {}", staged.root_id);

    if options.activate {
        let from_root = neotavern_storage::activation::active_root(&options.data_root)
            .map_err(|err| format!("resolve active root failed: {err}"))?;
        legacy_import::activate_staged(&options.data_root, &staged, &from_root)
            .map_err(|err| format!("activation failed: {err}"))?;
        println!("activated {}", staged.root_id);
    } else {
        println!("not activated (pass --activate after review)");
    }
    Ok(())
}

const LEGACY_IMPORT_USAGE: &str = "\
usage: neotavern-headless legacy-import --source <app.db> --root <data-root> [--activate]

Stages a legacy Drizzle `app.db` into a new versioned data root
(ADR-0062, ADR-0041): plan (dry run) -> staged copy -> validation.
The active root is never written by this command; `--activate` runs the
activation journal (kind \"import\") only after validation passes.

stdout: `family <name> <count>` per source family, `converted ...`,
        `staged <root-id>`, then `activated <root-id>` with --activate.
exit:   0 ok, 1 source/import failure (problems on stderr), 2 usage.";

/// The `legacy-rollback` subcommand (ADR-0062, release-gate G8): return the
/// data root to the retained previous root through the activation journal.
fn legacy_rollback_run(argv: Vec<String>) -> u8 {
    match legacy_rollback_parse(&argv) {
        Err(ParseError::Help) => {
            println!("{LEGACY_ROLLBACK_USAGE}");
            EXIT_OK
        }
        Err(ParseError::Usage(message)) => {
            eprintln!("neotavern-headless legacy-rollback: {message}");
            eprintln!("{LEGACY_ROLLBACK_USAGE}");
            EXIT_USAGE
        }
        Ok(options) => match legacy_rollback_exec(&options) {
            Ok(()) => EXIT_OK,
            Err(message) => {
                eprintln!("neotavern-headless legacy-rollback: {message}");
                EXIT_ERROR
            }
        },
    }
}

/// `legacy-rollback` options.
struct LegacyRollbackOptions {
    data_root: PathBuf,
    to: Option<PathBuf>,
}

fn legacy_rollback_parse(argv: &[String]) -> Result<LegacyRollbackOptions, ParseError> {
    let mut data_root: Option<PathBuf> = None;
    let mut to: Option<PathBuf> = None;
    let mut rest = argv.iter().skip(2); // argv[0] + the subcommand
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--help" | "-h" => return Err(ParseError::Help),
            "--root" => {
                let value = rest
                    .next()
                    .ok_or_else(|| ParseError::Usage("--root requires a path".to_string()))?;
                data_root = Some(PathBuf::from(value.as_str()));
            }
            "--to" => {
                let value = rest
                    .next()
                    .ok_or_else(|| ParseError::Usage("--to requires a path".to_string()))?;
                to = Some(PathBuf::from(value.as_str()));
            }
            other => {
                return Err(ParseError::Usage(format!("unknown argument {other:?}")));
            }
        }
    }
    let data_root =
        data_root.ok_or_else(|| ParseError::Usage("--root <data-root> is required".to_string()))?;
    Ok(LegacyRollbackOptions { data_root, to })
}

fn legacy_rollback_exec(options: &LegacyRollbackOptions) -> Result<(), String> {
    use neotavern_storage::activation;

    let target = match &options.to {
        Some(path) => path.clone(),
        None => activation::previous_root(&options.data_root)
            .map_err(|err| format!("scan retained roots failed: {err}"))?
            .ok_or_else(|| "no retained previous root to roll back to".to_string())?,
    };
    activation::rollback_to(&options.data_root, &target)
        .map_err(|err| format!("rollback failed: {err}"))?;
    println!("rolled back to {}", target.display());
    Ok(())
}

const LEGACY_ROLLBACK_USAGE: &str = "\
usage: neotavern-headless legacy-rollback --root <data-root> [--to <path>]

Returns the data root to the retained previous root (default: the newest
inactive root under roots/, or the path given by --to) through the activation
journal (kind \"rollback\", ADR-0041/0062). The rolled-back-from root stays on
disk, so the switch is itself reversible.

stdout: `rolled back to <path>`.
exit:   0 ok, 1 no retained root / rollback failure, 2 usage.";
/// Opens the kernel, binds the adapter, prints `listening <addr>`, waits for
/// stdin EOF, then drains the listener.
pub fn serve(config: HeadlessConfig) -> Result<(), String> {
    let kernel = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
        data_root: Some(config.data_root.clone()),
    })
    .map_err(|err| format!("kernel open failed: {err}"))?;
    secrets::wire_secrets(&kernel, &config.secret_backend)?;
    // SEC-01: plaintext reveal is host-gated, OFF by default (the legacy
    // NEOTA_ALLOW_SECRETS_EXPOSURE contract). Every other provider-secret DTO
    // stays value-free regardless.
    kernel.set_secrets_exposure(config.allow_secrets_exposure);
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
            ("NEOTA_ALLOW_SECRETS_EXPOSURE", "1"),
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
        assert!(config.allow_secrets_exposure);
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
        assert!(
            !config.allow_secrets_exposure,
            "plaintext reveal is OFF by default (SEC-01)"
        );
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
            "--allow-secrets-exposure",
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
        assert!(
            config.allow_secrets_exposure,
            "the --allow-secrets-exposure flag opts in"
        );
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
    fn portable_backend_requires_both_paths() {
        let missing_enc = parse(&[
            "--root",
            "x",
            "--secret-backend",
            "portable",
            "--secret-passphrase-file",
            "p.txt",
        ]);
        match missing_enc {
            Err(ParseError::Usage(message)) => {
                assert!(message.contains("--secrets-enc"), "{message}")
            }
            other => panic!("expected usage, got {other:?}"),
        }
        let missing_pass = parse(&[
            "--root",
            "x",
            "--secret-backend",
            "portable",
            "--secrets-enc",
            "secrets.enc",
        ]);
        match missing_pass {
            Err(ParseError::Usage(message)) => {
                assert!(message.contains("--secret-passphrase-file"), "{message}")
            }
            other => panic!("expected usage, got {other:?}"),
        }
    }

    #[test]
    fn portable_paths_are_rejected_for_non_portable_backends() {
        let result = parse(&[
            "--root",
            "x",
            "--secret-backend",
            "env",
            "--secrets-enc",
            "secrets.enc",
        ]);
        match result {
            Err(ParseError::Usage(message)) => {
                assert!(message.contains("only valid with"), "{message}")
            }
            other => panic!("expected usage, got {other:?}"),
        }
        let result = parse(&["--root", "x", "--secret-passphrase-file", "p.txt"]);
        assert!(matches!(result, Err(ParseError::Usage(_))));
    }

    #[test]
    fn portable_backend_parses_with_both_paths() {
        let config = parse(&[
            "--root",
            "x",
            "--secret-backend",
            "portable",
            "--secrets-enc",
            "data/secrets.enc",
            "--secret-passphrase-file",
            "data/passphrase.txt",
        ])
        .expect("parse");
        match config.secret_backend {
            SecretBackend::Portable {
                enc_path,
                passphrase_path,
            } => {
                assert_eq!(enc_path, PathBuf::from("data/secrets.enc"));
                assert_eq!(passphrase_path, PathBuf::from("data/passphrase.txt"));
            }
            other => panic!("expected portable, got {other:?}"),
        }
    }

    #[test]
    fn portable_paths_fill_from_the_environment() {
        let env = [
            ("NEOTA_DATA_ROOT", "/from-env"),
            ("NEOTA_SECRET_BACKEND", "portable"),
            ("NEOTA_SECRETS_ENC", "/srv/nt/secrets.enc"),
            ("NEOTA_SECRET_PASSPHRASE_FILE", "/srv/nt/passphrase"),
        ];
        let config = parse_args_with(["neotavern-headless"], &env).expect("parse env");
        match config.secret_backend {
            SecretBackend::Portable {
                enc_path,
                passphrase_path,
            } => {
                assert_eq!(enc_path, PathBuf::from("/srv/nt/secrets.enc"));
                assert_eq!(passphrase_path, PathBuf::from("/srv/nt/passphrase"));
            }
            other => panic!("expected portable, got {other:?}"),
        }
    }

    #[test]
    fn unspecified_bind_is_not_loopback() {
        let config = parse(&["--root", "x", "--bind", "0.0.0.0:9"]).expect("parse");
        assert_eq!(config.bind_addr.ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert!(!config.bind_addr.ip().is_loopback());
    }
}
