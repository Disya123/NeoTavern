//! Desktop winit host for the product chat workspace (Windows/macOS).
//!
//! A1 split of the former `bin/neocompositor-desktop.rs` - zero behavior
//! change: the bin keeps argument parsing, this module owns the shared
//! [`App`] state, the event loop and the probe machinery. Layout mirrors the
//! Android host (`android_surface.rs`):
//!
//! - `state` - session/window construction;
//! - `produce` - full document rebuild + vello raster (the slow path);
//! - `input` - pointer/touch capture, slop rules, message + shell actions;
//! - `scroll` - visual-offset animations (wheel ease-out, touch fling, land);
//! - `text` - keyboard into the focused field;
//! - `frame` - per-redraw present, blend windows, resize, `ApplicationHandler`;
//! - `probe` - deterministic `--pointer`/`--type`/`--wheel`/`--tick` scripting
//!   (plus the diagnostics-only real-time `--wait <ms>` pause).
//!
//! Privacy contract: `App` is declared here, so every child `impl App` block
//! sees the private fields as a descendant of this module - the split changed
//! no visibility.

mod frame;
mod input;
mod probe;
mod produce;
mod scroll;
mod state;
mod text;

use std::collections::VecDeque;
use std::sync::Arc;

use self::probe::ProbeOp;
use crate::scroll_ack::ScrollAckLoop;
use crate::scroll_dynamics::SmoothScroll;
use crate::{ChatCompositor, ChatSession, HitRects, PresentSurface, ProductWire, ShellHit};
use neotavern_presentation_dioxus_shell::{
    set_chat_blueprint_source, set_chat_wallpaper_mode, ChatBlueprintSource,
};
use neotavern_presentation_m0_d2::MessageRect;
use neotavern_presentation_m0_d2::ProductVelloSession;
use winit::event_loop::EventLoop;
use winit::window::{CursorIcon, Window};

/// Layout rect (css x, y, w, h) of the `part:chat-wallpaper` node - the
/// wallpaper dest for the blit-shader underlay (image audit, stage C).
fn wallpaper_rect_css(
    skeleton: &neotavern_presentation_m0_d2::SlotSkeleton,
) -> Option<(f32, f32, f32, f32)> {
    skeleton
        .nodes
        .iter()
        .find(|node| {
            node.part.as_deref() == Some("chat-wallpaper")
                && node.css_width > 0.0
                && node.css_height > 0.0
        })
        .map(|node| (node.css_x, node.css_y, node.css_width, node.css_height))
}

const TITLE: &str = "NeoCompositor — NeoTavern (Windows)";
/// CSS-px per wheel notch — Chromium's desktop wheel step (~100 px per
/// detent). winit reports one line per notch on Windows and does not apply
/// the OS "lines per notch" setting, so the multiplier carries the whole
/// browser-parity step; 40 px read as "nothing moves" next to any browser.
const WHEEL_LINE_CSS: f32 = 100.0;

/// Auto-dismiss delay for the Phase C status toast.
const TOAST_MS: std::time::Duration = std::time::Duration::from_millis(3500);

/// Write one parked export document (chat / character card / prompt template).
/// Returns the path the file landed at.
fn write_export_file(export: &crate::LastExport) -> std::io::Result<String> {
    let dir = std::env::var_os("NEOTA_EXPORT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default().join("exports"));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(&export.filename);
    std::fs::write(&path, &export.bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Text field currently receiving keyboard input (bin-local focus; the shared
/// view model already owns the strings via `set_composer_text` /
/// `set_character_search`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TextFocus {
    None,
    Composer,
    CharacterSearch,
    ChatSearch,
    CreateName,
    ProfileCreateName,
    ProfileRename,
    ChatRename,
    MemoryContent,
    MemoryKeys,
    PresetName,
    ProviderName,
    /// Inline message editor body (`part:message-edit-input`).
    MessageEdit,
    /// Book editor fields (`part:lorebook-name-input` /
    /// `part:lorebook-description-input`).
    LorebookName,
    LorebookDescription,
    /// Persona editor fields (`part:persona-name-input` /
    /// `part:persona-description-input`).
    PersonaName,
    PersonaDescription,
    /// Card-import dialog path prompt (`part:card-path-input`).
    CardPath,
    /// Prompt-template import dialog path (`part:prompt-template-path-input`).
    PromptTemplatePath,
    /// Generation-preset import dialog path (`part:generation-preset-path-input`).
    PresetImportPath,
    /// Profile container import path (`part:profile-import-path`).
    ProfileImportPath,
    /// Header message-search field (`part:header-search-input`).
    HeaderSearch,
    /// Custom ChatML role templates (`part:instruct-*-input`).
    InstructSystem,
    InstructUser,
    InstructAssistant,
    InstructTool,
    InstructSuffix,
    InstructStops,
    /// Compact prompt-block editor (`part:prompt-block-*-input`).
    PromptBlockName,
    PromptBlockContent,
    PromptBlockDepth,
    PromptBlockOrder,
    PromptBlockModel,
    /// Character editor fields (`part:character-*-input`).
    CharacterName,
    CharacterDescription,
    CharacterTag,
    CharacterFirstMessage,
    CharacterCreatorNotes,
    CharacterGreeting(usize),
    /// Generation-preset sampler number (`part:preset-value-input`).
    PresetSampler,
}

fn instruct_focus_role(focus: TextFocus) -> Option<&'static str> {
    match focus {
        TextFocus::InstructSystem => Some("system"),
        TextFocus::InstructUser => Some("user"),
        TextFocus::InstructAssistant => Some("assistant"),
        TextFocus::InstructTool => Some("tool"),
        TextFocus::InstructSuffix => Some("promptSuffix"),
        TextFocus::InstructStops => Some("stopStrings"),
        _ => None,
    }
}

/// Inline message action captured at `Down`, like `PendingUi` for the shell.
/// Kind vocabulary is the shared hit-rects decision table; execution here:
/// React-builtin `copy` (client-side OS clipboard), `delete` (session), the
/// rest log honestly until their feature slices land.
struct PendingMessageAction {
    css_x: f32,
    css_y: f32,
    kind: crate::MessageActionKind,
    row_id: String,
}

struct PanelDrag {
    start_x: f32,
    start_width: f32,
}

/// Composer-adjacent control captured at `Down` from the hit-rect snapshot
/// (layout geometry, not hand-measured bands); released at `Up` in slop.
#[derive(Clone, Copy, Debug)]
enum QuickAction {
    Send,
    Stop,
    ComposerSettings,
    ComposerReset,
    ComposerContext,
    ScrollLatest,
    HeaderSearch,
    BackToParentChat,
}

/// A native-control tap captured at `Down`; released at `Up` if the pointer
/// stayed within `TOUCH_SLOP_CSS` (mirror of the Android `PendingUi`).
struct PendingUi {
    css_x: f32,
    css_y: f32,
    hit: ShellHit,
}

/// Active touch contact (single pointer; no multitouch yet). Owns the drag
/// scroll between slop-cross and release, plus the velocity estimate the
/// release fling starts from - the Android host `last_y`/`last_t`/`velocity`
/// trio, in CSS px.
struct TouchContact {
    pointer_id: u64,
    anchor_y: f32,
    last_y: f32,
    last_t_ns: u64,
    velocity: f64,
    dragging: bool,
    /// A control captured the contact at `Down` (shell hit, message action,
    /// quick action, panel resize). Captured contacts never drag-scroll;
    /// the release runs the same slop-checked `pointer_up` as a mouse click.
    captured: bool,
}

struct App {
    window: Option<Arc<Window>>,
    present: Option<PresentSurface>,
    /// The live chat session. The host picks the wire at startup — the
    /// in-memory `FakeWire` (default) or a kernel-backed wire injected through
    /// `RunConfig.wire` (`Box<dyn ProductWire>`; the kernel adapter lives in
    /// `presentation-kernel-wire`, which is why the field type stays a trait
    /// object here).
    session: ChatSession<Box<dyn ProductWire>>,
    compositor: Option<ChatCompositor>,
    /// Warm produce session: kept across produces so `open_or_refresh`
    /// applies view-model changes incrementally (A2) instead of rebuilding
    /// the VirtualDom every dirty frame.
    vello_session: Option<ProductVelloSession>,
    size: (u32, u32),
    density: f32,
    message_count: u32,
    dirty: bool,
    /// Last `scene_epoch` the host observed. This IS the invalidation
    /// contract: every visible session mutation bumps the epoch, so observing
    /// it in `about_to_wait`/`frame` makes any mutation visible without
    /// per-call-site `dirty` bookkeeping (the Android host reads the same
    /// epoch for its presenter generation).
    observed_scene_epoch: u64,
    snapshot_path: Option<String>,
    swap_path: Option<String>,
    dom_dump_path: Option<String>,
    retry_present: bool,
    last_present_error: Option<std::time::Instant>,
    pending_ui: Option<PendingUi>,
    pending_custom: Option<(String, f32, f32)>,
    last_cursor: Option<(f32, f32)>,
    pointer_taps: VecDeque<ProbeOp>,
    simulated: bool,
    /// Whether the queued probe script contains a `--tick` op. `--wheel`
    /// starts the deterministic probe clock only then: a wheel-only script
    /// must run on the live clock, or the frozen clock-at-0 would stop the
    /// scroll animation (and the lands) from ever advancing.
    probe_has_tick: bool,
    /// Live wheel smooth-scroll; sampled per frame and applied through the
    /// same clamped `scroll_chat_by` path as instant input.
    smooth_scroll: Option<SmoothScroll>,
    /// Fling velocity in CSS px/s after a touch release; decays via the
    /// shared `scroll_dynamics` constants (identical core with Android).
    glide_velocity: f64,
    /// The scroll offset currently SHOWN on screen (CSS px). During a scroll
    /// animation it leads the baked offset; the difference is the blit shift
    /// (`BlitWindow.scroll_y`), so animation frames present the frozen raster
    /// without a re-produce. Landing (gesture end, grab, drift cap) syncs the
    /// session to this value with one `scroll_chat_by`.
    visual_scroll_css: f32,
    /// Cached painted canvas extents in CSS px (`chat_canvas_top/bottom`)
    /// from the last produce — the blit's sample window (real rows only;
    /// below the band the raster holds the composer, not content).
    chat_canvas_css: Option<(f32, f32)>,
    /// Cached chat scroll extent (`ChatSession::scroll_max_css`), refreshed
    /// per produce. The wheel impulse and the animation advance clamp their
    /// targets against it so the visual never overshoots the content window
    /// (an overshoot snapped back on landing — a visible jump at the edge).
    scroll_max_css: f32,
    /// Chat-column blend window cached per produce: `(header, composer_top,
    /// band_left, band_right)` in physical px.
    chat_band: Option<(f32, f32, f32, f32)>,
    /// Fast-path scroll ack-loop (shared with the Android host): owns the
    /// drift cap (half the chat band), the presented-window bookkeeping and
    /// the advance/land decisions, so both hosts run the identical policy.
    ack: ScrollAckLoop,
    /// Monotonic clock base for the scroll animation timelines.
    clock_base: std::time::Instant,
    /// Deterministic probe clock (ns since boot of the replay); `None`
    /// disables it. `--tick` ops advance it and step the animations, so
    /// `--wheel 40 --tick 120 --snapshot x.png` lands a deterministic end
    /// state without depending on wall time.
    probe_clock_ns: Option<u64>,
    /// Monotonic ns of the last live fling step (physics dt source).
    last_glide_tick_ns: Option<u64>,
    /// Active touch contact, if any; mouse events are suppressed while set
    /// (digitizers synthesize mouse events for the same contact).
    touch: Option<TouchContact>,
    /// `--blit-shift <dy_css>` diagnostic: one shifted present after the next
    /// frame, to verify the 2D blend window (chat column shifts, chrome and
    /// sidebar stay put).
    blit_shift_probe: Option<f32>,
    focus: TextFocus,
    status_shown_at: Option<std::time::Instant>,
    /// Chat message row boxes from the last painted frame, keyed by
    /// `data-message-id`; drives inline message-action hit-testing.
    message_rects: Vec<MessageRect>,
    /// Message action captured at `Down` (released at `Up` within slop).
    pending_message_action: Option<PendingMessageAction>,
    /// Composer control captured at `Down` (released at `Up` within slop).
    pending_quick: Option<(QuickAction, f32, f32)>,
    /// Layout-derived hit rectangles from the last produced frame - the single
    /// source of geometry for taps/focus (replaces hand-measured bands).
    hit_rects: HitRects,
    /// Drag-resize of the React side panel (`Sidebar_resizeHandle`).
    panel_drag: Option<PanelDrag>,
    /// Last OS cursor icon applied on `pointer_move`; the Win32 call is not
    /// free and move events arrive per pixel.
    cursor_icon: Option<CursorIcon>,
    /// `--w`/`--h` logical window size (documented defaults 1100x760).
    initial_size: (u32, u32),
    /// Raw wallpaper file bytes from `--wallpaper <path>` (<=16 MiB, same cap
    /// as the avatar decode preflight). Decoded lazily per window size.
    wallpaper_bytes: Option<Vec<u8>>,
    /// Cached cover raster + the physical size it was built for.
    wallpaper_cache: Option<(u32, u32, crate::AvatarThumb)>,
    /// Bumped whenever `wallpaper_cache` is rebuilt so the GPU underlay
    /// re-uploads only on real content/size changes.
    wallpaper_epoch: u64,
    /// Last produce timestamp while a generation stream was live — the
    /// ~30/s streaming cadence gate (AGENTS §24).
    last_stream_produce: Option<std::time::Instant>,
    /// Set when the streaming gate deferred this frame's produce: the present
    /// still shows the previous raster and the next redraw re-produces.
    produce_deferred: bool,
    /// Last tracked CSS cursor position — wheel events carry no position in
    /// this winit version, and the panel scroll router needs one.
    pointer_css: (f32, f32),
    /// Frame-pacing diagnostics (`NEOTA_FRAME_TIMING=1`): when the last blit
    /// presented and how long the last produce took, logged per present.
    last_present_instant: Option<std::time::Instant>,
    last_produce_ms: Option<u128>,
    frame_timing: bool,
    /// Per-produce skeleton dump counter (`NEOTA_DOM_DUMP_ALL`).
    dom_dump_count: u32,
}

pub struct RunConfig {
    pub messages: u32,
    pub initial_size: (u32, u32),
    pub snapshot: Option<String>,
    pub swapchain: Option<String>,
    pub dom_dump: Option<String>,
    pub blit_shift: Option<f32>,
    pub wallpaper_path: Option<String>,
    pub blueprint_source: Option<ChatBlueprintSource>,
    /// Runtime wire override for kernel-backed hosts. `None` keeps the
    /// in-memory `FakeWire` seeded with `messages` rows (the default
    /// `neocompositor-desktop` bin).
    pub wire: Option<Box<dyn ProductWire>>,
    /// Preferred chat to open (`ChatSession::open`). `None` keeps the
    /// FakeWire demo chat (the default bin); kernel-backed hosts pass the id
    /// of the chat they seeded.
    pub chat_id: Option<String>,
}

/// Build the session, apply the configuration in the exact order the former
/// `main` used (fields -> wallpaper -> blueprint -> seeded line) and run the
/// winit event loop to completion.
pub fn run(config: RunConfig) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(config.messages, config.wire, config.chat_id)?;
    app.snapshot_path = config.snapshot;
    app.swap_path = config.swapchain;
    app.dom_dump_path = config.dom_dump;
    app.pointer_taps = probe::parse_probe_ops(&std::env::args().collect::<Vec<String>>());
    app.probe_has_tick = app
        .pointer_taps
        .iter()
        .any(|op| matches!(op, crate::desktop_host::probe::ProbeOp::Tick(_)));
    app.blit_shift_probe = config.blit_shift;
    app.initial_size = config.initial_size;
    if let Some(path) = config.wallpaper_path {
        match std::fs::read(&path) {
            Ok(bytes) => {
                if bytes.len() > crate::THUMBNAIL_INPUT_MAX_BYTES {
                    eprintln!(
                        "[neocompositor-desktop] wallpaper ignored: file exceeds {} bytes",
                        crate::THUMBNAIL_INPUT_MAX_BYTES
                    );
                } else {
                    app.wallpaper_bytes = Some(bytes);
                    // Drops the opaque packed `.AppShell_shell` base so the
                    // host-composited photo can show through the translucent
                    // scene (see product_shell.rs wallpaper-mode comment).
                    set_chat_wallpaper_mode(true);
                }
            }
            Err(err) => {
                eprintln!("[neocompositor-desktop] wallpaper ignored: {err}");
            }
        }
    }
    if let Some(source) = config.blueprint_source {
        let legacy = matches!(source, ChatBlueprintSource::Disabled);
        set_chat_blueprint_source(source);
        if legacy {
            eprintln!("[neocompositor-desktop] chrome driven by legacy RSX (safe mode)");
        } else {
            eprintln!("[neocompositor-desktop] chrome driven by blueprint document (--blueprint)");
        }
    } else if let ChatBlueprintSource::Path(path) = ChatBlueprintSource::from_env() {
        set_chat_blueprint_source(ChatBlueprintSource::Path(path));
        eprintln!("[neocompositor-desktop] chrome driven by NEOTA_CHAT_BLUEPRINT_DOC");
    } else {
        // Stage-1 default (ADR-0056): the embedded canonical document drives
        // the covered chrome variants; uncovered ones degrade to legacy per
        // frame with a one-time notice from the shell.
        set_chat_blueprint_source(ChatBlueprintSource::Embedded);
        eprintln!(
            "[neocompositor-desktop] chrome driven by embedded blueprint (default; --legacy-chrome to opt out)"
        );
    }
    eprintln!(
        "[neocompositor-desktop] seeded {} wire messages",
        app.message_count
    );
    let event_loop = EventLoop::new()?;
    event_loop.run_app(&mut app)?;
    Ok(())
}
