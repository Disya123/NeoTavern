# M0-D1b physical capture runbook

**Status:** lab procedure. Program **M0-D1b PASS** is the host-side record
[`m0-d1b-adjudication.json`](m0-d1b-adjudication.json), not the probe logcat
bit. Desktop Vulkan is preliminary. D1a evidence/verdict must not be rewritten.

**Probe:** [m0-d1b-probe.md](m0-d1b-probe.md)  
**Schema:** `m0-d1b-adjudication/v1` (`scripts/m0-d1b-adjudicate.mjs`)  
**Device:** Xiaomi `8f5c2b7c` / `23122PCD1G` / Adreno 710  
**Tool:** RenderDoc **v1.45** at `E:\renderdoc`

## Required chain

```text
clean source bundle (node scripts/m0-d1a-source-bundle.mjs)
→ NDK .so with gpu,android-jni,renderdoc-capture
→ debug APK
→ bind APK (--bind-apk)
→ Xiaomi control: 1000 frames, M0_D1B_CAPTURE_FRAME=-1, layers off
→ Xiaomi capture: same APK, layers on, capture at generation 120, then finish 1000 frames
→ renderdoccmd convert XML
→ host adjudicator (separate evidence commit)
```

Do not grant D1b PASS from logcat counters alone.

## Launch

Debug-only; not a launcher. Production `MainActivity` is unchanged.

```text
adb shell am start -n com.neotavern.mobile/.M0D1bActivity --es com.neotavern.mobile.M0_D1B_FRAMES 1000 --es com.neotavern.mobile.M0_D1B_CAPTURE_FRAME -1
adb shell am start -n com.neotavern.mobile/.M0D1bActivity --es com.neotavern.mobile.M0_D1B_FRAMES 1000 --es com.neotavern.mobile.M0_D1B_CAPTURE_FRAME 120
```

Helpers:

```text
node scripts/m0-d1b-renderdoc-capture.mjs --mode=control --serial=8f5c2b7c
node scripts/m0-d1b-renderdoc-capture.mjs --mode=capture --serial=8f5c2b7c
node scripts/m0-d1b-adjudicate.mjs --stamp=<capture> --control-stamp=<control>
```

Wait at least three minutes: capture starts at frame 120, then the probe
finishes the remaining frames before it prints `m0-d1b gpu_ran=true`.

Captures land in gitignored `apps/android/m0-d1b-captures/`. The APK bind
still uses `scripts/m0-d1a-source-bundle.mjs` (D1a captures dir).

## Capture proof

The Event Browser at generation 120 must show, in order:

```text
m0-d1b-moving-blit:g120
→ accumulator current generation
→ m0-d1b-roi-read:2
→ m0-d1b-glass:2:g120
```

Reject `m0-d1b-glass:2:g0` / `g119` on that frame. Restore of the static
prefix (`m0-d1b-restore-static`) is a cache, not a D1a forbidden flatten.

## Golden counters (control and capture, except `capture_polls`)

```text
pass_compiles=1
vello_rebuilds=4
layout_rebuilds=0
ui_rebuilds=0
moving_blits=1000
devices=1
readbacks=0
xdev=0
raster=4
glass=1001
render_polls=0
capture_polls=0   # control / normal path
capture_polls=1   # capture run only, after EndFrameCapture
acc_bytes=1046528
capture=false
```

`capture_polls` must not be counted as a production render-thread wait.

## Admission

Host-side `scripts/m0-d1b-adjudicate.mjs --write` wrote
[`docs/rfc/m0-d1b-adjudication.json`](m0-d1b-adjudication.json) after the
physical artifacts below.

| Split             | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Capture stamp     | `2026-08-17T18-15-34-453Z`                                         |
| Control stamp     | `2026-08-17T18-15-03-717Z`                                         |
| APK source commit | `21b38c0`                                                          |
| APK SHA-256       | `089744f364a24018bbea15ffb51abd8a4cc7ebcf4ab2fe887285ba12f41384e6` |
| `.rdc` SHA-256    | `7768ec08d2b7288dee98d8ea8cb242d95dbbb032f1abdc94221327d7d6c167ad` |
| Device            | Xiaomi `8f5c2b7c` / Adreno 710 / Vulkan                            |
| `d1b_verdict`     | **PASS**                                                           |
| Probe `capture=`  | false                                                              |

The probe cannot set `android_gpu_capture`. Only this host record flips it.

## Non-goals

- Changing `docs/rfc/m0-d1a-adjudication.json`
- Treating desktop Vulkan as D1b PASS
- `D1=Track D GO`
- Treating this runbook as M0-D2 PASS. D2 dynamic sample is STARTED; see
  [m0-d2-probe.md](m0-d2-probe.md) and
  [m0-d2-physical-runbook.md](m0-d2-physical-runbook.md) (not PASS)
