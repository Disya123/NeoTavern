---
title: Packages
description: >-
  La responsabilité de chaque package de l'espace de travail et la direction
  des dépendances qui garde le monorepo exempt de cycles.
sidebar_position: 4
---

Chaque package de l'espace de travail a exactement une responsabilité, et les
dépendances ne pointent que vers le bas, ce qui garde le monorepo exempt de
cycles.

## Direction des Dépendances

Le code ne peut dépendre que des packages « en dessous » de lui :

```text
apps (server, web, desktop, plugin-runtime)
  → packages
  → shared, contracts (le socle)
```

`server` et `web` dépendent des packages ; les packages dépendent au plus de
`shared` et `contracts`. Les dépendances cycliques sont interdites. Quand
vous ajoutez du nouveau code, placez-le dans le package le plus étroit qui
peut l'héberger : les utilitaires partagés vont dans `@neotavern/shared`, les
formes d'API dans `@neotavern/contracts`, et tout ce qui touche à la base de
données dans `@neotavern/db`.

## Responsabilités des Packages

- `@neotavern/shared` — utilitaires isomorphes sans dépendances de runtime :
  IDs UUIDv7, `Result`, l'enveloppe `AppError`, un logger structuré avec
  expurgation des secrets, des utilitaires de délai et de signal, et les
  macros de prompt.
- `@neotavern/contracts` — schémas TypeBox pour chaque entrée et sortie d'API. La
  source unique de vérité partagée entre le serveur et le web ; jamais
  dupliquée à la main.
- `@neotavern/db` — SQLite : le schéma Drizzle, les migrations, les dépôts et la
  recherche FTS5. Le seul package qui parle à la base de données.
- `@neotavern/ui` — composants de base headless construits sur les primitives
  Radix, les design tokens et les hooks `data-*` sur lesquels les thèmes
  s'appuient.
- `@neotavern/i18n` — configuration i18next, espaces de noms, ressources `en` et
  `ru`, et le localiseur de codes d'erreur qui mappe les codes machine aux
  textes localisés.
- `@neotavern/plugin-sdk` — le Plugin SDK versionné : schéma de manifeste,
  permissions et octrois de capacités, et les contrats d'API frontend et
  backend contre lesquels les plugins compilent.
- `@neotavern/theme-sdk` — le Theme SDK : schéma de manifeste, les niveaux
  jeton/composant/shell et la résolution d'héritage.
- `@neotavern/provider-sdk` — le contrat d'adaptateur de fournisseur unifié plus
  les adaptateurs intégrés pour les fournisseurs LLM, TTS, STT et d'images,
  et le registre d'adaptateurs.
- `@neotavern/legacy-compat` — la couche de compatibilité héritée : globals
  `window`, le bus d'événements et les îlots DOM non gérés pour les scripts
  de l'ère SillyTavern.
- `@neotavern/gestures` — gestes de lignes indépendants du framework : menus
  contextuels (clic droit et appui long) et reconnaissance de réorganisation
  par glisser-déposer.
- `@neotavern/plugin-build` — le pipeline de build et de publication des plugins :
  analyser, signer et construire les packages de plugins.

## Ce Qui Va Où

- **Les formes d'API** viennent toujours de `@neotavern/contracts`. Le backend et le
  frontend ne déclarent jamais deux fois le même type.
- **L'accès à la base de données** passe uniquement par les dépôts de
  `@neotavern/db`. Le code de plugin ne reçoit jamais de connexion SQLite.
- **Le comportement des fournisseurs** vit dans les adaptateurs de
  `@neotavern/provider-sdk`. Le cœur du serveur n'est couplé au SDK d'aucun
  fournisseur, avec une exception documentée : l'adaptateur Anthropic utilise
  le SDK officiel pour les surfaces bêta.
- **Les blocs de construction d'interface** viennent de `@neotavern/ui` ; les écrans
  de l'application les composent. Les gestes indépendants du framework
  restent dans `@neotavern/gestures` pour pouvoir être réutilisés en dehors de
  React.

## Ajouter un Package

Un nouveau package a besoin d'un `README.md` qui énonce son but, ses points
d'entrée publics, ses dépendances et ses contraintes — la documentation fait
partie de l'implémentation. Avant d'en créer un, vérifiez si le code
s'adapte à un package existant ; la réponse par défaut est pas de nouveau
package.
