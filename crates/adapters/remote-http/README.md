# remote-http-adapter

Phase 4 Remote Access Adapter (ТЗ §10): maps HTTP(S)/SSE traffic onto the
SAME `runtime_kernel::Kernel` instance the local hosts use.

## Purpose

- **Transport-only.** The adapter decodes the `wire.request.envelope` JSON,
  runs the wire protocol check, and dispatches the operation payload to the
  kernel. It answers with `wire.response.envelope` JSON.
- **No ownership.** The adapter never opens SQLite and never takes a
  data-root lease — the kernel is the single writable owner (ТЗ §22). The
  adapter does not own product rules; all validation lives in the generated
  wire contract and the kernel.
- **No platform branching.** One code path for every host; loopback-only by
  default.
- **One kernel, many transports.** Any number of adapters may share an
  `Arc<Mutex<Kernel>>`; the mutex is the single-writer coordinator (see the
  integration test `two_adapters_share_one_kernel`).

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `bind_addr` | `127.0.0.1:0` (loopback, ephemeral) | Address the HTTP listener binds. Port `0` → OS-assigned; the real address is `RemoteAdapter::local_addr()`. |
| `trusted_proxy` | `false` | Gates insecure binds. When `false`, a non-loopback `bind_addr` is rejected at `start()` with `AdapterError::InsecureBind` *before* any bind happens. Set `true` only when a trusted proxy owns network exposure. |
| `max_request_bytes` | `1048576` (1 MiB) | Request body cap. Over-limit → `413 QUOTA_EXCEEDED` (`rule: request_too_large`), enforced for Content-Length and chunked bodies. |
| `max_connections` | `64` | Worker pool size serving the single `tiny_http` listener. |
| `drain_timeout` | `5s` | Grace period of `shutdown()` for in-flight requests; on timeout the remaining workers are abandoned. |

## Security defaults

- **Loopback-only by default.** `127.0.0.1:0` binds nothing but the local
  machine. Non-loopback binds fail at startup unless `trusted_proxy: true`.
- **413 for oversized bodies** — the body is never buffered past
  `max_request_bytes` (Content-Length pre-check and chunked read cap).
- **426 for protocol mismatches** — major inequality or minor-too-new
  requests are rejected with `PROTOCOL_MISMATCH` *before* dispatch, so a
  mismatched client can never execute a product write (§6.5).
- **400 for undecodable request bodies**, 404 for unknown routes, 405 for
  wrong methods — transport failures carry no request id.
- **No panics on wire data.** Every payload-driven failure maps to a
  controlled `EnvelopeFailure` / error envelope; `unwrap`/`expect` appear
  only on program-internal invariants.

## Routes

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/meta` | `200` + JSON `wire.meta.dto`, with `X-Neota-Schema-Hash` and `X-Neota-Protocol` diagnostic headers. |
| `POST` | `/rpc` | Envelope dispatch. Once the envelope parses and the protocol check passes, always answers `200` with an ok/error response envelope. |
| `POST` | `/rpc/stream` | Envelope dispatch for streaming operations; answers `text/event-stream` (error frame + `stream.closed` terminal frame in Phase 4). |
| any | anything else | `404 NOT_FOUND`; wrong method on a known route → `405 VALIDATION`. |

## Envelope semantics

- `POST /rpc` body is a `wire.request.envelope` JSON. HTTP status is reserved
  for transport-level failures that happen before a usable envelope exists
  (`400` / `413` / `426` / `404` / `405`).
- After the envelope parses and passes `check_protocol`, the adapter ALWAYS
  answers `HTTP 200` with a `wire.response.envelope` — `kind: ok` or
  `kind: error` — echoing the `requestId`. Kernel dispatch errors map to the
  canonical wire codes (`CONTRACT_VIOLATION`, `NOT_FOUND`, `UNAUTHORIZED`,
  `CANCELLED`, `DATA_ROOT_IN_USE`, `INTERNAL`, `CONFLICT`); product DTOs
  (`err.product`) are copied verbatim.
- Remote clients are **not** required to match the embedded `schemaHash`
  (§6.5): the hash is accepted as-is and dispatch proceeds.

## Streaming (Phase 6)

`POST /rpc/stream` serves live SSE for the two streaming operations
(`generation.start`, `generation.retry`): the adapter opens
`Kernel::dispatch_stream`, then loops `EventStream::next_notice(250 ms)` →
`generation.events` page (≤200 items) → one `sse::encode_envelope_frame` per
committed event, finishing with `encode_terminal_frame(stream_id, last+1,
"stream.closed", {})`. Frames are written over a manually framed chunked
response (`Request::into_writer`) and flushed per batch, because tiny_http
0.12 buffers `respond()` bodies entirely and would otherwise deliver the whole
stream at once. A client disconnect drops the stream; the kernel executor is
durable and unaffected.

Resume/reconnect: `POST /rpc/stream` with `generation.events` replays the
durable log from the `Last-Event-ID` header (or the request's `afterSequence`)
and polls until the terminal event. Delivery is at-least-once over committed
rows only — nothing is served before its transaction lands (§64). Every other
operation keeps the Phase 4 behavior: an `event: error` frame plus the
`stream.closed` terminal frame (`operation_not_streamable`).

## Tests

```sh
cargo test -p remote-http-adapter
```

The integration suites drive a real `runtime_kernel::Kernel` over a tempfile
data root through a std-only raw-TCP HTTP client. `tests/remote_http.rs`
covers meta/version reporting, character CRUD round-trips, paging cursors,
transport failures (400/413/426), protocol gating, bind security, graceful
shutdown, shared-kernel multi-transport, single-writer exclusivity
(`DATA_ROOT_IN_USE`), SSE error framing, schema-hash tolerance, envelope
schema violations, route/method negatives, 200-body deterministic fuzz,
16×16 concurrent create/read consistency, keep-alive and the 426 stream gate —
24 scenarios. `tests/generation_stream.rs` adds the Phase 6 surface: live SSE
ordering + terminal frame + payload equivalence with the durable log,
`Last-Event-ID` resume (union == full log, no gaps/dups), slow-consumer
completion, unary generation ops over `/rpc`, and the protocol gate blocking
streaming before dispatch — 5 scenarios. All assertions go through the
generated envelope decoders and DTO validators.
