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
    Draw { kind: DrawKind },
    PushLayer { alpha: f32, clip: bool },
    PopLayer,
    Glass { node_id: u64, bounds: Rect },
    Text(anyrender::HostTextFragment),
}

#[derive(Default)]
pub struct ProducerSink {
    pub ops: Vec<StreamOp>,
}

impl ProducerSink {
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
        self.ops.push(StreamOp::PushLayer { alpha, clip: false });
    }

    fn push_clip_layer(&mut self, _transform: Affine, _clip: &impl Shape) {
        self.ops.push(StreamOp::PushLayer {
            alpha: 1.0,
            clip: true,
        });
    }

    fn pop_layer(&mut self) {
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
        self.ops.push(StreamOp::Draw {
            kind: DrawKind::Stroke,
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
        self.ops.push(StreamOp::Draw {
            kind: DrawKind::Fill,
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
        self.ops.push(StreamOp::Draw {
            kind: DrawKind::Glyph,
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
        self.ops.push(StreamOp::Draw {
            kind: DrawKind::BoxShadow,
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
