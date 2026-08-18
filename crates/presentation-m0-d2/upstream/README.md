# M0-D2 upstream patch set

Bounded paint-seam patches. Not a private fork of Blitz layout, Styło, or Parley.

| Crate         | Pin          | Patch                                                                                          | Inserted lines                                     |
| ------------- | ------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `anyrender`   | 0.11.0       | [`anyrender-0.11.0-host-node-marker.patch`](anyrender-0.11.0-host-node-marker.patch)           | **97** (`src/lib.rs`, `src/recording.rs`)          |
| `blitz-paint` | 0.3.0-beta.1 | [`blitz-paint-0.3.0-beta.1-glass-barrier.patch`](blitz-paint-0.3.0-beta.1-glass-barrier.patch) | **197** (`src/render.rs`, `src/text.rs`)           |
| **Total**     |              |                                                                                                | **294**                                            |

Vendored snapshots: [`crates/vendor/`](../../vendor/README.md) via `[patch.crates-io]` in `crates/Cargo.toml`.

## What the hooks do

`PaintScene::host_node_marker` is a default no-op. `blitz-paint::render_element` calls it after culling and **before** drawing that node's background, so the marker sits in the real paint order (stacking context / `z-index` included).

`PaintScene::host_text_fragment` is a default no-op. `blitz-paint` emits it from the already-shaped Parley `Layout` during `draw_inline_layout` / text-input paint (clusters, bidi maps, caret stops, glyph geometry). Layout and text shaping are not re-run. Recording `Scene` does not store text fragments; live sinks override the hook.

## Rebase experiment (2026-08-18)

| Target                                | Result                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `anyrender 0.11.1` (latest crates.io) | **Applies.** `git apply --check` succeeded; lib.rs hunks offset by 3 lines. recording.rs applied cleanly. |
| `blitz-paint` newer than 0.3.0-beta.1 | **None on crates.io.** Pin is already latest.                                                             |

This does **not** land the patch upstream and is **not** a status raise. A
successful rebase-check is required evidence that the seam is bounded.
