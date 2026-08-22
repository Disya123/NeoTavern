//! Renderer-neutral, first-party presentation ABI.
//!
//! This crate deliberately stops at `UiSceneV1`: it owns no Dioxus, DOM,
//! Blitz, Vello, wgpu, GPU handle, or platform surface. Renderer adapters are
//! consumers of this ABI, never part of it.

#![forbid(unsafe_code)]

pub mod generated;
pub mod v1;

pub use generated::ui_blueprint_v1::UiBlueprintDocumentV1;
pub use v1::{
    compile_character_manager_v1, materialize_character_manager_scene_v1,
    materialize_character_manager_scene_v1_from_document, materialize_chat_scene_v1_from_document,
    BlueprintErrorV1, CaptureBundleV1, CharacterManagerStateV1, ChatSurfaceStateV1, UiActionV1,
    UiBlueprintDocumentResponsiveItemLayoutV1, UiBlueprintV1, UiLabelOverrideV1, UiNodeOverridesV1,
    UiSceneV1, UiStyleRefV1, ViewportClassV1,
};
