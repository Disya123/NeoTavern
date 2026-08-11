---
title: Desktop Overview
description: How the desktop app is delivered — a Tauri 2 shell with an embedded Node.js sidecar.
sidebar_position: 1
---

The desktop app is a native distribution of NeoTavern: a Tauri 2 shell that
runs the Fastify backend as an embedded Node.js sidecar.

## One App, No Setup

The desktop distribution is self-contained. Node.js, SQLite, and the
production web assets ship inside the package, so the first run needs no
terminal, no Git, no npm, and no manual database setup. You install the app,
launch it, and the webview opens once the local API is ready.

The runtime pieces are:

- **Tauri 2 shell** — the native window and application lifecycle.
- **Node.js sidecar** — a self-contained Node.js 24 binary that runs the
  Fastify backend locally on `127.0.0.1`.
- **SQLite** — the local database, created automatically in the data
  directory on first run.

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
[Node Sidecar](node-sidecar.md) for the mechanics.

## Data Location

Installed builds store user data in the platform's app-local-data directory,
never inside the bundle. The portable build is the exception: with the
portable flag present, data lives in a local `data/` folder next to the
application. Data handling itself is covered in the
[Data and Storage](../data/index.md) section.

## Next Steps

- [Tauri Shell](tauri-shell.md) — the native window and its lifecycle.
- [Node Sidecar](node-sidecar.md) — the embedded backend process.
- [Packaging](packaging.md) — distribution formats and first run.
