# M0-D1a physical capture runbook

**Status:** lab procedure after `GateP:P1`. Program **M0-D1a PASS** is the
host-side record [`m0-d1a-adjudication.json`](m0-d1a-adjudication.json), not
the probe logcat bit. PRE-GATE desktop/AVD artifacts stay unadmitted. D1b
may start; it is `NOT_STARTED` in the D1a JSON. `D1=Track D GO` is not
granted.

| Split                 | Status             | Meaning                                                                                                       |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `capture_host`        | **`READY`**        | RenderDoc **v1.45** pinned at `E:\renderdoc`, AGI 3.3.3 archived at `E:\agi`, Java ≥ 11, adb, bound debug APK |
| `physical_device`     | Xiaomi `8f5c2b7c`  | Emulators remain excluded. Capture used Adreno 710 / Vulkan.                                                  |
| D1a program           | **PASS**           | Host adjudicator admitted the Vulkan Event Browser tree                                                       |
| `android_gpu_capture` | **true** (host)    | Probe log stays `capture=false`; only the admission record flips this bit                                     |

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §48  
**Decision:** [gate-p-decision-draft.md](gate-p-decision-draft.md)  
**Probe:** [m0-d1a-probe.md](m0-d1a-probe.md)

## Required chain

```text
clean source bundle (evidence_dirty=false)
→ APK built from that commit (apk_linkage=BOUND via --bind-apk)
→ physical Android production GPU (not AVD, not software renderer)
→ GPU capture (RenderDoc v1.45): pass/resource order + two accumulator reads
→ D1a verdict
```

Counters, the host API timeline, and wgpu debug groups **do not** replace
the capture. Do **not** hunt a newer AGI: **3.3.3 is the last published
release**. Do **not** strip `VkInstanceCreateInfo::pNext` unless RenderDoc
also cannot parse the `.rdc`. D1b may start only after D1a PASS (now
recorded). Do not reuse PRE-GATE APK hashes.

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

Primary pin: [`tools/renderdoc.pin.json`](../../tools/renderdoc.pin.json) —
**RenderDoc v1.45** (2026-07-02, built from
`2fc0bc04cb95499635f63986a55bc6f67849dd9f`) at **`E:\renderdoc`**. Zip
`RenderDoc_1.45_64.zip` SHA-256
`bd665c348a8245d10a1f513e35b83603edc1a78006277583d09ec0769286eea4`.
`qrenderdoc.exe` SHA-256
`c9904905fe380b2869d48c7a4209c2331370e0bfda502a24da26ec4031cf885b`.
`renderdoccmd.exe` SHA-256
`273352017e23e890fe9134de0157d1fe556676a4c6004bfe3265db1a4648ed07`.
Android layer APK
`plugins/android/org.renderdoc.renderdoccmd.arm64.apk` SHA-256
`cdf4c32582da36e37e1f226a47a488b1685ffb5c3cac006fa6187ede9f28b9f1`.
Preset: [`tools/renderdoc-frame-capture.preset.json`](../../tools/renderdoc-frame-capture.preset.json).
Official Android path: [Android capture guide](https://github.com/baldurk/renderdoc/blob/v1.x/docs/how/how_android_capture.rst)
(File → Attach to Remote Context). Close Android Studio or disable its ADB
integration so it does not steal the debuggable APK.

AGI 3.3.3 remains pinned at `E:\agi` as an **archive** only
([`tools/agi.pin.json`](../../tools/agi.pin.json)). The existing
`2026-08-17T16-17-08-012Z-d1a.gfxtrace` is
**`CAPTURED_BUT_NOT_REPLAYABLE`**: `gapit commands` fails to mutate
`vkCreateInstance` with unknown `VkStructureType(1000128004)` =
`VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT`. Labels are in
the bytes; the Commands pane is not. Do not strip messenger create-info
from `pNext` for that parser.

The probe paints offscreen (no swapchain present), so a present/frame
trigger captures the HWUI TextView. Do **not** use an external frame
trigger. Debug-only feature `renderdoc-capture` (not implied by
`android-jni`) wraps the first measured D1a frame:

```text
StartFrameCapture(wgpu VkDevice / instance dispatch table)
→ encode exact D1a frame
→ queue.submit
→ device.poll / fence completion
→ EndFrameCapture
```

`RENDERDOC_GetAPI` is loaded from the injected layer; `renderdoc_app.h` is
vendored and pinned (`tools/renderdoc.pin.json` `app_header`). Production
`libneotavern_android_jni.so` does not compile that module. Passing `NULL`
as the device pointer captured GLES (`2026-08-17T16-53-54-457Z-d1a.rdc`,
1437 bytes, `WRONG_API_CAPTURE / NON-ADMISSIBLE`).

The debug manifest lists RenderDoc packages under `<queries>` so the
Vulkan loader can see the layer APK on `targetSdk >= 30`.

Host checks (RenderDoc + archived AGI, Java ≥ 11, adb, writable
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
check). RenderDoc v1.45 is an additional pin at `tools/renderdoc.pin.json`;
do not retarget the tooling commit to a RenderDoc-only revision if that
would make `apk_source_commit` equal the tooling pin. APK provenance is the
latest BOUND source bundle (`apk_linkage=BOUND`, `evidence_dirty=false`).
Do not bind the APK to the tooling-only commit.

| Field                    | Value                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_tooling_commit` | `5df24c8fa97ca2edce3d5627445c2b3e419d683c`                                                                                               |
| `apk_source_commit`      | latest BOUND bundle (`apk_source_commit` ≠ tooling commit)                                                                               |
| Last AGI-era bind        | `7487f12…` / SHA-256 `47b632b830188f264bd07ff06947ceabd96aea6064ecb96fd788c3e739c31391` — **stale after RenderDoc in-app + `<queries>`** |

Rebind the debug APK after those probe-only changes. Do not capture an
unbound or dirty tree.

When a physical phone is on USB, rebuild twice. Control APK is
`gpu,android-jni` (feature off). Capture APK is
`gpu,android-jni,renderdoc-capture`, then `--bind-apk` from a clean tree
(`apk_source_commit` ≠ `5df24c8`).

```sh
node scripts/m0-d1a-renderdoc-capture.mjs --mode=control
node scripts/m0-d1a-renderdoc-capture.mjs --mode=capture
```

That command refuses `emulator-*` / qemu / goldfish / ranchu / `sdk_gphone`,
requires Android 11+ (SDK ≥ 30), an ABI present in the APK, and a hardware
GPU (SwiftShader/qemu rejected). Capture mode installs the SHA-256-matching
BOUND APK and the pinned RenderDoc arm64 layer APK, sets
`VK_LAYER_RENDERDOC_Capture` as a GPU debug layer, launches
`com.neotavern.mobile/.M0D1aActivity`, waits for the in-app capture
boundary, pulls `{stamp}-d1a.rdc`, converts to XML, and runs the
completeness checker. Control mode disables GPU debug layers and only
checks golden counters/timeline (`devices=1`, `readbacks=0`, `xdev=0`,
`roi_copies=200`, `glass=200`, golden timeline). Close Android Studio first.
A new `.rdc` is accepted only if the Event Browser contains Vulkan commands
and both `m0-d1a-roi-read:1/2` with readable resource usages.
`StartFrameCapture` success is not PASS. The GLES 1437-byte capture
`2026-08-17T16-53-54-457Z-d1a.rdc` stays `WRONG_API_CAPTURE / NON-ADMISSIBLE`.

### Bound APK inspect (this lab)

Debug APK `apps/android/app/build/outputs/apk/debug/app-debug.apk`:
`application-debuggable`, package `com.neotavern.mobile`, exported
`M0D1aActivity`, native ABIs `arm64-v8a` `x86_64`. Optional
`android.hardware.vulkan.level` / `version` (`required=false`) and
RenderDoc `<queries>` are declared **only** in
`apps/android/app/src/debug/AndroidManifest.xml`. Merged debug
manifest includes those features, queries, and `M0D1aActivity`; merged
release manifest includes none of them. wgpu prefers Vulkan on physical
Android (GLES fallback). Release NDK `.so` ORs wgpu `InstanceFlags::DEBUG`
so `VK_EXT_debug_utils` labels (`m0-d1a-*`) land in the capture.

### RenderDoc GUI (Android Remote Context)

1. Close Android Studio.
2. File → Attach to Remote Context → the Xiaomi device.
3. Launch **`M0D1aActivity`**, not `MainActivity`.
4. Event Browser must show, in order:
   `m0-d1a-roi-read:1` → first glass dispatch → intermediate raster/blit →
   `m0-d1a-roi-read:2` → second glass dispatch.
5. Resource viewer: identity and usage of `m0-d1a-accumulator` and
   `m0-d1a-glass-roi`. ROI copies are same-device. No CPU readback, no
   cross-device transfer.

If a present/frame trigger only captures the TextView, that is expected:
the workload is offscreen. Use the VkDevice-bound in-app boundary, not an
external frame trigger. Production RenderGraph is unchanged.

### RenderDoc CLI

```sh
node scripts/m0-d1a-renderdoc-capture.mjs --serial=<PHYSICAL_SERIAL> --mode=capture
```

Then (if convert did not already):

```sh
E:\renderdoc\renderdoccmd.exe convert -c xml -f apps/android/m0-d1a-captures/<stamp>-d1a.rdc -o apps/android/m0-d1a-captures/<stamp>-d1a.xml
node scripts/m0-d1a-capture-check.mjs --commands apps/android/m0-d1a-captures/<stamp>-d1a.xml
```

That check does **not** admit D1a PASS and does **not** set
`android_gpu_capture`. Admission is
`node scripts/m0-d1a-adjudicate.mjs` →
[`m0-d1a-adjudication.json`](m0-d1a-adjudication.json).

Trace names: `{stamp}-d1a.rdc`, `{stamp}-d1a.xml`,
`{stamp}-d1a-commands.txt`, `{stamp}-d1a-logcat.txt`,
`{stamp}-d1a-device.json`, `{stamp}-d1a-evidence.json`
(`schema: m0-d1a-capture-evidence/v1`). Archived AGI traces keep
`{stamp}-d1a.gfxtrace`. Directory is gitignored.

Admitted Vulkan capture (`android_gpu_capture=true` in the host record only):
`apps/android/m0-d1a-captures/2026-08-17T17-18-59-431Z-d1a.rdc`
(1 487 376 bytes, SHA-256 `d45c45db…b11259`, `<driver>Vulkan</driver>`,
both `m0-d1a-roi-read:1/2`, `vkCmdCopyImage` 299=`m0-d1a-accumulator` →
303=`m0-d1a-glass-roi` at 140×80). APK SHA-256 `478a4593…` bound to
`2d72a3c`. GLES 1437-byte `2026-08-17T16-53-54-457Z-d1a.rdc` stays
`WRONG_API_CAPTURE / NON-ADMISSIBLE`.

### AGI archive (do not retry as the capture tool)

```text
E:\agi\gapit.exe commands -groupbyusermarkers -groupbyframe apps/android/m0-d1a-captures/2026-08-17T16-17-08-012Z-d1a.gfxtrace
```

fails with `Missing switch case handler for value vulkan.VkStructureType
VkStructureType(1000128004)`. Status JSON (gitignored):
`apps/android/m0-d1a-captures/2026-08-17T16-17-08-012Z-d1a-agi-status.json`.

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

## Lab inventory (after admission)

Recorded 2026-08-17 after host-side adjudication of RenderDoc v1.45:

| Need               | This host                                                                         |
| ------------------ | --------------------------------------------------------------------------------- |
| Physical Android   | Xiaomi `8f5c2b7c` (`23122PCD1G`, Adreno 710); emulators excluded                  |
| RenderDoc          | **pinned** v1.45 at `E:\renderdoc`                                                |
| AGI                | **archived** 3.3.3 at `E:\agi` — `.gfxtrace` is `CAPTURED_BUT_NOT_REPLAYABLE`     |
| Full SDK / NDK     | present at `E:\android_sdk` (NDK 27–29)                                           |
| Gradle 8.9 on PATH | unpacked under `%TEMP%\gradle-8.9\` (repo has no `gradlew`)                       |
| Readable GPU tree  | **admitted** — Event Browser shows both ROI reads and accumulator/ROI identity    |
| Paid device farm   | not used                                                                          |

Program D1a is **PASS**. The probe still logs `android_gpu_capture=false`.
Flip that bit only in the evidence-admission record (already done).

D1b is **PASS** in [m0-d1b-adjudication.json](m0-d1b-adjudication.json).
It remains `NOT_STARTED` in this D1a admission JSON. `D1=Track D GO` is not granted.
