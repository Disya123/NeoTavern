---
title: Plugin-SDK-Übersicht
description: Was das Plugin SDK ist und wie die Frontend-/Backend-API-Aufteilung funktioniert.
sidebar_position: 1
---

Das Plugin SDK ist die versionierte öffentliche API, mit der Plugins
NeoTavern erweitern — sie deckt sowohl die Browser-seitige Oberfläche als
auch das Server-seitige Backend ab.

## Was das Plugin SDK ist

Plugins sind ZIP-Pakete (`.stplugin`), die ein Manifest, optionale
Frontend- und Backend-Einstiegspunkte sowie Assets enthalten. Sie erweitern
die Anwendung ausschließlich über das Paket `@neotavern/plugin-sdk` — nie durch
direktes Importieren von Fastify, React, Zustand, TanStack Query, der
SQLite-Verbindung oder interner Komponenten. Das sind
Implementierungsdetails des Hosts und ändern sich ohne Ankündigung.

Das SDK ist versioniert (`apiVersion` im Manifest), damit Plugins über
Anwendungsupdates hinweg funktionieren. Der Host setzt den Vertrag durch:
Was Sie über das SDK registrieren, wird bereinigt, wenn Ihr Plugin
deaktiviert wird, und was Sie aus internen Modulen bräuchten, wird bewusst
nicht exponiert.

## Frontend- und Backend-Aufteilung

Ein Plugin hat zwei optionale Hälften:

- **Frontend** — ein Browser-ESM-Einstiegspunkt, der `FrontendPluginApi` in
  seinem `activate()`-Aufruf erhält. Er registriert UI-Oberflächen wie
  Toolbar-Aktionen, Nachrichtenaktionen, Slash-Befehle und
  Einstellungs-Panels und lauscht auf Anwendungsereignisse.
- **Backend** — ein Node.js-ESM-Einstiegspunkt, der `ServerPluginApi`
  erhält. Er mountet Routen unter `/api/plugins/{pluginId}/`, liest und
  schreibt isolierten Speicher, führt berechtigungsgeprüfte Netzwerkaufrufe
  aus und registriert Anbieter und Kontext-Shifting-Strategien.

Beide Hälften sind optional. Ein Plugin, das nur eine Toolbar-Schaltfläche
hinzufügt, braucht kein Backend; ein Plugin, das nur eine API bedient,
braucht kein Frontend. Jede Registrierung gibt eine Bereinigungsfunktion
zurück, und die Laufzeit sammelt diese, sodass die Deaktivierung nichts
zurücklässt.

## Ein Plugin erstellen

Importieren Sie `definePlugin` aus `@neotavern/plugin-sdk` und exportieren Sie
eine Definition mit einer `activate(api)`-Funktion:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const unregister = api.ui.messageActions.register({
      id: 'example.greet',
      title: 'Greet',
      run: ({ message }) => console.log(message.messageId),
    });
    api.events.on('chat.opened', ({ chatId }) => console.log(chatId));
  },
});
```

Die generierte [Plugin-SDK-Referenz](../api/plugin-sdk/) dokumentiert jeden
exportierten Typ und jede exportierte Funktion mit ihrer exakten Signatur.

## Nächste Schritte

- [Manifest](manifest.md) — Paketstruktur und `plugin.json`-Schema.
- [Berechtigungen](permissions.md) — das Berechtigungsmodell und der
  Einwilligungsablauf.
- [Frontend-API](frontend.md) — UI-Oberflächen und Ereignisse registrieren.
- [Backend-API](backend.md) — Routen, Speicher und Server-Abstraktionen.
- [Lebenszyklus](lifecycle.md) — Installieren, Aktivieren, Deaktivieren und
  Bereinigungsgarantien.
- [Sandboxing](sandboxing.md) — das Sicherheitsmodell für nicht
  vertrauenswürdigen Code.
