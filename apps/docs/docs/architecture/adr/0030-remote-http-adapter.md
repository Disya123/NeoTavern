---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0030-remote-http-adapter.md
---

# ADR-0030: Remote HTTP Adapter — envelope-over-HTTP on the shared Runtime Kernel

Date: 2026-08-13. Status: Accepted (Phase 4 core; TLS termination and pairing
land with Phase 4 hardening / Phase 9).
Related documents:
[ADR-0029](0029-wire-contract-toolchain.md) (wire contract single source and
codegen), [Wire contracts](../architecture/wire-contracts.md),
[Operations inventory](../architecture/operations-inventory.md),
[Version axes](../architecture/version-axes.md).

## Context

ТЗ §9–§12 requires Headless/VPS to serve the same Runtime Kernel over
HTTP/SSE, with the server being an **adapter**, not a mode of the kernel:
`Core::start(serverMode=true)` and `isServer` branching are forbidden. The
kernel must stay transport-free — it sees only `operationId` + payload bytes
through `Kernel::dispatch` — and all adapters of one host must share one
Kernel instance (one data-root lease, one writer coordinator, §9/§22).

The legacy TypeScript server (`apps/server`) keeps serving the unmigrated
`/api/v2` surface; its in-flight user changes forbid touching it. The Phase 4
remote surface therefore needs a new, standalone adapter crate that:

- maps HTTP + SSE onto the frozen wire envelopes without creating a second
  copy of any product DTO (§6.3: transports map `operationId`, they do not
  define request/response DTOs);
- enforces the §10 security defaults: loopback-only unless a trusted
  TLS-terminating boundary is explicitly declared, bounded request sizes and
  concurrency, fail-closed negotiation;
- never opens SQLite and never implements product rules (it calls
  `Kernel::dispatch`, which owns both).

## Decision

### 1. New crate `crates/adapters/remote-http` (package `remote-http-adapter`)

A std-only adapter (tiny_http 0.12 thread pool; no tokio/async) exposing:

- `RemoteAdapter::start(Arc<Mutex<Kernel>>, RemoteAdapterConfig)` → bound
  adapter; `local_addr()`, `is_listening()`, `shutdown()` (graceful drain with
  `drain_timeout`, then listener release);
- routes: `GET /meta` (handshake), `POST /rpc` (request envelope → response
  envelope), `POST /rpc/stream` (SSE; terminal-frame semantics now, durable
  event streams arrive with Phase 6 generation workflows);
- `RemoteAdapterConfig { bind_addr, trusted_proxy, max_request_bytes,
max_connections, drain_timeout }` with loopback-ephemeral defaults.

### 2. `Arc<Mutex<Kernel>>` is the adapter-level writer coordinator

`Kernel` is `Send` but not `Sync` (its storage handle is a
`RefCell<Option<Database>>`). The adapter wraps the kernel in a `std::sync::Mutex`
so concurrent HTTP requests serialize on the single writer — exactly the
"one writer coordinator" of §22 — without changing the kernel or making
product state reachable unsynchronized. A poisoned mutex maps to a controlled
`INTERNAL` error envelope, never a panic.

### 3. Envelope-over-HTTP mapping (the transport defines no DTOs)

- `POST /rpc` body is the frozen `wire.request.envelope`. Once the envelope
  parses and passes the protocol check, the response is always HTTP 200 with a
  `wire.response.envelope` (`kind: ok` | `kind: error`); the product outcome
  lives inside the envelope.
- Transport-level failures before a usable envelope: 400 (JSON parse or
  envelope-schema violation, `CONTRACT_VIOLATION` with `issue.*.path` /
  `issue.*.rule` params), 413 (body over `max_request_bytes`,
  `QUOTA_EXCEEDED`), 404 (unknown route, `NOT_FOUND`), 405 (wrong method,
  `VALIDATION`).
- Protocol negotiation (§6.5 remote rule): `wireProtocol.major` must equal the
  embedded manifest major and client `minor` must not exceed the server's; a
  violation returns 426 with an error envelope (`PROTOCOL_MISMATCH`,
  `client_major`/`server_major` params) **before** dispatch — a mismatched
  client cannot execute product writes. Remote clients are not required to
  match `schemaHash` (§6.5).
- Kernel results are copied into the envelope verbatim after
  `validate_response_envelope` (§6.4: responses are validated before send).
  `KernelError.product` (e.g. `CHARACTER_NOT_FOUND`) is copied into the error
  envelope untouched; kernel-level classes map to canonical wire codes
  (`CONTRACT_VIOLATION`, `NOT_FOUND`, `CANCELLED`, `DATA_ROOT_IN_USE`,
  `INTERNAL`, …).

### 4. Security defaults (§10)

- Default bind `127.0.0.1:0`; `start()` rejects any non-loopback bind with
  `AdapterError::InsecureBind` **before** binding unless `trusted_proxy:
true` is set explicitly. `trusted_proxy` declares a TLS-terminating reverse
  proxy boundary (§10: "non-loopback требует TLS либо явно настроенного
  trusted reverse proxy boundary"); the adapter itself does not terminate TLS
  yet — that is Phase 4 hardening / Phase 9 work, and no listener can be
  started publicly without this explicit declaration.
- `max_request_bytes` enforced pre-read via Content-Length and by bounded
  reads for chunked bodies; `max_connections` bounds the worker pool.
- No auth/audit in this core slice: pairing, sessions, tokens, rate limiting
  and audit events are Phase 4 hardening (ADR-0005 remote-session model
  informs them); the crate is not a full remote-access server until those
  land. `GET /meta` is intentionally unauthenticated (public handshake).

### 5. SSE framing now, durable streams with Phase 6

`src/sse.rs` implements spec-correct framing (`event:` / `id:` / `data:`
lines, multi-line data split, terminal frame) and `Last-Event-ID` parsing so
reconnect/resume plumbing exists. `/rpc/stream` validates the envelope, checks
the registry for an `eventSchemaId`, and answers with an error frame +
terminal `stream.closed` frame. In the frozen registry only `generation.start`
declares `eventSchemaId: "wire.generation.event"`, but its kernel
implementation is Phase 6, so dispatch returns `NOT_FOUND` for it today;
non-streamable operations (`characters.list`, …) are rejected with
`CONTRACT_VIOLATION` (`operation_not_streamable`). Actual sequenced event
delivery, at-least-once resume and snapshot fallback (§64) arrive with the
Phase 6 generation workflow — the transport contract is already fixed by
`wire.event.envelope`.

### 6. Kernel untouched

No changes to `crates/runtime-kernel` or `crates/contracts-generated`: the
kernel stays transport-free, the wire hash is unchanged, and the adapter
consumes only the existing public dispatch/meta surface plus the generated
envelope decoders/validators.

## Alternatives

- **Reuse the Fastify server as the remote surface.** Rejected for now:
  `apps/server` has in-flight user changes and would require routing the
  kernel through Node; the ТЗ allows Fastify reuse (Phase 4) but the adapter
  must sit on the same Kernel instance, and a Node process would duplicate
  the writer boundary. The legacy surface keeps serving unmigrated families.
- **Rust async HTTP (hyper/tokio).** Rejected: tiny_http's fixed thread pool
  is the bounded concurrency the §10 limits require, adds no runtime, and
  keeps the crate dependency-light for Android/Desktop targets.
- **Kernel-internal server mode.** Rejected explicitly by §9
  (`Core::start(serverMode=true)` forbidden).
- **Adapter-level rate limiting now.** Deferred to hardening: the bounded
  worker pool and body limits already cap resource use; per-client rate
  limiting needs the session model (ADR-0005) to be meaningful.

## Consequences

- **Positive:** the same Kernel serves local IPC and remote HTTP with one
  writer; envelope/DTO semantics are identical on both transports; insecure
  public binds fail closed at startup; the wire hash and generated DTOs are
  untouched; the adapter is a small, std-only crate testable in CI.
- **Costs:** all dispatch is serialized by the mutex (correct for SQLite
  single-writer; read parallelism is a later optimization that must keep the
  writer coordinator); TLS termination and pairing are still missing, so the
  crate is not yet a production remote-access server; `/rpc/stream` cannot
  stream real events until Phase 6.
- **Process:** new crate registered in `crates/Cargo.toml`; `cargo test`
  covers the integration suite (`tests/remote_http.rs`); contract codegen
  untouched (frozen hash).

## Migration

No DDL, no runtime migration, no wire change. The adapter is additive: it can
be disabled/reverted independently; storage and Kernel are unaffected.
Rollback — stop starting the adapter; the legacy Fastify surface and local
paths remain unchanged.
