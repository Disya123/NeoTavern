# runtime-kernel

The NeoTavern runtime kernel: a transport-free, in-process dispatcher for the
product wire contract (see `packages/contracts/src/wire` and the generated
contract bundle). Operation routing, contract validation and cancellation
(Phase 1), SQLite-backed durable storage (Phase 2) and product CRUD over the
frozen wire contract (Phase 3); no network.

## Purpose

`runtime-kernel` is the single authority that executes product-wire operations.
It validates its embedded contract manifest (`contracts_generated::contract_schema_hash`)
against the caller-provided expectation at `Kernel::open`, decodes request
payloads through the generated DTO checkers, and returns serialized DTO bytes.

Because every payload crosses the generated DTO boundary (`decode_*` /
`validate_*` in `contracts_generated::generated`), request bytes can never panic
the kernel: malformed input surfaces as `KernelErrorCode::ContractViolation`.

The kernel is deliberately std-only (no tokio, no HTTP, no platform I/O, no UI).
Transport concerns live in the facade layer (`packages/neobackend`); this crate
only implements the in-process dispatch semantics.

## Public API

- `CancellationFlag` — `Arc<AtomicBool>` cancellation token passed into every
  dispatch; `cancel()` / `is_cancelled()`.
- `KernelError` / `KernelErrorCode` — error model:
  `ContractMismatch`, `ContractViolation`, `OperationNotFound`, `Unauthorized`,
  `Internal`, `Cancelled`, `DataRootInUse`, `StorageFailure`, `NotFound`,
  `Conflict`, `ProviderError`; carries `Issue` paths from the generated
  checkers plus diagnostic `params` and an optional wire `product` DTO
  (Phase 3).
- `KernelConfig` — `{ expected_schema_hash: String, ffi_abi_version: u32, data_root: Option<PathBuf> }`.
- `Kernel` — `open(config)` validates hash + ABI against the embedded manifest
  (`ffiAbiVersion` must be `1`) and, with a `data_root`, spawns the
  writer-coordinator thread that owns the database (§22). `Kernel` is
  `Send + Sync`; `dispatch(operation_id, request, cancel)` and
  `dispatch_stream(operation_id, request, cancel)` are cheap channel
  round-trips to that thread. `meta.get` is stateless; the Phase 3/6 product
  operations require a `data_root` (else `StorageFailure`). Streaming
  operations (`generation.start`, `generation.retry`) are only accepted by
  `dispatch_stream` — `dispatch` rejects them with `OperationNotFound` and
  vice versa. Unknown operation → `OperationNotFound`.
- `EventStream` / `StreamNotice` — streaming handle returned by
  `dispatch_stream`: `stream_id()` (== generation run id) and
  `next_notice(timeout)` → `Committed { through_sequence }` /
  `Terminal { last_sequence }`. Notices are hints; the durable event log
  (`generation.events` operation) is the canonical replay source.
- `headless::HeadlessAdapter` — in-process adapter; `dispatch(request_id, operation_id, request, cancel)`
  pass-through (correlation ids are the caller's concern) + `meta_bytes()`.
- `local::LocalConnection` — local in-process connection facade
  (ТЗ §11.1: no HTTP/port); `call(operation_id, request, cancel)` pass-through.
- `generation` — Phase 6 durable generation workflows: state machine
  (`queued → preparing → streaming → completed | failed | cancelling →
cancelled`, plus `interrupted` via startup recovery), CAS transitions by
  `revision`, provider routing through the Phase 7 `ProviderRegistry`
  (deterministic built-in fake), per-step durable commits, atomic
  terminal commits (final message + terminal event in one transaction), lease
  fields and idempotent reconciliation commands (see the Phase 6/7 sections).

## Constraints

- **No platform imports**: no `std::net`, no OS-specific APIs, no `unsafe`.
- **No HTTP / server / UI**: transport is out of scope; only direct
  in-process calls exist.
- **Storage-backed product ops**: `meta.get` is stateless; the Phase 3/6
  product operations require a `data_root` (durable storage) and fail with
  `StorageFailure` otherwise.
- **Never panic on payloads**: request bytes are decoded via the generated
  checkers; all failures are `KernelError` results.
- **No `serde_json::Value` escapes the DTO boundary** (except inside
  tolerant/`Value`-typed envelope fields of the generated types).

## Phase 2

SQLite-backed storage ownership: `Kernel::open` with a `data_root` acquires
the exclusive data-root lease and opens the database through
`neotavern_storage`; `storage_diagnostics()` reports storage format, schema
revision and the bundled SQLite version.

## Phase 3 slice (product CRUD)

Implemented operations (all over the kernel's single writable connection):

- `characters.list` / `characters.get` / `characters.create` /
  `characters.update` / `characters.delete`
- `chats.list` / `chats.get` / `chats.messages.list`
- `lorebooks.list` / `presets.list`

`backups.*` stays `OperationNotFound` (Phase 11).

- **Seeding chats/messages/lorebooks/presets**: the frozen registry has no
  create wire operations for these tables, so integration tests seed them
  directly through `neotavern_storage` BEFORE opening the kernel (the kernel
  holds the single writable connection for its lifetime).
- **Error model**: `KernelError` carries diagnostic `params` and, for
  product-level failures, `product: Option<Box<ProductErrorDto>>` — the wire
  `wire.error.dto` payload (stable codes like `CHARACTER_NOT_FOUND` with
  camelCase `characterId` params). The host glue copies `product` into the
  response envelope verbatim. Kernel-level codes map `*_NOT_FOUND` to
  `NotFound`, everything else to `Conflict`.
- **Pagination cursors** are opaque base64url (no padding) of
  `"{createdAt}|{id}"` for characters/chats and `"{sequence}|{id}"` for
  messages; pages order by `created_at DESC, id DESC` / `sequence ASC, id ASC`
  with a keyset predicate on the cursor. `nextCursor` appears only when a full
  page was returned (default limit 50, clamped to `1..=200`).

## Phase 6 slice (generation durability)

Generation is a recoverable workflow (§62–§64) executed by the single
writer-coordinator thread:

- **Writer-coordinator thread**: `Kernel::open` moves the `Database` into a
  dedicated thread; every operation (CRUD, generation steps, cancel, shutdown)
  is a command on its queue. While a generation streams, pending unary commands
  are drained between provider steps, so reads and `generation.cancel` stay
  live during long runs.
- **Operations**: `generation.start` / `generation.retry` (streaming),
  `generation.cancel`, `generation.get` (durable run snapshot
  `wire.generation.run`), `generation.events` (paged durable event log
  `wire.paged.generation-events`), `generation.keep` / `generation.discard`
  (idempotent post-terminal reconciliation commands, ТЗ §63).
- **State machine**: transitions are compare-and-set on `revision`; terminal
  states (`completed` / `failed` / `cancelled`) are immutable; `interrupted`
  marks a run whose executor died. Cancel sets a durable `cancel_requested`
  flag + executor flag; the executor commits `cancelled` and never commits
  late provider output after cancellation.
- **Fake provider** (deterministic, fault-injectable): `model` grammar
  `steps=N;fail-at=N;delay-ms=N;tokens-per-step=N`; delta text derived from
  `sha256(run_key|i)` with `run_key = "{chat_id}|{attempt}"` — same inputs
  give byte-identical event logs across processes, which the Local/Remote
  equivalence tests rely on. Since Phase 7 the fake lives as a portable
  adapter in `built-in-providers` (`FakeProvider`) and is registered by the
  kernel's `ProviderRegistry`; behavior is byte-identical to the Phase 6
  inline provider. Unknown provider → `PROVIDER_UNAVAILABLE`; bad grammar →
  `PROVIDER_MODEL_INVALID`; injected failure → `PROVIDER_STEP_FAILED`.
- **Durability**: every delta/checkpoint/terminal event is appended to
  `generation_events` in the same transaction that advances the run's
  `last_event_sequence` (CAS), refreshes the executor lease (`lease_owner`,
  `lease_expires_at = now + 30 s`) and bumps `revision`. The terminal commit
  inserts the final assistant `messages` row, flips the run status and appends
  the terminal event atomically — no duplicate final message is possible.
- **Recovery**: on open, runs still non-terminal with an expired (or absent)
  lease are marked `interrupted`; the exclusive data-root lease guarantees no
  live executor elsewhere. `generation.retry` then starts a new attempt linked
  via `source_run_id`; `generation.keep` promotes the partial text to a
  message; `generation.discard` purges the event log. All three are idempotent.
- **No duplicate writer**: exactly one kernel instance per data root (lease);
  a second `Kernel::open` on the same root fails with `DataRootInUse` before
  any generation state can fork.

## Phase 7 slice (portable providers)

Generation execution now routes through portable provider adapters
(`provider-sdk`) instead of the Phase 6 inline fake. The kernel registers
the built-in adapters (`built-in-providers`) and hands each run to the
adapter resolved from the run's `provider` field (default `fake`).

- **`providers::ProviderRegistry`** — stable-order adapter list:
  `new_builtins()` registers `FakeProvider` (id `fake`, model `fake-1`);
  `register(Arc<dyn ProviderAdapter>)` appends host adapters;
  `find(id)` resolves one for generation execution; `list()` returns all in
  registration order. The registry lives in the writer thread state next to
  the `Database`.
- **`providers.list` operation** — stateless (like `meta.get`): no `data_root`
  required, so a stateless kernel answers it. Strict empty request; the
  response is `wire.result.list-providers` with one `ProviderDto` per
  registered adapter (id, name, builtin, availability, models), validated
  through `validate_result_list_providers` before serialization. Adapter
  `Availability` maps onto the generated `ProviderAvailability` enum.
- **`Kernel::set_secret_resolver(Arc<dyn SecretResolver>)`** — host-provided
  secret-resolution seam (ТЗ §68): the kernel stores only the handle, never
  resolved values, and passes it to the generation executor for adapters
  that need secrets (the built-in fake/recorded providers ignore it). The
  command is ack'd fire-and-forget (5s rendezvous timeout; a timed-out ack
  is ignored and the setting still lands at the next step boundary).
- **`Kernel::set_run_timeout(Duration)`** — per-run provider deadline for
  future generations; default `RUN_TIMEOUT` = 60s. The executor builds
  `ProviderRequest { deadline: Some(Deadline::after(run_timeout)) }`, and
  the adapter must finish the attempt within the window (a late attempt
  fails with `PROVIDER_TIMEOUT`).
- **Executor emit bridge** — adapter deltas stream through a bridge that,
  per delta: drains queued commands (shutdown → commit progress and stop),
  re-reads the durable run (a `cancelling`/`cancel_requested`/terminal run
  stops — late output never reaches the chat, §63), then commits the delta
  (checkpoint every 4th, lease refresh, CAS on `revision`). `EmitStatus::Stop`
  tells the adapter to stop producing immediately; the kernel's dispatch
  `CancellationFlag` is exposed to the adapter as a `CancelToken`.
- **Provider error mapping** (kernel `ErrorDto` codes in `generation.failed`):

  | Provider SDK error | Wire code                                   | Params                         |
  | ------------------ | ------------------------------------------- | ------------------------------ |
  | `StepFailed`       | `PROVIDER_STEP_FAILED`                      | `runId`, `step` (when present) |
  | `Timeout`          | `PROVIDER_TIMEOUT`                          | `runId`                        |
  | `NetworkFault`     | `PROVIDER_NETWORK_FAULT`                    | `runId`                        |
  | `Unavailable`      | `PROVIDER_UNAVAILABLE`                      | `provider`                     |
  | `RequestInvalid`   | `PROVIDER_MODEL_INVALID`                    | `model`                        |
  | `Cancelled`        | cancelled terminal (`generation.cancelled`) | —                              |

  An unknown `provider` field (no registered adapter) fails the run with
  `PROVIDER_UNAVAILABLE` — unchanged product behavior. Secret values never
  appear in request snapshots, event payloads, error payloads or `Debug`
  output (`SecretValue` prints `<redacted>`).
