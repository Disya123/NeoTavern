---
title: Contrato de Adaptador
description: O que todo adaptador de provedor deve implementar, da validação aos timeouts.
sidebar_position: 2
---

O contrato de adaptador é o contrato que todo provedor de LLM, TTS, STT e
imagem implementa. Se você escrever um adaptador que o satisfaz, todo o
pipeline funciona com o seu provedor.

## A Interface

A interface `ProviderAdapter` tem um `kind` estável, declarações opcionais de
modalidade e os métodos necessários. A geração de texto é a capacidade base;
métodos de fala, imagem e transcrição são opcionais, de modo que um adaptador
apenas de LLM ainda é um provedor válido.

```ts
interface ProviderAdapter {
  readonly kind: string;
  readonly modalities?: readonly ProviderModality[];
  readonly capabilities?: {
    assistantPrefill?: boolean;
    textCompletion?: boolean;
  };
  validateConfig(): Promise<ValidationResult>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  speech?(request: SpeechRequest, signal: AbortSignal): AsyncIterable<SpeechEvent>;
  image?(request: ImageRequest, signal: AbortSignal): AsyncIterable<ImageEvent>;
  transcribe?(request: TranscriptionRequest, signal: AbortSignal): Promise<TranscriptionResult>;
  countTokens?(request: TokenCountRequest): Promise<TokenCount>;
}
```

## Comportamento Exigido

O contrato exige oito comportamentos:

- **Validação de configuração** — `validateConfig()` verifica a própria
  configuração do adaptador sem fazer chamadas de rede e retorna uma lista de
  problemas.
- **Listagem de modelos** — `listModels(signal)` retorna os modelos
  disponíveis e deve respeitar o sinal de abort.
- **Cancelamento** — todo método de longa duração recebe um `AbortSignal` e
  deve abortar prontamente quando ele dispara.
- **Stream unificado de eventos** — `generate()` produz um stream de
  `GenerationEvent`s tipados e deve terminar com exatamente um evento
  terminal, `done` ou `error`. Geração de fala e imagem usa a mesma forma de
  streaming.
- **Normalização de erros** — falhas de provedor são mapeadas para códigos
  `AppError` estáveis com códigos e parâmetros legíveis por máquina. Status
  HTTP upstream são diferenciados (auth, rate limit, modelo ruim, erro de
  servidor), e corpos upstream brutos nunca são repassados aos clientes.
- **Timeouts** — um adaptador não deve depender apenas do sinal do chamador.
  Ele precisa de seus próprios prazos para conexão, silêncio ocioso no
  streaming e leituras completas de resposta. O SDK traz `ProviderTimeouts`
  (padrões: 30 s de conexão, 60 s ocioso, 30 s de leitura) e um
  `DeadlineController` que combina o sinal do chamador com prazos
  rearmáveis e aborta com um erro `TIMEOUT`.
- **Logging seguro** — a chave de API é fornecida a partir de armazenamento
  seguro e nunca deve ser registrada em logs, nem incluída em diagnósticos ou
  saídas de erro.
- **Registro** — adaptadores são registrados por kind, seja no registro do
  núcleo, seja pela API de backend do Plugin SDK.

## Neutralidade de Fornecedor

O núcleo não está preso a nenhum SDK de fornecedor. Espera-se que novos
adaptadores usem o `fetch` global e o parser de SSE do SDK (`parseSseStream`)
para respostas em streaming.

Há exatamente uma exceção documentada: o adaptador da Anthropic usa
`@anthropic-ai/sdk`, porque a API da Anthropic — extended thinking e suporte a
beta headers — é tratada com mais precisão pelo SDK oficial do que por um
cliente fetch escrito à mão. É o único adaptador conectado a uma biblioteca de
fornecedor; todo o resto fala HTTP diretamente.

## Integração com o Host

O `ProviderRegistry` mapeia kinds de provedores para factories de adaptadores.
`register` retorna uma função de unregister, `create` instancia um adaptador e
lança `PROVIDER_NOT_FOUND` para kinds desconhecidos, e o registro também
abriga o registro local de tokenizadores. Capacidades de wire declaradas, como
`assistantPrefill`, são usadas para validar perfis de conexão — o host nunca
descarta silenciosamente um override de perfil persistido que um adaptador não
suporta.

Para os adaptadores reais incluídos e o que cada um atende, veja
[Adaptadores](adapters.md). Para registrar um adaptador a partir de um plugin,
veja a [API de backend do Plugin SDK](../plugin-sdk/backend.md).
