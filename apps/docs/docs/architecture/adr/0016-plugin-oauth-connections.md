---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0016-plugin-oauth-connections.md
---

# ADR-0016: Plugin OAuth connections (rev4 §K5, `api.auth`)

## Context

External services (messaging, calendars, file sharing, LLM providers with user accounts) require OAuth authorization, and plugins need a way to access them on the user's behalf. The naive option "the plugin keeps the token in its own sandbox storage" does not work for three reasons:

1. **Secret problem.** OAuth confidentiality requires a `clientSecret` for the code exchange, but plugin code lives in a sandbox (iframe with opaque origin or a separate process) — it cannot store a secret reliably. That leaves the public-client flow, which forbids a refresh cycle without a secret.
2. **Exfiltration risk.** A token in the plugin's hands means any bug in untrusted code (or the plugin itself) can carry the token out; the core security model (ADR-0014) is built on data never leaving the boundaries without explicit permission.
3. **User control.** A connection to an external service is long-lived, reversible, sensitive state; it must be host-owned (visible in the UI, revocable in one click), like the capability grants of ADR-0015.

`api.auth` had been deferred "until a specification appears"; this decision is that specification.

## Decision

1. **Host-owned PKCE loop.** The server is the only party involved in OAuth: it creates the `state` (one-time, 32 bytes) and the PKCE `code_verifier` (32 bytes), stores them in the connection record, builds the `authorizationUrl`, receives the IdP callback, exchanges the code for a token, and stores the token in `plugin_auth_connections` (`token_json`). The sandbox and web UI see only metadata: `connectionId`, `serviceId`, `serviceName`, `scopes`, `status`.
2. **Tokens never leave the server.** `api.auth` returns metadata; authorized requests go through `api.network.fetch(url, {connectionId})`: the server-side proxy (`POST /api/v2/plugins/:id/auth/fetch` and backend-RPC `network.fetch`) resolves the token and injects `Authorization` server-side. `resolveConnectionAuthorization()` is the single point that turns a token into a header; an expired token moves the connection to `expired` and publishes `plugin.auth.expired`.
3. **Public OAuth clients only.** The manifest declares `authClients`: `clientId` without `clientSecret`. The code exchange uses PKCE S256, redirects during the exchange are forbidden (`redirect: 'error'`), timeout 15 s. Refresh without a secret is impossible — v1 does not refresh tokens automatically; an expired connection requires renewed consent. Descriptors change only via reinstall.
4. **HTTPS-only with a loopback exception.** `authorizationUrl`, `tokenUrl` and the targets of authorized fetch are HTTPS; the exception is plain-HTTP loopback (`127.0.0.1`, `localhost`, `[::1]`), so a local IdP or dev gateway works without TLS (in the spirit of local-first, no-cloud operation).
5. **One-time `state`.** The callback does not require an enabled plugin (the state is the proof of the loop), so half-completed consent survives a plugin restart; with a disabled plugin the state is not burned. A successful callback burns the state — a repeated callback fails with `STATE_EXPIRED`.
6. **Events.** `plugin.auth.connected/revoked/expired` (`{pluginId, connectionId, serviceId}`) in the SSE whitelist and `api.events.subscribe`; the web host uses them to update the connections dialog instantly.
7. **Management.** Host-owned Connections dialog (Radix, portal into `modal.layer`): list, statuses, scopes, Connect/Revoke buttons; capability `auth.connections` in the manifest's `requiredCapabilities` (consent at activation, like any grant).

## Alternatives

- **Client-side PKCE in the sandbox** (the plugin runs the loop itself, token in `storage.kv`): no secret needed, but the token lives in untrusted code, allows exfiltration, is invisible to the user and not revocable by the host; contradicts the core security model; rejected.
- **Refresh loop with a `clientSecret` in the manifest**: a secret in the manifest reaches the sandbox and is accessible during package analysis; OAuth public clients forbid refresh without a secret. Deferred until a separate host-managed secret store (v2).
- **Transparent oauth-proxy on a separate port** (host holds tokens, plugin talks to a local proxy): duplicates the existing `network.fetch` proxy mechanism and complicates the environment model; rejected.
- **Keep `api.auth` deferred**: external integrations require OAuth everywhere; this slice implements the minimal secure subset. Rejected — the contract is fixed in this ADR.

## Consequences

- Positive: tokens never leave the server (the single point of leakage is eliminated by construction); connections are host-owned: visible, revocable, survive reload and plugin restart (persisted in the DB); e2e with a mock IdP covers the whole loop (authorize → callback → connected → signed fetch → revoke); the sandbox gets a documented `api.auth` without widening core privileges.
- Negative: v1 without automatic refresh — expired tokens require renewed consent; `authClients` are static (reinstall to change); the `plugin_auth_connections` table adds secret storage to the DB — it requires the same rules as `provider_secrets` (no tokens in logs, diagnostics, or browser storage).
- Compatibility: additive change (new `/auth/*` endpoint block, new migration 0017, new SDK namespace); old plugins without `authClients` are unaffected; existing `api.network.fetch` without `connectionId` works as before. Documentation: `docs/plugin-sdk/rev4-api.md` § `auth`, `docs/api/README.md` § "Plugin OAuth connections", migration 0017, `CHANGELOG.md`.
