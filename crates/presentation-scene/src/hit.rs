//! Hit-testing against the [`FrameSnapshot`] (ADR-0057 INV-2).
//!
//! There is no second coordinate table: the same rects that paint answer
//! the click. Topmost-first = reverse paint order (children after parents,
//! later siblings on top). Text fields resolve the point to a caret byte
//! index through the same shaped text that paints.

use crate::arena::SceneId;
use crate::editor::FieldId;
use crate::scene::SceneAction;
use crate::snapshot::{FrameSnapshot, PaintData};

/// What a point in the frame hits.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HitTarget {
    /// A control with an action (button).
    Action { action: SceneAction, node: SceneId },
    /// An input field; `caret_byte` is the caret position under the point
    /// (None when the field has no shaped text there).
    Field {
        field: FieldId,
        node: SceneId,
        caret_byte: Option<usize>,
    },
    /// Any other node (containers, text).
    Node { node: SceneId },
    /// Background — no node contains the point.
    Nothing,
}

/// Topmost-first hit test in absolute frame coordinates.
pub fn hit_test(snapshot: &FrameSnapshot, x: f32, y: f32) -> HitTarget {
    for node in snapshot.nodes.iter().rev() {
        if !node.rect.contains(x, y) {
            continue;
        }
        match &node.paint {
            PaintData::Input { field } => {
                let caret_byte = snapshot.inputs.get(field).and_then(|f| {
                    let lx = x - f.text_origin.0;
                    let ly = y - f.text_origin.1;
                    // Clamp into the text block vertically: clicks above
                    // the first line / below the last line still position
                    // the caret in the nearest line.
                    f.shaped.byte_index_at_point(lx, ly).or_else(|| {
                        f.shaped
                            .byte_index_at_point(lx, f.shaped.height() * 0.5)
                            .or(Some(0))
                    })
                });
                return HitTarget::Field {
                    field: *field,
                    node: node.id,
                    caret_byte,
                };
            }
            PaintData::Button { .. } => {
                if let Some(action) = node.action {
                    return HitTarget::Action {
                        action,
                        node: node.id,
                    };
                }
                return HitTarget::Node { node: node.id };
            }
            _ => {
                if let Some(action) = node.action {
                    return HitTarget::Action {
                        action,
                        node: node.id,
                    };
                }
                return HitTarget::Node { node: node.id };
            }
        }
    }
    HitTarget::Nothing
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

    #[test]
    fn hit_finds_button_and_returns_action() {
        let mut s = Scene::new();
        let root = s.root();
        s.append_child(
            root,
            SceneNode {
                kind: NodeKind::Button {
                    label: vec![TextRun::plain("send", TextTokens::body())],
                },
                layout: NodeLayout::row()
                    .with_height(SizeToken::Height(crate::style::ControlHeightToken::Control)),
                action: Some(SceneAction(7)),
                ..SceneNode::container(NodeLayout::row())
            },
        );
        let snap = build(&mut s);
        let btn = &snap.nodes[1];
        let cx = btn.rect.x + btn.rect.w * 0.5;
        let cy = btn.rect.y + btn.rect.h * 0.5;
        match hit_test(&snap, cx, cy) {
            HitTarget::Action { action, .. } => assert_eq!(action, SceneAction(7)),
            other => panic!("expected action hit, got {other:?}"),
        }
        assert_eq!(hit_test(&snap, -5.0, -5.0), HitTarget::Nothing);
    }

    #[test]
    fn hit_on_input_resolves_caret_byte() {
        let mut s = Scene::new();
        let root = s.root();
        s.append_child(
            root,
            SceneNode {
                kind: NodeKind::Input {
                    field: FieldId::Composer,
                    placeholder: "placeholder".into(),
                },
                layout: NodeLayout::column()
                    .with_height(SizeToken::Height(crate::style::ControlHeightToken::Control)),
                ..SceneNode::container(NodeLayout::column())
            },
        );
        s.hydrate_input(FieldId::Composer, "hello world");
        let snap = build(&mut s);
        let frame = &snap.inputs[&FieldId::Composer];
        // Click near the end of the text.
        let end_caret = frame.shaped.caret_geometry(frame.shaped.byte_len());
        let x = frame.text_origin.0 + end_caret.x - 2.0;
        let y = frame.text_origin.1 + (end_caret.y_top + end_caret.y_bottom) * 0.5;
        match hit_test(&snap, x, y) {
            HitTarget::Field {
                field, caret_byte, ..
            } => {
                assert_eq!(field, FieldId::Composer);
                assert!(
                    caret_byte.unwrap_or(0) > 5,
                    "clicking near the end positions late, got {caret_byte:?}"
                );
            }
            other => panic!("expected field hit, got {other:?}"),
        }
        // Routing the hit back through the editor moves the caret there.
        let byte = match hit_test(&snap, x, y) {
            HitTarget::Field { caret_byte, .. } => caret_byte.unwrap(),
            _ => unreachable!(),
        };
        s.input_mut(FieldId::Composer).apply(CursorOp::Position {
            index: byte,
            select: false,
        });
        assert_eq!(
            s.input(FieldId::Composer).unwrap().cursor().caret,
            byte.clamp(0, "hello world".len())
        );
    }

    #[test]
    fn later_siblings_hit_first() {
        let mut s = Scene::new();
        let root = s.root();
        let _under = s.append_child(
            root,
            SceneNode::container(NodeLayout::column())
                .with_background(crate::style::ColorToken::SurfacePrimary),
        );
        let over = s.append_child(
            root,
            SceneNode {
                kind: NodeKind::Button {
                    label: vec![TextRun::plain("over", TextTokens::body())],
                },
                action: Some(SceneAction(3)),
                layout: NodeLayout::column()
                    .with_height(SizeToken::Height(crate::style::ControlHeightToken::Control)),
                ..SceneNode::container(NodeLayout::column())
            },
        );
        let snap = build(&mut s);
        let rect = snap.node(over).unwrap().rect;
        let hit = hit_test(&snap, rect.x + 1.0, rect.y + 1.0);
        assert!(
            matches!(hit, HitTarget::Action { .. }),
            "topmost sibling wins"
        );
    }
}
