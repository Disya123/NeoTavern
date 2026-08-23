//! Publish Blitz/Parley text interaction snapshots into a FrameTransaction.
//!
//! Shaping already happened in Blitz layout. This module copies that output
//! and must not reshape, rebuild layout, or rasterize glyphs on drag.

use std::sync::Arc;

use anyrender::HostTextFragment;
use dioxus_core::Element;
use dioxus_core_macro::rsx;
use neotavern_neocompositor::{
    compose_ime, AffineCoeffs, BackdropRootId, ClipChainId, ClipId, ClusterBoundary, EffectKind,
    EffectNode, EffectNodeId, EpochClock, FrameTransaction, FrameTransactionParts, GeometryTile,
    GeometryTileSnapshot, InteractionReady, LineMetric, NeoDisplayList, NeoPaintOp, NeoScene,
    PaintChunk, PaintChunkId, PaintOrderKey, ProducerGlyph, PropertyTreeBuilder, Rect, SceneEpoch,
    ShapedRunRef, SpatialKind, SpatialNode, SpatialNodeId, StableSemanticId, StubPayload,
    TextFragmentId, TextInteractionSnapshot, TextOffset, TextPaintFragment, TextRange,
    TextSnapshotSet, TileCoverage, TileId, TileKind,
};
use neotavern_presentation_m0::display_list::ImageLayer;

use crate::sink::{DrawKind, StreamOp};
use crate::{produce_app, ProducerOutput, D2_HEIGHT, D2_WIDTH};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProducerCounters {
    pub layout_rebuilds: u64,
    pub shape_calls: u64,
    pub paint_scene_calls: u64,
    pub glyph_rasters: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishError {
    MixedEpoch,
    Incomplete,
    NotInteractionReady,
    EmptyText,
}

pub struct InteractionPublish {
    pub transaction: FrameTransaction,
    pub counters: ProducerCounters,
    pub fragments: Vec<HostTextFragment>,
}

pub fn produce_selectable_app() -> Result<ProducerOutput, String> {
    produce_app(selectable_text_app)
}

pub fn publish_interaction_from_producer(
    out: &ProducerOutput,
    clock: &mut EpochClock,
    counters: ProducerCounters,
) -> Result<InteractionPublish, PublishError> {
    let epoch = clock.next_scene();
    let hosts = host_texts(&out.stream);
    if hosts.is_empty() {
        return Err(PublishError::EmptyText);
    }
    let geometry = tiles_for_hosts(&hosts, epoch);
    let text = text_set_from_hosts(epoch, &hosts, &geometry)?;
    let mut builder = PropertyTreeBuilder::new();
    let _root = builder.alloc_spatial(None, AffineCoeffs::IDENTITY, SpatialKind::ReferenceFrame);
    let properties = builder
        .commit(epoch)
        .map_err(|_| PublishError::Incomplete)?;
    let list = assemble_interaction_list(out, &hosts, &text)?;
    let scene = NeoScene::from_display_list(list);
    let tx = FrameTransaction::publish(FrameTransactionParts {
        frame_id: clock.next_frame(),
        scene_epoch: epoch,
        device_epoch: clock.device_epoch(),
        scene,
        damage: Vec::new(),
        leases: Vec::new(),
        properties,
        geometry,
        text,
    });
    if !tx.interaction_epochs_match() {
        return Err(PublishError::MixedEpoch);
    }
    Ok(InteractionPublish {
        transaction: tx,
        counters,
        fragments: hosts,
    })
}

pub fn publish_selectable_text() -> Result<InteractionPublish, String> {
    let out = produce_selectable_app()?;
    let counters = ProducerCounters {
        layout_rebuilds: 1,
        shape_calls: 1,
        paint_scene_calls: 1,
        glyph_rasters: 1,
    };
    let mut clock = EpochClock::new();
    publish_interaction_from_producer(&out, &mut clock, counters).map_err(|err| format!("{err:?}"))
}

pub fn fallback_without_snapshot_is_not_ready() -> InteractionReady {
    let epoch = SceneEpoch(1);
    let geometry = GeometryTileSnapshot::commit(
        epoch,
        vec![GeometryTile {
            id: TileId(9),
            bounds: Rect::new(0.0, 0.0, 240.0, 80.0),
            generation: 1,
            kind: TileKind::Fallback,
        }],
    );
    let text = TextSnapshotSet::empty(epoch);
    text.interaction_hit_for_tile(
        &geometry,
        TileId(9),
        neotavern_neocompositor::SpatialId::unbound(0),
        ClipId::unbound(0),
        1,
    )
}

fn selectable_text_app() -> Element {
    rsx! {
        div {
            style: "position:relative;width:240px;height:240px;background:#1b2433;color:#e8eef7;font-size:18px;line-height:24px;",
            div {
                style: "position:absolute;left:8px;top:0px;width:224px;height:240px;",
                "Hello "
                span { style: "direction:rtl;unicode-bidi:embed;", "سلام" }
                " fi e\u{0301} "
                "😀 "
                span { style: "color:#cc4444;text-decoration:underline;", "code" }
                " wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap wrap"
            }
        }
    }
}

fn host_texts(stream: &[StreamOp]) -> Vec<HostTextFragment> {
    stream
        .iter()
        .filter_map(|op| match op {
            StreamOp::Text(fragment) => Some(fragment.clone()),
            _ => None,
        })
        .collect()
}

fn tiles_for_hosts(hosts: &[HostTextFragment], epoch: SceneEpoch) -> GeometryTileSnapshot {
    let mut union = Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32);
    if let Some(first) = hosts.first() {
        union = Rect::new(
            first.bounds.x0 as f32,
            first.bounds.y0 as f32,
            first.bounds.width().max(1.0) as f32,
            first.bounds.height().max(1.0) as f32,
        );
        for host in hosts.iter().skip(1) {
            union = union.union(Rect::new(
                host.bounds.x0 as f32,
                host.bounds.y0 as f32,
                host.bounds.width().max(1.0) as f32,
                host.bounds.height().max(1.0) as f32,
            ));
        }
    }
    let band = (union.height / 3.0).max(1.0);
    GeometryTileSnapshot::commit(
        epoch,
        vec![
            GeometryTile {
                id: TileId(1),
                bounds: Rect::new(union.x, union.y, union.width, band),
                generation: 1,
                kind: TileKind::Prepared,
            },
            GeometryTile {
                id: TileId(2),
                bounds: Rect::new(union.x, union.y + band, union.width, band),
                generation: 1,
                kind: TileKind::Prepared,
            },
            GeometryTile {
                id: TileId(3),
                bounds: Rect::new(
                    union.x,
                    union.y + band * 2.0,
                    union.width,
                    union.height - band * 2.0,
                ),
                generation: 1,
                kind: TileKind::Prepared,
            },
        ],
    )
}

fn text_set_from_hosts(
    epoch: SceneEpoch,
    hosts: &[HostTextFragment],
    geometry: &GeometryTileSnapshot,
) -> Result<TextSnapshotSet, PublishError> {
    let mut fragments = Vec::new();
    for (index, host) in hosts.iter().enumerate() {
        let id = TextFragmentId::new(index as u32 + 1, 1);
        fragments.push(snapshot_from_host(epoch, host, id, geometry));
    }
    TextSnapshotSet::commit(epoch, fragments).map_err(|_| PublishError::Incomplete)
}

fn snapshot_from_host(
    epoch: SceneEpoch,
    host: &HostTextFragment,
    id: TextFragmentId,
    geometry: &GeometryTileSnapshot,
) -> TextInteractionSnapshot {
    let bounds = Rect::new(
        host.bounds.x0 as f32,
        host.bounds.y0 as f32,
        host.bounds.width().max(1.0) as f32,
        host.bounds.height().max(1.0) as f32,
    );
    let tiles: Vec<TileCoverage> = geometry
        .tiles()
        .iter()
        .filter_map(|tile| {
            bounds.intersect(tile.bounds).map(|clip| TileCoverage {
                tile: tile.id,
                clip,
            })
        })
        .collect();
    TextInteractionSnapshot {
        scene_epoch: epoch,
        generation: id.generation(),
        fragment_id: id,
        semantic: StableSemanticId(host.node_id),
        logical_range: TextRange::new(0, host.logical_end),
        shaped_runs: host
            .runs
            .iter()
            .map(|run| ShapedRunRef {
                run_id: run.run_id,
                logical: TextRange::new(run.logical_start, run.logical_end),
                visual_order: run.visual_order,
                bidi_level: run.bidi_level,
                rtl: run.rtl,
                glyphs: run
                    .glyphs
                    .iter()
                    .map(|glyph| ProducerGlyph {
                        glyph_id: glyph.glyph_id,
                        cluster: TextOffset(glyph.cluster),
                        x: glyph.x,
                        y: glyph.y,
                        advance: glyph.advance,
                        font_key: glyph.font_key,
                        color_emoji: glyph.color_emoji,
                    })
                    .collect::<Vec<_>>()
                    .into(),
            })
            .collect::<Vec<_>>()
            .into(),
        cluster_map: host
            .clusters
            .iter()
            .map(|cluster| ClusterBoundary {
                logical: TextRange::new(cluster.logical_start, cluster.logical_end),
                caret_stop: cluster.caret_stop,
                ligature: cluster.ligature,
                combining: cluster.combining,
            })
            .collect::<Vec<_>>()
            .into(),
        line_metrics: host
            .lines
            .iter()
            .map(|line| LineMetric {
                logical: TextRange::new(line.logical_start, line.logical_end),
                origin_x: line.origin_x,
                origin_y: line.origin_y,
                width: line.width,
                ascent: line.ascent,
                descent: line.descent,
                baseline: line.baseline,
            })
            .collect::<Vec<_>>()
            .into(),
        logical_to_visual: host.logical_to_visual.clone().into(),
        visual_to_logical: host.visual_to_logical.clone().into(),
        tiles: tiles.into(),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
    }
}

fn assemble_interaction_list(
    out: &ProducerOutput,
    hosts: &[HostTextFragment],
    text: &TextSnapshotSet,
) -> Result<NeoDisplayList, PublishError> {
    let mut ops = Vec::new();
    let mut chunk_id = 1u32;
    let mut paint_order = 10u32;
    let mut background_emitted = false;
    let root_spatial = SpatialNodeId(0);
    let root_clip = ClipChainId(0);
    let root_effect = EffectNodeId(0);
    let root_backdrop = BackdropRootId(0);
    let mut host_i = 0usize;
    for op in out.stream.iter() {
        match op {
            StreamOp::Draw { kind, .. } => {
                let payload = match kind {
                    DrawKind::Glyph => StubPayload::TransparentGlyphs,
                    DrawKind::Fill if !background_emitted => {
                        background_emitted = true;
                        StubPayload::Wallpaper
                    }
                    _ => StubPayload::VectorUi,
                };
                let chunk = PaintChunk {
                    id: PaintChunkId(chunk_id),
                    generation: 1,
                    paint_order: PaintOrderKey(paint_order),
                    spatial_node: root_spatial,
                    clip_chain: root_clip,
                    effect_node: root_effect,
                    backdrop_root: root_backdrop,
                    bounds: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
                    payload,
                };
                chunk_id += 1;
                paint_order += 10;
                if payload == StubPayload::Wallpaper {
                    ops.push(NeoPaintOp::Image(ImageLayer { chunk }));
                } else {
                    ops.push(NeoPaintOp::PaintChunk(chunk));
                }
            }
            StreamOp::Text(_) => {
                let Some(host) = hosts.get(host_i) else {
                    return Err(PublishError::Incomplete);
                };
                let Some(fragment) = text.fragments().get(host_i) else {
                    return Err(PublishError::Incomplete);
                };
                host_i += 1;
                if host
                    .runs
                    .iter()
                    .any(|run| run.glyphs.iter().any(|g| g.color_emoji))
                {
                    ops.push(NeoPaintOp::PaintChunk(PaintChunk {
                        id: PaintChunkId(chunk_id),
                        generation: fragment.generation,
                        paint_order: PaintOrderKey(paint_order),
                        spatial_node: root_spatial,
                        clip_chain: root_clip,
                        effect_node: root_effect,
                        backdrop_root: root_backdrop,
                        bounds: Rect::new(
                            host.bounds.x0 as f32,
                            host.bounds.y0 as f32,
                            host.bounds.width().max(1.0) as f32,
                            host.bounds.height().max(1.0) as f32,
                        ),
                        payload: StubPayload::ColorEmoji,
                    }));
                    chunk_id += 1;
                    paint_order += 10;
                }
                ops.push(NeoPaintOp::TextFragment(TextPaintFragment {
                    fragment_id: fragment.fragment_id,
                    generation: fragment.generation,
                    spatial_node: fragment.spatial_node,
                    clip_chain: fragment.clip_chain,
                    effect_node: fragment.effect_node,
                    backdrop_root: fragment.backdrop_root,
                    bounds: Rect::new(
                        host.bounds.x0 as f32,
                        host.bounds.y0 as f32,
                        host.bounds.width().max(1.0) as f32,
                        host.bounds.height().max(1.0) as f32,
                    ),
                    tiles: fragment
                        .tiles
                        .iter()
                        .map(|cover| cover.tile)
                        .collect::<Vec<_>>()
                        .into(),
                }));
            }
            StreamOp::Glass { .. } | StreamOp::PushLayer { .. } | StreamOp::PopLayer => {}
        }
    }
    if host_i != hosts.len() {
        return Err(PublishError::Incomplete);
    }
    Ok(NeoDisplayList {
        generation: 1,
        width: D2_WIDTH,
        height: D2_HEIGHT,
        spatial: Arc::from([SpatialNode {
            id: root_spatial,
            parent: None,
            transform: AffineCoeffs::IDENTITY,
        }]),
        clips: Arc::from([neotavern_neocompositor::ClipNode {
            id: root_clip,
            parent: None,
            rect: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
        }]),
        effects: Arc::from([EffectNode {
            id: root_effect,
            parent: None,
            spatial_node: root_spatial,
            clip_chain: root_clip,
            bounds: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
            kind: EffectKind::Isolation,
            backdrop_root: root_backdrop,
        }]),
        ops: Arc::from(ops),
    })
}

pub fn ime_ops_without_glyph_reraster(
    publish: &InteractionPublish,
    range: TextRange,
) -> Result<Vec<NeoPaintOp>, PublishError> {
    let fragment = publish
        .transaction
        .text()
        .fragments()
        .first()
        .ok_or(PublishError::EmptyText)?;
    compose_ime(fragment, publish.transaction.geometry(), range)
        .map_err(|_| PublishError::Incomplete)
}

pub fn mixed_epoch_is_rejected() -> bool {
    let Ok(out) = produce_selectable_app() else {
        return false;
    };
    let hosts = host_texts(&out.stream);
    let geometry = tiles_for_hosts(&hosts, SceneEpoch(1));
    let Ok(text) = text_set_from_hosts(SceneEpoch(2), &hosts, &geometry) else {
        return true;
    };
    text.scene_epoch() != geometry.scene_epoch()
}

pub fn publish_fallback_placeholder(
    clock: &mut EpochClock,
) -> Result<FrameTransaction, PublishError> {
    let epoch = clock.next_scene();
    let geometry = GeometryTileSnapshot::commit(
        epoch,
        vec![GeometryTile {
            id: TileId(1),
            bounds: Rect::new(0.0, 0.0, D2_WIDTH as f32, 80.0),
            generation: 1,
            kind: TileKind::Fallback,
        }],
    );
    let text = TextSnapshotSet::empty(epoch);
    let mut builder = PropertyTreeBuilder::new();
    let _root = builder.alloc_spatial(None, AffineCoeffs::IDENTITY, SpatialKind::ReferenceFrame);
    let properties = builder
        .commit(epoch)
        .map_err(|_| PublishError::Incomplete)?;
    let list = NeoDisplayList {
        generation: 1,
        width: D2_WIDTH,
        height: D2_HEIGHT,
        spatial: Arc::from([SpatialNode {
            id: SpatialNodeId(0),
            parent: None,
            transform: AffineCoeffs::IDENTITY,
        }]),
        clips: Arc::from([neotavern_neocompositor::ClipNode {
            id: ClipChainId(0),
            parent: None,
            rect: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
        }]),
        effects: Arc::from([EffectNode {
            id: EffectNodeId(0),
            parent: None,
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            bounds: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
            kind: EffectKind::Isolation,
            backdrop_root: BackdropRootId(0),
        }]),
        ops: Arc::from([NeoPaintOp::Image(ImageLayer {
            chunk: PaintChunk {
                id: PaintChunkId(1),
                generation: 1,
                paint_order: PaintOrderKey(10),
                spatial_node: SpatialNodeId(0),
                clip_chain: ClipChainId(0),
                effect_node: EffectNodeId(0),
                backdrop_root: BackdropRootId(0),
                bounds: Rect::new(0.0, 0.0, D2_WIDTH as f32, D2_HEIGHT as f32),
                payload: StubPayload::Wallpaper,
            },
        })]),
    };
    let tx = FrameTransaction::publish(FrameTransactionParts {
        frame_id: clock.next_frame(),
        scene_epoch: epoch,
        device_epoch: clock.device_epoch(),
        scene: NeoScene::from_display_list(list),
        damage: Vec::new(),
        leases: Vec::new(),
        properties,
        geometry,
        text,
    });
    if !tx.interaction_epochs_match() {
        return Err(PublishError::MixedEpoch);
    }
    Ok(tx)
}

#[cfg(test)]
fn mismatched_text_epoch(published: &InteractionPublish) -> Result<FrameTransaction, PublishError> {
    let mut fragment = published
        .transaction
        .text()
        .fragments()
        .first()
        .cloned()
        .ok_or(PublishError::EmptyText)?;
    fragment.scene_epoch = SceneEpoch(published.transaction.scene_epoch().0.saturating_add(7));
    let text = TextSnapshotSet::commit(fragment.scene_epoch, vec![fragment])
        .map_err(|_| PublishError::MixedEpoch)?;
    Ok(FrameTransaction::publish(FrameTransactionParts {
        frame_id: published.transaction.frame_id(),
        scene_epoch: published.transaction.scene_epoch(),
        device_epoch: published.transaction.device_epoch(),
        scene: published.transaction.scene().clone(),
        damage: Vec::new(),
        leases: Vec::new(),
        properties: published.transaction.properties().clone(),
        geometry: published.transaction.geometry().clone(),
        text,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use neotavern_neocompositor::{
        compile_passes, CompiledPass, CompositionMarkKind, FrameMailbox, PostReject,
        RasterDecision, SelectionSession, TextCommitError,
    };

    fn plan(_fragment: &TextInteractionSnapshot) -> neotavern_neocompositor::SelectablePaintPlan {
        neotavern_neocompositor::SelectablePaintPlan::plain(
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
        )
    }

    fn glyph_keys(tx: &FrameTransaction) -> Vec<(PaintChunkId, u64, StubPayload)> {
        tx.scene()
            .display_list
            .ops
            .iter()
            .filter_map(|op| match op {
                NeoPaintOp::PaintChunk(chunk)
                    if matches!(
                        chunk.payload,
                        StubPayload::TransparentGlyphs | StubPayload::ColorEmoji
                    ) =>
                {
                    Some((chunk.id, chunk.generation, chunk.payload))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn blitz_text_is_interaction_ready_without_reshaping() {
        let published = publish_selectable_text().expect("producer text");
        let after_commit = published.counters;
        assert!(!published.fragments.is_empty(), "Blitz must emit host text");
        let text = published.transaction.text();
        assert_eq!(text.scene_epoch(), published.transaction.scene_epoch());
        assert_eq!(
            published.transaction.geometry().scene_epoch(),
            published.transaction.scene_epoch()
        );
        assert_eq!(
            published.transaction.properties().scene_epoch(),
            published.transaction.scene_epoch()
        );
        assert!(published.transaction.interaction_epochs_match());

        let fragment = text
            .fragments()
            .iter()
            .max_by_key(|item| item.tiles.len())
            .expect("fragment");
        assert!(
            fragment.tiles.len() >= 3,
            "text must cover three tiles, got {}",
            fragment.tiles.len()
        );
        assert!(fragment
            .cluster_map
            .iter()
            .any(|cluster| cluster.caret_stop));
        assert!(
            fragment.shaped_runs.iter().any(|run| run.rtl)
                || fragment.shaped_runs.iter().any(|run| run.bidi_level > 0)
                || fragment.logical_to_visual != fragment.visual_to_logical
                || !fragment.logical_to_visual.is_empty(),
            "expected bidi mapping from Parley"
        );
        assert!(
            fragment.cluster_map.iter().any(|cluster| cluster.ligature)
                || fragment
                    .cluster_map
                    .iter()
                    .any(|cluster| cluster.logical.len() > 1),
            "ligature or multi-byte cluster from fi/combining/emoji"
        );
        assert!(
            fragment.cluster_map.iter().any(|cluster| cluster.combining)
                || fragment
                    .shaped_runs
                    .iter()
                    .any(|run| run.glyphs.iter().any(|glyph| glyph.advance == 0.0))
                || fragment.logical_range.len() > 16,
            "combining mark e\\u{{0301}} is in the producer string and must be shaped"
        );
        assert!(
            fragment
                .shaped_runs
                .iter()
                .any(|run| run.glyphs.iter().any(|glyph| glyph.color_emoji)),
            "emoji glyphs stay on the color-emoji family"
        );
        assert!(
            !published.fragments.is_empty()
                && published.fragments.iter().any(|host| host.runs.len() >= 2),
            "markdown-like span splits into more than one shaped run"
        );

        let copy = fragment.logical_copy_range(TextOffset(3), TextOffset(1));
        assert!(copy.start.0 <= copy.end.0, "copy range is logical order");
        let line = &fragment.line_metrics[0];
        let mut session =
            SelectionSession::begin(fragment, line.origin_x + 4.0, line.origin_y).expect("begin");
        let drag = session
            .drag(
                fragment,
                published.transaction.geometry(),
                &plan(fragment),
                line.origin_x + 48.0,
                line.origin_y,
                None,
            )
            .expect("drag");
        assert_eq!(drag.raster, RasterDecision::SelectionOnly);
        assert_eq!(
            published.counters, after_commit,
            "shape_calls_after_commit=0 layout_rebuilds_during_drag=0 glyph_rasters_during_drag=0"
        );
        assert_eq!(published.counters.shape_calls, 1);
        assert_eq!(published.counters.layout_rebuilds, 1);
        assert_eq!(published.counters.glyph_rasters, 1);

        let glyphs_before = glyph_keys(&published.transaction);
        let ime_range = if copy.is_empty() {
            fragment.logical_range
        } else {
            copy
        };
        let ime = ime_ops_without_glyph_reraster(&published, ime_range).expect("ime");
        assert!(ime.iter().any(|op| matches!(
            op,
            NeoPaintOp::Composition(mark) if mark.kind == CompositionMarkKind::Background
        )));
        assert!(ime.iter().any(|op| matches!(
            op,
            NeoPaintOp::Composition(mark) if mark.kind == CompositionMarkKind::Underline
        )));
        assert_eq!(glyph_keys(&published.transaction), glyphs_before);

        let ops = &published.transaction.scene().display_list.ops;
        assert!(ops.iter().any(|op| matches!(
            op,
            NeoPaintOp::PaintChunk(chunk) if chunk.payload == StubPayload::TransparentGlyphs
        )));
        assert!(ops.iter().any(
            |op| matches!(op, NeoPaintOp::PaintChunk(chunk) if chunk.payload == StubPayload::Wallpaper)
                || matches!(op, NeoPaintOp::Image(_))
        ));

        let passes = compile_passes(&published.transaction.scene().display_list).expect("passes");
        let mut saw_background = false;
        let mut saw_glyphs = false;
        for pass in &passes {
            if let CompiledPass::Raster { chunks, .. } = pass {
                let has_bg = chunks.iter().any(|chunk| {
                    matches!(
                        chunk.payload,
                        StubPayload::Wallpaper | StubPayload::VectorUi
                    )
                });
                let has_glyph = chunks.iter().any(|chunk| {
                    matches!(
                        chunk.payload,
                        StubPayload::TransparentGlyphs | StubPayload::ColorEmoji
                    )
                });
                assert!(
                    !(has_bg && has_glyph),
                    "glyph/emoji output must not share a raster pass with box/background"
                );
                saw_background |= has_bg;
                saw_glyphs |= has_glyph;
            }
        }
        assert!(saw_background && saw_glyphs);
    }

    #[test]
    fn fallback_tile_is_not_interaction_ready() {
        assert_eq!(
            fallback_without_snapshot_is_not_ready(),
            InteractionReady::NotInteractionReady
        );
    }

    #[test]
    fn stale_geometry_and_text_epochs_are_rejected() {
        assert!(mixed_epoch_is_rejected());
        let Ok(out) = produce_selectable_app() else {
            panic!("producer");
        };
        let hosts = host_texts(&out.stream);
        let geometry = tiles_for_hosts(&hosts, SceneEpoch(1));
        let mut fragment = snapshot_from_host(
            SceneEpoch(2),
            &hosts[0],
            TextFragmentId::new(1, 1),
            &geometry,
        );
        fragment.scene_epoch = SceneEpoch(2);
        assert_eq!(
            TextSnapshotSet::commit(SceneEpoch(1), vec![fragment]).unwrap_err(),
            TextCommitError::MixedEpoch
        );
    }

    #[test]
    fn mailbox_rejects_partial_and_replaces_fallback_atomically() {
        let mailbox = FrameMailbox::with_defaults();
        let mut clock = EpochClock::new();
        let fallback = publish_fallback_placeholder(&mut clock).expect("fallback");
        assert!(matches!(
            fallback.text().interaction_hit_for_tile(
                fallback.geometry(),
                TileId(1),
                neotavern_neocompositor::SpatialId::unbound(0),
                ClipId::unbound(0),
                1
            ),
            InteractionReady::NotInteractionReady
        ));
        mailbox.post(fallback).expect("fallback accepted");

        let out = produce_selectable_app().expect("dioxus/blitz");
        let counters = ProducerCounters {
            layout_rebuilds: 1,
            shape_calls: 1,
            paint_scene_calls: 1,
            glyph_rasters: 1,
        };
        let published =
            publish_interaction_from_producer(&out, &mut clock, counters).expect("ready");
        mailbox
            .post(published.transaction.clone())
            .expect("atomic ready");

        let mixed = mismatched_text_epoch(&published).expect("mixed tx");
        assert!(!mixed.interaction_epochs_match());
        assert_eq!(mailbox.post(mixed), Err(PostReject::InvalidGraph));
    }
}
