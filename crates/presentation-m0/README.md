# neotavern-presentation-m0

Non-production **PRE-GATE M0-D1a paint-seam probe** for NeoUI v4 RFC 4.5. It is
not a normative M0 PASS (M0 is `ENTERED` after `GateP:P1`), not NeoCompositor
v1, not a Dioxus/Blitz producer, not a replacement for the Gate P record, and
it is **not** linked into the production WebView kernel `.so`. A **debug-only**
Activity can load a second library `libneotavern_presentation_m0.so`.

Evidence: [`docs/rfc/m0-d1a-probe.md`](../../docs/rfc/m0-d1a-probe.md).

## What it proves

- Display-list cut `PaintChunk` / `Image` vs `BackdropBarrier` (no merge across
  a glass barrier; nested `BeginEffectScope` / `EndEffectScope`).
- Host-authored static D1a scene: wallpaper → glass A → vector UI → glass B
  (inside group opacity) → overlay, with clip + transform nodes.
- One `wgpu` `Device`/`Queue` shared by Vello raster and the glass pass.
- Sampleable intermediate (Vello `STORAGE_BINDING|TEXTURE_BINDING` plus a
  compositor accumulator). Glass reads a **same-device ROI copy**, never a CPU
  readback and never a cross-device copy.
- First-frame **API timeline** (named accumulator / snapshot / ROI copies).
  That log is not an AGI/RenderDoc GPU capture and does not flip
  `android_gpu_capture`.

## Pins

- Vello **0.9.0** (`Renderer::new(&device)`, `render_to_texture`)
- wgpu **29** (resolved `29.0.4`; Vulkan/GLES/Metal features; DX12 left off so
  this crate can share the workspace lockfile with Tauri `windows 0.61`)
- Blitz is **not** in this crate. That is M0-D2.

## Commands

CPU graph tests (default CI / `cargo test --workspace`):

```sh
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0
```

GPU probe (skip at runtime if no adapter; a skip is **not** D1a PASS):

```sh
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu
cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu --bin m0-d1a-probe
```

Android (debug APK only; production `MainActivity` / kernel JNI unchanged):

```sh
bash apps/android/scripts/build-m0-d1a-libs.sh
gradle -p apps/android :app:assembleDebug
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.neotavern.mobile/.M0D1aActivity
adb logcat -d -s NeoTavern:I | findstr m0-d1a
```

Optional extra: `-e com.neotavern.mobile.M0_D1A_FRAMES 100`.

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
  This crate's existing runs stay **PRE-GATE / BLOCKED** until a physical
  GPU-capture D1a PASS. Do not start M0-D1b from these artifacts.
- An emulator GLES 3.1 100-frame logcat line is partial evidence, not an
  admissible D1a PASS (needs Gate P, GPU capture, physical device, source
  bundle). Compiling the NDK `.so` is not a PASS.
- Do not treat crate `PASS`/`PATCH`/`REPLACE` as `GateP:P0|P1|P2`.
