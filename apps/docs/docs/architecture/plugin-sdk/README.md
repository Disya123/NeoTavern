---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/plugin-sdk/README.md
---

# Plugin SDK

## Sandboxed multi-surface composition

Each native frontend plugin owns one full-viewport sandbox iframe. Every SDK
registration receives an isolated root inside that iframe. The host batches
the rectangles of active mounts and supplies them to the sandbox; an SVG clip
path limits both the visible and interactive iframe area to their union. Thus
pointer events outside a plugin surface remain with the application.

Dialog registrations are placed above regular surfaces for the same plugin;
the documented system surface still has higher priority. Unmounting a
registration removes only its root and geometry tracker. Reload, disable,
crash, and shutdown remove all roots, trackers, and clip regions for that
plugin only. Plugin UI must not rely on iframe-per-registration behavior.

Plugins depend on the versioned `@neotavern/plugin-sdk`, not directly on
React/Zustand/Fastify/SQLite (AGENTS.md §17).

## Manifest (plugin.json)

```json
{
  "id": "author.plugin-name",
  "name": "Plugin Name",
  "version": "1.0.0",
  "apiVersion": 2,
  "engines": { "neotavern": "^0.1.0" },
  "frontend": "dist/frontend.js",
  "backend": "dist/backend.mjs",
  "permissions": ["chat.read", "ui.messageActions", "network:api.example.com"],
  "legacy": {
    "frontend": "legacy/main-window.js",
    "backend": "legacy/server.mjs"
  }
}
```

The `.stplugin` package is a ZIP with a manifest. `validateManifest()` checks
the id (reverse-DNS), the semver version, `apiVersion <= 2`, and permission
validity.

For OAuth connections (rev4 §K5, `api.auth`) the manifest may declare public
OAuth clients — `authClients`:

```json
{
  "authClients": [
    {
      "serviceId": "com.example.idp",
      "name": "Example IdP",
      "authorizationUrl": "https://idp.example.com/oauth/authorize",
      "tokenUrl": "https://idp.example.com/oauth/token",
      "clientId": "neotavern-<plugin-id>",
      "scopes": ["profile.read"]
    }
  ]
}
```

Only public clients with PKCE: `clientSecret` is forbidden, plugin code lives
in a sandbox. `serviceId` is a unique reverse-DNS; `authorizationUrl`/`tokenUrl`
accept HTTPS only, with the exception of plain-HTTP loopback (`127.0.0.1`,
`localhost`, `[::1]`) for a local IdP in development. Descriptors change only
by reinstalling the plugin. The API contract is
`docs/plugin-sdk/rev4-api.md`, § «auth».

## Permissions

`chat.read`, `chat.write`, `characters.read/write`, `lorebook.read/write`,
`prompt.inspect`, `prompt.modify`, `providers.register`, `ui.toolbar`,
`ui.sidebar`, `ui.messageActions`, `ui.shell`, `clipboard.read/write`,
`notifications`, `server.routes`, `network:<host>`, `files:plugin`,
`files:user-selected`.

The special form `network:*` is a wildcard that allows fetch to ANY host. The
host treats it as full network access; the consent UI MUST show such a
permission with an enhanced warning, and publishing plugins that request
`network:*` is not recommended — request specific `network:<host>` instead.

A list is shown at install time; adding new permissions after an update
requires re-consent (`diffPermissions()`).

A permission in the manifest is a capability request, not automatic access.
The production host applies permissions to implemented UI registrations,
routes, provider/context APIs, virtual files, notifications, and network
fetch. Declared future surfaces (`lorebook.*`, clipboard, and user-selected
files) should not be considered available until the corresponding host API
exists.

## Capability kernel (rev4)

The permission layer is implemented as a capability kernel: the `kernel`
namespace of the `@neotavern/plugin-sdk` package
(`packages/plugin-sdk/src/kernel/`). The same code checks grants in the web
host and on the server, so the browser and backend see the same set of rights.

- **Manifest.** `requiredCapabilities`/`optionalCapabilities` — requests
  `{ name, scope? }` (`kernel.parseCapability`); legacy `permissions` strings
  are aliased into the v4 catalog. The user confirms any subset.
- **Grants.** Stored in `plugin_capability_grants` (migration 0016) with a
  monotonic `revision`; delivered to the sandbox in the host handshake
  (`grantedCapabilities`) and to the backend host through the capability
  broker (`apps/server/src/plugin/capabilityBroker.ts`).
- **Runtime check.** Enforcement points call `broker.check(pluginId,
request)`; the semantics are `kernel.grantSatisfies` (name match + scope
  coverage).
- **Revocation.** `revoke`/`revokeAll` mark the row revoked, bump the
  revision, and publish `plugin.capability.revoked` on the event bus (SSE →
  web host → kernel session → plugin). In-flight operations finish with
  `CAPABILITY_REVOKED`, open handles are closed by the host. Active grants:
  `GET /api/v2/plugins/:id/capabilities`.
- **Feature negotiation.** The host handshake advertises `supportedFeatures`
  (`ui.overlays`, `backend.byte-stream`, `storage.kv`, `chat.draft`,
  `ui.commands`, `jobs.background`); the plugin checks
  `api.runtime.supports(feature, version)`.
- **Protocol.** One transferred `MessagePort` per sandbox (one-shot bootstrap
  with a nonce), envelopes with `instanceId`/`requestId`/`sequence`/
  `deadline`, cancellation via `rpc.cancel`, pull-based byte streams with
  credits (backpressure, bounded memory). Errors are stable machine codes
  `kernel.KernelErrorCode` (`CAPABILITY_DENIED`, `CAPABILITY_REVOKED`,
  `REVISION_CONFLICT`, `PLUGIN_QUOTA_EXCEEDED`, …) with `retryable`,
  `retryAfterMs`, `details`.
- **User state.** Plugin state does not live in the registry but in
  `plugin_state`: scope `user|workspace|chat|installation`, `owner_id`, CAS
  `revision` separate from the data format `schema_version` (repository
  `repos.pluginState`).

Currently the kernel serves the bootstrap handshake, feature registry, limits,
and revocation notifications to the sandbox; the rest of the RPC migrates to it
incrementally. Decision and alternatives:
[ADR-0014](../adr/0014-plugin-capability-kernel.md). The public kernel API for
plugin authors: [rev4-api](rev4-api.md); reference examples —
`plugins/rev4-storage/` and `plugins/rev4-overlay/` (overlay walkthrough:
[examples/rev4-overlay-game.md](examples/rev4-overlay-game.md)), plus the
e2e-verified `plugins/rev4-tools/`, `plugins/rev4-blocks/`, `plugins/rev4-agent/`
(toolbar commands, notifications, message blocks, backend worker with routes —
the full cycle in `e2e/rev4-samples.spec.ts`).

Provider models are available through `api.models.list(providerId?)` (without
`providerId` — the active provider) and the ready-made widget
`api.ui.modelMenu` (contract — `rev4-api.md` § «models and the model menu»);
example — `plugins/rev4-modelmenu/`.

For inter-plugin RPC (rev4 §D, `api.services`) the provider registers a service
capability `services.provide`, the consumer connects with the capability
`services.connect`; `serviceId` is host-prefixed (`<pluginId>.<name>`), the
host routes calls into the provider session. Examples: `plugins/rev4-service/`
and `plugins/rev4-service-client/` (full cycle in
`e2e/rev4-services.spec.ts`). The API contract is `docs/plugin-sdk/rev4-api.md`
§ «services»; decision — [ADR-0017](../adr/0017-plugin-services.md).

## Frontend

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const off = api.ui.messageActions.register({
      id: 'example.translate',
      title: () => api.i18n.t('translate'),
      icon: 'translate',
      order: 90,
      placement: 'primary',
      // v2: the context receives a message snapshot + AbortSignal;
      // messageId/chatId stay at the top level (see below).
      run: async ({ message, signal }) => {
        if (message.content) await translate(message.content, signal);
      },
    });
    const offEvent = api.events.on('chat.message.created', onMessage);
    // save the cleanup functions for deactivate
  },
  deactivate() {
    // full cleanup: handlers, timers, DOM, subscriptions
  },
});
```

Each registration returns a cleanup function. After deactivation there must be
no remaining handlers, timers, DOM nodes, routes, or subscriptions.

The NeoTavern production host activates frontend plugins in isolated sandbox
iframes (postMessage RPC, `apps/web/src/plugins/runtime.ts`), and backend
plugins in a separate Node process with capability IPC
(`apps/server/src/plugin/backendHost.ts`). The exported `PluginRuntime`,
`activateFrontendPlugin()`, and `activateServerPlugin()` are a reference
in-process implementation for alternative hosts and tests; the main host does
not use them (treat them as `@deprecated` for production integrations). Both
runtimes automatically collect cleanup functions for UI registrations, routes,
event subscriptions, i18n, notifications, providers/tokenizers, context
strategies, and post-processors. Deactivation is idempotent; a failed
activation rolls back partial registrations, and an error in the user's
`deactivate()` does not cancel the mandatory resource cleanup.

Available registrations: pages, settings panels, toolbar, message actions,
context menu, slash commands, prompt interceptors, event handlers, message
renderers, character tabs, sidebar panels, dialogs, notifications, hotkeys,
commands, and i18n resources. A message renderer returns only safe text
(`replace` or `after`), not HTML. `mount(root, context)` runs inside the
plugin iframe; the character tab receives a `characterId`.

The frontend entry loads only for an active/consented package and runs in an
`iframe sandbox="allow-scripts"` without `allow-same-origin`. The host receives
serializable metadata/callback results via `postMessage`, mounts the iframe
into stable slots, and sends an unmount/deactivate handshake.

### Adaptive toolbar actions

`ui.toolbarActions.register()` passes the host only the action semantics
(`id`, localizable `title`, optional `icon`, `run`). The host renders the
action itself as a standard button inside `data-component="action-bar"` and
chooses wrapping or local scrolling based on the available width. The plugin
neither receives nor should compute viewport/panel width, add its own
breakpoints, or depend on internal React/CSS Modules classes.

Stable hooks are available for themes: `data-component="plugin-toolbar"`,
`data-part="actions"`, `data-component="action-bar"`, `data-part="group"`,
`data-role="primary"`, and on the button `data-part="icon|label"`. The label
must be short but must remain a fully localized accessible name; the host does
not replace it with an icon alone when the panel narrows.

A prompt interceptor with `prompt.modify` is invoked after server context
shifting. The browser returns the result over a one-shot SSE rendezvous; the
errors and timeout of one plugin do not stop the chain. After the result, the
server restores protected messages and re-applies the token budget.

### Message actions (v2)

`api.ui.messageActions.register(def)` — actions on the message panel
(`MessageActionDef` in `packages/plugin-sdk/src/frontend.ts`).

- **`run()` context — BREAKING in v2.** The context receives an immutable
  message snapshot `message: MessageActionSnapshot`
  (`{ messageId, chatId, branchId, role, content, name, meta, revision }`)
  and a `signal: AbortSignal`. The `messageId` and `chatId` fields are kept at
  the top level of the context, so old callbacks `({ messageId, chatId }) => …`
  keep working unchanged. Migration: to read the message text, switch to
  `context.message.content`; interrupt long operations via `context.signal`.
- **Content is gated per-plugin.** `message.content` is `null` if the plugin
  does not hold **both** the `ui.messageActions` and `chat.read` permissions
  (role/revision/meta are available without `chat.read`). Adding `chat.read`
  to an already installed manifest moves the package to `needs-consent`.
- **`icon`** is a semantic name from the host allowlist (`translate`, `speak`/
  `tts`, `summarize`, `rewrite`, `analyze`, `copy`, `save`, `delete`, `like`,
  `dislike`, `pin`, …); an unknown name renders as a puzzle-piece fallback
  icon. The `title` label is shown by the host as-is — the plugin localizes it
  itself (for example, via `api.i18n` at registration time).
- **`order`** (number, default `100`, smaller renders first) and **`placement`**
  (`'primary' | 'overflow'`, default `'primary'`): the SDK contract did not
  change. The host renders both sets in one inline message action panel
  (desktop `data-part="message-actions-inline"`, mobile — in the message card,
  §10.2.1 `docs/ux/README.md`); there is no «More» menu in the host.
- **`signal`** is aborted on host teardown (unmount, navigation, plugin
  disable), on a repeated invocation of the same action (a new call replaces
  the old one), and on timeout; an error in `run()` is isolated by the host
  and does not break the chat.
- **Legacy `contextMenuItems` with `context: 'message'`** keep working and are
  rendered in the same inline action panel (their context is `{ targetId }`,
  not a snapshot).
- Example: `plugins/rev4-translate/` — a «Translate» action (`icon: 'translate'`,
  `order: 90`, `placement: 'primary'`) that reads `context.message.content` and
  shows a mock translation via `api.notify` without external services. The
  kernel-path contract (`api.surfaces.register('messageActions', …)`) —
  `docs/plugin-sdk/rev4-api.md` § «message actions».

### Row gestures

The `@neotavern/plugin-sdk/gestures` submodule re-exports
`@neotavern/gestures` — framework-agnostic context menu (right click /
long-press) and drag-and-drop recognition for list rows. Plugins attach
handlers to their own DOM/React elements directly, without a dependency on
`@neotavern/ui`:

```ts
import { createRowGestures } from '@neotavern/plugin-sdk/gestures';

const rowGestures = createRowGestures({
  indexAttribute: 'data-tag-index',
  onOpenMenu: (tagId, at) => openTagMenu(tagId),
  onDragMove: (tagId, toIndex) => previewTagMove(tagId, toIndex),
  onDragEnd: () => saveTagOrder(),
  canDrag: (tagId) => pinnedTags.has(tagId) === false,
});

element.addEventListener('mousedown', (event) => rowGestures.onMouseDown(event, tag.id, index));
element.addEventListener('touchstart', (event) => rowGestures.onTouchStart(event, tag.id, index));
element.addEventListener('contextmenu', (event) => rowGestures.onContextMenu(event, tag.id));
element.addEventListener('dragstart', rowGestures.onDragStart);
// … on unmount/disable always call rowGestures.destroy().
```

The options contract and lifecycle are described in
`packages/gestures/README.md`. A plugin inside the sandbox iframe is
responsible for its own cleanup (AGENTS.md §17): the long-press timer and
document listeners are removed by `destroy()`.

## Backend

```ts
interface ServerPluginApi {
  routes: PluginRouter; // mounted under /api/plugins/{id}/
  storage: PluginStorage; // isolated key/value
  events: PluginEventBus;
  logger: PluginLogger;
  fetch: PermissionCheckedFetch; // only network:<host> from permissions
  providers: PluginProviderRegistry;
  contextStrategies: PluginContextStrategyRegistry;
  files: PluginVirtualFileSystem; // root — the plugin folder
}
```

`providers.registerTokenizer(profile)` registers a local model-specific
tokenizer (tiktoken, SentencePiece, Hugging Face tokenizer JSON, or a custom
format). The profile defines `id`, `approximate`, `matches(model)`, and
`count(text)`. The registration is automatically removed on
deactivate/rollback, so a disabled plugin does not affect the token budget.

`contextStrategies.register(strategy)` adds a context shifting strategy. The
host automatically removes the registration on deactivate/rollback, verifies
the integrity of system/pinned/current-user blocks, and after the strategy
result applies the final token budget itself. The `fitsBudget` value returned
by the plugin is not considered trusted.

The plugin is not given: a Fastify root, SQLite connection, internal tables,
absolute paths, all env, other providers' API keys.

The backend entry runs in a separate Node.js 24 process. A restricted loader
resolves package-local ESM, and capability IPC exposes only the SDK API. Routes
are mounted under `/api/plugins/{id}`, callbacks have a timeout and an
`AbortSignal`; a process crash removes all host registrations.

`events.on()` subscribes the worker to core app events. `events.emit()` allows
only its own namespace (`${pluginId}.event`); the payload is JSON-safe, at most
256 KiB, and no more than 128 event names per runtime at once. Subscriptions
are automatically removed on disable/crash/shutdown.

## Isolation

Native modes: Sandboxed UI (iframe + RPC) and Backend worker (separate
process). `node:vm` is not used as a sandbox.

`legacy.frontend` and `legacy.backend` are a separate trusted compatibility
mode, not a bypass of the native sandbox. The manifest MUST request
`legacy.trusted`, the UI shows an enhanced warning, and the user confirms the
permission explicitly. The legacy frontend runs in the main window; the
backend receives an Express Router limited to its own `/api/plugins/{id}`
namespace. Safe mode does not load legacy entry points.

The per-legacy-API authority map — supported contract, native-capability
mapping, isolation level, limits and support policy for each legacy surface —
lives in [`packages/legacy-compat/COMPATIBILITY.md`](https://github.com/Disya123/NeoTavern/blob/main/packages/legacy-compat/COMPATIBILITY.md)
and is enforced by the ARC-11 suite (`apps/server/test/legacyAuthority.spec.ts`):
legacy compatibility may translate or restrict an operation, but never grants
more authority than the corresponding native capability.

Detailed rationale: [ADR-0007](../adr/0007-plugin-runtime-isolation.md),
[ADR-0039](../adr/0039-legacy-compatibility-authority-boundary.md).

## Installing from a Git repository

The Plugin Manager accepts a public repository link (`github.com` or
`gitlab.com`, HTTPS only). The server **does not invoke the git binary**: it
downloads a repository archive (GitHub `codeload.github.com/.../tar.gz/{ref|HEAD}`,
GitLab `/-/archive/{ref}/...` — GitLab requires an explicit `ref`), which then
goes through exactly the same validation as a ZIP: path traversal, symlink/
native/executable payload, sizes, manifest, entry points, permissions.
Installation is atomic and rolls back on error.
`POST /api/v2/plugins/install-git` (see [API](../api/README.md#plugins));
disabled with `NEOTA_PLUGIN_GIT_INSTALL=false`.

## Package trust (ТЗ §SEC-05)

Every installed package carries an explicit trust state, recorded in
`InstalledPlugin.trust`:

| State                | Meaning                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `built-in`           | Package ships with the product (reserved for preinstalled packages; none today).             |
| `verified-publisher` | Package carries a signature from a trusted publisher key; every file digest was verified.    |
| `locally-trusted`    | Package is unsigned but the local user explicitly accepted it (via the consent/enable flow). |
| `unsigned-untrusted` | Package has no signature and no local trust decision yet.                                    |

Verification happens **before** any consent or filesystem promotion and is
fail-closed:

- a signed package contains `signature/manifest.json` (format
  `neotavern.package-signature.v1`, Ed25519, sha256) plus the raw 64-byte
  `signature/package.sig` over the exact manifest bytes;
- the manifest pins the sha256 digest of **every** file in the package — any
  extra, missing or modified file rejects the install;
- the signature is checked against the trusted publisher keyring
  (`NEOTA_PLUGIN_PUBLISHER_KEYS` — comma-separated base64-encoded raw Ed25519
  public keys);
- a signature from an unknown publisher rejects the install
  (`PLUGIN_SIGNATURE_UNTRUSTED`) — it is **never** downgraded to unsigned;
- a broken signature/digest rejects with `PLUGIN_SIGNATURE_INVALID`;
- unsigned packages install as `unsigned-untrusted` unless
  `NEOTA_PLUGIN_REQUIRE_SIGNATURE=true` rejects them with
  `PLUGIN_SIGNATURE_REQUIRED`;
- enabling an unsigned package through the consent flow records it as
  `locally-trusted`; local trust persists across unsigned updates of the same
  plugin id, while a fresh signature is always re-verified and wins.

Archive hardening (both ZIP and tar.gz, ТЗ §SEC-05): path traversal,
absolute/backslash paths, symlinks, encrypted entries, native/executable
payloads and duplicate normalized paths are rejected, and entry/expansion
limits bound zip bombs.

## Plugin dependencies (npm)

> **⚠️ Mandatory reading for plugin authors.**
>
> **It is recommended to bundle dependencies with esbuild/rollup.** On-the-fly
> npm dependency resolution is intended **only for heavy WASM libraries**
> (ML/ONNX runtimes, etc.) that are impractical or impossible to include in a
> bundle. Everything else should be built into a single entry file: it is
> faster, more reliable, and not subject to version conflicts.

If the package root has a `package.json` with `dependencies`, the built-in
installer (without invoking `npm`, without executing install scripts)
resolves them from `registry.npmjs.org` (overridable with
`NEOTA_PLUGIN_REGISTRY`) and lays them out in `node_modules` inside the
package:

- registry versions only: semver ranges (`^ ~ >= <= * ||`, etc.) and
  dist-tags; `git+`, `file:`, `workspace:`, URL tarballs →
  `PLUGIN_DEPS_UNSUPPORTED` before download starts;
- transitive dependencies are included (BFS) and hoisted into a **flat**
  `node_modules`; if two branches require incompatible versions of the same
  package, the install fails with `PLUGIN_DEPS_CONFLICT` — this is a
  deliberate v1 limitation, fixed by bundling (see the warning above);
- tarballs are verified against the registry `integrity` (sha512/sha256),
  cached in `data/cache/plugin-deps/` with a limit; limits:
  `NEOTA_PLUGIN_DEPS_MAX_PACKAGES` (default 300 packages),
  `NEOTA_PLUGIN_DEPS_MAX_BYTES` (default 200 MB unpacked);
- after unpacking, `node_modules` is scanned: native binaries and executable
  files (`.node`, `.exe`, `.dll`, `.so`, `.dylib`, `.bat`, `.cmd`, `.ps1`,
  `.sh`, `.msi`, `.bin`) → `PLUGIN_DEPS_FORBIDDEN_FILE` and rollback; bin
  links are not created, install/postinstall scripts are **never executed**;
- the result is recorded in `node_modules/.neotavern-deps.json` (name/version/
  tarball/integrity of each package) and in the plugin's registry entry
  (`InstalledPlugin.dependencies`); the UI shows this list before activation.

The plugin's backend code may import bare specifiers from its own
`node_modules` only when the `.neotavern-deps.json` marker is present; the
loader still forbids `node:*`, `data:`, `http(s):`, and any resolution outside
the package root. v1 limitation: dependencies that need Node built-in modules
(`node:fs`, `node:path`, …) will not load — pure-JS/WASM packages are
supported. Frontend plugins are unchanged: the author bundles frontend
dependencies themselves.

## Installation and lifecycle

1. The user installs a bounded `.stplugin` ZIP **or** a Git link through the
   Plugin Manager.
2. The host validates the manifest, paths, file types, installs npm
   dependencies, and atomically replaces the package.
3. The status `needs-consent` is retained until exact confirmation of all
   requested permissions; a package with npm dependencies additionally shows
   their list.
4. At activation, backend/legacy registrations start first; an error rolls
   back the partial activation and keeps `PLUGIN_LOAD_FAILED`.
5. Disable, safe mode, delete, crash, and shutdown perform host-enforced
   cleanup.
6. An update that adds a permission disables the runtime until new consent.
