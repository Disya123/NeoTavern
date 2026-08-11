---
title: Packaging
description: Distribution formats for Windows, macOS, and Linux, and the first-run experience.
sidebar_position: 4
---

NeoTavern is distributed as native packages per platform, each carrying the
Node.js sidecar, SQLite, native addons, and the production web assets.

## Distribution Formats

The desktop build produces:

- **Windows installer** — NSIS and MSI installers with per-user install
  mode. The installer registers the app and puts user data in the
  platform's app-local-data directory.
- **Windows portable build** — a ZIP containing the executable, the sidecar,
  a `portable.flag` marker, and `resources/`, plus a `.sha256` checksum
  file. With the flag present, data lives in a local `data/` folder next to
  the application instead of app-local-data.
- **macOS package** — a `.app` bundle, packaged into a DMG on the macOS
  runner.
- **Linux** — an AppImage and an archive.

Each format is built and smoke-tested on its own native platform runner,
because the distribution bundles native addons. Cross-platform copying of
prepared artifacts is not supported.

## What Ships Inside

Every package contains everything the app needs at runtime:

- The Tauri 2 shell.
- The self-contained Node.js 24 sidecar executable.
- SQLite via `better-sqlite3`.
- Sharp for image processing.
- The production web assets.

Because Node.js, SQLite, and the assets are inside the package, the user
needs nothing installed beforehand — no Node.js, no npm, no database setup.

## First Run

The first launch is the product's core promise: open the app, and it works.

1. The shell starts the sidecar.
2. The backend creates the data directory, initializes the SQLite database,
   runs pending migrations (with a backup before pending schema changes),
   seeds bundled themes and the starter character.
3. The webview opens on the ready application.

There is no terminal, no installer wizard beyond the platform one, no
`npm install`, and no manual configuration. If the user chose a chat
background or installed plugins, none of that lives in the executable — user
data is separate from the bundle, so updates replace the core without
touching user files.

## Updates

Release builds sign their artifacts and integrate the Tauri updater. The
updater verifies the manifest and a minisign signature before installing a
platform artifact, then restarts the shell. Rollback means publishing the
previous reviewed code as a new signed release — unsigned downgrades are not
allowed. Plugins and themes update independently through the Plugin and
Theme managers; user files never enter an executable update artifact.

## Building

From the repository, the packaging commands are:

```bash
pnpm desktop:prepare
pnpm desktop:build
pnpm desktop:portable
pnpm desktop:release
```

`desktop:prepare` builds the server and web, copies target-specific native
addons, and creates the sidecar with the Tauri target-triple suffix.
`desktop:portable` additionally builds the NSIS/MSI installers and the
portable ZIP with checksum, then runs a headless shell smoke test.
`desktop:release` produces signed updater artifacts and requires the release
secrets. Building installers requires Rust stable MSVC, Windows C++ Build
Tools, and WebView2 on the build machine — none of which end users need.
