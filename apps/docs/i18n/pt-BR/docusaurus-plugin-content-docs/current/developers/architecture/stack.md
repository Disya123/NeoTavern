---
title: Stack de Tecnologias
description: >-
  A stack aprovada do NeoTavern: Node.js 24, Fastify 5, React 19, Vite 8,
  TypeScript estrito, SQLite com Drizzle e Tauri 2.
sidebar_position: 3
---

O NeoTavern roda em uma stack deliberadamente convencional: Node.js 24 LTS,
Fastify 5, React 19, Vite 8, TypeScript estrito, SQLite com Drizzle ORM e um
shell de desktop Tauri 2.

## Runtime e Linguagem

- **Node.js 24 LTS** — o runtime do backend e do sidecar de desktop incluído. O
  código permanece compatível com Node.js 22 onde for prático.
- **TypeScript estrito** — ativado em todo lugar. `any` injustificado,
  `as unknown as`, `@ts-ignore` e asserções não nulas são proibidos. Fronteiras
  de sistema usam `unknown` e validação explícita.
- **Somente ESM** — todos os aplicativos e pacotes usam módulos ES.

## Backend

- **Fastify 5** — o framework de API. Cada módulo do backend é um plugin
  Fastify isolado.
- **TypeBox + Fastify Type Provider** — cada entrada e saída de API tem um JSON
  Schema, gerado de `@neotavern/contracts`.
- **SSE** — a geração em streaming roda sobre Server-Sent Events. WebSocket
  fica reservado para canais bidirecionais reais.
- **AbortSignal** — toda operação longa aceita um `AbortSignal` e expira limpo
  quando o cliente desconecta.

## Frontend

- **React 19** — um aplicativo de página única, sem renderização no servidor.
- **Vite 8** — o bundler e servidor de desenvolvimento. O Vite é apenas
  ferramenta de build, não uma API de plugin de aplicativo.
- **React Router** — roteamento, com um único workspace de chat e superfícies
  do sistema renderizadas sobre ele.
- **TanStack Query** — o único store para estado do servidor.
- **Zustand** — apenas estado transitório de interface: o painel ativo,
  preferências de tema e idioma, o personagem fixado e rascunhos limitados à
  sessão.
- **Radix Primitives** — componentes headless acessíveis envolvidos por
  `@neotavern/ui`.

## Dados

- **SQLite via better-sqlite3** — o único arquivo de banco de dados, aberto com
  WAL, `foreign_keys = ON`, `busy_timeout` e instruções preparadas.
- **Drizzle ORM** — esquema tipado, repositórios e migrações.
- **FTS5** — pesquisa de texto completo sobre personagens, chats e mensagens.

## Estilo

- **CSS Modules + custom properties + camadas em cascata + container queries** —
  o kit de ferramentas de estilo. Temas sobrescrevem tokens de design e regras
  de camada sem brigar com especificidade.

## Templates e Localização

- **Handlebars** — modelos de formato de instrução, renderizados em um ambiente
  com sandbox sem acesso a sistema de arquivos ou execução de código.
- **i18next** — todas as strings voltadas ao usuário, com namespaces e recursos
  por localidade.

## Desktop

- **Tauri 2** — o shell de desktop, com o servidor Node.js distribuído como
  binário sidecar autocontido.
- **tauri-plugin-shell e tauri-plugin-updater** — gerenciamento de processos e
  atualizações assinadas.

## Ferramentas

- **pnpm workspaces** — o gerenciador de pacotes do monorepo.
- **Vitest** — testes unitários e de integração.
- **Playwright** — testes de ponta a ponta, incluindo smoke tests do shell de
  desktop.

## O Que Está Deliberadamente Ausente

- Sem PostgreSQL, Redis, Docker ou qualquer outro serviço que você precise
  instalar ou executar.
- Sem SSR ou servidor Node para o frontend além do processo de API.
- Sem `node:vm` como sandbox de segurança para plugins — plugins de backend não
  confiáveis rodam em um processo restrito separado.

Veja [Visão Geral do Monorepo](overview) para entender como as peças se
encaixam e [Pacotes](packages) para saber quem é dono do quê.
