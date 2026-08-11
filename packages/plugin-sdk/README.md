# @neotavern/plugin-sdk

Versioned Plugin SDK v2. Plugins depend on this package instead of
React/Zustand/Fastify/SQLite (AGENTS.md §17).

## Public API

- `definePlugin()` / `defineServerPlugin()` — typed wrappers.
- `validateManifest()` — validation of `plugin.json` (id, semver, apiVersion,
  permissions).
- `Permissions`, `hasPermission()`, `diffPermissions()`, `parsePermission()` —
  the permission model (`network:<host>` etc.).
- `EventBus`, `AppEventMap` — typed event bus.
- `Disposables` — tracking of cleanup functions.
- `PluginRuntime`, `activateFrontendPlugin()`, `activateServerPlugin()` —
  host-enforced lifecycle with automatic collection of registrations.
- Frontend: `FrontendPluginApi`, `definePlugin`, def types (messageActions,
  pages, toolbar, dialogs, character tabs, safe-text message renderers, slash,
  interceptors, …).
- Backend: `ServerPluginApi`
  (routes/storage/events/logger/fetch/providers/contextStrategies/postProcessors/files).
  Tokenizer, context strategy and post-processor registrations are
  automatically included in lifecycle cleanup.

## Cleanup contract

Every registration returns a cleanup function; after `deactivate()` no
handlers, timers, DOM nodes, routes or subscriptions remain.

The host MUST activate plugins via `activateFrontendPlugin()` or
`activateServerPlugin()`. The runtime intercepts registrations of UI, routes,
events, i18n, notifications, providers/tokenizers, context strategies and
post-processors, so cleanup runs even if plugin code did not keep the returned
function. If `activate()` throws, already-created registrations are rolled
back; if `deactivate()` throws, cleanup still completes.

## Dependencies

- `@neotavern/contracts`, `@neotavern/shared`.

## Commands

```bash
pnpm --filter @neotavern/plugin-sdk build
pnpm exec vitest run packages/plugin-sdk
```

## Constraints

The package contains no React/DOM — mount points are typed as `unknown`, the
concrete types are supplied by the host (`apps/web`). The production frontend
runs in a sandboxed iframe, the backend in a separate permission-limited
Node.js process; callback boundaries accept only serializable values.
`node:vm` is not used as a sandbox. Main-window/Express legacy entry points
are a separate trusted mode requiring explicit `legacy.trusted` consent.
See [docs/plugin-sdk](../../docs/plugin-sdk/README.md).
