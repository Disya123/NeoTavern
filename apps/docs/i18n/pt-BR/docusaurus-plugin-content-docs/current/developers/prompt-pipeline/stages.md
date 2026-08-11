---
title: Estágios do Pipeline
description: >-
  Os 14 estágios fixos do pipeline de prompt e as regras que todo hook de
  plugin segue: prioridade, timeout, cancelamento, permissões e isolamento.
sidebar_position: 2
---

A geração passa por 14 estágios fixos, da entrada do usuário ao salvamento da
mensagem, e todo hook de plugin segue as mesmas regras de prioridade, timeout,
cancelamento, permissões e isolamento de erros.

## A Ordem dos Estágios

A ordem é fixa e idêntica para toda geração:

```text
Entrada do usuário
→ Macros
→ Dados do personagem/persona
→ Lorebook
→ Memória/RAG
→ Contagem de tokens
→ Context shifting
→ Interceptadores de plugins
→ Renderização do formato instruct
→ Serialização do provedor
→ Requisição
→ Resposta em streaming
→ Hooks de pós-processamento
→ Salvar mensagem
```

## Estágio por Estágio

1. **Entrada do usuário** — a mensagem de rascunho e as opções de geração
   desta requisição são capturadas.
2. **Macros** — `{{user}}`, `{{char}}` e variáveis customizadas são resolvidas
   por `replaceMacros`. Macros desconhecidas são mantidas como estão.
3. **Dados do personagem/persona** — os campos da ficha do personagem e a
   persona ativa são montados no array de mensagens.
4. **Lorebook** — entradas de lorebook correspondentes são inseridas de acordo
   com suas regras de ativação. Entradas marcadas como obrigatórias são
   protegidas contra remoção.
5. **Memória/RAG** — blocos de memória e de busca vetorial são recuperados e
   classificados.
6. **Contagem de tokens** — o perfil local de tokenizador conta o contexto
   montado.
7. **Context shifting** — o contexto é ajustado ao orçamento de tokens. Veja
   [Context Shifting](context-shifting).
8. **Interceptadores de plugins** — plugins podem inspecionar e modificar o
   array de mensagens. Após o último interceptador, o pipeline reconta tokens
   e reaplica o orçamento, de modo que nenhum plugin possa contorná-lo.
9. **Renderização do formato instruct** — o array limpo de mensagens é
   renderizado no formato instruct selecionado, ou mantido estruturado. Veja
   [Formatos Instruct](instruct-formats).
10. **Serialização do provedor** — o adaptador monta a requisição do provedor:
    adaptadores de chat recebem o array estruturado de mensagens; adaptadores
    de texto recebem a string do prompt renderizado.
11. **Requisição** — a requisição é enviada com um `AbortSignal`, timeouts e
    tratamento de desconexão do cliente.
12. **Resposta em streaming** — a resposta flui via SSE. Um
    `assistantPrefill` opcional é prefixado exatamente uma vez ao primeiro
    delta.
13. **Hooks de pós-processamento** — plugins podem processar a resposta em
    streaming antes de ela ser salva.
14. **Salvar mensagem** — a mensagem final, suas variantes e os metadados de
    geração são salvos em uma única transação.

## Regras dos Hooks

Todo hook de plugin é definido pelo mesmo contrato:

- **Ordem e prioridade** — os hooks são executados em ordem de prioridade;
  prioridades iguais são ordenadas de forma determinística.
- **Timeout** — cada hook tem um timeout. Um hook que o excede é abortado.
- **Cancelamento** — os hooks recebem o `AbortSignal` da geração e devem parar
  o trabalho quando ele dispara.
- **Permissões** — um hook só é executado se o plugin tiver as permissões que
  suas capacidades declaradas exigem.
- **Isolamento de exceções** — um erro no hook de um plugin é capturado,
  registrado e ignorado. O pipeline continua; um interceptador quebrado nunca
  deve quebrar silenciosamente toda a geração.
- **Log de diagnóstico** — toda mudança de prompt é registrada. O log de
  mudanças é retornado nos diagnósticos de geração e armazenado no `meta` da
  mensagem de resposta, para que você sempre possa ver o que foi realmente
  enviado.

## Pós-Processamento de Prompt

No modo chat, o array de mensagens pode passar por um estágio opcional de
reconstrução antes da serialização — a versão do algoritmo clássico
`mergeMessages`. Os modos incluem `merge`, `semi`, `strict` e `single`, além
das variantes `_tools` que preservam mensagens de ferramenta. No modo texto
este estágio é ignorado, porque a renderização instruct já colapsou os papéis
em uma única string.

## Veja Também

- [Context Shifting](context-shifting) para saber como o orçamento é aplicado.
- [Tokenização](tokenization) para saber como a contagem de tokens funciona.
- O [Plugin SDK](../plugin-sdk/) para as APIs de registro de interceptadores e
  pós-processamento.
