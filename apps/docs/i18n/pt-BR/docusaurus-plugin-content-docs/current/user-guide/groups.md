---
title: Grupos
description: Como o NeoTavern lida com conversas de vários personagens e chats em grupo.
sidebar_position: 4
---

Esta página explica o que são grupos e como o NeoTavern lida com conversas de
vários personagens hoje.

## O Que É um Grupo

Um grupo é uma única conversa da qual vários personagens participam. Enquanto
um chat comum tem um personagem mais sua persona, um chat em grupo alterna
entre personagens para que cada resposta possa vir de um participante
diferente.

## Grupos no NeoTavern Hoje

O modelo central de chat do NeoTavern é um personagem por conversa, com sua
persona sobreposta. Um recurso dedicado de chat em grupo que permita criar uma
conversa e alternar seus membros no aplicativo está **planejado**; ele não está
disponível na versão atual, então esta página descreve o que funciona hoje.

## Chats em Grupo Importados

Quando você migra um backup do SillyTavern por Configurações → Dados, chats em
grupo são tratados com segurança:

- Definições de grupo e seus históricos são importados como chats comuns,
  carregando o registro original do grupo nos metadados do chat.
- O histórico mantém cada nome de participante, mensagem e variante de swipe,
  então o histórico multicaractere permanece legível e você pode continuar a
  conversa.
- Categorias não suportadas são listadas explicitamente no relatório de
  importação em vez de serem descartadas silenciosamente.

## Trabalhando com Vários Personagens Agora

Enquanto grupos nativos estão planejados, estes recursos cobrem os fluxos
comuns com vários personagens:

- **Chats separados por personagem.** Cada personagem mantém seu próprio
  histórico de chat, e o painel Chats limita a lista ao personagem atual.
- **Um mundo compartilhado via lorebooks.** Vincule um lorebook a vários
  personagens para que um conhecimento de mundo consistente alcance todas as
  conversas. Veja [Lorebooks](lorebook).
- **Ramos de linha de história.** Use checkpoints e branches para explorar
  caminhos divergentes com qualquer personagem sem perder a conversa principal.
  Veja [Chatting](chat).
- **Personas.** Alterne sua própria persona por chat para mudar como você se
  apresenta em cada conversa.

Se você precisa de uma conversa verdadeiramente multicaractere, tenha em mente
a abordagem de chat em grupo importado: ela preserva seu histórico de grupo
existente, e o recurso nativo planejado construirá sobre os mesmos dados.
