//! Routes one Blitz paint traversal into the content scene or one of the
//! chrome scenes, driven by the painter's `set_chrome_route` toggles at
//! `chrome-block` subtree roots (NeoCompositor chrome split: the fixed
//! header/composer must not bake into the desktop overscan raster's
//! scroll-band sample space).

use std::cell::Cell;

use anyrender::{
    ChromeRoute, Filter, Glyph, HostNodeMarker, HostTextFragment, NormalizedCoord, PaintRef,
    PaintScene, RenderContext, Scene,
};
use kurbo::{Affine, Shape, Stroke};
use peniko::{BlendMode, Fill, FontData, StyleRef};

pub struct ChromeRouterSink<'a, M, H, C> {
    pub main: &'a mut M,
    pub header: &'a mut H,
    pub composer: &'a mut C,
    pub route: Cell<ChromeRoute>,
}

impl<M: RenderContext, H: RenderContext, C: RenderContext> RenderContext
    for ChromeRouterSink<'_, M, H, C>
{
}

impl<M: PaintScene, H: PaintScene, C: PaintScene> PaintScene for ChromeRouterSink<'_, M, H, C> {
    fn reset(&mut self) {
        match self.route.get() {
            ChromeRoute::Main => self.main.reset(),
            ChromeRoute::Header => self.header.reset(),
            ChromeRoute::Composer => self.composer.reset(),
        }
    }

    fn set_chrome_route(&mut self, route: ChromeRoute) {
        self.route.set(route);
    }

    fn push_layer(
        &mut self,
        blend: impl Into<BlendMode>,
        alpha: f32,
        transform: Affine,
        clip: &impl Shape,
        filter: Option<std::sync::Arc<Filter>>,
        backdrop_filter: Option<std::sync::Arc<Filter>>,
    ) {
        match self.route.get() {
            ChromeRoute::Main => {
                self.main
                    .push_layer(blend, alpha, transform, clip, filter, backdrop_filter)
            }
            ChromeRoute::Header => {
                self.header
                    .push_layer(blend, alpha, transform, clip, filter, backdrop_filter)
            }
            ChromeRoute::Composer => {
                self.composer
                    .push_layer(blend, alpha, transform, clip, filter, backdrop_filter)
            }
        }
    }

    fn push_clip_layer(&mut self, transform: Affine, clip: &impl Shape) {
        match self.route.get() {
            ChromeRoute::Main => self.main.push_clip_layer(transform, clip),
            ChromeRoute::Header => self.header.push_clip_layer(transform, clip),
            ChromeRoute::Composer => self.composer.push_clip_layer(transform, clip),
        }
    }

    fn pop_layer(&mut self) {
        match self.route.get() {
            ChromeRoute::Main => self.main.pop_layer(),
            ChromeRoute::Header => self.header.pop_layer(),
            ChromeRoute::Composer => self.composer.pop_layer(),
        }
    }

    fn stroke<'a>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        brush: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        match self.route.get() {
            ChromeRoute::Main => self
                .main
                .stroke(style, transform, brush, brush_transform, shape),
            ChromeRoute::Header => {
                self.header
                    .stroke(style, transform, brush, brush_transform, shape)
            }
            ChromeRoute::Composer => {
                self.composer
                    .stroke(style, transform, brush, brush_transform, shape)
            }
        }
    }

    fn fill<'a>(
        &mut self,
        style: Fill,
        transform: Affine,
        brush: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        match self.route.get() {
            ChromeRoute::Main => self
                .main
                .fill(style, transform, brush, brush_transform, shape),
            ChromeRoute::Header => {
                self.header
                    .fill(style, transform, brush, brush_transform, shape)
            }
            ChromeRoute::Composer => {
                self.composer
                    .fill(style, transform, brush, brush_transform, shape)
            }
        }
    }

    fn draw_glyphs<'a, 's: 'a>(
        &'s mut self,
        font: &'a FontData,
        font_size: f32,
        hint: bool,
        normalized_coords: &'a [NormalizedCoord],
        embolden: kurbo::Vec2,
        style: impl Into<StyleRef<'a>>,
        brush: impl Into<PaintRef<'a>>,
        brush_alpha: f32,
        transform: Affine,
        glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = Glyph> + Clone,
    ) {
        match self.route.get() {
            ChromeRoute::Main => self.main.draw_glyphs(
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
                glyphs,
            ),
            ChromeRoute::Header => self.header.draw_glyphs(
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
                glyphs,
            ),
            ChromeRoute::Composer => self.composer.draw_glyphs(
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
                glyphs,
            ),
        }
    }

    fn draw_box_shadow(
        &mut self,
        transform: Affine,
        rect: kurbo::Rect,
        brush: peniko::Color,
        radius: f64,
        std_dev: f64,
    ) {
        match self.route.get() {
            ChromeRoute::Main => self
                .main
                .draw_box_shadow(transform, rect, brush, radius, std_dev),
            ChromeRoute::Header => self
                .header
                .draw_box_shadow(transform, rect, brush, radius, std_dev),
            ChromeRoute::Composer => self
                .composer
                .draw_box_shadow(transform, rect, brush, radius, std_dev),
        }
    }

    fn host_node_marker(&mut self, marker: HostNodeMarker) {
        match self.route.get() {
            ChromeRoute::Main => self.main.host_node_marker(marker),
            ChromeRoute::Header => self.header.host_node_marker(marker),
            ChromeRoute::Composer => self.composer.host_node_marker(marker),
        }
    }

    fn host_text_fragment(&mut self, fragment: HostTextFragment) {
        match self.route.get() {
            ChromeRoute::Main => self.main.host_text_fragment(fragment),
            ChromeRoute::Header => self.header.host_text_fragment(fragment),
            ChromeRoute::Composer => self.composer.host_text_fragment(fragment),
        }
    }

    fn append_scene(&mut self, scene: Scene, scene_transform: Affine) {
        match self.route.get() {
            ChromeRoute::Main => self.main.append_scene(scene, scene_transform),
            ChromeRoute::Header => self.header.append_scene(scene, scene_transform),
            ChromeRoute::Composer => self.composer.append_scene(scene, scene_transform),
        }
    }
}
