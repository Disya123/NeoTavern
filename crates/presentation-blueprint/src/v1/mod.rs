//! Version 1 of the portable Character Manager Cards presentation ABI.
//!
//! The v1 pilot intentionally covers the catalog/cards surface and its
//! Product Wire backed CRUD/import/export intents. React-only editor, gallery,
//! plugin slot, and sanitized-document details are not represented as native
//! widgets until their Product Wire data exists.
//!
//! Boundary:
//! - `UiBlueprintDocumentV1` — schema imported from the React CaptureBundle via
//!   the strict TypeBox normalizer (`packages/contracts/src/presentation/blueprint.ts`).
//!   The generated decoder in `crate::generated::ui_blueprint_v1` is the sole
//!   Rust representation; no hand-maintained field list is permitted.
//! - `CharacterManagerStateV1` — Product Wire-backed runtime state (catalog,
//!   selection, query, sort, view, etc.). This is the only dynamic input to
//!   scene materialization.
//! - `UiSceneV1` — concrete scene for a given `ViewportClassV1`,
//!   materialized from `UiBlueprintDocumentV1 + CharacterManagerStateV1 + ViewportClassV1`.

mod character_manager;
mod chat;
mod scene;

pub use crate::generated::ui_blueprint_v1::{
    UiBlueprintDocumentFormatV1, UiBlueprintDocumentIdV1,
    UiBlueprintDocumentResponsiveItemLayoutV1, UiBlueprintDocumentV1,
};
/// Backwards-compatible alias for the state bundle.
pub use character_manager::CaptureBundleV1 as CharacterManagerStateBundleV1;
/// Product Wire-backed runtime state alias — the dynamic input alongside the
/// static `UiBlueprintDocumentV1` when materializing a `UiSceneV1`.
pub use character_manager::CharacterManagerCaptureV1 as CharacterManagerStateV1;
pub use character_manager::{
    BlueprintErrorV1, CaptureBundleV1, CharacterCatalogViewV1, CharacterManagerActionV1,
    CharacterManagerBlueprintV1, CharacterManagerCaptureV1, CharacterManagerDialogV1,
    CharacterManagerTabV1, CharacterSortV1, UiAbiVersionV1, UiActionV1, UiBlueprintV1,
    UiFeedbackV1, UiLoadStateV1, UiWireEffectV1, compile_character_manager_v1,
};
pub use chat::{
    ChatSurfaceStateV1, ContextUsageBreakdownV1, ContextUsageSummaryV1,
    materialize_chat_scene_v1_from_document,
};
pub use scene::{
    CollectionPresentationV1, UiContentV1, UiLabelOverrideV1, UiLayoutV1, UiNodeOverridesV1,
    UiNodeV1, UiSceneV1, UiSemanticStateV1, UiSemanticV1, UiStyleHookV1, UiStyleRefV1,
    ViewportClassV1, materialize_character_manager_scene_v1,
    materialize_character_manager_scene_v1_from_document,
};
