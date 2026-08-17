//! Bounded layer cache (RFC §50). Not a GPU texture cache yet.

use crate::display_list::PaintChunkId;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct LayerKey {
    pub chunk: PaintChunkId,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayerCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

/// Generation-keyed cache with a hard entry cap. Unbounded maps are forbidden.
pub struct LayerCache {
    cap: usize,
    entries: HashMap<LayerKey, ()>,
    order: Vec<LayerKey>,
    stats: LayerCacheStats,
}

impl LayerCache {
    pub fn new(cap: usize) -> Self {
        assert!(cap > 0, "LayerCache cap must be at least 1");
        Self {
            cap,
            entries: HashMap::new(),
            order: Vec::new(),
            stats: LayerCacheStats {
                hits: 0,
                misses: 0,
                evictions: 0,
            },
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn stats(&self) -> LayerCacheStats {
        self.stats.clone()
    }

    pub fn get(&mut self, key: LayerKey) -> bool {
        if self.entries.contains_key(&key) {
            self.stats.hits += 1;
            true
        } else {
            self.stats.misses += 1;
            false
        }
    }

    pub fn insert(&mut self, key: LayerKey) {
        if self.entries.contains_key(&key) {
            return;
        }
        while self.entries.len() >= self.cap {
            if let Some(oldest) = self.order.first().copied() {
                self.order.remove(0);
                self.entries.remove(&oldest);
                self.stats.evictions += 1;
            } else {
                break;
            }
        }
        self.entries.insert(key, ());
        self.order.push(key);
    }

    pub fn invalidate_generation(&mut self, generation: u64) {
        self.order.retain(|key| key.generation != generation);
        self.entries.retain(|key, _| key.generation != generation);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }
}
