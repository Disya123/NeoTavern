//! NeoCompositor desktop host on the **canonical Rust Kernel** wire.
//!
//! The same winit/present pipeline as `neocompositor-desktop` (the shared
//! `desktop_host` module in `presentation-chat`); the only difference is the
//! wire: every Product Wire call and generation stream goes through a real
//! `runtime-kernel` with durable SQLite storage instead of the in-memory
//! `FakeWire`. This is the "kernel mode" bin — the runtime wire choice lives
//! in a separate crate because `presentation-chat` must not depend on
//! `runtime-kernel` (guard test `live_wire.rs`).
//!
//! Build & run (Windows/macOS):
//!   cargo run --manifest-path crates/Cargo.toml \
//!     -p neotavern-presentation-kernel-wire --features desktop-host \
//!     --bin neocompositor-kernel
//!
//! Additional flags over the shared host:
//!   --data-root <dir>  kernel storage root (default: a temp dir per run)
//!   --seed <N>         seed N chat messages before the session opens
//!                     (default 12, mirroring the FakeWire host's `--messages`)

use neotavern_presentation_chat::desktop_host::{run, RunConfig};
use neotavern_presentation_kernel_wire::{seed_parity_workspace, KernelProductWire};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let get = |name: &str, default: &str| -> String {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };
    let seed: u32 = get("--seed", "12").parse().unwrap_or(12);
    let data_root = get("--data-root", "");

    let root: std::path::PathBuf = if data_root.is_empty() {
        std::env::temp_dir().join(format!("neocompositor-kernel-{}", std::process::id()))
    } else {
        std::path::PathBuf::from(data_root)
    };
    std::fs::create_dir_all(&root)?;

    let mut wire = KernelProductWire::open(&root)
        .map_err(|err| -> Box<dyn std::error::Error> { err.to_string().into() })?;
    let mut chat_id: Option<String> = None;
    if seed > 0 {
        let seeded = seed_parity_workspace(&mut wire, "Kernel Demo", seed)
            .map_err(|err| -> Box<dyn std::error::Error> { err.to_string().into() })?;
        eprintln!("[neocompositor-kernel] seeded {seed} messages into {seeded}");
        chat_id = Some(seeded);
    }
    let wire: Box<dyn neotavern_presentation_chat::ProductWire> = Box::new(wire);

    let snapshot: Option<String> = args
        .iter()
        .position(|a| a == "--snapshot")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let swapchain: Option<String> = args
        .iter()
        .position(|a| a == "--swapchain")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let dom_dump: Option<String> = args
        .iter()
        .position(|a| a == "--dom-dump")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let blit_shift: Option<f32> = args
        .iter()
        .position(|a| a == "--blit-shift")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.trim().parse::<f32>().ok());
    let w: u32 = get("--w", "1100").parse().unwrap_or(1100);
    let h: u32 = get("--h", "760").parse().unwrap_or(760);
    let legacy_chrome = args.iter().any(|a| a == "--legacy-chrome")
        || std::env::var("NEOTA_LEGACY_CHROME")
            .map(|value| value == "1")
            .unwrap_or(false);
    let blueprint_source = if legacy_chrome {
        Some(neotavern_presentation_dioxus_shell::ChatBlueprintSource::Disabled)
    } else {
        args.iter()
            .position(|a| a == "--blueprint")
            .and_then(|i| args.get(i + 1))
            .map(|value| {
                if value == "embedded" {
                    neotavern_presentation_dioxus_shell::ChatBlueprintSource::Embedded
                } else {
                    neotavern_presentation_dioxus_shell::ChatBlueprintSource::Path(
                        std::path::PathBuf::from(value),
                    )
                }
            })
    };

    run(RunConfig {
        messages: seed,
        initial_size: (w.max(1), h.max(1)),
        snapshot,
        swapchain,
        dom_dump,
        blit_shift,
        wallpaper_path: args
            .iter()
            .position(|a| a == "--wallpaper")
            .and_then(|i| args.get(i + 1))
            .cloned(),
        blueprint_source,
        wire: Some(wire),
        chat_id,
    })
}
