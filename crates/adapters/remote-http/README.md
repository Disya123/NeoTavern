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
| `trusted_proxy` | `false` | Gates insecure binds. When `false`, a non-loopback `bind_addr` is rejected at `start()` with `AdapterError::InsecureBind` *before* any bind happens. With `true` but **no `auth`** a public bind is still a startup error (`AdapterError::PublicBindRequiresAuth`, §10: "Публичное включение listener без настроенных auth и transport security является startup error"). |
| `auth` | `None` | Pairing store. `Some(AuthConfig { max_credentials })` gates `/rpc` and `/rpc/stream` behind `Authorization: Bearer <token>`; `/meta` stays public. `None` (loopback only) skips the gate. |
| `rate_limit` | `None` | Token-bucket limiter. `Some(RateLimitConfig { requests_per_second, burst, max_clients })` — buckets keyed by credential id (authed) or client IP (unauthed, see `trusted_proxies`); over-burst → `429 RATE_LIMITED` + `Retry-After`. Bucket map bounded at `max_clients` (LRU-ish eviction). |
| `trusted_proxies` | `[]` | Reverse proxies trusted to append `X-Forwarded-For` (§10: "forwarded client/proto headers принимаются только от configured proxy addresses"). Empty (default) = forwarded headers ignored entirely; rate limiting keys by the peer socket IP. When the peer is in this list, the client IP is taken from the `X-Forwarded-For` chain (rightmost entry not appended by a trusted proxy; unparsable entries skipped; missing/unusable header falls back to the peer). Forwarded headers from any other peer are never honored — a client cannot self-spoof the bucket key. |
| `max_streams` | `8` | Concurrent long-lived SSE streams. Over the cap → `429 RATE_LIMITED` (`rule: stream_limit`). |
| `audit_capacity` | `256` | Bounded FIFO audit ring (`AuditKind` + detail, no token material). |
| `allowed_origins` | `[]` | CORS/Origin allowlist (exact-match, case-sensitive). Empty (default) is deny-by-default: any request carrying an `Origin` header is rejected 403 `ORIGIN_NOT_ALLOWED` before dispatch; no `Access-Control-*` header is ever emitted. Non-browser clients (no `Origin` header) are unaffected. |
| `max_request_bytes` | `1048576` (1 MiB) | Request body cap. Over-limit → `413 QUOTA_EXCEEDED` (`rule: request_too_large`), enforced for Content-Length and chunked bodies. |
| `max_connections` | `64` | Worker pool size serving the single `tiny_http` listener. |
| `drain_timeout` | `5s` | Grace period of `shutdown()` for in-flight requests; on timeout the remaining workers are abandoned. |

## Security defaults

- **Loopback-only by default.** `127.0.0.1:0` binds nothing but the local
  machine. Non-loopback binds fail at startup unless `trusted_proxy: true`
  **and** `auth` is configured — a public listener without configured auth
  and transport security is a startup error (§10).
- **Forwarded headers only from configured proxies.** `X-Forwarded-For` is
  honored solely when the immediate peer is listed in `trusted_proxies`;
  from any other peer the header is ignored, so a client cannot rotate the
  header to escape its rate-limit bucket (§10). The client IP for keying is
  the rightmost chain entry not appended by a trusted proxy (multi-hop
  proxies append one entry each); garbage entries are skipped and a
  missing/unusable header falls back to the peer IP.
- **Pairing issues revocable scoped credentials**, not a master token:
  `RemoteAdapter::pair(label)` returns `(id, token)`; the store keeps only a
  SHA-256 verifier, credentials can be revoked individually
  (`RemoteAdapter::revoke(id)`, idempotent) and `pair()` fails with
  `AuthError::LimitReached` at `max_credentials`. Live streams re-check the
  credential before every SSE frame batch and abort with a `credential_revoked`
  error frame when it dies mid-stream.
- **401 before body read.** The auth gate runs before the request body is
  read: an unauthenticated request gets `401 UNAUTHORIZED`
  (`missing_credential` / `invalid_credential`) with `WWW-Authenticate:
  Bearer` even when its body would exceed `max_request_bytes` (§10).
- **429 for rate limits.** `RATE_LIMITED` (with `Retry-After: 1`) for
  over-burst requests and for exceeding `max_streams` concurrent streams
  (`rule: stream_limit`).
- **Bounded audit, no secrets.** Every gate decision is recorded
  (`AuthGranted`, `AuthDenied`, `RateLimited`, `StreamLimitReached`,
  `OriginDenied`) into a bounded FIFO ring
  (`RemoteAdapter::audit_events()`); raw tokens and payloads never enter the
  audit.
- **CORS deny-by-default.** A browser cross-origin request (one carrying an
  `Origin` header) is admitted only when the origin exactly matches an entry
  of `allowed_origins`; anything else is rejected 403 `ORIGIN_NOT_ALLOWED`
  before any body read or dispatch, and `Access-Control-*` headers are never
  emitted for disallowed origins. With the allowlist configured, an `OPTIONS`
  preflight from an allowed origin answers 204 with
  `Access-Control-Allow-Origin` / `-Methods` / `-Headers` + `Vary: Origin`,
  and every actual response carries `Access-Control-Allow-Origin` (§10:
  browser auth защищён от CSRF). Non-browser clients send no `Origin` header
  and are unaffected.
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
transport failures (400/413/426), protocol gating, bind security (insecure
wildcard rejected; trusted-proxy-without-auth rejected; trusted proxy + auth
serves), graceful shutdown, shared-kernel multi-transport, single-writer
exclusivity (`DATA_ROOT_IN_USE`), SSE error framing, schema-hash tolerance,
envelope schema violations, route/method negatives, 200-body deterministic
fuzz, 16×16 concurrent create/read consistency, keep-alive and the 426 stream
gate — 24 scenarios. `tests/generation_stream.rs` adds the Phase 6 surface:
live SSE ordering + terminal frame + payload equivalence with the durable log,
`Last-Event-ID` resume (union == full log, no gaps/dups), slow-consumer
completion, unary generation ops over `/rpc`, and the protocol gate blocking
streaming before dispatch — 5 scenarios. `tests/hardening.rs` (Phase 4
hardening / Phase 9) covers the auth gate (401 before body read, `/meta` open,
revoke blocks new calls, bounded pairing), rate limiting (429 + `Retry-After`
after the burst), the concurrent-stream cap (429 `stream_limit` while a live
stream holds the slot), SSE credential re-check (mid-stream revocation
terminates the stream with `credential_revoked` before the terminal event),
CORS deny-by-default (403 `ORIGIN_NOT_ALLOWED` without an allowlist; preflight
204 + `Access-Control-*` headers only for explicitly allowed origins),
forwarded-header trust (`X-Forwarded-For` keys the rate-limit bucket only
when the peer is a configured trusted proxy; an untrusted peer cannot rotate
the header past the peer's bucket; garbage values fall back safely) and
audit events without token material — 11 scenarios. All assertions go through
the generated envelope decoders and DTO validators.
