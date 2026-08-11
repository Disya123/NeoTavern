---
title: Technology Stack
description: >-
  The approved NeoTavern stack: Node.js 24, Fastify 5, React 19, Vite 8,
  strict TypeScript, SQLite with Drizzle, and Tauri 2.
sidebar_position: 3
---

NeoTavern runs on a deliberately boring stack: Node.js 24 LTS, Fastify 5,
React 19, Vite 8, strict TypeScript, SQLite with Drizzle ORM, and a Tauri 2
desktop shell.

## Runtime and Language

- **Node.js 24 LTS** — the runtime for the backend and the bundled desktop
  sidecar. Code stays compatible with Node.js 22 where practical.
- **TypeScript strict** — enabled everywhere. Unjustified `any`, `as unknown
as`, `@ts-ignore`, and non-null assertions are banned. System boundaries
  use `unknown` and explicit validation.
- **ESM only** — all apps and packages use ES modules.

## Backend

- **Fastify 5** — the API framework. Every backend module is an isolated
  Fastify plugin.
- **TypeBox + Fastify Type Provider** — every API input and output has a
  JSON Schema, generated from `@neotavern/contracts`.
- **SSE** — streaming generation runs over Server-Sent Events. WebSocket is
  reserved for real bidirectional channels.
- **AbortSignal** — every long-running operation accepts an `AbortSignal`
  and times out cleanly when the client disconnects.

## Frontend

- **React 19** — a single-page app, no server-side rendering.
- **Vite 8** — the bundler and dev server. Vite is build tooling only, not
  an application plugin API.
- **React Router** — routing, with a single chat workspace and system
  surfaces rendered over it.
- **TanStack Query** — the only store for server state.
- **Zustand** — transient UI state only: the active panel, theme and
  language preferences, the pinned character, and limited session-only
  drafts.
- **Radix Primitives** — accessible headless components wrapped by
  `@neotavern/ui`.

## Data

- **SQLite via better-sqlite3** — the single database file, opened with WAL,
  `foreign_keys = ON`, `busy_timeout`, and prepared statements.
- **Drizzle ORM** — typed schema, repositories, and migrations.
- **FTS5** — full-text search over characters, chats, and messages.

## Styling

- **CSS Modules + custom properties + cascade layers + container queries** —
  the styling toolkit. Themes override design tokens and layer rules without
  fighting specificity.

## Templating and Localization

- **Handlebars** — instruct-format templates, rendered in a sandboxed
  environment with no filesystem or code-execution access.
- **i18next** — all user-facing strings, with namespaces and per-locale
  resources.

## Desktop

- **Tauri 2** — the desktop shell, with the Node.js server shipped as a
  self-contained sidecar binary.
- **tauri-plugin-shell and tauri-plugin-updater** — process management and
  signed updates.

## Tooling

- **pnpm workspaces** — the monorepo package manager.
- **Vitest** — unit and integration tests.
- **Playwright** — end-to-end tests, including desktop shell smoke tests.

## What Is Deliberately Absent

- No PostgreSQL, Redis, Docker, or any other service you must install or
  run.
- No SSR or Node server for the frontend beyond the API process.
- No `node:vm` as a security sandbox for plugins — untrusted backend
  plugins run in a separate restricted process instead.

See [Monorepo Overview](overview) for how the pieces fit together and
[Packages](packages) for who owns what.
