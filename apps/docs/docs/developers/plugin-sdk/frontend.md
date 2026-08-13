---
title: Frontend Plugin API
description: How a frontend plugin registers pages, panels, actions, commands, and events.
sidebar_position: 4
---

The frontend API is what a browser-side plugin receives in its `activate()`
call: a set of registrars for every UI surface, the event bus, and i18n.

## Entry Point

A frontend plugin exports a definition with an `activate(api)` function.
The host calls it with the `FrontendPluginApi` object once the plugin is
consented and active:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    // Register surfaces here.
  },
  deactivate() {
    // Optional explicit teardown.
  },
});
```

Every registrar returns a cleanup function. The runtime collects these
automatically, so your plugin does not need to track them by hand — though
`deactivate()` can still tear down anything you manage yourself.

## Registration Surfaces

The `api.ui` namespace groups the UI registrars:

- **Pages** — `api.ui.pages.register({ id, path, title, mount })` adds a
  route under the plugin namespace. `mount` receives a host-provided container
  and may return a teardown.
- **Settings panels** — `api.ui.settingsPanels.register(...)` adds a panel to
  the Settings screen.
- **Toolbar actions** — `api.ui.toolbarActions.register({ id, title, icon,
run })`. The host renders the action as a standard button; you only provide
  semantics, never layout or breakpoints.
- **Message actions** — `api.ui.messageActions.register({ id, title, icon,
order, placement, run })`. The `run` callback receives an immutable message
  snapshot plus an `AbortSignal` that fires on teardown, re-invocation, or
  timeout.
- **Context menu items** — `api.ui.contextMenuItems.register({ id, title,
context, run })` for `context: 'message' | 'character'`.
- **Message renderers** — `api.ui.messageRenderers.register({ id, title,
render })`. `render` returns plain text with a `placement` of `'replace'`
  or `'after'` — never HTML.
- **Character tabs** — `api.ui.characterTabs.register({ id, title, mount })`.
  `mount` receives `{ characterId }` as context.
- **Sidebar panels** — `api.ui.sidebarPanels.register({ id, title, slot,
mount })` with `slot: 'left' | 'right'`.
- **Dialogs** — `api.ui.dialogs.register({ id, title, description, mount })`.
- **Command palette actions** — `api.ui.commands.register({ id, title, run })`.
- **Hotkeys** — `api.ui.hotkeys.register({ id, combo, run })`, for example
  `combo: 'mod+shift+k'`.
- **Declarative slots** — `api.ui.slots.contribute({ slot, title, priority,
permission, action, when })` contributes buttons to the five stable
  semantic slot ids without shipping any markup or script. See
  [Declarative UI Slots](slots.md).

Slash commands register separately through `api.slash.register({ name,
description, run })`, and prompt interceptors through `api.interceptors`.

## Prompt Interceptors

An interceptor runs on the assembled prompt before it is sent:

```ts
api.interceptors.register({
  id: 'example.format',
  priority: 100,
  timeoutMs: 5000,
  intercept(context) {
    // context.messages is an array of { id, role, content, name }.
    return context;
  },
});
```

Lower `priority` runs earlier; a plugin that exceeds `timeoutMs` is skipped
without breaking the chain. Interceptors that only inspect the prompt need
`prompt.inspect`; those that change it need `prompt.modify`.

## Events

The event bus is typed and shared with the host. `api.events.on(event,
handler)` returns an unsubscribe function:

```ts
const off = api.events.on('chat.message.created', ({ chatId, messageId }) => {
  console.log('new message', chatId, messageId);
});
```

Built-in events include `chat.created`, `chat.opened`,
`chat.message.created`, `chat.message.updated`, `chat.message.deleted`,
`character.selected`, `generation.started`, `generation.delta`,
`generation.finished`, `generation.error`, `theme.changed`, and
`language.changed`. Plugins may also emit and listen to custom events, with
names namespaced by convention, for example `myplugin.foo`.

## Message Snapshots and Content Gating

Message actions receive an immutable `MessageActionSnapshot` with
`messageId`, `chatId`, `branchId`, `role`, `content`, `name`, `meta`, and
`revision`. The `content` field is `null` unless the plugin also holds
`chat.read`, so an action can render metadata without ever seeing message
text.

## Notifications and i18n

`api.notify({ title, description, variant, timeoutMs })` shows a notification
and returns a dismiss function. `variant` is `info`, `success`, `warning`, or
`error`.

`api.i18n` manages translation resources in an isolated plugin namespace:

```ts
api.i18n.addResources('ru', { greet: 'Привет' });
const label = api.i18n.t('greet');
```

`addResources` returns a cleanup function like every other registration.

## Cleanup Guarantees

Because every registration returns a cleanup function and the runtime tracks
them, disabling a plugin removes all of its handlers, timers, DOM nodes,
subscriptions, and background requests. See [Lifecycle](lifecycle.md) for the
full teardown contract, and the generated
[Plugin SDK reference](../../api/plugin-sdk/) for the precise types.

## Related

- [Declarative UI Slots](slots.md) — the declarative `api.ui.slots` surface.
- [Extension Availability](availability.md) — where plugin surfaces exist at all.
- [Legacy Frontend Gate](legacy-frontend.md) — the app-level opt-in for
  legacy main-window scripts.
