//! Per-redraw frame for the desktop host: probe replay, scroll animation
//! advance, present + blend windows, resize, and the winit `ApplicationHandler`.

use std::sync::Arc;

use super::probe::ProbeOp;
use super::{App, TITLE, TOAST_MS, WHEEL_LINE_CSS};
use crate::{BlitWindow, PresentSurface, StreamFrame};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow};
use winit::window::WindowAttributes;

impl App {
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
        // kernel's writer thread: pump the live run here (one frame per
        // redraw, `about_to_wait` re-arms redraws while the stream is live).
        // FakeWire drains synchronously inside `send`, so this is a no-op for
        // the default in-memory host.
        if self.session.state().stream_handle.is_some() {
            match self.session.poll_stream(0) {
                Ok(StreamFrame::Event { .. }) => self.dirty = true,
                Ok(StreamFrame::Terminal | StreamFrame::Error(_)) => self.dirty = true,
                _ => {}
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
    pub(super) fn present_window(&self) -> BlitWindow {
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
    pub(super) fn chat_blit_window(&self, dy_css: f32) -> BlitWindow {
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
        } else {
            event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
        }
    }
}
