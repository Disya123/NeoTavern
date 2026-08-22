# `neotavern-presentation-blueprint`

Pure Rust, renderer-neutral ABI for the React-to-Rust UI migration pilot.

## Scope

V1 compiles a Product-Wire-backed Character Manager **Cards** state into a
portable `UiBlueprintV1`, then materializes an immutable `UiSceneV1` for a
compact, medium, or expanded viewport class. The scene exposes four parallel
views: paint, hit-test, text-interaction, and semantics. It is intentionally
not a renderer — the crate must not depend on Dioxus, Blitz, Vello, wgpu,
NeoCompositor, Android JNI, DOM/WebView APIs, or GPU handles. Renderer
adapters consume `UiSceneV1` later.

The **chat surface** (M2 slice) joins as a second document id: the authored
canonical document `ui-blueprint-document-chat-v1.json` plus
`ChatSurfaceStateV1` (messages slice + composer draft) materialize through
`materialize_chat_scene_v1_from_document`. The whole inner chrome — header,
viewport and composer — is **document-driven**: node ids, nesting, order and
actions are read from the JSON; message rows are instantiated from the
authored `chat-message` template (`parameter:"messageId"` actions bind to
each row); unknown ids flow through as generic flow nodes. The tables in
`v1/chat.rs` only name Theme SDK hooks and label keys per stable id. Hooks
carry Theme SDK slots (`slot:chat.header`, `slot:chat.composer`) so a
scene-driven renderer keeps DOM-parity with both the React oracle and the
native RSX. Chat actions join the closed `UiActionV1` union (send/composer
controls plus the full per-row set `chat.message.context…swipe-next`); the
wire-backed ones map onto `chats.messages.create` / `chats.messages.delete`.
The desktop consumer is the flagged chrome renderer
`presentation-dioxus-shell/src/scene_chat.rs`
(`--blueprint <path|embedded>` on `neocompositor-desktop`).

Since the M4 wave 1 the document also carries **presentation overrides** per
node (`label` with an i18n path, `icon` from the closed registry mirroring
`PHOSPHOR_REGULAR`, token-only `styleRefs`). The materializer copies them onto
scene nodes and the renderer applies them over its built-in tables, so
label/icon/style edits are JSON-only changes. The chat composer buttons in the
canonical fixture already author their presentation this way. See
[`docs/desktop/chat-ui-recipe.md`](../../docs/desktop/chat-ui-recipe.md) for
the authoring loop (`pnpm blueprint:validate`, `pnpm ui:schema`).

## Public inputs

- `UiBlueprintDocumentV1` (`crates/presentation-blueprint/src/generated/ui_blueprint_v1.rs`,
  generated from `packages/contracts/src/presentation/blueprint.ts`) — the
  static structure imported from the React `CaptureBundle` via the strict
  normalizer. The TypeBox schema is the sole authored cross-language document;
  no hand-maintained Rust field list is permitted.
- `CharacterManagerStateV1` (`CharacterManagerCaptureV1`) — the dynamic
  Product Wire-backed runtime state (catalog, selection, query, sort, view,
  dialog, loading). No React-only editor/gallery/extension/creator-notes fields
  are invented — V1 is honestly limited to Cards + Product Wire CRUD/import/export.
- `ViewportClassV1` — `compact`, `medium`, or `expanded`.
- `UiActionV1` — closed typed intents. Product-Wire request payloads reuse
  generated DTOs; file paths, file bytes, and handles never enter the ABI.

The `CaptureBundle` (Chromium observation with DOM bounds, computed styles,
authored declarations) never reaches a production renderer. Only the portable
`UiBlueprintDocumentV1` and typed state reach the scene. The deterministic
cross-language fixtures are:

- `packages/contracts/src/presentation/fixtures/character-manager-v1.json` — Product Wire state;
- `packages/contracts/src/presentation/fixtures/ui-blueprint-document-v1.json` — canonical document parsed by both TypeScript and Rust;
- `packages/contracts/src/presentation/fixtures/ui-blueprint-document-chat-v1.json` — chat surface document (M2 slice).

`UiSceneV1` is built from `UiBlueprintDocumentV1 + CharacterManagerStateV1 + ViewportClassV1`
(`materialize_character_manager_scene_v1_from_document`); the legacy
`materialize_character_manager_scene_v1(blueprint, viewport)` path is retained
for the state-only compilation. The chat surface materializes from
`UiBlueprintDocumentV1 + ChatSurfaceStateV1 + ViewportClassV1`.

## Deliberate V1 boundary

Product Wire currently lacks the full React Character Manager editor/gallery
fields (`personality`, `scenario`, `first message`, `extensions`, `gallery`,
`creator notes iframe`, etc.). V1 therefore does not claim native support for
Editor, Advanced, Gallery, plugin slots, creator-notes iframe content, or
sanitized-document layout. Extend Product Wire first, then add a new versioned
Blueprint slice.

Repeating elements (e.g. `character-card`) must carry `data-ui-key="<stable-id>"`
so `scripts/ui-oracle/capture.mjs` produces unique IDs like
`character-card.<character-id>` and the same resolved IDs in `parentNodeId`
and `actionTrace`; otherwise the strict importer rejects
`PRESENTATION_CAPTURE_DUPLICATE_NODE`.

Capture currently provides authored `::before`/`::after` declarations but not
resolved pseudo-element computed styles — an explicit pending strict-import
boundary documented in `scripts/ui-oracle/README.md` and `capture.mjs`.

## Development

```powershell
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-blueprint
node tools/presentation-codegen/codegen.mjs --check
```

See [ADR-0055](../../docs/adr/0055-react-ui-oracle-blueprint-pilot.md) for the
capture → blueprint → scene boundary and parity-gate rules.
