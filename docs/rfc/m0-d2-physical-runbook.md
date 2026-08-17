# M0-D2 physical capture runbook

**Status:** lab procedure. Program **M0-D2 PASS** is the host-side record
[`m0-d2-adjudication.json`](m0-d2-adjudication.json). Desktop Vulkan is
preliminary. D1a and D1b evidence/verdict must not be rewritten.
`D1=Track D GO` is not granted from this runbook; see
[m0-track-comparison.md](m0-track-comparison.md).

**Probe:** [m0-d2-probe.md](m0-d2-probe.md)  
**Schema:** `m0-d2-adjudication/v1` (`scripts/m0-d2-adjudicate.mjs`)  
**Device:** Xiaomi `8f5c2b7c` / `23122PCD1G` / Adreno 710  
**Tool:** RenderDoc **v1.45** at `E:\renderdoc`

## Required chain

```text
clean source bundle (node scripts/m0-d1a-source-bundle.mjs)
→ NDK .so with gpu,android-jni,renderdoc-capture
   (libneotavern_presentation_m0.so and libneotavern_presentation_m0_d2.so)
→ debug APK
→ bind APK (--bind-apk)
→ Xiaomi control: 1000 frames, M0_D2_CAPTURE_FRAME=-1, layers off
→ Xiaomi capture: same APK, layers on, capture at generation 120, then finish 1000 frames
→ renderdoccmd convert XML
→ host adjudicator (separate evidence commit)
```

Do not grant D2 PASS from logcat counters alone. `--bind-apk` refuses a dirty
worktree (`evidence_dirty=true`). Official capture admission is a later
evidence commit after the probe commit is on a clean tree.

## REHEARSAL / NON-ADMISSIBLE (dirty/unbound APK)

These stamps came from a dirty worktree / unbound APK. They MUST NOT be
reused for `--write` or program PASS:

| Role    | Stamp                      | Status                         |
| ------- | -------------------------- | ------------------------------ |
| control | `2026-08-17T19-34-27-050Z` | **REHEARSAL / NON-ADMISSIBLE** |
| capture | `2026-08-17T19-41-18-304Z` | **REHEARSAL / NON-ADMISSIBLE** |

Capture used a gitignored unbound helper, not the official
`m0-d2-renderdoc-capture.mjs --mode=capture` bind gate. The host adjudicator
rejects these stamps.

## Launch

Debug-only; not a launcher. Production `MainActivity` is unchanged.

```text
adb shell am start -n com.neotavern.mobile/.M0D2Activity --es com.neotavern.mobile.M0_D2_FRAMES 1000 --es com.neotavern.mobile.M0_D2_CAPTURE_FRAME -1
adb shell am start -n com.neotavern.mobile/.M0D2Activity --es com.neotavern.mobile.M0_D2_FRAMES 1000 --es com.neotavern.mobile.M0_D2_CAPTURE_FRAME 120
```

Helpers:

```text
node scripts/m0-d2-renderdoc-capture.mjs --mode=control --serial=8f5c2b7c
node scripts/m0-d2-renderdoc-capture.mjs --mode=capture --serial=8f5c2b7c
node scripts/m0-d2-adjudicate.mjs --stamp=<capture> --control-stamp=<control>
```

Wait at least three minutes: capture starts at frame 120, then the probe
finishes the remaining frames before it prints `m0-d2 gpu_ran=true`.

Captures land in gitignored `apps/android/m0-d2-captures/`. The APK bind
still uses `scripts/m0-d1a-source-bundle.mjs` (D1a captures dir).

## Capture proof

The Event Browser at generation 120 must show, in order:

```text
m0-d2-restore-static
→ m0-d2-moving-blit:g120
→ accumulator current generation
→ m0-d2-roi-read:2
→ m0-d2-glass:2:g120
→ m0-d2-overlay-blit
```

Reject `m0-d2-glass:2:g0` / `g119` on that frame. Restore of the static
prefix is a cache, not a D1a forbidden flatten.

## Golden counters (control and capture, except `capture_polls`)

```text
pass_compiles=1
layout_rebuilds=0
paint_scene_rebuilds=0
ui_rebuilds=0
moving_blits=1000
devices=1
readbacks=0
xdev=0
glass=1001
render_polls=0
capture_polls=0   # control / normal path
capture_polls=1   # capture run only, after EndFrameCapture
acc_bytes=1046528
sampled_gen=999
producer_source=dioxus-virtualdom+blitz-paint-traversal+host-node-marker
glass_from_hook=2
patch_lines=65
rebase_anyrender_0111=PASS
blitz_newer=NOT_AVAILABLE
capture_timeline=restore,moving:g120,roi:2,glass:2:g120,overlay
```

`raster` / `vello_rebuilds` must match each other and stay at the first-frame
bake count (Blitz emits more fills than the D1b mock). They must not grow
during motion.

## Admitted stamps (BOUND APK)

| Field             | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Control stamp     | `2026-08-17T20-11-00-619Z`                                         |
| Capture stamp     | `2026-08-17T20-11-27-178Z`                                         |
| APK source commit | `3036422`                                                          |
| APK SHA-256       | `ff425359b9a1c6e5aef205faa2e0542b136efa2f01cbe2268b2291ca951515ea` |
| `.rdc` SHA-256    | `e9cca1e7de465f67215bf0af6076c85d7370883ef2f9d0b1161b4b8f4f2a617f` |
| Device            | Xiaomi `8f5c2b7c` / Adreno 710 / Vulkan                            |
| `d2_verdict`      | **PASS**                                                           |
| Probe `capture=`  | false                                                              |
| `apk_linkage`     | `BOUND`                                                            |
| `evidence_dirty`  | false                                                              |

The probe cannot set `android_gpu_capture`. Only the host record flips it.

## After this PASS record

Technical M0 is closed. `D1=Track D GO` still requires an owner signature
on the [TrackComparison](m0-track-comparison.md). Upstream landing of the
paint hook stays in missing capabilities.
