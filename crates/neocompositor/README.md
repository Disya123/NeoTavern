# NeoCompositor (`neotavern-neocompositor`)

Milestone B **STARTED** (not PASS): production types, a bounded
`FrameTransaction` mailbox, property trees, CPU scroll/animation fast
paths, async hit-test / nested-scroll dispatch, and a PERF-18 effect-scope
capture (**PASS** on physical Vulkan, not B PASS). This is **not** a
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
  `ScrollId`. Targeting does not round-trip through Dioxus/layout. The
  Android MotionEvent / Choreographer adapter (`platform_input`) forwards
  raw screen samples and `eventTimeNanos`, coalesces MOVE latest-wins on a
  bounded queue, and must not wait on compositor/producer/layout. It is
  wired only to the debug `PresentationInputActivity` / flagged shell, not
  production `MainActivity` or default JNI. Instrumented coverage is
  `PresentationInputInstrumentedTest`. Status: `IMPLEMENTED /
PERFETTO_PENDING`. Physical FrameTimeline/SurfaceFlinger input-to-present
  is still pending; the host adjudicator does not treat raw
  input-to-present as a one-refresh PASS gate.
- Interaction-ready text snapshots (RFC §21.1): immutable
  `TextInteractionSnapshot` bound to `SceneEpoch`, generation-safe
  `TextFragmentId`, producer-authored bidi runs / clusters / line metrics /
  glyph geometry. The compositor does not shape, layout, or fall back fonts.
  A fragment may span many tiles. Text, geometry, and property snapshots
  switch atomically on `FrameTransaction`. Stale/recycled fragments cancel
  instead of selecting another message.
- Cross-tile selection underlay (PERF-19 **PASS** on physical Vulkan, not
  B PASS):
  `SelectionPaintOp` sits between the box/background chunk and transparent
  glyph/emoji chunks. Highlight is not baked into background or glyph
  tiles. Drag is `SELECTION_ONLY`: bounded damage, no shaping/layout, no
  glyph/background raster invalidation. Rects clip per tile from one
  logical geometry with shared snapping/apron rules. Color emoji and
  syntax colors do not go through a selection blend-mode. Selection under
  subsequent glass invalidates the dependent glass ROI. Handles/caret use
  the same property snapshot and async scroll state; autoscroll nudges an
  existing `ScrollId`. A fallback tile without an interaction snapshot is
  not a text target. The Blitz producer publishes snapshots via
  `PaintScene::host_text_fragment`; IME composition uses separate underlay
  ops without glyph-tile redraw.
- Effect-scope backdrop (PERF-18 **PASS** on physical Vulkan, not B PASS):
  ancestor opacity/filter/mask wrap prefix, glass, and foreground as one
  group; backdrop is sampled at the barrier from the parent root; group
  targets and glass ROI stay bounded; nested glass stays acyclic; malformed
  scopes are rejected before present and keep last-known-good.
- Device/surface recovery (RFC §36 / T13, CPU injection-tested, not B PASS):
  `GpuRecovery` owns the RFC §36 phases through `Ready` or `Degraded`.
  `Timeout` skips a frame without rebuild. Surface outdated/lost recreates
  surface/config on the same `DeviceEpoch`. Device loss bumps `DeviceEpoch`,
  destroys device-bound cache/targets/pipelines/handles, keeps `SceneEpoch`
  and product text/geometry/selection/logical scroll, rejects stale
  transactions / callbacks / retirement leases, keeps the mailbox
  bounded/latest-wins, and builds the first restored frame from the new epoch
  only. Bounded attempts then `Degraded` with acting WebView rollback. OOM
  does not start a recreate loop. Not production JNI.
- Bounded GPU telemetry (CPU counters, not B PASS): `GpuTelemetry` is a
  copy-sized snapshot of queue/cache/target bytes and high-water, dropped/
  coalesced frames, recovery reason/duration/attempt, epoch, frame cause,
  damage/ROI, GPU timing availability (`Unavailable` on this snapshot;
  timestamp queries live on `InteropTelemetry` and are not image
  readbacks), and degraded/rollback reason. Not an event log.
- Shared-device raster interop (RFC T18, CPU protocol + debug probe, not
  B PASS): one `SharedGpuContext` (`Instance`/`Adapter`/`Device`/`Queue`/
  `DeviceEpoch` protocol). Blitz/Vello raster binds that context and does
  not open a second device. Raster tiles, accumulator, glass ROI, and
  surface share the epoch. Typed GPU handles reject foreign/stale owners
  before submit. Raster output is a sampleable compositor texture:
  `image_readbacks = 0`, `cross_device_copies = 0`. Timestamp queries are
  capability-gated (`GpuTiming::Unavailable` or bounded async resolve) and
  do not block present. Retirement leases outlive latest-wins drops.
  Queue pressure is capped (`QUEUE_CAP`). Device loss uses `GpuRecovery`.
  Unsupported compute degrades to WebView rollback without a second device.
  Debug `PERF_SCENARIO=interop` is host **PASS** on physical Vulkan (not a
  cutover).

## What this crate is not

- Not linked into `libneotavern_android_jni.so`.
- Not a cutover switch. Public Android stays on the React/WebView path.
- `NEOTA_NEOCOMPOSITOR=1` is a **feature flag** for later host wiring. The
  default host is `PresentationHost::WebViewRollback`.
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
- cross-tile selection underlay (PERF-19 **PASS** on physical Vulkan, not
  B PASS; Blitz producer snapshots)
- viewport remap / selection transactions in `crates/presentation-session`
  (PERF-19/20 host integration; criteria PASS on physical Vulkan; not
  production JNI)
- PERF-18 effect-scope backdrop (**PASS** on physical Vulkan, not B PASS)
- M0-D1a pass-order corpus as a production regression (not a lab re-run)
- device/surface recovery CPU state machine (injection tests; not production
  JNI)
- bounded GPU telemetry / recovery counters (CPU snapshot; GPU timestamps on
  that snapshot stay `Unavailable`; interop timestamps are separate)
- shared-device raster interop CPU protocol (`SharedGpuContext`; one device;
  sampleable raster texture; no image readback / cross-device copy; debug
  `interop` probe path; host **PASS** on physical Vulkan; not production JNI)
- Android MotionEvent / Choreographer adapter (host-side; debug/flagged
  shell only; not production JNI; `IMPLEMENTED / PERFETTO_PENDING`)

Not started (do not treat as done):

- remaining PERF-01…PERF-22 and 120 Hz product budgets (PERF-18/19/20
  are independently PASS; Milestone B stays STARTED)
- physical FrameTimeline/SurfaceFlinger input-to-present for the gesture
  adapter (`IMPLEMENTED / PERFETTO_PENDING`)

See [presentation boundary](../../docs/architecture/presentation-boundary.md)
and [ADR-0049](../../docs/adr/0049-track-d-dioxus-presentation.md).
