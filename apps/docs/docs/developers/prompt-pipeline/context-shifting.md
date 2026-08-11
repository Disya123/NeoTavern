---
title: Context Shifting
description: >-
  How the pipeline fits the assembled context into the token budget, the
  pre-request steps, and the truncate, summarize, vector-recall, and manual
  strategies.
sidebar_position: 5
---

Context shifting fits the assembled conversation into the model's token
budget by removing or compressing the least important context while keeping
everything that must stay.

## Pre-Request Steps

Before a request is sent, the pipeline follows these steps:

1. Determine the tokenizer profile and the context limit of the model.
2. Reserve space for the response.
3. Keep the system prompt, the character, required lorebook entries, and
   pinned messages.
4. Remove or compress the oldest unpinned blocks first.
5. Remove tool-call and tool-result messages only as a pair.
6. Recount tokens after every change.
7. Show the user what was excluded or summarized.

If the protected context alone exceeds the budget, generation ends with the
stable `TOKEN_BUDGET_EXCEEDED` error instead of sending an over-budget
request to the provider.

## How Shifting Works

`shiftContext(messages, countTokens, budget)` adjusts the dialogue to the
token budget. It returns three lists:

- `kept` — the messages that fit;
- `excluded` — the messages removed, shown to the user;
- `truncated` — blocks that were compressed rather than dropped.

System messages and pinned messages are always protected. The oldest
unpinned blocks are removed first. Tool calls and their results are linked
through `toolCallId`, `tool_call_id`, or `callId` and removed as one group,
even when they are not adjacent.

## Built-in Strategies

The strategy is selected by the `contextStrategy` setting and applied
through the `ContextStrategyRegistry`:

- **truncate** — removes the oldest unpinned groups.
- **summarize** — builds a local extractive summary of the excluded history
  and keeps it before the current user input.
- **vector-recall** — drops low-relevance lorebook and memory blocks before
  high-relevance ones, then shortens old history.
- **manual** — first excludes messages flagged `meta.manualExcluded: true`
  (including their paired tool-call and tool-result), then continues with
  normal reduction if more space is needed.

## Plugins and the Budget

Plugins may register additional strategies; registering returns a cleanup
function. A plugin strategy cannot bypass the budget:

- the host restores required messages and rejects a strategy that removed
  protected context;
- the host independently recounts the real budget;
- counting and shifting run before plugin interceptors, and a mandatory
  re-count with a final shift runs after them — a plugin cannot add
  messages late to sneak past the limit.

## The Context Audit

Every generation creates a `PromptContextAudit` before the network call and
finishes it with one terminal status: `completed`, `failed`, or `cancelled`.
The audit records:

- the generation ID, provider, and model;
- every prompt block in actual order, with token counts and the stable
  reason for inclusion or exclusion;
- the context limit, the response reserve, and the final prompt-token
  count;
- the tokenizer profile and whether it is approximate;
- the final provider messages and the plugin-interceptor diagnostics;
- a normalized provider error code, without upstream response bodies.

Only the last complete audit per chat is kept in the database; a new
request atomically replaces the old one, and deleting the chat deletes the
audit. The UI reads it through `GET /api/v2/chats/:id/context-audit`.

A live preview endpoint, `POST /api/v2/context-preview`, runs the same
persona, lorebook, memory, template, tokenizer, and shifting stages without
creating messages, branches, or audits.

## See Also

- [Pipeline Stages](stages) for where shifting sits in the stage order.
- [Tokenization](tokenization) for how tokens are counted.
- [Data & Storage](../data/) for where audits are stored.
