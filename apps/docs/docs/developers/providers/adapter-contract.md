---
title: Adapter Contract
description: What every provider adapter must implement, from validation to timeouts.
sidebar_position: 2
---

The adapter contract is the contract every LLM, TTS, STT, and image provider
implements. If you write an adapter that satisfies it, the whole pipeline
works with your provider.

## The Interface

The `ProviderAdapter` interface has a stable `kind`, optional modality
declarations, and the required methods. Text generation is the base
capability; speech, image, and transcription methods are optional, so an
LLM-only adapter is still a valid provider.

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

## Required Behavior

The contract requires eight behaviors:

- **Configuration validation** — `validateConfig()` checks the adapter's own
  configuration without making network calls and returns a list of issues.
- **Model listing** — `listModels(signal)` returns the available models and
  must respect the abort signal.
- **Cancellation** — every long-running method receives an `AbortSignal` and
  must abort promptly when it fires.
- **Unified event stream** — `generate()` yields a stream of typed
  `GenerationEvent`s and must end with exactly one terminal event, `done` or
  `error`. Speech and image generation use the same streaming shape.
- **Error normalization** — provider failures are mapped to stable
  `AppError` codes with machine-readable codes and parameters. Upstream HTTP
  statuses are differentiated (auth, rate limit, bad model, server error),
  and raw upstream bodies are never forwarded to clients.
- **Timeouts** — an adapter must not rely on the caller's signal alone. It
  needs its own deadlines for connection, idle streaming silence, and whole
  response reads. The SDK ships `ProviderTimeouts` (defaults: 30 s connect,
  60 s idle, 30 s read) and a `DeadlineController` that combines the caller
  signal with re-armable deadlines and aborts with a `TIMEOUT` error.
- **Safe logging** — the API key is provided from secure storage and must
  never be logged, nor included in diagnostics or error output.
- **Registration** — adapters are registered by kind, either in the core
  registry or through the Plugin SDK backend API.

## Vendor Neutrality

The core is not bound to any vendor SDK. New adapters are expected to use the
global `fetch` and the SDK's SSE parser (`parseSseStream`) for streaming
responses.

There is exactly one documented exception: the Anthropic adapter uses
`@anthropic-ai/sdk`, because the Anthropic API — extended thinking and
beta-header support — is handled more accurately by the official SDK than by
a hand-written fetch client. It is the only adapter wired to a vendor
library; everything else speaks HTTP directly.

## Host Integration

The `ProviderRegistry` maps provider kinds to adapter factories. `register`
returns an unregister function, `create` instantiates an adapter and throws
`PROVIDER_NOT_FOUND` for unknown kinds, and the registry also hosts the local
tokenizer registry. Declared wire capabilities such as `assistantPrefill`
are used to validate connection profiles — the host never silently drops a
persisted profile override that an adapter does not support.

For the real shipped adapters and what each one targets, see
[Adapters](adapters.md). For registering an adapter from a plugin, see the
[Plugin SDK backend API](../plugin-sdk/backend.md).
