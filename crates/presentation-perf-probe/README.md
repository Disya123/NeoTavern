# presentation-perf-probe (`neotavern-presentation-perf-probe`)

Debug-only Android probe for PERF-18/19/20, shared-device raster
interop, and the input-to-present present loop (`PresentationI2pProbe`).
**Not** production JNI, **not** `MainActivity`, **not** Milestone B PASS
or production cutover. Host stamps live in
[`docs/rfc/perf-18-20-adjudication.json`](../../docs/rfc/perf-18-20-adjudication.json)
(`PERF-18=PASS`, `PERF-19=PASS`, `PERF-20=PASS`, `Milestone B=STARTED`).
Interop capture does not stamp Milestone B PASS. Host stamp:
[`docs/rfc/shared-device-interop-adjudication.json`](../../docs/rfc/shared-device-interop-adjudication.json)
(`shared_device_interop=PASS`, `Milestone B=STARTED`).

## Scenarios

| Extra `PERF_SCENARIO` | Evidence                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perf18`              | Effect-scope golden through wgpu/Vulkan: glass inside opacity/transform/rounded clip; bounded world-space ROI copy                                                                        |
| `perf19`              | Cross-tile selection underlay + autoscroll; shape/layout/glyph raster stay 0 during drag                                                                                                  |
| `perf20`              | Multi-frame fling 10 000 px/s + exact `+350 px`; one `DeltaToken`; C0/C1 continuity                                                                                                       |
| `interop`             | Shared-device raster↔compositor path: `devices=1`, `image_readbacks=0`, `xdev=0`; raster texture sampled by compositor/glass. Host **PASS** on physical Vulkan (not B PASS, not cutover). |

```text
adb shell am start -n com.neotavern.mobile/.PresentationPerfActivity \
  --es com.neotavern.mobile.PERF_SCENARIO interop \
  --es com.neotavern.mobile.PERF_FRAMES 16 \
  --es com.neotavern.mobile.PERF_CAPTURE_FRAME 2
```

Negative `PERF_CAPTURE_FRAME` disables RenderDoc.

## Input-to-present (debug host)

`PresentationInputActivity` presents a retained texture to a **window
swapchain** on a compositor `HandlerThread`. The UI thread only
`try_push`es. `Choreographer#doFrame` is not `actualPresentTime`.

```text
adb shell am start -n com.neotavern.mobile/.PresentationInputActivity \
  --es com.neotavern.mobile.I2P_FIXTURE all \
  --ei com.neotavern.mobile.I2P_HZ 120 \
  --ei com.neotavern.mobile.I2P_WARMUP_MS 2000 \
  --ei com.neotavern.mobile.I2P_SCROLL_MS 60000
```

Physical capture: `node scripts/input-to-present-perfetto-capture.mjs`.
Host adjudication: `node scripts/input-to-present-adjudicate.mjs`.

## Commands

```bash
cargo test -p neotavern-presentation-perf-probe --features gpu
M0_D1A_FEATURES=gpu,android-jni,renderdoc-capture bash apps/android/scripts/build-m0-d1a-libs.sh
```
