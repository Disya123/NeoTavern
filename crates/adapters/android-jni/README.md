# neotavern-android-jni

Thin JNI transport over the `neotavern-mobile-ffi` C ABI for the Android host
(ТЗ §6.9, Фаза 5).

```text
Kotlin KernelBridge → JNI (this crate) → nt_* (mobile-ffi) → Runtime Kernel → SQLite
```

One native library (`libneotavern_android_jni.so`) is loaded into the app
process by `com.neotavern.mobile.KernelBridge`
(`System.loadLibrary("neotavern_android_jni")`). The crate is the **only**
Rust code on the device; it adds no second kernel entry point — every kernel
call goes through the stable C ABI of `neotavern-mobile-ffi`, and the JNI
layer answers **byte-identical response envelopes** to the desktop Tauri
transport for the same request envelope (both go through the shared
`neotavern-envelope` mapping; §6.3: transports do not define their own DTOs).

## Relationship to mobile-ffi

| Concern        | mobile-ffi (`nt_*`)                                                           | android-jni (`jni_*` / JNI)                                                                                                       |
| -------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Kernel access  | Exported C ABI: opaque handles, bounded buffers, integer statuses             | Calls `nt_*` only; no direct `Kernel` access                                                                                      |
| Request decode | `nt_call` takes `(op, raw payload)`                                           | Decodes `wire.request.envelope` (operationId + payload) via the generated DTOs — never in Kotlin                                  |
| Response build | Returns **raw** kernel result/error bytes                                     | Builds the validated `wire.response.envelope` via `neotavern-envelope` (byte-identical to tauri-local)                            |
| Streams        | `nt_stream_start/wait/cancel/free` (notice + durable `generation.events` log) | Frames events/terminal/error into the frozen WebView bridge payloads                                                              |
| Errors         | `NT_ERR_*` status codes                                                       | `JniError { code, message }` → thrown `KernelException(int, String)` for transport/ABI failures; product errors stay in envelopes |
| Panics         | `guard()` → `NT_ERR_INTERNAL`                                                 | `catch_unwind` on every JNI entry point → `KernelException(NT_ERR_INTERNAL)`                                                      |

`mobile-ffi` and `tauri-local` are untouched; this crate compiles as
`cdylib` (for the device) and `rlib` (so the contract is exercised by the
host test suite).

## C ABI status codes (stable; what `KernelException.code` carries)

| Code | Name                 | Meaning                                                                 |
| ---- | -------------------- | ----------------------------------------------------------------------- |
| 0    | `NT_OK`              | Success                                                                 |
| 1    | `NT_ERR_INVALID_ARG` | Null/invalid pointer, non-UTF-8 string, oversized or malformed argument |
| 2    | `NT_ERR_CONTRACT`    | Contract violation (payload failed the generated DTO checks)            |
| 3    | `NT_ERR_NOT_FOUND`   | Operation or record not found                                           |
| 4    | `NT_ERR_STORAGE`     | Storage-layer failure (lease conflict, corruption, no durable storage)  |
| 5    | `NT_ERR_CANCELLED`   | Operation cancelled                                                     |
| 6    | `NT_ERR_INTERNAL`    | Internal failure (including a contained Rust panic)                     |
| 7    | `NT_ERR_BUFFER`      | Host output buffer too small                                            |
| 8    | `NT_ERR_MISMATCH`    | Contract/schema hash or ABI version mismatch                            |

## JNI method table (`com.neotavern.mobile.KernelBridge`, static natives)

| JNI symbol           | Signature               | Returns                                      | Errors                                         |
| -------------------- | ----------------------- | -------------------------------------------- | ---------------------------------------------- |
| `nativeHandshake`    | `()Ljava/lang/String;`  | Handshake JSON (below)                       | `null` only on a broken JVM                    |
| `nativeOpen`         | `(Ljava/lang/String;)J` | opaque kernel handle                         | `0` + `KernelException`                        |
| `nativeClose`        | `(J)V`                  | —                                            | idempotent; no exception                       |
| `nativeCall`         | `(J[B)[B`               | response-envelope bytes                      | `KernelException` (transport-level only)       |
| `nativeStreamStart`  | `(J[B)J`                | stream handle (live or virtual error stream) | `0` + `KernelException` (ABI-level only)       |
| `nativeStreamWait`   | `(JI)[B`                | one framing payload, or `null` on timeout    | `KernelException`                              |
| `nativeStreamCancel` | `(JJ)V`                 | —                                            | `KernelException` (best-effort; see Lifecycle) |
| `nativeStreamFree`   | `(J)V`                  | —                                            | idempotent; no exception                       |

The kernel is opened over the app-scoped `context.filesDir/neotavern`
(no permissions, no HTTP, no listening port; the native bridge never blocks
the main thread — the Kotlin host calls it from a background
`ExecutorService`).

### Handshake JSON (`nativeHandshake`)

```json
{
  "ffiAbiVersion": 1,
  "schemaHash": "<sha256 of the embedded contract manifest>",
  "wireProtocol": { "major": 1, "minor": 0 },
  "appVersion": "0.1.0"
}
```

### Request/response envelopes

`nativeCall(handle, requestEnvelope)` and `nativeStreamStart` accept the same
`wire.request.envelope` JSON bytes as every other transport:

```json
{
  "wireProtocol": { "major": 1, "minor": 0 },
  "schemaHash": "<contract schema hash>",
  "requestId": "<uuid v4>",
  "operationId": "meta.get",
  "payload": {}
}
```

Responses are validated `wire.response.envelope` JSON, byte-identical to
tauri-local for the same request:

```json
{ "kind": "ok", "requestId": "<echo>", "result": { ... } }
{ "kind": "error", "requestId": "<echo>", "error": { "code": "NOT_FOUND", "params": {} } }
```

Envelope decoding (operationId + payload extraction) happens in Rust via the
generated wire DTOs — **no hand-written wire DTOs anywhere**, and Kotlin never
parses envelopes.

### `nativeStreamWait` payloads (frozen WebView bridge framing)

One call returns exactly one payload (or `null` when nothing arrived within
`timeoutMs` — keep polling; `null` does **not** mean end-of-stream):

```json
{ "kind": "event", "event": { "streamId": "...", "sequence": 0, "type": "generation.delta", "payload": { } } }
{ "kind": "terminal" }
{ "kind": "error", "error": { "kind": "error", "requestId": "...", "error": { "code": "...", "params": {} } } }
```

- Events are delivered one per call, in ascending `sequence`, replayed from
  the durable `generation.events` log (ТЗ §64) — the log is the canonical
  source, mirroring the Tauri transport's poller.
- After the terminal event (`generation.completed` / `generation.failed` /
  `generation.cancelled`), exactly one `{"kind":"terminal"}` follows, then
  every later call returns `null`.
- The bridge passes these payload objects through verbatim to
  `window.__neotavernMobileCallbacks.resolve(callbackId, <payload>)`.

### Error-stream handles (stream-open product errors)

A streamable check, protocol mismatch or kernel/product-class failure of
`nt_stream_start` does **not** throw — it returns a _virtual error stream_
handle whose first `nativeStreamWait` yields
`{"kind":"error","error":<error response envelope>}` (the exact envelope the
desktop transport answers for the same request; stream-open product errors
are resolve()-class, not transport failures). ABI-level failures (unknown
handle, oversized request, unparseable envelope) throw `KernelException`.

## Error mapping

`JniError` → thrown `KernelException(int code, String message)` with the
mobile-ffi `NT_ERR_*` value as `code`. Kernel/product errors never throw —
they travel back as response envelopes (unary) or error-stream framing
(streams), exactly like tauri-local.

Known nuance: `nativeStreamCancel` sets the executor cancellation flag
**before** dispatching the durable `generation.cancel` operation, so the
abort is effective even when the returned status reports a state conflict
(the single writer thread processes the durable op only after the run it is
executing finishes). Treat a cancel error as best-effort, mirroring the
desktop transport's `abort_stream`.

## Lifecycle

1. `nativeHandshake()` — check `ffiAbiVersion`/`schemaHash` against the WebView bundle (a stale bundle or mismatched native library is caught before any product write; §6.5).
2. `nativeOpen(filesDir/neotavern)` — one kernel per app process; `0` + `KernelException` on failure (e.g. `DATA_ROOT_IN_USE` semantics via `NT_ERR_STORAGE`).
3. `nativeCall` / `nativeStreamStart` + `nativeStreamWait` + `nativeStreamCancel` — background executor, never the main thread.
4. `nativeStreamFree(stream)` — always after a stream ends (idempotent).
5. `nativeClose(handle)` — frees the kernel **and every stream it owns** (idempotent; closing while a stream pump is running is the host's lifecycle bug, surfaced as a controlled `KernelException` on the next wait).

Handles are i64 pointer values registered in process-local tables; a stale
handle is a controlled `JniError` (never undefined behaviour), and
double-free / double-close are no-ops.

## Building for Android

The library is **not committed**; it is produced by
`apps/android/scripts/build-libs.sh` (CI invokes it with `cargo ndk`; Android
Studio users run it locally — rustup android targets already installed):

```bash
cd apps/android
bash scripts/build-libs.sh
```

The script must resolve the Rust workspace root (`crates/Cargo.toml` — the
repo root has no manifest) and run, e.g. from `apps/android`:

```bash
cargo ndk -t arm64-v8a -t x86_64 \
  -o app/src/main/jniLibs \
  build --release \
  --manifest-path ../../crates/Cargo.toml \
  -p neotavern-android-jni
```

Output: `app/src/main/jniLibs/{arm64-v8a,x86_64}/libneotavern_android_jni.so`.
The `jni` dependency is used with `default-features = false` — the library is
loaded into an existing JVM on device, so `libjvm` must never be linked.

## Tests

Host-runnable, no JVM (`cargo test -p neotavern-android-jni`):

| Test                                                   | Covers                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handshake_reports_abi_and_schema`                     | handshake JSON: ffiAbiVersion/schemaHash/wireProtocol/appVersion                                                                                       |
| `open_meta_get_round_trip_and_idempotent_close`        | open over a tempfile data root, `meta.get` envelope round trip, requestId echo, idempotent close                                                       |
| `unknown_operation_returns_not_found_envelope`         | product error envelope, not a transport failure                                                                                                        |
| `contract_violation_returns_error_envelope_not_panic`  | payload fails the generated DTO checks → error envelope, never a panic                                                                                 |
| `oversized_request_is_invalid_arg`                     | `MAX_REQUEST_LEN` bound checked before allocation                                                                                                      |
| `garbage_envelope_is_a_transport_error`                | unparseable body → transport-level `JniError`                                                                                                          |
| `response_envelopes_are_byte_identical_to_tauri_local` | **byte equality** with `neotavern-tauri-local::dispatch_envelope` for ok / NOT_FOUND / contract-violation / protocol-mismatch requests                 |
| `generation_stream_events_until_terminal`              | stream start → per-event framing (validated `wire.event.envelope`s, strictly increasing sequences) → terminal framing → `null` after; double-free safe |
| `stream_cancel_requests_and_terminates`                | cancel flag effect against a live (slow fake) run → `generation.cancelled` terminal                                                                    |
| `stream_start_non_streamable_is_an_error_stream`       | non-streamable op and protocol mismatch → virtual error stream with the desktop's exact envelope                                                       |
| `unknown_handles_are_controlled`                       | stale kernel/stream handles and cancel-of-error-stream are controlled `InvalidArg` errors                                                              |
