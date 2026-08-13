# neotavern-mobile-ffi

Phase 5 native bridge for mobile hosts (ТЗ §6.9): a minimal stable C ABI over
the SAME `runtime_kernel::Kernel` instance the local/remote transports use.

## Purpose

- **ABI-safe transport only.** The exported `nt_*` functions pass opaque
  handles, bounded length-delimited buffers, UTF-8 operation ids and stable
  integer status codes. Product Rust structs, SQLite rows and internal enums
  never cross the boundary (§6.9).
- **Same wire contract.** Payloads are the identical Product Wire Contract
  bytes used by Local IPC and the Remote Adapter: `nt_call` and
  `nt_stream_start` dispatch through `Kernel::dispatch` /
  `Kernel::dispatch_stream`, so schema validation, handshake and error
  mapping are the generated contract's, not a second copy (§6.3).
- **No ownership.** The adapter never opens SQLite and never takes a
  data-root lease — the kernel is the single writable owner (§22). One
  kernel instance serves every transport; mobile background workers that
  recreate the kernel must obtain the same lease before any writable open.
- **No platform branching.** One code path for every native host (Android
  JNI, future Swift); no `isAndroid`/`isServer` in the kernel or here.

## ABI surface

The crate compiles as both `cdylib` (real FFI consumers) and `rlib` (the
test suite exercises the exported contract in-process).

### Handles and ownership

| Symbol | Contract |
| --- | --- |
| `nt_ffi_version()` | Returns `FFI_ABI_VERSION` (currently 1). A host must require exactly this value before creating a kernel handle (§6.5). |
| `nt_kernel_open(data_root, out_handle)` | Opens a kernel over a NUL-terminated UTF-8 path (`null` → stateless kernel). On success stores an opaque `NtKernel*` in `out_handle`. |
| `nt_kernel_free(handle)` | The only legitimate way to release a kernel handle (null is a no-op). |
| `nt_call(handle, op, req, req_len, out, out_cap, out_len)` | One unary operation. The response, or on error the serialized product error, is copied into the host buffer. |
| `nt_stream_start(handle, op, req, req_len, out_stream, out_id, out_id_cap, out_id_len)` | Starts a durable generation stream; stores an opaque `NtStream*` and copies the run id (on error, the error body) into `out_id`. |
| `nt_stream_wait(stream, timeout_ms, out_sequence)` | Blocks up to `timeout_ms` for the next committed/terminal sequence (or `-1` on timeout). Event payloads are replayed via `nt_call(..., "generation.events", ...)` — the durable log is canonical (§64). |
| `nt_stream_cancel(handle, stream)` | Sets the executor cancellation flag and issues the durable `generation.cancel` operation. |
| `nt_stream_free(stream)` | The only legitimate way to release a stream handle (null is a no-op). |

### Status codes

| Code | Meaning |
| --- | --- |
| `NT_OK` (0) | Success. |
| `NT_ERR_INVALID_ARG` (1) | Null/invalid pointer, non-UTF-8 string, oversized (`> MAX_REQUEST_LEN`) or malformed argument. |
| `NT_ERR_CONTRACT` (2) | Payload failed the generated DTO checks (request or response). |
| `NT_ERR_NOT_FOUND` (3) | Operation or record not found. |
| `NT_ERR_STORAGE` (4) | Storage-layer failure (lease conflict, corruption, no durable storage). |
| `NT_ERR_CANCELLED` (5) | Operation cancelled. |
| `NT_ERR_INTERNAL` (6) | Internal failure, including a contained Rust panic. |
| `NT_ERR_BUFFER` (7) | Host output buffer too small; `*out_len` carries the required capacity. |
| `NT_ERR_MISMATCH` (8) | Contract/schema hash or ABI version mismatch at open. |

Error bodies carry the wire product DTO verbatim when the kernel produced one
(`err.product`), otherwise `{code, message, issues}` where `issues` lists the
generated-checker violation paths (`{path, rule}`). Raw payloads and secrets
are never included.

### Buffer and memory rules (§6.9)

- Buffer sizes are checked **before** any allocation or parse
  (`req_len ≤ MAX_REQUEST_LEN` = 1 MiB; `out_cap` host-provided).
- Rust allocations are freed only by exported Rust free functions
  (`nt_kernel_free`, `nt_stream_free`); the host never frees a Rust
  allocation.
- On `NT_ERR_BUFFER`, `*out_len` reports the required capacity without
  allocating.
- Rust panics never cross the ABI: every entry point is wrapped in
  `catch_unwind` (`guard`); a panic becomes `NT_ERR_INTERNAL`.
- Handles are `Send + Sync`; any thread may call (the kernel's writer
  coordinator serializes actual writes).

## Tests

```sh
cargo test -p neotavern-mobile-ffi
```

`src/lib.rs` unit tests drive the exported contract directly: panic
containment (`guard_contains_panics`), stateless open + `meta.get` round-trip
with buffer-shortage reporting, unknown-operation/oversized-request/contract
violation negatives, and a full storage CRUD + `generation.start` stream
notice over the FFI (`storage_crud_and_stream_over_ffi`, seeding the chat
through `neotavern_storage` after closing the kernel lease). The ABI version
is asserted against `runtime_kernel::FFI_ABI_VERSION`.
