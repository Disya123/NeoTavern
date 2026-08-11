---
title: Architecture
description: >-
  Vue d'ensemble de la section architecture : la disposition du monorepo, la
  pile technologique approuvée et les responsabilités de chaque package.
sidebar_position: 1
---

Cette section explique comment le monorepo NeoTavern est organisé, quelles
technologies il utilise et comment le serveur, le client web et le shell
desktop s'assemblent.

## Pages de Cette Section

- [Vue d'ensemble du monorepo](architecture/overview) — la disposition de `apps/` et
  `packages/`, le flux de données entre le serveur et le web, et le principe
  local-first.
- [Pile technologique](architecture/stack) — la pile approuvée : Node.js 24, Fastify 5,
  React 19, Vite 8, SQLite, Drizzle, Tauri 2 et les espaces de travail pnpm.
- [Packages](architecture/packages) — la responsabilité de chaque package de l'espace de
  travail et la direction des dépendances entre eux.

## Sections Associées

La section [Pipeline de prompts](prompt-pipeline/) décrit les étapes de
génération en détail, et [Données et stockage](data/) documente la base de
données, la gestion des fichiers et les sauvegardes.
