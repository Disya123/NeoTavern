use serde::Serialize;
use tauri::AppHandle;

#[cfg(all(desktop, feature = "remote"))]
use neotavern_tauri_local::remote::{RemoteAccessService, RemoteAccessState};
#[cfg(desktop)]
use neotavern_tauri_local::{
    build_request_envelope, commands, KernelHost, KernelHostConfig, SecretBackend,
};
#[cfg(desktop)]
use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
#[cfg(desktop)]
use tauri::{path::BaseDirectory, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
#[cfg(desktop)]
use url::Url;

#[cfg(desktop)]
const STARTUP_ATTEMPTS: usize = 1200;
#[cfg(desktop)]
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(desktop)]
const UPDATE_ENDPOINT: Option<&str> = option_env!("NEOTA_UPDATE_ENDPOINT");
#[cfg(desktop)]
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("NEOTA_UPDATE_PUBLIC_KEY");
/// Backend mode selection вЂ” the honest staged default (ADR-0038 "Honest
/// Desktop default", AGENTS.md В§21).
///
/// The Runtime Kernel is the canonical core, but public/release builds
/// temporarily run the tested legacy Node sidecar while the Kernel is an
/// explicit Preview; nightly/internal builds default to the Kernel. The
/// channel is baked at build time via `NEOTA_DESKTOP_CHANNEL`
/// (`nightly` в†’ Kernel default; any other value or unset в†’ sidecar default).
/// Debug (dev) builds are internal and default to the Kernel.
///
/// Explicit runtime overrides always win: `NEOTA_LEGACY_SERVER=1` forces the
/// sidecar, `NEOTA_KERNEL=1` forces the Kernel (Preview opt-in). CONFLICT
/// POLICY (ADR-0038): when BOTH overrides are set, `NEOTA_KERNEL=1` wins вЂ”
/// the Kernel is the canonical plane and the direction of travel вЂ” and a
/// warning is printed to stderr. The full mode matrix is covered by unit
/// tests (`resolve_desktop_mode`, see `mod tests` below).
#[cfg(desktop)]
const LEGACY_SERVER_ENV: &str = "NEOTA_LEGACY_SERVER";
#[cfg(desktop)]
const KERNEL_MODE_ENV: &str = "NEOTA_KERNEL";
#[cfg(desktop)]
const DESKTOP_CHANNEL: Option<&str> = option_env!("NEOTA_DESKTOP_CHANNEL");

#[cfg(desktop)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DesktopMode {
    Sidecar,
    Kernel,
}

/// Pure mode resolver вЂ” the decision table behind [`desktop_mode`], explicit
/// inputs so the whole matrix is unit-testable (no env/global access).
///
/// Precedence (ADR-0038):
/// 1. `legacy_override` (`NEOTA_LEGACY_SERVER=1`) в†’ Sidecar;
/// 2. `kernel_override` (`NEOTA_KERNEL=1`) в†’ Kernel; when BOTH are set the
///    Kernel wins (conflict policy вЂ” the warning is printed by the caller);
/// 3. `debug_build` в†’ Kernel (dev builds are internal);
/// 4. build channel: every channel (release included) в†’ Kernel. The public
///    release flipped to the Kernel in round 59a; `NEOTA_LEGACY_SERVER=1` is the
///    only way back to the sidecar, for one transition window.
///    public release default while the Kernel is a Preview).
#[cfg(desktop)]
fn resolve_desktop_mode(
    legacy_override: bool,
    kernel_override: bool,
    debug_build: bool,
    channel: Option<&str>,
) -> DesktopMode {
    match (legacy_override, kernel_override) {
        (true, true) => DesktopMode::Kernel,
        (true, false) => DesktopMode::Sidecar,
        (false, true) => DesktopMode::Kernel,
        (false, false) => {
            // The public release runs the Kernel (round 59a). The channel no
            // longer decides: a release build without overrides is Kernel, and
            // the sidecar is reachable only through NEOTA_LEGACY_SERVER=1.
            let _ = channel;
            let _ = debug_build;
            DesktopMode::Kernel
        }
    }
}

#[cfg(desktop)]
fn desktop_mode() -> DesktopMode {
    let legacy = std::env::var(LEGACY_SERVER_ENV).as_deref() == Ok("1");
    let kernel = std::env::var(KERNEL_MODE_ENV).as_deref() == Ok("1");
    if legacy && kernel {
        eprintln!(
            "[neotavern] conflicting overrides: both NEOTA_LEGACY_SERVER=1 and NEOTA_KERNEL=1 are set; NEOTA_KERNEL wins (conflict policy, ADR-0038)"
        );
    }
    resolve_desktop_mode(legacy, kernel, cfg!(debug_assertions), DESKTOP_CHANNEL)
}

/// Truthful backend-mode probe for the web UI (DiagnosticsPanel "Kernel
/// Preview" marking, ADR-0038): the panel must show the Kernel as an explicit
/// Preview only when the Kernel is actually the active backend.
#[cfg(desktop)]
#[tauri::command]
fn desktop_backend_mode() -> &'static str {
    match desktop_mode() {
        DesktopMode::Kernel => "kernel",
        DesktopMode::Sidecar => "sidecar",
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::{resolve_desktop_mode, DesktopMode};

    #[test]
    fn every_channel_defaults_to_the_kernel() {
        for channel in [None, Some("release"), Some("stable"), Some("nightly")] {
            assert_eq!(
                resolve_desktop_mode(false, false, false, channel),
                DesktopMode::Kernel,
                "channel {channel:?} must default to the kernel"
            );
        }
    }

    #[test]
    fn debug_build_defaults_to_kernel_even_on_release_channel() {
        assert_eq!(
            resolve_desktop_mode(false, false, true, None),
            DesktopMode::Kernel
        );
        assert_eq!(
            resolve_desktop_mode(false, false, true, Some("release")),
            DesktopMode::Kernel
        );
    }

    #[test]
    fn explicit_legacy_override_forces_sidecar_everywhere() {
        for (debug, channel) in [
            (false, None),
            (false, Some("nightly")),
            (true, None),
            (true, Some("nightly")),
        ] {
            assert_eq!(
                resolve_desktop_mode(true, false, debug, channel),
                DesktopMode::Sidecar
            );
        }
    }

    #[test]
    fn explicit_kernel_override_forces_kernel_everywhere() {
        for (debug, channel) in [
            (false, None),
            (false, Some("release")),
            (true, None),
            (true, Some("release")),
        ] {
            assert_eq!(
                resolve_desktop_mode(false, true, debug, channel),
                DesktopMode::Kernel
            );
        }
    }

    #[test]
    fn conflicting_overrides_resolve_to_kernel() {
        // Conflict policy: NEOTA_KERNEL=1 wins over NEOTA_LEGACY_SERVER=1.
        for (debug, channel) in [
            (false, None),
            (false, Some("release")),
            (false, Some("nightly")),
            (true, None),
        ] {
            assert_eq!(
                resolve_desktop_mode(true, true, debug, channel),
                DesktopMode::Kernel
            );
        }
    }

    #[test]
    fn mode_matrix_is_total_and_consistent() {
        let channels: [Option<&str>; 4] = [None, Some("release"), Some("nightly"), Some("custom")];
        for legacy in [false, true] {
            for kernel in [false, true] {
                for debug in [false, true] {
                    for channel in channels {
                        let mode = resolve_desktop_mode(legacy, kernel, debug, channel);
                        // Round 59a: only an explicit legacy override still
                        // selects the sidecar; everything else is the Kernel.
                        let expected = if kernel || !legacy {
                            DesktopMode::Kernel
                        } else {
                            DesktopMode::Sidecar
                        };
                        assert_eq!(
                            mode, expected,
                            "legacy={legacy} kernel={kernel} debug={debug} channel={channel:?}"
                        );
                    }
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreUpdateStatus {
    configured: bool,
    current_version: String,
    available_version: Option<String>,
}

#[cfg(desktop)]
fn core_update_configuration() -> Result<Option<(Url, &'static str)>, String> {
    let (Some(endpoint), Some(public_key)) = (UPDATE_ENDPOINT, UPDATE_PUBLIC_KEY) else {
        return Ok(None);
    };
    if public_key.trim().is_empty() {
        return Err("NEOTA_UPDATE_PUBLIC_KEY must not be empty".to_string());
    }
    let endpoint =
        Url::parse(endpoint).map_err(|error| format!("invalid core update endpoint: {error}"))?;
    if endpoint.scheme() != "https" {
        return Err("core update endpoint must use HTTPS".to_string());
    }
    Ok(Some((endpoint, public_key)))
}

#[cfg(desktop)]
#[tauri::command]
async fn check_core_update(app: AppHandle) -> Result<CoreUpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let Some((endpoint, public_key)) = core_update_configuration()? else {
        return Ok(CoreUpdateStatus {
            configured: false,
            current_version,
            available_version: None,
        });
    };
    let update = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(CoreUpdateStatus {
        configured: true,
        current_version,
        available_version: update.map(|release| release.version),
    })
}

#[cfg(desktop)]
#[tauri::command]
async fn install_core_update(app: AppHandle) -> Result<bool, String> {
    let Some((endpoint, public_key)) = core_update_configuration()? else {
        return Err("core updater is not configured for this build".to_string());
    };
    let update = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let Some(update) = update else {
        return Ok(false);
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    app.restart();
}

// Mobile has no updater (no desktop bundle): the same commands are served as
// stubs so the SPA diagnostics panel gets a truthful, typed answer instead of
// an "unknown command" error.
#[cfg(mobile)]
#[tauri::command]
fn mobile_check_core_update(app: AppHandle) -> CoreUpdateStatus {
    CoreUpdateStatus {
        configured: false,
        current_version: app.package_info().version.to_string(),
        available_version: None,
    }
}

#[cfg(mobile)]
#[tauri::command]
fn mobile_install_core_update(_app: AppHandle) -> Result<bool, String> {
    Err("core updater is not available on this platform".into())
}

#[cfg(desktop)]
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
}

#[cfg(desktop)]
fn sidecar_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let rendered = path.to_string_lossy();
        if let Some(stripped) = rendered.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

#[cfg(desktop)]
fn reserve_loopback_port() -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

#[cfg(desktop)]
fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.stopping.store(true, Ordering::Release);
    if let Ok(mut child) = state.child.lock() {
        if let Some(process) = child.take() {
            let _ = process.kill();
        }
    };
}

/// Resolves the canonical local data root: `data/` next to the executable for
/// the portable build, otherwise the platform app-data directory. Both the
/// kernel and (opt-in) legacy sidecar use this root; only one mode runs at a
/// time, so the root never has two writable owners. Returns `(root, portable)`
/// вЂ” the portable flag selects the secret backend (SEC-01.1).
#[cfg(desktop)]
fn resolve_data_dir(app: &tauri::App) -> Result<(PathBuf, bool), Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    let portable_data_dir = executable
        .parent()
        .filter(|directory| directory.join("portable.flag").is_file())
        .map(|directory| directory.join("data"));
    let (data_dir, portable) = match portable_data_dir {
        Some(directory) => (directory, true),
        None => (app.path().app_local_data_dir()?, false),
    };
    fs::create_dir_all(&data_dir)?;
    Ok((data_dir, portable))
}

#[cfg(desktop)]
fn open_main_window_when_ready(app: AppHandle, port: u16) {
    thread::spawn(move || {
        let address = ("127.0.0.1", port);
        let ready = (0..STARTUP_ATTEMPTS).any(|_| {
            if TcpStream::connect(address).is_ok() {
                return true;
            }
            thread::sleep(STARTUP_POLL_INTERVAL);
            false
        });

        if !ready {
            eprintln!("backend sidecar did not become ready");
            if std::env::var("NEOTA_DESKTOP_SMOKE").as_deref() == Ok("1") {
                stop_sidecar(&app);
                std::process::exit(1);
            }
            app.exit(1);
            return;
        }

        if std::env::var("NEOTA_DESKTOP_SMOKE").as_deref() == Ok("1") {
            // Deterministic smoke exit: kill the sidecar and exit directly.
            // `app.exit()` routes through the GTK event loop, which can stay
            // wedged under xvfb on slow CI runners after the backend is
            // already ready; the smoke must not depend on loop teardown.
            stop_sidecar(&app);
            std::process::exit(0);
        }

        let url = match Url::parse(&format!("http://127.0.0.1:{port}")) {
            Ok(url) => url,
            Err(error) => {
                eprintln!("failed to construct backend URL: {error}");
                app.exit(1);
                return;
            }
        };
        if let Err(error) = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(url))
            .title("NeoTavern")
            .inner_size(1280.0, 820.0)
            .min_inner_size(360.0, 520.0)
            .build()
        {
            eprintln!("failed to create main window: {error}");
            app.exit(1);
        }
    });
}

/// Spawns the legacy Node sidecar вЂ” the release-channel default while the
/// Kernel is a Preview, and the explicit `NEOTA_LEGACY_SERVER=1` transition
/// bridge for unmigrated features (ADR-0038). Returns the events receiver and
/// child.
#[cfg(desktop)]
fn spawn_legacy_sidecar(
    app: &tauri::App,
    port: u16,
    data_dir: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let web_dir = sidecar_path(
        app.path()
            .resolve("resources/web", BaseDirectory::Resource)?,
    );
    let sharp_module = sidecar_path(app.path().resolve(
        "resources/native/node_modules/sharp/lib/index.js",
        BaseDirectory::Resource,
    )?);
    let sqlite_module = sidecar_path(app.path().resolve(
        "resources/native/node_modules/better-sqlite3/lib/index.js",
        BaseDirectory::Resource,
    )?);
    let plugin_node = sidecar_path(app.path().resolve(
        if cfg!(windows) {
            "resources/runtime/node.exe"
        } else {
            "resources/runtime/node"
        },
        BaseDirectory::Resource,
    )?);
    let plugin_worker = sidecar_path(app.path().resolve(
        "resources/runtime/plugin-worker.mjs",
        BaseDirectory::Resource,
    )?);
    let plugin_loader = sidecar_path(app.path().resolve(
        "resources/runtime/plugin-loader.mjs",
        BaseDirectory::Resource,
    )?);

    let (mut events, child) = app
        .shell()
        .sidecar("neotavern-server")?
        .env("NEOTA_HOST", "127.0.0.1")
        .env("NEOTA_PORT", port.to_string())
        .env("NEOTA_DATA_DIR", data_dir)
        .env("NEOTA_WEB_DIR", web_dir)
        .env("NEOTA_SHARP_MODULE", sharp_module)
        .env("NEOTA_SQLITE_MODULE", sqlite_module)
        .env("NEOTA_PLUGIN_NODE", plugin_node)
        .env("NEOTA_PLUGIN_WORKER", plugin_worker)
        .env("NEOTA_PLUGIN_LOADER", plugin_loader)
        .env("NEOTA_CORS_ORIGIN", format!("http://127.0.0.1:{port}"))
        .spawn()?;

    {
        let state = app.state::<SidecarState>();
        let mut slot = state
            .child
            .lock()
            .map_err(|_| "sidecar state lock was poisoned")?;
        *slot = Some(child);
    }

    let event_app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    eprintln!("[server] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[server:error] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("backend sidecar terminated: {payload:?}");
                    let state = event_app.state::<SidecarState>();
                    if !state.stopping.load(Ordering::Acquire) {
                        event_app.exit(1);
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    open_main_window_when_ready(app.handle().clone(), port);
    Ok(())
}

/// Phase 3 local kernel mode: the packaged kernel owns the data root; the
/// window loads the bundled web assets over `tauri://localhost` with no HTTP
/// server at all. With `NEOTA_DESKTOP_SMOKE=1` the shell self-checks the
/// packaged kernel (handshake + meta + reads) and exits deterministically.
#[cfg(desktop)]
fn setup_local_kernel_mode(
    app: &mut tauri::App,
    data_dir: PathBuf,
    portable: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    std::env::set_var("NEOTA_SEED_STARTER", "1");
    let host = KernelHost::open(KernelHostConfig {
        // Clone: `data_dir` is also the Remote Access config fallback (the
        // kernel data root is guaranteed writable and exists).
        data_root: Some(data_dir.clone()),
        secret_backend: resolve_secret_backend(portable),
        // SEC-01 plaintext-reveal gate: OFF unless the operator opted in
        // (the legacy NEOTA_ALLOW_SECRETS_EXPOSURE contract; the accepted
        // truthy spellings match the headless host).
        allow_secrets_exposure: std::env::var("NEOTA_ALLOW_SECRETS_EXPOSURE")
            .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false),
    })
    .map_err(|error| {
        // Controlled kernel error (contract mismatch, data_root_in_use,
        // storage failure): the shell must not open a window against a dead
        // kernel, and the error goes to stderr diagnostics only.
        eprintln!("kernel open failed: {error}");
        error.to_string()
    })?;

    // Рњ5 slice 57 (РўР— В§8.3/В§9.3): the host performs the effects of registered
    // safe tools вЂ” the kernel never executes tools. Wire the declarative
    // `app_now` contract (UTC clock, side-effect-free, consent-free) and the
    // built-in executor that resumes waiting runs automatically.
    host.set_tool_executor(Some(Arc::new(neotavern_host_tools::BuiltinToolExecutor)));
    host.register_tool(serde_json::json!({
        "id": "app-now",
        "name": "app_now",
        "description": "Return the current UTC date and time.",
        "inputSchema": { "type": "object" },
    }))
    .map_err(|error| {
        eprintln!("built-in tool registration failed: {error}");
        error
    })?;

    app.manage(host);

    // Phase 9 Remote Access host service (РўР— В§10): the service wraps the
    // remote-http adapter lifecycle; its config persists next to the app
    // data. Resolution is best-effort вЂ” a failure falls back to the local
    // data dir instead of failing startup (Remote Access is off by default;
    // the UI surfaces any persistence failure later as `REMOTE_IO`).
    #[cfg(feature = "remote")]
    {
        let config_dir = app
            .path()
            .app_config_dir()
            .or_else(|_| app.path().app_local_data_dir())
            .unwrap_or_else(|_| data_dir.clone());
        // Best-effort: an unwritable config dir only degrades config
        // persistence, never startup.
        let _ = std::fs::create_dir_all(&config_dir);
        let service = RemoteAccessService::new(config_dir.join("remote-access.json"));
        app.manage(RemoteAccessState(service));
    }

    if std::env::var("NEOTA_DESKTOP_SMOKE").as_deref() == Ok("1") {
        let smoke =
            run_kernel_smoke(app.handle()).and_then(|_| run_golden_smoke(app.handle(), &data_dir));
        if let Err(error) = smoke {
            eprintln!("[smoke] FAILED: {error}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }

    if let Err(error) =
        WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::App("index.html".into()))
            .title("NeoTavern")
            .inner_size(1280.0, 820.0)
            .min_inner_size(360.0, 520.0)
            .build()
    {
        eprintln!("failed to create main window: {error}");
        app.handle().exit(1);
    }
    Ok(())
}

/// Selects the kernel SecretStore backend (РўР— В§SEC-01, SEC-01.1).
///
/// - `NEOTA_SECRET_BACKEND=osvault|session` wins explicitly (tests, rollback);
/// - smoke self-checks stay deterministic with the session-only store;
/// - portable mode keeps the explicit session-only interim until the
///   portable `secrets.enc` wiring slice lands;
/// - installed (non-portable) kernel mode defaults to the machine-bound OS
///   credential vault (Windows Credential Manager / macOS Keychain / Linux
///   Secret Service): keys never travel with the data folder, an
///   unreachable vault reports `SECRET_UNAVAILABLE_ON_THIS_DEVICE` вЂ” never a
///   plaintext fallback.
#[cfg(desktop)]
fn resolve_secret_backend(portable: bool) -> SecretBackend {
    if let Ok(value) = std::env::var("NEOTA_SECRET_BACKEND") {
        return match value.as_str() {
            "osvault" => SecretBackend::OsVault,
            _ => SecretBackend::Session,
        };
    }
    if std::env::var("NEOTA_DESKTOP_SMOKE").as_deref() == Ok("1") || portable {
        return SecretBackend::Session;
    }
    SecretBackend::OsVault
}

/// Deterministic smoke self-check for the packaged local kernel: exercises
/// the exact local handshake (already validated by [`KernelHost::open`]) plus
/// one meta and two read operations through the shared envelope layer. Any
/// non-ok envelope or transport failure fails the check.
#[cfg(desktop)]
fn run_kernel_smoke(app: &AppHandle) -> Result<(), String> {
    let host = app.state::<KernelHost>();
    for (operation_id, payload) in [
        ("meta.get", serde_json::json!({})),
        ("characters.list", serde_json::json!({})),
        ("backups.list", serde_json::json!({})),
    ] {
        dispatch_ok(&host, operation_id, payload)
            .map_err(|error| format!("{operation_id}: {error}"))?;
        eprintln!("[smoke] {operation_id}: ok");
    }
    Ok(())
}

/// One unary wire round trip: envelope в†’ protocol check в†’ kernel dispatch в†’
/// validated response envelope. `Err` carries the envelope error or a
/// transport failure.
#[cfg(desktop)]
fn dispatch_ok(
    host: &KernelHost,
    operation_id: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = build_request_envelope(
        operation_id,
        payload,
        "00000000-0000-4000-8000-000000000001",
    );
    let body = host
        .dispatch_envelope(&request)
        .map_err(|failure| format!("transport failure: {failure:?}"))?;
    let envelope: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "response was not JSON".to_string())?;
    match envelope.get("kind").and_then(|k| k.as_str()) {
        Some("ok") => Ok(envelope
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null)),
        _ => Err(format!(
            "error envelope {}",
            envelope
                .get("error")
                .map(|e| e.to_string())
                .unwrap_or_default()
        )),
    }
}

/// Opens a live wire stream through the host and collects every forwarded
/// event envelope until the end-of-stream sentinel, returning the run id and
/// the event log.
#[cfg(desktop)]
/// Dispatches an operation EXPECTING an error envelope; resolves with the
/// serialized error object (for fail-closed assertions like
/// `providers.secrets.reveal` with exposure off).
fn dispatch_error(
    host: &KernelHost,
    operation_id: &str,
    payload: serde_json::Value,
) -> Result<String, String> {
    let request = build_request_envelope(
        operation_id,
        payload,
        "00000000-0000-4000-8000-000000000004",
    );
    let body = host
        .dispatch_envelope(&request)
        .map_err(|failure| format!("transport failure: {failure:?}"))?;
    let envelope: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "response was not JSON".to_string())?;
    if envelope.get("kind").and_then(|k| k.as_str()) == Some("ok") {
        return Err(format!(
            "{operation_id}: expected an error envelope, got ok"
        ));
    }
    Ok(envelope
        .get("error")
        .map(|error| error.to_string())
        .unwrap_or_default())
}

fn run_stream(
    host: &KernelHost,
    operation_id: &str,
    payload: serde_json::Value,
) -> Result<(String, Vec<serde_json::Value>), String> {
    let request = build_request_envelope(
        operation_id,
        payload,
        "00000000-0000-4000-8000-000000000002",
    );
    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
    let body = host
        .open_stream(&request, move |event| {
            let _ = tx.send(event);
            Ok(())
        })
        .map_err(|failure| format!("transport failure: {failure:?}"))?;
    let envelope: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "stream response was not JSON".to_string())?;
    if envelope.get("kind").and_then(|k| k.as_str()) != Some("ok") {
        return Err(format!(
            "{operation_id}: error envelope {}",
            envelope
                .get("error")
                .map(|e| e.to_string())
                .unwrap_or_default()
        ));
    }
    let stream_id = envelope["result"]["streamId"]
        .as_str()
        .ok_or_else(|| "stream response carried no streamId".to_string())?
        .to_string();
    let mut events = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("stream did not terminate in time".to_string());
        }
        let event = rx
            .recv_timeout(remaining.min(Duration::from_secs(5)))
            .map_err(|_| "stream channel closed without a terminal sentinel".to_string())?;
        if event.is_null() {
            break;
        }
        events.push(event);
    }
    Ok((stream_id, events))
}

/// The packaged golden vertical slice (Р­С‚Р°Рї 2.9/2.10): the SAME user flow the
/// UI drives through the generated client, exercised over the REAL Tauri host
/// path (shell в†’ KernelHost envelope в†’ kernel в†’ SQLite) on a fresh data root:
///
/// 1. character в†’ chat в†’ user message;
/// 2. `generation.start` (deterministic fake grammar) в†’ the run completes and
///    saves exactly one assistant message durably;
/// 3. a tool round trip (В§8.3): register a declarative tool, a second run
///    durably waits (`waiting_for_tool`), `generation.tools.list` serves the
///    contract, `generation.tool.result` resumes and completes the run with a
///    second assistant message;
/// 4. a full chats/messages CRUD walk on a throwaway chat вЂ” every op of the
///    `chats.crud` and `chats.messages.crud` capabilities (G6 evidence);
/// 5. full library-cluster walks вЂ” every op of presets, personas, memories,
///    lorebooks (+entries), providers.list and settings (G6 evidence).
///
/// No HTTP, no sidecar, no UI: this is the packaged host's own self-check,
/// runnable headless via `NEOTA_DESKTOP_SMOKE=1`.
#[cfg(desktop)]
fn run_golden_smoke(app: &AppHandle, data_dir: &std::path::Path) -> Result<(), String> {
    let host = app.state::<KernelHost>();

    // 1. Library + conversation setup (wire CRUD).
    let character = dispatch_ok(
        &host,
        "characters.create",
        serde_json::json!({
            "name": "Aria",
            "description": "Golden slice character",
            "tags": [],
        }),
    )?;
    let character_id = character["id"]
        .as_str()
        .ok_or_else(|| "character response carried no id".to_string())?
        .to_string();
    let chat = dispatch_ok(
        &host,
        "chats.create",
        serde_json::json!({
            "characterId": character_id,
            "title": "Golden slice",
        }),
    )?;
    let chat_id = chat["id"]
        .as_str()
        .ok_or_else(|| "chat response carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "chats.messages.create",
        serde_json::json!({
            "chatId": chat_id,
            "role": "user",
            "content": "Hello",
        }),
    )?;
    eprintln!("[smoke] golden: character/chat/message created");

    // 2. Plain generation в†’ durable save (fake provider, deterministic
    //    grammar: one step Г— 24 chars).
    let (run_id, _events) = run_stream(
        &host,
        "generation.start",
        serde_json::json!({
            "chatId": chat_id,
            "message": "Hello",
            "provider": "fake",
            "model": "steps=1;tokens-per-step=24",
        }),
    )?;
    let run = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": run_id }),
    )?;
    if run["status"] != serde_json::json!("completed") {
        return Err(format!("plain run did not complete: {run}"));
    }
    let assistant_count = count_assistant_messages(&host, &chat_id)?;
    if assistant_count != 1 {
        return Err(format!(
            "plain run must save exactly one assistant message, found {assistant_count}"
        ));
    }
    let messages = dispatch_ok(
        &host,
        "chats.messages.list",
        serde_json::json!({ "chatId": chat_id, "limit": 200 }),
    )?;
    let assistant_content = messages["items"]
        .as_array()
        .and_then(|items| items.iter().find(|m| m["role"] == "assistant"))
        .and_then(|m| m["content"].as_str())
        .ok_or_else(|| "assistant message has no content".to_string())?;
    if assistant_content.chars().count() != 24 {
        return Err(format!(
            "assistant content length {} != 24 (deterministic fake grammar)",
            assistant_content.chars().count()
        ));
    }
    eprintln!("[smoke] golden: generation completed, one assistant message saved");

    // 3. Tool round trip (В§8.3). The fake adapter calls with
    //    `{"query": "<input>"}`, so the registered schema accepts exactly
    //    that (matching the kernel integration suite's weather tool).
    host.register_tool(serde_json::json!({
        "id": "lookup-weather",
        "name": "lookup_weather",
        "description": "Look up the current weather for a city.",
        "inputSchema": {
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"],
            "additionalProperties": false
        },
    }))?;
    eprintln!("[smoke] golden: tool registered");
    let (tool_run_id, _events) = run_stream(
        &host,
        "generation.start",
        serde_json::json!({
            "chatId": chat_id,
            "message": "Weather in Kyiv",
            "provider": "fake",
            "model": "tool=lookup_weather",
        }),
    )?;
    let tool_run = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": tool_run_id }),
    )?;
    if tool_run["status"] != serde_json::json!("waiting_for_tool") {
        return Err(format!("tool run did not wait: {tool_run}"));
    }
    let tools = dispatch_ok(&host, "generation.tools.list", serde_json::json!({}))?;
    let tool_ids: Vec<&str> = tools["items"]
        .as_array()
        .map(|items| items.iter().filter_map(|t| t["id"].as_str()).collect())
        .unwrap_or_default();
    // The host registers its built-in `app-now` clock contract at startup
    // (M5 slice 57); the smoke adds exactly one more.
    if tool_ids != ["app-now", "lookup-weather"] {
        return Err(format!(
            "tools.list must serve the built-in plus the smoke contract: {tools}"
        ));
    }
    let events = dispatch_ok(
        &host,
        "generation.events",
        serde_json::json!({ "workflowId": tool_run_id, "limit": 200 }),
    )?;
    let tool_call_id = events["items"]
        .as_array()
        .and_then(|items| {
            items.iter().find(|e| {
                e["type"] == "generation.step" && e["payload"]["step"]["type"] == "tool_call"
            })
        })
        .and_then(|step| step["payload"]["step"]["input"]["toolCall"]["id"].as_str())
        .ok_or_else(|| "no tool_call step with a call id in the journal".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "generation.tool.result",
        serde_json::json!({
            "runId": tool_run_id,
            "toolCallId": tool_call_id,
            "result": { "celsius": 22 },
        }),
    )?;
    let tool_run = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": tool_run_id }),
    )?;
    if tool_run["status"] != serde_json::json!("completed") {
        return Err(format!(
            "tool run did not complete after the result: {tool_run}"
        ));
    }
    let assistant_count = count_assistant_messages(&host, &chat_id)?;
    if assistant_count != 2 {
        return Err(format!(
            "tool round trip must save exactly one more assistant message, found {assistant_count}"
        ));
    }
    eprintln!("[smoke] golden: tool round trip completed, two assistant messages saved");

    // 3b. Run-transcript walk (ui.run-transcript, round 38): the last
    //     assistant message carries the durable run id at the top level and
    //     `generation.events` serves the step timeline the transcript panel
    //     renders — including the afterSequence paging it performs.
    let transcript = dispatch_ok(
        &host,
        "chats.messages.list",
        serde_json::json!({ "chatId": chat_id, "limit": 200 }),
    )?;
    let transcript_run_id = transcript["items"]
        .as_array()
        .and_then(|items| items.iter().rev().find(|m| m["role"] == "assistant"))
        .and_then(|m| m["generationRunId"].as_str())
        .ok_or_else(|| "last assistant message carries no generationRunId".to_string())?
        .to_string();
    if transcript_run_id != tool_run_id {
        return Err(format!(
            "assistant run id {transcript_run_id} does not match the tool run {tool_run_id}"
        ));
    }
    let page_one = dispatch_ok(
        &host,
        "generation.events",
        serde_json::json!({ "workflowId": tool_run_id, "limit": 2 }),
    )?;
    let first_items = page_one["items"]
        .as_array()
        .ok_or_else(|| "transcript page one carried no items".to_string())?;
    if first_items.len() != 2 {
        return Err(format!(
            "transcript first page must honor the limit=2, got {}",
            first_items.len()
        ));
    }
    let last_sequence = first_items
        .last()
        .and_then(|envelope| envelope["sequence"].as_i64())
        .ok_or_else(|| "transcript envelope carried no sequence".to_string())?;
    let page_two = dispatch_ok(
        &host,
        "generation.events",
        serde_json::json!({
            "workflowId": tool_run_id,
            "afterSequence": last_sequence,
            "limit": 200,
        }),
    )?;
    let second_items = page_two["items"]
        .as_array()
        .ok_or_else(|| "transcript page two carried no items".to_string())?;
    if second_items.is_empty() {
        return Err("afterSequence transcript page was empty".to_string());
    }
    // The durable journal interleaves lifecycle envelopes with steps; the
    // transcript panel filters to generation.step on the bridge. Assert the
    // paged continuation actually serves step envelopes (the tool result and
    // the resumed turn live past the first page).
    if !second_items
        .iter()
        .any(|envelope| envelope["type"] == "generation.step")
    {
        return Err("afterSequence transcript page served no step envelopes".to_string());
    }
    eprintln!(
        "[smoke] golden: run transcript walk ok ({} paged steps + {} after sequence {last_sequence})",
        first_items.len(),
        second_items.len()
    );

    // 4. Full chats.crud + chats.messages.crud walk (G6 evidence, round 23:
    //    every op of both capabilities runs on the packaged artifact, on a
    //    throwaway chat that is deleted afterwards).
    let second = dispatch_ok(
        &host,
        "chats.create",
        serde_json::json!({ "characterId": character_id, "title": "Smoke throwaway" }),
    )?;
    let second_id = second["id"]
        .as_str()
        .ok_or_else(|| "throwaway chat carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "chats.get",
        serde_json::json!({ "chatId": second_id }),
    )?;
    dispatch_ok(
        &host,
        "chats.update",
        serde_json::json!({ "chatId": second_id, "title": "Smoke renamed" }),
    )?;
    let throwaway = dispatch_ok(
        &host,
        "chats.messages.create",
        serde_json::json!({ "chatId": second_id, "role": "user", "content": "edit me" }),
    )?;
    let throwaway_message = throwaway["id"]
        .as_str()
        .ok_or_else(|| "throwaway message carried no id".to_string())?
        .to_string();
    let edited = dispatch_ok(
        &host,
        "chats.messages.update",
        serde_json::json!({
            "chatId": second_id,
            "messageId": throwaway_message,
            "content": "edited",
            "meta": { "smokeNote": "meta-edit" },
        }),
    )?;
    if edited["content"] != serde_json::json!("edited")
        || edited["meta"]["smokeNote"] != serde_json::json!("meta-edit")
    {
        return Err(format!(
            "messages.update did not echo content+meta: {edited}"
        ));
    }
    dispatch_ok(
        &host,
        "chats.messages.delete",
        serde_json::json!({ "chatId": second_id, "messageId": throwaway_message }),
    )?;
    dispatch_ok(
        &host,
        "chats.reorder",
        serde_json::json!({ "characterId": character_id, "order": [chat_id, second_id] }),
    )?;
    dispatch_ok(
        &host,
        "chats.delete",
        serde_json::json!({ "chatId": second_id }),
    )?;
    eprintln!("[smoke] golden: chats/messages CRUD full walk ok");

    // 4b. Message-editing verdict walk (ui.message-editing, round 38): the
    //     checkpoint/branch snapshot link and the delete-checkpoint clear run
    //     on the packaged artifact against the main golden chat.
    let pre_snapshot = dispatch_ok(
        &host,
        "chats.messages.list",
        serde_json::json!({ "chatId": chat_id, "limit": 200 }),
    )?;
    let checkpoint_source = pre_snapshot["items"]
        .as_array()
        .and_then(|items| items.iter().rev().find(|m| m["role"] == "assistant"))
        .and_then(|m| m["id"].as_str())
        .ok_or_else(|| "no assistant message for the checkpoint source".to_string())?
        .to_string();
    let snapshot = dispatch_ok(
        &host,
        "chats.snapshots.create",
        serde_json::json!({
            "chatId": chat_id,
            "messageId": checkpoint_source,
            "kind": "checkpoint",
        }),
    )?;
    let child_id = snapshot["chat"]["id"]
        .as_str()
        .ok_or_else(|| "snapshot child carried no id".to_string())?
        .to_string();
    let copied = snapshot["copiedMessages"].as_i64().unwrap_or(0);
    if copied < 2 {
        return Err(format!(
            "checkpoint snapshot copied {copied} messages, expected the full prefix"
        ));
    }
    let snapshots = dispatch_ok(
        &host,
        "chats.snapshots.list",
        serde_json::json!({ "chatId": chat_id }),
    )?;
    let listed = snapshots["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .any(|chat| chat["id"].as_str() == Some(child_id.as_str()))
        })
        .unwrap_or(false);
    if !listed {
        return Err(format!("snapshot list did not return the child {child_id}"));
    }
    let cleared = dispatch_ok(
        &host,
        "chats.messages.update",
        serde_json::json!({
            "chatId": chat_id,
            "messageId": checkpoint_source,
            "clearCheckpointChatId": true,
        }),
    )?;
    if !cleared["checkpointChatId"].is_null() {
        return Err(format!(
            "clearCheckpointChatId must drop the link, got: {}",
            cleared["checkpointChatId"]
        ));
    }
    dispatch_ok(
        &host,
        "chats.delete",
        serde_json::json!({ "chatId": child_id }),
    )?;
    eprintln!("[smoke] golden: checkpoint snapshot created/listed/cleared ok");

    // 5. Full library-cluster walks (G6 evidence, round 24): presets,
    //    personas, memories, lorebooks (+entries), providers.list, settings вЂ”
    //    every op of each capability on the packaged artifact.
    let preset = dispatch_ok(
        &host,
        "presets.create",
        serde_json::json!({ "kind": "generation", "name": "Smoke preset", "data": {} }),
    )?;
    let preset_id = preset["id"]
        .as_str()
        .ok_or_else(|| "preset carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "presets.get",
        serde_json::json!({ "presetId": preset_id }),
    )?;
    dispatch_ok(
        &host,
        "presets.update",
        serde_json::json!({ "presetId": preset_id, "name": "Smoke preset v2" }),
    )?;
    dispatch_ok(&host, "presets.list", serde_json::json!({}))?;
    dispatch_ok(
        &host,
        "presets.delete",
        serde_json::json!({ "presetId": preset_id }),
    )?;

    let persona = dispatch_ok(
        &host,
        "personas.create",
        serde_json::json!({ "name": "Smoke persona", "description": "Golden walk persona" }),
    )?;
    let persona_id = persona["id"]
        .as_str()
        .ok_or_else(|| "persona carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "personas.get",
        serde_json::json!({ "personaId": persona_id }),
    )?;
    dispatch_ok(
        &host,
        "personas.update",
        serde_json::json!({ "personaId": persona_id, "name": "Smoke persona v2" }),
    )?;
    dispatch_ok(&host, "personas.list", serde_json::json!({}))?;
    dispatch_ok(
        &host,
        "personas.delete",
        serde_json::json!({ "personaId": persona_id }),
    )?;

    let memory = dispatch_ok(
        &host,
        "memories.create",
        serde_json::json!({
            "scope": "character",
            "characterId": character_id,
            "keys": ["smoke"],
            "content": "Golden walk memory.",
        }),
    )?;
    let memory_id = memory["id"]
        .as_str()
        .ok_or_else(|| "memory carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "memories.update",
        serde_json::json!({ "memoryId": memory_id, "content": "Golden walk memory v2." }),
    )?;
    dispatch_ok(&host, "memories.list", serde_json::json!({}))?;
    dispatch_ok(
        &host,
        "memories.delete",
        serde_json::json!({ "memoryId": memory_id }),
    )?;

    dispatch_ok(&host, "providers.list", serde_json::json!({}))?;
    dispatch_ok(&host, "providers.catalog", serde_json::json!({}))?;

    dispatch_ok(&host, "settings.get", serde_json::json!({}))?;
    dispatch_ok(
        &host,
        "settings.update",
        serde_json::json!({
            "settings": [{ "key": "app.language", "value": { "locale": "en" } }]
        }),
    )?;
    dispatch_ok(
        &host,
        "settings.instructformats.list",
        serde_json::json!({}),
    )?;

    let lorebook = dispatch_ok(
        &host,
        "lorebooks.create",
        serde_json::json!({
            "name": "Smoke lore",
            "description": "Golden walk lorebook",
            "characterId": character_id,
            "entries": [{ "keys": ["smoke"], "content": "Golden walk entry.", "enabled": true }],
        }),
    )?;
    let lorebook_id = lorebook["id"]
        .as_str()
        .ok_or_else(|| "lorebook carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "lorebooks.get",
        serde_json::json!({ "lorebookId": lorebook_id }),
    )?;
    dispatch_ok(&host, "lorebooks.list", serde_json::json!({}))?;
    dispatch_ok(
        &host,
        "lorebooks.update",
        serde_json::json!({ "lorebookId": lorebook_id, "name": "Smoke lore v2" }),
    )?;
    dispatch_ok(
        &host,
        "lorebooks.entries.list",
        serde_json::json!({ "lorebookId": lorebook_id }),
    )?;
    let entry = dispatch_ok(
        &host,
        "lorebooks.entries.create",
        serde_json::json!({
            "lorebookId": lorebook_id,
            "entry": { "keys": ["second"], "content": "Second entry.", "enabled": true },
        }),
    )?;
    let entry_id = entry["id"]
        .as_str()
        .ok_or_else(|| "entry carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "lorebooks.entries.update",
        serde_json::json!({
            "lorebookId": lorebook_id,
            "entryId": entry_id,
            "patch": { "content": "Second entry v2." },
        }),
    )?;
    dispatch_ok(
        &host,
        "lorebooks.entries.delete",
        serde_json::json!({ "lorebookId": lorebook_id, "entryId": entry_id }),
    )?;
    dispatch_ok(
        &host,
        "lorebooks.delete",
        serde_json::json!({ "lorebookId": lorebook_id }),
    )?;
    eprintln!("[smoke] golden: library clusters full walk ok");

    // 6. Variants/revisions/drafts + snapshots + app events (G6 evidence,
    //    round 25). Draft lifecycle lives on the throwaway chat's message;
    //    snapshots walk on the golden chat (checkpoint at the last message,
    //    rollback forks a child chat вЂ” the parent stays intact).
    let assistant = dispatch_ok(
        &host,
        "chats.messages.list",
        serde_json::json!({ "chatId": chat_id, "limit": 200 }),
    )?;
    let assistant_id = assistant["items"]
        .as_array()
        .and_then(|items| items.iter().find(|m| m["role"] == "assistant"))
        .and_then(|m| m["id"].as_str())
        .ok_or_else(|| "assistant message has no id".to_string())?
        .to_string();
    let variant = dispatch_ok(
        &host,
        "chats.messages.variants.create",
        serde_json::json!({ "chatId": chat_id, "messageId": assistant_id, "content": "Alt swipe" }),
    )?;
    let variant_id = variant["id"]
        .as_str()
        .ok_or_else(|| "variant carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "chats.messages.variants.list",
        serde_json::json!({ "chatId": chat_id, "messageId": assistant_id }),
    )?;
    dispatch_ok(
        &host,
        "chats.messages.variants.activate",
        serde_json::json!({ "chatId": chat_id, "messageId": assistant_id, "variantId": variant_id }),
    )?;
    dispatch_ok(
        &host,
        "chats.messages.revisions.list",
        serde_json::json!({ "chatId": chat_id, "messageId": assistant_id }),
    )?;
    dispatch_ok(
        &host,
        "chats.messages.variants.delete",
        serde_json::json!({ "chatId": chat_id, "messageId": assistant_id, "variantId": variant_id }),
    )?;

    let draft_saved = dispatch_ok(
        &host,
        "chats.messages.drafts.save",
        serde_json::json!({ "chatId": chat_id, "role": "assistant", "content": "partialвЂ¦" }),
    )?;
    let draft_id = draft_saved["id"]
        .as_str()
        .ok_or_else(|| "draft carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "chats.messages.drafts.list",
        serde_json::json!({ "chatId": chat_id }),
    )?;
    dispatch_ok(
        &host,
        "chats.messages.drafts.get",
        serde_json::json!({ "chatId": chat_id, "draftId": draft_id }),
    )?;
    dispatch_ok(
        &host,
        "chats.messages.drafts.commit",
        serde_json::json!({ "chatId": chat_id, "draftId": draft_id }),
    )?;
    let draft_two = dispatch_ok(
        &host,
        "chats.messages.drafts.save",
        serde_json::json!({ "chatId": chat_id, "role": "assistant", "content": "discard me" }),
    )?;
    dispatch_ok(
        &host,
        "chats.messages.drafts.discard",
        serde_json::json!({ "chatId": chat_id, "draftId": draft_two["id"].as_str().unwrap_or("") }),
    )?;

    let checkpoint = dispatch_ok(
        &host,
        "chats.snapshots.create",
        serde_json::json!({ "chatId": chat_id, "messageId": assistant_id, "kind": "checkpoint" }),
    )?;
    let _checkpoint_chat = checkpoint["chat"]["id"].as_str().unwrap_or("");
    dispatch_ok(
        &host,
        "chats.snapshots.list",
        serde_json::json!({ "chatId": chat_id }),
    )?;
    dispatch_ok(
        &host,
        "chats.snapshots.rollback",
        serde_json::json!({ "chatId": chat_id, "toMessageId": assistant_id }),
    )?;

    dispatch_ok(&host, "events.poll", serde_json::json!({}))?;
    eprintln!("[smoke] golden: variants/drafts/snapshots/events walk ok");

    // 7. library.assets + characters.crud full walks (G6 evidence, round 26).
    //    A real 1x1 PNG keeps the thumbnail path honest.
    const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let asset = dispatch_ok(
        &host,
        "assets.put",
        serde_json::json!({
            "kind": "avatar",
            "filename": "smoke.png",
            "contentType": "image/png",
            "contentBase64": TINY_PNG,
        }),
    )?;
    let asset_id = asset["asset"]["id"]
        .as_str()
        .ok_or_else(|| "asset carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "assets.get",
        serde_json::json!({ "assetId": asset_id }),
    )?;
    dispatch_ok(
        &host,
        "assets.content",
        serde_json::json!({ "assetId": asset_id }),
    )?;
    dispatch_ok(
        &host,
        "assets.thumb",
        serde_json::json!({ "assetId": asset_id, "maxPx": 64 }),
    )?;
    dispatch_ok(
        &host,
        "assets.list",
        serde_json::json!({ "kind": "avatar", "limit": 50 }),
    )?;
    dispatch_ok(
        &host,
        "assets.delete",
        serde_json::json!({ "assetId": asset_id }),
    )?;

    dispatch_ok(
        &host,
        "characters.get",
        serde_json::json!({ "characterId": character_id }),
    )?;
    dispatch_ok(
        &host,
        "characters.card.get",
        serde_json::json!({ "characterId": character_id }),
    )?;
    dispatch_ok(
        &host,
        "characters.card.update",
        serde_json::json!({
            "characterId": character_id,
            "card": {
                "name": "Aria",
                "description": "Golden slice character, card-edited",
                "first_mes": "Hello from the card walk.",
                "creator_notes": "Packaged smoke.",
            },
        }),
    )?;
    dispatch_ok(
        &host,
        "characters.update",
        serde_json::json!({ "characterId": character_id, "name": "Aria renamed" }),
    )?;
    let gallery_item = dispatch_ok(
        &host,
        "characters.gallery.add",
        serde_json::json!({
            "characterId": character_id,
            "filename": "smoke-gallery.png",
            "contentType": "image/png",
            "contentBase64": TINY_PNG,
        }),
    )?;
    let gallery_id = gallery_item["item"]["id"]
        .as_str()
        .ok_or_else(|| "gallery item carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "characters.gallery.list",
        serde_json::json!({ "characterId": character_id }),
    )?;
    dispatch_ok(
        &host,
        "characters.gallery.delete",
        serde_json::json!({ "characterId": character_id, "imageId": gallery_id }),
    )?;
    dispatch_ok(
        &host,
        "characters.delete",
        serde_json::json!({ "characterId": character_id }),
    )?;
    dispatch_ok(
        &host,
        "characters.restore",
        serde_json::json!({ "characterId": character_id }),
    )?;
    let versions = dispatch_ok(
        &host,
        "characters.versions.list",
        serde_json::json!({ "characterId": character_id }),
    )?;
    let version_id = versions["items"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|v| v["id"].as_str())
        .ok_or_else(|| "character has no versions".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "characters.versions.restore",
        serde_json::json!({ "characterId": character_id, "versionId": version_id }),
    )?;
    dispatch_ok(
        &host,
        "characters.list",
        serde_json::json!({ "includeDeleted": true }),
    )?;
    eprintln!("[smoke] golden: assets/characters full walk ok");

    // 8. generation.workflow residual ops (G6 evidence, round 27): cancel a
    //    delayed run, retry a failed run, keep/discard durably waiting runs,
    //    unary events page.
    let cancel_request = build_request_envelope(
        "generation.start",
        serde_json::json!({
            "chatId": chat_id,
            "message": "cancel me",
            "provider": "fake",
            "model": "delay-ms=3000",
        }),
        "00000000-0000-4000-8000-000000000003",
    );
    let (cancel_tx, cancel_rx) = std::sync::mpsc::channel::<serde_json::Value>();
    let cancel_body = host
        .open_stream(&cancel_request, move |event| {
            let _ = cancel_tx.send(event);
            Ok(())
        })
        .map_err(|failure| format!("transport failure: {failure:?}"))?;
    let cancel_envelope: serde_json::Value = serde_json::from_slice(&cancel_body)
        .map_err(|_| "stream response was not JSON".to_string())?;
    let cancelled_id = cancel_envelope["result"]["streamId"]
        .as_str()
        .ok_or_else(|| "cancel stream carried no streamId".to_string())?
        .to_string();
    std::thread::sleep(Duration::from_millis(500));
    dispatch_ok(
        &host,
        "generation.cancel",
        serde_json::json!({ "workflowId": cancelled_id }),
    )?;
    loop {
        let event = cancel_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "cancel stream closed without a sentinel".to_string())?;
        if event.is_null() {
            break;
        }
    }
    let cancelled_run = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": cancelled_id }),
    )?;
    let cancelled_status = cancelled_run["status"].as_str().unwrap_or("");
    if matches!(cancelled_status, "queued" | "running" | "waiting_for_tool") {
        return Err(format!("cancelled run is still active: {cancelled_status}"));
    }
    eprintln!("[smoke] golden: cancel -> {cancelled_status}");

    let (failed_id, _failed_events) = run_stream(
        &host,
        "generation.start",
        serde_json::json!({
            "chatId": chat_id,
            "message": "fail on purpose",
            "provider": "fake",
            "model": "fail-at=1",
        }),
    )?;
    let failed_run = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": failed_id }),
    )?;
    if failed_run["status"] == serde_json::json!("completed") {
        return Err("fail-at run unexpectedly completed".to_string());
    }
    // Retry the CANCELLED run: retry inherits the original model grammar, and
    // the failed run's `fail-at=1` would deterministically fail again вЂ” the
    // cancelled run's grammar completes.
    let (retried_id, _retry_events) = run_stream(
        &host,
        "generation.retry",
        serde_json::json!({ "sourceRunId": cancelled_id }),
    )?;
    let retried = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": retried_id }),
    )?;
    if retried["status"] != serde_json::json!("completed") {
        return Err(format!("retry did not complete: {retried}"));
    }
    dispatch_ok(
        &host,
        "generation.events",
        serde_json::json!({ "workflowId": retried_id, "limit": 200 }),
    )?;
    eprintln!("[smoke] golden: retry after failure -> completed");

    // keep/discard recover TERMINAL runs (failed/cancelled/interrupted, РўР— В§4):
    // keep persists the partial output as an assistant message, discard purges
    // the journal. A waiting_for_tool run is NOT recoverable вЂ” it resumes via
    // generation.tool.result (already exercised above).
    let (partial_id, _partial_events) = run_stream(
        &host,
        "generation.start",
        serde_json::json!({
            "chatId": chat_id,
            "message": "keep partial",
            "provider": "fake",
            "model": "steps=3;fail-at=3",
        }),
    )?;
    let partial_run = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": partial_id }),
    )?;
    if partial_run["status"] != serde_json::json!("failed") {
        return Err(format!("fail-at=3 run did not fail: {partial_run}"));
    }
    dispatch_ok(
        &host,
        "generation.keep",
        serde_json::json!({ "workflowId": partial_id }),
    )?;
    eprintln!("[smoke] golden: keep recovered the partial output of a failed run");

    dispatch_ok(
        &host,
        "generation.discard",
        serde_json::json!({ "workflowId": cancelled_id }),
    )?;
    let discarded = dispatch_ok(
        &host,
        "generation.get",
        serde_json::json!({ "workflowId": cancelled_id }),
    )?;
    let discarded_status = discarded["status"].as_str().unwrap_or("");
    if discarded_status != "cancelled" {
        return Err(format!("discard changed the terminal status: {discarded}"));
    }
    eprintln!(
        "[smoke] golden: discard purged the cancelled journal (status kept: {discarded_status})"
    );

    // 9. Diagnostics + search walk (G6 evidence, round 27).
    dispatch_ok(&host, "search.rebuild", serde_json::json!({}))?;
    let hits = dispatch_ok(
        &host,
        "search.query",
        serde_json::json!({ "q": "Aria", "scope": "characters", "sort": "relevance", "limit": 50 }),
    )?;
    if hits["items"]
        .as_array()
        .map(|items| items.is_empty())
        .unwrap_or(true)
    {
        return Err(format!(
            "search found nothing for a known character: {hits}"
        ));
    }
    dispatch_ok(&host, "diagnostics.cache.clear", serde_json::json!({}))?;
    dispatch_ok(&host, "diagnostics.export", serde_json::json!({}))?;
    eprintln!("[smoke] golden: diagnostics/search walk ok");

    // 10. Migration walk (G7/G8 packaged evidence, round 28): a legacy
    //     Drizzle `app.db` goes through the ADR-0062 staged-root lifecycle
    //     (plan -> stage -> validate -> activate -> rollback) against THIS
    //     kernel's data root, inside the packaged process. The running kernel
    //     keeps serving its open database; the pointer ends where it started.
    use neotavern_storage::{activation, legacy_import};
    let legacy_source = data_dir.join("smoke-legacy-app.db");
    build_legacy_fixture(&legacy_source)?;

    let previous = activation::active_root(data_dir)
        .map_err(|error| format!("migration walk: active_root failed: {error}"))?;
    let staged_plan = legacy_import::plan(&legacy_source)
        .map_err(|error| format!("migration walk: plan failed: {error}"))?;
    if !staged_plan.ready {
        return Err("migration walk: plan refused the fixture".to_string());
    }
    let staged = legacy_import::stage(&legacy_source, data_dir)
        .map_err(|error| format!("migration walk: stage failed: {error}"))?;
    legacy_import::validate_staged(&staged)
        .map_err(|error| format!("migration walk: validate failed: {error}"))?;
    legacy_import::activate_staged(data_dir, &staged, &previous)
        .map_err(|error| format!("migration walk: activation failed: {error}"))?;
    let imported = activation::read_pointer(data_dir)
        .map_err(|error| format!("migration walk: pointer read failed: {error}"))?
        .ok_or_else(|| "migration walk: no pointer after activation".to_string())?;
    if imported.root != staged.staged_root {
        return Err(format!(
            "migration walk: pointer did not move to the staged root: {:?}",
            imported.root
        ));
    }
    activation::rollback_to(data_dir, &previous)
        .map_err(|error| format!("migration walk: rollback failed: {error}"))?;
    let rolled_back = activation::read_pointer(data_dir)
        .map_err(|error| format!("migration walk: pointer read failed: {error}"))?
        .ok_or_else(|| "migration walk: no pointer after rollback".to_string())?;
    if rolled_back.root != previous {
        return Err(format!(
            "migration walk: rollback did not restore the previous root: {:?}",
            rolled_back.root
        ));
    }
    let still_serving = dispatch_ok(&host, "characters.list", serde_json::json!({ "limit": 1 }))?;
    if still_serving["items"].is_null() {
        return Err("migration walk: the kernel stopped serving its open database".to_string());
    }
    eprintln!(
        "[smoke] golden: migration walk staged {} and rolled back to the previous root",
        staged.root_id
    );

    // 11. Backups + prompt plan + provider config/secrets + activation
    //     status (G6 evidence, round 31). Restore runs as the dedicated
    //     offline writer op (close -> swap -> reopen + migrations).
    let backup = dispatch_ok(&host, "backups.create", serde_json::json!({}))?;
    let backup_id = backup["id"]
        .as_str()
        .or_else(|| backup["backupId"].as_str())
        .ok_or_else(|| "backup carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "backups.restore",
        serde_json::json!({ "backupId": backup_id }),
    )?;
    dispatch_ok(
        &host,
        "backups.delete",
        serde_json::json!({ "backupId": backup_id }),
    )?;
    dispatch_ok(&host, "backups.list", serde_json::json!({}))?;
    eprintln!("[smoke] golden: backups create/restore/delete/list ok");

    dispatch_ok(&host, "data.activation.status", serde_json::json!({}))?;

    let plan = dispatch_ok(
        &host,
        "generation.prompt.plan",
        serde_json::json!({ "runId": retried_id }),
    )?;
    let message_count = plan["messages"]
        .as_array()
        .map(|messages| messages.len())
        .unwrap_or(0);
    if message_count == 0 || plan["inputTokens"].as_i64().unwrap_or(0) == 0 {
        return Err(format!("prompt plan carried no messages/tokens: {plan}"));
    }
    dispatch_ok(
        &host,
        "chats.context.audit",
        serde_json::json!({ "chatId": chat_id }),
    )?;
    dispatch_ok(
        &host,
        "chats.prompt.preview",
        serde_json::json!({ "chatId": chat_id, "userMessage": "preview" }),
    )?;
    eprintln!("[smoke] golden: prompt plan/context audit/preview ok");

    let config = dispatch_ok(
        &host,
        "providers.config.set",
        serde_json::json!({
            "provider": "fake",
            "name": "local",
            "config": { "temperature": 0.7 },
        }),
    )?;
    let config_id = config["config"]["id"]
        .as_str()
        .or_else(|| config["id"].as_str())
        .ok_or_else(|| "provider config carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "providers.config.get",
        serde_json::json!({ "provider": "fake", "name": "local" }),
    )?;
    dispatch_ok(&host, "providers.config.list", serde_json::json!({}))?;
    // 11b. Provider access walk (providers.access, round 41): model discovery
    //      and the one-shot connectivity test run on the packaged artifact
    //      against the built-in fake adapter — a local, keyless, deterministic
    //      round trip that never touches the network, plus the fail-closed
    //      answer for an unknown config id.
    let discovered = dispatch_ok(
        &host,
        "providers.models",
        serde_json::json!({ "providerId": config_id }),
    )?;
    let discovered_models = discovered["models"]
        .as_array()
        .ok_or_else(|| "providers.models carried no list".to_string())?;
    if discovered_models.len() != 1
        || discovered_models[0]["id"] != serde_json::json!("fake-1")
        || discovered_models[0]["contextLimit"] != serde_json::json!(8192)
    {
        return Err(format!(
            "providers.models did not enumerate the fake model set: {discovered}"
        ));
    }
    let tested = dispatch_ok(
        &host,
        "providers.test",
        serde_json::json!({
            "providerId": config_id,
            "message": "ping",
            "model": "steps=1;tokens-per-step=6",
        }),
    )?;
    let tested_text = tested["text"].as_str().unwrap_or_default();
    if tested_text.chars().count() != 6
        || tested["usage"]["steps"] != serde_json::json!(1)
        || tested["usage"]["outputChars"] != serde_json::json!(6)
    {
        return Err(format!(
            "providers.test returned an unexpected round trip: {tested}"
        ));
    }
    let missing_config = dispatch_error(
        &host,
        "providers.models",
        // The wire `uuid` format admits versions 1-5, so an unknown config id
        // has to be a well-formed v4 to reach the kernel lookup.
        serde_json::json!({ "providerId": "00000000-0000-4000-8000-000000000000" }),
    )?;
    if !missing_config.contains("PROVIDER_CONFIG_NOT_FOUND") {
        return Err(format!(
            "providers.models did not fail closed for an unknown config: {missing_config}"
        ));
    }
    eprintln!(
        "[smoke] golden: provider model discovery + one-shot test ok (unknown config fails closed)"
    );
    let secret = dispatch_ok(
        &host,
        "providers.secrets.create",
        serde_json::json!({
            "providerId": config_id,
            "value": "sk-smoke-secret",
            "label": "smoke",
        }),
    )?;
    let secret_id = secret["secret"]["id"]
        .as_str()
        .or_else(|| secret["id"].as_str())
        .or_else(|| secret["secretId"].as_str())
        .ok_or_else(|| "provider secret carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "providers.secrets.list",
        serde_json::json!({ "providerId": config_id }),
    )?;
    dispatch_ok(
        &host,
        "providers.secrets.update",
        serde_json::json!({
            "providerId": config_id,
            "secretId": secret_id,
            "label": "renamed",
            "active": true,
        }),
    )?;
    // SEC-01 fail-closed: exposure is OFF by default, so reveal must refuse
    // with the stable code and must never echo the plaintext value.
    let reveal_error = dispatch_error(
        &host,
        "providers.secrets.reveal",
        serde_json::json!({ "providerId": config_id, "secretId": secret_id }),
    )?;
    if !reveal_error.contains("SECRETS_EXPOSURE_DISABLED")
        || reveal_error.contains("sk-smoke-secret")
    {
        return Err(format!("reveal did not fail closed: {reveal_error}"));
    }
    dispatch_ok(
        &host,
        "providers.secrets.delete",
        serde_json::json!({ "providerId": config_id, "secretId": secret_id }),
    )?;
    dispatch_ok(
        &host,
        "providers.config.delete",
        serde_json::json!({ "provider": "fake", "name": "local" }),
    )?;
    eprintln!("[smoke] golden: provider config/secrets walk ok (reveal fail-closed)");

    // 13. Themes + profiles + profile export/import (G6 evidence, round 32).
    //     A theme is declarative data: its CSS rides the addressed asset
    //     store (kind theme-css), validated at install.
    let css = dispatch_ok(
        &host,
        "assets.put",
        serde_json::json!({
            "kind": "theme-css",
            "filename": "theme.css",
            "contentType": "text/css",
            "contentBase64": "Ym9keXt9",
        }),
    )?;
    let css_id = css["asset"]["id"]
        .as_str()
        .ok_or_else(|| "theme css asset carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "themes.install",
        serde_json::json!({
            "id": "smoke-theme",
            "name": "Smoke Theme",
            "version": "1.0.0",
            "trustState": "verified-publisher",
            "publisherKeyId": "fp-smoke",
            "cssAssetId": css_id,
            "manifest": {
                "id": "smoke-theme",
                "level": "shell",
                "settings": {
                    "accent": { "type": "color", "default": "#7c3aed" },
                },
            },
        }),
    )?;
    dispatch_ok(
        &host,
        "themes.activate",
        serde_json::json!({ "id": "smoke-theme" }),
    )?;
    dispatch_ok(
        &host,
        "themes.settings.get",
        serde_json::json!({ "id": "smoke-theme" }),
    )?;
    dispatch_ok(
        &host,
        "themes.settings.update",
        serde_json::json!({ "id": "smoke-theme", "values": { "accent": "#00c853" } }),
    )?;
    let themes = dispatch_ok(&host, "themes.list", serde_json::json!({}))?;
    let listed_theme = themes["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .any(|theme| theme["id"].as_str() == Some("smoke-theme"))
        })
        .unwrap_or(false);
    if !listed_theme {
        return Err(format!(
            "installed theme missing from themes.list: {themes}"
        ));
    }
    dispatch_ok(&host, "themes.deactivate", serde_json::json!({}))?;
    dispatch_ok(
        &host,
        "themes.uninstall",
        serde_json::json!({ "id": "smoke-theme" }),
    )?;
    eprintln!("[smoke] golden: themes install/activate/settings/list/deactivate/uninstall ok");

    let profile = dispatch_ok(
        &host,
        "profiles.create",
        serde_json::json!({ "name": "Smoke profile" }),
    )?;
    let profile_id = profile["profile"]["id"]
        .as_str()
        .ok_or_else(|| "profile carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "profiles.rename",
        serde_json::json!({ "id": profile_id, "name": "Smoke renamed" }),
    )?;
    dispatch_ok(&host, "profiles.list", serde_json::json!({}))?;
    let exported = dispatch_ok(&host, "profile.export", serde_json::json!({}))?;
    let container_path = exported["containerPath"]
        .as_str()
        .ok_or_else(|| "profile export carried no containerPath".to_string())?
        .to_string();
    let imported = dispatch_ok(
        &host,
        "profile.import",
        serde_json::json!({ "containerPath": container_path, "policy": "remap" }),
    )?;
    let imported_characters = imported["inserted"].as_i64().unwrap_or(0);
    if imported_characters == 0 {
        return Err(format!("profile import applied no records: {imported}"));
    }
    dispatch_ok(
        &host,
        "profiles.delete",
        serde_json::json!({ "id": profile_id }),
    )?;
    eprintln!("[smoke] golden: profiles + profile export/import ok");

    // 12. Secrets lifecycle: status (backend describe), then lock вЂ” the
    //     lock response itself carries `locked: true` (status reports the
    //     store shape, not the lock state).
    let status = dispatch_ok(&host, "secrets.status", serde_json::json!({}))?;
    if status["available"] != serde_json::json!(true) {
        return Err(format!("secret store is unavailable: {status}"));
    }
    let lock = dispatch_ok(&host, "secrets.lock", serde_json::json!({}))?;
    if lock["locked"] != serde_json::json!(true) {
        return Err(format!("lock did not report locked: {lock}"));
    }
    dispatch_ok(&host, "secrets.status", serde_json::json!({}))?;
    eprintln!("[smoke] golden: secrets status/lock ok");
    // 14. Character card import (G6 evidence, round 33): a legacy-
    //     compatible V2 card rides a PNG chara tEXt chunk (fixed fixture
    //     bytes, valid CRCs), published through assets.put kind card.
    const CARD_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA9nRFWHRjaGFyYQBleUp6Y0dWaklqb2lZMmhoY21GZlkyRnlaRjkyTWlJc0luTndaV05mZG1WeWMybHZiaUk2SWpJdU1DSXNJbTVoYldVaU9pSkRZWEprSUVsdGNHOXlkQ0lzSW1SbGMyTnlhWEIwYVc5dUlqb2lTVzF3YjNKMFpXUWdabkp2YlNCaElGQk9SeUJqWVhKa0lHSjVJSFJvWlNCd1lXTnJZV2RsWkNCemJXOXJaU0lzSW1acGNuTjBYMjFsY3lJNklraGxiR3h2SUdaeWIyMGdkR2hsSUdOaGNtUXVJaXdpZEdGbmN5STZXeUpqWVhKa0lsMTmuwW+pAAAAAElFTkSuQmCC";
    let card_asset = dispatch_ok(
        &host,
        "assets.put",
        serde_json::json!({
            "kind": "card",
            "filename": "card-import.png",
            "contentType": "image/png",
            "contentBase64": CARD_PNG_B64,
        }),
    )?;
    let card_asset_id = card_asset["asset"]["id"]
        .as_str()
        .ok_or_else(|| "card asset carried no id".to_string())?
        .to_string();
    let imported_card = dispatch_ok(
        &host,
        "imports.character.card",
        serde_json::json!({ "assetId": card_asset_id }),
    )?;
    let card_character = imported_card["character"]["name"]
        .as_str()
        .ok_or_else(|| "card import carried no character name".to_string())?;
    if card_character != "Card Import" {
        return Err(format!(
            "card import produced the wrong character: {imported_card}"
        ));
    }
    if imported_card["created"] != serde_json::json!(true) {
        return Err(format!("card import was not created: {imported_card}"));
    }
    // Re-import dedup (AGENTS §11): the same bytes must NOT create a second
    // character.
    let reimported = dispatch_ok(
        &host,
        "imports.character.card",
        serde_json::json!({ "assetId": card_asset_id }),
    )?;
    if reimported["created"] != serde_json::json!(false) {
        return Err(format!("card re-import created a duplicate: {reimported}"));
    }
    eprintln!("[smoke] golden: character card import + dedup ok ({card_character})");
    // 14b. Card/chat export walk (ui.card-exports, round 39): the imported
    //      character carries the original container — the json export must be
    //      a verbatim round trip, the png export must re-embed the chara tEXt
    //      chunk, and re-importing the exported png must parse (creating a
    //      fresh character that is cleaned up afterwards). chats.export
    //      serves the neotavern-chat-export container of the golden chat.
    let card_character_id = imported_card["character"]["id"]
        .as_str()
        .ok_or_else(|| "card import carried no character id".to_string())?
        .to_string();
    let json_export = dispatch_ok(
        &host,
        "characters.export.card",
        serde_json::json!({ "characterId": card_character_id, "format": "json" }),
    )?;
    let json_b64 = json_export["contentBase64"]
        .as_str()
        .ok_or_else(|| "json export carried no content".to_string())?;
    use base64::Engine as _;
    let json_bytes = base64::engine::general_purpose::STANDARD
        .decode(json_b64)
        .map_err(|e| format!("json export base64 did not decode: {e}"))?;
    let card_json: serde_json::Value = serde_json::from_slice(&json_bytes)
        .map_err(|e| format!("json export was not a card object: {e}"))?;
    // The exporter round-trips the preserved container verbatim; a V2 card may
    // carry its fields either flat next to `spec` or nested under `data`, so
    // the walk accepts both shapes and checks spec + the card name.
    let exported_card_name = card_json["name"]
        .as_str()
        .or_else(|| card_json["data"]["name"].as_str())
        .unwrap_or_default()
        .to_string();
    if card_json["spec"] != serde_json::json!("chara_card_v2")
        || exported_card_name != "Card Import"
    {
        return Err(format!(
            "json export lost the verbatim container: {card_json}"
        ));
    }
    if json_export["warnings"]
        .as_array()
        .map(|warnings| !warnings.is_empty())
        .unwrap_or(false)
    {
        return Err(format!("verbatim json export must not warn: {json_export}"));
    }
    let png_export = dispatch_ok(
        &host,
        "characters.export.card",
        serde_json::json!({ "characterId": card_character_id, "format": "png" }),
    )?;
    let png_b64 = png_export["contentBase64"]
        .as_str()
        .ok_or_else(|| "png export carried no content".to_string())?;
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(png_b64)
        .map_err(|e| format!("png export base64 did not decode: {e}"))?;
    if !png_bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("png export lost the PNG signature".to_string());
    }
    if !png_bytes.windows(5).any(|window| window == b"chara") {
        return Err("png export lost the chara tEXt chunk".to_string());
    }
    let reimport_asset = dispatch_ok(
        &host,
        "assets.put",
        serde_json::json!({
            "kind": "card",
            "filename": "card-export-roundtrip.png",
            "contentType": "image/png",
            "contentBase64": png_b64,
        }),
    )?;
    let reimport_asset_id = reimport_asset["asset"]["id"]
        .as_str()
        .ok_or_else(|| "re-import asset carried no id".to_string())?
        .to_string();
    let reimported_export = dispatch_ok(
        &host,
        "imports.character.card",
        serde_json::json!({ "assetId": reimport_asset_id }),
    )?;
    if reimported_export["created"] != serde_json::json!(true) {
        return Err(format!(
            "exported png re-import failed: {reimported_export}"
        ));
    }
    if reimported_export["character"]["name"] != serde_json::json!("Card Import") {
        return Err(format!(
            "exported png re-import lost the card name: {reimported_export}"
        ));
    }
    let duplicate_id = reimported_export["character"]["id"]
        .as_str()
        .ok_or_else(|| "re-imported character carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "characters.delete",
        serde_json::json!({ "characterId": duplicate_id }),
    )?;
    let chat_export = dispatch_ok(
        &host,
        "chats.export",
        serde_json::json!({ "chatId": chat_id }),
    )?;
    let chat_b64 = chat_export["contentBase64"]
        .as_str()
        .ok_or_else(|| "chat export carried no content".to_string())?;
    let chat_bytes = base64::engine::general_purpose::STANDARD
        .decode(chat_b64)
        .map_err(|e| format!("chat export base64 did not decode: {e}"))?;
    let chat_container: serde_json::Value = serde_json::from_slice(&chat_bytes)
        .map_err(|e| format!("chat export was not a container object: {e}"))?;
    if chat_container["kind"] != serde_json::json!("neotavern-chat-export") {
        return Err(format!(
            "chat export carried the wrong container kind: {}",
            chat_container["kind"]
        ));
    }
    let exported_messages = chat_container["messages"]
        .as_array()
        .map(|messages| messages.len())
        .unwrap_or(0);
    if exported_messages < 3 {
        return Err(format!(
            "chat export dumped {exported_messages} messages, expected the full golden walk"
        ));
    }
    eprintln!(
        "[smoke] golden: card exports json-verbatim + png-chunk + re-import + chat export ok"
    );
    // 15. Declarative plugin lifecycle (G6 evidence, round 34): the kernel
    //     durably records the host-verified SEC-05 package and serves the
    //     data-driven plugin families — state (optimistic revision),
    //     secrets (masked projections; reveal stays fail-closed) and chat
    //     blocks. No code executor: declarative plugins are DATA (ADR-0058).
    dispatch_ok(
        &host,
        "plugins.install",
        serde_json::json!({
            "id": "smoke-plugin",
            "name": "Smoke Plugin",
            "version": "1.0.0",
            "trustState": "verified-publisher",
            "publisherKeyId": "fp-smoke",
            "permissions": ["plugin.storage", "storage.user", "storage.blobs", "secrets.manageOwn", "secrets.reveal"],
            "manifest": { "id": "smoke-plugin", "main": "dist/index.js" },
        }),
    )?;
    dispatch_ok(
        &host,
        "plugins.enable",
        serde_json::json!({ "id": "smoke-plugin" }),
    )?;

    // 15b. Plugin job queue (ADR-0064, round 57b): the durable queue is walked on
    //      the packaged artifact — enqueue with an opaque payload, list it back by
    //      plugin, cancel it, and a second cancel is refused as JOB_TERMINAL.
    //      Execution stays OFF: no handler is registered in the packaged default,
    //      so the enabled runner would still claim nothing and jobs stay queued.
    let job = dispatch_ok(
        &host,
        "plugins.jobs.enqueue",
        serde_json::json!({
            "pluginId": "smoke-plugin",
            "kind": "timer",
            "payloadJson": "{\"tick\":1}",
        }),
    )?;
    let job_id = job["job"]["id"]
        .as_str()
        .ok_or_else(|| "enqueued job carried no id".to_string())?
        .to_string();
    let listed = dispatch_ok(
        &host,
        "plugins.jobs.list",
        serde_json::json!({ "pluginId": "smoke-plugin" }),
    )?;
    let listed_count = listed["jobs"]
        .as_array()
        .map(|jobs| jobs.len())
        .unwrap_or(0);
    if listed_count != 1 {
        return Err(format!(
            "plugins.jobs.list returned {listed_count} jobs, expected the one just enqueued"
        ));
    }
    let cancelled = dispatch_ok(
        &host,
        "plugins.jobs.cancel",
        serde_json::json!({ "jobId": job_id }),
    )?;
    if cancelled["job"]["state"].as_str() != Some("cancelled") {
        return Err("plugins.jobs.cancel did not report a cancelled job".to_string());
    }
    let terminal = dispatch_error(
        &host,
        "plugins.jobs.cancel",
        serde_json::json!({ "jobId": job_id }),
    )?;
    // `dispatch_error` returns the product error DTO as JSON text, not a bare code.
    let terminal_code = serde_json::from_str::<serde_json::Value>(&terminal)
        .ok()
        .and_then(|value| value["code"].as_str().map(str::to_string))
        .unwrap_or_else(|| terminal.clone());
    if terminal_code != "JOB_TERMINAL" {
        return Err(format!(
            "second cancel reported {terminal_code}, expected JOB_TERMINAL"
        ));
    }
    eprintln!("[smoke] golden: plugin jobs enqueue/list/cancel + terminal refusal ok");

    let messages = dispatch_ok(
        &host,
        "chats.messages.list",
        serde_json::json!({ "chatId": chat_id, "limit": 50 }),
    )?;
    let last_message_id = messages["items"]
        .as_array()
        .and_then(|items| items.last())
        .and_then(|message| message["id"].as_str())
        .ok_or_else(|| "chat has no messages for a block".to_string())?
        .to_string();
    let block = dispatch_ok(
        &host,
        "chats.blocks.attach",
        serde_json::json!({
            "chatId": chat_id,
            "messageId": last_message_id,
            "blockType": "meter",
            "rendererId": "blk:meter",
            "pluginId": "smoke-plugin",
            "descriptor": { "title": "Smoke meter" },
        }),
    )?;
    let block_id = block["id"]
        .as_str()
        .or_else(|| block["blockId"].as_str())
        .ok_or_else(|| "block carried no id".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "chats.blocks.list",
        serde_json::json!({ "chatId": chat_id, "messageIds": [last_message_id] }),
    )?;
    dispatch_ok(
        &host,
        "blocks.update",
        serde_json::json!({ "blockId": block_id, "serializedState": { "count": 9 } }),
    )?;
    dispatch_ok(
        &host,
        "blocks.delete",
        serde_json::json!({ "blockId": block_id }),
    )?;

    let state_set = dispatch_ok(
        &host,
        "plugins.state.set",
        serde_json::json!({
            "pluginId": "smoke-plugin",
            "scope": "user",
            "data": { "lastQuery": "smoke", "runs": 1 },
        }),
    )?;
    let state_revision = state_set["revision"].as_i64().unwrap_or(0);
    let state_get = dispatch_ok(
        &host,
        "plugins.state.get",
        serde_json::json!({ "pluginId": "smoke-plugin", "scope": "user" }),
    )?;
    if state_get["data"]["runs"] != serde_json::json!(1) {
        return Err(format!("plugin state round trip failed: {state_get}"));
    }
    dispatch_ok(
        &host,
        "plugins.state.set",
        serde_json::json!({
            "pluginId": "smoke-plugin",
            "scope": "user",
            "data": { "lastQuery": "smoke", "runs": 2 },
            "expectedRevision": state_revision,
        }),
    )?;
    dispatch_ok(
        &host,
        "plugins.state.delete",
        serde_json::json!({ "pluginId": "smoke-plugin", "scope": "user" }),
    )?;

    dispatch_ok(
        &host,
        "plugins.secrets.set",
        serde_json::json!({
            "pluginId": "smoke-plugin",
            "scope": "user",
            "key": "apiKey",
            "value": "sk-plugin-smoke",
        }),
    )?;
    let secret_list = dispatch_ok(
        &host,
        "plugins.secrets.list",
        serde_json::json!({ "pluginId": "smoke-plugin", "scope": "user" }),
    )?;
    let secret_listing = serde_json::to_string(&secret_list).unwrap_or_default();
    if secret_listing.contains("sk-plugin-smoke") {
        return Err(format!("secret listing leaked plaintext: {secret_list}"));
    }
    let plugin_reveal = dispatch_error(
        &host,
        "plugins.secrets.reveal",
        serde_json::json!({ "pluginId": "smoke-plugin", "scope": "user", "key": "apiKey" }),
    )?;
    if !plugin_reveal.contains("SECRETS_EXPOSURE_DISABLED")
        || plugin_reveal.contains("sk-plugin-smoke")
    {
        return Err(format!(
            "plugin reveal did not fail closed: {plugin_reveal}"
        ));
    }
    dispatch_ok(
        &host,
        "plugins.secrets.delete",
        serde_json::json!({ "pluginId": "smoke-plugin", "scope": "user", "key": "apiKey" }),
    )?;

    // Cluster 21a: the plugin blob store — chunked publish, bounded range read,
    // list and idempotent delete through the packaged KernelHost envelope. The
    // digest of "hello" is the blob id, which is what makes the assertion below
    // a content-addressing check rather than a shape check.
    let blob_begin = dispatch_ok(
        &host,
        "plugins.blobs.begin",
        serde_json::json!({
            "pluginId": "smoke-plugin",
            "name": "smoke.bin",
            "contentType": "application/octet-stream",
            "totalBytes": 5,
        }),
    )?;
    let blob_upload_id = blob_begin["uploadId"]
        .as_str()
        .ok_or_else(|| "blob begin carried no uploadId".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "plugins.blobs.append",
        serde_json::json!({
            "pluginId": "smoke-plugin",
            "uploadId": blob_upload_id,
            "index": 0,
            "contentBase64": "aGVsbG8=",
        }),
    )?;
    let blob = dispatch_ok(
        &host,
        "plugins.blobs.finish",
        serde_json::json!({ "pluginId": "smoke-plugin", "uploadId": blob_upload_id }),
    )?;
    let blob_id = blob["blobId"]
        .as_str()
        .ok_or_else(|| "blob finish carried no blobId".to_string())?
        .to_string();
    let expected_blob_id = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    if blob_id != expected_blob_id || blob["sizeBytes"] != serde_json::json!(5) {
        return Err(format!(
            "plugin blob publish is not content-addressed: {blob}"
        ));
    }
    let blob_read = dispatch_ok(
        &host,
        "plugins.blobs.read",
        serde_json::json!({
            "pluginId": "smoke-plugin",
            "blobId": blob_id,
            "offset": 0,
            "length": 16,
        }),
    )?;
    if blob_read["dataBase64"] != serde_json::json!("aGVsbG8=")
        || blob_read["eof"] != serde_json::json!(true)
    {
        return Err(format!("plugin blob range read failed: {blob_read}"));
    }
    let blob_list = dispatch_ok(
        &host,
        "plugins.blobs.list",
        serde_json::json!({ "pluginId": "smoke-plugin" }),
    )?;
    if blob_list["items"].as_array().map(Vec::len) != Some(1) {
        return Err(format!(
            "plugin blob list did not report the blob: {blob_list}"
        ));
    }
    let blob_deleted = dispatch_ok(
        &host,
        "plugins.blobs.delete",
        serde_json::json!({ "pluginId": "smoke-plugin", "blobId": blob_id }),
    )?;
    if blob_deleted["deleted"] != serde_json::json!(true) {
        return Err(format!("plugin blob delete was not honest: {blob_deleted}"));
    }

    // Round 48: the audit's remaining "the packaged smoke never calls it"
    // caveats, walked here so the matrix discloses nothing it cannot prove.
    let chat_page = dispatch_ok(&host, "chats.list", serde_json::json!({ "limit": 50 }))?;
    let chat_ids: Vec<&str> = chat_page["items"]
        .as_array()
        .map(|items| items.iter().filter_map(|item| item["id"].as_str()).collect())
        .unwrap_or_default();
    if !chat_ids.contains(&chat_id.as_str()) {
        return Err(format!("chats.list did not report the smoke chat: {chat_page}"));
    }

    let exposure = dispatch_ok(&host, "secrets.exposure", serde_json::json!({}))?;
    if exposure["allowSecretsExposure"] != serde_json::json!(false) {
        return Err(format!(
            "secrets.exposure did not report the fail-closed default: {exposure}"
        ));
    }

    let upload_begin = dispatch_ok(
        &host,
        "assets.upload.begin",
        serde_json::json!({
            "kind": "smoke.upload",
            "filename": "smoke.bin",
            "contentType": "application/octet-stream",
            "totalBytes": 5,
        }),
    )?;
    let upload_id = upload_begin["uploadId"]
        .as_str()
        .ok_or_else(|| "asset upload begin carried no uploadId".to_string())?
        .to_string();
    dispatch_ok(
        &host,
        "assets.upload.append",
        serde_json::json!({
            "uploadId": upload_id,
            "index": 0,
            "contentBase64": "aGVsbG8=",
        }),
    )?;
    let uploaded = dispatch_ok(
        &host,
        "assets.upload.finish",
        serde_json::json!({ "uploadId": upload_id }),
    )?;
    if uploaded["asset"]["sizeBytes"] != serde_json::json!(5) {
        return Err(format!("chunked asset upload did not publish the bytes: {uploaded}"));
    }
    let abort_begin = dispatch_ok(
        &host,
        "assets.upload.begin",
        serde_json::json!({
            "kind": "smoke.upload",
            "filename": "discard.bin",
            "contentType": "application/octet-stream",
            "totalBytes": 5,
        }),
    )?;
    let abort_id = abort_begin["uploadId"]
        .as_str()
        .ok_or_else(|| "asset upload begin carried no uploadId".to_string())?
        .to_string();
    let aborted = dispatch_ok(
        &host,
        "assets.upload.abort",
        serde_json::json!({ "uploadId": abort_id }),
    )?;
    if aborted["deleted"] != serde_json::json!(true) {
        return Err(format!("asset upload abort was not honest: {aborted}"));
    }

    dispatch_ok(
        &host,
        "plugins.disable",
        serde_json::json!({ "id": "smoke-plugin" }),
    )?;
    dispatch_ok(
        &host,
        "plugins.uninstall",
        serde_json::json!({ "id": "smoke-plugin" }),
    )?;
    eprintln!("[smoke] golden: declarative plugin lifecycle (state/secrets/blocks) ok");
    // 15b. Plugin package-trust fence walk (security.plugin-package-trust,
    //      round 42): SEC-05 says an install may never lower the recorded
    //      trust rank. The kernel enforces that fence, and the packaged smoke
    //      proves both halves — a rejected downgrade leaves the registry
    //      untouched, an equal-rank version bump still lands, and the probe
    //      plugin is removed again so the walk leaves no residue.
    dispatch_ok(
        &host,
        "plugins.install",
        serde_json::json!({
            "id": "trust-fence-plugin",
            "name": "Trust Fence Plugin",
            "version": "1.0.0",
            "trustState": "verified-publisher",
            "publisherKeyId": "fp-trust-fence",
            "permissions": ["plugin.storage"],
            "manifest": { "id": "trust-fence-plugin", "main": "dist/index.js" },
        }),
    )?;
    let downgrade = dispatch_error(
        &host,
        "plugins.install",
        serde_json::json!({
            "id": "trust-fence-plugin",
            "name": "Trust Fence Plugin",
            "version": "2.0.0",
            "trustState": "locally-trusted",
            "publisherKeyId": "fp-trust-fence",
            "permissions": ["plugin.storage"],
            "manifest": { "id": "trust-fence-plugin", "main": "dist/index.js" },
        }),
    )?;
    if !downgrade.contains("PLUGIN_TRUST_DOWNGRADE") || !downgrade.contains("trust-fence-plugin") {
        return Err(format!(
            "plugin trust downgrade was not rejected: {downgrade}"
        ));
    }
    let fenced = plugin_item(
        &dispatch_ok(&host, "plugins.list", serde_json::json!({}))?,
        "trust-fence-plugin",
    )?;
    if fenced["version"] != serde_json::json!("1.0.0")
        || fenced["trustState"] != serde_json::json!("verified-publisher")
    {
        return Err(format!(
            "rejected trust downgrade still mutated the registry: {fenced}"
        ));
    }
    dispatch_ok(
        &host,
        "plugins.install",
        serde_json::json!({
            "id": "trust-fence-plugin",
            "name": "Trust Fence Plugin",
            "version": "2.0.0",
            "trustState": "verified-publisher",
            "publisherKeyId": "fp-trust-fence",
            "permissions": ["plugin.storage"],
            "manifest": { "id": "trust-fence-plugin", "main": "dist/index.js" },
        }),
    )?;
    let upgraded = plugin_item(
        &dispatch_ok(&host, "plugins.list", serde_json::json!({}))?,
        "trust-fence-plugin",
    )?;
    if upgraded["version"] != serde_json::json!("2.0.0")
        || upgraded["trustState"] != serde_json::json!("verified-publisher")
    {
        return Err(format!("trust-equal version bump did not land: {upgraded}"));
    }
    dispatch_ok(
        &host,
        "plugins.uninstall",
        serde_json::json!({ "id": "trust-fence-plugin" }),
    )?;
    eprintln!(
        "[smoke] golden: plugin package-trust fence ok (downgrade rejected, equal rank bumps)"
    );
    Ok(())
}

/// Finds one plugin in a `plugins.list` envelope or fails the walk.
#[cfg(desktop)]
fn plugin_item(list: &serde_json::Value, plugin_id: &str) -> Result<serde_json::Value, String> {
    list["items"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["id"] == serde_json::json!(plugin_id))
                .cloned()
        })
        .ok_or_else(|| format!("plugin {plugin_id} missing from the registry: {list}"))
}

/// Builds a minimal legacy Drizzle-era `app.db` for the packaged migration
/// walk (same table shapes the storage converter maps; mirrors the storage
/// test fixture family).
#[cfg(desktop)]
fn build_legacy_fixture(source: &std::path::Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open(source)
        .map_err(|error| format!("fixture open failed: {error}"))?;
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
        CREATE TABLE lore_entries (
            id TEXT PRIMARY KEY, lorebook_id TEXT NOT NULL, keys_json TEXT, secondary_keys TEXT,
            content TEXT NOT NULL, enabled INTEGER DEFAULT 1, position INTEGER DEFAULT 0,
            constant INTEGER DEFAULT 0, selective INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE presets (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );",
    )
    .map_err(|error| format!("fixture tables failed: {error}"))?;
    for sql in [
        "INSERT INTO characters (id, name, created_at, updated_at) VALUES ('leg-c1', 'Alice', 1, 2)",
        "INSERT INTO chats (id, title, character_id, created_at, updated_at) VALUES ('leg-h1', 'Chat', 'leg-c1', 3, 4)",
        "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ('leg-m1', 'leg-h1', 'user', 'Hello', 5)",
        "INSERT INTO lorebooks (id, name, description, created_at, updated_at) VALUES ('leg-l1', 'Lore', 'd', 6, 7)",
        "INSERT INTO presets (id, kind, name, data, created_at, updated_at) VALUES ('leg-p1', 'default', 'Preset', '{}', 8, 9)",
    ] {
        conn.execute(sql, [])
            .map_err(|error| format!("fixture seed failed: {error}"))?;
    }
    Ok(())
}

/// Counts assistant messages in the chat (bounded page).
#[cfg(desktop)]
fn count_assistant_messages(host: &KernelHost, chat_id: &str) -> Result<usize, String> {
    let messages = dispatch_ok(
        host,
        "chats.messages.list",
        serde_json::json!({ "chatId": chat_id, "limit": 200 }),
    )?;
    Ok(messages["items"]
        .as_array()
        .map(|items| items.iter().filter(|m| m["role"] == "assistant").count())
        .unwrap_or(0))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    {
        let builder = tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_dialog::init())
            .manage(SidecarState {
                child: Mutex::new(None),
                stopping: AtomicBool::new(false),
            })
            .invoke_handler(tauri::generate_handler![
                check_core_update,
                install_core_update,
                // Truthful mode probe for the UI (DiagnosticsPanel "Kernel
                // Preview" marking): registered in BOTH modes so the panel
                // never has to guess which backend is active.
                desktop_backend_mode
            ]);

        // Kernel commands are registered only in local kernel mode: in the
        // sidecar mode the host is not managed, and an unmanaged State access
        // would panic. `desktop_mode()` decides the mode (honest staged
        // default, ADR-0038).
        let builder = if desktop_mode() == DesktopMode::Kernel {
            builder.invoke_handler(tauri::generate_handler![
                commands::kernel_dispatch,
                commands::kernel_stream_start,
                commands::kernel_stream_abort,
                // G7/G8 user-facing half (round 29): the Settings в†’ Data
                // legacy import/rollback host commands over the ADR-0062
                // staged-root lifecycle.
                commands::legacy_import_plan,
                commands::legacy_import_execute,
                commands::legacy_import_rollback,
                // Phase 9 Remote Access (РўР— В§10) вЂ” the desktop build always
                // has the `remote` feature; the cfg guard keeps a
                // tauri-only tauri-local configuration compiling.
                #[cfg(feature = "remote")]
                commands::kernel_remote_status,
                #[cfg(feature = "remote")]
                commands::kernel_remote_start,
                #[cfg(feature = "remote")]
                commands::kernel_remote_stop,
                #[cfg(feature = "remote")]
                commands::kernel_remote_pair,
                #[cfg(feature = "remote")]
                commands::kernel_remote_revoke
            ])
        } else {
            builder
        };

        let app = builder
            .setup(|app| {
                let (data_dir, portable) = resolve_data_dir(app)?;

                match desktop_mode() {
                    DesktopMode::Sidecar => {
                        let port = reserve_loopback_port()?;
                        spawn_legacy_sidecar(app, port, &data_dir)?;
                    }
                    DesktopMode::Kernel => setup_local_kernel_mode(app, data_dir, portable)?,
                }
                Ok(())
            })
            .build(tauri::generate_context!())
            .expect("failed to build Tauri application");

        app.run(|app, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                stop_sidecar(app);
            }
        });
    }

    #[cfg(mobile)]
    {
        tauri::Builder::default()
            .invoke_handler(tauri::generate_handler![
                mobile_check_core_update,
                mobile_install_core_update
            ])
            .build(tauri::generate_context!())
            .expect("failed to build Tauri application")
            .run(|_app, _event| {});
    }
}
