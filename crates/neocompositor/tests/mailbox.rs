use neotavern_neocompositor::{
    compile_passes, AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, DeviceEpoch,
    EffectKind, EffectNode, EffectNodeId, EffectScopeId, EpochClock, FrameMailbox,
    FrameTransaction, GlassBoundary, NeoDisplayList, NeoPaintOp, NeoScene, PaintChunk,
    PaintChunkId, PaintOrderKey, PostAccept, PostReject, Rect, ResourceLease, ResourceLeaseId,
    SpatialNode, SpatialNodeId, StubPayload, TryDequeue,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

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

fn dequeue_ready(mailbox: &FrameMailbox) -> Arc<FrameTransaction> {
    match mailbox.try_dequeue() {
        TryDequeue::Ready(tx) => tx,
        other => panic!("expected Ready, got {other:?}"),
    }
}

#[test]
fn burst_of_10k_transactions_does_not_grow_the_queue() {
    let mailbox = FrameMailbox::with_defaults();
    let scene = shared_scene();
    let mut clock = EpochClock::new();
    for i in 0..10_000u64 {
        mailbox
            .post(publish(&mut clock, &scene, i))
            .expect("burst post");
    }
    assert_eq!(mailbox.pending_count(), 1);
    let stats = mailbox.stats();
    assert_eq!(stats.posted, 10_000);
    assert_eq!(stats.accepted, 10_000);
    assert_eq!(stats.coalesced, 9_999);
    assert_eq!(stats.high_water_items, 1);
    assert!(stats.high_water_bytes > 0);
    assert!(stats.high_water_bytes <= stats.current_bytes || stats.current_items == 1);
    let retired = mailbox.drain_retired();
    assert_eq!(retired.len(), 9_999);
    assert_eq!(mailbox.pending_count(), 1);
}

#[test]
fn out_of_order_and_stale_transactions_are_rejected() {
    let mailbox = FrameMailbox::with_defaults();
    let scene = shared_scene();
    let mut clock = EpochClock::new();
    let first = publish(&mut clock, &scene, 1);
    let newer = publish(&mut clock, &scene, 2);
    mailbox.post(newer).expect("newer");
    assert_eq!(mailbox.post(first), Err(PostReject::Stale));
    assert_eq!(mailbox.stats().rejected_stale, 1);
    assert_eq!(mailbox.pending_count(), 1);
}

#[test]
fn device_epoch_bump_invalidates_old_handles() {
    let mailbox = FrameMailbox::with_defaults();
    let scene = shared_scene();
    let mut clock = EpochClock::new();
    mailbox
        .post(publish(&mut clock, &scene, 1))
        .expect("epoch 0");
    let old_epoch = mailbox.device_epoch();
    assert_eq!(old_epoch, DeviceEpoch(0));
    let bumped = mailbox.bump_device_epoch();
    assert_eq!(bumped, DeviceEpoch(1));
    assert_eq!(mailbox.pending_count(), 0);
    assert!(mailbox.last_known_good().is_none());
    let retired = mailbox.drain_retired();
    assert_eq!(retired.len(), 1);
    assert_eq!(retired[0].device_epoch, DeviceEpoch(0));

    clock.bump_device();
    let stale_device = FrameTransaction::publish_shared(
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
    assert_eq!(mailbox.post(stale_device), Err(PostReject::DeviceEpoch));
    mailbox
        .post(publish(&mut clock, &scene, 2))
        .expect("epoch 1");
    assert_eq!(mailbox.pending_count(), 1);
}

#[test]
fn drop_and_coalesce_do_not_leak_leases() {
    let mailbox = FrameMailbox::with_defaults();
    let scene = shared_scene();
    let mut clock = EpochClock::new();
    mailbox.post(publish(&mut clock, &scene, 1)).unwrap();
    mailbox.post(publish(&mut clock, &scene, 2)).unwrap();
    let retired = mailbox.drain_retired();
    assert_eq!(retired.len(), 1);
    assert_eq!(retired[0].id, ResourceLeaseId(1));
    let presented = dequeue_ready(&mailbox);
    assert_eq!(presented.leases()[0].id, ResourceLeaseId(2));
    mailbox.post(publish(&mut clock, &scene, 3)).unwrap();
    dequeue_ready(&mailbox);
    let retired = mailbox.drain_retired();
    assert!(retired.iter().any(|lease| lease.id == ResourceLeaseId(2)));
    assert_eq!(mailbox.pending_count(), 0);
    assert_eq!(
        mailbox.last_known_good().unwrap().leases()[0].id,
        ResourceLeaseId(3)
    );
}

#[test]
fn invalid_transaction_keeps_last_known_good() {
    let mailbox = FrameMailbox::with_defaults();
    let scene = shared_scene();
    let mut clock = EpochClock::new();
    mailbox.post(publish(&mut clock, &scene, 1)).unwrap();
    let good = dequeue_ready(&mailbox);
    assert_eq!(good.generation(), 1);

    let mut bad_list = two_barrier_scene();
    let mut ops = Vec::from(bad_list.ops.as_ref());
    ops.push(NeoPaintOp::EndEffectScope(EffectScopeId(99)));
    bad_list.ops = ops.into();
    let bad = FrameTransaction::publish_shared(
        clock.next_frame(),
        clock.next_scene(),
        clock.device_epoch(),
        Arc::new(NeoScene::from_display_list(bad_list)),
        Vec::new(),
        vec![ResourceLease {
            id: ResourceLeaseId(7),
            device_epoch: clock.device_epoch(),
        }],
    );
    assert_eq!(mailbox.post(bad), Err(PostReject::InvalidGraph));
    assert_eq!(
        mailbox.last_known_good().unwrap().leases()[0].id,
        ResourceLeaseId(1)
    );
    assert_eq!(mailbox.pending_count(), 0);
    let retired = mailbox.drain_retired();
    assert_eq!(retired[0].id, ResourceLeaseId(7));
}

#[test]
fn render_dequeue_never_blocks() {
    let mailbox = FrameMailbox::with_defaults();
    let start = Instant::now();
    assert_eq!(mailbox.try_dequeue(), TryDequeue::Empty);
    assert!(start.elapsed() < Duration::from_millis(50));

    mailbox.with_lock_held(|| {
        let start = Instant::now();
        assert_eq!(mailbox.try_dequeue(), TryDequeue::Busy);
        assert_eq!(
            mailbox.post(FrameTransaction::full_frame(NeoScene::from_display_list(
                two_barrier_scene()
            ))),
            Err(PostReject::Contended)
        );
        assert!(start.elapsed() < Duration::from_millis(50));
    });
}

#[test]
fn pressure_and_cancellation_are_deterministic() {
    let tight = FrameMailbox::new(1, 16);
    let scene = shared_scene();
    let mut clock = EpochClock::new();
    let oversize = publish(&mut clock, &scene, 1);
    assert!(oversize.byte_size() > 16);
    assert_eq!(tight.post(oversize), Err(PostReject::Oversize));
    assert_eq!(tight.stats().rejected_oversize, 1);
    assert_eq!(tight.pending_count(), 0);

    let mailbox = FrameMailbox::with_defaults();
    mailbox.post(publish(&mut clock, &scene, 2)).unwrap();
    dequeue_ready(&mailbox);
    mailbox.cancel();
    mailbox.cancel();
    assert_eq!(
        mailbox.post(publish(&mut clock, &scene, 3)),
        Err(PostReject::Cancelled)
    );
    assert_eq!(
        mailbox.post(publish(&mut clock, &scene, 4)),
        Err(PostReject::Cancelled)
    );
    assert_eq!(mailbox.stats().cancelled, 2);
    assert_eq!(mailbox.stats().rejected_cancelled, 2);
    assert_eq!(mailbox.pending_count(), 0);
    assert_eq!(
        mailbox.last_known_good().unwrap().leases()[0].id,
        ResourceLeaseId(2)
    );
}

#[test]
fn first_post_is_queued_then_coalesced() {
    let mailbox = FrameMailbox::with_defaults();
    let scene = shared_scene();
    let mut clock = EpochClock::new();
    assert_eq!(
        mailbox.post(publish(&mut clock, &scene, 1)),
        Ok(PostAccept::Queued)
    );
    let first_id = mailbox.try_dequeue();
    assert!(matches!(first_id, TryDequeue::Ready(_)));
    assert_eq!(
        mailbox.post(publish(&mut clock, &scene, 2)),
        Ok(PostAccept::Queued)
    );
    assert!(matches!(
        mailbox.post(publish(&mut clock, &scene, 3)),
        Ok(PostAccept::Coalesced { .. })
    ));
}

#[test]
fn m0_graph_compiler_still_accepts_valid_lists() {
    compile_passes(&two_barrier_scene()).expect("valid M0-shaped list");
}
