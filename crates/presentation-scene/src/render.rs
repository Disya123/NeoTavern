//! Vello paint encoding (ADR-0057 INV-3): the single render path.
//!
//! Paint consumes [`FrameSnapshot`] + [`Theme`] and encodes one
//! `vello::Scene`. There is no second renderer behind a guard and no
//! style recomputation here — colors resolve from tokens at this boundary
//! only.

use vello::kurbo::{Affine, Rect as KRect, RoundedRect, Stroke};
use vello::peniko::{Brush, Color, Fill};
use vello::{NormalizedCoord, Scene as VelloScene};

use crate::snapshot::{FrameSnapshot, PaintData};
use crate::theme::{Rgba, Theme};

/// Encodes one frame. `vello_scene` is reset per frame by the host; this
/// function only appends.
pub fn render_frame(snapshot: &FrameSnapshot, theme: &Theme, vello_scene: &mut VelloScene) {
    // Root canvas background first.
    let canvas = theme.color(crate::style::ColorToken::SurfaceCanvas);
    vello_scene.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        &brush(canvas),
        None,
        &KRect::new(
            0.0,
            0.0,
            snapshot.viewport.0 as f64,
            snapshot.viewport.1 as f64,
        ),
    );

    for node in &snapshot.nodes {
        let rect = node.rect;
        let krect = KRect::new(
            rect.x as f64,
            rect.y as f64,
            (rect.x + rect.w) as f64,
            (rect.y + rect.h) as f64,
        );
        if let Some(bg) = node.background {
            let color = theme.color(bg);
            match node.radius {
                Some(token) => {
                    let rr = RoundedRect::new(
                        krect.x0,
                        krect.y0,
                        krect.x1,
                        krect.y1,
                        (theme.radius(token) as f64).min(krect.height() / 2.0),
                    );
                    vello_scene.fill(Fill::NonZero, Affine::IDENTITY, &brush(color), None, &rr);
                }
                None => {
                    vello_scene.fill(Fill::NonZero, Affine::IDENTITY, &brush(color), None, &krect);
                }
            }
        }
        if let Some(border_token) = node.border {
            let color = theme.color(border_token);
            let width = 1.0; // hairline; the theme contract finalizes in Phase 2
            match node.radius {
                Some(token) => {
                    let rr = RoundedRect::new(
                        krect.x0,
                        krect.y0,
                        krect.x1,
                        krect.y1,
                        theme.radius(token) as f64,
                    );
                    vello_scene.stroke(
                        &Stroke::new(width),
                        Affine::IDENTITY,
                        &stroke_brush(color),
                        None,
                        &rr,
                    );
                }
                None => {
                    vello_scene.stroke(
                        &Stroke::new(width),
                        Affine::IDENTITY,
                        &stroke_brush(color),
                        None,
                        &krect,
                    );
                }
            }
        }
        match &node.paint {
            PaintData::Nothing => {}
            PaintData::Text { shaped, origin } => {
                draw_text(
                    shaped,
                    *origin,
                    crate::style::ColorToken::TextPrimary,
                    theme,
                    vello_scene,
                );
            }
            PaintData::Button { shaped, origin } => {
                draw_text(
                    shaped,
                    *origin,
                    crate::style::ColorToken::AccentText,
                    theme,
                    vello_scene,
                );
            }
            PaintData::Input { field } => {
                draw_input(snapshot, field, theme, vello_scene);
            }
        }
    }
}

fn draw_input(
    snapshot: &FrameSnapshot,
    field: &crate::editor::FieldId,
    theme: &Theme,
    vello_scene: &mut VelloScene,
) {
    let Some(frame) = snapshot.inputs.get(field) else {
        return;
    };
    let empty = frame.shaped.byte_len() == 0;
    if empty {
        if let Some(ph) = &frame.placeholder {
            draw_shaped(
                ph,
                frame.text_origin,
                theme.color(crate::style::ColorToken::TextMuted),
                vello_scene,
            );
        }
    } else {
        draw_shaped(
            &frame.shaped,
            frame.text_origin,
            theme.color(crate::style::ColorToken::TextPrimary),
            vello_scene,
        );
    }
    // Selection behind the caret.
    for sel in &frame.selection_rects {
        let r = KRect::new(
            sel.x as f64,
            sel.y as f64,
            (sel.x + sel.w) as f64,
            (sel.y + sel.h) as f64,
        );
        vello_scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            &brush(
                theme
                    .color(crate::style::ColorToken::Accent)
                    .with_alpha(0.4),
            ),
            None,
            &r,
        );
    }
    if let Some(caret) = frame.caret_rect {
        let r = KRect::new(
            caret.x as f64,
            caret.y as f64,
            (caret.x + caret.w) as f64,
            (caret.y + caret.h) as f64,
        );
        vello_scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            &brush(theme.color(crate::style::ColorToken::Accent)),
            None,
            &r,
        );
    }
}

fn draw_text(
    shaped: &crate::text::ShapedText,
    origin: (f32, f32),
    color_token: crate::style::ColorToken,
    theme: &Theme,
    vello_scene: &mut VelloScene,
) {
    draw_shaped(shaped, origin, theme.color(color_token), vello_scene);
}

fn draw_shaped(
    shaped: &crate::text::ShapedText,
    origin: (f32, f32),
    color: Rgba,
    vello_scene: &mut VelloScene,
) {
    let transform = Affine::translate((origin.0 as f64, origin.1 as f64));
    for paint_run in shaped.paint_runs() {
        let run = paint_run.run.run();
        let coords: Vec<NormalizedCoord> = run
            .normalized_coords()
            .iter()
            .map(|&c| NormalizedCoord::from(c))
            .collect();
        vello_scene
            .draw_glyphs(run.font())
            .font_size(run.font_size())
            .hint(false)
            .normalized_coords(&coords)
            .transform(transform)
            .brush(&brush(color))
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

fn brush(color: Rgba) -> Brush {
    Brush::Solid(color.to_peniko())
}

fn stroke_brush(color: Rgba) -> Brush {
    brush(color)
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
}
