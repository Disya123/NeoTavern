---
title: Architecture
description: >-
  Overview of the architecture section: the monorepo layout, the approved
  technology stack, and the responsibilities of each package.
sidebar_position: 1
---

This section explains how the NeoTavern monorepo is organized, which
technologies it uses, and how the server, web client, and desktop shell fit
together.

## Pages in This Section

- [Monorepo Overview](architecture/overview) — the layout of `apps/` and `packages/`, the
  data flow between server and web, and the local-first principle.
- [Technology Stack](architecture/stack) — the approved stack: Node.js 24, Fastify 5,
  React 19, Vite 8, SQLite, Drizzle, Tauri 2, and pnpm workspaces.
- [Packages](architecture/packages) — the responsibility of every workspace package and
  the dependency direction between them.

## Related Sections

The [Prompt Pipeline](prompt-pipeline/) section describes the generation
stages in detail, and [Data & Storage](data/) documents the database,
file handling, and backups.
