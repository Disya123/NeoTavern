---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0044-generation-run-step-model.md
---

# ADR-0044: Provider Execution and the Generation Run/Step/Tool Model

- **Status:** accepted (decision in force; delivered with the M2 PR,
  pr-kernel-golden)
- **Date:** 2026-08-14
- **Related:** [ADR-0038](0038-canonical-rust-kernel-core.md),
  [ADR-0040](0040-secret-store-port-format.md),
  [ADR-0029](0029-wire-contract-toolchain.md),
  [ТЗ 10/10 rev2 §8.3, §9.1–§9.4](https://github.com/Disya123/NeoTavern/blob/main/NeoTavern_architecture_10_of_10_spec_2026-08-13.md)

## Context

ТЗ §8.3 forbids the primitive `Created → Streaming → Completed` model as the
domain basis: streaming is event delivery, not the full lifecycle. The Kernel
must model a durable `GenerationRun` composed of `GenerationStep`s, with
`WaitingForTool` as a durable wait (never an open DB transaction), `Yielded`
for approval/external waits, per-step budgets and idempotent external
effects. ТЗ §9 requires the full prompt pipeline in the Kernel with an
immutable `PromptPlan` before any network request, provider secrets resolved
only at execution time via `SecretStore`, and fail-closed capability
negotiation.

## Decision

1. **State machine** (validated in `crates/runtime-kernel/src/generation.rs`
   via `cas_status`): `Created → Planning → Running ↔ WaitingForTool`
   (`tool_call` / `tool_result`), `Running ↔ Yielded` (`resume`),
   `Running → Committing → Completed`; `Cancelling → Cancelled` from
   `Planning`/`Running`/`WaitingForTool`/`Yielded`; `Failed` from
   `Planning`/`Running`/`WaitingForTool`/`Committing`;
   `Completed`/`Cancelled`/`Failed` are terminal. Every transition is a
   compare-and-swap on the run status; delta commits combine the message
   delta and the run update in one transaction (`commit_delta`, checkpoint
   every 4th delta); `terminal_completed` inserts the final assistant
   message + status CAS + terminal event in one transaction.
2. **Durable step journal**: table `generation_steps` with idempotency keys
   `turn-{seq}`, `tool-call-{id}`, `tool-result-{id}`; global gapless event
   sequence `generation_events`. Replaying a duplicate transport event must
   not duplicate a delta, step or message.
3. **Run identity and budgets**: `run_key = chat_id|attempt`;
   `RUN_TIMEOUT = 60 s` wall clock; lease with `LEASE_GRACE_SECONDS = 30`;
   `recover()` marks stale-lease runs `interrupted` (explicit recoverable
   terminal state) instead of silently continuing; `MAX_TOOL_CALLS = 8`
   (`TOOL_LOOP_LIMIT`); tool calls pass JSON Schema subset validation
   (`validate_node` / `properties_contains`), capability check and registry
   lookup before execution; `WaitingForTool` is durable (no open transaction
   is held).
4. **PromptPlan** (immutable, built before any network request):
   `PromptBlock`/`PromptMessage`/`PromptExcluded` with exclusion reasons;
   `MAX_HISTORY_MESSAGES = 128` (drop-oldest); `DEFAULT_CONTEXT_LIMIT =
   8192`; `MAX_LOREBOOK_BLOCKS = 24`, `MAX_LOREBOOK_ENTRIES = 2000` (keyword
   activation); instruct format `plain-messages-v1`; heuristic token
   estimator (CJK/latin) with `response_reserved = 0`; camelCase wire DTO.
5. **Provider secrets**: `providers_config` stores only a `secret_ref`
   (never the value); the wire surface exposes `hasApiKey`; resolving a
   provider `apiKey` without a wired `SecretStore` fails closed
   (`resolve_provider_api_key` no-resolver error); `provider-openai-compat`
   puts the key only into the `Authorization: Bearer` header, never into
   DTOs, diagnostics, logs or exports; upsert preserves the existing ref.
6. **Streaming**: typed provider event model (text delta, reasoning summary,
   tool-call delta/ready, usage, completion, error); partial preview
   retention `PARTIAL_PREVIEW_LEN = 4096`; backpressure via a synchronous
   writer thread with mpsc (`EmitStatus::Stop`).
7. **Crash recovery**: `recover()` replays the durable step/event journal,
   either safely continuing or moving the run to an explicit recoverable
   terminal state; no raw chain-of-thought is ever persisted (only
   provider-provided reasoning summaries and technical status events).
8. **Tests**: `crates/runtime-kernel/tests/tool_loop.rs` 10 cases (golden
   round trip, unregistered tool fails, invalid args fail, stale tool result
   rejected, non-waiting run stale, cancel-on-wait finalizes cancelled,
   retry-on-wait state conflict, loop limit fails, crash-at-wait
   reopens+resumes, empty registry); `generation.rs`, `providers_openai.rs`,
   `wire_corpus.rs`, `conformance.rs`, `generation_stream.rs`.

## Alternatives considered

- **Keep the linear `Created → Streaming → Completed` state machine.**
  Rejected: ТЗ §8.3 explicitly forbids it as the domain basis; no durable
  tool wait, no crash resume, no idempotent external effects.
- **Event sourcing as the primary persistence model.** Rejected: ТЗ §24
  forbids event sourcing as the main persistence model; the durable
  step/event journal is a recovery aid, not the system of record.
- **In-memory run state with a DB snapshot only at completion.** Rejected:
  loses `WaitingForTool`, partial text and tool-call state on crash;
  violates the crash-recovery requirement.
- **Optimistic concurrency via a version column only.** Rejected: CAS +
  lease are needed to detect lost updates across retries and crashed
  writers.
- **Provider executes tools itself or mutates product data.** Rejected:
  ТЗ §9.3 — the adapter only returns a normalized tool request;
  orchestration, authorization and durable step transitions belong to the
  Kernel.

## Consequences

- **Positive**: crash-safe runs with deterministic replay, no duplicate
  external effects, honest `CAPABILITY_UNAVAILABLE` when no wired secret
  store or unsupported capability, replay-safe transport.
- **Negative**: schema complexity (`generation_steps`/`generation_events`),
  the tokenizer heuristic gap until the exact-tokenizer ADR, synchronous
  writer thread constraint, deferred plugin interceptors/named presets.
- The M2-era design docs `docs/architecture/generation-run-steps.md` and
  `docs/architecture/generation-durability.md` become companions of this
  ADR.
