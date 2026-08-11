---
title: Formats d'instruction
description: >-
  Comment les formats d'instruction rendent le tableau de messages propre avec
  des modèles Handlebars en bac à sable, les formats intégrés et les presets
  JSON versionnés.
sidebar_position: 3
---

Les formats d'instruction définissent comment le tableau de messages propre
est rendu en une chaîne de prompt, en utilisant des modèles Handlebars en bac
à sable qui n'ont aucun accès au système de fichiers ni à l'exécution de
code.

## Le Gestionnaire de Formats

Un gestionnaire de formats intégré possède les formats d'instruction. Les
formats sont des modèles Handlebars rendus dans un environnement isolé : les
modèles ne reçoivent que `content`, `role` et `name`, et seuls les helpers
documentés sont disponibles. Les modèles n'ont aucun accès à Node.js, aucun
accès au système de fichiers et aucun moyen d'exécuter du code arbitraire.

Un format décrit :

- les modèles système, utilisateur, assistant et outil ;
- les jetons BOS et EOS ;
- les séparateurs de messages ;
- les jetons spéciaux.

## Formats Intégrés

NeoTavern est livré avec ces formats :

- **ChatML** — blocs de rôle `<|im_start|>` / `<|im_end|>`.
- **Llama 3** — `<|begin_of_text|>` avec balises de rôle.
- **Alpaca** — blocs d'instruction et de réponse.
- **Mistral** — blocs `[INST]` / `[/INST]`.
- **Command-R** — blocs `<|START_OF_TURN_TOKEN|>`.
- **Formats personnalisés** — modèles définis par l'utilisateur,
  sélectionnables comme format actif.

## Tableau de Messages Propre Jusqu'au Rendu

Jusqu'à l'étape de rendu, le pipeline travaille exclusivement avec un tableau
structuré de messages avec rôles (`system`, `user`, `assistant`, `tool`). Les
macros sont résolues, le lorebook et la mémoire sont insérés, le décalage de
contexte retire l'excédent et les intercepteurs de plugins modifient ce
tableau. Le rendu a lieu exactement une fois, à l'étape de rendu, donc aucun
adaptateur ne reformate le prompt une seconde fois.

## Sortie Finale

L'étape de rendu produit l'une de deux formes :

- **Une chaîne** — le prompt rendu, envoyé aux fournisseurs de complétion de
  texte et utilisé pour les diagnostics.
- **JSON structuré** — le tableau `GenerationMessage[]`, envoyé aux
  fournisseurs de chat qui acceptent des messages balisés par rôle.

Le mode est sélectionné par `serializeAsText` : les adaptateurs de texte
(`text-completion`, `novelai`, `ai-horde`, `koboldai`) reçoivent toujours le
prompt d'instruction rendu comme un seul message `user` ; les adaptateurs de
chat (`openai-compatible`, `anthropic`) reçoivent le tableau structuré.

## Macros

`{{user}}`, `{{char}}` et les variables personnalisées sont résolus avant le
rendu final. Les macros ne sont jamais développées dans le moteur de modèles
lui-même, donc les fichiers de modèles restent du balisage pur.

## Formats Personnalisés et Presets

Le format personnalisé actif est stocké dans `AppSettings.instructFormat`.
Quand il est défini, le tableau de messages propre est rendu en une seule
chaîne et les chaînes d'arrêt du format deviennent les séquences d'arrêt de
la requête. Quand il vaut `null`, la sérialisation structurée native est
utilisée.

Les formats sont importés et exportés comme des **presets JSON versionnés** :

- `importInstructFormat()` valide le preset avant qu'il ne devienne actif ;
- `exportInstructFormat()` produit des valeurs séparées sûres pour le JSON ;
- les presets portent une version, donc les exports plus anciens peuvent être
  migrés à l'import.

## Voir Aussi

- [Étapes du pipeline](stages) pour savoir où le rendu se situe dans l'ordre
  des étapes.
- [Tokenisation](tokenization) pour savoir comment le contexte rendu est
  compté.
- [Fournisseurs](../providers/) pour savoir comment les adaptateurs
  consomment la sortie sérialisée.
