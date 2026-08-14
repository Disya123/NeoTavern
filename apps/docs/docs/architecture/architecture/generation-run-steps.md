---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/generation-run-steps.md
---

# Generation run/step journal and the tool-call loop (ТЗ §8.3, Этап 2.7)

> **Status.** Этап 2.7 implemented (round 12, M2): durable step journal
> (`generation_steps`, schema migration 6), the derived `waiting_for_tool` run
> status, the declarative tool registry, the kernel-side tool-call loop with
> loop guard and stable terminal codes, and crash-at-wait recovery. The kernel
> **never executes tools** — it validates the normalized call, durably waits,
> and the host performs the effect and submits the result. Round 13 added the
> waiting-run cancel/retry semantics (§8.3) and the end-to-end tool round trip
> through the real OpenAI-compatible adapter.

## The durable waiting state

A provider turn that emits a normalized tool call must not block the writer
thread waiting for a human/host, and the waiting state must survive a process
crash. Этап 2.7 models waiting as a **durable marker, not a held transaction**:

```sql
-- migration 6 (no table rebuild: ALTER + CREATE only, v3 CHECK untouched)
ALTER TABLE generation_runs ADD COLUMN pending_tool_call_json TEXT;

CREATE TABLE generation_steps (
  run_id          TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
  sequence        INTEGER NOT NULL,           -- per-run, 0-based, gapless
  step_id         TEXT NOT NULL,              -- uuidv7
  step_type       TEXT NOT NULL,              -- provider_turn|tool_call|tool_result|final_commit
  status          TEXT NOT NULL,              -- running|waiting|completed|failed
  attempt         INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  input_json      TEXT NOT NULL DEFAULT '{}', -- bounded JSON (e.g. the normalized ToolCall)
  output_json     TEXT,                       -- bounded JSON (e.g. the tool result)
  error_json      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
) STRICT;
CREATE INDEX idx_generation_steps_run ON generation_steps(run_id);
```

- The DB `status` CHECK **stays** `queued|preparing|streaming|completed|failed|
  cancelling|cancelled|interrupted` — `waiting_for_tool` is a **derived wire
  status**: `streaming` + `pending_tool_call_json IS NOT NULL`. No table
  rebuild, no migration risk for existing runs (the m6 lesson: never rebuild a
  parent table inside the transactional runner — children FK-repoint and a
  `DROP TABLE` CASCADE-deletes them).
- `pending_tool_call_json` holds the serialized normalized `wire.tool.call`
  (kernel-assigned uuid `toolCallId`, tool name, validated arguments). The
  marker is the single source of truth for "is this run waiting, and on
  which call".

## Step journal

Every step is an immutable row + a `generation.step` wire event, committed in
the same CAS transaction that advances the run (`revision`,
`last_event_sequence`, lease refresh). Step `sequence` is per-run monotonic
from 0 (`MAX(sequence)+1`); the event `sequence` is the run's
`last_event_sequence + 1`.

| step_type       | status      | written when                                                              |
| --------------- | ----------- | ------------------------------------------------------------------------- |
| `provider_turn` | `completed` | a provider turn ends (tool-call transition or normal completion)          |
| `tool_call`     | `waiting`   | the waiting transition commits (carries the normalized `ToolCall`)        |
| `tool_result`   | `completed` | `generation.tool.result` clears the marker (carries call + result)        |
| `final_commit`  | `completed` | the successful run commits its terminal message                           |

The closing steps are advisory diagnostics; the canonical terminal record stays
the atomic terminal transaction (assistant `messages` row + status flip +
`generation.completed` event).

## The tool-call loop

```text
provider turn
  └─ ProviderEvent::ToolCall ─► validate (registered + args schema)
       ├─ unknown tool            → terminal TOOL_NOT_FOUND
       ├─ bad arguments           → terminal TOOL_ARGS_INVALID
       ├─ budget exhausted        → terminal TOOL_LOOP_LIMIT (max 8 calls)
       └─ valid: ONE CAS tx
            provider_turn(completed) step + tool_call(waiting) step
            + pending_tool_call_json + 2× generation.step events
            → run reports waiting_for_tool; stream session ends

host performs the effect ONCE, then
generation.tool.result { runId, toolCallId, result }
  ├─ not waiting / wrong call id  → TOOL_RESULT_STALE (non-idempotent)
  └─ valid: ONE CAS tx (tool_result step + marker cleared + event)
       → resumed provider turn with extra messages:
         assistant { tool_calls:[…] } + tool { tool_call_id, result }
       → next turn (may emit text, complete, or another tool call)
```

- The kernel assigns the **stable `toolCallId` (uuid)** itself — adapter ids
  (`call_…`, `fake-call-…`) are transport-local and may collide.
- The host must submit the result exactly once per `toolCallId`; a replay is
  `TOOL_RESULT_STALE` (external effects are the host's idempotency concern —
  the kernel guarantees the waiting state exists before the host runs).
- **Crash at wait:** the waiting transition refreshed the lease, so a reopen
  (fresh lease) leaves the run `waiting_for_tool` and the host can submit the
  result on the new kernel. An expired lease → startup recovery marks the run
  `interrupted` (retry-safe: no external effect ever ran, because the host
  only executes after the durable waiting commit).

## Cancel and retry of waiting runs

A waiting run has **no live executor**: its stream session ended at the
durable waiting transition, so `generation.cancel` cannot rely on the
executor observing `cancel_requested`. It therefore finalizes the terminal
itself — `WaitingForTool → Cancelling → Cancelled` (§8.3), in the same
operation:

- `generation.cancel` on `{queued, preparing, streaming}` still only sets
  `cancelling` + `cancel_requested` (an executor IS live there); on a
  **waiting** run it commits the `cancelled` terminal directly.
- **All four terminal writers clear `pending_tool_call_json`** (`completed`,
  `failed`, `cancelled`, and startup `interrupted` recovery), so a terminal
  run never reports a derived waiting status and a stale host submission is
  rejected (`generation.tool.result` on a non-`streaming` run →
  `TOOL_RESULT_STALE`). The host must not execute an effect after observing
  cancellation.
- The step journal survives cancellation unchanged (immutable evidence:
  `provider_turn` + `tool_call` rows stay).
- `generation.retry` from a **cancelled** waiting run starts attempt 2 (fresh
  `source_run_id` link, full tool round trip). `generation.retry` on a run
  still **waiting** (live `streaming` + marker) is `GENERATION_RUN_STATE_CONFLICT`
  — the source must be terminal first.
- `generation.discard` on a recoverable terminal run also clears the marker
  (hygiene; the run was already terminal).

## Declarative tool registry

Tools are **contracts, not code** (`wire.tool.spec`: `id` `^[a-z][a-z0-9-]{1,63}$`,
`name`, `description`, `inputSchema`):

- `Kernel::register_tool(spec)` (writer command, fire-and-forget ack) — the
  registry is in-memory per kernel; hosts re-register after restart.
- `generation.tools.list` (app.read, stateless) serves the registry; the
  executor passes the declared tools to adapters via `ProviderRequest.tools`.
- Argument validation is a minimal JSON-Schema subset: `object` with
  `properties`/`required`/`additionalProperties` plus
  `string|number|integer|boolean|object|array|null` property types (nested
  arrays/objects recursive). Full JSON-Schema is a follow-up.

## Adapters

- `provider-sdk`: `ProviderEvent::ToolCall { id, name, arguments }`,
  `PromptMessage.tool_calls`/`.tool_call_id`, `ProviderRequest.tools`.
- OpenAI-compatible adapter: serializes `tools` (function schema) and the
  resumed-turn context; accumulates SSE `delta.tool_calls[]` fragments
  (concatenated `function.arguments`) and emits one `ToolCall` per completed
  call after the stream.
- Fake provider: `tool=<name>` (first turn calls, resumed turn emits
  deterministic final text) and `tool-loop=<name>` (every turn calls — drives
  the loop-guard tests).

## Operations (registry additions)

| Operation              | Class             | Purpose                                                        |
| ---------------------- | ----------------- | -------------------------------------------------------------- |
| `generation.tools.list`| transactional, idempotent, safe, app.read | list registered tool contracts         |
| `generation.tool.result`| transactional, non-idempotent, none, app.write | submit a tool result and resume the run (→ `wire.generation.run`) |

Terminal error codes added: `TOOL_NOT_FOUND`, `TOOL_ARGS_INVALID`,
`TOOL_LOOP_LIMIT`, `TOOL_RESULT_STALE`.

## Tests

- `crates/runtime-kernel/src/tools.rs` — registry + schema subset (7 unit).
- `crates/built-in-providers/src/fake.rs` — tool grammar + loop mode (2 unit).
- `crates/provider-openai-compat/src/tests.rs` — tools/tool-call serialization,
  fragmented arguments, mixed text+call streams (2 adapter).
- `crates/runtime-kernel/tests/tool_loop.rs` — golden round trip, tool listing,
  unregistered tool, invalid arguments, stale result, non-waiting stale,
  loop limit, crash-at-wait reopen/resume, cancel-on-waiting finalization,
  retry-from-cancelled, retry-on-live-waiting conflict (10 integration).
- `crates/runtime-kernel/tests/providers_openai.rs` — golden tool round trip
  through the **real** OpenAI-compatible adapter and SSE path: turn 1 streams
  a normalized tool call → durable waiting → `generation.tool.result` → turn 2
  resumes with the tool context → completed with one message; both HTTP bodies
  assert `tools` serialization and the resumed `tool_call_id` (1 integration).
- `crates/storage/tests/open_migrate.rs` — migration 6 on a v5 data root.

## Related documents

- [Generation durability](generation-durability.md) — the run state machine,
  event log and recovery the step journal extends.
- [Prompt pipeline](prompt-pipeline.md) — the durable PromptPlan the executor
  builds once and reuses on resumed turns.
- [Wire contracts](wire-contracts.md) — operation registry and envelopes.
- [Runtime Kernel README](https://github.com/Disya123/NeoTavern/blob/main/crates/runtime-kernel/README.md) — kernel API.
