//! Chat viewport virtualization (RFC T19 / T26).
//!
//! Height index, range predictor, bounded preparation queue, tile cache,
//! and fling-continuous geometry remap live here — not in
//! `neotavern-neocompositor`. The compositor consumes only the **active**
//! [`GeometrySnapshot`]. This crate is not production JNI and not an
//! Android cutover.

pub mod height;
pub mod predictor;
pub mod prepare;
pub mod range;
pub mod remap;
pub mod session;
pub mod tiles;

pub use height::{GeometryEpoch, HeightError, HeightIndex, HeightKind, ItemHit, LogicalItemId};
pub use predictor::{PredictedRanges, PredictorBudgets, PredictorInput, RangePredictor};
pub use prepare::{PrepAccept, PrepJob, PrepPriority, PrepStats, PreparationQueue};
pub use range::{FallbackReadyRange, ItemSpan, PreparedRange, VisibleRange};
pub use remap::{
    validate_commit, AckResult, CommitError, ContactMode, DebtCapError, DebtCaps, DebtStats,
    DeltaToken, DualGeometry, GeometryCommit, GeometryCorrection, GeometryDebt, GeometryDebtLedger,
    PrefixDelta, PrefixDeltaMap, PrefixError, RemapOutcome, SceneGeneration, ScrollAck,
    ScrollAnchor, ViewportError,
};
pub use session::{PresentDecision, PresentOutcome, ViewportSession, PROTECTED_BAND_PX};
pub use tiles::{
    GeometrySnapshot, TileCache, TileCacheStats, TileDescriptor, TileFidelity, TileId, TileInsert,
};
