//! Milestone B VisualSurface frame ingress (ADR-0050 / RFC §29).
//!
//! Trusted, ephemeral, generation-safe. Not Plugin SDK, not Milestone D,
//! not a public `PluginVisualSurface`. Product Wire carries only the
//! logical declare; this queue never stores a `wgpu::Device`.

use std::collections::HashMap;

use crate::display_list::Rect;
use crate::epoch::{DeviceEpoch, PresentationTime};
use crate::shared_device::{
    SharedGpuContext, SharedGpuError, SharedTextureFormat, TextureUsageFlags, TypedGpuHandle,
    DEFAULT_FORMAT,
};
use crate::surface_fallback::{FallbackPolicy, SurfaceId};

pub const INGRESS_ITEM_CAP: usize = 1;
pub const INGRESS_SURFACE_CAP: usize = 8;
pub const INGRESS_BYTE_QUOTA: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisualSurfaceDeclare {
    pub wire_surface_id: String,
    pub generation: u64,
    pub width: u32,
    pub height: u32,
    pub sampleable: bool,
    pub policy: FallbackPolicy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceContent {
    Sampleable {
        handle: TypedGpuHandle,
        width: u32,
        height: u32,
        format: SharedTextureFormat,
        usage: TextureUsageFlags,
        bytes: usize,
    },
    NotReady,
}

impl SurfaceContent {
    pub fn bytes(self) -> usize {
        match self {
            Self::Sampleable { bytes, .. } => bytes,
            Self::NotReady => 0,
        }
    }

    pub fn is_ready(self) -> bool {
        matches!(self, Self::Sampleable { .. })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SurfaceFence {
    pub ready: bool,
    pub device_epoch: DeviceEpoch,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceFrame {
    pub surface: SurfaceId,
    pub generation: u64,
    pub sequence: u64,
    pub timestamp: PresentationTime,
    pub content: SurfaceContent,
    pub damage: Option<Rect>,
    pub fence: Option<SurfaceFence>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IngressDropReason {
    Late,
    NotReady,
    Coalesced,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IngressAccept {
    Queued,
    Coalesced { dropped_sequence: u64 },
    Dropped { reason: IngressDropReason },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IngressReject {
    UnknownSurface,
    StaleGeneration,
    DeviceEpoch,
    Format,
    Dimensions,
    Usage,
    Ownership,
    Quota,
    ForeignDevice,
    ReadbackForbidden,
    SurfaceCap,
    InvalidDeclare,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PresentSample {
    Ready(SurfaceFrame),
    Fallback { policy: FallbackPolicy },
}

#[derive(Clone, Debug, PartialEq)]
struct Slot {
    declare: VisualSurfaceDeclare,
    id: SurfaceId,
    generation: u64,
    last_sequence: u64,
    last_ready: Option<SurfaceFrame>,
    held_bytes: usize,
}

#[derive(Debug)]
pub struct SurfaceFrameIngress {
    next_id: u32,
    device_epoch: DeviceEpoch,
    surfaces: HashMap<String, Slot>,
    by_id: HashMap<SurfaceId, String>,
    item_cap: usize,
    byte_quota: usize,
    surface_cap: usize,
    dropped_late: u64,
    dropped_not_ready: u64,
    coalesced: u64,
}

impl SurfaceFrameIngress {
    pub fn new(device_epoch: DeviceEpoch) -> Self {
        Self {
            next_id: 1,
            device_epoch,
            surfaces: HashMap::new(),
            by_id: HashMap::new(),
            item_cap: INGRESS_ITEM_CAP,
            byte_quota: INGRESS_BYTE_QUOTA,
            surface_cap: INGRESS_SURFACE_CAP,
            dropped_late: 0,
            dropped_not_ready: 0,
            coalesced: 0,
        }
    }

    pub fn device_epoch(&self) -> DeviceEpoch {
        self.device_epoch
    }

    pub fn plugin_runtime(&self) -> bool {
        false
    }

    pub fn direct_display_list_injection(&self) -> bool {
        false
    }

    pub fn surface_frame_ingress(&self) -> bool {
        true
    }

    pub fn item_cap(&self) -> usize {
        self.item_cap
    }

    pub fn dropped_late(&self) -> u64 {
        self.dropped_late
    }

    pub fn dropped_not_ready(&self) -> u64 {
        self.dropped_not_ready
    }

    pub fn coalesced(&self) -> u64 {
        self.coalesced
    }

    pub fn used_bytes(&self) -> usize {
        self.surfaces.values().map(|slot| slot.held_bytes).sum()
    }

    pub fn declare(&mut self, declare: VisualSurfaceDeclare) -> Result<SurfaceId, IngressReject> {
        if declare.wire_surface_id.is_empty()
            || declare.generation == 0
            || declare.width == 0
            || declare.height == 0
        {
            return Err(IngressReject::InvalidDeclare);
        }
        if let Some(existing) = self.surfaces.get_mut(&declare.wire_surface_id) {
            if declare.generation < existing.generation {
                return Err(IngressReject::StaleGeneration);
            }
            existing.declare = declare.clone();
            existing.generation = declare.generation;
            return Ok(existing.id);
        }
        if self.surfaces.len() >= self.surface_cap {
            return Err(IngressReject::SurfaceCap);
        }
        let id = SurfaceId(self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        self.by_id.insert(id, declare.wire_surface_id.clone());
        self.surfaces.insert(
            declare.wire_surface_id.clone(),
            Slot {
                id,
                generation: declare.generation,
                last_sequence: 0,
                last_ready: None,
                held_bytes: 0,
                declare,
            },
        );
        Ok(id)
    }

    pub fn surface_id(&self, wire_surface_id: &str) -> Option<SurfaceId> {
        self.surfaces.get(wire_surface_id).map(|slot| slot.id)
    }

    pub fn submit(
        &mut self,
        gpu: &SharedGpuContext,
        frame: SurfaceFrame,
    ) -> Result<IngressAccept, IngressReject> {
        let wire = self
            .by_id
            .get(&frame.surface)
            .cloned()
            .ok_or(IngressReject::UnknownSurface)?;
        let meta = {
            let slot = self
                .surfaces
                .get(&wire)
                .ok_or(IngressReject::UnknownSurface)?;
            SlotMeta {
                generation: slot.generation,
                declare_generation: slot.declare.generation,
                last_sequence: slot.last_sequence,
                sampleable: slot.declare.sampleable,
                width: slot.declare.width,
                height: slot.declare.height,
            }
        };
        if frame.generation != meta.generation || frame.generation < meta.declare_generation {
            return Err(IngressReject::StaleGeneration);
        }
        if frame.sequence <= meta.last_sequence {
            self.dropped_late = self.dropped_late.saturating_add(1);
            return Ok(IngressAccept::Dropped {
                reason: IngressDropReason::Late,
            });
        }
        if matches!(frame.fence, Some(SurfaceFence { ready: false, .. }))
            || matches!(frame.content, SurfaceContent::NotReady)
        {
            self.dropped_not_ready = self.dropped_not_ready.saturating_add(1);
            return Ok(IngressAccept::Dropped {
                reason: IngressDropReason::NotReady,
            });
        }
        if gpu.device_epoch() != self.device_epoch || frame_epoch(&frame) != self.device_epoch {
            return Err(IngressReject::DeviceEpoch);
        }
        self.validate_content(gpu, &meta, &frame)?;
        let extra = frame.content.bytes();
        let current = self.used_bytes();
        let prior = self
            .surfaces
            .get(&wire)
            .map(|slot| slot.held_bytes)
            .unwrap_or(0);
        if current.saturating_sub(prior).saturating_add(extra) > self.byte_quota {
            return Err(IngressReject::Quota);
        }
        let slot = self
            .surfaces
            .get_mut(&wire)
            .ok_or(IngressReject::UnknownSurface)?;
        let dropped = slot.last_ready.take().map(|old| old.sequence);
        if dropped.is_some() {
            self.coalesced = self.coalesced.saturating_add(1);
        }
        slot.last_sequence = frame.sequence;
        slot.last_ready = Some(frame);
        slot.held_bytes = extra;
        debug_assert!(
            usize::from(slot.last_ready.is_some()) <= self.item_cap,
            "ingress queue is latest-ready-frame-wins"
        );
        Ok(match dropped {
            Some(seq) => IngressAccept::Coalesced {
                dropped_sequence: seq,
            },
            None => IngressAccept::Queued,
        })
    }

    pub fn present_sample(&self, surface: SurfaceId) -> PresentSample {
        let Some(wire) = self.by_id.get(&surface) else {
            return PresentSample::Fallback {
                policy: FallbackPolicy::ExplicitError,
            };
        };
        let Some(slot) = self.surfaces.get(wire) else {
            return PresentSample::Fallback {
                policy: FallbackPolicy::ExplicitError,
            };
        };
        if let Some(ready) = slot.last_ready {
            return PresentSample::Ready(ready);
        }
        PresentSample::Fallback {
            policy: slot.declare.policy,
        }
    }

    /// Device-loss: bump epoch, new generation, reject old frames/fences.
    pub fn recover_device(&mut self, new_epoch: DeviceEpoch) {
        self.device_epoch = new_epoch;
        for slot in self.surfaces.values_mut() {
            slot.generation = slot.generation.saturating_add(1);
            slot.declare.generation = slot.generation;
            slot.last_ready = None;
            slot.held_bytes = 0;
            slot.last_sequence = 0;
        }
    }

    /// GPU completion does not drop last-ready; lifetime holds until a newer
    /// ready frame or [`Self::recover_device`].
    pub fn complete_gpu(&self, surface: SurfaceId) -> bool {
        matches!(self.present_sample(surface), PresentSample::Ready(_))
    }

    fn validate_content(
        &self,
        gpu: &SharedGpuContext,
        meta: &SlotMeta,
        frame: &SurfaceFrame,
    ) -> Result<(), IngressReject> {
        let SurfaceContent::Sampleable {
            handle,
            width,
            height,
            format,
            usage,
            bytes,
        } = frame.content
        else {
            return Ok(());
        };
        if !meta.sampleable {
            return Err(IngressReject::Usage);
        }
        if width != meta.width || height != meta.height {
            return Err(IngressReject::Dimensions);
        }
        if format != DEFAULT_FORMAT.texture_format {
            return Err(IngressReject::Format);
        }
        if usage.contains(TextureUsageFlags::CPU_READBACK) {
            return Err(IngressReject::ReadbackForbidden);
        }
        if !usage.contains(TextureUsageFlags::SAMPLE) {
            return Err(IngressReject::Usage);
        }
        if bytes == 0 {
            return Err(IngressReject::Quota);
        }
        gpu.validate_surface(handle).map_err(map_gpu)?;
        Ok(())
    }
}

struct SlotMeta {
    generation: u64,
    declare_generation: u64,
    last_sequence: u64,
    sampleable: bool,
    width: u32,
    height: u32,
}

fn frame_epoch(frame: &SurfaceFrame) -> DeviceEpoch {
    match frame.fence {
        Some(fence) => fence.device_epoch,
        None => match frame.content {
            SurfaceContent::Sampleable { handle, .. } => handle.epoch,
            SurfaceContent::NotReady => DeviceEpoch(u64::MAX),
        },
    }
}

fn map_gpu(err: SharedGpuError) -> IngressReject {
    match err {
        SharedGpuError::StaleEpoch | SharedGpuError::MixedEpoch => IngressReject::DeviceEpoch,
        SharedGpuError::ForeignDevice => IngressReject::ForeignDevice,
        SharedGpuError::ForeignOwner => IngressReject::Ownership,
        SharedGpuError::CpuReadbackForbidden => IngressReject::ReadbackForbidden,
        SharedGpuError::LiveHandleCap | SharedGpuError::QueueSaturated => IngressReject::Quota,
        _ => IngressReject::Ownership,
    }
}

impl VisualSurfaceDeclare {
    pub fn reference(wire_surface_id: impl Into<String>) -> Self {
        Self {
            wire_surface_id: wire_surface_id.into(),
            generation: 1,
            width: 64,
            height: 64,
            sampleable: true,
            policy: FallbackPolicy::OpaquePanel,
        }
    }

    pub fn reference_pressure() -> Self {
        Self {
            wire_surface_id: crate::reference_visual_surface::WIRE_SURFACE_ID.into(),
            generation: 1,
            width: crate::reference_visual_surface::REFERENCE_SURFACE_WIDTH,
            height: crate::reference_visual_surface::REFERENCE_SURFACE_HEIGHT,
            sampleable: true,
            policy: FallbackPolicy::OpaquePanel,
        }
    }
}
