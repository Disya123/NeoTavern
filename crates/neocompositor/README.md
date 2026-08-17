# NeoCompositor (`neotavern-neocompositor`)

Milestone B **STARTED** (not PASS): production types plus a bounded
`FrameTransaction` mailbox. This is **not** a production JNI renderer and
**not** an Android cutover.

## What this crate is

- The shared interchange for Track D compositor work after D1/D2 GO.
- Consumed by M0 probe crates (`presentation-m0`, `presentation-m0-d2`) so
  probe and production types do not drift.
- UI/producer → render spine: monotonic `FrameId` / `SceneEpoch` /
  `DeviceEpoch`, immutable `FrameTransaction`, latest-wins mailbox with
  item/byte caps, stale/device-epoch reject, resource retirement, and
  last-known-good on invalid graphs.

## What this crate is not

- Not linked into `libneotavern_android_jni.so`.
- Not a cutover switch. Public Android stays on the React/WebView path.
- `NEOTA_NEOCOMPOSITOR=1` is a **feature flag** for later host wiring. The
  default host is `PresentationHost::WebViewRollback`.
- GPU telemetry and device-loss recovery are not started (required before
  B PASS, not this slice). Mailbox high-water counters are in-memory only.

## RFC §50 progress

Started (CPU types + tests):

- ordered NeoDisplayList / paint-bridge types
- `compile_passes` (barrier-aware; scopes; MovingSample)
- GlassSurface / NeoGlass / NeoScene / damage rects
- bounded layer cache and target pool
- immutable `FrameTransaction` + bounded UI→render mailbox
- M0-D1a pass-order corpus as a production regression (not a lab re-run)

Not started (do not treat as done):

- spatial scroll / clip / effect trees beyond the display-list snapshot
- scroll/animation fast paths
- PERF-14/17/18/21 (async hit-test, sticky/fixed, effect scopes, nested scroll)
- virtualization, selection, geometry remap
- GPU device/surface recovery
- shared-device raster interop in this crate (still in the M0 probe)
- GPU timing telemetry
- PERF-01…PERF-22 and 120 Hz product budgets

See [presentation boundary](../../docs/architecture/presentation-boundary.md)
and [ADR-0049](../../docs/adr/0049-track-d-dioxus-presentation.md).
