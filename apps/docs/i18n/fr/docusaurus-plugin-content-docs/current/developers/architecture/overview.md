---
title: Vue d'ensemble du monorepo
description: >-
  La disposition du monorepo NeoTavern, le flux de données entre le serveur
  et le web, et le principe local-first qui façonne l'architecture.
sidebar_position: 2
---

NeoTavern est une application local-first : un seul processus Fastify sert
l'API et le frontend construit facultatif, sans bases de données externes,
files d'attente ou conteneurs requis.

## Disposition du Monorepo

L'espace de travail est un monorepo pnpm avec deux groupes de premier niveau,
`apps/` et `packages/` :

```text
apps/
  server/          # Backend Fastify : API, pipeline de prompts, SSE, hôte hérité
  web/             # SPA React
  plugin-runtime/  # Processus Node.js restreint pour les plugins backend
  desktop/         # Shell Tauri 2 ; exécute le serveur comme processus sidecar
packages/
  shared/        # IDs UUIDv7, Result, erreurs, logger, utilitaires async
  contracts/     # Schémas d'API TypeBox — source unique de vérité
  db/            # SQLite : schéma, migrations, dépôts, FTS5
  ui/            # Composants headless sur primitives Radix
  i18n/          # Configuration i18next et ressources linguistiques
  plugin-sdk/    # Manifeste de plugin, permissions et contrats d'API
  theme-sdk/     # Jetons de thème, niveaux et héritage
  provider-sdk/  # Contrat d'adaptateur de fournisseur et adaptateurs
  legacy-compat/ # Globals de fenêtre et îlots de compatibilité DOM
  gestures/      # Gestes de lignes indépendants du framework
  plugin-build/  # Pipeline de build et de publication des plugins
```

## Applications

- `apps/server` — le backend Fastify. Il expose l'API `/api/v2/*`, exécute le
  pipeline de prompts, diffuse la génération via SSE et héberge la surface
  héritée compatible Express. Chaque module est un plugin Fastify isolé.
- `apps/web` — la SPA React. Elle parle au serveur via HTTP et rend
  l'espace de travail de chat, plus les surfaces pour les personnages, les
  paramètres, les fournisseurs, les thèmes et les plugins.
- `apps/plugin-runtime` — un processus Node.js limité en permissions dans
  lequel s'exécutent les plugins backend non fiables, isolé du processus
  serveur principal.
- `apps/desktop` — le shell Tauri 2. Il lance le serveur compilé comme un
  sidecar Node.js autonome et n'ouvre la webview qu'une fois l'API locale
  prête.

## Packages

Le code partagé vit dans des packages étroitement ciblés sous `packages/`.
Chaque package a une seule responsabilité, et les dépendances ne pointent que
vers le bas : `server` et `web` dépendent des packages, et les packages
dépendent au plus de `shared` et `contracts`. Consultez [Packages](packages)
pour la ventilation complète.

## Flux de Données

Une requête typique traverse ces couches :

1. Le frontend appelle un endpoint `/api/v2/*` via TanStack Query.
2. Fastify valide l'entrée contre un schéma TypeBox et renvoie les erreurs
   dans l'enveloppe `{ code, params, traceId }`.
3. Les dépôts de `@neotavern/db` lisent et écrivent SQLite, avec pagination par
   curseur et recherche FTS5.
4. La génération s'exécute via `POST /api/v2/chats/:id/generate` : le
   pipeline de prompts assemble le contexte, l'adaptateur de fournisseur
   sérialise la requête, la réponse est diffusée via SSE et le message est
   enregistré.

L'application web est une page unique : les routes changent l'espace de
travail de chat, tandis que les personnages, paramètres, fournisseurs,
thèmes et plugins s'affichent dans une surface de dialogue par-dessus la
position de chat conservée.

## Principe Local-First

Tout fonctionne sur votre machine :

- Le backend n'écoute que sur `127.0.0.1` par défaut. L'accès distant est une
  adhésion explicite avec des sessions bornées et des exigences HTTPS.
- Toutes les données vivent dans un seul répertoire de données local : une
  base de données SQLite unique plus un stockage de fichiers adressés par
  contenu. Pas de PostgreSQL, Redis ou Docker.
- L'application fonctionne hors ligne. Les appels de fournisseur sont le seul
  trafic réseau, et l'adaptateur `echo` intégré vous permet de tester tout le
  pipeline sans aucun fournisseur.
- Les sauvegardes, exports et l'import SillyTavern se font tous localement
  via les mêmes API SQLite et fichiers.

Consultez [Données et stockage](../data/) pour la couche de stockage et
[Pipeline de prompts](../prompt-pipeline/) pour le chemin de génération.
