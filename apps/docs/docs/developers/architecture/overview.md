---
title: Monorepo Overview
description: >-
  The NeoTavern monorepo layout, the data flow between server and web, and
  the local-first principle that shapes the architecture.
sidebar_position: 2
---

NeoTavern is a local-first application: a single Fastify process serves the
API and the optional built frontend, with no external databases, queues, or
containers required.

## Monorepo Layout

The workspace is a pnpm monorepo with two top-level groups, `apps/` and
`packages/`:

```text
apps/
  server/          # Fastify backend: API, prompt pipeline, SSE, legacy host
  web/             # React SPA
  plugin-runtime/  # Restricted Node.js process for backend plugins
  desktop/         # Tauri 2 shell; runs the server as a sidecar process
packages/
  shared/        # UUIDv7 IDs, Result, errors, logger, async utilities
  contracts/     # TypeBox API schemas — single source of truth
  db/            # SQLite: schema, migrations, repositories, FTS5
  ui/            # Headless components on Radix primitives
  i18n/          # i18next setup and language resources
  plugin-sdk/    # Plugin manifest, permissions, and API contracts
  theme-sdk/     # Theme tokens, levels, and inheritance
  provider-sdk/  # Provider adapter contract and adapters
  legacy-compat/ # window globals and DOM compatibility islands
  gestures/      # Framework-agnostic row gestures
  plugin-build/  # Plugin build and publish pipeline
```

## Apps

- `apps/server` — the Fastify backend. It exposes the `/api/v2/*` API, runs
  the prompt pipeline, streams generation over SSE, and hosts the
  Express-compatible legacy surface. Each module is an isolated Fastify
  plugin.
- `apps/web` — the React SPA. It talks to the server over HTTP and renders
  the chat workspace, plus the surfaces for characters, settings, providers,
  themes, and plugins.
- `apps/plugin-runtime` — a permission-limited Node.js process in which
  untrusted backend plugins execute, isolated from the main server process.
- `apps/desktop` — the Tauri 2 shell. It launches the compiled server as a
  self-contained Node.js sidecar and opens the webview only after the local
  API is ready.

## Packages

Shared code lives in narrowly scoped packages under `packages/`. Every
package has one responsibility, and dependencies only point downward:
`server` and `web` depend on packages, and packages depend at most on
`shared` and `contracts`. See [Packages](packages) for the full breakdown.

## Data Flow

A typical request flows through these layers:

1. The frontend calls an `/api/v2/*` endpoint through TanStack Query.
2. Fastify validates the input against a TypeBox schema and returns errors
   in the `{ code, params, traceId }` envelope.
3. Repositories in `@neotavern/db` read and write SQLite, with cursor pagination
   and FTS5 search.
4. Generation runs `POST /api/v2/chats/:id/generate`: the prompt pipeline
   assembles the context, the provider adapter serializes the request, the
   response streams back over SSE, and the message is saved.

The web app is a single page: routes change the chat workspace, while
characters, settings, providers, themes, and plugins render in a dialog
surface over the preserved chat location.

## Local-First Principle

Everything runs on your machine:

- The backend binds to `127.0.0.1` by default. Remote access is an explicit
  opt-in with bounded sessions and HTTPS requirements.
- All data lives in one local data directory: a single SQLite database plus
  a content-addressed file store. No PostgreSQL, Redis, or Docker.
- The app works offline. Provider calls are the only network traffic, and
  the built-in `echo` adapter lets you test the whole pipeline without any
  provider.
- Backups, exports, and the SillyTavern import all happen locally through
  the same SQLite and file APIs.

See [Data & Storage](../data/) for the storage layer and
[Prompt Pipeline](../prompt-pipeline/) for the generation path.
