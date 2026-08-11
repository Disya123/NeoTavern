---
title: Tokenization
description: >-
  Local token counting through the tokenizer registry: tiktoken-compatible,
  SentencePiece, Hugging Face JSON, model-specific plugins, and the
  approximate fallback.
sidebar_position: 4
---

Token counting runs locally through a tokenizer registry that supports
tiktoken-compatible, SentencePiece, Hugging Face JSON, and model-specific
plugin tokenizers, with an explicit approximate fallback.

## Local Counting

Token counting never leaves the machine. The registry selects a tokenizer
profile for the active model, and the pipeline counts the assembled context
in-process before any network request.

## The Tokenizer Registry

The registry accepts four kinds of tokenizers:

- **Tiktoken-compatible** — BPE tokenizers compatible with OpenAI's
  tiktoken, for OpenAI model families.
- **SentencePiece** — models that ship SentencePiece vocabularies.
- **Hugging Face tokenizer JSON** — `tokenizer.json` files from Hugging
  Face repositories, converted to a compact rank format.
- **Model-specific plugins** — provider plugins may register a precise
  tokenizer profile for a model.

An **approximate fallback** exists for models with no registered tokenizer,
and it is always labeled explicitly, so the UI never presents an estimate as
an exact count.

## Built-in Profiles

The core registers offline profiles for the common families:

- `openai:o200k_base` — GPT-4o, GPT-4.1, GPT-5, o1, o3, and o4 families.
- `openai:cl100k_base` — GPT-4, GPT-3.5 Turbo, and text-embedding-3.
- `deepseek:bytelevel-bpe-v1` — DeepSeek families. Counting runs through a
  compact counting-only engine (a BPE merge port with no vocabulary and no
  decoder) over the ranks of the official `tokenizer.json`. The file is
  converted once into a small rank file cached in
  `data/cache/tokenizers/deepseek-v4-flash/` via atomic temp-plus-rename
  writes; the full JSON and the runtime tokenizer library are neither
  stored nor loaded.

If the network is unavailable, the DeepSeek profile honestly falls back to
the approximate profile and retries at most once per 15 minutes — a missing
tokenizer never blocks generation.

## Approximate Fallback

Unknown local models use `approximate-character-v1`, a script-aware
heuristic: roughly 4.6 characters per token for Latin, 4.0 for Cyrillic,
1.7 for CJK, and 2.0 for digits. The approximation is flagged everywhere it
appears, and a provider plugin can replace it at any time by registering a
precise profile.

## Plugin Profiles

Plugins register tokenizer profiles with a priority. A plugin profile with
priority above `-10` overrides the family profile for the models it covers.
The selected profile is passed into the pipeline as `countTokens`,
`tokenizerProfile`, and `tokenizerApproximate`.

## The Token Budget Result

After counting, the pipeline exposes `PipelineResult.tokenBudget`, which
contains:

- the tokenizer profile used;
- the `approximate` flag;
- the model's context limit;
- the reserved response space;
- the final prompt-token count.

See [Context Shifting](context-shifting) for how the budget is enforced.
