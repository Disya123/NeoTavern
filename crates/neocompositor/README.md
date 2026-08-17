# NeoCompositor (`neotavern-neocompositor`)

Milestone B **STARTED** (not PASS): production types, a bounded
`FrameTransaction` mailbox, property trees, and CPU scroll/animation fast
paths. This is **not** a production JNI renderer and **not** an Android
cutover.

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

## What this crate is not

- Not linked into `libneotavern_android_jni.so`.
- Not a cutover switch. Public Android stays on the React/WebView path.
- `NEOTA_NEOCOMPOSITOR=1` is a **feature flag** for later host wiring. The
  default host is `PresentationHost::WebViewRollback`.
- GPU telemetry and device-loss recovery are not started (required before
  B PASS, not this slice). Mailbox high-water counters are in-memory only.
- Hit-test event dispatch, virtualization, and a gesture-platform adapter
  are **not** in this crate yet (separate commits). PERF-14/17/18/21 are
  not closed.

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
- M0-D1a pass-order corpus as a production regression (not a lab re-run)

Not started (do not treat as done):

- PERF-14/17/18/21 (async hit-test, sticky/fixed product completeness,
  effect scopes, nested scroll product handoff)
- virtualization, selection, geometry remap
- hit-test event dispatch / gesture-platform adapter
- GPU device/surface recovery
- shared-device raster interop in this crate (still in the M0 probe)
- GPU timing telemetry
- PERF-01…PERF-22 and 120 Hz product budgets

See [presentation boundary](../../docs/architecture/presentation-boundary.md)
and [ADR-0049](../../docs/adr/0049-track-d-dioxus-presentation.md).
