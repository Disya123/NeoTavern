//! NeoCompositor desktop host (Windows/macOS).
//!
//! Runs the exact product route the Android `SurfaceView` host runs вЂ”
//! `ProductWire в†’ Dioxus в†’ Blitz в†’ NeoCompositor/presentation-session в†’
//! vello в†’ swapchain` вЂ” inside a native winit window. The only platform code
//! here is the window + `wgpu::Surface`; the present pipeline is the shared
//! [`neotavern_presentation_chat::PresentSurface`] host, which is byte-identical
//! in behavior to the Android `GpuSurface` (`android_surface.rs`).
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

use std::collections::VecDeque;
use std::sync::Arc;

use neotavern_presentation_chat::{
    hit_test, scroll_ack::ScrollAckLoop, scroll_dynamics::SmoothScroll, sidebar_occupied_css,
    BlitWindow, ChatCompositor, ChatSession, FakeWire, HitRects, PresentSurface, QuickIntent,
    ShellAction, ShellHit, TapIntent, DEMO_CHAT_ID, RAIL_WIDTH, TOUCH_SLOP_CSS,
};
use neotavern_presentation_dioxus_shell::{
    chrome_metrics, install_product_shell, product_shell_app,
};
use neotavern_presentation_m0_d2::{
    image_paints_from_layout, write_slot_skeleton, MessageRect, ProductVelloSession, VelloFilter,
};
use vello::peniko::color::palette;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowAttributes};

const TITLE: &str = "NeoCompositor вЂ” NeoTavern (Windows)";
/// Approx CSS-px per wheel notch вЂ” a comfortable desktop scroll step.
const WHEEL_LINE_CSS: f32 = 40.0;

/// Layout rect (css x, y, w, h) of the `part:chat-wallpaper` node — the
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

/// Auto-dismiss delay for the Phase C status toast.
const TOAST_MS: std::time::Duration = std::time::Duration::from_millis(3500);

/// Write one parked export document (chat / character card / prompt template).
/// Returns the path the file landed at.
fn write_export_file(export: &neotavern_presentation_chat::LastExport) -> std::io::Result<String> {
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

fn preset_sampler_text(view: &neotavern_presentation_dioxus_shell::ProductShellView) -> String {
    view.preset_rows
        .iter()
        .find(|row| row.focused)
        .map(|row| row.value.clone())
        .unwrap_or_default()
}

/// One scripted probe step, replayed in argument order so
/// "focus -> type -> send" scenarios are expressible.
#[derive(Clone, Debug)]
enum ProbeOp {
    Tap(f32, f32),
    Type(String),
    /// One wheel notch in CSS px through the live smooth-scroll path.
    Wheel(f32),
    /// Advance the deterministic probe clock by N ms and run one animation
    /// step (same sampler the real frame loop uses).
    Tick(u64),
}

/// Inline message action captured at `Down`, like `PendingUi` for the shell.
/// Kind vocabulary is the shared hit-rects decision table; execution here:
/// React-builtin `copy` (client-side OS clipboard), `delete` (session), the
/// rest log honestly until their feature slices land.
struct PendingMessageAction {
    css_x: f32,
    css_y: f32,
    kind: neotavern_presentation_chat::MessageActionKind,
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
/// release fling starts from — the Android host's `last_y`/`last_t`/`velocity`
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
    session: ChatSession<FakeWire>,
    compositor: Option<ChatCompositor>,
    size: (u32, u32),
    density: f32,
    message_count: u32,
    dirty: bool,
    snapshot_path: Option<String>,
    swap_path: Option<String>,
    dom_dump_path: Option<String>,
    retry_present: bool,
    last_present_error: Option<std::time::Instant>,
    pending_ui: Option<PendingUi>,
    last_cursor: Option<(f32, f32)>,
    pointer_taps: VecDeque<ProbeOp>,
    simulated: bool,
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
    /// Layout-derived hit rectangles from the last produced frame вЂ” the single
    /// source of geometry for taps/focus (replaces hand-measured bands).
    hit_rects: HitRects,
    /// Drag-resize of the React side panel (`Sidebar_resizeHandle`).
    panel_drag: Option<PanelDrag>,
    /// Last OS cursor icon applied on `pointer_move`; the Win32 call is not
    /// free and move events arrive per pixel.
    cursor_icon: Option<winit::window::CursorIcon>,
    /// `--w`/`--h` logical window size (documented defaults 1100Г—760).
    initial_size: (u32, u32),
    /// Raw wallpaper file bytes from `--wallpaper <path>` (≤16 MiB, same cap
    /// as the avatar decode preflight). Decoded lazily per window size.
    wallpaper_bytes: Option<Vec<u8>>,
    /// Cached cover raster + the physical size it was built for.
    wallpaper_cache: Option<(u32, u32, neotavern_presentation_chat::AvatarThumb)>,
    /// Bumped whenever `wallpaper_cache` is rebuilt so the GPU underlay
    /// re-uploads only on real content/size changes.
    wallpaper_epoch: u64,
}

impl App {
    fn new(messages: u32) -> Result<Self, Box<dyn std::error::Error>> {
        let wire = FakeWire::with_message_count(messages.max(1));
        let mut session = ChatSession::open(wire, Some(DEMO_CHAT_ID))
            .map_err(|err| -> Box<dyn std::error::Error> { err.to_string().into() })?;
        let _ = session.mount_vdom();
        let _ = session.drain_stream();
        // Hydrate avatar thumbnails via `assets.content` so the GPU overlay on
        // the shared host has real pixels (Android parity).
        session.refresh_characters();
        Ok(Self {
            window: None,
            present: None,
            session,
            compositor: None,
            size: (0, 0),
            density: 1.0,
            message_count: messages,
            dirty: true,
            snapshot_path: None,
            swap_path: None,
            dom_dump_path: None,
            retry_present: false,
            last_present_error: None,
            pending_ui: None,
            last_cursor: None,
            pointer_taps: VecDeque::new(),
            simulated: false,
            smooth_scroll: None,
            glide_velocity: 0.0,
            visual_scroll_css: 0.0,
            chat_band: None,
            ack: ScrollAckLoop::new(0.0),
            clock_base: std::time::Instant::now(),
            probe_clock_ns: None,
            last_glide_tick_ns: None,
            touch: None,
            blit_shift_probe: None,
            focus: TextFocus::None,
            status_shown_at: None,
            message_rects: Vec::new(),
            pending_message_action: None,
            pending_quick: None,
            hit_rects: HitRects::default(),
            panel_drag: None,
            cursor_icon: None,
            initial_size: (1100, 760),
            wallpaper_bytes: None,
            wallpaper_cache: None,
            wallpaper_epoch: 0,
        })
    }

    /// Produce + rasterize once on dirty (mirrors the Android host: layout and
    /// vello raster happen per `bind`, then each present frame only re-blits
    /// the accumulated `resolve` вЂ” `composite_only_frames`).
    fn produce_and_render(&mut self) {
        let Some(present) = self.present.as_mut() else {
            return;
        };
        let t0 = std::time::Instant::now();
        let (width, height) = self.size;
        let density = self.density;
        // Produce-time target re-allocation: resize events only re-configure
        // the swapchain (stretch-present of the previous raster); here the
        // rasters catch up with the settled size exactly once per produce.
        present.resize(width.max(1), height);
        let (insets, toast_showing, chat_band, ack_cap_css, ui_opacity, character_count) = {
            let session = &mut self.session;
            session.set_surface_size(width.max(1), height, density);
            session.set_safe_area_physical(0.0, 0.0, 0.0, 0.0);
            // One view-model build per frame: `shell_view` clones characters,
            // visible rows and drafts, so a second call for the toast check
            // doubles that cost on every drag/scroll tick.
            let shell = session.shell_view();
            let toast_showing = shell.status_message.is_some();
            // Chat-column blend window (physical px) for blit-shifted
            // presents; the drift cap is half the band height so filler never
            // covers the whole viewport between landings.
            let d = density.max(1.0);
            let css_w = ((width.max(1) as f32 / d).round()) as u32;
            let css_h = ((height.max(1) as f32 / d).round()) as u32;
            let (_, header, viewport, _) = chrome_metrics(css_w, css_h);
            let occupied = sidebar_occupied_css(&shell);
            let band = (
                header as f32 * d,
                (header + viewport) as f32 * d,
                occupied * d,
                width as f32,
            );
            let cap = (band.1 - band.0) * 0.5 / d;
            // Captured before the move into `install_product_shell`; the
            // wallpaper dim and the produce log need them, and a second
            // `shell_view()` call would clone the whole view-model again
            // (see the comment above).
            let ui_opacity = shell.ui_opacity;
            let character_count = shell.characters.len();
            install_product_shell(shell);
            (
                session.insets(),
                toast_showing,
                band,
                cap,
                ui_opacity,
                character_count,
            )
        };
        self.chat_band = Some(chat_band);
        self.ack.set_cap(ack_cap_css);
        if toast_showing {
            if self.status_shown_at.is_none() {
                self.status_shown_at = Some(std::time::Instant::now());
            }
        } else {
            self.status_shown_at = None;
        }
        let t_layout = std::time::Instant::now();

        let t_open = std::time::Instant::now();
        let mut sess = match ProductVelloSession::open(
            product_shell_app,
            width.max(1),
            height.max(1),
            density.max(1.0),
            insets,
        ) {
            Ok(session) => session,
            Err(err) => {
                eprintln!("[neocompositor-desktop] session open: {err}");
                self.dirty = true;
                return;
            }
        };
        let t_paint = std::time::Instant::now();
        let (produced, scene, _diag) = match sess.paint(VelloFilter::full()) {
            Ok(out) => out,
            Err(err) => {
                eprintln!("[neocompositor-desktop] paint: {err}");
                self.dirty = true;
                return;
            }
        };
        let t_render = std::time::Instant::now();
        let list_ops = produced.list.ops.len();
        let scene_paths = scene.encoding().n_paths;

        // Diagnostic: dump the recorded paint stream (fills/strokes with
        // bounding boxes) so the painted geometry can be compared with the
        // skeleton (`--dom-dump`). Helps catch paint/layout divergence.
        if std::env::var("NEOTA_SCENE_DUMP").is_ok() {
            let mut lines: Vec<String> = produced
                .stream
                .iter()
                .filter_map(|op| match op {
                    neotavern_presentation_m0_d2::StreamOp::Draw {
                        kind,
                        rect: Some(r),
                        fill_rgba: Some((cr, cg, cb, ca)),
                    } if *ca > 40 => Some(format!(
                        "[stream] {kind:?} rect=({:.0},{:.0},{:.0},{:.0}) rgba=({cr},{cg},{cb},{ca})",
                        r.x, r.y, r.x + r.width, r.y + r.height
                    )),
                    _ => None,
                })
                .collect();
            lines.sort();
            for l in lines {
                eprintln!("{l}");
            }
        }

        let heights = self.session.compositor_height_index();
        match self.compositor.as_mut() {
            Some(compositor) => compositor.bind_list(produced.list),
            None => {
                self.compositor = Some(ChatCompositor::from_list_scaled(
                    heights,
                    width,
                    height,
                    produced.list,
                    density.max(1.0),
                ));
            }
        }

        if let Err(err) = present.render(&scene, palette::css::TRANSPARENT) {
            eprintln!("[neocompositor-desktop] render: {err}");
            self.dirty = true;
            return;
        }
        let t_post = std::time::Instant::now();
        if std::env::var("NEOTA_DEBUG_PEEK").is_ok() {
            for (px, py) in [(550, 410), (1092, 410), (550, 100), (30, 400)] {
                let before = present.debug_peek_resolve(px, py);
                eprintln!("[wall-debug] after render ({px},{py}): {before:?}");
            }
        }
        // One full skeleton build per produce: the same skeleton feeds the
        // wallpaper dest rect, the hit rects and (when requested) the dom
        // dump — `slot_skeleton()` walks the whole document on every call.
        let skeleton = sess.slot_skeleton();
        // Wallpaper photo: fixed underlay composited by the blit shader (image
        // audit, stage C). The scroll blit shifts the scene OVER the photo, so
        // the wallpaper no longer rides the band shift and the band's
        // out-of-range region shows the photo instead of the flat filler. The
        // dest rect is the layout rect of the `part:chat-wallpaper` node
        // (chat workspace + bleed) — the photo no longer glows through the
        // sidebar, matching the React chrome scoping.
        if let Some(bytes) = &self.wallpaper_bytes {
            let density = density.max(1.0);
            let wall_css = wallpaper_rect_css(&skeleton);
            // React parity dim: `overlay_alpha = ui_opacity/100 * 0.45`
            // (product_shell.rs); the shader applies it fixed to the photo.
            let overlay_alpha = (ui_opacity.min(100) as f32 / 100.0) * 0.45;
            present.set_wallpaper_overlay_alpha(overlay_alpha);
            match wall_css {
                Some(rect) => {
                    let (rw, rh) = (
                        (rect.2 * density).round().max(1.0),
                        (rect.3 * density).round().max(1.0),
                    );
                    // Re-derive the cover only when the dest rect moved by
                    // more than 10% along either axis; in between the shader
                    // stretches the cached cover into the new rect (a photo
                    // tolerates it, and a resize drag changes the rect every
                    // produce — a full re-decode per tick would dominate the
                    // frame).
                    let stale = match &self.wallpaper_cache {
                        Some((w, h, _)) => {
                            let (w, h) = (*w as f32, *h as f32);
                            (w - rw).abs() > w * 0.1 || (h - rh).abs() > h * 0.1
                        }
                        None => true,
                    };
                    let regen = if stale {
                        neotavern_presentation_chat::wallpaper_cover_thumbnail(
                            bytes, rw as u32, rh as u32,
                        )
                    } else {
                        None
                    };
                    if let Some(thumb) = regen {
                        self.wallpaper_cache = Some((rw as u32, rh as u32, thumb));
                        self.wallpaper_epoch += 1;
                    }
                    if let Some((_, _, thumb)) = &self.wallpaper_cache {
                        present.upload_wallpaper(self.wallpaper_epoch, thumb);
                        present.set_wallpaper_rect(Some([
                            (rect.0 * density).round(),
                            (rect.1 * density).round(),
                            rw,
                            rh,
                        ]));
                    }
                }
                None => present.set_wallpaper_rect(None),
            }
        }
        // Avatars ride the scene as `<img src="asset:{id}">` rasters (image
        // audit, stage B): the paint walk z-orders them with clips and modal
        // layers, so no post-frame composite exists. NEOTA_INSCENE_IMAGES=0
        // restores the Stage A GPU overlay for a device where the Vello
        // image atlas regresses.
        let avatar_count = if neotavern_presentation_m0_d2::inscene_images_enabled() {
            sess.paint_layout().avatars.len()
        } else {
            let avatar_paints = image_paints_from_layout(
                sess.paint_layout(),
                density.max(1.0),
                self.session.avatar_ready_token(),
            );
            for (asset_id, thumb) in self.session.avatar_thumbs() {
                present.upload_avatar(asset_id, thumb);
            }
            present.composite_avatars(&avatar_paints);
            avatar_paints.len()
        };
        // Message row boxes for inline action hit-testing (copy). The rows are
        // in-flow inside the chat viewport, so their layout rects are the
        // window CSS-px positions the pointer pipeline uses.
        self.message_rects = sess.paint_layout().messages.clone();
        // Layout-derived hit rects: the single geometry source for taps and
        // text-field focus (same skeleton the `--dom-dump` writes).
        self.hit_rects = HitRects::from_skeleton(&skeleton);
        let total = t0.elapsed();
        let layout_ms = t_layout.duration_since(t0).as_millis();
        let open_ms = t_paint.duration_since(t_open).as_millis();
        let paint_ms = t_render.duration_since(t_paint).as_millis();
        let render_ms = t_post.duration_since(t_render).as_millis();
        let post_ms = total.as_millis() - layout_ms - open_ms - paint_ms - render_ms;
        eprintln!(
            "[neocompositor-desktop] produced cmds={} ops={} paths={} glass={} backend={} kernel_messages={} characters={} avatars={} [layout {}ms open {}ms paint {}ms render {}ms post {}ms total {}ms]",
            produced.report.paint_commands,
            list_ops,
            scene_paths,
            produced.report.glass_hooks,
            present.backend,
            self.session.kernel_message_count(),
            character_count,
            avatar_count,
            layout_ms,
            open_ms,
            paint_ms,
            render_ms,
            post_ms,
            total.as_millis(),
        );
        if let Some(path) = self.snapshot_path.take() {
            match present.snapshot(&path) {
                Ok(()) => eprintln!("[neocompositor-desktop] snapshot WROTE {path}"),
                Err(err) => eprintln!("[neocompositor-desktop] snapshot failed: {err}"),
            }
        }
        if let Some(path) = self.dom_dump_path.take() {
            let count = skeleton.nodes.len();
            match write_slot_skeleton(&path, &skeleton) {
                Ok(()) => {
                    eprintln!("[neocompositor-desktop] dom-dump WROTE {path} ({count} nodes)")
                }
                Err(err) => eprintln!("[neocompositor-desktop] dom-dump failed: {err}"),
            }
        }
        // After a produce the raster is baked at the session offset: the
        // ack-loop lands on the produced window (the blit shift reads against
        // it). While no scroll animation is mid-flight the visual follows the
        // bake; mid-animation the visual keeps leading (landing will sync it
        // back).
        self.ack.land(self.session.scroll_offset_css());
        if !self.scroll_animation_active() {
            self.visual_scroll_css = self.session.scroll_offset_css();
        }
        self.dirty = false;
    }

    /// CSS coordinates for a physical window position.
    fn css_point(&self, physical_x: f64, physical_y: f64) -> (f32, f32) {
        let d = self.density.max(1.0);
        ((physical_x as f32) / d, (physical_y as f32) / d)
    }

    fn ensure_viewport(&mut self) {
        self.session
            .set_surface_size(self.size.0.max(1), self.size.1, self.density);
    }

    /// Down: capture native controls via `hit_test`, exactly like the Android
    /// `try_push(Down)`. Over the chat canvas (`None`) we capture nothing вЂ”
    /// wheel/drag handles that area.
    fn pointer_down(&mut self, css_x: f32, css_y: f32) {
        // A grab lands any running scroll animation BEFORE capture: the
        // sync-back produce refreshes hit rects so they match the shifted
        // screen exactly (one ~30 ms produce per grab, not per scroll frame).
        if self.scroll_animation_active()
            || self.ack.drift(self.visual_scroll_css).abs() > f32::EPSILON
        {
            self.smooth_scroll = None;
            self.glide_velocity = 0.0;
            self.land_now();
            self.produce_and_render();
        }
        self.ensure_viewport();
        self.pending_message_action = None;
        self.pending_quick = None;
        self.panel_drag = None;
        let rects = self.hit_rects.clone();
        let view = self.session.shell_view();
        if self.near_panel_resize(css_x) {
            self.panel_drag = Some(PanelDrag {
                start_x: css_x,
                start_width: self.session.panel_width(),
            });
            self.pending_ui = None;
            self.focus = TextFocus::None;
            return;
        }
        self.pending_ui = hit_test(&view, css_x, css_y).map(|hit| PendingUi { css_x, css_y, hit });
        // Layout-derived controls (HitRects): composer chrome + inline message
        // actions. The decision table is shared with the Android host
        // (`hit_rects::resolve_tap`) вЂ” geometry from the same Blitz/Taffy pass
        // that painted the frame, no hand-measured bands.
        match rects.resolve_tap(css_x, css_y) {
            TapIntent::Quick(quick) => {
                let quick = match quick {
                    QuickIntent::Send => QuickAction::Send,
                    QuickIntent::Stop => QuickAction::Stop,
                    QuickIntent::ComposerSettings => QuickAction::ComposerSettings,
                    QuickIntent::ComposerReset => QuickAction::ComposerReset,
                    QuickIntent::ComposerContext => QuickAction::ComposerContext,
                    QuickIntent::ScrollLatest => QuickAction::ScrollLatest,
                    QuickIntent::HeaderSearch => QuickAction::HeaderSearch,
                    QuickIntent::BackToParentChat => QuickAction::BackToParentChat,
                };
                self.pending_quick = Some((quick, css_x, css_y));
            }
            TapIntent::MessageAction { kind, row_id } => {
                self.pending_message_action = Some(PendingMessageAction {
                    css_x,
                    css_y,
                    kind,
                    row_id,
                });
            }
            // Declarative custom intents have no authority: the honest
            // default is the session trace toast (a future registry attaches
            // real handlers without touching this call site).
            TapIntent::Custom { name } => {
                if name == "custom.chat.snapshots-menu" {
                    eprintln!("[neocompositor-desktop] snapshots menu toggled");
                    self.session.toggle_snapshots_menu();
                } else {
                    eprintln!("[neocompositor-desktop] custom intent tapped: {name}");
                    self.session.custom_intent(&name);
                }
            }
            TapIntent::None => {}
        }
        // Bin-local keyboard focus вЂ” targets resolved from the same snapshot.
        let mut focus = TextFocus::None;
        if view.card_import_dialog_open {
            if rects.covers(css_x, css_y, "part:card-path-input") {
                focus = TextFocus::CardPath;
            }
        } else if view.prompt_template_import_open {
            if rects.covers(css_x, css_y, "part:prompt-template-path-input") {
                focus = TextFocus::PromptTemplatePath;
            }
        } else if view.generation_preset_import_open {
            if rects.covers(css_x, css_y, "part:generation-preset-path-input") {
                focus = TextFocus::PresetImportPath;
            }
        } else if view.create_dialog_open {
            if rects.covers(css_x, css_y, "part:create-name") {
                focus = TextFocus::CreateName;
            }
        } else if view.prompt_block_edit_open {
            if rects.covers(css_x, css_y, "part:prompt-block-name-input") {
                focus = TextFocus::PromptBlockName;
            } else if rects.covers(css_x, css_y, "part:prompt-block-depth-input") {
                focus = TextFocus::PromptBlockDepth;
            } else if rects.covers(css_x, css_y, "part:prompt-block-order-input") {
                focus = TextFocus::PromptBlockOrder;
            } else if rects.covers(css_x, css_y, "part:prompt-block-content-input") {
                focus = TextFocus::PromptBlockContent;
            } else if rects.covers(css_x, css_y, "part:prompt-block-model-input")
                && view.selected_provider_id.is_some()
            {
                focus = TextFocus::PromptBlockModel;
            }
        } else if rects.covers(css_x, css_y, "slot:chat.composer")
            || rects.covers(css_x, css_y, "component:textarea")
        {
            focus = TextFocus::Composer;
        } else if rects.covers(css_x, css_y, "component:text-field+part:search") {
            focus = TextFocus::CharacterSearch;
        } else if rects.covers(css_x, css_y, "part:chat-search") {
            focus = TextFocus::ChatSearch;
        } else if rects.covers(css_x, css_y, "part:profile-create-name") {
            focus = TextFocus::ProfileCreateName;
        } else if rects.covers(css_x, css_y, "part:profile-rename-input") {
            focus = TextFocus::ProfileRename;
        } else if rects.covers(css_x, css_y, "part:chat-rename-input") {
            focus = TextFocus::ChatRename;
        } else if rects.covers(css_x, css_y, "part:memory-content-input") {
            focus = TextFocus::MemoryContent;
        } else if rects.covers(css_x, css_y, "part:memory-keys-input") {
            focus = TextFocus::MemoryKeys;
        } else if rects.covers(css_x, css_y, "part:preset-name-input") {
            focus = TextFocus::PresetName;
        } else if rects.covers(css_x, css_y, "part:provider-name-input") {
            focus = TextFocus::ProviderName;
        } else if rects.covers(css_x, css_y, "part:message-edit-input") {
            focus = TextFocus::MessageEdit;
        } else if rects.covers(css_x, css_y, "part:lorebook-name-input") {
            focus = TextFocus::LorebookName;
        } else if rects.covers(css_x, css_y, "part:lorebook-description-input") {
            focus = TextFocus::LorebookDescription;
        } else if rects.covers(css_x, css_y, "part:persona-name-input") {
            focus = TextFocus::PersonaName;
        } else if rects.covers(css_x, css_y, "part:persona-description-input") {
            focus = TextFocus::PersonaDescription;
        } else if rects.covers(css_x, css_y, "part:profile-import-path") {
            focus = TextFocus::ProfileImportPath;
        } else if rects.covers(css_x, css_y, "part:header-search-input") {
            focus = TextFocus::HeaderSearch;
        } else if rects.covers(css_x, css_y, "part:instruct-system-input") {
            focus = TextFocus::InstructSystem;
        } else if rects.covers(css_x, css_y, "part:instruct-user-input") {
            focus = TextFocus::InstructUser;
        } else if rects.covers(css_x, css_y, "part:instruct-assistant-input") {
            focus = TextFocus::InstructAssistant;
        } else if rects.covers(css_x, css_y, "part:instruct-tool-input") {
            focus = TextFocus::InstructTool;
        } else if rects.covers(css_x, css_y, "part:instruct-suffix-input") {
            focus = TextFocus::InstructSuffix;
        } else if rects.covers(css_x, css_y, "part:instruct-stops-input") {
            focus = TextFocus::InstructStops;
        } else if rects.covers(css_x, css_y, "part:character-name-input") {
            focus = TextFocus::CharacterName;
        } else if rects.covers(css_x, css_y, "part:character-description-input") {
            focus = TextFocus::CharacterDescription;
        } else if rects.covers(css_x, css_y, "part:character-tag-input") {
            focus = TextFocus::CharacterTag;
        } else if rects.covers(css_x, css_y, "part:character-first-message-input") {
            focus = TextFocus::CharacterFirstMessage;
        } else if rects.covers(css_x, css_y, "part:character-creator-notes-input") {
            focus = TextFocus::CharacterCreatorNotes;
        } else if let Some(rect) = rects.top_matching(css_x, css_y, "part:character-greeting-input")
        {
            if let Some(idx) = rect.key.as_deref().and_then(|k| k.parse::<usize>().ok()) {
                focus = TextFocus::CharacterGreeting(idx);
            }
        } else if rects.covers(css_x, css_y, "part:preset-value-input") {
            focus = TextFocus::PresetSampler;
        }
        self.focus = focus;
    }

    fn near_panel_resize(&self, css_x: f32) -> bool {
        let view = self.session.shell_view();
        if !view.sidebar_open || view.chat.viewport_width <= 600 {
            return false;
        }
        let edge = RAIL_WIDTH + self.session.panel_width();
        (css_x - edge).abs() <= 6.0
    }

    /// Send the composer draft (durable message via `chats.messages.create`).
    fn send_composer(&mut self) {
        eprintln!("[neocompositor-desktop] composer send tapped");
        match self.session.send(None) {
            Ok(()) => {}
            Err(err) => eprintln!("[neocompositor-desktop] send error: {err}"),
        }
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }

    /// Inline message actions (copy/delete) resolve through the hit-rect
    /// snapshot in `pointer_down`; the row id arrives via the button's
    /// `data-message-id` (`SlotNode.key`), so no pixel offsets exist here.

    /// Copy a message to the OS clipboard (client-side React action) and
    /// surface the honest "copied" toast afterwards. The shared
    /// `PresentSurface` stays OS-neutral: the clipboard is a host capability.
    fn copy_message(&mut self, row_id: String) {
        let Some(text) = self.session.message_text(&row_id) else {
            return;
        };
        let chars = text.chars().count();
        match arboard::Clipboard::new().and_then(|mut cb| cb.set_text(text)) {
            Ok(()) => {
                eprintln!(
                    "[neocompositor-desktop] message {row_id} copied ({chars} chars) to clipboard"
                );
                self.session.copied_message(&row_id);
                self.dirty = true;
                self.window.as_ref().map(|w| w.request_redraw());
            }
            Err(err) => eprintln!("[neocompositor-desktop] clipboard write failed: {err}"),
        }
    }

    /// Delete a message through `chats.messages.delete` (durable wire op) and
    /// surface the toast. Mirrors the React builtin delete action.
    fn delete_message(&mut self, row_id: String) {
        eprintln!("[neocompositor-desktop] message delete tapped: {row_id}");
        self.session.delete_message(&row_id);
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }

    /// `chats.snapshots.rollback` (React builtin): remove everything after
    /// the tapped message; the message itself stays.
    fn rollback_message(&mut self, row_id: String) {
        eprintln!("[neocompositor-desktop] rollback tapped: {row_id}");
        self.session.rollback_to_message(&row_id);
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }

    /// Move: a drag beyond the slop cancels the tap (Android 16 CSS-px rule).
    fn pointer_move(&mut self, css_x: f32, css_y: f32) {
        if let Some(drag) = self.panel_drag.as_ref() {
            let target = drag.start_width + (css_x - drag.start_x);
            // One produce = full vdom mount + Blitz layout + vello raster of
            // the whole window (~30ms warm on the reference PC). Applying the
            // raw pointer delta would re-run it per event batch; quantizing
            // the live width keeps the divider tracking without falling
            // behind, and `pointer_up` snaps to the exact target.
            const PANEL_DRAG_QUANT_CSS: f32 = 6.0;
            if (target - self.session.panel_width()).abs() >= PANEL_DRAG_QUANT_CSS {
                self.session.set_panel_width(target);
                self.dirty = true;
                self.window.as_ref().map(|w| w.request_redraw());
            }
            return;
        }
        if let Some(pending) = self.pending_ui.as_mut() {
            if (css_x - pending.css_x).abs() > TOUCH_SLOP_CSS
                || (css_y - pending.css_y).abs() > TOUCH_SLOP_CSS
            {
                self.pending_ui = None;
            }
        }
        if let Some(pending) = self.pending_message_action.as_mut() {
            if (css_x - pending.css_x).abs() > TOUCH_SLOP_CSS
                || (css_y - pending.css_y).abs() > TOUCH_SLOP_CSS
            {
                self.pending_message_action = None;
            }
        }
        if let Some((_, px, py)) = self.pending_quick.as_ref() {
            if (css_x - px).abs() > TOUCH_SLOP_CSS || (css_y - py).abs() > TOUCH_SLOP_CSS {
                self.pending_quick = None;
            }
        }
        if let Some(window) = self.window.as_ref() {
            let icon = if self.near_panel_resize(css_x) {
                winit::window::CursorIcon::ColResize
            } else {
                winit::window::CursorIcon::Default
            };
            // Win32 `SetCursor` per pixel of travel adds visible input lag on
            // the resize edge; only cross the boundary when it changes.
            if self.cursor_icon != Some(icon) {
                window.set_cursor(icon);
                self.cursor_icon = Some(icon);
            }
        }
        let _ = css_y;
    }

    /// Up: dispatch the layout-resolved quick action (composer controls), then
    /// inline message actions, then the captured shell hit вЂ” all within slop.
    fn pointer_up(&mut self, css_x: f32, css_y: f32) {
        if let Some(drag) = self.panel_drag.take() {
            // Snap the exact pointer width so quantized live steps never
            // leave the panel off by up to one quantum.
            let target = drag.start_width + (css_x - drag.start_x);
            self.session.set_panel_width(target);
            self.dirty = true;
            self.window.as_ref().map(|w| w.request_redraw());
            eprintln!(
                "[neocompositor-desktop] panel width -> {}",
                self.session.panel_width()
            );
            return;
        }
        if let Some((quick, px, py)) = self.pending_quick.take() {
            if (css_x - px).abs() <= TOUCH_SLOP_CSS && (css_y - py).abs() <= TOUCH_SLOP_CSS {
                match quick {
                    QuickAction::Send => {
                        self.pending_ui = None;
                        self.send_composer();
                    }
                    QuickAction::Stop => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] composer stop tapped");
                        let _ = self.session.cancel_generation();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::ComposerSettings => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] tap -> composer Settings");
                        self.session
                            .apply_shell_action(ShellAction::SetPanel("settings".into()));
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::ComposerReset => {
                        self.pending_ui = None;
                        let _ = self.session.set_composer_text(String::new());
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::ComposerContext => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] tap -> composer context meter");
                        self.session.toggle_context_panel();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::ScrollLatest => {
                        // Saturate the virtualized window at the newest rows.
                        // The jump happens outside the animation, so the
                        // visual follows the baked offset (no stale shift).
                        self.pending_ui = None;
                        self.session.scroll_chat_by(1.0e6);
                        self.visual_scroll_css = self.session.scroll_offset_css();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::HeaderSearch => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] header search toggled");
                        self.session.toggle_header_search();
                        self.focus = if self.session.view().header_search_open {
                            TextFocus::HeaderSearch
                        } else {
                            TextFocus::None
                        };
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::BackToParentChat => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] back to parent chat tapped");
                        self.session.open_parent_chat();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                }
                return;
            }
        }
        if let Some(pending) = self.pending_message_action.take() {
            if (css_x - pending.css_x).abs() <= TOUCH_SLOP_CSS
                && (css_y - pending.css_y).abs() <= TOUCH_SLOP_CSS
            {
                match pending.kind {
                    neotavern_presentation_chat::MessageActionKind::Copy => {
                        self.copy_message(pending.row_id)
                    }
                    neotavern_presentation_chat::MessageActionKind::Delete => {
                        self.delete_message(pending.row_id)
                    }
                    neotavern_presentation_chat::MessageActionKind::Rollback => {
                        self.rollback_message(pending.row_id)
                    }
                    neotavern_presentation_chat::MessageActionKind::Regenerate => {
                        eprintln!(
                            "[neocompositor-desktop] regenerate tapped: {}",
                            pending.row_id
                        );
                        self.session.regenerate_message(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::SwipePrevious => {
                        eprintln!("[neocompositor-desktop] swipe-previous tapped");
                        self.session.swipe_variant(&pending.row_id, -1);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::SwipeNext => {
                        eprintln!("[neocompositor-desktop] swipe-next tapped");
                        self.session.swipe_variant(&pending.row_id, 1);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::SwipePicker => {
                        eprintln!(
                            "[neocompositor-desktop] swipe-picker tapped: {}",
                            pending.row_id
                        );
                        self.session.open_variant_picker(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::SwipePickerClose => {
                        eprintln!("[neocompositor-desktop] swipe-picker-close tapped");
                        self.session.close_variant_picker();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::Edit => {
                        eprintln!("[neocompositor-desktop] edit tapped: {}", pending.row_id);
                        if self.session.view().details_message_id.as_deref()
                            == Some(&pending.row_id)
                        {
                            self.session.set_message_details_mode("edit");
                        } else {
                            self.session.start_message_edit(&pending.row_id);
                        }
                        self.focus = TextFocus::MessageEdit;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::EditSave => {
                        eprintln!("[neocompositor-desktop] edit save tapped");
                        self.session.submit_message_edit();
                        self.focus = TextFocus::None;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::EditCancel => {
                        eprintln!("[neocompositor-desktop] edit cancel tapped");
                        self.session.cancel_message_edit();
                        self.focus = TextFocus::None;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::History => {
                        eprintln!("[neocompositor-desktop] history tapped: {}", pending.row_id);
                        self.session.open_message_history(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::HistoryClose => {
                        eprintln!("[neocompositor-desktop] history close tapped");
                        self.session.close_message_history();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::Checkpoint => {
                        eprintln!(
                            "[neocompositor-desktop] checkpoint tapped: {}",
                            pending.row_id
                        );
                        self.session.create_message_snapshot(&pending.row_id, true);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::Branch => {
                        eprintln!("[neocompositor-desktop] branch tapped: {}", pending.row_id);
                        self.session.create_message_snapshot(&pending.row_id, false);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::Context => {
                        eprintln!("[neocompositor-desktop] context tapped: {}", pending.row_id);
                        self.session.toggle_message_context(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::Prompt => {
                        eprintln!("[neocompositor-desktop] prompt tapped: {}", pending.row_id);
                        self.session.open_prompt_plan_for_message(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::Steps => {
                        eprintln!("[neocompositor-desktop] steps tapped: {}", pending.row_id);
                        self.session
                            .open_run_transcript_for_message(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::DeleteCheckpoint => {
                        eprintln!(
                            "[neocompositor-desktop] delete-checkpoint tapped: {}",
                            pending.row_id
                        );
                        self.session.open_checkpoint_delete(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::Details => {
                        eprintln!("[neocompositor-desktop] details tapped: {}", pending.row_id);
                        self.session.open_message_details(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::DetailsClose => {
                        eprintln!("[neocompositor-desktop] details-close tapped");
                        self.session.close_message_details();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::DetailsModeActions => {
                        eprintln!("[neocompositor-desktop] details-mode-actions tapped");
                        self.session.set_message_details_mode("actions");
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::DetailsModeDetails => {
                        eprintln!("[neocompositor-desktop] details-mode-details tapped");
                        self.session.set_message_details_mode("details");
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::DetailsModeEdit => {
                        eprintln!("[neocompositor-desktop] details-mode-edit tapped");
                        self.session.set_message_details_mode("edit");
                        self.focus = TextFocus::MessageEdit;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    neotavern_presentation_chat::MessageActionKind::DetailsSaveEdit => {
                        eprintln!("[neocompositor-desktop] details-save-edit tapped");
                        self.session.submit_message_details_edit();
                        self.focus = TextFocus::None;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                }
                return;
            }
        }
        let Some(pending) = self.pending_ui.take() else {
            return;
        };
        if (css_x - pending.css_x).abs() > TOUCH_SLOP_CSS
            || (css_y - pending.css_y).abs() > TOUCH_SLOP_CSS
        {
            return;
        }
        if let ShellHit::Action(action) = pending.hit {
            eprintln!("[neocompositor-desktop] tap -> {action:?}");
            self.session.apply_shell_action(action);
            // Host-side file sink for parked exports (`chats.export`,
            // `characters.export.card`, prompt-template JSON). React
            // downloads to the browser; the desktop host writes under
            // exports/, overridable via NEOTA_EXPORT_DIR.
            if let Some(export) = self.session.take_last_export() {
                match write_export_file(&export) {
                    Ok(path) => {
                        eprintln!("[neocompositor-desktop] export written: {path}");
                        self.session.note_export_path(&path);
                    }
                    Err(err) => {
                        eprintln!("[neocompositor-desktop] export write failed: {err}");
                    }
                }
                self.dirty = true;
            }
            self.dirty = true;
            self.window.as_ref().map(|w| w.request_redraw());
        }
    }

    /// Monotonic nanoseconds for the scroll animation timelines. The
    /// deterministic probe clock takes precedence while scripted ops run so
    /// `--tick` sequences land on exact sample times.
    fn monotonic_ns(&self) -> u64 {
        self.probe_clock_ns
            .unwrap_or_else(|| self.clock_base.elapsed().as_nanos() as u64)
    }

    /// Advances the scroll animations in the VISUAL offset only: the frozen
    /// raster stays baked at the session offset and the difference presents
    /// as a blit shift, so animation frames skip the ~30 ms re-produce.
    /// Returns `true` when an animation just finished — `frame` then lands
    /// the visual into the session (sync-back).
    fn advance_scroll_animations(&mut self) -> bool {
        let was_active = self.scroll_animation_active();
        let now = self.monotonic_ns();
        if let Some(anim) = self.smooth_scroll.take() {
            match anim.sample(now) {
                Some(offset) => {
                    self.visual_scroll_css = offset.max(0.0);
                    self.smooth_scroll = Some(anim);
                }
                None => {
                    // The eased sample never returns the endpoint itself;
                    // the visual ends exactly on the target.
                    self.visual_scroll_css = anim.target().max(0.0);
                }
            }
        }
        // Touch fling: same glide constants as the Android vsync loop. The
        // step dt is measured in the active clock domain (probe clock for
        // scripted runs, wall time live), so decay and travel stay consistent.
        if neotavern_presentation_chat::scroll_dynamics::glide_active(self.glide_velocity) {
            const FLING_FRAME_NS: u64 = 8_333_333;
            let now = self.monotonic_ns();
            // Clamp one step to 250 ms: a stalled window (occlusion, system
            // load) must not teleport the fling across the chat. Android gets
            // this for free from its fixed vsync tick.
            let dt = now
                .saturating_sub(
                    self.last_glide_tick_ns
                        .unwrap_or(now.saturating_sub(FLING_FRAME_NS)),
                )
                .clamp(1, 250_000_000);
            self.last_glide_tick_ns = Some(now);
            self.visual_scroll_css += (self.glide_velocity * (dt as f64 / 1e9)) as f32;
            self.visual_scroll_css = self.visual_scroll_css.max(0.0);
            self.glide_velocity =
                neotavern_presentation_chat::scroll_dynamics::glide_decay(self.glide_velocity, dt);
        } else {
            self.last_glide_tick_ns = None;
        }
        let finished = was_active && !self.scroll_animation_active();
        finished
    }

    fn scroll_animation_active(&self) -> bool {
        self.smooth_scroll.is_some()
            || neotavern_presentation_chat::scroll_dynamics::glide_active(self.glide_velocity)
            || self.touch.as_ref().is_some_and(|contact| contact.dragging)
    }

    /// Sync-back: lands the visual offset into the session with ONE clamped
    /// `scroll_chat_by`, so the next produce bakes exactly what the screen
    /// shows and the blit shift returns to zero. The ack-loop lands on the
    /// produced window (produce is synchronous here — no in-flight state).
    fn land_scroll(&mut self, shift: f32) {
        if shift != 0.0 {
            self.session.scroll_chat_by(shift);
            self.ack.land(self.session.scroll_offset_css());
            self.visual_scroll_css = self.session.scroll_offset_css();
            self.dirty = true;
        }
    }

    /// Land unconditionally (drag release, grab): sync the session to the
    /// visual regardless of how large the drift is.
    fn land_now(&mut self) {
        let shift = self.ack.drift(self.visual_scroll_css);
        self.land_scroll(shift);
    }

    /// Wheel over the chat viewport scrolls it; `dy` is in CSS px (negative =
    /// scroll up / older messages). Notches land on a ~120 ms ease-out curve
    /// over the blit shift (no re-produce per frame); chaining notches
    /// mid-flight retargets.
    fn wheel(&mut self, css_dy: f32) {
        if css_dy == 0.0 || self.present.is_none() {
            return;
        }
        self.glide_velocity = 0.0;
        let now = self.monotonic_ns();
        match self.smooth_scroll.as_mut() {
            Some(anim) if anim.sample(now).is_some() => anim.retarget(css_dy, now),
            _ => {
                self.smooth_scroll =
                    Some(SmoothScroll::impulse(self.visual_scroll_css, css_dy, now));
            }
        }
        self.window.as_ref().map(|w| w.request_redraw());
    }

    /// Touch input: tap-through when a control captured the contact, drag
    /// scroll over the chat canvas (1 : 1 while dragging), fling on release.
    /// Single pointer; the digitizer's synthesized mouse events for the same
    /// contact are ignored while it is active.
    fn touch_input(
        &mut self,
        pointer_id: u64,
        phase: winit::event::TouchPhase,
        css_x: f32,
        css_y: f32,
    ) {
        use winit::event::TouchPhase;
        match phase {
            TouchPhase::Started => {
                let now = self.monotonic_ns();
                // Route the contact through the same `Down` capture as a
                // mouse press (controls, slop rules) so taps stay identical.
                self.pointer_down(css_x, css_y);
                let captured = self.pending_ui.is_some()
                    || self.pending_message_action.is_some()
                    || self.pending_quick.is_some()
                    || self.panel_drag.is_some();
                self.touch = Some(TouchContact {
                    pointer_id,
                    anchor_y: css_y,
                    last_y: css_y,
                    last_t_ns: now,
                    velocity: 0.0,
                    dragging: false,
                    captured,
                });
                if !captured {
                    // Canvas contact: drag-scroll candidate. Cancel any live
                    // smooth scroll so the finger takes over 1 : 1.
                    self.smooth_scroll = None;
                    self.glide_velocity = 0.0;
                }
            }
            TouchPhase::Moved => {
                let now = self.monotonic_ns();
                if let Some(contact) = self.touch.as_mut() {
                    if contact.pointer_id != pointer_id {
                        return;
                    }
                    if contact.captured {
                        // The control's own slop check runs at release
                        // (`pointer_up`), like the Android pending-tap rule.
                        return;
                    }
                    if !contact.dragging {
                        if (css_y - contact.anchor_y).abs() > TOUCH_SLOP_CSS {
                            contact.dragging = true;
                        } else {
                            return;
                        }
                    }
                    let dt_ns = now.saturating_sub(contact.last_t_ns).max(1);
                    let dy = contact.last_y - css_y;
                    contact.velocity = f64::from(dy) / (dt_ns as f64 / 1e9);
                    contact.last_y = css_y;
                    contact.last_t_ns = now;
                    // Visual-only: the frozen raster presents the drag as a
                    // blit shift; the session lands on release.
                    self.visual_scroll_css = (self.visual_scroll_css + dy).max(0.0);
                    self.window.as_ref().map(|w| w.request_redraw());
                }
            }
            TouchPhase::Ended => {
                if let Some(contact) = self.touch.take() {
                    if contact.pointer_id != pointer_id {
                        self.touch = Some(contact);
                        return;
                    }
                    if contact.captured || !contact.dragging {
                        // Tap (or a captured contact whose slop check runs
                        // inside `pointer_up`): the same dispatch as a mouse
                        // click.
                        self.pointer_up(css_x, css_y);
                    } else {
                        // Release starts the shared glide decay (Android
                        // fling constants); slow drags land immediately.
                        if neotavern_presentation_chat::scroll_dynamics::glide_active(
                            contact.velocity,
                        ) {
                            self.glide_velocity = contact.velocity;
                        } else {
                            self.land_now();
                        }
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                }
            }
            TouchPhase::Cancelled => {
                self.touch = None;
                self.glide_velocity = 0.0;
                // The gesture died mid-flight: keep what the screen shows by
                // landing the visual into the session.
                self.land_now();
            }
        }
    }

    fn instruct_field_text(&self, role: &str) -> String {
        let shell = self.session.shell_view();
        match role {
            "system" => shell.instruct_system,
            "user" => shell.instruct_user,
            "assistant" => shell.instruct_assistant,
            "tool" => shell.instruct_tool,
            "promptSuffix" => shell.instruct_prompt_suffix,
            "stopStrings" => shell.instruct_stop_strings,
            _ => String::new(),
        }
    }

    /// Type one character into the focused text field (keyboard or `--type`).
    fn type_char(&mut self, ch: char) {
        match self.focus {
            TextFocus::Composer => {
                let current = self.session.view().composer_text;
                let next = format!("{current}{ch}");
                self.session
                    .set_composer_text(next.clone())
                    .unwrap_or_else(|err| eprintln!("[neocompositor-desktop] composer: {err}"));
                eprintln!("[neocompositor-desktop] typed '{ch}' -> composer=\"{next}\"");
            }
            TextFocus::CharacterSearch => {
                let current = self.session.shell_view().search;
                let next = format!("{current}{ch}");
                self.session.set_character_search(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> search=\"{next}\"");
            }
            TextFocus::ChatSearch => {
                let current = self.session.shell_view().chat_search;
                let next = format!("{current}{ch}");
                self.session.set_chat_search(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> chat_search=\"{next}\"");
            }
            TextFocus::CreateName => {
                let current = self.session.shell_view().create_name;
                let next = format!("{current}{ch}");
                self.session.set_create_name(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> create_name=\"{next}\"");
            }
            TextFocus::ProfileCreateName => {
                let current = self.session.shell_view().profile_create_name;
                let next = format!("{current}{ch}");
                self.session.set_profile_create_name(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> profile_create_name=\"{next}\"");
            }
            TextFocus::ProfileRename => {
                let current = self.session.shell_view().profile_rename_name;
                let next = format!("{current}{ch}");
                self.session.set_profile_rename_name(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> profile_rename_name=\"{next}\"");
            }
            TextFocus::ChatRename => {
                let current = self.session.shell_view().chat_rename_draft;
                let next = format!("{current}{ch}");
                self.session.set_chat_rename_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> chat_rename=\"{next}\"");
            }
            TextFocus::MemoryContent => {
                let current = self.session.shell_view().memory_draft_content.clone();
                let next = format!("{current}{ch}");
                self.session.set_memory_draft_content(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> memory_content=\"{next}\"");
            }
            TextFocus::MemoryKeys => {
                let current = self.session.shell_view().memory_draft_keys.clone();
                let next = format!("{current}{ch}");
                self.session.set_memory_draft_keys(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> memory_keys=\"{next}\"");
            }
            TextFocus::PresetName => {
                let current = self.session.shell_view().preset_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_preset_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> preset_name=\"{next}\"");
            }
            TextFocus::ProviderName => {
                let current = self.session.shell_view().provider_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_provider_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> provider_name=\"{next}\"");
            }
            TextFocus::MessageEdit => {
                let current = self.session.view().editing_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_message_edit_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> edit_draft=\"{next}\"");
            }
            TextFocus::LorebookName => {
                let current = self.session.shell_view().lorebook_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_lorebook_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> lorebook_name=\"{next}\"");
            }
            TextFocus::LorebookDescription => {
                let current = self.session.shell_view().lorebook_description_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_lorebook_description_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> lorebook_desc+{ch}");
            }
            TextFocus::PersonaName => {
                let current = self.session.shell_view().persona_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_persona_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> persona_name=\"{next}\"");
            }
            TextFocus::PersonaDescription => {
                let current = self.session.shell_view().persona_description_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_persona_description_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> persona_desc+{ch}");
            }
            TextFocus::CardPath => {
                let current = self.session.shell_view().card_path_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_card_path_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> card_path+{ch}");
            }
            TextFocus::PromptTemplatePath => {
                let current = self.session.shell_view().prompt_template_path_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_template_path_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_template_path+{ch}");
            }
            TextFocus::PresetImportPath => {
                let current = self
                    .session
                    .shell_view()
                    .generation_preset_path_draft
                    .clone();
                let next = format!("{current}{ch}");
                self.session.set_generation_preset_path_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> generation_preset_path+{ch}");
            }
            TextFocus::ProfileImportPath => {
                let current = self.session.shell_view().profile_import_path.clone();
                let next = format!("{current}{ch}");
                self.session.set_profile_import_path(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> import_path+{ch}");
            }
            TextFocus::HeaderSearch => {
                let current = self.session.view().header_search_query;
                let next = format!("{current}{ch}");
                self.session.set_header_search_query(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> header_search=\"{next}\"");
            }
            TextFocus::InstructSystem
            | TextFocus::InstructUser
            | TextFocus::InstructAssistant
            | TextFocus::InstructTool
            | TextFocus::InstructSuffix
            | TextFocus::InstructStops => {
                let role = instruct_focus_role(self.focus).expect("instruct focus");
                let current = self.instruct_field_text(role);
                let next = format!("{current}{ch}");
                self.session.set_instruct_role(role, &next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> instruct.{role}");
            }
            TextFocus::PromptBlockName => {
                let current = self.session.shell_view().prompt_block_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_name=\"{next}\"");
            }
            TextFocus::PromptBlockContent => {
                let current = self.session.shell_view().prompt_block_content_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_content_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_content+{ch}");
            }
            TextFocus::PromptBlockDepth => {
                let current = self.session.shell_view().prompt_block_depth_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_depth_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_depth=\"{next}\"");
            }
            TextFocus::PromptBlockOrder => {
                let current = self.session.shell_view().prompt_block_order_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_order_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_order=\"{next}\"");
            }
            TextFocus::PromptBlockModel => {
                let current = self.session.shell_view().prompt_block_model_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_model_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_model=\"{next}\"");
            }
            TextFocus::CharacterName => {
                let current = self
                    .session
                    .shell_view()
                    .selected_draft
                    .as_ref()
                    .map(|draft| draft.name.clone())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_character_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> character_name=\"{next}\"");
            }
            TextFocus::CharacterDescription => {
                let current = self
                    .session
                    .shell_view()
                    .selected_draft
                    .as_ref()
                    .map(|draft| draft.description.clone())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_character_description_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> character_desc+{ch}");
            }
            TextFocus::CharacterTag => {
                let current = self.session.shell_view().tag_input.clone();
                let next = format!("{current}{ch}");
                self.session.set_tag_input(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> tag_input=\"{next}\"");
            }
            TextFocus::CharacterFirstMessage => {
                let current = self
                    .session
                    .shell_view()
                    .selected_draft
                    .as_ref()
                    .map(|draft| draft.first_message.clone())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_character_first_message(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> character_first_msg+{ch}");
            }
            TextFocus::CharacterCreatorNotes => {
                let current = self
                    .session
                    .shell_view()
                    .selected_draft
                    .as_ref()
                    .map(|draft| draft.creator_notes.clone())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_character_creator_notes(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> character_creator_notes+{ch}");
            }
            TextFocus::CharacterGreeting(idx) => {
                let current = self
                    .session
                    .shell_view()
                    .selected_draft
                    .as_ref()
                    .and_then(|draft| draft.alternate_greetings.get(idx).cloned())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_alternate_greeting(idx, &next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> greeting[{idx}]+{ch}");
            }
            TextFocus::PresetSampler => {
                let current = preset_sampler_text(&self.session.shell_view());
                let next = format!("{current}{ch}");
                self.session.set_preset_value_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> preset_sampler=\"{next}\"");
            }
            TextFocus::None => return,
        }
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }

    /// Backspace into the focused text field.
    fn backspace(&mut self) {
        let current = match self.focus {
            TextFocus::Composer => self.session.view().composer_text,
            TextFocus::CharacterSearch => self.session.shell_view().search,
            TextFocus::ChatSearch => self.session.shell_view().chat_search,
            TextFocus::CreateName => self.session.shell_view().create_name,
            TextFocus::ProfileCreateName => self.session.shell_view().profile_create_name,
            TextFocus::ProfileRename => self.session.shell_view().profile_rename_name,
            TextFocus::ChatRename => self.session.shell_view().chat_rename_draft,
            TextFocus::MemoryContent => self.session.shell_view().memory_draft_content.clone(),
            TextFocus::MemoryKeys => self.session.shell_view().memory_draft_keys.clone(),
            TextFocus::PresetName => self.session.shell_view().preset_name_draft.clone(),
            TextFocus::ProviderName => self.session.shell_view().provider_name_draft.clone(),
            TextFocus::MessageEdit => self.session.view().editing_draft.clone(),
            TextFocus::LorebookName => self.session.shell_view().lorebook_name_draft.clone(),
            TextFocus::LorebookDescription => {
                self.session.shell_view().lorebook_description_draft.clone()
            }
            TextFocus::PersonaName => self.session.shell_view().persona_name_draft.clone(),
            TextFocus::PersonaDescription => {
                self.session.shell_view().persona_description_draft.clone()
            }
            TextFocus::CardPath => self.session.shell_view().card_path_draft.clone(),
            TextFocus::PromptTemplatePath => {
                self.session.shell_view().prompt_template_path_draft.clone()
            }
            TextFocus::PresetImportPath => self
                .session
                .shell_view()
                .generation_preset_path_draft
                .clone(),
            TextFocus::ProfileImportPath => self.session.shell_view().profile_import_path.clone(),
            TextFocus::HeaderSearch => self.session.view().header_search_query,
            TextFocus::InstructSystem
            | TextFocus::InstructUser
            | TextFocus::InstructAssistant
            | TextFocus::InstructTool
            | TextFocus::InstructSuffix
            | TextFocus::InstructStops => {
                let role = instruct_focus_role(self.focus).expect("instruct focus");
                self.instruct_field_text(role)
            }
            TextFocus::PromptBlockName => self.session.shell_view().prompt_block_name_draft.clone(),
            TextFocus::PromptBlockContent => {
                self.session.shell_view().prompt_block_content_draft.clone()
            }
            TextFocus::PromptBlockDepth => {
                self.session.shell_view().prompt_block_depth_draft.clone()
            }
            TextFocus::PromptBlockOrder => {
                self.session.shell_view().prompt_block_order_draft.clone()
            }
            TextFocus::PromptBlockModel => {
                self.session.shell_view().prompt_block_model_draft.clone()
            }
            TextFocus::CharacterName => self
                .session
                .shell_view()
                .selected_draft
                .as_ref()
                .map(|draft| draft.name.clone())
                .unwrap_or_default(),
            TextFocus::CharacterDescription => self
                .session
                .shell_view()
                .selected_draft
                .as_ref()
                .map(|draft| draft.description.clone())
                .unwrap_or_default(),
            TextFocus::CharacterTag => self.session.shell_view().tag_input.clone(),
            TextFocus::CharacterFirstMessage => self
                .session
                .shell_view()
                .selected_draft
                .as_ref()
                .map(|draft| draft.first_message.clone())
                .unwrap_or_default(),
            TextFocus::CharacterCreatorNotes => self
                .session
                .shell_view()
                .selected_draft
                .as_ref()
                .map(|draft| draft.creator_notes.clone())
                .unwrap_or_default(),
            TextFocus::CharacterGreeting(idx) => self
                .session
                .shell_view()
                .selected_draft
                .as_ref()
                .and_then(|draft| draft.alternate_greetings.get(idx).cloned())
                .unwrap_or_default(),
            TextFocus::PresetSampler => preset_sampler_text(&self.session.shell_view()),
            TextFocus::None => return,
        };
        let next: String = current
            .chars()
            .take(current.chars().count().saturating_sub(1))
            .collect();
        match self.focus {
            TextFocus::Composer => {
                let _ = self.session.set_composer_text(next);
            }
            TextFocus::CharacterSearch => self.session.set_character_search(&next),
            TextFocus::ChatSearch => self.session.set_chat_search(&next),
            TextFocus::CreateName => self.session.set_create_name(&next),
            TextFocus::ProfileCreateName => self.session.set_profile_create_name(&next),
            TextFocus::ProfileRename => self.session.set_profile_rename_name(&next),
            TextFocus::ChatRename => self.session.set_chat_rename_draft(&next),
            TextFocus::MemoryContent => self.session.set_memory_draft_content(&next),
            TextFocus::MemoryKeys => self.session.set_memory_draft_keys(&next),
            TextFocus::PresetName => self.session.set_preset_name_draft(&next),
            TextFocus::ProviderName => self.session.set_provider_name_draft(&next),
            TextFocus::MessageEdit => self.session.set_message_edit_draft(&next),
            TextFocus::LorebookName => self.session.set_lorebook_name_draft(&next),
            TextFocus::LorebookDescription => self.session.set_lorebook_description_draft(&next),
            TextFocus::PersonaName => self.session.set_persona_name_draft(&next),
            TextFocus::PersonaDescription => self.session.set_persona_description_draft(&next),
            TextFocus::CardPath => self.session.set_card_path_draft(&next),
            TextFocus::PromptTemplatePath => self.session.set_prompt_template_path_draft(&next),
            TextFocus::PresetImportPath => self.session.set_generation_preset_path_draft(&next),
            TextFocus::ProfileImportPath => self.session.set_profile_import_path(&next),
            TextFocus::HeaderSearch => self.session.set_header_search_query(&next),
            TextFocus::InstructSystem
            | TextFocus::InstructUser
            | TextFocus::InstructAssistant
            | TextFocus::InstructTool
            | TextFocus::InstructSuffix
            | TextFocus::InstructStops => {
                let role = instruct_focus_role(self.focus).expect("instruct focus");
                self.session.set_instruct_role(role, &next);
            }
            TextFocus::PromptBlockName => self.session.set_prompt_block_name_draft(&next),
            TextFocus::PromptBlockContent => self.session.set_prompt_block_content_draft(&next),
            TextFocus::PromptBlockDepth => self.session.set_prompt_block_depth_draft(&next),
            TextFocus::PromptBlockOrder => self.session.set_prompt_block_order_draft(&next),
            TextFocus::PromptBlockModel => self.session.set_prompt_block_model_draft(&next),
            TextFocus::CharacterName => self.session.set_character_name_draft(&next),
            TextFocus::CharacterDescription => self.session.set_character_description_draft(&next),
            TextFocus::CharacterTag => self.session.set_tag_input(&next),
            TextFocus::CharacterFirstMessage => self.session.set_character_first_message(&next),
            TextFocus::CharacterCreatorNotes => self.session.set_character_creator_notes(&next),
            TextFocus::CharacterGreeting(idx) => self.session.set_alternate_greeting(idx, &next),
            TextFocus::PresetSampler => self.session.set_preset_value_draft(&next),
            TextFocus::None => {}
        }
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }

    fn frame(&mut self) {
        if self.present.is_none() {
            return;
        }
        if std::env::var("NEOTA_DEBUG_PEEK").is_ok() {
            let inner = self
                .window
                .as_ref()
                .map(|w| format!("{}x{}", w.inner_size().width, w.inner_size().height))
                .unwrap_or_else(|| "none".into());
            let surf = self.present.as_ref().map(|p| p.size()).unwrap_or((0, 0));
            eprintln!(
                "[wall-debug] window.inner={inner} surface={}x{} self.size={}x{}",
                surf.0, surf.1, self.size.0, self.size.1
            );
        }
        // Phase C toast: auto-dismiss after the configured delay (polled via
        // `about_to_wait` while a toast is live).
        if let Some(at) = self.status_shown_at {
            if at.elapsed() >= TOAST_MS {
                self.session.clear_status_message();
                self.status_shown_at = None;
                self.dirty = true;
            }
        }
        // `--pointer` taps: replay the whole sequence through the same pointer
        // pipeline (each tap hit-tests against the state mutated by the prior
        // taps) before this frame's produce, so `--snapshot` captures the
        // post-tap UI. Probe ops replay in argument order, so
        // "focus -> type -> send" is expressible.
        if !self.simulated {
            self.simulated = true;
            // Chat-area hit-testing (inline message actions) needs the painted
            // layout geometry, which only exists after a produce. Prime one
            // layout pass before replaying taps; keep the snapshot/swapchain
            // dump paths for the post-tap produce.
            if !self.pointer_taps.is_empty() && self.message_rects.is_empty() {
                let snapshot = self.snapshot_path.take();
                let swap = self.swap_path.take();
                let dump = self.dom_dump_path.take();
                self.produce_and_render();
                self.snapshot_path = snapshot;
                self.swap_path = swap;
                self.dom_dump_path = dump;
            }
            while let Some(op) = self.pointer_taps.pop_front() {
                match op {
                    ProbeOp::Tap(x, y) => {
                        self.pointer_down(x, y);
                        self.pointer_up(x, y);
                    }
                    ProbeOp::Type(text) => {
                        for ch in text.chars() {
                            self.type_char(ch);
                        }
                    }
                    ProbeOp::Wheel(dy) => {
                        // Route the notch through the live `wheel` path with
                        // the deterministic clock started at 0 (a real-time
                        // base would race the later `--tick` steps).
                        self.probe_clock_ns.get_or_insert(0);
                        self.wheel(dy);
                    }
                    ProbeOp::Tick(ms) => {
                        // One animation step at a deterministic sample time:
                        // the same sampler the real frame loop runs. A step
                        // that finishes the animation lands immediately so
                        // the produce below bakes the landed offset (the
                        // frame-level landing already ran inside the replay).
                        let clock = self.probe_clock_ns.get_or_insert(0);
                        *clock = clock.saturating_add(ms.saturating_mul(1_000_000));
                        if self.advance_scroll_animations() {
                            self.land_now();
                        }
                    }
                }
            }
        }
        // Wheel ease-out / touch fling advance the VISUAL offset (frozen
        // raster + blit shift, no re-produce). The scripted probe clock lives
        // exactly while a scripted animation is still mid-flight; once it
        // lands, live input returns to wall time (a stale frozen clock would
        // freeze the next live animation too).
        if !self.scroll_animation_active() {
            self.probe_clock_ns = None;
        }
        self.advance_scroll_animations();
        // Landing (sync-back) through the shared ack-loop: a drift past half
        // the chat band while the gesture runs — or any residual drift once
        // it ended — bakes the visual into the session with one clamped
        // `scroll_chat_by`; the produce below then re-renders the content
        // window at the landed offset (the same contract the Android host
        // drives through the kernel rebase).
        if let Some(shift) = self
            .ack
            .due(self.visual_scroll_css, self.scroll_animation_active())
        {
            self.land_scroll(shift);
        }
        if self.dirty {
            self.produce_and_render();
        }
        // A produce failure leaves `dirty` set so we retry instead of
        // presenting stale content.
        if self.dirty {
            return;
        }
        // Present from the accumulated resolve once per redraw. Redraws are
        // event-driven (resize, data change, later: pointer/stream) вЂ” the idle
        // window stays at ~0% CPU instead of spinning the event loop. The
        // probe dump (if requested) is re-written by the shifted present
        // below, so `--blit-shift --swapchain x.png` captures the shifted
        // frame.
        let probe_swap = self.swap_path.clone();
        let window = self.present_window();
        let result = {
            let present = self.present.as_mut().expect("present present");
            match &self.swap_path {
                Some(path) => present.present_and_dump(window, path),
                None => present.present(window),
            }
        };
        match result {
            Ok(()) => {
                if let Some(path) = self.swap_path.take() {
                    eprintln!("[neocompositor-desktop] swapchain dump WROTE {path}");
                }
                self.retry_present = false;
                self.last_present_error = None;
            }
            Err(err) => {
                let now = std::time::Instant::now();
                let throttle = self
                    .last_present_error
                    .map(|last| now.duration_since(last).as_millis() > 250)
                    .unwrap_or(true);
                self.last_present_error = Some(now);
                if throttle {
                    eprintln!("[neocompositor-desktop] present: {err}");
                }
                // Any acquire failure (incl. Timeout/Occluded) leaves the
                // window on stale/brown вЂ” schedule a bounded retry instead of
                // freezing on the first failure. `about_to_wait` re-arms a
                // redraw every ~50ms while this stays set; otherwise the loop
                // idles at 0% CPU.
                self.retry_present = true;
            }
        }
        // `--blit-shift` diagnostic: one extra present with the chat column
        // shifted by the given CSS px inside the 2D blend window — sidebar,
        // header and composer must stay put while the chat viewport shifts.
        if let Some(dy) = self.blit_shift_probe.take() {
            let window = self.chat_blit_window(dy);
            if let Some(present) = self.present.as_mut() {
                let result = match &probe_swap {
                    Some(path) => present.present_and_dump(window, path),
                    None => present.present(window),
                };
                match result {
                    Ok(()) => eprintln!(
                        "[neocompositor-desktop] blit-shift {dy} css px (band {:?})",
                        (
                            window.header,
                            window.composer_top,
                            window.band_left,
                            window.band_right
                        )
                    ),
                    Err(err) => eprintln!("[neocompositor-desktop] blit-shift present: {err}"),
                }
            }
        }
    }

    /// The blend window for the regular present: the cached chat column plus
    /// the current blit shift (visual minus the ack-loop's presented window),
    /// in physical px. Falls back to a plain full-frame blit before the first
    /// produce.
    fn present_window(&self) -> BlitWindow {
        match self.chat_band {
            Some((header, composer_top, band_left, band_right)) => BlitWindow {
                scroll_y: self.ack.drift(self.visual_scroll_css) * self.density.max(1.0),
                header,
                composer_top,
                band_left,
                band_right,
            },
            None => BlitWindow::default(),
        }
    }

    /// `--blit-shift` diagnostic window: the cached chat column shifted by an
    /// absolute CSS px amount (independent of the animation state).
    fn chat_blit_window(&self, dy_css: f32) -> BlitWindow {
        let (header, composer_top, band_left, band_right) =
            self.chat_band.unwrap_or((0.0, 0.0, 0.0, 0.0));
        BlitWindow {
            scroll_y: dy_css * self.density.max(1.0),
            header,
            composer_top,
            band_left,
            band_right,
        }
    }

    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        if self.size != (width, height) {
            eprintln!(
                "[neocompositor-desktop] resize {:?} -> ({width},{height})",
                self.size
            );
        }
        self.size = (width, height);
        // Per event: re-configure the swapchain only (the blit keeps sampling
        // the previous raster between produces) and mark dirty — winit
        // coalesces redraws, so the document re-lays-out at the new size at
        // the display cadence instead of once per drag pixel. The expensive
        // target re-allocation happens once per produce (`produce_and_render`
        // calls `PresentSurface::resize`), not once per event.
        if let Some(present) = self.present.as_mut() {
            present.set_swapchain_size(width, height);
        }
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        event_loop.set_control_flow(ControlFlow::Wait);
        let window = match event_loop.create_window(
            WindowAttributes::default()
                .with_title(TITLE)
                .with_inner_size(winit::dpi::LogicalSize::new(
                    self.initial_size.0 as f64,
                    self.initial_size.1 as f64,
                )),
        ) {
            Ok(window) => Arc::new(window),
            Err(err) => {
                eprintln!("[neocompositor-desktop] window: {err}");
                event_loop.exit();
                return;
            }
        };
        let inner = window.inner_size();
        self.size = (inner.width.max(1), inner.height.max(1));
        self.density = window.scale_factor() as f32;

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            flags: wgpu::InstanceFlags::from_build_config().with_env()
                | wgpu::InstanceFlags::ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER
                | wgpu::InstanceFlags::DEBUG,
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::default(),
            display: None,
        });
        let surface = match instance.create_surface(window.clone()) {
            Ok(surface) => surface,
            Err(err) => {
                eprintln!("[neocompositor-desktop] surface: {err}");
                event_loop.exit();
                return;
            }
        };
        let present = match PresentSurface::open(&instance, surface, self.size.0, self.size.1) {
            Ok(present) => present,
            Err(err) => {
                eprintln!("[neocompositor-desktop] present: {err}");
                event_loop.exit();
                return;
            }
        };
        eprintln!(
            "[neocompositor-desktop] ready {}x{} dpr={} backend={} swapchain={:?} srgb={}",
            self.size.0,
            self.size.1,
            self.density,
            present.backend,
            present.config.format,
            present.srgb_target,
        );
        self.window = Some(window);
        self.present = Some(present);
        self.window.as_ref().map(|w| w.request_redraw());
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: winit::window::WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => self.resize(size.width, size.height),
            WindowEvent::RedrawRequested => self.frame(),
            WindowEvent::Touch(touch) => {
                // Digitizers synthesize mouse events for the same contact;
                // while the touch pipeline owns the pointer, ignore those.
                let (x, y) = self.css_point(touch.location.x, touch.location.y);
                self.touch_input(touch.id, touch.phase, x, y);
            }
            WindowEvent::CursorMoved { position, .. } => {
                if self.touch.is_some() {
                    return;
                }
                let (x, y) = self.css_point(position.x, position.y);
                self.last_cursor = Some((x, y));
                self.pointer_move(x, y);
            }
            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } => {
                if self.touch.is_some() {
                    return;
                }
                let Some((x, y)) = self.last_cursor else {
                    return;
                };
                match state {
                    ElementState::Pressed => self.pointer_down(x, y),
                    ElementState::Released => self.pointer_up(x, y),
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let css_y = match delta {
                    MouseScrollDelta::LineDelta(_, lines) => lines * WHEEL_LINE_CSS,
                    MouseScrollDelta::PixelDelta(pos) => (pos.y as f32) / self.density.max(1.0),
                };
                self.wheel(css_y);
            }
            WindowEvent::KeyboardInput { event, .. }
                if event.state == winit::event::ElementState::Pressed =>
            {
                use winit::keyboard::Key;
                match &event.logical_key {
                    Key::Character(text) => {
                        for ch in text.chars() {
                            self.type_char(ch);
                        }
                    }
                    Key::Named(winit::keyboard::NamedKey::Backspace) => self.backspace(),
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self.retry_present {
            if let Some(window) = self.window.as_ref() {
                window.request_redraw();
            }
            let next = std::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(50))
                .expect("instant");
            event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(next.into()));
        } else if self.scroll_animation_active() {
            // Wheel ease-out and touch fling frames at the vsync cadence; the
            // animation is absolute-time based, so a late frame lands on the
            // correct offset instead of skipping steps. A scripted animation
            // still on the probe clock advances it at the same cadence, so it
            // completes in real time after the replay.
            if let Some(clock) = self.probe_clock_ns.as_mut() {
                *clock = clock.saturating_add(8_000_000);
            }
            if let Some(window) = self.window.as_ref() {
                window.request_redraw();
            }
            let next = std::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(8))
                .expect("instant");
            event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(next.into()));
        } else if self.status_shown_at.is_some() {
            // Poll at ~10 Hz so the toast auto-dismisses.
            if let Some(window) = self.window.as_ref() {
                window.request_redraw();
            }
            let next = std::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(100))
                .expect("instant");
            event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(next.into()));
        } else {
            event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
        }
    }
}

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
    let probe_ops: VecDeque<ProbeOp> = {
        let mut ops = VecDeque::new();
        let mut args_iter = args.iter().peekable();
        while let Some(arg) = args_iter.next() {
            match arg.as_str() {
                "--pointer" => {
                    if let Some(spec) = args_iter.next() {
                        if let Some((x, y)) = spec.split_once(',') {
                            if let (Ok(x), Ok(y)) =
                                (x.trim().parse::<f32>(), y.trim().parse::<f32>())
                            {
                                ops.push_back(ProbeOp::Tap(x, y));
                            }
                        }
                    }
                }
                "--type" => {
                    if let Some(text) = args_iter.next() {
                        ops.push_back(ProbeOp::Type(text.clone()));
                    }
                }
                "--wheel" => {
                    if let Some(spec) = args_iter.next() {
                        if let Ok(dy) = spec.trim().parse::<f32>() {
                            ops.push_back(ProbeOp::Wheel(dy));
                        }
                    }
                }
                "--tick" => {
                    if let Some(spec) = args_iter.next() {
                        if let Ok(ms) = spec.trim().parse::<u64>() {
                            ops.push_back(ProbeOp::Tick(ms));
                        }
                    }
                }
                _ => {}
            }
        }
        ops
    };

    let mut app = App::new(messages)?;
    app.snapshot_path = snapshot;
    app.swap_path = swapchain;
    app.dom_dump_path = dom_dump;
    app.pointer_taps = probe_ops;
    app.blit_shift_probe = blit_shift;
    app.initial_size = (w.max(1), h.max(1));
    if let Some(path) = args
        .iter()
        .position(|a| a == "--wallpaper")
        .and_then(|i| args.get(i + 1))
    {
        match std::fs::read(path) {
            Ok(bytes) => {
                if bytes.len() > neotavern_presentation_chat::THUMBNAIL_INPUT_MAX_BYTES {
                    eprintln!(
                        "[neocompositor-desktop] wallpaper ignored: file exceeds {} bytes",
                        neotavern_presentation_chat::THUMBNAIL_INPUT_MAX_BYTES
                    );
                } else {
                    app.wallpaper_bytes = Some(bytes);
                    // Drops the opaque packed `.AppShell_shell` base so the
                    // host-composited photo can show through the translucent
                    // scene (see product_shell.rs wallpaper-mode comment).
                    neotavern_presentation_dioxus_shell::set_chat_wallpaper_mode(true);
                }
            }
            Err(err) => {
                eprintln!("[neocompositor-desktop] wallpaper ignored: {err}");
            }
        }
    }
    if let Some(source) = blueprint_source {
        let legacy = matches!(
            source,
            neotavern_presentation_dioxus_shell::ChatBlueprintSource::Disabled
        );
        neotavern_presentation_dioxus_shell::set_chat_blueprint_source(source);
        if legacy {
            eprintln!("[neocompositor-desktop] chrome driven by legacy RSX (safe mode)");
        } else {
            eprintln!("[neocompositor-desktop] chrome driven by blueprint document (--blueprint)");
        }
    } else if let neotavern_presentation_dioxus_shell::ChatBlueprintSource::Path(path) =
        neotavern_presentation_dioxus_shell::ChatBlueprintSource::from_env()
    {
        neotavern_presentation_dioxus_shell::set_chat_blueprint_source(
            neotavern_presentation_dioxus_shell::ChatBlueprintSource::Path(path),
        );
        eprintln!("[neocompositor-desktop] chrome driven by NEOTA_CHAT_BLUEPRINT_DOC");
    } else {
        // Stage-1 default (ADR-0056): the embedded canonical document drives
        // the covered chrome variants; uncovered ones degrade to legacy per
        // frame with a one-time notice from the shell.
        neotavern_presentation_dioxus_shell::set_chat_blueprint_source(
            neotavern_presentation_dioxus_shell::ChatBlueprintSource::Embedded,
        );
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
