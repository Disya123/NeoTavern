# M0-D1a physical capture runbook

**Status:** lab procedure after `GateP:P1`. Does **not** admit D1a PASS by
itself. PRE-GATE desktop/AVD artifacts stay unadmitted.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §48  
**Decision:** [gate-p-decision-draft.md](gate-p-decision-draft.md)  
**Probe:** [m0-d1a-probe.md](m0-d1a-probe.md)

## Required chain

```text
clean source bundle (evidence_dirty=false)
→ APK built from that commit (apk_linkage=BOUND via --bind-apk)
→ physical Android production GPU (not AVD, not software renderer)
→ GPU capture (AGI or RenderDoc): pass/resource order + two accumulator reads
→ D1a verdict
```

Counters, the host API timeline, and wgpu debug groups **do not** replace
the capture.

## Capture labels the frame must show

| Order                | Label / debug group                                       | Resource                                  |
| -------------------- | --------------------------------------------------------- | ----------------------------------------- |
| 1                    | `m0-d1a-clear-acc`                                        | write `m0-d1a-accumulator`                |
| then, per raster     | Vello raster into `m0-d1a-vello`, blit `m0-d1a-blit-pass` | write accumulator                         |
| barrier 1            | `m0-d1a-roi-read:1`                                       | **read** accumulator → `m0-d1a-glass-roi` |
| barrier 1            | `m0-d1a-glass` / `m0-d1a-glass-pass`                      | sample snapshot, write accumulator ROI    |
| … more raster/blit … |                                                           |                                           |
| barrier 2            | `m0-d1a-roi-read:2`                                       | **read** accumulator → snapshot           |
| barrier 2            | `m0-d1a-glass` / `m0-d1a-glass-pass`                      | sample snapshot, write accumulator ROI    |

Both ROI copies MUST be same-device copies of `m0-d1a-accumulator` at the
barrier paint position. A CPU readback or a second device is FAIL/REPLACE,
not PASS.

## Host commands (pinned source)

Set `ANDROID_HOME` to the full SDK (this lab: `E:\android_sdk`), not a
`platform-tools`-only tree.

```sh
node scripts/m0-d1a-source-bundle.mjs
bash apps/android/scripts/build-m0-d1a-libs.sh
bash apps/android/scripts/build-libs.sh
pnpm --filter @neotavern/web build
gradle -p apps/android :app:assembleDebug
node scripts/m0-d1a-source-bundle.mjs --apk apps/android/app/build/outputs/apk/debug/app-debug.apk --bind-apk
```

`--bind-apk` is allowed only when `evidence_dirty=false` and the APK was
built from that tree.

## Device

`adb devices -l` MUST list a **physical** `usb:` transport. `emulator-*`
and `sdk_gphone*` are partial evidence only.

```sh
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.neotavern.mobile/.M0D1aActivity
```

## Capture tools (free; not a paid farm)

Install one of:

- [Android GPU Inspector](https://gpuinspector.dev/) (preferred on Android)
- [RenderDoc](https://renderdoc.org/) with the Android capture layer

Capture **one** completed D1a frame (100-frame run is for lifetime; the
order proof is the first frame). Export pass/resource timeline showing the
two accumulator reads. Store the capture under
`apps/android/m0-d1a-captures/` (gitignored) and cite the path from
`m0-d1a-probe.md`.

Do not set `android_gpu_capture=true` in the probe because a capture file
exists on disk. Flip that bit only in the **evidence-admission record**
after a reviewer confirms the two reads.

## What this lab currently lacks

Recorded 2026-08-17 after `GateP:P1`:

| Need               | This host                                               |
| ------------------ | ------------------------------------------------------- |
| Physical Android   | **missing** (`adb` = `emulator-5554` only)              |
| AGI / RenderDoc    | **missing** (not installed)                             |
| Full SDK / NDK     | present at `E:\android_sdk` (NDK 27–29)                 |
| Gradle 8.9 on PATH | **missing** (repo has no `gradlew`; CI installs Gradle) |
| Paid device farm   | not used                                                |

The single external step that unblocks D1a PASS: attach a physical Android
that meets the Gate P qualified-device definition, install a free GPU
capture tool, rebuild the APK from the pinned commit, capture one frame.

D1b stays `NOT_STARTED` until that PASS.
