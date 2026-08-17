# neotavern-presentation-m0

Non-production **M0-D1a paint-seam probe** for NeoUI v4 RFC 4.5. Program
**M0-D1a is PASS** only on the host-side record
[`docs/rfc/m0-d1a-adjudication.json`](../../docs/rfc/m0-d1a-adjudication.json).
This crate still logs `android_gpu_capture=false` and a runner **BLOCKED**
verdict: the probe cannot self-admit. It is not a normative M0 PASS (M0 is
`ENTERED` after `GateP:P1`), not NeoCompositor v1, not a Dioxus/Blitz
producer, not a replacement for the Gate P record, and it is **not** linked
into the production WebView kernel `.so`. A **debug-only** Activity can load
a second library `libneotavern_presentation_m0.so`.

Evidence: [`docs/rfc/m0-d1a-probe.md`](../../docs/rfc/m0-d1a-probe.md),
[`docs/rfc/m0-d1b-probe.md`](../../docs/rfc/m0-d1b-probe.md),
[`docs/rfc/m0-d1b-adjudication.json`](../../docs/rfc/m0-d1b-adjudication.json).

## What it proves

- Display-list cut `PaintChunk` / `Image` vs `BackdropBarrier` (no merge across
  a glass barrier; nested `BeginEffectScope` / `EndEffectScope`).
- Host-authored D1a static scene and D1b scene (wallpaper → glass A →
  vector UI → optional moving sample → glass B → overlay).
- One `wgpu` `Device`/`Queue` shared by Vello raster and the glass pass.
- Sampleable intermediate (Vello `STORAGE_BINDING|TEXTURE_BINDING` plus a
  compositor accumulator). Glass reads a **same-device ROI copy**, never a CPU
  readback and never a cross-device copy.
- D1b moving sample is a persistent compositor texture blit (no layout
  rebuild, no decoder). Glass B samples the current frame generation.
- First-frame **API timeline** (named accumulator / snapshot / ROI copies).
  That log is not an AGI/RenderDoc GPU capture and does not flip
  `android_gpu_capture`.
- Debug-only Android RenderDoc in-app capture when feature
  `renderdoc-capture` is enabled and `VK_LAYER_RENDERDOC_Capture` is
  injected. D1a binds the first measured frame; D1b binds generation 120
  (`m0-d1b` path template) and records `capture_only_polls` separately
  from `render_thread_polls`. `android-jni` does not enable that feature.
  Production kernel JNI does not compile the module. The RenderDoc library
  is not packaged in the APK.

## Pins

- Vello **0.9.0** (`Renderer::new(&device)`, `render_to_texture`)
- wgpu **29** (resolved `29.0.4`; Vulkan/GLES/Metal features; DX12 left off so
  this crate can share the workspace lockfile with Tauri `windows 0.61`)
- Blitz is **not** in this crate. M0-D2 STARTED in
  [`presentation-m0-d2`](../presentation-m0-d2/README.md) (producer+dynamic
  seam, not PASS). The D2 crate calls `run_dynamic_list` here so D1b and D2
  share one compositor.

## Commands

CPU graph tests (default CI / `cargo test --workspace`):

```sh
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0
```

GPU probe (skip at runtime if no adapter; a skip is **not** D1a PASS):

```sh
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu
cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu --bin m0-d1a-probe
cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu --bin m0-d1b-probe
cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0-d2 --features gpu --bin m0-d2-probe
```

Android (debug APK only; production `MainActivity` / kernel JNI unchanged):

```sh
bash apps/android/scripts/build-m0-d1a-libs.sh
M0_D1A_FEATURES=gpu,android-jni,renderdoc-capture bash apps/android/scripts/build-m0-d1a-libs.sh
gradle -p apps/android :app:assembleDebug
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.neotavern.mobile/.M0D1aActivity
adb logcat -d -s NeoTavern:I | findstr m0-d1a
adb shell am start -n com.neotavern.mobile/.M0D1bActivity --es com.neotavern.mobile.M0_D1B_FRAMES 1000 --es com.neotavern.mobile.M0_D1B_CAPTURE_FRAME -1
adb logcat -d -s NeoTavern:I | findstr m0-d1b
```

Optional D1a extra: `-e com.neotavern.mobile.M0_D1A_FRAMES 100`.
D1b capture extra: `M0_D1B_CAPTURE_FRAME 120` (default). `-1` disables
RenderDoc. Lab: `node scripts/m0-d1b-renderdoc-capture.mjs`.

Source bundle (gitignored JSON + binary diff; not a PASS). Schema
`m0-d1a-source-bundle/v3`. Default `apk_linkage=UNBOUND`. `BOUND` requires
`--bind-apk`. The JSON records the helper file hash. Unrelated root TZ is
listed in `excluded_unrelated_paths` and does not hide task-relevant dirty
files. Do not pair an old APK hash with a dirty unrelated tree.

```sh
node scripts/m0-d1a-source-bundle.mjs
node scripts/m0-d1a-source-bundle.mjs --apk path/to/app-debug.apk --bind-apk
```

## Constraints

- RFC 4.5: Gate P is `GateP:P1`. Normative M0 is `ENTERED`, not PASS.
  Host-side D1a and D1b are **PASS**. This crate's logcat bit stays
  `capture=false`. Desktop/AVD PRE-GATE runs stay unadmitted. Do not
  treat either as `D1=Track D GO`.
- An emulator GLES 3.1 100-frame logcat line is partial evidence, not an
  admissible D1a PASS (needs Gate P, GPU capture, physical device, source
  bundle). Compiling the NDK `.so` is not a PASS.
- Do not treat crate `PASS`/`PATCH`/`REPLACE` as `GateP:P0|P1|P2`.
