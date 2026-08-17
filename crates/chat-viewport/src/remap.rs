//! Geometry epochs and fling-continuous remap (RFC §15.8 / PERF-20).
//!
//! Active and shadow [`GeometrySnapshot`]s exist together. Exact-height
//! updates land in a bounded [`PrefixDeltaMap`]. A geometry commit switches
//! tiles, geometry, hit-test, and semantics generations atomically and
//! preserves C0 screen position plus C1 screen velocity (no fling impulse).

use crate::height::{GeometryEpoch, HeightIndex, LogicalItemId};
use crate::tiles::GeometrySnapshot;

pub const PREFIX_ENTRY_BYTES: usize = 64;
pub const DEBT_ENTRY_BYTES: usize = 64;
pub const DEFAULT_PREFIX_ITEM_CAP: usize = 64;
pub const DEFAULT_PREFIX_BYTE_CAP: usize = DEFAULT_PREFIX_ITEM_CAP * PREFIX_ENTRY_BYTES;
pub const DEFAULT_DEBT_ITEM_CAP: usize = 8;
pub const DEFAULT_DEBT_BYTE_CAP: usize = DEFAULT_DEBT_ITEM_CAP * DEBT_ENTRY_BYTES;
pub const DEFAULT_DEBT_PIXEL_CAP: f64 = 1200.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct DeltaToken(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContactMode {
    Rest,
    Touch,
    Fling,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollAnchor {
    pub item: LogicalItemId,
    pub intra_item_offset: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SceneGeneration {
    pub geometry: u64,
    pub tiles: u64,
    pub hit_test: u64,
    pub semantics: u64,
}

impl SceneGeneration {
    pub fn bump_atomic(&mut self) {
        let next = self.geometry.saturating_add(1);
        *self = Self {
            geometry: next,
            tiles: next,
            hit_test: next,
            semantics: next,
        };
    }

    pub fn is_atomic(self) -> bool {
        self.geometry == self.tiles
            && self.tiles == self.hit_test
            && self.hit_test == self.semantics
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PrefixDelta {
    pub item: LogicalItemId,
    pub estimated: f64,
    pub exact: f64,
    pub delta: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrefixError {
    Overlap,
    NonMonotonic,
    UnknownItem,
    Cap,
    NonFinite,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrefixDeltaMap {
    entries: Vec<PrefixDelta>,
    ordered: Vec<OrderedDelta>,
    item_cap: usize,
    byte_cap: usize,
    token: DeltaToken,
    next_token: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct OrderedDelta {
    layout_index: usize,
    delta: f64,
    prefix: f64,
}

impl PrefixDeltaMap {
    pub fn new(item_cap: usize, byte_cap: usize) -> Self {
        Self {
            entries: Vec::new(),
            ordered: Vec::new(),
            item_cap: item_cap.max(1),
            byte_cap: byte_cap.max(PREFIX_ENTRY_BYTES),
            token: DeltaToken(1),
            next_token: 1,
        }
    }

    pub fn token(&self) -> DeltaToken {
        self.token
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn bytes(&self) -> usize {
        self.entries.len().saturating_mul(PREFIX_ENTRY_BYTES)
    }

    pub fn entries(&self) -> &[PrefixDelta] {
        &self.entries
    }

    pub fn delta_for(&self, item: LogicalItemId) -> Option<f64> {
        self.entries
            .iter()
            .find(|entry| entry.item == item)
            .map(|entry| entry.delta)
    }

    pub fn item_ids(&self) -> Vec<LogicalItemId> {
        self.entries.iter().map(|entry| entry.item).collect()
    }

    pub fn total_delta(&self) -> f64 {
        self.entries.iter().map(|entry| entry.delta).sum()
    }

    pub fn reindex(&mut self, index: &HeightIndex) {
        let mut pairs: Vec<(usize, f64)> = self
            .entries
            .iter()
            .filter_map(|entry| index.index_of(entry.item).map(|i| (i, entry.delta)))
            .collect();
        pairs.sort_by_key(|pair| pair.0);
        let mut acc = 0.0;
        self.ordered = pairs
            .into_iter()
            .map(|(layout_index, delta)| {
                let ordered = OrderedDelta {
                    layout_index,
                    delta,
                    prefix: acc,
                };
                acc += delta;
                ordered
            })
            .collect();
    }

    /// Prefix sum of deltas for items with layout index strictly less than
    /// `layout_index`. `O(log k)` after [`Self::reindex`].
    pub fn prefix_before(&self, layout_index: usize) -> f64 {
        match self
            .ordered
            .binary_search_by(|entry| entry.layout_index.cmp(&layout_index))
        {
            Ok(i) => self.ordered[i].prefix,
            Err(0) => 0.0,
            Err(i) => {
                let prev = self.ordered[i - 1];
                prev.prefix + prev.delta
            }
        }
    }

    pub fn insert(
        &mut self,
        index: &HeightIndex,
        delta: PrefixDelta,
    ) -> Result<DeltaToken, PrefixError> {
        if !delta.estimated.is_finite() || !delta.exact.is_finite() || !delta.delta.is_finite() {
            return Err(PrefixError::NonFinite);
        }
        let layout_index = index.index_of(delta.item).ok_or(PrefixError::UnknownItem)?;
        if self.entries.iter().any(|entry| entry.item == delta.item) {
            return Err(PrefixError::Overlap);
        }
        if self
            .ordered
            .iter()
            .any(|entry| entry.layout_index == layout_index)
        {
            return Err(PrefixError::Overlap);
        }
        if self.entries.len() + 1 > self.item_cap
            || self.bytes() + PREFIX_ENTRY_BYTES > self.byte_cap
        {
            return Err(PrefixError::Cap);
        }
        self.entries.push(delta);
        self.reindex(index);
        Ok(self.token)
    }

    /// Rejects a batch whose layout indices are not strictly increasing.
    pub fn extend_sorted(
        &mut self,
        index: &HeightIndex,
        deltas: &[PrefixDelta],
    ) -> Result<DeltaToken, PrefixError> {
        let mut last = None;
        for delta in deltas {
            let layout_index = index.index_of(delta.item).ok_or(PrefixError::UnknownItem)?;
            if last.is_some_and(|prev| layout_index <= prev) {
                return Err(PrefixError::NonMonotonic);
            }
            last = Some(layout_index);
        }
        for delta in deltas {
            self.insert(index, *delta)?;
        }
        Ok(self.token)
    }

    pub fn remove(&mut self, index: &HeightIndex, item: LogicalItemId) -> Option<PrefixDelta> {
        let pos = self.entries.iter().position(|entry| entry.item == item)?;
        let removed = self.entries.remove(pos);
        self.reindex(index);
        Some(removed)
    }

    pub fn rotate_token(&mut self) {
        self.next_token = self.next_token.saturating_add(1);
        self.token = DeltaToken(self.next_token);
    }

    pub fn clear(&mut self, index: &HeightIndex) {
        self.entries.clear();
        self.reindex(index);
        self.rotate_token();
    }
}

impl Default for PrefixDeltaMap {
    fn default() -> Self {
        Self::new(DEFAULT_PREFIX_ITEM_CAP, DEFAULT_PREFIX_BYTE_CAP)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeometryDebt {
    pub item: LogicalItemId,
    pub estimated: f64,
    pub exact: f64,
    pub delta: f64,
    pub from_epoch: GeometryEpoch,
    pub to_epoch: GeometryEpoch,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DebtCaps {
    pub items: usize,
    pub bytes: usize,
    pub pixels: f64,
}

impl Default for DebtCaps {
    fn default() -> Self {
        Self {
            items: DEFAULT_DEBT_ITEM_CAP,
            bytes: DEFAULT_DEBT_BYTE_CAP,
            pixels: DEFAULT_DEBT_PIXEL_CAP,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DebtStats {
    pub deferred: u64,
    pub settled: u64,
    pub cap_hits: u64,
    pub high_water_items: usize,
    pub high_water_bytes: usize,
    pub high_water_pixels: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GeometryDebtLedger {
    entries: Vec<GeometryDebt>,
    caps: DebtCaps,
    stats: DebtStats,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DebtCapError {
    Cap,
}

impl GeometryDebtLedger {
    pub fn new(caps: DebtCaps) -> Self {
        Self {
            entries: Vec::new(),
            caps,
            stats: DebtStats::default(),
        }
    }

    pub fn caps(&self) -> DebtCaps {
        self.caps
    }

    pub fn stats(&self) -> DebtStats {
        self.stats
    }

    pub fn pending(&self) -> &[GeometryDebt] {
        &self.entries
    }

    pub fn pixels(&self) -> f64 {
        self.entries.iter().map(|entry| entry.delta.abs()).sum()
    }

    pub fn bytes(&self) -> usize {
        self.entries.len().saturating_mul(DEBT_ENTRY_BYTES)
    }

    pub fn try_push(&mut self, debt: GeometryDebt) -> Result<(), DebtCapError> {
        let next_items = self.entries.len() + 1;
        let next_bytes = self.bytes() + DEBT_ENTRY_BYTES;
        let next_pixels = self.pixels() + debt.delta.abs();
        if next_items > self.caps.items
            || next_bytes > self.caps.bytes
            || next_pixels > self.caps.pixels
        {
            self.stats.cap_hits = self.stats.cap_hits.saturating_add(1);
            return Err(DebtCapError::Cap);
        }
        self.entries.push(debt);
        self.stats.deferred = self.stats.deferred.saturating_add(1);
        self.stats.high_water_items = self.stats.high_water_items.max(self.entries.len());
        self.stats.high_water_bytes = self.stats.high_water_bytes.max(self.bytes());
        self.stats.high_water_pixels = self.stats.high_water_pixels.max(self.pixels());
        Ok(())
    }

    pub fn remove(&mut self, item: LogicalItemId) -> Option<GeometryDebt> {
        let pos = self.entries.iter().position(|entry| entry.item == item)?;
        Some(self.entries.remove(pos))
    }

    pub fn take_ready(
        &mut self,
        mut ready: impl FnMut(&GeometryDebt) -> bool,
    ) -> Vec<GeometryDebt> {
        let mut keep = Vec::new();
        let mut out = Vec::new();
        for entry in self.entries.drain(..) {
            if ready(&entry) {
                out.push(entry);
            } else {
                keep.push(entry);
            }
        }
        self.entries = keep;
        self.stats.settled = self.stats.settled.saturating_add(out.len() as u64);
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GeometryCorrection {
    Unchanged,
    Applied,
    Deferred,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitError {
    Stale,
    StaleShadow,
    OutOfOrder,
    IncompletePrefix,
    MixedEpoch,
    ScrollGenerationMismatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewportError {
    Height(crate::height::HeightError),
    Prefix(PrefixError),
    Commit(CommitError),
}

impl From<crate::height::HeightError> for ViewportError {
    fn from(value: crate::height::HeightError) -> Self {
        Self::Height(value)
    }
}

impl From<PrefixError> for ViewportError {
    fn from(value: PrefixError) -> Self {
        Self::Prefix(value)
    }
}

impl From<CommitError> for ViewportError {
    fn from(value: CommitError) -> Self {
        Self::Commit(value)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GeometryCommit {
    pub old_epoch: GeometryEpoch,
    pub new_epoch: GeometryEpoch,
    pub based_on_scroll_generation: u64,
    pub anchor: ScrollAnchor,
    pub prefix_delta_map: PrefixDeltaMap,
    pub new_extent: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckResult {
    Applied,
    IgnoredStale,
    IgnoredAlreadyApplied,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollAck {
    pub scroll_generation: u64,
    pub token: DeltaToken,
    pub base_offset: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RemapOutcome {
    pub correction: GeometryCorrection,
    pub applied: bool,
    pub deferred: bool,
    pub hard_clamped: bool,
    pub cap_hit: bool,
    pub deceleration_requested: bool,
    pub screen_velocity_before: f64,
    pub screen_velocity_after: f64,
    pub anchor_screen_before: f64,
    pub anchor_screen_after: f64,
    pub generation: SceneGeneration,
    pub old_epoch: GeometryEpoch,
    pub new_epoch: GeometryEpoch,
    pub token: DeltaToken,
}

impl RemapOutcome {
    pub fn velocity_continuous(&self) -> bool {
        !self.hard_clamped
            && (self.screen_velocity_after - self.screen_velocity_before).abs() < 1e-9
    }

    pub fn position_continuous(&self) -> bool {
        (self.anchor_screen_after - self.anchor_screen_before).abs() < 1e-6
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DualGeometry {
    pub active: GeometrySnapshot,
    pub shadow: GeometrySnapshot,
}

pub fn validate_commit(
    active_epoch: GeometryEpoch,
    shadow_epoch: GeometryEpoch,
    scroll_generation: u64,
    commit: &GeometryCommit,
) -> Result<(), CommitError> {
    if commit.old_epoch != active_epoch {
        return Err(CommitError::Stale);
    }
    if commit.new_epoch.0 <= commit.old_epoch.0 {
        return Err(CommitError::OutOfOrder);
    }
    if commit.new_epoch != shadow_epoch {
        return Err(CommitError::StaleShadow);
    }
    if commit.prefix_delta_map.is_empty() {
        return Err(CommitError::IncompletePrefix);
    }
    if commit.based_on_scroll_generation != scroll_generation {
        return Err(CommitError::ScrollGenerationMismatch);
    }
    Ok(())
}
