---
title: Visão Geral do Plugin SDK
description: O que é o Plugin SDK e como funciona a divisão entre as APIs de frontend e backend.
sidebar_position: 1
---

O Plugin SDK é a API pública versionada que plugins usam para estender o
NeoTavern, cobrindo tanto a interface no navegador quanto o backend no
servidor.

## O Que É o Plugin SDK

Plugins são pacotes ZIP (`.stplugin`) que trazem um manifesto, pontos de
entrada opcionais de frontend e backend, e ativos. Eles estendem o aplicativo
apenas pelo pacote `@neotavern/plugin-sdk` — nunca importando Fastify, React,
Zustand, TanStack Query, a conexão SQLite ou componentes internos
diretamente. Esses são detalhes de implementação do host e mudam sem aviso.

O SDK é versionado (`apiVersion` no manifesto) para que plugins continuem
funcionando entre atualizações do aplicativo. O host aplica o contrato: tudo o
que você registra pelo SDK é limpo quando seu plugin é desativado, e tudo o
que você precisaria dos módulos internos é deliberadamente não exposto.

## Divisão entre Frontend e Backend

Um plugin tem duas metades opcionais:

- **Frontend** — uma entrada ESM de navegador que recebe `FrontendPluginApi`
  em sua chamada `activate()`. Ela registra superfícies de interface como
  ações de barra de ferramentas, ações de mensagem, comandos de barra e
  painéis de configurações, e escuta eventos do aplicativo.
- **Backend** — uma entrada ESM Node.js que recebe `ServerPluginApi`. Ela
  monta rotas sob `/api/plugins/{pluginId}/`, lê e grava armazenamento
  isolado, faz chamadas de rede verificadas por permissões e registra
  provedores e estratégias de context shifting.

Ambas as metades são opcionais. Um plugin que só adiciona um botão de barra de
ferramentas não precisa de backend; um plugin que só serve uma API não precisa
de frontend. Cada registro retorna uma função de limpeza, e o runtime as
recolhe para que a desativação não deixe nada para trás.

## Escrevendo um Plugin

Importe `definePlugin` de `@neotavern/plugin-sdk` e exporte uma definição com uma
função `activate(api)`:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const unregister = api.ui.messageActions.register({
      id: 'example.greet',
      title: 'Greet',
      run: ({ message }) => console.log(message.messageId),
    });
    api.events.on('chat.opened', ({ chatId }) => console.log(chatId));
  },
});
```

A [Referência do Plugin SDK](../api/plugin-sdk/) gerada documenta cada tipo e
função exportados com sua assinatura exata.

## Próximos Passos

- [Manifesto](manifest.md) — estrutura do pacote e esquema de `plugin.json`.
- [Permissões](permissions.md) — o modelo de permissões e o fluxo de
  consentimento.
- [API de Frontend](frontend.md) — registro de superfícies de interface e
  eventos.
- [API de Backend](backend.md) — rotas, armazenamento e abstrações do servidor.
- [Ciclo de Vida](lifecycle.md) — instalação, ativação, desativação e garantias
  de limpeza.
- [Sandboxing](sandboxing.md) — o modelo de segurança para código não
  confiável.
