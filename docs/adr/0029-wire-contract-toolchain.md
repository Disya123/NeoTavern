# ADR-0029: Wire contract toolchain — TypeBox single source → deterministic codegen → committed Rust DTOs

Date: 2026-08-12. Status: Accepted (Phase 0).
Related documents: [ADR-0004](0004-typebox-contracts.md) (TypeBox as the API
schema source), [ADR-0028](0028-ses-bootstrap-tcb.md) (trusted bootstrapping —
same spirit of minimal, deterministic, auditable artifacts),
[Wire contracts](../architecture/wire-contracts.md),
[Operations inventory](../architecture/operations-inventory.md),
[Version axes](../architecture/version-axes.md).

## Context

NeoTavern is moving product operations into a Rust Runtime Kernel (ТЗ §7). The
same operations are served today by the TypeScript Fastify server
(`apps/server/src/plugins/*.ts`) with TypeBox schemas from `@neotavern/contracts`
(ADR-0004). For the kernel to be a faithful writer of the same contract, the
TypeScript and Rust validators must agree **exactly** on:

- schema structure (which fields, which types, strictness),
- string semantics (JS `.length` counts UTF-16 code units; Rust `str.len()` is
  bytes — they disagree on non-BMP characters),
- regex dialect (JS vs Rust regex differ on lookarounds and backrefs),
- enum/union representation (closed string sets, discriminated unions),
- numeric constraints (safe integer range, portability).

Experience in this repo shows hand-maintained mirrors drift (the backup `kind`
field drifted out of a hand-redeclared UI type, ARCH-11; the SSE event
whitelist drifted across three packages before being centralized in
`packages/contracts/src/events.ts`). A second, hand-written Rust mirror of the
wire contract would drift the same way, silently, across languages where no
single type-checker can catch it.

The kernel must also validate **without panic** on arbitrary external payloads,
return controlled errors, and the whole contract must be reviewable and
reproducible at a specific commit.

## Decision

### 1. TypeBox as the single hand-authored source of truth

`packages/contracts/src/wire/` is the only place a wire contract is written by
humans: TypeBox schemas (every DTO with a `$id`), the operation registry
(`WireOperation` metadata: execution class, idempotency, retry policy, auth
scope, size limits, unknown-fields policy, allowed error codes), and the
fixture corpus. TypeScript types are inferred from the schemas; nothing is
hand-written twice.

### 2. Deterministic codegen with canonical JSON and a sha256 `schemaHash`

`tools/contract-codegen/codegen.mjs` reads the wire layer and emits:

- `packages/contracts/generated/contract.bundle.json` (schemas + operations,
  canonical JSON — key-sorted, no whitespace, trailing newline);
- `packages/contracts/generated/contract-manifest.json` (protocol version,
  dialect, `schemaHash`, `ffiAbiVersion`, `generatorVersion`, per-operation
  metadata);
- `packages/contracts/generated/fixtures/*.json` + `corpus.json`;
- `crates/contracts-generated/src/generated.rs` (DTOs + validators).

`schemaHash = sha256(canonical(bundle))` — the entire contract fingerprints
into 64 hex characters. Root scripts `contracts:generate` / `contracts:check`
run the tool; `--check` regenerates and exits non-zero on any diff, so a stale
commit fails CI with a git-diff exit code.

### 3. Committed generated artifacts (Rust builds without Node)

`generated.rs` and the JSON artifacts are committed to the repo. The Rust
crate embeds the manifest via `include_str!` and contains no toolchain
dependency — `cargo build/test` works in a Node-free environment, and code
review sees the exact bytes that ship.

### 4. Wire-safe subset with fail-on-unsupported (no `serde_json::Value` fallback)

`checkWireSchema` (`packages/contracts/src/wire/rules.ts`) rejects at compile
time every construct the two validators cannot agree on: `oneOf`/`allOf`/`not`,
`if`/`then`/`else`, `$ref`/`$dynamicRef`, `patternProperties`,
`dependentSchemas`, `unevaluatedProperties`, `prefixItems`, `contains`,
`Type.Any`/`Type.Unknown`/`Type.Unsafe`, raw `enum`, non-portable regex
(lookarounds, backrefs, `\p{…}`), out-of-range numeric constraints, and any
`default` key. The generated Rust DTOs are strict
(`#[serde(deny_unknown_fields)]`); tolerant payload slots exist only where the
schema says so (envelope `payload`/`result`, `ProductErrorDto.params`) and are
explicitly typed `serde_json::Value`. There is no implicit fallback path that
could silently accept a schema the other language would reject.

### 5. String-discriminated unions

Open unions are **string-discriminated**: a tagged union carries
`x-wire-discriminator` (`type`/`kind`) and every member starts with a string
literal const; closed string enums (`anyOf` of consts) carry
`x-wire-unknown-behavior: 'reject'` so unknown literals fail validation. Rust
emits `#[serde(tag = "type")]` enums / renamed variants. This keeps the
wire format self-describing and validation identical in both languages.

### 6. UTF-16 string-length semantics shared by both validators

Both validators count string length in **UTF-16 code units** (JS `.length`;
Rust `s.encode_utf16().count()`), so `maxLength`/`minLength` verdicts match on
non-BMP text. Format patterns (`uuid`, `rfc3339`, `decimal-string`) come from
one `WIRE_FORMAT_PATTERNS` map mirrored byte-for-byte into precompiled Rust
static regexes (fail-closed, never panicking, on a malformed pattern).

### 7. Format registry shared TS/Rust

The format registry (`packages/contracts/src/wire/formats.ts`) is the single
definition of which `format` keywords exist on the wire; anything else is
rejected as `unregistered-format` at contract compile time.

### 8. Exact-match local handshake

`Kernel::open` accepts only the contract it was built with: the caller's
`expected_schema_hash` must equal the crate's embedded
`contract_schema_hash()`, and `ffi_abi_version` must be `1` — any mismatch is a
controlled `ContractMismatch` error. The request envelope additionally carries
`wireProtocol` + `schemaHash`, validated per request. Remote peers negotiate
major/minor via `meta.get`; breaking changes require a wire major bump (see
[Wire contracts](../architecture/wire-contracts.md#7-contract-versioning-67)).

### 9. Controlled errors, no panic

Validation is a structural walk producing `Issue { path, rule }` lists; decode
is parse → validate → DTO → domain with `WireError { Parse | Violation |
Internal }`. The kernel never panics on external payload bytes (enforced by a
no-panic fuzz pass over 512 generated inputs in the corpus and kernel smoke
tests). Generated-code failures surface as `Internal` errors, not panics.

## Alternatives

- **Hand-written mirror DTOs in Rust.** Rejected: the mirror drifts (precedent:
  ARCH-11 backup `kind`, the SSE whitelist drift) and no single type-checker
  spans both languages. Codegen guarantees structural equality by construction.
- **Runtime reflection in Rust** (parse JSON Schema at startup and interpret it
  against `serde_json::Value`). Rejected: couples the kernel to the schema
  runtime and the toolchain, loses static types, makes validation slow, and
  re-implements a JSON-Schema engine that must match TypeBox verdicts by hand.
- **Generated-into-memory** (run codegen at build time, never commit the
  output). Rejected: breaks review (the shipped contract is not in the diff),
  breaks reproducibility of old commits, and makes Rust builds depend on Node —
  violating the "Rust builds without Node" requirement.
- **Enum-key-based discriminators** (numeric or enum-key tags for unions).
  Rejected: creates untagged-ambiguity risks, makes the wire format less
  self-describing, and diverges from TypeBox/JSON Schema conventions that the
  TypeScript side already uses.

## Consequences

- **Positive:** a single source of truth; byte-identical validators in TS and
  Rust (UTF-16 length, formats, regexes, union semantics); reviewable,
  committed, reproducible artifacts; Node-free Rust builds; handshake failures
  are loud and early (wrong hash → `ContractMismatch`); schema changes are
  visible as diffs in generated files plus a new `schemaHash`.
- **Costs:** every schema change requires regenerating and committing the
  artifacts; generated files are large and mostly noise in review (mitigated by
  `--check` and the fixture corpus doing the semantic verification); the wire
  subset is deliberately small (no `$ref`, no `oneOf`, …), so some exotic
  schemas need restructuring; the corpus must be extended whenever a new rule
  family is added.
- **Process:** `pnpm contracts:generate` after any edit under
  `packages/contracts/src/wire/`; CI runs `contracts:check` and
  `crates:test`. Changing `wireProtocol` major or `FFI_ABI_VERSION` requires a
  migration guide per [Version axes](../architecture/version-axes.md).

## Migration

No DDL and no runtime migration: Phase 0 adds the wire layer, the codegen tool
and the committed generated artifacts; the Fastify `/api/v2` surface keeps
serving unchanged until operations move to the kernel per
[Operations inventory](../architecture/operations-inventory.md#7-ownership-and-routing-table).
Rollback — stop using the kernel; the Fastify surface remains the live writer.
