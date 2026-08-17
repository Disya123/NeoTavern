# M0-D1a paint-seam probe

**Status:** runner artifact remains **PRE-GATE / BLOCKED** (RFC 4.5 §0.3.2 /
§48). Gate P is **`GateP:P1` / PASSED**. Normative Milestone 0 is
**`ENTERED`**, not PASS. This file is **not** a Track D compositor GO and
**not** D1a PASS. Existing desktop/AVD runs are **not admitted**.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §48  
**Crate:** [`crates/presentation-m0`](../../crates/presentation-m0/README.md)

Architectural wording in the RFC is not evidence. This file records what the
working prototype actually ran. After `GateP:P1`, D1a must be **repeated**
from pinned source on physical Android with GPU capture. D1b stays forbidden
until that D1a PASS.

## Pins

| Component        | Pin          | Notes                                                                         |
| ---------------- | ------------ | ----------------------------------------------------------------------------- |
| Vello            | 0.9.0        | `Renderer::new(&device)`, `render_to_texture` to `Rgba8Unorm` STORAGE texture |
| wgpu             | 29.0.4       | via Vello `^29.0.3`; features `vulkan`/`gles`/`metal`                         |
| Blitz            | _not in D1a_ | producer seam is M0-D2                                                        |
| rustc (this run) | 1.97.1       | Vello 0.9 MSRV 1.88                                                           |

DX12 is **not** compiled in this workspace: wgpu-hal 29 needs `windows 0.62`
while Tauri/WebView2 stay on `windows 0.61`. That is a lockfile split, not a
paint-order failure. The Android production path is Vulkan/GLES, which is what
the probe builds.

## Scene (host-authored, static)

```text
wallpaper Image
→ BackdropBarrier glass A
→ vector UI PaintChunk
→ BeginEffectScope (opacity 0.85)
→ vector UI PaintChunk (clipped)
→ BackdropBarrier glass B (overlaps A)
→ EndEffectScope
→ overlay PaintChunk (translated spatial node)
```

Compiled pass kinds (golden):

```text
raster → glass → raster → raster → glass → raster
```

Chunks are never merged across a `BackdropBarrier`. Glass B keeps the ancestor
opacity scope. Overlay keeps a distinct spatial node (translate). Glass B uses
a nested clip rect; the glass pass scissors to `ROI ∩ clip`.

Text is a **shaped vector stand-in**. Real glyphs from Dioxus/Blitz are M0-D2.

## GPU path

1. One wgpu `Instance` / `Device` / `Queue` owned by the probe (not
   `vello::util::RenderContext`, which hides Android emulator Vulkan with
   `conformance_version == 0` and would pick GLES 3.0 over Vulkan CPU).
   Instance flag `ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER` is set. Vello
   `Renderer` is created with that device. `devices_created = 1` for the
   100-frame run.
2. Each raster pass: Vello renders into a STORAGE+TEXTURE target (Vello clears
   that target; this is upstream behaviour, not a fork). The result is blended
   onto a compositor **accumulator**.
3. Each glass pass: **same-device** `copy_texture_to_texture` of the ROI only
   (≤ 256×256 snapshot; D1a ROIs are 140×80) into a sampleable texture, then a
   WGSL 5-tap blur+tint writes the ROI on the accumulator. No
   `Renderer::register_texture` atlas copy. No `map_async`. No second device.

Vello does not keep an uncleared destination for later sampling. The probe
treats that as compositor-owned accumulation, not as a required Vello fork.

## Headless run (2026-08-17)

```text
cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu --bin m0-d1a-probe
```

| Field                    | Value                                           |
| ------------------------ | ----------------------------------------------- |
| Host                     | Windows 10, NVIDIA GeForce RTX 3060, **Vulkan** |
| `gpu_ran`                | true                                            |
| `software_adapter`       | false                                           |
| `devices_created`        | 1                                               |
| `cpu_readbacks`          | 0                                               |
| `cross_device_copies`    | 0                                               |
| `same_device_roi_copies` | 200 (2 glasses × 100 frames)                    |
| `raster_passes`          | 400 (4 raster × 100)                            |
| `glass_passes`           | 200 (2 glasses × 100)                           |
| `frames`                 | 100                                             |
| `android_gpu_capture`    | false                                           |
| crate verdict            | **BLOCKED**                                     |

CPU tests (no GPU): display-list cut, unbalanced scope error, verdict
classifier, adapter ranking. GPU tests skip if no adapter; a skip is not a
PASS.

## Verdict

Two different questions. Do not collapse them.

| Question                                             | Result                           | Meaning                                                                                                                        |
| ---------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Gate P (`GateP:P0\|P1\|P2`)                          | **`GateP:P1` / PASSED**          | Signed 2026-08-17. Does not admit this runner as D1a PASS.                                                                     |
| Normative M0                                         | **`ENTERED`**                    | Entry allowed; not PASS.                                                                                                       |
| Runner-labelled M0-D1a                               | **PRE-GATE / BLOCKED**           | AVD GLES 3.1 100-frame run exists. No GPU capture, no physical-device production backend. **Not admitted.**                    |
| Upstream Vello/wgpu API enough for this static seam? | **provisional** (non-admissible) | Shared device, sampleable RT, ROI glass, no readback on desktop Vulkan and emulator GLES. Not a D1a PASS.                      |
| Limited supported fork needed?                       | **not indicated**                | Compositor accumulator is host code, not a Vello patch. Emulator gfxstream Vulkan is skipped, not patched.                     |
| Replace paint substrate?                             | **not indicated** on these hosts | No readback / cross-device / dual-device failure on desktop Vulkan or emulator GLES.                                           |
| RFC §48 D1a **exit**                                 | **not met**                      | Repeat from pinned source: physical Android + GPU capture (pass/resource order, two accumulator reads). Runner BLOCKED ≠ FAIL. |

Do **not** record this as milestone `PASS`, `PATCH`, or `REPLACE`. Headless
and AVD success is partial evidence; RFC 4.5 says it MAY later be admitted
to M0 only by a written evidence-admission record. The `GateP:P1` signature
does **not** admit these runs.

M0-D1b and M0-D2 are **not started**. RFC 4.5 forbids D1b until admitted
D1a PASS.

## Android NDK compile (2026-08-17)

```text
cargo ndk -t x86_64 -t arm64-v8a build --release -p neotavern-presentation-m0 --features gpu,android-jni
```

| ABI       | artifact                                                    |
| --------- | ----------------------------------------------------------- |
| x86_64    | `libneotavern_presentation_m0.so` (~7.5 MiB, debug jniLibs) |
| arm64-v8a | `libneotavern_presentation_m0.so` (~6.8 MiB, debug jniLibs) |

Debug-only Activity `com.neotavern.mobile.M0D1aActivity` loads that library.
It is **not** the launcher (MAIN+DEFAULT, no LAUNCHER — required so AGI
`gapit packages` can see it) and is **not** in `libneotavern_android_jni.so`.
Production WebView path is unchanged. `.so` files are gitignored.

Launch:

```sh
bash apps/android/scripts/build-m0-d1a-libs.sh
adb shell am start -n com.neotavern.mobile/.M0D1aActivity
```

A successful logcat `m0-d1a` line with `ran_on_android=true` still leaves
`android_gpu_capture=false`, so the crate verdict stays **BLOCKED** until a
GPU capture exists.

## Android emulator 100-frame run (2026-08-17)

AVD `Medium_Phone_API_36.1`, restarted with `-gpu host` (NVIDIA GeForce RTX
3060). GLES 3.1 via Android Emulator OpenGL ES Translator. Debug-only
`M0D1aActivity`, extra `M0_D1A_FRAMES=100`.

```text
m0-d1a gpu_ran=true adapter=Android_Emulator_OpenGL_ES_Translator_(NVIDIA_GeForce_RTX_3060/PCIe/SSE2) backend=Gl software=false devices=1 readbacks=0 xdev=0 roi_copies=200 raster=400 glass=200 frames=100 ran_on_android=true capture=false verdict=BLOCKED reason=Android_GPU_ran;_GPU_capture_with_pass/resource_order_is_still_required_for_D1a_PASS
```

| Field                    | Value                         |
| ------------------------ | ----------------------------- |
| `gpu_ran`                | true                          |
| `adapter_backend`        | Gl (GLES 3.1 host translator) |
| `software_adapter`       | false                         |
| `devices_created`        | 1                             |
| `cpu_readbacks`          | 0                             |
| `cross_device_copies`    | 0                             |
| `same_device_roi_copies` | 200                           |
| `raster_passes`          | 400                           |
| `glass_passes`           | 200                           |
| `frames`                 | 100                           |
| `ran_on_android`         | true                          |
| `android_gpu_capture`    | false                         |
| crate verdict            | **BLOCKED**                   |

This is **not** a production-phone Vulkan run and **not** a D1a PASS.

### Failed paths recorded on the same AVD

| Attempt                                                     | Result                                                                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default `RenderContext::device(None)`                       | `no compatible wgpu adapter` — emulator Vulkan `conformance_version.major == 0` is hidden unless `ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER`                    |
| Goldfish/GFXStream Vulkan (SwiftShader **and** host NVIDIA) | SIGSEGV in `vulkan.ranchu.so` `ResourceTracker::on_vkQueueSubmit` on the first Vello `render_to_texture` submit. Probe now **skips** those Vulkan adapters. |
| `-gpu swiftshader_indirect` GLES 3.0                        | No compute; Vello cannot run. Use `-gpu host` (GLES 3.1) for this AVD.                                                                                      |

## Still required before this artifact can be admitted to M0-D1a

RFC 4.5: after `GateP:P1/P2`, an evidence-admission record plus:

- GPU capture with pass/resource order (two glass passes sampling the
  accumulator at the barrier paint position)
- Physical-device run on the production Android graphics backend (phone
  Vulkan/GLES, not emulator translator)
- Immutable source bundle (base commit, patch/diff hash, lockfile, APK SHA-256)
- Same counters: 0 CPU readback, 0 cross-device copy, 1 device/queue
- Blitz is still M0-D2; D1a pins Vello 0.9.0 + wgpu 29.0.4

Until a **new** physical D1a PASS, **stop D1b**. Repeat D1a from pinned source:

```text
clean source bundle (evidence_dirty=false; unrelated paths listed or absent)
→ new APK built from that bundle (apk_linkage=BOUND via --bind-apk)
→ physical Android production GPU
→ GPU capture (two accumulator reads at barriers)
→ D1a verdict
```

See [physical capture runbook](m0-d1a-physical-runbook.md) for the
post-`GateP:P1` rebuild chain. Debug groups `m0-d1a-roi-read:1` /
`m0-d1a-roi-read:2` name the two accumulator reads; they do **not** replace
AGI/RenderDoc.

## Desktop Vulkan API timeline (2026-08-17 evening)

```text
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu
cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu --bin m0-d1a-probe
```

| Field                      | Value                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Host                       | Windows, NVIDIA GeForce RTX 3060, **Vulkan**                                        |
| rustc                      | 1.97.1                                                                              |
| `gpu_ran`                  | true                                                                                |
| `devices_created`          | 1                                                                                   |
| `cpu_readbacks`            | 0                                                                                   |
| `cross_device_copies`      | 0                                                                                   |
| `same_device_roi_copies`   | 200                                                                                 |
| `raster_passes`            | 400                                                                                 |
| `glass_passes`             | 200                                                                                 |
| `frames`                   | 100                                                                                 |
| `api_timeline`             | `clear,raster,blit,roi:1,glass:1,raster,blit,raster,blit,roi:2,glass:2,raster,blit` |
| `api_timeline_events`      | 13                                                                                  |
| `compositor_texture_bytes` | 774144                                                                              |
| `android_gpu_capture`      | false                                                                               |
| `ran_on_android`           | false                                                                               |
| crate verdict              | **BLOCKED**                                                                         |

The timeline names two ROI copies from `m0-d1a-accumulator` into
`m0-d1a-glass-roi` and two glass passes that sample the snapshot. It is
**not** AGI/RenderDoc evidence of hidden driver copies.

Raw log (gitignored): `apps/android/m0-d1a-captures/2026-08-17-desktop-vulkan-probe.log`.

Source-bundle helper:

```sh
node scripts/m0-d1a-source-bundle.mjs
node scripts/m0-d1a-source-bundle.mjs --apk path/to/app-debug.apk --bind-apk
```

Produces gitignored JSON + `git diff --binary HEAD` under
`apps/android/m0-d1a-captures/` (`m0-d1a-source-bundle/v3`). Default
`apk_linkage=UNBOUND`. `BOUND` requires explicit `--bind-apk` for an APK
built from this tree; `--apk` alone is observational. The JSON records
`helper_sha256` / `helper_git_blob` / `helper_matches_head` so the helper
revision is part of the bundle. `excluded_unrelated_paths` (root TZ copy)
does not hide task-relevant dirty files. A dirty-tree hash plus an old APK
is **not** an admitted M0 bundle.

### Evening AVD D1a — `BLOCKED / NON-ADMISSIBLE`

**BLOCKED / NON-ADMISSIBLE** on 2026-08-17 evening: `adb devices -l` listed
only `emulator-5554` (`sdk_gphone64_x86_64`). No phone.

The already-installed debug APK (44 432 284 bytes, SHA-256 `A661693E…BAEB`)
contained an **older** `libneotavern_presentation_m0.so` that does **not**
match the current source bundle (no `timeline=` fields). Starting
`M0D1aActivity` reproduced a GLES 3.1 100-frame run, but that binary cannot
be cited as evidence of this tree:

```text
m0-d1a gpu_ran=true adapter=Android_Emulator_OpenGL_ES_Translator_(NVIDIA_GeForce_RTX_3060/PCIe/SSE2) backend=Gl software=false devices=1 readbacks=0 xdev=0 roi_copies=200 raster=400 glass=200 frames=100 ran_on_android=true capture=false verdict=BLOCKED reason=Android_GPU_ran;_GPU_capture_with_pass/resource_order_is_still_required_for_D1a_PASS
```

Raw log (gitignored):
`apps/android/m0-d1a-captures/2026-08-17-evening-avd-d1a.log`.

Do not pair that APK hash with a later source-bundle JSON as if they were
one revision. Physical production-backend D1a remains **BLOCKED** (no phone).

### Post-`GateP:P1` rebuild (2026-08-17 night) — not D1a PASS

Pinned commit `0167be5` (capture debug groups) + helper program fields
updated to `GateP:P1` / M0 `ENTERED`. Clean evidence tree
(`evidence_dirty=false`, root TZ excluded). Debug APK **BOUND**:

| Field                    | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| APK bytes                | 52 747 061                                                         |
| APK SHA-256              | `05d063dd5ac9ff916538e1eaf8d933a66a666cd6ea533c366d4c6a15a6ded834` |
| `apk_linkage`            | `BOUND` (`--bind-apk`, `evidence_dirty=false`)                     |
| `apk_source_commit`      | `58898226a896af14eaea94feec25d935727008fa`                         |
| `capture_tooling_commit` | `5df24c8fa97ca2edce3d5627445c2b3e419d683c`                         |
| helper                   | `helper_matches_head=true`                                         |
| `adb devices`            | `emulator-5554` only                                               |
| AGI                      | **3.3.3 pinned at `E:\agi`** (`capture_host=READY`)                |
| Physical USB             | **`BLOCKED_EXTERNAL`**                                             |
| D1a verdict              | **`ENVIRONMENT_BLOCKED`** (physical Android + GPU capture missing) |

This APK is the pinned binary for the next physical capture. It is **not**
admitted. AVD must not replace the phone. D1b stays `NOT_STARTED`.

Host-only preflight (no phone):

```sh
node scripts/m0-d1a-capture-preflight.mjs --host-only
```

Search AGI commands (after a real trace) for debug groups
`m0-d1a-roi-read:1` and `m0-d1a-roi-read:2`. Completeness check:

```sh
node scripts/m0-d1a-capture-check.mjs --commands <stamp>-d1a-commands.txt
```

That check does not flip `android_gpu_capture` and is not D1a PASS.
Runbook: [m0-d1a-physical-runbook.md](m0-d1a-physical-runbook.md).

### Capture tool switch (2026-08-17 night) — still not D1a PASS

Do **not** hunt a newer AGI. **3.3.3** is the last published release. The
physical `.gfxtrace`
`apps/android/m0-d1a-captures/2026-08-17T16-17-08-012Z-d1a.gfxtrace` is
**`CAPTURED_BUT_NOT_REPLAYABLE`**: `gapit commands` fails on unknown
`VkStructureType(1000128004)` =
`VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT`. Do not strip
`VkInstanceCreateInfo::pNext` for that parser.

Capture tool is **RenderDoc v1.45** at `E:\renderdoc`
([`tools/renderdoc.pin.json`](../../tools/renderdoc.pin.json)). Close
Android Studio. Use
`node scripts/m0-d1a-renderdoc-capture.mjs --mode=control` (feature off)
then `--mode=capture` after a `renderdoc-capture` rebuild and `--bind-apk`.
The in-app boundary is bound to wgpu-hal's raw `VkDevice` around the first
offscreen D1a frame only. Debug manifest `<queries>` lists the RenderDoc
layer packages. Production path and RenderGraph are unchanged. The
1437-byte GLES file `2026-08-17T16-53-54-457Z-d1a.rdc` is
`WRONG_API_CAPTURE / NON-ADMISSIBLE` (NULL device matched HWUI).

D1a stays **BLOCKED** (`android_gpu_capture=false`) until the owner admits
the capture. A Vulkan `.rdc` with both ROI groups exists
(`2026-08-17T17-18-59-431Z-d1a.rdc`); that does not auto-flip the flag.
D1b stays `NOT_STARTED`.

Emulator smoke of **this** APK (GLES translator, not a phone) produced the
golden API timeline and stayed `capture=false` / `BLOCKED`:

```text
m0-d1a gpu_ran=true adapter=Android_Emulator_OpenGL_ES_Translator_(NVIDIA_GeForce_RTX_3060/PCIe/SSE2) backend=Gl software=false devices=1 readbacks=0 xdev=0 roi_copies=200 raster=400 glass=200 frames=100 ran_on_android=true capture=false timeline=clear,raster,blit,roi:1,glass:1,raster,blit,raster,blit,roi:2,glass:2,raster,blit timeline_events=13 first_frame_cpu_us=1043704 acc_bytes=774144 verdict=BLOCKED reason=Android_GPU_ran;_GPU_capture_with_pass/resource_order_is_still_required_for_D1a_PASS
```

That confirms the BOUND `.so` matches the golden cut. It is still not GPU
capture and not D1a PASS.

Gitignored bundle:
`apps/android/m0-d1a-captures/2026-08-17T15-02-55-334Z-source-bundle.json`
(regenerate after the helper program-status commit). AVD log:
`apps/android/m0-d1a-captures/2026-08-17-post-p1-avd-d1a.log`.

## Non-goals (unchanged)

- Production APK / `MainActivity` compositor
- Theme SDK v2, Plugin IR, chat-route migration
- 10k chat, 120 Hz percentile gate, scroll, input
- NeoCompositor v1 crate layout (`neo-scene`, …)
