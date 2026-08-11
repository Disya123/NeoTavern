---
title: SQLite-Speicherung
description: >-
  Die SQLite-Datenbankeinstellungen, STRICT-Tabellen, FTS5-Suche, stabile
  UUIDv7-IDs, versionierte Migrationen und Plugin-Isolierung.
sidebar_position: 2
---

NeoTavern speichert alle strukturierten Daten in einer einzigen
SQLite-Datenbank mit strikten Pragmas, STRICT-Tabellen, FTS5-Suche und
versionierten Migrationen.

## Datenbankeinstellungen

Die Verbindung wird mit den folgenden Einstellungen geöffnet:

- `foreign_keys = ON` — referenzielle Integrität wird erzwungen.
- WAL-Journalmodus — Leser werden nie von Schreibern blockiert.
- `busy_timeout` — gleichzeitige Schreiber warten, statt sofort zu
  scheitern.
- `synchronous = NORMAL` — Dauerhaftigkeit mit WAL-sicherer Leistung.
- Vorbereitete Anweisungen — alle Abfragen laufen über die vorbereiteten
  Anweisungen von Drizzle; keine rohe SQL-String-Interpolation.
- STRICT-Tabellen wo immer möglich — SQLite erzwingt Spaltentypen.
- FTS5 — Volltextsuche über Charaktere, Chats und Nachrichten.

## Stabile IDs

Jede Entität hat eine stabile String-ID, vorzugsweise UUIDv7. IDs sind nie
Array-Indizes. Wo ein Papierkorb benötigt wird, werden Zeilen mit
`deleted_at` soft gelöscht, statt entfernt zu werden.

## Schema-Überblick

Die Haupttabellen decken die Bibliothek und den Laufzeitzustand ab:
Charaktere, Personas, Chats, Branches, Nachrichten und
Nachrichtenvarianten, Tags, Lorebooks und Lore-Einträge, Presets,
Anbieterkonfigurationen und -geheimnisse, das Plugin-Registry mit
Einstellungen und Fähigkeitsgewährungen, das Theme-Registry,
Prompt-Kontext-Audits, Importaufträge und -artefakte sowie
Cache-Metadaten.

Zwei Muster sind für Plugin-Autoren wichtig:

- `plugin_state` speichert Plugin-eigenen Zustand getrennt vom
  Installations-Registry, mit einer `schema_version` für das
  Datenformat und einer `revision` für Compare-and-Swap.
- `provider_secrets` speichert API-Schlüssel als Schreibschutz-Werte: Nur
  eine maskierte Vorschau verlässt je das Repository.

## FTS5-Suche

Die virtuellen Tabellen `characters_fts`, `chats_fts` und `messages_fts`
betreiben die Suche, erstellt mit `unicode61` und `remove_diacritics`.
Trigger bei `INSERT`/`UPDATE`/`DELETE` halten sie transaktional synchron.
Die Suche unterstützt Präfixbegriffe (`token*`), Tag-Filter und
bm25-Relevanzranking. Ein vollständiger Neuaufbau ist unter
`POST /api/v2/search/rebuild` verfügbar.

## Migrationen

Jede Schemaänderung wird als Migration ausgeliefert:

- Migrationen sind **versioniert und idempotent** — `IF NOT EXISTS` plus
  eine strikte Version machen die erneute Ausführung sicher.
- Migrationen laufen **transaktional**; eine fehlgeschlagene Migration
  rollt als Ganzes zurück.
- Es gibt keine automatische `down`-Migration. Rollback bedeutet, das
  Pre-Migrations-Backup wiederherzustellen, das der Runner für befüllte
  Datenbanken vor gefährlichen Migrationen automatisch erstellt.
- Das Lesen von Daten löst nie versteckte destruktive Änderungen aus.

Siehe [Backups](backups), wie die Sicherheits-Backups des
Migrations-Runners funktionieren.

## Plugin-Isolierung

Plugins erhalten nie eine direkte SQLite-Verbindung. Die gesamte
Persistenz läuft über die Speicher-APIs des Plugin SDK, die die Tabellen
`plugin_storage` und `plugin_state` im Namen des Plugins verwalten. Das
hält Plugin-Daten versioniert, widerrufbar und sicher vor rohen
SQL-Unfällen. Die Speicher-API finden Sie im [Plugin SDK](../plugin-sdk/).

## Was nie in die Datenbank kommt

- Bilder und Audio werden auf der Festplatte gespeichert, nie als BLOBs in
  der Hauptdatenbank. Siehe [Dateien und Bilder](files-and-images).
- Unbekannte Charakterkartenfelder und Erweiterungsmetadaten bleiben in der
  `ext`-Spalte erhalten und überstehen Export und Import.
