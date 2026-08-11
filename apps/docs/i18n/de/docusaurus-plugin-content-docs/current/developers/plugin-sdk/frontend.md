---
title: Frontend-Plugin-API
description: Wie ein Frontend-Plugin Seiten, Panels, Aktionen, Befehle und Ereignisse registriert.
sidebar_position: 4
---

Die Frontend-API ist das, was ein Browser-seitiges Plugin in seinem
`activate()`-Aufruf erhält: einen Satz von Registraren für jede
UI-Oberfläche, den Ereignisbus und i18n.

## Einstiegspunkt

Ein Frontend-Plugin exportiert eine Definition mit einer
`activate(api)`-Funktion. Der Host ruft sie mit dem
`FrontendPluginApi`-Objekt auf, sobald das Plugin seine Einwilligung hat
und aktiv ist:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    // Register surfaces here.
  },
  deactivate() {
    // Optional explicit teardown.
  },
});
```

Jeder Registrar gibt eine Bereinigungsfunktion zurück. Die Laufzeit sammelt
diese automatisch, sodass Ihr Plugin sie nicht von Hand verfolgen muss —
obwohl `deactivate()` weiterhin alles abräumen kann, das Sie selbst
verwalten.

## Registrierungsoberflächen

Der Namensraum `api.ui` gruppiert die UI-Registrare:

- **Seiten** — `api.ui.pages.register({ id, path, title, mount })` fügt eine
  Route unter dem Plugin-Namensraum hinzu. `mount` erhält einen
  Host-bereitgestellten Container und kann ein Teardown zurückgeben.
- **Einstellungs-Panels** — `api.ui.settingsPanels.register(...)` fügt dem
  Einstellungsbildschirm ein Panel hinzu.
- **Toolbar-Aktionen** — `api.ui.toolbarActions.register({ id, title, icon,
run })`. Der Host rendert die Aktion als Standardschaltfläche; Sie liefern
  nur Semantik, nie Layout oder Breakpoints.
- **Nachrichtenaktionen** — `api.ui.messageActions.register({ id, title, icon,
order, placement, run })`. Der `run`-Callback erhält einen
  unveränderlichen Nachrichten-Snapshot plus ein `AbortSignal`, das bei
  Teardown, erneutem Aufruf oder Timeout ausgelöst wird.
- **Kontextmenü-Einträge** — `api.ui.contextMenuItems.register({ id, title,
context, run })` für `context: 'message' | 'character'`.
- **Nachrichten-Renderer** — `api.ui.messageRenderers.register({ id, title,
render })`. `render` gibt Klartext mit einem `placement` von `'replace'`
  oder `'after'` zurück — nie HTML.
- **Charakter-Tabs** — `api.ui.characterTabs.register({ id, title, mount })`.
  `mount` erhält `{ characterId }` als Kontext.
- **Seitenleisten-Panels** — `api.ui.sidebarPanels.register({ id, title, slot,
mount })` mit `slot: 'left' | 'right'`.
- **Dialoge** — `api.ui.dialogs.register({ id, title, description, mount })`.
- **Befehlspaletten-Aktionen** — `api.ui.commands.register({ id, title, run })`.
- **Tastenkürzel** — `api.ui.hotkeys.register({ id, combo, run })`, zum
  Beispiel `combo: 'mod+shift+k'`.

Slash-Befehle registrieren sich separat über `api.slash.register({ name,
description, run })` und Prompt-Interceptor über `api.interceptors`.

## Prompt-Interceptor

Ein Interceptor läuft auf dem zusammengesetzten Prompt, bevor er gesendet
wird:

```ts
api.interceptors.register({
  id: 'example.format',
  priority: 100,
  timeoutMs: 5000,
  intercept(context) {
    // context.messages is an array of { id, role, content, name }.
    return context;
  },
});
```

Eine niedrigere `priority` läuft früher; ein Plugin, das `timeoutMs`
überschreitet, wird übersprungen, ohne die Kette zu brechen. Interceptor,
die den Prompt nur prüfen, benötigen `prompt.inspect`; solche, die ihn
ändern, benötigen `prompt.modify`.

## Ereignisse

Der Ereignisbus ist typisiert und wird mit dem Host geteilt. `api.events.on(event,
handler)` gibt eine Abmeldefunktion zurück:

```ts
const off = api.events.on('chat.message.created', ({ chatId, messageId }) => {
  console.log('new message', chatId, messageId);
});
```

Integrierte Ereignisse umfassen `chat.created`, `chat.opened`,
`chat.message.created`, `chat.message.updated`, `chat.message.deleted`,
`character.selected`, `generation.started`, `generation.delta`,
`generation.finished`, `generation.error`, `theme.changed` und
`language.changed`. Plugins können auch eigene Ereignisse ausgeben und
empfangen, mit Namen, die per Konvention in Namespaces liegen, zum Beispiel
`myplugin.foo`.

## Nachrichten-Snapshots und Inhaltsgating

Nachrichtenaktionen erhalten einen unveränderlichen
`MessageActionSnapshot` mit `messageId`, `chatId`, `branchId`, `role`,
`content`, `name`, `meta` und `revision`. Das Feld `content` ist `null`,
es sei denn, das Plugin hält auch `chat.read` — so kann eine Aktion
Metadaten rendern, ohne je Nachrichtentext zu sehen.

## Benachrichtigungen und i18n

`api.notify({ title, description, variant, timeoutMs })` zeigt eine
Benachrichtigung und gibt eine Ausblendfunktion zurück. `variant` ist
`info`, `success`, `warning` oder `error`.

`api.i18n` verwaltet Übersetzungsressourcen in einem isolierten
Plugin-Namensraum:

```ts
api.i18n.addResources('ru', { greet: 'Привет' });
const label = api.i18n.t('greet');
```

`addResources` gibt wie jede andere Registrierung eine
Bereinigungsfunktion zurück.

## Bereinigungsgarantien

Da jede Registrierung eine Bereinigungsfunktion zurückgibt und die Laufzeit
sie verfolgt, entfernt das Deaktivieren eines Plugins alle seine Handler,
Timer, DOM-Knoten, Abonnements und Hintergrundanfragen. Den vollständigen
Teardown-Vertrag finden Sie unter [Lebenszyklus](lifecycle.md) und die
präzisen Typen in der generierten
[Plugin-SDK-Referenz](../../api/plugin-sdk/).
