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
//!   --snapshot <png> / --swapchain <png> / --dom-dump <json>  diagnostic dumps

use std::collections::VecDeque;
use std::sync::Arc;

use neotavern_presentation_chat::{
    ChatCompositor, ChatSession, DEMO_CHAT_ID, FakeWire, HitRects, PresentSurface, QuickIntent,
    RAIL_WIDTH, ShellAction, ShellHit, TOUCH_SLOP_CSS, TapIntent, hit_test,
};
use neotavern_presentation_dioxus_shell::{install_product_shell, product_shell_app};
use neotavern_presentation_m0_d2::{
    MessageRect, ProductVelloSession, VelloFilter, image_paints_from_layout, write_slot_skeleton,
};
use vello::peniko::color::palette;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowAttributes};

const TITLE: &str = "NeoCompositor вЂ” NeoTavern (Windows)";
/// Approx CSS-px per wheel notch вЂ” a comfortable desktop scroll step.
const WHEEL_LINE_CSS: f32 = 40.0;
/// GPU texture cache key for the `--wallpaper` photo (not an avatar; lives in
/// the same LRU only so the upload path is shared).
const WALLPAPER_ASSET_ID: &str = "neota-wallpaper";

/// Auto-dismiss delay for the Phase C status toast.
const TOAST_MS: std::time::Duration = std::time::Duration::from_millis(3500);

/// Write one decoded chat-export document (`chats.export` host sink).
/// Returns the path the file landed at.
fn write_export_file(
    export: &neotavern_presentation_chat::LastExport,
) -> std::io::Result<String> {
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
}

/// One scripted probe step, replayed in argument order so
/// "focus -> type -> send" scenarios are expressible.
#[derive(Clone, Debug)]
enum ProbeOp {
    Tap(f32, f32),
    Type(String),
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
    ComposerSettings,
    ComposerReset,
    ComposerContext,
    ScrollLatest,
}

/// A native-control tap captured at `Down`; released at `Up` if the pointer
/// stayed within `TOUCH_SLOP_CSS` (mirror of the Android `PendingUi`).
struct PendingUi {
    css_x: f32,
    css_y: f32,
    hit: ShellHit,
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
    focus: TextFocus,
    status_shown_at: Option<std::time::Instant>,
    avatar_paints: Vec<neotavern_neocompositor::ImagePaintOp>,
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
            focus: TextFocus::None,
            status_shown_at: None,
            avatar_paints: Vec::new(),
            message_rects: Vec::new(),
            pending_message_action: None,
            pending_quick: None,
            hit_rects: HitRects::default(),
            panel_drag: None,
            cursor_icon: None,
            initial_size: (1100, 760),
            wallpaper_bytes: None,
            wallpaper_cache: None,
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
        let (insets, toast_showing) = {
            let session = &mut self.session;
            session.set_surface_size(width.max(1), height, density);
            session.set_safe_area_physical(0.0, 0.0, 0.0, 0.0);
            // One view-model build per frame: `shell_view` clones characters,
            // visible rows and drafts, so a second call for the toast check
            // doubles that cost on every drag/scroll tick.
            let shell = session.shell_view();
            let toast_showing = shell.status_message.is_some();
            install_product_shell(shell);
            (session.insets(), toast_showing)
        };
        if toast_showing {
            if self.status_shown_at.is_none() {
                self.status_shown_at = Some(std::time::Instant::now());
            }
        } else {
            self.status_shown_at = None;
        }
        let t_layout = std::time::Instant::now();

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
        let (produced, scene, _diag) = match sess.paint(VelloFilter::full()) {
            Ok(out) => out,
            Err(err) => {
                eprintln!("[neocompositor-desktop] paint: {err}");
                self.dirty = true;
                return;
            }
        };
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
        if std::env::var("NEOTA_DEBUG_PEEK").is_ok() {
            for (px, py) in [(550, 410), (1092, 410), (550, 100), (30, 400)] {
                let before = present.debug_peek_resolve(px, py);
                eprintln!("[wall-debug] after render ({px},{py}): {before:?}");
            }
        }
        // Wallpaper photo UNDER the translucent scene (destination-over on
        // `resolve`): glass fills blend over the photo like CSS glass over a
        // background image. Rebuilt only when the physical size changes.
        if let Some(bytes) = &self.wallpaper_bytes {
            let cached = match &self.wallpaper_cache {
                Some((w, h, _)) if *w == width && *h == height => None,
                _ => neotavern_presentation_chat::wallpaper_cover_thumbnail(
                    bytes,
                    width.max(1),
                    height.max(1),
                ),
            };
            if let Some(thumb) = cached {
                self.wallpaper_cache = Some((width, height, thumb));
            }
            if let Some((_, _, thumb)) = &self.wallpaper_cache {
                present.upload_avatar(WALLPAPER_ASSET_ID, thumb);
                present.composite_wallpaper_under(&neotavern_neocompositor::ImagePaintOp {
                    asset_id: WALLPAPER_ASSET_ID.to_string(),
                    dest: neotavern_neocompositor::Rect::new(
                        0.0,
                        0.0,
                        width.max(1) as f32,
                        height.max(1) as f32,
                    ),
                    clip_radius: 0.0,
                    ready_token: 0,
                });
            }
            if std::env::var("NEOTA_DEBUG_PEEK").is_ok() {
                for (px, py) in [(550, 410), (1092, 410), (550, 100), (30, 400)] {
                    let after = present.debug_peek_resolve(px, py);
                    eprintln!("[wall-debug] after wallpaper ({px},{py}): {after:?}");
                }
            }
        }
        // Avatar GPU overlay (Android parity): upload thumbnails and draw them
        // on `resolve` so the swapchain blit shows the real avatar image.
        let avatar_paints = image_paints_from_layout(
            sess.paint_layout(),
            density.max(1.0),
            self.session.avatar_ready_token(),
        );
        let avatar_count = avatar_paints.len();
        for (asset_id, thumb) in self.session.avatar_thumbs() {
            present.upload_avatar(asset_id, thumb);
        }
        present.composite_avatars(&avatar_paints);
        self.avatar_paints = avatar_paints;
        // Message row boxes for inline action hit-testing (copy). The rows are
        // in-flow inside the chat viewport, so their layout rects are the
        // window CSS-px positions the pointer pipeline uses.
        self.message_rects = sess.paint_layout().messages.clone();
        // Layout-derived hit rects: the single geometry source for taps and
        // text-field focus (same skeleton the `--dom-dump` writes).
        self.hit_rects = HitRects::from_skeleton(&sess.slot_skeleton());
        let total = t0.elapsed();
        let layout_ms = t_layout.duration_since(t0).as_millis();
        let render_ms = total.as_millis().saturating_sub(layout_ms);
        eprintln!(
            "[neocompositor-desktop] produced cmds={} ops={} paths={} glass={} backend={} kernel_messages={} characters={} avatars={} [layout {}ms raster {}ms total {}ms]",
            produced.report.paint_commands,
            list_ops,
            scene_paths,
            produced.report.glass_hooks,
            present.backend,
            self.session.kernel_message_count(),
            self.session.shell_view().characters.len(),
            avatar_count,
            layout_ms,
            render_ms,
            total.as_millis(),
        );
        if let Some(path) = self.snapshot_path.take() {
            match present.snapshot(&path) {
                Ok(()) => eprintln!("[neocompositor-desktop] snapshot WROTE {path}"),
                Err(err) => eprintln!("[neocompositor-desktop] snapshot failed: {err}"),
            }
        }
        if let Some(path) = self.dom_dump_path.take() {
            let skeleton = sess.slot_skeleton();
            let count = skeleton.nodes.len();
            match write_slot_skeleton(&path, &skeleton) {
                Ok(()) => {
                    eprintln!("[neocompositor-desktop] dom-dump WROTE {path} ({count} nodes)")
                }
                Err(err) => eprintln!("[neocompositor-desktop] dom-dump failed: {err}"),
            }
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
                    QuickIntent::ComposerSettings => QuickAction::ComposerSettings,
                    QuickIntent::ComposerReset => QuickAction::ComposerReset,
                    QuickIntent::ComposerContext => QuickAction::ComposerContext,
                    QuickIntent::ScrollLatest => QuickAction::ScrollLatest,
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
        if view.create_dialog_open {
            if rects.covers(css_x, css_y, "part:create-name") {
                focus = TextFocus::CreateName;
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
                        self.pending_ui = None;
                        self.session.scroll_chat_by(1.0e6);
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
                    neotavern_presentation_chat::MessageActionKind::Edit => {
                        eprintln!("[neocompositor-desktop] edit tapped: {}", pending.row_id);
                        self.session.start_message_edit(&pending.row_id);
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
                        eprintln!("[neocompositor-desktop] checkpoint tapped: {}", pending.row_id);
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
                    other => eprintln!(
                        "[neocompositor-desktop] tap -> message:{other:?} on {} not wired yet",
                        pending.row_id
                    ),
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
            let export_id = match &action {
                ShellAction::ExportChat(id) => Some(id.clone()),
                _ => None,
            };
            self.session.apply_shell_action(action);
            // Host-side file sink for `chats.export` (React downloads to the
            // browser; the desktop host writes under exports/, overridable
            // via NEOTA_EXPORT_DIR).
            if export_id.is_some() {
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
            }
            self.dirty = true;
            self.window.as_ref().map(|w| w.request_redraw());
        }
    }

    /// Wheel over the chat viewport scrolls it; `dy` is in CSS px (negative =
    /// scroll up / older messages).
    fn wheel(&mut self, css_dy: f32) {
        if css_dy != 0.0 && self.present.is_some() {
            self.session.scroll_chat_by(css_dy);
            self.dirty = true;
            self.window.as_ref().map(|w| w.request_redraw());
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
                }
            }
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
        // window stays at ~0% CPU instead of spinning the event loop.
        let result = {
            let present = self.present.as_mut().expect("present present");
            match &self.swap_path {
                Some(path) => present.present_and_dump(0.0, 0.0, 0.0, path),
                None => present.present(0.0, 0.0, 0.0),
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
        if let Some(present) = self.present.as_mut() {
            present.resize(width, height);
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
            WindowEvent::CursorMoved { position, .. } => {
                let (x, y) = self.css_point(position.x, position.y);
                self.last_cursor = Some((x, y));
                self.pointer_move(x, y);
            }
            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } => {
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
