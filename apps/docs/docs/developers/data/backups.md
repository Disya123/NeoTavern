---
title: Backups
description: >-
  The backup model: online SQLite snapshots, safe restore with a safety
  backup, and what backups cover.
sidebar_position: 4
---

Backups are online SQLite snapshots created through the SQLite Backup API,
safe to run with WAL, and restorable without external tools.

## Backup Model

A backup is a consistent snapshot of the SQLite database, created while the
server is running:

- `POST /api/v2/backups` creates the snapshot through the SQLite Backup API,
  which is safe with WAL and does not block readers.
- `GET /api/v2/backups` lists existing backups; cache contents and logs are
  not included.

Each backup record shows its date, size, schema version, source, and state.
The UI shows the same information, and creating a backup never interrupts
reading local data.

## What Backups Cover

A backup covers the entire structured database: characters, personas, chats
and messages, lorebooks, presets, provider configurations, plugin state, and
settings. It does not include:

- `cache/thumbnails/` — regenerable, and excluded by design;
- logs — excluded by design;
- import staging directories — temporary by design.

Originals in `files/` are content-addressed and never touched by cache
maintenance, so they are not part of the snapshot itself.

## Restore

`POST /api/v2/backups/:id/restore` follows a safe sequence:

1. Create and rotate a **safety backup** of the current state.
2. Validate the selected snapshot with `PRAGMA quick_check`.
3. Copy it into the live database through the SQLite Online Backup API.

The connection and repositories stay open: the response carries
`restartRequired: false`, and subsequent reads and writes keep working
without a restart. Restore never requires external SQLite tools. A failed
snapshot or copy returns `RESTORE_FAILED`, and the safety backup is
retained, so the current state is never lost in a failed restore.

In the UI, restore requires explicit confirmation, is never reported as
successful before the integrity check passes, and offers automatic return
to the safety copy if something goes wrong. Deleting a backup warns you if
it is the last working copy.

## Backups as a Safety Net

The same snapshot mechanics guard dangerous operations:

- The migration runner creates a pre-migration backup for populated
  databases before migrations that rebuild or reshape tables.
- Import execution creates a safety backup before writing any selected
  data, so a failed or interrupted import can always be rolled back.
- Restore always snapshots the current state first, as described above.

## See Also

- [SQLite Storage](sqlite) for the database itself.
- [Files and Images](files-and-images) for what lives outside the database.
- The user-facing flow is documented in the
  [User Guide](../../user-guide/data-and-backups).
