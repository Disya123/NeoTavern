//! Renderer-neutral, first-party presentation ABI.
//!
//! This crate deliberately stops at `UiSceneV1`: it owns no Dioxus, DOM,
//! Blitz, Vello, wgpu, GPU handle, or platform surface. Renderer adapters are
//! consumers of this ABI, never part of it.

#![forbid(unsafe_code)]

pub mod v1;

pub use v1::{
    compile_character_manager_v1, materialize_character_manager_scene_v1, BlueprintErrorV1,
    CaptureBundleV1, UiBlueprintV1, UiSceneV1, ViewportClassV1,
};
