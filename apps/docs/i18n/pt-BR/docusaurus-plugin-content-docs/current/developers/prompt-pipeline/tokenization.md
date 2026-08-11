---
title: Tokenização
description: >-
  Contagem local de tokens pelo registro de tokenizadores: compatíveis com
  tiktoken, SentencePiece, JSON do Hugging Face, plugins específicos de modelo
  e o fallback aproximado.
sidebar_position: 4
---

A contagem de tokens é executada localmente por um registro de tokenizadores
que suporta tokenizadores compatíveis com tiktoken, SentencePiece, JSON do
Hugging Face e plugins específicos de modelo, com um fallback aproximado
explícito.

## Contagem Local

A contagem de tokens nunca sai da máquina. O registro seleciona um perfil de
tokenizador para o modelo ativo, e o pipeline conta o contexto montado em
processo antes de qualquer requisição de rede.

## O Registro de Tokenizadores

O registro aceita quatro tipos de tokenizadores:

- **Compatíveis com tiktoken** — tokenizadores BPE compatíveis com o tiktoken
  da OpenAI, para as famílias de modelos da OpenAI.
- **SentencePiece** — modelos que fornecem vocabulários SentencePiece.
- **JSON de tokenizador do Hugging Face** — arquivos `tokenizer.json` de
  repositórios do Hugging Face, convertidos para um formato compacto de ranks.
- **Plugins específicos de modelo** — plugins de provedores podem registrar um
  perfil de tokenizador preciso para um modelo.

Um **fallback aproximado** existe para modelos sem tokenizador registrado, e
ele é sempre rotulado explicitamente, de modo que a interface nunca apresenta
uma estimativa como uma contagem exata.

## Perfis Integrados

O núcleo registra perfis offline para as famílias comuns:

- `openai:o200k_base` — famílias GPT-4o, GPT-4.1, GPT-5, o1, o3 e o4.
- `openai:cl100k_base` — GPT-4, GPT-3.5 Turbo e text-embedding-3.
- `deepseek:bytelevel-bpe-v1` — famílias DeepSeek. A contagem passa por um
  mecanismo compacto apenas de contagem (uma versão BPE merge sem vocabulário
  e sem decodificador) sobre os ranks do `tokenizer.json` oficial. O arquivo é
  convertido uma vez em um pequeno arquivo de ranks armazenado em cache em
  `data/cache/tokenizers/deepseek-v4-flash/` por meio de escritas atômicas
  temp-plus-rename; o JSON completo e a biblioteca de tokenizador em runtime
  não são armazenados nem carregados.

Se a rede estiver indisponível, o perfil DeepSeek recai honestamente no perfil
aproximado e tenta novamente no máximo uma vez a cada 15 minutos — um
tokenizador ausente nunca bloqueia a geração.

## Fallback Aproximado

Modelos locais desconhecidos usam `approximate-character-v1`, uma heurística
ciente de scripts: aproximadamente 4,6 caracteres por token para latim, 4,0
para cirílico, 1,7 para CJK e 2,0 para dígitos. A aproximação é sinalizada em
todos os lugares em que aparece, e um plugin de provedor pode substituí-la a
qualquer momento registrando um perfil preciso.

## Perfis de Plugins

Plugins registram perfis de tokenizador com uma prioridade. Um perfil de
plugin com prioridade acima de `-10` substitui o perfil de família para os
modelos que cobre. O perfil selecionado é passado ao pipeline como
`countTokens`, `tokenizerProfile` e `tokenizerApproximate`.

## O Resultado do Orçamento de Tokens

Após a contagem, o pipeline expõe `PipelineResult.tokenBudget`, que contém:

- o perfil de tokenizador usado;
- a flag `approximate`;
- o limite de contexto do modelo;
- o espaço reservado para resposta;
- a contagem final de tokens do prompt.

Veja [Context Shifting](context-shifting) para saber como o orçamento é
aplicado.
