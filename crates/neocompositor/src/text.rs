//! Interaction-ready text snapshots (RFC §21.1).
//!
//! Glyph geometry and logical→visual maps are **producer** data. This module
//! must not shape Unicode, run layout, or perform font fallback.

use std::sync::Arc;

use crate::display_list::{BackdropRootId, ClipChainId, EffectNodeId, Rect, SpatialNodeId};
use crate::epoch::SceneEpoch;
use crate::geometry_tiles::{GeometryTileSnapshot, TileId};
use crate::property_tree::{
    ClipId, HitTestId, HitTestItem, LogicalRect, PointerFlags, SpatialId, StableSemanticId,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct TextFragmentId {
    index: u32,
    generation: u64,
}

impl TextFragmentId {
    pub const fn unbound(index: u32) -> Self {
        Self {
            index,
            generation: 0,
        }
    }

    pub const fn new(index: u32, generation: u64) -> Self {
        Self { index, generation }
    }

    pub const fn index(self) -> u32 {
        self.index
    }

    pub const fn generation(self) -> u64 {
        self.generation
    }

    pub const fn is_live(self) -> bool {
        self.generation != 0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TextOffset(pub u32);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextRange {
    pub start: TextOffset,
    pub end: TextOffset,
}

impl TextRange {
    pub fn new(start: u32, end: u32) -> Self {
        if start <= end {
            Self {
                start: TextOffset(start),
                end: TextOffset(end),
            }
        } else {
            Self {
                start: TextOffset(end),
                end: TextOffset(start),
            }
        }
    }

    pub fn contains(self, offset: TextOffset) -> bool {
        offset.0 >= self.start.0 && offset.0 < self.end.0
    }

    pub fn is_empty(self) -> bool {
        self.start.0 >= self.end.0
    }

    pub fn len(self) -> u32 {
        self.end.0.saturating_sub(self.start.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BidiAffinity {
    Before,
    After,
}

/// Opaque producer glyph. The compositor replays it; it does not shape.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProducerGlyph {
    pub glyph_id: u32,
    pub cluster: TextOffset,
    pub x: f32,
    pub y: f32,
    pub advance: f32,
    pub font_key: u64,
    pub color_emoji: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ShapedRunRef {
    pub run_id: u64,
    pub logical: TextRange,
    pub visual_order: u32,
    pub bidi_level: u8,
    pub rtl: bool,
    pub glyphs: Arc<[ProducerGlyph]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClusterBoundary {
    pub logical: TextRange,
    pub caret_stop: bool,
    pub ligature: bool,
    pub combining: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineMetric {
    pub logical: TextRange,
    pub origin_x: f32,
    pub origin_y: f32,
    pub width: f32,
    pub ascent: f32,
    pub descent: f32,
    pub baseline: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileCoverage {
    pub tile: TileId,
    pub clip: Rect,
}

/// Immutable interaction snapshot from the upstream text stack.
#[derive(Clone, Debug, PartialEq)]
pub struct TextInteractionSnapshot {
    pub scene_epoch: SceneEpoch,
    pub generation: u64,
    pub fragment_id: TextFragmentId,
    pub semantic: StableSemanticId,
    pub logical_range: TextRange,
    pub shaped_runs: Arc<[ShapedRunRef]>,
    pub cluster_map: Arc<[ClusterBoundary]>,
    pub line_metrics: Arc<[LineMetric]>,
    pub logical_to_visual: Arc<[u32]>,
    pub visual_to_logical: Arc<[u32]>,
    pub tiles: Arc<[TileCoverage]>,
    pub spatial_node: SpatialNodeId,
    pub clip_chain: ClipChainId,
    pub effect_node: EffectNodeId,
    pub backdrop_root: BackdropRootId,
}

impl TextInteractionSnapshot {
    pub fn caret_stops(&self) -> impl Iterator<Item = TextOffset> + '_ {
        self.cluster_map
            .iter()
            .filter(|cluster| cluster.caret_stop)
            .map(|cluster| cluster.logical.start)
            .chain(std::iter::once(self.logical_range.end))
    }

    pub fn snap_caret(&self, offset: TextOffset) -> TextOffset {
        let mut best = self.logical_range.start;
        for stop in self.caret_stops() {
            if stop.0 <= offset.0 {
                best = stop;
            } else {
                break;
            }
        }
        best
    }

    pub fn next_caret(&self, offset: TextOffset) -> Option<TextOffset> {
        self.caret_stops().find(|stop| stop.0 > offset.0)
    }

    pub fn cluster_at(&self, offset: TextOffset) -> Option<&ClusterBoundary> {
        self.cluster_map
            .iter()
            .find(|cluster| cluster.logical.contains(offset))
    }

    pub fn visual_index(&self, cluster_index: usize) -> Option<u32> {
        self.logical_to_visual.get(cluster_index).copied()
    }

    pub fn logical_index(&self, visual_index: usize) -> Option<u32> {
        self.visual_to_logical.get(visual_index).copied()
    }

    /// Copy range is always logical, independent of visual bidi order.
    pub fn logical_copy_range(&self, a: TextOffset, b: TextOffset) -> TextRange {
        TextRange::new(a.0, b.0)
    }

    pub fn covers_tile(&self, id: TileId) -> bool {
        self.tiles.iter().any(|cover| cover.tile == id)
    }

    pub fn local_bounds(&self) -> LogicalRect {
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        for line in self.line_metrics.iter() {
            min_x = min_x.min(line.origin_x);
            min_y = min_y.min(line.origin_y - line.ascent);
            max_x = max_x.max(line.origin_x + line.width);
            max_y = max_y.max(line.origin_y + line.descent);
        }
        if min_x > max_x {
            return LogicalRect::new(0.0, 0.0, 0.0, 0.0);
        }
        LogicalRect::new(
            f64::from(min_x),
            f64::from(min_y),
            f64::from(max_x - min_x),
            f64::from(max_y - min_y),
        )
    }

    /// Hit a caret stop from producer glyph geometry. No shaping/layout.
    pub fn hit_caret(&self, local_x: f32, local_y: f32) -> Option<TextOffset> {
        let line = self.line_metrics.iter().find(|line| {
            let top = line.origin_y - line.ascent;
            let bottom = line.origin_y + line.descent;
            local_y >= top && local_y < bottom
        })?;
        let mut best = line.logical.start;
        let mut best_x = line.origin_x;
        for run in self.shaped_runs.iter() {
            if run.logical.end.0 <= line.logical.start.0
                || run.logical.start.0 >= line.logical.end.0
            {
                continue;
            }
            for glyph in run.glyphs.iter() {
                let mid = glyph.x + glyph.advance * 0.5;
                if (mid - local_x).abs() <= (best_x - local_x).abs() {
                    best = self.snap_caret(glyph.cluster);
                    best_x = mid;
                }
            }
        }
        Some(best)
    }

    pub fn hit_test_item(&self, spatial: SpatialId, clip: ClipId, paint_order: u32) -> HitTestItem {
        HitTestItem {
            id: HitTestId(self.fragment_id.index()),
            target: self.semantic,
            generation: self.fragment_id.generation(),
            local_bounds: self.local_bounds(),
            spatial,
            clip,
            paint_order,
            scroll_target: None,
            pointer_flags: PointerFlags::PARTICIPATES,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextCommitError {
    MixedEpoch,
    GenerationMismatch,
    DuplicateFragment,
}

/// Immutable set of text snapshots for one [`SceneEpoch`].
#[derive(Clone, Debug, PartialEq)]
pub struct TextSnapshotSet {
    scene_epoch: SceneEpoch,
    fragments: Arc<[TextInteractionSnapshot]>,
}

impl TextSnapshotSet {
    pub fn empty(scene_epoch: SceneEpoch) -> Self {
        Self {
            scene_epoch,
            fragments: Arc::from([]),
        }
    }

    pub fn commit(
        scene_epoch: SceneEpoch,
        fragments: Vec<TextInteractionSnapshot>,
    ) -> Result<Self, TextCommitError> {
        let mut seen = Vec::new();
        for fragment in &fragments {
            if fragment.scene_epoch != scene_epoch {
                return Err(TextCommitError::MixedEpoch);
            }
            if fragment.generation != fragment.fragment_id.generation() {
                return Err(TextCommitError::GenerationMismatch);
            }
            if seen
                .iter()
                .any(|id: &TextFragmentId| id.index() == fragment.fragment_id.index())
            {
                return Err(TextCommitError::DuplicateFragment);
            }
            seen.push(fragment.fragment_id);
        }
        Ok(Self {
            scene_epoch,
            fragments: fragments.into(),
        })
    }

    pub fn scene_epoch(&self) -> SceneEpoch {
        self.scene_epoch
    }

    pub fn is_empty(&self) -> bool {
        self.fragments.is_empty()
    }

    pub fn fragments(&self) -> &[TextInteractionSnapshot] {
        &self.fragments
    }

    pub fn get(&self, id: TextFragmentId) -> Option<&TextInteractionSnapshot> {
        self.fragments
            .iter()
            .find(|fragment| fragment.fragment_id == id)
    }

    pub fn live(&self, id: TextFragmentId) -> bool {
        self.get(id).is_some()
    }

    pub fn by_semantic(
        &self,
        semantic: StableSemanticId,
        generation: u64,
    ) -> Option<&TextInteractionSnapshot> {
        self.fragments.iter().find(|fragment| {
            fragment.semantic == semantic && fragment.fragment_id.generation() == generation
        })
    }

    /// Fallback tiles without a live snapshot are not text targets.
    pub fn hit_item_for_tile(
        &self,
        geometry: &GeometryTileSnapshot,
        tile: TileId,
        spatial: SpatialId,
        clip: ClipId,
        paint_order: u32,
    ) -> Option<HitTestItem> {
        match self.interaction_hit_for_tile(geometry, tile, spatial, clip, paint_order) {
            InteractionReady::Ready(item) => Some(item),
            InteractionReady::NotInteractionReady => None,
        }
    }

    /// Missing snapshot on a fallback tile is [`NotInteractionReady`], not an
    /// approximate hit on a neighbour.
    pub fn interaction_hit_for_tile(
        &self,
        geometry: &GeometryTileSnapshot,
        tile: TileId,
        spatial: SpatialId,
        clip: ClipId,
        paint_order: u32,
    ) -> InteractionReady {
        if geometry.is_fallback(tile) {
            let has_snapshot = self
                .fragments
                .iter()
                .any(|fragment| fragment.covers_tile(tile));
            if !has_snapshot {
                return InteractionReady::NotInteractionReady;
            }
        }
        match self
            .fragments
            .iter()
            .find(|fragment| fragment.covers_tile(tile))
            .map(|fragment| fragment.hit_test_item(spatial, clip, paint_order))
        {
            Some(item) => InteractionReady::Ready(item),
            None => InteractionReady::NotInteractionReady,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InteractionReady {
    Ready(crate::property_tree::HitTestItem),
    NotInteractionReady,
}

impl Default for TextSnapshotSet {
    fn default() -> Self {
        Self::empty(SceneEpoch(0))
    }
}

/// Test/host counter so drag paths can prove they never call the producer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProducerTextWork {
    pub shaping: u64,
    pub layout: u64,
    pub font_fallback: u64,
    pub glyph_raster: u64,
    pub background_raster: u64,
}

impl ProducerTextWork {
    pub fn record_publish(&mut self) {
        self.shaping = self.shaping.saturating_add(1);
        self.layout = self.layout.saturating_add(1);
        self.font_fallback = self.font_fallback.saturating_add(1);
        self.glyph_raster = self.glyph_raster.saturating_add(1);
        self.background_raster = self.background_raster.saturating_add(1);
    }
}
