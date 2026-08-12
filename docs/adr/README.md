# Architecture Decision Records

## ADR-0030: Remote HTTP Adapter — envelope-over-HTTP on the shared Runtime Kernel

Phase 4 headless/remote surface: a new std-only crate
(`crates/adapters/remote-http`, tiny_http 0.12) maps the frozen wire envelopes
onto `GET /meta`, `POST /rpc`, `POST /rpc/stream` (SSE) without defining any
DTO of its own; `Arc<Mutex<Kernel>>` is the single writer coordinator shared
with local IPC (§22), insecure non-loopback binds fail closed unless
`trusted_proxy: true` declares a TLS-terminating boundary, protocol mismatch
(426) is enforced before dispatch, and kernel product errors are copied into
the envelope verbatim. SSE framing and Last-Event-ID exist now; durable
sequenced streams arrive with Phase 6 generation workflows. Full decision,
alternatives and consequences: [ADR-0030](0030-remote-http-adapter.md).

## ADR-0029: Wire contract toolchain (TypeBox single source → deterministic codegen)

Product Wire Contracts in `packages/contracts/src/wire/` are the single
hand-authored cross-language contract source: TypeScript types are inferred
from TypeBox schemas, the JSON Schema bundle + manifest (with `schemaHash`)
are emitted deterministically by `tools/contract-codegen`, and the Rust
boundary DTOs/validators in `crates/contracts-generated` are generated from
the same bundle and committed. Wire-safe subset with fail-on-unsupported
(no `serde_json::Value` fallback), string-discriminated unions, exact-match
local handshake (`wireProtocol` + `schemaHash`), UTF-16 code-unit string
length and a shared format registry on both validators. Full decision,
alternatives and consequences: [ADR-0029](0029-wire-contract-toolchain.md).

## ADR-0028: SES bootstrap and TCB (two-phase bootstrap, lockdown policy, endowment list)

Trusted `worker-bootstrap.mjs` performs a 9-step two-phase bootstrap:
Node primitives → SES → `lockdown()` → hardened bridge →
Compartment → vetted endowments → signed module graph → entrypoint. Nothing
plugin-world runs before `lockdown()` (it is part of the TCB). Production
lockdown: `errorTaming:"safe"`, `overrideTaming:"moderate"`,
`consoleTaming:"safe"`; `severe` as default is forbidden. The Compartment
receives only vetted endowments (`console` → BoundedConsoleSink,
TextEncoder/Decoder, URL, AbortController, queueMicrotask); no
`process/require/Buffer/fetch/WebSocket/SharedArrayBuffer/raw WebAssembly`.
Worker: only from the fixed TRUSTED_BOOTSTRAP, `execArgv:[]`, minimal env,
`eval:false`, workerData = only small identifiers; reuse between plugins is
forbidden. Full decision, alternatives and consequences:
[ADR-0028](0028-ses-bootstrap-tcb.md).

## ADR-0027: Node Universal Runtime — Worker-per-plugin and compat path

Backend runtime moves to the target topology: a separate NeoTavern Plugin
Runtime process with one Worker per active plugin; plugin code — only inside a
SES Compartment after `lockdown()`; security boundary — Worker isolate + SES +
Capability Broker, not the Node Permission Model. The new runtime is
`apps/plugin-runtime`; Main Host and Runtime run in separate processes, a
Runtime crash does not take down the Host. rev4 (apiVersion 2) runs in
parallel until fully replaced; switching by `manifest.apiVersion` (v2 → old
process path, v3 → new Runtime). ADR-0007 is superseded in the backend-runtime
part (the frontend part is retained). Full decision, alternatives and
consequences: [ADR-0027](0027-plugin-node-universal-runtime.md).

## ADR-0026: Resource bounds as an emergency boundary

Fixed per-plugin quotas are cancelled: `resourceLimits` — only an
emergency boundary, computed from headroom (RAM, RSS Host/Runtime, active
Workers, memory hint, history); eviction — by adaptive cache policy, not a
forced idle timeout. Telemetry — parent-side (`worker.cpuUsage`/
`getHeapStatistics`/`ELU`) plus `/proc` and cgroup v2 read-only; runaway is
determined by memory growth + absence of progress + proximity to the boundary;
two-phase termination with workerEpoch invalidation; when the culprit
cannot be identified — restart Plugin Runtime instead of killing the largest
Worker. SLO — regression gates, not quotas. Full decision, alternatives
and consequences: [ADR-0026](0026-plugin-resource-governor.md).

## ADR-0025: Event cursor/replay and multi-window singleton (rev4 stage 9, §J1/J3)

`events.subscribe(event, {cursor})` without a callback returns an async
iterator: the host keeps a bounded ring buffer of app events (128/name, 4096
total, TTL 60 s) and replays events after the cursor (at-least-once, dedupe
key — `cursor` in `evt.emit`), ack-based backpressure via `maxInFlight` (64),
cursor beyond the window → `EVENT_CURSOR_EXPIRED`. Background consumers — in
exactly one window per installation: `WindowRoleManager` picks the primary via
BroadcastChannel (claim + heartbeat, leader = min windowId, lease 4 s, release
on pagehide), the plugin gets `api.windows.role/isBackground` and the push
`window.background.changed` (via `api.events.on`, without RPC). Deterministic
and fair degradation: standalone without BC, no silent event loss. Full
decision, alternatives and consequences:
[ADR-0025](0025-event-cursor-and-multiwindow.md).

## ADR-0024: Crash isolation for sandbox frames (rev4 stage 8, §M3)

Two dead-sandbox signals: closure of the session port
(`KernelSession.onPeerClose` — process death/self-navigation, works without
timers) and the `kernel.ping` heartbeat (10 s interval, 3 s deadline — covers
hang in site-isolated Chromium; in the shared-process model a spin inside an
iframe freezes the host too, so the primary signal is the port). A failure
consumes the restart budget (3 per 10-minute window), crash-loop disables the
plugin server-side; `neotavern-plugin-crash` renders a host-owned notification
(survives frame teardown), the failure counter is visible in
`api.diagnostics.get().crash`. Full decision, alternatives and
consequences: [ADR-0024](0024-sandbox-crash-isolation.md).

## ADR-0023: Host-driven lifecycle hooks for plugins (rev4 stage 7, §J2)

SSE events around the atomic swap of the package directory
(`plugin.updating` → `plugin.updated`/`plugin.rollback`, plus `uninstalling`)
are mapped by the web runtime to best-effort RPC hooks
`beforeUpdate`/`afterUpdate`/`rollback`/`uninstall` (+ `suspend`/`resume` on
`visibilitychange`); the host state machine does not wait for the plugin
(deadline 1500 ms, degrading to `{handled: false}`), but teardown of the
replaced frame waits for the settlement of the last hook so its final writes
(KV, blobs) are not cut off by the session-port closure. Full decision,
alternatives and consequences:
[ADR-0023](0023-plugin-lifecycle-hooks.md).

## ADR-0022: Host overlay chrome and z-order protection during `full`-overlay (rev4 stage 6)

While a `full`-overlay is alive, the host renders its own chrome (plugin name +
host close button) on layer `--st-layer-plugin-chrome` (300) — above all plugin
layers (200) and below host modals (1000); the app background gets `inert`,
focus is restored, Escape works from inside the sandbox iframe as well (relay
via RPC `ui.overlay.escape`); chrome ownership is bound to the frame instance
(`frameId`), a stale flush from a replaced frame closes nothing. Full decision,
alternatives and consequences:
[ADR-0022](0022-overlay-host-chrome-zorder.md).

## ADR-0021: Cron schedules, retry lifecycle and DLQ for plugin jobs (rev4 stage 5)

A custom 5-field cron parser (no external dependencies), ack contract of
dispatch at `retries > 0` (hold until confirmation, exponential backoff,
timeout for a lost ack), DLQ as `status: 'failed'` with `lastError` and manual
`retry`; fire-and-forget without `retries` is retained. Full decision,
alternatives and consequences: [ADR-0021](0021-plugin-jobs-cron-retries-dlq.md).

## ADR-0020: Persistent message blocks (rev4 stage 4)

Plugin block attachments are durable data: server table
`message_block_attachments` (cascade on message/plugin uninstall), REST
CRUD + batch read, `freeze` persists renderer state on real unmounts,
`chat.message.block.changed` synchronizes clients, the renderer reload race is
resolved with an in-place retry on the registration event. Full decision,
alternatives and consequences:
[ADR-0020](0020-persistent-message-blocks.md).

## ADR-0019: Chat CAS, server-side drafts and outbox (rev4 stage 3)

Streaming write no longer rewrites a committed message: revision-CAS on
`PATCH` of messages (`MESSAGE_CONFLICT` instead of silent overwrite), server
object `message_drafts` with atomic commit (a writer crash leaves a draft for
sweep, not an empty message; commit retry-safe via `committed_message_id`),
idempotency key on create for retry semantics. Full decision, alternatives and
consequences: [ADR-0019](0019-chat-cas-drafts-outbox.md).

## ADR-0018: Isolated compute workers (rev4 §C2, `api.workers`)

Worker as a third trust level: computations without DOM and data live in the
plugin realm (opaque origin + `worker-src blob: data:` / `connect-src 'none'`),
the host verifies a manifest-allowlisted bundle (≤ 2 MiB, MIME) and delivers
it via the kernel channel; capability `compute.worker`, quota 2 live, death
together with the session and on revocation. Full decision, alternatives and
consequences: [ADR-0018](0018-plugin-compute-workers.md).

## ADR-0017: Cross-plugin services (rev4 §D, `api.services`)

Host-mediated RPC between sandbox plugins: the provider registers service
metadata, calls are routed into the session of the provider itself (functions
never cross boundaries as objects); `serviceId` is host-prefixed
(`<pluginId>.<name>`) — squatting is impossible by construction; capabilities
`services.provide`/`services.connect`, deadlines, payload cap 256 KiB,
connection limits; v1 — web-only (backend plugins are a non-goal). Full
decision, alternatives and consequences: [ADR-0017](0017-plugin-services.md).

## ADR-0016: Plugin OAuth connections (rev4 §K5)

Host-owned OAuth: the server drives the PKCE cycle, tokens are stored only in
`plugin_auth_connections` and never leave the server; the sandbox sees
metadata (`api.auth.list/get/connect/revoke`) and makes authorized calls via
`network.fetch(url, {connectionId})`; public clients only (no clientSecret),
HTTPS-only with a loopback-HTTP exception, one-time `state`, v1 without
refresh. Full decision, alternatives and consequences:
[ADR-0016](0016-plugin-oauth-connections.md).

## ADR-0015: Runtime capability grants (rev4 §B2)

A plugin can request a capability at runtime: the web host shows a consent
dialog, the server persists the grant (`POST /api/v2/plugins/:id/capabilities`),
web slices see it immediately, backend — from the next activation; revoking a
grant immediately stops enforcement on the web host. Full decision,
alternatives and consequences: [ADR-0015](0015-runtime-capability-grants.md).

## ADR-0014: Plugin SDK capability kernel (rev4)

Permissions became scoped capability grants with runtime revocation: the
broker as the single enforcement point for browser and backend, grants in
`plugin_capability_grants`, revocation via SSE `plugin.capability.revoked`,
kernel session with a transferred `MessagePort`, feature registry and
`api.runtime.supports`; user state moved into `plugin_state`. Full decision,
alternatives and consequences: [ADR-0014](0014-plugin-capability-kernel.md).

## ADR-0013: Plugin installation via Git link and built-in npm dependency installer

Plugins are installed from the repository HTTPS archive (no git binary), npm
dependencies are resolved by the built-in installer without executing
install scripts; flat hoisting, version conflicts are reported, the
recommended path is bundling. Full decision, alternatives and supply-chain
mitigations: [ADR-0013](0013-plugin-git-install-and-deps.md).

## ADR-0012: Multi-surface sandbox composition

One sandboxed iframe per plugin, host-owned rectangle composition, and an SVG
clip path preserve registration isolation without stealing input from the
application. Details: [ADR-0012](0012-multi-surface-sandbox-composition.md).

Key architecture decisions. A significant new decision is recorded in a
separate `NNNN-title.md` file with context, decision, alternatives and
consequences.

---

## ADR-0001: SQLite + WAL

**Context.** Local application without mandatory cloud; tens/hundreds of
thousands of characters; simple installation.
**Decision.** SQLite (better-sqlite3) + Drizzle, WAL, FTS5. No PostgreSQL/Redis.
**Alternatives.** PostgreSQL (heavy for local installation), IndexedDB-only
(no shared server state for plugins).
**Consequences.** Single process; backup via SQLite API; migrations are
transactional.

## ADR-0002: Own SDKs

**Context.** Stability of contracts for plugins/themes; isolation from
internal libraries.
**Decision.** Plugins/themes depend on `@neotavern/plugin-sdk`/`@neotavern/theme-sdk`, not on
React/Zustand/Fastify/SQLite.
**Alternatives.** Direct access to internals (unstable, breaks updates).
**Consequences.** Clean TS contracts; the host implements the API; cleanup per
contract.

## ADR-0003: SSE for generation

**Context.** One-way token stream.
**Decision.** SSE (`text/event-stream`); WebSocket — only for a real
bidirectional channel.
**Alternatives.** WebSocket (overkill for streaming), long-polling (worse).
**Consequences.** Simple client; cancellation via connection close/AbortSignal.

## ADR-0004: TypeBox 0.34 + type-provider v5

`@sinclair/typebox@0.34` + `@fastify/type-provider-typebox@5.x`; schemas — a
single source in `@neotavern/contracts`. Context, alternatives and consequences:
[ADR-0004](0004-typebox-contracts.md).

## ADR-0005: Sessions for remote access

Non-loopback bind requires an explicit remote mode, bootstrap token and HTTPS
origin. The browser receives a bounded HttpOnly session and in-memory CSRF
token; Web Storage is not used for credentials. Full decision, alternatives and
consequences: [ADR-0005](0005-remote-session-auth.md).

## ADR-0006: Declarative CSS theme shell

The theme shell is implemented in CSS over stable slots/hooks without
executing theme code; installation is atomic, and `?safe=1` bypasses package
runtime. Full decision and alternatives:
[ADR-0006](0006-declarative-theme-shell.md).

## ADR-0007: Plugin SDK isolation and trusted legacy mode

The native frontend runs in a sandboxed iframe, the backend — in a separate
permission-limited Node.js process with capability IPC. Main-window/Express
legacy entry points require a separate `legacy.trusted` consent and are
disabled in safe mode. Full decision, cleanup and alternatives:
[ADR-0007](0007-plugin-runtime-isolation.md).

> **Partially superseded** by [ADR-0027](0027-plugin-node-universal-runtime.md):
> the backend part (permission-limited process as the primary boundary) is
> replaced by the Worker + SES Compartment model in Plugin Runtime; the
> frontend part (iframe, legacy trusted) is retained unchanged.

## ADR-0008: JSON instead of YAML for additional parameters

Additional Parameters are stored as structured JSON in `settings`
(`customIncludeBody`/`customExcludeBody`/`customIncludeHeaders`); validation is
shared between client and server, forbidden headers and reserved body keys are
rejected. Full decision, alternatives and consequences:
[ADR-0008](0008-json-additional-parameters.md).

## ADR-0011: Shell layout v1 — tokenized geometry, slots as skin-targets

`data-slot` hooks are fixed as stable skin-targets, a registry of 10
implemented slots, `navigation.secondary`/`panel.right` are not in v1;
content geometry is a documented exception; breakpoints and the literal ban
are checked by a style-contract test. Full decision, alternatives and
consequences: [ADR-0011](0011-shell-layout-v1.md).
