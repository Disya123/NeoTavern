//! Producer corpus: Dioxus → Blitz/Parley → TextInteractionSnapshot.
//!
//! Shaping already happened in Blitz. The compositor must not reshape.

use neotavern_neocompositor::{
    BackdropRootId, ClipChainId, CompositionMarkKind, EffectNodeId, InteractionReady, NeoPaintOp,
    PaintChunk, PaintChunkId, PaintOrderKey, RasterDecision, Rect, SelectablePaintPlan,
    SelectionSession, SpatialNodeId, StubPayload, TextOffset,
};
use neotavern_presentation_m0_d2::{
    fallback_without_snapshot_is_not_ready, ime_ops_without_glyph_reraster,
    mixed_epoch_is_rejected, publish_selectable_text,
};

#[test]
fn dioxus_blitz_text_publishes_interaction_snapshot() {
    let published = publish_selectable_text().expect("VirtualDom → Blitz text");
    assert!(
        !published.fragments.is_empty(),
        "host_text_fragment must fire from already-shaped Parley layouts"
    );
    let tx = &published.transaction;
    assert!(tx.interaction_epochs_match());
    assert_eq!(tx.text().scene_epoch(), tx.scene_epoch());
    assert_eq!(tx.geometry().scene_epoch(), tx.scene_epoch());
    assert_eq!(tx.properties().scene_epoch(), tx.scene_epoch());

    let fragment = tx
        .text()
        .fragments()
        .iter()
        .max_by_key(|item| item.tiles.len())
        .expect("fragment");
    assert!(fragment.tiles.len() >= 3, "text spans three tiles");
    assert!(fragment
        .cluster_map
        .iter()
        .any(|cluster| cluster.caret_stop));
    let copy = fragment.logical_copy_range(TextOffset(3), TextOffset(1));
    assert!(copy.start.0 <= copy.end.0);

    let line = &fragment.line_metrics[0];
    let mut session =
        SelectionSession::begin(fragment, line.origin_x + 4.0, line.origin_y).expect("begin");
    let plan = SelectablePaintPlan::plain(
        PaintChunk {
            id: PaintChunkId(1),
            generation: 1,
            paint_order: PaintOrderKey(1),
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            effect_node: EffectNodeId(0),
            backdrop_root: BackdropRootId(0),
            bounds: Rect::new(0.0, 0.0, 240.0, 240.0),
            payload: StubPayload::Wallpaper,
        },
        Rect::new(0.0, 0.0, 240.0, 240.0),
    );
    let drag = session
        .drag(
            fragment,
            tx.geometry(),
            &plan,
            line.origin_x + 48.0,
            line.origin_y,
            None,
        )
        .expect("drag");
    assert_eq!(drag.raster, RasterDecision::SelectionOnly);
    assert_eq!(published.counters.shape_calls, 1);
    assert_eq!(published.counters.layout_rebuilds, 1);
    assert_eq!(published.counters.glyph_rasters, 1);

    let ime = ime_ops_without_glyph_reraster(&published, fragment.logical_range).expect("ime");
    assert!(ime.iter().any(|op| matches!(
        op,
        NeoPaintOp::Composition(mark) if mark.kind == CompositionMarkKind::Background
    )));
}

#[test]
fn missing_snapshot_is_not_an_approximate_hit() {
    assert_eq!(
        fallback_without_snapshot_is_not_ready(),
        InteractionReady::NotInteractionReady
    );
    assert!(mixed_epoch_is_rejected());
}
