//! Map the Blitz paint stream to `NeoDisplayList`. Order comes only from the stream.

use std::sync::Arc;

use neotavern_presentation_m0::display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, GlassBoundary, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
};

use crate::sink::{DrawKind, StreamOp};
use crate::{D2_HEIGHT, D2_WIDTH};

pub fn assemble_from_stream(stream: &[StreamOp]) -> Result<NeoDisplayList, String> {
    let root_spatial = SpatialNodeId(0);
    let root_clip = ClipChainId(0);
    let root_effect = EffectNodeId(0);
    let root_backdrop = BackdropRootId(0);
    let mut ops = Vec::new();
    let mut layer_is_effect: Vec<bool> = Vec::new();
    let mut scope_stack: Vec<EffectScopeId> = Vec::new();
    let mut next_scope = 1u32;
    let mut chunk_id = 1u32;
    let mut paint_order = 10u32;
    let mut emitted_wallpaper = false;
    let mut opacity_bounds = Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32);
    let mut effect_nodes = vec![EffectNode {
        id: root_effect,
        parent: None,
        spatial_node: root_spatial,
        clip_chain: root_clip,
        bounds: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
        kind: EffectKind::Isolation,
        backdrop_root: root_backdrop,
    }];

    let current_effect = |scope_stack: &[EffectScopeId], root_effect: EffectNodeId| {
        scope_stack
            .last()
            .map(|id| EffectNodeId(id.0))
            .unwrap_or(root_effect)
    };

    for op in stream {
        match op {
            StreamOp::Draw { kind } => {
                let payload = if !emitted_wallpaper && *kind == DrawKind::Fill {
                    emitted_wallpaper = true;
                    StubPayload::Wallpaper
                } else {
                    StubPayload::VectorUi
                };
                let chunk = PaintChunk {
                    id: PaintChunkId(chunk_id),
                    generation: 1,
                    paint_order: PaintOrderKey(paint_order),
                    spatial_node: root_spatial,
                    clip_chain: root_clip,
                    effect_node: current_effect(&scope_stack, root_effect),
                    backdrop_root: root_backdrop,
                    bounds: Rect::new(0.0, 0.0, 1.0, 1.0),
                    payload,
                };
                chunk_id += 1;
                paint_order += 10;
                if payload == StubPayload::Wallpaper {
                    ops.push(NeoPaintOp::Image(ImageLayer { chunk }));
                } else {
                    ops.push(NeoPaintOp::PaintChunk(chunk));
                }
            }
            StreamOp::Glass { node_id, bounds } => {
                ops.push(NeoPaintOp::BackdropBarrier(GlassBoundary {
                    id: BarrierId(*node_id as u32),
                    spatial_node: root_spatial,
                    clip_chain: root_clip,
                    effect_node: current_effect(&scope_stack, root_effect),
                    backdrop_root: root_backdrop,
                    roi: *bounds,
                }));
                paint_order += 10;
            }
            StreamOp::PushLayer { alpha, clip } => {
                let is_effect = !*clip && *alpha < 1.0;
                layer_is_effect.push(is_effect);
                if is_effect {
                    let id = EffectScopeId(next_scope);
                    next_scope += 1;
                    scope_stack.push(id);
                    effect_nodes.push(EffectNode {
                        id: EffectNodeId(id.0),
                        parent: Some(root_effect),
                        spatial_node: root_spatial,
                        clip_chain: root_clip,
                        bounds: opacity_bounds,
                        kind: EffectKind::Opacity(*alpha),
                        backdrop_root: root_backdrop,
                    });
                    opacity_bounds = Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32);
                    ops.push(NeoPaintOp::BeginEffectScope(id));
                }
            }
            StreamOp::PopLayer => {
                let Some(is_effect) = layer_is_effect.pop() else {
                    return Err("unbalanced PopLayer in Blitz paint stream".into());
                };
                if is_effect {
                    let Some(id) = scope_stack.pop() else {
                        return Err("unbalanced effect scope".into());
                    };
                    ops.push(NeoPaintOp::EndEffectScope(id));
                }
            }
        }
    }

    if !layer_is_effect.is_empty() || !scope_stack.is_empty() {
        return Err("unclosed layer/effect scope in Blitz paint stream".into());
    }

    Ok(NeoDisplayList {
        generation: 1,
        width: D2_WIDTH,
        height: D2_HEIGHT,
        spatial: Arc::from([SpatialNode {
            id: root_spatial,
            parent: None,
            transform: AffineCoeffs::IDENTITY,
        }]),
        clips: Arc::from([ClipNode {
            id: root_clip,
            parent: None,
            rect: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
        }]),
        effects: Arc::from(effect_nodes),
        ops: Arc::from(ops),
    })
}
