//! Recording `PaintScene` whose command order **is** the canonical paint order.

use std::sync::Arc;

use anyrender::{
    Filter, Glyph, HostNodeKind, HostNodeMarker, NormalizedCoord, PaintRef, PaintScene,
    RenderContext,
};
use kurbo::{Affine, Rect as KurboRect, Shape, Stroke, Vec2};
use neotavern_presentation_m0::display_list::Rect;
use peniko::{BlendMode, Color, Fill, FontData, StyleRef};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawKind {
    Fill,
    Stroke,
    Glyph,
    BoxShadow,
}

#[derive(Clone, Debug, PartialEq)]
pub enum StreamOp {
    Draw {
        kind: DrawKind,
        rect: Option<Rect>,
        fill_rgba: Option<(u8, u8, u8, u8)>,
    },
    PushLayer {
        alpha: f32,
        clip: bool,
    },
    PopLayer,
    Glass {
        node_id: u64,
        bounds: Rect,
    },
    Text(anyrender::HostTextFragment),
}

#[derive(Default)]
pub struct ProducerSink {
    pub ops: Vec<StreamOp>,
    pub max_ops: Option<u32>,
    pub(crate) counted: u32,
    pub(crate) skip_stack: Vec<bool>,
}

impl ProducerSink {
    fn admit(&mut self) -> bool {
        self.counted = self.counted.saturating_add(1);
        if let Some(max) = self.max_ops {
            if self.counted > max {
                return false;
            }
        }
        true
    }

    pub fn glass_ids(&self) -> Vec<u64> {
        self.ops
            .iter()
            .filter_map(|op| match op {
                StreamOp::Glass { node_id, .. } => Some(*node_id),
                _ => None,
            })
            .collect()
    }
}

impl RenderContext for ProducerSink {}

impl PaintScene for ProducerSink {
    fn reset(&mut self) {
        self.ops.clear();
        self.counted = 0;
        self.skip_stack.clear();
    }

    fn push_layer(
        &mut self,
        _blend: impl Into<BlendMode>,
        alpha: f32,
        _transform: Affine,
        _clip: &impl Shape,
        _filter: Option<Arc<Filter>>,
        _backdrop_filter: Option<Arc<Filter>>,
    ) {
        if !self.admit() {
            self.skip_stack.push(true);
            return;
        }
        self.ops.push(StreamOp::PushLayer { alpha, clip: false });
        self.skip_stack.push(false);
    }

    fn push_clip_layer(&mut self, _transform: Affine, _clip: &impl Shape) {
        if !self.admit() {
            self.skip_stack.push(true);
            return;
        }
        self.ops.push(StreamOp::PushLayer {
            alpha: 1.0,
            clip: true,
        });
        self.skip_stack.push(false);
    }

    fn pop_layer(&mut self) {
        self.counted = self.counted.saturating_add(1);
        if self.skip_stack.pop() == Some(true) {
            return;
        }
        self.ops.push(StreamOp::PopLayer);
    }

    fn stroke<'a>(
        &mut self,
        _style: &Stroke,
        _transform: Affine,
        _brush: impl Into<PaintRef<'a>>,
        _brush_transform: Option<Affine>,
        _shape: &impl Shape,
    ) {
        if !self.admit() {
            return;
        }
        self.ops.push(StreamOp::Draw {
            kind: DrawKind::Stroke,
            rect: Some(rect_of(
                _transform,
                _shape.bounding_box(),
                _style.width as f32,
            )),
            fill_rgba: paint_rgba(_brush),
        });
    }

    fn fill<'a>(
        &mut self,
        _style: Fill,
        _transform: Affine,
        _brush: impl Into<PaintRef<'a>>,
        _brush_transform: Option<Affine>,
        _shape: &impl Shape,
    ) {
        if !self.admit() {
            return;
        }
        self.ops.push(StreamOp::Draw {
            kind: DrawKind::Fill,
            rect: Some(rect_of(_transform, _shape.bounding_box(), 0.0)),
            fill_rgba: paint_rgba(_brush),
        });
    }

    fn draw_glyphs<'a, 's: 'a>(
        &'s mut self,
        _font: &'a FontData,
        _font_size: f32,
        _hint: bool,
        _normalized_coords: &'a [NormalizedCoord],
        _embolden: Vec2,
        _style: impl Into<StyleRef<'a>>,
        _brush: impl Into<PaintRef<'a>>,
        _brush_alpha: f32,
        _transform: Affine,
        _glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = Glyph> + Clone,
    ) {
        let _ = glyphs.count();
        if !self.admit() {
            return;
        }
        self.ops.push(StreamOp::Draw {
            kind: DrawKind::Glyph,
            rect: None,
            fill_rgba: None,
        });
    }

    fn draw_box_shadow(
        &mut self,
        _transform: Affine,
        _rect: KurboRect,
        _brush: Color,
        _radius: f64,
        _std_dev: f64,
    ) {
        if !self.admit() {
            return;
        }
        self.ops.push(StreamOp::Draw {
            kind: DrawKind::BoxShadow,
            rect: Some(rect_of(_transform, _rect, _radius.max(0.0) as f32)),
            fill_rgba: {
                let rgba = _brush.to_rgba8();
                Some((rgba.r, rgba.g, rgba.b, rgba.a))
            },
        });
    }

    fn host_node_marker(&mut self, marker: HostNodeMarker) {
        if marker.kind != HostNodeKind::Glass {
            return;
        }
        self.ops.push(StreamOp::Glass {
            node_id: marker.node_id,
            bounds: Rect::new(
                marker.bounds.x0 as f32,
                marker.bounds.y0 as f32,
                marker.bounds.width() as f32,
                marker.bounds.height() as f32,
            ),
        });
    }

    fn host_text_fragment(&mut self, fragment: anyrender::HostTextFragment) {
        self.ops.push(StreamOp::Text(fragment));
    }
}

/// Bounding box of a shape under a transform, plus half a stroke width so the
/// recorded rect covers the painted pixels. Diagnostic only.
fn rect_of(transform: Affine, bbox: kurbo::Rect, stroke_half: f32) -> Rect {
    let [a, b, c, d, e, f] = transform.as_coeffs();
    let pts = [
        (bbox.x0, bbox.y0),
        (bbox.x1, bbox.y0),
        (bbox.x0, bbox.y1),
        (bbox.x1, bbox.y1),
    ];
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for (x, y) in pts {
        let tx = a * x + c * y + e;
        let ty = b * x + d * y + f;
        min_x = min_x.min(tx);
        min_y = min_y.min(ty);
        max_x = max_x.max(tx);
        max_y = max_y.max(ty);
    }
    Rect::new(
        (min_x - f64::from(stroke_half)).max(0.0) as f32,
        (min_y - f64::from(stroke_half)).max(0.0) as f32,
        (max_x + f64::from(stroke_half)) as f32,
        (max_y + f64::from(stroke_half)) as f32,
    )
}

/// Best-effort RGBA of a brush; gradients/shaders come back as `None`.
fn paint_rgba<'a>(brush: impl Into<PaintRef<'a>>) -> Option<(u8, u8, u8, u8)> {
    match brush.into() {
        PaintRef::Solid(color) => {
            let rgba = color.to_rgba8();
            Some((rgba.r, rgba.g, rgba.b, rgba.a))
        }
        _ => None,
    }
}
