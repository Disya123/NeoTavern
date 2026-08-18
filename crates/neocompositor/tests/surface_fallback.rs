//! PERF-22 host corpus: non-sampleable surface fallback policy.
//!
//! Host status is **IMPLEMENTED**. PASS still requires an Android fixture
//! with a real platform surface and input routing. Milestone B remains
//! STARTED. Not production JNI.

use neotavern_neocompositor::{
    compile_passes, compile_surface_plan, AffineCoeffs, BackdropRootId, BarrierId, ClipChainId,
    ClipNode, EffectKind, EffectNode, EffectNodeId, EffectScopeId, EpochClock, FallbackPolicy,
    FrameMailbox, FrameTransaction, FrameTransactionParts, GeometryTileSnapshot, GlassBoundary,
    NeoDisplayList, NeoPaintOp, NeoScene, PaintChunk, PaintChunkId, PaintOrderKey, ParentEffect,
    PostReject, PosterFrameId, PropertySnapshot, Rect, ResolvedKind, ResourceLease,
    ResourceLeaseId, SpatialNode, SpatialNodeId, StubPayload, SurfaceCapability,
    SurfaceCompileError, SurfaceCompileRequest, SurfaceId, SurfaceSpec, TextSnapshotSet,
    TryDequeue,
};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

const FB_W: f32 = 1080.0;
const FB_H: f32 = 2400.0;
const VIEWPORT: Rect = Rect {
    x: 0.0,
    y: 0.0,
    width: FB_W,
    height: FB_H,
};
const WEBVIEW: SurfaceId = SurfaceId(1);
const VIDEO: SurfaceId = SurfaceId(2);
const MESSAGE: SurfaceId = SurfaceId(3);
const WEBVIEW_CHUNK: PaintChunkId = PaintChunkId(10);
const VIDEO_CHUNK: PaintChunkId = PaintChunkId(11);
const MESSAGE_CHUNK: PaintChunkId = PaintChunkId(12);
const POSTER: PosterFrameId = PosterFrameId(7);

fn spatial() -> Arc<[SpatialNode]> {
    Arc::from([SpatialNode {
        id: SpatialNodeId(0),
        parent: None,
        transform: AffineCoeffs::IDENTITY,
    }])
}

fn clips() -> Arc<[ClipNode]> {
    Arc::from([ClipNode {
        id: ClipChainId(0),
        parent: None,
        rect: VIEWPORT,
    }])
}

fn effects() -> Arc<[EffectNode]> {
    Arc::from([
        EffectNode {
            id: EffectNodeId(0),
            parent: None,
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            bounds: VIEWPORT,
            kind: EffectKind::Isolation,
            backdrop_root: BackdropRootId(0),
        },
        EffectNode {
            id: EffectNodeId(1),
            parent: Some(EffectNodeId(0)),
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            bounds: VIEWPORT,
            kind: EffectKind::Opacity(0.5),
            backdrop_root: BackdropRootId(0),
        },
        EffectNode {
            id: EffectNodeId(2),
            parent: Some(EffectNodeId(1)),
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            bounds: VIEWPORT,
            kind: EffectKind::Mask,
            backdrop_root: BackdropRootId(0),
        },
    ])
}

fn chunk(id: PaintChunkId, payload: StubPayload, bounds: Rect, order: u32) -> PaintChunk {
    PaintChunk {
        id,
        generation: 1,
        paint_order: PaintOrderKey(order),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
        bounds,
        payload,
    }
}

fn glass(id: u32, roi: Rect) -> NeoPaintOp {
    NeoPaintOp::BackdropBarrier(GlassBoundary {
        id: BarrierId(id),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
        roi,
    })
}

fn list(ops: Vec<NeoPaintOp>) -> NeoDisplayList {
    NeoDisplayList {
        generation: 1,
        width: FB_W as u32,
        height: FB_H as u32,
        spatial: spatial(),
        clips: clips(),
        effects: effects(),
        ops: Arc::from(ops),
    }
}

fn wallpaper_and(rest: Vec<NeoPaintOp>) -> NeoDisplayList {
    let mut ops = vec![
        NeoPaintOp::BeginEffectScope(EffectScopeId(0)),
        NeoPaintOp::PaintChunk(chunk(PaintChunkId(1), StubPayload::Wallpaper, VIEWPORT, 1)),
    ];
    ops.extend(rest);
    ops.push(NeoPaintOp::EndEffectScope(EffectScopeId(0)));
    list(ops)
}

fn webview_bounds() -> Rect {
    Rect::new(80.0, 400.0, 920.0, 640.0)
}

fn video_bounds() -> Rect {
    Rect::new(80.0, 1100.0, 920.0, 480.0)
}

fn spec(
    id: SurfaceId,
    capability: SurfaceCapability,
    bounds: Rect,
    chunk_id: PaintChunkId,
) -> SurfaceSpec {
    let mut spec = SurfaceSpec::new(id, capability, bounds);
    spec.chunk_id = Some(chunk_id);
    spec.paint_order = PaintOrderKey(chunk_id.0);
    spec.under_glass = true;
    spec
}

fn compile(
    surfaces: Vec<SurfaceSpec>,
    display_list: NeoDisplayList,
    epoch: u64,
    previous_epoch: Option<u64>,
    previous: &[(SurfaceId, SurfaceCapability)],
) -> Result<(NeoScene, neotavern_neocompositor::SurfacePlan), SurfaceCompileError> {
    let scene = NeoScene::from_display_list(display_list)
        .with_surfaces(surfaces)
        .compile_surfaces(
            neotavern_neocompositor::SceneEpoch(epoch),
            previous_epoch.map(neotavern_neocompositor::SceneEpoch),
            previous,
        )?;
    let plan = scene.surface_plan.clone().expect("compiled plan");
    Ok((scene, plan))
}

fn publish(clock: &mut EpochClock, scene: NeoScene, lease: u64) -> FrameTransaction {
    let epoch = scene
        .surface_plan
        .as_ref()
        .map(|plan| plan.scene_epoch)
        .unwrap_or(clock.next_scene());
    FrameTransaction::publish(FrameTransactionParts {
        frame_id: clock.next_frame(),
        scene_epoch: epoch,
        device_epoch: clock.device_epoch(),
        scene,
        damage: Vec::new(),
        leases: vec![ResourceLease {
            id: ResourceLeaseId(lease),
            device_epoch: clock.device_epoch(),
        }],
        properties: PropertySnapshot::empty(),
        geometry: GeometryTileSnapshot::empty(epoch),
        text: TextSnapshotSet::empty(epoch),
    })
}

fn assert_zero_copies(plan: &neotavern_neocompositor::SurfacePlan) {
    assert_eq!(plan.image_readbacks, 0);
    assert_eq!(plan.xdev, 0);
    assert_eq!(plan.sampling_edges, 0);
}

#[test]
fn webview_under_glass_gets_opaque_panel_fallback() {
    let bounds = webview_bounds();
    let mut surface = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        bounds,
        WEBVIEW_CHUNK,
    );
    surface.requested_policy = Some(FallbackPolicy::OpaquePanel);
    let list = wallpaper_and(vec![
        glass(1, Rect::new(40.0, 360.0, 1000.0, 720.0)),
        NeoPaintOp::PaintChunk(chunk(WEBVIEW_CHUNK, StubPayload::MovingSample, bounds, 10)),
    ]);
    let (scene, plan) = compile(vec![surface], list, 1, None, &[]).unwrap();
    assert_eq!(plan.scene_epoch.0, 1);
    assert_eq!(plan.resolved.len(), 1);
    let node = &plan.resolved[0];
    assert_eq!(
        node.kind,
        ResolvedKind::Fallback {
            policy: FallbackPolicy::OpaquePanel
        }
    );
    assert!(!node.original_hittable);
    assert!(node.fallback_hittable);
    assert_eq!(node.clip, bounds);
    assert_eq!(node.hit_bounds, bounds);
    assert_eq!(node.paint_order, PaintOrderKey(10));
    assert_zero_copies(&plan);
    let payload = scene.display_list.ops.iter().find_map(|op| match op {
        NeoPaintOp::PaintChunk(chunk) if chunk.id == WEBVIEW_CHUNK => Some(chunk.payload),
        _ => None,
    });
    assert_eq!(payload, Some(StubPayload::Overlay));
    assert!(compile_passes(&scene.display_list).is_ok());
}

#[test]
fn secure_video_under_glass_gets_opaque_panel_without_copy() {
    let bounds = video_bounds();
    let mut surface = spec(
        VIDEO,
        SurfaceCapability::NonSampleableSecureVideo,
        bounds,
        VIDEO_CHUNK,
    );
    surface.requested_policy = Some(FallbackPolicy::OpaquePanel);
    let list = wallpaper_and(vec![
        glass(1, Rect::new(40.0, 1040.0, 1000.0, 560.0)),
        NeoPaintOp::PaintChunk(chunk(VIDEO_CHUNK, StubPayload::MovingSample, bounds, 11)),
    ]);
    let (_scene, plan) = compile(vec![surface], list, 1, None, &[]).unwrap();
    assert_eq!(
        plan.resolved[0].kind,
        ResolvedKind::Fallback {
            policy: FallbackPolicy::OpaquePanel
        }
    );
    assert!(!plan.resolved[0].original_hittable);
    assert_zero_copies(&plan);
}

#[test]
fn webview_and_secure_video_inside_opacity_mask_use_whole_fallback() {
    let web = {
        let mut spec = spec(
            WEBVIEW,
            SurfaceCapability::NonSampleableWebView,
            webview_bounds(),
            WEBVIEW_CHUNK,
        );
        spec.parent_effects = vec![ParentEffect::Opacity, ParentEffect::Mask];
        spec.requested_policy = Some(FallbackPolicy::OpaquePanel);
        spec
    };
    let video = {
        let mut spec = spec(
            VIDEO,
            SurfaceCapability::NonSampleableSecureVideo,
            video_bounds(),
            VIDEO_CHUNK,
        );
        spec.parent_effects = vec![ParentEffect::Opacity, ParentEffect::Mask];
        spec.requested_policy = Some(FallbackPolicy::OpaquePanel);
        spec
    };
    let list = wallpaper_and(vec![
        NeoPaintOp::BeginEffectScope(EffectScopeId(1)),
        glass(1, Rect::new(40.0, 360.0, 1000.0, 1280.0)),
        NeoPaintOp::PaintChunk(chunk(
            WEBVIEW_CHUNK,
            StubPayload::MovingSample,
            webview_bounds(),
            10,
        )),
        NeoPaintOp::PaintChunk(chunk(
            VIDEO_CHUNK,
            StubPayload::MovingSample,
            video_bounds(),
            11,
        )),
        NeoPaintOp::EndEffectScope(EffectScopeId(1)),
    ]);
    let (_scene, plan) = compile(vec![web, video], list, 1, None, &[]).unwrap();
    assert_eq!(plan.resolved.len(), 2);
    for node in &plan.resolved {
        assert!(node.effects_applied_to_fallback);
        assert!(!node.original_hittable);
        assert!(matches!(node.kind, ResolvedKind::Fallback { .. }));
    }
    assert_zero_copies(&plan);
}

#[test]
fn overlapping_glass_does_not_sample_non_sampleable() {
    let mut surface = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        webview_bounds(),
        WEBVIEW_CHUNK,
    );
    surface.overlapping_glass = true;
    surface.requested_policy = Some(FallbackPolicy::OpaquePanel);
    let list = wallpaper_and(vec![
        glass(1, Rect::new(40.0, 360.0, 1000.0, 400.0)),
        glass(2, Rect::new(40.0, 560.0, 1000.0, 400.0)),
        NeoPaintOp::PaintChunk(chunk(
            WEBVIEW_CHUNK,
            StubPayload::MovingSample,
            webview_bounds(),
            10,
        )),
    ]);
    let (scene, plan) = compile(vec![surface], list, 1, None, &[]).unwrap();
    assert_eq!(scene.glass.len(), 2);
    assert_eq!(
        plan.resolved[0].kind,
        ResolvedKind::Fallback {
            policy: FallbackPolicy::OpaquePanel
        }
    );
    assert_eq!(plan.sampling_edges, 0);
    assert!(compile_passes(&scene.display_list).is_ok());
}

#[test]
fn poster_frame_fallback_uses_preauthored_poster() {
    let mut surface = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        webview_bounds(),
        WEBVIEW_CHUNK,
    );
    surface.poster = Some(POSTER);
    surface.requested_policy = Some(FallbackPolicy::PosterFrame);
    let list = wallpaper_and(vec![
        glass(1, Rect::new(40.0, 360.0, 1000.0, 720.0)),
        NeoPaintOp::PaintChunk(chunk(
            WEBVIEW_CHUNK,
            StubPayload::MovingSample,
            webview_bounds(),
            10,
        )),
    ]);
    let (_scene, plan) = compile(vec![surface], list, 1, None, &[]).unwrap();
    assert_eq!(
        plan.resolved[0].kind,
        ResolvedKind::Fallback {
            policy: FallbackPolicy::PosterFrame
        }
    );
    assert_eq!(plan.resolved[0].poster, Some(POSTER));
    assert_zero_copies(&plan);
}

#[test]
fn opaque_panel_fallback_is_explicitly_selectable() {
    let mut surface = spec(
        VIDEO,
        SurfaceCapability::NonSampleableSecureVideo,
        video_bounds(),
        VIDEO_CHUNK,
    );
    surface.requested_policy = Some(FallbackPolicy::OpaquePanel);
    let list = wallpaper_and(vec![NeoPaintOp::PaintChunk(chunk(
        VIDEO_CHUNK,
        StubPayload::VectorUi,
        video_bounds(),
        11,
    ))]);
    let (_scene, plan) = compile(vec![surface], list, 1, None, &[]).unwrap();
    assert_eq!(plan.resolved[0].policy, Some(FallbackPolicy::OpaquePanel));
}

#[test]
fn fullscreen_promotion_owns_viewport_hit_bounds() {
    let mut surface = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        webview_bounds(),
        WEBVIEW_CHUNK,
    );
    surface.promote_fullscreen = true;
    let list = wallpaper_and(vec![NeoPaintOp::PaintChunk(chunk(
        WEBVIEW_CHUNK,
        StubPayload::MovingSample,
        webview_bounds(),
        10,
    ))]);
    let (_scene, plan) = compile(vec![surface], list, 1, None, &[]).unwrap();
    let node = &plan.resolved[0];
    assert_eq!(
        node.kind,
        ResolvedKind::Fallback {
            policy: FallbackPolicy::FullscreenSurface
        }
    );
    assert_eq!(node.bounds, VIEWPORT);
    assert_eq!(node.clip, VIEWPORT);
    assert_eq!(node.hit_bounds, VIEWPORT);
    assert!(node.paint_order > PaintOrderKey(10));
}

#[test]
fn capability_change_requires_new_scene_epoch() {
    let bounds = webview_bounds();
    let sampleable = spec(
        WEBVIEW,
        SurfaceCapability::SampleableTexture,
        bounds,
        WEBVIEW_CHUNK,
    );
    let list = wallpaper_and(vec![NeoPaintOp::PaintChunk(chunk(
        WEBVIEW_CHUNK,
        StubPayload::MovingSample,
        bounds,
        10,
    ))]);
    let (_scene, plan) = compile(vec![sampleable.clone()], list.clone(), 1, None, &[]).unwrap();
    assert_eq!(plan.resolved[0].kind, ResolvedKind::Sampled);

    let mut webview = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        bounds,
        WEBVIEW_CHUNK,
    );
    webview.requested_policy = Some(FallbackPolicy::OpaquePanel);
    let previous = plan.capabilities();
    let same_epoch = compile(vec![webview.clone()], list.clone(), 1, Some(1), &previous);
    assert_eq!(
        same_epoch.err(),
        Some(SurfaceCompileError::CapabilityChangedSameEpoch)
    );

    let (scene, next) = compile(vec![webview], list, 2, Some(1), &previous).unwrap();
    assert_eq!(next.scene_epoch.0, 2);
    assert!(matches!(
        next.resolved[0].kind,
        ResolvedKind::Fallback {
            policy: FallbackPolicy::OpaquePanel
        }
    ));
    assert_eq!(scene.surface_plan.as_ref().unwrap().scene_epoch.0, 2);
}

#[test]
fn stale_epoch_is_rejected_without_panic() {
    let surface = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        webview_bounds(),
        WEBVIEW_CHUNK,
    );
    let list = wallpaper_and(vec![NeoPaintOp::PaintChunk(chunk(
        WEBVIEW_CHUNK,
        StubPayload::Overlay,
        webview_bounds(),
        10,
    ))]);
    let err = compile(vec![surface], list, 1, Some(4), &[]).err();
    assert_eq!(err, Some(SurfaceCompileError::StaleEpoch));
}

#[test]
fn fallback_blocks_click_through_to_hidden_original_and_message() {
    let mut message = spec(
        MESSAGE,
        SurfaceCapability::SampleableTexture,
        webview_bounds(),
        MESSAGE_CHUNK,
    );
    message.under_glass = false;
    message.paint_order = PaintOrderKey(5);
    let mut webview = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        webview_bounds(),
        WEBVIEW_CHUNK,
    );
    webview.requested_policy = Some(FallbackPolicy::OpaquePanel);
    webview.paint_order = PaintOrderKey(10);
    let list = wallpaper_and(vec![
        NeoPaintOp::PaintChunk(chunk(
            MESSAGE_CHUNK,
            StubPayload::VectorUi,
            webview_bounds(),
            5,
        )),
        glass(1, Rect::new(40.0, 360.0, 1000.0, 720.0)),
        NeoPaintOp::PaintChunk(chunk(
            WEBVIEW_CHUNK,
            StubPayload::MovingSample,
            webview_bounds(),
            10,
        )),
    ]);
    let (_scene, plan) = compile(vec![message, webview], list, 1, None, &[]).unwrap();
    assert!(!plan.resolved[1].original_hittable);
    assert_eq!(plan.hit(120.0, 420.0), Some(WEBVIEW));
    assert_ne!(plan.hit(120.0, 420.0), Some(MESSAGE));
}

#[test]
fn successful_plan_has_zero_readbacks_and_xdev() {
    let mut surface = spec(
        VIDEO,
        SurfaceCapability::NonSampleableSecureVideo,
        video_bounds(),
        VIDEO_CHUNK,
    );
    surface.poster = Some(POSTER);
    surface.requested_policy = Some(FallbackPolicy::PosterFrame);
    let list = wallpaper_and(vec![NeoPaintOp::PaintChunk(chunk(
        VIDEO_CHUNK,
        StubPayload::VectorUi,
        video_bounds(),
        11,
    ))]);
    let (_scene, plan) = compile(vec![surface], list, 1, None, &[]).unwrap();
    assert_zero_copies(&plan);
}

#[test]
fn malformed_partial_effect_is_rejected_and_keeps_last_known_good() {
    let mut good = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        webview_bounds(),
        WEBVIEW_CHUNK,
    );
    good.requested_policy = Some(FallbackPolicy::OpaquePanel);
    let list = wallpaper_and(vec![
        glass(1, Rect::new(40.0, 360.0, 1000.0, 720.0)),
        NeoPaintOp::PaintChunk(chunk(
            WEBVIEW_CHUNK,
            StubPayload::MovingSample,
            webview_bounds(),
            10,
        )),
    ]);
    let (scene, _plan) = compile(vec![good], list.clone(), 1, None, &[]).unwrap();
    let mut clock = EpochClock::new();
    let mailbox = FrameMailbox::with_defaults();
    let good_tx = publish(&mut clock, scene, 1);
    mailbox.post(good_tx).unwrap();
    assert!(matches!(mailbox.try_dequeue(), TryDequeue::Ready(_)));
    let lkg = mailbox.last_known_good().unwrap().leases()[0].id;

    let mut bad = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        webview_bounds(),
        WEBVIEW_CHUNK,
    );
    bad.partial_parent_effect = true;
    let panicked = catch_unwind(AssertUnwindSafe(|| {
        compile_surface_plan(SurfaceCompileRequest {
            scene_epoch: neotavern_neocompositor::SceneEpoch(2),
            previous_epoch: Some(neotavern_neocompositor::SceneEpoch(1)),
            previous_capabilities: &[(WEBVIEW, SurfaceCapability::NonSampleableWebView)],
            surfaces: &[bad.clone()],
            display_list: &list,
            viewport: VIEWPORT,
        })
    }));
    let result = panicked.expect("compiler must not panic");
    assert_eq!(result.err(), Some(SurfaceCompileError::PartialEffect));

    let bad_scene = NeoScene::from_display_list(list).with_surfaces(vec![bad]);
    let bad_tx = FrameTransaction::publish(FrameTransactionParts {
        frame_id: clock.next_frame(),
        scene_epoch: neotavern_neocompositor::SceneEpoch(2),
        device_epoch: clock.device_epoch(),
        scene: bad_scene,
        damage: Vec::new(),
        leases: vec![ResourceLease {
            id: ResourceLeaseId(99),
            device_epoch: clock.device_epoch(),
        }],
        properties: PropertySnapshot::empty(),
        geometry: GeometryTileSnapshot::empty(neotavern_neocompositor::SceneEpoch(2)),
        text: TextSnapshotSet::empty(neotavern_neocompositor::SceneEpoch(2)),
    });
    assert_eq!(mailbox.post(bad_tx), Err(PostReject::InvalidGraph));
    assert_eq!(mailbox.last_known_good().unwrap().leases()[0].id, lkg);
}

#[test]
fn missing_capability_and_forbidden_combos_are_rejected() {
    let bounds = webview_bounds();
    let list = wallpaper_and(vec![NeoPaintOp::PaintChunk(chunk(
        WEBVIEW_CHUNK,
        StubPayload::MovingSample,
        bounds,
        10,
    ))]);
    let mut missing = SurfaceSpec::new(WEBVIEW, SurfaceCapability::NonSampleableWebView, bounds);
    missing.capability = None;
    missing.chunk_id = Some(WEBVIEW_CHUNK);
    assert_eq!(
        compile(vec![missing], list.clone(), 1, None, &[]).err(),
        Some(SurfaceCompileError::MissingCapability)
    );

    let mut backdrop = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        bounds,
        WEBVIEW_CHUNK,
    );
    backdrop.as_backdrop_source = true;
    assert_eq!(
        compile(vec![backdrop], list.clone(), 1, None, &[]).err(),
        Some(SurfaceCompileError::BackdropFromNonSampleable)
    );

    let mut sampling = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        bounds,
        WEBVIEW_CHUNK,
    );
    sampling.claimed_sampling_edge = true;
    assert_eq!(
        compile(vec![sampling], list.clone(), 1, None, &[]).err(),
        Some(SurfaceCompileError::FakeSamplingDependency)
    );

    let mut copy = spec(
        VIDEO,
        SurfaceCapability::NonSampleableSecureVideo,
        video_bounds(),
        VIDEO_CHUNK,
    );
    copy.copy_requested = true;
    assert_eq!(
        compile(vec![copy], list.clone(), 1, None, &[]).err(),
        Some(SurfaceCompileError::SecureCopy)
    );

    let mut overlay = spec(
        SurfaceId(9),
        SurfaceCapability::ProtectedOverlay,
        bounds,
        WEBVIEW_CHUNK,
    );
    overlay.requested_policy = Some(FallbackPolicy::OpaquePanel);
    assert_eq!(
        compile(vec![overlay], list.clone(), 1, None, &[]).err(),
        Some(SurfaceCompileError::UnsupportedCombo)
    );

    let mut poster = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        bounds,
        WEBVIEW_CHUNK,
    );
    poster.requested_policy = Some(FallbackPolicy::PosterFrame);
    assert_eq!(
        compile(vec![poster], list, 1, None, &[]).err(),
        Some(SurfaceCompileError::PosterWithoutSource)
    );
}

#[test]
fn sampleable_texture_may_be_backdrop_source() {
    let mut surface = spec(
        WEBVIEW,
        SurfaceCapability::SampleableTexture,
        webview_bounds(),
        WEBVIEW_CHUNK,
    );
    surface.as_backdrop_source = true;
    surface.claimed_sampling_edge = true;
    let list = wallpaper_and(vec![
        NeoPaintOp::PaintChunk(chunk(
            WEBVIEW_CHUNK,
            StubPayload::MovingSample,
            webview_bounds(),
            10,
        )),
        glass(1, Rect::new(40.0, 360.0, 1000.0, 720.0)),
    ]);
    let (_scene, plan) = compile(vec![surface], list, 1, None, &[]).unwrap();
    assert_eq!(plan.resolved[0].kind, ResolvedKind::Sampled);
    assert!(plan.resolved[0].original_hittable);
    assert_zero_copies(&plan);
}

#[test]
fn capability_and_fallback_share_one_scene_epoch() {
    let mut surface = spec(
        WEBVIEW,
        SurfaceCapability::NonSampleableWebView,
        webview_bounds(),
        WEBVIEW_CHUNK,
    );
    surface.requested_policy = Some(FallbackPolicy::OpaquePanel);
    let list = wallpaper_and(vec![NeoPaintOp::PaintChunk(chunk(
        WEBVIEW_CHUNK,
        StubPayload::MovingSample,
        webview_bounds(),
        10,
    ))]);
    let (scene, plan) = compile(vec![surface], list, 11, None, &[]).unwrap();
    assert_eq!(plan.scene_epoch.0, 11);
    assert_eq!(scene.surface_plan.unwrap().scene_epoch.0, 11);
    assert_eq!(
        scene.surfaces[0].capability,
        Some(SurfaceCapability::NonSampleableWebView)
    );
    assert_eq!(plan.resolved[0].policy, Some(FallbackPolicy::OpaquePanel));
}
