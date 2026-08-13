# ADR-0034: Android Local Host — JNI + WebView Bridge over the mobile FFI ABI

Date: 2026-08-13. Status: Accepted (Phase 5).
Related documents: [Android local host](../android/README.md),
[Desktop](../desktop/README.md), [Wire contracts](../architecture/wire-contracts.md),
[Version axes](../architecture/version-axes.md),
[ADR-0029](0029-wire-contract-toolchain.md), [ADR-0030](0030-remote-http-adapter.md),
[ADR-0033](0033-desktop-local-kernel-transport.md),
ТЗ §5.4, §6.9, §13, §78 Фаза 5.

## Context

ТЗ §13 requires a Mobile Host that runs the local-first product on the
device; §6.9 fixes the FFI/JNI ABI policy for every native bridge; §5.4
defines the host set (desktop, web, mobile). Phase 5 delivers the Android
local foundation: basic CRUD/settings plus startup recovery, with generation
streams wired and no provider-config UI on mobile yet.

Before this ADR the Phase 5 native bridge existed only as the C ABI crate
(`crates/adapters/mobile-ffi`, ADR-0029 toolchain, §6.9): opaque handles,
bounded buffers, status codes — but no Android host consumed it. The desktop
showed the pattern (ADR-0033: embedded kernel, no HTTP, bundled web assets,
typed TS `LocalTransport`), yet Android differs materially: the JNI boundary
is a second marshalling layer, the WebView is the only UI surface, secrets
must come from the Android Keystore, and the APK build is a separate
Gradle/cargo-ndk pipeline. The wire contract is frozen (`WIRE_SCHEMA_HASH`,
21 operations), so the host surface is exactly the frozen registry.

## Decision

- **JNI transport over the existing mobile-ffi C ABI.** The new
  `neotavern-android-jni` crate (cdylib + rlib, cargo workspace member) is
  **thin marshalling only**: JNI argument/result conversion onto the stable
  `nt_*` functions (`nt_ffi_version`, `nt_kernel_open/free`, `nt_call`,
  `nt_stream_start/wait/cancel/free`). There is one ABI implementation
  (§6.9); the JNI crate never re-implements dispatch, validation or error
  mapping.
- **Envelope extraction in Rust; no hand-written Kotlin DTOs.** Request and
  response payloads stay the identical Product Wire Contract bytes; JSON
  parsing and validation happen in the Rust/kernel side, so the Kotlin side
  only moves bytes between the WebView bridge and JNI. A wire schema change
  requires no Kotlin changes (regenerated Rust boundary DTOs only).
- **Opaque `jlong` handles; controlled `KernelException`; no Rust panic
  crossing JNI.** Kernel and stream handles are stored as opaque `jlong`s
  (never pointers in Kotlin). Every JNI entry point contains Rust panics
  (mobile-ffi `catch_unwind` → `NT_ERR_INTERNAL`); an FFI-level failure
  surfaces to Kotlin as a single controlled `KernelException` carrying the
  stable status code — no panic, no undefined behavior across the
  boundary.
- **WebView bridge with a frozen callback protocol.** The native host
  installs `window.__neotavernMobile` (`handshake()` sync JSON, `call()`
  fire-and-forget with `callbackId`, `cancelStream()`); the TS transport
  installs `window.__neotavernMobileCallbacks = { resolve, reject }`
  before any call and receives async envelopes (ok / product error /
  stream event, terminal, error). The TS side is `MobileBridgeTransport`
  (`LocalBackend` over it), byte-identical envelope construction to
  `TauriTransport` and the same typed `TransportError` split.
- **No localhost, no Node, bundled web assets.** The WebView loads web
  assets bundled into the APK; there is no HTTP server, no listening port
  and no Node on the device — the kernel is embedded and reached only over
  the in-process bridge. No arbitrary third-party JS runs in the WebView.
- **Keystore secrets.** Secrets are stored with Android Keystore AES/GCM
  keys; there is no plaintext fallback, and keystore failure is a typed
  `SecretStoreUnavailableError`.
- **Routing.** `createBackend()` keeps its exact default (Tauri bridge →
  `LocalBackend`, else `LegacyBackend`); the local profile adds an explicit
  override layer routing to `LocalBackend` over `MobileBridgeTransport`.

## Alternatives

- **Tauri Android host (reuse the desktop shell).** The Tauri Android
  target exists as a remote-server test client (see
  [Desktop](../desktop/README.md)), but as the local host it would drag the
  WRY/webview management, the Tauri IPC layer and the desktop bundle into
  the mobile product and add a second kernel-bridge stack beside
  `mobile-ffi` (§6.9 names one native ABI). Rejected — a plain Android
  WebView + a thin JNI crate on the frozen C ABI keeps the mobile stack
  minimal and the ABI single-sourced.
- **Direct Kotlin → Kernel (no mobile-ffi).** Kotlin calling into
  `runtime-kernel` directly (or a Kotlin-native reimplementation of the
  bridge) would create a second dispatch/validation implementation and
  violate §6.9's single-ABI policy. Rejected — the JNI crate marshals to
  the existing `nt_*` ABI, so Android and future Swift hosts share one
  boundary contract.

## Consequences

- **Android compilation is verified in CI only**: the `android-build` job
  compiles the APK (Gradle 8.9 / AGP 8.5.2 / Kotlin 1.9.24, JDK 17, minSdk
  26) on every PR; JVM unit tests run in the PR `checks` job and
  instrumentation tests run on the nightly emulator. No local Android
  toolchain is required for other platforms.
- **The `.so` is not committed**: `apps/android/scripts/build-libs.sh`
  (cargo ndk) builds
  `apps/android/app/src/main/jniLibs/{arm64-v8a,x86_64}/libneotavern_android_jni.so`
  from `neotavern-android-jni` before the APK build; the web assets are
  bundled from the built web app.
- **Remote profiles are deferred to Phase 9**: the Phase 5 host is
  local-only; remote access on mobile reuses the Phase 4/9 remote adapter
  surface later.
- Phase 5 scope stays bounded: basic CRUD/settings, startup recovery and
  generation streams; no provider-config UI on mobile.
