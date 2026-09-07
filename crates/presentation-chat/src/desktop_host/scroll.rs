//! Visual-offset scroll animation for the desktop host: wheel ease-out, touch
//! fling decay, and the landing (sync-back) into the session offset.

use super::App;
use crate::scroll_dynamics::SmoothScroll;

impl App {
    /// Monotonic nanoseconds for the scroll animation timelines. The
    /// deterministic probe clock takes precedence while scripted ops run so
    /// `--tick` sequences land on exact sample times.
    pub(super) fn monotonic_ns(&self) -> u64 {
        self.probe_clock_ns
            .unwrap_or_else(|| self.clock_base.elapsed().as_nanos() as u64)
    }

    /// Advances the scroll animations in the VISUAL offset only: the frozen
    /// raster stays baked at the session offset and the difference presents
    /// as a blit shift, so animation frames skip the ~30 ms re-produce.
    /// Returns `true` when an animation just finished — `frame` then lands
    /// the visual into the session (sync-back).
    pub(super) fn advance_scroll_animations(&mut self) -> bool {
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
        if crate::scroll_dynamics::glide_active(self.glide_velocity) {
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
            self.glide_velocity = crate::scroll_dynamics::glide_decay(self.glide_velocity, dt);
        } else {
            self.last_glide_tick_ns = None;
        }
        let finished = was_active && !self.scroll_animation_active();
        finished
    }

    pub(super) fn scroll_animation_active(&self) -> bool {
        self.smooth_scroll.is_some()
            || crate::scroll_dynamics::glide_active(self.glide_velocity)
            || self.touch.as_ref().is_some_and(|contact| contact.dragging)
    }

    /// Sync-back: lands the visual offset into the session with ONE clamped
    /// `scroll_chat_by`, so the next produce bakes exactly what the screen
    /// shows and the blit shift returns to zero. The ack-loop lands on the
    /// produced window (produce is synchronous here — no in-flight state).
    pub(super) fn land_scroll(&mut self, shift: f32) {
        if shift != 0.0 {
            self.session.scroll_chat_by(shift);
            self.ack.land(self.session.scroll_offset_css());
            self.visual_scroll_css = self.session.scroll_offset_css();
            self.dirty = true;
        }
    }

    /// Land unconditionally (drag release, grab): sync the session to the
    /// visual regardless of how large the drift is.
    pub(super) fn land_now(&mut self) {
        let shift = self.ack.drift(self.visual_scroll_css);
        self.land_scroll(shift);
    }

    /// Wheel over the chat viewport scrolls it; `dy` is in CSS px (negative =
    /// scroll up / older messages). Notches land on a ~120 ms ease-out curve
    /// over the blit shift (no re-produce per frame); chaining notches
    /// mid-flight retargets.
    pub(super) fn wheel(&mut self, css_dy: f32) {
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

    /// Wheel with a pointer position: over the characters Edit panel the
    /// notch scrolls the panel body (native shim for React's native panel
    /// scrolling — Blitz paint has no overflow scroll), elsewhere it scrolls
    /// the chat.
    pub(super) fn wheel_at(&mut self, css_x: f32, css_y: f32, css_dy: f32) {
        if self.route_panel_wheel(css_x, css_y, css_dy) {
            return;
        }
        self.wheel(css_dy);
    }

    fn route_panel_wheel(&mut self, css_x: f32, css_y: f32, css_dy: f32) -> bool {
        let view = self.session.shell_view();
        if !(view.sidebar_open && view.panel == "characters" && view.tab == "edit") {
            return false;
        }
        let panel_x = crate::RAIL_WIDTH;
        let panel_w = self.session.panel_width();
        if css_x < panel_x || css_x >= panel_x + panel_w {
            return false;
        }
        // The scroller only exists where the editor content overflows the
        // window; the hit rects already carry the applied offset, so the
        // unscrolled content bottom adds it back. The root box is clipped to
        // the viewport — overflowing rows (greetings, chips) set the extent.
        let window_h = self.size.1 as f32 / self.density.max(1.0);
        let Some(rect) = self
            .hit_rects
            .top_matching(css_x, css_y, "part:character-editor")
        else {
            return false;
        };
        let max_offset =
            (self.hit_rects.subtree_bottom(rect) + view.panel_scroll_css - window_h).max(0.0);
        if max_offset <= 0.0 {
            // Over the editor but nothing to scroll: still consume the
            // notch — it must not reach the chat behind the panel.
            return true;
        }
        if self.session.scroll_panel_by(css_dy, max_offset) {
            self.dirty = true;
            self.window.as_ref().map(|w| w.request_redraw());
        }
        true
    }
}
