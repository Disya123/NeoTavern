---
title: Vue d'ensemble des fournisseurs
description: >-
  Comment NeoTavern parle aux services LLM, TTS, STT et d'images via un
  seul contrat d'adaptateur.
sidebar_position: 1
---

Les fournisseurs sont la façon dont NeoTavern parle aux services IA externes :
modèles de langage, text-to-speech, speech-to-text et génération d'images.

## Un Seul Contrat d'Adaptateur

Chaque fournisseur — qu'il s'agisse d'un endpoint de chat compatible OpenAI,
d'une connexion Anthropic native, d'un backend communautaire comme NovelAI ou
KoboldAI, ou d'un service enregistré par un plugin — implémente le même
contrat `ProviderAdapter` de `@neotavern/provider-sdk`. Le pipeline central ne
connaît que ce contrat, donc l'application n'est liée à aucun fournisseur
unique.

Un adaptateur doit prendre en charge :

- La validation de la configuration.
- La liste des modèles disponibles.
- L'annulation via `AbortSignal`.
- Un flux d'événements de génération unifié.
- Des erreurs normalisées.
- Des délais.
- Une journalisation sans secrets.
- L'enregistrement via le Plugin SDK.

Comme le pipeline voit une seule forme quel que soit le fournisseur, des
fonctionnalités comme le streaming, le décalage de contexte et la gestion
des erreurs fonctionnent à l'identique sur tous les fournisseurs. Consultez
[Contrat d'adaptateur](adapter-contract.md) pour les exigences précises.

## Adaptateurs Livrés

La distribution livre des adaptateurs pour les endpoints compatibles OpenAI,
Anthropic, les endpoints de complétion de texte, NovelAI, KoboldAI, l'AI
Horde et un adaptateur écho local. Chacun est documenté dans
[Adaptateurs](adapters.md).

## Estimation Locale des Jetons

Le comptage de jetons est local et hors ligne. Des tokeniseurs exacts
(tiktoken, SentencePiece ou JSON de tokeniseur Hugging Face) peuvent être
enregistrés par modèle, y compris par les plugins de fournisseurs ; jusqu'à
ce qu'un tokeniseur exact soit enregistré, l'hôte utilise une heuristique
consciente des écritures et marque le compte comme approximatif.

## Étendre les Fournisseurs

Le cœur est délibérément exempt de dépendances aux SDK de fournisseurs. Les
nouveaux fournisseurs sont ajoutés en écrivant un adaptateur et en
l'enregistrant :

- Les fournisseurs du cœur s'enregistrent via le `ProviderRegistry` de
  `@neotavern/provider-sdk`.
- Les fournisseurs de plugins s'enregistrent via l'API backend du Plugin SDK
  (`api.providers.register(kind, factory)`), qui exige la permission
  `providers.register`. L'enregistrement renvoie une fonction de nettoyage et
  est retiré automatiquement quand le plugin se désactive.

C'est le chemin documenté pour un endpoint privé, un modèle auto-hébergé ou
un service sans adaptateur intégré. La
[référence du Provider SDK](../api/provider-sdk/) générée documente le
contrat complet.
