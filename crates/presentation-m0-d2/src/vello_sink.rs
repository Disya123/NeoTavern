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

pub struct VelloSink {
    pub scene: Scene,
}

impl VelloSink {
    pub fn new() -> Self {
        Self {
            scene: Scene::new(),
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
        let path = vpath(clip);
        self.scene
            .push_layer(Fill::NonZero, blend.into(), alpha, affine(transform), &path);
    }

    fn push_clip_layer(&mut self, transform: Affine, clip: &impl Shape) {
        let path = vpath(clip);
        self.scene.push_layer(
            Fill::NonZero,
            BlendMode::new(Mix::Normal, Compose::SrcOver),
            1.0,
            affine(transform),
            &path,
        );
    }

    fn pop_layer(&mut self) {
        self.scene.pop_layer();
    }

    fn stroke<'a>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        brush: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
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
