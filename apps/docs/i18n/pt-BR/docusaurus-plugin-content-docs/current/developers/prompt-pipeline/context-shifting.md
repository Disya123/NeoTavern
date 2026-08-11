---
title: Context Shifting
description: >-
  Como o pipeline ajusta o contexto montado ao orçamento de tokens, as etapas
  pré-requisição e as estratégias truncate, summarize, vector-recall e manual.
sidebar_position: 5
---

O context shifting ajusta a conversa montada ao orçamento de tokens do modelo
removendo ou comprimindo o contexto menos importante enquanto mantém tudo o
que deve permanecer.

## Etapas Pré-Requisição

Antes de uma requisição ser enviada, o pipeline segue estas etapas:

1. Determina o perfil de tokenizador e o limite de contexto do modelo.
2. Reserva espaço para a resposta.
3. Mantém o system prompt, o personagem, entradas de lorebook obrigatórias e
   mensagens fixadas.
4. Remove ou comprime primeiro os blocos não fixados mais antigos.
5. Remove mensagens de tool-call e tool-result apenas em pares.
6. Reconta tokens após cada mudança.
7. Mostra ao usuário o que foi excluído ou resumido.

Se apenas o contexto protegido exceder o orçamento, a geração termina com o
erro estável `TOKEN_BUDGET_EXCEEDED` em vez de enviar uma requisição acima do
orçamento ao provedor.

## Como o Shifting Funciona

`shiftContext(messages, countTokens, budget)` ajusta o diálogo ao orçamento de
tokens. Ele retorna três listas:

- `kept` — as mensagens que cabem;
- `excluded` — as mensagens removidas, mostradas ao usuário;
- `truncated` — blocos que foram comprimidos em vez de descartados.

Mensagens do sistema e mensagens fixadas são sempre protegidas. Os blocos não
fixados mais antigos são removidos primeiro. Chamadas de ferramenta e seus
resultados são vinculados por `toolCallId`, `tool_call_id` ou `callId` e
removidos como um único grupo, mesmo quando não são adjacentes.

## Estratégias Integradas

A estratégia é selecionada pela configuração `contextStrategy` e aplicada por
meio do `ContextStrategyRegistry`:

- **truncate** — remove os grupos não fixados mais antigos.
- **summarize** — constrói um resumo extrativo local do histórico excluído e o
  mantém antes da entrada atual do usuário.
- **vector-recall** — descarta blocos de lorebook e memória de baixa
  relevância antes dos de alta relevância e depois encurta o histórico antigo.
- **manual** — primeiro exclui mensagens sinalizadas com
  `meta.manualExcluded: true` (incluindo seus pares tool-call e tool-result)
  e depois continua com a redução normal se mais espaço for necessário.

## Plugins e o Orçamento

Plugins podem registrar estratégias adicionais; o registro retorna uma função
de limpeza. Uma estratégia de plugin não pode contornar o orçamento:

- o host restaura mensagens obrigatórias e rejeita uma estratégia que removeu
  contexto protegido;
- o host reconta independentemente o orçamento real;
- contagem e shifting rodam antes dos interceptadores de plugins, e uma
  recontagem obrigatória com um shifting final roda depois deles — um plugin
  não pode adicionar mensagens tarde para passar despercebido do limite.

## A Auditoria de Contexto

Toda geração cria um `PromptContextAudit` antes da chamada de rede e o
finaliza com um status terminal: `completed`, `failed` ou `cancelled`. A
auditoria registra:

- o ID da geração, o provedor e o modelo;
- todo bloco de prompt na ordem real, com contagens de tokens e o motivo
  estável de inclusão ou exclusão;
- o limite de contexto, a reserva de resposta e a contagem final de tokens do
  prompt;
- o perfil de tokenizador e se ele é aproximado;
- as mensagens finais do provedor e os diagnósticos dos interceptadores de
  plugins;
- um código de erro de provedor normalizado, sem os corpos de resposta
  upstream.

Apenas a última auditoria completa por chat é mantida no banco de dados; uma
nova requisição substitui atomicamente a antiga, e excluir o chat exclui a
auditoria. A interface a lê por meio de `GET /api/v2/chats/:id/context-audit`.

Um endpoint de pré-visualização ao vivo, `POST /api/v2/context-preview`,
executa os mesmos estágios de persona, lorebook, memória, template,
tokenizador e shifting sem criar mensagens, ramificações ou auditorias.

## Veja Também

- [Estágios do Pipeline](stages) para saber onde o shifting fica na ordem de
  estágios.
- [Tokenização](tokenization) para saber como os tokens são contados.
- [Dados e Armazenamento](../data/) para saber onde as auditorias são
  armazenadas.
