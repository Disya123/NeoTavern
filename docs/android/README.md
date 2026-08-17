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
  byte-identical request envelopes to `TauriTransport`. The default
  `createBackend()` on Android is `LocalBackend` over that bridge. The
  themed HostConnect gate (`data-component="host-connect"`). The gate skin
  lives in `@neotavern/ui` (`@layer components`, `--st-*` tokens, Card /
  Button / TextField / Segmented) so installed themes can restyle it; there
  is no CSS Module palette. `ThemeSync` mounts above the gate: the on-device
  kernel theme paints the connect screen when one is installed. The gate
  can switch the singleton to `RemoteBackend` over Headless / Desktop
  Remote Access (URL or QR pairing link). Pairing tokens stay in
  sessionStorage, never localStorage. After the first pick, **Settings →
  General → Host** and the Home onboarding **Use another host** button
  reopen the same gate without clearing the session until a new Connect
  succeeds. Reopen lands on the _other_ method (local → Link, remote →
  This device) so Local and pairing links stay interchangeable.

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
- **Starter pack.** `nt_kernel_open` sets `NEOTA_SEED_STARTER=1` so the
  writer thread imports the bundled Hazel character (V3 card + original
  PNG avatar) and the four-entry Vesper lorebook — the same files as
  `apps/server/assets/starter/`. The avatar is published on the writer
  thread because it exceeds the wire `assets.put` 1 MiB cap. Stage markers
  live in `__neotavern_meta` (`starter.hazel.v1.*`). After `.complete`,
  deleting or editing Hazel is user intent and is not undone on the next
  launch. A missing or corrupt asset logs `starter content retry` and does
  not block the kernel.
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
- **System bars (safe-area).** Android 15+ (`targetSdk 35`) draws the
  activity edge-to-edge. Android WebView does **not** populate CSS
  `env(safe-area-inset-*)` (it stays 0) and **does not inset HTML for
  `View.setPadding`**. Padding a native host around the WebView left a dead
  strip that was not part of the document. `MainActivity` lays the WebView
  out full-screen and publishes `WindowInsetsCompat` (`systemBars |
displayCutout`) as both `--nt-safe-area-*` and `--nt-inset-*` on
  `documentElement` (CSS pixels). The web client also reads
  `window.__neotavernMobile.safeAreaCss()` so chrome is not stuck at 0 when
  `evaluateJavascript` races hydration. Theme chrome reads `--nt-inset-*`.
  Status/nav bars are
  transparent (`isAppearanceLightStatusBars = false`). Interactive chrome
  (chat header, rail, Character Manager title/close, Cards/Edit tabs) sits
  below the clock and above the gesture pill; wallpaper and scrollable
  lists pass **under** the status bar. On viewports ≤ 600 px the chrome
  floors at `--st-space-2xl` when `--nt-inset-*` is still 0, so the
  gesture pill cannot cover Cards/Edit while WindowInsets catch up. The
  web client ignores a `safeAreaCss()` box of all zeros so it cannot
  clobber a later real measurement.
- **M-1 presentation measurement (NeoUI v4 RFC, not a compositor).** Before
  Gate P the host may only collect Track A/A0/B evidence. Production visuals
  stay live-glass CSS on `file://`. The activity always **requests** the highest
  refresh mode that matches the current physical resolution
  (`preferredDisplayModeId`) and logs `m1-refresh` / `m1-env` / `m1-memory` /
  `m1-thermal` under tag `NeoTavern`. Requesting a mode is not the same as
  getting it (`ENVIRONMENT_BLOCKED` if the OS stays at 60 Hz). Track A0
  (glass off/static) is **opt-in only**:
  `adb shell am start -n com.neotavern.mobile/.MainActivity -e com.neotavern.mobile.MEASUREMENT_GLASS off`.
  That sets `data-nt-measurement-glass="off"` so the user cascade layer
  zeroes blur tokens and disables `backdrop-filter`. Track B is **opt-in
  only** (`MEASUREMENT_ORIGIN=asset-loader`): same APK assets via
  `WebViewAssetLoader` at `https://appassets.androidplatform.net/assets/web/index.html`.
  The SPA already treats that host as a packaged WebView; production default
  stays `file://`. An optional 30 s sampler (`MEASUREMENT_FRAMES=on`) logs
  `m1-frames` (rAF) and `m1-choreographer` (UI thread). On API 35+ the WebView
  votes `setRequestedFrameRate` at the requested Hz. Capture helper:
  `node scripts/m1-android-capture.mjs --track a --phase cold`. Fill-in evidence:
  [BaselineReport M-1](../rfc/m1-baseline-report.md). Do not ship A0 or B as
  the default. See [RFC NeoUI v4](../rfc/neoui-v4-android-presentation-backend.md)
  §0.3.1. The M0-D1a paint-seam probe is `crates/presentation-m0`. Production
  kernel JNI does not link it. Debug APK can load `M0D1aActivity` (not the
  launcher). Morning AVD GLES 3.1 is **PRE-GATE / BLOCKED**. Evening AVD
  D1a on the installed APK is **BLOCKED / NON-ADMISSIBLE** (`.so` ≠ current
  source). Capture host is **READY** (RenderDoc v1.45 at `E:\renderdoc`;
  AGI 3.3.3 archived `CAPTURED_BUT_NOT_REPLAYABLE`). Program **M0-D1a is
  PASS** on the host-side record
  [`m0-d1a-adjudication.json`](../rfc/m0-d1a-adjudication.json); the probe
  still logs `capture=false`. The 1437-byte GLES capture is
  `WRONG_API_CAPTURE / NON-ADMISSIBLE`. See [M0-D1a probe](../rfc/m0-d1a-probe.md)
  and the [physical capture runbook](../rfc/m0-d1a-physical-runbook.md).
  M0-D2 is **PASS** on the host-side record
  [`m0-d2-adjudication.json`](../rfc/m0-d2-adjudication.json) (Dioxus/Blitz
  producer seam plus compositor moving sample; probe `capture=false`; not
  production JNI). See [M0-D2 probe](../rfc/m0-d2-probe.md) and the
  [physical runbook](../rfc/m0-d2-physical-runbook.md). Technical M0 is
  **PASS**. `D1=Track D GO` and `D2=Dioxus+Blitz GO` are
  signed ([d1-d2-decision.md](../rfc/d1-d2-decision.md)); `D3=DEFERRED`.
  React/WebView remains the public renderer and rollback. Production
  compositor types start in `crates/neocompositor` (Milestone B **STARTED**,
  not PASS) with a bounded mailbox and spatial/scroll/clip/effect trees, and
  are **not** linked into `libneotavern_android_jni.so`.
  `NEOTA_NEOCOMPOSITOR=1` is a non-default flag, not a cutover switch.

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
  (§85). Stop is an explicit `PendingIntent.getService` targeting
  `GenerationService` (not a package-scoped implicit broadcast — those do
  not reach a non-exported runtime receiver on API 34+, including 36).
  The Stop action and OS service expiration both map to
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
  `WebViewUserFlowInstrumentedTest.hostConnectLocal_generationViaBridge_processDeathInterruptedThenRetry`
  starts `generation.start` through `window.__neotavernMobile.call` on the
  production `<filesDir>/neotavern` root, closes the shared kernel without
  `generation.cancel`, and asserts interrupted → retry.
  `BackgroundExecutionInstrumentedTest` covers the same recovery on a temp
  data root, plus FGS user-stop and WorkManager unique-work dedup.
- **No new kernel surface.** The JNI symbol table, the wire registry and
  the schema hash stay frozen; background work uses only the existing
  envelope operations (`generation.start`/`retry`/`cancel`, `backups.create`)
  built with `EnvelopeBuilder` (byte-identical to the TS `wireEnvelope`).

### API-level matrix

| API level   | Background behaviour                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 26 (minSdk) | `startForegroundService` + foreground notification required for the FGS                                                                             |
| 33+         | `POST_NOTIFICATIONS` runtime permission before the notification can be shown                                                                        |
| 34+         | `dataSync` foreground-service type with the system quota (6 h/day cumulative; exhaustion stops the service → cancel path)                           |
| 34+ / 36    | Stop is `PendingIntent.getService` → `GenerationService` (`ACTION_STOP`). Package-scoped implicit broadcasts do not reach this non-exported service |

Verified in CI: JVM unit tests for `KernelHolder`, `EnvelopeBuilder`,
`ForegroundExecutionCoordinator`, `NotificationState` and `MaintenancePolicy`
run in PR `checks`; `BackgroundExecutionInstrumentedTest` and
`WebViewUserFlowInstrumentedTest` run on the API 26 and API 34 emulators
in nightly (`connectedDebugAndroidTest`).

## Phase gate status (ТЗ §78)

- **PR CI (`checks`):** JVM unit tests — host bridge, secret store,
  lifecycle, envelope mapping.
- **Nightly emulator:** instrumentation tests in
  `.github/workflows/nightly.yml` run on the emulator against the real
  kernel.
- **CI `android-build` job:** compiles the APK with Gradle 8.9 / AGP 8.5.2
  / Kotlin 1.9.24 on JDK 17 after `pnpm --filter @neotavern/web build`.
  Assemble is **fail-closed** without `apps/web/dist/index.html`; the job
  then unzips debug and release APKs and requires `assets/web/index.html`
  (ТЗ §18.3 Packaged). The release APK is debug-signed in CI — store
  signing is the release gate, not M6. Android compilation is verified in CI — no local Android
  toolchain is required to develop other platforms.
- The `.so` is **not committed**: `apps/android/scripts/build-libs.sh`
  (cargo ndk) produces
  `apps/android/app/src/main/jniLibs/{arm64-v8a,x86_64}/libneotavern_android_jni.so`
  from the `neotavern-android-jni` crate before the APK build. Web assets
  are staged by Gradle `packageWebAssets` from `apps/web/dist` into
  `assets/web/` (never committed under `app/src/main/assets/web/`).

## Explicit constraints

- **No Node** on the device, **no listening port**, **no HTTP server**:
  local mode talks to the kernel over the in-process bridge only. Remote
  URL/QR modes use the device's INTERNET permission to reach a user-chosen
  Headless / Desktop Remote Access host (Product Wire `/rpc`). CAMERA is
  optional for QR pairing.
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
[NeoUI v4 RFC (non-canonical)](../rfc/neoui-v4-android-presentation-backend.md),
[BaselineReport M-1](../rfc/m1-baseline-report.md),
[M0-D1a paint-seam probe](../rfc/m0-d1a-probe.md),
[M0-D1a physical capture runbook](../rfc/m0-d1a-physical-runbook.md),
[M0-D1a host adjudication](../rfc/m0-d1a-adjudication.json),
[M0-D1b moving sample](../rfc/m0-d1b-probe.md),
[M0-D1b host adjudication](../rfc/m0-d1b-adjudication.json),
[M0-D1b physical capture runbook](../rfc/m0-d1b-physical-runbook.md),
[M0-D2 producer seam](../rfc/m0-d2-probe.md),
[M0-D2 host adjudication](../rfc/m0-d2-adjudication.json),
[M0-D2 physical capture runbook](../rfc/m0-d2-physical-runbook.md),
[TrackComparison](../rfc/m0-track-comparison.md),
[D1/D2 decision](../rfc/d1-d2-decision.md),
[Gate P decision record (signed GateP:P1)](../rfc/gate-p-decision-draft.md),
[ADR-0036](../adr/0036-android-background-execution.md),
[generation durability](../architecture/generation-durability.md),
[mobile-ffi README](../../crates/adapters/mobile-ffi/README.md),
[Desktop local kernel mode](../desktop/README.md),
[Version axes](../architecture/version-axes.md).
