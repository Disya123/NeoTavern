---
title: Plugin Sandboxing
description: 'The security model for untrusted plugin code: process isolation and safe mode.'
sidebar_position: 7
---

Untrusted plugin code is isolated at every layer: the backend runs in a
separate restricted process, the frontend runs in a sandboxed iframe, and
themes never receive sensitive access at all.

## No JavaScript Sandbox

`node:vm` is deliberately not used as a security sandbox. A JavaScript
interpreter sandbox cannot stop a determined attacker from reaching the
host process. Instead, isolation is enforced by the operating system: separate
processes with limited capabilities, and separate browsing contexts.

## Backend Isolation

An untrusted backend plugin runs in its own Node.js 24 process with
restrictions:

- A limited loader resolves only package-local ESM and the SDK API.
- The process cannot import `node:*` built-ins beyond what the loader allows,
  resolve modules outside the package root, or reach the host database.
- All capabilities arrive through an IPC channel; the host enforces
  permissions at every call.
- The process listens to core application events only through the SDK event
  bus, and can emit only under its own namespace.
- If the process crashes, the host removes every registration it owned.

The plugin process never receives the Fastify root, the SQLite connection,
absolute paths, the full environment, or other providers' API keys. Network
access is limited to granted hosts through the permission-checked `fetch`.

## Frontend Isolation

A native frontend plugin runs inside a sandboxed iframe with
`sandbox="allow-scripts"` and without `allow-same-origin`:

- The iframe has no same-origin access to the application document.
- Communication with the host happens through a single transferred
  `MessagePort` with a bootstrap nonce, structured envelopes, deadlines, and
  cancellation.
- The host mounts each registration's UI into an isolated root inside the
  iframe and communicates via RPC, so the plugin never touches the React
  component tree or internal DOM.
- A plugin UI crash takes down only that plugin's roots and clip regions.

Each plugin owns one full-viewport sandbox iframe; the host batches the
rectangles of active mounts and clips the visible and interactive iframe area
to their union, so pointer events outside a plugin surface stay with the
application.

## Trusted Legacy Mode

`legacy.frontend` and `legacy.backend` entries are a separate, trusted
compatibility mode for existing SillyTavern extensions — not a bypass of the
native sandbox. Using either entry requires the `legacy.trusted` permission,
which the UI shows with an enhanced warning, and the user must confirm it
explicitly. Legacy frontend code executes in the main window, and legacy
backend code gets an Express router scoped to its own
`/api/plugins/{pluginId}` namespace. Safe mode does not load legacy entry
points at all.

## Themes

Theme packages are even more restricted: a theme receives no access to
chats, API keys, or the filesystem. Themes are CSS and declarative layout
only — there is no JavaScript entry point in the Theme SDK. See
[Theme SDK safe mode](../theme-sdk/safe-mode.md) for the theme-side story.

## Safe Mode

Safe mode (`?safe=1` in the URL) disables third-party plugins and themes
entirely. It is handled before plugin or theme code loads: package CSS and
token overrides are not added to the document, and third-party entry points
never run. The built-in theme and the built-in plugin runtime remain, so the
interface always recovers. Leaving safe mode restores the previously saved
active plugin and theme state.

## Package Validation

Every package is validated before any code can run: path traversal,
symlinks, native binaries, and executable payloads are rejected; manifest
fields, entry points, and permissions are checked; npm dependencies are
fetched with integrity checks and install scripts are never executed. For
the full install-to-teardown story, see [Lifecycle](lifecycle.md).
