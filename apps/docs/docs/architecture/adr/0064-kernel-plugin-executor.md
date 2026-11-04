---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0064-kernel-plugin-executor.md
---

# ADR-0064 — Kernel-resident plugin executor with a durable job queue

**Status:** accepted (owner decision: kernel-resident). Queue + wire implemented
(round 55); the worker loop and secret injection are **not** enabled until the
security review checklist at the end of this document is signed off.
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

## Security review checklist (blocks enabling execution)

The worker loop stays off until each item is answered in writing on this ADR:

1. **Broker contract**: the exact API by which the executor hands a secret to a
   task, and why the task cannot retain it after the call.
2. **Grant evaluation**: where `secrets.reveal` and `storage.<scope>` are checked
   for a job, and what happens when the grant is revoked mid-run.
3. **Process boundary**: whether the task runs in a separate process/isolate; if
   not, what prevents it from reading kernel memory.
4. **Audit trail**: which events are recorded when a secret is injected
   (plugin, job, key name, timestamp — never the value).
5. **Kill switch**: how an operator disables execution without deleting data
   (the queue keeps `queued` jobs; the runner is what stops).
6. **Test plan for leaks**: a test that inspects job rows, DTOs and logs after a
   run and asserts no secret value appears.

Until then `plugins.jobs.*` is a durable queue with no runner: jobs accumulate as
`queued`, and `hostSurfaces.ts` keeps `plugins.jobs.host-queue` as the host's
surface for live execution.
