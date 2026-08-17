# Architecture Decision Records

## ADR-0049: Track D compositor and Dioxus/Blitz producer (D1/D2 GO)

Owner-signed D1/D2 after technical M0 PASS and TrackComparison. **D1=Track D
GO**, **D2=Dioxus+pinned Blitz GO**, **D3=DEFERRED** (Android Rust
presentation path, Web stays React). Feature-flagged staged implementation;
React/WebView remains the rollback and the public Android renderer until
Milestone B/C DoD. Track D is not claimed as the cheapest A/B/C track.
Full decision: [ADR-0049](0049-track-d-dioxus-presentation.md), signed record
[d1-d2-decision.md](../rfc/d1-d2-decision.md).

## ADR-0048: M5 slice-2 limited waiver — message swipe/draft/revision legacy routes

Этап 4 slice 2 (message variants/revisions/drafts) delivers the full
vertical — kernel wire ops, legacy converter, facade/wireBridge and the UI
cutover (ChatPage swipe controls, variants/revisions hooks, variant picker,
kernel-plugin draft streaming all route through the facade in kernel mode;
`check-ui-api` drops from 68 to 61 recorded sites). The replaced legacy
`/api/v2` message swipe/draft/revision routes cannot be deleted yet because
the facade's browser branches still use them as the Web Client /
legacy-sidecar transport (ADR-0038). ADR-0048 keeps them feature-frozen with
no direct production UI callers, and moves their removal to Этап 6 (release
gate), superseding the slice-2 expiry of the analogous ADR-0047 waiver-1
item. Full decision, alternatives and consequences:
[ADR-0048](0048-m5-slice2-route-removal.md).

## ADR-0047: M4 limited waivers — slice-1 scope and full-cutover residual items

The M4 (Этап 4, full UI/API cutover) acceptance covers the delivered
**slice-1 scope** (personas + full lorebook CRUD incl. entry level,
contract → kernel → facade → UI → corpus → host parity, plus the SEC-01
and SEC-05 audit fixes) and records seven limited P1 waivers for the rest:
legacy `/api/v2/lorebooks` + `/api/v2/personas` route removal (next slice);
character↔lorebook scoping, `chat.persona_id`/`{{user}}` wiring, the
per-profile export scoping (SEC-02 — this waiver supersedes the ADR-0042
M4-cutover expiry, ratified by the human verdict) and the two full-cutover
exit criteria (zero production legacy calls, legacy Fastify product-data
ownership) expire at the release gate; slices 2–7 are the tracked remainder
of Этап 4 with per-slice verdicts. No P0 remains open; the slice-1
conformance work (47-op wire registry, clippy/assert fix, regenerated
generated.rs, check-ui-api baseline) is recorded in the ledger evidence.
Full decision, alternatives and consequences:
[ADR-0047](0047-m4-limited-waivers.md).

## ADR-0046: M3 limited waivers — data-cutover residual P1 items

The M3 (Этап 3) data-cutover acceptance records eight limited P1 waivers
(ТЗ §10.3–§10.4): parent-directory fsync after the pointer rename is a
platform best-effort (release-gate expiry); pointer containment without
canonicalization is defense-in-depth (release-gate hardening); `--no-backup`
is a documented escape hatch (permanent); legacy-sidecar stop/block, restore
convergence on the shared activation protocol, the in-app
migration/restart-to-complete UX and the settings/branches/revisions/assets
conversion are tracked to the M4 cutover; recovery re-verification is a
release-gate item. Every waiver has an exact issue text, severity P1 and an
expiry; an expired waiver re-opens its blocker via the gate. Full decision,
alternatives and consequences:
[ADR-0046](0046-m3-limited-waivers.md).

## ADR-0045: M2 packaged golden E2E with fault injection — limited waiver

M2's packaged-flow exit criterion is satisfied by the honest **kernel-flow
smoke** (`NEOTA_DESKTOP_SMOKE=1`): the full user flow runs headless over the
real Tauri host path (character → chat → message → `generation.start` →
`completed` with exactly one deterministic assistant message →
`register_tool` → `waiting_for_tool` → `tool.result` → second assistant
message) and exits non-zero on any failed assertion. The ТЗ §17.2
**fault-injection and recovery suite** (crash at tool wait / final commit,
deterministic recovery without repeated external effects, backup/restore
drill) is a §18.2 merge/release-branch check, not an Этап 2 exit criterion;
it is waived for M2 as a limited P2 waiver with expiry at the release gate.
The gap stays recorded as an open item and the smoke keeps running in CI.
Full decision, alternatives and consequences:
[ADR-0045](0045-m2-golden-e2e-waiver.md).

## ADR-0044: Provider execution and the generation run/step/tool model

The Kernel models a durable `GenerationRun` composed of `GenerationStep`s
(ТЗ §8.3): a CAS-validated state machine (`Created → Planning → Running ↔
WaitingForTool → Committing → Completed`, `Cancelling`, `Failed`), a durable
step/event journal with idempotency keys (`turn-{seq}`/`tool-call-{id}`/
`tool-result-{id}`), run leases with `interrupted` as an explicit recoverable
terminal state, a `MAX_TOOL_CALLS = 8` loop budget, an immutable `PromptPlan`
built before any network request (character/persona/lorebook/history blocks,
heuristic token budget, exclusion reasons), provider secrets resolved only at
execution time via `SecretStore` (fail-closed without a resolver; the key
lives only in the `Authorization` header), and a typed streaming event model
with synchronous-writer mpsc backpressure. Tool calls are validated against a
declarative registry and executed by the host, never by the provider or the
kernel. Honest boundaries recorded in the ADR: plugin interceptors and named
instruct presets deferred, heuristic tokenizer with `response_reserved = 0`
until the exact-tokenizer ADR, manual resume for interrupted runs. Full
decision, alternatives and consequences:
[ADR-0044](0044-generation-run-step-model.md).

## ADR-0043: Web Client — Remote-Only Mode and Standalone Browser Runtime Decision

The installable web artifact is a **Remote/Installable Web Client**: the
browser runs the UI shell and talks to the Kernel on a user-controlled
Headless/Desktop host through the authenticated Product Wire HTTP/stream
transport. It is **not** a standalone offline runtime: the service worker
caches only the versioned app shell and public static assets (never API/SSE
responses, prompts, provider events or secrets), and without a connection the
Web Client shows an honest connection/offline screen with no product
mutations. The standalone browser/WASM runtime is a separate product track —
if ever required it needs its own ADR/RFC passing the ТЗ §11.3.2 criteria
(browser-compatible core, SQLite WASM + OPFS single-writer, quota/eviction,
browser secrets, provider CORS model, mobile Safari lifecycle, offline E2E);
until then standalone capability is `Not supported` (ARC-12). This ADR records
the decision that ADR-0038 and `AGENTS.md` already reference as "ADR-0043".
Full decision, alternatives and consequences:
[ADR-0043](0043-web-client-remote-only.md).

## ADR-0042: Limited waiver — per-profile export scoping (M1, SEC-02)

A bounded exception to the M1 SEC-02 blocker list: **one** P1 issue
(per-profile export scoping — the canonical schema must add per-profile
foreign keys and the export must filter by them) is waived for M1, under
strict conditions: severity P1 (not P0), scope limited to the single issue,
expiry at the **M4 cutover** (the canonical schema + export filtering must
land before M4 acceptance), no silent fallback (secrets stay excluded today),
and human sign-off by the same person who accepts M1. Alternatives — hold M1
open (forces a canonical feature into the feature-frozen legacy contour) or
implement in legacy now (double ownership across two planes) — were rejected.
The gate validates the waiver's fields and the ledger records it. Full
decision, alternatives and consequences:
[ADR-0042](0042-m1-waiver-per-profile-export-scoping.md).

## ADR-0040: SecretStore port — host backends, portable format, crypto parameters

The canonical kernel SecretStore port (ТЗ §SEC-01 / §19.2 ADR #5): host
backend matrix (OS vault on Desktop, Keystore on Android, explicit env/file
on Headless, in-memory session-only, portable `secrets.enc`); portable v2
format — AES-256-GCM over a JSON envelope, Argon2id KDF with the header
(magic, formatVer, KDF id and parameters, salt) authenticated as AAD so a
tampered header can never downgrade the KDF, fresh nonce per write, salt
stable per passphrase, best-effort zeroization; Argon2id m=64 MiB / t=3 / p=1
fixed provisionally and gated by a pre-Stable benchmark ADR (parameters are
versioned in the header, so tuning is non-breaking); machine-independent
portable key derivation (file + passphrase only); atomic temp+rename writes;
`lock()` and staged re-encryption; legacy v1 (scrypt) files are a migration
input rejected with an explicit code until the Этап 3 converter; stable
error codes. Full decision, alternatives and consequences:
[ADR-0040](0040-secret-store-port-format.md).

## ADR-0041: Versioned Data Roots — Activation Journal and Windows Restart-to-Complete

The Этап 3 data-cutover layout (ТЗ §10.2–§10.4 / §19.2 ADR #8): versioned
data roots under `data-root/roots/` with a small `active-root.json` pointer
and a durable `activation-journal.json` (`prepared` → `validated` →
`activation_pending` → `committed` | `rolled_back`); the Windows activation
protocol uses a verified platform-specific replace primitive with bounded
retry/backoff for classified transient sharing/lock errors, never deletes
the old root before commit confirmation, writes `activation_pending` +
clean exit + **Restart to finish migration** after the retry budget is
exhausted, and completes activation at next bootstrap before plugins/UI
queries/SQLite/background services start; the old root stays the only
active root on failed activation; rollback is available until the first new
mutation or via an immutable safety copy. Full decision, alternatives and
consequences: [ADR-0041](0041-versioned-data-roots-activation.md).

## ADR-0039: Legacy Compatibility Authority Boundary

Legacy compatibility is an **authority-non-expanding boundary** (ТЗ 10/10
rev2 §14): compatibility MAY translate or restrict an operation but MUST NOT
grant more authority than the corresponding native capability. Three
compatibility tiers (Native compatible / Sandbox compatible / Architecturally
incompatible); unconditional prohibitions — canonical `database.sqlite`+WAL/SHM,
`SecretStore`, kernel internals, other plugins' data, `legacy.superuser`,
Product Wire bypass — that user consent, debug mode or a high-risk grant
cannot lift; scoped VFS (`/data/extensions/<id>/...` →
`<data-root>/plugin-data/<plugin-id>/...`); high-risk grants limited to
arbitrary public-host network, picker-scoped filesystem, Desktop process
execution behind an allowlist, and the legacy frontend unmanaged island;
compatibility adapter is not a second core; permanent
`packages/legacy-compat/` (`ST Compatibility API v1`) vs temporary
`packages/migration-shims/` with CI-enforced expiry (ARC-09); per-API
capability mapping with an ARC-11 mapping test. Full decision, alternatives
and consequences: [ADR-0039](0039-legacy-compatibility-authority-boundary.md).

## ADR-0038: Canonical Rust Kernel Core — Architecture Convergence decision

The Rust Runtime Kernel is the **canonical application core** of NeoTavern —
the single owner of product logic and persistent state (ТЗ 10/10 rev2 §4,
§28). The Fastify/Drizzle contour is feature-frozen legacy/migration mode;
new product logic lives in the Kernel. Canonical filename `database.sqlite`;
live dual-write between `app.db` and `database.sqlite` is prohibited; support
tiers (Desktop Released after the M2 gate, Headless later, Android
Experimental, Web Client Remote-only); **honest staged Desktop default**
(public builds use the tested legacy sidecar, Kernel is Preview, nightly
defaults to Kernel, public switch only after the release gate); standalone
browser/WASM runtime is out of scope; legacy compatibility is an
authority-non-expanding boundary (ADR-0039); the target architecture ТЗ 10/10
rev2 supersedes ТЗ 7.2 where they conflict, and AGENTS.md is amended
accordingly. Full decision, alternatives and consequences:
[ADR-0038](0038-canonical-rust-kernel-core.md).

## ADR-0037: Extension hardening — declarative slots, legacy-frontend gate, theme fallback, engines enforcement, namespaced quotas + secrets

Phase 10 defines the real extension security boundaries (ТЗ §10): the five
declarative semantic UI slots (host re-validation, permission gating,
priority order — plugins provide data only, never markup), an app-level
`extensions.legacyFrontend` gate (default off) stacked on the admin-only
`legacy.trusted` consent before any legacy `<script>` reaches the main
document, theme activation rollback with a last-working boot fallback and
responsive `density`/`motion` semantics, manifest `engines` enforcement
(incompatible updates auto-disable and keep the previous version), kv quotas
on namespaced state (413 `STATE_QUOTA_EXCEEDED`), a write-only per-plugin
SecretStore with gated reveal that never enters backups/exports/logs, plugin
namespaces as an additive backup sidecar with conflict-skip restore, and
explicit extension-runtime availability probes on every host. Full decision,
alternatives and consequences: [ADR-0037](0037-extension-hardening.md).

## ADR-0036: Android Background Execution — bounded foreground service + WorkManager maintenance over the shared kernel handle

Phase 8 wires ТЗ §8/§19 background execution on the Android host onto the
**same kernel session** as the activity: a bounded `dataSync` foreground
service continues user-visible generation streams (shared handle via
`KernelHolder` refcount — never a second writable kernel, §22), the
notification shows run state and a Stop action but **never message content**
(§85), maintenance is WorkManager unique one-time work (`backups.create`,
battery + storage constraints, no exact schedule §66), and stop/expiration
map to `generation.cancel` while process death recovers via kernel startup
recovery + `generation.retry`. No new JNI/contract/codegen surface — purely
a host-side lifecycle adapter on the frozen wire registry. Full decision,
alternatives and consequences: [ADR-0036](0036-android-background-execution.md).

## ADR-0035: Desktop Remote Access — host service over the shared Runtime Kernel

Phase 9 wires the Phase 4 remote surface into the desktop shell: the new
`neotavern-desktop-remote` host service (`crates/adapters/desktop-remote`)
wraps `remote-http-adapter` on the **same `Arc<Mutex<Kernel>>`** as local
IPC (one writer, §22) — off by default (no listener), loopback default with
an ephemeral port, non-loopback only with `trusted_proxy` AND auth
(fail-closed pre-bind), pairing with revocable in-memory SHA-256-verifier
credentials (re-pair after restart; durable credential persistence deferred),
CORS deny-by-default via `allowed_origins`, bounded audit, and a
`kernel_remote_*` Tauri command surface that controls the host service
without touching the frozen wire registry (no contract/codegen change).
Config lives host-owned at `app_config_dir/remote-access.json` (atomic
write), never in the product DB. Full decision, alternatives and
consequences: [ADR-0035](0035-desktop-remote-access.md).

## ADR-0034: Android Local Host — JNI + WebView Bridge on the mobile FFI ABI

Phase 5 wires the Android host to the Runtime Kernel without Node or
localhost: the `neotavern-android-jni` crate marshals JNI calls to the
existing stable C ABI (`crates/adapters/mobile-ffi`, thin marshalling only,
envelope extraction in Rust, no hand-written Kotlin DTOs, opaque `jlong`
handles, contained `KernelException`), the WebView loads bundled web assets
and speaks a frozen JS bridge protocol (`window.__neotavernMobile`
handshake/call/cancelStream with a callback channel), and the local profile
routes `LocalBackend` over `MobileBridgeTransport`. Secrets live in the
Android Keystore (AES/GCM, no plaintext fallback). Full decision,
alternatives and consequences:
[ADR-0034](0034-android-local-host-jni-transport.md).

## ADR-0033: Desktop Local Kernel Transport — Tauri IPC Cutover

Phase 3 wires the desktop to the Runtime Kernel without the HTTP server:
a shared envelope crate (`neotavern-envelope`) for byte-identical envelopes
across CLI/HTTP/Tauri, `neotavern-tauri-local` with `kernel_dispatch` /
`kernel_stream_start` / `kernel_stream_abort`, kernel mode as the shell
default (legacy Node sidecar opt-in via `NEOTA_LEGACY_SERVER=1`) and a
`LocalTransport` over `invoke` for `LocalBackend`. First vertical slice:
DiagnosticsPanel kernel section (meta + backups). Full decision, alternatives
and consequences: [ADR-0033](0033-desktop-local-kernel-transport.md).

## ADR-0032: Portable Data — Backup Container, Staged Restore, Portable Export

Phase 11 turns the Phase 2 recovery primitives into public long-lived formats:
the `.neotavern-backup` container (manifest + checksummed inventory + pinned
asset set), kill-safe staged restore with atomic candidate activation resolved
at open, the `.neotavern-export` NDJSON interchange with explicit duplicate
policy, and a read-only legacy converter. Full decision, alternatives and
consequences: [ADR-0032](0032-portable-data.md).

## ADR-0031: Portable Provider Contract (Phase 7)

Phase 7 turns provider execution into a portable contract: `crates/provider-sdk`
(adapter trait, normalized errors/usage, deadline/retry policy, secret
references) + `crates/built-in-providers` (deterministic fake, recorded
fixtures, conformance suite) + kernel `ProviderRegistry` with `providers.list`,
host secret-resolver seam and per-run deadline; storage migration 4 persists
config/secret separation (`provider_configs`). Full decision, alternatives and
consequences: [ADR-0031](0031-portable-provider-contract.md).

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
