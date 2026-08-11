---
title: Backups
description: >-
  Das Backup-Modell: Online-SQLite-Snapshots, sichere Wiederherstellung mit
  Sicherungs-Backup und was Backups abdecken.
sidebar_position: 4
---

Backups sind Online-SQLite-Snapshots, die über die SQLite-Backup-API
erstellt werden, mit WAL sicher ausführbar und ohne externe Werkzeuge
wiederherstellbar.

## Backup-Modell

Ein Backup ist ein konsistenter Snapshot der SQLite-Datenbank, erstellt
während der Server läuft:

- `POST /api/v2/backups` erstellt den Snapshot über die
  SQLite-Backup-API, die mit WAL sicher ist und Leser nicht blockiert.
- `GET /api/v2/backups` listet vorhandene Backups auf; Cache-Inhalte und
  Logs sind nicht enthalten.

Jeder Backup-Datensatz zeigt Datum, Größe, Schema-Version, Quelle und
Zustand. Die Oberfläche zeigt dieselben Informationen, und das Erstellen
eines Backups unterbricht nie das Lesen lokaler Daten.

## Was Backups abdecken

Ein Backup deckt die gesamte strukturierte Datenbank ab: Charaktere,
Personas, Chats und Nachrichten, Lorebooks, Presets,
Anbieterkonfigurationen, Plugin-Zustand und Einstellungen. Nicht enthalten
sind:

- `cache/thumbnails/` — regenerierbar und per Design ausgeschlossen;
- Logs — per Design ausgeschlossen;
- Import-Staging-Verzeichnisse — per Design temporär.

Originale in `files/` sind inhaltsadressiert und werden nie von der
Cache-Wartung berührt, sodass sie nicht Teil des Snapshots selbst sind.

## Wiederherstellung

`POST /api/v2/backups/:id/restore` folgt einer sicheren Sequenz:

1. Ein **Sicherungs-Backup** des aktuellen Zustands erstellen und rotieren.
2. Den ausgewählten Snapshot mit `PRAGMA quick_check` validieren.
3. Ihn über die SQLite-Online-Backup-API in die Live-Datenbank kopieren.

Verbindung und Repositories bleiben offen: Die Antwort trägt
`restartRequired: false`, und nachfolgende Lese- und Schreibvorgänge
funktionieren ohne Neustart weiter. Die Wiederherstellung erfordert nie
externe SQLite-Werkzeuge. Ein fehlgeschlagener Snapshot oder Kopiervorgang
gibt `RESTORE_FAILED` zurück, und das Sicherungs-Backup bleibt erhalten,
sodass der aktuelle Zustand bei einer fehlgeschlagenen Wiederherstellung
nie verloren geht.

In der Oberfläche erfordert die Wiederherstellung eine explizite
Bestätigung, wird nie vor bestandener Integritätsprüfung als erfolgreich
gemeldet und bietet bei einem Problem die automatische Rückkehr zur
Sicherungskopie an. Das Löschen eines Backups warnt Sie, wenn es die letzte
funktionierende Kopie ist.

## Backups als Sicherheitsnetz

Dieselbe Snapshot-Mechanik schützt gefährliche Vorgänge:

- Der Migrations-Runner erstellt für befüllte Datenbanken vor Migrationen,
  die Tabellen neu aufbauen oder umformen, ein Pre-Migrations-Backup.
- Die Importausführung erstellt vor dem Schreiben ausgewählter Daten ein
  Sicherungs-Backup, sodass ein fehlgeschlagener oder unterbrochener
  Import immer zurückgerollt werden kann.
- Die Wiederherstellung snapshotet den aktuellen Zustand immer zuerst, wie
  oben beschrieben.

## Siehe auch

- [SQLite-Speicherung](sqlite) für die Datenbank selbst.
- [Dateien und Bilder](files-and-images) für das, was außerhalb der
  Datenbank lebt.
- Der benutzerorientierte Ablauf ist im
  [Benutzerhandbuch](../../user-guide/data-and-backups) dokumentiert.
