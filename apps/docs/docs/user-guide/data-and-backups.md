---
title: Data & Backups
description: Where NeoTavern stores your data, how to export and import, and how backups work.
sidebar_position: 10
---

This page explains where your data lives, what the data directory contains,
and how to export, import, and back up your library.

## The Data Directory

All user data lives in one data directory, created on first run. Its exact
location is shown in Settings → Data; you can point the server at another
location with the `NEOTA_DATA_DIR` environment variable. The layout:

- `app.db` — the SQLite database: characters, chats, messages, lorebooks,
  memory entries, personas, presets, and settings. It runs in WAL mode with
  foreign keys enabled and full-text search for characters, chats, and
  messages.
- `files/` — original user files: avatars, backgrounds, attachments, audio,
  and generated images. These are never derived data.
- `cache/` — regenerable data: thumbnails, tokenizer data, and plugin
  downloads. Clearing a cache never touches your originals.
- `backups/` — backup archives you create from the UI.
- `logs/` — redacted server logs.
- `plugins/` and `themes/` — installed packages, each confined to its own
  directory.

## What Is Stored

Characters and their cards, chats with full message history and swipe
variants, lorebooks, memory entries, personas, generation presets,
connection profiles, themes, plugins, and your settings. API keys are
stored locally in an encrypted key manager and are never written to logs,
browser storage, or diagnostic exports.

## Export and Import

- **Character cards** export as PNG or JSON, and chats export as archives
  you can keep or move to another machine. See
  [Characters](characters).
- **SillyTavern migration** lives in Settings → Data: pick a full data
  backup ZIP, and the app first runs a read-only analysis that reports the
  objects, nested records, damage, size, and conflicts per category —
  characters, chats, personas, lorebooks, and presets. Nothing is written
  before you review the report and confirm. You then choose the categories
  and one explicit conflict policy (keep existing, create copies, safely
  merge, or replace from the archive). Secrets, plugins, themes, and
  unsupported categories are listed as skipped, and repeating the import
  never creates duplicates.

## Backups

Backups are created and restored entirely from the UI in Settings → Data:

- **Create** a backup any time; creating one does not block reading your
  data.
- The backup screen shows date, size, schema version, source, and state.
- **Restore** asks for confirmation, creates a protective backup of the
  current state first, and tells you the app must restart afterwards.
- Restore is only reported as successful after integrity is verified; if it
  fails, the app offers an automatic return to the protective copy.

Before any dangerous schema migration, the app creates a backup on its own.
Combined with the WAL database, that means an upgrade or a restore always
has a known-good fallback. See [Upgrading](../getting-started/upgrading).
