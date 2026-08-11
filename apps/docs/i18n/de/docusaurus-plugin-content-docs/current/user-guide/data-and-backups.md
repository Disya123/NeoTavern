---
title: Daten & Backups
description: Wo NeoTavern Ihre Daten speichert, wie Sie exportieren und importieren und wie Backups funktionieren.
sidebar_position: 10
---

Diese Seite erklärt, wo Ihre Daten liegen, was das Datenverzeichnis enthält
und wie Sie Ihre Bibliothek exportieren, importieren und sichern.

## Das Datenverzeichnis

Alle Benutzerdaten liegen in einem Datenverzeichnis, das beim ersten Start
erstellt wird. Seine genaue Position wird unter Einstellungen → Daten
angezeigt; Sie können den Server mit der Umgebungsvariablen `NEOTA_DATA_DIR`
auf einen anderen Speicherort verweisen. Die Struktur:

- `app.db` — die SQLite-Datenbank: Charaktere, Chats, Nachrichten,
  Lorebooks, Gedächtniseinträge, Personas, Presets und Einstellungen. Sie
  läuft im WAL-Modus mit aktivierten Fremdschlüsseln und
  Volltextsuche für Charaktere, Chats und Nachrichten.
- `files/` — originale Benutzerdateien: Avatare, Hintergründe, Anhänge,
  Audio und generierte Bilder. Das sind nie abgeleitete Daten.
- `cache/` — regenerierbare Daten: Thumbnails, Tokenizer-Daten und
  Plugin-Downloads. Das Leeren eines Caches berührt nie Ihre Originale.
- `backups/` — Backup-Archive, die Sie über die Oberfläche erstellen.
- `logs/` — redigierte Server-Logs.
- `plugins/` und `themes/` — installierte Pakete, jeweils auf ihr eigenes
  Verzeichnis beschränkt.

## Was gespeichert wird

Charaktere und ihre Karten, Chats mit vollständigem Nachrichtenverlauf und
Swipe-Varianten, Lorebooks, Gedächtniseinträge, Personas,
Generierungs-Presets, Verbindungsprofile, Themes, Plugins und Ihre
Einstellungen. API-Schlüssel werden lokal in einer verschlüsselten
Schlüsselverwaltung gespeichert und nie in Logs, Browser-Speicher oder
Diagnose-Exporte geschrieben.

## Export und Import

- **Charakterkarten** werden als PNG oder JSON exportiert, und Chats werden
  als Archive exportiert, die Sie aufbewahren oder auf einen anderen Rechner
  mitnehmen können. Siehe [Charaktere](characters).
- Die **SillyTavern-Migration** liegt unter Einstellungen → Daten: Wählen
  Sie ein vollständiges Datenbackup-ZIP, und die App führt zuerst eine
  schreibgeschützte Analyse durch, die Objekte, verschachtelte Datensätze,
  Beschädigungen, Größe und Konflikte pro Kategorie meldet — Charaktere,
  Chats, Personas, Lorebooks und Presets. Es wird nichts geschrieben, bevor
  Sie den Bericht prüfen und bestätigen. Sie wählen dann die Kategorien und
  eine explizite Konfliktrichtlinie (vorhandene behalten, Kopien erstellen,
  sicher zusammenführen oder aus dem Archiv ersetzen). Geheimnisse, Plugins,
  Themes und nicht unterstützte Kategorien werden als übersprungen
  aufgelistet, und ein wiederholter Import erzeugt nie Duplikate.

## Backups

Backups werden vollständig über die Oberfläche in Einstellungen → Daten
erstellt und wiederhergestellt:

- **Backup erstellen** können Sie jederzeit; das Erstellen blockiert das
  Lesen Ihrer Daten nicht.
- Der Backup-Bildschirm zeigt Datum, Größe, Schema-Version, Quelle und
  Zustand.
- **Wiederherstellen** fragt nach Bestätigung, erstellt zuerst ein
  Schutz-Backup des aktuellen Zustands und teilt Ihnen mit, dass die App
  danach neu gestartet werden muss.
- Die Wiederherstellung wird erst nach erfolgreicher Integritätsprüfung als
  erfolgreich gemeldet; bei einem Fehlschlag bietet die App eine
  automatische Rückkehr zur Schutzkopie an.

Vor jeder gefährlichen Schema-Migration erstellt die App von sich aus ein
Backup. Zusammen mit der WAL-Datenbank bedeutet das, dass ein Update oder
eine Wiederherstellung immer über einen bekannten, funktionierenden
Fallback verfügt. Siehe [Updates](../getting-started/upgrading).
