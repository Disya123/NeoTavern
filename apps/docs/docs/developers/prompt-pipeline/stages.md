---
title: Pipeline Stages
description: >-
  The 14 fixed stages of the prompt pipeline and the rules every plugin
  hook follows: priority, timeout, cancellation, permissions, and isolation.
sidebar_position: 2
---

Generation runs through 14 fixed stages, from user input to saving the
message, and every plugin hook follows the same rules for priority, timeout,
cancellation, permissions, and error isolation.

## The Stage Order

The order is fixed and identical for every generation:

```text
User input
→ Macros
→ Character/persona data
→ Lorebook
→ Memory/RAG
→ Token counting
→ Context shifting
→ Plugin interceptors
→ Instruct format rendering
→ Provider serialization
→ Request
→ Streaming response
→ Post-processing hooks
→ Save message
```

## Stage by Stage

1. **User input** — the draft message and the generation options for this
   request are captured.
2. **Macros** — `{{user}}`, `{{char}}`, and custom variables are resolved by
   `replaceMacros`. Unknown macros are left as-is.
3. **Character/persona data** — the character card fields and the active
   persona are assembled into the message array.
4. **Lorebook** — matching lorebook entries are inserted according to their
   activation rules. Entries marked required are protected from removal.
5. **Memory/RAG** — memory and vector-recall blocks are retrieved and
   ranked.
6. **Token counting** — the local tokenizer profile counts the assembled
   context.
7. **Context shifting** — the context is fitted into the token budget. See
   [Context Shifting](context-shifting).
8. **Plugin interceptors** — plugins may inspect and modify the message
   array. After the last interceptor, the pipeline recounts tokens and
   re-applies the budget, so no plugin can bypass it.
9. **Instruct format rendering** — the clean message array is rendered into
   the selected instruct format, or kept structured. See
   [Instruct Formats](instruct-formats).
10. **Provider serialization** — the adapter builds the provider request:
    chat adapters receive the structured message array, text adapters the
    rendered prompt string.
11. **Request** — the request is sent with an `AbortSignal`, timeouts, and
    client-disconnect handling.
12. **Streaming response** — the response streams over SSE. An optional
    `assistantPrefill` is prepended exactly once to the first delta.
13. **Post-processing hooks** — plugins may process the streamed response
    before it is saved.
14. **Save message** — the final message, its variants, and the generation
    metadata are saved in one transaction.

## Hook Rules

Every plugin hook is defined by the same contract:

- **Order and priority** — hooks run in priority order; equal priorities are
  ordered deterministically.
- **Timeout** — each hook has a timeout. A hook that exceeds it is aborted.
- **Cancellation** — hooks receive the generation's `AbortSignal` and must
  stop work when it fires.
- **Permissions** — a hook only runs if the plugin holds the permissions its
  declared capabilities require.
- **Exception isolation** — an error in one plugin's hook is caught, logged,
  and skipped. The pipeline continues; a broken interceptor must never
  silently break the whole generation.
- **Diagnostic log** — every prompt change is recorded. The change log is
  returned in the generation diagnostics and stored in the response
  message's `meta`, so you can always see what was actually sent.

## Prompt Post-Processing

In chat mode, the message array may pass through an optional rebuild stage
before serialization — the port of the classic `mergeMessages` algorithm.
Modes include `merge`, `semi`, `strict`, and `single`, plus `_tools`
variants that preserve tool messages. In text mode this stage is skipped,
because the instruct render has already collapsed roles into one string.

## See Also

- [Context Shifting](context-shifting) for how the budget is enforced.
- [Tokenization](tokenization) for how token counting works.
- The [Plugin SDK](../plugin-sdk/) for the interceptor and post-processing
  registration APIs.
