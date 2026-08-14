use serde::Serialize;
use tauri::AppHandle;

#[cfg(all(desktop, feature = "remote"))]
use neotavern_tauri_local::remote::{RemoteAccessService, RemoteAccessState};
#[cfg(desktop)]
use neotavern_tauri_local::{build_request_envelope, commands, KernelHost, KernelHostConfig};
#[cfg(desktop)]
use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
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
/// Backend mode selection — the honest staged default (ADR-0038 "Honest
/// Desktop default", AGENTS.md §21).
///
/// The Runtime Kernel is the canonical core, but public/release builds
/// temporarily run the tested legacy Node sidecar while the Kernel is an
/// explicit Preview; nightly/internal builds default to the Kernel. The
/// channel is baked at build time via `NEOTA_DESKTOP_CHANNEL`
/// (`nightly` → Kernel default; any other value or unset → sidecar default).
/// Debug (dev) builds are internal and default to the Kernel.
///
/// Explicit runtime overrides always win: `NEOTA_LEGACY_SERVER=1` forces the
/// sidecar, `NEOTA_KERNEL=1` forces the Kernel (Preview opt-in). CONFLICT
/// POLICY (ADR-0038): when BOTH overrides are set, `NEOTA_KERNEL=1` wins —
/// the Kernel is the canonical plane and the direction of travel — and a
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

/// Pure mode resolver — the decision table behind [`desktop_mode`], explicit
/// inputs so the whole matrix is unit-testable (no env/global access).
///
/// Precedence (ADR-0038):
/// 1. `legacy_override` (`NEOTA_LEGACY_SERVER=1`) → Sidecar;
/// 2. `kernel_override` (`NEOTA_KERNEL=1`) → Kernel; when BOTH are set the
///    Kernel wins (conflict policy — the warning is printed by the caller);
/// 3. `debug_build` → Kernel (dev builds are internal);
/// 4. build channel: `nightly` → Kernel, any other/unset → Sidecar (the
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
            if debug_build {
                DesktopMode::Kernel
            } else {
                match channel {
                    Some("nightly") => DesktopMode::Kernel,
                    _ => DesktopMode::Sidecar,
                }
            }
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
    fn public_release_channel_defaults_to_sidecar() {
        assert_eq!(
            resolve_desktop_mode(false, false, false, None),
            DesktopMode::Sidecar
        );
        assert_eq!(
            resolve_desktop_mode(false, false, false, Some("release")),
            DesktopMode::Sidecar
        );
        assert_eq!(
            resolve_desktop_mode(false, false, false, Some("stable")),
            DesktopMode::Sidecar
        );
    }

    #[test]
    fn nightly_channel_defaults_to_kernel() {
        assert_eq!(
            resolve_desktop_mode(false, false, false, Some("nightly")),
            DesktopMode::Kernel
        );
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
                        let expected = if kernel {
                            DesktopMode::Kernel
                        } else if legacy {
                            DesktopMode::Sidecar
                        } else if debug {
                            DesktopMode::Kernel
                        } else {
                            match channel {
                                Some("nightly") => DesktopMode::Kernel,
                                _ => DesktopMode::Sidecar,
                            }
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
/// time, so the root never has two writable owners.
#[cfg(desktop)]
fn resolve_data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    let portable_data_dir = executable
        .parent()
        .filter(|directory| directory.join("portable.flag").is_file())
        .map(|directory| directory.join("data"));
    let data_dir = match portable_data_dir {
        Some(directory) => directory,
        None => app.path().app_local_data_dir()?,
    };
    fs::create_dir_all(&data_dir)?;
    Ok(data_dir)
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

/// Spawns the legacy Node sidecar — the release-channel default while the
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
) -> Result<(), Box<dyn std::error::Error>> {
    let host = KernelHost::open(KernelHostConfig {
        // Clone: `data_dir` is also the Remote Access config fallback (the
        // kernel data root is guaranteed writable and exists).
        data_root: Some(data_dir.clone()),
    })
    .map_err(|error| {
        // Controlled kernel error (contract mismatch, data_root_in_use,
        // storage failure): the shell must not open a window against a dead
        // kernel, and the error goes to stderr diagnostics only.
        eprintln!("kernel open failed: {error}");
        error.to_string()
    })?;
    app.manage(host);

    // Phase 9 Remote Access host service (ТЗ §10): the service wraps the
    // remote-http adapter lifecycle; its config persists next to the app
    // data. Resolution is best-effort — a failure falls back to the local
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
        run_kernel_smoke(&app.handle());
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

/// Deterministic smoke self-check for the packaged local kernel: exercises
/// the exact local handshake (already validated by [`KernelHost::open`]) plus
/// one meta and two read operations through the shared envelope layer. Any
/// non-ok envelope or transport failure exits 1.
#[cfg(desktop)]
fn run_kernel_smoke(app: &AppHandle) {
    let host = app.state::<KernelHost>();
    let mut failures = 0usize;
    for (operation_id, payload) in [
        ("meta.get", serde_json::json!({})),
        ("characters.list", serde_json::json!({})),
        ("backups.list", serde_json::json!({})),
    ] {
        let request = build_request_envelope(
            operation_id,
            payload,
            "00000000-0000-4000-8000-000000000001",
        );
        match host.dispatch_envelope(&request) {
            Ok(body) => match serde_json::from_slice::<serde_json::Value>(&body) {
                Ok(envelope) if envelope.get("kind").and_then(|k| k.as_str()) == Some("ok") => {
                    eprintln!("[smoke] {operation_id}: ok");
                }
                Ok(envelope) => {
                    eprintln!(
                        "[smoke] {operation_id}: error envelope {}",
                        envelope
                            .get("error")
                            .map(|e| e.to_string())
                            .unwrap_or_default()
                    );
                    failures += 1;
                }
                Err(_) => {
                    eprintln!("[smoke] {operation_id}: response was not JSON");
                    failures += 1;
                }
            },
            Err(failure) => {
                eprintln!("[smoke] {operation_id}: transport failure {:?}", failure);
                failures += 1;
            }
        }
    }
    if failures == 0 {
        std::process::exit(0);
    }
    std::process::exit(1);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    {
        let builder = tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
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
                // Phase 9 Remote Access (ТЗ §10) — the desktop build always
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
                let data_dir = resolve_data_dir(app)?;

                match desktop_mode() {
                    DesktopMode::Sidecar => {
                        let port = reserve_loopback_port()?;
                        spawn_legacy_sidecar(app, port, &data_dir)?;
                    }
                    DesktopMode::Kernel => setup_local_kernel_mode(app, data_dir)?,
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
