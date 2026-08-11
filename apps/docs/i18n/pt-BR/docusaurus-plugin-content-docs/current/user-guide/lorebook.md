---
title: Lorebooks
description: O que são lorebooks, como as entradas ativam e como vinculá-los a personagens.
sidebar_position: 5
---

Esta página explica lorebooks: coleções de conhecimento de mundo que o
NeoTavern injeta no prompt exatamente quando se tornam relevantes.

## O Que É um Lorebook

Um lorebook é um conjunto de entradas sobre um mundo, uma ambientação ou um
personagem: locais, facções, história, pessoas, regras de magia — qualquer
coisa que o modelo deva saber, mas que desperdiçaria tokens se incluída em
todas as mensagens. Em vez de carregar o livro inteiro no prompt, o aplicativo
ativa apenas as entradas cujas palavras-chave correspondem à conversa atual.

Um livro tem escopo **global** (disponível em todos os chats) ou é vinculado a
um **personagem** (usado apenas nas conversas daquele personagem). Você pode
vincular e desvincular livros por personagem na seção Lore do editor de
personagem.

## Entradas

Cada entrada tem:

- **Chaves primárias** — uma ou mais palavras-chave de ativação. Pelo menos uma
  chave primária é obrigatória.
- **Chaves secundárias** — palavras-chave opcionais adicionais.
- **Conteúdo** — o texto injetado no prompt quando a entrada dispara.
- **Posição** — onde a entrada é inserida em relação às outras entradas.
- **Alternadores** — `enabled` (participar da ativação), `constant` (sempre
  incluída) e `selective` (inserir apenas na posição configurada).

A correspondência é uma busca de substring sem diferenciar maiúsculas de
minúsculas contra o contexto da conversa. Quando uma entrada dispara, seu
conteúdo é inserido no prompt na posição da entrada, e o diálogo da entrada
mostra uma estimativa de seu tamanho em tokens para que você mantenha o
orçamento previsível.

## Ordem de Inserção

O pipeline monta os blocos de prompt em uma ordem fixa: prompt principal,
lorebook antes do personagem, persona, personagem, lorebook depois do
personagem, exemplos de diálogo, memória, histórico de chat, instruções
pós-histórico e a entrada atual do usuário. Entradas de lorebook são
classificadas por relevância junto com blocos de memória, e entradas constantes
estão sempre presentes. A ordem efetiva das entradas ativadas segue sua posição
dentro do livro, então um livro bem estruturado produz um prompt estável.

## Gerenciando Livros

O painel Lorebooks na barra de navegação tem três abas: a lista de livros, o
editor de livros e a lista de entradas. A lista mostra o nome de cada livro,
descrição, contagem de carregamentos e um selo de escopo (Global ou
Personagem), com filtros para livros globais, livros de um personagem
específico ou todos os livros. Livros são excluídos para um estado de lixeira e
podem ser restaurados, e a busca sobre livros é estabilizada com debounce para
bibliotecas grandes.

Novos livros criados no editor de personagem são imediatamente vinculados a
esse personagem. Veja [Characters](characters) para o editor e
[Memory & Recall](memory) para como blocos de memória interagem com entradas de
lorebook.
