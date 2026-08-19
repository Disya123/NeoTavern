//! Live Product Wire → Dioxus → Blitz → presentation-session bind.
//!
//! CPU compositor session. GPU present lives in `android_surface` (Android).
//! `compositor_scroll_tick` must not call Dioxus or Blitz.

use neotavern_chat_viewport::{HeightIndex, PredictorBudgets, TileCache, ViewportSession};
use neotavern_neocompositor::PresentationTime;
use neotavern_presentation_dioxus_shell::{
    chrome_metrics, install_product_chat, product_chat_app, ProductChatView,
};
use neotavern_presentation_m0_d2::{produce_app_at, ProducerOutput};
use neotavern_presentation_session::PresentationSession;

pub struct ChatCompositor {
    pub session: PresentationSession,
    pub width: f32,
    pub height: f32,
    pub layout_rebuilds: u64,
    pub paint_rebuilds: u64,
    pub composite_only_frames: u64,
    pub layout_rebuilds_on_scroll: u64,
    pub paint_rebuilds_on_scroll: u64,
    scrolling: bool,
}

impl ChatCompositor {
    pub fn open(
        view: &ProductChatView,
        heights: HeightIndex,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let produced = rebuild_producer(view, width, height)?;
        Ok(Self::from_list(heights, width, height, produced.list))
    }

    pub fn from_list(
        heights: HeightIndex,
        width: u32,
        height: u32,
        list: neotavern_neocompositor::NeoDisplayList,
    ) -> Self {
        Self::from_list_scaled(heights, width, height, list, 1.0)
    }

    pub fn from_list_scaled(
        heights: HeightIndex,
        width: u32,
        height: u32,
        list: neotavern_neocompositor::NeoDisplayList,
        scale: f32,
    ) -> Self {
        let scale = scale.max(1.0);
        let css_w = ((width as f32) / scale).round().max(1.0) as u32;
        let css_h = ((height as f32) / scale).round().max(1.0) as u32;
        let (_, _, viewport_h, _) = chrome_metrics(css_w, css_h);
        let viewport_px = f64::from(viewport_h.max(1)) * f64::from(scale);
        let mut session = PresentationSession::new(
            viewport_from_index(heights, viewport_px),
            width as f32,
            height as f32,
        );
        session.bind_producer_scene(list);
        let _ = session.publish();
        Self {
            session,
            width: width as f32,
            height: height as f32,
            layout_rebuilds: 1,
            paint_rebuilds: 1,
            composite_only_frames: 0,
            layout_rebuilds_on_scroll: 0,
            paint_rebuilds_on_scroll: 0,
            scrolling: false,
        }
    }

    pub fn bind_list(&mut self, list: neotavern_neocompositor::NeoDisplayList) {
        self.session.bind_producer_scene(list);
        let _ = self.session.publish();
        self.layout_rebuilds = self.layout_rebuilds.saturating_add(1);
        self.paint_rebuilds = self.paint_rebuilds.saturating_add(1);
        if self.scrolling {
            self.layout_rebuilds_on_scroll = self.layout_rebuilds_on_scroll.saturating_add(1);
            self.paint_rebuilds_on_scroll = self.paint_rebuilds_on_scroll.saturating_add(1);
        }
    }

    pub fn note_scroll(&mut self, scrolling: bool) {
        self.scrolling = scrolling;
    }

    pub fn is_scrolling(&self) -> bool {
        self.scrolling
    }

    pub fn rebuild(&mut self, view: &ProductChatView) -> Result<ProducerOutput, String> {
        let produced = rebuild_producer(
            view,
            self.width.max(1.0) as u32,
            self.height.max(1.0) as u32,
        )?;
        self.session.bind_producer_scene(produced.list.clone());
        let _ = self.session.publish();
        self.layout_rebuilds = self.layout_rebuilds.saturating_add(1);
        self.paint_rebuilds = self.paint_rebuilds.saturating_add(1);
        if self.scrolling {
            self.layout_rebuilds_on_scroll = self.layout_rebuilds_on_scroll.saturating_add(1);
            self.paint_rebuilds_on_scroll = self.paint_rebuilds_on_scroll.saturating_add(1);
        }
        Ok(produced)
    }

    pub fn compositor_tick(&mut self, velocity: f64, dt_ns: u64, time: PresentationTime) -> f64 {
        let (offset, _) = self.session.compositor_scroll_tick(velocity, dt_ns, time);
        self.composite_only_frames = self.composite_only_frames.saturating_add(1);
        offset
    }

    pub fn telemetry_line(&self) -> String {
        format!(
            "composite_only_frames={} layout_rebuilds_on_scroll={} paint_rebuilds_on_scroll={} layout_rebuilds={} paint_rebuilds={}",
            self.composite_only_frames,
            self.layout_rebuilds_on_scroll,
            self.paint_rebuilds_on_scroll,
            self.layout_rebuilds,
            self.paint_rebuilds,
        )
    }
}

pub fn rebuild_producer(
    view: &ProductChatView,
    width: u32,
    height: u32,
) -> Result<ProducerOutput, String> {
    install_product_chat(view.clone());
    produce_app_at(product_chat_app, width, height)
}

fn viewport_from_index(index: HeightIndex, viewport_h: f64) -> ViewportSession {
    let mut vp = ViewportSession::new(
        index,
        PredictorBudgets::default(),
        TileCache::new(256, 4 * 1024 * 1024),
        viewport_h.max(1.0),
        8_333_333,
    );
    let extent = vp.index().extent();
    vp.teleport((extent - viewport_h).max(0.0));
    let _ = vp.present();
    vp
}
