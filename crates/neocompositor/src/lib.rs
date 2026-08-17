//! NeoCompositor production crate (Milestone B start).
//!
//! Default host is WebView rollback. `NEOTA_NEOCOMPOSITOR=1` selects the
//! flagged compositor path and is not a production cutover.

pub mod display_list;
pub mod epoch;
pub mod host;
pub mod layer_cache;
pub mod mailbox;
pub mod neo_glass;
pub mod pass_graph;
pub mod property_tree;
pub mod scene;
pub mod target_pool;
pub mod transaction;

pub use display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, GlassBoundary, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
};
pub use epoch::{DeviceEpoch, EpochClock, FrameId, SceneEpoch};
pub use host::{
    production_host_from_env, production_host_from_flag, PresentationHost, NEOCOMPOSITOR_FLAG,
};
pub use layer_cache::{LayerCache, LayerCacheStats, LayerKey};
pub use mailbox::{
    FrameMailbox, MailboxStats, PostAccept, PostReject, TryDequeue, DEFAULT_BYTE_CAP,
    DEFAULT_ITEM_CAP,
};
pub use neo_glass::NeoGlass;
pub use pass_graph::{barriers_cut_raster_runs, compile_passes, CompiledPass, GraphError};
pub use property_tree::{
    hit_test, ClipId, ClipTreeNode, EffectId, EffectSpec, EffectTreeNode, HitTestItem,
    HitTestMatch, Insets, LogicalRect, Point, PropertyEffectKind, PropertySnapshot,
    PropertyTreeBuilder, SampleError, SampledFrame, ScrollId, ScrollRange, Size, SpatialId,
    SpatialKind, SpatialTreeNode, TreeError, Vec2,
};
pub use scene::{GlassSurface, NeoScene};
pub use target_pool::{TargetId, TargetPool, TargetPoolError};
pub use transaction::{
    DamageRect, FrameTransaction, FrameTransactionParts, ResourceLease, ResourceLeaseId,
};
