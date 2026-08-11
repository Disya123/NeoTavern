---
title: Stockage SQLite
description: >-
  Les paramètres de la base de données SQLite, les tables STRICT, la
  recherche FTS5, les IDs UUIDv7 stables, les migrations versionnées et
  l'isolation des plugins.
sidebar_position: 2
---

NeoTavern stocke toutes les données structurées dans une base de données
SQLite unique avec des pragmas stricts, des tables STRICT, la recherche FTS5
et des migrations versionnées.

## Paramètres de la Base de Données

La connexion est ouverte avec les paramètres suivants :

- `foreign_keys = ON` — l'intégrité référentielle est appliquée.
- Mode de journalisation WAL — les lecteurs ne sont jamais bloqués par les
  écrivains.
- `busy_timeout` — les écrivains concurrents attendent au lieu d'échouer
  immédiatement.
- `synchronous = NORMAL` — durabilité avec des performances sûres pour le
  WAL.
- Déclarations préparées — toutes les requêtes passent par les déclarations
  préparées de Drizzle ; aucune interpolation de chaîne SQL brute.
- Tables STRICT partout où c'est possible — SQLite applique les types de
  colonnes.
- FTS5 — recherche plein texte sur les personnages, conversations et
  messages.

## IDs Stables

Chaque entité a un ID de chaîne stable, de préférence UUIDv7. Les IDs ne sont
jamais des index de tableau. Là où une corbeille est nécessaire, les lignes
sont supprimées en douceur avec `deleted_at` au lieu d'être retirées.

## Vue d'Ensemble du Schéma

Les tables principales couvrent la bibliothèque et l'état d'exécution :
personnages, personas, conversations, branches, messages et variantes de
messages, tags, lorebooks et entrées de lore, presets, configurations et
secrets de fournisseurs, le registre de plugins avec paramètres et octrois de
capacités, le registre de thèmes, les audits de contexte de prompt, les jobs
et artefacts d'import, et les métadonnées de cache.

Deux modèles comptent pour les auteurs de plugins :

- `plugin_state` stocke l'état détenu par le plugin séparément du registre
  d'installation, avec un `schema_version` pour le format de données et une
  `revision` pour la comparaison-échange.
- `provider_secrets` stocke les clés API comme des valeurs en écriture seule :
  seul un aperçu masqué quitte jamais le dépôt.

## Recherche FTS5

Les tables virtuelles `characters_fts`, `chats_fts` et `messages_fts`
alimentent la recherche, construites avec `unicode61` et
`remove_diacritics`. Les déclencheurs sur `INSERT`/`UPDATE`/`DELETE` les
maintiennent synchronisées transactionnellement. La recherche prend en charge
les termes préfixés (`token*`), les filtres de tags et le classement de
pertinence bm25. Une reconstruction complète est disponible à
`POST /api/v2/search/rebuild`.

## Migrations

Chaque changement de schéma est livré comme une migration :

- Les migrations sont **versionnées et idempotentes** — `IF NOT EXISTS` plus
  une version stricte rendent la ré-exécution sûre.
- Les migrations s'exécutent **transactionnellement** ; une migration
  échouée revient en arrière dans son ensemble.
- Il n'y a pas de migration `down` automatique. Le retour en arrière signifie
  restaurer la sauvegarde pré-migration, que le runner crée automatiquement
  pour les bases de données peuplées avant les migrations dangereuses.
- La lecture de données ne déclenche jamais de changements destructifs
  cachés.

Consultez [Sauvegardes](backups) pour savoir comment fonctionnent les
sauvegardes de sécurité du runner de migrations.

## Isolation des Plugins

Les plugins ne reçoivent jamais de connexion SQLite directe. Toute la
persistance passe par les API de stockage du Plugin SDK, qui possèdent les
tables `plugin_storage` et `plugin_state` pour le compte du plugin. Cela
garde les données de plugins versionnées, révocables et à l'abri des
accidents de SQL brut. Consultez le [Plugin SDK](../plugin-sdk/) pour l'API
de stockage.

## Ce Qui Ne Va Jamais Dans la Base de Données

- Les images et l'audio sont stockés sur le disque, jamais comme BLOB dans la
  base de données principale. Consultez [Fichiers et images](files-and-images).
- Les champs inconnus des fiches de personnage et les métadonnées
  d'extensions sont conservés dans la colonne `ext` et survivent à l'export
  et à l'import.
