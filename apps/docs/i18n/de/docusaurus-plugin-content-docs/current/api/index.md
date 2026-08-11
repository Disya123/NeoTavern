---
title: SDK-Referenz
description: Überblick über die automatisch generierte TypeDoc-Referenz für die vier öffentlichen SDK-Pakete.
sidebar_position: 1
---

Die SDK-Referenz ist eine automatisch generierte API-Referenz für die vier
öffentlichen TypeScript-Pakete, die NeoTavern Plugin-, Theme- und
Anbieter-Autoren zur Verfügung stellt.

## Was generiert wird

Die Referenz wird bei jedem Site-Build von TypeDoc aus dem
`src/index.ts`-Einstiegspunkt jedes Pakets erzeugt. Sie dokumentiert die
exakte exportierte Oberfläche von:

- **Plugin SDK** — `@neotavern/plugin-sdk`: Manifest-Validierung, das
  Berechtigungsmodell, typisierte Ereignisse und die Frontend- und
  Backend-Plugin-API-Verträge.
- **Theme SDK** — `@neotavern/theme-sdk`: den Design-Token-Vertrag,
  Theme-Manifest-Validierung, Vererbungsauflösung und
  CSS-Variablen-Generierung.
- **Provider SDK** — `@neotavern/provider-sdk`: den Anbieter-Adaptervertrag,
  integrierte Adapter, Token-Schätzung und das Laufzeit-Registry.
- **Contracts** — `@neotavern/contracts`: die gemeinsamen Anfrage-, Antwort- und
  Entitätsschemata, von denen sowohl die Backend-Routen als auch die
  Frontend-Typen abgeleitet sind.

Die generierten Seiten sind nicht von Hand geschrieben und werden nicht im
Repository eingecheckt. Sie werden bei jedem Build neu erstellt, sodass sie
immer zum aktuellen `src/` der Pakete passen.

## Die Referenz neu generieren

Jeder Docusaurus-Build generiert die Referenz als Teil der Pipeline neu:

```bash
pnpm --filter @neotavern/docs build
```

Führen Sie denselben Befehl lokal aus, wenn Sie nach einer Änderung an
einer SDK-Quelldatei eine frische Referenz wünschen.

## Die Pakete durchsuchen

- [Plugin-SDK-Referenz](api/plugin-sdk/)
- [Theme-SDK-Referenz](api/theme-sdk/)
- [Provider-SDK-Referenz](api/provider-sdk/)
- [Contracts-Referenz](api/contracts/)

Für Nutzungsleitfäden statt roher API-Listen siehe die Abschnitte Plugin
SDK, Theme SDK und Anbieter dieser Dokumentation. Sie erklären die
Verträge in Prosa mit Beispielen und verlinken für die präzisen Signaturen
auf die generierten Seiten.
