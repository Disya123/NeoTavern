# @neotavern/client-sdk

Remote-access SDK (ТЗ §57): typed calls, event streaming and protocol
handshake over the product wire contract. The wire schemas, registry and
envelope formats come from `@neotavern/contracts` (single source of truth);
this package adds the client transport and operation semantics on top.

## Public API

- `HttpTransport` — HTTP transport for the wire endpoints:
  `POST {base}/rpc` (RequestEnvelope → ResponseEnvelope),
  `POST {base}/rpc/stream` (SSE `text/event-stream` EventEnvelope frames;
  NDJSON is still accepted when a stub returns a non-SSE content type),
  `GET {base}/meta`. Optional `authorization` (pairing bearer). `fetchImpl`
  is injectable for tests.
- `ClientSdk` — `handshake()`, typed `call()`, `stream()`:
  - registry lookup against `buildProductWireRegistry()`;
  - outbound payload validation + `requestLimitBytes` size check _before_
    any transport request;
  - response/event payload validation against the operation schemas;
  - retry per `retryPolicy`, idempotent operations only (up to 2 retries);
  - `OutcomeUnknownError` on non-idempotent timeout (ТЗ §15.2) and on
    idempotent timeout after retries are exhausted.
- Errors — `ProductError` (wraps `ProductErrorDto`), `TransportError`
  (`retryable`/`timeout`/`resumable` flags), `OutcomeUnknownError`.
- Types — `Transport`, `CallOptions`, `StreamOptions`, `CallResult`,
  `StreamEvent`, plus wire types `MetaDto`, `ProductErrorDto`,
  `RequestEnvelope`, `ResponseEnvelope`, `EventEnvelope`.

## Commands

```bash
pnpm --filter @neotavern/client-sdk build       # tsc -b
pnpm --filter @neotavern/client-sdk typecheck   # tsc -b
pnpm exec vitest run packages/client-sdk        # tests (stub fetch, no server)
```

## Constraints

- Depends only on `@neotavern/contracts` and `@sinclair/typebox` (Value
  validation). No server code, no product rules (validation only, ТЗ §15.1).
- The wire endpoints (`/rpc`, `/rpc/stream`, `/meta`) are served by
  Headless and Desktop Remote Access (`remote-http`). `RemoteBackend`
  speaks them through this SDK.
- Streams never fabricate terminal events; a stream that dies mid-way
  fails with a resumable `TransportError` (sequence-based recovery is a
  kernel-side feature).
