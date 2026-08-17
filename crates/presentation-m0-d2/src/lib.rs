//! NeoUI v4 M0-D2 producer-seam probe (RFC 4.5 stage 3).
//!
//! Geometry and text come from a real Dioxus `VirtualDom` and pinned Blitz
//! layout/paint. A public `anyrender::Scene` records paint commands. Glass
//! surfaces are typed host hooks via `data-neoui="glass"` on the laid-out
//! Blitz DOM. This crate must not substitute the D1a host-authored mock
//! display list after layout.
//!
//! Program D2 is **STARTED**, not PASS. Normative M0 stays `ENTERED`.
//! `D1=Track D GO` is not granted.

use std::sync::Arc;

use anyrender::recording::RenderCommand;
use anyrender::Scene;
use blitz_dom::BaseDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use dioxus_core::{Element, VirtualDom};
use dioxus_core_macro::rsx;
use dioxus_native_dom::{DioxusDocument, DocumentConfig};
use neotavern_presentation_m0::display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, GlassBoundary, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
};
use neotavern_presentation_m0::scene_d1a::{D1A_HEIGHT, D1A_WIDTH};

pub const D2_WIDTH: u32 = D1A_WIDTH;
pub const D2_HEIGHT: u32 = D1A_HEIGHT;
const OPACITY_SCOPE: EffectScopeId = EffectScopeId(1);
const SKIP_TAGS: &[&str] = &[
    "html", "head", "body", "main", "style", "script", "meta", "title", "link",
];

/// Experimental pins matching presentation-m0 wgpu 29 / Vello 0.9.
/// Not a D2 PASS and not a production Dioxus/Blitz adoption.
pub const D2_PIN_NOTES: &str = concat!(
    "dioxus-core/html/native-dom 0.8.0-alpha.1; ",
    "blitz-dom/paint/traits 0.3.0-beta.1; ",
    "anyrender 0.11.0 (vello 0.9 / wgpu 29). ",
    "dioxus-native 0.7.10 is rejected (old wgpu). ",
    "Full dioxus-native 0.8 is avoided (winit 0.31 window shell)."
);

/// Honest gap list. D2 cannot PASS while any of these remain.
pub fn missing_upstream_capabilities() -> &'static [&'static str] {
    &[
        "typed Blitz/anyrender Glass/backdrop paint node (host data-neoui hook is a stand-in)",
        "producer-owned synthetic moving sample after the static seam",
        "rebase experiment of this alpha/beta pin set",
        "physical Android GPU capture of the producer path",
        "first-class compositor barrier inserted by Blitz paint order, not a post-layout host walk",
    ]
}

/// D1a-shaped first-party scene. Glass uses a host hook attribute, not a
/// mock list pasted on after layout. Glass B sits inside one bounded
/// opacity/clip ancestor.
fn d2_static_app() -> Element {
    rsx! {
        div {
            style: "position:relative;width:320px;height:200px;background:#1b2433;",
            div {
                style: "position:absolute;left:0;top:0;width:320px;height:200px;background:#243044;"
            }
            div {
                class: "neoui-glass",
                "data-neoui": "glass",
                style: "position:absolute;left:24px;top:40px;width:140px;height:80px;"
            }
            div {
                style: "position:absolute;left:36px;top:132px;width:210px;height:28px;color:#e8eef7;font-size:14px;",
                "vector ui"
            }
            div {
                style: "position:absolute;left:72px;top:64px;width:160px;height:96px;opacity:0.85;overflow:hidden;",
                div {
                    style: "position:absolute;left:16px;top:20px;width:90px;height:36px;color:#d7e3f4;font-size:12px;",
                    "grouped"
                }
                div {
                    class: "neoui-glass",
                    "data-neoui": "glass",
                    style: "position:absolute;left:8px;top:6px;width:140px;height:80px;"
                }
            }
            div {
                style: "position:absolute;left:208px;top:8px;width:96px;height:22px;color:#ffffff;font-size:12px;",
                "overlay"
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProducerReport {
    pub vdom_rebuilt: bool,
    pub layout_resolved: bool,
    pub paint_commands: u64,
    pub glyph_runs: u64,
    pub glass_hooks: u64,
    pub effect_scopes: u64,
    pub source: &'static str,
    pub pin_notes: &'static str,
}

pub fn produce_static_d1a_list() -> Result<(NeoDisplayList, ProducerReport), String> {
    let vdom = VirtualDom::new(d2_static_app);
    let mut doc = DioxusDocument::new(
        vdom,
        DocumentConfig {
            viewport: Some(Viewport::new(D2_WIDTH, D2_HEIGHT, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    doc.initial_build();
    {
        let mut inner = doc.inner.borrow_mut();
        inner.resolve(0.0);
    }
    let mut scene = Scene::new();
    {
        let mut inner = doc.inner.borrow_mut();
        paint_scene(&mut scene, &mut inner, 1.0, D2_WIDTH, D2_HEIGHT, 0, 0);
    }
    let inner = doc.inner.borrow();
    let (list, glass_hooks, effect_scopes) = assemble_list_from_dom(&inner)?;
    let glyph_runs = scene
        .commands
        .iter()
        .filter(|cmd| matches!(cmd, RenderCommand::GlyphRun(_)))
        .count() as u64;
    let report = ProducerReport {
        vdom_rebuilt: true,
        layout_resolved: true,
        paint_commands: scene.commands.len() as u64,
        glyph_runs,
        glass_hooks,
        effect_scopes,
        source: "dioxus-virtualdom+blitz-layout+anyrender-scene",
        pin_notes: D2_PIN_NOTES,
    };
    Ok((list, report))
}

fn assemble_list_from_dom(doc: &BaseDocument) -> Result<(NeoDisplayList, u64, u64), String> {
    let root_spatial = SpatialNodeId(0);
    let root_clip = ClipChainId(0);
    let opacity_clip = ClipChainId(1);
    let root_effect = EffectNodeId(0);
    let opacity_effect = EffectNodeId(1);
    let root_backdrop = BackdropRootId(0);
    let mut builder = ListBuilder {
        ops: Vec::new(),
        chunk_id: 1,
        paint_order: 10,
        glass_id: 1,
        glass_hooks: 0,
        effect_scopes: 0,
        opacity_bounds: None,
        emitted_wallpaper: false,
        root_spatial,
        root_clip,
        opacity_clip,
        root_effect,
        opacity_effect,
        root_backdrop,
        in_opacity: false,
    };
    builder.walk(doc, doc.root_element().id)?;
    if builder.glass_hooks != 2 {
        return Err(format!(
            "expected 2 glass host hooks, found {}",
            builder.glass_hooks
        ));
    }
    if builder.effect_scopes != 1 {
        return Err(format!(
            "expected 1 bounded opacity/clip scope, found {}",
            builder.effect_scopes
        ));
    }
    let opacity_bounds = builder
        .opacity_bounds
        .unwrap_or(Rect::new(72.0, 64.0, 160.0, 96.0));
    let glass_hooks = builder.glass_hooks;
    let effect_scopes = builder.effect_scopes;
    let list = NeoDisplayList {
        generation: 1,
        width: D2_WIDTH,
        height: D2_HEIGHT,
        spatial: Arc::from([SpatialNode {
            id: root_spatial,
            parent: None,
            transform: AffineCoeffs::IDENTITY,
        }]),
        clips: Arc::from([
            ClipNode {
                id: root_clip,
                parent: None,
                rect: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
            },
            ClipNode {
                id: opacity_clip,
                parent: Some(root_clip),
                rect: opacity_bounds,
            },
        ]),
        effects: Arc::from([
            EffectNode {
                id: root_effect,
                parent: None,
                spatial_node: root_spatial,
                clip_chain: root_clip,
                bounds: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
                kind: EffectKind::Isolation,
                backdrop_root: root_backdrop,
            },
            EffectNode {
                id: opacity_effect,
                parent: Some(root_effect),
                spatial_node: root_spatial,
                clip_chain: opacity_clip,
                bounds: opacity_bounds,
                kind: EffectKind::Opacity(0.85),
                backdrop_root: root_backdrop,
            },
        ]),
        ops: Arc::from(builder.ops),
    };
    Ok((list, glass_hooks, effect_scopes))
}

struct ListBuilder {
    ops: Vec<NeoPaintOp>,
    chunk_id: u32,
    paint_order: u32,
    glass_id: u32,
    glass_hooks: u64,
    effect_scopes: u64,
    opacity_bounds: Option<Rect>,
    emitted_wallpaper: bool,
    root_spatial: SpatialNodeId,
    root_clip: ClipChainId,
    opacity_clip: ClipChainId,
    root_effect: EffectNodeId,
    opacity_effect: EffectNodeId,
    root_backdrop: BackdropRootId,
    in_opacity: bool,
}

impl ListBuilder {
    fn walk(&mut self, doc: &BaseDocument, node_id: usize) -> Result<(), String> {
        let Some(node) = doc.get_node(node_id) else {
            return Ok(());
        };
        let glass = is_glass_hook(node);
        let opacity = is_opacity_clip_scope(node);
        let bounds = node_bounds(node);
        let tag = element_tag(node);

        if opacity {
            if self.effect_scopes != 0 {
                return Err("D2 probe allows one bounded opacity/clip scope".into());
            }
            self.effect_scopes = 1;
            self.opacity_bounds = Some(bounds);
            self.in_opacity = true;
            self.ops.push(NeoPaintOp::BeginEffectScope(OPACITY_SCOPE));
        }

        if glass {
            self.ops.push(NeoPaintOp::BackdropBarrier(GlassBoundary {
                id: BarrierId(self.glass_id),
                spatial_node: self.root_spatial,
                clip_chain: if self.in_opacity {
                    self.opacity_clip
                } else {
                    self.root_clip
                },
                effect_node: if self.in_opacity {
                    self.opacity_effect
                } else {
                    self.root_effect
                },
                backdrop_root: self.root_backdrop,
                roi: bounds,
            }));
            self.glass_id += 1;
            self.glass_hooks += 1;
            self.paint_order += 10;
        } else if should_emit_box(tag, bounds) {
            let payload =
                if !self.emitted_wallpaper && bounds.width >= 300.0 && bounds.height >= 180.0 {
                    self.emitted_wallpaper = true;
                    StubPayload::Wallpaper
                } else if bounds.x >= 180.0 && bounds.y <= 20.0 {
                    StubPayload::Overlay
                } else {
                    StubPayload::VectorUi
                };
            let chunk = PaintChunk {
                id: PaintChunkId(self.chunk_id),
                generation: 1,
                paint_order: PaintOrderKey(self.paint_order),
                spatial_node: self.root_spatial,
                clip_chain: if self.in_opacity {
                    self.opacity_clip
                } else {
                    self.root_clip
                },
                effect_node: if self.in_opacity {
                    self.opacity_effect
                } else {
                    self.root_effect
                },
                backdrop_root: self.root_backdrop,
                bounds,
                payload,
            };
            self.chunk_id += 1;
            self.paint_order += 10;
            if payload == StubPayload::Wallpaper {
                self.ops.push(NeoPaintOp::Image(ImageLayer { chunk }));
            } else {
                self.ops.push(NeoPaintOp::PaintChunk(chunk));
            }
        }

        let children = {
            let paint = node.paint_children.borrow();
            paint.clone().unwrap_or_else(|| node.children.clone())
        };
        for child_id in children {
            self.walk(doc, child_id)?;
        }

        if opacity {
            self.ops.push(NeoPaintOp::EndEffectScope(OPACITY_SCOPE));
            self.in_opacity = false;
        }
        Ok(())
    }
}

fn element_tag(node: &blitz_dom::Node) -> Option<&str> {
    node.element_data().map(|data| data.name.local.as_ref())
}

fn attr_eq(node: &blitz_dom::Node, name: &str, value: &str) -> bool {
    node.element_data()
        .map(|data| {
            data.attrs
                .iter()
                .any(|attr| *attr.name.local == *name && attr.value == value)
        })
        .unwrap_or(false)
}

fn class_contains(node: &blitz_dom::Node, token: &str) -> bool {
    node.element_data()
        .and_then(|data| {
            data.attrs
                .iter()
                .find(|attr| *attr.name.local == *"class")
                .map(|attr| attr.value.split_whitespace().any(|part| part == token))
        })
        .unwrap_or(false)
}

fn style_contains(node: &blitz_dom::Node, needle: &str) -> bool {
    node.element_data()
        .and_then(|data| {
            data.attrs
                .iter()
                .find(|attr| *attr.name.local == *"style")
                .map(|attr| attr.value.contains(needle))
        })
        .unwrap_or(false)
}

fn is_glass_hook(node: &blitz_dom::Node) -> bool {
    attr_eq(node, "data-neoui", "glass") || class_contains(node, "neoui-glass")
}

fn is_opacity_clip_scope(node: &blitz_dom::Node) -> bool {
    style_contains(node, "opacity:") && style_contains(node, "overflow:hidden")
}

fn node_bounds(node: &blitz_dom::Node) -> Rect {
    let layout = node.final_layout;
    Rect::new(
        layout.location.x,
        layout.location.y,
        layout.size.width.max(1.0),
        layout.size.height.max(1.0),
    )
}

fn should_emit_box(tag: Option<&str>, bounds: Rect) -> bool {
    let Some(tag) = tag else {
        return false;
    };
    if SKIP_TAGS.contains(&tag) {
        return false;
    }
    bounds.width >= 1.0 && bounds.height >= 1.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use neotavern_presentation_m0::{compile_passes, static_d1a_scene, CompiledPass};

    #[test]
    fn d2_producer_uses_vdom_and_layout_not_d1a_mock() {
        let (list, report) = produce_static_d1a_list().expect("D2 producer");
        assert!(report.vdom_rebuilt);
        assert!(report.layout_resolved);
        assert_eq!(
            report.source,
            "dioxus-virtualdom+blitz-layout+anyrender-scene"
        );
        assert!(
            report.paint_commands > 0,
            "Blitz paint must record commands"
        );
        assert_eq!(report.glass_hooks, 2);
        assert_eq!(report.effect_scopes, 1);
        assert_ne!(list.ops, static_d1a_scene().ops);
        assert!(!missing_upstream_capabilities().is_empty());

        let glass_at: Vec<usize> = list
            .ops
            .iter()
            .enumerate()
            .filter_map(|(idx, op)| match op {
                NeoPaintOp::BackdropBarrier(_) => Some(idx),
                _ => None,
            })
            .collect();
        assert_eq!(glass_at.len(), 2);
        assert!(
            list.ops
                .iter()
                .take(glass_at[0])
                .any(|op| matches!(op, NeoPaintOp::PaintChunk(_) | NeoPaintOp::Image(_))),
            "Glass A must not precede every raster/image op"
        );
        assert!(
            list.ops[glass_at[0] + 1..glass_at[1]]
                .iter()
                .any(|op| matches!(op, NeoPaintOp::PaintChunk(_) | NeoPaintOp::Image(_))),
            "canonical paint order is not all fills then leftover glasses"
        );
        assert!(
            list.ops
                .iter()
                .skip(glass_at[1] + 1)
                .any(|op| matches!(op, NeoPaintOp::PaintChunk(_) | NeoPaintOp::Image(_))),
            "overlay/raster must remain after Glass B"
        );
        assert!(list
            .ops
            .iter()
            .any(|op| matches!(op, NeoPaintOp::BeginEffectScope(OPACITY_SCOPE))));
        assert!(list
            .ops
            .iter()
            .any(|op| matches!(op, NeoPaintOp::EndEffectScope(OPACITY_SCOPE))));

        let passes = compile_passes(&list).expect("compiled producer list");
        let glasses: Vec<&CompiledPass> = passes.iter().filter(|pass| pass.is_glass()).collect();
        assert_eq!(glasses.len(), 2);
        assert!(
            glasses[1].open_scopes().contains(&OPACITY_SCOPE),
            "Glass B must keep the ancestor opacity/clip scope"
        );
    }
}
