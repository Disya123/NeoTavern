//! Per-redraw frame for the desktop host: probe replay, scroll animation
//! advance, present + blend windows, resize, and the winit `ApplicationHandler`.

use std::sync::Arc;

use super::probe::ProbeOp;
use super::{App, TITLE, TOAST_MS, WHEEL_LINE_CSS};
use crate::{BlitWindow, PresentSurface};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow};
use winit::window::WindowAttributes;

/// Produce cadence floor while a generation stream is live (AGENTS §24:
/// no more than 30 UI updates per second for streaming responses).
const STREAM_PRODUCE_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(33);

impl App {
    /// Single invalidation observation point: every visible session mutation
    /// bumps `scene_epoch`, so consuming an epoch change here marks the frame
    /// dirty regardless of per-call-site `dirty` bookkeeping. Mirrors the
    /// Android host (`produced.list.generation = session.scene_epoch()`).
    /// Returns `true` when a change was consumed.
    pub(super) fn observe_scene_epoch(&mut self) -> bool {
        let epoch = self.session.scene_epoch();
        if epoch != self.observed_scene_epoch {
            self.observed_scene_epoch = epoch;
            self.dirty = true;
            true
        } else {
            false
        }
    }

    /// DPI move (mixed-DPI Windows monitors): `refresh` hard-errors on a
    /// scale change (m0-d2 produce guard), so the warm session is dropped for
    /// a cold open in the new scale. Caches keyed by physical size re-derive
    /// per produce; the wallpaper cover re-derives through its size
    /// hysteresis once the dest rect scales.
    pub(super) fn apply_scale_change(&mut self, scale: f32) {
        let scale = scale.max(1.0);
        if (self.density - scale).abs() <= f32::EPSILON {
            return;
        }
        eprintln!(
            "[neocompositor-desktop] scale {:.3} -> {:.3}; cold produce",
            self.density, scale
        );
        self.density = scale;
        self.vello_session = None;
        self.wallpaper_cache = None;
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }

    /// `--hit x y` debug report: both hit-test systems' resolution for one
    /// CSS point, against the installed (painted) view — the same single
    /// geometry contract the tap capture uses.
    pub(super) fn hit_probe_report(&self, css_x: f32, css_y: f32) -> String {
        let view = neotavern_presentation_dioxus_shell::current_product_shell();
        format!(
            "[hit-probe] ({css_x},{css_y}) geometric={:?} layout={:?}",
            crate::hit_test(&view, css_x, css_y),
            self.hit_rects.resolve_tap(css_x, css_y)
        )
    }

    pub(super) fn frame(&mut self) {
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
        // Kernel-backed generation streams commit asynchronously on the
        // kernel's writer thread: drain every queued frame here (one produce
        // per pump, not one per event) and keep the produce cadence at
        // ~30/s while the run is live (AGENTS §24). FakeWire drains
        // synchronously inside `send`, so this is a no-op for the default
        // in-memory host.
        if self.session.pump_stream() {
            self.dirty = true;
        }
        // Invalidation contract inside the frame too: toast dismissal and the
        // probe replay below mutate the session; nothing may depend on a
        // per-handler `dirty` memory being correct.
        self.observe_scene_epoch();
        // `--pointer` taps: replay the whole sequence through the same pointer
        // pipeline (each tap hit-tests against the state mutated by the prior
        // taps) before this frame's produce, so `--snapshot` captures the
        // post-tap UI. Probe ops replay in argument order, so
        // "focus -> type -> send" is expressible. Animation ops (wheel/tick)
        // replay ONE PER FRAME — a real wheel spreads its notches over many
        // frames and the ease renders between them; draining them all into
        // one frame collapses the gesture into a single jump and no
        // mid-gesture frame (drift, blit runway, cap lands) ever exists.
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
        }
        if !self.pointer_taps.is_empty() {
            while let Some(op) = self.pointer_taps.pop_front() {
                let animation_op = matches!(op, ProbeOp::Wheel(_) | ProbeOp::Tick(_));
                match op {
                    ProbeOp::Tap(x, y) => {
                        self.pointer_down(x, y);
                        self.pointer_up(x, y);
                    }
                    ProbeOp::Move(x, y) => {
                        self.pointer_css = (x, y);
                    }
                    ProbeOp::Type(text) => {
                        for ch in text.chars() {
                            self.type_char(ch);
                        }
                    }
                    ProbeOp::Wheel(dy) => {
                        // Route the notch through the live `wheel_at` path
                        // (panel vs chat routing off the tracked pointer).
                        // The deterministic clock starts at 0 only for
                        // scripts that step it with `--tick` (a real-time
                        // base would race those steps); a wheel-only script
                        // must keep the live clock, or the frozen clock
                        // would stop the animation and the lands forever.
                        if self.probe_has_tick {
                            self.probe_clock_ns.get_or_insert(0);
                        }
                        let (css_px, css_py) = self.pointer_css;
                        self.wheel_at(css_px, css_py, dy);
                    }
                    ProbeOp::ScrollTo(offset) => {
                        // Deterministic jump: the produce later in THIS frame
                        // bakes the raster at the new offset and rebases the
                        // ack loop; the visual follows the bake (no
                        // animation is left mid-flight here).
                        let before = self.session.scroll_offset_css();
                        self.smooth_scroll = None;
                        self.glide_velocity = 0.0;
                        self.session.set_scroll_offset_css(offset);
                        self.visual_scroll_css = offset;
                        self.dirty = true;
                        eprintln!(
                            "[scroll-to] before={before} after={} max={}",
                            self.session.scroll_offset_css(),
                            self.session.scroll_max_css()
                        );
                    }
                    ProbeOp::Tick(ms) => {
                        // One animation step at a deterministic sample
                        // time: the same step the real frame loop runs
                        // (`advance_and_land_scroll` — visual advance, land
                        // when the ack drift crosses the baked runway cap).
                        let clock = self.probe_clock_ns.get_or_insert(0);
                        *clock = clock.saturating_add(ms.saturating_mul(1_000_000));
                        self.advance_and_land_scroll();
                    }
                    ProbeOp::Hit(x, y) => {
                        // Resolves against the geometry produced by the
                        // previous op's produce (or the priming pass), like
                        // every other replayed op.
                        eprintln!("{}", self.hit_probe_report(x, y));
                    }
                    ProbeOp::Wait(ms) => {
                        // Real-time pause (diagnostics): the event loop is
                        // inside this frame, the window just shows the last
                        // present; resize/input events queue and replay
                        // after the pause.
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                    }
                }
                // A live window produces between input events; the scripted
                // replay must too, or the next op reads stale geometry
                // (panel wheel routing hit hit_rects from the priming
                // produce — before the panel even opened). The epoch
                // observation keeps this true even for ops that bump the
                // session without remembering `dirty`.
                self.observe_scene_epoch();
                if self.dirty {
                    let snapshot = self.snapshot_path.take();
                    let swap = self.swap_path.take();
                    let dump = self.dom_dump_path.take();
                    self.produce_and_render();
                    self.snapshot_path = snapshot;
                    self.swap_path = swap;
                    self.dom_dump_path = dump;
                }
                if animation_op {
                    // The wheel notch / tick lands in its own frame; the
                    // ease renders through the animation re-arm until the
                    // next op replays.
                    break;
                }
            }
            // The replay's settled state is always worth one paint, even
            // when every op clamped to a no-op (e.g. wheel past the chat
            // bottom): dumps requested with the probe must deterministically
            // capture the post-replay UI.
            self.dirty = true;
        }
        // Wheel ease-out / touch fling advance the VISUAL offset (frozen
        // raster + blit shift, no re-produce). The scripted probe clock lives
        // exactly while a scripted animation is still mid-flight; once it
        // lands, live input returns to wall time (a stale frozen clock would
        // freeze the next live animation too).
        if !self.scroll_animation_active() {
            self.probe_clock_ns = None;
        }
        // Produce BEFORE the acquire: a produce may re-allocate the rasters
        // and re-configure the swapchain, which must not happen while a
        // swapchain texture is checked out.
        if self.dirty {
            let streaming = self.session.state().stream_handle.is_some();
            let due = !streaming
                || self
                    .last_stream_produce
                    .is_none_or(|at| at.elapsed() >= STREAM_PRODUCE_MIN_INTERVAL);
            if due {
                self.produce_and_render();
                self.produce_deferred = false;
                if streaming {
                    self.last_stream_produce = Some(std::time::Instant::now());
                }
            } else {
                // Streaming gate: present the previous raster now; the live
                // stream re-arms redraws at ~16 ms, so the deferred produce
                // lands on the next frame (the terminal frame lifts the gate
                // immediately).
                self.produce_deferred = true;
            }
        }
        // A produce failure leaves `dirty` set so we retry instead of
        // presenting stale content; a merely deferred produce still presents
        // the last raster below.
        if self.dirty && !self.produce_deferred {
            return;
        }
        // Present, phase 1 — acquire. The FIFO swapchain blocks here until
        // the compositor releases a buffer (a v-sync boundary); the wake
        // timer only has to fire once per refresh, the acquire does the
        // phase-locking.
        if let Err(err) = self.present.as_mut().expect("present present").acquire() {
            self.note_present_error(&err);
            return;
        }
        // Present, phase 2 — sample the scroll animation against the v-sync
        // boundary the acquire just returned from, so every displayed frame
        // leads scanout by exactly one refresh. Sampling at the wake-timer
        // instant (the old order) left a 0..refresh random offset between the
        // sample and the scanout: consecutive displayed frames advanced the
        // motion by 5/6/7 ms worth of samples in turn — the judder that
        // high-refresh monitors turned into visible stutter even though the
        // present cadence itself was perfectly even.
        self.advance_and_land_scroll();
        // Present, phase 3 — blit the blended window and queue the frame for
        // the next refresh. Redraws are event-driven (resize, data change,
        // scroll frames) — the idle window stays at ~0% CPU. The probe dump
        // (if requested) is re-written by the shifted present below, so
        // `--blit-shift --swapchain x.png` captures the shifted frame.
        let probe_swap = self.swap_path.clone();
        let window = self.present_window();
        let result = {
            let present = self.present.as_mut().expect("present present");
            match &self.swap_path {
                Some(path) => present.blit_and_dump(window, path),
                None => present.blit(window),
            }
        };
        match result {
            Ok(()) => {
                if let Some(path) = self.swap_path.take() {
                    eprintln!("[neocompositor-desktop] swapchain dump WROTE {path}");
                }
                self.retry_present = false;
                self.last_present_error = None;
                if self.frame_timing {
                    let now = std::time::Instant::now();
                    let dt = self
                        .last_present_instant
                        .map(|at| now.duration_since(at).as_millis())
                        .unwrap_or(0);
                    self.last_present_instant = Some(now);
                    let acquire = self
                        .present
                        .as_ref()
                        .map(|p| p.last_acquire_wait().as_millis())
                        .unwrap_or(0);
                    eprintln!(
                        "[frame-timing] dt={dt}ms acquire={acquire}ms produce={:?}ms drift={:.1}",
                        self.last_produce_ms,
                        self.ack.drift(self.visual_scroll_css)
                    );
                }
            }
            Err(err) => self.note_present_error(&err),
        }
        // `--blit-shift` diagnostic: one extra present with the chat column
        // shifted by the given CSS px inside the 2D blend window — sidebar,
        // header and composer must stay put while the chat viewport shifts.
        if let Some(dy) = self.blit_shift_probe.take() {
            let window = self.chat_blit_window(dy);
            if let Some(present) = self.present.as_mut() {
                let result = match present.acquire() {
                    Err(err) => Err(err),
                    Ok(()) => match &probe_swap {
                        Some(path) => present.blit_and_dump(window, path),
                        None => present.blit(window),
                    },
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
        // A3 scroll-settle hydration: after the present, and only outside a
        // live scroll gesture, so image fetches never extend an animation
        // frame (they used to sit inside the produce and extend the land
        // stall). A hydrated asset re-arms one redraw so the next produce
        // paints it.
        if !self.scroll_animation_active() && self.session.refresh_visible_assets() {
            self.dirty = true;
            self.window.as_ref().map(|w| w.request_redraw());
        }
    }

    /// The blend window for the regular present: the cached chat column plus
    /// the current blit shift (visual minus the ack-loop's presented window),
    /// in physical px. Falls back to a plain full-frame blit before the first
    /// produce.
    pub(super) fn present_window(&self) -> BlitWindow {
        match self.chat_band {
            Some((header, composer_top, band_left, band_right)) => {
                let d = self.density.max(1.0);
                let overscan = self
                    .present
                    .as_ref()
                    .map(|p| p.overscan_phys())
                    .unwrap_or(0) as f32;
                // The drift may only sample baked chat rows: the source
                // window is the canvas extents. Below the band the raster
                // holds the COMPOSER (part of the doc scene) — an unclamped
                // shifted sample painted a ghost composer into the band, and
                // the ghost jumping on every land read as scroll judder.
                let (src_top, src_bottom) = match self.chat_canvas_css {
                    Some((top, bottom)) => {
                        // ABSOLUTE raster px (the BlitWindow contract): css
                        // panel px translated into the raster, which puts
                        // the top strip (css < 0) INSIDE the window — the
                        // clamps hold at the raster edges, not at css 0,
                        // or the overscan runway stops being sampleable.
                        let raster_h = self
                            .present
                            .as_ref()
                            .map(|p| p.raster_height())
                            .unwrap_or(0) as f32;
                        (
                            (top * d + overscan).max(0.0),
                            (bottom * d + overscan).min(raster_h),
                        )
                    }
                    None => (0.0, 0.0),
                };
                BlitWindow {
                    // The blit shift is the CONTENT displacement: the shader
                    // samples `doc_y + scroll_y`, so a positive `scroll_y`
                    // moves the content UP on screen. The visual offset grows
                    // toward OLDER content (from-bottom semantics), which
                    // must move the content DOWN — hence the negation.
                    // Un-negated, every gesture animated the content the
                    // wrong way and each land snapped it back (the frame
                    // tracking measured +4 px/frame backward drift with
                    // −24..−120 px land snaps netting the correct +196 px).
                    scroll_y: -self.ack.drift(self.visual_scroll_css) * d,
                    header,
                    composer_top,
                    band_left,
                    band_right,
                    src_top,
                    src_bottom,
                }
            }
            None => BlitWindow::default(),
        }
    }

    /// `--blit-shift` diagnostic window: the cached chat column shifted by an
    /// absolute CSS px amount (independent of the animation state). The
    /// source window stays the legacy full raster so the probe can also
    /// demonstrate what an unclamped shift samples.
    pub(super) fn chat_blit_window(&self, dy_css: f32) -> BlitWindow {
        let (header, composer_top, band_left, band_right) =
            self.chat_band.unwrap_or((0.0, 0.0, 0.0, 0.0));
        BlitWindow {
            scroll_y: dy_css * self.density.max(1.0),
            header,
            composer_top,
            band_left,
            band_right,
            src_top: 0.0,
            src_bottom: 0.0,
        }
    }

    /// Shared present-failure bookkeeping: throttled stderr plus a bounded
    /// retry (re-armed in `about_to_wait`).
    fn note_present_error(&mut self, err: &str) {
        let now = std::time::Instant::now();
        let throttle = self
            .last_present_error
            .map(|last| now.duration_since(last).as_millis() > 250)
            .unwrap_or(true);
        self.last_present_error = Some(now);
        if throttle {
            eprintln!("[neocompositor-desktop] present: {err}");
        }
        // Any acquire failure (incl. Timeout/Occluded) leaves the window on
        // stale content — schedule a bounded retry instead of freezing on
        // the first failure. `about_to_wait` re-arms a redraw every ~50ms
        // while this stays set; otherwise the loop idles at 0% CPU.
        self.retry_present = true;
    }

    pub(super) fn resize(&mut self, width: u32, height: u32) {
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
        // Per event: layout state only. The swapchain is deliberately NOT
        // re-configured here — re-configuring per event left a window where
        // the blit mapped the screen through the NEW config while the
        // resolve was still the OLD raster (a maximize painted a compressed
        // middle band with black margins and chrome from two layouts).
        // Keeping the old configuration lets DWM stretch the last consistent
        // frame for the one coalesced frame until `produce_and_render` →
        // `PresentSurface::resize` re-configures and re-allocates atomically;
        // a swapchain that does go stale surfaces as `Outdated` in `acquire`
        // and is healed with the raster-matching config there.
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
        let mut present = match PresentSurface::open(&instance, surface, self.size.0, self.size.1) {
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
        if let Some(every) = std::env::var("NEOTA_FRAME_DUMPS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
        {
            let dir = std::env::var("NEOTA_DUMP_DIR").unwrap_or_else(|_| ".".into());
            present.set_frame_dumps(every.max(1), dir);
        }
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
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.apply_scale_change(scale_factor as f32);
            }
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
                // Wheel events carry no cursor position in this winit
                // version; route through the last tracked pointer so wheel
                // over the side panel scrolls the panel, not the chat.
                let (css_px, css_py) = self.pointer_css;
                self.wheel_at(css_px, css_py, css_y);
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
        // Invalidation contract: any event-handler mutation that bumped the
        // session epoch becomes visible here, even without a `dirty` write.
        if self.observe_scene_epoch() {
            if let Some(window) = self.window.as_ref() {
                window.request_redraw();
            }
        }
        let document_changed = neotavern_presentation_dioxus_shell::chat_blueprint_file_changed();
        if document_changed == Some(true) {
            self.dirty = true;
            if let Some(window) = self.window.as_ref() {
                window.request_redraw();
            }
        }
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
            //
            // The re-arm timer must be SHORTER than a vsync interval: the
            // FIFO swapchain makes `get_current_texture` the pacer (it
            // blocks until the compositor releases a buffer), so a 1 ms
            // re-arm aligns every frame to the refresh (144 Hz included).
            // The old 8 ms timer landed BETWEEN vsyncs on high-refresh
            // monitors — frame intervals alternated 7/14 ms and scrolling
            // juddered.
            if let Some(clock) = self.probe_clock_ns.as_mut() {
                *clock = clock.saturating_add(1_000_000);
            }
            if let Some(window) = self.window.as_ref() {
                window.request_redraw();
            }
            let next = std::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(1))
                .expect("instant");
            event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(next.into()));
        } else if self.dirty && self.session.state().stream_handle.is_none() {
            // The post-acquire residual land (gesture end) marks the frame
            // dirty AFTER the scroll branch above went idle — without this
            // re-arm the loop parks on Wait and the window freezes on the
            // shifted raster until the next input event. (Live streams are
            // driven by the stream branch below instead; produce failures
            // retry through this branch too.)
            if let Some(window) = self.window.as_ref() {
                window.request_redraw();
            }
            let next = std::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(1))
                .expect("instant");
            event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(next.into()));
        } else if self.ack.drift(self.visual_scroll_css).abs()
            > crate::scroll_ack::LANDED_EPSILON_CSS
        {
            // Idle with a residual drift: the visual offset is ahead of (or
            // behind) the presented window while no animation is running.
            // The per-present land only runs on presenting frames, so a
            // gesture whose easing outlived the last present (produce frames
            // return before the present phase) can leave the loop parked on
            // a SHIFTED raster forever — the content sits displaced behind
            // the header/composer until the next input event. A shifted
            // screen at rest is never acceptable: land the residual here so
            // the very next frame re-produces at the true offset.
            self.land_now();
            if let Some(window) = self.window.as_ref() {
                window.request_redraw();
            }
            let next = std::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(1))
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
        } else if self.session.state().stream_handle.is_some() {
            // Live kernel generation stream: keep pumping at the frame
            // cadence (≈60 Hz) until the terminal event clears the handle.
            if let Some(window) = self.window.as_ref() {
                window.request_redraw();
            }
            let next = std::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(16))
                .expect("instant");
            event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(next.into()));
        } else if document_changed.is_some() {
            // Only file-backed authoring mode polls. Embedded product UI
            // remains event-driven; unchanged documents do not repaint.
            event_loop.set_control_flow(ControlFlow::WaitUntil(
                std::time::Instant::now() + std::time::Duration::from_millis(100),
            ));
        } else {
            event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
        }
    }
}
