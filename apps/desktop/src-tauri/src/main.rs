use serde::Serialize;
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
use tauri::{path::BaseDirectory, AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const STARTUP_ATTEMPTS: usize = 1200;
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(50);
const UPDATE_ENDPOINT: Option<&str> = option_env!("NEOTA_UPDATE_ENDPOINT");
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("NEOTA_UPDATE_PUBLIC_KEY");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreUpdateStatus {
    configured: bool,
    current_version: String,
    available_version: Option<String>,
}

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

struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
}

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

fn reserve_loopback_port() -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.stopping.store(true, Ordering::Release);
    if let Ok(mut child) = state.child.lock() {
        if let Some(process) = child.take() {
            let _ = process.kill();
        }
    };
}

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

fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SidecarState {
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            check_core_update,
            install_core_update
        ])
        .setup(|app| {
            let port = reserve_loopback_port()?;
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
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_sidecar(app);
        }
    });
}

fn main() {
    run();
}
