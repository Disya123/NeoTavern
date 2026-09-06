//! Shared fast-path scroll ack-loop: mailbox → ack → re-produce with window
//! advancement.
//!
//! While a scroll gesture runs, both hosts present a raster that was produced
//! for an older content window and shift it (blit window / compositor fast
//! path). The drift between the visual offset and the produced window must
//! not grow unbounded: when it reaches the cap (half the chat band), the host
//! advances the product window (`ChatSession::scroll_chat_by`), re-produces,
//! and rebases the fast path onto the new window (kernel `ack`). This module
//! owns that drift accounting so the desktop winit host and the Android JNI
//! host run the identical policy; only input and present plumbing is
//! host-specific.
//!
//! Units are CSS px on both hosts; hosts convert to physical px at the
//! present boundary.

/// Drift accounting for the fast-path scroll ack-loop.
///
/// Invariant: `presented_css` is the content window offset the
/// currently-presented raster was produced at. The host updates it exactly
/// once per landed raster via [`ScrollAckLoop::land`].
#[derive(Clone, Copy, Debug)]
pub struct ScrollAckLoop {
    presented_css: f32,
    cap_css: f32,
    /// Window advance in flight: the product state was already advanced to
    /// this offset, the re-produced raster has not landed yet. While set, no
    /// further advance is decided (one produce per ack).
    in_flight: Option<f32>,
}

/// Floor for the drift cap so a degenerate chrome band (overlay frames
/// report zero-height bands) cannot turn every frame into a re-produce.
pub const MIN_ACK_CAP_CSS: f32 = 24.0;

/// Drift below this is treated as landed (final landing must not re-produce
/// for sub-pixel residue).
pub const LANDED_EPSILON_CSS: f32 = 0.5;

impl ScrollAckLoop {
    pub fn new(presented_css: f32) -> Self {
        Self {
            presented_css,
            cap_css: f32::INFINITY,
            in_flight: None,
        }
    }

    /// Content window offset the currently-presented raster was produced at.
    pub fn presented(&self) -> f32 {
        self.presented_css
    }

    /// Rebase on a landed raster: the present path swapped in a frame
    /// produced for `window_css`. Completes any in-flight advance.
    pub fn land(&mut self, window_css: f32) {
        self.presented_css = window_css;
        self.in_flight = None;
    }

    pub fn set_cap(&mut self, cap_css: f32) {
        self.cap_css = cap_css.max(MIN_ACK_CAP_CSS);
    }

    pub fn cap(&self) -> f32 {
        self.cap_css
    }

    /// Visual offset minus the presented window: what the blit shift / fast
    /// path unacked delta should display right now.
    pub fn drift(&self, visual_css: f32) -> f32 {
        visual_css - self.presented_css
    }

    /// Window-advance decision for the current frame.
    ///
    /// While the gesture is active the checkerboard cap applies (the frozen
    /// raster may lead by at most half a band); once it is not, any residual
    /// drift is a final landing. `None` while an advance is already in
    /// flight, and for a zero drift.
    pub fn due(&self, visual_css: f32, gesture_active: bool) -> Option<f32> {
        if self.in_flight.is_some() {
            return None;
        }
        let drift = self.drift(visual_css);
        if drift == 0.0 {
            return None;
        }
        if gesture_active {
            (drift.abs() >= self.cap_css).then_some(drift)
        } else {
            (drift.abs() > LANDED_EPSILON_CSS).then_some(drift)
        }
    }

    /// Record the advance decision: the host applies `in_flight_shift()` to
    /// the product window and re-produces.
    pub fn begin_advance(&mut self, target_css: f32) {
        self.in_flight = Some(target_css);
    }

    /// Shift the host still has to apply to the product window
    /// (`target - presented`), if an advance is in flight.
    pub fn in_flight_shift(&self) -> Option<f32> {
        self.in_flight.map(|target| target - self.presented_css)
    }

    /// Target of the in-flight advance, if any.
    pub fn in_flight_target(&self) -> Option<f32> {
        self.in_flight
    }

    pub fn advance_pending(&self) -> bool {
        self.in_flight.is_some()
    }

    /// Drop the in-flight marker without landing (produce failed). The drift
    /// stays visible so the next frame re-decides against the unchanged
    /// raster.
    pub fn cancel_advance(&mut self) {
        self.in_flight = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{LANDED_EPSILON_CSS, MIN_ACK_CAP_CSS, ScrollAckLoop};

    #[test]
    fn cap_cross_decides_only_past_half_band() {
        let mut loop_ = ScrollAckLoop::new(0.0);
        loop_.set_cap(200.0);
        assert_eq!(loop_.cap(), 200.0);
        assert_eq!(loop_.due(199.0, true), None);
        let shift = loop_.due(200.0, true).expect("cap crossed");
        assert_eq!(shift, 200.0);
        loop_.begin_advance(200.0);
        // One produce per ack: no second decision until the raster lands.
        assert_eq!(loop_.due(260.0, true), None);
        assert_eq!(loop_.in_flight_shift(), Some(200.0));
        loop_.land(200.0);
        assert_eq!(loop_.presented(), 200.0);
        assert_eq!(loop_.drift(260.0), 60.0);
        assert!(!loop_.advance_pending());
    }

    #[test]
    fn inactive_gesture_lands_residual_drift() {
        let mut loop_ = ScrollAckLoop::new(0.0);
        loop_.set_cap(200.0);
        // Below the cap an active gesture does not advance…
        assert_eq!(loop_.due(120.0, true), None);
        // …but once the gesture ends the residual drift lands.
        assert_eq!(loop_.due(120.0, false), Some(120.0));
        loop_.begin_advance(120.0);
        loop_.land(120.0);
        assert_eq!(loop_.due(120.0, false), None, "landed drift is zero");
    }

    #[test]
    fn sub_pixel_residue_and_negative_drift_are_honest() {
        let mut loop_ = ScrollAckLoop::new(0.0);
        loop_.set_cap(200.0);
        assert_eq!(loop_.due(LANDED_EPSILON_CSS / 2.0, false), None);
        loop_.land(300.0);
        // Visual below the presented window (scroll back towards the top):
        // the shift is negative and still lands.
        assert_eq!(loop_.due(240.0, false), Some(-60.0));
    }

    #[test]
    fn degenerate_cap_is_floored() {
        let mut loop_ = ScrollAckLoop::new(0.0);
        loop_.set_cap(0.0);
        assert_eq!(loop_.cap(), MIN_ACK_CAP_CSS);
        assert_eq!(loop_.due(10.0, true), None, "floor keeps idle frames idle");
        loop_.set_cap(f32::NEG_INFINITY);
        assert_eq!(loop_.cap(), MIN_ACK_CAP_CSS);
    }

    #[test]
    fn cancel_reopens_decisions_against_the_unchanged_raster() {
        let mut loop_ = ScrollAckLoop::new(0.0);
        loop_.set_cap(100.0);
        loop_.begin_advance(150.0);
        loop_.cancel_advance();
        assert!(!loop_.advance_pending());
        assert_eq!(loop_.in_flight_shift(), None);
        assert_eq!(loop_.presented(), 0.0);
        assert_eq!(loop_.due(150.0, true), Some(150.0));
    }

    #[test]
    fn clamp_at_top_keeps_presented_and_visual_together() {
        let mut loop_ = ScrollAckLoop::new(0.0);
        loop_.set_cap(100.0);
        loop_.begin_advance(80.0);
        // scroll_chat_by clamps at 0 — the produced window is 0, not the
        // negative target; land records the real window.
        loop_.land(0.0);
        assert_eq!(loop_.presented(), 0.0);
        assert_eq!(loop_.due(0.0, false), None);
        assert_eq!(loop_.drift(0.0), 0.0);
    }
}
