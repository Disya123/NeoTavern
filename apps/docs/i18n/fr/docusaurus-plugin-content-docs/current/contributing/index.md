---
title: Contribuer à NeoTavern
description: Comment contribuer à NeoTavern — issues, code, documentation et traductions
sidebar_position: 1
---

NeoTavern est un projet ouvert, et les contributions de toutes sortes sont les
bienvenues : rapports de bugs, demandes de fonctionnalités, code,
documentation et traductions.

## Façons de Contribuer

- **Signaler des bugs et demander des fonctionnalités.** Ouvrez une issue sur
  GitHub avec la version, votre OS et les étapes pour reproduire :
  [https://github.com/Disya123/NeoTavern/issues](https://github.com/Disya123/NeoTavern/issues)
- **Écrire du code.** Choisissez une issue, commentez-la et ouvrez une pull
  request. Gardez les changements petits et suivez les
  [Règles de code](contributing/code-guidelines).
- **Améliorer la documentation.** Le site public vit dans `apps/docs` ;
  consultez [Site de documentation](contributing/docs-site).
- **Traduire.** Aidez avec l'une des huit locales ou proposez-en une nouvelle ;
  consultez [Traductions](contributing/translations).

## Code de Conduite

Traitez les autres contributeurs avec respect. Soyez constructif dans les
revues et les issues, partez du principe de bonne foi et gardez la discussion
focalisée sur le travail. Le
[AGENTS.md](https://github.com/Disya123/NeoTavern/blob/main/AGENTS.md) du
dépôt est la description faisant autorité de la façon dont le projet est
construit et dont les tâches sont accomplies ; lisez-le avant votre premier
changement.

## Avant de Commencer

- Lisez d'abord la [Configuration de développement](contributing/development-setup) et
  les [Règles de code](contributing/code-guidelines), plus le fichier AGENTS.md lié
  ci-dessus.
- Cherchez une issue existante couvrant ce que vous voulez faire, et
  commentez avant de commencer un gros travail pour que les mainteneurs
  puissent donner un retour précoce.
- Gardez les pull requests focalisées : un changement logique par PR, avec
  les tests et la documentation inclus.

## Ce Qui Se Passe Après Votre Soumission

Les mainteneurs examinent le changement et le CI exécute les portes de
qualité — lint, typecheck et tests. Une fois tout au vert, la pull request
est fusionnée et les changements visibles par l'utilisateur atterrissent dans
le changelog.
