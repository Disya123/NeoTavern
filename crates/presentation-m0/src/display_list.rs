//! Re-export of production NeoDisplayList (`neotavern-neocompositor`).
//!
//! M0 probe scenes still live in this crate; the interchange types do not.

pub use neotavern_neocompositor::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, GlassBoundary, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
};
