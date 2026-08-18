//! Bounded GPU telemetry and recovery counters.
//!
//! CPU accounting only. GPU timestamp queries are advertised as
//! [`GpuTimingAvailability::Unavailable`] until shared-device raster interop
//! lands. Not Milestone B PASS and not a production cutover.

use crate::epoch::{DeviceEpoch, SceneEpoch};
use crate::host::PresentationHost;
use crate::mailbox::MailboxStats;
use crate::recovery::{
    DegradedReason, GpuFault, GpuRecovery, RecoveryFrameCause, RecoveryPhase, RecoveryTelemetryView,
};
use crate::transaction::DamageRect;

/// CPU-side byte weight for one layer-cache entry until GPU sizes exist.
pub const LAYER_ACCOUNTING_BYTES: usize = 256 * 1024;
/// CPU-side byte weight for one in-use render target until GPU sizes exist.
pub const TARGET_ACCOUNTING_BYTES: usize = 1024 * 1024;

const TELEMETRY_SIZE_CAP: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameCause {
    Present,
    TimeoutSkip,
    SurfaceRebuild,
    DeviceRehydrate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuTimingAvailability {
    /// Host CPU path: no GPU timestamp queries yet.
    Unavailable,
}

/// Copy-sized snapshot. No event log, no unbounded maps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GpuTelemetry {
    pub queue_bytes: usize,
    pub queue_high_water_bytes: usize,
    pub cache_bytes: usize,
    pub cache_high_water_bytes: usize,
    pub target_bytes: usize,
    pub target_high_water_bytes: usize,
    pub dropped_frames: u64,
    pub coalesced_frames: u64,
    pub recovery_attempt: u32,
    pub last_recovery_reason: Option<GpuFault>,
    pub last_recovery_duration_us: u64,
    pub device_epoch: DeviceEpoch,
    pub scene_epoch: Option<SceneEpoch>,
    pub frame_cause: FrameCause,
    pub damage: DamageRect,
    pub roi: DamageRect,
    pub gpu_timing: GpuTimingAvailability,
    pub degraded_reason: Option<DegradedReason>,
    pub rollback_reason: Option<DegradedReason>,
    pub host: PresentationHost,
    pub recovery_phase: RecoveryPhase,
}

const _: () = assert!(
    std::mem::size_of::<GpuTelemetry>() <= TELEMETRY_SIZE_CAP,
    "GpuTelemetry must stay a bounded snapshot"
);

impl GpuTelemetry {
    fn from_view(view: RecoveryTelemetryView) -> Self {
        let mailbox: MailboxStats = view.mailbox;
        let dropped_frames = view
            .skipped_timeouts
            .saturating_add(mailbox.rejected_stale)
            .saturating_add(mailbox.rejected_oversize)
            .saturating_add(mailbox.rejected_cancelled);
        let rollback_reason = match view.host {
            PresentationHost::WebViewRollback => view.degraded_reason,
            PresentationHost::NeoCompositor { .. } => None,
        };
        Self {
            queue_bytes: mailbox.current_bytes,
            queue_high_water_bytes: mailbox.high_water_bytes,
            cache_bytes: view.cache_len.saturating_mul(LAYER_ACCOUNTING_BYTES),
            cache_high_water_bytes: view
                .cache_high_water_entries
                .saturating_mul(LAYER_ACCOUNTING_BYTES),
            target_bytes: view.targets_in_use.saturating_mul(TARGET_ACCOUNTING_BYTES),
            target_high_water_bytes: view
                .target_high_water
                .saturating_mul(TARGET_ACCOUNTING_BYTES),
            dropped_frames,
            coalesced_frames: mailbox.coalesced,
            recovery_attempt: view.attempt,
            last_recovery_reason: view.last_fault,
            last_recovery_duration_us: view.last_recovery_duration_us,
            device_epoch: view.device_epoch,
            scene_epoch: view.scene_epoch,
            frame_cause: match view.frame_cause {
                RecoveryFrameCause::Present => FrameCause::Present,
                RecoveryFrameCause::TimeoutSkip => FrameCause::TimeoutSkip,
                RecoveryFrameCause::SurfaceRebuild => FrameCause::SurfaceRebuild,
                RecoveryFrameCause::DeviceRehydrate => FrameCause::DeviceRehydrate,
            },
            damage: view.damage,
            roi: view.roi,
            gpu_timing: GpuTimingAvailability::Unavailable,
            degraded_reason: view.degraded_reason,
            rollback_reason,
            host: view.host,
            recovery_phase: view.phase,
        }
    }
}

impl GpuRecovery {
    pub fn telemetry(&self) -> GpuTelemetry {
        GpuTelemetry::from_view(self.telemetry_view())
    }
}
