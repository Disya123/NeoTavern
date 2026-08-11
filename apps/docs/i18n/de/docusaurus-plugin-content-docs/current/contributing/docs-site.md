---
title: Dokumentations-Site
description: Wie die NeoTavern-Dokumentations-Site funktioniert und wie Sie Seiten hinzufügen oder korrigieren
sidebar_position: 4
---

Die öffentliche Dokumentations-Site ist ein Docusaurus-Projekt in
`apps/docs`. Diese Seite erklärt ihre Struktur und wie Sie Seiten
hinzufügen oder aktualisieren.

## Aufbau

- Englische Quellseiten liegen in `apps/docs/docs/`, eine Markdown-Datei
  pro Seite, organisiert in denselben Verzeichnissen, die die
  Seitenleiste zeigt.
- Übersetzungen liegen in
  `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/` und
  spiegeln den englischen Baum eine Datei pro Seite; siehe
  [Übersetzungen](./translations).
- Die SDK-Referenz unter `apps/docs/docs/api/` wird generiert und ist
  gitignored; bearbeiten Sie sie nicht von Hand.

## Eine Seite hinzufügen

1. Erstellen Sie die Markdown-Datei in dem Verzeichnis, das zu der Stelle
   passt, an der die Seite erscheinen soll.
2. Fügen Sie Front Matter mit `title`, `description` und
   `sidebar_position` hinzu:

   ```yaml
   ---
   title: Page Title
   description: One sentence describing the page.
   sidebar_position: 3
   ---
   ```

3. Beginnen Sie mit einer ein-Satz-Zusammenfassung dessen, was die Seite
   abdeckt.
4. Verwenden Sie `##` und `###` für Abschnitte; das Front-Matter-`title`
   liefert die einzelne H1.
5. Wenn Sie ein neues Verzeichnis hinzufügen, erstellen Sie eine
   `_category_.json` darin:

   ```json
   { "label": "Category Label", "position": 2 }
   ```

`sidebar_position` ordnet Seiten innerhalb ihres Verzeichnisses; die
Übersichtsseite ist 1. Inhaltsseitenleisten-Abschnitte werden aus der
Verzeichnisstruktur automatisch generiert.

## MDX-Grenzen

Seiten sind nur einfaches Markdown plus Docusaurus-Admonitions:

```md
:::note
Text inside the admonition.
:::
```

Keine `import`-Anweisungen, keine eigenen JSX-Komponenten, keine Tabs und
kein rohes HTML. Jede Seite muss unverändert in jede der acht
Übersetzungssprachen kopierbar bleiben. Codebeispiele verwenden umschlossene
Blöcke mit einem Sprach-Tag.

## SDK-Referenz

Die SDK-Referenz wird von TypeDoc aus dem Einstiegspunkt jedes Pakets
generiert:

- `packages/plugin-sdk/src/index.ts` → `apps/docs/docs/api/plugin-sdk/`
- `packages/theme-sdk/src/index.ts` → `apps/docs/docs/api/theme-sdk/`
- `packages/provider-sdk/src/index.ts` → `apps/docs/docs/api/provider-sdk/`
- `packages/contracts/src/index.ts` → `apps/docs/docs/api/contracts/`

Die Referenz wird bei jedem Site-Build neu generiert, sodass
Bearbeitungen an generierten Seiten verloren gehen. Um eine
Referenzseite zu korrigieren, korrigieren Sie stattdessen das TSDoc im
Paketquellcode. Die Übersicht unter `apps/docs/docs/api/index.md` ist von
Hand geschrieben und bleibt eingecheckt.

## Die Site ausführen

```bash
pnpm docs:site        # local dev server with hot reload
pnpm docs:site:build  # production build: all locales plus the SDK reference
```

Der Produktions-Build ist das Tor — kaputte Links und kaputte
Markdown-Links lassen ihn fehlschlagen — führen Sie ihn also vor dem
Pushen von Inhaltsänderungen aus.

## Linkregeln

Interne Links müssen auf Seiten zeigen, die auf der Site existieren.
Bevorzugen Sie absolute Site-Pfade von der Startseite (`/getting-started/`)
und relative Pfade von tieferen Seiten (`../developers/` von einer Seite
unter `contributing/`). Externe Links sind auf die
Docusaurus-Dokumentation und das NeoTavern-Repository beschränkt.

## Interne Entwicklerdokumente

Das Repository führt außerdem interne Entwicklerdokumentation in `docs/`
an der Repository-Wurzel, validiert durch `pnpm docs:check` und
`pnpm docs:build`. Das ist eine separate Dokumentenmenge von dieser
öffentlichen Site; verwechseln Sie die beiden Bäume nicht.
