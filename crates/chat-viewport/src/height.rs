//! Offset ↔ logical item in `O(log n)`. Heights are estimated or exact and
//! carry a [`GeometryEpoch`]. Exact commits that still need C0/C1 remap are
//! recorded as [`GeometryCorrection::PendingDebt`].

use std::collections::HashMap;

use crate::range::ItemSpan;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GeometryEpoch(pub u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct LogicalItemId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeightKind {
    Estimated,
    Exact,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ItemHit {
    pub id: LogicalItemId,
    pub index: usize,
    pub origin: f64,
    pub height: f64,
    pub kind: HeightKind,
    pub local: f64,
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
pub enum GeometryCorrection {
    Unchanged,
    PendingDebt(GeometryDebt),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeightError {
    UnknownItem,
    NonPositiveHeight,
    DuplicateId,
}

struct Fenwick {
    used: usize,
    cap: usize,
    tree: Vec<f64>,
}

impl Fenwick {
    fn new() -> Self {
        Self {
            used: 0,
            cap: 0,
            tree: vec![0.0],
        }
    }

    fn rebuild(heights: &[f64]) -> Self {
        let used = heights.len();
        let cap = used.next_power_of_two().max(1);
        let mut fenwick = Self {
            used,
            cap,
            tree: vec![0.0; cap + 1],
        };
        for (i, height) in heights.iter().enumerate() {
            fenwick.add(i, *height);
        }
        fenwick
    }

    fn push(&mut self, height: f64, heights: &[f64]) {
        if self.used + 1 > self.cap {
            *self = Self::rebuild(heights);
            return;
        }
        let i = self.used;
        self.used += 1;
        self.add(i, height);
    }

    fn add(&mut self, mut i: usize, delta: f64) {
        i += 1;
        while i <= self.cap {
            self.tree[i] += delta;
            i += i & i.wrapping_neg();
        }
    }

    fn prefix(&self, mut i: usize) -> f64 {
        let mut sum = 0.0;
        while i > 0 {
            sum += self.tree[i];
            i -= i & i.wrapping_neg();
        }
        sum
    }

    fn total(&self) -> f64 {
        self.prefix(self.used)
    }

    fn index_at_offset(&self, mut offset: f64) -> Option<usize> {
        if self.used == 0 {
            return None;
        }
        if offset < 0.0 {
            offset = 0.0;
        }
        let total = self.total();
        if offset >= total {
            return Some(self.used - 1);
        }
        let mut idx = 0usize;
        let mut bit = prev_pow2(self.used);
        let mut acc = 0.0;
        while bit > 0 {
            let next = idx + bit;
            if next <= self.used && acc + self.tree[next] <= offset {
                acc += self.tree[next];
                idx = next;
            }
            bit >>= 1;
        }
        Some(idx.min(self.used - 1))
    }
}

fn prev_pow2(n: usize) -> usize {
    if n == 0 {
        0
    } else {
        1usize << (usize::BITS - 1 - n.leading_zeros())
    }
}

/// Ordered height index. Layout order is independent of [`LogicalItemId`].
pub struct HeightIndex {
    ids: Vec<LogicalItemId>,
    heights: Vec<f64>,
    kinds: Vec<HeightKind>,
    by_id: HashMap<LogicalItemId, usize>,
    fenwick: Fenwick,
    epoch: GeometryEpoch,
    debt: Vec<GeometryDebt>,
}

impl HeightIndex {
    pub fn new() -> Self {
        Self {
            ids: Vec::new(),
            heights: Vec::new(),
            kinds: Vec::new(),
            by_id: HashMap::new(),
            fenwick: Fenwick::new(),
            epoch: GeometryEpoch(0),
            debt: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn geometry_epoch(&self) -> GeometryEpoch {
        self.epoch
    }

    pub fn extent(&self) -> f64 {
        self.fenwick.total()
    }

    pub fn pending_debt(&self) -> &[GeometryDebt] {
        &self.debt
    }

    pub fn origin_at(&self, index: usize) -> Option<f64> {
        if index > self.ids.len() {
            return None;
        }
        Some(self.fenwick.prefix(index))
    }

    pub fn height_at(&self, index: usize) -> Option<(LogicalItemId, f64, HeightKind)> {
        Some((
            *self.ids.get(index)?,
            *self.heights.get(index)?,
            *self.kinds.get(index)?,
        ))
    }

    pub fn span_covering(&self, start: f64, end: f64) -> ItemSpan {
        if self.is_empty() {
            return ItemSpan::EMPTY;
        }
        let first = self.item_at_offset(start).map(|hit| hit.index).unwrap_or(0);
        let last = self
            .item_at_offset(end.max(start) - 1e-9)
            .map(|hit| hit.index)
            .unwrap_or(first);
        ItemSpan {
            start: first,
            end: (last + 1).min(self.len()),
        }
    }

    pub fn height(&self, id: LogicalItemId) -> Option<(f64, HeightKind)> {
        let i = *self.by_id.get(&id)?;
        Some((self.heights[i], self.kinds[i]))
    }

    pub fn offset_of(&self, id: LogicalItemId) -> Option<f64> {
        let i = *self.by_id.get(&id)?;
        Some(self.fenwick.prefix(i))
    }

    pub fn item_at_offset(&self, offset: f64) -> Option<ItemHit> {
        let index = self.fenwick.index_at_offset(offset)?;
        let origin = self.fenwick.prefix(index);
        Some(ItemHit {
            id: self.ids[index],
            index,
            origin,
            height: self.heights[index],
            kind: self.kinds[index],
            local: (offset - origin).max(0.0),
        })
    }

    pub fn push(
        &mut self,
        id: LogicalItemId,
        height: f64,
        kind: HeightKind,
    ) -> Result<usize, HeightError> {
        self.insert_at(self.ids.len(), id, height, kind)
    }

    pub fn prepend(
        &mut self,
        items: &[(LogicalItemId, f64, HeightKind)],
    ) -> Result<(), HeightError> {
        for (id, height, _) in items {
            if *height <= 0.0 {
                return Err(HeightError::NonPositiveHeight);
            }
            if self.by_id.contains_key(id) {
                return Err(HeightError::DuplicateId);
            }
        }
        let extra = items.len();
        let mut ids = Vec::with_capacity(self.ids.len() + extra);
        let mut heights = Vec::with_capacity(self.heights.len() + extra);
        let mut kinds = Vec::with_capacity(self.kinds.len() + extra);
        for (id, height, kind) in items {
            ids.push(*id);
            heights.push(*height);
            kinds.push(*kind);
        }
        ids.append(&mut self.ids);
        heights.append(&mut self.heights);
        kinds.append(&mut self.kinds);
        self.ids = ids;
        self.heights = heights;
        self.kinds = kinds;
        self.rebuild();
        Ok(())
    }

    pub fn set_height(
        &mut self,
        id: LogicalItemId,
        height: f64,
        kind: HeightKind,
    ) -> Result<(), HeightError> {
        if height <= 0.0 {
            return Err(HeightError::NonPositiveHeight);
        }
        let i = *self.by_id.get(&id).ok_or(HeightError::UnknownItem)?;
        let delta = height - self.heights[i];
        self.heights[i] = height;
        self.kinds[i] = kind;
        self.fenwick.add(i, delta);
        Ok(())
    }

    /// Records exact geometry that is not remapped in this slice (PERF-20
    /// C0/C1 is a follow-up). Live heights stay on the previous estimate so
    /// the current fling offset is not silently rewritten.
    pub fn commit_exact(
        &mut self,
        id: LogicalItemId,
        exact: f64,
    ) -> Result<GeometryCorrection, HeightError> {
        if exact <= 0.0 {
            return Err(HeightError::NonPositiveHeight);
        }
        let i = *self.by_id.get(&id).ok_or(HeightError::UnknownItem)?;
        let estimated = self.heights[i];
        let delta = exact - estimated;
        if delta.abs() < 1e-9 {
            self.kinds[i] = HeightKind::Exact;
            return Ok(GeometryCorrection::Unchanged);
        }
        let from = self.epoch;
        self.epoch = GeometryEpoch(self.epoch.0.saturating_add(1));
        let debt = GeometryDebt {
            item: id,
            estimated,
            exact,
            delta,
            from_epoch: from,
            to_epoch: self.epoch,
        };
        self.debt.push(debt);
        Ok(GeometryCorrection::PendingDebt(debt))
    }

    fn insert_at(
        &mut self,
        index: usize,
        id: LogicalItemId,
        height: f64,
        kind: HeightKind,
    ) -> Result<usize, HeightError> {
        if height <= 0.0 {
            return Err(HeightError::NonPositiveHeight);
        }
        if self.by_id.contains_key(&id) {
            return Err(HeightError::DuplicateId);
        }
        if index == self.ids.len() {
            self.ids.push(id);
            self.heights.push(height);
            self.kinds.push(kind);
            self.fenwick.push(height, &self.heights);
            self.by_id.insert(id, index);
            return Ok(index);
        }
        self.ids.insert(index, id);
        self.heights.insert(index, height);
        self.kinds.insert(index, kind);
        self.rebuild();
        Ok(index)
    }

    fn rebuild(&mut self) {
        self.fenwick = Fenwick::rebuild(&self.heights);
        self.by_id.clear();
        for (i, id) in self.ids.iter().copied().enumerate() {
            self.by_id.insert(id, i);
        }
    }
}

impl Default for HeightIndex {
    fn default() -> Self {
        Self::new()
    }
}
