# @neotavern/provider-sdk

Provider adapter contract (LLM/TTS/STT/image), built-in adapters and the
registry.

## Public API

- `ProviderAdapter` — the interface: `validateConfig()`, `listModels(signal)`,
  `generate(request, signal)` (AsyncIterable<GenerationEvent>), `countTokens?()`.
- `OpenAICompatibleAdapter` — OpenAI-compatible `/v1/chat/completions` (OpenAI,
  OpenRouter, LM Studio, llama.cpp, Ollama `/v1`, vLLM).
- `EchoAdapter` — offline provider for tests/demos.
- `ProviderRegistry` — registration of kinds (cleanup function),
  `create(kind, config)`.
- `TokenizerRegistry` — priority model-to-tokenizer registry. The core
  registers offline Tiktoken `o200k_base` and `cl100k_base`; plugins can add
  SentencePiece, Hugging Face JSON and model-specific profiles with a cleanup
  function.
- `parseSseStream()`, `estimateTokens()`, `normalizeProviderError()`.

## Guarantees

- cancellation via `AbortSignal`;
- a single event stream (`start → delta* → done|error`);
- error normalization into `AppError` codes;
- logging without API keys;
- the core is not tied to any vendor SDK (global `fetch` only).

## Dependencies

- `@neotavern/contracts`, `@neotavern/shared`, `js-tiktoken` (local BPE ranks,
  no network).

## Commands

```bash
pnpm --filter @neotavern/provider-sdk build
pnpm exec vitest run packages/provider-sdk
```

## Constraints

Exact core mappings: GPT-4o/GPT-4.1/GPT-5/o1/o3/o4 → `o200k_base`;
GPT-4/GPT-3.5 Turbo/text-embedding-3 → `cl100k_base`.

If no exact model profile is registered, `TokenizerRegistry.resolve()` returns
the `approximate-character-v1` heuristic (~4 characters/token) with
`approximate: true`. A profile with `approximate: false` MUST return a
deterministic non-negative integer; an invalid plugin tokenizer stops the
request instead of understating the token budget.
