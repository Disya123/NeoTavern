---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/README.md
---

# Architecture

> **Architecture Convergence program (M1, Wave 0 → Wave 1).** The governing
> decisions are
> [ADR-0038](../adr/0038-canonical-rust-kernel-core.md) (the **Rust Runtime
> Kernel is the canonical application core**; the Fastify/Drizzle contour is a
> feature-frozen legacy/migration adapter) and
> [ADR-0039](../adr/0039-legacy-compatibility-authority-boundary.md)
> (legacy compatibility is an authority-non-expanding boundary). The governing
> requirements document is the target-architecture
> [ТЗ 10/10 rev2](https://github.com/Disya123/NeoTavern/blob/main/NeoTavern_architecture_10_of_10_spec_2026-08-13.md),
> which supersedes the previous ТЗ 7.2 where they conflict. Capability and
> host statuses are tracked in the generated
> [capability matrix](../capability-matrix.md) (ARC-10); temporary architectural
> exceptions live in [exceptions.json](https://github.com/Disya123/NeoTavern/blob/main/docs/architecture/exceptions.json) (ARC-09). The desktop
> default is staged: public builds use the tested legacy sidecar while the
> Kernel is a Preview (release gate, ADR-0038 §"Honest Desktop default").
>
> **M1 / Wave 1 (Immediate security) — legacy contour delivered:** SEC-02
> logical allowlist export, SEC-03/SEC-04 plugin network broker (SSRF policy +
> bounded streaming), SEC-05 plugin package trust, the restore maintenance
> lock, the ARC-11 compatibility authority/VFS isolation suite, and SEC-01
> SecretStore (secrets out of the main DB; portable `secrets.enc`, session and
> env modes; opaque references; bootstrap import) — each with its own
> regression/security tests and capability rows in
> [release-manifest.json](https://github.com/Disya123/NeoTavern/blob/main/docs/release-manifest.json). The kernel-plane
> SecretStore port (crates/secret-store, ADR-0040) is delivered with the
> canonical portable v2 format (Argon2id + AES-256-GCM). Remaining Wave 1
> work: OS-vault / Keystore adapters and the portable passphrase UX (M3).

The section below describes the current (pre-cutover) layout. Product logic
migrates into the Kernel over the program milestones; new product logic is
implemented only in the Kernel and exposed through Product Wire.

NeoTavern is a local application: a single Fastify process serves the API and
(optionally) the built frontend (legacy/migration contour, ADR-0038). No
PostgreSQL/Redis/Docker.

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
    mobile-ffi/        # Phase 5 native bridge: stable C ABI → same Kernel
                       # (opaque handles, bounded buffers, status codes)
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
- [Runtime Kernel + Storage foundation](https://github.com/Disya123/NeoTavern/blob/main/crates/runtime-kernel/README.md) —
  Phase 1 kernel skeleton (dispatch, handshake, cancellation, local/headless
  adapters) and Phase 2 storage crate (see
  [`crates/storage/README.md`](https://github.com/Disya123/NeoTavern/blob/main/crates/storage/README.md)): exclusive
  data-root lease, pinned SQLite baseline (3.53.2 bundled), migration ledger
  with checksums, immutable assets with orphan GC, Backup-API recovery snapshot
  and read-only Recovery Mode. The kernel opens durable storage via
  `KernelConfig::data_root`; a second writable process gets a controlled
  `DataRootInUse` error (ТЗ §22).
- [NeoBackend UI routing](https://github.com/Disya123/NeoTavern/blob/main/apps/web/src/api/backend.ts) — the web app
  routes every API call through the `NeoBackend` facade singleton
  (`LegacyBackend` transport today). Typed wire operations use the facade's
  domain APIs; the 20 remaining `/api/v2` call sites (messages, drafts,
  snapshots, blocks, providers, legacy bridge) go through the documented
  temporary `raw` passthrough and are deleted per-slice in Фаза 3.
- [Version axes](version-axes.md) — independent versioning of app, storage,
  wire protocol, SDKs and formats.
- [Phase 4 Remote Adapter](https://github.com/Disya123/NeoTavern/blob/main/crates/adapters/remote-http/README.md) —
  headless/remote HTTP+SSE surface on the **same Runtime Kernel** as local
  IPC: `GET /meta`, `POST /rpc`, `POST /rpc/stream`, envelope-over-HTTP status
  mapping (400/403/404/405/413/426), loopback-by-default with fail-closed
  non-loopback bind (public bind requires trusted proxy AND auth), pairing/
  revocable credentials, token-bucket rate limiting, bounded streams with
  per-batch credential re-check, CORS deny-by-default, bounded secret-free
  audit, and one writer coordinator (`Arc<Mutex<Kernel>>`).
  See
  [ADR-0030](../adr/README.md#adr-0030-remote-http-adapter--envelope-over-http-on-the-shared-runtime-kernel)
  and
  [Wire contracts §6.1](wire-contracts.md#61-http-transport-mapping-phase-4-remote-adapter).
- [Phase 4 CLI transport](https://github.com/Disya123/NeoTavern/blob/main/crates/adapters/cli/README.md) —
  `neotavern-cli` maps one wire request envelope → one response envelope
  through the same kernel (same envelope layer, byte-identical answers):
  `--operation <id> '<payload>'` builds the envelope from the embedded
  manifest, `--envelope` reads a full envelope JSON from stdin; stable exit
  codes 0/1/2 and the exclusive data-root lease for `--root` runs (§6.3,
  §22).
- [Phase 5 mobile FFI ABI](https://github.com/Disya123/NeoTavern/blob/main/crates/adapters/mobile-ffi/README.md) —
  the Android/local native bridge foundation (ТЗ §6.9): a minimal stable C
  ABI (`nt_ffi_version`, `nt_kernel_open/free`, `nt_call`,
  `nt_stream_start/wait/cancel/free`) carrying the **same** Product Wire
  Contract bytes over opaque handles and bounded buffers. Buffer sizes are
  checked before allocation, Rust allocations are freed only by exported free
  functions, panics are contained to `NT_ERR_INTERNAL`, and
  `ffiAbiVersion` + `schemaHash` are part of the exact local handshake — an
  incompatible host never receives a runtime handle.
- [Phase 5: Android Local foundation — JNI bridge, host, mobile transport,
  CI gates](../android/README.md) — `apps/android`
  (WebView + JNI) on the same mobile FFI ABI: the `neotavern-android-jni`
  crate marshals to the stable `nt_*` functions, the frozen JS bridge
  protocol (`window.__neotavernMobile` handshake/call/cancelStream with a
  callback channel) carries byte-identical envelopes to
  `MobileBridgeTransport`, Keystore AES/GCM secrets with no plaintext
  fallback, kernel open on a background executor and close on destroy.
  Profile routing: the local profile selects `LocalBackend` over
  `MobileBridgeTransport` (explicit override layer — the default
  `createBackend()` routing is unchanged). See
  [ADR-0034](../adr/README.md#adr-0034-android-local-host--jni--webview-bridge-on-the-mobile-ffi-abi).
- **Phase 9 Desktop Remote Access** — `crates/adapters/desktop-remote`
  (`neotavern-desktop-remote`): a host service in the Tauri shell that wraps
  the Phase 4 `remote-http` adapter on the **same `Arc<Mutex<Kernel>>`** as
  local IPC (one writer, §22) — off by default (no listener until enabled in
  Settings → Remote Access), loopback default with an ephemeral port,
  non-loopback only behind a trusted TLS-terminating proxy with auth
  (fail-closed pre-bind), pairing with revocable in-memory
  SHA-256-verifier credentials (re-pair after restart; durable credential
  persistence deferred), CORS deny-by-default via `allowed_origins`, bounded
  secret-free audit, host-owned config at `app_config_dir/remote-access.json`
  (atomic write, never in the product DB), and a `kernel_remote_*` Tauri
  command surface that controls the host service without changing the frozen
  wire registry (no contract/codegen impact). The enable/pair/revoke UI is
  gated to the desktop shell. See
  [ADR-0035](../adr/README.md#adr-0035-desktop-remote-access--host-service-over-the-shared-runtime-kernel).
- **Phase 10 Extension hardening** — real security boundaries for
  extensions (ТЗ §10/§47–§54/§70): declarative semantic UI slots
  (the five frozen ids, host-side re-validation, permission gating,
  priority ordering, zero layout change when nothing renders),
  app-level `extensions.legacyFrontend` gate (default off) so legacy
  SillyTavern `<script>` injection additionally requires the admin-only
  `legacy.trusted` consent, theme activation rollback + last-working boot
  fallback + responsive `density`/`motion` semantics, manifest `engines`
  enforcement (incompatible update → auto-disable with the previous
  version intact), namespaced-state kv quotas (413
  `STATE_QUOTA_EXCEEDED`), per-plugin SecretStore (write-only, gated
  reveal, never in backups/exports/logs), plugin namespaces as an
  additive backup sidecar (conflict-skip restore), and explicit
  extension-runtime availability probes (Android `extensionsAvailability`,
  web `useExtensionAvailability`, kernel-mode CSP contract test). See
  [ADR-0037](../adr/README.md#adr-0037-extension-hardening--declarative-slots-legacy-frontend-gate-theme-fallback-engines-enforcement-namespaced-quotas--secrets)
  and the [Plugin SDK](../plugin-sdk/README.md) /
  [Theme SDK](../theme-sdk/README.md) docs.
- [Generation durability](generation-durability.md) — Phase 6: recoverable
  generation workflows over the same kernel — durable state machine
  (`generation_runs`/`generation_events`, migration 3), CAS transitions by
  revision, deterministic fake provider with fault injection, at-least-once
  sequenced SSE with `Last-Event-ID` resume, and idempotent Retry/Keep/Discard
  reconciliation (ТЗ §62–§64).
- [Providers](providers.md) — Phase 7: portable provider contract, built-in
  adapters (deterministic fake, recorded fixtures), config/secret separation
  (`provider_configs`, migration 4), deadline/cancellation and the
  conformance suite (ТЗ §55–§56).
- **Phase 8 Android background execution** — host-side lifecycle adapter
  over the **same kernel session** (never a second writable kernel, §22):
  a bounded `dataSync` foreground service continues user-visible generation
  streams via a shared `KernelHolder`-refcounted handle, with a
  status-only notification and Stop action (§85) mapping stop/expiration to
  `generation.cancel` and process death to kernel startup recovery +
  `generation.retry`; maintenance runs as WorkManager unique one-time work
  (`neotavern-maintenance` → `backups.create`, battery + storage
  constraints, no exact schedule §66, no boot-time daemon, no own scheduler
  §87). Purely host-side: JNI symbols, wire registry and schema hash stay
  frozen — no kernel/platform branching. See
  [ADR-0036](../adr/README.md#adr-0036-android-background-execution--bounded-foreground-service--workmanager-maintenance-over-the-shared-kernel-handle)
  and [Android host](../android/README.md).
- [Portable data](portable-data.md) — Phase 11: public backup containers,
  kill-safe staged restore with atomic activation, Portable Export/import and
  the read-only legacy converter (ТЗ §34, §40–§43).
- [ADR-0029](../adr/README.md#adr-0029-wire-contract-toolchain-typebox-single-source--deterministic-codegen)
  — the contract toolchain decision.
