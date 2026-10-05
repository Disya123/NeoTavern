//! The retained scene model (ADR-0057 platform spec §3).
//!
//! A [`Scene`] is a retained tree of [`SceneNode`]s in an epoch arena. The
//! product projection rebuilds *content* per frame but keeps node
//! identities stable (same message → same [`SceneId`]), so editor state,
//! hit-testing and focus survive re-projection. Nodes are role-based — the
//! platform owns containers/text/buttons/inputs/slots, the product fills
//! them with data (INV-1: no product state is stored here beyond the
//! input editors, which are ephemeral interaction state, never truth).

use std::collections::BTreeMap;

use crate::arena::{SceneArena, SceneId};
use crate::editor::{Editor, FieldId};
use crate::style::{ColorToken, NodeLayout, RadiusToken, SizeToken, TextTokens};

/// Product-assigned interaction id (the pilot maps numbers to behaviors;
/// the scene core only carries them so hit-testing can return them).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SceneAction(pub u64);

/// Semantic role exported to the a11y tree (platform spec §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum A11yRole {
    Root,
    Heading,
    Text,
    Button,
    Input,
    ListItem,
    List,
}

/// A slot region (ADR-0037; the Phase-2 plugin fragment mount — ADR-0058).
/// Phase 1 reserves the variant; the pilot scene does not mount fragments.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SlotId(pub u64);

/// One styled text run (plain, token-styled).
#[derive(Clone, Debug, PartialEq)]
pub struct TextRun {
    pub text: String,
    pub tokens: TextTokens,
}

impl TextRun {
    pub fn plain(text: impl Into<String>, tokens: TextTokens) -> Self {
        Self {
            text: text.into(),
            tokens,
        }
    }
}

/// One node's kind plus the data its renderer needs.
#[derive(Clone, Debug, PartialEq)]
pub enum NodeKind {
    Container,
    /// Static text content (message bodies, labels, headers).
    Text {
        runs: Vec<TextRun>,
    },
    /// Pressable control with a text label.
    Button {
        label: Vec<TextRun>,
    },
    /// Editable field driven by the editor-core (INV-4).
    Input {
        field: FieldId,
        placeholder: String,
    },
    /// Reserved plugin surface (ADR-0058, platform spec §11).
    Slot {
        slot: SlotId,
    },
}

/// A retained scene node.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneNode {
    pub kind: NodeKind,
    pub layout: NodeLayout,
    pub background: Option<ColorToken>,
    pub radius: Option<RadiusToken>,
    /// Optional hairline border color; width is theme data.
    pub border: Option<ColorToken>,
    pub role: A11yRole,
    /// Localized accessible name (a11y export; INV-2 supplies bounds).
    pub name: String,
    pub action: Option<SceneAction>,
}

impl SceneNode {
    pub fn container(layout: NodeLayout) -> Self {
        Self {
            kind: NodeKind::Container,
            layout,
            background: None,
            radius: None,
            border: None,
            role: A11yRole::Text,
            name: String::new(),
            action: None,
        }
    }

    pub fn text(runs: Vec<TextRun>) -> Self {
        Self {
            kind: NodeKind::Text { runs },
            ..Self::container(NodeLayout::column())
        }
    }

    pub fn with_background(mut self, c: ColorToken) -> Self {
        self.background = Some(c);
        self
    }

    pub fn with_radius(mut self, r: RadiusToken) -> Self {
        self.radius = Some(r);
        self
    }

    pub fn with_role(mut self, role: A11yRole) -> Self {
        self.role = role;
        self
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }

    pub fn with_action(mut self, action: SceneAction) -> Self {
        self.action = Some(action);
        self
    }
}

/// Retained scene: arena of nodes + tree edges + per-field input state.
/// The root fills the frame: the host hands the viewport to the layout
/// pass and the root *is* the frame (children stay content-sized).
fn root_layout() -> NodeLayout {
    NodeLayout::column().with_height(SizeToken::Fill)
}

#[derive(Debug, Default)]
pub struct Scene {
    arena: SceneArena<(SceneNode, Vec<SceneId>)>,
    root: Option<SceneId>,
    /// Ephemeral editor state per field (INV-4). Hydrated by the projection
    /// from Kernel state; never a source of truth (INV-1).
    inputs: BTreeMap<FieldId, Editor>,
    /// Monotonic content revision — bumped by every mutation; the frame
    /// snapshot carries it and the host redraws only on change.
    revision: u64,
}

impl Scene {
    pub fn new() -> Self {
        Self::default()
    }

    /// The root node (created lazily).
    pub fn root(&mut self) -> SceneId {
        if let Some(r) = self.root {
            if self.arena.contains(r) {
                return r;
            }
        }
        let id = self
            .arena
            .alloc((SceneNode::container(root_layout()), Vec::new()));
        self.root = Some(id);
        self.revision += 1;
        id
    }

    pub fn root_id(&self) -> Option<SceneId> {
        self.root.filter(|r| self.arena.contains(*r))
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn node(&self, id: SceneId) -> Option<&SceneNode> {
        self.arena.get(id).map(|(n, _)| n)
    }

    pub fn node_mut(&mut self, id: SceneId) -> Option<&mut SceneNode> {
        self.arena.get_mut(id).map(|(n, _)| n)
    }

    pub fn children(&self, id: SceneId) -> &[SceneId] {
        self.arena.get(id).map(|(_, c)| c.as_slice()).unwrap_or(&[])
    }

    /// Appends a child node; parent must be live.
    pub fn append_child(&mut self, parent: SceneId, node: SceneNode) -> SceneId {
        let id = self.arena.alloc((node, Vec::new()));
        if let Some((_, children)) = self.arena.get_mut(parent) {
            children.push(id);
        }
        self.revision += 1;
        id
    }

    /// Inserts a child at a position (list reordering keeps stable ids).
    pub fn insert_child_at(&mut self, parent: SceneId, index: usize, node: SceneNode) -> SceneId {
        let id = self.arena.alloc((node, Vec::new()));
        if let Some((_, children)) = self.arena.get_mut(parent) {
            let index = index.min(children.len());
            children.insert(index, id);
        }
        self.revision += 1;
        id
    }

    /// Removes a child subtree (frees the whole branch; epoch validation
    /// makes any stale handle from an older frame inert).
    pub fn remove_child(&mut self, parent: SceneId, child: SceneId) -> bool {
        let Some((_, children)) = self.arena.get_mut(parent) else {
            return false;
        };
        let Some(pos) = children.iter().position(|c| *c == child) else {
            return false;
        };
        children.remove(pos);
        self.remove_subtree(child);
        self.revision += 1;
        true
    }

    fn remove_subtree(&mut self, id: SceneId) {
        let Some((_, children)) = self.arena.get(id) else {
            return;
        };
        let children: Vec<SceneId> = children.clone();
        for c in children {
            self.remove_subtree(c);
        }
        // Editor state is FieldId-keyed (not node-keyed): it survives node
        // removal and is re-hydrated from Kernel state on the next frame
        // (INV-1 — the editor is ephemeral interaction state, never truth).
        self.arena.remove(id);
    }

    /// Replaces all children of a node in one step (the projection's main
    /// loop: sync message rows while keeping matching ids). Children of
    /// `parent` that are absent from the new list are freed (subtree);
    /// children that moved here are re-parented.
    pub fn set_children(&mut self, parent: SceneId, children: Vec<SceneId>) {
        let Some((_, existing)) = self.arena.get(parent) else {
            return;
        };
        let existing = existing.clone();
        let freed: Vec<SceneId> = existing
            .iter()
            .copied()
            .filter(|o| !children.contains(o))
            .collect();
        for old in freed {
            self.remove_subtree(old);
        }
        if let Some((_, slot)) = self.arena.get_mut(parent) {
            *slot = children;
        }
        self.revision += 1;
    }

    /// Live ids in depth-first paint order (root first).
    pub fn paint_order(&self) -> Vec<SceneId> {
        let mut out = Vec::new();
        if let Some(root) = self.root_id() {
            self.walk(root, &mut out);
        }
        out
    }

    fn walk(&self, id: SceneId, out: &mut Vec<SceneId>) {
        out.push(id);
        let children = self.children(id).to_vec();
        for c in children {
            self.walk(c, out);
        }
    }

    // -- editor-core inputs (INV-4) --------------------------------------

    /// Editor state for a field; created empty on first touch.
    pub fn input_mut(&mut self, field: FieldId) -> &mut Editor {
        self.inputs.entry(field).or_insert_with(Editor::empty)
    }

    pub fn input(&self, field: FieldId) -> Option<&Editor> {
        self.inputs.get(&field)
    }

    /// Hydration seam: the projection sets the durable text (Kernel truth)
    /// only when it differs from what the user is editing — returns `true`
    /// when it applied the change.
    pub fn hydrate_input(&mut self, field: FieldId, text: &str) -> bool {
        let editor = self.input_mut(field);
        if editor.text() != text {
            editor.set_text(text);
            self.revision += 1;
            true
        } else {
            false
        }
    }

    pub fn input_fields(&self) -> impl Iterator<Item = FieldId> + '_ {
        self.inputs.keys().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::CursorOp;

    #[test]
    fn stable_ids_survive_removal_of_siblings() {
        let mut s = Scene::new();
        let root = s.root();
        let a = s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("a", TextTokens::body())]),
        );
        let b = s.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("b", TextTokens::body())]),
        );
        assert!(s.remove_child(root, a));
        assert!(!s.arena_contains(a));
        // b still lives with the same id
        assert!(s.node(b).is_some());
        assert_eq!(s.children(root), &[b]);
    }

    #[test]
    fn remove_subtree_frees_descendants() {
        let mut s = Scene::new();
        let root = s.root();
        let parent = s.append_child(root, SceneNode::container(NodeLayout::column()));
        let child = s.append_child(parent, SceneNode::text(vec![]));
        s.remove_child(root, parent);
        assert!(!s.arena_contains(child));
    }

    #[test]
    fn hydrate_input_only_writes_on_difference() {
        let mut s = Scene::new();
        assert!(s.hydrate_input(FieldId::Composer, "hello"));
        assert!(!s.hydrate_input(FieldId::Composer, "hello"));
        // user typed through the editor
        s.input_mut(FieldId::Composer).queue_insert("!");
        s.input_mut(FieldId::Composer)
            .apply(CursorOp::Insert { batch: 0 });
        // same durable text → no clobber of the user's cursor
        assert!(!s.hydrate_input(FieldId::Composer, "hello!"));
        assert_eq!(s.input(FieldId::Composer).unwrap().text(), "hello!");
    }

    #[test]
    fn paint_order_is_depth_first() {
        let mut s = Scene::new();
        let root = s.root();
        let list = s.append_child(root, SceneNode::container(NodeLayout::column()));
        let _row1 = s.append_child(list, SceneNode::text(vec![]));
        let _row2 = s.append_child(list, SceneNode::text(vec![]));
        let _footer = s.append_child(root, SceneNode::text(vec![]));
        let order = s.paint_order();
        assert_eq!(order.len(), 5);
        assert_eq!(order[0], root);
        assert_eq!(order[1], list);
    }

    impl Scene {
        #[cfg(test)]
        fn arena_contains(&self, id: SceneId) -> bool {
            self.arena.contains(id)
        }
    }
}
