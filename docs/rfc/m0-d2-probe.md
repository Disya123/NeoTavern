# M0-D2 Dioxus/Blitz producer seam

**Status:** program **M0-D2 STARTED**, not PASS. Dynamic sample is in the
producer display list after the Dioxus/Blitz static seam. Host-side D1a and
D1b remain PASS. Normative M0 stays **`ENTERED`**. `D1=Track D GO` is not
granted. A Xiaomi rehearsal 1000-frame run and generation-120 Vulkan capture exist
(`2026-08-17T19-34-27-050Z` / `2026-08-17T19-41-18-304Z`); they are
**REHEARSAL / NON-ADMISSIBLE** (dirty/unbound APK) and MUST NOT be reused
for PASS. Admission requires a clean source bundle, BOUND APK, official
capture, and host adjudicator `--write`.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §48 stage 3  
**Crate:** [`crates/presentation-m0-d2`](../../crates/presentation-m0-d2/README.md)  
**Runbook:** [m0-d2-physical-runbook.md](m0-d2-physical-runbook.md)

D1a/D1b used a host-authored display list. Stage 3 requires geometry and text
to come from a real Dioxus `VirtualDom` and pinned Blitz layout/paint. A mock
list pasted on after layout is forbidden. Canonical glass order comes from
Blitz `render_element`, not a second DOM walk. The moving sample is inserted
into that producer `NeoDisplayList` immediately before Glass B — not via
`static_d1b_scene()`.

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

| Piece             | Implementation                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Raster/text paint | Blitz `paint_scene` → `ProducerSink: PaintScene`                                                                         |
| Glass             | `data-neoui="glass"` detected **inside** `blitz-paint` `render_element` after cull, before the node's background         |
| Marker API        | default `PaintScene::host_node_marker` (no-op on stock backends)                                                         |
| Display list      | Stream order only: `BeginEffectScope` → preceding draws → `BackdropBarrier(NodeId)` → following draws → `EndEffectScope` |
| Moving sample     | Compositor `StubPayload::MovingSample` inserted **after** the Blitz seam, immediately before the last glass barrier      |
| Diagnostic walk   | Preorder DOM glass ids. Must not define z-order                                                                          |
| Ancestor effect   | Blitz opacity/clip `push_layer` around Glass B                                                                           |

Patch set: [`crates/presentation-m0-d2/upstream/`](../../crates/presentation-m0-d2/upstream/README.md)
(**65** inserted lines). Rebase: `anyrender 0.11.1` `git apply --check` succeeds
(lib.rs hunks offset 3). `blitz-paint` 0.3.0-beta.1 is already latest crates.io
(`NOT_AVAILABLE`, not `FAIL`). Layout/text files are not patched. If this hook
had required a second scene builder, that would be **M0-D2 FAIL**. Upstream
landing stays a missing capability; M0 only needs a bounded, reproducible patch.

## Scene (static then dynamic)

```text
Dioxus/Blitz PaintOps
→ Glass A
→ vector UI
→ moving:gN
→ ROI-2:gN
→ Glass B:gN
→ overlay
```

Motion does not rebuild the display list or the compiled pass graph:

```text
pass_compiles=1
layout_rebuilds_during_motion=0
paint_scene_rebuilds_during_motion=0
```

Per frame after bake: compositor transform/blit, damage, and generation only.
Glass B samples the current `gN` accumulator, not `gN-1`. Timeline tokens use
the 1-based paint-order glass ordinal (`roi:2`), not a Blitz node id.

Fixtures also cover siblings, `z-index` hoist vs DOM order, nested/overlapping
glass, transform+clip+opacity, and balanced layer pops.

## Host adjudicator extras

`scripts/m0-d2-adjudicate.mjs` additionally requires:

- real `VirtualDom → Blitz paint_scene` (`producer_source=…host-node-marker`)
- both barriers from the paint hook (`glass_from_hook=2`)
- opacity/clip scope kept on Glass B (crate tests)
- `devices=1`, `readbacks=0`, `xdev=0`
- bounded ROI / stable `acc_bytes=1046528`
- `patch_lines=65`
- rebase AnyRender 0.11.1 = `PASS`
- newer Blitz release = `NOT_AVAILABLE` (not `FAIL`)

The probe still logs `capture=false`. D1a/D1b JSON is unchanged.

## Missing upstream capabilities

D2 cannot PASS while these remain:

1. Upstream landing of `PaintScene::host_node_marker` (local crates.io patch).
2. Typed Blitz Glass paint node beyond the `data-neoui` host marker.
3. Host-side D2 admission with a **BOUND** APK (`--bind-apk` on a clean tree)
   and `scripts/m0-d2-adjudicate.mjs --write`. A lab RenderDoc tree on a dirty
   worktree is not program PASS.

Estimated replacement surface if the pin set fails: keep the `NeoDisplayList`
cut and swap the producer without rewriting D1a/D1b compositor evidence.

## Non-goals

- Declaring M0-D2 PASS or `D2=Dioxus` without the host-side capture record.
- Changing `docs/rfc/m0-d1a-adjudication.json` or D1b admission.
- Linking this crate into production kernel JNI.
- Granting `D1=Track D GO` (needs TrackComparison/decision record after M0).

## Commands

```sh
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0-d2
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0-d2 --features gpu
pnpm exec vitest run scripts/m0-d2-adjudicate.test.mjs
```

Android (debug APK only):

```sh
M0_D1A_FEATURES=gpu,android-jni,renderdoc-capture bash apps/android/scripts/build-m0-d1a-libs.sh
adb shell am start -n com.neotavern.mobile/.M0D2Activity --es com.neotavern.mobile.M0_D2_FRAMES 1000 --es com.neotavern.mobile.M0_D2_CAPTURE_FRAME 120
node scripts/m0-d2-renderdoc-capture.mjs --mode=control --serial=8f5c2b7c
node scripts/m0-d2-renderdoc-capture.mjs --mode=capture --serial=8f5c2b7c
node scripts/m0-d2-adjudicate.mjs --stamp=<capture> --control-stamp=<control>
```

A green unit test is **STARTED** evidence, not program PASS.
