---
title: Arquitetura
description: >-
  Visão geral da seção de arquitetura: o layout do monorepo, a stack de
  tecnologias aprovada e as responsabilidades de cada pacote.
sidebar_position: 1
---

Esta seção explica como o monorepo do NeoTavern é organizado, quais tecnologias
ele usa e como o servidor, o cliente web e o shell de desktop se encaixam.

## Páginas Nesta Seção

- [Visão Geral do Monorepo](architecture/overview) — o layout de `apps/` e `packages/`, o
  fluxo de dados entre servidor e web e o princípio local-first.
- [Stack de Tecnologias](architecture/stack) — a stack aprovada: Node.js 24, Fastify 5,
  React 19, Vite 8, SQLite, Drizzle, Tauri 2 e workspaces pnpm.
- [Pacotes](architecture/packages) — a responsabilidade de cada pacote do workspace e a
  direção das dependências entre eles.

## Seções Relacionadas

A seção [Pipeline de Prompt](prompt-pipeline/) descreve as etapas de geração
em detalhes, e [Dados e Armazenamento](data/) documenta o banco de dados, o
tratamento de arquivos e os backups.
