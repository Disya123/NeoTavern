---
title: Desktop Overview
description: How the desktop app is delivered — a Tauri 2 shell with an embedded Node.js sidecar.
sidebar_position: 1
---

The desktop app is a native distribution of NeoTavern: a Tauri 2 shell that hosts
the Rust kernel in-process and renders the React client in the WebView. There is no
backend process to start, and no local port to wait for.

## One App, No Setup

The desktop distribution is self-contained. The kernel, SQLite (bundled) and the
production web assets ship inside the package, so the first run needs no terminal,
no Git, no npm, and no manual database setup. You install the app, launch it, and
the WebView opens against the kernel already listening on the IPC channel.

The runtime pieces are:

- **Tauri 2 shell** — the native window, application lifecycle, and the host-only
  commands (job report, remote access, activation).
- **Runtime kernel** — Rust, in-process: dispatch, prompt pipeline, providers,
  plugins, storage.
- **SQLite** — the local database, created by the kernel in the data directory on
  first run.

## Supported Formats

The desktop build targets the formats most users expect:

- Windows installer (NSIS and MSI).
- Windows portable build (a ZIP with a portable flag).
- macOS package (`.app`, plus DMG).
- Linux AppImage and an archive.

Each format is produced on its native platform runner, because the
distribution bundles native addons such as `better-sqlite3` and Sharp. See
[Packaging](packaging.md) for the format details and first-run behavior.

## Lifecycle Guarantees

The shell and the sidecar are one unit. Closing the window shuts down the
backend — the app never leaves an orphan Node.js process behind. An
unexpected backend exit ends the shell with an error instead of a silently
broken window. See [Tauri Shell](tauri-shell.md) and
the [kernel transport](tauri-shell.md) for the mechanics; the Node sidecar it used to describe is gone.

## Recovery Mode

If a third-party theme or plugin leaves the interface unusable, start the
app in recovery (safe) mode — third-party package code never loads:

- **Kernel mode** — append `?safe=1` to the window URL
  (`tauri://localhost/?safe=1`). The web layer processes the switch before
  any package CSS or plugin entry point loads (see
  [Safe Mode](../theme-sdk/safe-mode.md)); in kernel mode this is the theme
  recovery switch, because declarative theme packages are the only
  third-party contribution the kernel-mode shell accepts.
- **Server mode** (legacy sidecar or a self-hosted server) — set
  `NEOTA_SAFE_MODE=true` on the backend process: third-party plugin
  activation is disabled for the whole startup. The web `?safe=1` switch
  also works here, since the server serves the SPA.

Leaving safe mode restores the previously saved theme and plugin state —
exiting does not change your selection.

## Plugin Runtime Availability

The plugin runtime (sandboxed backend workers, the capability broker,
frontend registrars) is a **server** feature: it
exists only where a backend process runs.

- **Kernel plane (the only plane)** — the Runtime Kernel is embedded in the shell
  and there is no plugin host process (no HTTP, no listening port). Plugin code
  runs in a sandbox against the wire surface; themes stay declarative.
- **Legacy sidecar mode** — removed in round 60b together with the Fastify
  backend. `NEOTA_LEGACY_SERVER` no longer exists, and the rollback path is a git
  revert, not an environment variable.

Which extension surfaces the web UI exposes is documented in the [Frontend Plugin API](../plugin-sdk/frontend.md)
availability note.

## Data Location

Installed builds store user data in the platform's app-local-data directory,
never inside the bundle. The portable build is the exception: with the
portable flag present, data lives in a local `data/` folder next to the
application. Data handling itself is covered in the
[Data and Storage](../data/index.md) section.

## Next Steps

- [Tauri Shell](tauri-shell.md) — the native window and its lifecycle.
- [Node sidecar (removed)](node-sidecar.md) — historical, the process no longer exists.
- [Packaging](packaging.md) — distribution formats and first run.
