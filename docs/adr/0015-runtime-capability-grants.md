# ADR-0015: Runtime capability grants (rev4 §B2 consent round-trip)

## Context

ADR-0014 introduced capability grants, but the only point at which they appeared was consent at plugin install/activation time (`grantConsented` from the manifest). A plugin could not request a grant while running: for example, `camera.request` or `network.domains` with a narrow scope only make sense after the user has reached a specific action. The SDK already declared `api.capabilities.request()`, but the sandbox replied `PROTOCOL_UNSUPPORTED` — the only documented core gap. Additionally, when a grant was revoked, the web host did not remove it from the frame's live list: enforcement kept working until the next plugin refetch.

## Decision

1. **Server.** `CapabilityBroker.grantRuntime(pluginId, request)` — the single point for issuing grants outside the manifest: `parseCapability` (null for names outside the catalog and `legacy.trusted`), scope normalization (`network:https://host` → `{kind:'origins', origins:[...]}`), idempotency (an active grant is returned as-is, the revision does not grow). REST: `POST /api/v2/plugins/:id/capabilities` → 200 `{grant}`; 400 `unknown-capability`; 404 for an unknown/disabled plugin. The grant is persisted in `plugin_capability_grants` and survives page reload and restart.
2. **Enforcement boundary.** Web slices and consent checks see the new grant immediately (mutation of the live `frame.plugin.grantedCapabilities` list + sandbox `K.grants`). The backend process receives the grant at the next plugin activation (activate on start/enable reads `grantedPermissions` from the DB) — this is documented behavior, not a hidden limitation.
3. **Consent UI.** Host-owned dialog (Radix Dialog, portal into the `modal.layer` slot): plugin name, capability, scope. One pending request per plugin (a repeated request → `CAPABILITY_DENIED` `consent-pending`), 60 s timeout (`consent-timeout`), Deny/Esc → `user-denied`. The plugin cannot style the dialog or forge consent.
4. **Revoke fix.** `plugin.capability.revoked` (SSE → web host) now removes the grant from the frame's live list (`onAppEventRevoked` splice) and synchronizes `K.grants` in the sandbox; enforcement stops immediately, without a refetch.
5. **SDK/sandbox.** `api.capabilities.request({name, scope?})` is implemented in the sandbox over the kernel port; after success `K.grants` is updated so that `granted(name)` returns `true` right away. Errors: `CAPABILITY_DENIED` (deny/timeout/pending/unknown-capability), `BACKEND_UNAVAILABLE` (server unreachable), `VALIDATION_FAILED` (bad name/scope).

## Alternatives

- **Extend consent only at plugin update** (reinstall with a new manifest): does not cover actions that only make sense in a session context and forces the user to reinstall the plugin; rejected.
- **Allow everything from the catalog without a dialog**: silent grant issuance is worse than an explicit request; rejected.
- **Keep runtime grants only in web-host memory**: lost on reload and invisible to the backend; the user decision is to persist them in the DB; rejected.

## Consequences

- Positive: a full "manifest-consent + runtime-consent" loop with a single grant model; revocation immediately stops enforcement on the web host; plugins get a documented way to obtain scoped grants on demand; test coverage of the consent loop (server 7, web 13, e2e).
- Negative: backend-process consistency lags by one activation (documented); the new errors (`consent-timeout`, `consent-pending`, `unknown-capability`) need localization; the dialog requires a11y support.
- Compatibility: additive change (new endpoint, new SDK method); old plugins without `request()` are unaffected; no DB migration required. Documentation: `docs/plugin-sdk/rev4-api.md` § `capabilities.request`, `CHANGELOG.md`.
