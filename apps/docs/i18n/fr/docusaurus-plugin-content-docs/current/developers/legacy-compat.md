---
title: Compatibilité héritée
description: Les contrats documentés de l'ère SillyTavern qui fonctionnent encore.
sidebar_position: 8
---

NeoTavern préserve un ensemble de contrats documentés pour les extensions
existantes de l'ère SillyTavern, afin que les plugins écrits contre ces API
puissent continuer à fonctionner pendant que le Plugin SDK natif est la voie
à suivre.

## Globals de Fenêtre

Le package `@neotavern/legacy-compat` installe les globals de fenêtre documentés
que les extensions plus anciennes attendent :

- `window.SillyTavern` — avec `getContext()`, `eventSource` et
  `event_types`.
- `window.eventSource` — la source d'événements héritée.
- `window.event_types` — les constantes de noms d'événements.
- `window.extension_settings` — l'objet partagé de paramètres d'extensions.
- `window.$` et `window.jQuery` — l'instance jQuery embarquée.

Ces globals sont installés de façon idempotente et câblés à l'hôte via un
pont, donc le code hérité peut lire le même contexte et les mêmes événements
que le code natif.

## Îlots DOM Non Gérés

Les extensions frontend héritées s'attendent à posséder un morceau de la
page. L'hôte fournit des îlots DOM non gérés à cet effet : un conteneur
stable auquel le code hérité peut s'attacher et qu'il peut manipuler
directement, en dehors de l'arbre React. Les extensions reçoivent le
conteneur, et l'hôte gère le reste de l'application autour.

## Plugins Serveur Hérités

Les plugins serveur hérités s'exécutent via un hôte de compatibilité
Express. Leurs routes sont proxifiées sous `/api/plugins/{pluginId}/...`,
correspondant au même espace de noms que les plugins backend natifs.
L'intégration `@fastify/express` n'est utilisée que dans cette couche de
compatibilité — le nouveau cœur est natif Fastify et ne route pas via
Express.

## La Frontière de Confiance

Les points d'entrée hérités sont un mode de confiance, pas une contournement
du bac à sable. Un package qui les utilise doit déclarer `legacy.frontend` ou
`legacy.backend` dans son manifeste et demander la permission
`legacy.trusted`, que l'interface de consentement affiche avec un
avertissement renforcé. Le code frontend hérité s'exécute dans la fenêtre
principale, et le code backend hérité obtient un routeur Express limité à son
propre espace de noms de plugin. Le mode sans échec ne charge pas du tout les
points d'entrée hérités. Consultez
[Bac à sable des plugins](plugin-sdk/sandboxing.md) et
[Manifeste de plugin](plugin-sdk/manifest.md) pour les détails.

## Ce Qui N'est Pas Pris en Charge

La compatibilité est un contrat documenté, pas une promesse de comportement
universel. Les plugins qui dépendent de l'un des éléments suivants ne sont
pas pris en charge :

- Des noms de classes CSS internes aléatoires.
- Le monkey patching des entrailles de l'application.
- Des imports privés depuis des packages qu'ils ne possèdent pas.

Ce sont des détails d'implémentation qui changent entre les versions. Quand
une API héritée change, le changement est livré avec un guide de migration et
un test de compatibilité.

## Migrer Vers l'Avant

Pour les nouvelles fonctionnalités, le [Plugin SDK](plugin-sdk/index.md)
natif est la voie prise en charge : versionné, vérifié par permissions,
isolé dans un bac à sable et nettoyé par l'hôte. La compatibilité héritée
existe pour garder les extensions existantes en vie, pas pour grandir.
Portez les extensions vers le SDK pour obtenir toutes les garanties de
sécurité et de cycle de vie.
