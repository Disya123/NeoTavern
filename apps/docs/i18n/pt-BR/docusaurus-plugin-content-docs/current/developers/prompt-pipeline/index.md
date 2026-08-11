---
title: Pipeline de Prompt
description: >-
  Visão geral do pipeline de prompt: a ordem fixa de estágios, formatos
  instruct, contagem local de tokens e context shifting.
sidebar_position: 1
---

O pipeline de prompt é o conjunto fixo e ordenado de estágios que transforma
um chat em uma requisição ao provedor, da entrada do usuário à mensagem
salva.

## O Que o Pipeline Faz

Toda geração — uma nova mensagem, um swipe, uma regeneração ou uma
impersonação — passa pelos mesmos estágios na mesma ordem. O pipeline monta o
contexto a partir do personagem, da persona, do lorebook e da memória, conta
tokens, ajusta o contexto ao orçamento do modelo, permite interceptação por
plugins, renderiza a requisição no formato instruct selecionado e, por fim,
transmite e salva a resposta.

## Páginas Nesta Seção

- [Estágios do Pipeline](prompt-pipeline/stages) — os 14 estágios em ordem e as regras que
  todo hook de plugin deve seguir.
- [Formatos Instruct](prompt-pipeline/instruct-formats) — como o array limpo de mensagens é
  renderizado com templates Handlebars em sandbox.
- [Tokenização](prompt-pipeline/tokenization) — o registro local de tokenizadores e seu
  fallback aproximado.
- [Context Shifting](prompt-pipeline/context-shifting) — como o pipeline ajusta o contexto ao
  orçamento de tokens e quais estratégias existem.

## Implementação

O pipeline vive em `apps/server/src/pipeline/`. Ele é executado inteiramente
no servidor, antes de qualquer chamada de rede, de modo que a requisição que
chega a um provedor é sempre o resultado dos mesmos estágios determinísticos.

## Seções Relacionadas

- Os interceptadores de plugins e suas APIs de registro estão documentados no
  [Plugin SDK](plugin-sdk/).
- O endpoint de geração e a auditoria de contexto fazem parte da
  [Referência da API](../api/).
- Os adaptadores de provedores que consomem a requisição serializada estão
  documentados em [Provedores](providers/).
