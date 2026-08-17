//! NeoUI v4 PRE-GATE D1a paint-seam probe (RFC 4.5).
//!
//! This crate is a **non-production** runner artifact. It is not normative
//! Milestone 0 (`NOT_ENTERED` until Gate P), not NeoCompositor v1, not a
//! Dioxus migration, and not a Gate P product decision (`GateP:P0|P1|P2`).
//!
//! The probe shows a host-authored static display list compiled into ordered
//! raster/glass passes on **one** `wgpu` device/queue. A first-frame **API
//! timeline** names the accumulator/snapshot resources; that is not an
//! AGI/RenderDoc GPU capture. Android GPU capture and a physical-device
//! production backend remain required before any later evidence-admission.

#[cfg(all(feature = "android-jni", target_os = "android"))]
mod android_jni;
pub mod display_list;
#[cfg(feature = "gpu")]
pub mod gpu;
pub mod pass_graph;
pub mod scene_d1a;
pub mod timeline;
pub mod verdict;

pub use display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, GlassBoundary, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
};
pub use pass_graph::{compile_passes, CompiledPass, GraphError};
pub use scene_d1a::static_d1a_scene;
pub use timeline::{encode_timeline, expected_first_frame, TimelineKind, D1A_GOLDEN_TIMELINE};
pub use verdict::{ProbeReport, SubstrateVerdict};
