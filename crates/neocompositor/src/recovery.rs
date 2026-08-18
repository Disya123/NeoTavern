//! Device and surface recovery (RFC §36 / T13).
//!
//! CPU state machine only. Not production JNI, not Milestone B PASS, not a
//! cutover. GPU textures, targets, pipelines, and fences are disposable.
//! [`SceneEpoch`] and product snapshots survive; [`DeviceEpoch`] does not.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use crate::epoch::{DeviceEpoch, SceneEpoch};
use crate::fast_path::CompositorFastPath;
use crate::host::PresentationHost;
use crate::layer_cache::{LayerCache, LayerKey};
use crate::mailbox::{FrameMailbox, MailboxStats, PostAccept, PostReject, TryDequeue};
use crate::selection::SelectionSession;
use crate::target_pool::{TargetId, TargetPool};
use crate::transaction::{DamageRect, FrameTransaction, ResourceLease, ResourceLeaseId};

pub const DEFAULT_RECOVERY_ATTEMPT_CAP: u32 = 3;
const CACHE_CAP: usize = 32;
const TARGET_CAP: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuFault {
    Timeout,
    SurfaceOutdated,
    SurfaceLost,
    DeviceLost,
    OutOfMemory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryPhase {
    Uninitialized,
    Ready,
    LossDetected,
    Quiescing,
    Recreating,
    Rehydrating,
    Degraded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DegradedReason {
    RetryCap,
    OutOfMemory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuHandleKind {
    Texture,
    Target,
    Pipeline,
    Surface,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GpuHandle {
    pub id: u64,
    pub kind: GpuHandleKind,
    pub device_epoch: DeviceEpoch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GpuCallback {
    pub id: u64,
    pub device_epoch: DeviceEpoch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallbackReject {
    StaleEpoch,
    Degraded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitReject {
    NothingInFlight,
    StaleEpoch,
    Degraded,
    MixedEpochHandle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryError {
    LeaseRetiredTwice(ResourceLeaseId),
    RetryCap,
    OutOfMemory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryOutcome {
    SkippedTimeout,
    SurfaceRebuilt { device_epoch: DeviceEpoch },
    DeviceRebuilt { device_epoch: DeviceEpoch },
    Degraded { reason: DegradedReason },
}

struct SurfaceConfig {
    generation: u64,
    device_epoch: DeviceEpoch,
}

struct DeviceBoundResources {
    epoch: DeviceEpoch,
    cache: LayerCache,
    targets: TargetPool,
    handles: Vec<GpuHandle>,
    surface: Option<SurfaceConfig>,
    next_handle: u64,
}

impl DeviceBoundResources {
    fn new(epoch: DeviceEpoch) -> Self {
        Self {
            epoch,
            cache: LayerCache::new(CACHE_CAP),
            targets: TargetPool::new(TARGET_CAP),
            handles: Vec::new(),
            surface: None,
            next_handle: 1,
        }
    }

    fn alloc(&mut self, kind: GpuHandleKind) -> GpuHandle {
        let handle = GpuHandle {
            id: self.next_handle,
            kind,
            device_epoch: self.epoch,
        };
        self.next_handle = self.next_handle.saturating_add(1);
        self.handles.push(handle);
        handle
    }

    fn recreate_surface(&mut self) -> u64 {
        let generation = self
            .surface
            .as_ref()
            .map(|surface| surface.generation.saturating_add(1))
            .unwrap_or(1);
        self.handles
            .retain(|handle| handle.kind != GpuHandleKind::Surface);
        self.surface = Some(SurfaceConfig {
            generation,
            device_epoch: self.epoch,
        });
        let _ = self.alloc(GpuHandleKind::Surface);
        generation
    }

    fn destroy_for_new_device(&mut self, epoch: DeviceEpoch) {
        self.cache.clear();
        let _ = self.targets.destroy_device_bound();
        self.handles.clear();
        self.surface = None;
        self.next_handle = 1;
        self.epoch = epoch;
    }

    fn has_epoch(&self, epoch: DeviceEpoch) -> bool {
        self.epoch == epoch
            || self
                .handles
                .iter()
                .any(|handle| handle.device_epoch == epoch)
            || self
                .surface
                .as_ref()
                .is_some_and(|surface| surface.device_epoch == epoch)
    }
}

/// Present-loop recovery owner. Mailbox stays bounded / latest-wins.
pub struct GpuRecovery {
    phase: RecoveryPhase,
    mailbox: FrameMailbox,
    gpu: DeviceBoundResources,
    fast_path: CompositorFastPath,
    selection: Option<SelectionSession>,
    in_flight: Option<Arc<FrameTransaction>>,
    stale_submit: bool,
    attempt: u32,
    attempt_cap: u32,
    skipped_timeouts: u64,
    last_fault: Option<GpuFault>,
    degraded_reason: Option<DegradedReason>,
    host: PresentationHost,
    retired: HashSet<ResourceLeaseId>,
    cache_high_water_entries: usize,
    target_high_water: usize,
    last_recovery_started: Option<Instant>,
    last_recovery_duration_us: u64,
    last_damage: DamageRect,
    last_roi: DamageRect,
    frame_cause: RecoveryFrameCause,
}

impl GpuRecovery {
    pub fn new() -> Self {
        Self::with_attempt_cap(DEFAULT_RECOVERY_ATTEMPT_CAP)
    }

    pub fn with_attempt_cap(attempt_cap: u32) -> Self {
        assert!(attempt_cap >= 1, "recovery attempt cap must be at least 1");
        Self {
            phase: RecoveryPhase::Uninitialized,
            mailbox: FrameMailbox::with_defaults(),
            gpu: DeviceBoundResources::new(DeviceEpoch(0)),
            fast_path: CompositorFastPath::new(),
            selection: None,
            in_flight: None,
            stale_submit: false,
            attempt: 0,
            attempt_cap,
            skipped_timeouts: 0,
            last_fault: None,
            degraded_reason: None,
            host: PresentationHost::NeoCompositor { feature_flag: true },
            retired: HashSet::new(),
            cache_high_water_entries: 0,
            target_high_water: 0,
            last_recovery_started: None,
            last_recovery_duration_us: 0,
            last_damage: DamageRect::EMPTY,
            last_roi: DamageRect::EMPTY,
            frame_cause: RecoveryFrameCause::Present,
        }
    }

    pub fn initialize(&mut self) -> Result<(), RecoveryError> {
        self.phase = RecoveryPhase::Ready;
        self.gpu = DeviceBoundResources::new(self.mailbox.device_epoch());
        let _ = self.gpu.recreate_surface();
        self.host = PresentationHost::NeoCompositor { feature_flag: true };
        Ok(())
    }

    pub fn phase(&self) -> RecoveryPhase {
        self.phase
    }

    pub fn host(&self) -> PresentationHost {
        self.host
    }

    pub fn device_epoch(&self) -> DeviceEpoch {
        self.gpu.epoch
    }

    pub fn mailbox_device_epoch(&self) -> DeviceEpoch {
        self.mailbox.device_epoch()
    }

    pub fn devices(&self) -> u32 {
        match self.phase {
            RecoveryPhase::Uninitialized | RecoveryPhase::Degraded => 0,
            _ => 1,
        }
    }

    pub fn surface_generation(&self) -> u64 {
        self.gpu
            .surface
            .as_ref()
            .map(|surface| surface.generation)
            .unwrap_or(0)
    }

    pub fn skipped_timeouts(&self) -> u64 {
        self.skipped_timeouts
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn last_fault(&self) -> Option<GpuFault> {
        self.last_fault
    }

    pub fn last_recovery_duration_us(&self) -> u64 {
        self.last_recovery_duration_us
    }

    pub fn cache_high_water(&self) -> usize {
        self.cache_high_water_entries
    }

    pub fn target_high_water(&self) -> usize {
        self.target_high_water
    }

    pub fn degraded_reason(&self) -> Option<DegradedReason> {
        self.degraded_reason
    }

    pub fn mailbox(&self) -> &FrameMailbox {
        &self.mailbox
    }

    pub fn fast_path(&self) -> &CompositorFastPath {
        &self.fast_path
    }

    pub fn fast_path_mut(&mut self) -> &mut CompositorFastPath {
        &mut self.fast_path
    }

    pub fn selection(&self) -> Option<&SelectionSession> {
        self.selection.as_ref()
    }

    pub fn set_selection(&mut self, selection: SelectionSession) {
        self.selection = Some(selection);
    }

    pub fn post(&self, tx: FrameTransaction) -> Result<PostAccept, PostReject> {
        self.mailbox.post(tx)
    }

    pub fn cache_insert(&mut self, key: LayerKey) {
        self.gpu.cache.insert(key);
        self.cache_high_water_entries = self.cache_high_water_entries.max(self.gpu.cache.len());
    }

    pub fn cache_len(&self) -> usize {
        self.gpu.cache.len()
    }

    pub fn acquire_target(&mut self) -> Result<TargetId, crate::target_pool::TargetPoolError> {
        let id = self.gpu.targets.acquire()?;
        self.target_high_water = self.target_high_water.max(self.gpu.targets.in_use_count());
        Ok(id)
    }

    pub fn targets_in_use(&self) -> usize {
        self.gpu.targets.in_use_count()
    }

    pub fn alloc_handle(&mut self, kind: GpuHandleKind) -> GpuHandle {
        self.gpu.alloc(kind)
    }

    pub fn live_handles(&self) -> &[GpuHandle] {
        &self.gpu.handles
    }

    pub fn has_device_epoch(&self, epoch: DeviceEpoch) -> bool {
        self.gpu.has_epoch(epoch)
            || self
                .in_flight
                .as_ref()
                .is_some_and(|tx| tx.device_epoch() == epoch)
            || self.mailbox.device_epoch() == epoch
    }

    pub fn retired_lease_count(&self) -> usize {
        self.retired.len()
    }

    pub fn logical_snapshot(&self) -> Option<Arc<FrameTransaction>> {
        self.mailbox.logical_snapshot()
    }

    pub fn complete_callback(&self, callback: GpuCallback) -> Result<(), CallbackReject> {
        if self.phase == RecoveryPhase::Degraded {
            return Err(CallbackReject::Degraded);
        }
        if callback.device_epoch != self.gpu.epoch {
            return Err(CallbackReject::StaleEpoch);
        }
        Ok(())
    }

    pub fn dequeue_for_submit(&mut self) -> Option<Arc<FrameTransaction>> {
        match self.mailbox.try_dequeue() {
            TryDequeue::Ready(tx) => {
                self.stale_submit = false;
                self.capture_tx(&tx);
                self.in_flight = Some(Arc::clone(&tx));
                Some(tx)
            }
            _ => None,
        }
    }

    pub fn submit(&mut self) -> Result<Arc<FrameTransaction>, SubmitReject> {
        if self.phase == RecoveryPhase::Degraded {
            self.in_flight = None;
            self.stale_submit = false;
            return Err(SubmitReject::Degraded);
        }
        if self.stale_submit {
            self.stale_submit = false;
            self.in_flight = None;
            return Err(SubmitReject::StaleEpoch);
        }
        let Some(tx) = self.in_flight.take() else {
            return Err(SubmitReject::NothingInFlight);
        };
        if tx.device_epoch() != self.gpu.epoch || tx.device_epoch() != self.mailbox.device_epoch() {
            return Err(SubmitReject::StaleEpoch);
        }
        if self
            .gpu
            .handles
            .iter()
            .any(|handle| handle.device_epoch != self.gpu.epoch)
        {
            return Err(SubmitReject::MixedEpochHandle);
        }
        let _ = self.gpu.alloc(GpuHandleKind::Texture);
        self.frame_cause = RecoveryFrameCause::Present;
        self.capture_tx(&tx);
        Ok(tx)
    }

    pub fn notify_fault(&mut self, fault: GpuFault) -> Result<RecoveryOutcome, RecoveryError> {
        self.last_fault = Some(fault);
        if self.phase == RecoveryPhase::Degraded {
            return Ok(RecoveryOutcome::Degraded {
                reason: self.degraded_reason.unwrap_or(DegradedReason::RetryCap),
            });
        }
        match fault {
            GpuFault::Timeout => {
                self.skipped_timeouts = self.skipped_timeouts.saturating_add(1);
                self.frame_cause = RecoveryFrameCause::TimeoutSkip;
                Ok(RecoveryOutcome::SkippedTimeout)
            }
            GpuFault::OutOfMemory => {
                self.last_recovery_duration_us = 0;
                self.degrade(DegradedReason::OutOfMemory);
                Ok(RecoveryOutcome::Degraded {
                    reason: DegradedReason::OutOfMemory,
                })
            }
            GpuFault::SurfaceOutdated | GpuFault::SurfaceLost => self.recover_surface(),
            GpuFault::DeviceLost => {
                self.begin_device_recovery()?;
                self.finish_rehydrate()?;
                Ok(RecoveryOutcome::DeviceRebuilt {
                    device_epoch: self.gpu.epoch,
                })
            }
        }
    }

    pub fn begin_device_recovery(&mut self) -> Result<DeviceEpoch, RecoveryError> {
        self.enter_loss(GpuFault::DeviceLost)?;
        self.phase = RecoveryPhase::Recreating;
        self.last_recovery_started = Some(Instant::now());
        let epoch = self.mailbox.recover_device_epoch();
        self.gpu.destroy_for_new_device(epoch);
        self.absorb_retired()?;
        if self.in_flight.take().is_some() {
            self.stale_submit = true;
        }
        debug_assert_eq!(self.devices(), 1);
        Ok(epoch)
    }

    pub fn finish_rehydrate(&mut self) -> Result<Option<Arc<FrameTransaction>>, RecoveryError> {
        if self.phase == RecoveryPhase::Degraded {
            return Err(RecoveryError::RetryCap);
        }
        self.phase = RecoveryPhase::Rehydrating;
        if self.mailbox.pending_count() == 0 {
            let _ = self.mailbox.rehydrate_logical();
        }
        let restored = match self.mailbox.try_dequeue() {
            TryDequeue::Ready(tx) => tx,
            _ => {
                self.record_recovery_duration();
                self.frame_cause = RecoveryFrameCause::DeviceRehydrate;
                self.phase = RecoveryPhase::Ready;
                return Ok(None);
            }
        };
        debug_assert_eq!(restored.device_epoch(), self.gpu.epoch);
        debug_assert!(restored
            .leases()
            .iter()
            .all(|lease| lease.device_epoch == self.gpu.epoch));
        debug_assert!(!self
            .live_handles()
            .iter()
            .any(|handle| handle.device_epoch.0 < self.gpu.epoch.0));
        self.mailbox.adopt_logical(Arc::clone(&restored));
        self.record_recovery_duration();
        self.frame_cause = RecoveryFrameCause::DeviceRehydrate;
        self.capture_tx(&restored);
        let _ = self.gpu.recreate_surface();
        let _ = self.gpu.alloc(GpuHandleKind::Pipeline);
        self.phase = RecoveryPhase::Ready;
        Ok(Some(restored))
    }

    fn recover_surface(&mut self) -> Result<RecoveryOutcome, RecoveryError> {
        if self.phase == RecoveryPhase::Degraded {
            return Ok(RecoveryOutcome::Degraded {
                reason: self.degraded_reason.unwrap_or(DegradedReason::RetryCap),
            });
        }
        self.phase = RecoveryPhase::LossDetected;
        self.phase = RecoveryPhase::Quiescing;
        self.phase = RecoveryPhase::Recreating;
        self.last_recovery_started = Some(Instant::now());
        let _ = self.gpu.recreate_surface();
        self.record_recovery_duration();
        self.frame_cause = RecoveryFrameCause::SurfaceRebuild;
        self.phase = RecoveryPhase::Ready;
        Ok(RecoveryOutcome::SurfaceRebuilt {
            device_epoch: self.gpu.epoch,
        })
    }

    fn enter_loss(&mut self, fault: GpuFault) -> Result<(), RecoveryError> {
        if self.attempt >= self.attempt_cap {
            self.degrade(DegradedReason::RetryCap);
            return Err(RecoveryError::RetryCap);
        }
        self.attempt = self.attempt.saturating_add(1);
        self.last_fault = Some(fault);
        self.phase = RecoveryPhase::LossDetected;
        self.phase = RecoveryPhase::Quiescing;
        Ok(())
    }

    fn degrade(&mut self, reason: DegradedReason) {
        self.phase = RecoveryPhase::Degraded;
        self.degraded_reason = Some(reason);
        self.host = PresentationHost::WebViewRollback;
        self.in_flight = None;
        self.stale_submit = false;
        self.gpu.destroy_for_new_device(self.gpu.epoch);
        let _ = self.mailbox.drain_retired();
    }

    fn absorb_retired(&mut self) -> Result<(), RecoveryError> {
        for lease in self.mailbox.drain_retired() {
            if !self.retired.insert(lease.id) {
                return Err(RecoveryError::LeaseRetiredTwice(lease.id));
            }
        }
        Ok(())
    }

    pub fn absorb_mailbox_retired(&mut self) -> Result<(), RecoveryError> {
        self.absorb_retired()
    }

    pub fn reject_stale_retirement(&self, lease: ResourceLease) -> bool {
        lease.device_epoch != self.gpu.epoch || self.retired.contains(&lease.id)
    }

    fn capture_tx(&mut self, tx: &FrameTransaction) {
        let damage = tx
            .damage()
            .iter()
            .copied()
            .fold(DamageRect::EMPTY, DamageRect::union);
        self.last_damage = damage;
        self.last_roi = tx
            .scene()
            .glass
            .first()
            .map(|glass| DamageRect::from_rect(glass.roi))
            .unwrap_or(damage);
    }

    fn record_recovery_duration(&mut self) {
        if let Some(start) = self.last_recovery_started.take() {
            self.last_recovery_duration_us =
                u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX);
        }
    }

    pub(crate) fn telemetry_view(&self) -> RecoveryTelemetryView {
        RecoveryTelemetryView {
            phase: self.phase,
            device_epoch: self.gpu.epoch,
            scene_epoch: self
                .mailbox
                .last_known_good()
                .or_else(|| self.mailbox.logical_snapshot())
                .map(|tx| tx.scene_epoch()),
            cache_len: self.gpu.cache.len(),
            cache_high_water_entries: self.cache_high_water_entries,
            targets_in_use: self.gpu.targets.in_use_count(),
            target_high_water: self.target_high_water,
            skipped_timeouts: self.skipped_timeouts,
            attempt: self.attempt,
            last_fault: self.last_fault,
            last_recovery_duration_us: self.last_recovery_duration_us,
            damage: self.last_damage,
            roi: self.last_roi,
            degraded_reason: self.degraded_reason,
            host: self.host,
            frame_cause: self.frame_cause,
            mailbox: self.mailbox.stats(),
        }
    }
}

impl Default for GpuRecovery {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryFrameCause {
    Present,
    TimeoutSkip,
    SurfaceRebuild,
    DeviceRehydrate,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RecoveryTelemetryView {
    pub phase: RecoveryPhase,
    pub device_epoch: DeviceEpoch,
    pub scene_epoch: Option<SceneEpoch>,
    pub cache_len: usize,
    pub cache_high_water_entries: usize,
    pub targets_in_use: usize,
    pub target_high_water: usize,
    pub skipped_timeouts: u64,
    pub attempt: u32,
    pub last_fault: Option<GpuFault>,
    pub last_recovery_duration_us: u64,
    pub damage: DamageRect,
    pub roi: DamageRect,
    pub degraded_reason: Option<DegradedReason>,
    pub host: PresentationHost,
    pub frame_cause: RecoveryFrameCause,
    pub mailbox: MailboxStats,
}
