use neotavern_neocompositor::{
    apply_autoscroll, autoscroll_delta, clip_to_tile, compile_passes, AffineCoeffs, BackdropRootId,
    BarrierId, ClipChainId, ClusterBoundary, CompiledPass, CompositorFastPath, EffectNodeId,
    GeometryTile, GeometryTileSnapshot, GlassBoundary, HandleKind, LineMetric, LogicalRect,
    NeoDisplayList, NeoPaintOp, PaintChunk, PaintChunkId, PaintOrderKey, Point, PresentationTime,
    ProducerGlyph, ProducerTextWork, PropertyTreeBuilder, RasterDecision, Rect, SceneEpoch,
    ScrollSequence, SelectablePaintPlan, SelectionError, SelectionSession, ShapedRunRef,
    SpatialKind, SpatialNodeId, StableSemanticId, StubPayload, TextFragmentId,
    TextInteractionSnapshot, TextOffset, TextRange, TextSnapshotSet, TileCoverage, TileId,
    TileKind,
};
use std::sync::Arc;

fn ms(v: u64) -> PresentationTime {
    PresentationTime::from_millis(v)
}

fn viewport() -> Rect {
    Rect::new(0.0, 0.0, 400.0, 240.0)
}

fn background() -> PaintChunk {
    PaintChunk {
        id: PaintChunkId(1),
        generation: 1,
        paint_order: PaintOrderKey(1),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
        bounds: Rect::new(0.0, 0.0, 400.0, 240.0),
        payload: StubPayload::Wallpaper,
    }
}

fn plan() -> SelectablePaintPlan {
    let mut plan = SelectablePaintPlan::plain(background(), viewport());
    plan.underline = true;
    plan.strike = true;
    plan.syntax = true;
    plan
}

fn producer_fragment(
    epoch: SceneEpoch,
    id: TextFragmentId,
    work: &mut ProducerTextWork,
) -> TextInteractionSnapshot {
    work.record_publish();
    let glyphs = |items: &[(u32, u32, f32, f32, f32, bool)]| {
        items
            .iter()
            .map(|(gid, cluster, x, y, adv, emoji)| ProducerGlyph {
                glyph_id: *gid,
                cluster: TextOffset(*cluster),
                x: *x,
                y: *y,
                advance: *adv,
                font_key: 1,
                color_emoji: *emoji,
            })
            .collect::<Vec<_>>()
    };
    let ltr = ShapedRunRef {
        run_id: 1,
        logical: TextRange::new(0, 5),
        visual_order: 0,
        bidi_level: 0,
        rtl: false,
        glyphs: glyphs(&[
            (10, 0, 0.0, 0.0, 10.0, false),
            (11, 1, 10.0, 0.0, 10.0, false),
            (12, 2, 20.0, 0.0, 10.0, false),
            (13, 3, 30.0, 0.0, 10.0, false),
            (14, 4, 40.0, 0.0, 10.0, false),
        ])
        .into(),
    };
    let rtl = ShapedRunRef {
        run_id: 2,
        logical: TextRange::new(5, 7),
        visual_order: 1,
        bidi_level: 1,
        rtl: true,
        glyphs: glyphs(&[
            (20, 6, 60.0, 0.0, 10.0, false),
            (21, 5, 70.0, 0.0, 10.0, false),
        ])
        .into(),
    };
    let liga = ShapedRunRef {
        run_id: 3,
        logical: TextRange::new(7, 9),
        visual_order: 2,
        bidi_level: 0,
        rtl: false,
        glyphs: glyphs(&[(30, 7, 0.0, 80.0, 16.0, false)]).into(),
    };
    let combining = ShapedRunRef {
        run_id: 4,
        logical: TextRange::new(9, 11),
        visual_order: 3,
        bidi_level: 0,
        rtl: false,
        glyphs: glyphs(&[
            (40, 9, 20.0, 80.0, 10.0, false),
            (41, 10, 20.0, 80.0, 0.0, false),
        ])
        .into(),
    };
    let emoji = ShapedRunRef {
        run_id: 5,
        logical: TextRange::new(11, 12),
        visual_order: 4,
        bidi_level: 0,
        rtl: false,
        glyphs: glyphs(&[(50, 11, 0.0, 160.0, 20.0, true)]).into(),
    };
    TextInteractionSnapshot {
        scene_epoch: epoch,
        generation: id.generation(),
        fragment_id: id,
        semantic: StableSemanticId(7),
        logical_range: TextRange::new(0, 12),
        shaped_runs: Arc::from([ltr, rtl, liga, combining, emoji]),
        cluster_map: Arc::from([
            ClusterBoundary {
                logical: TextRange::new(0, 1),
                caret_stop: true,
                ligature: false,
                combining: false,
            },
            ClusterBoundary {
                logical: TextRange::new(1, 2),
                caret_stop: true,
                ligature: false,
                combining: false,
            },
            ClusterBoundary {
                logical: TextRange::new(2, 3),
                caret_stop: true,
                ligature: false,
                combining: false,
            },
            ClusterBoundary {
                logical: TextRange::new(3, 4),
                caret_stop: true,
                ligature: false,
                combining: false,
            },
            ClusterBoundary {
                logical: TextRange::new(4, 5),
                caret_stop: true,
                ligature: false,
                combining: false,
            },
            ClusterBoundary {
                logical: TextRange::new(5, 6),
                caret_stop: true,
                ligature: false,
                combining: false,
            },
            ClusterBoundary {
                logical: TextRange::new(6, 7),
                caret_stop: true,
                ligature: false,
                combining: false,
            },
            ClusterBoundary {
                logical: TextRange::new(7, 9),
                caret_stop: true,
                ligature: true,
                combining: false,
            },
            ClusterBoundary {
                logical: TextRange::new(9, 11),
                caret_stop: true,
                ligature: false,
                combining: true,
            },
            ClusterBoundary {
                logical: TextRange::new(10, 11),
                caret_stop: false,
                ligature: false,
                combining: true,
            },
            ClusterBoundary {
                logical: TextRange::new(11, 12),
                caret_stop: true,
                ligature: false,
                combining: false,
            },
        ]),
        line_metrics: Arc::from([
            LineMetric {
                logical: TextRange::new(0, 7),
                origin_x: 0.0,
                origin_y: 16.0,
                width: 80.0,
                ascent: 16.0,
                descent: 4.0,
                baseline: 16.0,
            },
            LineMetric {
                logical: TextRange::new(7, 11),
                origin_x: 0.0,
                origin_y: 96.0,
                width: 40.0,
                ascent: 16.0,
                descent: 4.0,
                baseline: 96.0,
            },
            LineMetric {
                logical: TextRange::new(11, 12),
                origin_x: 0.0,
                origin_y: 176.0,
                width: 20.0,
                ascent: 16.0,
                descent: 4.0,
                baseline: 176.0,
            },
        ]),
        logical_to_visual: Arc::from([0, 1, 2, 3, 4, 6, 5, 7, 8, 9, 10]),
        visual_to_logical: Arc::from([0, 1, 2, 3, 4, 6, 5, 7, 8, 9, 10]),
        tiles: Arc::from([
            TileCoverage {
                tile: TileId(1),
                clip: Rect::new(0.0, 0.0, 400.0, 80.0),
            },
            TileCoverage {
                tile: TileId(2),
                clip: Rect::new(0.0, 80.0, 400.0, 80.0),
            },
            TileCoverage {
                tile: TileId(3),
                clip: Rect::new(0.0, 160.0, 400.0, 80.0),
            },
        ]),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
    }
}

fn three_tiles(epoch: SceneEpoch) -> GeometryTileSnapshot {
    GeometryTileSnapshot::commit(
        epoch,
        vec![
            GeometryTile {
                id: TileId(1),
                bounds: Rect::new(0.0, 0.0, 400.0, 80.0),
                generation: 1,
                kind: TileKind::Prepared,
            },
            GeometryTile {
                id: TileId(2),
                bounds: Rect::new(0.0, 80.0, 400.0, 80.0),
                generation: 1,
                kind: TileKind::Prepared,
            },
            GeometryTile {
                id: TileId(3),
                bounds: Rect::new(0.0, 160.0, 400.0, 80.0),
                generation: 1,
                kind: TileKind::Prepared,
            },
        ],
    )
}

fn replaced_tiles(epoch: SceneEpoch) -> GeometryTileSnapshot {
    GeometryTileSnapshot::commit(
        epoch,
        vec![
            GeometryTile {
                id: TileId(11),
                bounds: Rect::new(0.0, 0.0, 400.0, 80.0),
                generation: 2,
                kind: TileKind::Prepared,
            },
            GeometryTile {
                id: TileId(12),
                bounds: Rect::new(0.0, 80.0, 400.0, 80.0),
                generation: 2,
                kind: TileKind::Prepared,
            },
            GeometryTile {
                id: TileId(13),
                bounds: Rect::new(0.0, 160.0, 400.0, 80.0),
                generation: 2,
                kind: TileKind::Prepared,
            },
        ],
    )
}

fn payloads(ops: &[NeoPaintOp]) -> Vec<StubPayload> {
    ops.iter()
        .filter_map(|op| match op {
            NeoPaintOp::PaintChunk(chunk) => Some(chunk.payload),
            _ => None,
        })
        .collect()
}

fn selection_rects(ops: &[NeoPaintOp]) -> Vec<Rect> {
    ops.iter()
        .find_map(|op| match op {
            NeoPaintOp::Selection(selection) => Some(selection.rects.to_vec()),
            _ => None,
        })
        .unwrap_or_default()
}

fn static_chunks(ops: &[NeoPaintOp]) -> Vec<(PaintChunkId, u64, StubPayload)> {
    ops.iter()
        .filter_map(|op| match op {
            NeoPaintOp::PaintChunk(chunk) => Some((chunk.id, chunk.generation, chunk.payload)),
            _ => None,
        })
        .collect()
}

#[test]
fn paint_order_is_background_selection_glyphs_decorations_caret_handles() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let geometry = three_tiles(SceneEpoch(1));
    let frame = neotavern_neocompositor::compose_selectable(
        &fragment,
        &geometry,
        &plan(),
        TextRange::new(0, 12),
        Some(TextOffset(12)),
    )
    .unwrap();
    let kinds: Vec<_> = frame
        .ops
        .iter()
        .map(|op| match op {
            NeoPaintOp::PaintChunk(chunk) => match chunk.payload {
                StubPayload::Wallpaper => "background",
                StubPayload::TransparentGlyphs => "glyphs",
                StubPayload::ColorEmoji => "emoji",
                StubPayload::SyntaxGlyphs => "syntax",
                StubPayload::Decoration => "decoration",
                other => panic!("unexpected payload {other:?}"),
            },
            NeoPaintOp::TextFragment(_) => "text",
            NeoPaintOp::Selection(_) => "selection",
            NeoPaintOp::Caret(_) => "caret",
            NeoPaintOp::Handle(handle) if handle.kind == HandleKind::Start => "handle-start",
            NeoPaintOp::Handle(_) => "handle-end",
            other => panic!("unexpected op {other:?}"),
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "background",
            "text",
            "selection",
            "glyphs",
            "emoji",
            "syntax",
            "decoration",
            "caret",
            "handle-start",
            "handle-end",
        ]
    );
    let passes = compile_passes(&NeoDisplayList {
        generation: 1,
        width: 400,
        height: 240,
        spatial: Arc::from([]),
        clips: Arc::from([]),
        effects: Arc::from([]),
        ops: frame.ops.clone().into(),
    })
    .unwrap();
    let raster_payloads: Vec<Vec<StubPayload>> = passes
        .iter()
        .filter_map(|pass| match pass {
            CompiledPass::Raster { chunks, .. } => {
                Some(chunks.iter().map(|chunk| chunk.payload).collect())
            }
            _ => None,
        })
        .collect();
    assert!(raster_payloads
        .iter()
        .all(|chunks| !(chunks.contains(&StubPayload::Wallpaper)
            && chunks.iter().any(|payload| matches!(
                payload,
                StubPayload::TransparentGlyphs | StubPayload::ColorEmoji
            )))));
    assert!(passes.iter().any(|pass| matches!(
        pass,
        CompiledPass::Interaction {
            kind: neotavern_neocompositor::InteractionPassKind::Selection,
            ..
        }
    )));
}

#[test]
fn fragment_spans_three_tiles_without_seams() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let geometry = three_tiles(SceneEpoch(1));
    let frame = neotavern_neocompositor::compose_selectable(
        &fragment,
        &geometry,
        &plan(),
        TextRange::new(0, 12),
        Some(TextOffset(12)),
    )
    .unwrap();
    let rects = selection_rects(&frame.ops);
    assert!(rects.len() >= 3);
    let mut ys: Vec<(f32, f32)> = rects.iter().map(|rect| (rect.y, rect.y1())).collect();
    ys.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    for window in ys.windows(2) {
        if (window[0].1 - window[1].0).abs() <= 0.5 {
            assert_eq!(window[0].1, window[1].0);
        }
    }
    let span = Rect::new(0.0, 0.0, 400.0, 240.0);
    let a = clip_to_tile(span, Rect::new(0.0, 0.0, 400.0, 80.0)).unwrap();
    let b = clip_to_tile(span, Rect::new(0.0, 80.0, 400.0, 80.0)).unwrap();
    assert_eq!(a.y1(), b.y);
    assert!(a.intersect(b).is_none());
}

#[test]
fn bidi_selection_uses_logical_range_not_visual_order() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let geometry = three_tiles(SceneEpoch(1));
    let visual_first = fragment.logical_copy_range(TextOffset(6), TextOffset(5));
    assert_eq!(visual_first, TextRange::new(5, 6));
    let frame = neotavern_neocompositor::compose_selectable(
        &fragment,
        &geometry,
        &plan(),
        visual_first,
        Some(TextOffset(6)),
    )
    .unwrap();
    let rects = selection_rects(&frame.ops);
    assert_eq!(rects.len(), 1);
    assert!((rects[0].x - 70.0).abs() < 0.5, "logical 5 is visual x=70");
}

#[test]
fn ligature_and_combining_marks_keep_caret_stops() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let geometry = three_tiles(SceneEpoch(1));
    let liga = neotavern_neocompositor::compose_selectable(
        &fragment,
        &geometry,
        &plan(),
        TextRange::new(7, 9),
        Some(TextOffset(7)),
    )
    .unwrap();
    let liga_rects = selection_rects(&liga.ops);
    assert_eq!(liga_rects.len(), 1);
    assert!((liga_rects[0].width - 16.0).abs() < 0.5);
    let combining = neotavern_neocompositor::compose_selectable(
        &fragment,
        &geometry,
        &plan(),
        TextRange::new(9, 11),
        Some(TextOffset(9)),
    )
    .unwrap();
    assert_eq!(selection_rects(&combining.ops).len(), 1);
}

#[test]
fn color_emoji_and_syntax_do_not_use_blend_mode() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let geometry = three_tiles(SceneEpoch(1));
    let frame = neotavern_neocompositor::compose_selectable(
        &fragment,
        &geometry,
        &plan(),
        TextRange::new(0, 12),
        Some(TextOffset(12)),
    )
    .unwrap();
    let payload = payloads(&frame.ops);
    assert!(payload.contains(&StubPayload::ColorEmoji));
    assert!(payload.contains(&StubPayload::SyntaxGlyphs));
    assert!(payload.contains(&StubPayload::Decoration));
    let selection_idx = frame
        .ops
        .iter()
        .position(|op| matches!(op, NeoPaintOp::Selection(_)))
        .unwrap();
    let emoji_idx = frame
        .ops
        .iter()
        .position(|op| matches!(op, NeoPaintOp::PaintChunk(chunk) if chunk.payload == StubPayload::ColorEmoji))
        .unwrap();
    let syntax_idx = frame
        .ops
        .iter()
        .position(|op| matches!(op, NeoPaintOp::PaintChunk(chunk) if chunk.payload == StubPayload::SyntaxGlyphs))
        .unwrap();
    assert!(selection_idx < emoji_idx);
    assert!(selection_idx < syntax_idx);
    assert!(!payload.contains(&StubPayload::Overlay));
}

#[test]
fn drag_forward_and_back_unions_old_and_new_damage() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let geometry = three_tiles(SceneEpoch(1));
    let mut session = SelectionSession::begin(&fragment, 5.0, 10.0).unwrap();
    let forward = session
        .drag(
            &fragment,
            &geometry,
            &plan(),
            45.0,
            10.0,
            Some(Point::new(45.0, 10.0)),
        )
        .unwrap();
    assert_eq!(forward.raster, RasterDecision::SelectionOnly);
    assert!(forward.logical_range.end.0 > forward.logical_range.start.0);
    let back = session
        .drag(
            &fragment,
            &geometry,
            &plan(),
            15.0,
            10.0,
            Some(Point::new(15.0, 10.0)),
        )
        .unwrap();
    assert!(back.logical_range.len() < forward.logical_range.len());
    assert_eq!(back.damage.len(), 1);
    assert!(
        back.damage[0].width >= forward.damage[0].width || back.damage[0].x <= forward.damage[0].x
    );
}

#[test]
fn drag_does_not_shape_layout_or_invalidate_rasters() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let geometry = three_tiles(SceneEpoch(1));
    let before = work;
    let mut path = CompositorFastPath::new();
    let mut builder = PropertyTreeBuilder::new();
    let _root = builder.alloc_spatial(None, AffineCoeffs::IDENTITY, SpatialKind::ReferenceFrame);
    path.bind_snapshot(Arc::new(builder.commit(SceneEpoch(1)).unwrap()));
    path.present(ms(0));
    let rasters_before = path.raster_invalidations();
    let mut session = SelectionSession::begin(&fragment, 5.0, 10.0).unwrap();
    let first = session
        .drag(&fragment, &geometry, &plan(), 45.0, 10.0, None)
        .unwrap();
    let second = session
        .drag(&fragment, &geometry, &plan(), 25.0, 10.0, None)
        .unwrap();
    assert_eq!(work, before);
    assert_eq!(path.raster_invalidations(), rasters_before);
    assert_eq!(path.producer_requests(), 0);
    assert_eq!(static_chunks(&first.ops), static_chunks(&second.ops));
    assert_eq!(first.raster, RasterDecision::SelectionOnly);
}

#[test]
fn autoscroll_nudges_existing_scroll_id() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let geometry = three_tiles(SceneEpoch(1));
    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, AffineCoeffs::IDENTITY, SpatialKind::ReferenceFrame);
    let _scroll_node = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::IDENTITY,
        SpatialKind::Scroll {
            scroll_id: scroll,
            scrollport: LogicalRect::new(0.0, 0.0, 400.0, 240.0),
            content_extent: LogicalRect::new(0.0, 0.0, 400.0, 2000.0),
        },
    );
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(Arc::clone(&snapshot));
    path.present(ms(0));
    let mut session = SelectionSession::begin(&fragment, 5.0, 10.0).unwrap();
    let frame = session
        .drag(
            &fragment,
            &geometry,
            &plan(),
            10.0,
            170.0,
            Some(Point::new(10.0, 230.0)),
        )
        .unwrap();
    let delta = frame.autoscroll.expect("edge autoscroll");
    assert!(delta.y > 0.0);
    let unused = apply_autoscroll(&mut path, scroll, delta, ScrollSequence(1), ms(16)).unwrap();
    let _ = unused;
    path.present(ms(16));
    assert!(path.visual_offset(scroll).unwrap().y > 0.0);
    let caret = frame
        .ops
        .iter()
        .find_map(|op| match op {
            NeoPaintOp::Caret(caret) => Some(caret),
            _ => None,
        })
        .unwrap();
    assert_eq!(caret.spatial_node, fragment.spatial_node);
    assert_eq!(path.snapshot().unwrap().scene_epoch(), SceneEpoch(1));
    assert_eq!(
        autoscroll_delta(viewport(), 10.0, 230.0).unwrap().y,
        delta.y
    );
}

#[test]
fn tile_replacement_during_selection_keeps_logical_range() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let before = work;
    let mut session = SelectionSession::begin(&fragment, 5.0, 10.0).unwrap();
    let first = session
        .drag(
            &fragment,
            &three_tiles(SceneEpoch(1)),
            &plan(),
            45.0,
            90.0,
            None,
        )
        .unwrap();
    let replaced = session
        .drag(
            &fragment,
            &replaced_tiles(SceneEpoch(1)),
            &plan(),
            45.0,
            90.0,
            None,
        )
        .unwrap();
    assert_eq!(first.logical_range, replaced.logical_range);
    assert_eq!(work, before);
    assert!(!selection_rects(&replaced.ops).is_empty());
}

#[test]
fn stale_or_recycled_snapshot_cancels_instead_of_other_message() {
    let mut work = ProducerTextWork::default();
    let live = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let mut neighbor = producer_fragment(SceneEpoch(1), TextFragmentId::new(2, 1), &mut work);
    neighbor.semantic = StableSemanticId(99);
    let mut session = SelectionSession::begin(&live, 5.0, 10.0).unwrap();
    let recycled = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 2), &mut work);
    assert_eq!(
        session.drag(
            &recycled,
            &three_tiles(SceneEpoch(1)),
            &plan(),
            10.0,
            10.0,
            None
        ),
        Err(SelectionError::RecycledTarget)
    );
    let set = TextSnapshotSet::commit(SceneEpoch(1), vec![recycled, neighbor]).unwrap();
    assert_eq!(
        session.rebind_text(&set),
        Err(SelectionError::RecycledTarget)
    );
    assert_ne!(session.semantic(), StableSemanticId(99));
}

#[test]
fn fallback_tile_without_snapshot_is_not_a_text_target() {
    let geometry = GeometryTileSnapshot::commit(
        SceneEpoch(1),
        vec![GeometryTile {
            id: TileId(9),
            bounds: Rect::new(0.0, 0.0, 400.0, 80.0),
            generation: 1,
            kind: TileKind::Fallback,
        }],
    );
    let text = TextSnapshotSet::empty(SceneEpoch(1));
    assert_eq!(
        SelectionSession::try_begin_on_tile(&text, &geometry, TileId(9), 10.0, 10.0),
        Err(SelectionError::FallbackWithoutSnapshot)
    );
}

#[test]
fn transformed_and_clipped_text_stays_inside_clip() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let mut clipped = plan();
    clipped.extra_clip = Some(Rect::new(0.0, 0.0, 400.0, 80.0));
    clipped.transform = AffineCoeffs::scale(2.0, 2.0);
    let frame = neotavern_neocompositor::compose_selectable(
        &fragment,
        &three_tiles(SceneEpoch(1)),
        &clipped,
        TextRange::new(0, 12),
        Some(TextOffset(4)),
    )
    .unwrap();
    let rects = selection_rects(&frame.ops);
    assert!(!rects.is_empty());
    for rect in &rects {
        assert!(rect.y1() <= 80.0 + 0.5);
        assert!(rect.x >= 0.0);
    }
}

#[test]
fn selection_under_glass_invalidates_dependent_roi() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let mut with_glass = plan();
    with_glass.under_subsequent_glass = Some(GlassBoundary {
        id: BarrierId(1),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
        roi: Rect::new(0.0, 0.0, 400.0, 80.0),
    });
    let frame = neotavern_neocompositor::compose_selectable(
        &fragment,
        &three_tiles(SceneEpoch(1)),
        &with_glass,
        TextRange::new(0, 5),
        Some(TextOffset(5)),
    )
    .unwrap();
    assert!(!frame.glass_roi_invalidations.is_empty());
    let mut miss = plan();
    miss.under_subsequent_glass = Some(GlassBoundary {
        id: BarrierId(1),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
        roi: Rect::new(0.0, 200.0, 400.0, 40.0),
    });
    let skipped = neotavern_neocompositor::compose_selectable(
        &fragment,
        &three_tiles(SceneEpoch(1)),
        &miss,
        TextRange::new(0, 5),
        Some(TextOffset(5)),
    )
    .unwrap();
    assert!(skipped.glass_roi_invalidations.is_empty());
}
