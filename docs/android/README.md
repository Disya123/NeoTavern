# Android Local Host

## Architecture

The Android host runs the **same Runtime Kernel** as the desktop and remote
transports, embedded in the app process:

`WebView (bundled web app) → JS bridge (window.__neotavernMobile) → JNI
(neotavern-android-jni) → mobile-ffi C ABI (nt_*) → Runtime Kernel → SQLite`

- `apps/android/` — the Android Studio project (Gradle 8.9, AGP 8.5.2,
  Kotlin 1.9.24, compileSdk/targetSdk 35, minSdk 26, JDK 17). The WebView
  loads **bundled web assets** packaged with the APK — never a network
  origin, and never arbitrary third-party JS: only the bundled web app
  runs inside the WebView.
- `neotavern-android-jni` — the JNI crate (cdylib + rlib, cargo workspace
  member): thin marshalling over the stable mobile-ffi C ABI
  (`nt_ffi_version`, `nt_kernel_open/free`, `nt_call`,
  `nt_stream_start/wait/cancel/free`). Request/response **envelopes are
  extracted in Rust**; there are no hand-written Kotlin DTOs for wire
  payloads. The kernel is reached through opaque `jlong` handles; Rust
  panics never cross JNI — they are contained and surface as a controlled
  `KernelException`.
- `crates/adapters/mobile-ffi` — the ABI layer itself (see
  [its README](../../crates/adapters/mobile-ffi/README.md)); payloads are
  the identical Product Wire Contract bytes used by every other transport
  (§6.3).
- `apps/web/src/api/mobileBridgeTransport.ts` — the TS `LocalTransport`
  over the WebView bridge (`MobileBridgeTransport`), building
  byte-identical request envelopes to `TauriTransport`. Profile routing
  selects `LocalBackend` over `MobileBridgeTransport` for the local
  profile; the `createBackend()` default (Tauri vs Legacy) is unchanged
  (see [backend routing](../architecture/README.md)).

### Frozen JS bridge protocol

The native side installs `window.__neotavernMobile` before the web app
loads; the TS transport installs `window.__neotavernMobileCallbacks = {
resolve, reject }` **before** any `call()`:

- `handshake(): string` — synchronous JSON `{ ffiAbiVersion, schemaHash,
  wireProtocol: { major, minor }, appVersion }`.
- `call(requestId: string, envelopeJson: string, callbackId: string): void`
  — fire-and-forget; async results arrive through the callback channel.
- `cancelStream(streamId: string): void`.

Native delivers async results by evaluating
`window.__neotavernMobileCallbacks.resolve('<callbackId>',
JSON.parse('<escaped envelope string literal>'))` (responses) or
`reject('<callbackId>', JSON.parse('<escaped error JSON>'))` (errors).
Stream callback payloads are `{kind:"event", event:<eventEnvelope>}`,
`{kind:"terminal"}`, or `{kind:"error", error:<errorEnvelope>}`.

Request envelopes are byte-identical to `TauriTransport`'s
(`WIRE_PROTOCOL`, `WIRE_SCHEMA_HASH`, v4 requestId, operationId, payload).
A response envelope with the same requestId maps to a `LocalCallResult`
(`ok` envelope → `{ok:true,value}`, product-error envelope →
`{ok:false,error:ProductErrorDto}`); an IPC/transport failure or a missing
callback throws a typed `TransportError` (the same product-vs-transport
split as `tauriTransport.ts`). The exact `ffiAbiVersion` + `schemaHash`
handshake runs at kernel open — a mismatched native library or stale web
bundle fails before any product write (§6.5).

## Data root and secrets

- Data root: `filesDir/neotavern` — passed to `nt_kernel_open`; the kernel
  holds the exclusive data-root lease, so a second writable owner gets a
  controlled `DataRootInUse` error (§22).
- Secrets: Android Keystore AES/GCM keys. There is **no plaintext
  fallback**; a missing or unusable keystore surfaces as a typed
  `SecretStoreUnavailableError` instead of degrading to storage in the
  clear.

## Lifecycle

- The kernel handle is opened on a background executor (never the UI
  thread) at host startup and closed on `onDestroy`; `nt_*` handles are
  `Send + Sync`, so any thread may call (the kernel's writer coordinator
  serializes actual writes).
- Process-death durability comes from the kernel: committed work is durable
  in SQLite and the `generation.events` log, so a killed process recovers
  lease-expired runs at the next open (see
  [generation durability](../architecture/generation-durability.md)).

## Phase gate status (ТЗ §78)

- **PR CI (`checks`):** JVM unit tests — host bridge, secret store,
  lifecycle, envelope mapping.
- **Nightly emulator:** instrumentation tests in
  `.github/workflows/nightly.yml` run on the emulator against the real
  kernel.
- **CI `android-build` job:** compiles the APK with Gradle 8.9 / AGP 8.5.2
  / Kotlin 1.9.24 on JDK 17. Android compilation is verified in CI only —
  no local Android toolchain is required to develop other platforms.
- The `.so` is **not committed**: `apps/android/scripts/build-libs.sh`
  (cargo ndk) produces
  `apps/android/app/src/main/jniLibs/{arm64-v8a,x86_64}/libneotavern_android_jni.so`
  from the `neotavern-android-jni` crate before the APK build, and the
  bundled web assets are packaged into the APK from the built web app.

## Explicit constraints

- **No Node** on the device, **no listening port**, **no HTTP server**: the
  WebView talks to the kernel over the in-process bridge only. Remote
  profiles are deferred to Phase 9 ([ADR-0034](../adr/0034-android-local-host-jni-transport.md)).
- **No arbitrary third-party JS** in the WebView: only the bundled web app
  is loaded, and the bridge surface is exactly the frozen protocol above.

See also: [ADR-0034](../adr/0034-android-local-host-jni-transport.md),
[mobile-ffi README](../../crates/adapters/mobile-ffi/README.md),
[Desktop local kernel mode](../desktop/README.md),
[Version axes](../architecture/version-axes.md).
