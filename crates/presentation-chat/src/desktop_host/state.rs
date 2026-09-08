//! Session/window construction for the desktop host (`App::new` and small
//! coordinate helpers).

use std::collections::VecDeque;

use super::{App, TextFocus};
use crate::scroll_ack::ScrollAckLoop;
use crate::{ChatSession, FakeWire, HitRects, DEMO_CHAT_ID};

impl App {
    pub(super) fn new(
        messages: u32,
        wire: Option<Box<dyn crate::wire::ProductWire>>,
        chat_id: Option<String>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let boxed: Box<dyn crate::wire::ProductWire> = match wire {
            Some(custom) => custom,
            None => Box::new(FakeWire::with_message_count(messages.max(1))),
        };
        let preferred = chat_id.unwrap_or_else(|| DEMO_CHAT_ID.to_string());
        let mut session = ChatSession::open(boxed, Some(&preferred))
            .map_err(|err| -> Box<dyn std::error::Error> { err.to_string().into() })?;
        let _ = session.mount_vdom();
        let _ = session.drain_stream();
        // Hydrate avatar thumbnails via `assets.content` so the GPU overlay on
        // the shared host has real pixels (Android parity).
        session.refresh_characters();
        let observed_scene_epoch = session.scene_epoch();
        Ok(Self {
            window: None,
            present: None,
            session,
            compositor: None,
            vello_session: None,
            size: (0, 0),
            density: 1.0,
            message_count: messages,
            dirty: true,
            observed_scene_epoch,
            snapshot_path: None,
            swap_path: None,
            dom_dump_path: None,
            retry_present: false,
            last_present_error: None,
            pending_ui: None,
            pending_custom: None,
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
            last_stream_produce: None,
            produce_deferred: false,
            pointer_css: (0.0, 0.0),
        })
    }

    /// CSS coordinates for a physical window position.
    pub(super) fn css_point(&self, physical_x: f64, physical_y: f64) -> (f32, f32) {
        let d = self.density.max(1.0);
        ((physical_x as f32) / d, (physical_y as f32) / d)
    }

    pub(super) fn ensure_viewport(&mut self) {
        self.session
            .set_surface_size(self.size.0.max(1), self.size.1, self.density);
    }
}
