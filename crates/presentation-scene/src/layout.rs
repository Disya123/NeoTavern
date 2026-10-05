//! Taffy layout (ADR-0057 platform spec §3): the scene's single layout
//! engine. Text is measured through the Parley engine inside taffy's
//! measure callback — never re-derived elsewhere (INV-2).

use std::collections::HashMap;

use taffy::tree::NodeId as TaffyNodeId;
use taffy::TaffyTree as Taffy;
use taffy::{AvailableSpace, Dimension, FlexDirection, LengthPercentage, Size as TaffySize, Style};

use crate::arena::SceneId;
use crate::editor::FieldId;
use crate::scene::{NodeKind, Scene, SceneNode};
use crate::style::{Direction, SizeToken};
use crate::text::{ShapedText, TextEngine};
use crate::theme::Theme;

/// The layout stage: owns the taffy tree synced against the scene.
pub struct SceneLayouter {
    taffy: Taffy<SceneId>,
    map: HashMap<SceneId, TaffyNodeId>,
}

impl Default for SceneLayouter {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneLayouter {
    pub fn new() -> Self {
        Self {
            taffy: Taffy::new(),
            map: HashMap::new(),
        }
    }

    /// Runs the full layout pass and returns the shaped text + absolute
    /// geometry needed to build the [`crate::snapshot::FrameSnapshot`]:
    /// `(per-node (rect, node) in paint order, per-field shaped text)`.
    ///
    /// This is the *only* place geometry is computed; hit-testing, focus
    /// order, a11y bounds and paint all consume the snapshot built from it.
    pub fn layout(
        &mut self,
        scene: &Scene,
        theme: &Theme,
        engine: &mut TextEngine,
        viewport: (f32, f32),
    ) -> LayoutPass {
        self.sync(scene, theme);
        let Some(root_id) = scene.root_id() else {
            return LayoutPass::default();
        };
        let Some(&root) = self.map.get(&root_id) else {
            return LayoutPass::default();
        };
        let (vw, vh) = viewport;
        self.taffy
            .compute_layout_with_measure(
                root,
                TaffySize {
                    width: AvailableSpace::Definite(vw.max(1.0)),
                    height: AvailableSpace::Definite(vh.max(1.0)),
                },
                |known, _avail, _node, ctx, _style| {
                    let Some(id) = ctx.as_deref().copied() else {
                        return TaffySize::ZERO;
                    };
                    measure_node(scene, engine, theme, id, known)
                },
            )
            .expect("taffy layout of a synced tree cannot fail");

        // Read back absolute geometry in scene paint order; re-shape text
        // at the final content width for caret/paint geometry.
        let mut pass = LayoutPass {
            viewport,
            ..LayoutPass::default()
        };
        let mut out = Vec::new();
        accumulate(scene, &self.taffy, &self.map, root_id, (0.0, 0.0), &mut out);
        pass.nodes = out;
        for (id, node, rect) in pass.nodes.iter().map(|(id, n, r)| (*id, n, *r)) {
            let NodeKind::Input { field, placeholder } = node.kind.clone() else {
                continue;
            };
            let editor = scene.input(field);
            let text = editor.map(|e| e.text().to_string()).unwrap_or_default();
            let cursor = editor.map(|e| e.cursor());
            let inner = (
                rect.x + theme.spacing(node.layout.padding.horizontal),
                rect.y + theme.spacing(node.layout.padding.vertical),
            );
            let width = (rect.w - theme.spacing(node.layout.padding.horizontal) * 2.0).max(0.0);
            let shaped = engine.shape(
                &[crate::scene::TextRun::plain(
                    text,
                    crate::style::TextTokens::body(),
                )],
                theme,
                Some(width),
            );
            let placeholder_shaped = if placeholder.is_empty() {
                None
            } else {
                Some(
                    engine.shape(
                        &[crate::scene::TextRun::plain(
                            placeholder.clone(),
                            crate::style::TextTokens::body()
                                .with_color(crate::style::ColorToken::TextMuted),
                        )],
                        theme,
                        Some(width),
                    ),
                )
            };
            pass.inputs.insert(
                field,
                InputLayout {
                    node: id,
                    rect,
                    text_origin: inner,
                    shaped,
                    cursor,
                    placeholder: placeholder_shaped,
                },
            );
        }
        pass
    }

    /// Brings the taffy tree in sync with the scene (retained map: same
    /// node → same taffy node across frames; freed subtrees drop their
    /// taffy nodes; styles update in place).
    fn sync(&mut self, scene: &Scene, theme: &Theme) {
        let Some(root_id) = scene.root_id() else {
            return;
        };
        let mut live: Vec<SceneId> = Vec::new();
        collect_live(scene, root_id, &mut live);
        // Free stale taffy nodes first.
        let stale: Vec<SceneId> = self
            .map
            .keys()
            .copied()
            .filter(|id| !live.contains(id))
            .collect();
        for id in stale {
            if let Some(tn) = self.map.remove(&id) {
                let _ = self.taffy.remove(tn);
            }
        }
        // Ensure nodes exist, top-down, then set children order.
        for id in &live {
            if !self.map.contains_key(id) {
                let Some(node) = scene.node(*id) else {
                    continue;
                };
                let style = taffy_style(node, theme);
                let tn = if is_measured(&node.kind) {
                    self.taffy.new_leaf_with_context(style, *id)
                } else {
                    self.taffy.new_leaf(style)
                }
                .expect("taffy node creation cannot fail");
                self.map.insert(*id, tn);
            } else if let Some(node) = scene.node(*id) {
                let _ = self.taffy.set_style(self.map[id], taffy_style(node, theme));
            }
        }
        for id in &live {
            let children = children_of(scene, *id);
            let t_children: Vec<TaffyNodeId> = children
                .iter()
                .filter_map(|c| self.map.get(c).copied())
                .collect();
            if let Some(&tn) = self.map.get(id) {
                let _ = self.taffy.set_children(tn, &t_children);
            }
        }
    }
}

fn collect_live(scene: &Scene, id: SceneId, out: &mut Vec<SceneId>) {
    out.push(id);
    for c in children_of(scene, id) {
        collect_live(scene, *c, out);
    }
}

fn children_of(scene: &Scene, id: SceneId) -> &[SceneId] {
    scene.children(id)
}

fn is_measured(kind: &NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Text { .. } | NodeKind::Button { .. } | NodeKind::Input { .. }
    )
}

/// Intrinsic measurement for text-bearing nodes (the taffy measure
/// callback): shapes at the offered width.
fn measure_node(
    scene: &Scene,
    engine: &mut TextEngine,
    theme: &Theme,
    id: SceneId,
    known: TaffySize<Option<f32>>,
) -> TaffySize<f32> {
    let Some(node) = scene.node(id) else {
        return TaffySize::ZERO;
    };
    let runs: Vec<crate::scene::TextRun> = match &node.kind {
        NodeKind::Text { runs } => runs.clone(),
        NodeKind::Button { label } => label.clone(),
        NodeKind::Input { field, placeholder } => {
            let editor_text = scene
                .input(*field)
                .map(|e| e.text().to_string())
                .unwrap_or_default();
            if editor_text.is_empty() && !placeholder.is_empty() {
                vec![crate::scene::TextRun::plain(
                    placeholder.clone(),
                    crate::style::TextTokens::body(),
                )]
            } else {
                vec![crate::scene::TextRun::plain(
                    editor_text,
                    crate::style::TextTokens::body(),
                )]
            }
        }
        _ => return TaffySize::ZERO,
    };
    if runs.iter().all(|r| r.text.is_empty()) {
        // Empty content: zero measured size. Inputs that must keep a caret
        // line declare a fixed `SizeToken::Height` in their node layout.
        return TaffySize {
            width: known.width.unwrap_or(0.0),
            height: 0.0,
        };
    }
    let shaped = engine.shape(&runs, theme, known.width);
    TaffySize {
        width: known.width.unwrap_or(shaped.width()),
        height: shaped.height(),
    }
}

/// Converts a scene node's tokenized layout into a taffy style.
fn taffy_style(node: &SceneNode, theme: &Theme) -> Style {
    let l = &node.layout;
    let pad = theme.spacing(l.padding.horizontal);
    let pad_v = theme.spacing(l.padding.vertical);
    let gap = theme.spacing(l.gap);
    let size_of = |s: SizeToken| match s {
        SizeToken::Auto => Dimension::auto(),
        SizeToken::Fill => Dimension::percent(1.0),
        SizeToken::Height(t) => Dimension::length(theme.control_height(t)),
    };
    Style {
        flex_direction: match l.direction {
            Direction::Column => FlexDirection::Column,
            Direction::Row => FlexDirection::Row,
        },
        flex_grow: l.grow,
        gap: TaffySize {
            width: LengthPercentage::length(gap),
            height: LengthPercentage::length(gap),
        },
        padding: taffy::Rect {
            left: LengthPercentage::length(pad),
            right: LengthPercentage::length(pad),
            top: LengthPercentage::length(pad_v),
            bottom: LengthPercentage::length(pad_v),
        },
        size: TaffySize {
            width: size_of(l.width),
            height: size_of(l.height),
        },
        ..Style::default()
    }
}

/// Absolute geometry read-back: parent origin + taffy location (taffy bakes
/// the flex item's offset from the parent's border box — including the
/// parent's padding — into `location`).
fn accumulate(
    scene: &Scene,
    taffy: &Taffy<SceneId>,
    map: &HashMap<SceneId, TaffyNodeId>,
    id: SceneId,
    origin: (f32, f32),
    out: &mut Vec<(SceneId, SceneNode, crate::snapshot::Rect)>,
) {
    let Some(&tn) = map.get(&id) else { return };
    let Ok(layout) = taffy.layout(tn) else { return };
    let rect = crate::snapshot::Rect {
        x: origin.0 + layout.location.x,
        y: origin.1 + layout.location.y,
        w: layout.size.width,
        h: layout.size.height,
    };
    if let Some(node) = scene.node(id) {
        out.push((id, node.clone(), rect));
        for c in scene.children(id) {
            accumulate(scene, taffy, map, *c, (rect.x, rect.y), out);
        }
    }
}

/// The result of one layout pass, ready to be folded into a
/// [`crate::snapshot::FrameSnapshot`].
#[derive(Default)]
pub struct LayoutPass {
    pub viewport: (f32, f32),
    /// (node id, node, absolute rect) in depth-first paint order.
    pub nodes: Vec<(SceneId, SceneNode, crate::snapshot::Rect)>,
    /// Shaped text + cursor per input field.
    pub inputs: HashMap<FieldId, InputLayout>,
}

/// Layout-stage data for one input field.
pub struct InputLayout {
    pub node: SceneId,
    pub rect: crate::snapshot::Rect,
    /// Absolute origin of the text content (inside the field padding).
    pub text_origin: (f32, f32),
    pub shaped: ShapedText,
    pub cursor: Option<crate::editor::Cursor>,
    pub placeholder: Option<ShapedText>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{Scene, SceneNode, TextRun};
    use crate::style::{NodeLayout, Padding, SpacingToken, TextTokens};

    fn layout_simple(scene: &Scene) -> LayoutPass {
        let mut l = SceneLayouter::new();
        let mut engine = TextEngine::new();
        let theme = Theme::golden_dark();
        l.layout(scene, &theme, &mut engine, (400.0, 600.0))
    }

    #[test]
    fn children_get_absolute_rects_and_padding_is_baked_in() {
        let mut s = Scene::new();
        let root = s.root();
        let inner = SceneNode::container(
            NodeLayout::column()
                .with_padding(Padding::all(SpacingToken::Xl))
                .with_grow(1.0),
        )
        .with_background(crate::style::ColorToken::SurfacePrimary);
        let inner = s.append_child(root, inner);
        let _label = s.append_child(
            inner,
            SceneNode::text(vec![TextRun::plain("hi", TextTokens::body())]),
        );
        let pass = layout_simple(&s);
        assert_eq!(pass.viewport, (400.0, 600.0));
        let root_rect = pass.nodes[0].2;
        assert_eq!(
            root_rect,
            crate::snapshot::Rect {
                x: 0.0,
                y: 0.0,
                w: 400.0,
                h: 600.0
            }
        );
        let (inner_id, _, inner_rect) = &pass.nodes[1];
        assert_eq!(*inner_id, inner);
        assert_eq!(inner_rect.x, 0.0);
        assert_eq!(inner_rect.y, 0.0);
        // The child of a padded container sits at the padding edge —
        // either taffy baked the padding into the child location, or this
        // test caught a semantics assumption and accumulate() must add it.
        let pad = 24.0; // SpacingToken::Xl
        let label = &pass.nodes[2].2;
        assert_eq!(label.x, pad, "padding must be baked into child location");
        assert!(label.y >= pad);
        assert!(label.h > 0.0, "text nodes get measured height");
    }

    #[test]
    fn row_layout_places_siblings_horizontally() {
        let mut s = Scene::new();
        let root = s.root();
        s.node_mut(root).unwrap().layout = NodeLayout::row();
        let _a = s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("aaaa", TextTokens::body())]),
        );
        let _b = s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("bbbb", TextTokens::body())]),
        );
        let pass = layout_simple(&s);
        let a = &pass.nodes[1].2;
        let b = &pass.nodes[2].2;
        assert_eq!(a.x, 0.0);
        assert!(b.x > a.x, "row siblings advance horizontally: {a:?} {b:?}");
        assert!(b.w > 0.0);
    }

    #[test]
    fn stable_ids_keep_stable_taffy_nodes() {
        let mut s = Scene::new();
        let root = s.root();
        let a = s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("x", TextTokens::body())]),
        );
        let mut l = SceneLayouter::new();
        let mut engine = TextEngine::new();
        let theme = Theme::golden_dark();
        let _ = l.layout(&s, &theme, &mut engine, (300.0, 300.0));
        let tn_before = l.map[&a];
        let _ = l.layout(&s, &theme, &mut engine, (300.0, 300.0));
        assert_eq!(
            l.map[&a], tn_before,
            "retained taffy node for a stable scene id"
        );
    }

    #[test]
    fn removed_subtree_frees_its_taffy_nodes() {
        let mut s = Scene::new();
        let root = s.root();
        let child = s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("x", TextTokens::body())]),
        );
        let mut l = SceneLayouter::new();
        let mut engine = TextEngine::new();
        let theme = Theme::golden_dark();
        let _ = l.layout(&s, &theme, &mut engine, (300.0, 300.0));
        assert!(l.map.contains_key(&child));
        s.remove_child(root, child);
        let _ = l.layout(&s, &theme, &mut engine, (300.0, 300.0));
        assert!(
            !l.map.contains_key(&child),
            "freed subtree releases its taffy node"
        );
    }
}
