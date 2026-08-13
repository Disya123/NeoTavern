---
title: Backend Plugin API
description: The restricted server-side abstractions a backend plugin receives.
sidebar_position: 5
---

The backend API is what a server-side plugin receives in its `activate()`
call: restricted abstractions for routes, storage, events, logging,
network access, providers, and files — and nothing else.

## Entry Point

A backend plugin exports a definition with an `activate(api)` function that
receives the `ServerPluginApi` object:

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

The backend entry runs as a separate Node.js process. The plugin never
receives the Fastify root instance, the SQLite connection, internal tables,
absolute paths, the full environment, or other providers' API keys.

## Routes

`api.routes` is a scoped router mounted under
`/api/plugins/{pluginId}/`. Each method takes a path and a handler and
returns a cleanup function:

- `api.routes.get(path, handler)`
- `api.routes.post(path, handler)`
- `api.routes.put(path, handler)`
- `api.routes.delete(path, handler)`

A `PluginRequest` carries `params`, `query`, `headers`, a parsed JSON `body`,
and an `AbortSignal`. A `PluginResponse` is `{ status, body, headers }`.
Handlers may return a value directly or a promise; the host enforces timeouts
and cancels work through the signal.

## Storage

`api.storage` is a namespaced key/value store isolated per plugin:

```ts
await api.storage.set('state', { count: 1 });
const state = await api.storage.get('state');
await api.storage.delete('state');
const keys = await api.storage.keys();
```

Data is scoped to your plugin id, so two plugins can never collide.

## Storage Quotas

Namespaced state is quota-enforced (ТЗ §54, SDK `limits.storage` defaults):

- `kvBytes` — the serialized state may not exceed **1 MiB** (UTF-8 length);
- `kvKeys` — the state may not exceed **4096 top-level keys**.

A write that exceeds either limit is rejected with the stable
`STATE_QUOTA_EXCEEDED` error (HTTP 413, `params: { limitBytes, limitKeys,
keys, bytes }`). Existing rows are never affected by a rejected write — the
quota applies per write. Blobs are capped separately (8 MiB per blob, 64
blobs per plugin).

## Plugin Secrets

Sensitive material is stored through the scoped SecretStore API — never in
`api.storage` state (ТЗ §54: plugin secrets are stored only through the
SecretStore and never enter namespaced backup/export state):

```ts
await api.secrets.set('apiKey', '…'); // write-only
const { key, masked } = await api.secrets.get('apiKey'); // masked preview
await api.secrets.delete('apiKey');
```

Secret values are **write-only**: list responses return keys, metadata and a
masked preview, never the plaintext. The plaintext is returned only by the
dedicated reveal operation, and only when secrets exposure is enabled
server-side (`NEOTA_ALLOW_SECRETS_EXPOSURE`, default off) plus the
`secrets.reveal` capability grant. Secrets never appear in plugin state,
logs, diagnostics, or namespaced backup/export sections, and are deleted with
the plugin. The capability catalog grants `secrets.manageOwn` for managing
your own store and `secrets.reveal` for reading a plaintext.

## Backup and Export Policy

Manual backups (POST `/api/v2/backups`) store the full SQLite snapshot and,
additionally, an additive optional `<id>.plugin-namespaces.json` sidecar whose
`pluginNamespaces` section carries per-plugin namespaced state (`scope`,
`ownerId`, `schemaVersion`, `revision`, `data`) — **state only, secrets
never**. The sidecar is self-describing and unknown-section tolerant: future
sections are ignored. Restore applies the section with a conflict-skip
policy: a row whose (plugin, scope, owner) identity already exists is kept —
a backup never clobbers existing state. Deleting a plugin deletes its
namespaced state, capabilities and secrets with it (cascade); uninstalled
plugins contribute nothing to backups.

## Events and Logging

`api.events` is the same typed event bus the frontend uses. Subscribing
returns an unsubscribe function, and all subscriptions are removed
automatically on disable, crash, or shutdown. Emitting is restricted to your
own namespace (`{pluginId}.event`), payloads must be JSON-safe, and the host
caps payload size and the number of event names per runtime.

`api.logger` provides `debug`, `info`, `warn`, and `error` methods, each
taking a message and optional metadata. Logs never include secrets.

## Permission-Checked Fetch

`api.fetch` is `fetch` guarded by the plugin's `network:<host>` permissions:

```ts
const response = await api.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { Accept: 'application/json' },
  signal,
});
```

Requests to hosts that are not granted are rejected before any network
activity. Secrets from other providers are never injected into your requests.
The response object exposes `ok`, `status`, `text()`, and `json()`.

## Providers and Context Strategies

`api.providers` lets a plugin extend generation:

- `api.providers.register(kind, factory, options)` registers a new provider
  adapter kind (requires `providers.register`). Registration returns a
  cleanup function.
- `api.providers.registerTokenizer(profile)` registers a local
  model-specific tokenizer. A profile declares `id`, `approximate`,
  `matches(model)`, and `count(text)`. Exact tokenizers can be built from
  tiktoken, SentencePiece, or Hugging Face tokenizer JSON; until one is
  registered for a model, the host falls back to a script-aware heuristic
  and marks counts as approximate. Registration is removed automatically on
  deactivate.

`api.contextStrategies.register(strategy)` adds a context-shifting strategy.
The host verifies that system, pinned, and current-user blocks survive, and
applies the final token budget itself — the `fitsBudget` value a strategy
returns is not trusted.

`api.postProcessors.register(processor)` adds a post-generation hook. It runs
after the stream completes and before the message is saved; returning a new
string replaces the assistant reply. It requires `prompt.modify`.

## Virtual Filesystem

`api.files` is a sandboxed virtual filesystem rooted at the plugin's own data
directory:

```ts
await api.files.write('notes.txt', 'content');
const content = await api.files.read('notes.txt');
const entries = await api.files.list('.');
await api.files.delete('notes.txt');
```

Paths cannot escape the plugin root, so a plugin can only ever touch its own
data.

## What a Backend Plugin Cannot Do

The API surface is deliberately small. There is no way to reach the host
database, other plugins' storage, arbitrary filesystem paths, or unvetted
network hosts. If the SDK does not expose it, it is not accessible. The
generated [Plugin SDK reference](../../api/plugin-sdk/) lists the full
`ServerPluginApi` surface, and [Providers](../providers/index.md) explains
how provider plugins fit into the model.
