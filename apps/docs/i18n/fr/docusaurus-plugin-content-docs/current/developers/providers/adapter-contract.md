---
title: Contrat d'adaptateur
description: Ce que chaque adaptateur de fournisseur doit implémenter, de la validation aux délais.
sidebar_position: 2
---

Le contrat d'adaptateur est le contrat que chaque fournisseur LLM, TTS, STT
et d'images implémente. Si vous écrivez un adaptateur qui le satisfait, tout
le pipeline fonctionne avec votre fournisseur.

## L'Interface

L'interface `ProviderAdapter` a un `kind` stable, des déclarations de
modalités facultatives et les méthodes requises. La génération de texte est
la capacité de base ; les méthodes de parole, d'image et de transcription
sont facultatives, donc un adaptateur uniquement LLM est toujours un
fournisseur valide.

```ts
interface ProviderAdapter {
  readonly kind: string;
  readonly modalities?: readonly ProviderModality[];
  readonly capabilities?: {
    assistantPrefill?: boolean;
    textCompletion?: boolean;
  };
  validateConfig(): Promise<ValidationResult>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  speech?(request: SpeechRequest, signal: AbortSignal): AsyncIterable<SpeechEvent>;
  image?(request: ImageRequest, signal: AbortSignal): AsyncIterable<ImageEvent>;
  transcribe?(request: TranscriptionRequest, signal: AbortSignal): Promise<TranscriptionResult>;
  countTokens?(request: TokenCountRequest): Promise<TokenCount>;
}
```

## Comportement Requis

Le contrat exige huit comportements :

- **Validation de la configuration** — `validateConfig()` vérifie la propre
  configuration de l'adaptateur sans faire d'appels réseau et renvoie une
  liste de problèmes.
- **Liste des modèles** — `listModels(signal)` renvoie les modèles
  disponibles et doit respecter le signal d'abandon.
- **Annulation** — chaque méthode longue reçoit un `AbortSignal` et doit
  abandonner rapidement quand il se déclenche.
- **Flux d'événements unifié** — `generate()` produit un flux d'
  `GenerationEvent` typés et doit se terminer avec exactement un événement
  terminal, `done` ou `error`. La génération de parole et d'images utilise la
  même forme de streaming.
- **Normalisation des erreurs** — les échecs de fournisseur sont mappés à des
  codes `AppError` stables avec des codes lisibles par machine et des
  paramètres. Les statuts HTTP amont sont différenciés (auth, limite de
  débit, mauvais modèle, erreur serveur), et les corps bruts amont ne sont
  jamais transmis aux clients.
- **Délais** — un adaptateur ne doit pas compter uniquement sur le signal de
  l'appelant. Il a besoin de ses propres échéances pour la connexion, le
  silence de streaming inactif et les lectures complètes de réponse. Le SDK
  livre `ProviderTimeouts` (valeurs par défaut : 30 s de connexion, 60 s
  d'inactivité, 30 s de lecture) et un `DeadlineController` qui combine le
  signal de l'appelant avec des échéances réarmables et abandonne avec une
  erreur `TIMEOUT`.
- **Journalisation sûre** — la clé API est fournie depuis un stockage
  sécurisé et ne doit jamais être journalisée, ni incluse dans les
  diagnostics ou la sortie d'erreur.
- **Enregistrement** — les adaptateurs sont enregistrés par type, soit dans
  le registre central, soit via l'API backend du Plugin SDK.

## Neutralité envers les Fournisseurs

Le cœur n'est lié au SDK d'aucun fournisseur. Les nouveaux adaptateurs sont
censés utiliser le `fetch` global et le parseur SSE du SDK
(`parseSseStream`) pour les réponses en streaming.

Il y a exactement une exception documentée : l'adaptateur Anthropic utilise
`@anthropic-ai/sdk`, car l'API Anthropic — pensée étendue et prise en charge
des en-têtes bêta — est traitée plus précisément par le SDK officiel que par
un client fetch écrit à la main. C'est le seul adaptateur câblé à une
bibliothèque de fournisseur ; tout le reste parle HTTP directement.

## Intégration à l'Hôte

Le `ProviderRegistry` mappe les types de fournisseurs aux fabriques
d'adaptateurs. `register` renvoie une fonction de désenregistrement, `create`
instancie un adaptateur et lève `PROVIDER_NOT_FOUND` pour les types inconnus,
et le registre héberge aussi le registre de tokeniseurs local. Les capacités
de câblage déclarées comme `assistantPrefill` sont utilisées pour valider les
profils de connexion — l'hôte ne supprime jamais silencieusement un
remplacement de profil persistant qu'un adaptateur ne prend pas en charge.

Pour les vrais adaptateurs livrés et ce que chacun cible, consultez
[Adaptateurs](adapters.md). Pour enregistrer un adaptateur depuis un plugin,
consultez l'[API backend du Plugin SDK](../plugin-sdk/backend.md).
