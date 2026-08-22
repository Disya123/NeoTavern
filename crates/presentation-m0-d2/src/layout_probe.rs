//! Layout walk for compact Character Manager geometry and GPU avatar slots.
//!
//! Taffy `final_layout.location` is parent-relative CSS px. Physical dest
//! rects are `css * scale`. This walk is not paint order.

use blitz_dom::node::ElementData;
use blitz_dom::BaseDocument;
use dioxus_core::Element;
use neotavern_neocompositor::{ImagePaintOp, NeoDisplayList, NeoPaintOp, Rect};
use std::sync::Arc;

/// Compact Character Manager metrics after one Blitz layout.
#[derive(Clone, Debug, Default)]
pub struct ProductPaintLayout {
    pub card_css_width: f32,
    pub card_css_height: f32,
    pub title_css_width: f32,
    pub title_css_height: f32,
    pub avatars: Vec<AvatarSlot>,
    /// Chat message row boxes (`data-part="message"`, keyed by
    /// `data-message-id`), in window CSS px — used by the desktop host to
    /// hit-test the inline message action row (e.g. copy).
    pub messages: Vec<MessageRect>,
    /// Markdown structure probes: `data-part="message-code"` node count,
    /// `data-part="message-image"` block count, and the first
    /// `data-part="message-author"` width (distinguishes resolved character
    /// names from fallbacks by rendered advance).
    pub markdown_code_nodes: u32,
    pub markdown_image_blocks: u32,
    pub author_css_width: Option<f32>,
}

#[derive(Clone, Debug)]
pub struct MessageRect {
    pub id: String,
    pub css_x: f32,
    pub css_y: f32,
    pub css_width: f32,
    pub css_height: f32,
}

#[derive(Clone, Debug)]
pub struct AvatarSlot {
    pub asset_id: String,
    pub kind: AvatarKind,
    pub css_x: f32,
    pub css_y: f32,
    pub css_width: f32,
    pub css_height: f32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AvatarKind {
    Header,
    Card,
    Editor,
    Other,
}

/// React `--st-radius-control` on header/card avatars.
pub const AVATAR_CLIP_RADIUS_CSS: f32 = 10.0;

pub fn collect_paint_layout(doc: &BaseDocument, scale: f32) -> ProductPaintLayout {
    let mut layout = ProductPaintLayout::default();
    walk(
        doc,
        doc.root_element().id,
        0.0,
        0.0,
        scale.max(1.0),
        &mut layout,
    );
    layout
}

pub fn image_paints_from_layout(
    layout: &ProductPaintLayout,
    scale: f32,
    ready_token: u64,
) -> Vec<ImagePaintOp> {
    let scale = scale.max(1.0);
    layout
        .avatars
        .iter()
        .filter(|slot| !slot.asset_id.is_empty())
        .map(|slot| ImagePaintOp {
            asset_id: slot.asset_id.clone(),
            dest: Rect::new(
                slot.css_x * scale,
                slot.css_y * scale,
                slot.css_width * scale,
                slot.css_height * scale,
            ),
            clip_radius: AVATAR_CLIP_RADIUS_CSS * scale,
            ready_token,
        })
        .collect()
}

pub fn attach_image_paints(list: NeoDisplayList, paints: &[ImagePaintOp]) -> NeoDisplayList {
    if paints.is_empty() {
        return list;
    }
    let mut ops = list.ops.to_vec();
    ops.extend(paints.iter().cloned().map(NeoPaintOp::ImagePaint));
    NeoDisplayList {
        ops: Arc::from(ops),
        ..list
    }
}

fn walk(
    doc: &BaseDocument,
    node_id: usize,
    origin_x: f32,
    origin_y: f32,
    scale: f32,
    out: &mut ProductPaintLayout,
) {
    let Some(node) = doc.get_node(node_id) else {
        return;
    };
    let layout = node.final_layout;
    let x = origin_x + layout.location.x;
    let y = origin_y + layout.location.y;
    if let Some(data) = node.element_data() {
        if attr_is(data, "data-part", "character-card") {
            out.card_css_width = layout.size.width;
            out.card_css_height = layout.size.height;
        }
        if attr_is(data, "data-part", "title") {
            out.title_css_width = layout.size.width;
            out.title_css_height = layout.size.height;
        }
        if attr_is(data, "data-part", "avatar-fallback") {
            let asset_id = attr_get(data, "data-avatar-asset").unwrap_or_default();
            if !asset_id.is_empty() {
                let class = attr_get(data, "class").unwrap_or_default();
                out.avatars.push(AvatarSlot {
                    asset_id,
                    kind: avatar_kind(&class),
                    css_x: x,
                    css_y: y,
                    css_width: layout.size.width,
                    css_height: layout.size.height,
                });
            }
        }
        // React MessageBubble is `data-component="chat-message"`; the native
        // tree also keeps `data-part="message"` so older hit-tests still find
        // the row.
        if attr_is(data, "data-part", "message") || attr_is(data, "data-component", "chat-message")
        {
            let id = attr_get(data, "data-message-id").unwrap_or_default();
            if !id.is_empty()
                && !out
                    .messages
                    .iter()
                    .any(|row| row.id == id)
            {
                out.messages.push(MessageRect {
                    id,
                    css_x: x,
                    css_y: y,
                    css_width: layout.size.width,
                    css_height: layout.size.height,
                });
            }
        }
        if attr_is(data, "data-part", "message-code") {
            out.markdown_code_nodes += 1;
        }
        if attr_is(data, "data-part", "message-image") {
            out.markdown_image_blocks += 1;
        }
        if attr_is(data, "data-part", "message-author") && out.author_css_width.is_none() {
            out.author_css_width = Some(layout.size.width);
        }
    }
    let _ = scale;
    for child_id in node.children.clone() {
        walk(doc, child_id, x, y, scale, out);
    }
}

fn avatar_kind(class: &str) -> AvatarKind {
    if class.contains("headerAvatar") {
        AvatarKind::Header
    } else if class.contains("cardAvatar") {
        AvatarKind::Card
    } else if class.contains("editorAvatar") {
        AvatarKind::Editor
    } else {
        AvatarKind::Other
    }
}

fn attr_is(data: &ElementData, name: &str, value: &str) -> bool {
    data.attrs
        .iter()
        .any(|attr| *attr.name.local == *name && attr.value == value)
}

fn attr_get(data: &ElementData, name: &str) -> Option<String> {
    data.attrs.iter().find_map(|attr| {
        if *attr.name.local == *name {
            Some(attr.value.to_string())
        } else {
            None
        }
    })
}

/// Debug: dump layout rects of the tab chrome (`tabs-list`,
/// `tabs-scroll-content`, `tabs-content`) after one Blitz layout of `app`.
pub fn tab_debug_rects(
    app: fn() -> Element,
    width: u32,
    height: u32,
) -> Vec<(String, f32, f32, f32, f32)> {
    use blitz_traits::shell::{ColorScheme, Viewport};
    use dioxus_core::VirtualDom;
    use dioxus_native_dom::{DioxusDocument, DocumentConfig};
    let mut doc = DioxusDocument::new(
        VirtualDom::new(app),
        DocumentConfig {
            viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    doc.initial_build();
    {
        let mut inner = doc.inner.borrow_mut();
        inner.resolve(0.0);
    }
    let mut out = Vec::new();
    {
        let inner = doc.inner.borrow();
        fn walk(
            doc: &BaseDocument,
            id: usize,
            ox: f32,
            oy: f32,
            out: &mut Vec<(String, f32, f32, f32, f32)>,
        ) {
            let Some(node) = doc.get_node(id) else { return };
            let l = node.final_layout;
            let x = ox + l.location.x;
            let y = oy + l.location.y;
            if let Some(data) = node.element_data() {
                if let Some(part) = attr_get(data, "data-component") {
                    if matches!(
                        part.as_str(),
                        "tabs-list" | "tabs-scroll-content" | "tabs-content" | "tabs"
                    ) {
                        out.push((part, x, y, l.size.width, l.size.height));
                    }
                }
            }
            for child in node.children.clone() {
                walk(doc, child, x, y, out);
            }
        }
        walk(&inner, inner.root_element().id, 0.0, 0.0, &mut out);
    }
    out
}

/// One Theme SDK hook node after Blitz layout. Class names and React fiber
/// paths are deliberately omitted — the compare key is the documented
/// `data-component` / `data-part` / `data-slot` / `data-role` / `data-action`
/// contract (ADR-0055: React DOM is an oracle, not the native ABI).
#[derive(Clone, Debug, PartialEq)]
pub struct SlotNode {
    pub tag: String,
    pub component: Option<String>,
    pub part: Option<String>,
    pub slot: Option<String>,
    pub role: Option<String>,
    pub action: Option<String>,
    pub state: Option<String>,
    pub key: Option<String>,
    pub identity: String,
    pub path: String,
    pub css_x: f32,
    pub css_y: f32,
    pub css_width: f32,
    pub css_height: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SlotSkeleton {
    pub source: String,
    pub width: u32,
    pub height: u32,
    pub nodes: Vec<SlotNode>,
}

impl SlotSkeleton {
    pub fn identities(&self) -> Vec<&str> {
        self.nodes.iter().map(|node| node.identity.as_str()).collect()
    }

    pub fn count_matching(&self, needle: &str) -> usize {
        self.nodes
            .iter()
            .filter(|node| node.identity == needle || node.identity.starts_with(needle))
            .count()
    }

    pub fn has_identity(&self, needle: &str) -> bool {
        self.nodes.iter().any(|node| {
            node.identity == needle
                || node.component.as_deref() == Some(needle)
                || node.part.as_deref() == Some(needle)
                || node.slot.as_deref() == Some(needle)
                || node.action.as_deref() == Some(needle)
        })
    }
}

/// Walk the laid-out Blitz tree and keep only Theme SDK hook nodes.
pub fn collect_slot_skeleton(
    doc: &BaseDocument,
    source: &str,
    width: u32,
    height: u32,
) -> SlotSkeleton {
    let mut nodes = Vec::new();
    walk_slots(
        doc,
        doc.root_element().id,
        0.0,
        0.0,
        Vec::new(),
        &mut nodes,
    );
    SlotSkeleton {
        source: source.to_string(),
        width,
        height,
        nodes,
    }
}

fn walk_slots(
    doc: &BaseDocument,
    node_id: usize,
    origin_x: f32,
    origin_y: f32,
    ancestors: Vec<String>,
    out: &mut Vec<SlotNode>,
) {
    let Some(node) = doc.get_node(node_id) else {
        return;
    };
    let layout = node.final_layout;
    let x = origin_x + layout.location.x;
    let y = origin_y + layout.location.y;
    let mut next_ancestors = ancestors;
    if let Some(data) = node.element_data() {
        let component = nonempty_attr(data, "data-component");
        let part = nonempty_attr(data, "data-part");
        let slot = nonempty_attr(data, "data-slot");
        let role = nonempty_attr(data, "data-role");
        let action = nonempty_attr(data, "data-action");
        if component.is_some()
            || part.is_some()
            || slot.is_some()
            || role.is_some()
            || action.is_some()
        {
            let identity = slot_identity(
                component.as_deref(),
                part.as_deref(),
                slot.as_deref(),
                role.as_deref(),
                action.as_deref(),
            );
            let mut path_parts = next_ancestors.clone();
            path_parts.push(identity.clone());
            let key = nonempty_attr(data, "data-ui-key")
                .or_else(|| nonempty_attr(data, "data-message-id"));
            out.push(SlotNode {
                tag: data.name.local.to_string(),
                component,
                part,
                slot,
                role,
                action,
                state: nonempty_attr(data, "data-state"),
                key,
                identity: identity.clone(),
                path: path_parts.join(" > "),
                css_x: x,
                css_y: y,
                css_width: layout.size.width,
                css_height: layout.size.height,
            });
            next_ancestors.push(identity);
        }
    }
    for child_id in node.children.clone() {
        walk_slots(doc, child_id, x, y, next_ancestors.clone(), out);
    }
}

fn nonempty_attr(data: &ElementData, name: &str) -> Option<String> {
    attr_get(data, name).filter(|value| !value.is_empty())
}

pub fn slot_identity(
    component: Option<&str>,
    part: Option<&str>,
    slot: Option<&str>,
    role: Option<&str>,
    action: Option<&str>,
) -> String {
    let mut bits = Vec::new();
    if let Some(slot) = slot {
        bits.push(format!("slot:{slot}"));
    }
    if let Some(component) = component {
        bits.push(format!("component:{component}"));
    }
    if let Some(part) = part {
        bits.push(format!("part:{part}"));
    }
    if let Some(role) = role {
        bits.push(format!("role:{role}"));
    }
    if let Some(action) = action {
        bits.push(format!("action:{action}"));
    }
    if bits.is_empty() {
        "unknown".into()
    } else {
        bits.join("+")
    }
}

/// Pretty-print a skeleton as JSON (no serde — this crate stays dependency-light).
pub fn slot_skeleton_to_json(skeleton: &SlotSkeleton) -> String {
    let mut out = String::new();
    out.push_str("{\n");
    out.push_str(&format!(
        "  \"source\": {},\n",
        json_string(&skeleton.source)
    ));
    out.push_str(&format!("  \"viewport\": {{ \"width\": {}, \"height\": {} }},\n", skeleton.width, skeleton.height));
    out.push_str("  \"nodes\": [\n");
    for (index, node) in skeleton.nodes.iter().enumerate() {
        let comma = if index + 1 == skeleton.nodes.len() {
            ""
        } else {
            ","
        };
        out.push_str("    {\n");
        out.push_str(&format!("      \"tag\": {},\n", json_string(&node.tag)));
        out.push_str(&format!(
            "      \"component\": {},\n",
            json_opt(node.component.as_deref())
        ));
        out.push_str(&format!(
            "      \"part\": {},\n",
            json_opt(node.part.as_deref())
        ));
        out.push_str(&format!(
            "      \"slot\": {},\n",
            json_opt(node.slot.as_deref())
        ));
        out.push_str(&format!(
            "      \"role\": {},\n",
            json_opt(node.role.as_deref())
        ));
        out.push_str(&format!(
            "      \"action\": {},\n",
            json_opt(node.action.as_deref())
        ));
        out.push_str(&format!(
            "      \"state\": {},\n",
            json_opt(node.state.as_deref())
        ));
        out.push_str(&format!("      \"key\": {},\n", json_opt(node.key.as_deref())));
        out.push_str(&format!(
            "      \"identity\": {},\n",
            json_string(&node.identity)
        ));
        out.push_str(&format!("      \"path\": {},\n", json_string(&node.path)));
        out.push_str("      \"rect\": {\n");
        out.push_str(&format!("        \"x\": {:.1},\n", node.css_x));
        out.push_str(&format!("        \"y\": {:.1},\n", node.css_y));
        out.push_str(&format!("        \"w\": {:.1},\n", node.css_width));
        out.push_str(&format!("        \"h\": {:.1}\n", node.css_height));
        out.push_str("      }\n");
        out.push_str(&format!("    }}{comma}\n"));
    }
    out.push_str("  ]\n");
    out.push_str("}\n");
    out
}

pub fn write_slot_skeleton(path: &str, skeleton: &SlotSkeleton) -> Result<(), String> {
    let parent = std::path::Path::new(path)
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    std::fs::write(path, slot_skeleton_to_json(skeleton)).map_err(|err| err.to_string())
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn json_opt(value: Option<&str>) -> String {
    match value {
        Some(value) => json_string(value),
        None => "null".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_identity_joins_documented_hooks() {
        assert_eq!(
            slot_identity(
                Some("chat-message"),
                None,
                None,
                Some("assistant"),
                None
            ),
            "component:chat-message+role:assistant"
        );
        assert_eq!(
            slot_identity(None, Some("toolbar"), Some("chat.composer"), None, None),
            "slot:chat.composer+part:toolbar"
        );
    }

    #[test]
    fn slot_skeleton_json_escapes_quotes() {
        let skeleton = SlotSkeleton {
            source: "native".into(),
            width: 10,
            height: 20,
            nodes: vec![SlotNode {
                tag: "div".into(),
                component: Some("chat-view".into()),
                part: None,
                slot: None,
                role: None,
                action: None,
                state: None,
                key: Some("a\"b".into()),
                identity: "component:chat-view".into(),
                path: "component:chat-view".into(),
                css_x: 1.0,
                css_y: 2.0,
                css_width: 3.0,
                css_height: 4.0,
            }],
        };
        let json = slot_skeleton_to_json(&skeleton);
        assert!(json.contains("\"component\": \"chat-view\""));
        assert!(json.contains("\"key\": \"a\\\"b\""));
        assert!(json.contains("\"width\": 10"));
    }
}
