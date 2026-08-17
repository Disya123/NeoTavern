# NeoCompositor (`neotavern-neocompositor`)

Milestone B **start**: production types for NeoDisplayList, pass compilation,
GlassSurface, NeoScene, FrameTransaction, layer cache, target pool, NeoGlass,
and host selection.

This is **not** Milestone B PASS, **not** a production JNI renderer, and
**not** an Android cutover.

## What this crate is

- The shared interchange for Track D compositor work after D1/D2 GO.
- Consumed by M0 probe crates (`presentation-m0`, `presentation-m0-d2`) so
  probe and production types do not drift.

## What this crate is not

- Not linked into `libneotavern_android_jni.so`.
- Not a cutover switch. Public Android stays on the React/WebView path.
- `NEOTA_NEOCOMPOSITOR=1` is a **feature flag** for later host wiring. The
  default host is `PresentationHost::WebViewRollback`.
- GPU telemetry is not added (no telemetry by default).

## RFC §50 progress

Started (CPU types + tests):

- ordered NeoDisplayList / paint-bridge types
- `compile_passes` (barrier-aware; scopes; MovingSample)
- GlassSurface / NeoGlass / NeoScene / FrameTransaction / damage rects
- bounded layer cache and target pool
- spatial / clip / effect trees already on the display list

Not started (do not treat as done):

- scroll/animation fast paths
- GPU device/surface recovery
- shared-device raster interop in this crate (still in the M0 probe)
- height index / range predictor / tile cache
- overscan-miss fallback
- async scroll ack and spatial hit-test
- sticky/fixed compositor sampling
- interaction-ready text/selection
- geometry epochs / fling remap
- PERF-01…PERF-22 and 120 Hz product budgets

See [presentation boundary](../../docs/architecture/presentation-boundary.md)
and [ADR-0049](../../docs/adr/0049-track-d-dioxus-presentation.md).
