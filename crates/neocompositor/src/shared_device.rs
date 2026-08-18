//! Shared GPU device and raster↔compositor interop (RFC T18).
//!
//! CPU protocol for a single [`SharedGpuContext`]. Not production JNI, not a
//! cutover, not Milestone B PASS. A real wgpu Instance/Adapter/Device/Queue is
//! opened by the debug probe and bound here; this module refuses a second
//! device and never issues image readback or cross-device copy.

use std::collections::VecDeque;

use crate::epoch::DeviceEpoch;
use crate::host::PresentationHost;
use crate::recovery::{GpuFault, GpuRecovery, RecoveryPhase};
use crate::transaction::{ResourceLease, ResourceLeaseId};

pub const QUEUE_CAP: usize = 8;
pub const LIVE_HANDLE_CAP: usize = 64;
pub const TIMESTAMP_RESOLVE_CAP: u32 = 4;
pub const DEFAULT_FORMAT: SharedFormat = SharedFormat {
    color_space: ColorSpace::Srgb,
    alpha_mode: AlphaMode::Premultiplied,
    texture_format: SharedTextureFormat::Rgba8Unorm,
    usage: TextureUsageFlags::SAMPLE
        .union(TextureUsageFlags::RENDER)
        .union(TextureUsageFlags::COPY_SRC),
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DeviceIdentity(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandleOwner {
    Raster,
    Compositor,
    Glass,
    Surface,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedHandleKind {
    RasterTile,
    Accumulator,
    GlassRoi,
    Surface,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorSpace {
    Srgb,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlphaMode {
    Premultiplied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedTextureFormat {
    Rgba8Unorm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextureUsageFlags(u8);

impl TextureUsageFlags {
    pub const SAMPLE: Self = Self(1 << 0);
    pub const RENDER: Self = Self(1 << 1);
    pub const COPY_SRC: Self = Self(1 << 2);
    pub const COPY_DST: Self = Self(1 << 3);
    pub const CPU_READBACK: Self = Self(1 << 4);

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SharedFormat {
    pub color_space: ColorSpace,
    pub alpha_mode: AlphaMode,
    pub texture_format: SharedTextureFormat,
    pub usage: TextureUsageFlags,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GpuCaps {
    pub compute: bool,
    pub timestamp_queries: bool,
    pub max_texture_dimension_2d: u32,
}

impl GpuCaps {
    pub fn host_default() -> Self {
        Self {
            compute: true,
            timestamp_queries: false,
            max_texture_dimension_2d: 4096,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuTiming {
    Unavailable,
    AsyncBounded { pending: u32, cap: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InteropTelemetry {
    pub image_readbacks: u64,
    pub cross_device_copies: u64,
    pub timestamp_resolves: u64,
    pub timestamp_mode: GpuTiming,
    pub devices: u32,
    pub live_textures: u32,
    pub live_targets: u32,
    pub live_textures_high_water: u32,
    pub live_targets_high_water: u32,
    pub queue_depth: u32,
    pub coalesced_submits: u64,
    pub present_poll_waits: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TypedGpuHandle {
    pub id: u64,
    pub owner: HandleOwner,
    pub kind: SharedHandleKind,
    pub epoch: DeviceEpoch,
    pub identity: DeviceIdentity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BoundBackend {
    pub owner: HandleOwner,
    pub identity: DeviceIdentity,
    pub epoch: DeviceEpoch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadinessToken {
    pub submission: u64,
    pub epoch: DeviceEpoch,
    pub identity: DeviceIdentity,
    pub lease: ResourceLease,
    pub handle_id: u64,
    pub ready: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedGpuError {
    SecondDevice,
    Unsupported,
    Degraded,
    StaleEpoch,
    ForeignDevice,
    ForeignOwner,
    QueueSaturated,
    LiveHandleCap,
    CpuReadbackForbidden,
    CrossDeviceCopyForbidden,
    PollWaitForbidden,
    MixedEpoch,
}

impl std::fmt::Display for SharedGpuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match *self {
            Self::SecondDevice => "second GPU device is forbidden",
            Self::Unsupported => "gpu capability unsupported",
            Self::Degraded => "gpu context is degraded",
            Self::StaleEpoch => "gpu handle epoch is stale",
            Self::ForeignDevice => "gpu handle is from another device",
            Self::ForeignOwner => "gpu handle owner mismatch",
            Self::QueueSaturated => "gpu submission queue is saturated",
            Self::LiveHandleCap => "live gpu handle cap exceeded",
            Self::CpuReadbackForbidden => "cpu image readback is forbidden",
            Self::CrossDeviceCopyForbidden => "cross-device copy is forbidden",
            Self::PollWaitForbidden => "device.poll(wait) is forbidden in present",
            Self::MixedEpoch => "live gpu handles mix device epochs",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InteropPresentOutcome {
    Presented { submission: u64 },
    SkippedNotReady,
}

struct InFlight {
    token: ReadinessToken,
    dropped: bool,
}

/// Single shared GPU context. Raster and compositor bind; they do not open a
/// second device.
pub struct SharedGpuContext {
    identity: DeviceIdentity,
    epoch: DeviceEpoch,
    format: SharedFormat,
    caps: GpuCaps,
    host: PresentationHost,
    phase: RecoveryPhase,
    raster: Option<BoundBackend>,
    compositor: Option<BoundBackend>,
    live: Vec<TypedGpuHandle>,
    inflight: VecDeque<InFlight>,
    retained: Vec<ResourceLease>,
    next_handle: u64,
    next_submission: u64,
    next_lease: u64,
    timestamp_pending: u32,
    telemetry: InteropTelemetry,
    opened: bool,
}

impl SharedGpuContext {
    pub fn open(caps: GpuCaps) -> Result<Self, SharedGpuError> {
        Self::open_with_identity(DeviceIdentity(1), caps)
    }

    pub fn open_with_identity(
        identity: DeviceIdentity,
        caps: GpuCaps,
    ) -> Result<Self, SharedGpuError> {
        if DEFAULT_FORMAT
            .usage
            .contains(TextureUsageFlags::CPU_READBACK)
        {
            return Err(SharedGpuError::CpuReadbackForbidden);
        }
        let mut ctx = Self {
            identity,
            epoch: DeviceEpoch(0),
            format: DEFAULT_FORMAT,
            caps,
            host: PresentationHost::NeoCompositor { feature_flag: true },
            phase: RecoveryPhase::Ready,
            raster: None,
            compositor: None,
            live: Vec::new(),
            inflight: VecDeque::new(),
            retained: Vec::new(),
            next_handle: 1,
            next_submission: 1,
            next_lease: 1,
            timestamp_pending: 0,
            telemetry: InteropTelemetry {
                image_readbacks: 0,
                cross_device_copies: 0,
                timestamp_resolves: 0,
                timestamp_mode: GpuTiming::Unavailable,
                devices: 1,
                live_textures: 0,
                live_targets: 0,
                live_textures_high_water: 0,
                live_targets_high_water: 0,
                queue_depth: 0,
                coalesced_submits: 0,
                present_poll_waits: 0,
            },
            opened: true,
        };
        ctx.telemetry.timestamp_mode = ctx.timestamp_mode();
        if !caps.compute {
            ctx.degrade();
        }
        Ok(ctx)
    }

    pub fn identity(&self) -> DeviceIdentity {
        self.identity
    }

    pub fn device_epoch(&self) -> DeviceEpoch {
        self.epoch
    }

    pub fn format(&self) -> SharedFormat {
        self.format
    }

    pub fn host(&self) -> PresentationHost {
        self.host
    }

    pub fn phase(&self) -> RecoveryPhase {
        self.phase
    }

    pub fn telemetry(&self) -> InteropTelemetry {
        let mut snap = self.telemetry;
        snap.timestamp_mode = self.timestamp_mode();
        snap.queue_depth = self.inflight.len() as u32;
        snap.live_textures = self.count_kind(SharedHandleKind::RasterTile);
        snap.live_targets = self.count_kind(SharedHandleKind::Accumulator)
            + self.count_kind(SharedHandleKind::GlassRoi);
        snap
    }

    pub fn bind_raster(&mut self) -> Result<BoundBackend, SharedGpuError> {
        self.require_ready()?;
        let bound = BoundBackend {
            owner: HandleOwner::Raster,
            identity: self.identity,
            epoch: self.epoch,
        };
        self.raster = Some(bound);
        Ok(bound)
    }

    pub fn bind_compositor(&mut self) -> Result<BoundBackend, SharedGpuError> {
        self.require_ready()?;
        let bound = BoundBackend {
            owner: HandleOwner::Compositor,
            identity: self.identity,
            epoch: self.epoch,
        };
        self.compositor = Some(bound);
        Ok(bound)
    }

    pub fn alloc(
        &mut self,
        owner: HandleOwner,
        kind: SharedHandleKind,
    ) -> Result<TypedGpuHandle, SharedGpuError> {
        self.require_ready()?;
        if self.live.len() >= LIVE_HANDLE_CAP {
            return Err(SharedGpuError::LiveHandleCap);
        }
        let handle = TypedGpuHandle {
            id: self.next_handle,
            owner,
            kind,
            epoch: self.epoch,
            identity: self.identity,
        };
        self.next_handle = self.next_handle.saturating_add(1);
        self.live.push(handle);
        self.record_live();
        Ok(handle)
    }

    pub fn raster_tile(&mut self) -> Result<TypedGpuHandle, SharedGpuError> {
        let raster = self.raster.ok_or(SharedGpuError::ForeignOwner)?;
        if raster.identity != self.identity || raster.epoch != self.epoch {
            return Err(SharedGpuError::StaleEpoch);
        }
        self.alloc(HandleOwner::Raster, SharedHandleKind::RasterTile)
    }

    pub fn sample_tile(
        &mut self,
        handle: TypedGpuHandle,
    ) -> Result<ReadinessToken, SharedGpuError> {
        self.require_ready()?;
        self.reject_handle(handle, HandleOwner::Raster)?;
        if handle.kind != SharedHandleKind::RasterTile {
            return Err(SharedGpuError::ForeignOwner);
        }
        self.enqueue(handle)
    }

    pub fn present(&mut self) -> Result<InteropPresentOutcome, SharedGpuError> {
        self.require_ready()?;
        if self.telemetry.present_poll_waits != 0 {
            return Err(SharedGpuError::PollWaitForbidden);
        }
        let Some(front) = self.inflight.front() else {
            return Ok(InteropPresentOutcome::SkippedNotReady);
        };
        if !front.token.ready {
            return Ok(InteropPresentOutcome::SkippedNotReady);
        }
        if front.dropped {
            return Ok(InteropPresentOutcome::SkippedNotReady);
        }
        if front.token.epoch != self.epoch || front.token.identity != self.identity {
            return Err(SharedGpuError::StaleEpoch);
        }
        Ok(InteropPresentOutcome::Presented {
            submission: front.token.submission,
        })
    }

    /// Non-blocking GPU completion. Present must not call this as `wait`.
    pub fn complete_oldest(&mut self) -> Option<ReadinessToken> {
        let done = self.inflight.pop_front()?;
        self.release_lease(done.token.lease);
        self.retire_handle(done.token.handle_id);
        Some(done.token)
    }

    pub fn drop_pending_latest_wins(&mut self) {
        if let Some(back) = self.inflight.back_mut() {
            back.dropped = true;
            self.telemetry.coalesced_submits = self.telemetry.coalesced_submits.saturating_add(1);
        }
    }

    pub fn lease_held(&self, id: ResourceLeaseId) -> bool {
        self.retained.iter().any(|lease| lease.id == id)
            || self
                .inflight
                .iter()
                .any(|flight| flight.token.lease.id == id)
    }

    pub fn on_device_lost(
        &mut self,
        recovery: &mut GpuRecovery,
    ) -> Result<DeviceEpoch, SharedGpuError> {
        recovery
            .notify_fault(GpuFault::DeviceLost)
            .map_err(|_| SharedGpuError::Degraded)?;
        if recovery.phase() == RecoveryPhase::Degraded {
            self.degrade();
            return Err(SharedGpuError::Degraded);
        }
        self.epoch = recovery.device_epoch();
        self.live.clear();
        self.inflight.clear();
        self.retained.clear();
        self.timestamp_pending = 0;
        if let Some(raster) = &mut self.raster {
            raster.epoch = self.epoch;
        }
        if let Some(compositor) = &mut self.compositor {
            compositor.epoch = self.epoch;
        }
        self.record_live();
        Ok(self.epoch)
    }

    pub fn request_timestamp(&mut self) -> GpuTiming {
        if !self.caps.timestamp_queries {
            return GpuTiming::Unavailable;
        }
        if self.timestamp_pending >= TIMESTAMP_RESOLVE_CAP {
            return GpuTiming::AsyncBounded {
                pending: self.timestamp_pending,
                cap: TIMESTAMP_RESOLVE_CAP,
            };
        }
        self.timestamp_pending = self.timestamp_pending.saturating_add(1);
        GpuTiming::AsyncBounded {
            pending: self.timestamp_pending,
            cap: TIMESTAMP_RESOLVE_CAP,
        }
    }

    /// Async, bounded timestamp resolve. Never called from [`Self::present`].
    pub fn resolve_timestamps_async(&mut self) {
        if self.timestamp_pending == 0 {
            return;
        }
        let n = self.timestamp_pending.min(TIMESTAMP_RESOLVE_CAP);
        self.telemetry.timestamp_resolves =
            self.telemetry.timestamp_resolves.saturating_add(n as u64);
        self.timestamp_pending = 0;
    }

    pub fn copy_same_device(&mut self) -> Result<(), SharedGpuError> {
        self.require_ready()?;
        Ok(())
    }

    pub fn image_readback(&mut self) -> Result<(), SharedGpuError> {
        Err(SharedGpuError::CpuReadbackForbidden)
    }

    pub fn validate_surface(&self, handle: TypedGpuHandle) -> Result<(), SharedGpuError> {
        self.require_ready()?;
        self.reject_handle(handle, HandleOwner::Surface)?;
        if handle.kind != SharedHandleKind::Surface {
            return Err(SharedGpuError::ForeignOwner);
        }
        Ok(())
    }

    pub fn alloc_surface(&mut self) -> Result<TypedGpuHandle, SharedGpuError> {
        self.alloc(HandleOwner::Surface, SharedHandleKind::Surface)
    }

    pub fn cross_device_copy(&mut self) -> Result<(), SharedGpuError> {
        Err(SharedGpuError::CrossDeviceCopyForbidden)
    }

    pub fn poll_wait_in_present(&mut self) -> Result<(), SharedGpuError> {
        Err(SharedGpuError::PollWaitForbidden)
    }

    fn enqueue(&mut self, handle: TypedGpuHandle) -> Result<ReadinessToken, SharedGpuError> {
        if self.inflight.len() >= QUEUE_CAP {
            return Err(SharedGpuError::QueueSaturated);
        }
        let lease = ResourceLease {
            id: ResourceLeaseId(self.next_lease),
            device_epoch: self.epoch,
        };
        self.next_lease = self.next_lease.saturating_add(1);
        let token = ReadinessToken {
            submission: self.next_submission,
            epoch: self.epoch,
            identity: self.identity,
            lease,
            handle_id: handle.id,
            ready: true,
        };
        self.next_submission = self.next_submission.saturating_add(1);
        self.retained.push(lease);
        self.inflight.push_back(InFlight {
            token,
            dropped: false,
        });
        Ok(token)
    }

    fn reject_handle(
        &self,
        handle: TypedGpuHandle,
        expected: HandleOwner,
    ) -> Result<(), SharedGpuError> {
        if handle.identity != self.identity {
            return Err(SharedGpuError::ForeignDevice);
        }
        if handle.epoch != self.epoch {
            return Err(SharedGpuError::StaleEpoch);
        }
        if handle.owner != expected {
            return Err(SharedGpuError::ForeignOwner);
        }
        if !self.live.iter().any(|live| live.id == handle.id) {
            return Err(SharedGpuError::StaleEpoch);
        }
        if self.live.iter().any(|live| live.epoch != self.epoch) {
            return Err(SharedGpuError::MixedEpoch);
        }
        Ok(())
    }

    fn retire_handle(&mut self, handle_id: u64) {
        self.live.retain(|handle| handle.id != handle_id);
        self.record_live();
    }

    fn release_lease(&mut self, lease: ResourceLease) {
        self.retained.retain(|held| held.id != lease.id);
    }

    fn record_live(&mut self) {
        let textures = self.count_kind(SharedHandleKind::RasterTile);
        let targets = self.count_kind(SharedHandleKind::Accumulator)
            + self.count_kind(SharedHandleKind::GlassRoi);
        self.telemetry.live_textures = textures;
        self.telemetry.live_targets = targets;
        self.telemetry.live_textures_high_water =
            self.telemetry.live_textures_high_water.max(textures);
        self.telemetry.live_targets_high_water =
            self.telemetry.live_targets_high_water.max(targets);
        self.telemetry.queue_depth = self.inflight.len() as u32;
    }

    fn count_kind(&self, kind: SharedHandleKind) -> u32 {
        self.live
            .iter()
            .filter(|handle| handle.kind == kind)
            .count() as u32
    }

    fn timestamp_mode(&self) -> GpuTiming {
        if !self.caps.timestamp_queries {
            GpuTiming::Unavailable
        } else {
            GpuTiming::AsyncBounded {
                pending: self.timestamp_pending,
                cap: TIMESTAMP_RESOLVE_CAP,
            }
        }
    }

    fn require_ready(&self) -> Result<(), SharedGpuError> {
        if self.phase == RecoveryPhase::Degraded {
            return Err(SharedGpuError::Degraded);
        }
        if !self.opened {
            return Err(SharedGpuError::SecondDevice);
        }
        Ok(())
    }

    fn degrade(&mut self) {
        self.phase = RecoveryPhase::Degraded;
        self.host = PresentationHost::WebViewRollback;
        self.telemetry.devices = 0;
        self.live.clear();
        self.inflight.clear();
    }
}

/// Opens at most one [`SharedGpuContext`].
pub struct SharedGpuFactory {
    ctx: Option<SharedGpuContext>,
}

impl SharedGpuFactory {
    pub fn new() -> Self {
        Self { ctx: None }
    }

    pub fn open(&mut self, caps: GpuCaps) -> Result<&mut SharedGpuContext, SharedGpuError> {
        if self.ctx.is_some() {
            return Err(SharedGpuError::SecondDevice);
        }
        self.ctx = Some(SharedGpuContext::open(caps)?);
        Ok(self.ctx.as_mut().expect("just inserted"))
    }

    pub fn devices_created(&self) -> u32 {
        u32::from(self.ctx.is_some())
    }

    pub fn get(&self) -> Option<&SharedGpuContext> {
        self.ctx.as_ref()
    }

    pub fn get_mut(&mut self) -> Option<&mut SharedGpuContext> {
        self.ctx.as_mut()
    }
}

impl Default for SharedGpuFactory {
    fn default() -> Self {
        Self::new()
    }
}
