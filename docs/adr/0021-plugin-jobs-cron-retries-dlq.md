# ADR-0021: Cron schedules, retry lifecycle and DLQ for plugin jobs (rev4 stage 5)

## Context

Background plugin tasks (`api.jobs`) supported only one-shot (`runAt`) and fixed-interval (`intervalMs`) modes, were dispatched fire-and-forget and deleted right after firing: a plugin could neither learn the processing result, nor restart a failed task, nor see that a task was failing systematically. Three gaps:

1. **No cron semantics** — "every day at 03:00" could only be expressed by the plugin computing `runAt` itself (drifting precision, breaks on restart).
2. **No retry** — a single network/service failure irreversibly lost the dispatch.
3. **No failure visibility** — a failed task vanished without a trace.

Alternatives:

1. **An external cron library** — forbidden by project rules (no external dependencies for local functions) and overkill for 5 fields.
2. **Client-side retry** — the plugin re-schedules the task itself on error. Requires each plugin to implement its own backoff logic, does not survive a sandbox crash (the dispatch was already sent, no answer) and gives no overall picture.
3. **Ack contract + server-side state machine + DLQ** (chosen) — the runner holds the task until explicit acknowledgment; backoff and the retry budget live on the server; the DLQ keeps failed tasks until a manual retry.

## Decision

1. **Cron**: a self-contained parser `apps/server/src/lib/cron.ts` (5 fields, UTC; `*`, numbers, ranges, steps, lists; dow 0–7). `nextRunAt` — the first match after now; after a successful ack the task advances to the next match. Modes are mutually exclusive (`JOB_SCHEDULE_EXCLUSIVE`).
2. **Ack lifecycle**: with `retries > 0` the dispatch atomically stores `dispatchAt` before publishing the event and does not move `nextRunAt` — even a fast ack sees the in-flight state, and the task cannot restart until the plugin answers `ack(jobId, {ok})`. `ok: true` → a one-shot is deleted, interval/cron advances, attempts reset. `ok: false` → `attempts + 1`, backoff `retryDelayMs · 2^(attempts−1)` (cap 1h), retry at `nextRetryAt`. A missing ack (5 minutes) — "ack-timeout": counted as a failed attempt (a sandbox crash does not block the task forever).
3. **DLQ**: budget exhaustion (`attempts > maxRetries`) → `status: 'failed'`, `lastError`, `failedAt`. DLQ tasks are excluded from the scan; `retry(jobId)` resets to `active` and dispatches on the next scan; `cancel`/`DELETE` removes from any state. Without `retries` the fire-and-forget behavior is preserved — backward compatibility.
4. **"retries" semantics**: the retry budget counts **after** the first failure — `retries: N` allows N retries and goes to the DLQ on the (N+1)-th failure.
5. **State consistency**: the task's JSON file is the single source of truth; runner, ack, retry and routes read/write it atomically. The clock is injectable (`now()`), `ackTimeoutMs` is a manager option (tests are deterministic without timers).

## Consequences

- The plugin gets an honest "dispatch — acknowledgment" contract: a task is either delivered (ack ok), retried with backoff, or visible in the DLQ with a reason. No state is silently lost.
- The runner does not depend on the sandbox's liveness: a crash after dispatch is recovered by the ack timeout.
- Cron tasks survive a server restart (`nextRunAt` is persistent) and need no external libraries.
- Cost: ~200 lines of parser, JobRecord fields, two REST routes, two kernel-RPCs, clock injection for tests.
- Backward compatibility: tasks without `retries` behave as before; existing `runAt`/`intervalMs`/`payload` fields are unchanged.

## Migration

No DDL. JobRecord fields are optional; old task JSON files are read as `status: 'active'`, `attempts: 0` (defaults). Rollback — remove the new fields from code; files remain readable.
