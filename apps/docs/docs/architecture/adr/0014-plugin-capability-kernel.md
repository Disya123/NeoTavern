---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0014-plugin-capability-kernel.md
---

# ADR-0014: Plugin SDK capability kernel (rev4)

## Context

A flat `permissions` list in the manifest does not describe which specific
chats, storages or surfaces a plugin accesses, and does not support revoking
rights at runtime: disable/uninstall were the only enforcement points. In
parallel, plugin user state lived next to installation metadata in
`plugin_registry`, and the sandbox received rights implicitly — without a
handshake, feature negotiation and a unified error model. Revision 4 of the
Plugin SDK design requires: scoped grants, runtime revocation, a capability
broker as the single enforcement point for browser and backend, a unified
kernel protocol and a separate user-state table.

## Decision

1. **Capability model.** The manifest declares
   `requiredCapabilities`/`optionalCapabilities` as `{ name, scope? }`;
   legacy `permissions` strings are aliased into the v4 catalog
   (`kernel.parseCapability`). The user confirms any subset.
   Coverage semantics — `kernel.grantSatisfies`: name match + scope coverage
   (chat/workspace/user/installation).
2. **Grant storage.** `plugin_capability_grants` (migration 0016): `name`,
   `scope` (JSON), monotonic `revision`, `granted_at`, `expires_at`,
   `revoked_at`; UNIQUE `(plugin_id, name)`. Revocation marks the row rather
   than deleting it — history is needed for CAS and diagnostics.
3. **Broker.** `apps/server/src/plugin/capabilityBroker.ts` — the single
   enforcement point: `grantConsented` (activation), `check` (runtime),
   `revoke`/`revokeAll` (disable/uninstall/safe mode). The web host uses the
   same core code (`packages/plugin-sdk/src/kernel/`), so browser and backend
   see the same set of grants. Active grants are read via
   `GET /api/v2/plugins/:id/capabilities`.
4. **Runtime revocation.** The broker publishes `plugin.capability.revoked`
   to the event bus; the server SSE allowlist relays it to the browser; the
   web host delivers the event into the live kernel session of the sandbox.
   In-flight operations complete with `CAPABILITY_REVOKED`, open handles are
   closed by the host.
5. **Kernel session.** The sandbox receives a single transferred `MessagePort`
   (one-time bootstrap with a nonce via `window.postMessage`); after the ACK
   all communication goes over the port. The host handshake carries
   `grantedCapabilities`, `supportedFeatures` (feature registry:
   `ui.overlays`, `backend.byte-stream`, `storage.kv`, `chat.draft`,
   `ui.commands`, `jobs.background`) and `limits`
   (`kernel.DEFAULT_PLUGIN_LIMITS`). The plugin checks
   `api.runtime.supports(feature, version)`. Envelopes carry
   `instanceId`/`requestId`/`sequence`/`deadline`; cancellation — `rpc.cancel`;
   byte streams are pull-based with credits (backpressure, bounded memory).
6. **Errors.** Stable machine codes `kernel.KernelErrorCode`
   (`CAPABILITY_DENIED`, `CAPABILITY_REVOKED`, `REVISION_CONFLICT`,
   `PLUGIN_QUOTA_EXCEEDED`, `OPERATION_DEADLINE`, …) with `retryable`,
   `retryAfterMs`, `details`; wire form — plain object, survives structured
   clone between realms.
7. **User state.** `plugin_state` (migration 0016) is separated from the
   registry: scope `user|workspace|chat|installation`, `owner_id`,
   `schema_version` (the plugin's data format) and `revision` (CAS) — distinct
   entities; UNIQUE `(plugin_id, scope, COALESCE(owner_id,''))`. Repositories
   `repos.pluginState` and `repos.capabilityGrants`.

## Alternatives

- **Flat permissions list + consent on update** (rev1–3): gives no scope and
  no runtime revocation; rejected.
- **JWT-like signed capability tokens**: overkill for a local application
  without distributed nodes; a broker with a DB is simpler and already
  transactional.
- **Storing grants in `plugin_registry` as a JSON column**: mixes
  installation and rights, breaks CAS/revocation history; rejected.
- **Revocation only via sandbox restart**: the user expects an immediate
  revocation; rejected.

## Consequences

- Positive: a unified rights model for browser and backend; immediate
  revocation; feature negotiation without rewriting the protocol for new
  APIs; user state with its own lifecycle; stable error codes at the realm
  boundary.
- Negative: two tables and a broker instead of one column; plugins must
  handle `CAPABILITY_REVOKED` in long-lived operations; RPC surfaces migrate
  to the kernel incrementally — currently the kernel serves bootstrap,
  feature registry, limits and revocation notifications.
- Compatibility: migration 0016 is additive and idempotent; grants are
  recreated from the confirmed manifest on activation; legacy `permissions`
  keep working via aliasing. Documentation: `docs/plugin-sdk/README.md`
  § "Capability kernel (rev4)", `docs/api/README.md`, `docs/migrations/README.md`,
  `docs/data/README.md`.
