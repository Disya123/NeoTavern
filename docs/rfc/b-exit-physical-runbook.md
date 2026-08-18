# PERF-15 / PERF-22 / device-loss physical batch

**Status:** adjudicated on Xiaomi `8f5c2b7c` / Adreno 710 / Vulkan from
BOUND debug APK `a6cbae7`. Independent records:

| Criterion   | Record                                                         | Status                                                                |
| ----------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| PERF-15     | [perf-15-adjudication.json](perf-15-adjudication.json)         | `PASS` (reference VisualSurfaceFrameIngress; not PluginVisualSurface) |
| PERF-22     | [perf-22-adjudication.json](perf-22-adjudication.json)         | `PASS`                                                                |
| device-loss | [device-loss-adjudication.json](device-loss-adjudication.json) | `PASS`                                                                |

Milestone B remains **STARTED**. `almost_pass=false`. Production cutover
remains **NOT_STARTED**. PERF-15 PASS is the B-level
`VisualSurfaceFrameIngress` reference producer
([ADR-0050](../adr/0050-visual-surface-ingress-vs-plugin.md)). It does not
claim `PluginVisualSurface` or Milestone D. D3 stays **DEFERRED**.

## Required chain

```text
independent baseline (node scripts/b-exit-independent-baseline.mjs)
  — cargo test -p neotavern-presentation-perf-probe --features gpu
  — production libneotavern_android_jni.so untouched (gitignored prebuilt)
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
node scripts/b-exit-physical-adjudicate.mjs --write --apk-linkage=BOUND --evidence-dirty=false
node scripts/presentation-perf-bench-runner.mjs
```

Admitted physical stamps (gitignored captures under
`apps/android/b-exit-captures/`):

- PERF-22 panel `2026-08-18T17-57-00-885Z` plus poster / fullscreen / error
- PERF-15 `2026-08-18T18-56-59-678Z` (`visual_surface=present`,
  `producer=reference-visual-surface`, `plugin_runtime=false`)
- device-loss raster/composite `2026-08-18T17-57-57-104Z`
  (`wgpu_destroyed=true`, `wgpu_recreated=true`, two `open_probe_device`)

After this batch the phone is not required to assemble the unified
benchmark runner for PERF-01…05 and PERF-11…17/21
(`node scripts/presentation-perf-bench-runner.mjs --execute`). Host
corpora are not independent PASS.
