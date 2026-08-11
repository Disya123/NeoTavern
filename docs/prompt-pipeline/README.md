# Prompt pipeline

## Connection-profile additions

Before provider serialization the pipeline merges profile stop strings with
format and explicit generation stops, preserving the first occurrence of each
non-empty value. `assistantPrefill` is part of the typed `GenerationRequest`.
The host prepends it exactly once to the first streamed text delta (and to a
non-streaming terminal result); built-in adapters also receive it as the
assistant turn that generation continues from.

Fixed stage order (AGENTS.md §8):

```
User input → Macros → Character/persona data → Lorebook → Memory/RAG →
Token counting → Context shifting → Plugin interceptors →
Instruct format rendering → Provider serialization → Request →
Streaming response → Post-processing → Save message
```

Implementation: `apps/server/src/pipeline/`.

## Macros

`{{user}}`, `{{char}}` and custom variables are resolved before rendering
(`replaceMacros`). Unknown macros are left as-is.

## Instruct formats

Rendering via Handlebars in an isolated environment (no Node/FS/code, only
`content/role/name`). Built in: `chatml`, `llama3`, `alpaca`, `mistral`,
`command-r`. Up to the render stage the pipeline works with a plain message
array; the result is a prompt string for text-completion providers and
diagnostics. Versioned JSON presets are validated via `importInstructFormat()`
and exported as JSON-safe separated values via `exportInstructFormat()`.

The custom format is stored in `AppSettings.instructFormat`. When enabled, the
plain message array after all interceptors is rendered into a single string,
that string is sent to the provider as the user prompt, and `stopStrings`
become the request's stop sequences. With `null`, the standard structured
message serialization is used.

Final serialization (`serializeAsText`) is chosen by the template mode
(`text`), the presence of an explicit/selected instruct format, and the
provider type. Text adapters (`text-completion`, `novelai`, `ai-horde`,
`koboldai`) always receive the rendered instruct prompt as a single `user`
message and collapse `request.messages` into a string themselves; chat
adapters (`openai-compatible`, `anthropic`) receive a structured
`GenerationMessage[]` array. Thus instruct rendering happens exactly once and
is not duplicated by adapter-side formatting (see
[architecture](../architecture/README.md#source-catalog-and-adapters)).

Saved `generationDefaults` are merged with the specific request's parameters;
request parameters take precedence. `temperature`, `topP`, `topK`, `minP`,
`topA`, repetition/frequency/presence penalties, `seed`, reasoning effort,
streaming, and the response limit are passed into the pipeline.

### Reasoning controls

`reasoning` and `reasoningEffort` are different provider-neutral parameters.
The OpenAI-compatible adapter does not use the boolean `reasoning`: if
`reasoningEffort` is set, it sends it as `reasoning_effort`; the "provider
default" value leaves the field unset. The contract accepts the combined set
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, but a concrete
model may support only some levels and reject the rest. The current OpenAI
matrix is described in the [official model guide](https://developers.openai.com/api/docs/guides/latest-model).

NanoGPT accepts extended sampler fields and `reasoning_effort` through the
Chat Completions API. Its provider capability restricts the UI to `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`; the adapter does not send `max`.
The full parameter list is supported per the [official NanoGPT
documentation](https://docs.nano-gpt.com/api-reference/endpoint/chat-completion).

Anthropic uses a separate boolean `reasoning` to enable adaptive thinking. Its
UI offers only `low`, `medium`, `high`; a saved legacy `minimal` value is
compatible and serializes as `low`. Values from other providers are not
silently converted.

## Prompt post-processing (message reassembly)

In chat mode (`serializeAsText=false`), the `GenerationMessage[]` array may be
reassembled before provider serialization — a port of the `mergeMessages`
algorithm from classic SillyTavern
(`apps/server/src/pipeline/promptPostProcessing.ts`). In text mode the stage
is skipped: roles are already collapsed by the instruct render into a single
string. The mode is taken from the provider setting `promptPostProcessing` and
applied via `postProcessMessages(messages, mode, names)`.

Supported modes:

- `merge` — collapses adjacent messages with the same role (joined by `\n\n`);
  messages with role `tool` are never collapsed;
- `semi` — same as `merge`, plus intermediate `system` messages become `user`,
  after which the array is collapsed again;
- `strict` — guarantees that `user` comes first (inserts a placeholder if
  needed), turns intermediate `system` into `user`, and collapses again;
- `single` — folds all messages into one `user`, adding name prefixes
  (`{{char}}:`/`{{user}}:` per `names`);
- `_tools`-suffixed variants (`merge_tools`, `semi_tools`, `strict_tools`)
  keep messages with role `tool`; the base modes rewrite `tool` into `user`.

Empty content after collapsing is replaced with a placeholder (`Let's get
started.` by default). Names from dialogue examples
(`example_assistant`/`example_user`) and explicit `name` values are expanded
into prefixes. The canonical message array in `PipelineResult.messages` stays
pre-reassembly; the transformed array appears only in
`PipelineResult.request.messages`.

## Additional parameters (request extras)

SillyTavern's classic "Additional Parameters" are stored in the provider
settings as structured JSON (see [API](../api/README.md) and
[ADR-0008](../adr/README.md#adr-0008-json-instead-of-yaml-for-additional-parameters))
and applied by adapters at the request serialization stage
(`packages/provider-sdk/src/additionalParams.ts`):

- `customIncludeBody` — object, merged into the request body;
- `customExcludeBody` — body keys removed after the merge;
- `customIncludeHeaders` — additional request headers.

The protected headers `Authorization`, `Content-Type` and `Content-Length`
are **never** overwritten via `customIncludeHeaders`
(case-insensitively): credential and content-negotiation control stays with
the adapter. The `openai-compatible` and `text-completion` adapters support
application; values are defensively coerced at the boundary, and invalid
settings are ignored.

## Prompt templates

The advanced setting `promptTemplateMode` is separated from the final
instruct-format render:

- `chat` uses the system Chat template and the canonical stage order;
- `text` assembles the enabled blocks in the order of the
  `promptTemplate.blocks[]` elements.

Supported blocks: main prompt, lorebook before character, persona, character,
lorebook after character, dialogue examples, memory, chat history,
post-history instructions, and the current user input. The system prompt and
post-history instructions are stored separately and inserted exactly at their
block positions. Host blocks have stable ids and must be present in the array
exactly once; their dynamic text (Lorebook, persona, character card fields,
history, Memory/RAG, and Author's Note) is shown by the editor as an external
source. Importing and saving a prompt-template preset check the full host
block set and the uniqueness of all ids; an invalid preset never becomes
active.

The Prompt Manager also accepts up to 116 custom entries with ids `custom-*`.
Entry fields:

- `name`, `role` (`system | user | assistant`) and `content`;
- `enabled`;
- `triggers` (`normal`, `continue`, `impersonate`, `swipe`, `regenerate`,
  `quiet`); a missing array means all actions;
- `injectionPosition: relative | in-chat`;
- `injectionDepth` (`0` — after the last message, `1` — before it) and
  `injectionOrder` for equal depths;
- `model` — binding the block to a single model (id, free text, as in the
  provider model field). An empty/missing value applies the block to all
  models; when it does not match the active model, the block is excluded from
  the prompt (the audit shows the `model-mismatch` reason). The binding is
  chosen in the block edit dialog through the same model menu as the providers
  (loading the active provider's model list);
- `forbidOverrides` for Main Prompt: the character card system prompt does not
  replace the saved text.

`relative` entries follow their position in the array. `in-chat` entries are
inserted inside Chat History; at equal depth/order, roles sort as Assistant,
User, System. Macros are resolved before insertion. Custom entries are not
pinned and remain available to context shifting, and the final token budget is
still checked after plugin interceptors.

The Prompt Manager saves template changes automatically after a short delay;
the buttons in the top toolbar save and serve exactly the reusable preset.
Order changes via a separate drag handle with independent mouse and touch
handlers; the enable toggle sits before the block name. `Chat History` is
always pinned second-to-last, `Post-History Instructions` last; their handles
are replaced by a lock, and the pipeline normalizes old saved templates into
this order too. Therefore user input/history serialize before the system
post-history instructions, and no other relative block can end up after them.
If a prompt audit exists for the active chat, the list shows its token counts;
before the first audit, static prompts get a local estimate and dynamic host
blocks are marked `—`.

First the template determines the composition of the clean messages, then
context shifting and interceptors work on them, and only after that
`chatSerialization` either keeps the messages structured (`native`) or renders
the selected Handlebars instruct format (`custom`). This preserves a single
pipeline order and does not let the UI template bypass the final token
budget.

## Context shifting

The pipeline accepts ranked `contextBlocks` from Lorebook and Memory/RAG.
Required blocks (`required: true`), the system prompt, post-history
instructions, pinned messages, and the current user input are protected from
removal. If the protected context alone exceeds the budget, generation fails
with the stable error `TOKEN_BUDGET_EXCEEDED` instead of sending the provider
an over-budget request.

`shiftContext(messages, countTokens, budget)` fits the dialogue to the token
budget:

- system messages and `pinned` are protected;
- the oldest unpinned blocks are removed first;
- tool-call and tool-result are removed as a linked pair;
- tokens are recounted after each removal;
- returns `kept`, `excluded` (shown to the user), and `truncated`.

Built-in strategies:

- `truncate` — removes the oldest unpinned groups;
- `summarize` — creates a local extractive summary of the excluded history and
  stores it before the current user input;
- `vector-recall` — removes low-relevance Lorebook/Memory blocks before
  high-relevance ones, then trims the old history;
- `manual` — first excludes messages with `meta.manualExcluded: true`,
  including the linked tool-call/result pair; if that is not enough, it safely
  continues with ordinary trimming.

The strategy is chosen by the `contextStrategy` setting and applied through
`ContextStrategyRegistry`. Plugins can register their own implementations;
registration returns a cleanup. The host restores required messages, rejects a
strategy that removed protected context, and independently recounts the real
budget.

Counting and context shifting run before plugin interceptors. After all
interceptors, a mandatory recount and final shift run: a plugin cannot bypass
the limit by adding messages after the first check. Tool-call/tool-result are
linked via `toolCallId`, `tool_call_id`, or `callId` and removed as one group,
even when they are not adjacent.

`PipelineResult.tokenBudget` contains the tokenizer profile, the
`approximate` flag, the context limit, the response reserve, and the final
prompt token count. The core registers exact offline profiles
`openai:o200k_base` for the GPT-4o/GPT-4.1/GPT-5/o1/o3/o4 families and
`openai:cl100k_base` for GPT-4, GPT-3.5 Turbo, and text-embedding-3. The
DeepSeek family is covered by the exact profile `deepseek:bytelevel-bpe-v1`:
counting goes through a compact counting-only engine (a port of the BPE merge
from tokenizers-lib: heap keyed by `rank + position/len`, without vocab or
decoder) over the ranks of the official `tokenizer.json` repository
`deepseek-ai/DeepSeek-V4-Flash` (vocab/merges identical to V3 and refresh
releases). The downloaded `tokenizer.json` is converted once into a compact
ranks file (~1.4 MB) plus a list of added tokens, cached in
`data/cache/tokenizers/deepseek-v4-flash/` (atomic write via temp + rename);
the ~6 MB JSON and the tokenizer runtime library are not stored or loaded.
When the network is unavailable, the profile honestly falls back to
`approximate-character-v1` and retries no more than once per 15 minutes, so a
missing tokenizer never blocks generation. A plugin profile registered with
priority above `-10` overrides the DeepSeek family profile. Unknown local
models use the explicitly marked `approximate-character-v1` (script-aware
heuristic: Latin ~4.6, Cyrillic ~4.0, CJK ~1.7, digits ~2.0 characters per
token) until a provider plugin registers a Tiktoken, SentencePiece, Hugging
Face JSON, or model-specific profile.
The selected profile is passed into the pipeline as `countTokens`,
`tokenizerProfile`, and `tokenizerApproximate`.

## Context audit

Every generation creates a `PromptContextAudit` before the network call and
finishes it with one terminal status: `completed`, `failed`, or `cancelled`.
The record contains:

- generation id, date, provider/model, and prompt template/serialization modes;
- every prompt block in actual order with token count, an
  included/excluded flag, and a stable exclusion reason;
- context limit, response reserve, final prompt token count, and the tokenizer
  profile with the approximate flag;
- final provider messages and the plugin-interceptor diagnostics log;
- a normalized provider error code without the upstream body.

Only the last complete audit of each chat is stored in the DB; a new request
atomically replaces the old one, and deleting the chat cascades to the audit.
The UI reads it via `GET /api/v2/chats/:id/context-audit` to diagnose the
actually sent request. The current context counter does not use a historical
audit as live state for the next generation.

The home screen and the existing chat use one live-preview hook and one
`ContextUsagePanel`. `POST /api/v2/context-preview` accepts either a
`characterId` for a conversation not yet created, or a `chatId` for an
existing one. In the second case the server reads the active branch and
temporarily adds the draft without creating a message, branch, or audit. Both
variants run the same persona, Lorebook/Memory retrieval, Prompt Template,
instruct format, tokenizer, and context shifting stages.

Both surfaces group only enabled entries by history, Lorebook, character card,
persona, and other prompt blocks. When a preview is unavailable, the UI
explicitly shows a local estimate of only the visible history and draft;
character card, Lorebook, and persona values are not faked. The preview does
not run frontend plugin interceptors, because they require the generation SSE
bridge; the actual audit remains a separate diagnostic snapshot of the last
request.

Home and Chat load the preview after source/settings readiness, even when the
panel is collapsed. The shared debounce is 500 ms; changing the draft,
settings, or the history version changes the query key and cancels the stale
request. Until a new preview is ready, both surfaces equally show an
explicitly marked local estimate rather than passing off an old budget as
current.

## Plugin interceptors

Each hook has a priority, a timeout, and error isolation: a broken interceptor
is skipped with a diagnostic log entry, and generation continues. The prompt
change log is returned in `diagnostics` and stored in the `meta` of the
response message.
