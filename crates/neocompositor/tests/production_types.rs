use neotavern_neocompositor::{
    barriers_cut_raster_runs, compile_passes, production_host_from_flag, AffineCoeffs,
    BackdropRootId, BarrierId, ClipChainId, ClipNode, CompiledPass, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, FrameTransaction, GlassBoundary, LayerCache, LayerKey,
    NeoDisplayList, NeoGlass, NeoPaintOp, NeoScene, PaintChunk, PaintChunkId, PaintOrderKey,
    PresentationHost, Rect, SpatialNode, SpatialNodeId, StubPayload, TargetPool, TargetPoolError,
};
use std::sync::Arc;

fn two_barrier_scene() -> NeoDisplayList {
    let spatial = Arc::from([SpatialNode {
        id: SpatialNodeId(0),
        parent: None,
        transform: AffineCoeffs::IDENTITY,
    }]);
    let clips = Arc::from([ClipNode {
        id: ClipChainId(0),
        parent: None,
        rect: Rect::new(0.0, 0.0, 1080.0, 2400.0),
    }]);
    let effects = Arc::from([EffectNode {
        id: EffectNodeId(0),
        parent: None,
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        bounds: Rect::new(0.0, 0.0, 1080.0, 2400.0),
        kind: EffectKind::Isolation,
        backdrop_root: BackdropRootId(0),
    }]);
    let chunk = |id, payload, bounds| PaintChunk {
        id: PaintChunkId(id),
        generation: 1,
        paint_order: PaintOrderKey(id),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
        bounds,
        payload,
    };
    let ops = Arc::from([
        NeoPaintOp::BeginEffectScope(EffectScopeId(0)),
        NeoPaintOp::PaintChunk(chunk(
            1,
            StubPayload::Wallpaper,
            Rect::new(0.0, 0.0, 1080.0, 2400.0),
        )),
        NeoPaintOp::BackdropBarrier(GlassBoundary {
            id: BarrierId(1),
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            effect_node: EffectNodeId(0),
            backdrop_root: BackdropRootId(0),
            roi: Rect::new(40.0, 160.0, 1000.0, 720.0),
        }),
        NeoPaintOp::PaintChunk(chunk(
            2,
            StubPayload::VectorUi,
            Rect::new(80.0, 200.0, 920.0, 200.0),
        )),
        NeoPaintOp::PaintChunk(chunk(
            3,
            StubPayload::MovingSample,
            Rect::new(80.0, 980.0, 400.0, 220.0),
        )),
        NeoPaintOp::EndEffectScope(EffectScopeId(0)),
    ]);
    NeoDisplayList {
        generation: 1,
        width: 1080,
        height: 2400,
        spatial,
        clips,
        effects,
        ops,
    }
}

#[test]
fn compile_passes_cuts_glass_and_moving_sample() {
    let list = two_barrier_scene();
    let passes = compile_passes(&list).expect("valid list");
    assert!(matches!(passes[0], CompiledPass::Raster { .. }));
    assert!(matches!(
        passes[1],
        CompiledPass::Glass {
            barrier: GlassBoundary {
                id: BarrierId(1),
                ..
            },
            ..
        }
    ));
    assert!(matches!(passes[2], CompiledPass::Raster { .. }));
    assert!(matches!(passes[3], CompiledPass::MovingSample { .. }));
    assert!(barriers_cut_raster_runs(&list, &passes));
}

#[test]
fn frame_transaction_defaults_to_full_frame_damage() {
    let scene = NeoScene::from_display_list(two_barrier_scene());
    assert_eq!(scene.glass.len(), 1);
    let glass = NeoGlass::from_surface(scene.glass[0].clone());
    assert_eq!(glass.surface.barrier_id, 1);
    let tx = FrameTransaction::full_frame(scene);
    assert_eq!(tx.generation(), 1);
    assert_eq!(tx.damage().len(), 1);
    assert_eq!(tx.damage()[0].width, 1080);
}

#[test]
fn production_host_defaults_to_webview_rollback() {
    assert_eq!(
        production_host_from_flag(None),
        PresentationHost::WebViewRollback
    );
    assert_eq!(
        production_host_from_flag(Some("1")),
        PresentationHost::NeoCompositor { feature_flag: true }
    );
    assert_eq!(
        production_host_from_flag(Some("0")),
        PresentationHost::WebViewRollback
    );
}

#[test]
fn layer_cache_evicts_at_cap() {
    let mut cache = LayerCache::new(1);
    cache.insert(LayerKey {
        chunk: PaintChunkId(1),
        generation: 1,
    });
    cache.insert(LayerKey {
        chunk: PaintChunkId(2),
        generation: 1,
    });
    assert_eq!(cache.len(), 1);
    assert!(!cache.get(LayerKey {
        chunk: PaintChunkId(1),
        generation: 1,
    }));
    assert!(cache.get(LayerKey {
        chunk: PaintChunkId(2),
        generation: 1,
    }));
    assert_eq!(cache.stats().evictions, 1);
}

#[test]
fn target_pool_refuses_to_grow_past_cap() {
    let mut pool = TargetPool::new(1);
    let first = pool.acquire().expect("first target");
    assert_eq!(pool.acquire(), Err(TargetPoolError::Exhausted));
    pool.release(first);
    assert!(pool.acquire().is_ok());
}
