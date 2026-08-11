---
title: Upgrading
description: How NeoTavern updates work and why your data stays safe during an upgrade.
sidebar_position: 4
---

This page explains how NeoTavern updates are delivered, what happens to your
data during an upgrade, and where to read about what changed.

## How Updates Work

NeoTavern treats the core app, plugins, and themes as separate units, and
each updates independently:

- **Core updates** replace the application itself, keeping your data
  directory untouched.
- **Plugin and theme updates** happen through their respective managers in
  the app and never activate automatically without your review.
- Every install is atomic: the new version replaces the old one in a single
  step, and the previous version is kept so a failed update can roll back.
- Package integrity is verified by checksum, and the official catalog may
  add signatures on top of that.

You never need Git, npm, or a terminal to update. If you installed the app
normally, you update it the same way you installed it.

## Data Safety During Upgrades

- Updates never modify your user files directly: characters, chats,
  lorebooks, personas, and settings are not touched by the installer.
- When an update includes a database schema migration, a backup is created
  before the migration runs, and migrations are transactional and
  idempotent.
- Your SQLite database runs in WAL mode, so the app stays usable and your
  writes remain durable while a migration or upgrade happens.
- If a plugin or theme update fails, the app keeps the previous version
  working instead of leaving a half-installed package.

## Checking What Changed

The [changelog](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md)
lists every change with its impact. Before upgrading, skim the newest
entries: breaking changes come with a migration guide, and features that are
still experimental or planned are marked explicitly.

## Updating Plugins and Themes

Open the Plugins and Themes section. Each installed item shows its version,
status, and whether an update is available. If an update requests new
permissions, the app asks for your explicit consent again before it applies
them — permissions are never silently extended by an update.

## Rolling Back

Because the previous version is retained during core updates, you can
reinstall it if a new release misbehaves. Your data directory is
backward-readable, and a backup created before any risky migration lets you
restore a known-good state from the UI. See
[Data & Backups](../user-guide/data-and-backups).
