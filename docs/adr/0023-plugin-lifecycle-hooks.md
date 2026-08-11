# ADR-0023: Host-driven lifecycle hooks for plugins (rev4 stage 7, §J2)

## Context

Before rev4 stage 7, the plugin lifecycle was visible to the plugin at only two points: `activate(api)` on frame load and `deactivate()` on unmount. Gaps:

1. **Update is invisible** — installing a new version over an active plugin gave no warning (`beforeUpdate`), no confirmation (`afterUpdate`), and no rollback notification (`rollback`). State could not be finalized (closing resources, resetting local caches) before the file swap, nor recreated after it.
2. **No suspend/resume** — a hidden tab kept working (rAF, network), even though Chromium throttles it anyway; the plugin could not deliberately pause heavy work.
3. **Uninstall is indistinguishable from a crash** — `uninstall` was no different from any other frame unmount.

Alternatives:

1. **Wait for hooks with a blocking server state machine** — the plugin could get stuck forever (a deadline would still be needed), and a failing hook would block install/uninstall. This contradicts invariant 8 (explicit degradation) and "the host never waits for the plugin".
2. **Pull model** — the plugin polls `api.runtime.state()` itself. Races (a hook arriving after a state change), reaction latency, extra code in every plugin.
3. **Best-effort host-driven RPC** (chosen) — the host delivers hooks over the existing kernel port (`lifecycle.hook` RPC, 1500 ms deadline, `{handled}` response); the host state machine does not depend on the result.

## Decision

1. **Hook set**: `activate(api)` (required, full api) plus optional `suspend`/`resume`/`beforeUpdate`/`afterUpdate`/`rollback`/`uninstall`, set by the plugin on the definition. Capability is probed via `api.runtime.supports('lifecycle.hooks', 1)`.
2. **Delivery**: the server emits SSE events `plugin.updating` → `plugin.updated` / `plugin.rollback` around the atomic swap of the package directory (rollback restores the previous version and reactivates the backend without masking the original error). The web runtime maps the events to RPCs: `beforeUpdate`, `afterUpdate`, `rollback`, `uninstall` (+ `suspend`/`resume` on `visibilitychange` for all live frames). The events are added to the SSE whitelist, the TanStack invalidation, and the whitelist test.
3. **Best-effort contract**: RPC with a deadline; a missing/failed hook → `{handled: false}`; the host continues the state machine. No install/uninstall blocking on plugin code.
4. **Ordering with teardown**: frame replacement on update waits for the settlement of the last hook (bounded: the 1500 ms RPC deadline) before closing the session port — a hook's async writes (KV, blobs, backend) are not cut off mid-word by port closure. Without this, `afterUpdate` delivered to a still-alive old sandbox lost its final `kv.set`: `neotavern.plugin.deactivated` from the sandbox instantly finalized the teardown, and the port closed before the response arrived.
5. **Plugin integration point**: hooks live on the definition; the KV log is persistent proof of ordering after a restart (sample `plugins/rev4-lifecycle`).

## Consequences

- The plugin sees the full lifecycle: activation, visibility-based suspension, update (before/after), rollback, uninstall — with persistent finalization capabilities.
- The host does not depend on the plugin: any hook may be missing, fail, or hang — the host state moves on, the deadline trims the tails.
- Test base: server `events.spec.ts` (SSE frame ordering updating/updated/uninstalling), web `runtime.test.ts` (round-trip, degradation, suspend-all/resume-all, visibilitychange), e2e (update to v2 → hooks in the persistent KV log).
- Cost: 4 events in the whitelist/invalidation, one kernel RPC + sandbox handler, ~40 lines of runtime mapping, teardown wait for the last hook, a sample plugin.

## Migration

No DDL and no change to public contracts: hooks are optional, `lifecycle.hooks` is a new feature flag (existing plugins are not required to support it). Rollback — removal of the event mapping and the teardown wait; old plugins work unchanged.
