//! NeoCompositor production crate (Milestone B start).
//!
//! Default host is WebView rollback. `NEOTA_NEOCOMPOSITOR=1` selects the
//! flagged compositor path and is not a production cutover.

pub mod animation;
pub mod display_list;
pub mod epoch;
pub mod fast_path;
pub mod geometry_tiles;
pub mod hit_dispatch;
pub mod host;
pub mod layer_cache;
pub mod mailbox;
pub mod neo_glass;
pub mod pass_graph;
pub mod property_tree;
pub mod scene;
pub mod scroll;
pub mod selection;
pub mod target_pool;
pub mod text;
pub mod transaction;

pub use animation::{
    AnimValue, AnimationId, AnimationProperty, AnimationSpec, Easing, FastPathError,
};
pub use display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, CaretPaintOp, ClipChainId, ClipNode, EffectKind,
    EffectNode, EffectNodeId, EffectScopeId, GlassBoundary, HandleKind, HandlePaintOp, ImageLayer,
    NeoDisplayList, NeoPaintOp, PaintChunk, PaintChunkId, PaintOrderKey, Rect, SelectionPaintOp,
    SpatialNode, SpatialNodeId, StubPayload, TextPaintFragment,
};
pub use epoch::{DeviceEpoch, EpochClock, FrameId, PresentationTime, SceneEpoch, ScrollEpoch};
pub use fast_path::{CompositorFastPath, PresentOutcome, RasterDecision};
pub use geometry_tiles::{GeometryTile, GeometryTileSnapshot, TileId, TileKind};
pub use hit_dispatch::{DispatchError, HitTestSnapshot, PointerEvent, PointerId, PointerKind};
pub use host::{
    production_host_from_env, production_host_from_flag, PresentationHost, NEOCOMPOSITOR_FLAG,
};
pub use layer_cache::{LayerCache, LayerCacheStats, LayerKey};
pub use mailbox::{
    FrameMailbox, MailboxStats, PostAccept, PostReject, TryDequeue, DEFAULT_BYTE_CAP,
    DEFAULT_ITEM_CAP,
};
pub use neo_glass::NeoGlass;
pub use pass_graph::{
    barriers_cut_raster_runs, compile_passes, CompiledPass, GraphError, InteractionPassKind,
};
pub use property_tree::{
    hit_test, ClipId, ClipTreeNode, EffectId, EffectSpec, EffectTreeNode, HitTestId, HitTestItem,
    HitTestMatch, Insets, LogicalRect, Point, PointerFlags, PropertyEffectKind, PropertySnapshot,
    PropertyTreeBuilder, SampleError, SampledFrame, ScrollId, ScrollRange, Size, SpatialId,
    SpatialKind, SpatialTreeNode, StableSemanticId, TreeError, Vec2,
};
pub use scene::{GlassSurface, NeoScene};
pub use scroll::{
    AckResult, AsyncScrollState, GestureId, ScrollAck, ScrollInputError, ScrollSequence,
};
pub use selection::{
    apply_autoscroll, autoscroll_delta, clip_to_tile, compose_selectable, SelectablePaintPlan,
    SelectionError, SelectionFrame, SelectionSession, AUTOSCROLL_EDGE_PX,
};
pub use target_pool::{TargetId, TargetPool, TargetPoolError};
pub use text::{
    BidiAffinity, ClusterBoundary, LineMetric, ProducerGlyph, ProducerTextWork, ShapedRunRef,
    TextCommitError, TextFragmentId, TextInteractionSnapshot, TextOffset, TextRange,
    TextSnapshotSet, TileCoverage,
};
pub use transaction::{
    DamageRect, FrameTransaction, FrameTransactionParts, ResourceLease, ResourceLeaseId,
};
