---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/generation-durability.md
---

# Generation durability (ТЗ §62–§64, Фаза 6)

> **Status.** Phase 6 implemented: kernel writer coordinator, durable state
> machine, deterministic fake provider, durable event log, SSE delivery with
> resume, and idempotent reconciliation commands. Real (network) providers
> arrive in Phase 7 — the executor's provider seam is the extension point.

Generation is a **recoverable workflow**, not a request/response call: the
process may die at any point, committed state must survive, and every
unfinished run must be explainable after restart (§63).

## Storage model (migration 3, schema revision 3)

```sql
generation_runs (
  id PK, source_run_id → generation_runs, chat_id → chats CASCADE,
  attempt, status CHECK (queued|preparing|streaming|completed|failed|
                         cancelling|cancelled|interrupted),
  provider, model, request_snapshot_json, revision, cancel_requested,
  last_event_sequence, partial_length, error_json, message_id,
  lease_owner, lease_expires_at, started_at, updated_at
)
generation_events (
  run_id → generation_runs CASCADE, sequence, type, payload_json, created_at,
  PRIMARY KEY (run_id, sequence)
)
```

`messages.generation_run_id` links the final assistant message to its run.

- `request_snapshot_json` is the sanitized request DTO (`chatId`, `message`,
  optional `provider`/`model`) — no secrets exist in Phase 6's fake provider,
  and the rule is fixed: snapshot fields come from the wire DTO minus any
  secret reference (§62).
- `revision` is the CAS counter; `lease_owner`/`lease_expires_at` identify the
  executor holding the run; `cancel_requested` is the durable cancel flag.

## State machine

```text
queued → preparing → streaming → completed
                   ├──────────→ failed
                   ├──────────→ cancelling → cancelled
non-terminal + executor death/lease expiry → interrupted (recovery)
```

Every transition is a compare-and-set transaction
(`… WHERE id = ? AND revision = ?`, `revision = revision + 1`); a lost CAS
means another actor moved the run — the kernel re-reads and reacts, never
blind-retries. Terminal states (`completed`, `failed`, `cancelled`) are
immutable; `interrupted` is terminal for the attempt and only the
reconciliation commands may act on it (§63).

`generation.cancel` on an active run sets `cancelling` + `cancel_requested`
and signals the executor; the executor observes the flag before every commit,
so **late provider output after cancellation never reaches the chat**. Cancel
is a request until the executor commits `cancelled` — the operation is
idempotent while `cancelling` and a `CONFLICT`
(`GENERATION_RUN_STATE_CONFLICT`, params `runId`, `status`) once terminal.

## Writer coordinator (§22)

`Kernel::open` spawns one dedicated thread that owns the `Database`. All
operations — CRUD reads/writes, generation steps, cancel, shutdown — are
commands on its queue. While a generation streams, the loop drains pending
commands between provider steps: reads and `generation.cancel` stay live
during long runs, and at most one generation executes at a time (queued
streams wait their turn). `Kernel` is `Send + Sync`; `dispatch` is a short
round-trip; streaming operations go through `dispatch_stream`, which returns
an `EventStream` (`stream_id()` = run id, `next_notice(timeout)` →
`Committed { through_sequence }` / `Terminal { last_sequence }`).

## Deterministic fake provider

Phase 6 executes generation through a built-in fake provider so durability is
testable without network I/O (§78 Фаза 6 deliverable "deterministic fake
provider for fault injection"). The `model` string is a `;`-separated grammar:

| Key               | Default | Range   | Meaning                               |
| ----------------- | ------- | ------- | ------------------------------------- |
| `steps`           | 8       | 1–64    | delta steps                           |
| `fail-at`         | –       | 1–steps | provider error before step N          |
| `delay-ms`        | 0       | 0–200   | sleep per step (cancel/timeout tests) |
| `tokens-per-step` | 6       | 1–256   | delta text length                     |
| `tool`            | –       | name    | Этап 2.7: call a tool on the first turn, emit final text on the resumed turn |
| `tool-loop`       | –       | name    | Этап 2.7: call a tool on EVERY turn (loop-guard budget tests) |

Delta text for step `i` is derived from `sha256(chat_id|attempt|i)` — no wall
clock, no randomness: **same inputs → byte-identical event logs across
processes**, which the Local/Remote equivalence tests assert. Unknown
`provider` → `PROVIDER_UNAVAILABLE`; unparseable grammar →
`PROVIDER_MODEL_INVALID`; injected failure → `PROVIDER_STEP_FAILED` (params
`runId`, `step`). Phase 7 replaces this seam with portable real adapters.

## Durability boundaries

- **Per step:** ONE transaction appends the delta event (and every 4th delta
  additionally a `generation.checkpoint` event) to `generation_events`,
  advances `last_event_sequence`/`partial_length`, bumps `revision` and
  refreshes the lease (`now + 30 s`). A kill between steps loses nothing
  committed; a kill inside the transaction rolls back cleanly.
- **Terminal:** ONE transaction inserts the final assistant `messages` row,
  flips the run status and appends the terminal event
  (`generation.completed` carries the full `MessageDto`). The message INSERT
  and the status CAS share one transaction — **no duplicate final message is
  possible**, and a kill before the commit leaves no half-written result.
- **Recovery:** on open, runs still non-terminal whose lease is absent or
  expired are marked `interrupted`. The exclusive data-root lease guarantees
  no other live executor exists — this is the lease/process-identity check
  §63 requires (not wall-clock alone). Recovery never auto-retries.

## Event model and streaming (§64)

Delivery is **at-least-once over the durable log**:

- Every event row carries a per-run monotonic `sequence` (no gaps — the
  sequence is allocated by the same transaction that commits the row).
- The remote adapter's `/rpc/stream` replays committed rows in ≤200-item
  batches flushed per batch (tiny_http 0.12 `respond()` buffers bodies, so
  streaming writes a manual chunked response), then a terminal
  `stream.closed` frame. Notices from `dispatch_stream` only trigger reads —
  the log is canonical.
- **Reconnect:** `POST /rpc/stream` with `generation.events` resumes from the
  `Last-Event-ID` header (or `afterSequence` in the payload). Clients dedupe
  by `sequence`; the server never serves an uncommitted event, so resume can
  only repeat, never lose or reorder.
- **Slow consumer:** bounded by design — at most one batch in flight; TCP
  backpressure plus notice coalescing bound memory. No unbounded queue exists
  anywhere in the path.

## Operations (registry)

| Operation            | Class                     | Purpose                                                                                                             |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `generation.start`   | workflow, streaming       | create run (attempt 1) + execute                                                                                    |
| `generation.retry`   | workflow, streaming       | new attempt over a `failed`/`cancelled`/`interrupted` source run (`sourceRunId`); never re-executes a completed run |
| `generation.cancel`  | transactional             | request cancellation (§63)                                                                                          |
| `generation.get`     | transactional             | durable run snapshot `wire.generation.run` incl. bounded `partialText` preview                                      |
| `generation.events`  | transactional             | paged durable event log `wire.paged.generation-events` (`afterSequence` cursor, `hasMore`)                          |
| `generation.keep`    | transactional, idempotent | promote partial text to an assistant message (post-terminal only; a waiting-for-tool run returns its DTO instead of `NO_PARTIAL_OUTPUT`)                                                   |
| `generation.discard` | transactional, idempotent | purge the event log of a post-terminal run                                                                          |
| `generation.tools.list` | transactional, idempotent, safe | list the registered tool contracts (Этап 2.7)                                                              |
| `generation.tool.result` | transactional, non-idempotent | submit a tool result and resume a waiting-for-tool run (Этап 2.7)                                       |

Product error codes: `CHAT_NOT_FOUND`, `GENERATION_RUN_NOT_FOUND`,
`GENERATION_RUN_STATE_CONFLICT`, `NO_PARTIAL_OUTPUT`, `PROVIDER_UNAVAILABLE`,
`PROVIDER_MODEL_INVALID`, `PROVIDER_STEP_FAILED`, and Этап 2.7:
`TOOL_NOT_FOUND`, `TOOL_ARGS_INVALID`, `TOOL_LOOP_LIMIT`, `TOOL_RESULT_STALE`.

Retry semantics (§63): a retry creates a **new run** (`attempt = source + 1`,
`source_run_id` link) — it never re-executes the old attempt and never hides a
double billable call; Phase 6's fake provider bills nothing, and the model
extends to real providers in Phase 7.

## UI-facing flow

```text
start ── stream events ──► completed (message persisted)
  │                 │
  │                 └── failed / cancelled ──► UI offers:
  │                       Retry   → generation.retry (new attempt)
  │                       Keep    → generation.keep  (partial → message)
  │                       Discard → generation.discard
  └── process death ──► interrupted (recovery) ──► same three choices
```

## Related documents

- [Generation run/steps and the tool-call loop](generation-run-steps.md) — Этап
  2.7: durable step journal, `waiting_for_tool`, tool registry and loop guard.
- [Wire contracts](wire-contracts.md) — the 20-operation registry, envelopes
  and §6.1 HTTP/SSE transport mapping.
- [Operations inventory](operations-inventory.md) — wire-operation routing.
- [Runtime Kernel README](https://github.com/Disya123/NeoTavern/blob/main/crates/runtime-kernel/README.md) — kernel API
  and Phase 6 slice details.
- [Remote adapter README](https://github.com/Disya123/NeoTavern/blob/main/crates/adapters/remote-http/README.md) — SSE
  delivery and resume.
