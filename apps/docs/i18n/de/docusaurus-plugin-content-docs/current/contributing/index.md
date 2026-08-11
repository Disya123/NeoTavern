---
title: Zu NeoTavern beitragen
description: Wie Sie zu NeoTavern beitragen — Issues, Code, Dokumentation und Übersetzungen
sidebar_position: 1
---

NeoTavern ist ein offenes Projekt, und Beiträge jeder Art sind willkommen:
Fehlerberichte, Funktionswünsche, Code, Dokumentation und Übersetzungen.

## Möglichkeiten zum Mitwirken

- **Fehler melden und Funktionen wünschen.** Öffnen Sie ein Issue auf
  GitHub mit Version, Betriebssystem und Schritten zur Reproduktion:
  [https://github.com/Disya123/NeoTavern/issues](https://github.com/Disya123/NeoTavern/issues)
- **Code schreiben.** Wählen Sie ein Issue, kommentieren Sie es und öffnen
  Sie einen Pull-Request. Halten Sie Änderungen klein und folgen Sie den
  [Code-Richtlinien](contributing/code-guidelines).
- **Dokumentation verbessern.** Die öffentliche Site liegt in `apps/docs`;
  siehe [Dokumentations-Site](contributing/docs-site).
- **Übersetzen.** Helfen Sie bei einer der acht Sprachen mit oder schlagen
  Sie eine neue vor; siehe [Übersetzungen](contributing/translations).

## Verhaltenskodex

Behandeln Sie andere Mitwirkende mit Respekt. Seien Sie konstruktiv in
Reviews und Issues, gehen Sie von gutem Willen aus und halten Sie
Diskussionen auf die Arbeit fokussiert. Die
[AGENTS.md](https://github.com/Disya123/NeoTavern/blob/main/AGENTS.md) des
Repositories ist die maßgebliche Beschreibung, wie das Projekt aufgebaut
ist und wie Aufgaben erledigt werden; lesen Sie sie vor Ihrer ersten
Änderung.

## Bevor Sie beginnen

- Lesen Sie zuerst die [Entwicklungseinrichtung](contributing/development-setup) und
  die [Code-Richtlinien](contributing/code-guidelines) sowie die oben verlinkte
  AGENTS.md.
- Suchen Sie nach einem vorhandenen Issue, das abdeckt, was Sie tun
  möchten, und kommentieren Sie vor großen Arbeiten, damit Maintainer
  früh Feedback geben können.
- Halten Sie Pull-Requests fokussiert: eine logische Änderung pro PR, mit
  Tests und Dokumentation.

## Was nach der Einreichung passiert

Maintainer prüfen die Änderung, und CI führt die Qualitätsgates aus —
Lint, Typecheck und Tests. Wenn alles grün ist, wird der Pull-Request
zusammengeführt und benutzersichtbare Änderungen landen im Changelog.
