# `neotavern-presentation-blueprint`

Pure Rust, renderer-neutral ABI for the React-to-Rust UI migration pilot.

## Scope

V1 compiles a Product-Wire-backed Character Manager **Cards** capture into a
portable `UiBlueprintV1`, then materializes an immutable `UiSceneV1` for a
compact, medium, or expanded viewport class. The scene exposes four parallel
views: paint, hit-test, text-interaction, and semantics.

It is intentionally not a renderer. The crate must not depend on Dioxus,
Blitz, Vello, wgpu, NeoCompositor, Android JNI, DOM/WebView APIs, or GPU
handles. Renderer adapters consume `UiSceneV1` later.

## Public inputs

- `CaptureBundleV1` — immutable Product Wire state plus an ABI revision;
- `ViewportClassV1` — `compact`, `medium`, or `expanded`;
- `UiActionV1` — closed typed intents. Product-Wire request payloads reuse
  generated DTOs; file paths, file bytes, and handles never enter the ABI.

The deterministic cross-language fixture is
`packages/contracts/src/presentation/fixtures/character-manager-v1.json`.

## Deliberate V1 boundary

Product Wire currently lacks the full React Character Manager editor/gallery
fields. V1 therefore does not claim native support for Editor, Advanced,
Gallery, plugin slots, creator-notes iframe content, or sanitized-document
layout. Extend Product Wire first, then add a new versioned Blueprint slice.

## Development

```powershell
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-blueprint
```

See [ADR-0055](../../docs/adr/0055-react-ui-oracle-blueprint-pilot.md) for the
capture → blueprint → scene boundary and parity-gate rules.
