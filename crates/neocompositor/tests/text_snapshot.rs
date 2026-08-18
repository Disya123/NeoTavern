use neotavern_neocompositor::{
    AffineCoeffs, BackdropRootId, ClipChainId, ClipId, ClipNode, ClusterBoundary,
    CompositorFastPath, DispatchError, EffectKind, EffectNode, EffectNodeId, EpochClock,
    FrameTransaction, FrameTransactionParts, GeometryTile, GeometryTileSnapshot, HitTestSnapshot,
    LineMetric, LogicalRect, NeoDisplayList, NeoPaintOp, NeoScene, PaintChunk, PaintChunkId,
    PaintOrderKey, Point, PointerId, PointerKind, PresentationTime, ProducerGlyph,
    ProducerTextWork, PropertyTreeBuilder, Rect, SceneEpoch, ShapedRunRef, SpatialKind,
    SpatialNode, SpatialNodeId, StableSemanticId, StubPayload, TextFragmentId,
    TextInteractionSnapshot, TextOffset, TextRange, TextSnapshotSet, TileCoverage, TileId,
    TileKind,
};
use std::sync::Arc;

fn ms(v: u64) -> PresentationTime {
    PresentationTime::from_millis(v)
}

fn identity() -> AffineCoeffs {
    AffineCoeffs::IDENTITY
}

fn empty_scene() -> NeoScene {
    let spatial = Arc::from([SpatialNode {
        id: SpatialNodeId(0),
        parent: None,
        transform: AffineCoeffs::IDENTITY,
    }]);
    let clips = Arc::from([ClipNode {
        id: ClipChainId(0),
        parent: None,
        rect: Rect::new(0.0, 0.0, 400.0, 240.0),
    }]);
    let effects = Arc::from([EffectNode {
        id: EffectNodeId(0),
        parent: None,
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        bounds: Rect::new(0.0, 0.0, 400.0, 240.0),
        kind: EffectKind::Isolation,
        backdrop_root: BackdropRootId(0),
    }]);
    NeoScene::from_display_list(NeoDisplayList {
        generation: 1,
        width: 400,
        height: 240,
        spatial,
        clips,
        effects,
        ops: Arc::from([NeoPaintOp::PaintChunk(PaintChunk {
            id: PaintChunkId(1),
            generation: 1,
            paint_order: PaintOrderKey(1),
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            effect_node: EffectNodeId(0),
            backdrop_root: BackdropRootId(0),
            bounds: Rect::new(0.0, 0.0, 400.0, 80.0),
            payload: StubPayload::Wallpaper,
        })]),
    })
}

/// One selectable fragment covering three tiles: LTR, RTL run, ligature,
/// combining mark, and a color-emoji glyph. Geometry is producer-authored.
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
    // logical: 0..5 "Hello" LTR, 5..7 Arabic RTL, 7..9 ligature "fi", 9..11 e+combining, 11..12 emoji
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

#[test]
fn snapshot_is_immutable_and_bound_to_scene_epoch() {
    let epoch = SceneEpoch(3);
    let mut work = ProducerTextWork::default();
    let id = TextFragmentId::new(1, 4);
    let fragment = producer_fragment(epoch, id, &mut work);
    let set = TextSnapshotSet::commit(epoch, vec![fragment.clone()]).unwrap();
    assert_eq!(set.scene_epoch(), epoch);
    assert_eq!(set.get(id).unwrap().fragment_id, id);
    assert_eq!(set.get(id).unwrap().shaped_runs.len(), 5);
    assert_eq!(fragment.scene_epoch, epoch);
}

#[test]
fn fragment_id_is_generation_safe() {
    let live = TextFragmentId::new(2, 7);
    let recycled = TextFragmentId::new(2, 8);
    assert_ne!(live, recycled);
    assert_eq!(live.index(), recycled.index());
    assert!(!TextFragmentId::unbound(2).is_live());
}

#[test]
fn fragment_crosses_three_tiles_with_bidi_ligature_and_combining() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    assert_eq!(fragment.tiles.len(), 3);
    assert!(fragment.shaped_runs.iter().any(|run| run.rtl));
    assert!(fragment.cluster_map.iter().any(|c| c.ligature));
    assert!(fragment
        .cluster_map
        .iter()
        .any(|c| c.combining && !c.caret_stop));
    assert!(fragment
        .shaped_runs
        .iter()
        .any(|run| run.glyphs.iter().any(|g| g.color_emoji)));
    let liga = fragment.cluster_at(TextOffset(8)).unwrap();
    assert!(liga.ligature);
    assert_eq!(liga.logical, TextRange::new(7, 9));
    assert_eq!(fragment.snap_caret(TextOffset(8)), TextOffset(7));
    assert_eq!(fragment.snap_caret(TextOffset(10)), TextOffset(9));
    assert_eq!(fragment.visual_index(5), Some(6));
    assert_eq!(fragment.logical_index(5), Some(6));
}

#[test]
fn copy_range_is_logical_independent_of_visual_order() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let visual_drag = fragment.logical_copy_range(TextOffset(6), TextOffset(5));
    assert_eq!(visual_drag, TextRange::new(5, 6));
}

#[test]
fn compositor_hit_does_not_shape_or_layout() {
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let before = work;
    let caret = fragment.hit_caret(25.0, 10.0).unwrap();
    assert_eq!(caret, TextOffset(2));
    assert_eq!(work, before);
}

#[test]
fn text_geometry_and_property_snapshots_switch_atomically() {
    let mut clock = EpochClock::new();
    let epoch = clock.next_scene();
    let mut builder = PropertyTreeBuilder::new();
    let _root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let properties = builder.commit(epoch).unwrap();
    let mut work = ProducerTextWork::default();
    let text = TextSnapshotSet::commit(
        epoch,
        vec![producer_fragment(
            epoch,
            TextFragmentId::new(1, 1),
            &mut work,
        )],
    )
    .unwrap();
    let geometry = three_tiles(epoch);
    let tx = FrameTransaction::publish(FrameTransactionParts {
        frame_id: clock.next_frame(),
        scene_epoch: epoch,
        device_epoch: clock.device_epoch(),
        scene: empty_scene(),
        damage: Vec::new(),
        leases: Vec::new(),
        properties,
        geometry,
        text,
    });
    assert!(tx.interaction_epochs_match());
    assert_eq!(tx.text().scene_epoch(), epoch);
    assert_eq!(tx.geometry().scene_epoch(), epoch);
    assert_eq!(tx.properties().scene_epoch(), epoch);
    assert_eq!(tx.geometry().tiles().len(), 3);
}

#[test]
fn mixed_text_epoch_is_rejected() {
    let epoch = SceneEpoch(4);
    let mut work = ProducerTextWork::default();
    let fragment = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    assert!(TextSnapshotSet::commit(epoch, vec![fragment]).is_err());
}

#[test]
fn stale_or_recycled_fragment_cancels_instead_of_selecting_another_message() {
    let mut builder = PropertyTreeBuilder::new();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let clip = builder.alloc_clip(None, root, LogicalRect::new(0.0, 0.0, 400.0, 240.0));
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let mut work = ProducerTextWork::default();
    let live = producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 1), &mut work);
    let neighbor = TextInteractionSnapshot {
        fragment_id: TextFragmentId::new(2, 1),
        semantic: StableSemanticId(99),
        ..producer_fragment(SceneEpoch(1), TextFragmentId::new(2, 1), &mut work)
    };
    let items = vec![
        live.hit_test_item(root, clip, 10),
        neighbor.hit_test_item(root, clip, 5),
    ];
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(Arc::clone(&snapshot));
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(SceneEpoch(1), items)))
        .unwrap();
    path.bind_text(Arc::new(
        TextSnapshotSet::commit(SceneEpoch(1), vec![live.clone(), neighbor.clone()]).unwrap(),
    ))
    .unwrap();
    path.bind_geometry(Arc::new(three_tiles(SceneEpoch(1))))
        .unwrap();
    path.present(ms(0));
    let down = path
        .pointer_down(PointerId(1), Point::new(10.0, 10.0), ms(0))
        .unwrap();
    assert_eq!(down.target, Some(StableSemanticId(7)));
    assert_eq!(down.generation, 1);

    let recycled = TextInteractionSnapshot {
        fragment_id: TextFragmentId::new(1, 2),
        generation: 2,
        semantic: StableSemanticId(7),
        ..producer_fragment(SceneEpoch(1), TextFragmentId::new(1, 2), &mut work)
    };
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(
        SceneEpoch(1),
        vec![
            recycled.hit_test_item(root, clip, 10),
            neighbor.hit_test_item(root, clip, 5),
        ],
    )))
    .unwrap();
    let event = path
        .pointer_move(PointerId(1), Point::new(12.0, 12.0), ms(16))
        .unwrap();
    assert_eq!(event.kind, PointerKind::Cancel);
    assert_eq!(event.target, Some(StableSemanticId(7)));
    assert_ne!(event.target, Some(StableSemanticId(99)));
}

#[test]
fn fallback_tile_without_snapshot_is_not_a_text_target() {
    let epoch = SceneEpoch(1);
    let geometry = GeometryTileSnapshot::commit(
        epoch,
        vec![GeometryTile {
            id: TileId(9),
            bounds: Rect::new(0.0, 0.0, 400.0, 80.0),
            generation: 1,
            kind: TileKind::Fallback,
        }],
    );
    let text = TextSnapshotSet::empty(epoch);
    let mut builder = PropertyTreeBuilder::new();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let _ = builder.commit(epoch).unwrap();
    assert!(text
        .hit_item_for_tile(&geometry, TileId(9), root, ClipId::unbound(0), 1)
        .is_none());
}

#[test]
fn bind_rejects_stale_text_epoch() {
    let mut builder = PropertyTreeBuilder::new();
    let _root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let snapshot = Arc::new(builder.commit(SceneEpoch(2)).unwrap());
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(snapshot);
    let err = path.bind_text(Arc::new(TextSnapshotSet::empty(SceneEpoch(1))));
    assert_eq!(err, Err(DispatchError::StaleEpoch));
}

#[test]
fn mailbox_rejects_stale_text_snapshot_epoch() {
    let mut clock = EpochClock::new();
    let scene_epoch = clock.next_scene();
    let mut work = ProducerTextWork::default();
    let text = TextSnapshotSet::commit(
        SceneEpoch(9),
        vec![producer_fragment(
            SceneEpoch(9),
            TextFragmentId::new(1, 1),
            &mut work,
        )],
    )
    .unwrap();
    let mut builder = PropertyTreeBuilder::new();
    let _root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let tx = FrameTransaction::publish(FrameTransactionParts {
        frame_id: clock.next_frame(),
        scene_epoch,
        device_epoch: clock.device_epoch(),
        scene: empty_scene(),
        damage: Vec::new(),
        leases: Vec::new(),
        properties: builder.commit(scene_epoch).unwrap(),
        geometry: three_tiles(scene_epoch),
        text,
    });
    assert!(!tx.interaction_epochs_match());
    let mailbox = neotavern_neocompositor::FrameMailbox::with_defaults();
    assert_eq!(
        mailbox.post(tx),
        Err(neotavern_neocompositor::PostReject::InvalidGraph)
    );
}

#[allow(dead_code)]
fn unused_rect_for_docs() -> LogicalRect {
    LogicalRect::new(0.0, 0.0, 1.0, 1.0)
}
