---
title: Providers Overview
description: How NeoTavern talks to LLM, TTS, STT, and image services through one adapter contract.
sidebar_position: 1
---

Providers are how NeoTavern talks to external AI services: language models,
text-to-speech, speech-to-text, and image generation.

## One Adapter Contract

Every provider — whether it is an OpenAI-compatible chat endpoint, a native
Anthropic connection, a community backend such as NovelAI or KoboldAI, or a
plugin-registered service — implements the same `ProviderAdapter` contract
from `@neotavern/provider-sdk`. The core pipeline only knows this contract, so the
application is not bound to any single vendor.

An adapter must support:

- Configuration validation.
- Listing available models.
- Cancellation through `AbortSignal`.
- A unified generation event stream.
- Normalized errors.
- Timeouts.
- Secret-free logging.
- Registration through the Plugin SDK.

Because the pipeline sees one shape regardless of the vendor, features such
as streaming, context shifting, and error handling work identically across
all providers. See [Adapter Contract](adapter-contract.md) for the precise
requirements.

## Shipped Adapters

The distribution ships adapters for OpenAI-compatible endpoints, Anthropic,
text-completion endpoints, NovelAI, KoboldAI, the AI Horde, and a local echo
adapter. Each is documented in [Adapters](adapters.md).

## Local Token Estimation

Token counting is local and offline. Exact tokenizers (tiktoken,
SentencePiece, or Hugging Face tokenizer JSON) can be registered per model,
including by provider plugins; until an exact tokenizer is registered, the
host uses a script-aware heuristic and marks the count as approximate.

## Extending Providers

The core is deliberately free of vendor SDK dependencies. New providers are
added by writing an adapter and registering it:

- Core providers register through the `ProviderRegistry` in
  `@neotavern/provider-sdk`.
- Plugin providers register through the Plugin SDK's backend API
  (`api.providers.register(kind, factory)`), which requires the
  `providers.register` permission. Registration returns a cleanup function
  and is removed automatically when the plugin deactivates.

This is the documented path for a private endpoint, a self-hosted model, or
a service that has no built-in adapter. The generated
[Provider SDK reference](../api/provider-sdk/) documents the full contract.
