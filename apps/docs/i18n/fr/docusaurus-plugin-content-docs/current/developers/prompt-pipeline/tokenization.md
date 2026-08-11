---
title: Tokenisation
description: >-
  Comptage de jetons local via le registre de tokeniseurs : compatible
  tiktoken, SentencePiece, JSON Hugging Face, plugins spécifiques aux modèles
  et le repli approximatif.
sidebar_position: 4
---

Le comptage de jetons s'exécute localement via un registre de tokeniseurs qui
prend en charge les tokeniseurs compatibles tiktoken, SentencePiece, JSON
Hugging Face et spécifiques aux modèles via plugins, avec un repli
approximatif explicite.

## Comptage Local

Le comptage de jetons ne quitte jamais la machine. Le registre sélectionne un
profil de tokeniseur pour le modèle actif, et le pipeline compte le contexte
assemblé en processus avant toute requête réseau.

## Le Registre de Tokeniseurs

Le registre accepte quatre sortes de tokeniseurs :

- **Compatibles tiktoken** — des tokeniseurs BPE compatibles avec le tiktoken
  d'OpenAI, pour les familles de modèles OpenAI.
- **SentencePiece** — des modèles qui livrent des vocabulaires
  SentencePiece.
- **JSON de tokeniseur Hugging Face** — des fichiers `tokenizer.json` des
  dépôts Hugging Face, convertis en un format de rangs compact.
- **Plugins spécifiques aux modèles** — les plugins de fournisseurs peuvent
  enregistrer un profil de tokeniseur précis pour un modèle.

Un **repli approximatif** existe pour les modèles sans tokeniseur enregistré,
et il est toujours étiqueté explicitement, donc l'interface ne présente
jamais une estimation comme un compte exact.

## Profils Intégrés

Le cœur enregistre des profils hors ligne pour les familles courantes :

- `openai:o200k_base` — familles GPT-4o, GPT-4.1, GPT-5, o1, o3 et o4.
- `openai:cl100k_base` — GPT-4, GPT-3.5 Turbo et text-embedding-3.
- `deepseek:bytelevel-bpe-v1` — familles DeepSeek. Le comptage passe par un
  moteur compact dédié au comptage (un port de fusion BPE sans vocabulaire ni
  décodeur) sur les rangs du `tokenizer.json` officiel. Le fichier est
  converti une fois en un petit fichier de rangs mis en cache dans
  `data/cache/tokenizers/deepseek-v4-flash/` via des écritures atomiques
  temp-plus-rename ; le JSON complet et la bibliothèque de tokeniseur de
  runtime ne sont ni stockés ni chargés.

Si le réseau est indisponible, le profil DeepSeek retombe honnêtement sur le
profil approximatif et réessaie au plus une fois toutes les 15 minutes — un
tokeniseur manquant ne bloque jamais la génération.

## Repli Approximatif

Les modèles locaux inconnus utilisent `approximate-character-v1`, une
heuristique consciente des écritures : environ 4,6 caractères par jeton pour
le latin, 4,0 pour le cyrillique, 1,7 pour le CJK et 2,0 pour les chiffres.
L'approximation est signalée partout où elle apparaît, et un plugin de
fournisseur peut la remplacer à tout moment en enregistrant un profil précis.

## Profils de Plugins

Les plugins enregistrent des profils de tokeniseur avec une priorité. Un
profil de plugin avec une priorité supérieure à `-10` remplace le profil de
famille pour les modèles qu'il couvre. Le profil sélectionné est transmis au
pipeline comme `countTokens`, `tokenizerProfile` et
`tokenizerApproximate`.

## Le Résultat du Budget de Jetons

Après le comptage, le pipeline expose `PipelineResult.tokenBudget`, qui
contient :

- le profil de tokeniseur utilisé ;
- le drapeau `approximate` ;
- la limite de contexte du modèle ;
- l'espace de réponse réservé ;
- le compte final de jetons de prompt.

Consultez [Décalage de contexte](context-shifting) pour savoir comment le
budget est appliqué.
