---
title: API backend des plugins
description: Les abstractions restreintes côté serveur qu'un plugin backend reçoit.
sidebar_position: 5
---

L'API backend est ce qu'un plugin côté serveur reçoit dans son appel
`activate()` : des abstractions restreintes pour les routes, le stockage, les
événements, la journalisation, l'accès réseau, les fournisseurs et les
fichiers — et rien d'autre.

## Point d'Entrée

Un plugin backend exporte une définition avec une fonction `activate(api)`
qui reçoit l'objet `ServerPluginApi` :

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const off = api.routes.get('/hello', async (request) => ({
      status: 200,
      body: { hello: 'world' },
    }));
  },
});
```

L'entrée backend s'exécute comme un processus Node.js séparé. Le plugin ne
reçoit jamais l'instance racine Fastify, la connexion SQLite, les tables
internes, les chemins absolus, l'environnement complet ni les clés API
d'autres fournisseurs.

## Routes

`api.routes` est un routeur limité monté sous
`/api/plugins/{pluginId}/`. Chaque méthode prend un chemin et un handler et
renvoie une fonction de nettoyage :

- `api.routes.get(path, handler)`
- `api.routes.post(path, handler)`
- `api.routes.put(path, handler)`
- `api.routes.delete(path, handler)`

Un `PluginRequest` porte `params`, `query`, `headers`, un `body` JSON parsé
et un `AbortSignal`. Un `PluginResponse` est `{ status, body, headers }`. Les
handlers peuvent renvoyer une valeur directement ou une promesse ; l'hôte
applique les délais et annule le travail via le signal.

## Stockage

`api.storage` est un magasin clé/valeur espacé par noms, isolé par plugin :

```ts
await api.storage.set('state', { count: 1 });
const state = await api.storage.get('state');
await api.storage.delete('state');
const keys = await api.storage.keys();
```

Les données sont limitées à votre ID de plugin, donc deux plugins ne peuvent
jamais entrer en collision.

## Événements et Journalisation

`api.events` est le même bus d'événements typé que le frontend utilise.
S'abonner renvoie une fonction de désinscription, et tous les abonnements
sont retirés automatiquement à la désactivation, au crash ou à l'arrêt.
L'émission est restreinte à votre propre espace de noms (`{pluginId}.event`),
les charges utiles doivent être sûres pour le JSON, et l'hôte plafonne la
taille des charges utiles et le nombre de noms d'événements par runtime.

`api.logger` fournit les méthodes `debug`, `info`, `warn` et `error`, chacune
prenant un message et des métadonnées facultatives. Les logs n'incluent
jamais de secrets.

## Fetch Vérifié par Permissions

`api.fetch` est un `fetch` gardé par les permissions `network:<host>` du
plugin :

```ts
const response = await api.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { Accept: 'application/json' },
  signal,
});
```

Les requêtes vers des hôtes non accordés sont rejetées avant toute activité
réseau. Les secrets d'autres fournisseurs ne sont jamais injectés dans vos
requêtes. L'objet de réponse expose `ok`, `status`, `text()` et `json()`.

## Fournisseurs et Stratégies de Contexte

`api.providers` permet à un plugin d'étendre la génération :

- `api.providers.register(kind, factory, options)` enregistre un nouveau
  type d'adaptateur de fournisseur (nécessite `providers.register`).
  L'enregistrement renvoie une fonction de nettoyage.
- `api.providers.registerTokenizer(profile)` enregistre un tokeniseur local
  spécifique au modèle. Un profil déclare `id`, `approximate`,
  `matches(model)` et `count(text)`. Des tokeniseurs exacts peuvent être
  construits depuis du JSON de tokeniseur tiktoken, SentencePiece ou Hugging
  Face ; jusqu'à ce qu'un soit enregistré pour un modèle, l'hôte retombe sur
  une heuristique consciente des écritures et marque les comptes comme
  approximatifs. L'enregistrement est retiré automatiquement à la
  désactivation.

`api.contextStrategies.register(strategy)` ajoute une stratégie de décalage
de contexte. L'hôte vérifie que les blocs système, épinglés et de
l'utilisateur actuel survivent, et applique lui-même le budget de jetons
final — la valeur `fitsBudget` qu'une stratégie renvoie n'est pas fiable.

`api.postProcessors.register(processor)` ajoute un hook de post-génération.
Il s'exécute après la fin du flux et avant l'enregistrement du message ;
renvoyer une nouvelle chaîne remplace la réponse de l'assistant. Il nécessite
`prompt.modify`.

## Système de Fichiers Virtuel

`api.files` est un système de fichiers virtuel en bac à sable ancré dans le
répertoire de données propre du plugin :

```ts
await api.files.write('notes.txt', 'contenu');
const content = await api.files.read('notes.txt');
const entries = await api.files.list('.');
await api.files.delete('notes.txt');
```

Les chemins ne peuvent pas s'échapper de la racine du plugin, donc un plugin
ne peut toucher que ses propres données.

## Ce Qu'un Plugin Backend Ne Peut Pas Faire

La surface d'API est délibérément petite. Il n'y a aucun moyen d'atteindre la
base de données de l'hôte, le stockage d'autres plugins, des chemins de
système de fichiers arbitraires ou des hôtes réseau non examinés. Si le SDK
ne l'expose pas, ce n'est pas accessible. La
[référence du Plugin SDK](../../api/plugin-sdk/) générée liste la surface
complète `ServerPluginApi`, et [Fournisseurs](../providers/index.md)
explique comment les plugins de fournisseurs s'intègrent au modèle.
