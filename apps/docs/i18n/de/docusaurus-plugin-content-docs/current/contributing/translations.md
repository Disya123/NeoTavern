---
title: Übersetzungen
description: Eine Übersetzung der NeoTavern-Dokumentations-Site beitragen oder eine vorhandene verbessern
sidebar_position: 5
---

Die Dokumentations-Site erscheint auf Englisch plus acht Sprachen, und jede
Übersetzung ist ein Community-Beitrag. Diese Seite erklärt, wie Sie eine
beitragen oder eine vorhandene korrigieren.

## Aktuelle Sprachen

Die Basissprache ist Englisch. Die übersetzten Sprachen sind Russisch
(`ru`), vereinfachtes Chinesisch (`zh-Hans`), Japanisch (`ja`), Koreanisch
(`ko`), Spanisch (`es`), Französisch (`fr`), Deutsch (`de`) und
brasilianisches Portugiesisch (`pt-BR`).

## Wo Übersetzungen liegen

Jede Sprache spiegelt den englischen Baum unter `apps/docs/i18n/`:

```
apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/<path>.md
```

UI-Zeichenketten — Navigationsleiste, Fußzeile, Tagline und
Seitenleisten-Labels — liegen in JSON-Dateien unter
`apps/docs/i18n/<locale>/docusaurus-theme-classic/`, generiert vom
write-translations-Befehl.

## Vollständigkeit

Jede englische Seite sollte ein übersetztes Gegenstück am selben relativen
Pfad haben. Nicht übersetzte Seiten fallen automatisch auf Englisch zurück,
sodass partielle Fortschritte sofort sichtbar sind — aber zielen Sie auf
vollständige Abdeckung und reichen Sie nie halb übersetzte Dateien ein.

## Was zu übersetzen ist

- Überschriften, Fließtext, Bildunterschriften und Alt-Text.
- Die Front-Matter-`title` und `description`; halten Sie
  `sidebar_position` identisch.
- `_category_.json`-Labels.

## Was unangetastet bleibt

- Links, Code-Fences, Inline-Code und Admonition-Syntax
  (`:::note` ... `:::`) Byte für Byte.
- Der Produktname: NeoTavern wird nie übersetzt.
- API-Identifier, Dateinamen, Befehle und Flags bleiben in ihrer
  englischen Form.

## Terminologie

Verwenden Sie die Formulierung der App-Oberfläche, wo sie existiert;
andernfalls den Standard-Community-Begriff in Ihrer Sprache. Wo ein
Standard-Community-Begriff bereits existiert, bevorzugen Sie ihn — erfinden
Sie nie ein neues Wort.

## Eine Übersetzung korrigieren

Bearbeiten Sie die Datei für Ihre Sprache am selben relativen Pfad und
öffnen Sie einen Pull-Request. Wenn sich die englische Quelle einer Seite
ändert, aktualisieren Sie die Übersetzung dieser Seite in derselben
Änderung.

## Eine neue Sprache hinzufügen

1. Fügen Sie den Sprachcode und sein Anzeige-Label zu `i18n.locales` und
   `localeConfigs` in `apps/docs/docusaurus.config.ts` hinzu.
2. Richten Sie den Sprachordner ein:

   ```bash
   pnpm docs:translations -- --locale <code>
   ```

3. Übersetzen Sie jede Seite unter
   `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/` und
   die generierten JSON-Dateien.
4. Öffnen Sie einen Pull-Request, der sowohl die Konfigurationsänderung
   als auch die neuen Dateien enthält.

Sprachcodes folgen Standardkonventionen, zum Beispiel `zh-Hans` für
vereinfachtes Chinesisch und `pt-BR` für brasilianisches Portugiesisch.
