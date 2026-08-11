---
title: Tauri Shell
description: The Tauri 2 native shell and how closing the window stops the backend.
sidebar_position: 2
---

The desktop shell is built on Tauri 2. It owns the native window, launches
the backend, and guarantees that the two shut down together.

## The Shell's Job

The shell does three things:

1. **Spawns the sidecar** — it starts the self-contained Node.js backend
   process and waits until the local API is ready before opening the
   webview. You never see a half-loaded window pointing at a dead server.
2. **Hosts the webview** — the production web app runs inside the Tauri
   webview and talks to the backend over `127.0.0.1` on a random free port.
3. **Owns the lifecycle** — window events and process events are wired so
   that backend and shell always exit as one unit.

## Window Lifecycle

- **Close** — closing the window triggers a graceful shutdown of the
  sidecar. The backend is asked to stop cleanly, and the app waits for it
  before exiting. No orphan Node.js process is left behind.
- **Backend crash** — if the sidecar exits unexpectedly, the shell
  terminates with an error instead of showing a window that cannot do
  anything. Normal exits are marked separately so a clean shutdown is
  never mistaken for a crash.
- **Restart** — starting the app again re-spawns the sidecar from scratch.
  State lives in the data directory, not in the process, so restarts are
  lossless.

## The Window Is the API

Because the shell waits for the API before showing content, first launch
feels immediate: the window opens on a ready application. The backend listens
only on `127.0.0.1` on an ephemeral port, so nothing is exposed to the
network.

## Updater Integration

Release builds integrate the Tauri updater. The shell can check for core
updates, verify the manifest and minisign signature, install the platform
artifact, and restart. The updater replaces the core separately from the
user's data directory, and unsigned downgrades are rejected. Builds made
without an update endpoint and public key are fully functional but report
that updates are not configured.

## Development Builds

For development, the same shell can run against a dev server and a locally
started backend. The production guarantee — sidecar exits with the window —
applies to packaged builds; `pnpm desktop:dev` wires the shell to your
running dev processes instead.

For how the sidecar is bundled and managed, see
[Node Sidecar](node-sidecar.md).
