use neotavern_neocompositor::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, DeviceEpoch, EffectKind,
    EffectNode, EffectNodeId, EffectScopeId, EpochClock, FrameCause, FrameTransaction,
    GlassBoundary, GpuFault, GpuRecovery, GpuTimingAvailability, LayerKey, NeoDisplayList,
    NeoPaintOp, NeoScene, PaintChunk, PaintChunkId, PaintOrderKey, PresentationHost, RecoveryPhase,
    Rect, ResourceLease, ResourceLeaseId, SpatialNode, SpatialNodeId, StubPayload,
    LAYER_ACCOUNTING_BYTES, TARGET_ACCOUNTING_BYTES,
};
use std::sync::Arc;

fn identity() -> AffineCoeffs {
    AffineCoeffs::IDENTITY
}

fn two_barrier_scene() -> NeoDisplayList {
    let spatial = Arc::from([SpatialNode {
        id: SpatialNodeId(0),
        parent: None,
        transform: identity(),
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

fn shared_scene() -> Arc<NeoScene> {
    Arc::new(NeoScene::from_display_list(two_barrier_scene()))
}

fn publish(clock: &mut EpochClock, scene: &Arc<NeoScene>, lease: u64) -> FrameTransaction {
    let device = clock.device_epoch();
    FrameTransaction::publish_shared(
        clock.next_frame(),
        clock.next_scene(),
        device,
        Arc::clone(scene),
        Vec::new(),
        vec![ResourceLease {
            id: ResourceLeaseId(lease),
            device_epoch: device,
        }],
    )
}

fn ready() -> GpuRecovery {
    let mut gpu = GpuRecovery::new();
    gpu.initialize().expect("init");
    gpu
}

#[test]
fn telemetry_is_copy_and_gpu_timing_is_unavailable() {
    let gpu = ready();
    let snap = gpu.telemetry();
    let copy = snap;
    assert_eq!(copy.gpu_timing, GpuTimingAvailability::Unavailable);
    assert!(std::mem::size_of_val(&snap) <= 512);
}

#[test]
fn mailbox_burst_keeps_queue_high_water_bounded() {
    let gpu = ready();
    let scene = shared_scene();
    let mut clock = EpochClock::new();
    for i in 0..64u64 {
        gpu.post(publish(&mut clock, &scene, i)).expect("post");
    }
    let snap = gpu.telemetry();
    assert_eq!(gpu.mailbox().pending_count(), 1);
    assert_eq!(snap.coalesced_frames, 63);
    assert!(snap.queue_bytes > 0);
    assert_eq!(snap.queue_high_water_bytes, snap.queue_bytes);
    assert!(snap.queue_high_water_bytes <= 8 * 1024 * 1024);
}

#[test]
fn timeout_counts_as_dropped_frame_without_rebuild() {
    let mut gpu = ready();
    let before = gpu.telemetry();
    gpu.notify_fault(GpuFault::Timeout).unwrap();
    let snap = gpu.telemetry();
    assert_eq!(snap.dropped_frames, before.dropped_frames + 1);
    assert_eq!(snap.frame_cause, FrameCause::TimeoutSkip);
    assert_eq!(snap.recovery_phase, RecoveryPhase::Ready);
    assert_eq!(snap.last_recovery_reason, Some(GpuFault::Timeout));
}

#[test]
fn cache_and_target_high_water_survive_device_loss() {
    let mut gpu = ready();
    gpu.cache_insert(LayerKey {
        chunk: PaintChunkId(1),
        generation: 1,
    });
    gpu.cache_insert(LayerKey {
        chunk: PaintChunkId(2),
        generation: 1,
    });
    let _ = gpu.acquire_target().expect("target");
    let hot = gpu.telemetry();
    assert_eq!(hot.cache_bytes, 2 * LAYER_ACCOUNTING_BYTES);
    assert_eq!(hot.cache_high_water_bytes, 2 * LAYER_ACCOUNTING_BYTES);
    assert_eq!(hot.target_bytes, TARGET_ACCOUNTING_BYTES);
    assert_eq!(hot.target_high_water_bytes, TARGET_ACCOUNTING_BYTES);
    gpu.notify_fault(GpuFault::DeviceLost).unwrap();
    let cold = gpu.telemetry();
    assert_eq!(cold.cache_bytes, 0);
    assert_eq!(cold.target_bytes, 0);
    assert_eq!(cold.cache_high_water_bytes, 2 * LAYER_ACCOUNTING_BYTES);
    assert_eq!(cold.target_high_water_bytes, TARGET_ACCOUNTING_BYTES);
    assert_eq!(cold.device_epoch, DeviceEpoch(1));
    assert_eq!(cold.last_recovery_reason, Some(GpuFault::DeviceLost));
    assert_eq!(cold.recovery_attempt, 1);
    assert_eq!(cold.frame_cause, FrameCause::DeviceRehydrate);
}

#[test]
fn recovery_records_reason_duration_epoch_and_roi() {
    let mut gpu = ready();
    let scene = shared_scene();
    let mut clock = EpochClock::new();
    gpu.post(publish(&mut clock, &scene, 1)).unwrap();
    gpu.dequeue_for_submit().unwrap();
    gpu.notify_fault(GpuFault::DeviceLost).unwrap();
    let snap = gpu.telemetry();
    assert_eq!(snap.last_recovery_reason, Some(GpuFault::DeviceLost));
    assert_eq!(snap.device_epoch, DeviceEpoch(1));
    assert_eq!(
        snap.scene_epoch,
        Some(neotavern_neocompositor::SceneEpoch(1))
    );
    assert_eq!(snap.roi.width, 1000);
    assert_eq!(snap.roi.height, 720);
    assert_eq!(snap.gpu_timing, GpuTimingAvailability::Unavailable);
    let _ = snap.last_recovery_duration_us;
}

#[test]
fn surface_rebuild_is_a_frame_cause() {
    let mut gpu = ready();
    gpu.notify_fault(GpuFault::SurfaceLost).unwrap();
    let snap = gpu.telemetry();
    assert_eq!(snap.frame_cause, FrameCause::SurfaceRebuild);
    assert_eq!(snap.last_recovery_reason, Some(GpuFault::SurfaceLost));
    assert_eq!(snap.device_epoch, DeviceEpoch(0));
}

#[test]
fn oom_sets_degraded_and_rollback_reason() {
    let mut gpu = ready();
    gpu.notify_fault(GpuFault::OutOfMemory).unwrap();
    let snap = gpu.telemetry();
    assert_eq!(
        snap.degraded_reason,
        Some(neotavern_neocompositor::DegradedReason::OutOfMemory)
    );
    assert_eq!(
        snap.rollback_reason,
        Some(neotavern_neocompositor::DegradedReason::OutOfMemory)
    );
    assert_eq!(snap.host, PresentationHost::WebViewRollback);
    assert_eq!(snap.recovery_phase, RecoveryPhase::Degraded);
    assert_eq!(snap.recovery_attempt, 0);
}

#[test]
fn retry_cap_sets_rollback_reason() {
    let mut gpu = GpuRecovery::with_attempt_cap(1);
    gpu.initialize().unwrap();
    gpu.notify_fault(GpuFault::DeviceLost).unwrap();
    gpu.notify_fault(GpuFault::DeviceLost).unwrap_err();
    let snap = gpu.telemetry();
    assert_eq!(
        snap.degraded_reason,
        Some(neotavern_neocompositor::DegradedReason::RetryCap)
    );
    assert_eq!(
        snap.rollback_reason,
        Some(neotavern_neocompositor::DegradedReason::RetryCap)
    );
    assert_eq!(snap.host, PresentationHost::WebViewRollback);
}
