---
title: Node Sidecar
description: The Fastify backend as an embedded Node.js sidecar, from startup to graceful shutdown.
sidebar_position: 3
---

The backend of NeoTavern is a Fastify server, and in the desktop app it runs
as an embedded Node.js sidecar: a self-contained Node.js 24 binary packaged
next to the shell.

## Why a Sidecar

Bundling the backend as a separate process keeps the shell thin and the
backend real:

- The backend is the same Fastify 5 application that a self-hosted install
  runs, so desktop and server behavior stay identical.
- Node.js and SQLite are compiled into the distribution, which is why the
  first run needs no npm install and no terminal.
- A process boundary means a crash or a hang in the backend cannot take down
  the shell's event loop, and the shell can enforce lifecycle guarantees.

## Startup

On launch the shell spawns the sidecar executable and waits for readiness
before opening the webview. The backend:

- listens on a random free port on `127.0.0.1` only;
- creates the SQLite database and runs pending schema migrations in the
  data directory, taking a backup before pending migrations;
- serves the production web assets and the API.

First run is fully automatic: data directory, database, bundled themes, and
the starter character are set up without any user interaction.

## Graceful Shutdown

Shutdown is cooperative and ordered:

1. The shell receives the close event and tells the backend to stop.
2. The backend stops accepting new connections, finishes in-flight work
   within its deadline, and closes the database cleanly.
3. The sidecar exits and the shell exits.

An unexpected backend termination is detected by the shell and reported as an
error exit, never left to silently orphan a backend process. The app
therefore never leaves a stray `neotavern-server` process behind after the
window is closed.

## Bundling and Verification

The sidecar is built per target platform. Native addons (`better-sqlite3`,
Sharp) and the production web assets are prepared on the same target runner
and packaged with the executable; moving prepared resources between
operating systems is not supported. A smoke gate runs the packaged sidecar
headless on each platform in CI, verifying the real Node executable, SQLite,
Sharp, the packaged SPA, diagnostics, and the absence of leftover processes.

## Portable Variant

The portable Windows build runs the same sidecar layout: the main
executable, the sidecar executable, a `portable.flag` marker, and a
`resources/` folder. The flag switches the data root to a local `data/`
folder next to the application. The shell normalizes Windows resource paths
before handing them to the packaged Node binary.

For the formats and the first-run experience, see
[Packaging](packaging.md); for the shell that manages this process, see
[Tauri Shell](tauri-shell.md).
