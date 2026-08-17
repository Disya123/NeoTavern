---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/m0-d2-probe.md
---

# M0-D2 Dioxus/Blitz producer seam

**Status:** program **M0-D2 STARTED**, not PASS. Host-side D1a and D1b remain
PASS. Normative M0 stays **`ENTERED`**. `D1=Track D GO` is not granted.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §48 stage 3  
**Crate:** [`crates/presentation-m0-d2`](https://github.com/Disya123/NeoTavern/blob/main/crates/presentation-m0-d2/README.md)

D1a/D1b used a host-authored display list. Stage 3 requires geometry and text
to come from a real Dioxus `VirtualDom` and pinned Blitz layout/paint. A mock
list pasted on after layout is forbidden. Canonical glass order comes from
Blitz `render_element`, not a second DOM walk.

## Pins (experimental, not production)

```text
dioxus-core / dioxus-core-macro / dioxus-hooks / dioxus-html / dioxus-native-dom = 0.8.0-alpha.1
blitz-dom / blitz-paint / blitz-traits = 0.3.0-beta.1
anyrender = 0.11.0 + host_node_marker patch (65 inserted lines with blitz-paint)
```

These match `presentation-m0` Vello **0.9** / wgpu **29**. Rejected:

- `dioxus-native 0.7.10` — Blitz 0.2 / anyrender 0.6 / older wgpu.
- Full `dioxus-native 0.8` renderer crate — pulls a winit 0.31 window shell
  into the workspace lockfile. Headless path is
  `DioxusDocument` → `initial_build` → `BaseDocument::resolve` →
  `blitz_paint::paint_scene`.

Alpha/beta crates are marked experimental. They are not a D2 GO.

## Paint boundary

RFC allows a public recording sink, a small upstreamable hook, or another
described bounded extension point.

| Piece | Implementation |
| --- | --- |
| Raster/text paint | Blitz `paint_scene` → `ProducerSink: PaintScene` |
| Glass | `data-neoui="glass"` detected **inside** `blitz-paint` `render_element` after cull, before the node's background |
| Marker API | default `PaintScene::host_node_marker` (no-op on stock backends) |
| Display list | Stream order only: `BeginEffectScope` → preceding draws → `BackdropBarrier(NodeId)` → following draws → `EndEffectScope` |
| Diagnostic walk | Preorder DOM glass ids. Must not define z-order |
| Ancestor effect | Blitz opacity/clip `push_layer` around Glass B |

Patch set: [`crates/presentation-m0-d2/upstream/`](https://github.com/Disya123/NeoTavern/blob/main/crates/presentation-m0-d2/upstream/README.md)
(**65** inserted lines). Rebase: `anyrender 0.11.1` `git apply --check` succeeds
(lib.rs hunks offset 3). `blitz-paint` 0.3.0-beta.1 is already latest crates.io.
Layout/text files are not patched. If this hook had required a second scene
builder, that would be **M0-D2 FAIL**.

## Scene (static)

```text
wallpaper
→ GlassSurface A
→ ordinary vector UI
→ bounded opacity/clip group
    → grouped vector
    → overlapping GlassSurface B
→ foreground overlay
```

Fixtures also cover siblings, `z-index` hoist vs DOM order, nested/overlapping
glass, transform+clip+opacity, and balanced layer pops.

## Missing upstream capabilities

D2 cannot PASS while these remain:

1. Upstream landing of `PaintScene::host_node_marker` (local crates.io patch).
2. Typed Blitz Glass paint node beyond the `data-neoui` host marker.
3. Producer-owned synthetic moving sample after the static seam.
4. Physical Android GPU capture of the producer path.

Estimated replacement surface if the pin set fails: keep the `NeoDisplayList`
cut and swap the producer without rewriting D1a/D1b compositor evidence.

## Non-goals

- Declaring M0-D2 PASS or `D2=Dioxus`.
- Changing `docs/rfc/m0-d1a-adjudication.json` or D1b admission.
- Linking this crate into production kernel JNI.
- Adding D1b moving sample before this paint-order hook.

## Commands

```sh
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0-d2
```

A green unit test is **STARTED** evidence, not program PASS.
