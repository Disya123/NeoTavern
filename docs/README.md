# NeoTavern — documentation

Index of the internal documentation. Each major topic has its own folder.

## Sections

- [Architecture](architecture/README.md) — package boundaries, data flow, stack.
- [UX spec](ux/README.md) — user scenarios, states, accessibility, and
  acceptance criteria.
- [API](api/README.md) — REST `/api/v2`, SSE generation, error envelope.
- [Plugin SDK](plugin-sdk/README.md) — manifest, permissions, frontend/backend API, cleanup.
- [Theme SDK](theme-sdk/README.md) — tokens, skins, shells, safe mode, `data-*` hooks.
- [Prompt pipeline](prompt-pipeline/README.md) — stages, instruct formats, context shifting.
- [Data and SQLite](data/README.md) — schema, WAL/FTS5, files, cache.
- [Desktop](desktop/README.md) — Tauri 2 + Node sidecar, PWA, updates.
- [Migrations](migrations/README.md) — schema version, backup, rollback.
- [ADR](adr/README.md) — architectural decisions.
- [Changelog](../CHANGELOG.md).

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # run server + web (dev)
pnpm build            # tsc -b + vite build
pnpm typecheck        # type-check the whole monorepo
pnpm lint             # ESLint
pnpm format           # Prettier
pnpm test             # Vitest (backend + frontend)
pnpm docs:check       # check mandatory documents and links
pnpm docs:build       # index docs/
```
