//! Layout walk for compact Character Manager geometry and GPU avatar slots.
//!
//! Taffy `final_layout.location` is parent-relative CSS px. Physical dest
//! rects are `css * scale`. This walk is not paint order.

use blitz_dom::node::ElementData;
use blitz_dom::BaseDocument;
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
    walk(doc, doc.root_element().id, 0.0, 0.0, scale.max(1.0), &mut layout);
    layout
}

pub fn image_paints_from_layout(layout: &ProductPaintLayout, scale: f32, ready_token: u64) -> Vec<ImagePaintOp> {
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
