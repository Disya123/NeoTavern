---
title: Extension Availability
description: How the app reports whether extension surfaces exist at all (ТЗ §60/§61/§92).
sidebar_position: 7
---

Extensions do not exist everywhere. The desktop kernel build has no HTTP
server and no plugin host at all, so availability is reported explicitly
(ТЗ §60/§61/§92) instead of failing obscurely at runtime.

## Availability Model

`useExtensionAvailability()` (web host) returns a stable snapshot:

```ts
interface ExtensionAvailability {
  themes: 'available' | 'unavailable';
  nodeRuntime: 'available' | 'unavailable' | 'reduced';
  reason?: string; // machine-readable, e.g. 'node-runtime-desktop-kernel-mode'
}
```

- **`themes`** — always `'available'` in the web host; theme rendering is a
  first-class web surface.
- **`nodeRuntime`** — the Node plugin runtime:
  - `'available'` — in the browser/server-served app (plugins run in sandboxed
    iframes and Node workers).
  - `'unavailable'` — in desktop kernel mode (`isTauriRuntime()`): the SPA
    talks to the Rust kernel over Tauri IPC and there is no plugin host.
  - `'reduced'` — reserved for future degraded modes (for example sandboxed
    iframes unavailable); the web host never reports it today.
- **`reason`** — a stable machine-readable code (never a human string) when a
  surface is not fully available; the UI maps it to localized text.

The value is a pure probe of `isTauriRuntime()` and is stable for the lifetime
of the window — no subscription is needed.

## Where It Surfaces

The Plugins page shows a small availability note derived from `nodeRuntime`
(«Plugin runtime: available» / «Plugin runtime: unavailable — no plugin host
in this desktop build»), so users in kernel mode immediately know why
installing plugins is impossible.

Mobile builds follow the same model host-side: the Android WebView exposes
`backgroundExecutionAvailable()` and has no plugin surface, matching the
`unavailable` reporting contract.

See also: [Sandboxing](/developers/plugin-sdk/sandboxing) for how plugins run
where they are available, and [Declarative UI Slots](slots.md) for the plugin
UI surface.
