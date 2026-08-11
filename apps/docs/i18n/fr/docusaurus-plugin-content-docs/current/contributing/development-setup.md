---
title: Configuration de développement
description: Configurez un environnement de développement NeoTavern et exécutez le projet localement
sidebar_position: 2
---

Cette page explique comment configurer un environnement de développement
pour NeoTavern et exécuter le projet localement.

## Prérequis

- Node.js 24 LTS ou plus récent — le projet exige Node `>= 24`.
- pnpm 9 — l'espace de travail exige pnpm `>= 9` et `< 10` et déclare
  `packageManager: pnpm@9.15.0` ; activez-le avec corepack ou installez-le
  directement.
- Windows, macOS ou Linux. L'application de bureau embarque son propre
  runtime Node.js pour les utilisateurs finaux, mais le développement utilise
  toujours votre Node.js installé.

## Installer les Dépendances

```bash
pnpm install
```

Cela installe chaque package de l'espace de travail. Le dépôt est un monorepo
pnpm : les applications vivent dans `apps/` (serveur et web) et les
bibliothèques partagées dans `packages/`.

## Exécuter en Développement

```bash
pnpm dev
```

démarre le backend Fastify et l'application web Vite en parallèle avec le
rechargement à chaud. Pour les exécuter séparément :

```bash
pnpm dev:server
pnpm dev:web
```

Ouvrez l'URL imprimée par le serveur de dev Vite, connectez un fournisseur
dans les Paramètres et envoyez votre premier message pour vérifier tout le
pipeline : chat, serveur, fournisseur, streaming et enregistrement.

## Portes de Qualité

Exécutez-les avant de pousser :

```bash
pnpm typecheck    # TypeScript sur tout le monorepo
pnpm lint         # ESLint, aucun avertissement autorisé
pnpm test         # Tests unitaires et d'intégration Vitest, plus les tests web
pnpm test:e2e     # Suite de bout en bout Playwright (construit d'abord l'espace de travail)
pnpm build        # Build complet de l'espace de travail (tsc -b et Vite)
pnpm format:check # Vérification Prettier
```

`pnpm test:e2e` compile d'abord tout l'espace de travail, attendez-vous donc à
ce qu'il prenne plus de temps que les autres vérifications. Les scripts
`docs:check` et `docs:build` valident la documentation développeur interne ;
le site public a ses propres commandes, documentées sur la page
[Site de documentation](./docs-site).

## Développement Desktop

Le shell desktop (Tauri) et son sidecar Node sont des applications
séparées :

```bash
pnpm desktop:dev       # exécuter l'application de bureau en développement
pnpm desktop:portable  # construire le package Windows portable
pnpm desktop:release   # construire les packages d'installation
```

L'empaquetage desktop implique des chaînes d'outils spécifiques à l'OS ;
consultez la section [Desktop](../developers/desktop/) de la documentation
Développeurs pour les détails.

## Problèmes Courants

- `pnpm install` ou `pnpm dev` échoue : vérifiez que `node -v` rapporte 24 ou
  plus récent et que `pnpm -v` rapporte 9.
- Les serveurs de dev ne démarrent pas : vérifiez qu'aucun autre processus
  n'occupe les ports utilisés par le serveur et Vite, puis redémarrez
  `pnpm dev`.
