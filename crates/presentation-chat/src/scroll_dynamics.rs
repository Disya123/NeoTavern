//! Shared scroll dynamics for the native hosts (Android surface + desktop
//! winit host). Both hosts must stay identical at the core: the fling-decay
//! constants tuned on the Android vsync loop and the wheel smooth-scroll
//! curve live here. Hosts only map platform input to impulses and choose
//! where the deltas land (compositor fast path on Android,
//! `ChatSession::scroll_chat_by` on desktop).

/// Velocity decay per 60 Hz vsync tick (the Android feather-glide tuning).
pub const GLIDE_DECAY_PER_TICK: f64 = 0.94;
/// A glide below this velocity (CSS px/s) has stopped.
pub const GLIDE_STOP_VELOCITY: f64 = 12.0;
/// The vsync tick the glide constants were tuned at (60 Hz, ns).
pub const GLIDE_TICK_NS: u64 = 8_333_333;

/// Decays the glide velocity after the frame applied it. Returns the velocity
/// for the next frame (0 once below the stop threshold). `dt_ns` scales the
/// per-tick decay exponent so hosts ticking at other frame rates decay at the
/// same physical rate; at exactly [`GLIDE_TICK_NS`] this multiplies by
/// [`GLIDE_DECAY_PER_TICK`] with no floating-point detour, keeping the Android
/// host bit-identical to its previous inline `*= 0.94`.
pub fn glide_decay(velocity_px_s: f64, dt_ns: u64) -> f64 {
    let decayed = if dt_ns == GLIDE_TICK_NS {
        velocity_px_s * GLIDE_DECAY_PER_TICK
    } else {
        let ticks = dt_ns as f64 / GLIDE_TICK_NS as f64;
        velocity_px_s * GLIDE_DECAY_PER_TICK.powf(ticks)
    };
    if decayed.abs() < GLIDE_STOP_VELOCITY {
        0.0
    } else {
        decayed
    }
}

/// Whether a glide velocity still drives frames. Mirrors the Android host's
/// `is_scrolling` check (strictly greater than the stop threshold).
pub fn glide_active(velocity_px_s: f64) -> bool {
    velocity_px_s.abs() > GLIDE_STOP_VELOCITY
}

/// Wheel-notch smooth-scroll duration (~7 frames at 60 Hz, Chromium-like).
pub const SMOOTH_WHEEL_DURATION_NS: u64 = 120_000_000;

/// Eased target animation for discrete scroll input (wheel notches). Sampled
/// by absolute monotonic nanoseconds so hosts can drive it from vsync,
/// `about_to_wait`, or a deterministic probe clock. Content bounds are the
/// host's concern: apply the sampled deltas through the same clamped scroll
/// path the platform's direct input uses.
#[derive(Clone, Copy, Debug)]
pub struct SmoothScroll {
    from_css: f32,
    to_css: f32,
    start_ns: u64,
    duration_ns: u64,
}

impl SmoothScroll {
    /// Starts an animation from the current visual offset toward
    /// `current + delta_css`.
    pub fn impulse(current_offset_css: f32, delta_css: f32, now_ns: u64) -> Self {
        Self {
            from_css: current_offset_css,
            to_css: current_offset_css + delta_css,
            start_ns: now_ns,
            duration_ns: SMOOTH_WHEEL_DURATION_NS,
        }
    }

    /// Chains a new notch mid-flight: continues from the currently sampled
    /// position toward `target + delta_css`, restarting the clock. After the
    /// animation finished (`sample` returned `None`), prefer a fresh
    /// [`SmoothScroll::impulse`] from the session's authoritative offset.
    pub fn retarget(&mut self, delta_css: f32, now_ns: u64) {
        self.from_css = self.offset_at(now_ns);
        self.to_css += delta_css;
        self.start_ns = now_ns;
    }

    /// The scroll offset at `now_ns`, or `None` once the animation is over —
    /// the caller then lands exactly on [`SmoothScroll::target`] (the eased
    /// sample never returns the endpoint itself).
    pub fn sample(&self, now_ns: u64) -> Option<f32> {
        if now_ns >= self.start_ns.saturating_add(self.duration_ns) {
            None
        } else {
            Some(self.offset_at(now_ns))
        }
    }

    /// The offset this animation ends on.
    pub fn target(&self) -> f32 {
        self.to_css
    }
}

impl SmoothScroll {
    fn offset_at(&self, now_ns: u64) -> f32 {
        let t = if self.duration_ns == 0 {
            1.0
        } else {
            (now_ns.saturating_sub(self.start_ns)) as f64 / self.duration_ns as f64
        };
        self.from_css + (self.to_css - self.from_css) * ease_out_cubic(t) as f32
    }
}

/// Cubic ease-out: fast start, gentle landing — the standard wheel-scroll feel.
pub fn ease_out_cubic(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Android host applied `v *= 0.94` at its fixed vsync tick; the
    /// shared decay must reproduce those numbers exactly so both hosts stay
    /// one core, not two look-alikes.
    #[test]
    fn glide_decay_matches_android_host_constants() {
        // The exact product (no powf detour) at the tuned tick — compare
        // against the same expression so bit-equality is the contract.
        assert_eq!(
            glide_decay(1000.0, GLIDE_TICK_NS),
            1000.0 * GLIDE_DECAY_PER_TICK
        );
        assert_eq!(
            glide_decay(-500.0, GLIDE_TICK_NS),
            -500.0 * GLIDE_DECAY_PER_TICK
        );
        // Below-threshold velocities stop. 12.0 itself decays to 11.28 and
        // stops too — the threshold applies to the decayed value, as in the
        // host's `v *= 0.94; if v.abs() < 12 { 0 }` sequence.
        assert_eq!(glide_decay(11.9, GLIDE_TICK_NS), 0.0);
        assert_eq!(glide_decay(-4.0, GLIDE_TICK_NS), 0.0);
        assert_eq!(glide_decay(12.0, GLIDE_TICK_NS), 0.0);
        assert_eq!(
            glide_decay(12.8, GLIDE_TICK_NS),
            12.8 * GLIDE_DECAY_PER_TICK
        );
    }

    #[test]
    fn glide_decay_scales_with_frame_time() {
        let two_ticks = glide_decay(1000.0, 2 * GLIDE_TICK_NS);
        assert!((two_ticks - 883.6).abs() < 1e-9, "got {two_ticks}");
        let half_tick = glide_decay(1000.0, GLIDE_TICK_NS / 2);
        assert!((half_tick - 969.5).abs() < 0.1, "got {half_tick}");
    }

    #[test]
    fn glide_active_mirrors_android_is_scrolling() {
        assert!(glide_active(12.5));
        assert!(glide_active(-13.0));
        assert!(!glide_active(12.0));
        assert!(!glide_active(0.0));
    }

    #[test]
    fn smooth_scroll_lands_exactly_on_target() {
        let anim = SmoothScroll::impulse(0.0, 40.0, 1_000);
        assert_eq!(anim.sample(1_000), Some(0.0));
        let mut last = 0.0f32;
        for step in 1..=15 {
            let now = 1_000 + step * 8_000_000;
            match anim.sample(now) {
                Some(offset) => {
                    assert!(offset >= last, "ease-out must not reverse");
                    last = offset;
                }
                None => {
                    assert_eq!(step, 15, "finishes exactly at the 120 ms mark");
                    assert_eq!(anim.target(), 40.0);
                }
            }
        }
        assert!(last < 40.0, "eased samples never reach the endpoint");
        assert_eq!(anim.target(), 40.0);
    }

    #[test]
    fn smooth_scroll_retarget_chains_from_current_position() {
        let mut anim = SmoothScroll::impulse(0.0, 40.0, 0);
        let mid = anim.sample(60_000_000).expect("mid-flight sample");
        anim.retarget(40.0, 60_000_000);
        assert_eq!(anim.target(), 80.0);
        let resumed = anim.sample(60_000_000).expect("retarget stays live");
        assert_eq!(resumed, mid, "retarget continues from the sampled offset");
        // The chained run lands on 80 exactly at its own 120 ms mark.
        assert_eq!(anim.sample(180_000_000), None);
        assert_eq!(anim.target(), 80.0);
    }

    #[test]
    fn smooth_scroll_eases_out() {
        let anim = SmoothScroll::impulse(0.0, 90.0, 0);
        let first = anim.sample(30_000_000).expect("t=25%");
        let second = anim.sample(60_000_000).expect("t=50%");
        let third = anim.sample(90_000_000).expect("t=75%");
        let step_down = (second - first) > (third - second);
        assert!(
            step_down,
            "per-frame travel must shrink: {first} {second} {third}"
        );
    }
}
