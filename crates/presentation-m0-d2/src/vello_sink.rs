//! Blitz `PaintScene` that records into a Vello scene on the live GPU device.

use std::sync::Arc;

use anyrender::{
    Filter, Glyph, HostNodeMarker, HostTextFragment, NormalizedCoord, Paint, PaintRef, PaintScene,
    RenderContext,
};
use kurbo::{Affine, Rect as KurboRect, Shape, Stroke, Vec2};
use peniko::{BlendMode, Color, Compose, Fill, FontData, Mix, StyleRef};
use vello::peniko::kurbo as vkurbo;
use vello::Scene;

/// Which Blitz paint classes are encoded into the Vello scene.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VelloFilter {
    pub fills: bool,
    pub glyphs: bool,
    pub clips: bool,
    pub layers: bool,
    pub shadows: bool,
    pub max_ops: Option<u32>,
}

impl VelloFilter {
    pub fn full() -> Self {
        Self {
            fills: true,
            glyphs: true,
            clips: true,
            layers: true,
            shadows: true,
            max_ops: None,
        }
    }

    pub fn background() -> Self {
        Self {
            fills: false,
            glyphs: false,
            clips: false,
            layers: false,
            shadows: false,
            max_ops: None,
        }
    }

    pub fn rects() -> Self {
        Self {
            fills: true,
            glyphs: false,
            clips: false,
            layers: false,
            shadows: false,
            max_ops: None,
        }
    }

    pub fn with_max_ops(mut self, max_ops: u32) -> Self {
        self.max_ops = Some(max_ops);
        self
    }
}

/// Push/pop and clip sanity collected while encoding.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LayerDiag {
    pub ops: u32,
    pub push: u32,
    pub pop: u32,
    pub empty_clip: u32,
    pub non_finite: u32,
    pub skipped: u32,
    pub open: u32,
}

impl LayerDiag {
    pub fn balanced(&self) -> bool {
        self.push == self.pop && self.open == 0
    }

    pub fn line(&self) -> String {
        format!(
            "layer_diag ops={} push={} pop={} open={} empty_clip={} non_finite={} skipped={} balanced={}",
            self.ops,
            self.push,
            self.pop,
            self.open,
            self.empty_clip,
            self.non_finite,
            self.skipped,
            u8::from(self.balanced()),
        )
    }
}

pub struct VelloSink {
    pub scene: Scene,
    pub filter: VelloFilter,
    pub diag: LayerDiag,
    skip_stack: Vec<bool>,
}

impl VelloSink {
    pub fn new() -> Self {
        Self::with_filter(VelloFilter::full())
    }

    pub fn with_filter(filter: VelloFilter) -> Self {
        Self {
            scene: Scene::new(),
            filter,
            diag: LayerDiag::default(),
            skip_stack: Vec::new(),
        }
    }

    pub fn fill_canvas(&mut self, width: u32, height: u32) {
        self.scene.fill(
            Fill::NonZero,
            vkurbo::Affine::IDENTITY,
            Color::from_rgb8(0x15, 0x13, 0x11),
            None,
            &vkurbo::Rect::new(0.0, 0.0, f64::from(width), f64::from(height)),
        );
    }

    pub fn close_unbalanced_layers(&mut self) {
        while self.diag.open > 0 {
            self.scene.pop_layer();
            self.diag.open -= 1;
            self.diag.pop += 1;
        }
        self.skip_stack.clear();
    }

    fn admit_draw(&mut self) -> bool {
        self.diag.ops = self.diag.ops.saturating_add(1);
        if let Some(max) = self.filter.max_ops {
            if self.diag.ops > max {
                self.diag.skipped = self.diag.skipped.saturating_add(1);
                return false;
            }
        }
        true
    }

    fn transform_ok(&mut self, transform: Affine) -> bool {
        if transform.as_coeffs().iter().all(|c| c.is_finite()) {
            true
        } else {
            self.diag.non_finite = self.diag.non_finite.saturating_add(1);
            false
        }
    }

    fn clip_ok(&mut self, clip: &impl Shape) -> bool {
        let bb = clip.bounding_box();
        let empty = !bb.x0.is_finite()
            || !bb.y0.is_finite()
            || !bb.x1.is_finite()
            || !bb.y1.is_finite()
            || bb.x1 <= bb.x0
            || bb.y1 <= bb.y0;
        if empty {
            self.diag.empty_clip = self.diag.empty_clip.saturating_add(1);
            false
        } else {
            true
        }
    }
}

impl Default for VelloSink {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderContext for VelloSink {}

fn affine(transform: Affine) -> vkurbo::Affine {
    vkurbo::Affine::new(transform.as_coeffs())
}

fn vpath(shape: &impl Shape) -> vkurbo::BezPath {
    let src = shape.to_path(0.1);
    let mut out = vkurbo::BezPath::new();
    for el in src.elements() {
        match *el {
            kurbo::PathEl::MoveTo(p) => {
                out.move_to(vkurbo::Point::new(p.x, p.y));
            }
            kurbo::PathEl::LineTo(p) => {
                out.line_to(vkurbo::Point::new(p.x, p.y));
            }
            kurbo::PathEl::QuadTo(p1, p2) => {
                out.quad_to(
                    vkurbo::Point::new(p1.x, p1.y),
                    vkurbo::Point::new(p2.x, p2.y),
                );
            }
            kurbo::PathEl::CurveTo(p1, p2, p3) => {
                out.curve_to(
                    vkurbo::Point::new(p1.x, p1.y),
                    vkurbo::Point::new(p2.x, p2.y),
                    vkurbo::Point::new(p3.x, p3.y),
                );
            }
            kurbo::PathEl::ClosePath => out.close_path(),
        }
    }
    out
}

fn brush_ref(paint: PaintRef<'_>) -> Option<peniko::Brush> {
    match paint {
        Paint::Solid(color) => Some(peniko::Brush::Solid(color)),
        Paint::Gradient(gradient) => Some(peniko::Brush::Gradient(gradient.clone())),
        // Vello 0.9 Image brushes on Android Vulkan leave the whole
        // SurfaceView black (bind still reports success). Skip until a
        // sampled atlas path is proven. Header/card keep the clipped letter.
        Paint::Image(_) | Paint::Resource(_) | Paint::Custom(_) => None,
    }
}

impl PaintScene for VelloSink {
    fn reset(&mut self) {
        self.scene.reset();
        self.diag = LayerDiag::default();
        self.skip_stack.clear();
    }

    fn push_layer(
        &mut self,
        blend: impl Into<BlendMode>,
        alpha: f32,
        transform: Affine,
        clip: &impl Shape,
        _filter: Option<Arc<Filter>>,
        _backdrop_filter: Option<Arc<Filter>>,
    ) {
        if !self.admit_draw() || !self.filter.layers {
            self.skip_stack.push(true);
            return;
        }
        if !self.transform_ok(transform) || !self.clip_ok(clip) {
            self.skip_stack.push(true);
            return;
        }
        let path = vpath(clip);
        self.scene
            .push_layer(Fill::NonZero, blend.into(), alpha, affine(transform), &path);
        self.skip_stack.push(false);
        self.diag.push = self.diag.push.saturating_add(1);
        self.diag.open = self.diag.open.saturating_add(1);
    }

    fn push_clip_layer(&mut self, transform: Affine, clip: &impl Shape) {
        if !self.admit_draw() || !self.filter.clips {
            self.skip_stack.push(true);
            return;
        }
        if !self.transform_ok(transform) || !self.clip_ok(clip) {
            self.skip_stack.push(true);
            return;
        }
        let path = vpath(clip);
        self.scene.push_layer(
            Fill::NonZero,
            BlendMode::new(Mix::Normal, Compose::SrcOver),
            1.0,
            affine(transform),
            &path,
        );
        self.skip_stack.push(false);
        self.diag.push = self.diag.push.saturating_add(1);
        self.diag.open = self.diag.open.saturating_add(1);
    }

    fn pop_layer(&mut self) {
        self.diag.ops = self.diag.ops.saturating_add(1);
        if self.skip_stack.pop() == Some(true) {
            return;
        }
        self.scene.pop_layer();
        self.diag.pop = self.diag.pop.saturating_add(1);
        self.diag.open = self.diag.open.saturating_sub(1);
    }

    fn stroke<'a>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        brush: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        if !self.admit_draw() || !self.filter.fills || !self.transform_ok(transform) {
            return;
        }
        let Some(brush) = brush_ref(brush.into()) else {
            return;
        };
        let path = vpath(shape);
        self.scene.stroke(
            style,
            affine(transform),
            &brush,
            brush_transform.map(affine),
            &path,
        );
    }

    fn fill<'a>(
        &mut self,
        style: Fill,
        transform: Affine,
        brush: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        if !self.admit_draw() || !self.filter.fills || !self.transform_ok(transform) {
            return;
        }
        let Some(brush) = brush_ref(brush.into()) else {
            return;
        };
        let path = vpath(shape);
        self.scene.fill(
            style,
            affine(transform),
            &brush,
            brush_transform.map(affine),
            &path,
        );
    }

    fn draw_glyphs<'a, 's: 'a>(
        &'s mut self,
        font: &'a FontData,
        font_size: f32,
        hint: bool,
        normalized_coords: &'a [NormalizedCoord],
        _embolden: Vec2,
        style: impl Into<StyleRef<'a>>,
        brush: impl Into<PaintRef<'a>>,
        brush_alpha: f32,
        transform: Affine,
        glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = Glyph> + Clone,
    ) {
        if !self.admit_draw() || !self.filter.glyphs || !self.transform_ok(transform) {
            return;
        }
        let Some(brush) = brush_ref(brush.into()) else {
            return;
        };
        let style = style.into();
        self.scene
            .draw_glyphs(font)
            .font_size(font_size)
            .hint(hint)
            .normalized_coords(normalized_coords)
            .transform(affine(transform))
            .glyph_transform(glyph_transform.map(affine))
            .brush(&brush)
            .brush_alpha(brush_alpha)
            .draw(
                style,
                glyphs.map(|glyph| vello::Glyph {
                    id: glyph.id,
                    x: glyph.x,
                    y: glyph.y,
                }),
            );
    }

    fn draw_box_shadow(
        &mut self,
        transform: Affine,
        rect: KurboRect,
        brush: Color,
        radius: f64,
        std_dev: f64,
    ) {
        if !self.admit_draw() || !self.filter.shadows || !self.transform_ok(transform) {
            return;
        }
        if !rect.x0.is_finite()
            || !rect.y0.is_finite()
            || !rect.x1.is_finite()
            || !rect.y1.is_finite()
        {
            self.diag.non_finite = self.diag.non_finite.saturating_add(1);
            return;
        }
        self.scene.draw_blurred_rounded_rect(
            affine(transform),
            vkurbo::Rect::new(rect.x0, rect.y0, rect.x1, rect.y1),
            brush,
            radius,
            std_dev,
        );
    }

    fn host_node_marker(&mut self, _marker: HostNodeMarker) {}

    fn host_text_fragment(&mut self, _fragment: HostTextFragment) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_filter_is_balanced_when_empty() {
        let sink = VelloSink::new();
        assert!(sink.diag.balanced());
        assert_eq!(sink.filter, VelloFilter::full());
    }

    #[test]
    fn background_filter_disables_draw_classes() {
        let filter = VelloFilter::background();
        assert!(
            !filter.fills && !filter.glyphs && !filter.clips && !filter.layers && !filter.shadows
        );
    }
}
