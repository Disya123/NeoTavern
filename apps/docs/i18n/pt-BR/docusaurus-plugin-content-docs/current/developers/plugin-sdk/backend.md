---
title: API de Backend do Plugin
description: As abstrações restritas do lado do servidor que um plugin de backend recebe.
sidebar_position: 5
---

A API de backend é o que um plugin do lado do servidor recebe em sua chamada
`activate()`: abstrações restritas para rotas, armazenamento, eventos,
logging, acesso à rede, provedores e arquivos — e nada mais.

## Ponto de Entrada

Um plugin de backend exporta uma definição com uma função `activate(api)` que
recebe o objeto `ServerPluginApi`:

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

A entrada de backend roda como um processo Node.js separado. O plugin nunca
recebe a instância raiz do Fastify, a conexão SQLite, tabelas internas,
caminhos absolutos, o ambiente completo ou as chaves de API de outros
provedores.

## Rotas

`api.routes` é um roteador com escopo montado sob
`/api/plugins/{pluginId}/`. Cada método recebe um caminho e um handler e
retorna uma função de limpeza:

- `api.routes.get(path, handler)`
- `api.routes.post(path, handler)`
- `api.routes.put(path, handler)`
- `api.routes.delete(path, handler)`

Um `PluginRequest` carrega `params`, `query`, `headers`, um `body` JSON
analisado e um `AbortSignal`. Um `PluginResponse` é `{ status, body, headers }`.
Handlers podem retornar um valor diretamente ou uma promise; o host aplica
timeouts e cancela o trabalho por meio do sinal.

## Armazenamento

`api.storage` é um armazenamento de chave/valor com namespace, isolado por
plugin:

```ts
await api.storage.set('state', { count: 1 });
const state = await api.storage.get('state');
await api.storage.delete('state');
const keys = await api.storage.keys();
```

Os dados têm escopo do seu id de plugin, de modo que dois plugins nunca podem
colidir.

## Eventos e Logging

`api.events` é o mesmo barramento de eventos tipado que o frontend usa.
Inscrever-se retorna uma função de cancelamento de inscrição, e todas as
inscrições são removidas automaticamente na desativação, em uma falha ou no
encerramento. Emitir é restrito ao seu próprio namespace (`{pluginId}.event`),
os payloads devem ser seguros para JSON, e o host limita o tamanho do payload
e o número de nomes de eventos por runtime.

`api.logger` fornece métodos `debug`, `info`, `warn` e `error`, cada um
recebendo uma mensagem e metadados opcionais. Logs nunca incluem segredos.

## Fetch Verificado por Permissões

`api.fetch` é `fetch` protegido pelas permissões `network:<host>` do plugin:

```ts
const response = await api.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { Accept: 'application/json' },
  signal,
});
```

Requisições a hosts não concedidos são rejeitadas antes de qualquer atividade
de rede. Segredos de outros provedores nunca são injetados em suas
requisições. O objeto de resposta expõe `ok`, `status`, `text()` e `json()`.

## Provedores e Estratégias de Contexto

`api.providers` permite que um plugin estenda a geração:

- `api.providers.register(kind, factory, options)` registra um novo tipo de
  adaptador de provedor (exige `providers.register`). O registro retorna uma
  função de limpeza.
- `api.providers.registerTokenizer(profile)` registra um tokenizador local
  específico de modelo. Um perfil declara `id`, `approximate`,
  `matches(model)` e `count(text)`. Tokenizadores exatos podem ser construídos
  a partir de tiktoken, SentencePiece ou tokenizer JSON do Hugging Face; até
  que um seja registrado para um modelo, o host recorre a uma heurística
  ciente de scripts e marca as contagens como aproximadas. O registro é
  removido automaticamente na desativação.

`api.contextStrategies.register(strategy)` adiciona uma estratégia de context
shifting. O host verifica que blocos do sistema, fixados e do usuário atual
sobrevivem, e aplica o orçamento final de tokens ele mesmo — o valor
`fitsBudget` que uma estratégia retorna não é confiável.

`api.postProcessors.register(processor)` adiciona um hook de pós-geração. Ele
roda depois que o stream termina e antes de a mensagem ser salva; retornar uma
nova string substitui a resposta do assistente. Exige `prompt.modify`.

## Sistema de Arquivos Virtual

`api.files` é um sistema de arquivos virtual em sandbox com raiz no diretório
de dados do próprio plugin:

```ts
await api.files.write('notes.txt', 'content');
const content = await api.files.read('notes.txt');
const entries = await api.files.list('.');
await api.files.delete('notes.txt');
```

Caminhos não podem escapar da raiz do plugin, de modo que um plugin só pode
tocar seus próprios dados.

## O Que um Plugin de Backend Não Pode Fazer

A superfície da API é deliberadamente pequena. Não há como alcançar o banco de
dados do host, o armazenamento de outros plugins, caminhos arbitrários do
sistema de arquivos ou hosts de rede não verificados. Se o SDK não expõe, não
é acessível. A [Referência do Plugin SDK](../../api/plugin-sdk/) gerada lista a
superfície completa de `ServerPluginApi`, e [Provedores](../providers/index.md)
explica como plugins de provedores se encaixam no modelo.
