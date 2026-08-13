---
title: Legacy Frontend Gate
description: The app-level opt-in that keeps legacy SillyTavern frontend code out of the main WebView (ТЗ §10/§87).
sidebar_position: 8
---

ТЗ §10/§87 require that no arbitrary third-party JavaScript runs in the main
WebView. Native (rev4) plugins already run in an opaque-origin sandboxed
iframe; the remaining exception is the **legacy SillyTavern frontend** path,
which injects a plain `<script src="/api/v2/plugins/:id/legacy.js">` into the
main document.

## Two Independent Gates

A legacy frontend entry loads **only when both** conditions hold:

1. **Per-plugin consent** — the admin approved the `legacy.trusted`
   permission for that plugin (this remains an admin-only decision, never a
   manifest request).
2. **App-level opt-in** — the `extensions.legacyFrontend` setting is `true`.

The app-level setting defaults to **off**. Both the server (which registers
the setting) and the web host (which reads it through the settings API)
default to the closed position, so legacy main-window scripts stay inert until
an admin deliberately enables the whole legacy frontend surface.

When the gate is off, trusted legacy entries are skipped and the web host logs
**one** warning per session; it never logs per plugin. Turning the gate off
while plugins are loaded unloads the injected scripts immediately.

## What Stays Installed

`window.SillyTavern` and the other legacy globals (`window.eventSource`,
`window.event_types`, `window.extension_settings`, `window.$`/`window.jQuery`)
remain installed unconditionally. They are a documented legacy compatibility
contract (AGENTS.md §18) and are inert markers on their own — only an injected
legacy entry can actually run code against them. Keeping them installed means
legacy packages that probe for the globals at load time still load
gracefully; the gate only controls script _injection_.

## Why Both Gates

- `legacy.trusted` alone proves the admin reviewed _one_ package — but every
  future trusted package would also inject main-window JS without a global
  kill switch.
- The app-level gate is the master switch: environments that must not run
  unmanaged JS (the default posture) never see legacy entries even if an
  admin previously consented to a package.

## Configuration

| Setting                     | Type    | Default | Owner                                    |
| --------------------------- | ------- | ------- | ---------------------------------------- |
| `extensions.legacyFrontend` | boolean | `false` | server settings (registered server-side) |

There is no per-plugin exception: the app-level gate is global. Disabling the
gate is equivalent to «no legacy frontend plugins, ever», while keeping the
globals and the consent records intact for later opt-in.

See also: [Sandboxing](/developers/plugin-sdk/sandboxing) for the rev4
sandbox model and [Extension Availability](availability.md) for when the
plugin host exists at all.
