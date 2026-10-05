//! ADR-0057 native presentation platform core.
//!
//! This crate owns the product UI mechanism only — it never knows the
//! product (chat) and never links the Kernel. The frame pipeline is the one
//! from the platform spec §3:
//!
//! ```text
//! state -> projection -> scene (retained, epoch arena)
//!      -> taffy layout -> Parley text layout -> FrameSnapshot
//!      -> paint / hit / focus / a11y (all read the snapshot)
//! ```
//!
//! Invariant map (ADR-0057, `docs/architecture/native-presentation-platform.md`):
//!
//! - INV-1 single state truth — the crate never stores product state; the
//!   pilot's projection hydrates from Kernel DTOs only.
//! - INV-2 single geometry — [`snapshot::FrameSnapshot`] is the only
//!   geometry; [`hit`], focus order and paint read it, nothing else.
//! - INV-3 single render path — [`render`] encodes the snapshot; there is no
//!   second renderer behind a guard.
//! - INV-4 single input model — [`editor`] is the only text input model;
//!   fields are `FieldId`-addressable; append-only input is structurally
//!   impossible (all edits go through `replace_range`).
//! - INV-5 single stream driver — product concern, pilot-side.
//! - INV-6 bridges-only adapters — the platform core is adapter-free; hosts
//!   translate native events into the input model and present the snapshot.
//! - INV-7 behavioral evidence — conformance lives in the pilot crate's
//!   tests against the real Kernel; FakeWire runs are labeled, never
//!   product evidence.
//!
//! Styling is token-only: scene styles carry semantic token references
//! ([`style`]), never literal colors/sizes/fonts; the [`theme::Theme`]
//! resolves them. The type system leaves no literal bypass, which is the
//! native side of the AGENTS §14 hardcoding ban.

pub mod arena;
pub mod editor;
pub mod hit;
pub mod layout;
#[cfg(feature = "gpu")]
pub mod render;
pub mod scene;
pub mod snapshot;
pub mod style;
pub mod text;
pub mod theme;

pub use arena::{NodeId, SceneArena, SceneId};
pub use editor::{Cursor, CursorOp, Editor, FieldId};
pub use hit::{hit_test, HitTarget};
pub use layout::SceneLayouter;
pub use scene::{A11yRole, NodeKind, Scene, SceneAction, SceneNode, SlotId, TextRun};
pub use snapshot::FrameSnapshot;
pub use style::{
    ColorToken, ControlHeightToken, FontSizeToken, FontStackToken, FontWeightToken, NodeLayout,
    Padding, RadiusToken, SizeToken, SpacingToken, TextTokens,
};
pub use text::{ShapedText, TextEngine};
pub use theme::Theme;
