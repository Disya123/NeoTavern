---
title: Shipped Adapters
description: The provider adapters shipped with NeoTavern and what each one targets.
sidebar_position: 3
---

NeoTavern ships a set of provider adapters out of the box. They live in
`packages/provider-sdk/src/adapters/`, one file per adapter, and are
registered in the core `ProviderRegistry` by their provider kind.

## OpenAI-Compatible

File: `openaiCompatible.ts` — kind `openai-compatible`.

Targets any server exposing the OpenAI `/v1/chat/completions` and
`/v1/models` API: OpenAI itself, OpenRouter, LM Studio, llama.cpp server,
Ollama with the `/v1` endpoint, vLLM, and similar. It uses only the global
`fetch` and the SDK's SSE parser; the API key is sent but never logged.

## Anthropic

File: `anthropic.ts` — kind `anthropic`.

Targets the native Anthropic Messages API. This is the one documented
exception to the no-vendor-SDK rule: it uses `@anthropic-ai/sdk` because the
API — extended thinking and beta-header support — is handled more accurately
by the official SDK. It supports prompt caching and adaptive thinking and
declares the `assistantPrefill` wire capability.

## Text Completion

File: `textCompletion.ts` — kind `text-completion`.

Targets local or self-hosted backends that expose the legacy OpenAI
`/v1/completions` endpoint: text-generation-webui ("ooba"), koboldcpp, vLLM,
Ollama, llama.cpp server, and similar. Unlike chat adapters, it consumes a
serialized prompt: the prompt pipeline renders the instruct format and hands
the adapter a single user message whose content is the finished prompt, and
the adapter posts it to `/completions`. The API key is optional for local
servers and never logged.

## NovelAI

File: `novelai.ts` — kind `novelai`.

Targets the NovelAI text-generation API (`POST {baseUrl}/ai/generate` with a
Bearer key). Generation is non-streaming — a single `delta` plus the terminal
`done` event, matching the unified stream contract. Model discovery is not
offered by the API, so `listModels` returns the configured model. The
adapter is marked experimental because NovelAI's parameter surface evolves;
only the well-established samplers are mapped.

## KoboldAI

File: `koboldai.ts` — kind `koboldai`.

Targets the KoboldAI/Kobold server native API (`POST {baseUrl}/api/v1/generate`).
Generation is non-streaming; the loaded model is read from `/api/v1/model`
for discovery. Typical local installs need no API key.

## AI Horde

File: `aiHorde.ts` — kind `ai-horde`.

Targets the AI Horde (`stablehorde.net`), an asynchronous crowdsourced
cluster. A job is submitted with `/api/v2/generate/text/async`, then polled
via the status endpoint until done; the poll loop re-checks the caller
signal and an idle deadline, so a stuck job aborts instead of polling
forever. Anonymous use is allowed at lower priority; an API key is sent as
the `apikey` header when configured.

## Echo

File: `echo.ts` — kind `echo`.

A fully offline provider used for tests, demos, and verifying the streaming
pipeline without any network or API key. It streams the last user message
back word-by-word. It also implements the optional speech, image, and
transcription methods, which makes it a useful reference for writing an
adapter that covers every modality.

## Prompt Helper

File: `prompt.ts` — exports `promptFromMessages`, a shared helper that
serializes message arrays into the prompt shapes the adapters send. It is
not an adapter itself.

For the exact `ProviderAdapter` interface all of these implement, see
[Adapter Contract](adapter-contract.md) and the generated
[Provider SDK reference](../../api/provider-sdk/).
