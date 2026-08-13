---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0027-plugin-node-universal-runtime.md
---

# ADR-0027: Node Universal Runtime — Worker-per-plugin, separate Plugin Runtime process, and a compat path

Date: 2026-08-08. Status: Accepted.
Related documents: [ADR-0007](0007-plugin-runtime-isolation.md), [ADR-0026](0026-plugin-resource-governor.md).

## Context

The Node Universal Runtime design fixes the backend-runtime architecture:

- one backend plugin does NOT mean a separate Node.js process;
- one active backend plugin gets a separate Worker (a separate V8 isolate and JS heap);
- plugin code runs only inside a SES Compartment after `lockdown()`;
- the security boundary is Worker isolate + SES `lockdown()` + Compartment + object-capability API + a separate Plugin Runtime process, not the Node Permission Model;
- Main Host and Plugin Runtime are always in different processes; a Plugin Runtime crash does not take down the Main Host;
- the same JavaScript runtime for sandbox/extended/trusted; the trust level changes the set of capabilities, not the execution engine.

The current implementation (rev4, apiVersion 2) uses process-per-plugin: `apps/server/src/plugin/backendHost.ts` spawns a separate Node process per plugin with the Node Permission Model and a hand-rolled ESM loader as the primary boundary (`apps/server/worker/plugin-worker.mjs`, `plugin-loader.mjs`). SES is absent; plugin code runs via `await import(entry)`. This ADR fixes the target topology and the compatibility strategy.

## Decision

### 1. Target topology

```text
NeoTavern Main Host (Node.js)
  └─ NeoTavern Capability Broker
       └─ framed IPC ──► NeoTavern Plugin Runtime (separate Node.js process)
                            ├─ Worker A ─ SES Compartment A ─ Plugin A
                            ├─ Worker B ─ SES Compartment B ─ Plugin B
                            └─ ...
```

- The Main Host owns the Broker (grants/revoke/consent), HTTP/SSE, diagnostics, and supervision of the Runtime process.
- The Plugin Runtime owns the Workers: blank-hardened pool, Startup Coordinator, two-phase termination, restart, telemetry (see ADR-0026).

### 2. The new runtime — a separate component

- New package `apps/plugin-runtime`: process entry `neotavern-plugin-runtime`, trusted worker-bootstrap (two-phase bootstrap: trusted import of primitives → `lockdown()` → bridge → Compartment), Worker supervisor.
- Main Host ↔ Runtime protocol — framed IPC (hot header, frame types, ErrorEnvelope) in `packages/contracts`; Runtime ↔ Worker — MessagePort + transferable ArrayBuffer.
- Dependencies: `ses`, `@endo/module-source`, `@endo/compartment-mapper` (version-pinned, pure JS).
- The Main Host gets a Runtime client that fully replaces the existing `backendHost.ts` path for apiVersion 3.

### 3. Compat path: rev4 (apiVersion 2) in parallel

- The rev4 backend runtime (apiVersion 2) keeps working and stays available until full replacement. No existing v2 plugins break or migrate automatically.
- Switching by `manifest.apiVersion`:
  - apiVersion 2 → the existing process path (untouched);
  - apiVersion 3 → the new Node Universal Runtime.
- Stage A (prototype) runs in parallel mode; the rev4 path stays the default until the go/no-go checks pass.

### 4. Status of ADR-0007

ADR-0007 is superseded in the backend-runtime part: isolation through a separate permission-limited Node process is replaced by the Worker + SES Compartment model inside the Plugin Runtime. Process isolation is retained (Runtime is a separate process), but the primary boundary becomes SES, not the Node Permission Model. The frontend part of ADR-0007 (sandboxed iframe, legacy trusted) is preserved unchanged.

## Alternatives

- **Keep process-per-plugin + Permission Model (rev4).** Rejected: the Permission Model is disallowed as the primary boundary; there are no parent-side Worker APIs (`cpuUsage`/`getHeapStatistics`/`ELU`) — CPU runaway on Windows/macOS is not detectable; each plugin drags a whole process (RSS/start overhead).
- **Use `node:vm`.** Forbidden (not a security mechanism).
- **Everything in one process without Workers.** Rejected: a plugin crash takes down the host; no isolate isolation and no parent-side telemetry.
- **Immediate switch without a compat path.** Rejected: breaks existing v2 plugins; a parallel path is needed until full replacement.

## Consequences

- New package `apps/plugin-runtime` + protocol contracts in `packages/contracts`; `backendHost.ts`/`plugin-worker.mjs` remain only for apiVersion 2 and are then moved into the compat layer.
- Economics: Worker per plugin gives a V8 isolate with less overhead than a process; parent-side telemetry and Runtime restart become possible.
- Documentation: manifest apiVersion 3, trust levels, capability catalog; the ADR index is updated.
- Compatibility: public contracts of v2 plugins do not change; a migration guide for v2→v3 will appear together with manifest apiVersion 3 (stage B).

## Migration

No DDL. Internal restructure: the new Runtime process is introduced in parallel with the rev4 path; switching by `manifest.apiVersion`; the rev4 path is removed only after full replacement and passing the benchmark set. Rollback — switch back to the v2 path without data loss.
