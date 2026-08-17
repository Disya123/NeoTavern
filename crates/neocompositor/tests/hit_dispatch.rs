use neotavern_neocompositor::{
    AffineCoeffs, ClipId, CompositorFastPath, DispatchError, HitTestId, HitTestItem,
    HitTestSnapshot, LogicalRect, Point, PointerEvent, PointerFlags, PointerId, PointerKind,
    PresentationTime, PropertySnapshot, PropertyTreeBuilder, SceneEpoch, ScrollId, ScrollSequence,
    SpatialId, SpatialKind, StableSemanticId, Vec2,
};
use std::sync::Arc;
use std::thread;

fn identity() -> AffineCoeffs {
    AffineCoeffs::IDENTITY
}

fn viewport() -> LogicalRect {
    LogicalRect::new(0.0, 0.0, 100.0, 100.0)
}

fn ms(v: u64) -> PresentationTime {
    PresentationTime::from_millis(v)
}

fn ptr() -> PointerId {
    PointerId(1)
}

fn scroll_kind(id: ScrollId, width: f64, height: f64) -> SpatialKind {
    SpatialKind::Scroll {
        scroll_id: id,
        scrollport: viewport(),
        content_extent: LogicalRect::new(0.0, 0.0, width, height),
    }
}

#[allow(clippy::too_many_arguments)]
fn item(
    id: u32,
    target: u64,
    generation: u64,
    bounds: LogicalRect,
    spatial: SpatialId,
    clip: ClipId,
    paint_order: u32,
    scroll: Option<ScrollId>,
    participates: bool,
) -> HitTestItem {
    HitTestItem {
        id: HitTestId(id),
        target: StableSemanticId(target),
        generation,
        local_bounds: bounds,
        spatial,
        clip,
        paint_order,
        scroll_target: scroll,
        pointer_flags: if participates {
            PointerFlags::PARTICIPATES
        } else {
            PointerFlags::NONE
        },
    }
}

fn bind_interaction(
    snapshot: Arc<PropertySnapshot>,
    items: Vec<HitTestItem>,
) -> CompositorFastPath {
    let epoch = snapshot.scene_epoch();
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(Arc::clone(&snapshot));
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(epoch, items)))
        .unwrap();
    path.present(ms(0));
    path
}

struct ChatScene {
    snapshot: Arc<PropertySnapshot>,
    root_scroll: ScrollId,
    message: SpatialId,
    sticky: SpatialId,
    fixed: SpatialId,
    clip: ClipId,
}

fn chat_scene() -> ChatScene {
    let mut builder = PropertyTreeBuilder::new();
    let root_scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let scroll_node = builder.alloc_spatial(
        Some(root),
        identity(),
        scroll_kind(root_scroll, 100.0, 2000.0),
    );
    let message = builder.alloc_spatial(
        Some(scroll_node),
        AffineCoeffs::translate(0.0, 600.0),
        SpatialKind::ReferenceFrame,
    );
    let sticky = builder.alloc_spatial(
        Some(scroll_node),
        identity(),
        SpatialKind::Sticky {
            scroll_id: root_scroll,
            normal_origin: Point::new(0.0, 0.0),
            constraint_rect: viewport(),
            insets: neotavern_neocompositor::Insets::default(),
            valid_scroll_range: neotavern_neocompositor::ScrollRange {
                min: Vec2::new(0.0, 0.0),
                max: Vec2::new(0.0, 1500.0),
            },
            size: neotavern_neocompositor::Size::new(100.0, 20.0),
        },
    );
    let fixed = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::translate(10.0, 10.0),
        SpatialKind::Fixed {
            containing_block: root,
        },
    );
    let clip = builder.alloc_clip(None, root, LogicalRect::new(0.0, 0.0, 100.0, 2000.0));
    ChatScene {
        snapshot: Arc::new(builder.commit(SceneEpoch(1)).unwrap()),
        root_scroll,
        message,
        sticky,
        fixed,
        clip,
    }
}

fn chat_items(scene: &ChatScene) -> Vec<HitTestItem> {
    vec![
        item(
            1,
            10,
            1,
            LogicalRect::new(0.0, 0.0, 100.0, 80.0),
            scene.message,
            scene.clip,
            1,
            Some(scene.root_scroll),
            true,
        ),
        item(
            2,
            20,
            1,
            LogicalRect::new(0.0, 0.0, 100.0, 20.0),
            scene.sticky,
            scene.clip,
            10,
            Some(scene.root_scroll),
            true,
        ),
        item(
            3,
            30,
            1,
            LogicalRect::new(0.0, 0.0, 40.0, 40.0),
            scene.fixed,
            scene.clip,
            20,
            None,
            true,
        ),
    ]
}

#[test]
fn unacked_root_scroll_uses_per_node_inverse() {
    let scene = chat_scene();
    let mut path = bind_interaction(Arc::clone(&scene.snapshot), chat_items(&scene));
    path.nudge(
        scene.root_scroll,
        Vec2::new(0.0, 500.0),
        ScrollSequence(1),
        ms(16),
    )
    .unwrap();
    path.present(ms(16));
    let event = path
        .pointer_down(ptr(), Point::new(50.0, 140.0), ms(16))
        .unwrap();
    assert_eq!(event.target, Some(StableSemanticId(10)));
    assert_eq!(event.kind, PointerKind::Down);
    assert_eq!(event.scene_epoch, SceneEpoch(1));
    assert_eq!(event.scroll_id, Some(scene.root_scroll));
    let local = event.local.unwrap();
    assert!((local.x - 50.0).abs() < 1e-6);
    assert!((local.y - 40.0).abs() < 1e-6);
}

#[test]
fn sticky_header_blocks_message_underneath() {
    let scene = chat_scene();
    let mut path = bind_interaction(Arc::clone(&scene.snapshot), chat_items(&scene));
    path.nudge(
        scene.root_scroll,
        Vec2::new(0.0, 500.0),
        ScrollSequence(1),
        ms(16),
    )
    .unwrap();
    path.present(ms(16));
    let event = path
        .pointer_down(ptr(), Point::new(50.0, 10.0), ms(16))
        .unwrap();
    assert_eq!(event.target, Some(StableSemanticId(20)));
}

#[test]
fn viewport_fixed_control_ignores_root_scroll() {
    let scene = chat_scene();
    let mut path = bind_interaction(Arc::clone(&scene.snapshot), chat_items(&scene));
    path.nudge(
        scene.root_scroll,
        Vec2::new(0.0, 500.0),
        ScrollSequence(1),
        ms(16),
    )
    .unwrap();
    path.present(ms(16));
    let event = path
        .pointer_down(ptr(), Point::new(20.0, 20.0), ms(16))
        .unwrap();
    assert_eq!(event.target, Some(StableSemanticId(30)));
    assert_eq!(event.scroll_id, None);
}

#[test]
fn fixed_inside_transformed_ancestor_uses_that_inverse() {
    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let scroll_node =
        builder.alloc_spatial(Some(root), identity(), scroll_kind(scroll, 100.0, 1000.0));
    let transformed = builder.alloc_spatial(
        Some(scroll_node),
        AffineCoeffs::scale(2.0, 2.0),
        SpatialKind::ReferenceFrame,
    );
    let fixed = builder.alloc_spatial(
        Some(transformed),
        AffineCoeffs::translate(1.0, 1.0),
        SpatialKind::Fixed {
            containing_block: transformed,
        },
    );
    let clip = builder.alloc_clip(None, transformed, LogicalRect::new(0.0, 0.0, 50.0, 50.0));
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let mut path = bind_interaction(
        Arc::clone(&snapshot),
        vec![item(
            1,
            7,
            1,
            LogicalRect::new(0.0, 0.0, 4.0, 4.0),
            fixed,
            clip,
            1,
            None,
            true,
        )],
    );
    path.nudge(scroll, Vec2::new(0.0, 10.0), ScrollSequence(1), ms(16))
        .unwrap();
    path.present(ms(16));
    let (sx, sy) = path
        .sampled()
        .unwrap()
        .world(&snapshot, fixed)
        .unwrap()
        .transform_point(0.0, 0.0);
    let event = path
        .pointer_down(ptr(), Point::new(sx, sy), ms(16))
        .unwrap();
    assert_eq!(event.target, Some(StableSemanticId(7)));
    let local = event.local.unwrap();
    assert!(local.x.abs() < 1e-6 && local.y.abs() < 1e-6);
}

#[test]
fn nested_horizontal_latches_inner_then_handoffs_unused_vertical() {
    let mut builder = PropertyTreeBuilder::new();
    let outer = builder.alloc_scroll();
    let inner = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let outer_node =
        builder.alloc_spatial(Some(root), identity(), scroll_kind(outer, 100.0, 1000.0));
    let inner_node = builder.alloc_spatial(
        Some(outer_node),
        AffineCoeffs::translate(0.0, 40.0),
        scroll_kind(inner, 400.0, 100.0),
    );
    let content = builder.alloc_spatial(Some(inner_node), identity(), SpatialKind::ReferenceFrame);
    let clip = builder.alloc_clip(None, root, LogicalRect::new(0.0, 0.0, 400.0, 1000.0));
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let mut path = bind_interaction(
        Arc::clone(&snapshot),
        vec![item(
            1,
            11,
            1,
            LogicalRect::new(0.0, 0.0, 400.0, 80.0),
            content,
            clip,
            1,
            Some(inner),
            true,
        )],
    );
    let down = path
        .pointer_down(ptr(), Point::new(20.0, 50.0), ms(0))
        .unwrap();
    assert_eq!(down.target, Some(StableSemanticId(11)));
    assert_eq!(path.latched_scroll(), Some(inner));
    path.pointer_move(ptr(), Point::new(-80.0, 50.0), ms(16))
        .unwrap();
    assert_eq!(path.latched_scroll(), Some(inner));
    assert!((path.visual_offset(inner).unwrap().x - 100.0).abs() < 1e-6);
    assert_eq!(path.visual_offset(outer).unwrap().y, 0.0);
    path.pointer_move(ptr(), Point::new(-80.0, -100.0), ms(32))
        .unwrap();
    assert_eq!(path.latched_scroll(), Some(outer));
    assert!((path.visual_offset(inner).unwrap().x - 100.0).abs() < 1e-6);
    assert!((path.visual_offset(outer).unwrap().y - 150.0).abs() < 1e-6);
}

#[test]
fn overlap_clip_and_click_through() {
    let mut builder = PropertyTreeBuilder::new();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let message = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::translate(0.0, 40.0),
        SpatialKind::ReferenceFrame,
    );
    let overlay = builder.alloc_spatial(Some(root), identity(), SpatialKind::ReferenceFrame);
    let outer_clip = builder.alloc_clip(None, root, LogicalRect::new(0.0, 0.0, 100.0, 100.0));
    let inner_clip = builder.alloc_clip(
        Some(outer_clip),
        message,
        LogicalRect::new(0.0, 0.0, 20.0, 20.0),
    );
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let blocking = vec![
        item(
            1,
            1,
            1,
            LogicalRect::new(0.0, 0.0, 100.0, 80.0),
            message,
            outer_clip,
            1,
            None,
            true,
        ),
        item(
            2,
            2,
            1,
            LogicalRect::new(0.0, 0.0, 100.0, 100.0),
            overlay,
            outer_clip,
            5,
            None,
            true,
        ),
    ];
    let mut path = bind_interaction(Arc::clone(&snapshot), blocking);
    let blocked = path
        .pointer_down(ptr(), Point::new(10.0, 50.0), ms(0))
        .unwrap();
    assert_eq!(blocked.target, Some(StableSemanticId(2)));

    let passthrough = vec![
        item(
            1,
            1,
            1,
            LogicalRect::new(0.0, 0.0, 100.0, 80.0),
            message,
            outer_clip,
            1,
            None,
            true,
        ),
        item(
            2,
            2,
            1,
            LogicalRect::new(0.0, 0.0, 100.0, 100.0),
            overlay,
            outer_clip,
            5,
            None,
            false,
        ),
    ];
    let mut path = bind_interaction(Arc::clone(&snapshot), passthrough);
    let through = path
        .pointer_down(ptr(), Point::new(10.0, 50.0), ms(0))
        .unwrap();
    assert_eq!(through.target, Some(StableSemanticId(1)));

    let clipped = vec![item(
        1,
        1,
        1,
        LogicalRect::new(0.0, 0.0, 100.0, 80.0),
        message,
        inner_clip,
        1,
        None,
        true,
    )];
    let mut path = bind_interaction(snapshot, clipped);
    let miss = path
        .pointer_down(ptr(), Point::new(50.0, 70.0), ms(0))
        .unwrap();
    assert_eq!(miss.target, None);
    let hit = path
        .pointer_down(ptr(), Point::new(10.0, 50.0), ms(0))
        .unwrap();
    assert_eq!(hit.target, Some(StableSemanticId(1)));
}

#[test]
fn singular_overlay_is_non_hittable_not_a_block() {
    let mut builder = PropertyTreeBuilder::new();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let overlay = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::scale(0.0, 1.0),
        SpatialKind::ReferenceFrame,
    );
    let message = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::translate(0.0, 40.0),
        SpatialKind::ReferenceFrame,
    );
    let clip = builder.alloc_clip(None, root, viewport());
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let mut path = bind_interaction(
        snapshot,
        vec![
            item(
                1,
                1,
                1,
                LogicalRect::new(0.0, 0.0, 100.0, 80.0),
                message,
                clip,
                1,
                None,
                true,
            ),
            item(
                2,
                2,
                1,
                LogicalRect::new(0.0, 0.0, 100.0, 100.0),
                overlay,
                clip,
                9,
                None,
                true,
            ),
        ],
    );
    let event = path
        .pointer_down(ptr(), Point::new(10.0, 50.0), ms(0))
        .unwrap();
    assert_eq!(event.target, Some(StableSemanticId(1)));
}

#[test]
fn pointer_capture_survives_async_scroll() {
    let scene = chat_scene();
    let mut path = bind_interaction(Arc::clone(&scene.snapshot), chat_items(&scene));
    let down = path
        .pointer_down(ptr(), Point::new(50.0, 640.0), ms(0))
        .unwrap();
    assert_eq!(down.target, Some(StableSemanticId(10)));
    path.nudge(
        scene.root_scroll,
        Vec2::new(0.0, 500.0),
        ScrollSequence(1),
        ms(16),
    )
    .unwrap();
    path.present(ms(16));
    let moved = path
        .pointer_move(ptr(), Point::new(51.0, 140.0), ms(32))
        .unwrap();
    assert_eq!(moved.kind, PointerKind::Move);
    assert_eq!(moved.target, Some(StableSemanticId(10)));
    assert_eq!(path.captured_target(), Some(StableSemanticId(10)));
}

#[test]
fn recycled_target_cancels_and_does_not_fall_through() {
    let scene = chat_scene();
    let mut path = bind_interaction(Arc::clone(&scene.snapshot), chat_items(&scene));
    path.pointer_down(ptr(), Point::new(50.0, 640.0), ms(0))
        .unwrap();
    let mut recycled = chat_items(&scene);
    recycled[0].generation = 2;
    recycled[0].target = StableSemanticId(99);
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(SceneEpoch(1), recycled)))
        .unwrap();
    let event = path
        .pointer_move(ptr(), Point::new(50.0, 640.0), ms(16))
        .unwrap();
    assert_eq!(event.kind, PointerKind::Cancel);
    assert_eq!(event.target, Some(StableSemanticId(10)));
    assert_ne!(event.target, Some(StableSemanticId(99)));
    assert!(path.captured_target().is_none());
}

#[test]
fn stale_hit_snapshot_epoch_is_rejected() {
    let scene = chat_scene();
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(Arc::clone(&scene.snapshot));
    let stale = HitTestSnapshot::commit(SceneEpoch(9), chat_items(&scene));
    assert_eq!(
        path.bind_hit_test(Arc::new(stale)),
        Err(DispatchError::StaleEpoch)
    );
    let mut builder = PropertyTreeBuilder::new();
    builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let next = Arc::new(builder.commit(SceneEpoch(2)).unwrap());
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(
        SceneEpoch(1),
        chat_items(&scene),
    )))
    .unwrap();
    path.bind_snapshot(next);
    assert_eq!(
        path.pointer_down(ptr(), Point::new(1.0, 1.0), ms(0)),
        Err(DispatchError::StaleEpoch)
    );
}

#[test]
fn reversal_keeps_latch_handoff_does_not_double_apply() {
    let mut builder = PropertyTreeBuilder::new();
    let outer = builder.alloc_scroll();
    let inner = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let outer_node =
        builder.alloc_spatial(Some(root), identity(), scroll_kind(outer, 100.0, 1000.0));
    let inner_node = builder.alloc_spatial(
        Some(outer_node),
        identity(),
        scroll_kind(inner, 100.0, 200.0),
    );
    let content = builder.alloc_spatial(Some(inner_node), identity(), SpatialKind::ReferenceFrame);
    let clip = builder.alloc_clip(None, root, viewport());
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let mut path = bind_interaction(
        snapshot,
        vec![item(
            1,
            4,
            1,
            LogicalRect::new(0.0, 0.0, 100.0, 80.0),
            content,
            clip,
            1,
            Some(inner),
            true,
        )],
    );
    path.pointer_down(ptr(), Point::new(10.0, 10.0), ms(0))
        .unwrap();
    path.pointer_move(ptr(), Point::new(10.0, -10.0), ms(16))
        .unwrap();
    assert_eq!(path.latched_scroll(), Some(inner));
    path.pointer_move(ptr(), Point::new(10.0, 0.0), ms(32))
        .unwrap();
    assert_eq!(path.latched_scroll(), Some(inner));
    path.pointer_move(ptr(), Point::new(10.0, -200.0), ms(48))
        .unwrap();
    assert_eq!(path.latched_scroll(), Some(outer));
    assert!((path.visual_offset(inner).unwrap().y - 100.0).abs() < 1e-6);
    assert!((path.visual_offset(outer).unwrap().y - 110.0).abs() < 1e-6);
}

#[test]
fn hit_test_path_does_not_allocate_or_block() {
    let scene = chat_scene();
    let mut path = bind_interaction(Arc::clone(&scene.snapshot), chat_items(&scene));
    path.nudge(
        scene.root_scroll,
        Vec2::new(0.0, 500.0),
        ScrollSequence(1),
        ms(16),
    )
    .unwrap();
    path.present(ms(16));
    let ptr_before = path.sampled().unwrap().worlds_ptr();
    let cap = path.sampled().unwrap().worlds_capacity();
    path.pointer_down(ptr(), Point::new(50.0, 140.0), ms(16))
        .unwrap();
    for i in 0..64u64 {
        path.pointer_move(ptr(), Point::new(50.0, 140.0 - i as f64), ms(16 + i))
            .unwrap();
    }
    let up: PointerEvent = path
        .pointer_up(ptr(), Point::new(50.0, 80.0), ms(100))
        .unwrap();
    assert_eq!(up.target, Some(StableSemanticId(10)));
    assert_eq!(path.sampled().unwrap().worlds_ptr(), ptr_before);
    assert_eq!(path.sampled().unwrap().worlds_capacity(), cap);
    assert_eq!(path.producer_requests(), 0);

    let snapshot = Arc::clone(&scene.snapshot);
    let items = chat_items(&scene);
    let worker = thread::spawn(move || {
        let mut path = bind_interaction(snapshot, items);
        path.pointer_down(PointerId(2), Point::new(20.0, 20.0), ms(0))
            .map(|event| event.kind)
    });
    assert_eq!(worker.join().unwrap().unwrap(), PointerKind::Down);
}
