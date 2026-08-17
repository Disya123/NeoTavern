use neotavern_neocompositor::{
    AnimValue, AnimationProperty, AnimationSpec, CompositorFastPath, Easing, EffectId, EffectSpec,
    FastPathError, GestureId, Insets, LogicalRect, Point, PresentationTime, PropertyEffectKind,
    PropertySnapshot, PropertyTreeBuilder, RasterDecision, SceneEpoch, ScrollAck, ScrollEpoch,
    ScrollId, ScrollRange, ScrollSequence, Size, SpatialId, SpatialKind, Vec2,
};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn identity() -> neotavern_neocompositor::AffineCoeffs {
    neotavern_neocompositor::AffineCoeffs::IDENTITY
}

fn viewport() -> LogicalRect {
    LogicalRect::new(0.0, 0.0, 100.0, 100.0)
}

fn scroll_kind(scroll_id: ScrollId, content_height: f64) -> SpatialKind {
    SpatialKind::Scroll {
        scroll_id,
        scrollport: viewport(),
        content_extent: LogicalRect::new(0.0, 0.0, 100.0, content_height),
    }
}

fn assert_close(actual: f64, expected: f64, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{what}: {actual} != {expected}"
    );
}

fn assert_vec(actual: Vec2, x: f64, y: f64, what: &str) {
    assert_close(actual.x, x, &format!("{what}.x"));
    assert_close(actual.y, y, &format!("{what}.y"));
}

fn ms(ms: u64) -> PresentationTime {
    PresentationTime::from_millis(ms)
}

struct NestedScroll {
    snapshot: Arc<PropertySnapshot>,
    outer: ScrollId,
    inner: ScrollId,
    inner_content: SpatialId,
    outer_sibling: SpatialId,
}

fn nested_tree() -> NestedScroll {
    let mut builder = PropertyTreeBuilder::new();
    let outer = builder.alloc_scroll();
    let inner = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let outer_node = builder.alloc_spatial(Some(root), identity(), scroll_kind(outer, 1000.0));
    let outer_sibling =
        builder.alloc_spatial(Some(outer_node), identity(), SpatialKind::ReferenceFrame);
    let inner_node = builder.alloc_spatial(Some(outer_node), identity(), scroll_kind(inner, 200.0));
    let inner_content =
        builder.alloc_spatial(Some(inner_node), identity(), SpatialKind::ReferenceFrame);
    NestedScroll {
        snapshot: Arc::new(builder.commit(SceneEpoch(1)).unwrap()),
        outer,
        inner,
        inner_content,
        outer_sibling,
    }
}

struct StickyFixed {
    snapshot: Arc<PropertySnapshot>,
    scroll: ScrollId,
    sticky: SpatialId,
    viewport_fixed: SpatialId,
    content: SpatialId,
}

fn sticky_fixed_tree() -> StickyFixed {
    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let scroll_node = builder.alloc_spatial(Some(root), identity(), scroll_kind(scroll, 1000.0));
    let content = builder.alloc_spatial(
        Some(scroll_node),
        neotavern_neocompositor::AffineCoeffs::translate(0.0, 40.0),
        SpatialKind::ReferenceFrame,
    );
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
                max: Vec2::new(0.0, 800.0),
            },
            size: Size::new(100.0, 20.0),
        },
    );
    let viewport_fixed = builder.alloc_spatial(
        Some(root),
        neotavern_neocompositor::AffineCoeffs::translate(10.0, 10.0),
        SpatialKind::Fixed {
            containing_block: root,
        },
    );
    StickyFixed {
        snapshot: Arc::new(builder.commit(SceneEpoch(1)).unwrap()),
        scroll,
        sticky,
        viewport_fixed,
        content,
    }
}

fn bind(snapshot: Arc<PropertySnapshot>) -> CompositorFastPath {
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(snapshot);
    path
}

fn translation_tree() -> (Arc<PropertySnapshot>, SpatialId) {
    let mut builder = PropertyTreeBuilder::new();
    let node = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    (Arc::new(builder.commit(SceneEpoch(1)).unwrap()), node)
}

fn opacity_tree() -> (Arc<PropertySnapshot>, EffectId) {
    let mut builder = PropertyTreeBuilder::new();
    let root_bd = builder.declare_backdrop_root();
    let spatial = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let clip = builder.alloc_clip(None, spatial, viewport());
    let opacity = builder.alloc_effect(EffectSpec {
        parent: None,
        spatial,
        clip,
        kind: PropertyEffectKind::Opacity(1.0),
        backdrop_root: root_bd,
        bounds: viewport(),
    });
    (Arc::new(builder.commit(SceneEpoch(1)).unwrap()), opacity)
}

#[test]
fn ten_thousand_frames_do_not_call_producer_or_raster() {
    let tree = nested_tree();
    let mut path = bind(Arc::clone(&tree.snapshot));
    path.present(ms(0));
    let ptr = path.sampled().unwrap().worlds_ptr();
    let cap = path.sampled().unwrap().worlds_capacity();
    for i in 0..10_000u64 {
        let time = PresentationTime::from_nanos(i * 8_333_333);
        path.nudge(
            tree.outer,
            Vec2::new(0.0, 0.05),
            ScrollSequence(i + 1),
            time,
        )
        .unwrap();
        let outcome = path.present(time);
        assert_eq!(outcome.raster, RasterDecision::CompositeOnly);
        assert_eq!(outcome.scene_epoch, SceneEpoch(1));
    }
    assert_eq!(path.producer_requests(), 0);
    assert_eq!(path.raster_invalidations(), 0);
    assert_eq!(path.sampled().unwrap().worlds_ptr(), ptr);
    assert_eq!(path.sampled().unwrap().worlds_capacity(), cap);
}

#[test]
fn ack_rebase_does_not_teleport_or_double_apply() {
    let tree = nested_tree();
    let mut path = bind(Arc::clone(&tree.snapshot));
    path.nudge(tree.outer, Vec2::new(0.0, 10.0), ScrollSequence(1), ms(16))
        .unwrap();
    path.nudge(tree.outer, Vec2::new(0.0, 20.0), ScrollSequence(2), ms(32))
        .unwrap();
    path.present(ms(32));
    assert_vec(
        path.visual_offset(tree.outer).unwrap(),
        0.0,
        30.0,
        "visual before ack",
    );

    assert_eq!(
        path.ack(ScrollAck {
            scroll_id: tree.outer,
            epoch: ScrollEpoch(0),
            base_offset: Vec2::new(0.0, 10.0),
            scroll_sequence: ScrollSequence(1),
        }),
        neotavern_neocompositor::AckResult::Applied
    );
    let state = path.scroll_state(tree.outer).unwrap();
    assert_vec(state.committed_offset, 0.0, 10.0, "committed");
    assert_vec(state.unacked_delta, 0.0, 20.0, "unacked");
    assert_vec(state.visual_offset(), 0.0, 30.0, "visual after first ack");

    path.ack(ScrollAck {
        scroll_id: tree.outer,
        epoch: ScrollEpoch(0),
        base_offset: Vec2::new(0.0, 30.0),
        scroll_sequence: ScrollSequence(2),
    });
    assert_vec(
        path.visual_offset(tree.outer).unwrap(),
        0.0,
        30.0,
        "visual after full ack",
    );
    let state = path.scroll_state(tree.outer).unwrap();
    assert_vec(state.unacked_delta, 0.0, 0.0, "unacked drained");
}

#[test]
fn stale_and_out_of_order_acks_are_ignored() {
    let tree = nested_tree();
    let mut path = bind(Arc::clone(&tree.snapshot));
    path.nudge(tree.outer, Vec2::new(0.0, 8.0), ScrollSequence(1), ms(16))
        .unwrap();
    path.nudge(tree.outer, Vec2::new(0.0, 8.0), ScrollSequence(2), ms(32))
        .unwrap();
    path.ack(ScrollAck {
        scroll_id: tree.outer,
        epoch: ScrollEpoch(0),
        base_offset: Vec2::new(0.0, 8.0),
        scroll_sequence: ScrollSequence(1),
    });
    let visual = path.visual_offset(tree.outer).unwrap();
    assert_eq!(
        path.ack(ScrollAck {
            scroll_id: tree.outer,
            epoch: ScrollEpoch(0),
            base_offset: Vec2::new(0.0, 999.0),
            scroll_sequence: ScrollSequence(1),
        }),
        neotavern_neocompositor::AckResult::IgnoredStale
    );
    assert_eq!(
        path.ack(ScrollAck {
            scroll_id: tree.outer,
            epoch: ScrollEpoch(0),
            base_offset: Vec2::new(0.0, 0.0),
            scroll_sequence: ScrollSequence(0),
        }),
        neotavern_neocompositor::AckResult::IgnoredStale
    );
    assert_eq!(
        path.ack(ScrollAck {
            scroll_id: tree.inner,
            epoch: ScrollEpoch(0),
            base_offset: Vec2::new(0.0, 4.0),
            scroll_sequence: ScrollSequence(9),
        }),
        neotavern_neocompositor::AckResult::IgnoredStale
    );
    assert_vec(
        path.visual_offset(tree.outer).unwrap(),
        visual.x,
        visual.y,
        "unchanged",
    );
}

#[test]
fn direction_reversal_keeps_the_latched_scroll() {
    let tree = nested_tree();
    let mut path = bind(Arc::clone(&tree.snapshot));
    let gesture = GestureId(1);
    path.begin_gesture(gesture, &[tree.inner, tree.outer])
        .unwrap();
    let latched = path
        .gesture_delta(gesture, Vec2::new(0.0, 20.0), ScrollSequence(1), ms(16))
        .unwrap();
    assert_eq!(latched, tree.inner);
    let reversed = path
        .gesture_delta(gesture, Vec2::new(0.0, -10.0), ScrollSequence(2), ms(32))
        .unwrap();
    assert_eq!(reversed, tree.inner);
    assert_eq!(path.latched_scroll(), Some(tree.inner));
    assert_vec(path.visual_offset(tree.inner).unwrap(), 0.0, 10.0, "inner");
    assert_vec(path.visual_offset(tree.outer).unwrap(), 0.0, 0.0, "outer");
    let velocity = path.scroll_state(tree.inner).unwrap().screen_velocity;
    assert!(velocity.y < 0.0, "velocity follows reversal");
}

#[test]
fn nested_latch_handoffs_only_unused_delta() {
    let tree = nested_tree();
    let mut path = bind(Arc::clone(&tree.snapshot));
    let gesture = GestureId(7);
    path.begin_gesture(gesture, &[tree.inner, tree.outer])
        .unwrap();
    let latched = path
        .gesture_delta(gesture, Vec2::new(0.0, 150.0), ScrollSequence(1), ms(16))
        .unwrap();
    assert_eq!(latched, tree.outer);
    assert_vec(
        path.visual_offset(tree.inner).unwrap(),
        0.0,
        100.0,
        "inner clamped",
    );
    assert_vec(
        path.visual_offset(tree.outer).unwrap(),
        0.0,
        50.0,
        "unused only",
    );
    path.present(ms(16));
    let sampled = path.sampled().unwrap();
    let inner_world = sampled
        .world(&tree.snapshot, tree.inner_content)
        .unwrap()
        .translation();
    assert_close(inner_world.1, -150.0, "nested visual");
    let _ = tree.outer_sibling;
}

#[test]
fn fixed_and_sticky_follow_async_scroll() {
    let tree = sticky_fixed_tree();
    let mut path = bind(Arc::clone(&tree.snapshot));
    path.nudge(tree.scroll, Vec2::new(0.0, 40.0), ScrollSequence(1), ms(16))
        .unwrap();
    path.present(ms(16));
    let sampled = path.sampled().unwrap();
    let sticky = sampled
        .world(&tree.snapshot, tree.sticky)
        .unwrap()
        .translation();
    let fixed = sampled
        .world(&tree.snapshot, tree.viewport_fixed)
        .unwrap()
        .translation();
    let content = sampled
        .world(&tree.snapshot, tree.content)
        .unwrap()
        .translation();
    assert_close(sticky.1, 0.0, "sticky stays pinned");
    assert_close(fixed.0, 10.0, "fixed x");
    assert_close(fixed.1, 10.0, "fixed y");
    assert_close(content.1, 0.0, "scrolled content");
}

#[test]
fn animation_result_matches_across_refresh_rates() {
    let (snapshot, node) = translation_tree();
    let spec = AnimationSpec {
        property: AnimationProperty::Translation(node),
        from: Some(AnimValue::Translation(Vec2::new(0.0, 0.0))),
        to: AnimValue::Translation(Vec2::new(120.0, 0.0)),
        duration: Duration::from_millis(1000),
        easing: Easing::Linear,
    };
    let mut path60 = bind(Arc::clone(&snapshot));
    let id60 = path60.start_animation(spec, ms(0)).unwrap();
    let mut path90 = bind(Arc::clone(&snapshot));
    let id90 = path90.start_animation(spec, ms(0)).unwrap();
    let mut path120 = bind(Arc::clone(&snapshot));
    let id120 = path120.start_animation(spec, ms(0)).unwrap();
    for (path, id, hz) in [
        (&mut path60, id60, 60u64),
        (&mut path90, id90, 90),
        (&mut path120, id120, 120),
    ] {
        let frame_ns = 1_000_000_000 / hz;
        let mut time = PresentationTime::from_nanos(0);
        let target = PresentationTime::from_millis(500);
        while time < target {
            time = time.saturating_add_nanos(frame_ns);
            if time > target {
                time = target;
            }
            path.present(time);
        }
        match path.animation_value(id, target).unwrap() {
            AnimValue::Translation(v) => assert_vec(v, 60.0, 0.0, &format!("{hz} Hz")),
            other => panic!("expected translation, got {other:?}"),
        }
        let world = path
            .sampled()
            .unwrap()
            .world(path.snapshot().unwrap(), node)
            .unwrap()
            .translation();
        assert_close(world.0, 60.0, &format!("{hz} Hz world"));
    }
}

#[test]
fn animation_retarget_keeps_current_value() {
    let (snapshot, node) = translation_tree();
    let mut path = bind(snapshot);
    let id = path
        .start_animation(
            AnimationSpec {
                property: AnimationProperty::Translation(node),
                from: Some(AnimValue::Translation(Vec2::default())),
                to: AnimValue::Translation(Vec2::new(100.0, 0.0)),
                duration: Duration::from_millis(1000),
                easing: Easing::Linear,
            },
            ms(0),
        )
        .unwrap();
    path.present(ms(500));
    let before = path.animation_value(id, ms(500)).unwrap();
    let AnimValue::Translation(v0) = before else {
        panic!("translation");
    };
    assert_vec(v0, 50.0, 0.0, "midpoint");
    let kept = path
        .retarget_animation(
            id,
            AnimValue::Translation(Vec2::new(0.0, 0.0)),
            Duration::from_millis(500),
            ms(500),
        )
        .unwrap();
    assert_eq!(kept, before);
    let immediate = path.animation_value(id, ms(500)).unwrap();
    assert_eq!(immediate, before);
    path.present(ms(1000));
    match path.animation_value(id, ms(1000)).unwrap() {
        AnimValue::Translation(v) => assert_vec(v, 0.0, 0.0, "retarget end"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn unsupported_animation_needs_producer() {
    let (snapshot, node) = translation_tree();
    let mut path = bind(snapshot);
    for property in [
        AnimationProperty::Width,
        AnimationProperty::Height,
        AnimationProperty::Color,
        AnimationProperty::FontSize,
        AnimationProperty::GlyphOffset,
    ] {
        assert_eq!(
            path.start_animation(
                AnimationSpec {
                    property,
                    from: None,
                    to: AnimValue::Translation(Vec2::new(1.0, 0.0)),
                    duration: Duration::from_millis(100),
                    easing: Easing::Linear,
                },
                ms(0),
            ),
            Err(FastPathError::NeedsProducer)
        );
    }
    let _ = node;
    assert!(path.producer_requests() >= 5);
    assert_eq!(path.raster_invalidations(), 0);
}

#[test]
fn bounds_clamp_unused_delta() {
    let tree = nested_tree();
    let mut path = bind(Arc::clone(&tree.snapshot));
    let unused = path
        .nudge(tree.inner, Vec2::new(0.0, 500.0), ScrollSequence(1), ms(16))
        .unwrap();
    assert_vec(
        path.visual_offset(tree.inner).unwrap(),
        0.0,
        100.0,
        "clamped",
    );
    assert_vec(unused, 0.0, 400.0, "leftover");
}

#[test]
fn present_does_not_allocate_block_or_invalidate_raster() {
    let (snapshot, node) = translation_tree();
    let mut path = bind(Arc::clone(&snapshot));
    let id = path
        .start_animation(
            AnimationSpec {
                property: AnimationProperty::Translation(node),
                from: Some(AnimValue::Translation(Vec2::default())),
                to: AnimValue::Translation(Vec2::new(8.0, 0.0)),
                duration: Duration::from_millis(100),
                easing: Easing::Linear,
            },
            ms(0),
        )
        .unwrap();
    path.present(ms(0));
    let ptr = path.sampled().unwrap().worlds_ptr();
    let cap = path.sampled().unwrap().worlds_capacity();
    path.present(ms(50));
    path.present(ms(100));
    assert_eq!(path.sampled().unwrap().worlds_ptr(), ptr);
    assert_eq!(path.sampled().unwrap().worlds_capacity(), cap);
    assert_eq!(path.raster_invalidations(), 0);
    assert_eq!(path.producer_requests(), 0);
    let _ = id;

    let worker_snapshot = Arc::clone(&snapshot);
    let worker = thread::spawn(move || {
        let mut path = bind(worker_snapshot);
        for i in 0..64u64 {
            path.present(PresentationTime::from_millis(i));
        }
        (path.producer_requests(), path.raster_invalidations())
    });
    assert_eq!(worker.join().unwrap(), (0, 0));
}

#[test]
fn opacity_animation_samples_without_raster() {
    let (snapshot, effect) = opacity_tree();
    let mut path = bind(snapshot);
    path.start_animation(
        AnimationSpec {
            property: AnimationProperty::Opacity(effect),
            from: Some(AnimValue::Opacity(1.0)),
            to: AnimValue::Opacity(0.25),
            duration: Duration::from_millis(80),
            easing: Easing::Linear,
        },
        ms(0),
    )
    .unwrap();
    path.present(ms(40));
    let alpha = path.opacity(effect).unwrap();
    assert!((alpha - 0.625).abs() < 1e-5);
    assert_eq!(path.raster_invalidations(), 0);
}
