//! NeoUI v4 M0-D1a paint-seam probe (RFC 4.5).
//!
//! This crate is a **non-production** runner. Gate P is `GateP:P1`. Normative
//! Milestone 0 is `ENTERED`, not PASS. Existing desktop/AVD runs stay
//! PRE-GATE / BLOCKED until a physical Android GPU capture admits D1a.
//! This is not NeoCompositor v1, not a Dioxus migration, and not a Track D GO.
//!
//! The probe shows a host-authored static display list compiled into ordered
//! raster/glass passes on **one** `wgpu` device/queue. A first-frame **API
//! timeline** and wgpu debug groups name accumulator/snapshot resources; that
//! is not an AGI/RenderDoc GPU capture. Android GPU capture on a physical
//! device remains required before D1a PASS.

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
pub use timeline::{
    encode_timeline, expected_first_frame, TimelineKind, ACCUMULATOR_LABEL,
    CAPTURE_GROUP_GLASS_PREFIX, CAPTURE_GROUP_ROI_PREFIX, CAPTURE_PASS_BLIT, CAPTURE_PASS_CLEAR,
    CAPTURE_PASS_GLASS, D1A_GOLDEN_TIMELINE, SNAPSHOT_LABEL, VELLO_LABEL,
};
pub use verdict::{ProbeReport, SubstrateVerdict};
