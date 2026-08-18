//! M0-D1a display-list corpus as a production-crate regression (not a lab re-run).

use neotavern_neocompositor::{
    barriers_cut_raster_runs, compile_passes, AffineCoeffs, BackdropRootId, BarrierId, ClipChainId,
    ClipNode, CompiledPass, EffectKind, EffectNode, EffectNodeId, EffectScopeId, GlassBoundary,
    ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk, PaintChunkId, PaintOrderKey, Rect,
    SpatialNode, SpatialNodeId, StubPayload,
};
use std::sync::Arc;

const D1A_WIDTH: u32 = 320;
const D1A_HEIGHT: u32 = 200;

fn static_d1a_scene() -> NeoDisplayList {
    let root_spatial = SpatialNodeId(0);
    let overlay_spatial = SpatialNodeId(1);
    let root_clip = ClipChainId(0);
    let glass_b_clip = ClipChainId(1);
    let root_effect = EffectNodeId(0);
    let opacity_effect = EffectNodeId(1);
    let root_backdrop = BackdropRootId(0);
    let opacity_scope = EffectScopeId(1);

    let wallpaper = PaintChunk {
        id: PaintChunkId(1),
        generation: 1,
        paint_order: PaintOrderKey(10),
        spatial_node: root_spatial,
        clip_chain: root_clip,
        effect_node: root_effect,
        backdrop_root: root_backdrop,
        bounds: Rect::new(0.0, 0.0, D1A_WIDTH as f32, D1A_HEIGHT as f32),
        payload: StubPayload::Wallpaper,
    };
    let text = PaintChunk {
        id: PaintChunkId(2),
        generation: 1,
        paint_order: PaintOrderKey(30),
        spatial_node: root_spatial,
        clip_chain: root_clip,
        effect_node: root_effect,
        backdrop_root: root_backdrop,
        bounds: Rect::new(36.0, 132.0, 210.0, 28.0),
        payload: StubPayload::VectorUi,
    };
    let grouped_vector = PaintChunk {
        id: PaintChunkId(3),
        generation: 1,
        paint_order: PaintOrderKey(40),
        spatial_node: root_spatial,
        clip_chain: glass_b_clip,
        effect_node: opacity_effect,
        backdrop_root: root_backdrop,
        bounds: Rect::new(88.0, 84.0, 90.0, 36.0),
        payload: StubPayload::VectorUi,
    };
    let overlay = PaintChunk {
        id: PaintChunkId(4),
        generation: 1,
        paint_order: PaintOrderKey(60),
        spatial_node: overlay_spatial,
        clip_chain: root_clip,
        effect_node: root_effect,
        backdrop_root: root_backdrop,
        bounds: Rect::new(208.0, 8.0, 96.0, 22.0),
        payload: StubPayload::Overlay,
    };
    let glass_a = GlassBoundary {
        id: BarrierId(1),
        spatial_node: root_spatial,
        clip_chain: root_clip,
        effect_node: root_effect,
        backdrop_root: root_backdrop,
        roi: Rect::new(24.0, 40.0, 140.0, 80.0),
    };
    let glass_b = GlassBoundary {
        id: BarrierId(2),
        spatial_node: root_spatial,
        clip_chain: glass_b_clip,
        effect_node: opacity_effect,
        backdrop_root: root_backdrop,
        roi: Rect::new(80.0, 70.0, 140.0, 80.0),
    };

    NeoDisplayList {
        generation: 1,
        width: D1A_WIDTH,
        height: D1A_HEIGHT,
        spatial: Arc::from([
            SpatialNode {
                id: root_spatial,
                parent: None,
                transform: AffineCoeffs::IDENTITY,
            },
            SpatialNode {
                id: overlay_spatial,
                parent: Some(root_spatial),
                transform: AffineCoeffs::translate(4.0, 2.0),
            },
        ]),
        clips: Arc::from([
            ClipNode {
                id: root_clip,
                parent: None,
                rect: Rect::new(0.0, 0.0, D1A_WIDTH as f32, D1A_HEIGHT as f32),
            },
            ClipNode {
                id: glass_b_clip,
                parent: Some(root_clip),
                rect: Rect::new(72.0, 64.0, 160.0, 96.0),
            },
        ]),
        effects: Arc::from([
            EffectNode {
                id: root_effect,
                parent: None,
                spatial_node: root_spatial,
                clip_chain: root_clip,
                bounds: Rect::new(0.0, 0.0, D1A_WIDTH as f32, D1A_HEIGHT as f32),
                kind: EffectKind::Isolation,
                backdrop_root: root_backdrop,
            },
            EffectNode {
                id: opacity_effect,
                parent: Some(root_effect),
                spatial_node: root_spatial,
                clip_chain: glass_b_clip,
                bounds: Rect::new(72.0, 64.0, 160.0, 96.0),
                kind: EffectKind::Opacity(0.85),
                backdrop_root: root_backdrop,
            },
        ]),
        ops: Arc::from([
            NeoPaintOp::Image(ImageLayer { chunk: wallpaper }),
            NeoPaintOp::BackdropBarrier(glass_a),
            NeoPaintOp::PaintChunk(text),
            NeoPaintOp::BeginEffectScope(opacity_scope),
            NeoPaintOp::PaintChunk(grouped_vector),
            NeoPaintOp::BackdropBarrier(glass_b),
            NeoPaintOp::EndEffectScope(opacity_scope),
            NeoPaintOp::PaintChunk(overlay),
        ]),
    }
}

#[test]
fn m0_d1a_pass_order_is_regression_for_production_compile_passes() {
    let scene = static_d1a_scene();
    let passes = compile_passes(&scene).expect("valid D1a list");
    let kinds: Vec<&'static str> = passes
        .iter()
        .map(|pass| match pass {
            CompiledPass::Raster { .. } => "raster",
            CompiledPass::Glass { .. } => "glass",
            CompiledPass::MovingSample { .. } => "moving",
            CompiledPass::Interaction { .. } => "interaction",
        })
        .collect();
    assert_eq!(
        kinds,
        ["raster", "glass", "raster", "raster", "glass", "raster"]
    );
    assert!(barriers_cut_raster_runs(&scene, &passes));
}
