---
title: Pakete
description: >-
  Die Verantwortung jedes Workspace-Pakets und die Abhängigkeitsrichtung,
  die das Monorepo zyklusfrei hält.
sidebar_position: 4
---

Jedes Workspace-Paket hat genau eine Verantwortung, und Abhängigkeiten
zeigen nur nach unten, was das Monorepo zyklusfrei hält.

## Abhängigkeitsrichtung

Code darf nur von Paketen „unterhalb" abhängen:

```text
apps (server, web, desktop, plugin-runtime)
  → packages
  → shared, contracts (the floor)
```

`server` und `web` hängen von Paketen ab; Pakete hängen höchstens von
`shared` und `contracts` ab. Zyklische Abhängigkeiten sind verboten. Wenn
Sie neuen Code hinzufügen, legen Sie ihn in das engste Paket, das ihn
aufnehmen kann: Gemeinsame Helfer gehören zu `@neotavern/shared`, API-Formen zu
`@neotavern/contracts`, und alles Datenbankbezogene zu `@neotavern/db`.

## Paketverantwortlichkeiten

- `@neotavern/shared` — isomorphe Utilities ohne Laufzeitabhängigkeiten:
  UUIDv7-IDs, `Result`, der `AppError`-Envelope, ein strukturierter Logger
  mit Geheimnis-Redaktion, Timeout- und Signal-Helfer und Prompt-Makros.
- `@neotavern/contracts` — TypeBox-Schemata für jede API-Eingabe und -Ausgabe.
  Die einzige Quelle der Wahrheit, die Server und Web teilen; nie von Hand
  dupliziert.
- `@neotavern/db` — SQLite: das Drizzle-Schema, Migrationen, Repositories und
  FTS5-Suche. Das einzige Paket, das mit der Datenbank spricht.
- `@neotavern/ui` — Headless-Basiskomponenten auf Radix-Primitiven,
  Design-Tokens und die `data-*`-Hooks, auf die Themes sich stützen.
- `@neotavern/i18n` — i18next-Setup, Namespaces, `en`- und `ru`-Ressourcen und
  der Fehlercode-Lokalisierer, der Maschinen-Fehlercodes in lokalisierten
  Text übersetzt.
- `@neotavern/plugin-sdk` — das versionierte Plugin SDK: Manifest-Schema,
  Berechtigungen und Fähigkeitsgewährungen sowie die Frontend- und
  Backend-API-Verträge, gegen die Plugins kompilieren.
- `@neotavern/theme-sdk` — das Theme SDK: Manifest-Schema, die
  Token-/Komponenten-/Shell-Ebenen und die Vererbungsauflösung.
- `@neotavern/provider-sdk` — der einheitliche Anbieter-Adaptervertrag plus die
  integrierten Adapter für LLM-, TTS-, STT- und Bild-Anbieter sowie das
  Adapter-Registry.
- `@neotavern/legacy-compat` — die Legacy-Kompatibilitätsebene: `window`-Globals,
  den Ereignisbus und nicht verwaltete DOM-Inseln für Skripte aus der
  SillyTavern-Ära.
- `@neotavern/gestures` — framework-agnostische Zeilengesten:
  Kontextmenüs (Rechtsklick und langes Drücken) und Drag-and-Drop-
  Neuanordnungserkennung.
- `@neotavern/plugin-build` — die Plugin-Build- und Veröffentlichungspipeline:
  analysieren, signieren und Plugin-Pakete bauen.

## Was wo lebt

- **API-Formen** kommen immer aus `@neotavern/contracts`. Backend und Frontend
  deklarieren nie denselben Typ zweimal.
- **Datenbankzugriff** erfolgt nur über die Repositories von `@neotavern/db`.
  Plugin-Code erhält nie eine SQLite-Verbindung.
- **Anbieterverhalten** lebt in den Adaptern von `@neotavern/provider-sdk`. Der
  Serverkern ist an kein SDK eines einzelnen Anbieters gekoppelt, mit einer
  dokumentierten Ausnahme: Der Anthropic-Adapter verwendet das offizielle
  SDK für Beta-Oberflächen.
- **UI-Bausteine** kommen aus `@neotavern/ui`; Anwendungsbildschirme setzen sie
  zusammen. Framework-agnostische Gesten bleiben in `@neotavern/gestures`, damit
  sie außerhalb von React wiederverwendet werden können.

## Ein Paket hinzufügen

Ein neues Paket benötigt eine `README.md`, die Zweck, öffentliche
Einstiegspunkte, Abhängigkeiten und Einschränkungen angibt — Dokumentation
ist Teil der Implementierung. Prüfen Sie vor der Erstellung, ob der Code in
ein bestehendes Paket passt; die Standardantwort lautet: kein neues Paket.
