---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/perf-18-20-physical-runbook.md
---

# PERF-18/19/20 physical capture runbook

**Status:** lab procedure. Host adjudicator
[`scripts/perf-18-20-adjudicate.mjs`](https://github.com/Disya123/NeoTavern/blob/main/scripts/perf-18-20-adjudicate.mjs)
stamps each criterion independently:

```text
PERF-18 = PASS | BLOCKED
PERF-19 = PASS | BLOCKED
PERF-20 = PASS | BLOCKED
Milestone B = STARTED
```

There is no combined «almost PASS». Milestone B stays STARTED even if all
three are PASS. Production `MainActivity` / WebView rollback is unchanged.

**Device:** Xiaomi `8f5c2b7c` / `23122PCD1G` / Adreno 710  
**Tool:** RenderDoc **v1.45** at `E:\renderdoc`

## Required chain

```text
clean source bundle (node scripts/m0-d1a-source-bundle.mjs)
→ NDK .so with gpu,android-jni,renderdoc-capture
   (libneotavern_presentation_m0.so, libneotavern_presentation_m0_d2.so,
    libneotavern_presentation_perf_probe.so)
→ debug APK
→ bind APK (--bind-apk, evidence_dirty=false)
→ three independent launches: perf18 / perf19 / perf20
→ control (CAPTURE_FRAME=-1) then capture (RenderDoc layers on)
→ PERF-20 also keeps a multi-frame `perf20-frame` logcat trace
→ host adjudicator (separate evidence commit)
```

PERF-20 is **not** a single RenderDoc frame. Velocity continuity is the
JSONL/`perf20-frame` stream.

## Launch

```text
adb shell am start -n com.neotavern.mobile/.PresentationPerfActivity --es com.neotavern.mobile.PERF_SCENARIO perf18 --es com.neotavern.mobile.PERF_FRAMES 16 --es com.neotavern.mobile.PERF_CAPTURE_FRAME -1
adb shell am start -n com.neotavern.mobile/.PresentationPerfActivity --es com.neotavern.mobile.PERF_SCENARIO perf18 --es com.neotavern.mobile.PERF_FRAMES 16 --es com.neotavern.mobile.PERF_CAPTURE_FRAME 2
```

Same extras with `perf19` / `perf20`. `perf20` should run ≥48 frames.

Helpers:

```text
node scripts/perf-18-20-renderdoc-capture.mjs --mode=control --scenario=perf18 --serial=8f5c2b7c
node scripts/perf-18-20-renderdoc-capture.mjs --mode=capture --scenario=perf18 --serial=8f5c2b7c
node scripts/perf-18-20-renderdoc-capture.mjs --mode=control --scenario=perf19 --serial=8f5c2b7c
node scripts/perf-18-20-renderdoc-capture.mjs --mode=capture --scenario=perf19 --serial=8f5c2b7c
node scripts/perf-18-20-renderdoc-capture.mjs --mode=control --scenario=perf20 --serial=8f5c2b7c
node scripts/perf-18-20-renderdoc-capture.mjs --mode=capture --scenario=perf20 --serial=8f5c2b7c
node scripts/perf-18-20-adjudicate.mjs --perf18-stamp=... --perf19-stamp=... --perf20-stamp=...
```

Adjudicator output is always independent:

```text
PERF-18 = PASS | BLOCKED
PERF-19 = PASS | BLOCKED
PERF-20 = PASS | BLOCKED
Milestone B = STARTED
```
