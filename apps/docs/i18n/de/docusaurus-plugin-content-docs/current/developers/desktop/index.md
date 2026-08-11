---
title: Desktop-Übersicht
description: Wie die Desktop-App ausgeliefert wird — eine Tauri-2-Shell mit eingebettetem Node.js-Sidecar.
sidebar_position: 1
---

Die Desktop-App ist eine native Distribution von NeoTavern: eine
Tauri-2-Shell, die das Fastify-Backend als eingebetteten Node.js-Sidecar
ausführt.

## Eine App, keine Einrichtung

Die Desktop-Distribution ist in sich geschlossen. Node.js, SQLite und die
Produktions-Web-Assets werden im Paket mitgeliefert, sodass der Erststart
kein Terminal, kein Git, kein npm und keine manuelle Datenbankeinrichtung
erfordert. Sie installieren die App, starten sie, und die WebView öffnet
sich, sobald die lokale API bereit ist.

Die Laufzeitteile sind:

- **Tauri-2-Shell** — das native Fenster und der Anwendungslebenszyklus.
- **Node.js-Sidecar** — eine eigenständige Node.js-24-Binärdatei, die das
  Fastify-Backend lokal auf `127.0.0.1` ausführt.
- **SQLite** — die lokale Datenbank, beim ersten Start automatisch im
  Datenverzeichnis erstellt.

## Unterstützte Formate

Der Desktop-Build zielt auf die Formate, die die meisten Benutzer erwarten:

- Windows-Installer (NSIS und MSI).
- Windows-Portable-Build (ein ZIP mit einem Portable-Flag).
- macOS-Paket (`.app`, plus DMG).
- Linux-AppImage und ein Archiv.

Jedes Format wird auf seinem nativen Plattform-Runner erzeugt, weil die
Distribution native Addons wie `better-sqlite3` und Sharp bündelt.
Formatdetails und Erststart-Verhalten finden Sie unter
[Paketierung](packaging.md).

## Lebenszyklus-Garantien

Die Shell und der Sidecar sind eine Einheit. Das Schließen des Fensters
fährt das Backend herunter — die App hinterlässt nie einen verwaisten
Node.js-Prozess. Ein unerwarteter Backend-Austritt beendet die Shell mit
einem Fehler statt mit einem stillschweigend defekten Fenster. Die
Mechanik finden Sie unter [Tauri-Shell](tauri-shell.md) und
[Node-Sidecar](node-sidecar.md).

## Datenspeicherort

Installierte Builds speichern Benutzerdaten im applokalen
Datenverzeichnis der Plattform, nie im Bundle. Der Portable-Build ist die
Ausnahme: Wenn das Portable-Flag vorhanden ist, liegen die Daten in einem
lokalen `data/`-Ordner neben der Anwendung. Die Datenverwaltung selbst
wird im Abschnitt [Daten und Speicherung](../data/index.md) behandelt.

## Nächste Schritte

- [Tauri-Shell](tauri-shell.md) — das native Fenster und sein Lebenszyklus.
- [Node-Sidecar](node-sidecar.md) — der eingebettete Backend-Prozess.
- [Paketierung](packaging.md) — Distributionsformate und Erststart.
