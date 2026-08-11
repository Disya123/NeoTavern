---
title: Daten & Speicherung
description: >-
  Überblick über die Datenschicht: die SQLite-Datenbank, die
  Dateisystemstruktur für Originale und Cache sowie das Backup-Modell.
sidebar_position: 1
---

Dieser Abschnitt erklärt, wie NeoTavern Daten speichert: die
SQLite-Datenbank, die Dateisystemstruktur für Originale und Cache sowie
das Backup-Modell.

## Datenverzeichnis

Alle Benutzerdaten liegen in einem lokalen Datenverzeichnis:

```text
data/
  app.db
  files/{avatars,backgrounds,attachments,audio,generated}/
  plugins/  themes/  cache/thumbnails/  backups/  logs/
```

## Seiten in diesem Abschnitt

- [SQLite-Speicherung](data/sqlite) — Pragmas, STRICT-Tabellen, FTS5-Suche,
  stabile UUIDv7-IDs und Migrationen.
- [Dateien und Bilder](data/files-and-images) — wie Originale und regenerierbare
  Thumbnails gespeichert und atomar geschrieben werden.
- [Backups](data/backups) — das Backup-Modell, die Wiederherstellung und was
  Backups abdecken.

## Verwandte Abschnitte

- Der Abschnitt [Architektur](architecture/) erklärt, wo die
  Datenschicht im Monorepo sitzt.
- Für die benutzerorientierte Sicht siehe Daten und Backups im
  [Benutzerhandbuch](../user-guide/data-and-backups).
