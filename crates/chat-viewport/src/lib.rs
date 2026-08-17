//! Chat viewport virtualization (RFC T19).
//!
//! Height index, range predictor, bounded preparation queue, and tile cache
//! live here — not in `neotavern-neocompositor`. The compositor consumes only
//! [`GeometrySnapshot`] tile descriptors. This crate is not production JNI
//! and not an Android cutover. Geometry C0/C1 remap is a follow-up.

pub mod height;
pub mod predictor;
pub mod prepare;
pub mod range;
pub mod session;
pub mod tiles;

pub use height::{
    GeometryCorrection, GeometryDebt, GeometryEpoch, HeightError, HeightIndex, HeightKind, ItemHit,
    LogicalItemId,
};
pub use predictor::{PredictedRanges, PredictorBudgets, PredictorInput, RangePredictor};
pub use prepare::{PrepAccept, PrepJob, PrepPriority, PrepStats, PreparationQueue};
pub use range::{FallbackReadyRange, ItemSpan, PreparedRange, VisibleRange};
pub use session::{PresentDecision, PresentOutcome, ViewportSession};
pub use tiles::{
    GeometrySnapshot, TileCache, TileCacheStats, TileDescriptor, TileFidelity, TileId, TileInsert,
};
