---
title: Data & Storage
description: >-
  Overview of the data layer: the SQLite database, the file system layout
  for originals and cache, and the backup model.
sidebar_position: 1
---

This section explains how NeoTavern stores data: the SQLite database, the
file system layout for originals and cache, and the backup model.

## Data Directory

All user data lives in one local data directory:

```text
data/
  app.db
  files/{avatars,backgrounds,attachments,audio,generated}/
  plugins/  themes/  cache/thumbnails/  backups/  logs/
```

## Pages in This Section

- [SQLite Storage](data/sqlite) — pragmas, STRICT tables, FTS5 search, stable
  UUIDv7 IDs, and migrations.
- [Files and Images](data/files-and-images) — how originals and regenerable
  thumbnails are stored and written atomically.
- [Backups](data/backups) — the backup model, restore, and what backups cover.

## Related Sections

- The [Architecture](architecture/) section explains where the data
  layer sits in the monorepo.
- For the user-facing view, see Data and Backups in the
  [User Guide](../../user-guide/data-and-backups).
