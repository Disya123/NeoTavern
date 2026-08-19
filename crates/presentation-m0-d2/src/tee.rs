//! Forwards one Blitz paint traversal into two `PaintScene` sinks.

use std::sync::Arc;

use anyrender::{
    Filter, Glyph, HostNodeMarker, HostTextFragment, NormalizedCoord, PaintRef, PaintScene,
    RenderContext, Scene,
};
use kurbo::{Affine, Rect as KurboRect, Shape, Stroke, Vec2};
use peniko::{BlendMode, Color, Fill, FontData, StyleRef};

pub struct TeeSink<'a, A, B> {
    pub a: &'a mut A,
    pub b: &'a mut B,
}

impl<A: RenderContext, B: RenderContext> RenderContext for TeeSink<'_, A, B> {}

impl<A: PaintScene, B: PaintScene> PaintScene for TeeSink<'_, A, B> {
    fn reset(&mut self) {
        self.a.reset();
        self.b.reset();
    }

    fn push_layer(
        &mut self,
        blend: impl Into<BlendMode>,
        alpha: f32,
        transform: Affine,
        clip: &impl Shape,
        filter: Option<Arc<Filter>>,
        backdrop_filter: Option<Arc<Filter>>,
    ) {
        let blend = blend.into();
        self.a.push_layer(
            blend,
            alpha,
            transform,
            clip,
            filter.clone(),
            backdrop_filter.clone(),
        );
        self.b
            .push_layer(blend, alpha, transform, clip, filter, backdrop_filter);
    }

    fn push_clip_layer(&mut self, transform: Affine, clip: &impl Shape) {
        self.a.push_clip_layer(transform, clip);
        self.b.push_clip_layer(transform, clip);
    }

    fn pop_layer(&mut self) {
        self.a.pop_layer();
        self.b.pop_layer();
    }

    fn stroke<'a>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        brush: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let brush = brush.into();
        self.a
            .stroke(style, transform, brush.clone(), brush_transform, shape);
        self.b
            .stroke(style, transform, brush, brush_transform, shape);
    }

    fn fill<'a>(
        &mut self,
        style: Fill,
        transform: Affine,
        brush: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let brush = brush.into();
        self.a
            .fill(style, transform, brush.clone(), brush_transform, shape);
        self.b.fill(style, transform, brush, brush_transform, shape);
    }

    fn draw_glyphs<'a, 's: 'a>(
        &'s mut self,
        font: &'a FontData,
        font_size: f32,
        hint: bool,
        normalized_coords: &'a [NormalizedCoord],
        embolden: Vec2,
        style: impl Into<StyleRef<'a>>,
        brush: impl Into<PaintRef<'a>>,
        brush_alpha: f32,
        transform: Affine,
        glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = Glyph> + Clone,
    ) {
        let style = style.into();
        let brush = brush.into();
        let glyphs: Vec<Glyph> = glyphs.collect();
        self.a.draw_glyphs(
            font,
            font_size,
            hint,
            normalized_coords,
            embolden,
            style,
            brush.clone(),
            brush_alpha,
            transform,
            glyph_transform,
            glyphs.iter().copied(),
        );
        self.b.draw_glyphs(
            font,
            font_size,
            hint,
            normalized_coords,
            embolden,
            style,
            brush,
            brush_alpha,
            transform,
            glyph_transform,
            glyphs.into_iter(),
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
        self.a
            .draw_box_shadow(transform, rect, brush, radius, std_dev);
        self.b
            .draw_box_shadow(transform, rect, brush, radius, std_dev);
    }

    fn host_node_marker(&mut self, marker: HostNodeMarker) {
        self.a.host_node_marker(marker);
        self.b.host_node_marker(marker);
    }

    fn host_text_fragment(&mut self, fragment: HostTextFragment) {
        self.a.host_text_fragment(fragment.clone());
        self.b.host_text_fragment(fragment);
    }

    fn append_scene(&mut self, scene: Scene, scene_transform: Affine) {
        self.a.append_scene(scene.clone(), scene_transform);
        self.b.append_scene(scene, scene_transform);
    }
}
