---
title: Desenvolvedores
description: >-
  Visão geral da documentação para desenvolvedores do NeoTavern: arquitetura,
  o pipeline de prompt, a camada de dados e os SDKs para estender o aplicativo.
sidebar_position: 1
---

Esta seção explica como o NeoTavern é construído e como você pode estendê-lo
com plugins, temas e adaptadores de provedor.

## O Que Esta Seção Cobre

A documentação para desenvolvedores é dividida em quatro grupos:

- **Arquitetura** — o layout do monorepo, a stack de tecnologias aprovada e a
  responsabilidade de cada pacote do workspace.
- **Pipeline de prompt** — o conjunto fixo de etapas que transforma um chat em
  uma solicitação de provedor, incluindo formatos de instrução, tokenização e
  context shifting.
- **Dados e Armazenamento** — como o NeoTavern armazena dados estruturados em
  SQLite, como arquivos e imagens são tratados no disco e como funcionam os
  backups.
- **Estendendo o NeoTavern** — o Plugin SDK, o Theme SDK, adaptadores de
  provedor, a referência de API gerada e o shell de desktop.

## Por Onde Começar

Comece pela [Visão Geral da Arquitetura](developers/architecture/) se quiser entender o
formato do código, ou vá direto ao [Pipeline de Prompt](developers/prompt-pipeline/) se
estiver trabalhando no comportamento de geração.

## Camada de Dados

A seção [Dados e Armazenamento](developers/data/) cobre o banco de dados SQLite, o layout
do sistema de arquivos e o modelo de backups. É a referência para qualquer
coisa que persiste dados.

## Estendendo o NeoTavern

O NeoTavern é estendido de quatro formas:

- [Plugin SDK](developers/plugin-sdk/) — plugins com manifesto, permissões, APIs de
  frontend e backend, ganchos de ciclo de vida e sandbox.
- [Theme SDK](developers/theme-sdk/) — temas construídos com tokens de design, skins de
  componentes e layouts de shell.
- [Provedores](developers/providers/) — adaptadores de provedor que implementam o contrato
  unificado de adaptador.
- [Compatibilidade legada](developers/legacy-compat) — a camada de compatibilidade para
  plugins e scripts da era SillyTavern.

A [Referência de API](api/) é gerada das fontes dos SDKs pelo TypeDoc a cada
build do site, então suas páginas de membros sempre correspondem aos pacotes
publicados.

## Desktop

A seção [Desktop](developers/desktop/) documenta o shell Tauri 2, o sidecar Node.js e como
instaladores e versões portáteis são empacotados.
