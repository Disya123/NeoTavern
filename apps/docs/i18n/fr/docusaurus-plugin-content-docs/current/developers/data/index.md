---
title: Données et stockage
description: >-
  Vue d'ensemble de la couche de données : la base de données SQLite, la
  disposition du système de fichiers pour les originaux et le cache, et le
  modèle de sauvegarde.
sidebar_position: 1
---

Cette section explique comment NeoTavern stocke les données : la base de
données SQLite, la disposition du système de fichiers pour les originaux et
le cache, et le modèle de sauvegarde.

## Répertoire de Données

Toutes les données utilisateur vivent dans un seul répertoire de données
local :

```text
data/
  app.db
  files/{avatars,backgrounds,attachments,audio,generated}/
  plugins/  themes/  cache/thumbnails/  backups/  logs/
```

## Pages de Cette Section

- [Stockage SQLite](data/sqlite) — pragmas, tables STRICT, recherche FTS5, IDs
  UUIDv7 stables et migrations.
- [Fichiers et images](data/files-and-images) — comment les originaux et les
  vignettes régénérables sont stockés et écrits atomiquement.
- [Sauvegardes](data/backups) — le modèle de sauvegarde, la restauration et ce que
  couvrent les sauvegardes.

## Sections Associées

- La section [Architecture](architecture/) explique où la couche de
  données se situe dans le monorepo.
- Pour la vue orientée utilisateur, voir Données et sauvegardes dans le
  [Guide utilisateur](../user-guide/data-and-backups).
