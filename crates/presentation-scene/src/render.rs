//! Vello paint encoding (ADR-0057 INV-3): the single render path.
//!
//! Paint consumes [`FrameSnapshot`] + [`Theme`] and encodes one
//! `vello::Scene`. There is no second renderer behind a guard and no
//! style recomputation here — colors resolve from tokens at this boundary
//! only.
//!
//! Device scale: [`render_frame_at_scale`] encodes the SAME CSS-px
//! snapshot geometry multiplied by a device scale (desktop DPI, Android
//! density). The snapshot itself never changes — hit-tests, a11y bounds
//! and digests stay CSS-px; only paint addresses physical pixels.

use vello::kurbo::{Affine, Rect as KRect, RoundedRect, Stroke};
use vello::peniko::{Brush, Color, Fill};
use vello::{NormalizedCoord, Scene as VelloScene};

use crate::snapshot::{FrameSnapshot, PaintData, Rect};
use crate::style::ColorToken;
use crate::theme::{Rgba, Theme};

/// Encodes one frame at CSS-px scale 1:1 (phones at density 1.0, the
/// offscreen golden harness). `vello_scene` is reset per frame by the
/// host; this function only appends.
pub fn render_frame(snapshot: &FrameSnapshot, theme: &Theme, vello_scene: &mut VelloScene) {
    render_frame_at_scale(snapshot, theme, vello_scene, 1.0);
}

/// Encodes one frame at a device scale: every rect, radius, stroke width
/// and glyph transform is multiplied by `scale`, so the host rasters at
/// physical resolution (`css size × scale`) and samples the result 1:1 —
/// fractional-DPI text lands on real pixels instead of a stretched
/// blit. The snapshot geometry is untouched (INV-2: CSS px is the one
/// geometry; scale is a paint-time fact only).
pub fn render_frame_at_scale(
    snapshot: &FrameSnapshot,
    theme: &Theme,
    vello_scene: &mut VelloScene,
    scale: f32,
) {
    let mut enc = Enc {
        theme,
        scene: vello_scene,
        s: (scale.max(0.0)) as f64,
    };

    // Root canvas background first.
    enc.fill_rect(
        Rect {
            x: 0.0,
            y: 0.0,
            w: snapshot.viewport.0,
            h: snapshot.viewport.1,
        },
        ColorToken::SurfaceCanvas,
        None,
    );

    for node in &snapshot.nodes {
        if let Some(bg) = node.background {
            enc.fill_rect(node.rect, bg, node.radius);
        }
        if let Some(border_token) = node.border {
            enc.stroke_rect(node.rect, border_token, node.radius);
        }
        match &node.paint {
            PaintData::Nothing => {}
            PaintData::Text { shaped, origin } => {
                enc.draw_shaped(shaped, *origin, enc.theme.color(ColorToken::TextPrimary));
            }
            PaintData::Button { shaped, origin } => {
                enc.draw_shaped(shaped, *origin, enc.theme.color(ColorToken::AccentText));
            }
            PaintData::Input { field } => {
                enc.draw_input(snapshot, field);
            }
        }
    }
}

/// One frame's encode context: theme resolution + the device scale.
/// All coordinate math flows through [`Enc::s`] so nothing can paint at
/// a half-forgotten scale.
struct Enc<'a> {
    theme: &'a Theme,
    scene: &'a mut VelloScene,
    s: f64,
}

impl Enc<'_> {
    /// Rect in device px (scaled from the snapshot's CSS px).
    fn krect(&self, r: Rect) -> KRect {
        KRect::new(
            r.x as f64 * self.s,
            r.y as f64 * self.s,
            (r.x + r.w) as f64 * self.s,
            (r.y + r.h) as f64 * self.s,
        )
    }

    fn brush(&self, color: Rgba) -> Brush {
        Brush::Solid(color.to_peniko())
    }

    fn fill_rect(&mut self, r: Rect, token: ColorToken, radius: Option<crate::style::RadiusToken>) {
        self.fill_rect_alpha(r, token, 1.0, radius);
    }

    fn fill_rect_alpha(
        &mut self,
        r: Rect,
        token: ColorToken,
        alpha: f32,
        radius: Option<crate::style::RadiusToken>,
    ) {
        let color = self.theme.color(token).with_alpha(alpha);
        let krect = self.krect(r);
        match radius {
            Some(token) => {
                let radius = (self.theme.radius(token) as f64 * self.s)
                    .min(krect.height() / 2.0)
                    .min(krect.width() / 2.0);
                let rr = RoundedRect::new(krect.x0, krect.y0, krect.x1, krect.y1, radius);
                self.scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    &self.brush(color),
                    None,
                    &rr,
                );
            }
            None => {
                self.scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    &self.brush(color),
                    None,
                    &krect,
                );
            }
        }
    }

    fn stroke_rect(
        &mut self,
        r: Rect,
        token: ColorToken,
        radius: Option<crate::style::RadiusToken>,
    ) {
        let color = self.theme.color(token);
        let krect = self.krect(r);
        // Hairline; the theme contract finalizes in Phase 2. Scales with
        // the device scale so a 1.5× monitor keeps a crisp 1.5-px stroke.
        let width = 1.0 * self.s;
        match radius {
            Some(radius_token) => {
                let rr = RoundedRect::new(
                    krect.x0,
                    krect.y0,
                    krect.x1,
                    krect.y1,
                    self.theme.radius(radius_token) as f64 * self.s,
                );
                self.scene.stroke(
                    &Stroke::new(width),
                    Affine::IDENTITY,
                    &self.brush(color),
                    None,
                    &rr,
                );
            }
            None => {
                self.scene.stroke(
                    &Stroke::new(width),
                    Affine::IDENTITY,
                    &self.brush(color),
                    None,
                    &krect,
                );
            }
        }
    }

    fn draw_input(&mut self, snapshot: &FrameSnapshot, field: &crate::editor::FieldId) {
        let Some(frame) = snapshot.inputs.get(field) else {
            return;
        };
        let empty = frame.shaped.byte_len() == 0;
        if empty {
            if let Some(placeholder) = &frame.placeholder {
                let color = self.theme.color(ColorToken::TextMuted);
                self.draw_shaped(placeholder, frame.text_origin, color);
            }
        } else {
            let color = self.theme.color(ColorToken::TextPrimary);
            self.draw_shaped(&frame.shaped, frame.text_origin, color);
        }
        // Selection behind the caret: the accent at 0.4 alpha.
        for sel in &frame.selection_rects {
            self.fill_rect_alpha(*sel, ColorToken::Accent, 0.4, None);
        }
        if let Some(caret) = frame.caret_rect {
            self.fill_rect(caret, ColorToken::Accent, None);
        }
    }

    fn draw_shaped(&mut self, shaped: &crate::text::ShapedText, origin: (f32, f32), color: Rgba) {
        let transform =
            Affine::scale(self.s) * Affine::translate((origin.0 as f64, origin.1 as f64));
        for paint_run in shaped.paint_runs() {
            let run = paint_run.run.run();
            let coords: Vec<NormalizedCoord> = run
                .normalized_coords()
                .iter()
                .map(|&c| NormalizedCoord::from(c))
                .collect();
            let glyph_brush = self.brush(color);
            self.scene
                .draw_glyphs(run.font())
                .font_size(run.font_size())
                .hint(false)
                .normalized_coords(&coords)
                .transform(transform)
                .brush(&glyph_brush)
                .brush_alpha(1.0)
                .draw(
                    Fill::NonZero,
                    paint_run.run.positioned_glyphs().map(|g| vello::Glyph {
                        id: g.id,
                        x: g.x,
                        y: g.y,
                    }),
                );
        }
    }
}

impl Rgba {
    fn with_alpha(mut self, a: f32) -> Rgba {
        self.a = a;
        self
    }

    fn to_peniko(self) -> Color {
        Color::from_rgba8(
            (self.r * 255.0).round() as u8,
            (self.g * 255.0).round() as u8,
            (self.b * 255.0).round() as u8,
            (self.a * 255.0).round() as u8,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::CursorOp;
    use crate::layout::SceneLayouter;
    use crate::scene::{NodeKind, Scene, SceneNode, TextRun};
    use crate::snapshot::FrameSnapshot;
    use crate::style::{NodeLayout, SizeToken, TextTokens};
    use crate::text::TextEngine;
    use crate::theme::Theme;

    fn build(scene: &mut Scene) -> FrameSnapshot {
        let mut layouter = SceneLayouter::new();
        let mut engine = TextEngine::new();
        let theme = Theme::golden_dark();
        let rev = scene.revision();
        let pass = layouter.layout(scene, &theme, &mut engine, (400.0, 700.0));
        FrameSnapshot::from_pass(pass, &theme, &mut engine, rev)
    }

    /// CPU-side encoding: a vello::Scene can be built without a GPU — this
    /// proves the single render path runs headless (the golden/bridge
    /// harness rasterizes it later).
    #[test]
    fn frame_encodes_to_a_vello_scene_headless() {
        let mut s = Scene::new();
        let root = s.root();
        s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("hello vello", TextTokens::body())])
                .with_background(crate::style::ColorToken::SurfacePrimary),
        );
        s.append_child(
            root,
            SceneNode {
                kind: NodeKind::Input {
                    field: crate::editor::FieldId::Composer,
                    placeholder: "say".into(),
                },
                layout: NodeLayout::column()
                    .with_height(SizeToken::Height(crate::style::ControlHeightToken::Control)),
                ..SceneNode::container(NodeLayout::column())
            },
        );
        s.hydrate_input(crate::editor::FieldId::Composer, "typing");
        s.input_mut(crate::editor::FieldId::Composer)
            .apply(CursorOp::MoveToEnd { select: false });
        let snap = build(&mut s);
        let mut scene = VelloScene::new();
        render_frame(&snap, &Theme::golden_dark(), &mut scene);
        // CPU-side encoding is non-empty: paths + glyphs were encoded
        // (this proves the single render path runs headless; the GPU bridge
        // rasterizes the same scene later).
        let encoding = scene.encoding();
        assert!(encoding.n_paths > 0, "background fills must encode paths");
        assert!(
            !encoding.draw_tags.is_empty(),
            "draw objects must be encoded"
        );
    }

    /// Device scale doubles the encoded rect coordinates (the vello path
    /// stream stores f32 coordinates bitwise): the 400×700 viewport
    /// paints 400/700 at 1:1 and 800/1400 at 2:1. The snapshot never
    /// changes — scale is paint-time only.
    #[test]
    fn device_scale_moves_the_encoded_canvas_to_physical_pixels() {
        let mut s = Scene::new();
        let root = s.root();
        s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("scaled", TextTokens::body())]),
        );
        let snap = build(&mut s);
        let mut css = VelloScene::new();
        render_frame_at_scale(&snap, &Theme::golden_dark(), &mut css, 1.0);
        let mut hidpi = VelloScene::new();
        render_frame_at_scale(&snap, &Theme::golden_dark(), &mut hidpi, 2.0);

        let as_f32 = |scene: &VelloScene| -> Vec<f32> {
            scene
                .encoding()
                .path_data
                .iter()
                .map(|bits| f32::from_bits(*bits))
                .collect()
        };
        let css = as_f32(&css);
        let hidpi = as_f32(&hidpi);
        assert_eq!(
            css.iter().any(|c| (c - 400.0).abs() < 0.01),
            true,
            "scale 1.0 must paint the CSS-px viewport edge"
        );
        assert!(css.iter().any(|c| (c - 700.0).abs() < 0.01));
        assert!(
            hidpi.iter().any(|c| (c - 800.0).abs() < 0.01),
            "scale 2.0 must paint the doubled viewport edge"
        );
        assert!(hidpi.iter().any(|c| (c - 1400.0).abs() < 0.01));
        assert!(
            !hidpi.iter().any(|c| (c - 400.0).abs() < 0.01),
            "no stale CSS-px edge may survive at 2:1"
        );
    }
}
