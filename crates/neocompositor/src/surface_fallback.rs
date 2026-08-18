//! PERF-22: non-sampleable surface fallback policy.
//!
//! Every surface receives a [`SurfaceCapability`] **before** `compile_passes`
//! / the present loop. A non-sampleable node is replaced atomically by one
//! pre-allowed [`FallbackPolicy`]. Unsupported combinations reject with
//! last-known-good and never panic.
//!
//! Host corpus is **IMPLEMENTED**. PASS still requires an Android fixture
//! that checks a real platform surface and input routing.

use crate::display_list::{
    ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk, PaintChunkId, PaintOrderKey, Rect,
    StubPayload,
};
use crate::epoch::SceneEpoch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct SurfaceId(pub u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct PosterFrameId(pub u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum SurfaceCapability {
    SampleableTexture,
    NonSampleableWebView,
    NonSampleableSecureVideo,
    ProtectedOverlay,
    Unavailable,
}

impl SurfaceCapability {
    pub fn is_sampleable(self) -> bool {
        matches!(self, Self::SampleableTexture)
    }

    pub fn is_secure(self) -> bool {
        matches!(
            self,
            Self::NonSampleableSecureVideo | Self::ProtectedOverlay
        )
    }

    pub fn needs_fallback(self) -> bool {
        !self.is_sampleable()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum FallbackPolicy {
    OpaquePanel,
    PosterFrame,
    FullscreenSurface,
    ExplicitError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum ParentEffect {
    Opacity,
    Mask,
    Filter,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SurfaceCompileError {
    MissingCapability,
    UnsupportedCombo,
    PartialEffect,
    SecureCopy,
    BackdropFromNonSampleable,
    FakeSamplingDependency,
    StaleEpoch,
    CapabilityChangedSameEpoch,
    PosterWithoutSource,
    ReadbackForbidden,
    CrossDeviceCopy,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceSpec {
    pub id: SurfaceId,
    pub capability: Option<SurfaceCapability>,
    pub requested_policy: Option<FallbackPolicy>,
    pub bounds: Rect,
    pub clip: Rect,
    pub hit_bounds: Rect,
    pub paint_order: PaintOrderKey,
    pub chunk_id: Option<PaintChunkId>,
    pub under_glass: bool,
    pub overlapping_glass: bool,
    pub parent_effects: Vec<ParentEffect>,
    pub poster: Option<PosterFrameId>,
    pub as_backdrop_source: bool,
    pub claimed_sampling_edge: bool,
    pub partial_parent_effect: bool,
    pub copy_requested: bool,
    pub readback_requested: bool,
    pub xdev_requested: bool,
    pub promote_fullscreen: bool,
}

impl SurfaceSpec {
    pub fn new(id: SurfaceId, capability: SurfaceCapability, bounds: Rect) -> Self {
        Self {
            id,
            capability: Some(capability),
            requested_policy: None,
            bounds,
            clip: bounds,
            hit_bounds: bounds,
            paint_order: PaintOrderKey(id.0),
            chunk_id: None,
            under_glass: false,
            overlapping_glass: false,
            parent_effects: Vec::new(),
            poster: None,
            as_backdrop_source: false,
            claimed_sampling_edge: false,
            partial_parent_effect: false,
            copy_requested: false,
            readback_requested: false,
            xdev_requested: false,
            promote_fullscreen: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolvedKind {
    Sampled,
    Fallback { policy: FallbackPolicy },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedSurface {
    pub id: SurfaceId,
    pub capability: SurfaceCapability,
    pub kind: ResolvedKind,
    pub policy: Option<FallbackPolicy>,
    pub paint_order: PaintOrderKey,
    pub clip: Rect,
    pub hit_bounds: Rect,
    pub bounds: Rect,
    pub original_hittable: bool,
    pub fallback_hittable: bool,
    pub effects_applied_to_fallback: bool,
    pub sampling_edges: u32,
    pub poster: Option<PosterFrameId>,
}

impl ResolvedSurface {
    pub fn hittable(&self) -> bool {
        if matches!(self.kind, ResolvedKind::Fallback { .. }) {
            self.fallback_hittable && !self.original_hittable
        } else {
            self.original_hittable
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SurfacePlan {
    pub scene_epoch: SceneEpoch,
    pub resolved: Vec<ResolvedSurface>,
    pub image_readbacks: u32,
    pub xdev: u32,
    pub sampling_edges: u32,
}

impl SurfacePlan {
    pub fn empty(scene_epoch: SceneEpoch) -> Self {
        Self {
            scene_epoch,
            resolved: Vec::new(),
            image_readbacks: 0,
            xdev: 0,
            sampling_edges: 0,
        }
    }

    /// Front-to-back hit among **visible** fallback / sampleable nodes.
    /// Hidden originals never receive input through a fallback.
    pub fn hit(&self, x: f32, y: f32) -> Option<SurfaceId> {
        let mut best: Option<(PaintOrderKey, SurfaceId)> = None;
        for node in &self.resolved {
            if !node.hittable() {
                continue;
            }
            if !node.clip.contains_point(x, y) || !node.hit_bounds.contains_point(x, y) {
                continue;
            }
            let take = match best {
                None => true,
                Some((order, _)) => node.paint_order > order,
            };
            if take {
                best = Some((node.paint_order, node.id));
            }
        }
        best.map(|(_, id)| id)
    }

    pub fn capabilities(&self) -> Vec<(SurfaceId, SurfaceCapability)> {
        self.resolved
            .iter()
            .map(|node| (node.id, node.capability))
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompiledSurfaces {
    pub plan: SurfacePlan,
    pub display_list: NeoDisplayList,
}

pub struct SurfaceCompileRequest<'a> {
    pub scene_epoch: SceneEpoch,
    pub previous_epoch: Option<SceneEpoch>,
    pub previous_capabilities: &'a [(SurfaceId, SurfaceCapability)],
    pub surfaces: &'a [SurfaceSpec],
    pub display_list: &'a NeoDisplayList,
    pub viewport: Rect,
}

/// Compile capabilities + fallbacks **before** pass-graph compilation.
pub fn compile_surface_plan(
    request: SurfaceCompileRequest<'_>,
) -> Result<CompiledSurfaces, SurfaceCompileError> {
    if let Some(previous) = request.previous_epoch {
        if request.scene_epoch < previous {
            return Err(SurfaceCompileError::StaleEpoch);
        }
        if request.scene_epoch == previous {
            for spec in request.surfaces {
                let Some(capability) = spec.capability else {
                    return Err(SurfaceCompileError::MissingCapability);
                };
                if let Some((_, previous_cap)) = request
                    .previous_capabilities
                    .iter()
                    .copied()
                    .find(|(id, _)| *id == spec.id)
                {
                    if previous_cap != capability {
                        return Err(SurfaceCompileError::CapabilityChangedSameEpoch);
                    }
                }
            }
        }
    }

    let mut resolved = Vec::with_capacity(request.surfaces.len());
    for spec in request.surfaces {
        resolved.push(resolve_one(spec, request.viewport)?);
    }

    let display_list = rewrite_display_list(request.display_list, request.surfaces, &resolved);
    let plan = SurfacePlan {
        scene_epoch: request.scene_epoch,
        image_readbacks: 0,
        xdev: 0,
        sampling_edges: 0,
        resolved,
    };
    Ok(CompiledSurfaces { plan, display_list })
}

fn resolve_one(spec: &SurfaceSpec, viewport: Rect) -> Result<ResolvedSurface, SurfaceCompileError> {
    let Some(capability) = spec.capability else {
        return Err(SurfaceCompileError::MissingCapability);
    };
    if spec.partial_parent_effect {
        return Err(SurfaceCompileError::PartialEffect);
    }
    if spec.as_backdrop_source && !capability.is_sampleable() {
        return Err(SurfaceCompileError::BackdropFromNonSampleable);
    }
    if spec.claimed_sampling_edge && !capability.is_sampleable() {
        return Err(SurfaceCompileError::FakeSamplingDependency);
    }
    if capability.is_secure() && (spec.copy_requested || spec.readback_requested) {
        return Err(SurfaceCompileError::SecureCopy);
    }
    if spec.readback_requested {
        return Err(SurfaceCompileError::ReadbackForbidden);
    }
    if spec.xdev_requested {
        return Err(SurfaceCompileError::CrossDeviceCopy);
    }

    if !capability.needs_fallback() && !spec.promote_fullscreen {
        return Ok(ResolvedSurface {
            id: spec.id,
            capability,
            kind: ResolvedKind::Sampled,
            policy: None,
            paint_order: spec.paint_order,
            clip: spec.clip,
            hit_bounds: spec.hit_bounds,
            bounds: spec.bounds,
            original_hittable: true,
            fallback_hittable: false,
            effects_applied_to_fallback: false,
            sampling_edges: 0,
            poster: spec.poster,
        });
    }

    let policy = select_policy(spec, capability, viewport)?;
    let bounds = match policy {
        FallbackPolicy::FullscreenSurface => viewport,
        _ => spec.bounds,
    };
    let clip = match policy {
        FallbackPolicy::FullscreenSurface => viewport,
        _ => spec.clip,
    };
    let hit_bounds = match policy {
        FallbackPolicy::FullscreenSurface => viewport,
        _ => spec.hit_bounds,
    };
    let paint_order = fallback_paint_order(spec, policy);
    Ok(ResolvedSurface {
        id: spec.id,
        capability,
        kind: ResolvedKind::Fallback { policy },
        policy: Some(policy),
        paint_order,
        clip,
        hit_bounds,
        bounds,
        original_hittable: false,
        fallback_hittable: true,
        effects_applied_to_fallback: !spec.parent_effects.is_empty(),
        sampling_edges: 0,
        poster: spec.poster,
    })
}

fn select_policy(
    spec: &SurfaceSpec,
    capability: SurfaceCapability,
    viewport: Rect,
) -> Result<FallbackPolicy, SurfaceCompileError> {
    let fullscreen = spec.promote_fullscreen || spec.bounds.covers(viewport);
    let requested = spec.requested_policy.or_else(|| {
        if fullscreen {
            Some(FallbackPolicy::FullscreenSurface)
        } else {
            None
        }
    });
    let policy = match requested {
        Some(policy) => policy,
        None => default_policy(capability, spec.poster),
    };
    policy_allowed(capability, policy, spec.poster)?;
    Ok(policy)
}

fn default_policy(capability: SurfaceCapability, poster: Option<PosterFrameId>) -> FallbackPolicy {
    match capability {
        SurfaceCapability::SampleableTexture => FallbackPolicy::FullscreenSurface,
        SurfaceCapability::NonSampleableWebView | SurfaceCapability::NonSampleableSecureVideo => {
            if poster.is_some() {
                FallbackPolicy::PosterFrame
            } else {
                FallbackPolicy::OpaquePanel
            }
        }
        SurfaceCapability::ProtectedOverlay => FallbackPolicy::FullscreenSurface,
        SurfaceCapability::Unavailable => FallbackPolicy::ExplicitError,
    }
}

fn policy_allowed(
    capability: SurfaceCapability,
    policy: FallbackPolicy,
    poster: Option<PosterFrameId>,
) -> Result<(), SurfaceCompileError> {
    let ok = match (capability, policy) {
        (SurfaceCapability::SampleableTexture, FallbackPolicy::FullscreenSurface) => true,
        (SurfaceCapability::SampleableTexture, _) => false,
        (
            SurfaceCapability::NonSampleableWebView,
            FallbackPolicy::OpaquePanel
            | FallbackPolicy::FullscreenSurface
            | FallbackPolicy::ExplicitError,
        ) => true,
        (SurfaceCapability::NonSampleableWebView, FallbackPolicy::PosterFrame) => poster.is_some(),
        (
            SurfaceCapability::NonSampleableSecureVideo,
            FallbackPolicy::OpaquePanel
            | FallbackPolicy::FullscreenSurface
            | FallbackPolicy::ExplicitError,
        ) => true,
        (SurfaceCapability::NonSampleableSecureVideo, FallbackPolicy::PosterFrame) => {
            poster.is_some()
        }
        (
            SurfaceCapability::ProtectedOverlay,
            FallbackPolicy::FullscreenSurface | FallbackPolicy::ExplicitError,
        ) => true,
        (SurfaceCapability::ProtectedOverlay, _) => false,
        (
            SurfaceCapability::Unavailable,
            FallbackPolicy::OpaquePanel | FallbackPolicy::ExplicitError,
        ) => true,
        (SurfaceCapability::Unavailable, _) => false,
    };
    if !ok {
        if policy == FallbackPolicy::PosterFrame && poster.is_none() {
            return Err(SurfaceCompileError::PosterWithoutSource);
        }
        return Err(SurfaceCompileError::UnsupportedCombo);
    }
    Ok(())
}

fn fallback_paint_order(spec: &SurfaceSpec, policy: FallbackPolicy) -> PaintOrderKey {
    match policy {
        FallbackPolicy::FullscreenSurface => {
            PaintOrderKey(spec.paint_order.0.saturating_add(1_000))
        }
        _ => spec.paint_order,
    }
}

fn payload_for(policy: FallbackPolicy) -> StubPayload {
    match policy {
        FallbackPolicy::OpaquePanel
        | FallbackPolicy::ExplicitError
        | FallbackPolicy::FullscreenSurface => StubPayload::Overlay,
        FallbackPolicy::PosterFrame => StubPayload::Overlay,
    }
}

fn rewrite_display_list(
    list: &NeoDisplayList,
    specs: &[SurfaceSpec],
    resolved: &[ResolvedSurface],
) -> NeoDisplayList {
    let mut ops: Vec<NeoPaintOp> = list.ops.iter().cloned().collect();
    for (spec, node) in specs.iter().zip(resolved.iter()) {
        let ResolvedKind::Fallback { policy } = node.kind else {
            continue;
        };
        let Some(chunk_id) = spec.chunk_id else {
            continue;
        };
        for op in ops.iter_mut() {
            match op {
                NeoPaintOp::PaintChunk(chunk) | NeoPaintOp::Image(ImageLayer { chunk })
                    if chunk.id == chunk_id =>
                {
                    *chunk = fallback_chunk(chunk, node, policy);
                }
                _ => {}
            }
        }
    }
    let mut list = list.clone();
    list.ops = ops.into();
    list
}

fn fallback_chunk(
    source: &PaintChunk,
    node: &ResolvedSurface,
    policy: FallbackPolicy,
) -> PaintChunk {
    PaintChunk {
        id: source.id,
        generation: source.generation,
        paint_order: node.paint_order,
        spatial_node: source.spatial_node,
        clip_chain: source.clip_chain,
        effect_node: source.effect_node,
        backdrop_root: source.backdrop_root,
        bounds: node.bounds,
        payload: payload_for(policy),
    }
}

/// Re-validate a compiled scene before it enters the present loop.
pub fn surface_plan_invalid(
    scene_epoch: SceneEpoch,
    surfaces: &[SurfaceSpec],
    display_list: &NeoDisplayList,
    plan: Option<&SurfacePlan>,
    previous_epoch: Option<SceneEpoch>,
    previous_capabilities: &[(SurfaceId, SurfaceCapability)],
    viewport: Rect,
) -> bool {
    if surfaces.is_empty() {
        return plan.is_some_and(|plan| !plan.resolved.is_empty());
    }
    let compiled = match compile_surface_plan(SurfaceCompileRequest {
        scene_epoch,
        previous_epoch,
        previous_capabilities,
        surfaces,
        display_list,
        viewport,
    }) {
        Ok(compiled) => compiled,
        Err(_) => return true,
    };
    let Some(plan) = plan else {
        return true;
    };
    if plan.scene_epoch != scene_epoch {
        return true;
    }
    if plan.image_readbacks != 0 || plan.xdev != 0 || plan.sampling_edges != 0 {
        return true;
    }
    if plan.resolved.len() != compiled.plan.resolved.len() {
        return true;
    }
    for (got, expect) in plan.resolved.iter().zip(compiled.plan.resolved.iter()) {
        if got.id != expect.id
            || got.capability != expect.capability
            || got.kind != expect.kind
            || got.original_hittable != expect.original_hittable
        {
            return true;
        }
        if !got.capability.is_sampleable() && got.original_hittable {
            return true;
        }
    }
    display_samples_non_sampleable(surfaces, display_list, plan)
}

fn display_samples_non_sampleable(
    surfaces: &[SurfaceSpec],
    display_list: &NeoDisplayList,
    plan: &SurfacePlan,
) -> bool {
    for (spec, node) in surfaces.iter().zip(plan.resolved.iter()) {
        if node.capability.is_sampleable() {
            continue;
        }
        let Some(chunk_id) = spec.chunk_id else {
            continue;
        };
        for op in display_list.ops.iter() {
            let payload = match op {
                NeoPaintOp::PaintChunk(chunk) if chunk.id == chunk_id => chunk.payload,
                NeoPaintOp::Image(layer) if layer.chunk.id == chunk_id => layer.chunk.payload,
                _ => continue,
            };
            if payload == StubPayload::MovingSample {
                return true;
            }
        }
    }
    false
}
