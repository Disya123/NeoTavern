//! NeoUI v4 M0-D1a paint-seam probe (RFC 4.5).
//!
//! This crate is a **non-production** runner. Gate P is `GateP:P1`. Technical
//! M0 is host-side PASS; this crate still reports `android_gpu_capture=false`.
//! Display-list and pass-graph types live in `neotavern-neocompositor`; this
//! crate remains a probe and is not production JNI.
//!
//! The probe shows a host-authored static display list compiled into ordered
//! raster/glass passes on **one** `wgpu` device/queue. A first-frame **API
//! timeline** and wgpu debug groups name accumulator/snapshot resources; that
//! is not an AGI/RenderDoc GPU capture and MUST NOT flip `android_gpu_capture`.
//! Program D1b PASS lives in the host-side admission record; this crate
//! still reports `capture=false`. M0-D2 lives in `presentation-m0-d2`.

#[cfg(all(feature = "android-jni", target_os = "android"))]
mod android_jni;
pub mod display_list;
#[cfg(feature = "gpu")]
pub mod gpu;
pub mod pass_graph;
#[cfg(feature = "gpu")]
mod reference_visual_surface;
#[cfg(feature = "gpu")]
pub mod scene_character_manager;
#[cfg(all(feature = "renderdoc-capture", target_os = "android"))]
mod renderdoc_capture;
// Optional `ash` is Android-only in this crate. Keep the dep used on host so
// `cargo test --features renderdoc-capture` does not warn.
#[cfg(all(feature = "renderdoc-capture", not(target_os = "android")))]
use ash as _;
pub mod scene_d1a;
pub mod scene_d1b;
pub mod timeline;
pub mod verdict;

pub use display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, GlassBoundary, ImageLayer, ImagePaintOp, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
};
pub use pass_graph::{compile_passes, CompiledPass, GraphError};
pub use scene_d1a::static_d1a_scene;
pub use scene_d1b::static_d1b_scene;
pub use timeline::{
    encode_timeline, expected_first_frame, TimelineKind, ACCUMULATOR_LABEL,
    CAPTURE_GROUP_GLASS_PREFIX, CAPTURE_GROUP_ROI_PREFIX, CAPTURE_PASS_BLIT, CAPTURE_PASS_CLEAR,
    CAPTURE_PASS_GLASS, D1A_GOLDEN_TIMELINE, D1B_GOLDEN_TIMELINE, D1B_MOTION_TIMELINE_G120,
    SNAPSHOT_LABEL, VELLO_LABEL,
};
pub use verdict::{ProbeReport, SubstrateVerdict};
