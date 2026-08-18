use neotavern_neocompositor::{
    AffineCoeffs, BackdropRootId, BarrierId, CallbackReject, ClipChainId, ClipNode,
    ClusterBoundary, DegradedReason, DeviceEpoch, EffectKind, EffectNode, EffectNodeId,
    EffectScopeId, EpochClock, FrameTransaction, GestureId, GlassBoundary, GpuCallback, GpuFault,
    GpuHandleKind, GpuRecovery, LayerKey, LineMetric, LogicalRect, NeoDisplayList, NeoPaintOp,
    NeoScene, PaintChunk, PaintChunkId, PaintOrderKey, PostReject, PresentationHost,
    PresentationTime, ProducerGlyph, PropertyTreeBuilder, RecoveryError, RecoveryOutcome,
    RecoveryPhase, Rect, ResourceLease, ResourceLeaseId, SceneEpoch, ScrollSequence,
    SelectionSession, ShapedRunRef, SpatialKind, SpatialNode, SpatialNodeId, StableSemanticId,
    StubPayload, SubmitReject, TextFragmentId, TextInteractionSnapshot, TextOffset, TextRange,
    TextSnapshotSet, TileCoverage, TileId, Vec2, DEFAULT_RECOVERY_ATTEMPT_CAP,
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

fn publish(
    clock: &mut EpochClock,
    scene: &Arc<NeoScene>,
    lease: u64,
    text: TextSnapshotSet,
) -> FrameTransaction {
    let device = clock.device_epoch();
    FrameTransaction::publish(neotavern_neocompositor::FrameTransactionParts {
        frame_id: clock.next_frame(),
        scene_epoch: clock.next_scene(),
        device_epoch: device,
        scene: NeoScene::clone(scene),
        damage: Vec::new(),
        leases: vec![ResourceLease {
            id: ResourceLeaseId(lease),
            device_epoch: device,
        }],
        properties: neotavern_neocompositor::PropertySnapshot::empty(),
        geometry: neotavern_neocompositor::GeometryTileSnapshot::empty(SceneEpoch(1)),
        text,
    })
}

fn tiny_fragment(epoch: SceneEpoch) -> TextInteractionSnapshot {
    TextInteractionSnapshot {
        scene_epoch: epoch,
        generation: 1,
        fragment_id: TextFragmentId::new(0, 1),
        semantic: StableSemanticId(1),
        logical_range: TextRange::new(0, 1),
        shaped_runs: Arc::from([ShapedRunRef {
            run_id: 1,
            logical: TextRange::new(0, 1),
            visual_order: 0,
            bidi_level: 0,
            rtl: false,
            glyphs: Arc::from([ProducerGlyph {
                glyph_id: 1,
                cluster: TextOffset(0),
                x: 0.0,
                y: 0.0,
                advance: 10.0,
                font_key: 1,
                color_emoji: false,
            }]),
        }]),
        cluster_map: Arc::from([ClusterBoundary {
            logical: TextRange::new(0, 1),
            caret_stop: true,
            ligature: false,
            combining: false,
        }]),
        line_metrics: Arc::from([LineMetric {
            logical: TextRange::new(0, 1),
            origin_x: 0.0,
            origin_y: 10.0,
            width: 10.0,
            ascent: 10.0,
            descent: 2.0,
            baseline: 10.0,
        }]),
        logical_to_visual: Arc::from([0]),
        visual_to_logical: Arc::from([0]),
        tiles: Arc::from([TileCoverage {
            tile: TileId(1),
            clip: Rect::new(0.0, 0.0, 10.0, 12.0),
        }]),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
    }
}

fn ready() -> GpuRecovery {
    let mut gpu = GpuRecovery::new();
    gpu.initialize().expect("init");
    gpu
}

fn seeded(gpu: &mut GpuRecovery, clock: &mut EpochClock, lease: u64) -> SceneEpoch {
    let scene = shared_scene();
    let epoch = SceneEpoch(1);
    let text = TextSnapshotSet::commit(epoch, vec![tiny_fragment(epoch)]).expect("text");
    let tx = publish(clock, &scene, lease, text);
    let scene_epoch = tx.scene_epoch();
    gpu.post(tx).expect("post");
    scene_epoch
}

#[test]
fn timeout_skips_frame_without_rebuild() {
    let mut gpu = ready();
    let epoch = gpu.device_epoch();
    gpu.cache_insert(LayerKey {
        chunk: PaintChunkId(1),
        generation: 1,
    });
    let surface = gpu.surface_generation();
    let outcome = gpu.notify_fault(GpuFault::Timeout).expect("timeout");
    assert_eq!(outcome, RecoveryOutcome::SkippedTimeout);
    assert_eq!(gpu.phase(), RecoveryPhase::Ready);
    assert_eq!(gpu.device_epoch(), epoch);
    assert_eq!(gpu.surface_generation(), surface);
    assert_eq!(gpu.cache_len(), 1);
    assert_eq!(gpu.skipped_timeouts(), 1);
    assert_eq!(gpu.attempt(), 0);
}

#[test]
fn surface_lost_and_outdated_recreate_config_not_device() {
    let mut gpu = ready();
    let epoch = gpu.device_epoch();
    gpu.cache_insert(LayerKey {
        chunk: PaintChunkId(3),
        generation: 1,
    });
    let first = gpu.surface_generation();
    assert_eq!(
        gpu.notify_fault(GpuFault::SurfaceOutdated).unwrap(),
        RecoveryOutcome::SurfaceRebuilt {
            device_epoch: epoch
        }
    );
    assert_eq!(gpu.device_epoch(), epoch);
    assert!(gpu.surface_generation() > first);
    assert_eq!(gpu.cache_len(), 1);
    assert_eq!(
        gpu.notify_fault(GpuFault::SurfaceLost).unwrap(),
        RecoveryOutcome::SurfaceRebuilt {
            device_epoch: epoch
        }
    );
    assert_eq!(gpu.device_epoch(), epoch);
    assert_eq!(gpu.devices(), 1);
    assert_eq!(gpu.attempt(), 0);
}

#[test]
fn device_loss_between_dequeue_and_submit_rejects_old_epoch() {
    let mut gpu = ready();
    let mut clock = EpochClock::new();
    seeded(&mut gpu, &mut clock, 11);
    let dequeued = gpu.dequeue_for_submit().expect("dequeued");
    let old = dequeued.device_epoch();
    assert_eq!(old, DeviceEpoch(0));
    gpu.notify_fault(GpuFault::DeviceLost).expect("recover");
    assert_eq!(gpu.submit(), Err(SubmitReject::StaleEpoch));
    assert_eq!(gpu.device_epoch(), DeviceEpoch(1));
    assert_ne!(gpu.mailbox_device_epoch(), old);
    assert!(gpu
        .live_handles()
        .iter()
        .all(|handle| handle.device_epoch == DeviceEpoch(1)));
    assert_eq!(gpu.devices(), 1);
}

#[test]
fn device_loss_during_open_selection_keeps_logical_range() {
    let mut gpu = ready();
    let mut clock = EpochClock::new();
    let scene_epoch = seeded(&mut gpu, &mut clock, 4);
    let fragment = tiny_fragment(scene_epoch);
    let session = SelectionSession::begin(&fragment, 2.0, 8.0).expect("begin");
    let fragment_id = session.fragment_id();
    gpu.set_selection(session);
    gpu.notify_fault(GpuFault::DeviceLost).expect("recover");
    let kept = gpu.selection().expect("selection survived");
    assert_eq!(kept.fragment_id(), fragment_id);
    let restored = gpu.logical_snapshot().expect("logical");
    assert_eq!(restored.scene_epoch(), scene_epoch);
    assert_eq!(restored.text().scene_epoch(), scene_epoch);
    assert_eq!(restored.device_epoch(), gpu.device_epoch());
}

#[test]
fn stale_transaction_after_rebuild_is_rejected() {
    let mut gpu = ready();
    let mut clock = EpochClock::new();
    seeded(&mut gpu, &mut clock, 1);
    gpu.notify_fault(GpuFault::DeviceLost).expect("recover");
    let scene = shared_scene();
    let stale = FrameTransaction::publish_shared(
        clock.next_frame(),
        clock.next_scene(),
        DeviceEpoch(0),
        Arc::clone(&scene),
        Vec::new(),
        vec![ResourceLease {
            id: ResourceLeaseId(99),
            device_epoch: DeviceEpoch(0),
        }],
    );
    assert_eq!(gpu.post(stale), Err(PostReject::DeviceEpoch));
    assert_eq!(
        gpu.complete_callback(GpuCallback {
            id: 1,
            device_epoch: DeviceEpoch(0),
        }),
        Err(CallbackReject::StaleEpoch)
    );
}

#[test]
fn device_loss_during_fling_keeps_unacked_scroll() {
    let mut gpu = ready();
    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let _node = builder.alloc_spatial(
        Some(root),
        identity(),
        SpatialKind::Scroll {
            scroll_id: scroll,
            scrollport: LogicalRect::new(0.0, 0.0, 100.0, 100.0),
            content_extent: LogicalRect::new(0.0, 0.0, 100.0, 4000.0),
        },
    );
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    gpu.fast_path_mut().bind_snapshot(snapshot);
    gpu.fast_path_mut()
        .begin_gesture(GestureId(1), &[scroll])
        .unwrap();
    gpu.fast_path_mut()
        .gesture_delta(
            GestureId(1),
            Vec2::new(0.0, 80.0),
            ScrollSequence(1),
            PresentationTime::from_millis(16),
        )
        .unwrap();
    let before = *gpu.fast_path().scroll_state(scroll).expect("scroll");
    assert!(before.unacked_delta.y.abs() > 0.0);
    gpu.notify_fault(GpuFault::DeviceLost).expect("recover");
    let after = *gpu
        .fast_path()
        .scroll_state(scroll)
        .expect("still scrolling");
    assert_eq!(after.epoch, before.epoch);
    assert_eq!(after.unacked_delta, before.unacked_delta);
    assert_eq!(after.screen_velocity, before.screen_velocity);
    assert_eq!(after.applied_input_seq, before.applied_input_seq);
}

#[test]
fn cache_and_target_leases_are_released_once() {
    let mut gpu = ready();
    let mut clock = EpochClock::new();
    seeded(&mut gpu, &mut clock, 21);
    gpu.cache_insert(LayerKey {
        chunk: PaintChunkId(8),
        generation: 1,
    });
    let _ = gpu.acquire_target().expect("target");
    assert_eq!(gpu.cache_len(), 1);
    assert_eq!(gpu.targets_in_use(), 1);
    gpu.dequeue_for_submit();
    gpu.notify_fault(GpuFault::DeviceLost).expect("recover");
    assert_eq!(gpu.cache_len(), 0);
    assert_eq!(gpu.targets_in_use(), 0);
    assert_eq!(gpu.retired_lease_count(), 1);
    gpu.absorb_mailbox_retired().expect("no double retire");
    assert_eq!(gpu.retired_lease_count(), 1);
    assert!(gpu.reject_stale_retirement(ResourceLease {
        id: ResourceLeaseId(21),
        device_epoch: DeviceEpoch(0),
    }));
}

#[test]
fn last_known_good_logical_scene_is_restored() {
    let mut gpu = ready();
    let mut clock = EpochClock::new();
    let scene_epoch = seeded(&mut gpu, &mut clock, 3);
    gpu.dequeue_for_submit().unwrap();
    gpu.notify_fault(GpuFault::DeviceLost).expect("recover");
    let restored = gpu
        .mailbox()
        .last_known_good()
        .expect("lkg after rehydrate");
    assert_eq!(restored.scene_epoch(), scene_epoch);
    assert_eq!(restored.device_epoch(), DeviceEpoch(1));
    assert!(restored.leases().is_empty());
    assert_eq!(restored.generation(), 1);
}

#[test]
fn repeated_loss_is_capped_then_degrades_to_webview() {
    let mut gpu = GpuRecovery::with_attempt_cap(2);
    gpu.initialize().unwrap();
    gpu.notify_fault(GpuFault::DeviceLost).unwrap();
    gpu.notify_fault(GpuFault::DeviceLost).unwrap();
    let err = gpu.notify_fault(GpuFault::DeviceLost).unwrap_err();
    assert_eq!(err, RecoveryError::RetryCap);
    assert_eq!(gpu.phase(), RecoveryPhase::Degraded);
    assert_eq!(gpu.host(), PresentationHost::WebViewRollback);
    assert_eq!(gpu.devices(), 0);
    assert_eq!(DEFAULT_RECOVERY_ATTEMPT_CAP, 3);
}

#[test]
fn oom_does_not_start_a_recreate_loop() {
    let mut gpu = ready();
    let outcome = gpu.notify_fault(GpuFault::OutOfMemory).unwrap();
    assert_eq!(
        outcome,
        RecoveryOutcome::Degraded {
            reason: DegradedReason::OutOfMemory
        }
    );
    assert_eq!(gpu.attempt(), 0);
    assert_eq!(gpu.phase(), RecoveryPhase::Degraded);
    assert_eq!(gpu.host(), PresentationHost::WebViewRollback);
    let again = gpu.notify_fault(GpuFault::DeviceLost).unwrap();
    assert!(matches!(again, RecoveryOutcome::Degraded { .. }));
    assert_eq!(gpu.attempt(), 0);
}

#[test]
fn product_state_survives_and_old_epoch_is_gone() {
    let mut gpu = ready();
    let mut clock = EpochClock::new();
    let scene_epoch = seeded(&mut gpu, &mut clock, 5);
    let old = gpu.device_epoch();
    let old_tex = gpu.alloc_handle(GpuHandleKind::Texture);
    gpu.notify_fault(GpuFault::DeviceLost).expect("recover");
    let snap = gpu.logical_snapshot().expect("logical");
    assert_eq!(snap.scene_epoch(), scene_epoch);
    assert!(!snap.text().is_empty());
    assert_eq!(gpu.devices(), 1);
    assert_ne!(gpu.device_epoch(), old);
    assert!(!gpu.has_device_epoch(old));
    assert!(gpu
        .live_handles()
        .iter()
        .all(|handle| handle.device_epoch != old && handle.device_epoch != old_tex.device_epoch));
    assert_ne!(gpu.mailbox_device_epoch(), old);
    assert_eq!(snap.device_epoch(), gpu.device_epoch());
}

#[test]
fn mailbox_stays_latest_wins_during_rebuild() {
    let mut gpu = ready();
    let mut clock = EpochClock::new();
    seeded(&mut gpu, &mut clock, 1);
    let new_epoch = gpu.begin_device_recovery().expect("begin");
    assert_eq!(gpu.phase(), RecoveryPhase::Recreating);
    let scene = shared_scene();
    clock.bump_device();
    for i in 0..64u64 {
        gpu.post(publish(
            &mut clock,
            &scene,
            100 + i,
            TextSnapshotSet::empty(SceneEpoch(1)),
        ))
        .expect("bounded post");
    }
    assert_eq!(gpu.mailbox().pending_count(), 1);
    assert_eq!(gpu.mailbox().stats().high_water_items, 1);
    gpu.finish_rehydrate().expect("finish");
    assert_eq!(gpu.phase(), RecoveryPhase::Ready);
    assert_eq!(gpu.device_epoch(), new_epoch);
    assert_eq!(gpu.mailbox().pending_count(), 0);
    let restored = gpu.mailbox().last_known_good().expect("latest wins");
    assert_eq!(restored.device_epoch(), new_epoch);
    assert!(restored
        .leases()
        .iter()
        .all(|lease| lease.device_epoch == new_epoch));
}
