---
title: Code-Richtlinien
description: Die Regeln, die jeder NeoTavern-Codebeitrag befolgen muss
sidebar_position: 3
---

NeoTavern-Codebeiträge folgen einer gemeinsamen Reihe von Regeln: striktes
TypeScript, ein expliziter Fehlervertrag, Dokumentation als Teil der
Änderung und messbare Leistungsziele.

## TypeScript

- Der strikte Modus ist für allen Code aktiviert; lassen Sie ihn an.
- Ungerechtfertigtes `any`, `@ts-ignore`, Non-Null-Assertions und
  `as unknown as`-Casts sind verboten.
- An Systemgrenzen — Parsen, Anfragen, Dateien, Plugin-Eingabe — verwenden
  Sie `unknown` und validieren Sie explizit, bevor Sie den Daten vertrauen.
- Öffentliche Schnittstellen exponieren exportierte Typen. Duplizieren Sie
  Backend- und Frontend-Typen nie von Hand: Geteilte API-Typen liegen in
  `packages/contracts` und werden von dort importiert.
- Verwenden Sie durchgängig ESM.
- Bevorzugen Sie kleine Funktionen mit expliziten Ein- und Ausgaben
  gegenüber großen, zustandsbehafteten.

## API-Fehler

Jeder API-Fehler verwendet einen stabilen, maschinenlesbaren Envelope:

```json
{
  "code": "CHARACTER_NOT_FOUND",
  "params": { "characterId": "0193..." },
  "traceId": "01J4..."
}
```

- `code` ist ein stabiler, maschinenlesbarer Fehleridentifier — ändern Sie
  ihn nicht, sobald er ausgeliefert ist.
- `params` trägt strukturierten Kontext, auf den ein Client oder Plugin
  reagieren kann.
- `traceId` korreliert den Fehler mit Server-Logs.
- Benutzersichtbarer Text wird nie im Backend zusammengesetzt: Das
  Frontend lokalisiert Code und Params in UI-Text.

## Dokumentation ist Teil der Implementierung

Dokumentation ist Teil der Implementierung, kein Anhängsel nach dem Code.
Jede Änderung, die Benutzer- oder Entwicklerverhalten betrifft,
aktualisiert die relevanten Dateien in `docs/` in derselben Änderung.
Das ist Pflicht für:

- Architektur und Paketgrenzen;
- REST-API, SSE, WebSocket und Vertragsschemata;
- Plugin SDK, Theme SDK und die Legacy-Kompatibilitätsebene;
- Berechtigungen, Sandboxing und das Sicherheitsmodell;
- SQLite-Schema, Migrationen, Backup und Wiederherstellung;
- Import, Export, Dateien und den Thumbnail-Cache;
- Prompt-Pipeline, Instruct-Formate, Tokenisierung und Kontext-Shifting;
- Anbieter-Adapter;
- Desktop-Paketierung, den Tauri-Sidecar, PWA und Updates;
- Benutzereinstellungen, i18n und Barrierefreiheit;
- Breaking Changes, Deprecations und Migrationsleitfäden.

Zusätzliche Regeln:

- Jede neue `app` oder jedes neue `package` bringt eine `README.md` mit,
  die Zweck, öffentliche Einstiegspunkte, Abhängigkeiten, Dev-Befehle und
  Einschränkungen abdeckt.
- Öffentliche TypeScript-Exporte und SDK-Erweiterungspunkte erhalten TSDoc,
  wenn der Name allein den Vertrag nicht erklärt.
- Benutzersichtbare Änderungen werden zu `CHANGELOG.md` hinzugefügt;
  Breaking Changes erhalten zusätzlich einen Migrationsleitfaden.
- Dokumentieren Sie nicht implementierte Funktionen nicht als fertig —
  markieren Sie sie als „experimentell" oder „geplant".
- Halten Sie eine Quelle der Wahrheit pro Vertrag und verlinken Sie darauf;
  kopieren Sie denselben Vertrag nicht an mehrere Stellen.

## i18n

- Keine festkodierten benutzersichtbaren Zeichenketten im UI-Code. Alle
  Zeichenketten laufen über i18next-Namespaces.
- Formatieren Sie Pluralformen, Daten, Zahlen und Einheiten mit `Intl`,
  nicht durch Zeichenkettenverkettung.
- Sprachwechsel ohne Seitenneuladung; aktualisieren Sie `lang` und `dir`
  auf `<html>`.
- Unterstützen Sie RTL-Layouts.
- Plugins und Themes verwenden isolierte Namespaces, damit sie nicht mit
  der App kollidieren können.
- Das Backend gibt Fehlercodes zurück; das Frontend lokalisiert sie.
- Fügen Sie für neue Bildschirme Pseudo-Locale-Prüfungen hinzu und
  verifizieren Sie Oberflächen mit langen Übersetzungen.

## Leistungsziele

Überschreiten Sie diese Ziele nicht ohne eine explizite Entscheidung:

| Ziel                                                         | Budget         |
| ------------------------------------------------------------ | -------------- |
| Start bis einsatzbereite Oberfläche (Referenz-PC)            | 4 s            |
| Backend-Arbeitsspeicher im Leerlauf                          | 180 MB         |
| Erste Seite von 100.000 Charakteren                          | 300 ms         |
| Einen Chat mit 10.000 Nachrichten bis zu den neuesten öffnen | 700 ms         |
| Streaming-UI-Updates                                         | 30 pro Sekunde |
| Initiales Frontend-Bundle (gzip, vor Lazy-Chunks)            | 2 MB           |

Messen Sie vor und nach der Optimierung. Fügen Sie keinen Cache ohne
Invalidierungsstrategie hinzu.

## Testen

Jede Änderung fügt einen Test auf der passenden Ebene hinzu:
Vitest-Unit-Tests, Fastify-`inject()`-Integrationstests,
Playwright-End-to-End-Tests, visuelle Regression für Themes und
Shell-Layouts, Barrierefreiheitstests, Migrationstests,
Plugin-Vertragstests und die Legacy-Kompatibilitätssuite. Decken Sie
Fehler- und beschädigte Eingaben, Anfrageabbruch, Re-Import, Migrationen
und Rollback, Backup-Wiederherstellung, Cache-Bereinigung, Plugin-
Deaktivierung, Sicherer Modus, große Kataloge und lange Chats,
Kontext-Shifting an der Token-Budget-Grenze, Instruct-Format-Rendering
sowie Thumbnail-Generierung und -Invalidierung ab.

## Abschlusskriterien

Vor dem Pushen: `pnpm format`, `pnpm lint` mit null Warnungen,
`pnpm typecheck`, `pnpm test` und `pnpm test:e2e` für UI-Änderungen.
Bestätigen Sie, dass verwandte Dokumente, Beispiele und
Migrationsleitfäden aktualisiert sind und Dokumentationslinks auflösen.
