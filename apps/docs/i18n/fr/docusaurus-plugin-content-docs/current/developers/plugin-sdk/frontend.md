---
title: API frontend des plugins
description: >-
  Comment un plugin frontend enregistre des pages, panneaux, actions,
  commandes et événements.
sidebar_position: 4
---

L'API frontend est ce qu'un plugin côté navigateur reçoit dans son appel
`activate()` : un ensemble d'enregistreurs pour chaque surface d'interface,
le bus d'événements et i18n.

## Point d'Entrée

Un plugin frontend exporte une définition avec une fonction
`activate(api)`. L'hôte l'appelle avec l'objet `FrontendPluginApi` une fois
que le plugin est consenti et actif :

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    // Enregistrez les surfaces ici.
  },
  deactivate() {
    // Déconstruction explicite facultative.
  },
});
```

Chaque enregistreur renvoie une fonction de nettoyage. Le runtime les
collecte automatiquement, donc votre plugin n'a pas besoin de les suivre à la
main — même si `deactivate()` peut toujours démonter ce que vous gérez
vous-même.

## Surfaces d'Enregistrement

L'espace de noms `api.ui` regroupe les enregistreurs d'interface :

- **Pages** — `api.ui.pages.register({ id, path, title, mount })` ajoute une
  route sous l'espace de noms du plugin. `mount` reçoit un conteneur fourni
  par l'hôte et peut renvoyer une déconstruction.
- **Panneaux de paramètres** — `api.ui.settingsPanels.register(...)` ajoute
  un panneau à l'écran Paramètres.
- **Actions de barre d'outils** — `api.ui.toolbarActions.register({ id,
title, icon, run })`. L'hôte rend l'action comme un bouton standard ; vous
  ne fournissez que la sémantique, jamais la mise en page ou les points de
  rupture.
- **Actions de message** — `api.ui.messageActions.register({ id, title, icon,
order, placement, run })`. Le callback `run` reçoit un instantané de message
  immuable plus un `AbortSignal` qui se déclenche à la déconstruction, à la
  ré-invocation ou au délai.
- **Éléments de menu contextuel** — `api.ui.contextMenuItems.register({ id,
title, context, run })` pour `context: 'message' | 'character'`.
- **Renders de messages** — `api.ui.messageRenderers.register({ id, title,
render })`. `render` renvoie du texte brut avec un `placement` de
  `'replace'` ou `'after'` — jamais de HTML.
- **Onglets de personnage** — `api.ui.characterTabs.register({ id, title,
mount })`. `mount` reçoit `{ characterId }` comme contexte.
- **Panneaux latéraux** — `api.ui.sidebarPanels.register({ id, title, slot,
mount })` avec `slot: 'left' | 'right'`.
- **Boîtes de dialogue** — `api.ui.dialogs.register({ id, title, description,
mount })`.
- **Actions de palette de commandes** — `api.ui.commands.register({ id,
title, run })`.
- **Raccourcis clavier** — `api.ui.hotkeys.register({ id, combo, run })`, par
  exemple `combo: 'mod+shift+k'`.

Les commandes slash s'enregistrent séparément via `api.slash.register({ name,
description, run })`, et les intercepteurs de prompt via `api.interceptors`.

## Intercepteurs de Prompt

Un intercepteur s'exécute sur le prompt assemblé avant qu'il ne soit envoyé :

```ts
api.interceptors.register({
  id: 'example.format',
  priority: 100,
  timeoutMs: 5000,
  intercept(context) {
    // context.messages est un tableau de { id, role, content, name }.
    return context;
  },
});
```

Une `priority` plus basse s'exécute plus tôt ; un plugin qui dépasse
`timeoutMs` est ignoré sans casser la chaîne. Les intercepteurs qui
inspectent seulement le prompt ont besoin de `prompt.inspect` ; ceux qui le
changent ont besoin de `prompt.modify`.

## Événements

Le bus d'événements est typé et partagé avec l'hôte. `api.events.on(event,
handler)` renvoie une fonction de désinscription :

```ts
const off = api.events.on('chat.message.created', ({ chatId, messageId }) => {
  console.log('nouveau message', chatId, messageId);
});
```

Les événements intégrés incluent `chat.created`, `chat.opened`,
`chat.message.created`, `chat.message.updated`, `chat.message.deleted`,
`character.selected`, `generation.started`, `generation.delta`,
`generation.finished`, `generation.error`, `theme.changed` et
`language.changed`. Les plugins peuvent aussi émettre et écouter des
événements personnalisés, avec des noms espacés par convention, par exemple
`myplugin.foo`.

## Instantanés de Messages et Blocage de Contenu

Les actions de message reçoivent un `MessageActionSnapshot` immuable avec
`messageId`, `chatId`, `branchId`, `role`, `content`, `name`, `meta` et
`revision`. Le champ `content` vaut `null` à moins que le plugin détienne
aussi `chat.read`, donc une action peut rendre des métadonnées sans jamais
voir le texte du message.

## Notifications et i18n

`api.notify({ title, description, variant, timeoutMs })` affiche une
notification et renvoie une fonction de rejet. `variant` vaut `info`,
`success`, `warning` ou `error`.

`api.i18n` gère les ressources de traduction dans un espace de noms de plugin
isolé :

```ts
api.i18n.addResources('ru', { greet: 'Привет' });
const label = api.i18n.t('greet');
```

`addResources` renvoie une fonction de nettoyage comme chaque autre
enregistrement.

## Garanties de Nettoyage

Comme chaque enregistrement renvoie une fonction de nettoyage et que le
runtime les suit, désactiver un plugin retire tous ses handlers, minuteries,
nœuds DOM, abonnements et requêtes en arrière-plan. Consultez
[Cycle de vie](lifecycle.md) pour le contrat de déconstruction complet, et la
[référence du Plugin SDK](../../api/plugin-sdk/) générée pour les types précis.
