---
title: Technology Stack
description: >-
  The approved NeoTavern stack: Rust kernel, React 19, Vite 8, strict
  TypeScript, SQLite through the kernel, and Tauri 2.
sidebar_position: 3
---

NeoTavern runs on two halves and one contract: a Rust kernel that owns state and
I/O, a React web client that renders it, and a TypeBox envelope (Product Wire) that
is the only way between them.

## Kernel (Rust)

- **`crates/runtime-kernel`** — one operation dispatcher over Product Wire: every
  product operation is matched by id, validated against generated contracts,
  executed against SQLite, and answered as a typed envelope.
- **`crates/storage`** — SQLite (`rusqlite`, bundled), schema versions and
  migrations, backups, versioned data roots. No other layer opens the database.
- **Adapters** — `tauri-local` (desktop IPC), `headless`/`remote-http` (tests and
  remote clients), `cli`. Each answers byte-identical envelopes.
- **`crates/plugin-executor` + `plugin_jobs`** — durable job queue and the
  scheduling state machine; plugin code runs in a sandbox and never holds a
  database handle.

## Client (TypeScript)

- **React 19 + Vite 8 + strict TypeScript** — the web client, also the desktop
  UI inside the Tauri WebView.
- **`@neotavern/contracts`** — TypeBox schemas and the wire registry; codegen
  produces the Rust types, so a contract change breaks both sides at build time.
- **`@neotavern/neobackend`** — one facade (`backend.*`) over three transports:
  local kernel (desktop), remote kernel (HTTP), and a closed backend that throws
  `UnsupportedError` when there is no host. There is no legacy transport.
- **TanStack Query** — server state, invalidation driven by kernel app events.
- **`@neotavern/ui`, `@neotavern/i18n`** — headless components and `en`/`ru`
  resources.

## Desktop shell

- **Tauri 2** — opens the kernel in-process, exposes `kernel_dispatch` plus a few
  host-only commands (job report, remote access, activation), and never spawns a
  sidecar. The Node sidecar was deleted with the Fastify contour.

## Removed from the stack

Fastify 5, the `/api/v2` routes, Drizzle ORM and `packages/db` are gone, together
with the Node sidecar and the SSE event stream. Documents that still mention them
describe history; ADRs keep their original text on purpose.
