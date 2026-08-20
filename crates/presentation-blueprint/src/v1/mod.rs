//! Version 1 of the portable Character Manager Cards presentation ABI.
//!
//! The v1 pilot intentionally covers the catalog/cards surface and its
//! Product Wire backed CRUD/import/export intents. React-only editor, gallery,
//! plugin slot, and sanitized-document details are not represented as native
//! widgets until their Product Wire data exists.

mod character_manager;
mod scene;

pub use character_manager::{
    compile_character_manager_v1, BlueprintErrorV1, CaptureBundleV1, CharacterCatalogViewV1,
    CharacterManagerActionV1, CharacterManagerBlueprintV1, CharacterManagerCaptureV1,
    CharacterManagerDialogV1, CharacterManagerTabV1, CharacterSortV1, UiActionV1, UiBlueprintV1,
    UiFeedbackV1, UiLoadStateV1, UiWireEffectV1,
};
pub use scene::{
    materialize_character_manager_scene_v1, CollectionPresentationV1, UiContentV1, UiLayoutV1,
    UiNodeV1, UiSceneV1, UiSemanticStateV1, UiSemanticV1, UiStyleHookV1, ViewportClassV1,
};
