---
title: Formatos Instruct
description: >-
  Como os formatos instruct renderizam o array limpo de mensagens com
  templates Handlebars em sandbox, os formatos integrados e presets JSON
  versionados.
sidebar_position: 3
---

Formatos instruct definem como o array limpo de mensagens é renderizado em uma
string de prompt, usando templates Handlebars em sandbox que não têm acesso ao
sistema de arquivos nem à execução de código.

## O Gerenciador de Formatos

Um gerenciador de formatos integrado é dono dos formatos instruct. Formatos
são templates Handlebars renderizados em um ambiente isolado: os templates
recebem apenas `content`, `role` e `name`, e apenas helpers documentados estão
disponíveis. Templates não têm acesso ao Node.js, ao sistema de arquivos nem a
qualquer forma de executar código arbitrário.

Um formato descreve:

- templates de system, user, assistant e tool;
- tokens BOS e EOS;
- separadores de mensagens;
- tokens especiais.

## Formatos Integrados

O NeoTavern inclui estes formatos:

- **ChatML** — blocos de papel `<|im_start|>` / `<|im_end|>`.
- **Llama 3** — `<|begin_of_text|>` com tags de papel.
- **Alpaca** — blocos de instrução e resposta.
- **Mistral** — blocos `[INST]` / `[/INST]`.
- **Command-R** — blocos `<|START_OF_TURN_TOKEN|>`.
- **Formatos customizados** — templates definidos pelo usuário, selecionáveis
  como formato ativo.

## Array Limpo de Mensagens até a Renderização

Até o estágio de renderização, o pipeline trabalha exclusivamente com um array
estruturado de mensagens com papéis (`system`, `user`, `assistant`, `tool`).
Macros são resolvidas, lorebook e memória são inseridos, o context shifting
remove o excesso e os interceptadores de plugins modificam esse array. A
renderização acontece exatamente uma vez, no estágio de renderização, de modo
que nenhum adaptador reformata o prompt uma segunda vez.

## Saída Final

O estágio de renderização produz uma de duas formas:

- **Uma string** — o prompt renderizado, enviado aos provedores de
  text-completion e usado para diagnósticos.
- **JSON estruturado** — o array `GenerationMessage[]`, enviado aos provedores
  de chat que aceitam mensagens com tags de papel.

O modo é selecionado por `serializeAsText`: adaptadores de texto
(`text-completion`, `novelai`, `ai-horde`, `koboldai`) sempre recebem o prompt
instruct renderizado como uma única mensagem `user`; adaptadores de chat
(`openai-compatible`, `anthropic`) recebem o array estruturado.

## Macros

`{{user}}`, `{{char}}` e variáveis customizadas são resolvidas antes da
renderização final. Macros nunca são expandidas dentro do próprio mecanismo de
template, então os arquivos de template permanecem como marcação pura.

## Formatos Customizados e Presets

O formato customizado ativo é armazenado em `AppSettings.instructFormat`.
Quando definido, o array limpo de mensagens é renderizado em uma única string
e as strings de parada do formato se tornam as sequências de parada da
requisição. Quando `null`, a serialização estruturada nativa é usada.

Formatos são importados e exportados como **presets JSON versionados**:

- `importInstructFormat()` valida o preset antes de ele se tornar ativo;
- `exportInstructFormat()` produz valores separados e seguros para JSON;
- presets carregam uma versão, de modo que exportações antigas podem ser
  migradas na importação.

## Veja Também

- [Estágios do Pipeline](stages) para saber onde a renderização fica na ordem
  de estágios.
- [Tokenização](tokenization) para saber como o contexto renderizado é
  contado.
- [Provedores](../providers/) para saber como os adaptadores consomem a saída
  serializada.
