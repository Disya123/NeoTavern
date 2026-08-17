//! NeoCompositor production crate (Milestone B start).
//!
//! Default host is WebView rollback. `NEOTA_NEOCOMPOSITOR=1` selects the
//! flagged compositor path and is not a production cutover.

pub mod display_list;
pub mod host;
pub mod layer_cache;
pub mod neo_glass;
pub mod pass_graph;
pub mod scene;
pub mod target_pool;
pub mod transaction;

pub use display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, GlassBoundary, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
};
pub use host::{
    production_host_from_env, production_host_from_flag, PresentationHost, NEOCOMPOSITOR_FLAG,
};
pub use layer_cache::{LayerCache, LayerCacheStats, LayerKey};
pub use neo_glass::NeoGlass;
pub use pass_graph::{barriers_cut_raster_runs, compile_passes, CompiledPass, GraphError};
pub use scene::{GlassSurface, NeoScene};
pub use target_pool::{TargetId, TargetPool, TargetPoolError};
pub use transaction::{DamageRect, FrameTransaction};
