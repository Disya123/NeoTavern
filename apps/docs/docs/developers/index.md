---
title: Developers
description: >-
  Overview of the NeoTavern developer documentation: architecture, the
  prompt pipeline, the data layer, and the SDKs for extending the app.
sidebar_position: 1
---

This section explains how NeoTavern is built and how you can extend it with
plugins, themes, and provider adapters.

## What This Section Covers

The developer documentation is split into four groups:

- **Architecture** — the monorepo layout, the approved technology stack, and
  the responsibility of every workspace package.
- **Prompt pipeline** — the fixed set of stages that turns a chat into a
  provider request, including instruct formats, tokenization, and context
  shifting.
- **Data & Storage** — how NeoTavern stores structured data in SQLite, how
  files and images are handled on disk, and how backups work.
- **Extending NeoTavern** — the Plugin SDK, the Theme SDK, provider
  adapters, the generated API reference, and the desktop shell.

## Where to Start

Start with the [Architecture Overview](developers/architecture/) if you want to
understand the shape of the codebase, or jump straight to the
[Prompt Pipeline](developers/prompt-pipeline/) if you are working on generation
behavior.

## Data Layer

The [Data & Storage](developers/data/) section covers the SQLite database, the file
system layout, and the backup model. It is the reference for anything that
persists data.

## Extending NeoTavern

NeoTavern is extended in four ways:

- [Plugin SDK](developers/plugin-sdk/) — plugins with a manifest, permissions,
  frontend and backend APIs, lifecycle hooks, and sandboxing.
- [Theme SDK](developers/theme-sdk/) — themes built from design tokens, component
  skins, and shell layouts.
- [Providers](developers/providers/) — provider adapters that implement the unified
  adapter contract.
- [Legacy compatibility](developers/legacy-compat) — the compatibility layer for
  SillyTavern-era plugins and scripts.

The [API Reference](api/) is generated from the SDK sources by TypeDoc
during every site build, so its member pages always match the published
packages.

## Desktop

The [Desktop](developers/desktop/) section documents the Tauri 2 shell, the Node.js
sidecar, and how installers and portable builds are packaged.
