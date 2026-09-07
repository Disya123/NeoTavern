//! NeoCompositor desktop host (Windows/macOS).
//!
//! Runs the exact product route the Android `SurfaceView` host runs вЂ"
//! `ProductWire в†' Dioxus в†' Blitz в†' NeoCompositor/presentation-session в†'
//! vello в†' swapchain` вЂ" inside a native winit window. The only platform code
//! here is the window + `wgpu::Surface`; the present pipeline is the shared
//! [`neotavern_presentation_chat::PresentSurface`] host, which is byte-identical
//! in behavior to the Android `GpuSurface` (`android_surface.rs`).
//!
//! A1 split: the host lives in `neotavern_presentation_chat::desktop_host`
//! (state/produce/input/scroll/text/frame/probe modules); this binary is only
//! argument parsing plus the `run` entrypoint.
//!
//! Build & run (Windows/macOS):
//!   cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-chat \
//!     --features desktop-host --bin neocompositor-desktop
//!
//! Flags (before `--` for `cargo run`):
//!   --messages <N>  seed chat with N wire messages           (default 12)
//!   --w <px> --h <px>  initial window size in physical px    (default 1100x760)
//!   --pointer <x>,<y>  simulate one CSS-px tap through the same pointer
//!                      pipeline as the mouse (press+release, for snapshots)
//!   --type <text>     type text into the focused field
//!   --wheel <dy>      one wheel notch in CSS px through the live smooth-scroll
//!                     path (positive = toward older messages)
//!   --tick <ms>       advance the deterministic probe clock and run one
//!                     animation step (`--wheel 40 --tick 120` lands the notch;
//!                     a mid-flight `--tick 60` snapshots the eased state)
//!   --snapshot <png> / --swapchain <png> / --dom-dump <json>  diagnostic dumps

use neotavern_presentation_chat::desktop_host::{run, RunConfig};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let get = |name: &str, default: &str| -> String {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };
    let messages: u32 = get("--messages", "12").parse().unwrap_or(12);
    let w: u32 = get("--w", "1100").parse().unwrap_or(1100);
    let h: u32 = get("--h", "760").parse().unwrap_or(760);
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
    // Blit-window diagnostic: shift the chat column once (see `frame`).
    let blit_shift: Option<f32> = args
        .iter()
        .position(|a| a == "--blit-shift")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.trim().parse::<f32>().ok());
    // Blueprint-driven chrome (M2/M4): since the M4 wave-4 flip (ADR-0056)
    // the embedded canonical document is the DEFAULT renderer of the inner
    // chat chrome on this internal host. Opt-outs, strongest first:
    //   1. `--legacy-chrome` or `NEOTA_LEGACY_CHROME=1` — safe-mode escape
    //      hatch back to the hand-written RSX (also used by the golden
    //      capture gate);
    //   2. `--blueprint <path|embedded>` — explicit source override;
    //   3. `NEOTA_CHAT_BLUEPRINT_DOC=<path>` — authoring loop override.
    // Uncovered chrome variants (compact height, overlay/nested glass) keep
    // falling back to legacy per frame until their document slices land.
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
        messages,
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
        wire: None,
        chat_id: None,
    })
}
