---
title: Adaptadores Incluídos
description: Os adaptadores de provedor que vêm com o NeoTavern e o que cada um atende.
sidebar_position: 3
---

O NeoTavern inclui um conjunto de adaptadores de provedor de fábrica. Eles
ficam em `packages/provider-sdk/src/adapters/`, um arquivo por adaptador, e são
registrados no `ProviderRegistry` do núcleo pelo seu kind de provedor.

## Compatível com OpenAI

Arquivo: `openaiCompatible.ts` — kind `openai-compatible`.

Atende a qualquer servidor que exponha a API OpenAI `/v1/chat/completions` e
`/v1/models`: a própria OpenAI, OpenRouter, LM Studio, servidor llama.cpp,
Ollama com o endpoint `/v1`, vLLM e similares. Ele usa apenas o `fetch` global
e o parser de SSE do SDK; a chave de API é enviada, mas nunca registrada em
logs.

## Anthropic

Arquivo: `anthropic.ts` — kind `anthropic`.

Atende à API Messages nativa da Anthropic. Esta é a única exceção documentada
à regra de não usar SDKs de fornecedores: ela usa `@anthropic-ai/sdk` porque a
API — extended thinking e suporte a beta headers — é tratada com mais precisão
pelo SDK oficial. Ela suporta prompt caching e adaptive thinking e declara a
capacidade de wire `assistantPrefill`.

## Text Completion

Arquivo: `textCompletion.ts` — kind `text-completion`.

Atende a backends locais ou auto-hospedados que expõem o endpoint legado
OpenAI `/v1/completions`: text-generation-webui ("ooba"), koboldcpp, vLLM,
Ollama, servidor llama.cpp e similares. Diferente dos adaptadores de chat, ele
consome um prompt serializado: o pipeline de prompt renderiza o formato
instruct e entrega ao adaptador uma única mensagem user cujo conteúdo é o
prompt final, e o adaptador o envia para `/completions`. A chave de API é
opcional para servidores locais e nunca é registrada em logs.

## NovelAI

Arquivo: `novelai.ts` — kind `novelai`.

Atende à API de geração de texto do NovelAI (`POST {baseUrl}/ai/generate` com
uma chave Bearer). A geração não é em streaming — um único `delta` mais o
evento terminal `done`, correspondendo ao contrato de stream unificado. A
descoberta de modelos não é oferecida pela API, então `listModels` retorna o
modelo configurado. O adaptador é marcado como experimental porque a superfície
de parâmetros do NovelAI evolui; apenas os samplers bem estabelecidos são
mapeados.

## KoboldAI

Arquivo: `koboldai.ts` — kind `koboldai`.

Atende à API nativa do servidor KoboldAI/Kobold (`POST {baseUrl}/api/v1/generate`).
A geração não é em streaming; o modelo carregado é lido de `/api/v1/model`
para descoberta. Instalações locais típicas não precisam de chave de API.

## AI Horde

Arquivo: `aiHorde.ts` — kind `ai-horde`.

Atende ao AI Horde (`stablehorde.net`), um cluster assíncrono crowdsourced.
Um trabalho é submetido com `/api/v2/generate/text/async` e então consultado
pelo endpoint de status até terminar; o loop de consulta re-checa o sinal do
chamador e um prazo ocioso, de modo que um trabalho travado aborta em vez de
consultar para sempre. O uso anônimo é permitido em prioridade mais baixa; uma
chave de API é enviada como header `apikey` quando configurada.

## Echo

Arquivo: `echo.ts` — kind `echo`.

Um provedor totalmente offline usado para testes, demos e verificação do
pipeline de streaming sem qualquer rede ou chave de API. Ele transmite a
última mensagem do usuário de volta palavra por palavra. Ele também implementa
os métodos opcionais de fala, imagem e transcrição, o que o torna uma
referência útil para escrever um adaptador que cobre todas as modalidades.

## Helper de Prompt

Arquivo: `prompt.ts` — exporta `promptFromMessages`, um helper compartilhado
que serializa arrays de mensagens nas formas de prompt que os adaptadores
enviam. Não é um adaptador em si.

Para a interface exata `ProviderAdapter` que todos estes implementam, veja
[Contrato de Adaptador](adapter-contract.md) e a
[Referência do Provider SDK](../../api/provider-sdk/) gerada.
