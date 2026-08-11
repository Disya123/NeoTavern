---
title: Packages
description: >-
  The responsibility of each workspace package and the dependency direction
  that keeps the monorepo free of cycles.
sidebar_position: 4
---

Every workspace package has exactly one responsibility, and dependencies
only point downward, which keeps the monorepo free of cycles.

## Dependency Direction

Code may only depend on packages "below" it:

```text
apps (server, web, desktop, plugin-runtime)
  → packages
  → shared, contracts (the floor)
```

`server` and `web` depend on packages; packages depend at most on `shared`
and `contracts`. Cyclic dependencies are forbidden. When you add new code,
put it in the narrowest package that can host it: shared helpers go to
`@neotavern/shared`, API shapes go to `@neotavern/contracts`, and anything database
related goes to `@neotavern/db`.

## Package Responsibilities

- `@neotavern/shared` — isomorphic utilities with zero runtime dependencies:
  UUIDv7 IDs, `Result`, the `AppError` envelope, a structured logger with
  secret redaction, timeout and signal helpers, and prompt macros.
- `@neotavern/contracts` — TypeBox schemas for every API input and output. The
  single source of truth shared by server and web; never duplicated by hand.
- `@neotavern/db` — SQLite: the Drizzle schema, migrations, repositories, and FTS5
  search. The only package that talks to the database.
- `@neotavern/ui` — headless base components built on Radix primitives, design
  tokens, and the `data-*` hooks that themes rely on.
- `@neotavern/i18n` — i18next setup, namespaces, `en` and `ru` resources, and the
  error-code localizer that maps machine error codes to localized text.
- `@neotavern/plugin-sdk` — the versioned Plugin SDK: manifest schema, permissions
  and capability grants, and the frontend and backend API contracts that
  plugins compile against.
- `@neotavern/theme-sdk` — the Theme SDK: manifest schema, the
  token/component/shell levels, and inheritance resolution.
- `@neotavern/provider-sdk` — the unified provider adapter contract plus the
  built-in adapters for LLM, TTS, STT, and image providers, and the adapter
  registry.
- `@neotavern/legacy-compat` — the legacy compatibility layer: `window` globals,
  the event bus, and unmanaged DOM islands for SillyTavern-era scripts.
- `@neotavern/gestures` — framework-agnostic row gestures: context menus
  (right-click and long-press) and drag-and-drop reorder recognition.
- `@neotavern/plugin-build` — the plugin build and publish pipeline: analyze,
  sign, and build plugin packages.

## What Lives Where

- **API shapes** always come from `@neotavern/contracts`. Backend and frontend
  never declare the same type twice.
- **Database access** happens only through `@neotavern/db` repositories. Plugin
  code never receives a SQLite connection.
- **Provider behavior** lives in `@neotavern/provider-sdk` adapters. The server
  core is not coupled to any single provider's SDK, with one documented
  exception: the Anthropic adapter uses the official SDK for beta surfaces.
- **UI building blocks** come from `@neotavern/ui`; application screens compose
  them. Framework-agnostic gestures stay in `@neotavern/gestures` so they can be
  reused outside React.

## Adding a Package

A new package needs a `README.md` that states its purpose, public entry
points, dependencies, and constraints — documentation is part of the
implementation. Before creating one, check whether the code fits an existing
package; the default answer is no new package.
