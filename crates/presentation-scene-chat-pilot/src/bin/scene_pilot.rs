//! ADR-0057 Phase 1 desktop bridge binary for the chat pilot.
//!
//! Dev evidence host — NOT the shipped desktop UI (the legacy contour
//! still ships until the ADR-0057 phase gates). Everything except the
//! argument parsing lives in
//! [`neotavern_presentation_scene_chat_pilot::desktop`].
//!
//! Build & run (Windows/macOS):
//!   cargo run --manifest-path crates/Cargo.toml \
//!     -p neotavern-presentation-scene-chat-pilot \
//!     --features desktop-host --bin scene-pilot
//!
//! Flags:
//!   (default)          FakeWire demo chat, 12 messages (INV-7: the
//!                       window title carries the fake-wire label)
//!   --messages <N>      seed the FakeWire demo chat with N messages
//!   --root <dir>        open the real Rust Kernel over a SQLite data
//!                       root (created if missing; a demo chat is seeded
//!                       only when the workspace has no chats yet)
//!   --chat <id>         open this chat id (default: the session picks)
//!   --w <px> --h <px>   initial window size in logical (CSS) px
//!   --golden <dir>      local-only: render PNG rasters at the golden
//!                       corpus sizes into <dir> and exit (no window;
//!                       never a CI gate)

use neotavern_presentation_scene_chat_pilot::desktop::{render_pngs, run, RunConfig, WireSource};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let get = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let messages: u32 = get("--messages").and_then(|v| v.parse().ok()).unwrap_or(12);
    let width: u32 = get("--w").and_then(|v| v.parse().ok()).unwrap_or(1100);
    let height: u32 = get("--h").and_then(|v| v.parse().ok()).unwrap_or(760);
    let chat_id = get("--chat");
    let source = match get("--root") {
        Some(root) => WireSource::Kernel {
            root: std::path::PathBuf::from(root),
        },
        None => WireSource::Fake { messages },
    };
    let config = RunConfig {
        source,
        chat_id,
        width,
        height,
    };
    if let Some(dir) = get("--golden") {
        let written = render_pngs(config, std::path::Path::new(&dir))?;
        eprintln!("[scene-pilot] wrote {} golden raster(s)", written.len());
        return Ok(());
    }
    run(config)
}
