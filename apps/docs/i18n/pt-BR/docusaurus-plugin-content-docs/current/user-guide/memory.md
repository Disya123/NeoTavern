---
title: Memória e Recuperação
description: Memória de conversa, entradas de memória, busca vetorial e RAG no NeoTavern.
sidebar_position: 6
---

Esta página explica os recursos de memória que ajudam o modelo a lembrar em
conversas longas: a memória contínua da conversa, entradas de memória ativadas
por palavra-chave e busca vetorial.

## Memória de Conversa

Todo chat mantém um resumo contínuo que o pipeline atualiza conforme a conversa
cresce. Quando a estratégia de context shifting `summarize` está ativa, o
histórico excluído mais antigo é condensado em um resumo extrativo local
inserido antes da entrada atual do usuário — assim o modelo mantém a essência
dos eventos iniciais mesmo depois que as mensagens brutas saem do orçamento de
tokens. O resumo é armazenado com o chat e sobrevive a recarregamentos.

Você pode ver exatamente o que o prompt atual contém antes de enviar: uma
pré-visualização de contexto ao vivo mostra o tokenizador selecionado, o limite
de contexto e o espaço reservado para resposta, blocos excluídos, blocos
resumidos e a estratégia aplicada. Veja [Settings](settings) para o seletor de
estratégia.

## Entradas de Memória

Entradas de memória são fragmentos de conhecimento de longa duração que
persistem entre chats, independentes de qualquer conversa única. Cada entrada
tem:

- **Escopo** — `global` ou vinculado a um personagem.
- **Palavras-chave de ativação** — correspondência de substring sem diferenciar
  maiúsculas de minúsculas contra o contexto da conversa.
- **Conteúdo** — o texto injetado quando a entrada dispara.

Este é o padrão clássico de RAG: a recuperação é acionada pela correspondência
de palavras-chave, e os fragmentos injetados atendem à necessidade do modelo
por fatos estáveis — detalhes de personagem, regras do mundo ou pontos da trama
em andamento — sem inflar todos os prompts. Como as entradas de lorebook,
blocos de memória são classificados por relevância no pipeline de prompt e
contam para o orçamento de tokens.

## Busca Vetorial

A busca vetorial é a estratégia de context shifting `vector-recall`. Em vez de
cortar o contexto puramente por antiguidade, ela classifica blocos de lorebook
e memória por relevância semântica à entrada atual e descarta primeiro os menos
relevantes, depois poda o histórico mais antigo. O resultado: o modelo mantém o
material que importa para a mensagem atual mesmo quando não é o mais recente.

A estratégia é selecionada por configurações de geração, e plugins podem
adicionar mais estratégias pelo SDK. Toda estratégia ainda respeita o orçamento
final de tokens controlado pelo host — plugins não podem contorná-lo.

## Escolhendo uma Estratégia

As estratégias disponíveis são `truncate` (descartar os grupos não protegidos
mais antigos), `summarize` (condensar o histórico excluído), `vector-recall`
(manter blocos de alta relevância, podar por relevância e antiguidade) e
`manual` (excluir mensagens específicas do prompt sem deletá-las do histórico).
O modo manual expõe uma ação em cada mensagem para excluí-la ou restaurá-la, e
pares tool-call/tool-result são sempre tratados juntos. Veja [Chatting](chat)
para os controles no nível da mensagem e [Lorebooks](lorebook) para o modelo
relacionado de ativação por palavra-chave.
