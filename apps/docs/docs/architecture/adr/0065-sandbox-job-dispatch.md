---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0065-sandbox-job-dispatch.md
---

# ADR-0065 — Sandbox job dispatch for kernel-scheduled plugin jobs

- **Status:** accepted (implementation in progress, g1)
- **Context:** ADR-0064 made the kernel the job queue and the executor owner:
  `plugin_jobs` (schema v33) holds the durable queue, `plugin_runner::run_due`
  claims jobs with a lease and calls a host-supplied `PluginJobHandler`. The
  handler seam exists, but the desktop host has nothing to plug into it: a plugin
  job's effect happens inside the plugin sandbox (the JS runtime in
  `apps/plugin-runtime`), which the Rust host cannot call synchronously.

## Decision

Dispatch is a three-party round trip, and each party owns exactly one thing:

1. **the kernel owns time and state.** A host timer calls `run_due` on a fixed
   cadence (default 1 s, `RunnerOptions::enabled` off unless the host opts in).
   The claim, the lease, the attempt counter and terminal states stay in
   `plugin_jobs`; nothing about scheduling moves to the host.
2. **the host owns transport.** The desktop `PluginJobHandler` does not execute
   the job. It emits one Tauri event to the webview (`plugin.job.due`, carrying
   `{ jobId, pluginId, kind, payloadJson, attempts }`) and returns immediately
   with a _deferred_ result.
3. **the sandbox owns the effect.** The web host bridge (`plugins/kernel/jobs.ts`)
   already relays due events into `jobs.run`; it gains the other half: after the
   sandbox answers, it calls the Tauri command `plugin_job_report` with
   `{ jobId, ok, error? }`. That command is host-only (never wire): a client that
   could report completion would be able to mark work done without running it,
   which is exactly why `plugins.jobs.claim`/`complete` are not wire operations.

The kernel therefore never waits on a webview. A job whose report never arrives
stays leased until the lease expires; the scheduler then retries it per
`max_attempts` and finally fails it with `LEASE_EXPIRED`. That is the same
crash-safety the sync handler had, expressed as a timeout instead of a panic.

## Consequences

- **Secret model unchanged.** The kernel resolves secrets at dispatch time (one
  key per `reveal`, `user` scope, `secrets.exposure` gate,
  `SECRETS_EXPOSURE_DISABLED` when off) and ships values in the event payload
  only for keys the job declares — the sandbox never queries the broker directly.
- **Ordering is unchanged.** Claim order stays `(run_at, created_at, id)`;
  dispatch order is therefore queue order, not sandbox scheduling order.
- **Failure attribution.** A sandbox exception and a missing report are different
  outcomes: the first is an immediate `failed` with the bounded message, the
  second is a lease expiry. Both are visible in `PluginJobDto.lastError`.
- **Kill switch.** `RunnerOptions::enabled` stays `false` in tests and in the
  headless build; the desktop shell enables it through one host setting, so a
  packaged build can ship with scheduling off without a code change.
- **No wire surface grows.** The event is a host-local Tauri event, the report is
  a host-local command, and the queue remains the only durable record.

## Implementation note (round 70)

Round 72 wired the three parties: `spawn_plugin_job_timer` claims through
`KernelHost::claim_plugin_job` when `NEOTA_PLUGIN_JOBS` is truthy, emits
`plugin.job.due` to the webview, and the host-only `plugin_job_report` command
applies the sandbox's answer. The web side registers the Tauri event in the
plugin runtime (same delivery path as kernel app events) and `jobs.ts` reports
success or the bounded error message. Round 77 emits on `plugin-job-due`, not
`plugin.job.due`: Tauri rejects dots in event names (`IllegalEventName`), a defect
the packaged walk found immediately.

Packaged proof (round 77): `run_plugin_dispatch_smoke`
(`apps/desktop/src-tauri/src/lib.rs:250-372`) runs in the portable artifact when
`NEOTA_PLUGIN_DISPATCH_SMOKE=1` — enqueue over the wire, timer claim, emitted
event, host report, `plugins.jobs.get` reads `succeeded`, and a drained queue
hands out no second claim. The listener there is Rust standing in for the webview;
the webview half (sandbox `jobs.run`, then `invoke('plugin_job_report')`) is
covered by `apps/web/src/plugins/kernel/jobs.test.ts`, and both halves meet on the
same event payload and command contract.

Round 71 added the handle path the timer will use: internal `ClaimPluginJob` /
`ReportPluginJob` commands and `Kernel::claim_plugin_job` / `report_plugin_job`,
so a host never borrows the writer's database. Round 70 landed the seam itself:
`plugin_jobs::claim_for_host` returns a
`ClaimedJob` (id, plugin, kind, payload, attempt, max attempts — no lease), and
`plugin_jobs::report_from_host` applies an outcome to a leased job, refusing a
report that names an older attempt as `JOB_LEASE_STALE` and a terminal job as
`JOB_TERMINAL`. Four integration tests (`plugin_host_dispatch`) pin the promises:
a claim leases and cannot be stolen, a success clears the lease, a stale report is
refused and leaves the row leased, and a terminal job refuses a second report.

## Open item (tracked as g1)

The Tauri timer, the `plugin.job.due` emission, the `plugin_job_report` command
and the packaged-smoke step (`run_golden_smoke` enqueues a job, waits for the
sandbox relay, asserts the terminal state) are the remaining work of this ADR.
Until they land, `plugins.jobs` stays `Packaged` for enqueue/list/cancel and the
executor stays disabled, which is the honest state: nothing schedules jobs yet.
