# M0-D2 upstream patch set

Bounded paint-seam patches. Not a private fork of Blitz layout, Styło, or Parley.

| Crate         | Pin          | Patch                                                                                          | Inserted lines                            |
| ------------- | ------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `anyrender`   | 0.11.0       | [`anyrender-0.11.0-host-node-marker.patch`](anyrender-0.11.0-host-node-marker.patch)           | **35** (`src/lib.rs`, `src/recording.rs`) |
| `blitz-paint` | 0.3.0-beta.1 | [`blitz-paint-0.3.0-beta.1-glass-barrier.patch`](blitz-paint-0.3.0-beta.1-glass-barrier.patch) | **30** (`src/render.rs`)                  |
| **Total**     |              |                                                                                                | **65**                                    |

Vendored snapshots: [`crates/vendor/`](../../vendor/README.md) via `[patch.crates-io]` in `crates/Cargo.toml`.

## What the hook does

`PaintScene::host_node_marker` is a default no-op. `blitz-paint::render_element` calls it after culling and **before** drawing that node's background, so the marker sits in the real paint order (stacking context / `z-index` included). Layout and text shaping are unchanged.

## Rebase experiment (2026-08-17)

| Target                                | Result                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `anyrender 0.11.1` (latest crates.io) | **Applies.** `git apply --check` succeeded; lib.rs hunks offset by 3 lines. recording.rs applied cleanly. |
| `blitz-paint` newer than 0.3.0-beta.1 | **None on crates.io.** Pin is already latest.                                                             |

This does **not** land the patch upstream and is **not** M0-D2 PASS. A
successful rebase-check is required evidence that the seam is bounded.
