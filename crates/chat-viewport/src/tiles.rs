//! Bounded tile cache. Viewport and protected band stay pinned during fling.
//! Descriptors carry no chat/model payload.

use std::collections::HashMap;
use std::sync::Arc;

use crate::height::{GeometryEpoch, HeightIndex, LogicalItemId};
use crate::range::ItemSpan;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct TileId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileFidelity {
    Full,
    Fallback,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileDescriptor {
    pub id: TileId,
    pub first: LogicalItemId,
    pub last: LogicalItemId,
    pub origin: f64,
    pub height: f64,
    pub bytes: usize,
    pub fidelity: TileFidelity,
    pub epoch: GeometryEpoch,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TileCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub pinned_rejects: u64,
    pub high_water_items: usize,
    pub high_water_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileInsert {
    Inserted,
    AlreadyPresent,
    Pinned,
}

struct Entry {
    tile: TileDescriptor,
    pinned: bool,
}

pub struct TileCache {
    item_cap: usize,
    byte_cap: usize,
    entries: HashMap<TileId, Entry>,
    order: Vec<TileId>,
    next_id: u64,
    fling: bool,
    stats: TileCacheStats,
}

impl TileCache {
    pub fn new(item_cap: usize, byte_cap: usize) -> Self {
        assert!(item_cap >= 1, "tile cache item cap must be at least 1");
        assert!(byte_cap >= 1, "tile cache byte cap must be at least 1");
        Self {
            item_cap,
            byte_cap,
            entries: HashMap::new(),
            order: Vec::new(),
            next_id: 1,
            fling: false,
            stats: TileCacheStats::default(),
        }
    }

    pub fn stats(&self) -> TileCacheStats {
        self.stats
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.entries.values().map(|entry| entry.tile.bytes).sum()
    }

    pub fn set_fling(&mut self, active: bool) {
        self.fling = active;
        if !active {
            for entry in self.entries.values_mut() {
                entry.pinned = false;
            }
        }
    }

    pub fn fling_active(&self) -> bool {
        self.fling
    }

    pub fn get(&mut self, id: TileId) -> Option<TileDescriptor> {
        if let Some(entry) = self.entries.get(&id) {
            self.stats.hits = self.stats.hits.saturating_add(1);
            Some(entry.tile)
        } else {
            self.stats.misses = self.stats.misses.saturating_add(1);
            None
        }
    }

    pub fn descriptors(&self) -> Vec<TileDescriptor> {
        let mut tiles: Vec<_> = self.entries.values().map(|entry| entry.tile).collect();
        tiles.sort_by(|a, b| {
            a.origin
                .partial_cmp(&b.origin)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        tiles
    }

    pub fn covering(&self, id: LogicalItemId) -> Option<TileDescriptor> {
        self.entries
            .values()
            .find_map(|entry| (entry.tile.first == id).then_some(entry.tile))
    }

    pub fn pin_span(&mut self, index: &HeightIndex, span: ItemSpan) {
        for i in span.start..span.end {
            if let Some((id, _, _)) = index.height_at(i) {
                if let Some(entry) = self
                    .entries
                    .values_mut()
                    .find(|entry| entry.tile.first == id)
                {
                    entry.pinned = true;
                }
            }
        }
    }

    pub fn insert_span(
        &mut self,
        index: &HeightIndex,
        span: ItemSpan,
        fidelity: TileFidelity,
    ) -> TileInsert {
        let mut last = TileInsert::AlreadyPresent;
        for i in span.start..span.end {
            last = self.insert_item(index, i, fidelity);
        }
        last
    }

    fn insert_item(
        &mut self,
        index: &HeightIndex,
        layout_index: usize,
        fidelity: TileFidelity,
    ) -> TileInsert {
        let Some((id, height, _)) = index.height_at(layout_index) else {
            return TileInsert::AlreadyPresent;
        };
        let origin = index.origin_at(layout_index).unwrap_or(0.0);
        if let Some(existing) = self.covering(id) {
            let same_geom =
                (existing.origin - origin).abs() < 1e-6 && (existing.height - height).abs() < 1e-6;
            if self.fling
                && self.is_pinned(existing.id)
                && (!same_geom || existing.epoch != index.geometry_epoch())
            {
                self.stats.pinned_rejects = self.stats.pinned_rejects.saturating_add(1);
                return TileInsert::Pinned;
            }
            if existing.fidelity == fidelity
                && same_geom
                && existing.epoch == index.geometry_epoch()
            {
                return TileInsert::AlreadyPresent;
            }
            self.remove(existing.id);
        }
        let bytes = match fidelity {
            TileFidelity::Fallback => 128,
            TileFidelity::Full => BYTES_PER_TILE,
        };
        let tile = TileDescriptor {
            id: TileId(self.next_id),
            first: id,
            last: id,
            origin,
            height,
            bytes,
            fidelity,
            epoch: index.geometry_epoch(),
        };
        self.next_id = self.next_id.saturating_add(1);
        self.evict_until(bytes);
        if self.entries.len() >= self.item_cap || self.bytes() + bytes > self.byte_cap {
            if self.fling {
                self.stats.pinned_rejects = self.stats.pinned_rejects.saturating_add(1);
                return TileInsert::Pinned;
            }
            self.evict_unpinned();
            if self.entries.len() >= self.item_cap || self.bytes() + bytes > self.byte_cap {
                return TileInsert::Pinned;
            }
        }
        let pinned = false;
        self.order.push(tile.id);
        self.entries.insert(tile.id, Entry { pinned, tile });
        self.record();
        TileInsert::Inserted
    }

    fn is_pinned(&self, id: TileId) -> bool {
        self.entries.get(&id).is_some_and(|entry| entry.pinned)
    }

    fn remove(&mut self, id: TileId) {
        if self.entries.remove(&id).is_some() {
            self.order.retain(|open| *open != id);
        }
    }

    fn evict_until(&mut self, incoming: usize) {
        while !self.order.is_empty()
            && (self.entries.len() >= self.item_cap || self.bytes() + incoming > self.byte_cap)
        {
            let Some(oldest) = self.order.first().copied() else {
                break;
            };
            if self.fling && self.is_pinned(oldest) {
                let unpinned = self.order.iter().copied().find(|id| !self.is_pinned(*id));
                let Some(id) = unpinned else {
                    break;
                };
                self.remove(id);
                self.stats.evictions = self.stats.evictions.saturating_add(1);
                continue;
            }
            self.remove(oldest);
            self.stats.evictions = self.stats.evictions.saturating_add(1);
        }
    }

    fn evict_unpinned(&mut self) {
        let ids: Vec<_> = self
            .order
            .iter()
            .copied()
            .filter(|id| !self.is_pinned(*id))
            .collect();
        for id in ids {
            self.remove(id);
            self.stats.evictions = self.stats.evictions.saturating_add(1);
        }
    }

    fn record(&mut self) {
        self.stats.high_water_items = self.stats.high_water_items.max(self.entries.len());
        self.stats.high_water_bytes = self.stats.high_water_bytes.max(self.bytes());
    }
}

const BYTES_PER_TILE: usize = 4096;

/// Ready tiles + geometry for the compositor. No chat/model fields.
#[derive(Clone, Debug, PartialEq)]
pub struct GeometrySnapshot {
    pub epoch: GeometryEpoch,
    pub extent: f64,
    pub offset: f64,
    pub tiles: Arc<[TileDescriptor]>,
}

impl GeometrySnapshot {
    pub fn from_cache(cache: &TileCache, index: &HeightIndex, offset: f64) -> Self {
        Self {
            epoch: index.geometry_epoch(),
            extent: index.extent(),
            offset,
            tiles: cache.descriptors().into(),
        }
    }
}
