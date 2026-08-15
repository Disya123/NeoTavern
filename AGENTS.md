# AGENTS.md

Instructions for AI agents and developers working on NeoTavern.

## 1. Priorities

When making decisions, follow this order:

1. Preservation of user data.
2. Compatibility with existing SillyTavern plugins.
3. Local operation without a mandatory cloud.
4. Simple installation without a terminal, Git, npm, or manual database setup.
5. Stability of the public Plugin SDK and Theme SDK.
6. Performance on large local libraries.
7. Accessibility, localization, and freely changeable design.
8. Up-to-date documentation and examples.
9. Clean architecture and developer experience.

Do not change the approved stack or public contracts without an explicit assignment.

## 2. Approved stack

The stack is governed by [ADR-0038](docs/adr/0038-canonical-rust-kernel-core.md)
(canonical Rust Kernel core; Fastify/Drizzle is the legacy/migration contour)
and the target architecture
[ТЗ 10/10 rev2](NeoTavern_architecture_10_of_10_spec_2026-08-13.md).
The "approved stack" is split into two planes:

**Canonical plane (new product logic lives here):**

- Rust Runtime Kernel — the canonical application core: the single owner of
  product logic and persistent state (SQLite ownership, migrations, generation
  durability, backup/restore, provider and SecretStore ports).
- Product Wire Contracts (TypeBox) — the single cross-language contract
  source; generated TypeScript types and Rust DTOs.
- React 19.2 + Vite 8 for the frontend; TypeScript with `strict: true`.
- TanStack Query for server state; Zustand for local UI state only.
- Radix Primitives as the headless component base; CSS Modules, CSS Custom
  Properties, Cascade Layers, and Container Queries.
- i18next + react-i18next.
- Tauri 2.x for the desktop shell; pnpm workspaces for the monorepo.

**Legacy-compat plane (feature-frozen migration adapter, ADR-0038):**

- Node.js 24 LTS, bundled with the distribution (legacy host runtime).
- Fastify 5 — legacy/migration backend surface (`/api/v2`), no new product
  features except security fixes, defect fixes and migration bridges.
- SQLite via `better-sqlite3` and Drizzle ORM — legacy `app.db` adapter only;
  the canonical database is `database.sqlite` owned by the Kernel.
- SQLite FTS5, React Router, Handlebars for instruct formats and safe
  templates (legacy contour; the Kernel pipeline replaces them over time).
- Node.js/Fastify runs in the desktop build only as the legacy sidecar — the
  public release default while the Kernel is a Preview, and the explicit
  `NEOTA_LEGACY_SERVER=1` transition bridge (ADR-0038; mode selection in
  `apps/desktop/src-tauri/src/lib.rs`); Wails is allowed only as an
  alternative shell while keeping the legacy sidecar.

Live dual-write between `app.db` and `database.sqlite` is prohibited
(ADR-0038). Do not replace React with another UI framework, SQLite with a
server database, or Tauri with Electron without a separate architectural
decision. Any change to the canonical core requires an explicit assignment.

## 3. Expected structure

```text
apps/
├── server/
└── web/

packages/
├── contracts/
├── db/
├── ui/
├── plugin-sdk/
├── theme-sdk/
├── legacy-compat/
├── provider-sdk/
├── i18n/
└── shared/

docs/
├── README.md
├── architecture/
├── api/
├── plugin-sdk/
├── theme-sdk/
├── prompt-pipeline/
├── data/
├── desktop/
├── migrations/
└── adr/
```

New code should go into the narrowest suitable package. Do not create circular dependencies between packages.

## 4. General change rules

- Make the minimal change that fully solves the task.
- Do not rewrite neighboring modules without need.
- Do not delete legacy contracts just because they look ugly.
- Do not add microservices, Redis, PostgreSQL, Docker, or mandatory external processes.
- Do not add telemetry by default.
- Do not add a network dependency for features that can work locally.
- Do not load entire directories of characters, chats, or messages into memory.
- Do not use an array index as an entity ID.
- Do not store secrets in logs, browser storage, or diagnostic exports.
- Do not leave TODOs instead of the required implementation without an explicit explanation.
- Do not consider a task complete if a behavior, API, or architecture change is not reflected in the documentation.

## 5. TypeScript

- Strict mode is enabled.
- Unjustified `any`, `as unknown as`, `@ts-ignore`, and non-null assertions are forbidden.
- At system boundaries, use `unknown` and explicit validation.
- Public interfaces must have exported types.
- Place shared API types in `packages/contracts`.
- Do not manually duplicate backend and frontend types.
- Use ESM.
- Prefer small functions with explicit inputs and outputs.
- Errors must have a stable machine-readable code and parameters.

Example API error:

```json
{
  "code": "CHARACTER_NOT_FOUND",
  "params": { "characterId": "..." },
  "traceId": "..."
}
```

User-facing error text is localized on the frontend.

## 6. Backend and API

This section describes the legacy/migration contour (`apps/server`, `/api/v2`),
which is feature-frozen (ADR-0038): no new product features are added to it,
only security fixes, defect fixes and migration bridges. **New product logic
is implemented in the Rust Kernel and exposed through the Product Wire
Contracts** (`packages/contracts/src/wire`); hosts and the UI consume the
typed Product Wire client, never the legacy API directly.

For the legacy contour:

- Structure every backend module as an isolated Fastify plugin.
- Place the main API under `/api/v2/...`.
- Place plugin routes under `/api/plugins/{pluginId}/...`.
- All API inputs and outputs must have JSON Schema.
- Use TypeBox and the Fastify Type Provider.
- Streaming generation is done via SSE.
- Use WebSocket only when a two-way realtime channel is genuinely needed.
- All long-running operations must accept an `AbortSignal`.
- Add timeouts and correct request termination when the client disconnects.
- Do not hand ready-made, non-localized error messages to the frontend.
- The backend listens on `127.0.0.1` only by default.

Product Wire operations carry the same requirements as metadata (name/version,
request/response/event schema, scope, idempotency, retry, timeouts, size
limits, error codes, streaming semantics, compatibility classification) —
enforced by `compileWireContract` in `packages/contracts/src/wire/registry.ts`.

## 7. Provider SDK

All LLM, TTS, STT, and image providers implement a single adapter.

The adapter must support:

- configuration validation;
- fetching the model list;
- cancellation via `AbortSignal`;
- a unified generation event stream;
- error normalization;
- timeouts;
- safe logging;
- registration through the Plugin SDK.

Do not tightly couple the core to a single provider's official SDK.
The only documented exception is the Anthropic adapter
(`packages/provider-sdk/src/adapters/anthropic.ts`), which uses
`@anthropic-ai/sdk`: the Anthropic API (extended thinking, beta headers)
is supported more precisely by the SDK than by a hand-written fetch client.
New adapters are written against the global `fetch` by default.

## 8. Prompt pipeline

Keep the following stage order:

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

For every hook, the following must be defined:

- order and priority;
- timeout;
- cancellation;
- permissions;
- exception handling;
- a diagnostic log of prompt changes.

An error in one plugin must not silently break the whole pipeline.

## 9. Instruct Formats

- Use the built-in format manager and Handlebars.
- Support ChatML, Llama 3, Alpaca, Mistral, Command-R, and custom formats.
- The format describes system/user/assistant/tool templates, BOS/EOS, separators, and special tokens.
- Until the rendering stage, the pipeline works with a plain array of messages.
- The final result may be a string or structured JSON.
- Macros `{{user}}`, `{{char}}`, and custom variables are resolved before final rendering.
- Templates get no access to Node.js, the filesystem, or arbitrary code execution.
- Only documented helpers are allowed.
- Formats must be importable and exportable as versioned JSON presets.

## 10. Tokenization and Context Shifting

Token counting is performed locally.

The Tokenizer Registry must support:

- Tiktoken-compatible tokenizers;
- SentencePiece;
- Hugging Face tokenizer JSON;
- model-specific tokenizer plugins;
- approximate fallback only with an explicit warning.

Before a request:

1. Determine the tokenizer profile and the model's context limit.
2. Reserve room for the response.
3. Keep the system prompt, character, mandatory lorebook, and pinned messages.
4. Remove or compress the oldest unpinned blocks.
5. Remove tool-call and tool-result only as matched pairs.
6. Recalculate tokens after every change.
7. Show the user the excluded or summarized context.

Supported strategies: `truncate`, `summarize`, `vector-recall`, `manual`.

Plugins may add strategies, but must not bypass the final token budget.

## 11. SQLite and data

Mandatory settings:

- `foreign_keys = ON`;
- WAL;
- `busy_timeout`;
- prepared statements;
- transactional migrations;
- STRICT tables where possible;
- FTS5 for search.

Rules:

- All entities have a stable string ID, preferably UUIDv7.
- Any schema change is accompanied by a migration.
- A migration must be idempotent or have a strict version.
- A backup is created before a dangerous migration.
- Do not run hidden destructive migrations while reading data.
- Do not hand plugins a direct SQLite connection.
- Do not store images and audio as BLOBs in the main database.
- Do not lose unknown character card fields and extension metadata.
- Import must support re-running without creating duplicates.

## 12. Files and images

Original user files are stored separately from the cache.

When importing an image:

1. Check size, MIME, and extension.
2. Compute a content hash.
3. Save the original without quality loss.
4. Generate low-resolution thumbnails for catalogs, lists, and preview.
5. Store thumbnails in `data/cache/thumbnails/`.
6. The thumbnail key must include the original's hash, the size, and the algorithm version.
7. Do not regenerate a thumbnail if the key has not changed.
8. Do not load the original where a thumbnail is enough.
9. Rebuild the cache automatically when it is missing.
10. Cache clearing must never delete originals.

Write files atomically via a temporary file and rename.

## 13. Frontend

- The application is a React SPA without SSR.
- Vite is used as the bundler and dev server, but not as the application's Plugin API.
- TanStack Query holds server state.
- Zustand holds only local UI state.
- Do not copy server data into TanStack Query and Zustand at the same time.
- Large lists are virtualized.
- Use cursor pagination.
- Load old messages in batches.
- Do not render React for every received token character.
- Batch streaming updates via `requestAnimationFrame` or equivalent batching.
- Load heavy pages, editors, and plugins lazily.
- Every major area and every plugin must have an Error Boundary.

## 14. UI and themes

The interface must support a complete replacement of the visual shell, not just recoloring.

### Mandatory screen model

- The main screen always remains the chat workspace.
- Separate pages for settings, lobbies, character management, plugins, themes, import, or any other sections are forbidden — with no exceptions.
- Such interfaces are implemented only as side panels or modals over the chat. When they close, the user returns to the same chat state.
- Routes and the Plugin SDK cannot bypass this rule: they may only open allowed panels and modals, but must not replace the main screen with a standalone page.

Three theme levels:

1. Design tokens.
2. Component skin.
3. Shell layout.

Themes may implement interfaces in the spirit of Wii U, macOS, KDE/GNOME, console, visual novel, or mobile client without changing chat logic.

Mandatory styling stack:

```text
CSS Modules
+ CSS Custom Properties
+ CSS Cascade Layers
+ Container Queries
+ data-component/data-part/data-state
```

Layer order:

```css
@layer reset, tokens, base, components, plugin-base, theme, user;
```

Hardcoding in components is forbidden:

- colors;
- fonts;
- spacing;
- radii;
- shadows;
- blur;
- z-index;
- animation durations and easing;
- sizes of standard controls.

Hardcoding element layout rules is also forbidden: coordinates, grid/flex schemes, breakpoints, and area order. Components declare only roles and stable slots; layout is determined by the Shell theme through a documented contract.

Use semantic CSS tokens.

Do not use generated CSS Modules classes as a public theme contract. For a stable styling API, add documented `data-component`, `data-part`, `data-role`, and `data-state`.

`!important` is forbidden except in the user override layer and special accessibility modes.

## 15. App Shell and UI Slots

Main named areas:

```text
app.shell
├── navigation.primary
├── navigation.secondary
├── character.browser
├── chat.header
├── chat.viewport
├── chat.composer
├── panel.left
├── panel.right
├── status.area
├── modal.layer
└── notification.layer
```

Themes change the arrangement of areas. Plugins add content through stable slots.

Do not let plugins depend on the internal React hierarchy.

## 16. i18n

- There must be no hardcoded strings in the user UI.
- Use i18next namespaces.
- Format plurals, dates, numbers, and units via `Intl`.
- Fallback: regional language → base language → English.
- The language switches without a reload.
- Update `lang` and `dir` on `<html>`.
- Support RTL.
- Plugins and themes use isolated namespaces.
- The backend returns an error code; the frontend localizes it.
- Add a pseudo-locale test for new screens.
- Check the interface with long translations.

## 17. Plugin SDK

Plugins depend on their own versioned Plugin SDK, not directly on Fastify, React, Zustand, TanStack Query, or SQLite.

The frontend SDK can register:

- pages;
- settings panels;
- toolbar actions;
- message actions;
- context menus;
- slash commands;
- prompt interceptors;
- event handlers;
- message renderers;
- character tabs;
- sidebar panels;
- dialogs;
- notifications;
- hotkeys;
- command palette actions;
- i18n resources.

The backend SDK provides limited abstractions for routes, storage, events, logging, permission-checked fetch, providers, and a virtual filesystem.

Every registration must return a cleanup function. After a plugin is disabled, nothing may remain:

- handlers;
- timers;
- DOM nodes;
- background requests;
- routes;
- subscriptions.

New permissions after an update require the user's consent again.

## 18. Legacy compatibility

Keep the documented legacy contracts:

```text
window.SillyTavern
window.eventSource
window.event_types
window.extension_settings
window.$ / window.jQuery
```

React provides unmanaged DOM islands for old extensions.

Legacy server plugins run through the Express compatibility host and are proxied under `/api/plugins/{id}/...`.

`@fastify/express` is used only inside the compatibility layer, not in the new core.

Do not promise compatibility with plugins that depend on incidental internal CSS classes, monkey patching, or private imports. When changing a legacy API, add a migration guide and a compatibility test.

## 19. Plugin and theme security

- Do not use `node:vm` as a security sandbox.
- Run untrusted backend plugins in a separate process with restrictions.
- Use iframe + RPC for sandboxed UI.
- A theme package gets no access to chats, API keys, or the filesystem.
- Check ZIP packages for path traversal.
- Check permissions at install and update time.
- Provide a safe mode that disables third-party plugins and themes.
- A broken theme must not block access to the interface reset.

## 20. Caching

Every in-memory cache must have:

- a memory limit;
- TTL if data becomes stale;
- a versioned key;
- explicit invalidation;
- hit/miss metrics.

Unbounded global `Map`s are forbidden.

The disk cache must be fully deletable and automatically recoverable. User data must not depend on the cache being present.

The service worker caches only the app shell and static assets. Do not cache API, SSE, secrets, or sensitive responses.

## 21. Desktop and Web Client

Desktop (ADR-0038 honest default):

- The main shell is Tauri 2.x.
- The Runtime Kernel is the canonical backend; the legacy Fastify backend runs
  only as the Node.js sidecar — the release default while the Kernel is a
  Preview, selectable via `NEOTA_DESKTOP_CHANNEL`/`NEOTA_LEGACY_SERVER=1`/
  `NEOTA_KERNEL=1` (see docs/desktop/README.md). Conflict policy
  (ADR-0038): when both overrides are set, `NEOTA_KERNEL=1` wins; the mode
  matrix is unit-tested in `apps/desktop/src-tauri/src/lib.rs`.
- The DiagnosticsPanel marks an active Kernel as **Kernel Preview**; release
  builds on the sidecar show no kernel marking.
- Public builds temporarily default to the tested legacy sidecar while the
  Kernel is an explicit Preview; the Kernel becomes the default for
  nightly/internal builds only. The public default switches to the Kernel only
  after the release gate: all mandatory Desktop capabilities are `Packaged` in
  the capability matrix, migration and rollback are verified on packaged
  artifacts, no silent fallbacks exist and no P0 defects are open.
- Node.js and SQLite are included in the distribution (legacy sidecar).
- The first launch does not run `npm install`.
- The user does not need a terminal.
- Windows installer, macOS package, Linux AppImage/archive, and portable Windows build are supported.
- App shutdown must properly terminate the sidecar.
- The backend must not linger after the window closes.

Web Client (remote-only; not a standalone offline runtime, ADR-0038/0043):

- responsive layout;
- connection to a local backend on a PC or home server (user-controlled host);
- the service worker caches only the versioned app shell and static assets —
  API responses, SSE, prompts, provider events and secrets never enter Cache Storage;
- without a connection the Web Client shows an honest connection/offline screen
  and does not allow product mutations;
- the Web Client must not pretend to be a standalone offline Node.js
  application or a browser-hosted Kernel (ARC-12).

## 22. Accessibility

The base theme must meet WCAG 2.2 AA.

Check:

- keyboard control;
- visible focus;
- screen reader labels;
- dialog/menu semantics;
- contrast;
- reflow;
- touch targets;
- `prefers-reduced-motion`;
- high contrast;
- text enlargement;
- RTL;
- safe-area;
- the on-screen keyboard on phones.

Do not remove Radix accessibility behavior when styling.

## 23. Testing

Add a test at the appropriate level for every change.

Expected tools:

- Vitest for unit tests.
- Fastify `inject()` for backend integration tests.
- Playwright for E2E.
- Visual regression for themes and shell layouts.
- Accessibility tests.
- Migration tests.
- Plugin contract tests.
- Legacy compatibility suite.

Must be tested:

- erroneous and corrupted input data;
- request cancellation;
- re-import;
- migrations and rollback;
- backup recovery;
- cache clearing and recovery;
- plugin disable;
- safe mode;
- large catalogs and long chats;
- context shifting at the token budget boundary;
- instruct-format rendering;
- thumbnail generation and invalidation.

### Resource containment (mandatory for heavy suites)

Heavy fuzz/bench tests must never be able to take the host down
(plan rev 2.2; see
[docs/architecture/resource-containment.md](docs/architecture/resource-containment.md)):

- Every heavy payload builder is spec-first: `assertPayloadSpecCap(spec)` runs
  on a DECLARED spec before any `.repeat()` / `Array.from()`; the guard never
  allocates proportional to what it guards (no `JSON.stringify(payload)`
  sizing). Use the shared helper in
  `packages/contracts/test/_budget.ts`.
- Heavy benches build their payload INSIDE a dedicated
  `node --expose-gc` child from a small spec over argv; the parent asserts the
  returned metrics. Nothing heavy crosses IPC.
- Heavy commands are serialized and contained via
  `scripts/contained-run.mjs` (Windows Job Object; see
  `crates/resource-runner`). The runner refuses to run uncontained
  (`RESOURCE_BUDGET_MODE=contained` fail-safe). Root scripts:
  `pnpm test:contracts:heavy`, `pnpm test:rust-fuzz:contained`.
- vitest runs with `maxWorkers: 2` and `--max-old-space-size=2048` (root and
  `apps/web`); Playwright runs with `workers: 1`. Do not raise these without
  an explicit decision.
- Wire byte limits are generated from the registry
  (`operation_request_limit` / `operation_response_limit`); never hard-code
  payload byte constants in kernel or test code.
- Any new over-limit behavior must be proven behaviorally (payload gates in
  `crates/runtime-kernel/tests/kernel_payload_gates.rs`, 413-without-reading
  in `remote-http` tests), not by grepping docs.

## 24. Performance

Do not degrade target metrics without an explicit decision:

- startup to a ready UI: no more than 4 seconds on a reference PC;
- backend idle: no more than 180 MB RAM;
- first page of 100,000 characters: up to 300 ms;
- opening a chat of 10,000 messages: up to 700 ms until the latest messages are displayed;
- no more than 30 UI updates per second for streaming responses;
- initial frontend bundle: up to 2 MB gzip without lazy chunks.

Measure performance before and after optimization. Do not add a cache without an invalidation strategy.

## 25. Checks before task completion

Before completing:

1. Review the diff and remove accidental changes.
2. Run formatting.
3. Run lint.
4. Run the TypeScript typecheck.
5. Run the related unit/integration tests.
6. For UI changes, run Playwright and accessibility tests.
7. For the DB, verify the migration against a clean and an existing database.
8. For the Plugin SDK, verify disable and cleanup.
9. For a theme, verify safe mode and the absence of hardcoded tokens.
10. For desktop, verify the startup and shutdown of the Node.js sidecar.
11. Verify that the related documents, examples, ADRs, and migration guides are updated.
12. Verify the documentation's internal and external links.

Expected root project commands:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm docs:check
pnpm docs:build
pnpm build
```

If a command is missing, do not invent a successful result. State exactly what was or was not verified.

## 26. Agent report format

In the final report, state:

- what was changed;
- which files were affected;
- which documents were created or updated;
- which tests were run and their results;
- which checks could not be performed;
- whether there are migrations, API changes, or compatibility risks.

Do not claim the task is fully complete if the build or mandatory tests fail.

## 27. Documentation during development

Documentation is part of the implementation, not an optional tail after the code.

Any change affecting user or developer behavior must update the corresponding files in `docs/` in the same change. This is mandatory for:

- architecture and package boundaries;
- REST API, SSE, WebSocket, and contract schemas;
- Plugin SDK, Theme SDK, and the legacy compatibility layer;
- permissions, sandboxing, and the security model;
- SQLite schema, migrations, backup, and recovery;
- import, export, files, and the thumbnail cache;
- prompt pipeline, instruct formats, tokenization, and context shifting;
- provider adapters;
- desktop packaging, the Tauri sidecar, Web Client, and updates;
- user settings, i18n, and accessibility;
- breaking changes, deprecations, and migration guides.

### Mandatory rules

- Create or update documentation together with the code, not as a separate promised task.
- Every new `app` or `package` gets a `README.md` with its purpose, public inputs, dependencies, development commands, and constraints.
- Every public TypeScript export, SDK interface, and extension point gets TSDoc where a name alone is insufficient to understand the contract.
- API documentation contains method/path, request/response schema, examples, error codes, permissions, lifecycle, and versioning rules.
- Plugin documentation contains the manifest, lifecycle, cleanup, permissions, frontend/backend API, sandbox constraints, and a working minimal example.
- Theme documentation contains tokens, slots, `data-*` hooks, the shell contract, inheritance, safe mode, and a minimal theme example.
- A database change is accompanied by a description of the migration, compatibility, backup, rollback, or an explicit statement that no rollback exists.
- A significant architectural decision is recorded as an ADR in `docs/adr/` with context, decision, alternatives, and consequences.
- A user-facing change is added to `CHANGELOG.md`; a breaking change additionally gets a migration guide.
- Code examples in docs must compile or be checked by an automated docs test.
- Do not copy one contract into several places. Point to a single source of truth and link to it.
- Do not document functionality that does not exist yet as done. Mark proposal, experimental, and deprecated explicitly.
- If a change genuinely does not require docs, state the reason in the final report.

### Minimal Definition of Done for docs

1. The `docs/README.md` index is updated when a new section is added.
2. All new links resolve and do not point at arbitrary documentation versions.
3. Examples match the actual types and APIs of the current branch.
4. Deleted or renamed APIs are not left in a `docs/` search.
5. `pnpm docs:check` and `pnpm docs:build` pass if the commands already exist.

## 28. Internal documentation map

After repository initialization, these documents are the mandatory entry points and must be kept up to date:

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture/README.md)
- [API](docs/api/README.md)
- [Plugin SDK](docs/plugin-sdk/README.md)
- [Theme SDK](docs/theme-sdk/README.md)
- [Prompt pipeline](docs/prompt-pipeline/README.md)
- [Data and SQLite](docs/data/README.md)
- [Desktop and Tauri](docs/desktop/README.md)
- [Migrations](docs/migrations/README.md)
- [Architecture Decision Records](docs/adr/README.md)
- [Changelog](CHANGELOG.md)

If a related document does not exist yet, create it within the same task. Do not leave a link to a nonexistent document on the main branch.

## 29. Official stack documentation

Before using an unfamiliar or recently changed API, consult the official documentation for the appropriate version. Model memory, a random blog, or the first Stack Overflow answer are not the project's contract.

### Runtime, language, and backend

- [Node.js 24 API](https://nodejs.org/docs/latest-v24.x/api/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Fastify Documentation](https://fastify.dev/docs/latest/)
- [TypeBox](https://github.com/sinclairzx81/typebox)

### Frontend and state

- [React Reference](https://react.dev/reference/react)
- [Vite Guide](https://vite.dev/guide/)
- [TanStack Query for React](https://tanstack.com/query/latest/docs/framework/react)
- [Zustand Documentation](https://zustand.docs.pmnd.rs/)
- [Radix Primitives](https://www.radix-ui.com/primitives/docs/overview/introduction)

### Data, templates, and localization

- [SQLite Documentation](https://sqlite.org/docs.html)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
- [Handlebars Guide](https://handlebarsjs.com/guide/)
- [i18next Documentation](https://www.i18next.com/)

### Desktop

- [Tauri 2 Documentation](https://v2.tauri.app/)
- [Tauri: Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)

### Testing

- [Vitest Guide](https://vitest.dev/guide/)
- [Playwright Documentation](https://playwright.dev/docs/intro)

If a library is pinned to a specific major version, use the versioned docs for that major version. Do not port an example from `latest` until you have verified its compatibility with the versions in the lockfile.

## 30. Parallel subagent usage

Goal: the main agent and its subagents work concurrently. The main agent never idles waiting for subagent answers; it does its own slice of the work while subagents run.

### Dispatch

1. Decompose first, yourself. Split the work into independent slices before spawning anyone; never outsource the top-level plan or decomposition to a subagent.
2. Spawn the whole phase's subagents in one `tasks[]` batch, as early as possible, before starting your own slice. The call is asynchronous: it returns job IDs immediately, and each result auto-delivers when its job settles.
3. Never wait right after dispatching. `hub wait` is allowed only when you are fully blocked with no other work left. Collect settled results via `hub jobs` / `hub inbox` snapshots and auto-delivery.
4. Continue your own reads, edits, and verification immediately after the dispatch call — they run in parallel with the subagents. Do not start your work only after theirs finishes.

### Contracts

5. Decide cross-slice contracts up front — shared interfaces, formats, function signatures, file ownership — and state them in the batch `context`. Subagents must not negotiate contracts with each other.
6. Make every task self-contained: Target (exact files and symbols, explicit non-goals), Change (step-by-step), Acceptance (observable result). Subagents have no conversation history; never reference prior discussion.
7. Instruct every subagent to skip formatters, linters, and project-wide test suites; the main agent runs those once at the end.
8. Overlap on the same files is allowed — worst case, agents coordinate via IRC. But when two slices touch the same file, pre-assign ownership (who edits which symbols) in `context` to minimize merges.
9. Pass large payloads via `local://` URIs, never inline.

### Roles

10. Pick the most specific agent type: `scout` for read-only research, `librarian` for library/API questions, `reviewer` / `security-reviewer` for review, `sonic` for mechanical updates, general `task` only when nothing else fits.
11. Read-only exploration MUST use `scout`, never a writing agent.

### Collection and failure

12. A settled `hub jobs` snapshot is the delivery of that job's result. When integrating, verify claimed changes yourself — a completed job is not acceptance.
13. A failed subagent degrades only its slice: absorb the slice yourself or re-dispatch it; never restart the batch.
14. Stay under the concurrency cap (32); a larger batch queues, so split into waves.
15. If a subagent's result is needed for a decision, finish every other piece of work first and only then wait — never block early.
