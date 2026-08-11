---
title: SQLite Storage
description: >-
  The SQLite database settings, STRICT tables, FTS5 search, stable UUIDv7
  IDs, versioned migrations, and plugin isolation.
sidebar_position: 2
---

NeoTavern stores all structured data in a single SQLite database with strict
pragmas, STRICT tables, FTS5 search, and versioned migrations.

## Database Settings

The connection is opened with the following settings:

- `foreign_keys = ON` — referential integrity is enforced.
- WAL journal mode — readers are never blocked by writers.
- `busy_timeout` — concurrent writers wait instead of failing immediately.
- `synchronous = NORMAL` — durability with WAL-safe performance.
- Prepared statements — all queries go through Drizzle's prepared
  statements; no raw SQL string interpolation.
- STRICT tables wherever possible — SQLite enforces column types.
- FTS5 — full-text search over characters, chats, and messages.

## Stable IDs

Every entity has a stable string ID, preferably UUIDv7. IDs are never array
indexes. Where a trash can is needed, rows are soft-deleted with
`deleted_at` instead of being removed.

## Schema Overview

The main tables cover the library and runtime state: characters, personas,
chats, branches, messages and message variants, tags, lorebooks and lore
entries, presets, provider configs and secrets, the plugin registry with
settings and capability grants, the theme registry, prompt context audits,
import jobs and artifacts, and cache metadata.

Two patterns matter for plugin authors:

- `plugin_state` stores plugin-owned state separately from the install
  registry, with a `schema_version` for the data format and a `revision`
  for compare-and-swap.
- `provider_secrets` stores API keys as write-only values: only a masked
  preview ever leaves the repository.

## FTS5 Search

Virtual tables `characters_fts`, `chats_fts`, and `messages_fts` power
search, built with `unicode61` and `remove_diacritics`. Triggers on
`INSERT`/`UPDATE`/`DELETE` keep them synchronized transactionally. Search
supports prefix terms (`token*`), tag filters, and bm25 relevance ranking.
A full rebuild is available at `POST /api/v2/search/rebuild`.

## Migrations

Every schema change ships as a migration:

- Migrations are **versioned and idempotent** — `IF NOT EXISTS` plus a
  strict version make re-running safe.
- Migrations run **transactionally**; a failed migration rolls back as a
  whole.
- There is no automatic `down` migration. Rollback means restoring the
  pre-migration backup, which the runner creates automatically for
  populated databases before dangerous migrations.
- Reading data never triggers hidden destructive changes.

See [Backups](backups) for how the migration runner's safety backups work.

## Plugin Isolation

Plugins never receive a direct SQLite connection. All persistence goes
through the plugin SDK's storage APIs, which own the `plugin_storage` and
`plugin_state` tables on the plugin's behalf. This keeps plugin data
versioned, revocable, and safe from raw SQL accidents. See the
[Plugin SDK](../plugin-sdk/) for the storage API.

## What Never Goes in the Database

- Images and audio are stored on disk, never as BLOBs in the main database.
  See [Files and Images](files-and-images).
- Unknown character card fields and extension metadata are preserved in the
  `ext` column and survive export and import.
