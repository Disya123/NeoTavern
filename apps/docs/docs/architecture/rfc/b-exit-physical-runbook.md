---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/b-exit-physical-runbook.md
---

# PERF-15 / PERF-22 / device-loss physical batch

**Status:** lab procedure. Fixtures exist. Host records stay
**IMPLEMENTED** / **CPU_INJECTION** until a BOUND capture is adjudicated.
Milestone B remains **STARTED**. `almost_pass=false`. Production cutover
remains **NOT_STARTED**.

Independent records (failure of one never blocks writing the others):

| Criterion | Record | Current |
| --------- | ------ | ------- |
| PERF-15 | [perf-15-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/perf-15-adjudication.json) | `IMPLEMENTED` (no VisualSurface path) |
| PERF-22 | [perf-22-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/perf-22-adjudication.json) | `IMPLEMENTED` (platform fixture pending capture) |
| device-loss | [device-loss-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/device-loss-adjudication.json) | `CPU_INJECTION` |

PERF-15 cannot become PASS without a real VisualSurface / Product Wire
surface. A colored synthetic texture is not a substitute and is not an
ADR.

## Required chain

```text
independent baseline (node scripts/b-exit-independent-baseline.mjs)
  — cargo test -p neotavern-presentation-perf-probe --features gpu
  — production libneotavern_android_jni.so untouched / registered fingerprint
→ clean source bundle (node scripts/m0-d1a-source-bundle.mjs)
→ NDK debug probes only (build-m0-d1a-libs.sh)
   libneotavern_presentation_perf_probe.so
   NEVER scripts/build-libs.sh
→ debug APK
→ bind APK (--bind-apk, evidence_dirty=false)
→ independent launches:
   PresentationSurfaceActivity  perf22 / poster / fullscreen / error
   PresentationPerfActivity     perf15
   PresentationPerfActivity     recovery / recovery-fling / recovery-selection
   PresentationPerfActivity     recovery-surface / recovery-background
     (surface/background are NOT device-loss)
→ host adjudicators write three JSON files independently
```

## Launch

```text
adb shell am start -n com.neotavern.mobile/.PresentationSurfaceActivity --es com.neotavern.mobile.PERF_SCENARIO perf22 --es com.neotavern.mobile.PERF_CAPTURE_FRAME -1
adb shell am start -n com.neotavern.mobile/.PresentationPerfActivity --es com.neotavern.mobile.PERF_SCENARIO perf15 --es com.neotavern.mobile.PERF_FRAMES 48 --es com.neotavern.mobile.PERF_CAPTURE_FRAME -1
adb shell am start -n com.neotavern.mobile/.PresentationPerfActivity --es com.neotavern.mobile.PERF_SCENARIO recovery --es com.neotavern.mobile.PERF_CAPTURE_FRAME -1
```

Helpers:

```text
node scripts/b-exit-independent-baseline.mjs
node scripts/b-exit-physical-capture.mjs --fixture=perf22 --serial=8f5c2b7c
node scripts/b-exit-physical-adjudicate.mjs --write
node scripts/presentation-perf-bench-runner.mjs
```

Device-loss PASS requires `wgpu_destroyed=true` and `wgpu_recreated=true`
on the phone. CPU `LossDetected` is not physical.

After this batch the phone is not required to assemble the unified
benchmark runner for PERF-01…05 and PERF-11…17/21.
