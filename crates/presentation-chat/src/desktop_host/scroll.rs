//! Visual-offset scroll animation for the desktop host: wheel ease-out, touch
//! fling decay, and the landing (sync-back) into the session offset.

use super::App;
use crate::scroll_dynamics::SmoothScroll;
use neotavern_presentation_dioxus_shell::current_product_shell;

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
                    self.visual_scroll_css = offset.clamp(0.0, self.scroll_max_css);
                    self.smooth_scroll = Some(anim);
                }
                None => {
                    // The eased sample never returns the endpoint itself;
                    // the visual ends exactly on the target.
                    self.visual_scroll_css = anim.target().clamp(0.0, self.scroll_max_css);
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
            self.visual_scroll_css = self.visual_scroll_css.clamp(0.0, self.scroll_max_css);
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
    /// `scroll_chat_by`. The ack itself lands on the PRODUCED raster in
    /// `produce_and_render` — not here: while a produce is gated (live
    /// generation stream, 30/s cadence) the present must still blit the true
    /// `visual − presented` shift of the stale raster, so the offset must
    /// only rebase when the fresh raster actually exists. Without this the
    /// screen would freeze for up to one gate interval mid-stream.
    pub(super) fn land_scroll(&mut self, shift: f32) {
        if shift != 0.0 {
            self.session.scroll_chat_by(shift);
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

    /// One scroll step for the frame loop and the probe replay: sample the
    /// eased visual and land the session when the ack drift reaches the
    /// baked-runway cap. The overscan raster (`CHAT_OVERSCAN_CSS` strips and
    /// the neighbouring rows baked into the paint window) presents real rows
    /// on the leading edge while the drift stays inside the runway, so the
    /// 144fps blit fast path carries the gesture without the wallpaper
    /// filler strip that used to bound the cap at 96px. Mid-gesture produces
    /// happen only when the drift crosses the cap (a few per notch instead
    /// of one per quantized frame); once the gesture ends, any residual
    /// drift lands through the ack epsilon.
    pub(super) fn advance_and_land_scroll(&mut self) {
        self.advance_scroll_animations();
        if let Some(shift) = self
            .ack
            .due(self.visual_scroll_css, self.scroll_animation_active())
        {
            self.land_scroll(shift);
        }
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
        // Clamp the notch target to the content extent: the animation must
        // never aim past the newest row (the land would snap the overshoot
        // back — a visible jump at the bottom edge).
        let target = (self.visual_scroll_css + css_dy).clamp(0.0, self.scroll_max_css);
        let delta = target - self.visual_scroll_css;
        if delta.abs() <= f32::EPSILON {
            return;
        }
        match self.smooth_scroll.as_mut() {
            Some(anim) if anim.sample(now).is_some() => anim.retarget(delta, now),
            _ => {
                self.smooth_scroll =
                    Some(SmoothScroll::impulse(self.visual_scroll_css, delta, now));
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
        // Same single-geometry contract as the tap capture: the wheel routes
        // against the installed (painted) view, whose `panel_scroll_css`
        // matches the hit_rects extent below.
        let view = current_product_shell();
        if !(view.sidebar_open && view.panel == "characters") {
            return false;
        }
        let panel_x = crate::RAIL_WIDTH;
        let panel_w = self.session.panel_width();
        if css_x < panel_x || css_x >= panel_x + panel_w {
            return false;
        }
        // The scroller is the tab CONTENT root (`floating-tab-content`): it
        // hosts the cards list, the read-only character viewer, the editor
        // form and the advanced/gallery bodies alike. The root box is
        // clipped to the viewport — overflowing rows (greetings, chips,
        // cards, form fields) set the extent, and the applied offset must
        // be added back.
        let window_h = self.size.1 as f32 / self.density.max(1.0);
        let over_tab_body = self
            .hit_rects
            .covers(css_x, css_y, "part:floating-tab-content");
        if !over_tab_body {
            // Over the panel chrome (header, tabs, rail edge): consume the
            // notch — it must never reach the chat behind the panel.
            return true;
        }
        let extent_needle = "part:floating-tab-content";
        let max_offset = self
            .hit_rects
            .rects
            .iter()
            .find(|rect| rect.identity.contains(extent_needle))
            .map(|root| self.hit_rects.subtree_bottom(root) + view.panel_scroll_css - window_h)
            .filter(|max| *max > 0.0);
        match max_offset {
            // Over the tab body but nothing overflows: still consume.
            None => true,
            Some(max) => {
                if self.session.scroll_panel_by(css_dy, max) {
                    self.dirty = true;
                    self.window.as_ref().map(|w| w.request_redraw());
                }
                true
            }
        }
    }
}
