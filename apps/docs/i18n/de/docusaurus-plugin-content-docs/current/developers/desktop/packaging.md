---
title: Paketierung
description: Distributionsformate für Windows, macOS und Linux sowie das Erststart-Erlebnis.
sidebar_position: 4
---

NeoTavern wird als native Pakete pro Plattform verteilt, die jeweils den
Node.js-Sidecar, SQLite, native Addons und die Produktions-Web-Assets
enthalten.

## Distributionsformate

Der Desktop-Build erzeugt:

- **Windows-Installer** — NSIS- und MSI-Installer mit
  Pro-Benutzer-Installationsmodus. Der Installer registriert die App und
  legt Benutzerdaten im applokalen Datenverzeichnis der Plattform ab.
- **Windows-Portable-Build** — ein ZIP mit der Binärdatei, dem Sidecar,
  einer `portable.flag`-Markierung und `resources/`, plus einer
  `.sha256`-Prüfsummendatei. Bei vorhandenem Flag liegen die Daten in
  einem lokalen `data/`-Ordner neben der Anwendung statt im
  applokalen Datenverzeichnis.
- **macOS-Paket** — ein `.app`-Bundle, auf dem macOS-Runner in ein DMG
  verpackt.
- **Linux** — ein AppImage und ein Archiv.

Jedes Format wird auf seinem eigenen nativen Plattform-Runner gebaut und
smoke-getestet, weil die Distribution native Addons bündelt. Das
plattformübergreifende Kopieren vorbereiteter Artefakte wird nicht
unterstützt.

## Was im Paket steckt

Jedes Paket enthält alles, was die App zur Laufzeit braucht:

- Die Tauri-2-Shell.
- Die eigenständige Node.js-24-Sidecar-Binärdatei.
- SQLite über `better-sqlite3`.
- Sharp für die Bildverarbeitung.
- Die Produktions-Web-Assets.

Da Node.js, SQLite und die Assets im Paket sind, muss der Benutzer nichts
vorher installiert haben — kein Node.js, kein npm, keine
Datenbankeinrichtung.

## Erststart

Der erste Start ist das Kernversprechen des Produkts: App öffnen, und sie
funktioniert.

1. Die Shell startet den Sidecar.
2. Das Backend erstellt das Datenverzeichnis, initialisiert die
   SQLite-Datenbank, führt ausstehende Migrationen aus (mit Backup vor
   ausstehenden Schemaänderungen) und legt gebündelte Themes und den
   Startcharakter an.
3. Die WebView öffnet sich zur einsatzbereiten Anwendung.

Es gibt kein Terminal, keinen Installationsassistenten über den der
Plattform hinaus, kein `npm install` und keine manuelle Konfiguration.
Wenn der Benutzer einen Chat-Hintergrund gewählt oder Plugins installiert
hat, lebt nichts davon in der Binärdatei — Benutzerdaten sind vom Bundle
getrennt, sodass Updates den Kern ersetzen, ohne Benutzerdateien zu
berühren.

## Updates

Release-Builds signieren ihre Artefakte und integrieren den
Tauri-Updater. Der Updater verifiziert das Manifest und eine
Minisign-Signatur, bevor er ein Plattform-Artefakt installiert, und
startet dann die Shell neu. Rollback bedeutet, die vorherige geprüfte
Version als neues signiertes Release zu veröffentlichen — unsignierte
Downgrades sind nicht erlaubt. Plugins und Themes aktualisieren sich
unabhängig über die Plugin- und Theme-Verwaltung; Benutzerdateien gelangen
nie in ein Update-Artefakt der Binärdatei.

## Bauen

Aus dem Repository lauten die Paketierungsbefehle:

```bash
pnpm desktop:prepare
pnpm desktop:build
pnpm desktop:portable
pnpm desktop:release
```

`desktop:prepare` baut Server und Web, kopiert zielspezifische native
Addons und erstellt den Sidecar mit dem Tauri-Ziel-Triple-Suffix.
`desktop:portable` baut zusätzlich die NSIS-/MSI-Installer und das
portable ZIP mit Prüfsumme und führt dann einen headless
Shell-Smoke-Test aus. `desktop:release` erzeugt signierte
Updater-Artefakte und erfordert die Release-Geheimnisse. Das Bauen der
Installer erfordert Rust stable MSVC, Windows C++ Build Tools und WebView2
auf dem Build-Rechner — nichts davon brauchen Endbenutzer.
