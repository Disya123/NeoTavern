---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/android/README.md
---

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
  [its README](https://github.com/Disya123/NeoTavern/blob/main/crates/adapters/mobile-ffi/README.md)); payloads are
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

## Background execution (Phase 8)

ТЗ §8/§19: a generation the user can see keeps running when the app leaves
the foreground, and maintenance runs without user interaction. Both happen
**on the same kernel session** — never a second writable kernel, which the
exclusive data-root lease would reject with `DataRootInUse` (§22):

- **`KernelHolder`** (`KernelHolder.kt`) owns the single `KernelSession` and
  its executor and refcounts them between `MainActivity` and
  `GenerationService` / `MaintenanceWorker` (`acquire()`/`release()`; at
  zero the session is closed and the executor shut down).
  `KernelSession.open()` is idempotent, so both owners share one open
  kernel with one lease.
- **Foreground execution.** While a generation stream is active, the bridge
  hands the stream off (one additive entry point on the otherwise frozen
  Phase 5 bridge protocol) to `GenerationService` — a bounded
  `FOREGROUND_SERVICE_TYPE_DATA_SYNC` service started only for an active
  user-visible run. `ForegroundExecutionCoordinator` registers the claimed
  stream process-wide (first claim wins, idempotent); the service drains it
  on the holder executor and drives the foreground notification (channel
  `neotavern_generation`, id 1001).
- **Notification and stop.** The notification shows run state only —
  `Generating` / `Complete` / `Failed` via `NotificationState` — plus a Stop
  action (`ACTION_STOP`). It **never contains chat or message content**
  (§85). The Stop action and OS service expiration both map to
  `session.cancelStream(...)` (`nt_stream_cancel` → `generation.cancel`)
  and unclaim the stream; the service stops at terminal state.
- **Maintenance.** `MaintenanceScheduler` enqueues WorkManager **unique
  one-time work** (`neotavern-maintenance` → `backups.create`) with
  `BATTERY_NOT_LOW` + `STORAGE_NOT_LOW` constraints
  (`MaintenancePolicy`). WorkManager decides the actual time — ~15 min
  initial delay / ~12 h period are best-effort, no exact schedule (§66),
  no boot-time daemon, no own scheduler (§87). Execution is at-least-once;
  duplicates are safe (`backups.create` is idempotent).
- **Recovery.** A killed process recovers at the next open: kernel startup
  recovery marks the run `interrupted` (§63) and the web app resumes with
  `generation.retry` — no new kernel surface.
- **No new kernel surface.** The JNI symbol table, the wire registry and
  the schema hash stay frozen; background work uses only the existing
  envelope operations (`generation.start`/`retry`/`cancel`, `backups.create`)
  built with `EnvelopeBuilder` (byte-identical to the TS `wireEnvelope`).

### API-level matrix

| API level   | Background behaviour                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| 26 (minSdk) | `startForegroundService` + foreground notification required for the FGS                                                   |
| 33+         | `POST_NOTIFICATIONS` runtime permission before the notification can be shown                                              |
| 34+         | `dataSync` foreground-service type with the system quota (6 h/day cumulative; exhaustion stops the service → cancel path) |

Verified in CI: JVM unit tests for `KernelHolder`, `EnvelopeBuilder`,
`ForegroundExecutionCoordinator`, `NotificationState` and `MaintenancePolicy`
run in PR `checks`; `BackgroundExecutionInstrumentedTest` runs on the
API 26 and API 34 emulators in nightly.

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
- **Bounded foreground service only for user-visible active generation**: a
  `dataSync` FGS exists only while a generation stream the user can see is
  running — no always-on service, nothing at boot.
- **Best-effort maintenance, no exact schedule**: WorkManager decides when
  `backups.create` actually runs (battery/storage constraints gate it);
  there is no own scheduler, no alarm manager, no boot-time daemon (§66,
  §87).

See also: [ADR-0034](../adr/0034-android-local-host-jni-transport.md),
[ADR-0036](../adr/0036-android-background-execution.md),
[generation durability](../architecture/generation-durability.md),
[mobile-ffi README](https://github.com/Disya123/NeoTavern/blob/main/crates/adapters/mobile-ffi/README.md),
[Desktop local kernel mode](../desktop/README.md),
[Version axes](../architecture/version-axes.md).
