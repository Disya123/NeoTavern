---
title: Prompt Pipeline
description: >-
  Overview of the prompt pipeline: the fixed stage order, instruct formats,
  local token counting, and context shifting.
sidebar_position: 1
---

The prompt pipeline is the fixed, ordered set of stages that turns a chat
into a provider request, from user input to the saved message.

## What the Pipeline Does

Every generation — a new message, a swipe, a regeneration, or an
impersonation — runs through the same stages in the same order. The pipeline
assembles the context from the character, persona, lorebook, and memory,
counts tokens, fits the context into the model's budget, lets plugins
intercept, renders the request in the selected instruct format, and finally
streams and saves the response.

## Pages in This Section

- [Pipeline Stages](prompt-pipeline/stages) — the 14 stages in order and the rules every
  plugin hook must follow.
- [Instruct Formats](prompt-pipeline/instruct-formats) — how the clean message array is
  rendered with sandboxed Handlebars templates.
- [Tokenization](prompt-pipeline/tokenization) — the local tokenizer registry and its
  approximate fallback.
- [Context Shifting](prompt-pipeline/context-shifting) — how the pipeline fits the context
  into the token budget and which strategies exist.

## Implementation

The pipeline lives in `apps/server/src/pipeline/`. It runs entirely on the
server, before any network call, so the request that reaches a provider is
always the result of the same deterministic stages.

## Related Sections

- Plugin interceptors and their registration APIs are documented in the
  [Plugin SDK](plugin-sdk/).
- The generation endpoint and the context audit are part of the
  [API Reference](../api/).
- Provider adapters that consume the serialized request are documented
  under [Providers](providers/).
