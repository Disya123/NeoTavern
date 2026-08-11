# @neotavern/db

Data layer: SQLite (better-sqlite3) + Drizzle ORM. Schema, transactional
migrations, repositories with cursor pagination and FTS5 search.

## Public API

- `createAppDatabase(path, options?)` → `AppDatabase` (sqlite + drizzle + repos +
  `close`/`backup`/live `restore`). Migrations are applied automatically.
- `openDatabase()`, `runMigrations()`, schema (`schema`), `migrations`.
- Repositories: `CharacterRepository`, `ChatRepository`, `MessageRepository`,
  `PersonaRepository`, `SettingsRepository`, `ProviderConfigRepository`,
  `SearchRepository` (FTS5, `rebuild()`).
- Cursors: `encodeCursor`/`decodeCursor` (keyset pagination).

## SQLite settings

`foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout`, `synchronous=NORMAL`,
STRICT tables, FTS5 (`unicode61`) with synchronization triggers.

## Dependencies

- `better-sqlite3`, `drizzle-orm`, `@neotavern/shared`, `@neotavern/contracts`.

## Commands

```bash
pnpm --filter @neotavern/db build
pnpm --filter @neotavern/db db:migrate   # manually apply migrations
pnpm exec vitest run packages/db   # integration tests (in-memory)
```

## Constraints

Plugins are not given a direct SQLite connection (AGENTS.md §11). Images/audio
are not stored as BLOBs. See [docs/data](../../docs/data/README.md).
