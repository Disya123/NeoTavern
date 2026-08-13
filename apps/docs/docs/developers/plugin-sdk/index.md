---
title: Plugin SDK Overview
description: What the Plugin SDK is and how the frontend and backend API split works.
sidebar_position: 1
---

The Plugin SDK is the versioned public API that plugins use to extend NeoTavern,
covering both the browser-side UI and the server-side backend.

## What the Plugin SDK Is

Plugins are ZIP packages (`.stplugin`) that ship a manifest, optional frontend
and backend entry points, and assets. They extend the application through the
`@neotavern/plugin-sdk` package only — never by importing Fastify, React, Zustand,
TanStack Query, the SQLite connection, or internal components directly. Those
are implementation details of the host and change without notice.

The SDK is versioned (`apiVersion` in the manifest) so that plugins keep
working across application updates. The host enforces the contract: whatever
you register through the SDK is cleaned up when your plugin is disabled, and
whatever you would need from internal modules is deliberately not exposed.

## Frontend and Backend Split

A plugin has two optional halves:

- **Frontend** — a browser ESM entry that receives `FrontendPluginApi` in its
  `activate()` call. It registers UI surfaces such as toolbar actions, message
  actions, slash commands, and settings panels, and listens to application
  events.
- **Backend** — a Node.js ESM entry that receives `ServerPluginApi`. It mounts
  routes under `/api/plugins/{pluginId}/`, reads and writes isolated storage,
  performs permission-checked network calls, and registers providers and
  context-shifting strategies.

Both halves are optional. A plugin that only adds a toolbar button needs no
backend; a plugin that only serves an API needs no frontend. Each registration
returns a cleanup function, and the runtime collects these so deactivation
leaves nothing behind.

## Authoring a Plugin

Import `definePlugin` from `@neotavern/plugin-sdk` and export a definition with an
`activate(api)` function:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const unregister = api.ui.messageActions.register({
      id: 'example.greet',
      title: 'Greet',
      run: ({ message }) => console.log(message.messageId),
    });
    api.events.on('chat.opened', ({ chatId }) => console.log(chatId));
  },
});
```

The generated [Plugin SDK reference](../api/plugin-sdk/) documents every
exported type and function with its exact signature.

## Next Steps

- [Manifest](manifest.md) — package structure and `plugin.json` schema.
- [Permissions](permissions.md) — the permission model and consent flow.
- [Frontend API](frontend.md) — registering UI surfaces and events.
- [Declarative UI Slots](slots.md) — buttons for stable semantic slots.
- [Extension Availability](availability.md) — explicit runtime availability.
- [Legacy Frontend Gate](legacy-frontend.md) — app-level opt-in for legacy main-window scripts.
- [Backend API](backend.md) — routes, storage, and server abstractions.
- [Lifecycle](lifecycle.md) — install, enable, disable, and cleanup guarantees.
- [Sandboxing](sandboxing.md) — the security model for untrusted code.
