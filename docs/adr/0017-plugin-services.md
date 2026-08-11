# ADR-0017: Cross-plugin services (rev4 §D, `api.services`)

## Context

Plugins must exchange functions and data: a catalog reader calls another plugin's search, an image generator takes a third plugin's pre-prompt, and so on. The naive model "the consumer imports the provider's function" is impossible: each plugin lives in its own sandbox (iframe with opaque origin / separate process), and passing functions across the boundary is impossible in principle.

A reasonable alternative is "the provider publishes, the consumer invokes" over the already existing host-mediated kernel port (ADR-0014): the host knows all participants, owns the registry, and can apply limits. `api.services` had been deferred "until a specification appears"; this decision is that specification.

## Decision

1. **Host-owned registry and connections.** The provider registers only service metadata (`services.provide`): `name`, `methods`, `version?`, `description?`, `timeoutMs?`. An `services.invoke` call is routed by the host into the provider's own session via `session.call('services.invoke', …, {deadlineMs, signal })` — the handler runs in the provider's realm and never crosses the boundary as a function object. The result is JSON-safe data only.
2. **Host-prefixed `serviceId`.** The identifier is built by the host as `'<pluginId>.<name>'`. Hijacking another plugin's id is excluded by construction: a plugin cannot pick another plugin's prefix.
3. **Capabilities as roles.** `services.provide` is the provider role, `services.connect` is the consumer role (including `list()`). One plugin may hold both. Both are in the capability-name catalog; consent at activation like any grant.
4. **Limits and budget.** 16 services per plugin, 64 methods per service, 64 connections per consumer, 256 connections host-wide; payload ≤ 256 KiB JSON-safe in both directions (checked with `JSON.stringify` at the boundary); name — `^[a-zA-Z][a-zA-Z0-9_.]{0,63}$`. Service deadline: default 10 s, host cap 60 s (clamped to 1–60 s).
5. **Stable error codes.** The consumer gets `SERVICE_NOT_FOUND` (no connection/service removed), `SERVICE_METHOD_NOT_FOUND`, `SERVICE_UNAVAILABLE` (provider died mid-call), `SERVICE_TIMEOUT` (provider `OPERATION_DEADLINE`), `OPERATION_ABORTED` (consumer cancellation), `SERVICE_ERROR` with `details.providerCode` (a throw in the provider handler). `SERVICE_UNAVAILABLE`/`SERVICE_TIMEOUT` are marked retryable. Error texts are localized on the frontend (AGENTS.md §5).
6. **Cleanup by contract.** The provider's `dispose()` unregisters the service and all its connections; plugin deletion/deactivation via `finalizeFrameRemoval`/`onAppEventRevoked` cleans the registry and connection maps. Skipping cleanup is impossible — the maps live in `FrontendPluginRuntime`.
7. **v1 = web-only.** The slice works between web-sandbox plugins; backend plugins as providers/consumers are an explicit non-goal (a separate RPC mechanism between backend processes, if ever needed).

## Alternatives

- **Direct function passing between plugins** (the consumer takes an object from the registry): impossible — functions do not serialize across sandbox boundaries; contradicts the core isolation model (ADR-0007/0014). Rejected.
- **`invoke(serviceId, method, params)` without connect/disconnect** (one-shot calls by id): simpler, but gives neither the user nor the host visibility and control over bindings, complicates revocation and per-consumer limiting; connections are host-owned state in the spirit of ADR-0015/0016. Rejected.
- **Services as runtime plugins through the existing backend-RPC**: mixes compute roles with inter-plugin exchange and requires a shared registry across backend processes; outside the v1 scope. Rejected until a separate decision.
- **Keep `api.services` deferred**: inter-plugin integration is a baseline SDK need (examples: catalog search, pre-prompts, pluggable renderers). Rejected — the contract is fixed in this ADR.

## Consequences

- Positive: calls are safe by construction (functions never cross boundaries, payload is JSON-safe and bounded); squatting is excluded by the host prefix; the host owns the registry — limits, deadlines and revocation work centrally; tests: kernel 18/18 + e2e `rev4-services.spec.ts` (provide → cross-plugin invoke → provider disabled → graceful degrade).
- Negative: host-routing overhead per call (one RPC hop per `services.invoke`); v1 without backend providers; connections do not survive a page reload (unlike the OAuth connections of ADR-0016) — the consumer restores them via `connect()`.
- Compatibility: additive change (new SDK namespace, two new capability names, new wire methods); REST/DB unchanged; old plugins without `services` are unaffected. Documentation: `docs/plugin-sdk/rev4-api.md` § `services`, `CHANGELOG.md`.
