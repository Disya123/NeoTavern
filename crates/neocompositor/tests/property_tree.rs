use neotavern_neocompositor::{
    hit_test, AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectId, EffectKind,
    EffectNode, EffectNodeId, EffectScopeId, EffectSpec, EpochClock, FrameMailbox,
    FrameTransaction, FrameTransactionParts, GlassBoundary, HitTestItem, Insets, LogicalRect,
    NeoDisplayList, NeoPaintOp, NeoScene, PaintChunk, PaintChunkId, PaintOrderKey, Point,
    PostReject, PropertyEffectKind, PropertySnapshot, PropertyTreeBuilder, Rect, SampleError,
    SampledFrame, SceneEpoch, ScrollId, ScrollRange, Size, SpatialId, SpatialKind, SpatialNode,
    SpatialNodeId, StubPayload, TreeError, TryDequeue, Vec2,
};
use std::sync::Arc;
use std::thread;

fn identity() -> AffineCoeffs {
    AffineCoeffs::IDENTITY
}

fn assert_close(actual: f64, expected: f64, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-9,
        "{what}: {actual} != {expected}"
    );
}

fn assert_translation(world: AffineCoeffs, x: f64, y: f64) {
    let (tx, ty) = world.translation();
    assert_close(tx, x, "tx");
    assert_close(ty, y, "ty");
}

fn viewport() -> LogicalRect {
    LogicalRect::new(0.0, 0.0, 100.0, 100.0)
}

fn scroll_kind(scroll_id: ScrollId) -> SpatialKind {
    SpatialKind::Scroll {
        scroll_id,
        scrollport: viewport(),
        content_extent: LogicalRect::new(0.0, 0.0, 100.0, 1000.0),
    }
}

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
    NeoDisplayList {
        generation: 1,
        width: 1080,
        height: 2400,
        spatial,
        clips,
        effects,
        ops: Arc::from([
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
            NeoPaintOp::EndEffectScope(EffectScopeId(0)),
        ]),
    }
}

fn publish_tree(clock: &mut EpochClock, properties: PropertySnapshot) -> FrameTransaction {
    let epoch = properties.scene_epoch();
    FrameTransaction::publish(FrameTransactionParts {
        frame_id: clock.next_frame(),
        scene_epoch: epoch,
        device_epoch: clock.device_epoch(),
        scene: NeoScene::from_display_list(two_barrier_scene()),
        damage: Vec::new(),
        leases: Vec::new(),
        properties,
    })
}

struct RootScroll {
    snapshot: PropertySnapshot,
    scroll: ScrollId,
    content: SpatialId,
}

fn root_scroll_tree(epoch: u64) -> RootScroll {
    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let scroll_node = builder.alloc_spatial(Some(root), identity(), scroll_kind(scroll));
    let content = builder.alloc_spatial(
        Some(scroll_node),
        AffineCoeffs::translate(0.0, 40.0),
        SpatialKind::ReferenceFrame,
    );
    RootScroll {
        snapshot: builder.commit(SceneEpoch(epoch)).unwrap(),
        scroll,
        content,
    }
}

#[test]
fn root_and_nested_scroll_compose_producer_and_async_offsets() {
    let RootScroll {
        snapshot,
        scroll,
        content,
    } = root_scroll_tree(1);
    let mut sampled = SampledFrame::bind(&snapshot);
    sampled
        .set_scroll_offset(&snapshot, scroll, Vec2::new(0.0, 10.0))
        .unwrap();
    assert_translation(sampled.world(&snapshot, content).unwrap(), 0.0, 30.0);

    let mut builder = PropertyTreeBuilder::new();
    let outer = builder.alloc_scroll();
    let inner = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let outer_node = builder.alloc_spatial(Some(root), identity(), scroll_kind(outer));
    let inner_node = builder.alloc_spatial(Some(outer_node), identity(), scroll_kind(inner));
    let nested = builder.alloc_spatial(Some(inner_node), identity(), SpatialKind::ReferenceFrame);
    let snapshot = builder.commit(SceneEpoch(2)).unwrap();
    let mut sampled = SampledFrame::bind(&snapshot);
    sampled
        .set_scroll_offset(&snapshot, outer, Vec2::new(0.0, 10.0))
        .unwrap();
    sampled
        .set_scroll_offset(&snapshot, inner, Vec2::new(0.0, 5.0))
        .unwrap();
    assert_translation(sampled.world(&snapshot, nested).unwrap(), 0.0, -15.0);
}

#[test]
fn sticky_clamps_inside_range_and_uses_last_known_valid_outside() {
    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let scroll_node = builder.alloc_spatial(Some(root), identity(), scroll_kind(scroll));
    let sticky = builder.alloc_spatial(
        Some(scroll_node),
        identity(),
        SpatialKind::Sticky {
            scroll_id: scroll,
            normal_origin: Point::new(0.0, 0.0),
            constraint_rect: viewport(),
            insets: Insets::default(),
            valid_scroll_range: ScrollRange {
                min: Vec2::new(0.0, 0.0),
                max: Vec2::new(0.0, 80.0),
            },
            size: Size::new(100.0, 20.0),
        },
    );
    let snapshot = builder.commit(SceneEpoch(1)).unwrap();
    let mut sampled = SampledFrame::bind(&snapshot);

    sampled
        .set_scroll_offset(&snapshot, scroll, Vec2::new(0.0, 0.0))
        .unwrap();
    assert_translation(sampled.world(&snapshot, sticky).unwrap(), 0.0, 0.0);
    assert!(!sampled.constraint_stale(&snapshot, sticky));

    sampled
        .set_scroll_offset(&snapshot, scroll, Vec2::new(0.0, 40.0))
        .unwrap();
    assert_translation(sampled.world(&snapshot, sticky).unwrap(), 0.0, 0.0);
    assert!(!sampled.constraint_stale(&snapshot, sticky));

    sampled
        .set_scroll_offset(&snapshot, scroll, Vec2::new(0.0, 200.0))
        .unwrap();
    assert_translation(sampled.world(&snapshot, sticky).unwrap(), 0.0, 0.0);
    assert!(sampled.constraint_stale(&snapshot, sticky));
}

#[test]
fn viewport_fixed_ignores_root_scroll_fixed_in_transform_follows_ancestor() {
    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let scroll_node = builder.alloc_spatial(Some(root), identity(), scroll_kind(scroll));
    let transformed = builder.alloc_spatial(
        Some(scroll_node),
        AffineCoeffs::scale(2.0, 2.0),
        SpatialKind::ReferenceFrame,
    );
    let fixed_in_transform = builder.alloc_spatial(
        Some(transformed),
        AffineCoeffs::translate(1.0, 1.0),
        SpatialKind::Fixed {
            containing_block: transformed,
        },
    );
    let viewport_fixed = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::translate(10.0, 10.0),
        SpatialKind::Fixed {
            containing_block: root,
        },
    );
    let snapshot = builder.commit(SceneEpoch(1)).unwrap();
    let mut sampled = SampledFrame::bind(&snapshot);
    sampled
        .set_scroll_offset(&snapshot, scroll, Vec2::new(0.0, 10.0))
        .unwrap();

    assert_translation(
        sampled.world(&snapshot, viewport_fixed).unwrap(),
        10.0,
        10.0,
    );
    let (x, y) = sampled
        .world(&snapshot, fixed_in_transform)
        .unwrap()
        .transform_point(0.0, 0.0);
    assert_close(x, 2.0, "fixed-in-transform x");
    assert_close(y, -8.0, "fixed-in-transform y");
}

#[test]
fn nested_clip_chain_is_intersection() {
    let mut builder = PropertyTreeBuilder::new();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let outer = builder.alloc_clip(None, root, LogicalRect::new(0.0, 0.0, 100.0, 100.0));
    let inner = builder.alloc_clip(Some(outer), root, LogicalRect::new(10.0, 10.0, 20.0, 20.0));
    let snapshot = builder.commit(SceneEpoch(1)).unwrap();
    let sampled = SampledFrame::bind(&snapshot);
    let item = HitTestItem {
        local_bounds: LogicalRect::new(0.0, 0.0, 100.0, 100.0),
        spatial: root,
        clip: inner,
        paint_order: 1,
    };
    assert!(hit_test(&snapshot, &sampled, &[item], 15.0, 15.0)
        .unwrap()
        .is_some());
    assert!(hit_test(&snapshot, &sampled, &[item], 5.0, 5.0)
        .unwrap()
        .is_none());
    assert!(hit_test(&snapshot, &sampled, &[item], 200.0, 200.0)
        .unwrap()
        .is_none());
}

#[test]
fn glass_inside_opacity_keeps_explicit_backdrop_root_and_balanced_groups() {
    let mut builder = PropertyTreeBuilder::new();
    let isolation_root = builder.declare_backdrop_root();
    let glass_root = builder.declare_backdrop_root();
    let spatial = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let clip = builder.alloc_clip(None, spatial, viewport());
    let opacity = builder.alloc_effect(EffectSpec {
        parent: None,
        spatial,
        clip,
        kind: PropertyEffectKind::Opacity(0.5),
        backdrop_root: isolation_root,
        bounds: viewport(),
    });
    let filter = builder.alloc_effect(EffectSpec {
        parent: Some(opacity),
        spatial,
        clip,
        kind: PropertyEffectKind::Filter,
        backdrop_root: isolation_root,
        bounds: viewport(),
    });
    let mask = builder.alloc_effect(EffectSpec {
        parent: Some(filter),
        spatial,
        clip,
        kind: PropertyEffectKind::Mask,
        backdrop_root: isolation_root,
        bounds: viewport(),
    });
    let glass = builder.alloc_effect(EffectSpec {
        parent: Some(mask),
        spatial,
        clip,
        kind: PropertyEffectKind::Glass,
        backdrop_root: glass_root,
        bounds: LogicalRect::new(8.0, 8.0, 40.0, 40.0),
    });
    let snapshot = builder.commit(SceneEpoch(1)).unwrap();

    let mut effects = [EffectId::unbound(0); 4];
    let n = snapshot.copy_effect_chain(glass, &mut effects).unwrap();
    assert_eq!(n, 4);
    assert_eq!(effects[0], glass);
    assert_eq!(effects[1], mask);
    assert_eq!(effects[2], filter);
    assert_eq!(effects[3], opacity);
    assert_eq!(snapshot.group_scope_depth(glass).unwrap(), 3);
    assert_eq!(snapshot.effect(glass).unwrap().backdrop_root, glass_root);
    assert_ne!(
        snapshot.effect(glass).unwrap().backdrop_root,
        snapshot.effect(opacity).unwrap().backdrop_root
    );
}

#[test]
fn cyclic_stale_and_missing_parents_are_rejected_before_commit() {
    let mut cycle = PropertyTreeBuilder::new();
    let a = cycle.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let b = cycle.alloc_spatial(Some(a), identity(), SpatialKind::ReferenceFrame);
    cycle.reparent_spatial(a, Some(b)).unwrap();
    assert_eq!(cycle.commit(SceneEpoch(1)), Err(TreeError::Cycle));

    let mut missing = PropertyTreeBuilder::new();
    missing.alloc_spatial(
        Some(SpatialId::unbound(99)),
        identity(),
        SpatialKind::ReferenceFrame,
    );
    assert_eq!(missing.commit(SceneEpoch(1)), Err(TreeError::MissingParent));

    let mut stale = PropertyTreeBuilder::new();
    let parent = stale.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    stale.recycle_spatial(parent).unwrap();
    stale.alloc_spatial(Some(parent), identity(), SpatialKind::ReferenceFrame);
    assert_eq!(stale.commit(SceneEpoch(1)), Err(TreeError::StaleParent));

    let mut stale_scroll = PropertyTreeBuilder::new();
    let scroll = stale_scroll.alloc_scroll();
    let root = stale_scroll.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    stale_scroll.alloc_spatial(Some(root), identity(), scroll_kind(scroll));
    stale_scroll.recycle_scroll(scroll).unwrap();
    assert_eq!(
        stale_scroll.commit(SceneEpoch(1)),
        Err(TreeError::StaleScroll)
    );

    let mut clip_cycle = PropertyTreeBuilder::new();
    let spatial = clip_cycle.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let c0 = clip_cycle.alloc_clip(None, spatial, viewport());
    let c1 = clip_cycle.alloc_clip(Some(c0), spatial, viewport());
    clip_cycle.reparent_clip(c0, Some(c1)).unwrap();
    assert_eq!(clip_cycle.commit(SceneEpoch(1)), Err(TreeError::ClipCycle));
}

#[test]
fn recycled_spatial_index_does_not_revive_stale_handle() {
    let mut builder = PropertyTreeBuilder::new();
    let first = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    builder.recycle_spatial(first).unwrap();
    let second = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    assert_eq!(first.index(), second.index());
    assert_ne!(first.generation(), second.generation());
    let snapshot = builder.commit(SceneEpoch(1)).unwrap();
    assert!(snapshot.spatial(first).is_none());
    assert!(snapshot.spatial(second).is_some());
}

#[test]
fn singular_inverse_is_non_hittable_and_does_not_panic() {
    assert!(AffineCoeffs::scale(0.0, 1.0).inverse().is_none());
    let mut builder = PropertyTreeBuilder::new();
    let node = builder.alloc_spatial(
        None,
        AffineCoeffs::scale(0.0, 1.0),
        SpatialKind::ReferenceFrame,
    );
    let clip = builder.alloc_clip(None, node, viewport());
    let snapshot = builder.commit(SceneEpoch(1)).unwrap();
    let sampled = SampledFrame::bind(&snapshot);
    assert!(sampled.world(&snapshot, node).is_some());
    assert!(!sampled.hittable(&snapshot, node));
    assert!(sampled.inverse(&snapshot, node).is_none());
    let item = HitTestItem {
        local_bounds: viewport(),
        spatial: node,
        clip,
        paint_order: 1,
    };
    assert_eq!(hit_test(&snapshot, &sampled, &[item], 0.0, 0.0), Ok(None));
}

#[test]
fn mailbox_replaces_property_snapshots_atomically() {
    let mailbox = FrameMailbox::with_defaults();
    let mut clock = EpochClock::new();
    let first = root_scroll_tree(clock.next_scene().0);
    let first_snapshot = first.snapshot.clone();
    mailbox
        .post(publish_tree(&mut clock, first.snapshot))
        .unwrap();

    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    builder.alloc_spatial(Some(root), identity(), scroll_kind(scroll));
    let second = builder.commit(clock.next_scene()).unwrap();
    let second_epoch = second.scene_epoch();
    mailbox.post(publish_tree(&mut clock, second)).unwrap();

    let ready = match mailbox.try_dequeue() {
        TryDequeue::Ready(tx) => tx,
        other => panic!("expected Ready, got {other:?}"),
    };
    assert_eq!(ready.properties().scene_epoch(), second_epoch);
    assert_ne!(
        ready.properties().scene_epoch(),
        first_snapshot.scene_epoch()
    );
    let sampled = SampledFrame::bind(ready.properties());
    assert_eq!(sampled.scene_epoch(), second_epoch);
    assert_eq!(
        hit_test(&first_snapshot, &sampled, &[], 0.0, 0.0),
        Err(SampleError::EpochMismatch)
    );
}

#[test]
fn mailbox_rejects_property_epoch_mismatch() {
    let mailbox = FrameMailbox::with_defaults();
    let mut clock = EpochClock::new();
    let tree = root_scroll_tree(1);
    let tx = FrameTransaction::publish(FrameTransactionParts {
        frame_id: clock.next_frame(),
        scene_epoch: SceneEpoch(99),
        device_epoch: clock.device_epoch(),
        scene: NeoScene::from_display_list(two_barrier_scene()),
        damage: Vec::new(),
        leases: Vec::new(),
        properties: tree.snapshot,
    });
    assert_eq!(mailbox.post(tx), Err(PostReject::InvalidGraph));
    assert_eq!(mailbox.stats().rejected_invalid, 1);
}

#[test]
fn changing_one_scroll_id_does_not_resample_the_whole_tree() {
    let mut builder = PropertyTreeBuilder::new();
    let outer = builder.alloc_scroll();
    let inner = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let outer_node = builder.alloc_spatial(Some(root), identity(), scroll_kind(outer));
    let sibling = builder.alloc_spatial(Some(outer_node), identity(), SpatialKind::ReferenceFrame);
    let inner_node = builder.alloc_spatial(Some(outer_node), identity(), scroll_kind(inner));
    let inner_content =
        builder.alloc_spatial(Some(inner_node), identity(), SpatialKind::ReferenceFrame);
    let viewport_fixed = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::translate(4.0, 4.0),
        SpatialKind::Fixed {
            containing_block: root,
        },
    );
    let snapshot = builder.commit(SceneEpoch(1)).unwrap();
    let mut sampled = SampledFrame::bind(&snapshot);
    let live = snapshot.spatial_topo().len() as u32;
    assert_eq!(live, 6);
    assert_eq!(sampled.nodes_recomputed(), live);

    sampled
        .set_scroll_offset(&snapshot, inner, Vec2::new(0.0, 6.0))
        .unwrap();
    assert_eq!(sampled.nodes_recomputed(), 2);
    assert_translation(sampled.world(&snapshot, inner_content).unwrap(), 0.0, -6.0);
    assert_translation(sampled.world(&snapshot, sibling).unwrap(), 0.0, 0.0);
    assert_translation(sampled.world(&snapshot, viewport_fixed).unwrap(), 4.0, 4.0);

    sampled
        .set_scroll_offset(&snapshot, outer, Vec2::new(0.0, 9.0))
        .unwrap();
    assert_eq!(sampled.nodes_recomputed(), 4);
    assert_translation(sampled.world(&snapshot, viewport_fixed).unwrap(), 4.0, 4.0);
}

#[test]
fn sampling_path_does_not_allocate_or_block() {
    let RootScroll {
        snapshot,
        scroll,
        content,
    } = root_scroll_tree(1);
    let snapshot = Arc::new(snapshot);
    let mut sampled = SampledFrame::bind(&snapshot);
    let ptr = sampled.worlds_ptr();
    let cap = sampled.worlds_capacity();
    sampled
        .set_scroll_offset(&snapshot, scroll, Vec2::new(0.0, 12.0))
        .unwrap();
    sampled
        .set_scroll_offset(&snapshot, scroll, Vec2::new(0.0, 24.0))
        .unwrap();
    assert_eq!(sampled.worlds_ptr(), ptr);
    assert_eq!(sampled.worlds_capacity(), cap);
    assert_translation(sampled.world(&snapshot, content).unwrap(), 0.0, 16.0);

    let worker_snapshot = Arc::clone(&snapshot);
    let worker = thread::spawn(move || {
        let mut sampled = SampledFrame::bind(&worker_snapshot);
        sampled.set_scroll_offset(&worker_snapshot, scroll, Vec2::new(0.0, 3.0))
    });
    worker.join().expect("sampler thread").unwrap();
}

#[test]
fn hit_test_and_render_share_one_snapshot_epoch() {
    let a = root_scroll_tree(1);
    let b = root_scroll_tree(2);
    let sampled_a = SampledFrame::bind(&a.snapshot);
    assert_eq!(
        hit_test(&b.snapshot, &sampled_a, &[], 0.0, 0.0),
        Err(SampleError::EpochMismatch)
    );
    assert_eq!(
        SampledFrame::bind(&a.snapshot).set_scroll_offset(&b.snapshot, b.scroll, Vec2::default()),
        Err(SampleError::EpochMismatch)
    );
}
