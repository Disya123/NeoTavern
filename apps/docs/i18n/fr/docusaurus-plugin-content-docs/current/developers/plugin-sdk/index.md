---
title: Vue d'ensemble du Plugin SDK
description: >-
  Ce qu'est le Plugin SDK et comment fonctionne la séparation des API
  frontend et backend.
sidebar_position: 1
---

Le Plugin SDK est l'API publique versionnée que les plugins utilisent pour
étendre NeoTavern, couvrant à la fois l'interface côté navigateur et le
backend côté serveur.

## Ce Qu'est le Plugin SDK

Les plugins sont des packages ZIP (`.stplugin`) qui livrent un manifeste, des
points d'entrée frontend et backend facultatifs, et des ressources. Ils
étendent l'application uniquement via le package `@neotavern/plugin-sdk` — jamais en
important Fastify, React, Zustand, TanStack Query, la connexion SQLite ou des
composants internes directement. Ce sont des détails d'implémentation de
l'hôte qui changent sans préavis.

Le SDK est versionné (`apiVersion` dans le manifeste) pour que les plugins
continuent de fonctionner à travers les mises à jour de l'application.
L'hôte applique le contrat : tout ce que vous enregistrez via le SDK est
nettoyé quand votre plugin est désactivé, et tout ce dont vous auriez besoin
depuis les modules internes est délibérément non exposé.

## Séparation Frontend et Backend

Un plugin a deux moitiés facultatives :

- **Frontend** — une entrée ESM navigateur qui reçoit `FrontendPluginApi`
  dans son appel `activate()`. Elle enregistre des surfaces d'interface comme
  des actions de barre d'outils, des actions de message, des commandes slash
  et des panneaux de paramètres, et écoute les événements de l'application.
- **Backend** — une entrée ESM Node.js qui reçoit `ServerPluginApi`. Elle
  monte des routes sous `/api/plugins/{pluginId}/`, lit et écrit un stockage
  isolé, effectue des appels réseau vérifiés par permissions et enregistre
  des fournisseurs et des stratégies de décalage de contexte.

Les deux moitiés sont facultatives. Un plugin qui n'ajoute qu'un bouton de
barre d'outils n'a pas besoin de backend ; un plugin qui ne sert qu'une API
n'a pas besoin de frontend. Chaque enregistrement renvoie une fonction de
nettoyage, et le runtime les collecte pour que la désactivation ne laisse
rien derrière.

## Écrire un Plugin

Importez `definePlugin` depuis `@neotavern/plugin-sdk` et exportez une définition
avec une fonction `activate(api)` :

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

La [référence du Plugin SDK](../api/plugin-sdk/) générée documente chaque
type et fonction exportés avec leur signature exacte.

## Étapes Suivantes

- [Manifeste](manifest.md) — structure du package et schéma `plugin.json`.
- [Permissions](permissions.md) — le modèle de permissions et le flux de
  consentement.
- [API frontend](frontend.md) — enregistrer des surfaces d'interface et des
  événements.
- [API backend](backend.md) — routes, stockage et abstractions serveur.
- [Cycle de vie](lifecycle.md) — installation, activation, désactivation et
  garanties de nettoyage.
- [Bac à sable](sandboxing.md) — le modèle de sécurité pour le code non
  fiable.
