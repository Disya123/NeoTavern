# Host-surface boundary (plugin host)

The Product Wire is the canonical contract for product **data**. A small set of
plugin capabilities is not product data at all — it is the trusted **host**:
package verification, the live runtime switch, OAuth token storage and the
sandbox session. Those capabilities never enter the wire, so they need their own
explicit, auditable boundary instead of hiding inside a transport module.

Source of truth: [`apps/web/src/api/hostSurfaces.ts`](../../apps/web/src/api/hostSurfaces.ts)
(`HOST_SURFACES`). This page explains the table; the registry is the contract.

## Surfaces

| Id                                | Legacy route                    | Method | Why it is host-owned                                                                                                                             |
| --------------------------------- | ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugins.install.host-verify`     | `/plugins/install`              | POST   | The kernel `plugins.install` op requires the host to have already verified signature/digest and ZIP traversal (SEC-05). A browser cannot verify. |
| `plugins.install.git.host-verify` | `/plugins/install-git`          | POST   | Fetching a Git archive is an outbound operation of the trusted host and needs the same verification.                                             |
| `plugins.safe-mode.enter`         | `/plugins/runtime/safe-mode`    | POST   | Safe mode toggles the execution plane (worker pool + sandbox frames); the kernel owns data, not execution.                                       |
| `plugins.safe-mode.exit`          | `/plugins/runtime/safe-mode`    | DELETE | Same switch (exit path).                                                                                                                         |
| `plugins.auth.connections`        | `/plugins/:id/auth/connections` | GET    | OAuth tokens live in the host secret store and never leave it; Product Wire models plugin state and secrets, not third-party sessions.           |
| `plugins.auth.connect`            | `/plugins/:id/auth/connect`     | POST   | Starts a browser OAuth flow whose redirect endpoint is the host (state/PKCE).                                                                    |
| `plugins.auth.revoke`             | `/plugins/:id/auth/revoke`      | POST   | Revocation must delete a host-held token; the kernel never has a copy.                                                                           |
| `plugins.auth.sandbox-session`    | `/plugins/:id/auth`             | POST   | The rev4 sandbox broker reads/service-starts OAuth flows; tokens stay host-side, the browser flow is a host endpoint.                            |
| `plugins.auth.fetch-proxy`        | `/plugins/:id/auth/fetch`       | POST   | An authenticated `network.fetch` must inject the token server-side (rev4 §K5); the kernel is not an HTTP client for plugin credentials.          |
| `plugins.jobs.host-queue`         | `/plugins/:id/jobs`             | POST   | The scheduler (timers, retries, DLQ, worker) is the trusted host's in-process queue; the kernel is deliberately not a job runner.                |

## Rules

1. **One boundary file.** A legacy plugin-host route is called from
   `hostSurfaces.ts` and nowhere else. The cutover registry rows 19/20/21a point
   here instead of at scattered transport helpers.
2. **Fail closed on the kernel plane (ARC-02).** Every registry entry is
   `kernelMode: "unsupported"` today, and every exported call throws
   `UnsupportedError` whose `feature` is the registry id — never a silent
   request to a sidecar route that does not exist in kernel mode. The error is
   traceable to one row of the table above.
3. **Widening the literal requires a capability.** `kernelMode` is not a boolean
   switch to flip for convenience: changing it means a real host capability
   exists, and the cutover registry row that consumes the surface must be updated
   in the same change.
4. **Removal is the executor's job.** The `removal` field of each entry names what
   replaces it. The end state is a kernel-mode plugin executor that owns
   verification, safe mode and connection sessions; when it lands, this module
   and the legacy routes behind it are deleted together (stage 6),
   [ADR-0038](../adr/0038-canonical-rust-kernel-core.md).

## Audit coverage

These calls used to be invisible to `pnpm ui:api:check`: the legacy baseline
only matched literal `/api/v2` routes and `legacyRaw()` helpers, while the
shared API client prepends the `/api/v2` prefix, so plugin-host calls looked
like ordinary client paths. Since round 5 the checker has a third kind,
`host-surface`, which flags any `hostSurface(...)` call and records the
registry id as the detail. The baseline therefore grew from 44 to **51**
audited sites: the 7 moved calls are now tracked (a real audit closure, not a
regression), and a new capability cannot be added without a name, an owner and
a removal plan.

## Verification

`apps/web/src/api/hostSurfaces.test.ts` asserts that

- every registry entry has a route under `/plugins/`, a rationale and a removal
  plan, and ids are unique;
- the set of registry ids equals the set of exported host calls, so a new call
  cannot be added without a row;
- each call rejects on the kernel plane with `{ code: 'UNSUPPORTED', feature: id }`
  and performs no network request;
- on the legacy plane each call keeps its exact method and route.

## Related

- [Product Wire contracts](wire-contracts.md) — the canonical data plane.
- [UI/API cutover registry](etap4-ui-cutover-registry.md) — rows 19, 20, 21.
- [Data and SQLite](../data/README.md) — kernel ownership of persistent state.
