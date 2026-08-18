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
pub mod perf18;
pub mod platform_input;
pub mod pressure;
pub mod property_tree;
pub mod recovery;
pub mod scene;
pub mod scroll;
pub mod selection;
pub mod shared_device;
pub mod surface_fallback;
pub mod target_pool;
pub mod telemetry;
pub mod text;
pub mod transaction;
pub mod visual_surface;

pub use animation::{
    AnimValue, AnimationId, AnimationProperty, AnimationSpec, Easing, FastPathError,
};
pub use display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, CaretPaintOp, ClipChainId, ClipNode,
    CompositionMarkKind, CompositionPaintOp, EffectKind, EffectNode, EffectNodeId, EffectScopeId,
    GlassBoundary, HandleKind, HandlePaintOp, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SelectionPaintOp, SpatialNode, SpatialNodeId, StubPayload,
    TextPaintFragment,
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
pub use platform_input::{
    expand_android_motion, presentation_time_from_vsync, AndroidMotionView, InputPush,
    InputQueueStats, PlatformInputAdapter, PlatformPointerKind, PlatformPointerSample,
    ANDROID_ACTION_CANCEL, ANDROID_ACTION_DOWN, ANDROID_ACTION_MASK, ANDROID_ACTION_MOVE,
    ANDROID_ACTION_POINTER_DOWN, ANDROID_ACTION_POINTER_INDEX_MASK,
    ANDROID_ACTION_POINTER_INDEX_SHIFT, ANDROID_ACTION_POINTER_UP, ANDROID_ACTION_UP,
    INPUT_EDGE_RESERVE, INPUT_MAX_POINTERS, INPUT_QUEUE_CAP,
};
pub use pressure::{
    AdmissionItem, Admit, EvictReport, EvictionClass, PressureController, PressureReject,
    PressureStats, PressureTier, ResourceId, DEFAULT_ALLOC_RETRY_CAP, DEFAULT_PRESSURE_CAP_BYTES,
};
pub use property_tree::{
    hit_test, ClipId, ClipTreeNode, EffectId, EffectSpec, EffectTreeNode, HitTestId, HitTestItem,
    HitTestMatch, Insets, LogicalRect, Point, PointerFlags, PropertyEffectKind, PropertySnapshot,
    PropertyTreeBuilder, SampleError, SampledFrame, ScrollId, ScrollRange, Size, SpatialId,
    SpatialKind, SpatialTreeNode, StableSemanticId, TreeError, Vec2,
};
pub use recovery::{
    CallbackReject, DegradedReason, GpuCallback, GpuFault, GpuHandle, GpuHandleKind, GpuRecovery,
    RecoveryError, RecoveryOutcome, RecoveryPhase, SubmitReject, DEFAULT_RECOVERY_ATTEMPT_CAP,
};
pub use scene::{GlassSurface, NeoScene};
pub use scroll::{
    AckResult, AsyncScrollState, GestureId, ScrollAck, ScrollInputError, ScrollSequence,
};
pub use selection::{
    apply_autoscroll, autoscroll_delta, clip_to_tile, compose_ime, compose_selectable,
    SelectablePaintPlan, SelectionError, SelectionFrame, SelectionSession, AUTOSCROLL_EDGE_PX,
};
pub use shared_device::{
    AlphaMode, BoundBackend, ColorSpace, DeviceIdentity, GpuCaps, GpuTiming, HandleOwner,
    InteropPresentOutcome, InteropTelemetry, ReadinessToken, SharedFormat, SharedGpuContext,
    SharedGpuError, SharedGpuFactory, SharedHandleKind, SharedTextureFormat, TextureUsageFlags,
    TypedGpuHandle, DEFAULT_FORMAT, LIVE_HANDLE_CAP, QUEUE_CAP, TIMESTAMP_RESOLVE_CAP,
};
pub use surface_fallback::{
    compile_surface_plan, surface_plan_invalid, CompiledSurfaces, FallbackPolicy, ParentEffect,
    PosterFrameId, ResolvedKind, ResolvedSurface, SurfaceCapability, SurfaceCompileError,
    SurfaceCompileRequest, SurfaceId, SurfacePlan, SurfaceSpec,
};
pub use target_pool::{TargetId, TargetPool, TargetPoolError};
pub use telemetry::{
    FrameCause, GpuTelemetry, GpuTimingAvailability, LAYER_ACCOUNTING_BYTES,
    TARGET_ACCOUNTING_BYTES,
};
pub use text::{
    BidiAffinity, ClusterBoundary, InteractionReady, LineMetric, ProducerGlyph, ProducerTextWork,
    ShapedRunRef, TextCommitError, TextFragmentId, TextInteractionSnapshot, TextOffset, TextRange,
    TextSnapshotSet, TileCoverage,
};
pub use transaction::{
    DamageRect, FrameTransaction, FrameTransactionParts, ResourceLease, ResourceLeaseId,
};
pub use visual_surface::{
    IngressAccept, IngressDropReason, IngressReject, PresentSample, SurfaceContent, SurfaceFence,
    SurfaceFrame, SurfaceFrameIngress, VisualSurfaceDeclare, INGRESS_BYTE_QUOTA, INGRESS_ITEM_CAP,
    INGRESS_SURFACE_CAP,
};
