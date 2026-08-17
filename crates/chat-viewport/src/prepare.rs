//! Bounded preparation queue. Latest range wins; stale work is cancelled.
//! The render path never waits on this queue.

use crate::range::ItemSpan;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrepPriority {
    Visible,
    Emergency,
    Speculative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrepJob {
    pub id: u64,
    pub span: ItemSpan,
    pub generation: u64,
    pub priority: PrepPriority,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrepAccept {
    Queued,
    Coalesced { cancelled: u64 },
    Stale,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PrepStats {
    pub submitted: u64,
    pub coalesced: u64,
    pub cancelled: u64,
    pub completed: u64,
    pub high_water_items: usize,
}

pub struct PreparationQueue {
    cap: usize,
    pending: Option<PrepJob>,
    next_id: u64,
    latest_generation: u64,
    stats: PrepStats,
}

impl PreparationQueue {
    pub fn new(cap: usize) -> Self {
        assert!(cap >= 1, "preparation queue cap must be at least 1");
        Self {
            cap,
            pending: None,
            next_id: 1,
            latest_generation: 0,
            stats: PrepStats::default(),
        }
    }

    pub fn stats(&self) -> PrepStats {
        self.stats
    }

    pub fn pending(&self) -> Option<PrepJob> {
        self.pending
    }

    pub fn submit(
        &mut self,
        span: ItemSpan,
        generation: u64,
        priority: PrepPriority,
    ) -> PrepAccept {
        self.stats.submitted = self.stats.submitted.saturating_add(1);
        if generation < self.latest_generation {
            self.stats.cancelled = self.stats.cancelled.saturating_add(1);
            return PrepAccept::Stale;
        }
        self.latest_generation = generation;
        let job = PrepJob {
            id: self.next_id,
            span,
            generation,
            priority,
        };
        self.next_id = self.next_id.saturating_add(1);
        if let Some(old) = self.pending.replace(job) {
            self.stats.coalesced = self.stats.coalesced.saturating_add(1);
            self.stats.cancelled = self.stats.cancelled.saturating_add(1);
            self.record_depth();
            let _ = old;
            return PrepAccept::Coalesced { cancelled: old.id };
        }
        self.record_depth();
        debug_assert!(self.len() <= self.cap);
        PrepAccept::Queued
    }

    pub fn take(&mut self) -> Option<PrepJob> {
        let job = self.pending.take()?;
        self.stats.completed = self.stats.completed.saturating_add(1);
        self.record_depth();
        Some(job)
    }

    pub fn cancel_stale(&mut self, generation: u64) -> bool {
        if self.pending.is_some_and(|job| job.generation < generation) {
            self.pending = None;
            self.stats.cancelled = self.stats.cancelled.saturating_add(1);
            self.record_depth();
            true
        } else {
            false
        }
    }

    fn len(&self) -> usize {
        usize::from(self.pending.is_some())
    }

    fn record_depth(&mut self) {
        self.stats.high_water_items = self.stats.high_water_items.max(self.len());
    }
}
