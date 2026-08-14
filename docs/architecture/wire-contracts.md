# Product Wire Contracts (ТЗ §6)

> **Status.** The wire layer described here is the **Phase 0 target**. Source
> files under `packages/contracts/src/wire/` and the codegen tool
> (`tools/contract-codegen/`) are created during Phase 0; anything not yet
> present in the repo is marked **[PLANNED]**. The current HTTP surface they
> will eventually back is inventoried in
> [operations-inventory.md](operations-inventory.md).

Related documents: [Operations inventory](operations-inventory.md),
[Version axes](version-axes.md),
[ADR-0029](../adr/0029-wire-contract-toolchain.md),
[ADR-0004](../adr/0004-typebox-contracts.md).

## 1. Principle: one hand-authored source of truth

The product wire contract is **single-sourced** in TypeScript:

- **Hand-authored:** `packages/contracts/src/wire/` — TypeBox schemas plus the
  operation registry. This is the only place a contract is written by humans.
- **Derived:** TypeScript types are inferred from the TypeBox schemas
  (`Static<T>`), the JSON Schema bundle and manifest are emitted
  deterministically by `tools/contract-codegen/codegen.mjs`, and the Rust
  boundary DTOs/validators in `crates/contracts-generated/src/generated.rs`
  are generated from the same bundle and **committed**.
- The existing `packages/contracts/src/*.ts` schemas (ADR-0004, route schemas)
  remain the source of truth for the current `/api/v2` HTTP surface; the wire
  layer is the cross-language product contract for the Runtime Kernel
  (ТЗ §7).

### Source layout (all [PLANNED], Phase 0)

| File                                      | Contents                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/wire/dto.ts`      | Canonical DTO schemas with `$id` (`wire.meta.dto`, `wire.character.dto`, `wire.chat.dto`, `wire.message.dto`, `wire.backup.dto`, `wire.lorebook.dto`, `wire.preset.dto`, paged DTOs, `wire.generation.event`, `wire.error.dto`, request/result DTOs) + `WIRE_SCHEMAS: Record<string, TSchema>` |
| `packages/contracts/src/wire/formats.ts`  | Shared format registry (`uuid`, `rfc3339`, `decimal-string`) + `WIRE_FORMAT_PATTERNS`                                                                                                                                                                                                          |
| `packages/contracts/src/wire/rules.ts`    | Wire-safe subset enforcement (`checkWireSchema`)                                                                                                                                                                                                                                               |
| `packages/contracts/src/wire/errors.ts`   | `WIRE_ERROR_CODES`, `ContractViolation`, `ContractCompileError`                                                                                                                                                                                                                                |
| `packages/contracts/src/wire/envelope.ts` | `WIRE_PROTOCOL`, request/response/event envelope schemas, `SCHEMA_DIALECT`, `FFI_ABI_VERSION`, `GENERATOR_VERSION`                                                                                                                                                                             |
| `packages/contracts/src/wire/registry.ts` | `WireOperation`, `WireFixture`, `compileWireContract`, `buildProductWireRegistry()`                                                                                                                                                                                                            |
| `packages/contracts/src/wire/index.ts`    | Re-exports everything; calls `registerWireFormats()`                                                                                                                                                                                                                                           |

All schemas are strict objects (`additionalProperties: false`), optional fields
use `Type.Optional`, timestamps use `format: 'rfc3339'`, IDs use
`format: 'uuid'`, and every DTO carries a `$id` (schemaId).

## 2. Envelopes

Envelope `$id`s and shape ([PLANNED], `wire/envelope.ts`):

- `wire.request.envelope`:
  `{ wireProtocol: { major ≥1, minor ≥0 }, schemaHash: <64 hex>, requestId: uuid, operationId: string 1..128, payload: {…} }`
  — `payload` is tolerant by design (`additionalProperties: true`).
- `wire.response.envelope` — tagged union on `kind`:
  - `{ kind: "ok", requestId: uuid, result: {…} }` (tolerant `result`);
  - `{ kind: "error", requestId: uuid, error: ProductErrorDto }`.
- `wire.event.envelope`:
  `{ streamId: uuid, sequence: int ≥0, type: string 1..128, payload: {…} }`
  (tolerant `payload`).

Protocol constants: `WIRE_PROTOCOL = { major: 1, minor: 0 }`,
`SCHEMA_DIALECT = 'JSON Schema 2020-12'`, `FFI_ABI_VERSION = 1`,
`GENERATOR_VERSION = '1.0.0'`.

## 3. Wire-safe type rules (§6.6)

`checkWireSchema(schema, schemaId)` in `wire/rules.ts` walks a serialized JSON
Schema and reports `WireViolation { schemaId, path, rule }[]`. The wire subset
**fails on unsupported constructs** — there is no silent fallback:

| Rule                                                  | Rejected construct                                                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported-construct`                               | `oneOf`, `allOf`, `not`, `if`/`then`/`else`, `$ref`/`$dynamicRef`, `patternProperties`, `dependentSchemas`, `unevaluatedProperties`, `prefixItems`, `contains`, nodes with none of `type | anyOf      | const | $id`, `Type.Unsafe` |
| `ambiguous-union` / `missing-x-wire-unknown-behavior` | `anyOf` that is not a closed string enum and lacks `x-wire-discriminator`; closed string enums without `x-wire-unknown-behavior: 'reject'`                                               |
| `unsafe-type`                                         | `type: 'any'                                                                                                                                                                             | 'unknown'` |
| `implicit-default`                                    | any `default` key (JSON Schema `default` never applies on the wire)                                                                                                                      |
| `unregistered-format`                                 | `format` outside the shared registry (`uuid`, `rfc3339`, `decimal-string`)                                                                                                               |
| `pattern-not-portable`                                | lookahead `(?=`, negative lookahead `(?!`, lookbehind `(?<=`/`(?<!`, backrefs `\1`–`\9`, unicode properties `\p{` (JS/Rust regex dialect mismatch)                                       |
| `unsupported-numeric-constraint`                      | `multipleOf`, `exclusiveMinimum`, `exclusiveMaximum` on integer/number                                                                                                                   |
| `unsafe-integer-range`                                | `minimum`/`maximum` outside ±9007199254740991                                                                                                                                            |
| `use-anyof-literals`                                  | raw `enum` (TypeBox emits `anyOf` of consts; raw `enum` is not accepted in v1)                                                                                                           |

Object rules: `additionalProperties` must be boolean or a primitive schema
node; `required` must name keys of `properties`. Array rules: single `items`
schema only (no tuples). `$id` refs are not followed (no `$ref` in v1).

**String semantics shared with Rust:** length is counted in **UTF-16 code
units** (JS `.length`; Rust checks `s.encode_utf16().count()`), and the format
patterns are byte-identical between TS and Rust (`WIRE_FORMAT_PATTERNS` →
precompiled static regexes, fail-closed on malformed patterns).

**Discriminated unions:** tagged unions carry `x-wire-discriminator`
(e.g. `type` for `wire.generation.event`, `kind` for the response envelope);
closed string enums (e.g. `MessageRole`, `BackupDto.status`) carry
`x-wire-unknown-behavior: 'reject'` so an unknown literal is a validation
failure, never a silent pass-through.

## 4. Validation and failure behavior

The pipeline is **parse → validate → DTO → domain**, with controlled errors at
every stage and **no panic** on external payloads:

1. **Parse** — JSON bytes → `serde_json::Value` (Rust) / parsed object (TS).
   Malformed JSON is a controlled error.
2. **Validate** — structural walk against the generated checker
   (`validate_<schema>` in Rust; `Value.Check` in TS). Failures produce
   `Issue { path, rule }` lists, never exceptions across the boundary.
3. **DTO** — decode into the typed generated struct
   (`decode_<schema>`, strict: unknown fields are rejected at the serde level
   via `#[serde(deny_unknown_fields)]`; tolerant objects decode to
   `serde_json::Value` payloads).
4. **Domain** — the kernel operates on typed DTOs; responses are validated
   again before serialization.

Error model (`wire/errors.ts`, [PLANNED]):

- `WIRE_ERROR_CODES` — `INTERNAL`, `VALIDATION`, `CONTRACT_VIOLATION`,
  `NOT_FOUND`, `CONFLICT`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`,
  `OUTCOME_UNKNOWN`, `DATA_ROOT_IN_USE`, `UNSUPPORTED_SCHEMA`,
  `RECOVERY_REQUIRED`, `CANCELLED`, `PROVIDER_ERROR`, `QUOTA_EXCEEDED`.
- `ContractViolation` — structured contract failures
  (`{ code: "contract_violation", operationId?, direction:
'request'|'response'|'event', contractMajor, correlationId, issues:
[{ path, rule }] }`).
- Rust `WireError { kind: Parse | Violation | Internal, message, issues }`:
  `decode<T>` maps parse errors → `WireError::parse`, check failures →
  `WireError::violation`, and a failed typed decode after a successful check →
  `WireError::internal` (a generated-code bug, surfaced as an error, never a
  panic). The kernel dispatcher converts any `WireError` from request decoding
  into `KernelError::ContractViolation`.
- `ContractCompileError` (TS) — aggregates every `checkWireSchema` and
  registry-validation violation at compile time; the registry refuses to build
  with any violation.

## 5. Operation registry

`WireOperation` metadata ([PLANNED], `wire/registry.ts`):

```ts
interface WireOperation {
  operationId: string;
  feature: string;
  version: string;
  executionClass: 'transactional' | 'workflow' | 'maintenance' | 'host-service';
  idempotency: 'idempotent' | 'non-idempotent';
  retryPolicy: 'none' | 'safe' | 'safe-with-idempotency-key';
  authScope: string; // 'none' | 'app.read' | 'app.write' | …
  requestSchemaId: string;
  responseSchemaId?: string;
  eventSchemaId?: string;
  allowedErrorCodes: string[]; // subset of WIRE_ERROR_CODES
  requestLimitBytes: number;
  responseLimitBytes: number;
  eventLimitBytes?: number;
  unknownFields: 'strict' | 'tolerant';
}
```

`compileWireContract(input, schemas)` fails with `ContractCompileError` on:
duplicate/empty/`[a-z][a-z0-9.]{1,127}`-violating `operationId`; dangling
schema references; any referenced schema failing `checkWireSchema`; duplicate
`$id`; workflow/maintenance ops without an event or response schema; streaming
ops (eventSchemaId) carrying a response schema; empty/unknown
`allowedErrorCodes`; non-positive or over-limit sizes
(request ≤ 1 MiB, response ≤ 16 MiB, event ≤ 1 MiB); invalid fixtures.

### Phase 0 registry (`buildProductWireRegistry()`)

21 operations, all `feature: 'core'`, `version: '1.0'`,
`unknownFields: 'strict'`:

| operationId           | class         | idempotency    | retry | auth      | reqB   | respB  | eventB |
| --------------------- | ------------- | -------------- | ----- | --------- | ------ | ------ | ------ |
| `meta.get`            | transactional | idempotent     | safe  | none      | 1024   | 16384  | –      |
| `characters.list`     | transactional | idempotent     | safe  | app.read  | 4096   | 262144 | –      |
| `characters.get`      | transactional | idempotent     | safe  | app.read  | 2048   | 262144 | –      |
| `characters.create`   | transactional | non-idempotent | none  | app.write | 65536  | 262144 | –      |
| `characters.update`   | transactional | non-idempotent | none  | app.write | 65536  | 262144 | –      |
| `characters.delete`   | transactional | non-idempotent | none  | app.write | 2048   | 1024   | –      |
| `chats.list`          | transactional | idempotent     | safe  | app.read  | 4096   | 262144 | –      |
| `chats.get`           | transactional | idempotent     | safe  | app.read  | 2048   | 262144 | –      |
| `chats.create`        | transactional | non-idempotent | none  | app.write | 4096   | 262144 | –      |
| `chats.update`        | transactional | non-idempotent | none  | app.write | 2048   | 262144 | –      |
| `chats.delete`        | transactional | non-idempotent | none  | app.write | 2048   | 1024   | –      |
| `chats.messages.list` | transactional | idempotent     | safe  | app.read  | 4096   | 262144 | –      |
| `chats.messages.create` | transactional | non-idempotent | none | app.write | 1048576 | 262144 | –    |
| `chats.messages.update` | transactional | non-idempotent | none | app.write | 1048576 | 262144 | –    |
| `chats.messages.delete` | transactional | non-idempotent | none | app.write | 2048   | 1024   | –      |
| `generation.start`    | workflow      | non-idempotent | none  | app.write | 131072 | –      | 65536  |
| `generation.cancel`   | transactional | idempotent     | safe  | app.write | 2048   | 1024   | –      |
| `generation.get`      | transactional | idempotent     | safe  | app.read  | 2048   | 65536  | –      |
| `generation.events`   | transactional | idempotent     | safe  | app.read  | 4096   | 262144 | –      |
| `generation.retry`    | workflow      | non-idempotent | none  | app.write | 2048   | –      | 65536  |
| `generation.keep`     | transactional | idempotent     | safe  | app.write | 2048   | 65536  | –      |
| `generation.discard`  | transactional | idempotent     | safe  | app.write | 2048   | 65536  | –      |
| `providers.list`      | transactional | idempotent     | safe  | app.read  | 1024   | 262144 | –      |
| `providers.config.set` | transactional | non-idempotent | none | app.write | 131072 | 262144 | –      |
| `providers.config.get` | transactional | idempotent    | safe  | app.read  | 2048   | 262144 | –      |
| `providers.config.list` | transactional | idempotent   | safe  | app.read  | 4096   | 262144 | –      |
| `providers.config.delete` | transactional | non-idempotent | none | app.write | 2048 | 1024 | –      |
| `backups.create`      | workflow      | non-idempotent | none  | app.write | 1024   | 262144 | –      |
| `backups.list`        | transactional | idempotent     | safe  | app.read  | 1024   | 262144 | –      |
| `lorebooks.list`      | transactional | idempotent     | safe  | app.read  | 1024   | 262144 | –      |
| `presets.list`        | transactional | idempotent     | safe  | app.read  | 1024   | 262144 | –      |

`generation.start` and `generation.retry` are the two streaming operations:
both emit `wire.generation.event` frames (`generation.delta`,
`generation.checkpoint`, `generation.completed`, `generation.failed`,
`generation.cancelled`, `consumer_lagged`) and carry no response schema.
`generation.get` returns the durable run snapshot (`wire.generation.run`),
`generation.events` pages the durable event log
(`wire.paged.generation-events` — `EventEnvelope` items with `streamId`,
monotonic `sequence`, tagged `payload`), and `generation.keep` /
`generation.discard` are the idempotent post-terminal reconciliation commands
over a partial artifact (ТЗ §63).

`providers.list` reports the registered provider adapters (ТЗ §55/§60):
`wire.result.list-providers` items carry id/name/builtin, the
`wire.provider.availability` union (`available` | `degraded{code,detail?}` |
`unavailable{code,detail?}`) and the model list — see
[Providers](providers.md).

`providers.config.*` manages stored provider instances (ТЗ §9.4, Этап 2.4).
`wire.provider.config.dto` carries the non-secret `config` object plus
`hasApiKey` — the secret value is never part of any DTO. `set` (upsert;
`apiKey` optional) stores the API key through the kernel's SecretStore seam
and the `provider_configs` row keeps only the opaque reference; a set
without `apiKey` updates `config` and leaves the stored secret untouched.
Without a wired SecretStore, `set` with `apiKey` fails with the stable
`SECRET_UNAVAILABLE` product error (fail-closed, no plaintext fallback);
read-only backends surface `SECRET_STORE_READ_ONLY`. `delete` removes the
row and revokes the stored secret (best-effort). `get`/`list` report only
`hasApiKey`; a missing config yields `PROVIDER_CONFIG_NOT_FOUND` with
`{provider, name}` params.

## 6. Handshake and negotiation (§6.5)

### Local: exact match

The Runtime Kernel opens **only** against the contract it was built with:

- `Kernel::open(config)` ([PLANNED], `crates/runtime-kernel`) requires
  `config.expected_schema_hash == contracts_generated::contract_schema_hash()`
  (read from the embedded `contract-manifest.json`) and
  `config.ffi_abi_version == 1`; any mismatch → `KernelError::ContractMismatch`.
- The request envelope's `wireProtocol` and `schemaHash` are validated per
  request; a mismatch is a `ContractViolation`, never a silent accept.

### Remote: major/minor negotiation

- `meta.get` returns `MetaDto` with `api: { major, minor }` and
  `productWire: { major, minor }` (plus optional `minimumClientVersion` and a
  `features` map).
- **Compatibility rule:** same **major** is required; **minor** is a capability
  level — a client may require the server's minor to be ≥ its own, and the
  server rejects unsupported minor requests at the envelope layer. Additive
  changes bump `minor`; breaking changes bump `major` (see §7).

### 6.1. HTTP transport mapping (Phase 4 Remote Adapter)

The Phase 4 adapter (`crates/adapters/remote-http`, ADR-0030) maps the frozen
envelopes onto HTTP/SSE without defining any DTO of its own (§6.3). Surface:

| Route         | Method | Purpose                                                                                                                                                                                                        |
| ------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/meta`       | GET    | Public handshake; returns the same `MetaDto` as `meta.get` (`api`, `productWire`, `minimumClientVersion`, `features`)                                                                                          |
| `/rpc`        | POST   | One request envelope in, one response envelope out (unary)                                                                                                                                                     |
| `/rpc/stream` | POST   | SSE: envelope validation + protocol check, then event frames for the streaming operations (`generation.start`, `generation.retry`) or durable-log resume (`generation.events`); terminal `stream.closed` frame |

**Envelope-over-HTTP rule:** once the request envelope parses and passes the
protocol check, the response is always HTTP 200 carrying a
`wire.response.envelope` (`kind: ok` | `kind: error`) — the product outcome
lives inside the envelope, never in the HTTP status. HTTP status codes are
reserved for transport-level failures that occur before a usable envelope:

| Status | Condition                                                    | Error code           | Params                             |
| ------ | ------------------------------------------------------------ | -------------------- | ---------------------------------- |
| 400    | JSON parse or envelope-schema violation                      | `CONTRACT_VIOLATION` | `issue.<i>.path`, `issue.<i>.rule` |
| 403    | Browser `Origin` not in the CORS allowlist (deny-by-default) | `ORIGIN_NOT_ALLOWED` | `rule: origin_not_allowed`         |
| 405    | Wrong method on a known path                                 | `VALIDATION`         | —                                  |
| 404    | Unknown route                                                | `NOT_FOUND`          | —                                  |
| 413    | Body over `max_request_bytes` (Content-Length or chunked)    | `QUOTA_EXCEEDED`     | —                                  |
| 426    | Protocol mismatch (§6.5 remote rule)                         | `PROTOCOL_MISMATCH`  | `client_major`, `server_major`     |

**Protocol gate ordering:** for `/rpc/stream` the 426 check runs **before**
any streaming classification — a mismatched client gets a JSON error envelope,
not an SSE stream, and can never execute product writes. Remote clients are
**not** required to match `schemaHash` (§6.5); only major equality + client
minor ≤ server minor matter.

**SSE framing** (`src/sse.rs`): spec-correct `event:` / `id:` / `data:` lines,
multi-line `data:` split, and a terminal frame; `Last-Event-ID` is parsed for
reconnect/resume. `/rpc/stream` delivers sequenced
`wire.event.envelope` frames (`streamId`, monotonic `sequence`, tagged
`payload`) for the two streaming operations (`generation.start`,
`generation.retry`), followed by a terminal `stream.closed` frame; every other
operation still answers with an error frame + terminal `stream.closed`
(`CONTRACT_VIOLATION` `operation_not_streamable`). Delivery is **at-least-once
over a durable log**: the kernel appends every event to `generation_events`
inside the same transaction that advances the run's `last_event_sequence`, so
the SSE loop is a replay of committed rows — a reconnect resumes from
`Last-Event-ID` (or an explicit `afterSequence`) and never loses or reorders
committed events (§64). Frames are flushed per batch over a manually written
chunked response, because tiny_http 0.12 buffers `respond()` bodies entirely.

**Writer coordination:** the adapter wraps the shared `Kernel` in
`Arc<Mutex<Kernel>>`, but the kernel itself is `Send + Sync` and runs its own
writer-coordinator thread (§22): SSE polling acquires the mutex only for the
short `generation.events` read, never across a wait. A poisoned mutex maps to
a controlled `INTERNAL` envelope, never a panic.

**CLI transport (Phase 4 CLI hooks, `crates/adapters/cli`):** the
`neotavern-cli` binary maps one request envelope → one response envelope
through the same kernel with the same envelope layer (decode → protocol
check → dispatch → validated response), so CLI and HTTP answers are
byte-identical (§6.3). `--operation <id> '<payload>'` builds the envelope
from the embedded manifest (protocol + hash + generated v4 request id);
`--envelope` reads a full request envelope JSON from stdin (bounded to
1 MiB) and echoes the request id verbatim. Exit codes are a stable contract:
`0` = ok envelope, `1` = error envelope or pre-envelope transport failure,
`2` = usage error. With `--root` the CLI holds the exclusive data-root lease
for its run; a held lease answers `DATA_ROOT_IN_USE` (§22). See
`crates/adapters/cli/README.md`.

**Security defaults** (§10, ADR-0030): default bind `127.0.0.1:0`;
`start()` rejects any non-loopback bind with `AdapterError::InsecureBind`
unless `trusted_proxy: true` explicitly declares a TLS-terminating reverse
proxy boundary — and with `trusted_proxy` but **no configured `auth`** a
public bind is still a startup error (`PublicBindRequiresAuth`); a public
listener without configured auth and transport security never starts (§10).
When `auth` is enabled, pairing issues revocable scoped credentials
(`RemoteAdapter::pair(label)` → `(id, token)`; the store keeps only a SHA-256
verifier; `revoke(id)` is idempotent; the store is bounded by
`max_credentials`), the auth gate runs **before** the body is read (401
`UNAUTHORIZED` with `WWW-Authenticate: Bearer` — `missing_credential` /
`invalid_credential`; `/meta` stays public), over-burst requests and
over-cap concurrent streams answer `429 RATE_LIMITED` with `Retry-After`
(token-bucket keyed by credential id or peer IP, bounded bucket map; `rule:
`stream_limit`for`max_streams`), SSE streams re-check the credential per
frame batch and abort mid-stream on revocation (`credential_revoked`), CORS/
Origin is deny-by-default (a request carrying an `Origin`header is admitted
only on an exact match against the configured`allowed_origins`allowlist —
otherwise 403`ORIGIN_NOT_ALLOWED`before any body read or dispatch; with the
allowlist configured, allowed-origin responses carry`Access-Control-Allow-Origin`+`Vary: Origin`and an`OPTIONS`preflight
answers 204 with`Access-Control-Allow-Methods`/`-Headers`), forwarded
client headers are honored only from configured proxy addresses (the
rate-limit bucket keys by the `X-Forwarded-For`client IP — rightmost chain
entry not appended by a trusted proxy — solely when the immediate peer is
listed in`trusted_proxies`; from any other peer the header is ignored, so a
client cannot self-spoof the bucket key), and every gate decision
lands in a bounded audit ring without token material.
Body size and connection/worker counts are bounded by config
(`max_request_bytes`, `max_connections`, `drain_timeout`).

## 7. Contract versioning (§6.7)

- **Additive change** (new optional field, new operation, widened allowed
  error set within the same major): safe — clients that validate strictly must
  tolerate it or gate on the advertised minor.
- **Breaking change** (field removal/rename, type change, tightened
  constraints, changed semantics): requires a new **major** wire version and a
  migration guide, mirroring the existing HTTP policy in
  `docs/api/README.md` ("New backward-compatible fields stay within `/api/v2`.
  Breaking changes mean a new major API version").
- **Semantic diff tool** (`tools/contract-codegen/diff.mjs`, ТЗ §6.7):
  compares two canonical bundles by `$id`/`operationId` and classifies every
  change as `breaking` or `additive` (removed field/operation, optional→required,
  type/format/const/discriminator change, closed-enum narrowing and range
  tightening are breaking; new optional fields, new operations, widened ranges
  and `x-wire-unknown-behavior: 'preserve'` enum additions are additive).
  Exit code 0 = compatible, 1 = breaking, 2 = usage error. The rule set is
  self-tested by `tools/contract-codegen/diff-test.mjs` in CI.
- **`schemaHash`** = `sha256(canonical(bundle))` over the full schema set. Any
  schema change — additive or breaking — changes the hash, so the local kernel
  and its embedded manifest can never silently disagree.

## 8. Deterministic codegen pipeline

`tools/contract-codegen/codegen.mjs` ([PLANNED], Phase 0) is wired into the
root `package.json` as `contracts:generate` and `contracts:check`:

- **Input:** the wire layer's schema map + operation registry (TS).
- **Canonical JSON:** recursive key-sorted objects, no whitespace, trailing
  `\n`; `schemaHash = sha256(canonical(bundle))` lowercase hex.
- **Outputs** (all committed):
  - `packages/contracts/generated/contract.bundle.json` —
    `{ wireProtocol, schemaDialect, schemas: [ {$id, …} ], operations: […] }`;
  - `packages/contracts/generated/contract-manifest.json` —
    `{ wireProtocol, schemaDialect, schemaHash, ffiAbiVersion, generatorVersion,
operations: { <operationId>: { …metadata } } }`;
  - `packages/contracts/generated/fixtures/<fixtureId>.json` — one canonical
    JSON file per fixture;
  - `packages/contracts/generated/fixtures/corpus.json` — the fixture index
    (`{ id, operationId, kind, schemaId, valid, file }` per entry);
  - `crates/contracts-generated/src/generated.rs` — Rust DTO structs, string
    enums, tagged unions, and `check_*` / `validate_*` / `decode_*` functions
    with a fixed naming scheme (`wire.meta.dto` → `MetaDto` +
    `check_meta_dto`; `wire.request.list-characters` →
    `RequestListCharacters`, …).
- **Determinism gates:** generated artifacts are committed, so `--check`
  regenerates and exits non-zero on any diff (`contracts:check`); the generated
  `.rs` header is `// @generated by tools/contract-codegen/codegen.mjs — DO NOT EDIT.`
- **Rust builds without Node:** `crates/contracts-generated` embeds the
  manifest at compile time (`include_str!` of
  `packages/contracts/generated/contract-manifest.json`) and contains no
  toolchain dependency.

## 9. Cross-language corpus tests (§6.8)

The fixture corpus is the executable contract shared by both validators:

- **Fixtures:** every operation has one valid request + one valid response
  fixture (the two streaming ops — `generation.start` and `generation.retry` —
  carry a valid event instead), plus 12 negative
  fixtures covering each rule family (missing field, wrong type, unknown
  discriminator, range, strict extra field, unknown enum literal, bad status,
  bad checksum, bad timestamp, bad envelope kind). Valid fixtures must pass and
  invalid ones must fail — enforced at registry compile time on the TS side
  (`Value.Check`) and re-asserted by both runtimes.
- **TS:** `packages/contracts/test/wire.test.ts` (vitest) asserts the registry
  builds, all schemas pass `checkWireSchema`, crafted registry inputs are
  rejected, and every fixture validates to its declared verdict; JSON
  round-trip stability (`JSON.parse(JSON.stringify(x))` deep-equals).
- **Rust:** `crates/contracts-generated/tests/wire_corpus.rs` loads
  `corpus.json` + fixture files at runtime, dispatches per `schemaId` to the
  generated `decode_<snake>` functions, asserts `is_ok() == valid`, verifies
  decode → re-serialize → decode round-trips, and runs a no-panic fuzz pass
  (xorshift32 LCG over 512 byte-strings, `catch_unwind` around every decode).
  `crates/contracts-generated/tests/fuzz_deserialization.rs` adds the
  standalone boundary fuzz (ТЗ §80/§6.8): every one of the 45 generated
  decoders is driven with random raw buffers and with structurally mutated
  fixture values (field deletion, wrong-type swaps, unknown keys, corrupt
  strings); any panic fails the test. Fixed-seed xorshift64 keeps the corpus
  byte-reproducible; `NT_CONTRACT_FUZZ_ITERS` scales the budget (nightly runs
  200k iterations).
- The kernel smoke tests
  (`crates/runtime-kernel/tests/kernel_smoke.rs`, [PLANNED]) additionally pin
  handshake failure modes (wrong hash / wrong ABI → `ContractMismatch`),
  strict rejection (`{"extra":true}` on `meta.get` → `ContractViolation`),
  cancellation, unknown operation, and no-panic garbage input.

## 10. FFI/JNI ABI policy (§6.9)

- The ABI boundary passes **opaque handles and buffers only**:
  - Rust side: `Kernel`, `CancellationFlag` (opaque structs), byte slices in /
    byte vectors out (`dispatch(operation_id, request: &[u8], cancel) ->
Result<Vec<u8>, KernelError>`).
  - `FFI_ABI_VERSION = 1` is the only ABI version the kernel accepts; changing
    the ABI (signatures, memory model, threading) bumps it independently of the
    wire protocol.
  - `crates/runtime-kernel/src/lib.rs` exposes `headless::HeadlessAdapter`
    (thin dispatch pass-through) and `local::LocalConnection` (in-process
    `call`; no HTTP/port, ТЗ §11.1) as the Phase 1 surface the facades
    (`LocalBackend`, `RemoteBackend`, `LegacyBackend` in `packages/neobackend`)
    will bind to.
- **Concrete native adapter (Phase 5):** `crates/adapters/mobile-ffi`
  implements the policy as a stable C ABI for Android JNI / future Swift
  hosts. Surface: `nt_ffi_version`, `nt_kernel_open`/`nt_kernel_free`,
  `nt_call`, `nt_stream_start`/`nt_stream_wait`/`nt_stream_cancel`/
  `nt_stream_free` — opaque `NtKernel`/`NtStream` handles, bounded
  length-delimited UTF-8/byte buffers, stable integer status codes
  (`NT_OK`, `NT_ERR_INVALID_ARG`, `NT_ERR_CONTRACT`, `NT_ERR_NOT_FOUND`,
  `NT_ERR_STORAGE`, `NT_ERR_CANCELLED`, `NT_ERR_INTERNAL`, `NT_ERR_BUFFER`,
  `NT_ERR_MISMATCH`). Payloads are the identical Product Wire Contract bytes;
  `MAX_REQUEST_LEN` (1 MiB) is checked before any parse, output-buffer
  shortage returns `NT_ERR_BUFFER` with the required capacity, Rust
  allocations are freed only by the exported free functions, and every entry
  point contains panics (`catch_unwind` → `NT_ERR_INTERNAL`). The ABI
  version is part of the exact local handshake: `nt_kernel_open` runs the
  `schemaHash` + `ffiAbiVersion` check before creating a handle, so an
  incompatible host performs no product operations (§6.5). See
  `crates/adapters/mobile-ffi/README.md`.
- No `serde_json::Value` escapes generated DTO boundaries; tolerant payload
  fields are explicitly typed `Value` at the envelope level only.
- No platform/server/HTTP/UI dependencies in the kernel crate (ТЗ §6); std-only
  until a future phase introduces tokio deliberately.

## 11. Related documents

- [Operations inventory](operations-inventory.md) — the current HTTP surface
  these contracts back, and the ownership/routing table.
- [Version axes](version-axes.md) — wire version as one axis among many.
- [Mobile FFI ABI](../../crates/adapters/mobile-ffi/README.md) — the Phase 5
  native adapter implementing §6.9 as a stable C ABI (handles, buffers,
  status codes, buffer-free contract).
- [ADR-0029](../adr/0029-wire-contract-toolchain.md) — decision record for this
  toolchain; [ADR-0004](../adr/0004-typebox-contracts.md) — the TypeBox base.
