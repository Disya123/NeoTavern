use neotavern_neocompositor::{
    autoscroll_delta, expand_android_motion, presentation_time_from_vsync, AffineCoeffs,
    AndroidMotionView, AnimValue, AnimationProperty, AnimationSpec, ClipId, ClusterBoundary,
    CompositorFastPath, DeviceEpoch, Easing, GeometryTile, GeometryTileSnapshot, HitTestId,
    HitTestItem, HitTestSnapshot, InputPush, LineMetric, LogicalRect, PaintChunk, PaintChunkId,
    PaintOrderKey, PlatformInputAdapter, PlatformPointerKind, PlatformPointerSample, Point,
    PointerFlags, PointerId, PresentationTime, ProducerGlyph, PropertySnapshot,
    PropertyTreeBuilder, Rect, SceneEpoch, ScrollId, ScrollSequence, SelectablePaintPlan,
    SelectionSession, ShapedRunRef, SpatialId, SpatialKind, SpatialNodeId, StableSemanticId,
    StubPayload, TextFragmentId, TextInteractionSnapshot, TextOffset, TextRange, TextSnapshotSet,
    TileCoverage, TileId, TileKind, Vec2, ANDROID_ACTION_CANCEL, ANDROID_ACTION_DOWN,
    ANDROID_ACTION_MOVE, ANDROID_ACTION_POINTER_DOWN, ANDROID_ACTION_POINTER_INDEX_SHIFT,
    ANDROID_ACTION_POINTER_UP, ANDROID_ACTION_UP, INPUT_QUEUE_CAP,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn identity() -> AffineCoeffs {
    AffineCoeffs::IDENTITY
}

fn viewport() -> LogicalRect {
    LogicalRect::new(0.0, 0.0, 100.0, 100.0)
}

fn sample(
    kind: PlatformPointerKind,
    pointer: u64,
    x: f32,
    y: f32,
    time_nanos: u64,
) -> PlatformPointerSample {
    PlatformPointerSample {
        pointer: PointerId(pointer),
        kind,
        x,
        y,
        time_nanos,
    }
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
        pointer_flags: PointerFlags::PARTICIPATES,
    }
}

struct ChatScene {
    snapshot: Arc<PropertySnapshot>,
    root_scroll: ScrollId,
    message: SpatialId,
    sticky: SpatialId,
    fixed: SpatialId,
    clip: ClipId,
}

fn chat_scene(epoch: SceneEpoch) -> ChatScene {
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
        snapshot: Arc::new(builder.commit(epoch).unwrap()),
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
        ),
    ]
}

fn bind_chat(scene: &ChatScene) -> CompositorFastPath {
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(Arc::clone(&scene.snapshot));
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(
        scene.snapshot.scene_epoch(),
        chat_items(scene),
    )))
    .unwrap();
    path.present(PresentationTime::from_nanos(0));
    path
}

fn push_down_move_up(adapter: &PlatformInputAdapter, pointer: u64, x: f32, y: f32) {
    assert_eq!(
        adapter.try_push(sample(PlatformPointerKind::Down, pointer, x, y, 0)),
        InputPush::Queued
    );
    assert_eq!(
        adapter.try_push(sample(
            PlatformPointerKind::Move,
            pointer,
            x,
            y + 1.0,
            1_000_000
        )),
        InputPush::Queued
    );
    assert_eq!(
        adapter.try_push(sample(
            PlatformPointerKind::Up,
            pointer,
            x,
            y + 1.0,
            2_000_000
        )),
        InputPush::Queued
    );
}

#[test]
fn ten_thousand_moves_stay_bounded() {
    let adapter = PlatformInputAdapter::new();
    adapter.try_push(sample(PlatformPointerKind::Down, 1, 0.0, 0.0, 0));
    for i in 0..10_000u64 {
        let result = adapter.try_push(sample(
            PlatformPointerKind::Move,
            1,
            0.0,
            i as f32,
            i.saturating_add(1) * 1_000_000,
        ));
        assert!(matches!(
            result,
            InputPush::Queued | InputPush::Coalesced | InputPush::DroppedMove
        ));
    }
    adapter.try_push(sample(
        PlatformPointerKind::Up,
        1,
        0.0,
        10_000.0,
        11_000_000_000,
    ));
    let stats = adapter.stats();
    assert!(stats.high_water <= INPUT_QUEUE_CAP);
    assert!(stats.current <= INPUT_QUEUE_CAP);
    assert!(stats.coalesced_moves + stats.dropped_moves > 0);
    assert_eq!(stats.dropped_edges, 0);
}

#[test]
fn fling_velocity_matches_across_coalescing() {
    fn run(coalesce: bool) -> f64 {
        let scene = chat_scene(SceneEpoch(1));
        let mut path = bind_chat(&scene);
        let adapter = PlatformInputAdapter::new();
        adapter.try_push(sample(PlatformPointerKind::Down, 1, 50.0, 640.0, 0));
        adapter.drain(&mut path).unwrap();
        let steps = if coalesce { 1 } else { 40 };
        for i in 1..=steps {
            let t = 40_000_000 * i / steps;
            let y = 640.0 - 400.0 * (i as f32) / (steps as f32);
            adapter.try_push(sample(PlatformPointerKind::Move, 1, 50.0, y, t));
            if !coalesce {
                adapter.drain(&mut path).unwrap();
            }
        }
        if coalesce {
            adapter.drain(&mut path).unwrap();
        }
        path.scroll_state(scene.root_scroll)
            .unwrap()
            .screen_velocity
            .y
    }
    let fine = run(false);
    let coalesced = run(true);
    assert!(fine > 8_000.0, "fine {fine}");
    assert!(coalesced > 8_000.0, "coalesced {coalesced}");
    let rel = (fine - coalesced).abs() / fine.max(coalesced);
    assert!(rel < 0.15, "fine={fine} coalesced={coalesced} rel={rel}");
}

#[test]
fn sticky_and_fixed_tap_after_async_scroll() {
    let scene = chat_scene(SceneEpoch(1));
    let mut path = bind_chat(&scene);
    path.nudge(
        scene.root_scroll,
        Vec2::new(0.0, 500.0),
        ScrollSequence(1),
        PresentationTime::from_millis(16),
    )
    .unwrap();
    path.present(PresentationTime::from_millis(16));
    let adapter = PlatformInputAdapter::new();
    adapter.try_push(sample(PlatformPointerKind::Down, 1, 50.0, 10.0, 16_000_000));
    adapter.drain(&mut path).unwrap();
    assert_eq!(path.captured_target(), Some(StableSemanticId(20)));
    adapter.try_push(sample(PlatformPointerKind::Up, 1, 50.0, 10.0, 17_000_000));
    adapter.drain(&mut path).unwrap();
    adapter.try_push(sample(PlatformPointerKind::Down, 2, 20.0, 20.0, 18_000_000));
    adapter.drain(&mut path).unwrap();
    assert_eq!(path.captured_target(), Some(StableSemanticId(30)));
}

#[test]
fn nested_horizontal_then_vertical_handoff() {
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
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(Arc::clone(&snapshot));
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(
        SceneEpoch(1),
        vec![item(
            1,
            11,
            1,
            LogicalRect::new(0.0, 0.0, 400.0, 80.0),
            content,
            clip,
            1,
            Some(inner),
        )],
    )))
    .unwrap();
    let adapter = PlatformInputAdapter::new();
    adapter.try_push(sample(PlatformPointerKind::Down, 1, 20.0, 50.0, 0));
    adapter.drain(&mut path).unwrap();
    assert_eq!(path.latched_scroll(), Some(inner));
    adapter.try_push(sample(
        PlatformPointerKind::Move,
        1,
        -80.0,
        50.0,
        16_000_000,
    ));
    adapter.drain(&mut path).unwrap();
    assert_eq!(path.latched_scroll(), Some(inner));
    adapter.try_push(sample(
        PlatformPointerKind::Move,
        1,
        -80.0,
        -100.0,
        32_000_000,
    ));
    adapter.drain(&mut path).unwrap();
    assert_eq!(path.latched_scroll(), Some(outer));
}

#[test]
fn pointer_index_remap_keeps_android_id() {
    let ids = [2, 7];
    let xs = [10.0, 40.0];
    let ys = [11.0, 41.0];
    let down_second = AndroidMotionView {
        action: ANDROID_ACTION_POINTER_DOWN | (1 << ANDROID_ACTION_POINTER_INDEX_SHIFT),
        pointer_count: 2,
        event_time_nanos: 5,
        pointer_ids: &ids,
        x: &xs,
        y: &ys,
        history_times_nanos: &[],
        history_x: &[],
        history_y: &[],
    };
    let mut out = [sample(PlatformPointerKind::Move, 0, 0.0, 0.0, 0); 8];
    let n = expand_android_motion(&down_second, &mut out);
    assert_eq!(n, 1);
    assert_eq!(out[0].pointer, PointerId(7));
    assert_eq!(out[0].kind, PlatformPointerKind::Down);
    let up_first = AndroidMotionView {
        action: ANDROID_ACTION_POINTER_UP,
        pointer_count: 2,
        event_time_nanos: 6,
        pointer_ids: &ids,
        x: &xs,
        y: &ys,
        history_times_nanos: &[],
        history_x: &[],
        history_y: &[],
    };
    let n = expand_android_motion(&up_first, &mut out);
    assert_eq!(n, 1);
    assert_eq!(out[0].pointer, PointerId(2));
    assert_eq!(out[0].kind, PlatformPointerKind::Up);
}

#[test]
fn historical_move_keeps_original_timestamps() {
    let ids = [1];
    let xs = [30.0];
    let ys = [40.0];
    let history_t = [1_000_000u64, 2_000_000];
    let history_x = [10.0, 20.0];
    let history_y = [11.0, 21.0];
    let event = AndroidMotionView {
        action: ANDROID_ACTION_MOVE,
        pointer_count: 1,
        event_time_nanos: 3_000_000,
        pointer_ids: &ids,
        x: &xs,
        y: &ys,
        history_times_nanos: &history_t,
        history_x: &history_x,
        history_y: &history_y,
    };
    let mut out = [sample(PlatformPointerKind::Move, 0, 0.0, 0.0, 0); 8];
    let n = expand_android_motion(&event, &mut out);
    assert_eq!(n, 3);
    assert_eq!(out[0].time_nanos, 1_000_000);
    assert_eq!(out[1].time_nanos, 2_000_000);
    assert_eq!(out[2].time_nanos, 3_000_000);
    assert_eq!(out[2].x, 30.0);
}

#[test]
fn capture_target_removal_cancels() {
    let scene = chat_scene(SceneEpoch(1));
    let mut path = bind_chat(&scene);
    let adapter = PlatformInputAdapter::new();
    adapter.try_push(sample(PlatformPointerKind::Down, 1, 50.0, 640.0, 0));
    adapter.drain(&mut path).unwrap();
    assert_eq!(path.captured_target(), Some(StableSemanticId(10)));
    let mut recycled = chat_items(&scene);
    recycled[0].generation = 2;
    recycled[0].target = StableSemanticId(99);
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(SceneEpoch(1), recycled)))
        .unwrap();
    adapter.try_push(sample(
        PlatformPointerKind::Move,
        1,
        50.0,
        641.0,
        16_000_000,
    ));
    adapter.drain(&mut path).unwrap();
    assert!(path.captured_target().is_none());
}

#[test]
fn selection_drag_edge_autoscroll_uses_same_sequence() {
    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let node = builder.alloc_spatial(
        Some(root),
        identity(),
        SpatialKind::Scroll {
            scroll_id: scroll,
            scrollport: LogicalRect::new(0.0, 0.0, 400.0, 240.0),
            content_extent: LogicalRect::new(0.0, 0.0, 400.0, 2000.0),
        },
    );
    let clip = builder.alloc_clip(None, root, LogicalRect::new(0.0, 0.0, 400.0, 2000.0));
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(Arc::clone(&snapshot));
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(
        SceneEpoch(1),
        vec![item(
            1,
            7,
            1,
            LogicalRect::new(0.0, 0.0, 400.0, 240.0),
            node,
            clip,
            1,
            Some(scroll),
        )],
    )))
    .unwrap();
    let fragment = tiny_fragment(SceneEpoch(1));
    let geometry = GeometryTileSnapshot::commit(
        SceneEpoch(1),
        vec![GeometryTile {
            id: TileId(1),
            bounds: Rect::new(0.0, 0.0, 400.0, 240.0),
            generation: 1,
            kind: TileKind::Prepared,
        }],
    );
    path.bind_text(Arc::new(
        TextSnapshotSet::commit(SceneEpoch(1), vec![fragment.clone()]).unwrap(),
    ))
    .unwrap();
    path.bind_geometry(Arc::new(geometry.clone())).unwrap();
    let adapter = PlatformInputAdapter::new();
    adapter.try_push(sample(PlatformPointerKind::Down, 1, 10.0, 10.0, 0));
    adapter.drain(&mut path).unwrap();
    let mut session = SelectionSession::begin(&fragment, 10.0, 10.0).unwrap();
    adapter.try_push(sample(
        PlatformPointerKind::Move,
        1,
        10.0,
        230.0,
        16_000_000,
    ));
    let mut seq = 1;
    let plan = SelectablePaintPlan::plain(
        PaintChunk {
            id: PaintChunkId(1),
            generation: 1,
            paint_order: PaintOrderKey(1),
            spatial_node: SpatialNodeId(0),
            clip_chain: neotavern_neocompositor::ClipChainId(0),
            effect_node: neotavern_neocompositor::EffectNodeId(0),
            backdrop_root: neotavern_neocompositor::BackdropRootId(0),
            bounds: Rect::new(0.0, 0.0, 400.0, 240.0),
            payload: StubPayload::Wallpaper,
        },
        Rect::new(0.0, 0.0, 400.0, 240.0),
    );
    adapter
        .drain_selection(
            &mut path,
            &mut session,
            &fragment,
            &geometry,
            &plan,
            Rect::new(0.0, 0.0, 400.0, 240.0),
            &mut seq,
        )
        .unwrap();
    let expected = autoscroll_delta(Rect::new(0.0, 0.0, 400.0, 240.0), 10.0, 230.0).unwrap();
    assert!(expected.y > 0.0);
    assert!(path.visual_offset(scroll).unwrap().y > 0.0);
}

fn tiny_fragment(epoch: SceneEpoch) -> TextInteractionSnapshot {
    let glyphs: Arc<[ProducerGlyph]> = Arc::from([ProducerGlyph {
        glyph_id: 1,
        cluster: TextOffset(0),
        x: 0.0,
        y: 0.0,
        advance: 10.0,
        font_key: 1,
        color_emoji: false,
    }]);
    TextInteractionSnapshot {
        scene_epoch: epoch,
        generation: 1,
        fragment_id: TextFragmentId::new(1, 1),
        semantic: StableSemanticId(7),
        logical_range: TextRange::new(0, 1),
        shaped_runs: Arc::from([ShapedRunRef {
            run_id: 1,
            logical: TextRange::new(0, 1),
            visual_order: 0,
            bidi_level: 0,
            rtl: false,
            glyphs,
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
            origin_y: 0.0,
            width: 10.0,
            ascent: 16.0,
            descent: 4.0,
            baseline: 16.0,
        }]),
        logical_to_visual: Arc::from([0]),
        visual_to_logical: Arc::from([0]),
        tiles: Arc::from([TileCoverage {
            tile: TileId(1),
            clip: Rect::new(0.0, 0.0, 400.0, 240.0),
        }]),
        spatial_node: SpatialNodeId(0),
        clip_chain: neotavern_neocompositor::ClipChainId(0),
        effect_node: neotavern_neocompositor::EffectNodeId(0),
        backdrop_root: neotavern_neocompositor::BackdropRootId(0),
    }
}

#[test]
fn refresh_transition_keeps_animation_distance() {
    let mut builder = PropertyTreeBuilder::new();
    let node = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let spec = AnimationSpec {
        property: AnimationProperty::Translation(node),
        from: Some(AnimValue::Translation(Vec2::new(0.0, 0.0))),
        to: AnimValue::Translation(Vec2::new(120.0, 0.0)),
        duration: Duration::from_millis(1000),
        easing: Easing::Linear,
    };
    let mut values = Vec::new();
    for hz in [60u64, 120, 90] {
        let mut path = CompositorFastPath::new();
        path.bind_snapshot(Arc::clone(&snapshot));
        let adapter = PlatformInputAdapter::new();
        let id = path
            .start_animation(spec, PresentationTime::from_nanos(0))
            .unwrap();
        let step = 1_000_000_000 / hz;
        let mut t = 0;
        while t < 500_000_000 {
            t += step;
            adapter.on_vsync(t.min(500_000_000));
            path.present(adapter.presentation_time());
        }
        match path.animation_value(id, presentation_time_from_vsync(500_000_000)) {
            Some(AnimValue::Translation(v)) => values.push(v.x),
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!((values[0] - values[1]).abs() < 1e-6);
    assert!((values[1] - values[2]).abs() < 1e-6);
}

#[test]
fn focus_loss_and_surface_recreate_synthesize_cancel() {
    let scene = chat_scene(SceneEpoch(1));
    let mut path = bind_chat(&scene);
    let adapter = PlatformInputAdapter::new();
    adapter.try_push(sample(PlatformPointerKind::Down, 4, 50.0, 640.0, 0));
    adapter.drain(&mut path).unwrap();
    assert!(path.captured_target().is_some());
    adapter.lose_focus(8_000_000);
    adapter.drain(&mut path).unwrap();
    assert!(path.captured_target().is_none());
    adapter.try_push(sample(PlatformPointerKind::Down, 4, 50.0, 640.0, 9_000_000));
    adapter.drain(&mut path).unwrap();
    adapter.recreate_surface(10_000_000);
    adapter.drain(&mut path).unwrap();
    assert!(path.captured_target().is_none());
    assert!(adapter.stats().cancels_synthesized >= 2);
}

#[test]
fn move_present_does_not_call_producer_or_layout() {
    let scene = chat_scene(SceneEpoch(1));
    let mut path = bind_chat(&scene);
    let adapter = PlatformInputAdapter::new();
    adapter.on_vsync(16_000_000);
    adapter.try_push(sample(PlatformPointerKind::Down, 1, 50.0, 640.0, 0));
    adapter.drain(&mut path).unwrap();
    for i in 0..32 {
        adapter.try_push(sample(
            PlatformPointerKind::Move,
            1,
            50.0,
            640.0 - i as f32,
            1_000_000 * (i + 1),
        ));
        adapter.on_vsync(16_000_000 * (i + 2));
        adapter.drain(&mut path).unwrap();
    }
    assert_eq!(path.producer_requests(), 0);
    assert_eq!(adapter.stats().layout_callbacks, 0);
    assert_eq!(adapter.stats().producer_callbacks, 0);
}

#[test]
fn steady_state_after_warmup_does_not_grow_sampled_storage() {
    let scene = chat_scene(SceneEpoch(1));
    let mut path = bind_chat(&scene);
    let adapter = PlatformInputAdapter::new();
    push_down_move_up(&adapter, 1, 50.0, 640.0);
    adapter.drain(&mut path).unwrap();
    adapter.try_push(sample(PlatformPointerKind::Down, 1, 50.0, 640.0, 3_000_000));
    adapter.drain(&mut path).unwrap();
    let ptr_before = path.sampled().unwrap().worlds_ptr();
    let cap = path.sampled().unwrap().worlds_capacity();
    for i in 0..64u64 {
        adapter.try_push(sample(
            PlatformPointerKind::Move,
            1,
            50.0,
            640.0 - i as f32,
            4_000_000 + i,
        ));
        adapter.drain(&mut path).unwrap();
    }
    assert_eq!(path.sampled().unwrap().worlds_ptr(), ptr_before);
    assert_eq!(path.sampled().unwrap().worlds_capacity(), cap);
}

#[test]
fn device_epoch_bump_does_not_kill_gesture() {
    let scene = chat_scene(SceneEpoch(1));
    let mut path = bind_chat(&scene);
    let adapter = PlatformInputAdapter::new();
    adapter.try_push(sample(PlatformPointerKind::Down, 1, 50.0, 640.0, 0));
    adapter.drain(&mut path).unwrap();
    adapter.note_device_epoch(DeviceEpoch(1));
    adapter.try_push(sample(
        PlatformPointerKind::Move,
        1,
        50.0,
        600.0,
        16_000_000,
    ));
    adapter.drain(&mut path).unwrap();
    assert_eq!(path.captured_target(), Some(StableSemanticId(10)));
    assert_eq!(adapter.device_epoch(), DeviceEpoch(1));
}

#[test]
fn scene_epoch_revalidates_live_target() {
    let first = chat_scene(SceneEpoch(1));
    let mut path = bind_chat(&first);
    let adapter = PlatformInputAdapter::new();
    adapter.try_push(sample(PlatformPointerKind::Down, 1, 50.0, 640.0, 0));
    adapter.drain(&mut path).unwrap();
    let second = chat_scene(SceneEpoch(2));
    path.bind_snapshot(Arc::clone(&second.snapshot));
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(
        SceneEpoch(2),
        chat_items(&second),
    )))
    .unwrap();
    adapter.try_push(sample(
        PlatformPointerKind::Move,
        1,
        50.0,
        620.0,
        16_000_000,
    ));
    adapter.drain(&mut path).unwrap();
    assert_eq!(path.captured_target(), Some(StableSemanticId(10)));
}

#[test]
fn ui_thread_does_not_wait_on_locked_queue() {
    let adapter = PlatformInputAdapter::new();
    adapter.hold_queue(|| {
        let start = Instant::now();
        let result = adapter.try_push(sample(PlatformPointerKind::Move, 1, 1.0, 1.0, 1));
        assert_eq!(result, InputPush::Contended);
        assert!(start.elapsed() < Duration::from_millis(20));
        let edge = adapter.try_push(sample(PlatformPointerKind::Down, 2, 2.0, 2.0, 2));
        assert!(matches!(edge, InputPush::Queued | InputPush::Contended));
        assert!(start.elapsed() < Duration::from_millis(20));
    });
}

#[test]
fn cancel_action_covers_all_pointers() {
    let ids = [3, 8];
    let xs = [1.0, 2.0];
    let ys = [3.0, 4.0];
    let event = AndroidMotionView {
        action: ANDROID_ACTION_CANCEL,
        pointer_count: 2,
        event_time_nanos: 9,
        pointer_ids: &ids,
        x: &xs,
        y: &ys,
        history_times_nanos: &[],
        history_x: &[],
        history_y: &[],
    };
    let mut out = [sample(PlatformPointerKind::Move, 0, 0.0, 0.0, 0); 4];
    let n = expand_android_motion(&event, &mut out);
    assert_eq!(n, 2);
    assert_eq!(out[0].kind, PlatformPointerKind::Cancel);
    assert_eq!(out[0].pointer, PointerId(3));
    assert_eq!(out[1].pointer, PointerId(8));
}

#[test]
fn down_up_actions_use_event_time_nanos() {
    let ids = [9];
    let xs = [4.0];
    let ys = [5.0];
    let down = AndroidMotionView {
        action: ANDROID_ACTION_DOWN,
        pointer_count: 1,
        event_time_nanos: 77,
        pointer_ids: &ids,
        x: &xs,
        y: &ys,
        history_times_nanos: &[],
        history_x: &[],
        history_y: &[],
    };
    let up = AndroidMotionView {
        action: ANDROID_ACTION_UP,
        pointer_count: 1,
        event_time_nanos: 88,
        pointer_ids: &ids,
        x: &xs,
        y: &ys,
        history_times_nanos: &[],
        history_x: &[],
        history_y: &[],
    };
    let mut out = [sample(PlatformPointerKind::Move, 0, 0.0, 0.0, 0); 2];
    assert_eq!(expand_android_motion(&down, &mut out), 1);
    assert_eq!(out[0].time_nanos, 77);
    assert_eq!(expand_android_motion(&up, &mut out), 1);
    assert_eq!(out[0].kind, PlatformPointerKind::Up);
}
