---
title: Pipeline de prompts
description: >-
  Vue d'ensemble du pipeline de prompts : l'ordre fixe des étapes, les
  formats d'instruction, le comptage de jetons local et le décalage de
  contexte.
sidebar_position: 1
---

Le pipeline de prompts est l'ensemble fixe et ordonné d'étapes qui transforme
une conversation en requête de fournisseur, de l'entrée utilisateur au
message enregistré.

## Ce Que Fait le Pipeline

Chaque génération — un nouveau message, un swipe, une régénération ou une
impersonation — passe par les mêmes étapes dans le même ordre. Le pipeline
assemble le contexte à partir du personnage, du persona, du lorebook et de la
mémoire, compte les jetons, ajuste le contexte au budget du modèle, laisse
les plugins intercepter, rend la requête dans le format d'instruction
sélectionné et enfin diffuse et enregistre la réponse.

## Pages de Cette Section

- [Étapes du pipeline](prompt-pipeline/stages) — les 14 étapes dans l'ordre et les règles que
  chaque hook de plugin doit suivre.
- [Formats d'instruction](prompt-pipeline/instruct-formats) — comment le tableau de messages
  propre est rendu avec des modèles Handlebars en bac à sable.
- [Tokenisation](prompt-pipeline/tokenization) — le registre de tokeniseurs local et son
  repli approximatif.
- [Décalage de contexte](prompt-pipeline/context-shifting) — comment le pipeline ajuste le
  contexte au budget de jetons et quelles stratégies existent.

## Implémentation

Le pipeline vit dans `apps/server/src/pipeline/`. Il s'exécute entièrement
sur le serveur, avant tout appel réseau, donc la requête qui atteint un
fournisseur est toujours le résultat des mêmes étapes déterministes.

## Sections Associées

- Les intercepteurs de plugins et leurs API d'enregistrement sont documentés
  dans le [Plugin SDK](plugin-sdk/).
- L'endpoint de génération et l'audit de contexte font partie de la
  [Référence API](../api/).
- Les adaptateurs de fournisseurs qui consomment la requête sérialisée sont
  documentés sous [Fournisseurs](providers/).
