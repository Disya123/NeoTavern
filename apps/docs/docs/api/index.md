---
title: SDK Reference
description: Overview of the auto-generated TypeDoc reference for the four public SDK packages.
sidebar_position: 1
---

The SDK Reference is an auto-generated API reference for the four public TypeScript
packages that NeoTavern exposes to plugin, theme, and provider authors.

## What Is Generated

The reference is produced by TypeDoc from each package's `src/index.ts` entry
point during every site build. It documents the exact exported surface of:

- **Plugin SDK** — `@neotavern/plugin-sdk`: manifest validation, the permission model,
  typed events, and the frontend and backend plugin API contracts.
- **Theme SDK** — `@neotavern/theme-sdk`: the design-token contract, theme manifest
  validation, inheritance resolution, and CSS-variable generation.
- **Provider SDK** — `@neotavern/provider-sdk`: the provider adapter contract, built-in
  adapters, token estimation, and the runtime registry.
- **Contracts** — `@neotavern/contracts`: the shared request, response, and entity
  schemas that the backend routes and the frontend types both derive from.

The generated pages are not hand-written and are not committed to the repository.
They are recreated on every build, so they always match the current `src/` of the
packages.

## Regenerating the Reference

Any Docusaurus build regenerates the reference as part of the pipeline:

```bash
pnpm --filter @neotavern/docs build
```

Run the same command locally when you want a fresh reference after changing an
SDK source file.

## Browsing the Packages

- [Plugin SDK reference](api/plugin-sdk/)
- [Theme SDK reference](api/theme-sdk/)
- [Provider SDK reference](api/provider-sdk/)
- [Contracts reference](api/contracts/)

For usage guides instead of raw API listings, see the Plugin SDK, Theme SDK, and
Providers sections of this documentation. They explain the contracts in prose,
with examples, and link back to the generated pages for the precise signatures.
