---
title: Développeurs
description: >-
  Vue d'ensemble de la documentation développeur de NeoTavern : architecture,
  pipeline de prompts, couche de données et SDK pour étendre l'application.
sidebar_position: 1
---

Cette section explique comment NeoTavern est construit et comment vous pouvez
l'étendre avec des plugins, des thèmes et des adaptateurs de fournisseurs.

## Ce Que Couvre Cette Section

La documentation développeur est divisée en quatre groupes :

- **Architecture** — la disposition du monorepo, la pile technologique
  approuvée et la responsabilité de chaque package de l'espace de travail.
- **Pipeline de prompts** — l'ensemble fixe d'étapes qui transforme une
  conversation en requête de fournisseur, y compris les formats
  d'instruction, la tokenisation et le décalage de contexte.
- **Données et stockage** — comment NeoTavern stocke les données structurées
  dans SQLite, comment les fichiers et images sont gérés sur le disque et
  comment fonctionnent les sauvegardes.
- **Étendre NeoTavern** — le Plugin SDK, le Theme SDK, les adaptateurs de
  fournisseurs, la référence API générée et le shell desktop.

## Où Commencer

Commencez par la [Vue d'ensemble de l'architecture](developers/architecture/) si vous
voulez comprendre la forme du codebase, ou allez directement au
[Pipeline de prompts](developers/prompt-pipeline/) si vous travaillez sur le
comportement de génération.

## Couche de Données

La section [Données et stockage](developers/data/) couvre la base de données SQLite, la
disposition du système de fichiers et le modèle de sauvegarde. C'est la
référence pour tout ce qui persiste des données.

## Étendre NeoTavern

NeoTavern s'étend de quatre façons :

- [Plugin SDK](developers/plugin-sdk/) — des plugins avec un manifeste, des permissions,
  des API frontend et backend, des hooks de cycle de vie et un bac à sable.
- [Theme SDK](developers/theme-sdk/) — des thèmes construits à partir de design tokens,
  de skins de composants et de mises en page de shell.
- [Fournisseurs](developers/providers/) — des adaptateurs de fournisseurs qui
  implémentent le contrat d'adaptateur unifié.
- [Compatibilité héritée](developers/legacy-compat) — la couche de compatibilité pour
  les plugins et scripts de l'ère SillyTavern.

La [Référence API](api/) est générée à partir des sources des SDK par TypeDoc
à chaque build du site, donc ses pages de membres correspondent toujours aux
packages publiés.

## Desktop

La section [Desktop](developers/desktop/) documente le shell Tauri 2, le sidecar
Node.js et la façon dont les installeurs et versions portables sont
empaquetés.
