# ADR-0064 — Kernel-resident plugin executor with a durable job queue

**Status:** accepted (owner decision: kernel-resident). Queue + wire (round 55)
and the executor loop with secret injection (round 56) are implemented; execution
is still **off by default** — `RunnerOptions::enabled` is the kill switch, and the
checklist below is answered in "Security review checklist (closed)".
**Date:** 2026-11-04
**Supersedes:** nothing. **Related:** ADR-0038 (the Rust kernel owns product
state), ADR-0059 (React-primary), ADR-0061 (chunked ingestion),
`docs/architecture/host-surface-boundary.md` (the `plugins.jobs.host-queue`
surface this ADR eventually deletes), ТЗ §14.1 (plugin host), ТЗ §19 (provider
governor).

## Context

Plugin work today runs in the trusted host: the sandbox RPC queue
(`pluginJobs`: list/status/cancel/wait/logs/output) lives in the host process and
holds live handles, and the kernel is deliberately not a job runner. The cutover
registry records that as row 21(b), and `hostSurfaces.ts` marks
`plugins.jobs.host-queue` as `kernelMode: "unsupported"`.

Two problems follow from that split:

1. a job loses its identity when the host restarts — the queue is in-memory and
   the kernel has no durable record of scheduled work;
2. `plugins.secrets.*` and `plugins.state.*` have **no consumer inside the
   kernel**: they are product data with no executor that reads them, so a plugin
   secret can only ever be revealed to a human.

The owner chose the kernel-resident option over a host-owned executor: the kernel
schedules sandbox tasks and injects secrets itself. That is the larger change and
the one with the security question, so this ADR fixes the model before code.

## Decision

**The kernel owns the job queue and the scheduling decision; the worker that runs
plugin code is a thin runner the kernel drives.** Concretely:

- schema v33 `plugin_jobs` is the durable queue: one row per job with an opaque
  JSON payload (≤ 64 KiB, the KV quota), `attempts`, `max_attempts`, `run_at_ms`,
  a lease, and a bounded `last_error`;
- `plugins.jobs.enqueue|list|get|cancel` is the wire surface. **Claiming,
  leasing and completing never cross the wire** — a client cannot pose as a
  worker or steal a job, and a lease is an internal fact;
- `crates/plugin-executor` is the state machine (enqueue validation, ordering,
  leases, retry backoff, terminal states) with no I/O and no clock: the kernel
  passes `now_ms`, which makes every transition replayable and testable;
- the executor loop, when enabled, claims a job, resolves the plugin's grants,
  and only then opens a broker session for the secrets that job is allowed to
  read. It injects them into the running task through the broker seam — the
  secret value never enters a job row, a DTO, a log line or an error message.

## Invariants (enforced today)

1. **A job payload is opaque, bounded plugin JSON and is never a secret
   channel.** Enqueue validates it as JSON, caps it at 64 KiB, and stores it
   verbatim; the executor must not read secret material out of it.
2. **`attempts` counts leases, not failures.** Claiming increments it, so a
   worker that dies mid-run cannot retry forever by never reporting back; an
   expired lease returns the job to `queued` without refunding the attempt.
3. **Terminal states are terminal.** `succeeded`/`failed`/`cancelled` never move
   again; a late complete or a second cancel is a product error
   (`JOB_TERMINAL`), never a silent overwrite.
4. **Enqueue requires a real plugin row** (`PLUGIN_NOT_FOUND` otherwise), and a
   plugin may hold at most 256 outstanding jobs (`JOB_QUEUE_LIMIT`), so one
   plugin cannot monopolise the queue or create orphan work.
5. **Ordering is deterministic**: due jobs are claimed by
   `(run_at, created_at, id)`, so two hosts with the same queue claim in the same
   order. Retry backoff is exponential and jitter-free for the same reason; the
   lease, not jitter, prevents herd retries.

## Threat model of the secret path (the part under review)

The executor is the first component that would move secret material toward
plugin code. The risks it introduces, and the rule that answers each:

| Risk                                    | Rule                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret value persisted with the job     | Jobs store only `payload_json`; the broker session is opened at run time and dropped when the task ends. The queue has no column that can hold key material.                           |
| Secret leaked through logs/errors       | Adapter and executor errors are bounded single-line strings (`bounded_error`); the broker returns an opaque handle, and any message that embeds a value is a bug the tests must catch. |
| A plugin reads another plugin's secrets | The broker session is scoped to `(pluginId, scope, owner)` and requires the `secrets.reveal` grant recorded at install; the queue row's `plugin_id` is authoritative, not the payload. |
| A rogue worker claims jobs              | Claiming is `pub(crate)` in the kernel, not a wire op; there is no remote claim path to authenticate.                                                                                  |
| Replay of a finished job                | Terminal states refuse transitions; a retry is a NEW row, never a resurrection.                                                                                                        |
| Queue as exfiltration storage           | 64 KiB payload cap, 256 outstanding jobs per plugin, uninstall cascades (`ON DELETE CASCADE`).                                                                                         |

## What is implemented by this ADR

- schema v33 + migration, `CURRENT_SCHEMA = 33`;
- `crates/plugin-executor` (state machine, 7 unit tests);
- `plugins.jobs.enqueue|list|get|cancel` (158 wire ops) with product codes
  `PLUGIN_NOT_FOUND`, `JOB_NOT_FOUND`, `JOB_TERMINAL`, `JOB_PAYLOAD_INVALID`,
  `JOB_PAYLOAD_TOO_LARGE`, `JOB_ATTEMPTS_INVALID`, `JOB_QUEUE_LIMIT`,
  `JOB_TIMESTAMP_INVALID`;
- kernel-internal `claim_next`/`complete` (not wired to any loop yet);
- 7 integration tests in `crates/runtime-kernel/tests/plugin_jobs.rs`.

## Security review checklist (closed, round 56)

Each item is answered. The answers are implemented in
`crates/runtime-kernel/src/plugin_runner.rs` and pinned by
`crates/runtime-kernel/tests/plugin_runner.rs` (6 cases), except where a host
adapter still owes an integration (marked _host_).

1. **Broker contract.** `SecretAccess::reveal(key) -> Result<String, KernelError>`
   is the only handle a handler gets; it is a `&mut dyn SecretAccess` bound to the
   job's `plugin_id`, created per job and dropped when the handler returns. There
   is no session object to store, no `Clone`, no serialization: a handler can copy
   the returned `String` (it is trusted code), but the _queue_ cannot retain it —
   the runner never writes the value anywhere.
2. **Grant evaluation.** Every `reveal` calls
   `plugin_secrets::resolve_for_executor`, which re-runs `authorize` (the
   `secrets.reveal` grant from `plugins.permissions_json`) on **each** call. A
   grant revoked mid-run therefore fails the next reveal with
   `PLUGIN_PERMISSION_DENIED`; an uninstalled plugin fails with
   `PLUGIN_NOT_FOUND`. The scope is fixed to `user` (no owner argument), so a
   payload cannot smuggle an owner id to reach another scope. `storage.<scope>`
   is not consulted by the executor: jobs do not read KV state, handlers that need
   it call the wire ops like any other client.
3. **Process boundary.** The kernel does not run plugin JavaScript. A handler is a
   _trusted Rust adapter_ registered by the host; untrusted plugin code stays in
   the host sandbox, and the adapter decides how a revealed value crosses into
   it. Consequence, stated plainly: a hostile handler is equivalent to a hostile
   host, so the boundary is the host's, not the kernel's — which is why the
   sandbox contract remains the host's responsibility and this ADR does not
   pretend to isolate kernel-side code.
4. **Audit trail.** The job row is the record: one row per job, `attempts` per
   lease, `updated_at` per transition, bounded `last_error`. The runner records
   no key names and no values; a handler that wants a line writes it through its
   own sink, and `bounded_error` strips newlines and truncates to 500 chars so a
   provider message cannot smuggle a payload. _(host: wiring the sink is the
   adapter's task.)_
5. **Kill switch.** `RunnerOptions::enabled = false` (the default) makes
   `run_due` claim nothing and return `skipped`. Data is untouched: jobs stay
   `queued`, leases expire back to `queued`, and turning the flag back on resumes
   from the same rows. No env var is read inside the kernel — the host passes the
   option, so the switch cannot be flipped by a stray environment.
6. **Leak tests.** `plugin_runner` tests assert that after a run with a real
   secret: the revealed value is what the handler saw; `payload_json` and
   `last_error` do not contain it; and a job without the grant fails with
   `PLUGIN_PERMISSION_DENIED` while exposure-disabled fails with
   `SECRETS_EXPOSURE_DISABLED`. A DTO-level scan is unnecessary because the
   executor has no wire surface for values (the only value-returning op remains
   `plugins.secrets.reveal`).

Residual risk accepted by this round: a handler is trusted code, and the sandbox
boundary is the host's. The ADR therefore does NOT claim that kernel execution
isolates plugin code — it claims the queue, the grants and the leak surface are
kernel-owned and tested.

## Round 56 implementation note

`crates/runtime-kernel/src/plugin_runner.rs` drains the queue sequentially (one
writer connection; parallelism belongs to the adapters the handler dispatches to)
and returns `RunReport { claimed, succeeded, failed, skipped }`. The loop is not
yet called from the writer thread: the host adapter is expected to call
`plugin_runner::run_due` on its own cadence with its handler, which keeps the
kernel free of an execution policy (how often, how many, which kinds). Wiring the
Tauri adapter is the next round; until then jobs accumulate exactly as in round
55, and nothing regresses.
