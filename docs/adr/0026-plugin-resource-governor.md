# ADR-0026: Resource boundaries as an emergency boundary, parent-side telemetry, and Plugin Runtime restart

Date: 2026-08-08. Status: Revised.
The previous version ("Resource Governor, OS isolation and scheduler fairness") was rewritten to align with the Node Universal Runtime model: the resource-policy and SLO sections of the vNext design.

## Context

The previous model built protection on fixed small per-plugin quotas: `maxActiveBackends=5`, per-plugin RSS hard 192 MiB, CPU 1 core, idle timeout 60–90 s, `light/standard/heavy` profiles. Such values are explicitly forbidden as a default policy:

```text
maxActivePlugins = 5
pluginMemory = 192 MiB
pluginCPU = 1 core
heavyConcurrency = 1
networkPerPlugin = 3
jobsGlobal = 2
idleTimeout = 60s
light/standard/heavy hard profiles
```

The governing rule:

```text
resource physically available -> useful plugin may use resource
```

A legitimate plugin doing >1 GiB of useful work (B05) or using both cores (B07) must not be killed by a default quota. Resource limits are only emergency boundaries against runaway, not a user-visible performance plan.

At the same time, protection against real runaway remains mandatory: a bad plugin must not crash the Main Host (OOM) or monopolize CPU with no way to interrupt it. That is the task of this ADR.

## Decision

### 1. Fixed quotas are abolished

- No default `maxActiveBackends`/`maxWarmBackends` quotas, no RSS hard 192 MiB, no CPU = 1 core, no forced idle timeout. A Worker is unloaded only by the adaptive cache policy, an update/security event, or resource pressure.
- Node Worker `resourceLimits` are used only as an emergency boundary and are computed dynamically from headroom: physical RAM, current available memory, Main Host RSS, Plugin Runtime RSS, number of active Workers, the plugin's memory hint, and recent historical usage.
- If a legitimate plugin needs more heap and the system has sufficient headroom, the Worker is recreated with a higher emergency ceiling.
- The same small value is not applied to all plugins.

### 2. Telemetry: parent-side observation

- The trusted bootstrap inside the Worker periodically collects `heapUsed`, `heapTotal`, `external`, `arrayBuffers`, event loop utilization, and CPU. The plugin gets no API that would allow faking these metrics.
- Cooperative reporting alone is insufficient: an infinite loop blocks the Worker's event loop. The supervisor additionally uses external Worker APIs: `worker.getHeapStatistics()`, `worker.cpuUsage()`, `worker.performance.eventLoopUtilization()`, so observation works even when the guest event loop is unresponsive.
- Read-only `/proc/<pid>` and cgroup v2 remain sources for process-tree RSS on Linux; on Windows/macOS the primary sources are the parent-side Worker APIs, and the Worker's IPC usage report is supplementary, not the only one.
- Attribution does not pretend false precision: the UI distinguishes attributed heap, attributed external/ArrayBuffer, Broker-owned bytes, and estimated/shared process memory. If process RSS grows but the culprit cannot be reliably determined — action per item 4, not killing the largest Worker.

### 3. Runaway detection and two-phase termination

Runaway (memory or CPU) is determined by a combination of signs and progress, not a single heartbeat:

```text
retained heap grows
external/arrayBuffer memory grows
GC frees memory poorly
no proportional declared workload progress
Plugin Runtime/system approaches the emergency boundary
```

Action sequence on runaway:

```text
1. Main Host invalidates workerEpoch
2. Broker rejects new calls from the old epoch
3. Broker closes/cancels owned privileged handles
4. Runtime sends a cooperative CANCEL if possible
5. Runtime calls worker.terminate()
6. await Worker exit
7. if the Runtime itself is stuck -> kill/restart the Plugin Runtime process
```

`worker.terminate()` is not the moment of security revoke; revoke happens logically in steps 1–3. Every frame carries `runtimeEpoch/workerId/workerEpoch/requestId`; late responses from an old epoch after a restart are ignored. Error codes: `PLUGIN_MEMORY_RUNAWAY`, `PLUGIN_CPU_RUNAWAY`.

### 4. If the culprit cannot be determined — restart Plugin Runtime

When Plugin Runtime RSS grows, the culprit cannot be reliably attributed, and OOM approaches — the action is to restart the whole Plugin Runtime, not kill the largest Worker. The Main Host survives a Runtime crash and restores plugins on demand. Heap snapshots under memory pressure are not taken automatically — the snapshot itself can consume memory and block the isolate.

### 5. Leases and checkpoint

A CPU watchdog will not see `await new Promise(() => {})`: such a handler barely spends CPU and never completes. Every top-level invocation has `invocationId`, `workerEpoch`, start time, caller deadline, wall-clock lease, last progress, in-flight broker operations, and an AbortSignal. A long-running operation calls `api.runtime.checkpoint()` — confirmed progress extends the renewable activity lease; mere existence of a heartbeat lease does not extend it. On cancel — signal abort, cancel invocation-owned handles, reject late privileged calls, grace period, and only then terminate the stuck Worker. Uncaught exception — Worker-fatal; unhandled rejection — deterministic policy through a bounded fatal diagnostic path.

### 6. Scheduler — work-conserving

Priority classes: `interactive-host / generation / foreground-plugin / background-plugin / maintenance`. The scheduler is work-conserving: with no contention a task uses free CPU, there are no fixed slots; idle CPU caused by a fixed slot is not allowed. A CPU-heavy plugin may use both vCPUs through several Worker compute tasks when the host is free.

### 7. SLO and benchmark gates

The vNext numbers are regression gates, not quotas: Host + idle Runtime ≤650 MiB RSS p95; 30 installed ≤80 MiB delta; 15 enabled cold = 0 Workers; idle CPU ≤3%; warm activation p95 ≤150 ms; small Broker call p95 ≤20 ms; 1 GiB stream with bounded RSS without payload copies; 24h RSS drift ≤128 MiB; orphan Worker 0; Runtime crash → Main Host lives; infinite loop → offending Worker terminated. Incremental RSS per blank Worker / per realistic plugin Worker is measured by a prototype and becomes a regression metric, not a kill quota.

## Consequences

- Uncommitted work from the previous ADR version (resource presets in `config.ts`, fixed kill thresholds in `resourceGovernor.ts`, `resourceProfile.ts`) is NOT introduced as-is. Kept: monitoring (`/proc`, cgroup v2 read-only), machine-readable reasons, the pressure ladder as adaptive decisions, telemetry for diagnostics. Kill thresholds and profile numbers are recalculated per the emergency-boundary + headroom model.
- A move to Worker Threads is mandatory: parent-side Worker APIs (`cpuUsage`, `getHeapStatistics`, `ELU`) are unavailable with process-per-plugin (see ADR-0027).
- Codes: `PLUGIN_MEMORY_RUNAWAY`, `PLUGIN_CPU_RUNAWAY`, `SYSTEM_RESOURCE_PRESSURE` are added; `RESOURCE_PRESSURE`/`RESOURCE_LIMIT_EXCEEDED` remain retryable.
- This ADR describes only the emergency boundary; the overall resource philosophy is defined by the Node Universal Runtime design (ADR-0027).

## Migration

No DDL. Code restructure per the Node Universal Runtime stage A: a Worker supervisor in `apps/plugin-runtime`, dynamic emergency ceiling from headroom, parent-side telemetry, two-phase termination, Plugin Runtime restart. The existing fallback monitoring (proc, cgroup read-only) moves into the new supervisor. Compatibility: rev4 (apiVersion 2) stays the working path until full replacement (ADR-0027); rollback — switch back to the v2 path without data loss.
