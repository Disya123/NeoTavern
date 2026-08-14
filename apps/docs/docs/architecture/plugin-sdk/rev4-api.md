---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/plugin-sdk/rev4-api.md
---

# Plugin SDK rev4 — kernel API

Status: implemented (revision 4). Source of truth for the wire protocol —
`packages/plugin-sdk/src/kernel/session.ts`; this page describes the public
model for plugin authors. Installation and manifest overview —
[README](README.md).

## 0. Invariants

- Unprivileged code never executes in the application origin: the plugin
  frontend lives in a sandboxed iframe (`sandbox="allow-scripts"`, opaque origin),
  the backend — in a separate process that does not inherit the host environment.
- The sandbox iframe is additionally constrained by Permissions-Policy: the `allow`
  attribute lists in `'none'` all sensitive browser features (camera,
  microphone, geolocation, clipboard-read/write, usb/serial/hid/bluetooth,
  local fonts, high-entropy UA, storage-access, credential/OTP flows,
  local network access, etc.), so the plugin cannot observe the user's devices,
  environment, or data even if the application policy is widened.
- Every privileged operation passes a capability check on the host
  (web runtime or backend host); the check in the sandbox is fail-fast, not a boundary.
- Permission to compute does not grant permission to data.
- All long-running operations are cancellable (`AbortSignal` in the SDK, `rpc.cancel` on
  the wire); all streams have credit-based backpressure; every registration
  returns a cleanup.
- Degradation is explicit: proxy-mode overlays deliver synthetic pointer packets
  and never pretend to be native input.

## 1. Bootstrap and handshake

The host creates a `MessageChannel`, transfers `port2` in a single `postMessage` with a
one-time nonce; after the ACK all traffic goes only over the port. The sandbox
receives in the handshake:

```ts
{
  protocolVersion: '2.0.0';
  hostVersion: string;
  grantedCapabilities: CapabilityGrant[]; // {name, scope?, revision, grantedAt}
  supportedFeatures: Record<string, number>;
  limits: PluginLimits;
}
```

Feature negotiation happens in the sandbox: `api.runtime.supports('ui.overlays', 3)`.
Current host feature registry: `ui.overlays:3`, `backend.byte-stream:1`,
`storage.kv:1`, `storage.blobs:1`, `ui.commands:1`, `ui.surfaces:1`,
`ui.messageBlock:1`, `chat.draft:1`, `chat.events:1`, `jobs.background:1`,
`network.proxy:1`, `actions.host:1`, `ui.notifications:1`.

Features differ from capability grants: `supportedFeatures` — the capabilities
of a particular host (checked via `api.runtime.supports`), `grantedCapabilities`
— permissions confirmed by the user. To check an issued grant,
use `api.capabilities.granted(name)` / `api.capabilities.list()`, not
`supports()`.

## 2. The `api` namespaces

| Namespace           | Purpose                                                                                                                            | Capability                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `api.runtime`       | `supports()`, `limits()`, protocol versions                                                                                        | —                                                                              |
| `api.capabilities`  | current grants: `granted(name)`, `list()`, `request()`, `onRevoked(listener)`                                                      | —                                                                              |
| `api.diagnostics`   | `get()` — read-only snapshot of the plugin's own runtime state                                                                     | —                                                                              |
| `api.auth`          | OAuth connections: `list()`, `get()`, `connect()`, `revoke()` — metadata only, tokens never leave the server                       | `auth.connections`                                                             |
| `api.services`      | cross-plugin RPC: `provide()`, `list()`, `connect()`, `invoke()`, `disconnect()`                                                   | `services.provide` (provider) / `services.connect` (consumer)                  |
| `api.storage.kv`    | JSON KV with CAS revision, scopes: installation/user/workspace/chat                                                                | `storage.installation` / `storage.user` / `storage.workspace` / `storage.chat` |
| `api.storage.blobs` | content-addressed binary objects, streaming write/read                                                                             | `storage.blobs`                                                                |
| `api.backend`       | `request()` (byte-stream response) and `invoke()` (JSON) to the plugin's own backend                                               | `compute.backend`                                                              |
| `api.commands`      | palette commands: `register(id, def, runner, {kernel?})`, `unregister`                                                             | `ui.commands`                                                                  |
| `api.surfaces`      | v2 surface registrations (toolbar, dialogs, pages, message actions, …)                                                             | `ui.surfaces`                                                                  |
| `api.overlays`      | fullscreen/spot overlays with hitPolicy                                                                                            | `ui.overlay.<mode>`                                                            |
| `api.chats`         | `current()`, `listMessages()`, `append()`, `draft.*`                                                                               | `chats.read.*`, `chats.write.plugin`, `chats.draft`                            |
| `api.blocks`        | message block renderers: `registerRenderer`, `attach`                                                                              | `ui.messageBlock`                                                              |
| `api.jobs`          | background jobs: `schedule` (one-shot/interval/cron), `cancel`, `list`, `ack`, `retry`, `onRun`                                    | `jobs.background`                                                              |
| `api.workers`       | isolated compute workers: `spawn({entry, name?, signal?})` → handle (`postMessage`, `onMessage`, `onError`, `closed`, `terminate`) | `compute.worker`                                                               |
| `api.network`       | proxied fetch through the host (allowlist + secret injection)                                                                      | `network:*` / `network:<host>`                                                 |
| `api.models`        | provider models: `list(providerId?)` — without providerId the active provider is resolved                                          | `models.list`                                                                  |
| `api.ui.modelMenu`  | ready-made model picker widget: `modelMenu(container, options)` → `{dispose, setValue}`                                            | `models.list`                                                                  |
| `api.actions`       | user-activation-gated actions: clipboard, notifications, files.pick                                                                | `actions.host`                                                                 |
| `api.notifications` | toast notifications: `show({title, description?, variant?, timeoutMs?})`, `dismiss`                                                | `notifications.show`                                                           |
| `api.events`        | rev4 subscriptions `subscribe`/`unsubscribe` (whitelisted app events) + v2 `on` + `onKernelRevoked`                                | `chats.read.current` — only for chat-content events                            |

### commands and the kernel flag

`api.commands.register(id, definition, runner, opts?)`. With
`opts.kernel === true` the command is registered as a kernel surface
(`registrationId = cmd:<id>`): the host renders it in the plugin toolbar and invokes the
runner over the kernel port (`commands.run`), bypassing the legacy v2 postMessage path.
Without the flag the registration goes to the legacy v2 layer and is not invoked
from the toolbar in a rev4 sandbox. Host invocation from the UI:
`runPluginCommand(ctx, commandId, context)`.

`api.capabilities.list()` returns an array of grants `{name, scope?, revision,
grantedAt}` (not strings); `granted(name)` — a synchronous check against the handshake.

### capabilities.request (runtime grants)

`api.capabilities.request({name, scope?})` requests a grant while the plugin
is running (rev4 §B2). The host shows a consent dialog; if approved, it persists the
grant on the server (`POST /api/v2/plugins/:id/capabilities`) and returns it to the
sandbox; `K.grants` is updated, so a subsequent `granted(name)` already
returns `true`. One pending dialog per plugin; while one is busy, a repeated
request is rejected immediately.

- An already-issued grant resolves immediately without a dialog (idempotently).
- Denial/Esc/timeout (60 s) → `CAPABILITY_DENIED` (details.reason:
  `user-denied` / `consent-timeout` / `consent-pending`).
- Server unavailable → `BACKEND_UNAVAILABLE`.
- The grant survives a page reload (stored in the DB) and participates in
  enforcement on both hosts: web slices see it immediately, the backend process —
  from the plugin's next activation (activate on start/enable).
- `camera.request` and other catalog names absent from the manifest can be
  obtained only this way; `legacy.trusted` is never issued at all.
- Grant revocation (e.g. on deactivation) reaches the plugin via
  `capability.revoked`; the host removes the grant from the live list immediately.

### diagnostics

`api.diagnostics.get()` returns a read-only snapshot of the plugin's own
runtime state (rev4 §C). No capability is required — this is the plugin's own
data, like `capabilities.list`:

```ts
interface DiagnosticsSnapshot {
  protocolVersion: string; // '2.0.0'
  sdkVersion: string; // '1.0.0'
  instanceId: string; // sandbox session identifier ('rev4:...')
  plugin: {
    id: string;
    name: string;
    version: string;
    apiVersion: number;
    status: string; // runtime status from the registry
    lastErrorCode: string | null;
    compatibilityLevel: string;
  };
  limits: PluginLimits | null; // current limits (copy)
  features: Record<string, number>; // host feature registry (keys of api.runtime.supports)
  grants: CapabilityGrant[]; // active grants, cap 64
  crash?: {
    count: number; // total recorded crashes
    lastAt: number | null; // timestamp of the last one
    restartBudgetLeft: number; // auto-restarts left (0 → the next crash disables the plugin)
  };
}
```

The `crash` field appears after the first recorded crash (rev4 §M3).

Guarantees:

- The snapshot is built host-side only from public registry fields:
  no secrets (API keys, tokens, filesystem paths), no other plugins, and no
  manifest contents.
- Grants and features are a point-in-time snapshot at call time; a revoked
  grant disappears from the next snapshot.
- The method does not serialize `manifest` or internal frame structures; if
  needed, the client requests the data again itself.

### auth

OAuth connections to external services (rev4 §K5). The host owns the entire OAuth cycle:
`api.auth` is metadata only, the access token NEVER leaves the server.

```ts
interface KernelAuthConnection {
  connectionId: string;
  serviceId: string; // reverse-DNS id from the authClients manifest
  serviceName: string;
  scopes: string[];
  status: 'pending' | 'connected' | 'expired' | 'revoked';
  createdAt: number;
  updatedAt: number;
}
```

- `list()` — all of the plugin's connections (metadata, never tokens);
- `get(connectionId)` — a single connection; `null` if absent or if the
  connection does not belong to the plugin;
- `connect(serviceId, {scopes?})` — start (or reuse) a connection.
  An already-connected service resolves immediately to `{status:'connected'}`. A new
  connection is created in `pending` and returns `authorizationUrl` — the IdP
  page that the host MUST open for the user in the browser. After the user's
  consent the IdP callbacks to the host, the server exchanges the code and moves the
  connection to `connected`, after which the host sends the plugin the
  `plugin.auth.connected` event (`api.events.subscribe`);
- `revoke(connectionId)` — revokes the connection: the server forgets the token and sends
  `plugin.auth.revoked`.

Statuses: `pending` (awaiting callback), `connected`, `expired` (token expired;
v1 does not refresh tokens automatically), `revoked`.

Security model:

- Only public OAuth clients with PKCE (S256): the manifest declares
  `clientId` without `clientSecret` — plugin code lives in the sandbox and cannot
  store a secret. Service descriptors are declared statically in the `authClients`
  manifest and change only by reinstalling the plugin.
- `authorizationUrl`, `tokenUrl`, and authorized fetch targets — HTTPS only;
  the single exception is plain-HTTP loopback (`127.0.0.1`, `localhost`,
  `[::1]`) for a local IdP/gateway during development.
- `state` is one-time: it is burned on a successful callback, a repeated callback
  fails with `STATE_EXPIRED`. If the plugin is disabled at that moment, the state
  is kept, and the user can finish the cycle after re-enabling.
- Authorized requests go through `api.network.fetch(url,
{connectionId})`: the server resolves the token and injects `Authorization`
  server-side. There is no way for the sandbox to obtain the token value.
- Requires the `auth.connections` capability (enabled in the manifest's
  `requiredCapabilities`); an expired event arrives when attempting to
  use an expired connection (`AUTH_EXPIRED`).

### services

Cross-plugin RPC (rev4 §D): one plugin provides a service, another
connects to it and calls methods. The host performs all mediation:
the provider registers only metadata, and calls are routed into the
provider's own session, so handlers never cross boundaries
as function objects. Web-only: v1 works between web-sandbox plugins;
backend plugins are an explicit non-goal of this slice.

Capabilities: `services.provide` (provider), `services.connect`
(consumer; `list()` is part of it). A single plugin may hold both.

```ts
interface KernelServiceDescriptor {
  serviceId: string; // '<pluginId>.<name>' — host-prefixed, squatting impossible
  providerPluginId: string;
  name: string;
  methods: string[];
  version?: string;
  description?: string;
  timeoutMs?: number; // default 10000, host cap 60000, clamps [1000, 60000]
}

interface KernelServiceConnection {
  connectionId: string; // host-owned, '<token>' — the consumer does not choose it
  serviceId: string;
  consumerPluginId: string;
}

interface KernelServiceCall {
  connectionId: string;
  method: string;
  params?: unknown; // JSON-safe, <= 256 KiB in both directions
}
```

- `provide({name, methods, version?, description?, timeoutMs?, handle})` —
  publishes the service and returns `{serviceId, dispose()}`; `handle` executes
  `{callerPluginId, method, params, signal}` inside the provider's sandbox.
  `dispose()` removes the registration and deletes all consumer connections.
  Name: `^[a-zA-Z][a-zA-Z0-9_.]{0,63}$`; 16 services per plugin, 64 methods per
  service; republishing the same `serviceId` — `VALIDATION_FAILED`.
- `list()` — all registered services (metadata, without handlers).
- `connect(serviceId)` — creates a host-owned connection; returns
  `{connectionId, serviceId, methods}`. Dead provider — `SERVICE_UNAVAILABLE`;
  limits: 64 connections per consumer, 256 host-wide.
- `invoke(connectionId, method, params?, {signal?})` — routes the call into the
  provider's session with the service deadline; the result must be JSON-safe and
  <= 256 KiB. A failure does not cross as a function object: `result` is data only.
- `disconnect(connectionId)` — releases the connection; a repeated
  `invoke`/`disconnect` on it — `SERVICE_NOT_FOUND`.

Error mapping (the consumer sees a stable code, provider details are in
`details.providerCode`):

| Case                                 | Code to consumer                                 |
| ------------------------------------ | ------------------------------------------------ |
| No connection / service removed      | `SERVICE_NOT_FOUND`                              |
| Service/method not found             | `SERVICE_NOT_FOUND` / `SERVICE_METHOD_NOT_FOUND` |
| Provider dead (mid-call)             | `SERVICE_UNAVAILABLE`                            |
| Service deadline                     | `SERVICE_TIMEOUT` (`OPERATION_DEADLINE`)         |
| Consumer cancellation                | `OPERATION_ABORTED`                              |
| Throw in provider handle             | `SERVICE_ERROR` (details.providerCode)           |
| Quotas (methods/connections/payload) | `PLUGIN_QUOTA_EXCEEDED`                          |

### notifications

`api.notifications.show({title, description?, variant?, timeoutMs?})`
returns a cleanup-dismiss; `api.notify` — an alias of `show` for one-off
notifications. Requires the `notifications.show` capability; the host feature —
`ui.notifications:1`.

### storage.kv

One JSON object per `(plugin, scope, ownerId)`; keys are entries; the revision is a CAS
on the whole object. `set({scope, key, value, expectedRevision?})` throws
`REVISION_CONFLICT` on mismatch. The `chat` scope resolves to the current chat;
outside a chat — `NOT_FOUND`.

### overlays and hitPolicy

`api.overlays.register(mode, {initialRect?, hitShapes?})`, `mode`:

- `native` — the rectangle enters the iframe's clip-union: browser hit-testing
  and visuals live inside the region (visuals outside the region are clipped — that is a property
  of clip-path, not a bug); `hitShapes` narrow the region to SVG primitives
  (rect/circle/ellipse/polygon in overlay-local pixels) — both the clip and
  hit-testing follow the same geometry;
- `proxy` — the visuals are not clipped (the rect enters the clip-union in full); the host
  places a hit-div on top and delivers normalized packets to `onPointer(cb)`
  (`isTrusted` of synthetic events is not promised); `hitShapes` gate the packets: a pointer
  inside the rect but outside the shapes does not reach the plugin;
- `full` — the iframe is not clipped at all, one per plugin; `hitShapes`
  are rejected (`VALIDATION_FAILED`, reason `hitShapes-mode`);
- `none` — a visible but fully non-interactive layer (rect in the clip-union,
  the host places an absorbing hit-div with no forwarding); `hitShapes` are rejected.

Packets contain `type` (`down`/`move`/`up`/`cancel`), normalized `x`/`y`
(0..1 of the rect), `button`, `pressure`, `pointerId`, `sequence` (a monotonic
host counter per overlay) and `timestamp`. Geometry limits —
`limits.overlays`: `maxShapes` (32), `maxPolygonPoints` (256),
`maxGeometryBytes` (16 KiB); a violation — `VALIDATION_FAILED` with reason
`hitShapes`. `overlay.update(rect?, hitShapes?)` accepts both arguments
independently; a shape update without a rect does not touch the geometry. Shape updates
are limited by `limits.overlays.maxUpdatesPerSecond` (sliding 1 s window,
`PLUGIN_QUOTA_EXCEEDED` with `retryable: true` and `retryAfterMs`).

The host sends `ui.overlay.layout` (revision + rectangles) on every
geometry change; `ui.emergencyClose` closes all of the plugin's overlays. Host
security/permission UI always sits above plugin overlays.

### Overlay chrome (rev4 §G7)

While a `full` overlay is alive, the host renders its own chrome —
`[data-component="plugin-overlay-chrome"]` with the plugin name and a host close
button (`data-part="overlay-chrome-close"`) — above all plugin layers
(`--st-layer-plugin-chrome`, 300: panel 100 < overlay 200 < chrome 300 <
modal 1000 < dropdown 1100 < notification 1500). The chrome lives in the host DOM and
cannot be covered or spoofed by the plugin; its state is read via
`subscribeOverlayChrome`/`getOverlayChrome` (runtime singleton):

- closing via the button or `Escape` removes the overlay and the chrome synchronously;
- while the chrome is active, the application background (`main-area`, navigation,
  `status.area`) becomes `inert`, and focus returns to the previous element;
- `Escape` with focus inside the sandbox iframe does not reach the host window: the sandbox
  relays the key via the `ui.overlay.escape` RPC (no capability gate — only one's own
  overlay can be closed), and the host calls `closeFullOverlay()`;
- teardown: removing the registration, disposing the overlay, or removing the frame
  clears the chrome; chrome ownership is bound to a specific frame instance
  (`frameId`), so a stale layout-flush from a replaced frame cannot
  close the chrome of the plugin's new frame;
- `ui.surface.unmount` additionally releases the sandbox-side overlay
  container (key = registrationId) — host-driven closing leaves no
  plugin DOM nodes behind.

### chats

`current()` returns `{chatId, title}` of the current chat or `null`.
`listMessages({chatId?, cursor?, limit?})` without `chatId` reads the current chat, and
the `chats.read.current` grant suffices; an explicit `chatId` of another chat requires
`chats.read.all`. Returns `{items, nextCursor?}`: pages are ordered by
descending time (newest first), `items[0]` is the latest message.
`append({content, chatId?, idempotencyKey?})` creates a message of role
`plugin` (grant `chats.write.plugin`). `idempotencyKey` is an outbox contract:
a repeated append with the same key returns the original message instead of a
duplicate (useful on retry after a lost response).

### chats.draft

`draft.start()` → `draft.append(text)` (the host coalesces flushes at ≤10 Hz) →
`draft.commit()` (returns `messageId`) or `draft.abort()`.

A draft is a server-side object (rev4 stage 3): appends write to the
`message_drafts` table on the server, not into a committed message. Only `commit`
atomically materializes the final message of role `assistant`; a writer
crash leaves a draft that a sweep sweeps away — never a half-written message. `commit` is idempotent: a retry after success
returns the same `messageId` (`alreadyCommitted`). Write ordering is
guaranteed by the sequence: a repeated PATCH with an old sequence is a no-op.
10 Hz is a host policy, not part of the wire contract.

### Message CAS

Every message carries a `revision` (bumped on each update). `PATCH
/chats/:id/messages/:messageId` accepts an optional `expectedRevision`:
on mismatch the server responds with `MESSAGE_CONFLICT` (409) and the current
`revision` — the writer re-reads and retries instead of silently overwriting
someone else's edit. The `chat.message.updated` app event carries the current `revision`.

### blocks

`registerRenderer(blockType, {title, mount, serialize?, restore?})` —
declares a renderer; `mount` receives a container and a descriptor and returns a
cleanup. `attach(messageId, blockType, descriptor)` binds an instance to a
message and returns `{blockId}`.

Attachments are persistent (rev4 stage 4): they live in the server-side
`message_block_attachments` table (together with the renderer's serialized state)
and survive a page reload — the block renders in any client with the
same state. `attach` creates the attachment on the server (REST) and only then
updates the host cache; `freeze` (unmount due to overscan or a chat switch)
saves the state via `PATCH /api/v2/blocks/:id`; on reload the host
loads the attachments (`ensureBlocksLoaded`) and restores the state via
`restore`. The renderer remains host state: it lives as long as the plugin's
session lives; an attachment without a live renderer (plugin disabled) shows an
empty slot. Uninstalling the plugin cascades-deletes its attachments (FK).

Mounting: the sandbox creates its own container in the iframe (`data-neotavern-registration =
blockId`), the host leaves a geometric anchor in the message DOM
(`data-part="plugin-block"`), and the block content lives in the iframe container.
Blocks use overscan: while the message is outside the viewport, host containers are
unmounted (state is serialized via `serialize`); when it returns to the
viewport, blocks are remounted and state is restored (`restore`).
The overscan anchor is the message element (`article`), so unmounted
blocks do not collapse the slot. Without `IntersectionObserver` (or in environments without
viewport geometry) blocks are always mounted. A renderer whose capability
`ui.messageBlock` has been revoked degrades: the slot stays empty. On reload an
attachment may load before the plugin re-registers its renderer:
the empty slot waits for the registration event and mounts in place.

### backend

`api.backend.request(path, {method, headers?, body?})` returns
`{status, headers, body}` with a streaming `body`; the response body is a host→plugin
stream with credit backpressure (no base64 in the main transport).
`invoke(path, input)` — the JSON convenience.

JSON responses from workers pass through as-is: a plain object (without
`status`/`headers`/`body` fields) is not wrapped in the `PluginResponse` envelope and
reaches the plugin untouched; the envelope is normalized only for responses that
actually contain it (streaming routes `route.body.*`).

### models and the model menu

`api.models.list(providerId?)` — the provider's model list.

- `providerId` — an optional provider-config id; when omitted, the host
  resolves the **active provider** (the application reports it via
  `FrontendPluginRuntime.setActiveProviderConfigId`). This diverges from the
  backend-broker contract (`SdkModelsListArgsSchema`, where `providerId`
  is required) — deliberately: the plugin does not need to know the current provider.
- The response is `ModelInfo[]`: `{id, name, contextLimit?}`; the list is capped at
  `MODELS_MAX_LIST` (256).
- Errors: `VALIDATION_FAILED` (not a string / >128), `CAPABILITY_DENIED`
  (the `models.list` grant), `NOT_FOUND` (no active provider or
  `PROVIDER_NOT_FOUND` from the server).

`api.ui.modelMenu(container, options)` — a ready-made model picker widget
(vanilla, mounts into any element of the sandbox document). Contract:

```js
const handle = api.ui.modelMenu(container, {
  providerId, // optional; defaults to the active provider
  value, // initial model id (free text allowed)
  ariaLabel, // field aria-label (defaults to 'Model')
  labels: {
    // string overrides (English by default)
    load,
    loading,
    loaded,
    empty,
    noResults,
    loadHint,
    error,
    // 'loaded' contains '{n}' — the model count is substituted
  },
  onValueChange(value) {}, // selection from the list, Enter, or blur commit
});
handle.setValue('gpt-4o'); // without calling onValueChange
handle.dispose(); // idempotent; removes DOM and listeners
```

The behavior mirrors the host `ModelMenu` component (`@neotavern/ui`): the list
opens on focus/click and loads models once via
`api.models.list`, typing filters by label/id, Arrow/Home/End/Enter/Escape
work as in a combobox, Enter without a match commits free text,
blur commits the input, clicking outside closes, and the "Load models" button
reloads. The status line shows `{n} models loaded.`, an empty state, or `error (CODE)`.

Styles: the widget mirrors the host `ModelMenu` component through **host theme tokens**.
An opaque iframe cannot read the host stylesheet (CSP `style-src 'self'`),
so the host sends a snapshot of allowed tokens in the kernel handshake
(`HostHandshake.themeTokens`, the `PLUGIN_UI_TOKENS` list in
`apps/web/src/plugins/themeTokens.ts`) and re-sends them via the
`neotavern.plugin.tokens` message on every theme change — the widget repaints live.
Values are allowed strings (`rgb(…)`, px); var() chains are expanded by the
host. The widget carries the same markers as the host component:
`data-component="model-menu"`, `data-part="control-row"/"status"`,
`data-tone="error"`. The built-in CSSOM palette (dark/light per
`prefers-color-scheme`) remains only as a fallback for hosts without the
`themeTokens` field.

Minimal example — `plugins/rev4-modelmenu/`.

### message actions (MessageActionDef v2)

Registration: `api.surfaces.register('messageActions', def, runner,
{kernel: true})` — the host renders the action on the message panel and invokes the
runner over the kernel port (`surfaces.run`). Fields of `def`:

- `id`, `title` (a string or a function — an already-localized label, shown by the host
  as-is);
- `icon` — a semantic name from the host allowlist (`translate`, `speak`/`tts`,
  `summarize`, `rewrite`, `analyze`, `copy`, `save`, `delete`, `like`,
  `dislike`, `pin`, …); an unknown name gets the puzzle-piece fallback icon;
- `order` (number, default 100) — lower renders earlier;
- `placement` — `'primary'` or `'overflow'` (default `'primary'`); the contract
  has not changed. The host renders both sets in a single inline action panel
  (desktop `data-part="message-actions-inline"`, mobile — inside the message
  card); there is no "More" menu in the host.

Runner context (BREAKING vs v1):

```js
async function runner(context) {
  // context.message — an immutable snapshot:
  // { messageId, chatId, branchId, role, content, name, meta, revision }
  // content === null without the chat.read permission (per-plugin gate)
  const text = context.message && context.message.content;
  // context.messageId / context.chatId — remain at the top level
  // (backward compatibility: old callbacks ({messageId, chatId}) keep working)
  // context.signal — aborted by the host on teardown (unmount, navigation,
  // disable), on a repeated invocation of the same action, and on timeout
}
```

- Content is gated per-plugin: `message.content` is not null only if the plugin
  holds **both** the `ui.messageActions` and `chat.read` permissions; metadata
  (`role`, `revision`, `meta`) is available without `chat.read`. Adding
  `chat.read` to an installed manifest moves the package to `needs-consent`.
- `signal`: the host creates an `AbortController` per invocation (key —
  `context.invocationId`), `surfaces.abort` aborts it; re-invoking
  the same action cancels the previous run. A runner error is isolated
  by the host and does not break the chat.
- Legacy `contextMenuItems` with `context: 'message'` (the v2 path) keep
  working and render in the same inline panel with a `{ targetId }` context.
- Minimal example: `plugins/rev4-translate/` — "Translate"
  (`icon: 'translate'`, `order: 90`, `placement: 'primary'`), reads
  `context.message.content` and shows a mock translation via `api.notify`
  (no external services). General contract and migration —
  `docs/plugin-sdk/README.md` § "Message actions (v2)".

### workers

Runs **inside the plugin's own sandbox** (rev4 §C2, ADR-0018): a Worker
inherits the opaque origin and the CSP sandbox (`worker-src blob: data:`,
`script-src … blob: data:` — classic Workers from blob:, module Workers from
data:, `connect-src 'none'`) — computation without DOM, without direct network access, without
app storage/cookies. Permission to compute does not grant permission to data:
a Worker receives data only via the plugin's `postMessage`.

`entry` MUST be declared in the manifest (`workers: ["workers/double.js"]` —
safe relative `.js`/`.mjs` paths, install-time validation); the host checks size (≤ `workers.maxBundleBytes` = 2 MiB; `.mjs` additionally
≤ `workers.maxModuleDataUrlBytes` = 1.5 MiB) and MIME `text/javascript`,
transfers the bytes over a kernel stream, and the sandbox constructs the Worker by entry
extension: `.js` → classic `new Worker(blobUrl)`, `.mjs` →
`new Worker(dataUrl, { type: 'module' })` (ADR-0018: a blob: module Worker
does not resolve the entry in an opaque origin, so module bundles travel as data: URLs;
spike 6 pins the capability, spike 8 — the data: transport under production CSP).
The bundle stays self-contained: classic — without `import`/`export` and
`importScripts`, module — without `import` (blob/data URLs do not resolve relative
imports); a same-origin module Worker is rejected because it would inherit the application
origin. Handle:
`postMessage(message, transfer?)`, `onMessage(listener)` /
`onError(listener)` → unregister, `closed` (Promise), `terminate()`.

Errors: `CAPABILITY_DENIED` (no `compute.worker`), `VALIDATION_FAILED`
(undeclared entry — `reason: 'not-in-manifest-workers'`, bad MIME —
`reason: 'bad-mime'`), `NOT_FOUND` (no such file), `PLUGIN_QUOTA_EXCEEDED`
(> 2 MiB or > `limits.workers.maxInstances` live, default 2),
`WORKER_SPAWN_FAILED` (the Worker constructor threw), `OPERATION_ABORTED`
(signal). Live workers are terminated by the host on session teardown
(disable/uninstall/sandbox navigation) and on revocation of `compute.worker`.
`name` and `memoryBudgetMiB` are advisory v1 metadata (the browser does not enforce a
worker memory budget); `importScripts` is not supported;
SharedWorker/ServiceWorker are forbidden. For tasks that need data or the
network, use `compute.backend`.

### jobs (rev4 stage 5: cron, retries, DLQ)

`api.jobs.schedule({name, runAt | intervalMs | cron, payload?, retries?,
retryDelayMs?})` — exactly one scheduling mode:

- `runAt` — one-shot at epoch-ms;
- `intervalMs` — a fixed interval (≥ 1 s); the next run is exactly
  one interval after the previous one, no bursting;
- `cron` — a 5-field expression `minute hour day-of-month month day-of-week`
  (UTC): `*`, a number, `a-b`, `*/n` and `a-b/n` steps, `a,b` lists;
  day-of-week 0–7 (7 = Sunday). nextRunAt = the next match.

`retries` — the retry budget after the first failure (0..20, default 0):
with `retries > 0` the dispatch is **held until ack** — the job is neither deleted nor
advanced until the plugin answers `api.jobs.ack(jobId, {ok})`; the retry
uses exponential backoff (`retryDelayMs` base, default 5000,
doubling on each retry, cap 1 h). A missing ack (no answer within 5 minutes)
counts as a failed attempt. `ok: false` exhausts the budget →
the job goes to the DLQ: `status: 'failed'`, `lastError`, `failedAt`; jobs in the DLQ
are no longer dispatched until the plugin calls
`api.jobs.retry(jobId)` (resets attempts, nextRunAt = now). On a successful
ack: a one-shot is deleted, interval/cron advances to the next run,
attempts reset. Without `retries` the fire-and-forget behavior is
preserved: dispatch does not wait for an ack.

`api.jobs.list()` returns `{items}` with `status: 'active' | 'failed'`,
`attempts`, `maxRetries`, `lastError`, `failedAt`, `cron`, `runAt`,
`intervalMs`, `payload`. `ack` is idempotent: an ack for a deleted /
not-dispatched / DLQ job is a no-op (`acknowledged: false`) and throws no
errors. `api.jobs.cancel(jobId)` removes the job from any state.

Dispatches are delivered to `api.jobs.onRun(cb)` (a new subscription replaces the
previous one) — the cb MUST call `ack` itself; the event contains `jobId`, `name`,
`payload`. A plugin error inside cb does not break the runner (the bus subscription is isolated).

REST (all under `jobs.background`): `POST /api/v2/plugins/:id/jobs`,
`GET /api/v2/plugins/:id/jobs`, `POST .../jobs/:jobId/cancel`,
`POST .../jobs/:jobId/ack` `{ok, error?}` → `{acknowledged}`,
`POST .../jobs/:jobId/retry`, `DELETE .../jobs/:jobId`.
Validation: `JOB_SCHEDULE_INVALID` (no mode), `JOB_SCHEDULE_EXCLUSIVE`
(two modes), `JOB_CRON_INVALID` (bad expression), `JOB_RETRIES_INVALID`
(0..20), `JOB_RETRY_DELAY_INVALID` (1 s..1 h).

### network and secrets

`api.network.fetch(url, opts)` executes on the host: allowlist from grants,
redirects are rejected, the body is bounded. `authSecretRef` resolves only on the
server and is injected into the header; there is no `secrets.resolve` method visible to the
plugin.

### events

`api.events.subscribe(event, listener)` subscribes to app events over the
kernel port (not the legacy v2 postMessage path) and returns a cleanup-unsubscribe;
`api.events.unsubscribe(event, listener)` — the explicit cancel. Duplicate
subscriptions are idempotent; there is one host relay per event per plugin.

Only a whitelist of events that the application already streams to the browser
is available (allowlist = `BROWSER_APP_EVENTS` + `plugin.capability.revoked`,
`plugin.job.due`, `plugin.chat.updated`, `plugin.chat.message`); a name outside the
list → `VALIDATION_FAILED`. Events carrying chat content
(`generation.started/delta/finished/error`, `chat.message.created/updated/
deleted`) additionally require the `chats.read.current` capability — subscribing
without the grant is `CAPABILITY_DENIED`, and when the grant is revoked, delivery
stops on the host at emit time (fail-closed). Non-content events
(`chat.opened`, `character.selected`, …) are delivered without a capability.

Delivery is the `evt.emit` envelope `{event, payload, eventId, cursor?}`:
`eventId` — a stable id from the host (ordering/debug), `cursor` — the delivery
key. Like all rev4 registrations, the subscription lives in session scope:
iframe reset/plugin disable remove the host relays automatically.
The v2 `api.events.on` remains a legacy path and does not mix with
rev4 subscriptions.

`api.events.on(event, listener)` — a **local** listener for
host-generated envelopes (`window.background.changed` and the like): it makes no
RPC and does not pass through the allowlist, and returns a cleanup function. For events of the
SSE stream use `subscribe`.

### Event cursor/replay (rev4 §J1)

`api.events.subscribe(event, {cursor, signal, maxInFlight})` **without a callback**
returns an async iterator of events (alias — `api.events.stream`):

```js
const iterator = api.events.subscribe('chat.message.updated', {
  cursor: savedCursor,
  signal,
});
for await (const event of iterator) {
  await handle(event.payload);
  savedCursor = event.cursor; // at-least-once: resume from here
}
await iterator.return();
```

Each item is `{payload, event, eventId, cursor, sequence}`. Semantics:

- **at-least-once**: the iterator acks an event when the consumer requests the next —
  processed — one; if the sandbox dies between delivery and ack, re-subscribing with
  the `cursor` of the last processed event replays the missed ones. `event.cursor`/`sequence` — the
  deduplication key (a redelivery of the same event carries the same cursor).
- **Replay window**: the host keeps a bounded ring buffer of app events
  (128 per name, 4096 total, TTL 60 s) and replays events after the cursor
  on subscription. A fresh subscription without a cursor starts at the current position
  (no replay of the past). A cursor outside the window →
  `EVENT_CURSOR_EXPIRED` (explicit degradation, invariant 8); a cursor from the
  future → `VALIDATION_FAILED`.
- **Backpressure**: the host stops delivery at `maxInFlight`
  (default 64, 1..256) unacknowledged events and resumes on ack —
  a slow consumer does not grow in memory (the buffer is the bound).
- **Ordering**: strictly by sequence within a single event.
- `signal` aborts the iterator (`return()` + unsubscribe); session teardown
  closes the iterator automatically.

### Lifecycle hooks (rev4 §J2)

The host calls hooks on the plugin definition at explicit moments of the plugin's life:

```ts
activate(api); // after loading and grant issuance
suspend(); // tab hidden (visibilitychange → hidden)
resume(); // tab visible again
deactivate(); // before the frame is unmounted
beforeUpdate(); // the plugin is updating (SSE plugin.updating)
afterUpdate(); // update finished (SSE plugin.updated)
rollback(); // update rolled back (SSE plugin.rollback)
uninstall(); // the plugin is being removed (SSE plugin.uninstalling)
```

- `activate(api)` — the only required hook: it is called with the full
  `api` after the handshake; the plugin may set `suspend`/`resume`/`beforeUpdate`/`afterUpdate`/
  `rollback`/`uninstall` inside it or at the top level of the definition.
- Hooks are **best-effort by contract**: the host does not wait for their result for its own
  state machine; each call is the `lifecycle.hook` RPC `{hook, detail}`
  with a 1500 ms deadline and a `{handled: boolean}` response. A failed/missing
  hook degrades to `handled: false` (invariant 8: explicit degradation, not
  a silent pipeline failure). `detail` for update hooks is
  `{version, previousVersion}`, for `rollback` — `{previousVersion,
failedVersion}`.
- The feature is checked with `api.runtime.supports('lifecycle.hooks',
1)`; without it, hooks are not called.
- **Ordering with teardown**: when a frame is replaced on update, the host
  first delivers `beforeUpdate` → `afterUpdate`, and only after the last hook
  settles closes the old sandbox's session port —
  the hook's async writes (KV, blobs, backend calls) are not cut off
  mid-operation. Suspend/resume are broadcast to all live frames on
  `visibilitychange`.

### Crash isolation (rev4 §M3)

The host detects a dead/hung sandbox by two signals:

1. **Closure of the session port** (fast path): the sandbox process died or the
   document left via self-navigation — the port closes without graceful removal
   in the process. The host counts this as a crash and restarts the frame.
2. **The `kernel.ping` heartbeat** (slow path): every live frame
   is pinged on an interval (10 s), response deadline 3 s; an unanswered
   ping = hang (useful in site-isolated Chromium, where the sandbox lives in
   its own process and cannot freeze the main page).
   In the shared process model (not site-isolated), the host's main thread itself is
   frozen during a plugin main-thread spin — such a crash is detected
   only by port closure.

Restart policy (host-controlled):

- A crash within a 10-minute window spends the budget: `maxRestarts = 3`.
  Crashes 1–3 restart the frame with the same plugin record (the sandbox
  reloads and re-activates, registrations are restored);
  the (maxRestarts + 1)-th crash in the window — crash-loop → the plugin is
  disabled server-side (`POST /api/v2/plugins/:id/disable`), no frame is created.
- Every event outcome (`neotavern-plugin-crash` with
  `{pluginId, pluginName, error, restartBudgetLeft, disabled}`) is rendered
  as a host-owned notification ("restarted, N left" / "disabled after
  repeated crashes"): the notification belongs to the host, so teardown
  of the crashed frame does not sweep away the warning.
- Crash teardown fully closes the session: streams, workers, jobs,
  subscriptions, overlays, pending invokes (invariant 6: cleanup).
- The crash counter and the remaining budget are visible to the plugin in
  `api.diagnostics.get().crash` (own data only).

### Multi-window background singleton (rev4 §J3)

The plugin is activated in **every** application window (one UI instance per window),
but background consumers (event listeners, polling, job triggers) MUST
run in exactly one window per installation. The host elects the primary window and
gives the plugin only a role:

- `api.windows.role()` → `{role, windowId, installationId, isBackground}`:
  `role` is `primary` (this window owns the background singleton),
  `secondary` (another window of the same installation owns it), or `standalone`
  (BroadcastChannel unavailable — the window is its own primary);
- `api.windows.isBackground()` → `{isBackground}`;
- a role transition arrives as a host-generated `evt.emit`
  `window.background.changed` with the same snapshot — listen via
  `api.events.on` (no capability needed: this is the state of the plugin's own
  window). When you become primary, start the background consumers; when you lose the role,
  stop them.

The election lives on the host (`WindowRoleManager`): every tab with a live
frame of the installation sends a claim + heartbeat over the `BroadcastChannel`
(`neotavern:rev4:windows:<installationId>`); the leader is the live claim with the smallest
windowId (deterministically, without races). A claim expires by lease (4 s) —
a dead primary (killed renderer) is taken over by the others; closing the
tab (`pagehide`) releases the claim immediately. The manager lives as long as at least
one subscription of the installation's session exists in this window (cleanup by
session scope). The `window.background.changed` event does not pass
the `events.subscribe` allowlist — it is host-generated and listened to locally.

## 3. Streams and backpressure

Wire envelopes: `stream.open` (the consumer issues the initial credit =
`limits.streams.maxInFlightBytes`), `stream.chunk` (a transferable `ArrayBuffer`,
strictly within the credit, `seq` in order), `stream.credit` (replenishment after
reading), `stream.end` / `stream.error` / `stream.cancel`. Limits are read
programmatically: `api.runtime.limits()`.

## 4. Errors

Stable codes (`KernelError.code`): `PROTOCOL_UNSUPPORTED`,
`PROTOCOL_INVALID`, `HANDSHAKE_REJECTED`, `CAPABILITY_DENIED`,
`CAPABILITY_REVOKED`, `PLUGIN_QUOTA_EXCEEDED`, `OPERATION_ABORTED`,
`OPERATION_DEADLINE`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`,
`VALIDATION_FAILED`, `NOT_FOUND`, `STREAM_FAILED`, `BACKEND_UNAVAILABLE`,
`WORKER_SPAWN_FAILED`, `INTERNAL`. Each envelope carries `retryable`, optionally `retryAfterMs` and
`details`; the human-readable string is localized by the frontend and is not sent from the
host.

## 5. Lifecycle and revocation

- Every registration (`commands`, `surfaces`, `overlays`, `blocks`,
  subscriptions, draft, jobs) returns a cleanup; on disable/uninstall the host
  closes all handles automatically, including live `api.workers` workers.
- Grant revocation: `capability.revoked` on the port → subscriptions close, streams
  abort, jobs stop; `api.events.onKernelRevoked` for the plugin's reaction.
- Navigating the sandbox away from the document resets the session (registrations
  are removed, invites are rejected).

## 6. Legacy

`legacy.trusted` is a separate extension type (admin policy, signature/allowlist),
not a public capability, and is not issued via the ordinary consent dialog. Ordinary
rev4 plugins neither require nor receive privileges in the application origin.

Examples: [rev4-overlay-game](examples/rev4-overlay-game.md), sources —
`plugins/rev4-storage/`, `plugins/rev4-overlay/`, plus the e2e-verified
sample plugins `plugins/rev4-tools/` (commands + notifications + limits),
`plugins/rev4-blocks/` (message blocks + commands), `plugins/rev4-agent/`
(frontend + backend worker, routes and `api.backend.invoke`),
`plugins/rev4-grant/` (runtime capability request via the consent dialog) and
`plugins/rev4-lifecycle/` (suspend/resume by tab visibility and
update hooks via the KV log). Their full user cycle (install →
consent → activation → toolbar) is covered by `e2e/rev4-samples.spec.ts`.
