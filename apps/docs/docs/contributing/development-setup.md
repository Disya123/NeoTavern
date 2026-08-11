---
title: Development Setup
description: Set up a NeoTavern development environment and run the project locally
sidebar_position: 2
---

This page explains how to set up a development environment for NeoTavern and run
the project locally.

## Prerequisites

- Node.js 24 LTS or newer — the project requires Node `>= 24`.
- pnpm 9 — the workspace requires pnpm `>= 9` and `< 10` and declares
  `packageManager: pnpm@9.15.0`; enable it with corepack or install it directly.
- Windows, macOS, or Linux. The desktop app bundles its own Node.js runtime for
  end users, but development always uses your installed Node.js.

## Install Dependencies

```bash
pnpm install
```

This installs every workspace package. The repository is a pnpm monorepo:
applications live in `apps/` (server and web) and shared libraries live in
`packages/`.

## Run in Development

```bash
pnpm dev
```

starts the Fastify backend and the Vite web app in parallel with hot reload. To
run them separately:

```bash
pnpm dev:server
pnpm dev:web
```

Open the URL printed by the Vite dev server, connect a provider in Settings, and
send your first message to verify the full pipeline: chat, server, provider,
streaming, and save.

## Quality Gates

Run these before pushing:

```bash
pnpm typecheck    # TypeScript across the monorepo
pnpm lint         # ESLint, zero warnings allowed
pnpm test         # Vitest unit and integration tests, plus web tests
pnpm test:e2e     # Playwright end-to-end suite (builds the workspace first)
pnpm build        # full workspace build (tsc -b and Vite)
pnpm format:check # Prettier check
```

`pnpm test:e2e` compiles the whole workspace first, so expect it to take longer
than the other checks. The `docs:check` and `docs:build` scripts validate the
internal developer documentation; the public site has its own commands,
documented on the [Documentation Site](./docs-site) page.

## Desktop Development

The desktop shell (Tauri) and its Node sidecar are separate applications:

```bash
pnpm desktop:dev       # run the desktop app in development
pnpm desktop:portable  # build the portable Windows package
pnpm desktop:release   # build installer packages
```

Desktop packaging involves OS-specific toolchains; see the
[Desktop](../developers/desktop/) section of the Developers documentation for
details.

## Common Issues

- `pnpm install` or `pnpm dev` fails: check that `node -v` reports 24 or newer
  and `pnpm -v` reports 9.
- The dev servers do not start: check that no other process occupies the ports
  the server and Vite use, then restart `pnpm dev`.
