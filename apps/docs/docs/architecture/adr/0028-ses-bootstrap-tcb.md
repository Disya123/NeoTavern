---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0028-ses-bootstrap-tcb.md
---

# ADR-0028: SES bootstrap and the Trusted Computing Base (two-phase bootstrap, lockdown policy, endowment list)

Date: 2026-08-08. Status: Accepted.
Related documents: [ADR-0027](0027-plugin-node-universal-runtime.md), [ADR-0026](0026-plugin-resource-governor.md).

## Context

The Worker bootstrap must be minimal, deterministic, and fully controlled by NeoTavern (see ADR-0027). Everything executed before `lockdown()` is part of the TCB: plugin code, its dependencies, marketplace code, generated code, preload modules, code via `--require`/`--import`/`NODE_OPTIONS`, and custom loaders. The design fixes:

- the two-phase bootstrap order of 9 steps;
- the whitelist of loads before `lockdown()`;
- the production lockdown policy;
- the rules for `Compartment.globalThis`;
- hardening of the Worker constructor;
- the ban on inspector/preload in production;
- the rule never to reuse a Worker between plugins.

The current code (`apps/server/worker/plugin-worker.mjs`) does not call `lockdown()` and executes the plugin via `await import(entry)` — forbidden; the plugin gets the Node authority of the process.

## Decision

### 1. Two-phase bootstrap

Trusted `apps/plugin-runtime/worker-bootstrap.mjs` executes strictly in order:

```text
1. Node starts fixed trusted worker-bootstrap.mjs
2. import/capture strictly required Node primitives
3. import SES
4. call lockdown()
5. initialize hardened NeoTavern bridge
6. construct plugin Compartment
7. install vetted compatibility endowments
8. load validated signed module graph
9. invoke plugin entrypoint
```

Before `lockdown()` it is forbidden to execute plugin code, plugin dependencies, marketplace code, generated plugin code, arbitrary preload modules, APM/monitoring agents, user-controlled `--require`/`--import`, custom Node loaders, and code from `NODE_OPTIONS`. Any JavaScript executed before `lockdown()` is considered part of the TCB.

### 2. What may be loaded before lockdown

Only version-pinned audited bootstrap dependencies:

```text
node:worker_threads
node:perf_hooks
node:v8
minimal Node timer primitives
minimal text/url primitives for vetted wrappers
SES initialization
NeoTavern bootstrap code
```

A shim between `repairIntrinsics()` and `hardenIntrinsics()`, if one is ever needed: part of NeoTavern, a separate security review, version-pinned, not shipped with a plugin package, and not selectable by a plugin manifest. Plugin-specific pre-lockdown shims are forbidden.

### 3. Lockdown policy

Production default:

```ts
lockdown({
  errorTaming: 'safe',
  overrideTaming: 'moderate',
  consoleTaming: 'safe',
});
```

`overrideTaming: "severe"` as a default is forbidden; allowed only after a separate security ADR for a specific problem. `errorTaming: "unsafe-debug"` — local developer mode only.

### 4. Compartment global

- Shared JavaScript primordials stay hardened/frozen.
- The plugin's `Compartment.globalThis` does not have to be fully frozen: one Worker serves exactly one plugin trust domain, so plugin-owned code may create its own globals but must not mutate shared intrinsics (`Object.prototype`, `Array.prototype`, `Function.prototype`, `Promise.prototype`, and others).
- Privileged Node authority is never placed into a mutable plugin global.

### 5. Hardening the Worker constructor

Every plugin Worker is created only from the fixed `TRUSTED_BOOTSTRAP`:

```ts
new Worker(TRUSTED_BOOTSTRAP, {
  argv: [],
  execArgv: [],
  env: minimalWorkerEnvironment,
  eval: false,
  trackUnmanagedFds: true,
  stdin: false,
  stdout: true,
  stderr: true,
  resourceLimits: dynamicEmergencyLimits,
});
```

- `worker.SHARE_ENV` is forbidden.
- Not passed into the Worker environment: `NODE_OPTIONS`, Main Host secrets, OAuth tokens, provider keys, database credentials, unrelated NeoTavern env, debugger/preload settings.
- `workerData` contains only small immutable bootstrap identifiers: `workerId`, `workerEpoch`, `pluginId`, `installationId`, `moduleGraphDigest`. The plugin source/module graph is not passed through `workerData` (a structured clone is copied at Worker creation).

### 6. Inspector and preload

Production Plugin Runtime and plugin Workers are not started with `--inspect`/`--inspect-brk`/`--require`/`--import`/custom loader/arbitrary V8 flags from the environment. The Main Host clears `NODE_OPTIONS` when spawning the Plugin Runtime. Attaching a debugger to a production Plugin Runtime is considered a security boundary violation.

### 7. Worker reuse rule

- `blank-hardened`: passed the trusted bootstrap and `lockdown()`, never executed plugin code; can be assigned to exactly one plugin.
- `plugin-warm`: permanently bound to a plugin installation/epoch.
- A Worker that executed Plugin A MUST NOT return to the blank pool and MUST NOT be used for Plugin B; it is destroyed on final unload.

### 8. Vetted endowment list

The Compartment receives only vetted endowments:

```text
console              -> BoundedConsoleSink
TextEncoder/TextDecoder
URL / URLSearchParams
AbortController / AbortSignal
queueMicrotask
```

NOT endowed: `process`, `require`, `Buffer`, `fetch`, `WebSocket`, `Worker`, `SharedArrayBuffer`, raw `WebAssembly`, ambient `setTimeout`/`setInterval` (timers go through the host registry). Randomness goes through a vetted wrapper.

## Alternatives

- **Run the plugin as a plain Node ESM (`await import(entry)`)** — current rev4. Rejected: the plugin gets the Node authority of the process.
- **`overrideTaming: "severe"` as the default.** Rejected.
- **Fully freezing `Compartment.globalThis`.** Rejected: not required with one trust domain per Worker and breaks compatible libraries.
- **Passing the module graph via `workerData`.** Rejected.

## Consequences

- Trusted bootstrap in `apps/plugin-runtime/worker-bootstrap.mjs`; the endowment contract is versioned and covered by tests (DoD: the Compartment globals compatibility profile is versioned and tested).
- Dependencies: `ses`, `@endo/module-source`, `@endo/compartment-mapper` (version-pinned, pure JS) — only in `apps/plugin-runtime`.
- Security tests: B16 (module escape), the plugin has no Node authority, bootstrap order (plugin-world code is not executed before `lockdown()`), B28 (execArgv/env injection).
- Goes live together with Stage A (ADR-0027); the rev4 path is unaffected.

## Migration

No DDL. New component. Rollback — switch to the v2 path (ADR-0027) without data loss.
