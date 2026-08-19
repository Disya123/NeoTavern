# NeoTavern Android Host

Phase 5 local foundation: the Android app shell that renders the packaged web
UI in a hardened WebView and talks to the **same in-process Runtime Kernel**
over JNI — no Node, no localhost server, no HTTP (ТЗ Фаза 5; "Android
Standalone не обязан запускать Node или localhost server").

```
WebView (apps/web UI in assets/web/index.html)
   │  window.__neotavernMobile (addJavascriptInterface, installed pre-load)
   ▼
NeotavernBridge            @JavascriptInterface handshake/call/cancelStream
   │  background single-thread executor; UI-thread evaluateJavascript
   ▼
KernelSession              pure Kotlin state machine CLOSED→OPENING→OPEN→CLOSING
   │  streams registry freed on close; typed SessionError
   ▼
JniNativeKernel → KernelBridge   external natives (System.loadLibrary)
   │
   ▼
libneotavern_android_jni.so → neotavern-mobile-ffi (C ABI) → Runtime Kernel
   ▼
<filesDir>/neotavern (data root; single writable owner via kernel lease)
```

Data flows are the **Product Wire Contract bytes** used by every other
transport: the request/response envelopes are byte-identical to the
TauriTransport's (wireProtocol, schemaHash, requestId v4, operationId,
payload), so `LocalBackend` on mobile behaves exactly like desktop.

## Bridge protocol (`window.__neotavernMobile`)

Installed with `addJavascriptInterface` **before** `loadUrl`. The TS side
(`isMobileShell()` = `typeof window !== 'undefined' &&
window.__neotavernMobile !== undefined`) installs
`window.__neotavernMobileCallbacks` before invoking anything.

| Method | Contract |
| --- | --- |
| `handshake(): string` | Synchronous handshake JSON: `{ffiAbiVersion, schemaHash, wireProtocol:{major,minor}, appVersion}`. |
| `call(requestId, envelopeJson, callbackId): void` | Fire-and-forget. Unary ops resolve with the response envelope JSON (requestId echoed). Stream ops (`generation.start`, `generation.retry`) deliver stream payload objects through the same callback. |
| `cancelStream(streamId): void` | Cancels the durable run behind a wire stream id (learned from event envelopes, or the request id before the first event). |
| `extensionsAvailability(): string` | Extension-surface probe (ТЗ §51): `{"themes":true,"plugins":"declarative-only","nodeRuntime":false,"arbitraryJsInWebView":false}`. Pure constant, JVM-tested on the exact bytes. |

Async results are delivered by evaluating:

```
window.__neotavernMobileCallbacks && window.__neotavernMobileCallbacks
  .resolve('<callbackId>', JSON.parse('<escaped envelope string literal>'))
```

(`reject('<callbackId>', JSON.parse('<escaped error JSON>'))` for transport
failures). The envelope/error JSON is embedded via `JsEscaping` (pure Kotlin)
as a **properly escaped JS string literal — never raw interpolation** — so
attacker-controlled quotes/backslashes/control characters cannot execute JS
(ТЗ: arbitrary third-party JS in the main WebView is not supported).

Stream payload objects (delivered via `resolve` on the same callbackId):

| Kind | Meaning |
| --- | --- |
| `{"kind":"event","event":{streamId,sequence,type,payload}}` | One committed event; `streamId` enables `cancelStream`. Open success is signaled by the first event. |
| `{"kind":"terminal"}` | Run reached a terminal state; the pump stops. |
| `{"kind":"error","error":{code,params}}` | Stream-open product failure, synthesized by the bridge from the native status code (the frozen native surface has no product-DTO channel for stream start; unary product errors keep full DTO parity via error envelopes). |

`reject()` payloads are `{"code":"<bridge code>","message":"..."}` (codes:
`session-state`, `kernel-open-failed`, `kernel-call-failed`,
`stream-start-failed`, `unknown-stream`, `stream-limit`, `kernel-error`,
`internal`). Mid-stream wait failures reject() — the durable run stays
recoverable via `generation.get` / `generation.events`.

## Extension surface (declarative-only, ТЗ §10/§51)

The Android host has **no plugin execution surface by design**: no
sandbox/compartment host, no plugin registry, no Node runtime — the app is
JNI-only (no HTTP, no Node, ТЗ §6.9). `window.__neotavernMobile
.extensionsAvailability()` reports the frozen probe
(`{"themes":true,"plugins":"declarative-only","nodeRuntime":false,
"arbitraryJsInWebView":false}`):

- **Themes: yes, declaratively.** Trusted built-in themes plus declarative
  theme packages (validated CSS/tokens — see the
  [Theme SDK docs](../docs/docs/developers/theme-sdk/index.md)) are the only
  third-party contributions accepted on Android.
- **Plugins: declarative-only.** No third-party plugin code runs on the
  device — no JavaScript entry points, no legacy frontend runtime. (The
  desktop/web plugin runtimes are separate surfaces; see the
  [Plugin SDK docs](../docs/docs/developers/plugin-sdk/index.md).)
- **Node runtime: unavailable locally.** No Node.js, no localhost server, no
  HTTP (ТЗ §6.9).
- **Arbitrary JS in the WebView: never.** The main WebView loads only the
  packaged UI and the single `window.__neotavernMobile` bridge — no
  third-party `<script>` injection, no legacy runtime.

The probe constant is pure Kotlin (`ExtensionAvailability` in
`NeotavernBridge.kt`) and JVM-tested on the exact byte contract; the
instrumented test (`ExtensionSurfaceInstrumentedTest`) asserts it through the
bridge on device.

## Native JNI contract (frozen)

Class `com.neotavern.mobile.KernelBridge`, `@JvmStatic external` functions
(JNI symbols `Java_com_neotavern_mobile_KernelBridge_*`):

| Kotlin | JVM signature |
| --- | --- |
| `nativeHandshake()` | `()Ljava/lang/String;` |
| `nativeOpen(dataRoot)` | `(Ljava/lang/String;)J` — 0 = fail, throws `KernelException(code, message)` |
| `nativeClose(kernel)` | `(J)V` |
| `nativeCall(kernel, request)` | `(J[B)[B` — response envelope |
| `nativeStreamStart(kernel, request)` | `(J[B)J` |
| `nativeStreamWait(stream, timeoutMs)` | `(JI)[B` — `null` = poll timeout (never end-of-stream) |
| `nativeStreamCancel(kernel, stream)` | `(JJ)V` |
| `nativeStreamFree(stream)` | `(J)V` |

`KernelException.code` is the `NT_ERR_*` status (1 invalid arg, 2 contract,
3 not found, 4 storage, 5 cancelled, 6 internal, 7 buffer, 8 mismatch).
`nativeStreamWait` payloads are already the `{kind:...}` bridge payload
objects and are forwarded verbatim.

## Building the native library (.so)

The prebuilt `.so` is **NOT committed** (gitignored). Build it first:

```sh
cd apps/android
bash scripts/build-libs.sh        # requires cargo-ndk + Android NDK
```

Produces `app/src/main/jniLibs/{arm64-v8a,x86_64}/libneotavern_android_jni.so`
(both ABIs; x86_64 is what the CI emulator loads). The script is
cwd-independent and locates the Rust workspace (`crates/`) itself.

The guarded Dioxus canary also needs
`libneotavern_presentation_chat.so` in the same main `jniLibs` folders
(`bash scripts/build-m0-d1a-libs.sh` copies it there; probe libs stay in
`src/debug/jniLibs`). WebView remains in the APK. Default launcher is
still WebView until a debug `NEOTA_DIOXUS_SHELL=1` extra persists the
canary opt-in (later icon launches reuse it; `=0` clears). Release ignores
the extra.

## Building and running the app

### Android Studio

1. Open `apps/android` as a Gradle project (Gradle 8.9+, JDK 17).
2. Run `scripts/build-libs.sh` first (or build via CI).
3. Run the `app` configuration on an API 26+ device/emulator.

### Command line

```sh
cd apps/android
bash scripts/build-libs.sh
# assembleDebug is fail-closed without apps/web/dist/index.html (ТЗ §18.3)
pnpm --filter @neotavern/web build   # from the repo root
./gradlew :app:assembleDebug          # APK in app/build/outputs/apk/debug/
./gradlew :app:installDebug           # install on a connected device/emulator
```

> Note: the repo intentionally ships no `gradlew` wrapper; CI uses
> `gradle/actions/setup-gradle` with Gradle 8.9, AGP 8.5.2, Kotlin 1.9.24,
> JDK 17 temurin.

## Test matrix

| Scope | Command | Runs on |
| --- | --- | --- |
| JVM unit tests (state machine, JS escaping, callback frames, extension-availability probe, secret-store contract, M-1 display-refresh / glass / origin / frames) | `./gradlew :app:testDebugUnitTest` | Any JVM — no Android needed |
| Instrumented round trip (real kernel: meta.get, characters CRUD, durability after reopen) | `./gradlew :app:connectedDebugAndroidTest` | API 26+ device/emulator with the `.so` packaged |
| Instrumented extension-surface probe (frozen `extensionsAvailability()` JSON through the bridge; no kernel/JNI needed) | `./gradlew :app:connectedDebugAndroidTest` | API 26+ device/emulator |

The JVM-tested classes (`KernelSession`, `JsEscaping`, `CallbackFrame`,
`ExtensionAvailability`, `SecretStore`, `DisplayRefreshPolicy`,
`MeasurementGlass`, `MeasurementOrigin`, `MeasurementFrames`,
`FrameMissCounter`) contain **no android.\*** imports and run as plain JUnit 4.

## M-1 presentation measurement

This is the bounded measurement week from the
[NeoUI v4 RFC](../../docs/rfc/neoui-v4-android-presentation-backend.md)
(non-canonical). It is **not** a compositor. Production default remains live
glass on `file://`. The host requests the highest same-resolution display
mode and logs `m1-refresh` / `m1-origin` / `m1-glass` / `m1-env` /
`m1-memory` / `m1-thermal` / `m1-startup` under tag `NeoTavern`. On API 35+
the WebView also votes `setRequestedFrameRate` at the requested Hz.

Opt-in extras (never the launcher default):

```sh
# A0 — glass off
adb shell am start -n com.neotavern.mobile/.MainActivity -e com.neotavern.mobile.MEASUREMENT_GLASS off

# B — WebViewAssetLoader HTTPS origin (same APK assets)
adb shell am start -n com.neotavern.mobile/.MainActivity -e com.neotavern.mobile.MEASUREMENT_ORIGIN asset-loader

# rAF + UI Choreographer sampler (30 s)
adb shell am start -n com.neotavern.mobile/.MainActivity -e com.neotavern.mobile.MEASUREMENT_FRAMES on
```

Device capture helper (adb + installed APK, 50 s wait):

```sh
node scripts/m1-android-capture.mjs --track a --phase cold
```

Fill-in device table: [BaselineReport M-1](../../docs/rfc/m1-baseline-report.md).

The M0-D1a paint-seam probe is **not** in the production kernel `.so`. Debug
builds can load a second library via `M0D1aActivity` (not the launcher):

```sh
bash apps/android/scripts/build-m0-d1a-libs.sh
adb shell am start -n com.neotavern.mobile/.M0D1aActivity --es com.neotavern.mobile.M0_D1A_FRAMES 100
adb logcat -d -s NeoTavern:I
```

On the API 36.1 AVD the probe needs **GLES 3.1** (`emulator -gpu host`).
`-gpu swiftshader_indirect` is GLES 3.0 and cannot run Vello compute.
Goldfish/GFXStream Vulkan SIGSEGVs on Vello submit and is skipped.

Crate: [`crates/presentation-m0`](../../crates/presentation-m0/README.md).
Evidence: [M0-D1a probe](../../docs/rfc/m0-d1a-probe.md) (RFC 4.5 **PRE-GATE /
BLOCKED**; Gate P `GateP:P1`; normative M0 `ENTERED`, not PASS; do not
start D1b until D1a PASS).

## Phase gate status

- [x] Gradle + Kotlin host shell (hardened WebView; INTERNET is optional
      for HostConnect URL/QR remote, CAMERA optional for QR scan).
- [x] JNI binding (KernelBridge) + pure KernelSession state machine with
      typed errors and stream registry.
- [x] Keystore-backed SecretStore (AES/GCM, no plaintext fallback) and
      atomic-write ManagedDataRoot. On-device round-trip:
      `KeystoreSecretStoreInstrumentedTest`.
- [x] JVM unit tests + instrumentation kernel round trip (durability after
      simulated process death of KernelSession).
- [x] **Web assets packaged from `apps/web/dist`** — Gradle
      `packageWebAssets` stages `assets/web/index.html`; assemble fails
      closed without it (ТЗ §18.3). CI unzip-checks debug **and** release
      APKs (`assembleRelease` is debug-signed for the Packaged gate).
      `WebAssetsPackagedInstrumentedTest` asserts the entry on device.
- [x] Themed HostConnect gate (`data-component="host-connect"`, Theme SDK
      skin in `@neotavern/ui`) + LocalBackend over the mobile transport.
      `WebViewUserFlowInstrumentedTest` enters local mode, opens the
      character catalog (Hazel) and Settings (change-host), asserts the
      Home composer, and survives Activity recreate. The same class starts
      `generation.start` through `window.__neotavernMobile.call` (fake
      provider) and recovers interrupted → retry after a simulated process
      death on the production data root.
- [x] Device gate: catalog / settings / composer + generation process-death
      on the emulator matrix (WebView → JNI → Kernel). Nightly
      `connectedDebugAndroidTest` (API 26 + 34) runs the full instrumented
      suite; PR CI compiles the test APK and packages debug + release APKs.
- [x] Extension-surface probe (declarative-only policy, ТЗ §51) — JVM byte
      contract + instrumented bridge probe.
