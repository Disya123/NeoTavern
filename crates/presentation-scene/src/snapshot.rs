//! FrameSnapshot: the single geometry of one frame (ADR-0057 INV-2).
//!
//! Paint, hit-testing, focus order and the a11y export all consume this
//! struct — nothing recomputes geometry, nothing keeps a parallel table.
//! The snapshot is immutable once built; a new frame produces a new one.
//! Its `digest` powers the refactor-stability golden (INV-3): mechanical
//! refactors must not change it.

use std::collections::HashMap;

use crate::arena::SceneId;
use crate::editor::{Cursor, FieldId};
use crate::scene::{A11yRole, NodeKind, SceneAction};
use crate::style::{ColorToken, RadiusToken};
use crate::text::ShapedText;

/// Axis-aligned rect in CSS px, absolute frame coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

/// What one node paints with.
pub enum PaintData {
    Nothing,
    /// Static text: shaped content + origin (first glyph line origin
    /// differs per run — paint reads runs from the shaped text).
    Text {
        shaped: ShapedText,
        origin: (f32, f32),
    },
    /// Button label.
    Button {
        shaped: ShapedText,
        origin: (f32, f32),
    },
    /// Input: geometry details live in `FrameSnapshot::inputs`.
    Input {
        field: FieldId,
    },
}

/// One node's geometry + paint data.
pub struct SnapshotNode {
    pub id: SceneId,
    pub rect: Rect,
    pub background: Option<ColorToken>,
    pub radius: Option<RadiusToken>,
    pub border: Option<ColorToken>,
    pub role: A11yRole,
    pub name: String,
    pub action: Option<SceneAction>,
    pub paint: PaintData,
}

/// Per-field input geometry (INV-2: caret + selection rects come from the
/// same shaped text that paints).
pub struct InputFrame {
    pub node: SceneId,
    /// Field content rect (absolute).
    pub rect: Rect,
    /// Absolute origin of the text content.
    pub text_origin: (f32, f32),
    pub shaped: ShapedText,
    pub cursor: Option<Cursor>,
    /// Absolute caret rect for the cursor head.
    pub caret_rect: Option<Rect>,
    /// Absolute selection rects (viewport coords).
    pub selection_rects: Vec<Rect>,
    /// Shaped placeholder (drawn when the text is empty).
    pub placeholder: Option<ShapedText>,
}

/// The single geometry of one frame.
pub struct FrameSnapshot {
    pub viewport: (f32, f32),
    pub revision: u64,
    /// Nodes in depth-first paint order.
    pub nodes: Vec<SnapshotNode>,
    pub inputs: HashMap<FieldId, InputFrame>,
    /// Focus order: buttons and inputs in paint order (a11y/focus export).
    pub focus_order: Vec<SceneId>,
}

impl FrameSnapshot {
    /// Builds the snapshot from a completed
    /// [`crate::layout::LayoutPass`], shaping static/button text at the
    /// final laid-out width.
    pub fn from_pass(
        pass: crate::layout::LayoutPass,
        theme: &crate::theme::Theme,
        engine: &mut crate::text::TextEngine,
        revision: u64,
    ) -> Self {
        let mut nodes = Vec::with_capacity(pass.nodes.len());
        let mut focus_order = Vec::new();
        for (id, node, rect) in pass.nodes {
            let paint = match &node.kind {
                NodeKind::Container => PaintData::Nothing,
                NodeKind::Slot { .. } => PaintData::Nothing,
                NodeKind::Text { runs } => {
                    let pad_x = theme.spacing(node.layout.padding.horizontal);
                    let pad_y = theme.spacing(node.layout.padding.vertical);
                    let w = (rect.w - pad_x * 2.0).max(0.0);
                    let shaped = engine.shape(runs, theme, Some(w));
                    PaintData::Text {
                        shaped,
                        origin: (rect.x + pad_x, rect.y + pad_y),
                    }
                }
                NodeKind::Button { label } => {
                    let pad_x = theme.spacing(node.layout.padding.horizontal);
                    let pad_y = theme.spacing(node.layout.padding.vertical);
                    let w = (rect.w - pad_x * 2.0).max(0.0);
                    let shaped = engine.shape(label, theme, Some(w));
                    PaintData::Button {
                        shaped,
                        origin: (rect.x + pad_x, rect.y + pad_y),
                    }
                }
                NodeKind::Input { field, .. } => {
                    focus_order.push(id);
                    PaintData::Input { field: *field }
                }
            };
            if matches!(node.kind, NodeKind::Button { .. }) {
                focus_order.push(id);
            }
            nodes.push(SnapshotNode {
                id,
                rect,
                background: node.background,
                radius: node.radius,
                border: node.border,
                role: node.role,
                name: node.name.clone(),
                action: node.action,
                paint,
            });
        }
        // Input frames: caret/selection geometry in absolute coordinates.
        let mut inputs = HashMap::new();
        for (field, il) in pass.inputs {
            let caret_rect = il.cursor.map(|c| {
                let g = il.shaped.caret_geometry(c.caret);
                Rect {
                    x: il.text_origin.0 + g.x,
                    y: il.text_origin.1 + g.y_top,
                    w: 2.0,
                    h: (g.y_bottom - g.y_top).max(2.0),
                }
            });
            let selection_rects = il
                .cursor
                .and_then(|c| c.selection())
                .map(|sel| {
                    il.shaped
                        .selection_rects(sel)
                        .into_iter()
                        .map(|(sx, sy, sw, sh)| Rect {
                            x: il.text_origin.0 + sx,
                            y: il.text_origin.1 + sy,
                            w: sw,
                            h: sh,
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            inputs.insert(
                field,
                InputFrame {
                    node: il.node,
                    rect: il.rect,
                    text_origin: il.text_origin,
                    shaped: il.shaped,
                    cursor: il.cursor,
                    caret_rect,
                    selection_rects,
                    placeholder: il.placeholder,
                },
            );
        }
        // Paint order is already the focus order; dedup is a guard only.
        focus_order.dedup();
        Self {
            viewport: pass.viewport,
            revision,
            nodes,
            inputs,
            focus_order,
        }
    }

    pub fn node(&self, id: SceneId) -> Option<&SnapshotNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// Semantic a11y export (platform spec §6): role, name, bounds — the
    /// same geometry that paints and hit-tests (INV-2).
    pub fn semantic_items(&self) -> Vec<SemanticItem> {
        self.nodes
            .iter()
            .map(|n| SemanticItem {
                id: n.id,
                role: n.role,
                name: n.name.clone(),
                rect: n.rect,
                focus_index: self.focus_order.iter().position(|f| *f == n.id),
            })
            .collect()
    }

    /// Stable geometry digest (refactor-stability golden, INV-3): FNV-1a
    /// over quantized geometry + semantics. Identical frames on the same
    /// platform must produce the identical digest; any visual or layout
    /// change must change it.
    pub fn digest(&self) -> u64 {
        let mut h = Fnv1a::default();
        h.write_u64(0xC0FFEE);
        h.write_u64(self.revision);
        h.write_f(self.viewport.0);
        h.write_f(self.viewport.1);
        for n in &self.nodes {
            h.write_f(n.rect.x);
            h.write_f(n.rect.y);
            h.write_f(n.rect.w);
            h.write_f(n.rect.h);
            h.write_u8(match n.paint {
                PaintData::Nothing => 0,
                PaintData::Text { .. } => 1,
                PaintData::Button { .. } => 2,
                PaintData::Input { .. } => 3,
            });
            h.write_str(&n.name);
            h.write_u64(n.action.map(|a| a.0).unwrap_or(0));
        }
        for f in &self.focus_order {
            h.write_u32(f.slot());
        }
        let mut fields: Vec<(u64, u64)> = self
            .inputs
            .iter()
            .map(|(f, frame)| {
                let mut kh = Fnv1a::default();
                kh.write_str(match f {
                    FieldId::Composer => "Composer",
                    FieldId::Named(s) => s,
                });
                let mut vh = Fnv1a::default();
                if let Some(c) = frame.caret_rect {
                    vh.write_f(c.x);
                    vh.write_f(c.y);
                    vh.write_f(c.w);
                    vh.write_f(c.h);
                }
                for s in &frame.selection_rects {
                    vh.write_f(s.x);
                    vh.write_f(s.y);
                    vh.write_f(s.w);
                    vh.write_f(s.h);
                }
                (kh.finish(), vh.finish())
            })
            .collect();
        fields.sort_unstable();
        for (k, v) in fields {
            h.write_u64(k);
            h.write_u64(v);
        }
        h.finish()
    }
}

/// One a11y export item.
#[derive(Clone, Debug)]
pub struct SemanticItem {
    pub id: SceneId,
    pub role: A11yRole,
    pub name: String,
    pub rect: Rect,
    pub focus_index: Option<usize>,
}

/// FNV-1a 64-bit (small, dependency-free; deterministic across runs and
/// platforms — this is a digest for equality, not a crypto hash).
#[derive(Default)]
pub struct Fnv1a(u64);

impl Fnv1a {
    pub fn write_bytes(&mut self, bytes: &[u8]) {
        let mut h = if self.0 == 0 {
            0xcbf29ce484222325
        } else {
            self.0
        };
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        self.0 = h;
    }

    pub fn write_str(&mut self, s: &str) {
        self.write_bytes(s.as_bytes());
        self.write_bytes(&[0xFF]);
    }

    pub fn write_u8(&mut self, v: u8) {
        self.write_bytes(&[v]);
    }

    pub fn write_u32(&mut self, v: u32) {
        self.write_bytes(&v.to_le_bytes());
    }

    pub fn write_u64(&mut self, v: u64) {
        self.write_bytes(&v.to_le_bytes());
    }

    pub fn write_f(&mut self, v: f32) {
        // Quantize to 0.25 px so float noise from different build modes
        // cannot flip the digest, while real geometry changes always move
        // by >= 1 px.
        let q = (v * 4.0).round() as i64;
        self.write_bytes(&q.to_le_bytes());
    }

    pub fn finish(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::{CursorOp, Editor};
    use crate::layout::SceneLayouter;
    use crate::scene::{Scene, SceneNode, TextRun};
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
    fn caret_and_selection_geometry_live_in_the_snapshot() {
        let mut s = Scene::new();
        let root = s.root();
        let input = s.append_child(
            root,
            SceneNode {
                kind: NodeKind::Input {
                    field: FieldId::Composer,
                    placeholder: "type here".into(),
                },
                layout: NodeLayout::column()
                    .with_height(SizeToken::Height(crate::style::ControlHeightToken::Control)),
                ..SceneNode::container(NodeLayout::column())
            },
        );
        s.hydrate_input(FieldId::Composer, "hello caret");
        s.input_mut(FieldId::Composer).apply(CursorOp::Position {
            index: 5,
            select: false,
        });
        let snap = build(&mut s);
        let frame = &snap.inputs[&FieldId::Composer];
        assert!(frame.rect.h > 0.0);
        let caret = frame.caret_rect.expect("caret geometry");
        assert!(caret.h > 4.0);
        // Move into a selection and re-layout: selection rects appear.
        s.input_mut(FieldId::Composer).apply(CursorOp::Position {
            index: 0,
            select: true,
        });
        s.input_mut(FieldId::Composer)
            .apply(CursorOp::MoveToEnd { select: true });
        let snap2 = build(&mut s);
        let frame2 = &snap2.inputs[&FieldId::Composer];
        assert!(!frame2.selection_rects.is_empty());
        assert_eq!(snap.inputs[&FieldId::Composer].node, input);
    }

    #[test]
    fn digest_is_stable_and_sensitive() {
        let mut s = Scene::new();
        let root = s.root();
        let _t = s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("digest", TextTokens::body())]),
        );
        let snap_a = build(&mut s);
        let snap_b = build(&mut s);
        assert_eq!(snap_a.digest(), snap_b.digest(), "same scene → same digest");
        s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("more", TextTokens::body())]),
        );
        let snap_c = build(&mut s);
        assert_ne!(
            snap_a.digest(),
            snap_c.digest(),
            "added node → changed digest"
        );
    }

    #[test]
    fn editor_state_drives_caret_not_the_projection() {
        let mut s = Scene::new();
        let root = s.root();
        s.append_child(
            root,
            SceneNode {
                kind: NodeKind::Input {
                    field: FieldId::Composer,
                    placeholder: String::new(),
                },
                layout: NodeLayout::column()
                    .with_height(SizeToken::Height(crate::style::ControlHeightToken::Control)),
                ..SceneNode::container(NodeLayout::column())
            },
        );
        s.hydrate_input(FieldId::Composer, "abc");
        let e: &mut Editor = s.input_mut(FieldId::Composer);
        e.apply(CursorOp::MoveToStart { select: false });
        let snap = build(&mut s);
        let caret = snap.inputs[&FieldId::Composer].caret_rect.unwrap();
        assert_eq!(caret.x, snap.inputs[&FieldId::Composer].text_origin.0);
    }
}
