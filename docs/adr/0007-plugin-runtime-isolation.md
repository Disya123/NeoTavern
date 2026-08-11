# ADR-0007: Plugin SDK isolation and trusted legacy mode

## Context

Plugins must extend the frontend, backend, provider registry and prompt
pipeline, but must not get direct access to React, Fastify, SQLite, secrets
and the user's file system. At the same time, the project keeps explicitly
documented compatibility with SillyTavern legacy extensions, which
historically ran in the main window and used Express Router.

## Decision

The native Plugin SDK v2 is split into two untrusted runtimes:

- the frontend entry runs in an `iframe sandbox="allow-scripts"` without
  `allow-same-origin`; the host accepts only serializable registrations and
  interacts with the iframe via `postMessage`;
- the backend entry runs as a separate Node.js 24 process with a Permission
  Model, a restricted ESM loader and capability-checked IPC. The plugin gets
  no Fastify, SQLite connection, env, absolute paths or raw network API;
- backend-plugin routes are proxied only under
  `/api/plugins/{pluginId}/...`; storage and the virtual file system are
  isolated by plugin ID;
- provider, tokenizer and context-strategy callbacks run in the child
  process. The host re-validates responses, the protected prompt context and
  the final token budget;
- event subscriptions, routes, providers, tokenizers, context strategies,
  iframe mounts and pending callbacks are torn down by the host on disable,
  crash, activation rollback and shutdown;
- frontend prompt interceptors use a bounded SSE rendezvous: the host sends
  `plugin_intercept`, the browser returns a serializable result via a
  one-time request ID, after which the server restores the protected messages
  and re-applies the token budget.

Legacy entry points are allowed only with `legacy.trusted` in the manifest
and with separate explicit user consent. The legacy frontend runs in the main
window, the legacy backend — via an Express application isolated for the
specific plugin. Safe mode loads neither native nor legacy entry points.

## Alternatives

- `node:vm` rejected: it is not a security boundary for untrusted
  Node.js code.
- Running backend plugins in the Fastify process rejected: a capability leak
  or crash would affect the core and user data.
- Trusted frontend ESM for all plugins rejected: arbitrary code would get the
  DOM, credentials and SPA internals.
- Complete removal of legacy rejected due to the compatibility requirement;
  instead the risk is made explicit and opt-in.

## Consequences

- The Plugin API accepts only clone/JSON-safe values and has size and timeout
  limits; synchronous direct access to internals is impossible.
- The backend worker requires a bundled Node.js 24 and is included in the
  desktop resources.
- Some DOM-heavy legacy extensions work only in trusted mode and retain the
  risks of main-window execution.
- An update that adds permissions moves the package to `needs-consent`; the
  old runtime is disabled until re-consent.
- A crash of one native plugin must not stop the server or the prompt
  pipeline; it is diagnosed with a stable error code.
