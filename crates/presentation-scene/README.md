# neotavern-presentation-scene

Platform core of the native presentation platform (ADR-0057): a
product-free retained-scene crate over taffy (layout), Parley (text) and
Vello (paint). This crate knows nothing about chats, the Kernel or any
product model — the product-facing projection lives in the chat-pilot
crate built on top of it.

Normative spec: `docs/architecture/native-presentation-platform.md`
(frame pipeline §3, invariants INV-1..7).

## Pipeline

```
Scene (retained tree, editor state)
  → SceneLayouter (taffy; Parley measure closure)
  → LayoutPass (absolute rects, shaped inputs)
  → FrameSnapshot::from_pass (single geometry: paint order, focus order,
    input frames, semantic items, digest)
  → consumers: render (vello), hit_test, semantic_items — all read the
    one snapshot; nothing recomputes geometry
```

## Modules

| Module     | Role                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arena`    | Epoch-validated scene arena; slot reuse bumps the epoch so stale `SceneId`s never alias.                                                                                   |
| `style`    | Tokenized styling model (colors, spacing, radii, control heights, type ramp, font stacks, `NodeLayout`). No literal values — the AGENTS §14 hardcoding bans hold in Rust.  |
| `theme`    | Theme data: token → concrete values. `Theme::golden_dark()` mirrors the React golden `--st-*` tokens.                                                                      |
| `editor`   | Char-boundary-safe text editing model (`Cursor`, `CursorOp`, pending insert batches, IME composition seam). The single editing model for every host bridge.                |
| `scene`    | The retained scene tree (`SceneNode`, `NodeKind`, `SceneAction`, `A11yRole`, slot ids for ADR-0058 plugin UI). Editors are `FieldId`-keyed and survive node churn (INV-1). |
| `text`     | Parley wrapper: shaping with per-run token overrides, caret geometry, point→byte-index, per-line selection rects.                                                          |
| `layout`   | `SceneLayouter`: taffy sync (retained taffy nodes for stable scene ids), measure closure delegating to the Parley engine, absolute-geometry read-back.                     |
| `snapshot` | `FrameSnapshot`: the single geometry of one frame + deterministic FNV digest (refactor-stability golden, INV-3) + semantic a11y export.                                    |
| `hit`      | Reverse-paint-order hit-testing against the snapshot; text fields resolve points to caret byte indices through the same shaped text (INV-2).                               |
| `render`   | Vello paint encoding of a snapshot (`gpu` feature; CPU-encodable headless — no GPU needed to produce a `vello::Scene`).                                                    |

## Public inputs

- `Scene::new()` / `root()` / `append_child` / `remove_subtree` /
  `hydrate_input` / `input_mut` (editor ops)
- `SceneLayouter::layout(&scene, &theme, &mut TextEngine, viewport) -> LayoutPass`
- `FrameSnapshot::from_pass(pass, &theme, &mut engine, revision)`
- `render::render_frame(&snapshot, &theme, &mut vello::Scene)` (gpu)
- `hit::hit_test(&snapshot, x, y) -> HitTarget`

## Dependencies

- `taffy` 0.12 (flexbox; std + taffy_tree), `parley` 0.10 (text),
  `neotavern-presentation-design-system` (golden font context + tokens)
- `vello`/`peniko` only behind the `gpu` feature

No dependency on the Kernel, storage, or any product crate — enforced by
review; the chat pilot owns the product wiring.

## Development commands

```bash
cargo test -p neotavern-presentation-scene
cargo test -p neotavern-presentation-scene --features gpu
```

## Constraints

- Product-free: no chat/Kernel imports here, ever.
- Token-only styling: literal colors/spacing/radii/control sizes are
  forbidden in this crate (they live in `Theme` data).
- One geometry: `FrameSnapshot` is the only source of rects; hit-test,
  focus order, a11y bounds and paint must not re-derive positions.
- Digest determinism: `FrameSnapshot::digest` must stay stable for
  unchanged frames on the same platform (refactor-stability goldens
  depend on it).

## Status (2026-10)

Phase 1 increment A: core complete, 33 unit tests, no product surface
mounted yet. The chat-screen pilot (`crates/presentation-scene-chat-pilot`)
is the next increment; GPU raster goldens are local-only and never CI.
