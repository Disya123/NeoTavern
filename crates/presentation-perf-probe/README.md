# presentation-perf-probe (`neotavern-presentation-perf-probe`)

Debug-only Android probe for PERF-18/19/20. **Not** production JNI, **not**
`MainActivity`, **not** Milestone B PASS. The probe logs evidence; only the
host adjudicator may stamp `PASS` or `BLOCKED` per criterion.

## Scenarios

| Extra `PERF_SCENARIO` | Evidence |
| --------------------- | -------- |
| `perf18` | Effect-scope golden through wgpu/Vulkan: glass inside opacity/transform/rounded clip; bounded world-space ROI copy |
| `perf19` | Cross-tile selection underlay + autoscroll; shape/layout/glyph raster stay 0 during drag |
| `perf20` | Multi-frame fling 10 000 px/s + exact `+350 px`; one `DeltaToken`; C0/C1 continuity |

```text
adb shell am start -n com.neotavern.mobile/.PresentationPerfActivity \
  --es com.neotavern.mobile.PERF_SCENARIO perf18 \
  --es com.neotavern.mobile.PERF_FRAMES 16 \
  --es com.neotavern.mobile.PERF_CAPTURE_FRAME 2
```

Negative `PERF_CAPTURE_FRAME` disables RenderDoc.

## Commands

```bash
cargo test -p neotavern-presentation-perf-probe --features gpu
M0_D1A_FEATURES=gpu,android-jni,renderdoc-capture bash apps/android/scripts/build-m0-d1a-libs.sh
```
