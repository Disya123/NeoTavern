---
title: Adaptateurs livrés
description: Les adaptateurs de fournisseurs livrés avec NeoTavern et ce que chacun cible.
sidebar_position: 3
---

NeoTavern livre un ensemble d'adaptateurs de fournisseurs prêts à l'emploi.
Ils vivent dans `packages/provider-sdk/src/adapters/`, un fichier par
adaptateur, et sont enregistrés dans le `ProviderRegistry` central par leur
type de fournisseur.

## Compatible OpenAI

Fichier : `openaiCompatible.ts` — type `openai-compatible`.

Cible tout serveur exposant l'API OpenAI `/v1/chat/completions` et
`/v1/models` : OpenAI lui-même, OpenRouter, LM Studio, le serveur llama.cpp,
Ollama avec l'endpoint `/v1`, vLLM et autres. Il n'utilise que le `fetch`
global et le parseur SSE du SDK ; la clé API est envoyée mais jamais
journalisée.

## Anthropic

Fichier : `anthropic.ts` — type `anthropic`.

Cible l'API Messages native d'Anthropic. C'est l'unique exception documentée
à la règle sans SDK de fournisseur : il utilise `@anthropic-ai/sdk` car
l'API — pensée étendue et prise en charge des en-têtes bêta — est traitée
plus précisément par le SDK officiel. Il prend en charge la mise en cache de
prompt et la pensée adaptative et déclare la capacité de câblage
`assistantPrefill`.

## Complétion de Texte

Fichier : `textCompletion.ts` — type `text-completion`.

Cible les backends locaux ou auto-hébergés qui exposent l'ancien endpoint
OpenAI `/v1/completions` : text-generation-webui (« ooba »), koboldcpp, vLLM,
Ollama, le serveur llama.cpp et autres. Contrairement aux adaptateurs de
chat, il consomme un prompt sérialisé : le pipeline de prompts rend le format
d'instruction et donne à l'adaptateur un seul message utilisateur dont le
contenu est le prompt terminé, et l'adaptateur le poste vers `/completions`.
La clé API est facultative pour les serveurs locaux et jamais journalisée.

## NovelAI

Fichier : `novelai.ts` — type `novelai`.

Cible l'API de génération de texte NovelAI (`POST {baseUrl}/ai/generate`
avec une clé Bearer). La génération n'est pas en streaming — un seul `delta`
plus l'événement terminal `done`, conformément au contrat de flux unifié. La
découverte de modèles n'est pas proposée par l'API, donc `listModels`
renvoie le modèle configuré. L'adaptateur est marqué expérimental parce que
la surface de paramètres de NovelAI évolue ; seuls les échantillonneurs bien
établis sont mappés.

## KoboldAI

Fichier : `koboldai.ts` — type `koboldai`.

Cible l'API native du serveur KoboldAI/Kobold
(`POST {baseUrl}/api/v1/generate`). La génération n'est pas en streaming ; le
modèle chargé est lu depuis `/api/v1/model` pour la découverte. Les
installations locales typiques n'ont besoin d'aucune clé API.

## AI Horde

Fichier : `aiHorde.ts` — type `ai-horde`.

Cible l'AI Horde (`stablehorde.net`), un cluster asynchrone crowdsourcé. Un
job est soumis avec `/api/v2/generate/text/async`, puis interrogé via
l'endpoint de statut jusqu'à la fin ; la boucle d'interrogation revérifie le
signal de l'appelant et une échéance d'inactivité, donc un job bloqué
abandonne au lieu d'interroger indéfiniment. L'utilisation anonyme est
autorisée à priorité plus basse ; une clé API est envoyée comme en-tête
`apikey` quand elle est configurée.

## Echo

Fichier : `echo.ts` — type `echo`.

Un fournisseur entièrement hors ligne utilisé pour les tests, les
démonstrations et la vérification du pipeline de streaming sans aucun réseau
ni clé API. Il renvoie le dernier message utilisateur en streaming, mot par
mot. Il implémente aussi les méthodes facultatives de parole, d'image et de
transcription, ce qui en fait une référence utile pour écrire un adaptateur
qui couvre chaque modalité.

## Helper de Prompt

Fichier : `prompt.ts` — exporte `promptFromMessages`, un helper partagé qui
sérialise les tableaux de messages dans les formes de prompt que les
adaptateurs envoient. Ce n'est pas un adaptateur en soi.

Pour l'interface `ProviderAdapter` exacte que tous ces adaptateurs
implémentent, consultez [Contrat d'adaptateur](adapter-contract.md) et la
[référence du Provider SDK](../../api/provider-sdk/) générée.
