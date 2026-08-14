---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0031-portable-provider-contract.md
---

# ADR-0031: Portable Provider Contract (Phase 7)

Date: 2026-08-13. Status: Accepted (Phase 7).
Related documents: [Providers](../architecture/providers.md),
[ADR-0029](0029-wire-contract-toolchain.md),
[Generation durability](../architecture/generation-durability.md),
ТЗ §55–§56, §60, §68, §78 Фаза 7.

## Context

Phase 6 embedded a deterministic fake provider inside the Runtime Kernel
executor. That violated the Phase 7 target: built-in providers must be
portable adapters with normalized models/errors/usage, scoped credential
flow, timeout/cancel/retry policies and recorded non-secret fixtures — and
the kernel must not be coupled to a single provider implementation (ТЗ §55,
§87 "Provider SDK является contract, а built-in implementation может быть
native"). Secrets must never enter snapshots, logs, backups or diagnostics
(§68), and retry policy must never create a hidden double billable request
(§55).

## Decision

Three layers with one frozen trait:

1. `crates/provider-sdk` — the portable adapter contract (std-only, no
   async): `ProviderAdapter` (`id`/`name`/`builtin`/`models`/`availability`/
   `generate`), normalized `ProviderError` (stable codes `timeout |
cancelled | unavailable | request-invalid | step-failed | network-fault`),
   `Usage` accounting, `Deadline`/`RetryPolicy` policy primitives,
   `CancelToken`/`EmitStatus` cancellation/backpressure semantics, and the
   secret seams `SecretRef`/`SecretValue`/`SecretResolver` (opaque value,
   `Debug` prints `<redacted>`).
2. `crates/built-in-providers` — built-in adapters implementing the SDK:
   `FakeProvider` (byte-identical port of the Phase 6 inline fake,
   sha256-derived deltas, fault injection) and `RecordedProvider` (JSON
   script replay — recorded non-secret fixtures), plus a shared conformance
   suite applied to every adapter.
3. Kernel integration — the executor resolves adapters through a
   `ProviderRegistry` (built-ins registered at open), maps provider errors to
   product codes (`PROVIDER_STEP_FAILED`, `PROVIDER_TIMEOUT`,
   `PROVIDER_NETWORK_FAULT`, `PROVIDER_UNAVAILABLE`,
   `PROVIDER_MODEL_INVALID`), enforces a per-run `Deadline` (default 60 s),
   and exposes `providers.list` (wire op 21) plus the host seams
   `Kernel::set_secret_resolver` / `Kernel::set_run_timeout`.

Config/secret separation is persisted by storage migration 4
(`provider_configs`: non-secret `config_json` + nullable `secret_ref`,
`UNIQUE(provider, name)`, risk Low, transactional) — secrets live only in
host secure storage resolved through `SecretResolver`.

## Alternatives

- Keep the fake inline in the kernel: rejected — couples the kernel to one
  provider, blocks Android/Headless reuse, no conformance boundary.
- Vendor SDK dependency for built-ins: rejected — ТЗ §55 requires portable
  built-ins; the only sanctioned SDK exception is the Anthropic adapter in
  the TypeScript provider layer (AGENTS.md §7), not the kernel.
- Async provider trait (tokio): rejected — the kernel is std-only and the
  cooperative cancel/deadline model is sufficient for the built-ins; network
  providers may block with their own deadlines inside `generate`.

## Consequences

- The Phase 6 fake provider moved out of the kernel; existing generation
  tests pass unchanged (byte-identical event logs) — regression proof.
- One billable attempt per `generate` call is counter-proven by the
  conformance suite (no silent double billing); retry stays a user-visible
  `generation.retry` attempt.
- Secrets are references end-to-end; the redaction test scans run snapshots,
  event payloads and error JSON.
- `providers.list` gives UI/hosts the §60 availability metadata over both
  Local and Remote transports (adapter parity test over `/rpc`).
- New adapters must pass the same conformance battery; network providers
  plug into the same trait in later phases without kernel changes.
