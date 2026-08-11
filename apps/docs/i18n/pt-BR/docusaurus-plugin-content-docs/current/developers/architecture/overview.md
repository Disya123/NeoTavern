---
title: Visão Geral do Monorepo
description: >-
  O layout do monorepo do NeoTavern, o fluxo de dados entre servidor e web e
  o princípio local-first que molda a arquitetura.
sidebar_position: 2
---

O NeoTavern é um aplicativo local-first: um único processo Fastify serve a API
e o frontend construído opcional, sem bancos de dados externos, filas ou
contêineres.

## Layout do Monorepo

O workspace é um monorepo pnpm com dois grupos de nível superior, `apps/` e
`packages/`:

```text
apps/
  server/          # Backend Fastify: API, pipeline de prompt, SSE, host legado
  web/             # SPA React
  plugin-runtime/  # Processo Node.js restrito para plugins de backend
  desktop/         # Shell Tauri 2; executa o servidor como processo sidecar
packages/
  shared/        # IDs UUIDv7, Result, erros, logger, utilitários assíncronos
  contracts/     # Esquemas de API TypeBox — fonte única de verdade
  db/            # SQLite: esquema, migrações, repositórios, FTS5
  ui/            # Componentes headless sobre primitivas Radix
  i18n/          # Configuração do i18next e recursos de idioma
  plugin-sdk/    # Manifesto de plugin, permissões e contratos de API
  theme-sdk/     # Tokens de tema, níveis e herança
  provider-sdk/  # Contrato de adaptador de provedor e adaptadores
  legacy-compat/ # Globais de window e ilhas de compatibilidade DOM
  gestures/      # Gestos de linha agnósticos de framework
  plugin-build/  # Pipeline de build e publicação de plugins
```

## Aplicativos

- `apps/server` — o backend Fastify. Ele expõe a API `/api/v2/*`, executa o
  pipeline de prompt, transmite geração via SSE e hospeda a superfície legada
  compatível com Express. Cada módulo é um plugin Fastify isolado.
- `apps/web` — a SPA React. Ela conversa com o servidor via HTTP e renderiza o
  workspace de chat, além das superfícies de personagens, configurações,
  provedores, temas e plugins.
- `apps/plugin-runtime` — um processo Node.js com permissões limitadas no qual
  plugins de backend não confiáveis são executados, isolado do processo
  principal do servidor.
- `apps/desktop` — o shell Tauri 2. Ele inicia o servidor compilado como um
  sidecar Node.js autocontido e abre o webview apenas quando a API local está
  pronta.

## Pacotes

Código compartilhado vive em pacotes com escopo restrito sob `packages/`. Cada
pacote tem uma única responsabilidade, e dependências apontam apenas para
baixo: `server` e `web` dependem de pacotes, e pacotes dependem no máximo de
`shared` e `contracts`. Veja [Packages](packages) para o detalhamento completo.

## Fluxo de Dados

Uma solicitação típica flui por estas camadas:

1. O frontend chama um endpoint `/api/v2/*` pelo TanStack Query.
2. O Fastify valida a entrada contra um esquema TypeBox e retorna erros no
   envelope `{ code, params, traceId }`.
3. Repositórios em `@neotavern/db` leem e gravam no SQLite, com paginação por cursor
   e busca FTS5.
4. A geração executa `POST /api/v2/chats/:id/generate`: o pipeline de prompt
   monta o contexto, o adaptador de provedor serializa a solicitação, a
   resposta chega em streaming via SSE e a mensagem é salva.

O aplicativo web é uma única página: as rotas mudam o workspace de chat,
enquanto personagens, configurações, provedores, temas e plugins renderizam em
uma superfície de diálogo sobre a posição preservada do chat.

## Princípio Local-First

Tudo roda na sua máquina:

- O backend vincula-se a `127.0.0.1` por padrão. Acesso remoto é um
  consentimento explícito com sessões limitadas e exigências de HTTPS.
- Todos os dados ficam em um único diretório de dados local: um banco SQLite
  mais um armazenamento de arquivos endereçado por conteúdo. Sem PostgreSQL,
  Redis ou Docker.
- O aplicativo funciona offline. Chamadas de provedor são o único tráfego de
  rede, e o adaptador `echo` integrado permite testar todo o pipeline sem
  nenhum provedor.
- Backups, exportações e a importação do SillyTavern acontecem localmente pelas
  mesmas APIs de SQLite e arquivos.

Veja [Dados e Armazenamento](../data/) para a camada de armazenamento e
[Pipeline de Prompt](../prompt-pipeline/) para o caminho de geração.
