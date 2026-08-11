# ADR-0018: Isolated compute workers (rev4 §C2, `api.workers`)

## Context

Plugins need computations without a DOM: tokenization, parsing, game loops, embedding math. Three runtime candidates:

1. **Worker in the app origin** — rejected in rev4 §C2: contexts of the same origin share the same authority, so a host-origin Worker is code inside the app's trusted zone, not isolation; `connect-src 'self'` merely allows it to talk to its own origin. User consent does not create a technical boundary.
2. **Backend compute (`compute.backend`)** — exists, but is heavy for pure functions: requires a server process and is unnecessary for plugins without data or network.
3. **Worker inside the plugin's own sandbox** — the iframe already provides an opaque origin and CSP; spikes 6/8 confirmed classic blob-Workers in that realm. A CSP probe (2026-08) refined the matrix for module Workers: a blob: module Worker in an opaque origin does NOT work — the entry fetch happens in the Worker's own opaque origin, which cannot resolve a blob URL created in the origin iframe (blob URLs are origin-scoped); a data: module Worker works (data: has no origin scoping), including under the production CSP with `script-src … data:` and `worker-src … data:`, but Chromium rejects data: scripts above ~2 MiB (1.5 MiB verified OK, 2 MiB errors). Verdict: classic — blob:, module — data:.

The decision is option 3 as the public primitive `api.workers`, with backend compute as the guaranteed fallback for tasks that need data or network.

## Decision

1. **The Worker lives in the plugin's realm.** `api.workers.spawn({entry, name?, signal?})` constructs the Worker INSIDE the plugin's sandbox iframe from a host-verified bundle. Plugin↔worker messages are ordinary structured-clone `postMessage` within one realm (the host does not proxy the data and does not see it).
2. **Manifest allowlist `workers: string[]`.** Package-relative safe `.js`/`.mjs` paths (install-time validation in `validateManifest`, ≤ 8 entries, duplicates rejected). Spawning an undeclared entry → `VALIDATION_FAILED` (`reason: 'not-in-manifest-workers'`) before any fetch.
3. **Capability `compute.worker` at spawn time.** Without the grant — `CAPABILITY_DENIED`. Permission to compute is not permission to data (invariant 3, rev4 §0): the Worker has no network/storage/credentials; the plugin passes data itself via postMessage.
4. **Host-verified bundle delivery.** The host fetches the entry same-origin via the guard-checked route `/api/v2/plugins/:id/assets/*`, checks size (≤ `workers.maxBundleBytes` = 2 MiB; `.mjs` additionally ≤ `workers.maxModuleDataUrlBytes` = 1.5 MiB — `PLUGIN_QUOTA_EXCEEDED`) and MIME (`text/javascript`, otherwise `VALIDATION_FAILED` `reason: 'bad-mime'`), then hands the bytes to the sandbox over the kernel channel (`kind: 'workers.bundle'`); the sandbox creates the Worker by entry extension: `.js` → classic `new Worker(blobUrl)`, `.mjs` → `new Worker(dataUrl, { type: 'module' })`, where `dataUrl` is the base64 data: URL of the bundle (a blob: module Worker cannot resolve its entry in an opaque origin, see Context). Constructor failure → `WORKER_SPAWN_FAILED` (retryable code).
5. **Lifecycle and quotas.** Live Workers ≤ `limits.workers.maxInstances` (default 2) — the host keeps a ledger and frees slots on sandbox reports `workers.exited`/`workers.error` and on `workers.terminate`. Session dispose (frame reset/disable/uninstall/sandbox navigation) and revocation of `compute.worker` terminate all live Workers: the host sends `workers.terminate`, and the realm dies with the iframe in any case (invariant 6, rev4 §0).
6. **v1 constraints.** Bundles are self-contained: classic — no `import`/`export`/`importScripts`, module — no `import` (blob/data URLs cannot resolve relative imports). Limits: `workers.maxBundleBytes` (2 MiB, both kinds) and `workers.maxModuleDataUrlBytes` (1.5 MiB, `.mjs` only — headroom under the ~2 MiB Chromium data: script limit); both in `DEFAULT_PLUGIN_LIMITS`, read by the sandbox from the handshake `limits`. Module Workers are enabled: the initial verdict "Chromium kills blob:/data: module Workers" (2026-08) was a misdiagnosed kernel-channel race; after the deferred `stream.end` the real cause emerged for blob: — an origin-scoped blob URL cannot be resolved from the Worker's opaque origin. Spike 6 pins the capability (blob → data fallback), spike 8 pins the data: transport under production CSP; an engine regression → disable `.mjs`. Same-origin module Workers are rejected because they inherit the app origin (isolation regression). SharedWorker/ServiceWorker are forbidden; `memoryBudgetMiB`/`name` are advisory metadata; a CPU watchdog is deferred (no portable API).

## Alternatives

- **Host-origin Worker** — rejected (see Context, item 1).
- **A unique plugin origin per plugin** — stronger on paper (separate site), but requires separate-site hosting/signed asset origins; overkill for a local-first install. Kept as a next step if the browser blob-Worker matrix degrades.
- **`compute.backend` only** — preserves isolation but forces pure computations to route data through a server process and requires a backend plugin; remains a fallback, not a replacement.

## Consequences

- Third-trust-level computation without a new process and without data: the trust matrix (rev4 §B3) gains a row "compute worker = no DOM, plugin origin, data only through the plugin's postMessage".
- Enforcement is distributed: the host gates spawn (capability, allowlist, size, MIME, quota), the sandbox enforces realm death; the host ledger stays honest via `workers.exited`/`workers.error` reports even for a plugin that never calls `terminate()`.
- Plugin authors must bundle the worker entry as a self-contained script (classic without import/export/importScripts, module without import) — the constraint is documented in rev4-api.md and the `plugins/rev4-worker` example (e2e round-trip `doubled 21 -> 42` and `tripled 14 -> 42`).
- Docs: `docs/plugin-sdk/rev4-api.md` (namespace `api.workers`, errors), `CHANGELOG.md`.
