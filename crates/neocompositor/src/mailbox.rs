//! Bounded UI/producer → render mailbox (RFC §12).
//!
//! Latest complete transaction wins. The render path only [`Self::try_dequeue`]s:
//! it never waits on producer, layout, or raster.

use std::sync::{Arc, Mutex, TryLockError};

use crate::display_list::Rect;
use crate::epoch::{DeviceEpoch, EpochClock, FrameId, SceneEpoch};
use crate::pass_graph::compile_passes;
use crate::surface_fallback::{surface_plan_invalid, SurfaceCapability, SurfaceId};
use crate::transaction::{FrameTransaction, ResourceLease};

pub const DEFAULT_ITEM_CAP: usize = 1;
pub const DEFAULT_BYTE_CAP: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MailboxStats {
    pub posted: u64,
    pub accepted: u64,
    pub coalesced: u64,
    pub rejected_stale: u64,
    pub rejected_device_epoch: u64,
    pub rejected_invalid: u64,
    pub rejected_oversize: u64,
    pub rejected_cancelled: u64,
    pub rejected_contended: u64,
    pub dequeued: u64,
    pub retired: u64,
    pub cancelled: u64,
    pub device_epoch_bumps: u64,
    pub high_water_items: usize,
    pub high_water_bytes: usize,
    pub current_items: usize,
    pub current_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostAccept {
    Queued,
    Coalesced { dropped: FrameId },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostReject {
    Stale,
    DeviceEpoch,
    InvalidGraph,
    Oversize,
    Cancelled,
    Contended,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TryDequeue {
    Empty,
    Busy,
    Ready(Arc<FrameTransaction>),
}

struct Inner {
    pending: Option<Arc<FrameTransaction>>,
    last_known_good: Option<Arc<FrameTransaction>>,
    logical_snapshot: Option<Arc<FrameTransaction>>,
    clock: EpochClock,
    last_seen_frame: Option<FrameId>,
    last_seen_scene: Option<SceneEpoch>,
    last_seen_generation: u64,
    item_cap: usize,
    byte_cap: usize,
    cancelled: bool,
    stats: MailboxStats,
    retired: Vec<ResourceLease>,
}

impl Inner {
    fn current_items(&self) -> usize {
        usize::from(self.pending.is_some())
    }

    fn current_bytes(&self) -> usize {
        self.pending.as_ref().map(|tx| tx.byte_size()).unwrap_or(0)
    }

    fn record_depth(&mut self) {
        let items = self.current_items();
        let bytes = self.current_bytes();
        self.stats.current_items = items;
        self.stats.current_bytes = bytes;
        self.stats.high_water_items = self.stats.high_water_items.max(items);
        self.stats.high_water_bytes = self.stats.high_water_bytes.max(bytes);
    }

    fn retire_tx(&mut self, tx: &FrameTransaction) {
        self.retired.extend(tx.leases().iter().copied());
        self.stats.retired += tx.leases().len() as u64;
    }

    fn post(&mut self, tx: FrameTransaction) -> Result<PostAccept, PostReject> {
        self.stats.posted += 1;
        if self.cancelled {
            self.retire_tx(&tx);
            self.stats.rejected_cancelled += 1;
            return Err(PostReject::Cancelled);
        }
        if tx.device_epoch() != self.clock.device_epoch() {
            self.retire_tx(&tx);
            self.stats.rejected_device_epoch += 1;
            return Err(PostReject::DeviceEpoch);
        }
        let (previous_epoch, previous_capabilities) = self.previous_surface_state();
        let scene = tx.scene();
        let viewport = Rect::new(
            0.0,
            0.0,
            scene.display_list.width as f32,
            scene.display_list.height as f32,
        );
        if surface_plan_invalid(
            tx.scene_epoch(),
            &scene.surfaces,
            &scene.display_list,
            scene.surface_plan.as_ref(),
            previous_epoch,
            &previous_capabilities,
            viewport,
        ) || compile_passes(&scene.display_list).is_err()
            || tx.properties().validate().is_err()
            || property_epoch_mismatch(&tx)
            || !tx.interaction_epochs_match()
        {
            self.retire_tx(&tx);
            self.stats.rejected_invalid += 1;
            return Err(PostReject::InvalidGraph);
        }
        if tx.byte_size() > self.byte_cap {
            self.retire_tx(&tx);
            self.stats.rejected_oversize += 1;
            return Err(PostReject::Oversize);
        }
        if self.is_stale(&tx) {
            self.retire_tx(&tx);
            self.stats.rejected_stale += 1;
            return Err(PostReject::Stale);
        }

        let dropped = self.pending.take().map(|old| {
            let id = old.frame_id();
            self.retire_tx(&old);
            id
        });
        self.last_seen_frame = Some(tx.frame_id());
        self.last_seen_scene = Some(tx.scene_epoch());
        self.last_seen_generation = self.last_seen_generation.max(tx.generation());
        self.pending = Some(Arc::new(tx));
        self.stats.accepted += 1;
        if dropped.is_some() {
            self.stats.coalesced += 1;
        }
        self.record_depth();
        assert!(
            self.current_items() <= self.item_cap,
            "mailbox item cap exceeded"
        );
        Ok(match dropped {
            Some(id) => PostAccept::Coalesced { dropped: id },
            None => PostAccept::Queued,
        })
    }

    fn previous_surface_state(&self) -> (Option<SceneEpoch>, Vec<(SurfaceId, SurfaceCapability)>) {
        let Some(tx) = self.pending.as_ref().or(self.last_known_good.as_ref()) else {
            return (None, Vec::new());
        };
        let caps = match tx.scene().surface_plan.as_ref() {
            Some(plan) => plan.capabilities(),
            None => tx
                .scene()
                .surfaces
                .iter()
                .filter_map(|spec| spec.capability.map(|capability| (spec.id, capability)))
                .collect(),
        };
        (Some(tx.scene_epoch()), caps)
    }

    fn is_stale(&self, tx: &FrameTransaction) -> bool {
        if let Some(seen) = self.last_seen_frame {
            if tx.frame_id() <= seen {
                return true;
            }
        }
        if let Some(seen) = self.last_seen_scene {
            if tx.scene_epoch() < seen {
                return true;
            }
        }
        if tx.generation() < self.last_seen_generation {
            return true;
        }
        false
    }

    fn try_dequeue(&mut self) -> TryDequeue {
        match self.pending.take() {
            None => {
                self.record_depth();
                TryDequeue::Empty
            }
            Some(tx) => {
                if let Some(previous) = self.last_known_good.replace(Arc::clone(&tx)) {
                    if !Arc::ptr_eq(&previous, &tx) {
                        self.retire_tx(&previous);
                    }
                }
                self.stats.dequeued += 1;
                self.record_depth();
                TryDequeue::Ready(tx)
            }
        }
    }

    fn bump_device_epoch(&mut self) -> DeviceEpoch {
        if let Some(pending) = self.pending.take() {
            self.retire_tx(&pending);
        }
        if let Some(lkg) = self.last_known_good.take() {
            self.retire_tx(&lkg);
        }
        self.logical_snapshot = None;
        self.last_seen_frame = None;
        self.last_seen_scene = None;
        self.last_seen_generation = 0;
        let epoch = self.clock.bump_device();
        self.stats.device_epoch_bumps += 1;
        self.record_depth();
        epoch
    }

    fn remember_logical(&mut self, tx: &Arc<FrameTransaction>) {
        self.logical_snapshot = Some(Arc::clone(tx));
    }

    fn recover_device_epoch(&mut self) -> DeviceEpoch {
        if let Some(pending) = self.pending.take() {
            self.remember_logical(&pending);
            self.retire_tx(&pending);
        }
        if let Some(lkg) = self.last_known_good.take() {
            let same = self
                .logical_snapshot
                .as_ref()
                .is_some_and(|snapshot| Arc::ptr_eq(snapshot, &lkg));
            if !same {
                if self.logical_snapshot.is_none() {
                    self.remember_logical(&lkg);
                }
                self.retire_tx(&lkg);
            }
        }
        let epoch = self.clock.bump_device();
        self.stats.device_epoch_bumps += 1;
        self.record_depth();
        epoch
    }

    fn next_frame_after_seen(&mut self) -> FrameId {
        loop {
            let id = self.clock.next_frame();
            if self.last_seen_frame.map(|seen| id > seen).unwrap_or(true) {
                return id;
            }
        }
    }

    fn rehydrate_logical(&mut self) -> Result<PostAccept, PostReject> {
        if self.pending.is_some() {
            return Ok(PostAccept::Queued);
        }
        let Some(source) = self.logical_snapshot.clone() else {
            return Err(PostReject::Stale);
        };
        let frame = self.next_frame_after_seen();
        let epoch = self.clock.device_epoch();
        let accept = self.post(source.rebind_device(frame, epoch))?;
        self.logical_snapshot = self.pending.clone();
        Ok(accept)
    }

    fn adopt_logical(&mut self, tx: Arc<FrameTransaction>) {
        self.logical_snapshot = Some(tx);
    }

    fn cancel(&mut self) {
        self.cancelled = true;
        self.stats.cancelled += 1;
        if let Some(pending) = self.pending.take() {
            self.retire_tx(&pending);
        }
        self.record_depth();
    }
}

fn property_epoch_mismatch(tx: &FrameTransaction) -> bool {
    let properties = tx.properties();
    !properties.is_empty() && properties.scene_epoch() != tx.scene_epoch()
}

/// Bounded latest-wins mailbox. Render never blocks on this type.
pub struct FrameMailbox {
    inner: Mutex<Inner>,
}

impl FrameMailbox {
    pub fn new(item_cap: usize, byte_cap: usize) -> Self {
        assert!(item_cap >= 1, "FrameMailbox item_cap must be at least 1");
        assert!(byte_cap >= 1, "FrameMailbox byte_cap must be at least 1");
        Self {
            inner: Mutex::new(Inner {
                pending: None,
                last_known_good: None,
                logical_snapshot: None,
                clock: EpochClock::new(),
                last_seen_frame: None,
                last_seen_scene: None,
                last_seen_generation: 0,
                item_cap,
                byte_cap,
                cancelled: false,
                stats: MailboxStats::default(),
                retired: Vec::new(),
            }),
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(DEFAULT_ITEM_CAP, DEFAULT_BYTE_CAP)
    }

    pub fn post(&self, tx: FrameTransaction) -> Result<PostAccept, PostReject> {
        match self.inner.try_lock() {
            Ok(mut inner) => inner.post(tx),
            Err(TryLockError::WouldBlock) => {
                // UI must not wait for render. The caller sees a deterministic reject.
                Err(PostReject::Contended)
            }
            Err(TryLockError::Poisoned(err)) => err.into_inner().post(tx),
        }
    }

    /// Render-side take. Never waits on producer/layout/raster.
    pub fn try_dequeue(&self) -> TryDequeue {
        match self.inner.try_lock() {
            Ok(mut inner) => inner.try_dequeue(),
            Err(TryLockError::WouldBlock) => TryDequeue::Busy,
            Err(TryLockError::Poisoned(err)) => err.into_inner().try_dequeue(),
        }
    }

    pub fn last_known_good(&self) -> Option<Arc<FrameTransaction>> {
        self.lock_inner().last_known_good.clone()
    }

    pub fn device_epoch(&self) -> DeviceEpoch {
        self.lock_inner().clock.device_epoch()
    }

    pub fn bump_device_epoch(&self) -> DeviceEpoch {
        self.lock_inner().bump_device_epoch()
    }

    /// Device-loss path: bump [`DeviceEpoch`], retire GPU leases once, keep
    /// [`SceneEpoch`] and the logical last-known-good snapshot.
    pub fn recover_device_epoch(&self) -> DeviceEpoch {
        self.lock_inner().recover_device_epoch()
    }

    pub fn logical_snapshot(&self) -> Option<Arc<FrameTransaction>> {
        self.lock_inner().logical_snapshot.clone()
    }

    pub fn rehydrate_logical(&self) -> Result<PostAccept, PostReject> {
        match self.inner.try_lock() {
            Ok(mut inner) => inner.rehydrate_logical(),
            Err(TryLockError::WouldBlock) => Err(PostReject::Contended),
            Err(TryLockError::Poisoned(err)) => err.into_inner().rehydrate_logical(),
        }
    }

    pub fn adopt_logical(&self, tx: Arc<FrameTransaction>) {
        self.lock_inner().adopt_logical(tx);
    }

    pub fn cancel(&self) {
        self.lock_inner().cancel();
    }

    pub fn drain_retired(&self) -> Vec<ResourceLease> {
        let mut inner = self.lock_inner();
        std::mem::take(&mut inner.retired)
    }

    pub fn stats(&self) -> MailboxStats {
        self.lock_inner().stats
    }

    pub fn pending_count(&self) -> usize {
        self.lock_inner().current_items()
    }

    pub fn with_lock_held<R>(&self, f: impl FnOnce() -> R) -> R {
        let _guard = self.lock_inner();
        f()
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}
