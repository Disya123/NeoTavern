# M0-D1a physical capture runbook

**Status:** lab procedure after `GateP:P1`. Does **not** admit D1a PASS by
itself. PRE-GATE desktop/AVD artifacts stay unadmitted. D1b stays
`NOT_STARTED`.

| Split                 | Status                 | Meaning                                                                                          |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `capture_host`        | **`READY`**            | AGI 3.3.3 pinned at `E:\agi`, Java ≥ 11, adb, writable traces, bound debug APK inspectable       |
| `physical_device`     | **`BLOCKED_EXTERNAL`** | No physical USB phone. Emulators are excluded. Plug in a phone; do not raise D1a from this host. |
| D1a program           | **not PASS**           | `ENVIRONMENT_BLOCKED` until an admitted physical GPU capture                                     |
| `android_gpu_capture` | **false**              | Completeness check does **not** flip this bit                                                    |

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §48  
**Decision:** [gate-p-decision-draft.md](gate-p-decision-draft.md)  
**Probe:** [m0-d1a-probe.md](m0-d1a-probe.md)

## Required chain

```text
clean source bundle (evidence_dirty=false)
→ APK built from that commit (apk_linkage=BOUND via --bind-apk)
→ physical Android production GPU (not AVD, not software renderer)
→ GPU capture (AGI): pass/resource order + two accumulator reads
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

## Capture host (pinned)

Pin: [`tools/agi.pin.json`](../../tools/agi.pin.json) — Android GPU Inspector
**3.3.3** (Build.Number 900, Build.SHA
`5f97b4fd99a9459320b782203ce2de5351a1e661`) at **`E:\agi`**. Frame-capture
preset: [`tools/agi-frame-capture.preset.json`](../../tools/agi-frame-capture.preset.json)
(`-api vulkan`, `-capture-frames 0 -for 15s`, URI
`android.intent.action.MAIN:com.neotavern.mobile/com.neotavern.mobile.M0D1aActivity`).
AGI `gapit packages` lists only activities with an action filter; the debug
probe therefore declares MAIN+DEFAULT **without** LAUNCHER. The probe paints
offscreen (no swapchain present), so `-capture-frames 1` stops on the first
HWUI TextView present — use duration capture instead. Keep gapit stdin open
or it treats EOF as “stop now”. Release NDK `.so` must enable wgpu
`InstanceFlags::DEBUG` so AGI records `m0-d1a-*` labels.

Host checks (Java ≥ 11 from `E:\agi\jre` or Studio JBR, adb, writable
`apps/android/m0-d1a-captures/`, bound debug APK):

```sh
node scripts/m0-d1a-capture-preflight.mjs --host-only
```

`--host-only` must print `capture_host=READY` and
`physical_device=BLOCKED_EXTERNAL` while no phone is attached. It excludes
emulators. It does not install anything. It writes a gitignored evidence
manifest under `apps/android/m0-d1a-captures/`
(`{stamp}-d1a-evidence.json` and `capture-host-ready.json`).

### Provenance split

`capture_tooling_commit` stays
`5df24c8fa97ca2edce3d5627445c2b3e419d683c` (AGI pin, preflight, completeness
check). APK provenance is the latest BOUND source bundle
(`apk_linkage=BOUND`, `evidence_dirty=false`). The debug Vulkan
`uses-feature` commit is `apk_source_commit` after a clean rebuild and
`--bind-apk`. Do not bind the APK to the tooling-only commit.

| Field                    | Value                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| `capture_tooling_commit` | `5df24c8fa97ca2edce3d5627445c2b3e419d683c`                           |
| `apk_source_commit`      | `58898226a896af14eaea94feec25d935727008fa`                           |
| `apk_sha256`             | `05d063dd5ac9ff916538e1eaf8d933a66a666cd6ea533c366d4c6a15a6ded834`   |
| Bound source bundle      | `2026-08-17T15-49-48-279Z-source-bundle.json` (`BOUND`, clean)       |

When a physical phone is on USB:

```sh
node scripts/m0-d1a-capture-preflight.mjs
```

That command refuses `emulator-*` / qemu / goldfish / ranchu / `sdk_gphone`,
requires Android 11+ (SDK ≥ 30), an ABI present in the APK, and a hardware
GPU (SwiftShader/qemu rejected). It installs **only** the SHA-256-matching
BOUND APK (`adb install -r -d`), verifies the on-device SHA-256, starts
`com.neotavern.mobile/.M0D1aActivity`, writes logcat + device metadata, then
`am force-stop` so AGI can relaunch, and prints the exact `gapit trace`
command.

### Bound APK inspect (this lab)

Debug APK `apps/android/app/build/outputs/apk/debug/app-debug.apk`:
`application-debuggable`, package `com.neotavern.mobile`, exported
`M0D1aActivity`, native ABIs `arm64-v8a` `x86_64`. Optional
`android.hardware.vulkan.level` / `version` (`required=false`) is declared
**only** in `apps/android/app/src/debug/AndroidManifest.xml`. Merged debug
manifest includes those features and `M0D1aActivity`; merged release
manifest includes neither. Capture uses AGI `-api vulkan`. wgpu prefers
Vulkan on physical Android (GLES fallback).

### AGI GUI

1. File → Capture Trace.
2. API = **Vulkan**. Do **not** stop after 1 frame (that is the TextView
   present). Capture for ~15 seconds / until the probe log line appears.
3. Package/activity = `com.neotavern.mobile` /
   `com.neotavern.mobile.M0D1aActivity`.
4. Commands pane: group by **user markers** (and by frame).
5. Search debug groups **`m0-d1a-roi-read:1`** then **`m0-d1a-roi-read:2`**.
   Also confirm resources `m0-d1a-accumulator` and `m0-d1a-glass-roi`.

### AGI CLI (printed by preflight)

```text
E:\agi\gapit.exe trace -api vulkan -capture-frames 0 -for 15s -serial <PHYSICAL_SERIAL> -out apps/android/m0-d1a-captures/<stamp>-d1a.gfxtrace -uri android.intent.action.MAIN:com.neotavern.mobile/com.neotavern.mobile.M0D1aActivity -additionalargs "-e com.neotavern.mobile.M0_D1A_FRAMES 100"
```

Then dump commands and run the completeness checker (does **not** admit
D1a PASS and does **not** set `android_gpu_capture`):

```sh
E:\agi\gapit.exe commands -groupbyusermarkers -groupbyframe apps/android/m0-d1a-captures/<stamp>-d1a.gfxtrace > apps/android/m0-d1a-captures/<stamp>-d1a-commands.txt
node scripts/m0-d1a-capture-check.mjs --commands apps/android/m0-d1a-captures/<stamp>-d1a-commands.txt
```

Trace names: `{stamp}-d1a.gfxtrace`, `{stamp}-d1a-commands.txt`,
`{stamp}-d1a-logcat.txt`, `{stamp}-d1a-device.json`,
`{stamp}-d1a-evidence.json` (`schema: m0-d1a-capture-evidence/v1`). Directory
is gitignored.

## Source bundle (pinned source)

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
and `sdk_gphone*` are partial evidence only. Preflight will not install to
them.

## What this lab currently lacks

Recorded 2026-08-17 after `GateP:P1`, capture host prepared the same day:

| Need               | This host                                                                       |
| ------------------ | ------------------------------------------------------------------------------- |
| Physical Android   | **missing** (`adb` = `emulator-5554` only) — `physical_device=BLOCKED_EXTERNAL` |
| AGI                | **pinned** 3.3.3 at `E:\agi` — `capture_host=READY`                             |
| Full SDK / NDK     | present at `E:\android_sdk` (NDK 27–29)                                         |
| Gradle 8.9 on PATH | unpacked under `%TEMP%\gradle-8.9\` (repo has no `gradlew`)                     |
| Paid device farm   | not used                                                                        |

The single remaining step that unblocks a D1a capture attempt: attach a
physical Android that meets the Gate P qualified-device definition, then
run `node scripts/m0-d1a-capture-preflight.mjs` and the printed `gapit
trace` command.

A capture file on disk still does not set `android_gpu_capture=true`. Flip
that bit only in the **evidence-admission record** after a reviewer
confirms the two accumulator reads.

D1b stays `NOT_STARTED` until D1a PASS.
