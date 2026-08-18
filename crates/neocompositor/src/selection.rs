//! Cross-tile selection underlay (RFC §21.2 / §21.3, PERF-19 host).
//!
//! Glyph geometry comes from the bound [`TextInteractionSnapshot`]. This
//! module must not shape Unicode, run layout, rasterize glyphs, or bake
//! highlight into background/glyph tiles. Color emoji and syntax colors
//! never go through a selection blend-mode.

use crate::display_list::{
    AffineCoeffs, CaretPaintOp, GlassBoundary, HandleKind, HandlePaintOp, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SelectionPaintOp, StubPayload, TextPaintFragment,
};
use crate::epoch::{PresentationTime, SceneEpoch};
use crate::fast_path::{CompositorFastPath, RasterDecision};
use crate::geometry_tiles::{GeometryTileSnapshot, TileId};
use crate::property_tree::{Point, ScrollId, Vec2};
use crate::scroll::{ScrollInputError, ScrollSequence};
use crate::text::{
    TextFragmentId, TextInteractionSnapshot, TextOffset, TextRange, TextSnapshotSet,
};
use crate::transaction::DamageRect;

pub const AUTOSCROLL_EDGE_PX: f32 = 24.0;
const HANDLE_SIZE: f32 = 12.0;
const CARET_WIDTH: f32 = 1.0;
const TILE_EDGE_EPS: f32 = 0.5;
const GLYPH_CHUNK: PaintChunkId = PaintChunkId(9001);
const EMOJI_CHUNK: PaintChunkId = PaintChunkId(9002);
const SYNTAX_CHUNK: PaintChunkId = PaintChunkId(9003);
const DECORATION_CHUNK: PaintChunkId = PaintChunkId(9004);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionError {
    StaleFragment,
    StaleEpoch,
    MissingSnapshot,
    FallbackWithoutSnapshot,
    RecycledTarget,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectablePaintPlan {
    pub background: PaintChunk,
    pub underline: bool,
    pub strike: bool,
    pub syntax: bool,
    pub extra_clip: Option<Rect>,
    pub transform: AffineCoeffs,
    pub under_subsequent_glass: Option<GlassBoundary>,
    pub viewport: Rect,
}

impl SelectablePaintPlan {
    pub fn plain(background: PaintChunk, viewport: Rect) -> Self {
        Self {
            background,
            underline: false,
            strike: false,
            syntax: false,
            extra_clip: None,
            transform: AffineCoeffs::IDENTITY,
            under_subsequent_glass: None,
            viewport,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectionFrame {
    pub ops: Vec<NeoPaintOp>,
    pub damage: Vec<DamageRect>,
    pub raster: RasterDecision,
    pub logical_range: TextRange,
    pub glass_roi_invalidations: Vec<Rect>,
    pub autoscroll: Option<Vec2>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectionSession {
    fragment_id: TextFragmentId,
    scene_epoch: SceneEpoch,
    semantic: crate::property_tree::StableSemanticId,
    anchor: TextOffset,
    focus: TextOffset,
    last_union: Option<Rect>,
}

impl SelectionSession {
    pub fn begin(
        fragment: &TextInteractionSnapshot,
        local_x: f32,
        local_y: f32,
    ) -> Result<Self, SelectionError> {
        if !fragment.fragment_id.is_live() {
            return Err(SelectionError::StaleFragment);
        }
        let caret = fragment
            .hit_caret(local_x, local_y)
            .unwrap_or(fragment.logical_range.start);
        Ok(Self {
            fragment_id: fragment.fragment_id,
            scene_epoch: fragment.scene_epoch,
            semantic: fragment.semantic,
            anchor: caret,
            focus: caret,
            last_union: None,
        })
    }

    pub fn try_begin_on_tile(
        text: &TextSnapshotSet,
        geometry: &GeometryTileSnapshot,
        tile: TileId,
        local_x: f32,
        local_y: f32,
    ) -> Result<Self, SelectionError> {
        if geometry.scene_epoch() != text.scene_epoch() {
            return Err(SelectionError::StaleEpoch);
        }
        if geometry.is_fallback(tile) {
            let has_snapshot = text
                .fragments()
                .iter()
                .any(|fragment| fragment.covers_tile(tile));
            if !has_snapshot {
                return Err(SelectionError::FallbackWithoutSnapshot);
            }
        }
        let fragment = text
            .fragments()
            .iter()
            .find(|fragment| fragment.covers_tile(tile))
            .ok_or(SelectionError::MissingSnapshot)?;
        Self::begin(fragment, local_x, local_y)
    }

    pub fn fragment_id(&self) -> TextFragmentId {
        self.fragment_id
    }

    pub fn semantic(&self) -> crate::property_tree::StableSemanticId {
        self.semantic
    }

    pub fn rebind_text(&mut self, text: &TextSnapshotSet) -> Result<(), SelectionError> {
        if text.scene_epoch() != self.scene_epoch {
            return Err(SelectionError::StaleEpoch);
        }
        match text.get(self.fragment_id) {
            Some(fragment) if fragment.semantic == self.semantic => Ok(()),
            Some(_) => Err(SelectionError::RecycledTarget),
            None => {
                if text
                    .fragments()
                    .iter()
                    .any(|fragment| fragment.fragment_id.index() == self.fragment_id.index())
                {
                    Err(SelectionError::RecycledTarget)
                } else {
                    Err(SelectionError::StaleFragment)
                }
            }
        }
    }

    pub fn drag(
        &mut self,
        fragment: &TextInteractionSnapshot,
        geometry: &GeometryTileSnapshot,
        plan: &SelectablePaintPlan,
        local_x: f32,
        local_y: f32,
        pointer_in_viewport: Option<Point>,
    ) -> Result<SelectionFrame, SelectionError> {
        self.ensure_live(fragment)?;
        if geometry.scene_epoch() != fragment.scene_epoch {
            return Err(SelectionError::StaleEpoch);
        }
        if let Some(caret) = fragment.hit_caret(local_x, local_y) {
            self.focus = caret;
        }
        let range = fragment.logical_copy_range(self.anchor, self.focus);
        let mut frame = compose_selectable(fragment, geometry, plan, range, Some(self.focus))?;
        let new_union = union_rects(
            frame
                .ops
                .iter()
                .find_map(|op| match op {
                    NeoPaintOp::Selection(selection) => Some(selection.rects.as_ref()),
                    _ => None,
                })
                .unwrap_or(&[]),
        );
        let combined = match (self.last_union, new_union) {
            (Some(prev), Some(next)) => Some(prev.union(next)),
            (Some(prev), None) => Some(prev),
            (None, Some(next)) => Some(next),
            (None, None) => None,
        };
        if let Some(combined) = combined {
            frame.damage = vec![DamageRect::from_rect(combined)];
        }
        self.last_union = new_union;
        if let Some(point) = pointer_in_viewport {
            frame.autoscroll = autoscroll_delta(plan.viewport, point.x as f32, point.y as f32);
        }
        Ok(frame)
    }

    fn ensure_live(&self, fragment: &TextInteractionSnapshot) -> Result<(), SelectionError> {
        if fragment.scene_epoch != self.scene_epoch {
            return Err(SelectionError::StaleEpoch);
        }
        if fragment.fragment_id != self.fragment_id {
            if fragment.fragment_id.index() == self.fragment_id.index() {
                return Err(SelectionError::RecycledTarget);
            }
            return Err(SelectionError::StaleFragment);
        }
        if fragment.semantic != self.semantic {
            return Err(SelectionError::RecycledTarget);
        }
        Ok(())
    }
}

/// Half-open clip against a tile. Shared edges snap to the same integer so
/// adjacent tiles share one boundary and do not leave a gap or double edge.
pub fn clip_to_tile(rect: Rect, tile: Rect) -> Option<Rect> {
    let x0 = rect.x.max(tile.x);
    let y0 = rect.y.max(tile.y);
    let x1 = rect.x1().min(tile.x1());
    let y1 = rect.y1().min(tile.y1());
    if x0 >= x1 || y0 >= y1 {
        return None;
    }
    let sx0 = snap_min(x0, tile.x);
    let sy0 = snap_min(y0, tile.y);
    let sx1 = snap_max(x1, tile.x1());
    let sy1 = snap_max(y1, tile.y1());
    if sx0 >= sx1 || sy0 >= sy1 {
        return None;
    }
    Some(Rect::new(sx0, sy0, sx1 - sx0, sy1 - sy0))
}

pub fn autoscroll_delta(viewport: Rect, pointer_x: f32, pointer_y: f32) -> Option<Vec2> {
    let mut dx = 0.0;
    let mut dy = 0.0;
    if pointer_x < viewport.x + AUTOSCROLL_EDGE_PX {
        dx = f64::from(pointer_x - (viewport.x + AUTOSCROLL_EDGE_PX));
    } else if pointer_x > viewport.x1() - AUTOSCROLL_EDGE_PX {
        dx = f64::from(pointer_x - (viewport.x1() - AUTOSCROLL_EDGE_PX));
    }
    if pointer_y < viewport.y + AUTOSCROLL_EDGE_PX {
        dy = f64::from(pointer_y - (viewport.y + AUTOSCROLL_EDGE_PX));
    } else if pointer_y > viewport.y1() - AUTOSCROLL_EDGE_PX {
        dy = f64::from(pointer_y - (viewport.y1() - AUTOSCROLL_EDGE_PX));
    }
    if dx == 0.0 && dy == 0.0 {
        None
    } else {
        Some(Vec2::new(dx, dy))
    }
}

pub fn apply_autoscroll(
    path: &mut CompositorFastPath,
    scroll: ScrollId,
    delta: Vec2,
    seq: ScrollSequence,
    time: PresentationTime,
) -> Result<Vec2, ScrollInputError> {
    path.nudge(scroll, delta, seq, time)
}

pub fn compose_selectable(
    fragment: &TextInteractionSnapshot,
    geometry: &GeometryTileSnapshot,
    plan: &SelectablePaintPlan,
    range: TextRange,
    caret: Option<TextOffset>,
) -> Result<SelectionFrame, SelectionError> {
    if geometry.scene_epoch() != fragment.scene_epoch {
        return Err(SelectionError::StaleEpoch);
    }
    let logical_rects = logical_cluster_rects(fragment, range);
    let world_rects: Vec<Rect> = logical_rects
        .iter()
        .copied()
        .map(|rect| transform_rect(rect, plan.transform))
        .collect();
    let clipped = clip_rects_to_geometry(&world_rects, geometry, plan.extra_clip);
    let caret_offset = caret.unwrap_or(range.end);
    let caret_bounds = transform_rect(caret_rect(fragment, caret_offset), plan.transform);
    let start_bounds = handle_rect(caret_rect(fragment, range.start), HandleKind::Start);
    let end_bounds = handle_rect(caret_rect(fragment, range.end), HandleKind::End);
    let glass_roi_invalidations =
        invalidated_glass_rois(&clipped, plan.under_subsequent_glass.as_ref(), true);
    let damage = union_rects(&clipped)
        .map(|rect| vec![DamageRect::from_rect(rect)])
        .unwrap_or_default();
    Ok(SelectionFrame {
        ops: assemble_ops(
            fragment,
            plan,
            range,
            clipped,
            caret_offset,
            caret_bounds,
            transform_rect(start_bounds, plan.transform),
            transform_rect(end_bounds, plan.transform),
        ),
        damage,
        raster: RasterDecision::SelectionOnly,
        logical_range: range,
        glass_roi_invalidations,
        autoscroll: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn assemble_ops(
    fragment: &TextInteractionSnapshot,
    plan: &SelectablePaintPlan,
    range: TextRange,
    clipped: Vec<Rect>,
    caret_offset: TextOffset,
    caret_bounds: Rect,
    start_handle: Rect,
    end_handle: Rect,
) -> Vec<NeoPaintOp> {
    let mut ops = Vec::new();
    ops.push(NeoPaintOp::PaintChunk(plan.background.clone()));
    ops.push(NeoPaintOp::TextFragment(TextPaintFragment {
        fragment_id: fragment.fragment_id,
        generation: fragment.generation,
        spatial_node: fragment.spatial_node,
        clip_chain: fragment.clip_chain,
        effect_node: fragment.effect_node,
        backdrop_root: fragment.backdrop_root,
        bounds: fragment_bounds(fragment),
        tiles: fragment
            .tiles
            .iter()
            .map(|cover| cover.tile)
            .collect::<Vec<_>>()
            .into(),
    }));
    if !range.is_empty() && !clipped.is_empty() {
        ops.push(NeoPaintOp::Selection(SelectionPaintOp {
            fragment_id: fragment.fragment_id,
            generation: fragment.generation,
            logical_range: range,
            rects: clipped.into(),
            spatial_node: fragment.spatial_node,
            clip_chain: fragment.clip_chain,
            effect_node: fragment.effect_node,
            backdrop_root: fragment.backdrop_root,
            source_generation: fragment.generation,
        }));
    }
    let bounds = fragment_bounds(fragment);
    ops.push(glyph_chunk(
        fragment,
        GLYPH_CHUNK,
        StubPayload::TransparentGlyphs,
        bounds,
    ));
    if fragment
        .shaped_runs
        .iter()
        .any(|run| run.glyphs.iter().any(|glyph| glyph.color_emoji))
    {
        ops.push(glyph_chunk(
            fragment,
            EMOJI_CHUNK,
            StubPayload::ColorEmoji,
            bounds,
        ));
    }
    if plan.syntax {
        ops.push(glyph_chunk(
            fragment,
            SYNTAX_CHUNK,
            StubPayload::SyntaxGlyphs,
            bounds,
        ));
    }
    if plan.underline || plan.strike {
        ops.push(glyph_chunk(
            fragment,
            DECORATION_CHUNK,
            StubPayload::Decoration,
            bounds,
        ));
    }
    ops.push(NeoPaintOp::Caret(CaretPaintOp {
        fragment_id: fragment.fragment_id,
        generation: fragment.generation,
        caret: caret_offset,
        bounds: caret_bounds,
        spatial_node: fragment.spatial_node,
        clip_chain: fragment.clip_chain,
        effect_node: fragment.effect_node,
        backdrop_root: fragment.backdrop_root,
    }));
    if !range.is_empty() {
        ops.push(NeoPaintOp::Handle(HandlePaintOp {
            fragment_id: fragment.fragment_id,
            generation: fragment.generation,
            kind: HandleKind::Start,
            bounds: start_handle,
            spatial_node: fragment.spatial_node,
            clip_chain: fragment.clip_chain,
            effect_node: fragment.effect_node,
            backdrop_root: fragment.backdrop_root,
        }));
        ops.push(NeoPaintOp::Handle(HandlePaintOp {
            fragment_id: fragment.fragment_id,
            generation: fragment.generation,
            kind: HandleKind::End,
            bounds: end_handle,
            spatial_node: fragment.spatial_node,
            clip_chain: fragment.clip_chain,
            effect_node: fragment.effect_node,
            backdrop_root: fragment.backdrop_root,
        }));
    }
    ops
}

fn glyph_chunk(
    fragment: &TextInteractionSnapshot,
    id: PaintChunkId,
    payload: StubPayload,
    bounds: Rect,
) -> NeoPaintOp {
    NeoPaintOp::PaintChunk(PaintChunk {
        id,
        generation: fragment.generation,
        paint_order: PaintOrderKey(id.0),
        spatial_node: fragment.spatial_node,
        clip_chain: fragment.clip_chain,
        effect_node: fragment.effect_node,
        backdrop_root: fragment.backdrop_root,
        bounds,
        payload,
    })
}

fn fragment_bounds(fragment: &TextInteractionSnapshot) -> Rect {
    let local = fragment.local_bounds();
    Rect::new(
        local.x as f32,
        local.y as f32,
        local.width as f32,
        local.height as f32,
    )
}

fn logical_cluster_rects(fragment: &TextInteractionSnapshot, range: TextRange) -> Vec<Rect> {
    if range.is_empty() {
        return Vec::new();
    }
    let mut rects = Vec::new();
    for cluster in fragment.cluster_map.iter() {
        if !ranges_overlap(cluster.logical, range) {
            continue;
        }
        if cluster.combining && !cluster.caret_stop {
            continue;
        }
        let Some(line) = line_for_offset(fragment, cluster.logical.start) else {
            continue;
        };
        let mut min_x = f32::MAX;
        let mut max_x = f32::MIN;
        for run in fragment.shaped_runs.iter() {
            for glyph in run.glyphs.iter() {
                let glyph_range = fragment
                    .cluster_at(glyph.cluster)
                    .map(|item| item.logical)
                    .unwrap_or(TextRange::new(
                        glyph.cluster.0,
                        glyph.cluster.0.saturating_add(1),
                    ));
                if !ranges_overlap(glyph_range, cluster.logical) {
                    continue;
                }
                min_x = min_x.min(glyph.x);
                max_x = max_x.max(glyph.x + glyph.advance.max(0.0));
            }
        }
        if min_x > max_x {
            continue;
        }
        let top = line.origin_y - line.ascent;
        rects.push(Rect::new(
            min_x,
            top,
            (max_x - min_x).max(CARET_WIDTH),
            line.ascent + line.descent,
        ));
    }
    merge_line_rects(rects)
}

fn ranges_overlap(a: TextRange, b: TextRange) -> bool {
    a.start.0 < b.end.0 && b.start.0 < a.end.0
}

fn line_for_offset(
    fragment: &TextInteractionSnapshot,
    offset: TextOffset,
) -> Option<&crate::text::LineMetric> {
    fragment
        .line_metrics
        .iter()
        .find(|line| line.logical.contains(offset))
        .or_else(|| {
            if offset == fragment.logical_range.end {
                fragment.line_metrics.last()
            } else {
                None
            }
        })
}

fn merge_line_rects(mut rects: Vec<Rect>) -> Vec<Rect> {
    if rects.len() < 2 {
        return rects;
    }
    rects.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut merged: Vec<Rect> = Vec::new();
    for rect in rects {
        match merged.last_mut() {
            Some(open) if (open.y - rect.y).abs() <= TILE_EDGE_EPS && open.x1() + 0.5 >= rect.x => {
                *open = open.union(rect);
            }
            _ => merged.push(rect),
        }
    }
    merged
}

fn clip_rects_to_geometry(
    rects: &[Rect],
    geometry: &GeometryTileSnapshot,
    extra_clip: Option<Rect>,
) -> Vec<Rect> {
    let mut clipped = Vec::new();
    for rect in rects {
        let source = match extra_clip {
            Some(clip) => match rect.intersect(clip) {
                Some(hit) => hit,
                None => continue,
            },
            None => *rect,
        };
        for tile in geometry.tiles() {
            if let Some(piece) = clip_to_tile(source, tile.bounds) {
                clipped.push(piece);
            }
        }
    }
    clipped
}

fn caret_rect(fragment: &TextInteractionSnapshot, offset: TextOffset) -> Rect {
    let snapped = fragment.snap_caret(offset);
    let line = line_for_offset(fragment, snapped).or_else(|| fragment.line_metrics.last());
    let Some(line) = line else {
        return Rect::new(0.0, 0.0, CARET_WIDTH, 20.0);
    };
    let mut x = line.origin_x;
    if snapped.0 >= line.logical.end.0 {
        x = line.origin_x + line.width;
    } else {
        for run in fragment.shaped_runs.iter() {
            for glyph in run.glyphs.iter() {
                if fragment.snap_caret(glyph.cluster) == snapped {
                    x = glyph.x;
                }
            }
        }
    }
    Rect::new(
        x,
        line.origin_y - line.ascent,
        CARET_WIDTH,
        line.ascent + line.descent,
    )
}

fn handle_rect(caret: Rect, kind: HandleKind) -> Rect {
    let x = match kind {
        HandleKind::Start => caret.x - HANDLE_SIZE * 0.5,
        HandleKind::End => caret.x1() - HANDLE_SIZE * 0.5,
    };
    Rect::new(x, caret.y1() - 2.0, HANDLE_SIZE, HANDLE_SIZE)
}

fn transform_rect(rect: Rect, transform: AffineCoeffs) -> Rect {
    if transform == AffineCoeffs::IDENTITY {
        return rect;
    }
    let pts = [
        transform.transform_point(f64::from(rect.x), f64::from(rect.y)),
        transform.transform_point(f64::from(rect.x1()), f64::from(rect.y)),
        transform.transform_point(f64::from(rect.x), f64::from(rect.y1())),
        transform.transform_point(f64::from(rect.x1()), f64::from(rect.y1())),
    ];
    let min_x = pts.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let min_y = pts.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_x = pts.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let max_y = pts.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    Rect::new(
        min_x as f32,
        min_y as f32,
        (max_x - min_x) as f32,
        (max_y - min_y) as f32,
    )
}

fn union_rects(rects: &[Rect]) -> Option<Rect> {
    let mut iter = rects.iter().copied().filter(|rect| !rect.is_empty());
    let first = iter.next()?;
    Some(iter.fold(first, Rect::union))
}

fn invalidated_glass_rois(
    selection_rects: &[Rect],
    glass: Option<&GlassBoundary>,
    selection_is_prefix: bool,
) -> Vec<Rect> {
    let Some(glass) = glass else {
        return Vec::new();
    };
    if !selection_is_prefix {
        return Vec::new();
    }
    selection_rects
        .iter()
        .filter_map(|rect| rect.intersect(glass.roi))
        .collect()
}

fn snap_min(value: f32, tile_edge: f32) -> f32 {
    if (value - tile_edge).abs() <= TILE_EDGE_EPS {
        tile_edge.round()
    } else {
        value.floor()
    }
}

fn snap_max(value: f32, tile_edge: f32) -> f32 {
    if (value - tile_edge).abs() <= TILE_EDGE_EPS {
        tile_edge.round()
    } else {
        value.ceil()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_tile_edge_has_no_gap_or_double_paint() {
        let span = Rect::new(0.0, 0.0, 400.0, 160.0);
        let a = clip_to_tile(span, Rect::new(0.0, 0.0, 400.0, 80.0)).unwrap();
        let b = clip_to_tile(span, Rect::new(0.0, 80.0, 400.0, 80.0)).unwrap();
        assert_eq!(a.y1(), b.y);
        assert!(a.y1() <= b.y);
        assert!(a.intersect(b).is_none() || a.intersect(b).unwrap().height == 0.0);
    }
}
