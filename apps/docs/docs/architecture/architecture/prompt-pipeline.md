---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/prompt-pipeline.md
---

# Prompt pipeline (ТЗ §9.1–§9.2, Этап 2.6)

> **Status.** Kernel plane, Этап 2.6 delivered: the runtime-kernel prompt
> pipeline builds an immutable **PromptPlan** for every generation run —
> character/persona/lorebook system blocks, bounded history selection, a
> heuristic token budget with explicit truncation — stores it durably
> (`prompt_plans`, migration 5) and hands the instruct-neutral message array
> to the provider adapter. The user can inspect what was included or cut via
> the `generation.prompt.plan` wire op (§9.2).

The pipeline implements the ТЗ §9.1 stage order inside the Kernel
(AGENTS.md §8), producing the durable plan the run executes against:

```text
User input
→ Character/persona data      (character card: description + personality)
→ Lorebook                    (keyword activation, constant/selective rules)
→ History selection           (bounded window, non-tool roles)
→ Token counting              (local heuristic, explicitly approximate)
→ Context shifting            (drop oldest unpinned, record excluded)
→ Instruct-neutral messages   (plain role/content array)
→ Provider serialization      (the adapter serializes the array)
→ Streaming → durable save    (executor, Этап 2.7/2.8)
```

## The PromptPlan

`crates/runtime-kernel/src/prompt.rs` builds one immutable plan per run
(`PromptPlan`, camelCase serde — the stored `plan_json` equals the wire
`wire.prompt.plan` shape):

| Field               | Meaning                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `runId`, `chatId`   | The run this plan belongs to.                                                                                   |
| `provider`, `model` | The provider attempt the plan feeds.                                                                            |
| `instructFormat`    | `plain-messages-v1` — the instruct-neutral message array; template rendering (ChatML/Alpaca…) is a later stage. |
| `tokenizerProfile`  | `heuristic-v1` (approximate).                                                                                   |
| `approximateTokens` | Always `true` today — the kernel has no model-specific tokenizer yet.                                           |
| `contextLimit`      | Model context window (adapter-declared) or the 8192 fallback.                                                   |
| `responseReserved`  | Room reserved for the provider response (`min(2048, limit/4)`).                                                 |
| `inputTokens`       | Estimated input tokens after truncation.                                                                        |
| `overBudget`        | `true` when the plan still exceeds the available window after dropping all unpinned history.                    |
| `systemBlocks`      | Rendered blocks by source (`character`, `persona`, `lorebook`) — shown to the user.                             |
| `messages`          | Final instruct-neutral array: merged system message + selected history + the user message (pinned last).        |
| `excluded`          | `{messageId, reason}` per dropped message (reason `token_budget`).                                              |

## Stages

- **Character/persona** — the chat's character card contributes a
  `character` block (description) and a `persona` block (the SillyTavern
  card field `ext_json.personality`/`persona` when the host preserved it).
  All system blocks merge into the single leading `system` message.
- **Lorebook** — activation mirrors the legacy retrieval rules
  (`apps/server/src/lib/lorebookRetrieval.ts`): constant entries always
  inject; keyword entries match case-insensitively against the user message
  plus the recent-history tail; selective entries additionally need a
  secondary key; disabled entries never activate. Parsing is defensive —
  a malformed entry is skipped, never fails the plan. **Limitation:**
  the kernel schema has no character↔lorebook linkage yet, so all books are
  scanned (bounded at 2000 entries / 24 injected blocks); scoping arrives
  with the lorebook CRUD cutover.
- **History selection** — the last 128 non-tool messages (chronological),
  excluding `tool` roles (tool-call loop is Этап 2.7).
- **Token budget** — `heuristic-v1` counts CJK chars as 1 token each, other
  chars as 1 token per 4 (ceil), plus per-message overhead. It is
  approximate by design and flagged as such in the plan; a
  Tiktoken-compatible registry replaces it later without contract changes.
- **Context shifting** — while over budget, the oldest unpinned history
  message is dropped and recorded in `excluded` (the system prompt and the
  user message stay pinned). If the plan still overflows after dropping all
  history, `overBudget: true` (the provider may reject the request).
- **Instruct-neutral output** — the plan's `messages` array is what adapters
  serialize (AGENTS.md §9: plain role/content until provider-specific
  serialization). The OpenAI-compatible adapter emits it verbatim as the
  chat-completions `messages`; adapters without a plan fall back to the
  single `input` message.

## Execution integration

`execute_stream` builds the plan **before** the provider attempt (after
secret resolution, before `generate`): a plan that cannot be built or stored
fails the run with the stable terminal code `PROMPT_PLAN_FAILED` — the
pipeline is mandatory for run execution. The plan's message array travels to
the adapter via `ProviderRequest.messages` (`provider-sdk::PromptMessage`).
The plan row is keyed by `run_id` (one plan per run; retry attempts create
new runs and therefore new plans) and deleted with the run
(`ON DELETE CASCADE`).

## Wire surface

`generation.prompt.plan` (`app.read`, transactional, idempotent):
request `{ runId }` → `wire.prompt.plan`. Missing plan → stable
`PROMPT_PLAN_NOT_FOUND` (params `runId`). DTOs: `wire.prompt.plan`,
`wire.prompt.message`, `wire.prompt.block`, `wire.prompt.excluded`,
`wire.request.get-prompt-plan`.

## Tests

- `crates/runtime-kernel/src/prompt.rs` unit tests (5): the heuristic
  estimator (Latin/CJK), system-block merging, budget truncation with
  excluded ids, lorebook keyword activation (match + no-match), and the
  camelCase plan shape.
- `crates/runtime-kernel/tests/prompt_plan.rs` (2): the golden path —
  `generation.start` on a seeded character/chat/history completes, the
  durable `prompt_plans` row survives a kernel reopen, and
  `generation.prompt.plan` serves the plan (character + persona blocks,
  history + user selected, `excluded` empty at the default budget); unknown
  run → `PROMPT_PLAN_NOT_FOUND`.
- `crates/provider-openai-compat` — `rendered_plan_messages_serialize_into_the_body`
  proves the adapter serializes the plan array verbatim.

## Honest boundaries

- Tokenization is approximate (`heuristic-v1`, flagged); a model-specific
  tokenizer registry is future work.
- Instruct format template rendering (ChatML/Alpaca strings) is not yet
  implemented — the pipeline emits the structured instruct-neutral array.
- Macros, memory/RAG, plugin interceptors and tool-message pairing are later
  stages (Этап 2.7 / М4).
- Lorebook scoping to characters and `lorebook` CRUD over the kernel are
  pending the lorebook cutover.

## Related documents

- [Providers](providers.md) — the adapter contract and secret flow the plan
  feeds.
- [Generation durability](generation-durability.md) — the durable run
  workflow that executes the plan.
- [Wire contracts](wire-contracts.md) — `generation.prompt.plan` and the
  prompt DTOs.
- [Legacy prompt pipeline](https://github.com/Disya123/NeoTavern/blob/main/apps/server/src/pipeline/promptPipeline.ts) —
  the legacy reference implementation the rules mirror.
