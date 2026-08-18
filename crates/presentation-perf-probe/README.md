# presentation-perf-probe (`neotavern-presentation-perf-probe`)

Debug-only Android probe for PERF-18/19/20 and shared-device raster
interop. **Not** production JNI, **not** `MainActivity`, **not**
Milestone B PASS. Host stamps live in
[`docs/rfc/perf-18-20-adjudication.json`](../../docs/rfc/perf-18-20-adjudication.json)
(`PERF-18=PASS`, `PERF-19=PASS`, `PERF-20=PASS`, `Milestone B=STARTED`).
Interop capture does not stamp Milestone B PASS.

## Scenarios

| Extra `PERF_SCENARIO` | Evidence                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `perf18`              | Effect-scope golden through wgpu/Vulkan: glass inside opacity/transform/rounded clip; bounded world-space ROI copy                         |
| `perf19`              | Cross-tile selection underlay + autoscroll; shape/layout/glyph raster stay 0 during drag                                                   |
| `perf20`              | Multi-frame fling 10 000 px/s + exact `+350 px`; one `DeltaToken`; C0/C1 continuity                                                        |
| `interop`             | Shared-device raster↔compositor path: `devices=1`, `image_readbacks=0`, `xdev=0`; raster texture sampled by compositor/glass. Not cutover. |

```text
adb shell am start -n com.neotavern.mobile/.PresentationPerfActivity \
  --es com.neotavern.mobile.PERF_SCENARIO interop \
  --es com.neotavern.mobile.PERF_FRAMES 16 \
  --es com.neotavern.mobile.PERF_CAPTURE_FRAME 2
```

Negative `PERF_CAPTURE_FRAME` disables RenderDoc.

## Commands

```bash
cargo test -p neotavern-presentation-perf-probe --features gpu
M0_D1A_FEATURES=gpu,android-jni,renderdoc-capture bash apps/android/scripts/build-m0-d1a-libs.sh
```
