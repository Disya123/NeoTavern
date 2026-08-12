# Architecture

NeoTavern is a local application: a single Fastify process serves the API and
(optionally) the built frontend. No PostgreSQL/Redis/Docker.

## Stack

- Node.js 24 LTS (target; code is compatible with >=22), Fastify 5.
- React 19.2 + Vite 8, TypeScript `strict`.
- SQLite via better-sqlite3 + Drizzle ORM, WAL, FTS5.
- Radix Primitives, CSS Modules + Custom Properties + Cascade Layers.
- i18next, TanStack Query, Zustand.
- In-house Plugin SDK and Theme SDK; Legacy Compatibility Layer.

## Monorepo structure

```text
apps/
  server/   # Fastify backend, prompt pipeline, SSE, legacy host
  web/      # React SPA
  desktop/  # Tauri 2.x shell: server runs as a sidecar process
            # (see docs/desktop), resources — resources/{web,native,runtime}
packages/
  shared/        # IDs (UUIDv7), Result, errors, logger, async utilities
  contracts/     # TypeBox API schemas — single source of truth
  db/            # SQLite: schema, migrations, repositories, FTS5
  provider-sdk/  # adapter contract + adapters + registry
  plugin-sdk/    # manifest, capability grants and kernel (rev4), frontend/backend contracts
  theme-sdk/     # tokens, inheritance, CSS variable generation
  i18n/          # i18next, en/ru resources, error localization
  ui/            # headless components on Radix + data hooks
  gestures/      # framework-agnostic chat gestures: context menu, drag
  legacy-compat/ # window globals, DOM islands

crates/
  contracts-generated/ # generated Rust boundary DTOs + validators (do not edit)
  runtime-kernel/      # portable Rust kernel: dispatch, handshake, storage attach
  storage/             # SQLite ownership: lease, migrations, assets, snapshot,
                       # recovery (ТЗ Фаза 2)
  adapters/
    remote-http/       # Phase 4 headless/remote adapter: HTTP/SSE → same Kernel
                       # (tiny_http, envelope-over-HTTP, ADR-0030)
```

Dependencies only go "downward": `server`/`web` → packages; packages → `shared`/
`contracts`. Cyclic dependencies are forbidden (AGENTS.md §3).

## Data flow

1. Frontend (TanStack Query) calls `/api/v2/*`.
2. Fastify validates input against TypeBox schemas; errors → `{ code, params, traceId }` envelope.
3. Repositories work with SQLite (cursor pagination, FTS5).
4. Generation: `POST /api/v2/chats/:id/generate` → prompt pipeline → provider
   adapter → SSE stream → message save.

## Frontend App Shell

`AppShell` mounts once around the chat workspace. The main routes
`/home` and `/chats/:chatId` change only the chat. `Characters`, chat history,
providers, settings, themes, plugins and plugin pages render through
`SystemSurface` in a Radix Dialog portal over the preserved background location
via a shared `SurfaceDialog` (the same glass shell, close and
`data-component="system-surface"`). Nested manager editors such as
`PromptBlockEditorDialog` reuse the same shell rather than a separate dialog
chrome.
Therefore opening a system tool does not unmount the chat, does not discard
session-only drafts, and preserves deep links/Back/Escape.

TanStack Query remains the only server-state store. Zustand holds only
transient UI state: the active panel, theme/language/interface preferences,
the pinned character, and limited session-only drafts. Drafts are not written
to browser storage.

## API connection surface

The provider editor (panel and page) reproduces the behavior of the classic
SillyTavern API tab on top of the in-house stack: source selection from the
catalog, keys via the secret manager, model discovery, "Connect", message
test, connection status. Additionally:

- **Additional Parameters** — a modal with three JSON fields (include body
  / exclude body / include headers), saved into the provider's `settings` and
  server-validated. ST1's YAML was replaced with structured JSON
  (see [ADR-0008](../adr/README.md#adr-0008-json-instead-of-yaml-for-additional-parameters)).
- **Prompt Post-Processing** — a select of modes (`merge`/`semi`/`strict`/`single`
  and `_tools` variants), saved in `settings.promptPostProcessing`;
  the message array transformation runs on the server at the request
  preparation stage.
- **Auto-connect to Last Server** — `AppSettings.autoConnect` + `lastServer`
  (not in `ui`, this is application behavior). "Connect" writes `lastServer`;
  on load `AutoConnectSync` restores and re-validates the last connection
  without breaking provider-readiness consumers.

### Source catalog and adapters

Each source from the catalog (`GET /api/v2/providers/catalog`) maps to one
`adapterKind` — an implementation of the single `ProviderAdapter` contract
(`packages/provider-sdk`). Built-in kinds:

| adapterKind         | Sources                                               | Transport                                          |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `openai-compatible` | openai, deepseek, groq, mistralai, openai-compatible… | `/v1/chat/completions` (SSE)                       |
| `anthropic`         | anthropic                                             | Messages API (prompt caching)                      |
| `text-completion`   | text-completion, ooba, koboldcpp, vllm, ollama        | `/v1/completions` (legacy text)                    |
| `novelai`           | novelai                                               | `/ai/generate`                                     |
| `ai-horde`          | ai-horde                                              | async submit → poll `/api/v2/generate/text/status` |
| `koboldai`          | koboldai                                              | `/api/v1/generate`                                 |
| `echo`              | —                                                     | offline check without network                      |

**Chat vs text mapping rule.** Chat adapters (`openai-compatible`,
`anthropic`) receive an array of `GenerationMessage[]` (`serializeAsText=false`).
Text adapters (`text-completion`, `novelai`, `ai-horde`, `koboldai`) receive
the already-rendered instruct prompt as a single `user` message
(`serializeAsText=true`, see [prompt pipeline](../prompt-pipeline/README.md))
and collapse `request.messages` into a prompt string themselves. This rules out
double formatting: instruct rendering happens exactly once at the pipeline
stage.

Adapters are implemented on plain `fetch` by default, without vendor SDKs
(AGENTS.md §7). The only documented exception is Anthropic (`@anthropic-ai/sdk`):
the beta API surface (extended thinking and others) is supported more precisely
by the official SDK. NovelAI, AI Horde and KoboldAI Classic are marked
experimental: the request/response format is reproduced from the documentation
and covered by transport mocks, but the stability of unconfirmed endpoints is
not guaranteed. AI Horde supports anonymous mode (key not required) and polls
the queue at a configurable interval; job idleness is bounded by an idle
deadline.

## Boundaries and security

- Backend listens on `127.0.0.1` by default; remote access is explicit.
- Non-loopback bind without remote opt-in is blocked. Remote browser uses a
  bounded HttpOnly/SameSite session, an exact Origin, and an in-memory CSRF
  token; production remote origin must be HTTPS.
- API keys are stored in the `provider_secrets` table (several named keys per
  provider, one active). Values are write-only: only a masked preview leaves
  the server; the plaintext key is available to internal runtime methods and
  the `/reveal` route behind the explicit server flag
  `NEOTA_ALLOW_SECRETS_EXPOSURE` (off by default). Keys are never serialized
  into responses/logs.
- CSP, CORS restrictions, input validation, safe mode for themes/plugins.
- The diagnostics boundary exports only an aggregated typed projection:
  raw settings, logs, paths and user strings are not read and do not pass
  through the shared "secret editor" after serialization.

See also: [API](../api/README.md), [data](../data/README.md),
[prompt pipeline](../prompt-pipeline/README.md).

## Migration to ТЗ 7.2 (Phase 0 in progress)

The target architecture (NeoTavern ТЗ 7.2: product-first / local-first /
host-neutral) migrates from the current Fastify-server model toward a small
portable Rust Runtime Kernel behind stable Product Wire Contracts. Work is
delivered per phase gates (ТЗ §78); nothing is declared stable until its exit
gate passes.

- [Operations inventory](operations-inventory.md) — current `/api/v2` surface
  and the feature → writer ownership/routing table.
- [Product Wire Contracts](wire-contracts.md) — canonical TypeBox contracts,
  wire-safe rules, handshake, versioning, deterministic codegen and the
  cross-language corpus.
- [Runtime Kernel + Storage foundation](../../crates/runtime-kernel/README.md) —
  Phase 1 kernel skeleton (dispatch, handshake, cancellation, local/headless
  adapters) and Phase 2 storage crate (see
  [`crates/storage/README.md`](../../crates/storage/README.md)): exclusive
  data-root lease, pinned SQLite baseline (3.53.2 bundled), migration ledger
  with checksums, immutable assets with orphan GC, Backup-API recovery snapshot
  and read-only Recovery Mode. The kernel opens durable storage via
  `KernelConfig::data_root`; a second writable process gets a controlled
  `DataRootInUse` error (ТЗ §22).
- [NeoBackend UI routing](../../apps/web/src/api/backend.ts) — the web app
  routes every API call through the `NeoBackend` facade singleton
  (`LegacyBackend` transport today). Typed wire operations use the facade's
  domain APIs; the 20 remaining `/api/v2` call sites (messages, drafts,
  snapshots, blocks, providers, legacy bridge) go through the documented
  temporary `raw` passthrough and are deleted per-slice in Фаза 3.
- [Version axes](version-axes.md) — independent versioning of app, storage,
  wire protocol, SDKs and formats.
- [Phase 4 Remote Adapter](../../crates/adapters/remote-http/README.md) —
  headless/remote HTTP+SSE surface on the **same Runtime Kernel** as local
  IPC: `GET /meta`, `POST /rpc`, `POST /rpc/stream`, envelope-over-HTTP status
  mapping (400/404/405/413/426), loopback-by-default with fail-closed
  non-loopback bind, and one writer coordinator (`Arc<Mutex<Kernel>>`).
  See [ADR-0030](../adr/README.md#adr-0030-remote-http-adapter) and
  [Wire contracts §6.1](wire-contracts.md#61-http-transport-mapping-phase-4-remote-adapter).
- [Generation durability](generation-durability.md) — Phase 6: recoverable
  generation workflows over the same kernel — durable state machine
  (`generation_runs`/`generation_events`, migration 3), CAS transitions by
  revision, deterministic fake provider with fault injection, at-least-once
  sequenced SSE with `Last-Event-ID` resume, and idempotent Retry/Keep/Discard
  reconciliation (ТЗ §62–§64).
- [ADR-0029](../adr/README.md#adr-0029-wire-contract-toolchain) — the
  contract toolchain decision.
