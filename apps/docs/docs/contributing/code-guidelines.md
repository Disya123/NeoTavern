---
title: Code Guidelines
description: The rules every NeoTavern code contribution must follow
sidebar_position: 3
---

NeoTavern code contributions follow a shared set of rules: strict TypeScript, an
explicit error contract, documentation as part of the change, and measurable
performance targets.

## TypeScript

- Strict mode is enabled for all code; keep it on.
- Unjustified `any`, `@ts-ignore`, non-null assertions, and `as unknown as`
  casts are prohibited.
- At system boundaries — parsing, requests, files, plugin input — use `unknown`
  and validate explicitly before trusting the data.
- Public interfaces expose exported types. Never hand-duplicate backend and
  frontend types: shared API types live in `packages/contracts` and are imported
  from there.
- Use ESM throughout.
- Prefer small functions with explicit inputs and outputs over large, stateful
  ones.

## API Errors

Every API error uses a stable, machine-readable envelope:

```json
{
  "code": "CHARACTER_NOT_FOUND",
  "params": { "characterId": "0193..." },
  "traceId": "01J4..."
}
```

- `code` is a stable, machine-readable error identifier — do not change it once
  shipped.
- `params` carries structured context that a client or plugin can act on.
- `traceId` correlates the error with server logs.
- User-facing text is never composed on the backend: the frontend localizes the
  code and params into UI text.

## Documentation Is Part of Implementation

Documentation is part of the implementation, not a tail that comes after the
code. Any change that affects user or developer behavior updates the relevant
files in `docs/` in the same change. This is mandatory for:

- architecture and package boundaries;
- REST API, SSE, WebSocket, and contract schemas;
- Plugin SDK, Theme SDK, and the legacy compatibility layer;
- permissions, sandboxing, and the security model;
- SQLite schema, migrations, backup, and restore;
- import, export, files, and the thumbnail cache;
- prompt pipeline, instruct formats, tokenization, and context shifting;
- provider adapters;
- desktop packaging, the Tauri sidecar, Web Client, and updates;
- user settings, i18n, and accessibility;
- breaking changes, deprecations, and migration guides.

Additional rules:

- Every new `app` or `package` ships a `README.md` covering purpose, public
  entry points, dependencies, dev commands, and constraints.
- Public TypeScript exports and SDK extension points get TSDoc when the name
  alone does not explain the contract.
- User-visible changes are added to `CHANGELOG.md`; breaking changes also get a
  migration guide.
- Do not document unimplemented features as ready — mark them "experimental" or
  "planned".
- Keep one source of truth per contract and link to it; do not copy the same
  contract into several places.

## i18n

- No hardcoded user-facing strings in UI code. All strings go through i18next
  namespaces.
- Format plurals, dates, numbers, and units with `Intl`, not by string
  concatenation.
- Language switches without a page reload; update `lang` and `dir` on `<html>`.
- Support RTL layouts.
- Plugins and themes use isolated namespaces so they cannot collide with the
  app.
- The backend returns error codes; the frontend localizes them.
- Add pseudo-locale checks for new screens and verify interfaces with long
  translations.

## Performance Targets

Do not regress these targets without an explicit decision:

| Target                                             | Budget        |
| -------------------------------------------------- | ------------- |
| Start to ready UI (reference PC)                   | 4 s           |
| Backend idle memory                                | 180 MB        |
| First page of 100,000 characters                   | 300 ms        |
| Open a 10,000-message chat to the latest messages  | 700 ms        |
| Streaming UI updates                               | 30 per second |
| Initial frontend bundle (gzip, before lazy chunks) | 2 MB          |

Measure before and after optimization. Do not add a cache without an
invalidation strategy.

## Testing

Every change adds a test at the appropriate level: Vitest unit tests, Fastify
`inject()` integration tests, Playwright end-to-end tests, visual regression
for themes and shell layouts, accessibility tests, migration tests, plugin
contract tests, and the legacy compatibility suite. Cover error and corrupt
inputs, request cancellation, re-import, migrations and rollback, backup
restore, cache cleanup, plugin disable, safe mode, large catalogs and long
chats, context shifting at the token budget boundary, instruct-format
rendering, and thumbnail generation and invalidation.

## Definition of Done

Before you push: `pnpm format`, `pnpm lint` with zero warnings, `pnpm typecheck`,
`pnpm test`, and `pnpm test:e2e` for UI changes. Confirm that related docs,
examples, and migration guides are updated and that documentation links resolve.
