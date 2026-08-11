---
title: Legacy Compatibility
description: The documented SillyTavern-era contracts that still work.
sidebar_position: 8
---

NeoTavern preserves a set of documented contracts for existing
SillyTavern-era extensions, so that plugins written against those APIs can
keep working while the native Plugin SDK is the path forward.

## Window Globals

The `@neotavern/legacy-compat` package installs the documented window globals that
older extensions expect:

- `window.SillyTavern` — with `getContext()`, `eventSource`, and
  `event_types`.
- `window.eventSource` — the legacy event source.
- `window.event_types` — the event name constants.
- `window.extension_settings` — the shared extension settings object.
- `window.$` and `window.jQuery` — the bundled jQuery instance.

These globals are installed idempotently and wired to the host through a
bridge, so legacy code can read the same context and events as native code.

## Unmanaged DOM Islands

Legacy frontend extensions expect to own a piece of the page. The host
provides unmanaged DOM islands for this purpose: a stable container that
legacy code can attach to and manipulate directly, outside the React tree.
Extensions get the container, and the host handles the rest of the
application around it.

## Legacy Server Plugins

Legacy server plugins run through an Express compatibility host. Their
routes are proxied under `/api/plugins/{pluginId}/...`, matching the same
namespace native backend plugins use. The `@fastify/express` integration is
used only inside this compatibility layer — the new core is Fastify-native
and does not route through Express.

## The Trusted Boundary

Legacy entry points are a trusted mode, not a sandbox bypass. A package that
uses them must declare `legacy.frontend` or `legacy.backend` in its manifest
and request the `legacy.trusted` permission, which the consent UI shows with
an enhanced warning. Legacy frontend code executes in the main window, and
legacy backend code gets an Express router scoped to its own plugin
namespace. Safe mode does not load legacy entry points at all. See
[Plugin sandboxing](plugin-sdk/sandboxing.md) and
[Plugin manifest](plugin-sdk/manifest.md) for details.

## What Is Not Supported

Compatibility is a documented contract, not a promise of universal behavior.
Plugins that depend on any of the following are not supported:

- Random internal CSS class names.
- Monkey patching of application internals.
- Private imports from packages they do not own.

These are implementation details and change between releases. When a legacy
API does change, the change ships with a migration guide and a compatibility
test.

## Migrating Forward

For new functionality, the native [Plugin SDK](plugin-sdk/index.md) is the
supported path: versioned, permission-checked, sandboxed, and cleaned up by
the host. Legacy compatibility exists to keep existing extensions alive, not
to grow. Port extensions to the SDK to get the full security and lifecycle
guarantees.
