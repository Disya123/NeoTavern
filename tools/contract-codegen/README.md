# contract-codegen

Deterministic code generator for the NeoTavern product wire contract (Phase 0/1 of the
ТЗ 7.2 wire migration). Single source of truth: the wire layer of `@neotavern/contracts`
(`packages/contracts/src/wire/`); this tool turns it into the artifacts that the Rust
boundary and the facades consume.

## Purpose

The wire contract is defined once as TypeBox schemas plus an operation registry in
`@neotavern/contracts`. `codegen.mjs` snapshots that contract into:

- canonical JSON artifacts for non-Rust consumers (`packages/contracts/generated/`), and
- a generated Rust DTO module (`crates/contracts-generated/src/generated.rs`) that the
  kernel (`crates/runtime-kernel`) and the wire corpus test compile against.

Running the tool after any schema/operation change keeps every artifact in sync; `--check`
verifies the committed artifacts are still current.

## Inputs

The tool consumes the built wire layer, so it first runs
`pnpm --filter @neotavern/contracts build` (this also fails the run if the wire layer does
not compile). It then dynamic-imports `packages/contracts/dist/wire/index.js` and uses:

- `buildProductWireRegistry()` → `{ operations, schemas }` (15 compiled operations, the
  schema map keyed by `$id`)
- `PRODUCT_WIRE_FIXTURES` → the self-checked fixture corpus (40 entries: valid
  request/response per operation, one `generation.completed` event, 10 negative fixtures)
- `resolveFixtureSchemaId(fixture, operations)` → corpus `schemaId` resolution
- `compileWireContract` — re-run as a sanity gate before emission (throws
  `ContractCompileError` on any violation)
- `WIRE_PROTOCOL`, `SCHEMA_DIALECT`, `FFI_ABI_VERSION`, `GENERATOR_VERSION`,
  `WIRE_FORMAT_PATTERNS`

If `buildProductWireRegistry()` also returns `fixtures`, that list is used instead of
`PRODUCT_WIRE_FIXTURES` (same contract, either source is fine).

## Outputs

| File                                                  | Content                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/generated/contract.bundle.json`   | `{ wireProtocol, schemaDialect, schemas, operations }` — canonical TypeBox schemas (with `$id`) + full compiled operation objects                                                                                                                                                                                                  |
| `packages/contracts/generated/contract-manifest.json` | Protocol/dialect + `schemaHash` (lowercase hex SHA-256 of the **emitted bundle bytes**, canonical JSON + trailing newline) + per-operation metadata (`feature`, `version`, `executionClass`, `idempotency`, `retryPolicy`, `authScope`, schema ids, error codes, byte limits, `unknownFields`); absent optional fields are omitted |
| `packages/contracts/generated/fixtures/<id>.json`     | One canonical JSON file per fixture                                                                                                                                                                                                                                                                                                |
| `packages/contracts/generated/fixtures/corpus.json`   | `[{ id, operationId, kind, schemaId, valid, file }]`, `file` = `<id>.json`, `schemaId` from `resolveFixtureSchemaId`                                                                                                                                                                                                               |
| `crates/contracts-generated/src/generated.rs`         | The Rust boundary DTO module (see below)                                                                                                                                                                                                                                                                                           |

### `generated.rs` emission rules (rust-contract.md §3)

- Naming: strip `wire.` from `$id`; each dot segment kebab→snake/Pascal; joined with `_`
  (functions) or nothing (types). Examples: `wire.meta.dto` → `MetaDto`,
  `check_meta_dto`/`validate_meta_dto`/`decode_meta_dto`; `wire.request.list-characters` →
  `RequestListCharacters`, `decode_request_list_characters`.
- Strict objects → `#[derive(...)]` structs with `#[serde(deny_unknown_fields)]`; snake_case
  field names with `#[serde(rename = "...")]` when the JSON key differs; `Option<T>` +
  `#[serde(default, skip_serializing_if = "Option::is_none")]` for optional fields.
- Tolerant objects (`additionalProperties: true`, no properties) → `Value` fields.
- Maps (`additionalProperties: <primitive>`) → `HashMap<String, i64|String|f64|bool>`.
- Closed string enums (`anyOf` of consts + `x-wire-unknown-behavior: reject`) → serde
  enums with `#[serde(rename = ...)]` variants.
- Discriminated unions (`x-wire-discriminator`) → `#[serde(tag = "...")]` enums (tag `kind`
  for `wire.response.envelope`); unit variants for members with only the discriminator.
- Inline (non-`$id`) nested objects → helper structs named `<Pascal(parentId)><PascalField>`
  (e.g. `MetaDtoApi`, `MetaDtoProductWire`, `RequestEnvelopeWireProtocol`).
- Per schema: `pub(crate) fn check_x(&Value, &str, &mut Vec<Issue>)` (structural walk),
  `pub fn validate_x(&Value) -> Result<(), Vec<Issue>>`, and
  `pub fn decode_x(&[u8]) -> Result<T, WireError>` delegating to `crate::decode::<T>`.
  Kernel-contract aliases `decode_empty_request_dto`/`decode_empty_result_dto` and the
  `ProductErrorDto` type alias (`wire.error.dto`) are emitted alongside the §3 names.
- Checkers match TypeScript `Value.Check` verdicts on the shared corpus: UTF-16 code-unit
  string length (`encode_utf16().count()`), `as_i64`/`as_f64` numeric checks, `pattern` and
  `format` via `static RE_N: LazyLock<Regex>` compiled with
  `Regex::new(p).unwrap_or_else(|_| Regex::new("$^").unwrap())` (a malformed generated
  pattern fails closed, never panics), unknown-key rejection for strict objects, path joins
  via a module-private `join_path` helper.

## Usage

```bash
node tools/contract-codegen/codegen.mjs          # rebuild contracts, write all outputs
node tools/contract-codegen/codegen.mjs --check  # rebuild, compare in memory vs disk
```

`--check` prints `OK <path>` / `DIFF <path>` per output and exits `1` if anything differs;
it never writes. Root scripts: `pnpm contracts:generate` / `pnpm contracts:check`.

## Contract compatibility diff

`diff.mjs` compares two canonical contract bundles (the `contract.bundle.json` output
above) and classifies every difference as **breaking** (old wire peers cannot
interoperate), **additive** (safe extension), or **unchanged**. Schemas are matched by
`$id`, operations by `operationId`.

```bash
node tools/contract-codegen/diff.mjs <prev-bundle.json> <curr-bundle.json> [--json]
```

Exit codes: `0` = compatible, `1` = breaking change, `2` = usage/input error. With
`--json` the result prints as JSON (`{ compatible, changes }`); otherwise as one
`[kind] path - reason` line per change plus a summary.

Programmatic API (ESM):

```js
import { semanticDiff, diffBundlesFile } from './diff.mjs';

const result = semanticDiff(prevBundle, currBundle); // { compatible, changes }
const fromFiles = diffBundlesFile('prev.json', 'curr.json'); // same shape
```

### Rules (ТЗ §6.7)

| Change                                                            | Classification |
| ----------------------------------------------------------------- | -------------- |
| removed schema / operation / field                                | breaking       |
| field optional → required (incl. new required field)              | breaking       |
| type / format / const / discriminator changed                     | breaking       |
| enum (anyOf of consts) narrowed (values removed)                  | breaking       |
| enum widened, `x-wire-unknown-behavior: 'reject'`                 | breaking       |
| enum widened, `'preserve'` (or absent)                            | additive       |
| numeric/string range narrowed (min up, max down, lengths, counts) | breaking       |
| range widened                                                     | additive       |
| new optional field, new operation, new schema                     | additive       |
| removed tagged-union member                                       | breaking       |
| added tagged-union member (unknown members preserved)             | additive       |
| `allowedErrorCodes`: removed code                                 | breaking       |
| `allowedErrorCodes`: added code                                   | additive       |
| unknown additions (keys)                                          | additive note   |

Extensions applied to the operation envelope, documented here for the record:

- `requestSchemaId` / `responseSchemaId` / `eventSchemaId` changed → breaking (the
  operation's wire shape changed).
- `requestLimitBytes` / `responseLimitBytes` / `eventLimitBytes` lowered → breaking,
  raised → additive (byte limits are ranges).
- `unknownFields` `strict` → `allow` → additive, `allow` → `strict` → breaking.
- remaining metadata changes (`authScope`, `executionClass`, `idempotency`,
  `retryPolicy`, `feature`, `version`, …) → additive note (outside the wire-shape rules).

Canonical comparison reuses the canonicalizer exported by `codegen.mjs` (same definition
of "canonical" as the bundle bytes), with a small local key-sorted stringify as fallback.

`diff-test.mjs` is a plain-assertion harness (no test runner, no dependencies) covering
six cases: all-additive, removed field, optional→required, narrowed range, widened enum
with `preserve`, and new operation:

```bash
node tools/contract-codegen/diff-test.mjs   # prints OK/FAIL per case; exit 0 = all pass
```

## Determinism

Identical input always yields byte-identical output:

- every JSON artifact is canonical JSON — objects recursively key-sorted, no whitespace,
  trailing newline (arrays keep their order: schemas in registry order, operations in
  registry order, fixtures in fixture-list order);
- `generated.rs` emits schemas in registry (registration) order, fields in `properties`
  order, union members in `anyOf` order;
- the `schemaHash` is computed over the canonical bundle bytes, so it is stable too.

Run the tool twice and `cmp` the outputs to confirm; `--check` is the automated version.

## Regenerating

1. Edit the wire contract (`packages/contracts/src/wire/**`) — schemas, operations,
   fixtures — and any consumers that follow.
2. `node tools/contract-codegen/codegen.mjs` (or `pnpm contracts:generate`).
3. Commit the regenerated artifacts together with the source change; CI should run
   `pnpm contracts:check` to catch drift.
4. `crates/contracts-generated` embeds `contract-manifest.json` via `include_str!`; after a
   regeneration, `cargo test` in `crates/` re-validates the corpus against the new
   generated DTOs and checkers.
