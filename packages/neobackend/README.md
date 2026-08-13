# @neotavern/neobackend

UI facade over the NeoTavern product wire API (ТЗ §15). The `NeoBackend`
interface is the single surface the UI talks to; it is typed exclusively with
the canonical wire DTOs from `@neotavern/contracts` and never leaks transport
details.

## Implementations

| Backend         | Transport                                                        | When                                                 |
| --------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `LocalBackend`  | Same-process kernel adapter (`LocalTransport`) — no HTTP/sockets | Desktop/local-first runtime (ТЗ §15.1)               |
| `RemoteBackend` | `@neotavern/client-sdk` over a remote wire endpoint              | Web/remote runtime (ТЗ §57)                          |
| `LegacyBackend` | `fetch` against the legacy `/api/v2` server                      | Temporary bridge for unmigrated features (ТЗ Фаза 0) |

## Public API

- `NeoBackend` — `meta()` plus domain groups: `characters`, `chats`,
  `lorebooks`, `presets`, `generation` (streaming), `backups`.
- `CharactersApi`, `ChatsApi`, `GenerationApi`, `BackupsApi`, `LorebooksApi`,
  `PresetsApi` — operation contracts per group.
- `LocalBackend({ transport, expectedSchemaHash? })` — validates every
  outbound request against the registry `requestSchemaId` before the transport
  call (`ValidationError`, never a transport call), and every response/event
  against its schema (`ContractViolationError`). Construction compares the
  expected wire schema hash to `WIRE_SCHEMA_HASH`
  (`ContractMismatchError` on mismatch).
- `RemoteBackend({ sdk })` — delegates to `ClientSdk`; `meta()` = handshake.
- `LegacyBackend({ baseUrl, fetchImpl?, transport? })` — implements `meta()`,
  `characters.list`, `characters.get`; legacy error envelopes
  `{code, params, traceId}` map to `ProductError`; everything else throws
  `UnsupportedError` (`{code: 'UNSUPPORTED', feature}`). When the host
  supplies a `LegacyTransport` (the web app does — same-origin fetch, CSRF,
  multipart upload, SSE URLs), `LegacyBackend.raw` exposes a temporary
  `request`/`upload`/`sseUrl` passthrough for unmigrated `/api/v2` routes.
  Without a transport, `raw` throws `UnsupportedError`.
- Errors: `ContractMismatchError`, `ValidationError`, `ContractViolationError`,
  `UnsupportedError`.

## Commands

```bash
pnpm --filter @neotavern/neobackend build
pnpm --filter @neotavern/neobackend typecheck
pnpm --filter @neotavern/neobackend clean
```

## Constraints

- `LocalBackend` must never open sockets or use localhost/HTTP (ТЗ §15.1) —
  keep product rules out of the facade.
- Wire DTOs come from `@neotavern/contracts`; never redefine them here
  (AGENTS.md §5).
- `LegacyBackend` is temporary: new features must be added to the wire surface
  and the appropriate real backend, not to the legacy adapter.
