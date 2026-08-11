---
title: Visão Geral de Provedores
description: Como o NeoTavern fala com serviços de LLM, TTS, STT e imagem por meio de um único contrato de adaptador.
sidebar_position: 1
---

Provedores são como o NeoTavern fala com serviços externos de IA: modelos de
linguagem, texto-para-fala, fala-para-texto e geração de imagens.

## Um Único Contrato de Adaptador

Todo provedor — seja um endpoint de chat compatível com OpenAI, uma conexão
nativa da Anthropic, um backend comunitário como NovelAI ou KoboldAI, ou um
serviço registrado por plugin — implementa o mesmo contrato `ProviderAdapter`
de `@neotavern/provider-sdk`. O pipeline principal conhece apenas esse contrato, de
modo que o aplicativo não está preso a nenhum fornecedor único.

Um adaptador deve suportar:

- Validação de configuração.
- Listagem de modelos disponíveis.
- Cancelamento por `AbortSignal`.
- Um stream unificado de eventos de geração.
- Erros normalizados.
- Timeouts.
- Logging sem segredos.
- Registro por meio do Plugin SDK.

Como o pipeline vê uma única forma independente do fornecedor, recursos como
streaming, context shifting e tratamento de erros funcionam de forma idêntica
em todos os provedores. Veja [Contrato de Adaptador](adapter-contract.md) para
os requisitos precisos.

## Adaptadores Incluídos

A distribuição inclui adaptadores para endpoints compatíveis com OpenAI,
Anthropic, endpoints de text-completion, NovelAI, KoboldAI, AI Horde e um
adaptador echo local. Cada um está documentado em [Adaptadores](adapters.md).

## Estimativa Local de Tokens

A contagem de tokens é local e offline. Tokenizadores exatos (tiktoken,
SentencePiece ou tokenizer JSON do Hugging Face) podem ser registrados por
modelo, inclusive por plugins de provedores; até que um tokenizador exato seja
registrado, o host usa uma heurística ciente de scripts e marca a contagem
como aproximada.

## Estendendo Provedores

O núcleo é deliberadamente livre de dependências de SDKs de fornecedores.
Novos provedores são adicionados escrevendo um adaptador e registrando-o:

- Provedores do núcleo registram-se pelo `ProviderRegistry` em
  `@neotavern/provider-sdk`.
- Provedores de plugins registram-se pela API de backend do Plugin SDK
  (`api.providers.register(kind, factory)`), que exige a permissão
  `providers.register`. O registro retorna uma função de limpeza e é removido
  automaticamente quando o plugin é desativado.

Este é o caminho documentado para um endpoint privado, um modelo auto-hospedado
ou um serviço que não tem adaptador integrado. A
[Referência do Provider SDK](../api/provider-sdk/) gerada documenta o contrato
completo.
