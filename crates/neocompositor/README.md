# NeoCompositor (`neotavern-neocompositor`)

Milestone B **STARTED** (not PASS): production types, a bounded
`FrameTransaction` mailbox, property trees, CPU scroll/animation fast
paths, async hit-test / nested-scroll dispatch, and a PERF-18 effect-scope
host golden (**IMPLEMENTED / GPU_PENDING**, not PASS). This is **not** a
production JNI renderer and **not** an Android cutover.

## What this crate is

- The shared interchange for Track D compositor work after D1/D2 GO.
- Consumed by M0 probe crates (`presentation-m0`, `presentation-m0-d2`) so
  probe and production types do not drift.
- UI/producer → render spine: monotonic `FrameId` / `SceneEpoch` /
  `DeviceEpoch`, immutable `FrameTransaction` (scene + property snapshot),
  latest-wins mailbox with item/byte caps, stale/device-epoch reject,
  resource retirement, and last-known-good on invalid graphs.
- Generation-safe `SpatialId` / `ScrollId` / `ClipId` / `EffectId` trees:
  parent/cycle checks at commit, dense present-loop sampling, sticky/fixed
  containing blocks, clip/effect chains, explicit backdrop roots. Hit-test
  and rendering share one snapshot/epoch.
- Compositor-thread scroll/animation fast paths: `AsyncScrollState` is
  separate from the immutable snapshot. Input mutates delta/velocity;
  producer acks rebase without teleport. Nested latch/handoff passes only
  unused delta. Transform/opacity animations sample monotonic presentation
  time (refresh-rate independent, retarget-continuous). Present is
  lock-free, allocation-free, and does not rasterize or call the producer.
- Async hit-test and nested-scroll dispatch: `HitTestSnapshot` is bound to
  the same `SceneEpoch` / `PropertySnapshot` as render. The walk is
  front-to-back by paint order, each candidate uses its own inverse
  (sticky/fixed already sampled; no global scroll inverse). Clip chain is
  checked before a hit; a singular transform is non-hittable. The target is
  a stable logical id plus generation. Pointer capture keeps that target
  across async scroll; a removed/recycled target gets `Cancel` and does not
  fall through to another message. Gesture latch/handoff reuse the same
  `ScrollId`. Targeting does not round-trip through Dioxus/layout.
- Interaction-ready text snapshots (RFC §21.1): immutable
  `TextInteractionSnapshot` bound to `SceneEpoch`, generation-safe
  `TextFragmentId`, producer-authored bidi runs / clusters / line metrics /
  glyph geometry. The compositor does not shape, layout, or fall back fonts.
  A fragment may span many tiles. Text, geometry, and property snapshots
  switch atomically on `FrameTransaction`. Stale/recycled fragments cancel
  instead of selecting another message.
- Cross-tile selection underlay (PERF-19 **IMPLEMENTED**, not PASS):
  `SelectionPaintOp` sits between the box/background chunk and transparent
  glyph/emoji chunks. Highlight is not baked into background or glyph
  tiles. Drag is `SELECTION_ONLY`: bounded damage, no shaping/layout, no
  glyph/background raster invalidation. Rects clip per tile from one
  logical geometry with shared snapping/apron rules. Color emoji and
  syntax colors do not go through a selection blend-mode. Selection under
  subsequent glass invalidates the dependent glass ROI. Handles/caret use
  the same property snapshot and async scroll state; autoscroll nudges an
  existing `ScrollId`. A fallback tile without an interaction snapshot is
  not a text target. This is **not** PERF-19 PASS (Android
  selection/autoscroll capture still required). The Blitz producer now
  publishes real snapshots via `PaintScene::host_text_fragment`; IME
  composition uses separate underlay ops without glyph-tile redraw.
- Effect-scope backdrop host golden (PERF-18 **IMPLEMENTED / GPU_PENDING**):
  ancestor opacity/filter/mask wrap prefix, glass, and foreground as one
  group; backdrop is sampled at the barrier from the parent root; group
  targets and glass ROI stay bounded; nested glass stays acyclic; malformed
  scopes are rejected before present and keep last-known-good. This is
  **not** PERF-18 PASS (Android Vulkan capture still required).

## What this crate is not

- Not linked into `libneotavern_android_jni.so`.
- Not a cutover switch. Public Android stays on the React/WebView path.
- `NEOTA_NEOCOMPOSITOR=1` is a **feature flag** for later host wiring. The
  default host is `PresentationHost::WebViewRollback`.
- GPU telemetry and device-loss recovery are not started (required before
  B PASS, not this slice). Mailbox high-water counters are in-memory only.
- Virtualization lives in `crates/chat-viewport`, not here (including
  geometry epochs / C0/C1 remap). Viewport↔compositor transactions live in
  `crates/presentation-session`. A gesture-platform adapter is **not**
  in this crate yet.

## RFC §50 progress

Started (CPU types + tests):

- ordered NeoDisplayList / paint-bridge types
- `compile_passes` (barrier-aware; scopes; MovingSample)
- GlassSurface / NeoGlass / NeoScene / damage rects
- bounded layer cache and target pool
- immutable `FrameTransaction` + bounded UI→render mailbox
- spatial / scroll / clip / effect property trees (sticky/fixed sampling,
  dirty subtree, generation-safe handles)
- compositor scroll/animation fast paths (async delta, ack/rebase, nested
  latch/handoff, timestamp animation)
- async hit-test + nested-scroll dispatch (same snapshot/epoch as render;
  capture/cancel; no Dioxus round trip)
- interaction-ready text snapshots (immutable, producer-shaped, atomic
  with geometry + property snapshots)
- cross-tile selection underlay (PERF-19 **IMPLEMENTED**, not PASS;
  Blitz producer snapshots land in this slice; Android selection/autoscroll
  capture still required)
- viewport remap / selection transactions in `crates/presentation-session`
  (PERF-19/20 host integration, not PASS, not production JNI)
- PERF-18 effect-scope backdrop host golden (**IMPLEMENTED / GPU_PENDING**,
  not PASS; Android Vulkan capture still required)
- M0-D1a pass-order corpus as a production regression (not a lab re-run)

Not started (do not treat as done):

- gesture-platform adapter
- GPU device/surface recovery
- shared-device raster interop in this crate (still in the M0 probe)
- GPU timing telemetry
- PERF-01…PERF-22 PASS and 120 Hz product budgets (PERF-18 remains
  **IMPLEMENTED / GPU_PENDING**; PERF-19 and PERF-20 host corpora are
  **IMPLEMENTED**, not PASS)

See [presentation boundary](../../docs/architecture/presentation-boundary.md)
and [ADR-0049](../../docs/adr/0049-track-d-dioxus-presentation.md).
