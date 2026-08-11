---
title: Memory & Recall
description: Conversation memory, memory entries, vector recall, and RAG in NeoTavern.
sidebar_position: 6
---

This page explains the memory features that help the model remember across
long conversations: the rolling conversation memory, keyword-activated
memory entries, and vector recall.

## Conversation Memory

Every chat keeps a rolling summary that the pipeline maintains as the
conversation grows. When the context-shifting strategy `summarize` is
active, the oldest excluded history is condensed into a local extractive
summary that is inserted before the current user input — so the model keeps
the gist of early events even after the raw messages leave the token
budget. The summary is stored with the chat and survives reloads.

You can see exactly what the current prompt contains before sending: a live
context preview shows the selected tokenizer, the context limit and the
reserved response space, excluded blocks, summarized blocks, and the
strategy applied. See [Settings](settings) for the strategy picker.

## Memory Entries

Memory entries are long-lived knowledge fragments that persist across
chats, independent of any single conversation. Each entry has:

- **Scope** — `global` or bound to a character.
- **Activation keywords** — a case-insensitive substring match against the
  conversation context.
- **Content** — the text injected when the entry fires.

This is the classic RAG pattern: retrieval is triggered by keyword match,
and the injected fragments answer the model's need for stable facts —
character details, world rules, or ongoing plot points — without bloating
every prompt. Like lorebook entries, memory blocks are ranked by relevance
in the prompt pipeline and count toward the token budget.

## Vector Recall

Vector recall is the context-shifting strategy `vector-recall`. Instead of
cutting context purely by age, it ranks lorebook and memory blocks by
semantic relevance to the current input and drops the least relevant ones
first, then trims older history. The result: the model keeps the material
that matters for the current message even when it is not the newest.

The strategy is selected per generation settings, and plugins can add
further strategies through the SDK. Every strategy still respects the final
host-controlled token budget — plugins cannot bypass it.

## Choosing a Strategy

The available strategies are `truncate` (drop oldest unprotected groups),
`summarize` (condense excluded history), `vector-recall` (keep
high-relevance blocks, trim by relevance and age), and `manual` (exclude
specific messages from the prompt without deleting them from history). The
manual mode exposes an action on each message to exclude or restore it, and
tool-call/tool-result pairs are always handled together. See
[Chatting](chat) for message-level controls and
[Lorebooks](lorebook) for the related keyword activation model.
