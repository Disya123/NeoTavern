use neotavern_neocompositor::{
    compile_passes, ColorSpace, DeviceEpoch, DeviceIdentity, GpuCaps, GpuRecovery, GpuTiming,
    HandleOwner, InteropPresentOutcome, PresentationHost, RecoveryPhase, SharedGpuError,
    SharedGpuFactory, SharedHandleKind, SharedTextureFormat, TextureUsageFlags, TypedGpuHandle,
    QUEUE_CAP, TIMESTAMP_RESOLVE_CAP,
};

fn factory() -> SharedGpuFactory {
    SharedGpuFactory::new()
}

#[test]
fn context_and_device_are_created_once() {
    let mut factory = factory();
    factory.open(GpuCaps::host_default()).expect("first");
    assert_eq!(factory.devices_created(), 1);
    assert!(matches!(
        factory.open(GpuCaps::host_default()),
        Err(SharedGpuError::SecondDevice)
    ));
    assert_eq!(factory.devices_created(), 1);
}

#[test]
fn vello_and_compositor_see_the_same_device_identity() {
    let mut factory = factory();
    let ctx = factory.open(GpuCaps::host_default()).unwrap();
    let raster = ctx.bind_raster().unwrap();
    let compositor = ctx.bind_compositor().unwrap();
    assert_eq!(raster.identity, compositor.identity);
    assert_eq!(raster.identity, ctx.identity());
    assert_eq!(raster.epoch, compositor.epoch);
    assert_eq!(raster.owner, HandleOwner::Raster);
    assert_eq!(compositor.owner, HandleOwner::Compositor);
}

#[test]
fn current_epoch_tile_is_accepted_foreign_and_stale_are_rejected() {
    let mut factory = factory();
    let ctx = factory.open(GpuCaps::host_default()).unwrap();
    ctx.bind_raster().unwrap();
    ctx.bind_compositor().unwrap();
    let tile = ctx.raster_tile().unwrap();
    assert_eq!(tile.epoch, DeviceEpoch(0));
    ctx.sample_tile(tile).expect("current epoch");

    let foreign = TypedGpuHandle {
        id: tile.id,
        owner: HandleOwner::Raster,
        kind: SharedHandleKind::RasterTile,
        epoch: DeviceEpoch(0),
        identity: DeviceIdentity(99),
    };
    assert_eq!(ctx.sample_tile(foreign), Err(SharedGpuError::ForeignDevice));

    let mut recovery = GpuRecovery::new();
    recovery.initialize().unwrap();
    ctx.on_device_lost(&mut recovery).unwrap();
    assert_eq!(ctx.sample_tile(tile), Err(SharedGpuError::StaleEpoch));
}

#[test]
fn device_loss_between_raster_submit_and_composite_rejects_old_tile() {
    let mut factory = factory();
    let ctx = factory.open(GpuCaps::host_default()).unwrap();
    ctx.bind_raster().unwrap();
    ctx.bind_compositor().unwrap();
    let tile = ctx.raster_tile().unwrap();
    let mut recovery = GpuRecovery::new();
    recovery.initialize().unwrap();
    let new_epoch = ctx.on_device_lost(&mut recovery).unwrap();
    assert_eq!(new_epoch, DeviceEpoch(1));
    assert_eq!(ctx.sample_tile(tile), Err(SharedGpuError::StaleEpoch));
    ctx.bind_raster().unwrap();
    let restored = ctx.raster_tile().unwrap();
    assert_eq!(restored.epoch, DeviceEpoch(1));
    ctx.sample_tile(restored).unwrap();
}

#[test]
fn dropped_transaction_holds_lease_until_gpu_completion() {
    let mut factory = factory();
    let ctx = factory.open(GpuCaps::host_default()).unwrap();
    ctx.bind_raster().unwrap();
    let tile = ctx.raster_tile().unwrap();
    let token = ctx.sample_tile(tile).unwrap();
    assert!(ctx.lease_held(token.lease.id));
    ctx.drop_pending_latest_wins();
    assert!(ctx.lease_held(token.lease.id));
    assert_eq!(
        ctx.present().unwrap(),
        InteropPresentOutcome::SkippedNotReady
    );
    ctx.complete_oldest();
    assert!(!ctx.lease_held(token.lease.id));
}

#[test]
fn queue_saturation_does_not_block_present() {
    let mut factory = factory();
    let ctx = factory.open(GpuCaps::host_default()).unwrap();
    ctx.bind_raster().unwrap();
    for _ in 0..QUEUE_CAP {
        let tile = ctx.raster_tile().unwrap();
        ctx.sample_tile(tile).unwrap();
    }
    let extra = ctx.raster_tile().unwrap();
    assert_eq!(ctx.sample_tile(extra), Err(SharedGpuError::QueueSaturated));
    assert_eq!(
        ctx.poll_wait_in_present(),
        Err(SharedGpuError::PollWaitForbidden)
    );
    assert!(matches!(
        ctx.present().unwrap(),
        InteropPresentOutcome::Presented { .. }
    ));
}

#[test]
fn unsupported_timestamp_queries_are_unavailable_and_bounded() {
    let mut factory = factory();
    let ctx = factory.open(GpuCaps::host_default()).unwrap();
    assert_eq!(ctx.request_timestamp(), GpuTiming::Unavailable);
    assert_eq!(ctx.telemetry().timestamp_mode, GpuTiming::Unavailable);

    let mut capped = SharedGpuFactory::new();
    let ctx = capped
        .open(GpuCaps {
            compute: true,
            timestamp_queries: true,
            max_texture_dimension_2d: 4096,
        })
        .unwrap();
    for _ in 0..TIMESTAMP_RESOLVE_CAP {
        assert!(matches!(
            ctx.request_timestamp(),
            GpuTiming::AsyncBounded { .. }
        ));
    }
    assert_eq!(
        ctx.request_timestamp(),
        GpuTiming::AsyncBounded {
            pending: TIMESTAMP_RESOLVE_CAP,
            cap: TIMESTAMP_RESOLVE_CAP
        }
    );
    let _ = ctx.present().unwrap();
    ctx.resolve_timestamps_async();
    assert!(ctx.telemetry().timestamp_resolves <= u64::from(TIMESTAMP_RESOLVE_CAP));
    assert_eq!(ctx.telemetry().image_readbacks, 0);
    assert_eq!(ctx.telemetry().cross_device_copies, 0);
}

#[test]
fn ten_thousand_frames_do_not_grow_live_textures_or_targets() {
    let mut factory = factory();
    let ctx = factory.open(GpuCaps::host_default()).unwrap();
    ctx.bind_raster().unwrap();
    ctx.bind_compositor().unwrap();
    ctx.alloc(HandleOwner::Compositor, SharedHandleKind::Accumulator)
        .unwrap();
    ctx.alloc(HandleOwner::Glass, SharedHandleKind::GlassRoi)
        .unwrap();
    ctx.alloc(HandleOwner::Surface, SharedHandleKind::Surface)
        .unwrap();
    for _ in 0..10_000u32 {
        let tile = ctx.raster_tile().unwrap();
        ctx.sample_tile(tile).unwrap();
        ctx.present().unwrap();
        ctx.complete_oldest();
    }
    let snap = ctx.telemetry();
    assert_eq!(snap.live_textures, 0);
    assert!(snap.live_textures_high_water <= 1);
    assert_eq!(snap.live_targets, 2);
    assert_eq!(snap.live_targets_high_water, 2);
    assert_eq!(snap.image_readbacks, 0);
    assert_eq!(snap.cross_device_copies, 0);
    assert_eq!(snap.devices, 1);
}

#[test]
fn unsupported_compute_degrades_to_webview_without_second_device() {
    let mut factory = factory();
    let ctx = factory
        .open(GpuCaps {
            compute: false,
            timestamp_queries: false,
            max_texture_dimension_2d: 4096,
        })
        .unwrap();
    assert_eq!(ctx.phase(), RecoveryPhase::Degraded);
    assert_eq!(ctx.host(), PresentationHost::WebViewRollback);
    assert_eq!(ctx.bind_raster(), Err(SharedGpuError::Degraded));
    assert_eq!(factory.devices_created(), 1);
}

#[test]
fn format_is_explicit_and_forbids_cpu_readback() {
    let mut factory = factory();
    let ctx = factory.open(GpuCaps::host_default()).unwrap();
    let format = ctx.format();
    assert_eq!(format.color_space, ColorSpace::Srgb);
    assert_eq!(format.texture_format, SharedTextureFormat::Rgba8Unorm);
    assert!(format.usage.contains(TextureUsageFlags::SAMPLE));
    assert!(format.usage.contains(TextureUsageFlags::RENDER));
    assert!(!format.usage.contains(TextureUsageFlags::CPU_READBACK));
    assert_eq!(
        ctx.image_readback(),
        Err(SharedGpuError::CpuReadbackForbidden)
    );
    assert_eq!(
        ctx.cross_device_copy(),
        Err(SharedGpuError::CrossDeviceCopyForbidden)
    );
}

#[test]
fn d1a_pass_order_corpus_still_compiles() {
    compile_passes(&static_d1a_from_corpus()).expect("D1a two-barrier shape still compiles");
}

fn static_d1a_from_corpus() -> neotavern_neocompositor::NeoDisplayList {
    // The canonical regression is tests/m0_d1a_corpus.rs (not edited). This
    // helper only proves compile_passes still accepts a two-barrier D1a shape.
    use neotavern_neocompositor::{
        AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
        EffectNodeId, EffectScopeId, GlassBoundary, NeoDisplayList, NeoPaintOp, PaintChunk,
        PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
    };
    use std::sync::Arc;
    let spatial = Arc::from([
        SpatialNode {
            id: SpatialNodeId(0),
            parent: None,
            transform: AffineCoeffs::IDENTITY,
        },
        SpatialNode {
            id: SpatialNodeId(1),
            parent: Some(SpatialNodeId(0)),
            transform: AffineCoeffs::IDENTITY,
        },
    ]);
    let clips = Arc::from([
        ClipNode {
            id: ClipChainId(0),
            parent: None,
            rect: Rect::new(0.0, 0.0, 320.0, 200.0),
        },
        ClipNode {
            id: ClipChainId(1),
            parent: Some(ClipChainId(0)),
            rect: Rect::new(80.0, 72.0, 160.0, 80.0),
        },
    ]);
    let effects = Arc::from([
        EffectNode {
            id: EffectNodeId(0),
            parent: None,
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            bounds: Rect::new(0.0, 0.0, 320.0, 200.0),
            kind: EffectKind::Isolation,
            backdrop_root: BackdropRootId(0),
        },
        EffectNode {
            id: EffectNodeId(1),
            parent: Some(EffectNodeId(0)),
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(1),
            bounds: Rect::new(80.0, 72.0, 160.0, 80.0),
            kind: EffectKind::Opacity(0.5),
            backdrop_root: BackdropRootId(0),
        },
    ]);
    let chunk = |id, order, payload, bounds, clip, effect| PaintChunk {
        id: PaintChunkId(id),
        generation: 1,
        paint_order: PaintOrderKey(order),
        spatial_node: SpatialNodeId(0),
        clip_chain: clip,
        effect_node: effect,
        backdrop_root: BackdropRootId(0),
        bounds,
        payload,
    };
    NeoDisplayList {
        generation: 1,
        width: 320,
        height: 200,
        spatial,
        clips,
        effects,
        ops: Arc::from([
            NeoPaintOp::PaintChunk(chunk(
                1,
                10,
                StubPayload::Wallpaper,
                Rect::new(0.0, 0.0, 320.0, 200.0),
                ClipChainId(0),
                EffectNodeId(0),
            )),
            NeoPaintOp::BackdropBarrier(GlassBoundary {
                id: BarrierId(1),
                spatial_node: SpatialNodeId(0),
                clip_chain: ClipChainId(0),
                effect_node: EffectNodeId(0),
                backdrop_root: BackdropRootId(0),
                roi: Rect::new(24.0, 40.0, 140.0, 80.0),
            }),
            NeoPaintOp::BeginEffectScope(EffectScopeId(1)),
            NeoPaintOp::BackdropBarrier(GlassBoundary {
                id: BarrierId(2),
                spatial_node: SpatialNodeId(0),
                clip_chain: ClipChainId(1),
                effect_node: EffectNodeId(1),
                backdrop_root: BackdropRootId(0),
                roi: Rect::new(88.0, 84.0, 90.0, 48.0),
            }),
            NeoPaintOp::EndEffectScope(EffectScopeId(1)),
            NeoPaintOp::PaintChunk(chunk(
                4,
                60,
                StubPayload::Overlay,
                Rect::new(208.0, 8.0, 96.0, 22.0),
                ClipChainId(0),
                EffectNodeId(0),
            )),
        ]),
    }
}
