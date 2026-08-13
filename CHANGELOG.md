# Changelog

## [0.1.0] — 2026-08-11

Public release prep:

- Rebranded SillyTavern 2 → **NeoTavern**: package scope `@st2/*` → `@neotavern/*`,
  desktop product identity, plugin IDs, CLI tools (`neotavern-plugin`,
  `neotavern-plugin-runtime`), env vars (`NEOTA_*`), wire-format markers
  (`neotavern-profile-export`, `neotavern-chat-export`), and display strings.
- Versioning restarts at `0.1.0` (was `2.0.0-pre.3`).
- Documentation is now English: all app/package READMEs, `docs/` reference tree,
  ADRs, and `AGENTS.md` were translated from Russian.
- **AGPL-3.0** license added.
- Removed superseded planning documents (`ТЗ.md`, plugin-SDK vNext specs, mockup
  directory) and tracked build debris.

## Unreleased
### Added

- **Nightly CI (ТЗ §80).** New `.github/workflows/nightly.yml`: scheduled
  daily run of the full Rust workspace suite (including the storage recovery
  matrix: DB support window, backup/restore kill-safety, data-root lease,
  export/legacy fixtures) on ubuntu + **Windows NTFS**, clippy/fmt gates, a
  scaled deterministic contract boundary fuzz (200k iterations over all 45
  generated decoders; any panic fails), the Phase 11 benchmark with report
  artifact, and the TS regression baseline + docs integrity.
- **Contract boundary fuzz (ТЗ §80/§6.8).**
  `crates/contracts-generated/tests/fuzz_deserialization.rs` drives every
  generated `decode_*` fn with random raw buffers and structurally mutated
  fixture values (field deletion, wrong-type swaps, unknown keys, corrupt
  strings) under `catch_unwind` — a panic on arbitrary input is a test
  failure. Fixed-seed xorshift64 keeps the corpus reproducible;
  `NT_CONTRACT_FUZZ_ITERS` scales the budget.
- **Runtime Kernel + storage foundation (ТЗ 7.2 Фазы 0–2).** New `crates/`
  workspace: `contracts-generated` (deterministic Rust boundary DTOs from the
  TypeBox wire schemas), `runtime-kernel` (contract-validated dispatch,
  handshake, cancellation, durable storage attach) and `neotavern-storage`
  (exclusive data-root lease, pinned SQLite 3.53.2 baseline, migration ledger
  with checksums, immutable assets with orphan GC, Backup-API recovery
  snapshot, read-only Recovery Mode). A second writable process on the same
  data root gets a controlled `data_root_in_use` error.
- **Semantic contract diff (ТЗ §6.7).** `tools/contract-codegen/diff.mjs`
  classifies breaking/additive wire changes between canonical bundles;
  self-tested in CI (`diff-test.mjs`).
- **Headless Remote Adapter (ТЗ 7.2 Фаза 4).** New `crates/adapters/remote-http`
  (`remote-http-adapter`): a std-only tiny_http 0.12 adapter serving the frozen
  wire envelopes over `GET /meta`, `POST /rpc` and `POST /rpc/stream` (SSE) on
  the **same Runtime Kernel** as local IPC — one writer coordinator
  (`Arc<Mutex<Kernel>>`), no SQLite access, no product rules. Envelope-over-HTTP:
  valid envelopes always answer HTTP 200 with a `wire.response.envelope`;
  transport failures map to 400/404/405/413/426 with canonical error codes.
  Protocol negotiation (major equality, client minor ≤ server minor) is
  enforced before dispatch, so a mismatched client can never execute product
  writes; kernel product errors (`CHARACTER_NOT_FOUND`, …) pass through the
  error envelope verbatim. Security defaults: loopback-only bind, non-loopback
  requires an explicit `trusted_proxy` declaration (TLS-terminating boundary),
  bounded body/connection limits; TLS termination and pairing land with Phase
  4 hardening / Phase 9 (ADR-0030).
- **Mobile FFI ABI (ТЗ 7.2 Фаза 5, native bridge foundation).** New
  `crates/adapters/mobile-ffi` (`neotavern-mobile-ffi`): a minimal stable C
  ABI over the **same Runtime Kernel** for Android JNI / future Swift hosts —
  opaque `NtKernel`/`NtStream` handles, bounded length-delimited buffers,
  UTF-8 operation ids and stable integer status codes
  (`NT_OK` … `NT_ERR_MISMATCH`). Payloads are the identical Product Wire
  Contract bytes (`nt_call`/`nt_stream_start` → `Kernel::dispatch`/
  `dispatch_stream`), buffer sizes are checked before any allocation/parse
  (`MAX_REQUEST_LEN` 1 MiB; `NT_ERR_BUFFER` reports the required capacity),
  Rust allocations are freed only by the exported free functions
  (`nt_kernel_free`, `nt_stream_free`), and every entry point contains panics
  (`catch_unwind` → `NT_ERR_INTERNAL`). The `ffiAbiVersion` + `schemaHash`
  exact local handshake runs inside `nt_kernel_open`, so an incompatible host
  never receives a runtime handle and performs no product operations (§6.5).
  Streams wait via `nt_stream_wait` (committed/terminal sequence, durable
  `generation.events` replay) and cancel via `nt_stream_cancel` (§64). Docs:
  `crates/adapters/mobile-ffi/README.md`, wire-contracts §10,
  version-axes «Local FFI ABI».
- **Remote Access hardening (ТЗ §10, Фаза 4 hardening / Фаза 9).**
  `remote-http-adapter` gains the full remote-access security surface:
  pairing issues revocable scoped credentials (`pair` → `(id, token)`,
  SHA-256 verifier only, idempotent `revoke`, bounded by `max_credentials`),
  the auth gate runs **before** the body is read (401 `UNAUTHORIZED` with
  `WWW-Authenticate: Bearer` — `missing_credential` / `invalid_credential`;
  `/meta` stays public), a token-bucket rate limiter (keyed by credential id
  or peer IP, bounded bucket map) answers `429 RATE_LIMITED` with
  `Retry-After`, `max_streams` caps concurrent SSE streams (`rule:
  stream_limit`), live streams re-check the credential per frame batch and
  abort mid-stream on revocation (`credential_revoked`), CORS/Origin is
  deny-by-default (a browser `Origin` is admitted only on an exact match
  against the configured `allowed_origins` allowlist, otherwise 403
  `ORIGIN_NOT_ALLOWED` before dispatch; allowed origins get
  `Access-Control-Allow-Origin` + a 204 preflight), forwarded client headers
  are honored only from configured proxy addresses (`trusted_proxies`:
  `X-Forwarded-For` keys the rate-limit bucket only when the immediate peer
  is listed — rightmost chain entry not appended by a trusted proxy; from
  any other peer the header is ignored, so a client cannot self-spoof the
  bucket key), and every gate decision
  lands in a bounded audit ring without token material. A public non-loopback
  bind now requires BOTH `trusted_proxy` and configured `auth` — otherwise it
  is a startup error (`InsecureBind` / `PublicBindRequiresAuth`, §10). Docs:
  `crates/adapters/remote-http/README.md`, wire-contracts §6.1.
- **CLI transport (ТЗ §6.3, Фаза 4 CLI hooks).** New `crates/adapters/cli`
  (`neotavern-cli`): a std-only binary mapping one wire request envelope →
  one response envelope through the **same Runtime Kernel** and the same
  envelope layer as the HTTP adapter (decode → protocol check → dispatch →
  validated response; byte-identical answers). `--operation <id> '<payload>'`
  builds the envelope from the embedded manifest (protocol + `schemaHash` +
  generated v4 request id), `--envelope` reads a full request envelope JSON
  from stdin (bounded to 1 MiB, request id echoed). Stable exit codes: `0` =
  ok envelope, `1` = error envelope / pre-envelope transport failure, `2` =
  usage error. With `--root` the CLI holds the exclusive data-root lease for
  its run and a held lease answers `DATA_ROOT_IN_USE` (§22). Docs:
  `crates/adapters/cli/README.md`, wire-contracts §6.1.
- **Generation durability (ТЗ 7.2 Фаза 6).** Generation is now a recoverable
  workflow on the Runtime Kernel: wire registry grows 15 → 20 operations
  (`generation.get`, `generation.events`, `generation.retry`, `generation.keep`,
  `generation.discard`; schema hash `7e469552…`), storage migration 3 adds
  `generation_runs` + `generation_events` (schema revision 3), and the kernel
  gains a writer-coordinator thread (`Kernel` is now `Send + Sync`,
  `dispatch_stream` returns an `EventStream`). Durable state machine with
  CAS-by-revision transitions, executor lease, deterministic fake provider
  (`steps`/`fail-at`/`delay-ms`/`tokens-per-step` fault injection), per-step
  committed event log, atomic terminal commit (final message + terminal event
  in one transaction), and startup recovery of lease-expired runs to
  `interrupted`. The remote adapter streams real SSE for `generation.start` /
  `generation.retry` and resumes from `Last-Event-ID` via `generation.events`;
  Retry / Keep partial / Discard reconciliation commands are idempotent
  (ТЗ §62–§64). `NeoBackend` exposes the new generation API on all three
  backends with parity tests. Docs:
  `docs/architecture/generation-durability.md`.
- **Portable Built-in Providers (ТЗ 7.2 Фаза 7).** Provider execution is a
  portable contract, not kernel-internal code: new `crates/provider-sdk`
  (the `ProviderAdapter` trait with normalized errors/usage, `Deadline` /
  `RetryPolicy` policy primitives, `SecretRef`/`SecretValue`/`SecretResolver`
  config-secret separation, `CancelToken`/`EmitStatus` cancellation
  semantics) and `crates/built-in-providers` (deterministic `FakeProvider`
  ported byte-identical from the kernel inline fake, `RecordedProvider`
  replaying non-secret JSON fixtures, shared conformance suite proving
  cancel/timeout/no-double-billing/redaction). Storage migration 4 adds the
  `provider_configs` table (non-secret `config_json` + `secret_ref` only —
  secrets never enter the DB, snapshots, backups or logs). The wire registry
  grows 20 → 21 operations (`providers.list`, schema hash
  `b5333728…`); the kernel executor now resolves adapters through a
  `ProviderRegistry` with a host-provided secret-resolver seam and a 60s
  per-run deadline, and `NeoBackend` exposes `providers.list` on all three
  backends with parity tests. Docs: `docs/architecture/providers.md`.
- **Portable Data (ТЗ 7.2 Фаза 11).** The Phase 2 recovery primitives are
  now public long-lived formats: `.neotavern-backup` containers (manifest +
  checksummed inventory + the snapshot-pinned asset set, assembled in a temp
  dir and finalized atomically; `backups.create` / `backups.list` wire
  operations with a 16-container quota), kill-safe staged restore (candidate
  data roots activated by directory swap; a pending marker resolved at open
  completes or discards an interrupted activation — the active root is never
  overwritten), `.neotavern-export` NDJSON interchange with explicit
  duplicate policy (`reject`/`replace`/`remap`) and offline import through
  the same candidate machinery, and a read-only legacy converter for
  pre-kernel data roots (timestamps normalized, secrets/plugins never
  copied, source never mutated). Docs: `docs/architecture/portable-data.md`,
  ADR-0032, benchmark manifest `docs/architecture/benchmarks.md`.
- **NeoBackend UI routing.** Every web UI API call now routes through the
  `NeoBackend` facade (`apps/web/src/api/backend.ts`): typed wire operations
  via `LegacyBackend`, unmigrated `/api/v2` routes through the temporary
  `raw` passthrough (removed per-slice in Фаза 3).

- **Android APK client (remote server test).** Tauri 2 Android target:
  `#[cfg(desktop)]` sidecar/updater logic and `#[cfg(mobile)]` updater stubs;
  `tauri.android.conf.json` overrides the platform config; a plain
  `mobile-connect/` start page (no React, no Tauri API) remembers the server
  address, auto-navigates on fresh loads and lets the system back button
  return to the form. The APK connects to a NeoTavern server over LAN — no
  Node, no localhost backend on the device, cleartext HTTP only in debug
  builds via the manifest placeholder. Scripts: `desktop:android:init`,
  `desktop:android:dev`, `desktop:android:build`.
- **Non-destructive message edit history.** Real manual text edits now archive the
  previous content with CAS-safe restore, cursor pagination, checkpoint/branch copying,
  and chat export v2. Swipe/regenerate variants remain a separate history.
- **ST1-style message details.** Mobile details now provide a horizontally scrollable
  action row, Copy / + / Edit footer, drag-down dismissal, a grouped Danger zone, and
  plugin actions that adapt to circle or list presentation without SDK changes.


### Fixed

- **Token counter now matches the model's real tokenizer.** DeepSeek models
  (`deepseek/*`, `deepseek-chat`, `deepseek-reasoner`, local checkpoints) are
  counted with an exact counting-only byte-level BPE engine (ranks of
  `deepseek-ai/DeepSeek-V4-Flash`, converted once into a ~1.4 MB compact file
  cached in `data/cache/tokenizers/`, atomic write, offline falls back to the
  explicit approximate estimate), so Russian and other non-English text no
  longer shows a ~10% discrepancy versus the provider's usage. The remaining
  approximate fallback is script-aware (Latin ~4.6, Cyrillic ~4.0, CJK ~1.7,
  digits ~2.0 chars/token) and the web draft estimate uses the same function
  as the server instead of a divergent constant.
- **Chat viewport pins to the newest message on every open.** Switching chats
  in-app (sidebar, back-to-parent, checkpoint links) now deterministically
  lands on the newest message even when the target chat is served from the
  query cache with an equal message count — previously the viewport could
  stay at the previous scroll position and show the greeting.
- **Generation no longer hides behind the composer.** The pinned position is
  now the absolute bottom of the scroll container instead of an end-anchor
  alignment, so the streaming reply grows fully visible above the input field
  and manual scrolling is not yanked back on every flush.
- **The user's message appears instantly on send.** An optimistic pending
  bubble renders the message before the server confirms it, then swaps to the
  confirmed message without duplicates; after an error or Stop the persisted
  message is re-synced instead of staying invisible until reload.
- **Resizable settings sidebar.** A legacy compact-density preference no longer
  pins the navigation panel to 340 px, so drag and keyboard resize once again
  update both the panel and shifted chat. The General startup choice now uses
  the same full-width segmented control as Contrast instead of a switch.
- **Message action placement.** Editing, copy, regenerate and related controls now appear at the opposite edge of the message header from the author, instead of below the message body.
- **Unified live context preview.** Home and existing chats now use the same
  debounced preview hook and side-effect-free prompt pipeline. Changing context
  size, the composer draft, or chat history immediately invalidates the same
  query instead of leaving `/chats/:id` on the previous generation audit.
- **NanoGPT generation capabilities.** NanoGPT now enables its documented
  extended samplers and reasoning-effort selector. Provider capabilities expose
  accepted effort values, and the adapter omits unsupported `max` instead of
  sending an invalid request.

- **Remote image links render in single-process mode.** The CSP `img-src`
  directive now trusts `http:`/`https:` in addition to same-origin, `data:`
  and `blob:`, so markdown image links in chat and character cards load on
  the single-process server (`ST2_WEB_DIR`) exactly as they do behind the
  Vite dev server. Scripts remain strictly same-origin.

- **Single-process web serving trusts its own origin.** With `ST2_WEB_DIR` set,
  the CORS allowlist defaults to the server's own origin instead of the Vite
  dev origin, so CORS-mode asset loads (`<script type="module" crossorigin>`)
  no longer fail with "Not allowed by CORS" on every request.
- **Provider source changes preserve the selected API key.** The provider editor
  no longer sends a hidden `apiKey: null` patch when switching between catalog
  sources, so a visibly selected NanoGPT key remains active and connection
  validation no longer fails with `PROVIDER_CONFIG_INVALID`.

- **Accurate reasoning controls.** OpenAI-compatible profiles now hide the
  unrelated Anthropic reasoning switch, expose provider-default plus the full
  `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` effort superset, and warn
  that availability is model-specific. Anthropic keeps its explicit adaptive-
  thinking switch and only offers `low`/`medium`/`high`; unsupported foreign
  effort values are omitted instead of silently becoming `low`.
- **Deterministic plugin runtime delivery across CI platforms.** Backend module
  containment now canonicalizes package roots before validating package-local
  imports (including macOS `/var` aliases), streamed route bodies stay buffered
  until the HTTP consumer attaches and replenish worker credit after drain, and
  retryable jobs persist `dispatchAt` before publishing their due event so a
  same-turn acknowledgement cannot be lost.
- **Cross-platform CI and Plugin Runtime paths.** Files API confinement now
  compares canonical roots with the nearest existing target ancestor, allowing
  macOS `/var` to `/private/var` aliases while rejecting writes through escaping
  directory symlinks. The SIGTERM test waits for the child handler handshake,
  Theme starter archives normalize text to LF, Playwright runs against the
  checked-in Windows visual baselines, and GitHub Actions use Node 24-based
  action releases.

### Changed

- **Simplified variant controls.** The Variants picker button and popover were removed; the N/M counter and previous/next arrows remain.
- **ST1-height inline editing.** Editing a message now expands the textarea to the full height of its text, without an inner scrollbar.
- **Home now continues recent conversations.** Home shows an ST1-style
  expandable vertical list of the eight most recently updated chats across all
  characters. Character selection continues the latest conversation or creates
  one when needed while keeping preview open; explicit New chat reuses a
  greeting-only conversation until it receives user input, preventing empty
  duplicates. A default-on General setting opens Home only on
  initial load, while disabled mode preserves reloads and direct links. The
  chats API adds backward-compatible `sort=recent` and character metadata.
  Home also shows `NeoTavern <version>` with Docs/GitHub/Discord links and
  replaces All chats with a dismiss-and-restore Recent chats control.


- **Literal cleanup in `packages/ui` component styles.** `components.css` now
  resolves border widths, overlay viewport limits, the mobile dialog-sheet
  height and the inner menu radii through the new tokens (`border-width`,
  `radius-inset`, `overlay-width-limit`, `overlay-height-limit`,
  `dialog-sheet-height`) instead of hardcoded `1px`/`92vw`/`60vh`/`88dvh`/
  `calc(... - 4px)` literals; rendered output is unchanged.
- **Reusable `SurfaceDialog` shell + Edit prompt on the same chrome as Plugins.**
  The glass manager dialog (size, close control, `data-component="system-surface"`)
  is extracted to `SurfaceDialog`; route `SystemSurface` and
  `PromptBlockEditorDialog` both mount content inside it. Edit prompt is a
  Plugins-style page (eyebrow/header/actions + bordered panels), not a
  one-off dialog skin.

### Added

- **ST1 message actions: swipe history, checkpoints/branches, regenerate in
  place, and MessageActionDef v2.** Migration `0020_swipe_history_and_child_chats`
  gives every stored variant a 0-based `position` (backfilled by
  `(created_at, id)`, UNIQUE per message) and adds
  `messages.variant_count` / `active_variant_position` — positions form a
  permutation of `0..variant_count-1` with exactly one hole, the active
  content, which lives in `messages.content` — plus the child-chat provenance
  columns `chats.parent_chat_id` / `origin` / `source_message_id` and the
  checkpoint flag `messages.checkpoint_chat_id`. Swiping is a non-destructive
  position swap through the new `POST /chats/:id/messages/:messageId/swipe`
  (`{position, expectedRevision?}` → `Message` | 409 `MESSAGE_CONFLICT`); the
  legacy `variants/:variantId/activate` route keeps working, accepts an
  optional `{expectedRevision}` body and is non-destructive too. Regenerate
  rewrites the last assistant reply in place: the generate route accepts
  `regenerateMessageId` (stale target fails fast with 409
  `REGENERATE_TARGET_MOVED`) and archives the old text atomically with the
  done write, so an error or abort persists nothing. New
  `POST /chats/:id/snapshots` (`{messageId, kind: 'checkpoint'|'branch',
  replace?, title?}` → `{chat, copiedMessages}`) copies the active-branch
  prefix up to the target message in 500-row keyset batches into a child chat
  (raw `meta`, variants and persistent plugin blocks preserved, `parentId`
  remapped; child inherits character/persona/background/summary; default title
  `«{parent} — checkpoint|branch»`; `replace` only repoints the checkpoint
  flag — the old child chat is never deleted). UI: the message action bar is
  always visible (primary group + «Ещё» overflow at this stage; later
  superseded by the fully inline row and the mobile details card — see the
  adaptive actions entry below), the inline editor saves
  with `Ctrl/⌘+Enter`, cancels with `Escape` and keeps the draft on CAS
  conflict with an inline error, streaming regenerates in place (no second
  bubble), the swipe pager shows `N/M` plus a lazy variant picker, and the
  checkpoint flag opens / replaces (`Shift+click`) / unlinks with a toast
  carrying an «Open» action and a back-to-parent button in the child chat
  header. Plugin SDK: `MessageActionDef` v2 — `run()` now receives an
  immutable message snapshot (`message`) and an `AbortSignal` (**breaking**
  addition; `messageId`/`chatId` stay top-level so old callers keep working),
  optional `icon` (semantic names with host fallback), `order` and
  `placement: 'primary'|'overflow'`; `message.content` is `null` unless the
  plugin holds both `ui.messageActions` and `chat.read` (adding `chat.read`
  re-triggers consent); legacy `contextMenuItems` with `context: 'message'`
  still render in the overflow menu. Sample plugin `plugins/rev4-translate/`
  demonstrates the content contract without any external service. Docs:
  `docs/api/README.md` (§ «Чаты и сообщения», «Генерация (SSE)»),
  `docs/data/README.md` (§ «Свайп-история и child-чаты (миграция 0020)»),
  `docs/migrations/README.md` (§ 0020), `docs/ux/README.md` (§ 10.2, 10.4,
  10.6, 10.8), `docs/plugin-sdk/README.md` (§ «Message actions (v2)»),
  `docs/plugin-sdk/rev4-api.md` (§ «message actions (MessageActionDef v2)»).
- **Generation metadata (`messages.meta.generation`).** New replies and
  regenerations persist `generationId`, `providerConfigId`, `providerKind`,
  `providerSource`, `model`, `durationMs` (measured directly around the
  provider call) and `usage` (`promptTokens`/`completionTokens`/`totalTokens`,
  `null` when the provider reports none); legacy `meta.model` stays for
  compatibility. No DB migration — `meta` is already JSON. The typed contract
  exports `parseMessageGenerationMeta` (strict per-field, lenient to extra
  keys, never throws) so old and corrupted metadata render safely without
  placeholder values. Docs: `docs/data/README.md` (§ «Метаданные генерации»),
  `docs/api/README.md` (§ «Генерация (SSE)»).
- **Adaptive message actions: inline desktop row + ST1 mobile details card.**
  Above `600px` the message header shows every applicable built-in and plugin
  action in one inline row (context, edit, copy, regenerate, checkpoint,
  branch, delete-checkpoint, delete, plus all plugin actions — the «Ещё»
  overflow menu is gone). At ≤`600px` the header keeps only Edit and Details:
  Details opens an accessible bottom-sheet card (drag handle, avatar, author,
  Sent/Model/Generation-time rows — only really stored values, horizontal
  scrollable action panel, rendered message text, pinned Copy/Exclude/Edit
  footer); Edit opens the same card in full-size edit mode, Cancel closes it
  (or returns to details when edit was opened from there), a failed save keeps
  the card open with an inline error. Branch/checkpoint/regenerate close the
  card first; delete/remove-checkpoint close it and open the existing
  confirmation. The card ships stable theme hooks
  (`data-component="message-details-card"`, documented `data-part`/`data-state`
  set), focus trap and focus return, Escape/backdrop draft discard, safe-area,
  RTL logical properties and ≥44px touch targets. Docs:
  `docs/ux/README.md` (§ message action bar + mobile card hooks),
  `docs/plugin-sdk/README.md` + `docs/plugin-sdk/rev4-api.md`
  (host renders `placement: 'primary'|'overflow'` actions in the same row).
- **Generation races fixed.** The regenerate archive now persists **before**
  the SSE `done` event is emitted, so the client's post-done message refetch
  never sees the stale variant count (the swipe pager could stick at `N-1/N`
  after the second in-place regenerate). The streaming client surfaces a
  `GENERATION_FAILED` error when a connection ends without a terminal event
  instead of leaving the composer stuck in the generating state, and the echo
  provider paces its chunks so the Stop button has a real clickable window.
  Deep links (`/chats/:id`, system surfaces, OAuth) are no longer hijacked by
  the `openHomeOnLoad` startup redirect — it now applies only to a bare-root
  load — and a message row with its «Ещё» overflow menu open is lifted above
  the sticky composer so menu items stay clickable.
- **New `@st2/ui` primitives + theme tokens.** `Badge` (pill with
  `default`/`success`/`danger` tones and an optional decorative icon slot),
  `Segmented` (segmented radio group) and `SelectField` (Field-style labelled
  native select) are exported from `@st2/ui` with `data-component`/`data-part`
  hooks and token-only styles. `PromptBlockEditorDialog` now uses the shared
  `SelectField` (its local copy and `.select` CSS are removed).
  The theme contract gains five canonical tokens (all three contract places):
  `border-width` (`1px`, new Borders group), `radius-inset` (`4px`, Radii
  group) and the Viewport limits group `overlay-width-limit` (`92vw`),
  `overlay-height-limit` (`60vh`), `dialog-sheet-height` (`88dvh`); values
  match the literals they replace, so visuals are unchanged.
- **Per-model prompt blocks.** Each prompt block (host and `custom-*`) can be
  bound to one model id in its edit dialog (`PromptBlockEditorDialog`) through
  the same reusable `ModelMenu` as the provider editors (models of the active
  provider via «Load models»; free text allowed; empty value means every
  model). The prompt pipeline excludes blocks whose binding does not match the
  active model; the audit reports the new `model-mismatch` exclusion reason
  («Bound to a different model»). `PromptBlockSettingsSchema` gains the
  optional `model` field (max 256 chars); templates without it behave exactly
  as before. Docs: `docs/prompt-pipeline/README.md` (§ Prompt templates),
  `docs/api/README.md` (§ settings).
- **Reusable model menu (`ModelMenu`) + frontend Plugin SDK models surface.**
  The model picker is extracted into one reusable component
  `packages/ui/src/components/ModelMenu.tsx` (searchable combobox + «Load
  models» action + status line, token-styled via `data-component="model-menu"`
  and `data-part` hooks) and replaces the hand-rolled input/datalist + model
  select in `ProviderProfileEditor` and the plain input in
  `ConnectionProfileEditor` (AI Settings API tab and Providers page). The
  `Combobox` it wraps now seeds the search box with the committed value on
  focus (editing a model id no longer corrupts it) and stays open when the
  anchor input itself is focused (Radix outside-interaction fix). Frontend
  plugin SDK gains `models.list` on the web kernel (optional `providerId`
  defaults to the active provider config, capped at `MODELS_MAX_LIST`,
  `NOT_FOUND`/`VALIDATION_FAILED`/`CAPABILITY_DENIED`) and the sandbox
  surfaces `api.models.list(providerId?)` plus the ready-to-mount
  `api.ui.modelMenu(container, options)` widget (vanilla, mirrors the host
  `ModelMenu` skin through host theme tokens shipped in the kernel handshake
  (`HostHandshake.themeTokens`) and re-pushed on theme changes via
  `st2.plugin.tokens` — resolved values, var() chains unwrapped host-side;
  built-in CSSOM `prefers-color-scheme` palette remains the fallback only.
  The widget carries the same `data-component="model-menu"` /
  `data-part` / `data-tone` markers as the host component). Sample plugin
  `plugins/rev4-modelmenu/` with full e2e cycle in
  `e2e/rev4-samples.spec.ts` (including host-token color parity
  assertions). Docs: `docs/plugin-sdk/rev4-api.md`
  (§ «models и модельное меню»), `docs/plugin-sdk/README.md`,
  `docs/ux/README.md`, `packages/ui/README.md`.
- **§58 Final acceptance statement (Plugin SDK vNext M6).** New
  `docs/plugin-sdk/vnext-acceptance.md` maps every §58 clause to concrete
  evidence (implementation files, tests, benchmark gates) and tracks the
  DoD §56 checklist. Stage H (part 28), Stage I (part 29) and Stage J
  (part 30) are closed; the remaining CI-owned items — 24h soak (B17) and
  Linux/macOS runs (B18) — run in the new `plugin-runtime-platforms`
  matrix job (ubuntu-24.04 / windows-latest / macos-14) which executes the
  full suite, the B01–B31 bench with default gates and the parity recorder
  on every OS and uploads the reports as artifacts.
- **Cross-platform parity recorder (Plugin SDK vNext Stage J, part 30).**
  `scripts/platform-parity.mjs` runs the identical conformance smoke
  (lockdown before plugin code, noNodeAuthority, module-graph load, broker
  echo round-trip, warm reload) plus cold-start p50/p95 on every supported
  OS/arch and writes `platform-parity-<os>-<arch>.json` (B18/§44/§46/§56).
  Windows x64 report recorded (PARITY OK: cold p95 9.9 ms, broker call
  0.36 ms, warm load 5.3 ms); Linux/macOS run the same script in CI.
  Platform-sensitive runtime code is confined to host-adapter level:
  `path/win32` in the graph-builder builtin list and the documented
  win32 SIGTERM guard in `processHandles` (Windows does not run JS signal
  handlers on SIGTERM). Full vitest suite green on Windows: 114 files /
  1387 tests.
- **Benchmark harness B01–B31 (Plugin SDK vNext Stage I, part 29).**
  `apps/plugin-runtime/bench/bench-vnext.mjs` runs the §47 scenarios
  against the runtime's public dist API and gates them on the §46 SLOs:
  idle RSS, 30 installed / 15 cold plugins with zero Workers, 15
  blank-hardened Workers (lockdown p50/p95), >1 GiB legitimate allocation
  survival (B05), CPU-heavy completion (B07), infinite-loop
  force-termination with a live host (B08), 1 GiB bounded-RSS workload
  (B10), cold fanout (B19), warm retention without Worker recreation
  (B20), IPC control storm with zero runtime body decodes (B21), event
  fanout with handle-only envelopes (B22), missing-globals compatibility
  (B26), WASM/SAB invisibility (B27), hostile execArgv/env injection
  (B28), stale-epoch respawn (B29), 2000-call SDK flood with bounded RSS
  (B30) and 200k-line log flood through the bounded ring (B31). Scenarios
  already covered by dedicated suites (B06, B09, B11–B18, B23–B25, B32,
  B43–B47) are mapped to their test files and asserted present. Gates are
  env-overridable (`BENCH_GATE_*`); `--heavy` adds the >1 GiB scenarios,
  `--report-only` never fails CI, `--json` writes the machine report. All
  gates pass in default and `--heavy` modes. Documented the §9.1
  compatibility profile in `@st2/plugin-runtime` README, including the
  SES design exclusion of Float32/Float64Array (NaN side-channel).
- **Build/publish pipeline (Plugin SDK vNext Stage H, part 28).** New
  `packages/plugin-build` package with the `st2-plugin` CLI:
  `analyze` (§51/§52 — Node builtin imports with `@st2/node-compat`
  suggestions, platform payload hard gates via PE/ELF/Mach-O magic sniff,
  install scripts, dynamic imports, WASM stats, suggested §12
  capabilities), `build` (§8 zero-build mode: plain JS copied, TS
  transpiled through the pinned `typescript` compiler, per-file sha256
  digests + `sourceDigest`, signed `dist/backend/artifact.json` when a
  private key is provided), `sign`/`verify` (Ed25519 §36, keyId
  fingerprint pinning — a changed publisher key is detected before
  signature verification, `PUBLISHER_KEY_CHANGED` /
  `PACKAGE_SIGNATURE_INVALID`), and `genkey`. Build-time SES
  compatibility gate `--ses-gate` (§6.5/§8.10, benchmark B25): the final
  source-first module graph is imported under the exact production
  boundary — real Node Worker + `lockdown(moderate)` + one SES Compartment
  — and the build fails with the documented error code on
  incompatibility; marketplace ingestion reuses the same gate. Runtime
  (`plugin-runtime`) ships no dependency-install path and resolves no
  plugin `node_modules` at runtime (§7.2). `PluginManifest` gained
  `publisher.keyId` + `signature`; the v4 capability catalog appended the
  vNext §12 names. Tests: 19 (analyze 5, signing 6, build 6, ses-gate 2).
- **§33 Secrets API (Plugin SDK vNext Stage E, part 27).** OAuth-backed
  secrets through the Broker; the token value never leaves Main Host.
  Contracts (`sdkOps.ts`): `secrets.use` `{ connectionId (≤64 B) }` →
  `{ handle, serviceId, expiresAt? }`; `secrets.manageOwn` `{}` → redacted
  connections (≤ 100); `secrets.reveal` `{ connectionId }` →
  `{ accessToken, tokenType?, expiresAt? }`; bounds `SECRETS_MAX_LIVE` (16
  per plugin). Executor (`memoryHost.ts`): `secrets.use` mints an opaque
  `sec-…` handle via the injected `secretsProvider` and registers it in a
  per-plugin live store; the handle feeds `network.fetch`'s `secretId`
  (§29.1.5 — the host injects the Authorization header and pins the
  destination origin; a handle minted for another plugin is unknown,
  `NETWORK_SECRET_NOT_FOUND`); `secrets.reveal` is gated on
  `trustLevel === 'trusted'` in addition to the grant (§11.3), otherwise
  `TRUST_REQUIRED`; revoking a secrets capability closes the plugin's live
  handles (§10.2). Host (`vnextBrokerHost.ts`): `createHostSecretsProvider`
  reuses the OAuth connections repo (`authConnections.ts`, ADR-0016) with
  the same status/expiry semantics; the bound origin comes from the plugin
  manifest's declared `authClients` authorization URL or an injected
  `secretOriginResolver`; failures surface as AUTH_CONNECTION_NOT_FOUND /
  AUTH_REVOKED / AUTH_NOT_CONNECTED / AUTH_TOKEN_INVALID / AUTH_EXPIRED /
  AUTH_ORIGIN_UNKNOWN. Worker SDK: `sdk.secrets.use/manageOwn/reveal` with
  fail-fast validation. Tests: 5 unit (mint + header injection + origin
  mismatch, foreign-plugin handle, manageOwn + reveal trust gate, revoke +
  cap, denial + missing provider) + 3 worker e2e + 1 full-stack (real
  Worker → `sdk.secrets.use` → mint → `network.fetch` with the handle →
  Authorization header observed host-side; reveal stayed gated at sandbox
  trust). Stage E (M4) is now complete.
- **§34 Services API (Plugin SDK vNext Stage E, part 26).** Brokered
  cross-plugin calls: `services.provide` / `services.connect` /
  `services.respond` with no direct JavaScript references between
  Compartments. Contracts (`sdkOps.ts`): provide `{ name (≤128 B), version
  (≤64 B), methods (1..32 × ≤128 B) }` → `{ serviceId }`; connect `{ name,
  version, method, args (≤16 KiB JSON), deadlineMs (≤300 s) }` → `{
  result }`; respond `{ callId, ok, result | error }`; bounds
  `SERVICES_MAX_PENDING` (64 per plugin). Executor (`memoryHost.ts`):
  host-side registry name@version → provider plugin; `services.connect`
  checks the §26.2.1 causal chain — a provider already on the path fails
  fast with `SERVICE_CALL_CYCLE` before anything is pushed; pending calls
  are deadline-bounded (`OPERATION_DEADLINE`, the abort reason is
  propagated instead of masked); the injected `serviceCallSink` pushes
  `{ kind: 'service-call', envelope }` to the provider's worker (broker
  host `vnextBrokerHost.ts` keeps a `workerByPlugin` map registered when a
  `services.provide` RPC succeeds and pruned on `workerTerminated`; a dead
  provider surfaces as `SERVICE_UNAVAILABLE`); only the provider can settle
  a call (foreign/stale responds are idempotent `{ ok: false }`); revoking
  a services capability drops the plugin's registrations and settles
  in-flight calls in both directions (§10.2). Worker SDK:
  `sdk.services.provide(options, handler)` keeps the handler locally and
  `sdk.services.connect(...)` forwards the received causal chain (the host
  appends the caller id when pushing), with fail-fast validation; bridge
  `service-call` dispatch runs the handler and settles via
  `services.respond`. Tests: 7 unit (sink round-trip, cycle, NOT_FOUND /
  VALIDATION_FAILED / provider-down, duplicate + foreign respond, revoke,
  deadline, denial) + 3 worker e2e (provide + push with the received
  chain, denial, worker-side validation with zero wire calls) + 1
  full-stack (two real Workers: A→B round-trip and the A→B→A cycle that
  fails deterministically with SERVICE_CALL_CYCLE surfaced as the method
  result — B43).
- **§19/§27 Jobs API (Plugin SDK vNext Stage E, part 25).** `jobs.register`
  / `jobs.cancel` / `jobs.list` through the Broker, one capability
  (`jobs.background`). Contracts (`sdkOps.ts`): `jobs.register` takes a name
  (≤ 128 B) and exactly one of `intervalMs` (100..2^31-1) or `atMs`
  (0..2^31-1), optional payload ≤ 64 KiB; result `{ jobId }`; bounds
  `JOBS_MAX_PER_PLUGIN` (8) and `JOBS_MIN_INTERVAL_MS` (100). Executor
  (`memoryHost.ts`): host-side scheduler — timers live in the trusted host,
  the Worker never stays resident for `setInterval` (§19); repeating jobs
  re-arm themselves, one-shot jobs self-remove after firing; the injected
  `jobPushSink(pluginId, envelope)` delivers `{ kind: 'job-run', envelope }`
  to the owning worker (broker host `vnextBrokerHost.ts` keeps a
  `jobWorkers` map registered when a `jobs.register` RPC succeeds and pruned
  on `workerTerminated`; pushes to a dead worker are dropped); revoking
  `jobs.background` cancels the plugin's timers (§10.2), executor `close()`
  cancels all. Worker SDK: `sdk.jobs.register/cancel/list` plus
  `sdk.jobs.onRun(callback)` — the callback binds to a job through an
  `onRun` token passed to `register` (bound to the jobId after the wire
  response), backed by a bounded 8-entry map, dispatched via bridge
  `job-run` messages; fail-fast validation (exactly-one schedule, bounds)
  keeps invalid calls off the wire. Tests: 7 unit (register/list/cancel,
  exactly-one schedule, one-shot fire via sink, interval re-fire + cancel,
  revoke cancels, 8/plugin cap, denial) + 3 worker e2e (typed register +
  list, capability denial, worker-side validation with zero wire calls) + 1
  full-stack (real Worker → `sdk.jobs.register` → host timer → job-run push
  → callback → console through the §9.1.1 log router).
- **§13/§32 Process API (Plugin SDK vNext Stage E, part 24).**
  `process.spawn` / `process.output` / `process.signal` / `process.wait` /
  `process.close` through the Broker (all admit with `process.spawn`).
  Contracts (`sdkOps.ts`): spawn args (absolute executable path, args ≤ 64
  × 1 KiB, cwd, env ≤ 64 entries, timeoutMs ≤ 1 h, stdout/stderr capture or
  ignore); bounds 16 live processes per plugin, output ring 64 chunks ×
  64 KiB × 8 MiB (§32.4). New `apps/plugin-runtime/src/host/processHandles.ts`:
  trusted children stay host-side; always `shell:false`, `detached:false`,
  sanitized env (§32.1); scoped mode confines executable + cwd by host
  policy (`processScope`; manifest-derived scopes arrive with Stage H),
  mismatch fails with `PROCESS_SCOPE_DENIED`; unrestricted mode requires the
  separate `system.unrestricted` grant, otherwise
  `SYSTEM_UNRESTRICTED_REQUIRED` (§32.2); spawn failures (ENOENT) reject the
  call, post-spawn errors surface through the bounded stderr ring; timeout
  kills with SIGKILL; `kill()` targets the immediate child only —
  descendant containment is not guaranteed in pure Node (§32.3) and is
  documented, not promised; revoking a process capability kills the
  plugin's children (§10.2); `closeAll` awaits child exits. Worker SDK:
  `sdk.process.*` with fail-fast validation (bare executable names refused —
  absolute paths only). Tests: 9 unit (spawn + capture, missing executable,
  cwd scope, unrestricted gate, timeout kill, SIGTERM exit, revoke cleanup,
  ring bound, handle cap) + 3 worker e2e (spawn through the typed SDK,
  capability denial, worker-side validation) + 1 full-stack (real Worker →
  `sdk.process.spawn(node -e)` → host child → captured output over the full
  wire).
- **§29 Socket API (Plugin SDK vNext Stage E, part 23).** `network.websocket`
  / `network.tcp` / `network.listen` / `network.udp` through the Broker,
  one §12 capability per family. Contracts (`sdkOps.ts`): handle-based
  methods (open/connect → opaque id; send/receive/close; listen
  open/accept/close where accepted connection ids are managed by the
  `tcp.*` methods); bounds: 32 live handles per plugin, 128-message ring ×
  64 KiB per message × 8 MiB buffer per handle (§17 evict-oldest), receive
  limit 64, wait ≤ 5 s. New `apps/plugin-runtime/src/host/socketHandles.ts`:
  trusted sockets stay host-side (the plugin never touches raw Node
  sockets); bounded message rings with waiters; outbound destinations pass
  the same §29.1 SSRF scope policy as `network.http.fetch` (loopback
  requires `network.local` etc.); bind policy §29.1.4 — loopback by
  default, `0.0.0.0`/`::` always rejected, non-loopback bind requires
  `network.listen.public`; revoking a network capability closes the
  plugin's handles (§10.2); executor shutdown closes everything. Worker
  SDK: `sdk.network.websocket/tcp/listen/udp` with fail-fast validation.
  Tests: 9 unit (tcp echo round-trip, SSRF denial, listen loopback with
  per-connection handles, bind policy, udp round-trip with remote endpoint
  info, ring eviction, revoke cleanup, handle cap, closed semantics) + 3
  worker e2e (tcp echo through the typed SDK, capability denial,
  worker-side validation) + 1 full-stack (real Worker → `sdk.network.tcp`
  → host socket → echo server over the full wire).
- **§30 Files API (Plugin SDK vNext Stage E, part 22).** First Stage E
  (Full SDK) slice: `files.read` / `files.write` / `files.stat` /
  `files.list` / `files.rename` / `files.remove`, all under the
  `files.plugin` capability (plugin-owned data directory). Contracts
  (`packages/contracts/src/sdkOps.ts`): args schemas + catalog entries +
  method constants, bounds `FILES_MAX_PATH_BYTES` (1024), `FILES_MAX_CONTENT_BYTES`
  (4 MiB), `FILES_MAX_LIST` (1000). Executor (`memoryHost.ts`): `filesRoot`
  resolver (production: `join(pluginsRoot, pluginId, 'data')` wired via
  `createVNextRuntimeService({ filesRoot })` → broker policy → executor;
  `plugins.ts` provides it), path confinement — absolute paths, drive
  letters, backslashes and `..` segments are rejected; after `resolve` the
  real path is re-checked so a symlink cannot escape the plugin root;
  atomic writes (temp + rename), bounded reads, symlink-free listings,
  per-plugin root isolation. Worker SDK: `sdk.files.*` with fail-fast
  worker-side path validation that never reaches the wire. Tests: 9 unit
  (round-trip, traversal/absolute/backslash denial, symlink escape, size
  cap, per-plugin isolation, grant denial) + 3 worker e2e (round-trip,
  denial, worker-side validation) + 1 full-stack (real Worker → `sdk.files`
  → file on disk inside the plugin data dir).
- **§8.1 persistent module-map cache (Plugin SDK vNext Stage B, part 21).**
  The last open Stage B plan item. New
  `apps/plugin-runtime/src/graph/moduleMapCache.ts`:
  `packageSourceDigest` (sha256 over the sorted package files — rel path +
  content), `resolveModuleMapVersions` (Node / SES / @endo-module-source /
  @st2-plugin-runtime versions), `moduleMapCacheKey` = sha256(sourceDigest +
  NodeVersion + SESVersion + EndoCompilerVersion + ST2LoaderVersion) — any
  component upgrade invalidates the cache, and the canonical source stays
  the single source of truth (compiled records are not the plugin ABI).
  `ModuleMapDiskCache` does atomic writes (temp file + rename, §12), treats
  corrupt/unknown entries as misses (fully removable, self-rebuilding cache,
  §20), bounds entries at 8 MiB and stores `<key>.json` under
  `data/cache/plugin-module-maps`. Integration:
  `createVNextRuntimeService({ moduleMapCacheDir })` — `buildGraph` consults
  the cache keyed by source digest before compiling (hit: stored graph +
  warnings; miss: build + put); `plugins.ts` wires the cache directory.
  Tests: 10 unit (key stability, invalidation on any component change,
  round-trip, corrupt → miss, atomicity, clear, version switch) + 1
  full-stack (two activations of unchanged source = one entry and identical
  `graphDigest`; source change = second entry).
- **§6.5/§6.6 SES Compatibility Corpus gate (Plugin SDK vNext Stage B,
  part 20, benchmark B25).** New `apps/plugin-runtime/src/corpus/`:
  `corpus-manifest.json` is a versioned manifest (package, entry,
  `expect: pass|fail`, `expectedError`, reason) and `corpus.test.ts` imports
  every entry under the exact production boundary — a real Worker +
  `lockdown(moderate)` + one SES Compartment. `loadCorpusPackage.ts` is the
  first concrete dependency-vendoring step of the build pipeline (§7.2):
  the package and its transitive bare-import dependencies are vendored into
  a flat `node_modules/<pkg>/...` tree and bare specifiers are rewritten to
  relative imports (import / export-from / dynamic-import only), with
  archive-safety bounds (§8.7: ≤128 files, ≤512 KiB per file, ≤4 MiB total,
  depth ≤4). Pass entries must report `module-graph-loaded` with non-empty
  exports; fail entries must produce the documented error code (the
  `errorTaming: 'safe'` stack may be censored, so the code is the gate).
  Initial corpus: five Endo-family passes (`@endo/hex` including its
  transitive `@endo/harden` dependency, `@endo/immutable-arraybuffer`,
  `@endo/trampoline`, `@endo/path-compare`, `@endo/env-options`) and one
  documented failure (`@fastify/error` — CommonJS parses as ESM and fails at
  evaluation with `MODULE_EVALUATION_FAILED`; the vendoring path is
  build-time transpilation, §7.2). Corpus packages are pinned devDependencies
  of `@st2/plugin-runtime`. The gate must run on every Node/SES/@endo upgrade
  (§6.6). Tests: 7 (manifest structure + 6 imports).
- **§22 emergency resource boundary from headroom (Plugin SDK vNext Stage G,
  part 19, ADR-0026).** The static `DEFAULT_EMERGENCY_LIMITS` (768/128 MiB)
  in the supervisor is replaced by a per-spawn headroom-derived ceiling.
  New `apps/plugin-runtime/src/emergencyLimits.ts`: `computeEmergencyLimits`
  derives the ceiling from free memory × 0.75 minus the runtime's own RSS
  and a 256 MiB floor reservation per live worker, clamped to
  [256 MiB, 4 GiB]; the plugin memory hint (`memoryHintMiB`, §38) raises the
  ceiling toward the declared need when headroom permits; the admin override
  (`maxHeapOverrideMiB`, §39) replaces the whole calculation; young
  generation is old/4 clamped to [64, 512] MiB. `resolveEmergencyLimits`
  fixes precedence: explicit per-spawn caps → static supervisor config →
  headroom. The hint and override ride the `WORKER_SPAWN` frame (additive
  wire fields), the trusted bootstrap reports its actual
  `worker_threads.resourceLimits` in `hardened-ready`, and the ceiling
  surfaces in `WORKER_READY.emergencyLimits` and
  `VNextWorkerInfo.emergencyLimits` (§40 diagnostics).
  `VNextPluginActivationSpec` gained `memoryHintMiB` / `maxHeapOverrideMiB`.
  Tests: 13 unit (headroom math, hint, override, clamps, precedence),
  3 supervisor e2e (override exact via `thread.resourceLimits` + ready
  report, dynamic mode within bounds and consistent, static config), 1
  subprocess e2e (override through the real wire), 1 full-stack (override
  exact; hint 2048 → ceiling ≥ 2048).
- **§20.13 runtime restart recovery (Plugin SDK vNext Stage G, part 18).**
  A crashed Plugin Runtime process no longer leaves the Main Host holding a
  dead client. `VNextRuntimeService` now listens for the client's `exit`
  event: an unexpected process exit resets host state — pending activations
  are rejected with the new `PLUGIN_RUNTIME_CRASHED` error (HTTP 503),
  broker subscriptions are pruned, active workers become cold — and the
  client reference is dropped so the next activation spawns a fresh runtime
  under an incremented `runtimeEpoch` (runtime generation, §25.2: frames from
  a dead generation are distinguishable). Recovery is demand-driven only:
  previously warm plugins are never re-activated automatically and there is
  no restart stampede (§20.13). A spawn racing the crash fails fast with
  `PLUGIN_RUNTIME_CRASHED` instead of hanging on the dead pipe, and a
  graceful `shutdown()` exit is not treated as a crash. Tests: 1 subprocess
  e2e (SIGKILL → exit event → new generation handshake under epoch 2 with
  ping + workerReady) and 1 full-stack test (activation → SIGKILL via the
  runtime's own pid line on stderr → state reset, an in-flight activation
  rejects with `PLUGIN_RUNTIME_CRASHED`, the next activation boots a fresh
  generation with a new worker id).
- **§9.1.1–§9.1.4 BoundedConsoleSink and the full console channel (Plugin SDK
  vNext Stage G, part 17).** One `console.*` call no longer creates one
  transport message. The worker sink (`apps/plugin-runtime/consoleSink.mjs`,
  TCB) is a bounded formatter (§9.1.2: max depth 4 / keys 16 / items 32 /
  string 512 B / record 4000 B / stack 32 frames; getters are never
  intentionally invoked; proxy/getter failures become placeholders) plus a
  fixed 64 KiB ring with coalescing and a `droppedCount` — the ring is the
  only log buffer, with no secondary unbounded queue behind it. Batches
  (≤16 KiB / ≤256 records, flushed on a 4 KiB threshold, a 100 ms interval or
  force at terminate) are encoded once in the worker and forwarded opaque by
  the runtime (§15.1) as `LOG_BATCH` frames (0x1b). Flush credits start at 8
  and are replenished by `LOG_BATCH_ACK` (0x1c, capped at 64): without credit
  the worker stops flushing and never accumulates payload. The host log
  router attributes records to the plugin, must emit the synthetic
  `[ST2] N plugin log records suppressed` record when a batch reports drops
  (rule 9), and always acks. Fatal diagnostics (`FATAL_DIAGNOSTIC` 0x1d) ride
  a reserved, non-displaceable path: `uncaughtException` /
  `unhandledRejection` produce a bounded envelope plus a stderr line, the
  worker stays up only until `module-graph-loaded` / `module-graph-error` is
  delivered (deterministic activation outcome), then exits(1) (§9.1.4 /
  §26.1.3 / §26.1.4); the runtime retains the last envelope and attaches it
  to `WORKER_TERMINATED` so crash attribution survives frame races. Server
  wiring: `VNextRuntimeService` `logSink` / `fatalSink` options and a
  `[plugin:<id>]`-prefixed level mapping onto `ctx.logger` in `plugins.ts`.
  Tests: 13 unit (formatter bounds, ring coalesce/drop/drain, credits),
  5 worker e2e (batch round-trip, terminate flush, flood + droppedCount with
  ack loop, fatal paths), 2 subprocess e2e (LOG_BATCH + ack, FATAL_DIAGNOSTIC
  + WORKER_TERMINATED-with-fatal), 2 full-stack (log router attribution +
  synthetic suppressed record), 1 contracts pin. Import-time unhandled
  rejections no longer kill the worker before its graph report goes out; the
  four pre-existing full-stack lifecycle tests were restored and the
  "already active" test now uses a capability-granted plugin (a denied
  fire-and-forget chain is Worker-fatal by policy).
- **§29.1.1 scope capabilities (Plugin SDK vNext Stage F, part 16).**
  `network.http` alone now permits only public Internet addresses. Loopback
  (`127/8`, `::1`, `0.0.0.0/8`), RFC1918 / link-local / ULA / multicast, and
  cloud metadata endpoints each require an additional scope capability
  granted alongside `network.http`: `network.local`, `network.private`, and
  `network.metadata` respectively. New contracts: `NETWORK_SCOPE_LOCAL`,
  `NETWORK_SCOPE_PRIVATE`, `NETWORK_SCOPE_METADATA`,
  `NETWORK_SCOPE_CAPABILITIES`, `NetworkScope` interface, and
  `DEFAULT_NETWORK_SCOPE` (all-false). The executor's `isPublicIp` is
  replaced by `classifyAddress`, which returns `'public' | 'local' |
  'private' | 'metadata'`; cloud metadata IPs (`169.254.169.254`,
  `169.254.170.2`) are classified as `'metadata'` before link-local so they
  get the dedicated `network.metadata` scope, not `network.private`.
  `checkDestination` admits a non-public address only when the plugin's
  effective `NetworkScope` has the matching flag set; otherwise it fails
  with `NETWORK_DESTINATION_DENIED` (or `NETWORK_REDIRECT_DENIED` on a
  redirect hop, §29.1.3) and the error's `details.requiredScope` names the
  missing capability. Scope applies per-hop — every redirect is
  re-checked. A new `networkScopeProvider?: (pluginId) => NetworkScope`
  option lets the production broker derive the scope from the same DB
  grant rows the consent flow writes (`vnextBroker.ts` default provider),
  while the reference host derives it from the in-memory grants map. Tests:
  13 unit (local / private / metadata allow + deny, ECS metadata
  169.254.170.2, non-metadata link-local 169.254.1.1 → private, IPv6
  loopback, redirect scope re-check, redirect to private allowed, custom
  provider override, `requiredScope` in error details), 1 contracts pin.
- **§29 keep-alive/pooling, proxy and secret-bound requests (Plugin SDK vNext
  Stage F, part 15).** The `network.http.fetch` transport now satisfies §29 in
  full. A new `NetworkPool` (`apps/plugin-runtime/src/host/networkPool.ts`)
  provides real connection pooling over bounded `http.Agent`/`https.Agent`
  keep-alive agents (per-origin socket caps, idle TTL and connect timeout
  pinned in contracts: `NETWORK_POOL_MAX_SOCKETS_PER_ORIGIN` = 6,
  `NETWORK_POOL_MAX_FREE_SOCKETS` = 4, `NETWORK_POOL_KEEP_ALIVE_MS` = 60 s,
  `NETWORK_POOL_CONNECT_TIMEOUT_MS` = 10 s). The executor creates it lazily and
  it is the default transport; injectable `fetchImpl` (tests) bypasses it so
  test runs never leave pooled sockets behind, and `close()` on the executor /
  policy / broker host (wired into runtime `shutdown()`) releases idle sockets
  with a bounded poll. Proxies are executor-level configuration (`proxyUrl`,
  never plugin-controlled — a plugin-set proxy would be a local pivoting
  hole): HTTP targets use the absolute-form request line, HTTPS targets a
  CONNECT tunnel with TLS over the tunneled socket (tunneled connections are
  not pooled and every exit path destroys the sockets). Secret-bound requests
  (§29.1.5): fetch args gain an opaque `secretId`; the executor resolves it
  against the service-level `networkSecrets` registry and injects the secret's
  headers at request time (secret wins on header conflicts; the plugin never
  sees the value). The first hop must stay inside the secret's bound origin
  (`NETWORK_SECRET_ORIGIN_MISMATCH`, no `use secret X + arbitrary Y`), an
  unknown handle fails with `NETWORK_SECRET_NOT_FOUND`, and redirects never
  carry the injected secret to another origin — they continue without the
  secret headers. Tests: 6 unit `networkPool.test.ts` (keep-alive reuse proven
  by a single TCP connection serving two requests, per-origin socket bounds,
  close semantics, absolute-form proxy round-trip, CONNECT tunneling with no
  leaked sockets, non-http proxy URL rejected at creation), 4 executor tests
  (injection + secret-wins, not-found, origin mismatch, redirect drops the
  secret), 2 worker e2e (secretId rides the wire; oversized secretId rejected
  locally), 2 full-stack e2e (secret injected through the real runtime wire;
  mismatch through the real wire), 1 contracts pin.
- **§17 credit streams / chunked streaming for large response bodies (Plugin
  SDK vNext Stage F, part 14).** Encoded response bodies larger than one chunk
  (256 KiB, `RPC_STREAM_CHUNK_BYTES`) now travel the fd 3 data pipe as
  `RPC_RESPONSE_STREAM` frames (0x1a, host → runtime, ≤ 256 KiB each) instead
  of one giant frame. Each frame's payload is `header JSON + NUL + raw chunk`
  (`{ requestId, seq, final }` — JSON text can never contain a raw NUL, so the
  separator is unambiguous); the runtime relays the payload opaque and the
  worker is the single assembly and decode point (§15.1). Flow control is
  credit-based per §17: the window starts at one chunk, the worker grants
  `{ kind: 'rpc-stream-credit', requestId, bytes }` (a `BRIDGE_MESSAGE` the
  host client consumes internally and never re-emits as app-level) after each
  consumed chunk, and the producer never creates the next chunk without a free
  window. No unbounded queues: the host stream registry is bounded
  (`RPC_STREAM_MAX_CONCURRENT` = 16; overflow fails the response with a broker
  error, never a silent stall) and the worker accumulator is capped at
  `RPC_STREAM_MAX_ACCUMULATED_BYTES` = 16 MiB (headroom over the 8 MiB network
  body cap; seq gaps / cap overflow fail the call with `VALIDATION_FAILED`).
  The host side is a dedicated, unit-tested `ResponseStreamer` state machine;
  the client exposes diagnostics counters (`responseStreamFrameCount`,
  `responseStreamByteCount`). Bodies are still buffered at the endpoints
  (producer-side streaming reads from executors are a documented follow-up);
  the win is bounded transport and runtime parser memory. Tests: 6 unit
  `responseStreamer.test.ts`, 1 in-process worker e2e (600 KiB reassembled
  across 3 chunks), 1 subprocess e2e (600 KiB result → 3+ frames through the
  real runtime with a live credit round-trip), 1 full-stack e2e (600 KiB fetch
  body through the real server + DB grants).
- **Request direction for large RPC arguments over the data pipe (Plugin SDK
  vNext Stage F, part 13).** Broker-call arguments above the control bound now
  travel the fd 4 data pipe as `RPC_REQUEST_DATA` frames (0x19, worker → host
  via the runtime, opaque payload decoded once by the host client, §15.1).
  The worker routes deterministically in `invokeBrokerCall`: args ≤ 32 KiB
  keep the structured-clone control path; up to 16 MiB
  (`BROKER_MAX_ARGS_DATA_BYTES`) are serialized into the final wire body
  exactly once and shipped as `{ kind: 'rpc-request-data', requestId,
  pluginId, capabilityName, causalChain, deadlineAt, payloadBytes }`; larger
  args fail with `VALIDATION_FAILED`. The broker gateway recognizes the new
  bridge message and both broker cores gained `submitOpaque`: the forwarding
  core admits the call (deadline, revocation, duplicates, in-flight cap)
  against the mirrored metadata and relays the payload without decoding, the
  in-process reference core decodes and runs the policy. The runtime's fd 4
  became a real producer: a serialized bounded outbox (single write chain,
  drain-based backpressure, ≤ 8 queued frames — excess fails the call), and on
  Windows data sockets open one-directionally (`readable: false,
  writable: true`) because a pending read on a named-pipe handle blocks
  writes. `SDK_MAX_KV_VALUE_BYTES` and `SDK_MAX_SETTINGS_VALUE_BYTES` raised
  from 32 KiB to 8 MiB (values travel the data pipe in both directions).
  Tests: 2 in-process worker e2e (100 KiB KV and settings values round-trip
  through the reference core; the old size-bound test now uses a 9 MiB
  value), 1 subprocess e2e (200 KiB args → fd 4 → `rpcRequest` with the full
  payload), 1 full-stack e2e (100 KiB KV value through the real subprocess
  runtime and DB grants).

- **Streaming response bodies over the data pipe (Plugin SDK vNext Stage F,
  part 12).** Broker-call results larger than the control path now travel the
  data pipe as `RPC_RESPONSE_DATA` frames (0x18, host → runtime, opaque
  payload decoded once by the worker, §15.1); `PluginRuntimeClient
  .sendRpcResponse` routes deterministically between the control frame and the
  data pipe. `NETWORK_MAX_BODY_BYTES` raised from 32 KiB to 8 MiB, so
  `sdk.network.fetch` returns full large bodies (still buffered whole —
  chunked §17 credit streams come later). Hardening: a module-graph snapshot
  with an oversized export can no longer crash the runtime via the
  BRIDGE_MESSAGE control frame — the worker bounds the snapshot at 48 KiB and
  reports `snapshotOmitted`. `VNextRuntimeOptions` gained injectable
  `fetchImpl`/`dnsLookupImpl` for tests. Tests: subprocess e2e (a 200 KiB
  broker result over the data pipe), subprocess e2e (a 300 KiB export →
  `snapshotOmitted`, runtime stays alive), full-stack e2e (a 100 KiB fetch
  body through the real subprocess runtime), in-process (fetch bodies above
  the old 32 KiB cap arrive intact).

- **Data pipes + large module graphs (Plugin SDK vNext Stage F, part 11).**
  The §15.9 control/data head-of-line isolation topology is now functional:
  the Plugin Runtime owns a separate bounded outbox and bulk-frame parser on
  the data pipes (fd 3/4, cap `PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES` = 256
  MiB) and the host client wires both ends (fd 3 writes, fd 4 parses into an
  opaque `dataFrame` event). New wire frame `MODULE_GRAPH_DATA` (0x17,
  host → runtime over the data pipe): same `{ workerId, workerEpoch, graph }`
  body as `MODULE_GRAPH` but opaque to the wire — the worker is the single
  decode point (§15.1). `sendModuleGraph` routes deterministically: the
  control frame only when the encoded body fits the control cap with escaping
  slack and every module source stays under the §15.11 string bound; larger
  graphs go the data pipe. Host-side graph caps raised from 24/48 KiB to
  per-source 64 KiB and total 256 KiB. Tests: 4 codec/parser unit tests,
  1 subprocess e2e (a ~60 KiB source graph loads over the data pipe) and
  1 full-stack e2e (plugin activation with a 60 KiB source through the real
  subprocess runtime).

- **Live-delivery event subscriptions (Plugin SDK vNext Stage F, part 10).**
  `sdk.events.subscribe({ name, cursor? }, signal?)` now returns an async
  iterator (`next()` / `close()` / `[Symbol.asyncIterator]`) that receives
  host-emitted events in real time. New SDK operations `events.subscribe` /
  `events.unsubscribe` in the catalog (core channel §18, no grant; per-plugin
  cap `EVENTS_MAX_SUBSCRIPTIONS_PER_PLUGIN` = 8 → `SERVICE_UNAVAILABLE`). New
  wire frame `HOST_BRIDGE_MESSAGE` (0x16, host → runtime → worker, app-level;
  the worker-ward sibling of `BRIDGE_MESSAGE` 0x15); the runtime only checks
  worker identity and forwards the payload. Host side: `eventPushSink` in the
  reference executor (`memoryHost.ts`), subscription routing
  (subscriptionId → worker) in the broker host with cleanup on
  `events.unsubscribe` and `workerTerminated`, and a public emit path:
  `VNextRuntimeService.emitEvent(name, payload)` /
  `VNextBrokerHostService.emitEvent`. Worker side: bounded push queue (128),
  dedupe by seq, and a bounded-wait replay fallback so a lost push cannot hang
  the iterator. Tests: 5 executor unit, 2 in-process worker e2e, 4 broker-host,
  2 full-stack subprocess e2e (real wire: emit → worker → granted KV call →
  log marker).

- **M1 prototype go/no-go measurements (Plugin SDK vNext §54).**
  `apps/plugin-runtime/bench/m1-gates.mjs` runs the real subprocess runtime and
  measures the §54 gates measurable on a dev machine: idle runtime RSS,
  incremental RSS per blank worker, extrapolated worker capacity on 3 GiB, cold
  worker startup p50/p95 (wall + worker-side bootstrap), SES module load
  overhead, warm broker call host-ward hop latency, and infinite-loop
  termination latency (force-terminate path). Results are recorded to
  `docs/plugin-sdk/vnext-m1.md` (`--record`). First run (win32, node v24):
  idle runtime 72.7 MiB, blank worker ≈ 30 MiB delta (≈91 workers on 3 GiB),
  cold startup p50 447 ms / p95 465 ms, module load overhead 25 ms, warm
  broker hop 0.3 ms, infinite-loop termination p95 111 ms. Conclusion:
  `maxActivePlugins` is not needed (§54); deferred gates (8-10, 13-15) need
  the data-pipe infrastructure, a plugin corpus and long-running/platform
  suites.

- **v3 plugin spawn integration (Plugin SDK vNext Stage A, prototype).** The
  plugin manager now activates v3 backends in the real Plugin Runtime:
  `apps/server/src/plugin/vnextRuntime.ts` (`createVNextRuntimeService`)
  lazily spawns the runtime process, reads the plugin package from disk,
  builds the signed module graph host-side, and drives the activation cycle
  `WORKER_SPAWN → WORKER_READY → MODULE_GRAPH → module-graph-loaded`; the
  part-9c broker host is attached to the runtime transport so worker-side
  capability calls are decided by the Main Host policy against real DB grants.
  Wire additions in `@st2/contracts`: frame `MODULE_GRAPH` (0x14, host →
  runtime: the signed graph travels after hardened-ready per §15.8, opaque to
  the wire) and `BRIDGE_MESSAGE` (0x15, runtime → host: app-level worker
  bridge messages — module-graph-loaded/error today, live delivery in Stage
  F); `BrokerGateway.handleBridgeMessage` now reports whether it consumed the
  message. `PluginRuntimeClient` gained `sendModuleGraph` and the
  `bridgeMessage` event. `plugins.ts` routes apiVersion ≥ 3 through the
  service in every lifecycle point (install, reactivate, activate/disable/
  delete, safe-mode, onReady, onClose). Prototype limits (documented):
  one control-frame graph (64 KiB cap, per-module source ≤ 24 KiB), one
  worker per plugin, no worker restarts. Tests:
  `apps/plugin-runtime/src/runtimeClient.test.ts` (3 subprocess e2e: graph →
  loaded, evaluation error, stale-epoch reject) and
  `apps/server/test/vnextRuntime.spec.ts` (7 full-stack: broker round-trip
  through the real runtime, host-authoritative denial, activation failure +
  worker cleanup, already-active, deactivate no-op, shutdown + lazy restart,
  no protocol errors). Internal infrastructure; user-visible change: v3
  plugins activate end-to-end instead of failing with
  `PLUGIN_RUNTIME_UNAVAILABLE` (that code now only covers runtime spawn
  failure).

- **Main Host broker host + manifest v3 gate (Plugin SDK vNext Stage D part
  9c, prototype).** `apps/server/src/plugin/vnextBrokerHost.ts` —
  `createVNextBrokerHost(ctx, transport, options)` plugs the part-9 production
  policy into `createCapabilityBrokerCore` on Main Host: host-ward
  `RPC_REQUEST` frames become core submissions and the decision travels back
  as `RPC_RESPONSE` (part 9b wire); `revoke` aborts host-side in-flight calls
  and emits a `BROKER_REVOKE` frame so worker-side promises fail fast. The
  transport is injectable — `createPluginRuntimeTransport(client)` and
  `attachVNextBrokerHost(client, host)` adapt a `PluginRuntimeClient` (runtime
  spawn/worker lifecycle lands in Stage A). Boundary hardening: malformed
  frame bodies and call envelopes degrade to `VALIDATION_FAILED` with an
  unmatchable `requestId` (never poisons a real call), a host-side in-flight
  cap answers `SERVICE_UNAVAILABLE`, and wire errors are normalized exactly
  once. Manifest compat gate (ADR-0027 §3): `CURRENT_API_VERSION` is now 3 in
  `packages/plugin-sdk`, `InstalledPlugin.compatibilityLevel` gained
  `native-v3`, and activating a v3 plugin before the Stage A runtime
  integration returns the new `PLUGIN_RUNTIME_UNAVAILABLE` error (503)
  instead of running v3 code on the rev4 path. Also fixed in part 9:
  `fetchImpl`/`dnsLookupImpl` policy options now reach the reference executor
  (previously a silent no-op — real network calls leaked into tests); the
  injection test now asserts a body marker. Tests:
  `apps/server/test/vnextBrokerHost.spec.ts` (12: round-trip, denial, trust
  gate, revoke-abort + revoke frame, malformed frame/envelope, capacity cap,
  shutdown abort, transport wiring) plus manifest tests (apiVersion 3
  accepted, 4 rejected). Internal infrastructure; user-visible change is the
  v3 compat gate error.

- **Host-ward broker RPC relay (Plugin SDK vNext Stage D part 9b,
  prototype).** Worker broker calls now travel the production wire shape:
  `runtime-main` wires the supervisor `onBridgeMessage` hook through
  `createBrokerGateway(createHostForwardingCore(...))`; every admitted call
  ships host-ward as an `RPC_REQUEST` control frame (stamped with
  workerId/workerEpoch) and the worker-side pending promise settles from the
  matching `RPC_RESPONSE`. New wire contracts in `@st2/contracts`: frame type
  `BROKER_REVOKE` (0x13, additive) plus `PluginRuntimeRpcRequestBody` /
  `PluginRuntimeRpcResponseBody` / `PluginRuntimeBrokerRevokeBody` schemas.
  The forwarding core keeps admission protocol-level (envelope shape, deadline
  cap and expiry, causal cycles, duplicate requestIds, local revocation state,
  in-flight bound) while the capability decision stays in Main Host (ADR-0027);
  it aborts in-flight calls on `BROKER_REVOKE` (host-driven, `CAPABILITY_REVOKED`),
  on deadline expiry, on worker exit (epoch-matched) and on runtime shutdown,
  and drops `RPC_RESPONSE`s that race a worker restart (epoch mismatch).
  `PluginRuntimeClient` gained the `rpcRequest` event and
  `sendRpcResponse`/`sendBrokerRevoke` transport methods. Tests:
  `apps/plugin-runtime/src/broker/hostForwardingCore.test.ts` (21 unit) and
  `workerForwarding.test.ts` (3 worker e2e through the new
  `withForwardingWorker` harness: round-trip, host-side denial over the wire,
  revoke-abort B14 over the wire). Internal infrastructure; no user-facing
  behavior change.

- **Main Host broker policy for the vNext Capability Broker (Plugin SDK
  vNext Stage D part 9, prototype).** `apps/server` gained
  `src/plugin/vnextBroker.ts` — `createVNextBrokerPolicy(ctx, options)` builds
  the production `BrokerPolicy` (ADR-0027): `authorize` validates the call
  against the `SDK_OPERATION_CATALOG` (unknown method →
  `PROTOCOL_UNSUPPORTED`, capability/method mismatch → `POLICY_DENIED`), reads
  the grant from `ctx.database.repos.capabilityGrants` (the consent-flow rows,
  so revoke and expiry take effect on the next call; missing →
  `CAPABILITY_DENIED`, stale observed revision → `CAPABILITY_REVOKED`), and
  enforces the §31 trust gate (`database.core.read` requires
  `trustLevel: 'trusted'`, otherwise `TRUST_REQUIRED`). `execute` reuses the
  reference host executor with production backends: chats/characters/lorebook
  via `ctx.database.repos.*` (mapped to the summary schemas), `models.list`
  via provider config + adapter `listModels()`, `database.core.query` via a
  prepared statement on `ctx.database.sqlite` (the SQL gate and cell
  validation stay in the executor). All backends and the grant source are
  injectable for tests; the context surface is narrowed to `VNextBrokerHost`,
  and `assertProviderConfigValid` now takes the smaller
  `ProviderConfigValidationContext`. `@st2/server` depends on
  `@st2/plugin-runtime`. Tests: `apps/server/test/vnextBroker.spec.ts` (19:
  catalog/mismatch/core-channel/grant/revoke/expiry/revoke-race/trust gate/
  injected grantsProvider; production-backend round trips for characters,
  chats, lorebook, core DB, models and network). Internal infrastructure; no
  user-facing behavior change.

- **Brokered core DB read queries (Plugin SDK vNext Stage D part 8,
  prototype).** The §31 trusted `database.core.read` capability is now exposed
  as `sdk.db.query(sql, params?)` (broker method `database.core.query`). The
  reference host executor gates the SQL before delegating: exactly one
  read-only `SELECT`/`WITH` statement is admitted (write verbs, mutating
  keywords, multi-statement inputs and non-SELECT prefixes raise
  `POLICY_DENIED`), parameters must be bindable (non-finite numbers raise
  `VALIDATION_FAILED`), and the returned page is capped at
  `DATABASE_MAX_ROWS` (1000) rows and `DATABASE_MAX_COLUMNS` (64) columns
  with non-primitive cells rejected. The executor delegates to an injectable
  `dbQuery` function (in production a prepared statement on `ctx.database`);
  plugins never receive a DB driver module (§31). SQL text is bounded to
  `DATABASE_MAX_SQL_BYTES` (4096) and `DATABASE_MAX_PARAMS` (64) parameters.
  Contracts: `packages/contracts/src/sdkOps.ts` gained
  `SdkDatabaseQueryArgs/Result`, the four `DATABASE_*` bounds and one catalog
  entry. Tests: 7 unit (round-trip, write-gate across 10 statement kinds,
  multi-statement/prefix gate, CTE and `pragma_table_info` allowlisted,
  non-primitive cells, rows/columns cap, grant required) + 3 real-worker e2e
  (round-trip, local validation, grant required) + schema contract tests.
  Internal infrastructure; no user-facing behavior change.

- **Lorebook read operations over the Capability Broker (Plugin SDK vNext
  Stage D part 7, prototype).** The §12 `lorebook.read` capability is now
  exposed as three read-only SDK operations: `sdk.lorebook.list({ cursor?,
  limit?, characterId? })` returns a cursor-paginated page of books plus a
  `nextCursor`, `sdk.lorebook.read(bookId)` returns the full book, and
  `sdk.lorebook.entries(bookId)` returns the entries of a book (broker
  methods `lorebook.list`, `lorebook.read`, `lorebook.entries`, all gated by
  `lorebook.read`). The reference host executor delegates to injectable
  `lorebooksList` / `lorebookRead` / `lorebookEntries` functions (in
  production backed by `ctx.database.repos.lorebooks`); an unknown book (or a
  book without readable entries) raises `NOT_FOUND`. The book list is capped
  at `LOREBOK_MAX_LIST` (200), the entry list at `LOREBOK_MAX_ENTRIES` (1000),
  and cursors are bounded to 256 bytes. The results reuse the existing
  `LorebookSchema` and `LorebookEntrySchema` from
  `packages/contracts/src/lorebook.ts`. Contracts:
  `packages/contracts/src/sdkOps.ts` gained `SdkLorebookListArgs/Result`,
  `SdkLorebookReadArgs/Result`, `SdkLorebookEntriesArgs/Result`,
  `LOREBOK_MAX_LIST` / `LOREBOK_MAX_CURSOR_BYTES` / `LOREBOK_MAX_ENTRIES` and
  three catalog entries. Tests: 9 unit (list, characterId filter, read,
  NOT_FOUND, entries, entries NOT_FOUND, grant required, list cap, entries
  cap) + 5 real-worker e2e + schema contract tests. Internal infrastructure;
  no user-facing behavior change.

- **Characters read operations over the Capability Broker (Plugin SDK vNext
  Stage D part 6, prototype).** The §12 `characters.read` capability is now
  exposed as two read-only SDK operations: `sdk.characters.list({ cursor?,
  limit? })` returns a cursor-paginated page of character summaries plus a
  `nextCursor`, and `sdk.characters.read(characterId)` returns the full
  character (broker methods `characters.list` and `characters.read`, both
  gated by `characters.read`). The reference host executor delegates to
  injectable `charactersList` / `charactersRead` functions (in production
  backed by `ctx.database.repos.characters`); an unknown character raises
  `NOT_FOUND`, and the returned list is capped at `CHARACTERS_MAX_LIST` (200)
  with cursors bounded to 256 bytes. The results reuse the existing
  `CharacterSummarySchema` and `CharacterSchema` from
  `packages/contracts/src/character.ts`. Contracts:
  `packages/contracts/src/sdkOps.ts` gained `SdkCharactersListArgs/Result`,
  `SdkCharactersReadArgs/Result`, `CHARACTERS_MAX_LIST` /
  `CHARACTERS_MAX_CURSOR_BYTES` and two catalog entries. Tests: 5 unit (list,
  read, NOT_FOUND, grant required, cap) + 4 real-worker e2e + schema contract
  tests. Internal infrastructure; no user-facing behavior change.

- **Chats read operations over the Capability Broker (Plugin SDK vNext Stage D
  part 5, prototype).** The §12 `chats.read` capability is now exposed as two
  read-only SDK operations: `sdk.chats.list({ cursor?, limit?, characterId? })`
  returns a cursor-paginated page of chat summaries plus a `nextCursor`, and
  `sdk.chats.read(chatId)` returns the full chat (broker methods `chats.list`
  and `chats.read`, both gated by `chats.read`). The reference host executor
  delegates to injectable `chatsList` / `chatsRead` functions (in production
  backed by `ctx.database.repos.chats`); an unknown chat raises `NOT_FOUND`,
  and the returned list is capped at `CHATS_MAX_LIST` (200) with cursors
  bounded to 256 bytes. The results reuse the existing `ChatSummarySchema`
  and `ChatSchema` from `packages/contracts/src/chat.ts`. Contracts:
  `packages/contracts/src/sdkOps.ts` gained `SdkChatsListArgs/Result`,
  `SdkChatsReadArgs/Result`, `CHATS_MAX_LIST` / `CHATS_MAX_CURSOR_BYTES` and
  two catalog entries. Tests: 5 unit (list, read, NOT_FOUND, grant required,
  cap) + 4 real-worker e2e + schema contract tests. Internal infrastructure;
  no user-facing behavior change.

- **Models list over the Capability Broker (Plugin SDK vNext Stage D part 4,
  prototype).** The §12 `models.list` capability is now exposed as
  `sdk.models.list(providerId)` (broker method `models.list`). The reference
  host executor delegates to an injectable `modelsProvider` (in production this
  is the provider adapter's `listModels()` call); an unknown provider raises
  `NOT_FOUND`, and the returned list is capped at `MODELS_MAX_LIST` (256). The
  result reuses the existing `ModelInfoSchema` from
  `packages/contracts/src/provider.ts` (`{ id, name, contextLimit? }`).
  Contracts: `packages/contracts/src/sdkOps.ts` gained `SdkModelsListArgs/
  Result`, `MODELS_MAX_LIST` and a catalog entry mapping `models.list` →
  `models.list`. Tests: 4 unit (round-trip, NOT_FOUND, grant required, cap) +
  3 real-worker e2e + schema contract tests. Internal infrastructure; no
  user-facing behavior change.

- **Network fetch over the Capability Broker (Plugin SDK vNext Stage D part 3,
  prototype).** The §29 `network.http` capability is now exposed as
  `sdk.network.fetch(url, options)` (broker method `network.http.fetch`). The
  reference host executor (`apps/plugin-runtime/src/host/memoryHost.ts`)
  enforces SSRF hardening per §29.1: only `http`/`https` schemes are accepted;
  loopback, RFC1918 private ranges, link-local, cloud metadata
  (`169.254.0.0/16`), IPv6 loopback/ULA/link-local are denied with
  `NETWORK_DESTINATION_DENIED`; DNS rebinding (§29.1.2) is blocked by resolving
  the hostname before connect and policy-checking every resolved IP; redirects
  (§29.1.3) are followed manually with each target re-checked — a forbidden
  redirect raises `NETWORK_REDIRECT_DENIED`, the hop cap is 8. The response body
  is returned as a string (control-path, 32 KB cap until Stage F streaming
  bodies). The executor accepts injectable `fetchImpl` and `dnsLookupImpl` so
  tests stub network and SSRF edges without real I/O. Contracts:
  `packages/contracts/src/sdkOps.ts` gained `SdkNetworkFetchArgs/Result`,
  `NETWORK_*` bounds and a catalog entry mapping `network.http.fetch` →
  `network.http`. `KernelErrorCode` extended with `NETWORK_DESTINATION_DENIED`
  and `NETWORK_REDIRECT_DENIED` (§41). Tests: 11 unit (round-trip, SSRF
  loopback/private/metadata/scheme, DNS rebinding, redirect follow/manual/deny,
  grant required, body truncation) + 3 real-worker e2e + schema contract tests.
  Internal infrastructure; no user-facing behavior change.

- **Events channel over the Capability Broker (Plugin SDK vNext Stage D part 2,
  prototype).** The §18 events channel (ADR-0025 §J1 cursor/replay) is now
  exposed as a pull-based Core SDK operation `sdk.events.replay({ name,
  cursor?, limit?, waitMs? })` over the broker. The reference host executor
  (`apps/plugin-runtime/src/host/memoryHost.ts`) keeps a bounded ring buffer
  per event name (128/name, 4096 total, TTL 60 s, FIFO global eviction) with a
  per-name sequence and `evictedUpToSeq` tracking: cursors that fell outside
  the replay window raise `EVENT_CURSOR_EXPIRED`, a cursor ahead of the newest
  emitted event raises `VALIDATION_FAILED`, and concurrent replay waiters are
  bounded (64, `SERVICE_UNAVAILABLE` when exhausted). The wait is clamped to
  the broker deadline (a small margin avoids racing the in-flight deadline
  abort). Events are a core channel — `capability: null` in the operation
  catalog — so no §12 grant is required, but identity, deadline, cycle and
  bound checks still apply. Contracts: `packages/contracts/src/sdkOps.ts`
  gained `SdkEventsReplayArgs/Result`, `SdkEventEnvelope`, `EVENTS_*` ring
  bounds and a catalog entry with `capability: null` (the catalog type is now
  `string | null`). `KernelErrorCode` extended with `EVENT_BUFFER_EVICTED`
  (§41, reserved for the push/ack layer in Stage F); `BrokerErrorCode`
  extended with `SERVICE_UNAVAILABLE`. Tests: 8 unit (ring eviction, cursor
  expiry, per-name/global caps, TTL sweep, bounded wait, waiter cap, deadline
  clamp) + 3 real-worker e2e (replay from beginning, wait for an event,
  cursor expired) + events schema contract tests. Internal infrastructure; no
  user-facing behavior change.

- **Core SDK layer over the Capability Broker (Plugin SDK vNext Stage D part 1,
  prototype).** First typed capability operations on the new runtime:
  `packages/contracts/src/sdkOps.ts` defines the operation catalog — the
  single source of truth mapping broker `method` → §12 capability name
  (`storage.kv.*`, `settings.get`/`set`) plus TypeBox args schemas and value
  bounds. `worker-bootstrap.mjs` gained the frozen `sdk` endowment
  (`sdk.kv.get/set/delete/list`, `sdk.settings.get/set`) over the raw bridge:
  inputs are validated in the bootstrap before reaching the wire, validation
  failures surface as promise rejections (`VALIDATION_FAILED`), values are
  size-bounded (32 KiB, control path until Stage F). New reference host
  executor `apps/plugin-runtime/src/host/memoryHost.ts` implements the first
  operations with in-memory per-plugin KV/settings stores and per-§12 grants;
  it plugs into the broker core as a `BrokerPolicy` and denies unknown methods
  (`PROTOCOL_UNSUPPORTED`), capability/method mismatches (`POLICY_DENIED`) and
  ungranted capabilities (`CAPABILITY_DENIED`). `module-graph-loaded` drain
  switched to quiescent polling so chained import-time calls
  (`sdk.kv.set(...).then(() => sdk.kv.get(...))`) settle before the snapshot.
  Tests: 8 unit (host executor through the real broker core) + 5 real-worker
  e2e (kv/settings round-trips, chained calls, per-capability denial, worker-
  side input validation that never reaches the wire, value bound) + SDK
  operation schema contract tests. Internal infrastructure; no user-facing
  behavior change.

- **Capability Broker over the Plugin Runtime (Plugin SDK vNext Stage C,
  prototype).** New `apps/plugin-runtime/src/broker/*` (package
  `@st2/plugin-runtime`): `capabilityBroker.ts` implements the §10.1 admission
  checks (envelope validation, deadline fail-fast and in-flight deadline abort,
  `SERVICE_CALL_CYCLE` fail-fast over the causal call chain A→B→C per §26.2.1,
  revocation overlay per §10.2 with in-flight abort, B14) and delegates
  grant/trust/consent decisions to an injected `BrokerPolicy`; the bridge
  gateway (`brokerGateway.ts`) wires worker `rpc-request` bridge messages into
  the core and replies `rpc-response`, while the supervisor stays
  transport-pure (§16.1) behind a new `onBridgeMessage` hook. Worker bootstrap
  gained the hardened `bridge.invoke(method, args, options)` endowment — the
  only path plugin code can reach the broker — building the `BrokerCallRequest`
  envelope from workerData identity (pluginId/installationId/trustLevel) with
  bounded method/args/deadline/causal chain (§15.11); spawn now carries a
  `trustLevel` (sandbox/extended/trusted, §11). Wire contracts in
  `packages/contracts/src/capabilityBroker.ts` (TypeBox: `BrokerCallRequest`,
  `BrokerCallResult`, `BrokerRevokeCommand`, `BrokerWireError`, trust levels,
  deadline/chain limits); `rpc-request`/`rpc-response` bridge messages in
  `pluginRuntime.ts` are now typed to broker envelopes. `KernelErrorCode`
  extended with `TRUST_REQUIRED`, `POLICY_DENIED`, `SERVICE_VERSION_MISMATCH`,
  `SERVICE_CALL_CYCLE` (§41). SES Compartments do not support top-level await,
  so `module-graph-loaded` waits for import-time broker calls to settle
  (bounded, 5 s). Tests: 18 unit (broker core) + 5 real-worker e2e (echo
  round-trip, trust propagation, `CAPABILITY_DENIED`, revoke abort in-flight,
  `SERVICE_CALL_CYCLE`) + broker schema contract tests. Internal
  infrastructure; no user-facing behavior change.

- **Secure plugin module graph loader (Plugin SDK vNext Stage B, prototype).**
  New `apps/plugin-runtime/src/graph/*` (package `@st2/plugin-runtime`):
  `buildModuleGraph` builds a signed pure-JS dependency graph (BFS, SHA-256
  digests, static + dynamic imports via `@endo/module-source` and
  `@babel/parser`, `st2-plugin://` virtual locations, module-count/source-size
  caps, warnings for `require`/`eval`/`Function`/CJS idioms);
  `loadModuleGraph` evaluates the graph in an SES Compartment whose
  `resolveHook`/`importHook` serve only the signed graph
  (`noAggregateLoadErrors`, digest re-verification, `MODULE_NOT_IN_GRAPH` for
  out-of-graph imports, error codes `MODULE_DIGEST_MISMATCH` /
  `MODULE_EVALUATION_FAILED` / `UNSUPPORTED_DEPENDENCY` /
  `UNSUPPORTED_NODE_BUILTIN`). The worker bootstrap gained the
  `load-module-graph` bridge command; graph contracts live in
  `packages/contracts/src/pluginModule.ts` (incl. `toModuleMapManifest`).
  Tests: unit (builder + loader) and real-worker e2e. Internal infrastructure;
  no user-facing behavior change.

- **Event cursor/replay and multi-window background singleton (rev4 §J1/J3).**
  `api.events.subscribe(event, {cursor, signal, maxInFlight})` without a
  callback returns an async iterator (`api.events.stream`) over app events.
  The host retains a bounded ring buffer (128 per event name, 4096 total,
  60 s TTL) and replays events after the cursor — at-least-once recovery
  after a dropped subscription or sandbox restart; every `evt.emit` carries
  a stable `cursor` (`<event>:<seq>`) as the dedupe key, and delivery pauses
  at `maxInFlight` (default 64) until `events.ack` confirms handling
  (backpressure). Cursors outside the retained window are rejected with the
  new `EVENT_CURSOR_EXPIRED` code; fresh subscriptions start live without
  replaying the past. `api.events.on(event, cb)` adds local listeners for
  host-generated envelopes (`window.background.changed`). Background work
  now runs in exactly one window per installation: the host elects a primary
  per window over BroadcastChannel (claims + heartbeats, deterministic
  smallest-windowId leader, 4 s lease expiry, release on `pagehide`),
  exposed as `api.windows.role()` / `api.windows.isBackground()` with role
  transitions pushed as `window.background.changed`; without
  BroadcastChannel the window degrades to `standalone` (its own primary).
  New `plugins/rev4-events` (drop → replay through the cursor) and
  `plugins/rev4-multiwindow` (KV counter owned only by the primary, moves
  on primary death) samples; feature flags `events.cursor` /
  `windows.multiwindow`. Docs: ADR-0025, `docs/plugin-sdk/rev4-api.md`.

- **Sandbox crash isolation (rev4 §M3).** The host detects a dead or hung
  plugin sandbox through two signals: the kernel session port closing
  (`KernelSession.onPeerClose` — renderer-process death or self-navigation,
  detected without any timer) and a heartbeat (`kernel.ping` RPC every 10 s,
  3 s deadline — covers hangs in site-isolated Chromium where the sandbox
  runs in its own process). A detected crash restarts the frame under a
  restart budget (3 restarts inside a 10-minute window); exhausting the
  budget is a crash-loop and disables the plugin server-side
  (`POST /api/v2/plugins/:id/disable`) with no further restarts. Every
  outcome surfaces a host-owned notification (`st2-plugin-crash` →
  `plugins:pluginCrashed` / `pluginCrashedRestart` /
  `pluginCrashLoopDisabled`, en/ru) that survives the crashed frame's
  teardown, and the plugin's own `api.diagnostics.get()` gains an optional
  `crash` field (`count`, `lastAt`, `restartBudgetLeft`). The new
  `plugins/rev4-crash` sample self-navigates its sandbox away
  (`rev4-crash.boom`) and the e2e asserts the restart toast plus the
  re-registered command. Docs: ADR-0024, `docs/plugin-sdk/rev4-api.md`.

- **Host-driven plugin lifecycle hooks (rev4 §J2).** The server announces
  package updates around the atomic directory swap via SSE
  (`plugin.updating` → `plugin.updated` on success, `plugin.rollback` after
  a restore, `plugin.uninstalling` before removal) and the web runtime maps
  them onto best-effort sandbox RPCs: `beforeUpdate`, `afterUpdate`,
  `rollback`, `uninstall`, plus `suspend`/`resume` for every live frame on
  `visibilitychange` (feature flag `lifecycle.hooks`, RPC deadline 1500 ms,
  missing/throwing hooks degrade to `{handled: false}` without blocking the
  host state machine). Frame teardown on update replacement now awaits the
  in-flight hook's settlement before closing the session port, so the hook's
  final writes (KV, blobs, backend) are not cut off mid-flight. New
  `plugins/rev4-lifecycle` sample: suspend/resume state mirrored on
  `<html data-lifecycle-state>`, and a persisted KV hook log observable
  after an update (e2e installs v1 → updates to v2 → asserts the
  `beforeUpdate, afterUpdate` pair survives reload). Docs: ADR-0023,
  `docs/plugin-sdk/rev4-api.md`.

- **Host overlay chrome for `full` overlays (rev4 §G7).** While a plugin's
  `full` overlay is live, the host renders its own browser-chrome-style
  indicator (`data-component="plugin-overlay-chrome"` — plugin name +
  host-controlled close button) on a dedicated layer
  (`--st-layer-plugin-chrome: 300`, above every plugin layer and below host
  modals/permission UI), makes the app background inert, restores focus on
  close, and closes on Escape — including when focus lives inside the
  sandbox iframe (the sandbox relays the key via the new `ui.overlay.escape`
  RPC, which can only close the plugin's own overlay). Chrome ownership is
  tracked per frame instance, so a stale layout flush from a replaced frame
  can never close a newer frame's chrome. `ui.surface.unmount` now also
  disposes the sandbox-side overlay container so host-driven close leaves no
  plugin DOM behind; the overlay hit layer uses the `--st-layer-plugin-overlay`
  token instead of a hardcoded z-index. New canonical theme tokens
  `--st-layer-plugin-overlay` / `--st-layer-plugin-chrome`; i18n
  `plugins:overlayActiveLabel` / `plugins:closeOverlay` (en/ru). The
  `plugins/rev4-overlay` sample gains a `rev4-overlay.full` command (requires
  `ui.commands`) and the e2e asserts the chrome appears with the plugin name
  and disappears after Escape inside the iframe. Docs: ADR-0022,
  `docs/plugin-sdk/rev4-api.md`, `docs/theme-sdk/README.md`.

- **Plugin background jobs: cron schedules, retry lifecycle and a dead-letter
  queue (rev4 stage 5, `api.jobs`).** `jobs.schedule` accepts a 5-field UTC
  cron expression (`minute hour dom month dow`, `*`, ranges, steps, lists —
  parsed by a new dependency-free `apps/server/src/lib/cron.ts`) exclusive
  with `runAt`/`intervalMs`; the job's `nextRunAt` is the first cron match
  and advances on success, surviving server restarts. `retries` (0–20) turns
  on an ack-based lifecycle: the dispatch is held until the plugin reports
  `jobs.ack(jobId, {ok})` — `ok: false` retries with exponential backoff
  (`retryDelayMs` base, default 5 s, doubling, 1 h cap; a missing ack times
  out after 5 minutes as a failed attempt), and exhausting the budget moves
  the job to a DLQ (`status: 'failed'`, `lastError`, `failedAt`) where it is
  never dispatched again until `jobs.retry(jobId)` re-enqueues it; successful
  acks delete one-shots and advance interval/cron schedules. Fire-and-forget
  behavior without `retries` is unchanged. `jobs.list` exposes
  `status`/`attempts`/`maxRetries`/`lastError`/`failedAt`; new REST routes
  `POST /plugins/:id/jobs/:jobId/ack` (idempotent — acks for finished,
  never-dispatched or DLQ jobs are no-ops) and `POST .../jobs/:jobId/retry`;
  new kernel RPCs `jobs.ack`/`jobs.retry` with capability gating. The
  `plugins/rev4-jobs` sample demonstrates a flaky job delivered after two
  retries, a cron schedule listed and cancelled, and a full DLQ roundtrip;
  docs: ADR-0021, `docs/api/README.md`, `docs/plugin-sdk/rev4-api.md`.

- **Overlay hit shapes and the corrected clip model (rev4 §A4/G3, `ui.overlays:3`).**
  `api.overlays.register`/`update` accept `hitShapes` (rect/circle/ellipse/polygon
  in overlay-local pixels, capped by `limits.overlays`: `maxShapes` 32,
  `maxPolygonPoints` 256, `maxGeometryBytes` 16 KiB). `native` overlays render
  the shapes as SVG clip primitives so browser hit-testing follows the same
  geometry; `proxy` overlays point-test them before forwarding packets. The
  clip model now matches the rev4 contract: `native`, `proxy` and `none` rects
  all join the iframe clip union (proxy visuals stay visible; `none` is a
  visible non-interactive layer with an absorbing host hit-div), while one
  `full` overlay unclips the whole iframe — interactivity is decided by the
  hit layer, not the clip. Pointer packets carry `pointerId`, `sequence` and
  `timestamp`; shape updates are rate-limited by
  `overlays.maxUpdatesPerSecond` (`PLUGIN_QUOTA_EXCEEDED`, retryable). The
  `plugins/rev4-overlay` sample demonstrates a circular hit region and the
  `rev4-overlay` e2e asserts shape-gated forwarding.

- **Plugin lifecycle events over SSE (`plugin.installed/activated/disabled/deleted`).**
  The server now emits these on install, install-git, activate, disable and
  uninstall; the SSE relay forwards them and the web client invalidates the
  `['plugins']` cache on each, so every connected client (including other
  tabs) drops plugin sandboxes, overlay hit-divs and registrations
  immediately instead of keeping them until a manual refetch.
- **Chat CAS, server-side drafts and the write outbox (rev4 stage 3).**
  Messages carry a `revision` (bumped per update); `PATCH` accepts an
  `expectedRevision` and answers `MESSAGE_CONFLICT` (409) with the current
  revision instead of silently clobbering concurrent edits, and
  `chat.message.updated` reports the new revision. Streaming writers no
  longer PATCH a committed message row up to 10×/s: plugin drafts stream
  into a server-side `message_drafts` object (`POST/PATCH/commit/DELETE
  /chats/:id/drafts…`) where a monotonic `sequence` makes replayed PATCHes
  idempotent no-ops, `commit` atomically materializes the final message and
  is retry-safe (`alreadyCommitted`), and a server sweep removes stale rows
  (committed >1 h, uncommitted >24 h) — a crashed writer leaves a swept
  draft, never a half-written message. Message creates accept an
  `idempotencyKey` (unique per chat): a retried create returns the original
  message, and `api.chats.append` exposes the key to plugins. The 10 Hz
  flush rate remains an internal host policy. The `plugins/rev4-draft`
  sample demonstrates streaming-commit and key-deduped append; docs:
  ADR-0019, `docs/api/README.md`, `docs/plugin-sdk/rev4-api.md`.
- **Persistent message blocks (rev4 stage 4).** Block attachments —
  including the renderer's serialized state — are durable server data
  (`message_block_attachments`, migration 0019): they survive page reloads
  and render identically in any client. New REST surface: batch
  `GET /chats/:id/blocks?messageIds=`, `POST
  /chats/:id/messages/:messageId/blocks`, `PATCH/DELETE /blocks/:blockId`;
  uninstall and message deletion cascade the rows away. The host kernel
  persists on attach, freezes state to the server only on genuine unmounts
  (overscan/chat switch), and resolves the reload race (attachment arriving
  before the plugin re-registers its renderer) with an in-place retry
  instead of a remount storm. `chat.message.block.changed` (SSE + kernel
  allowlist) keeps other clients' caches in sync. The `rev4-blocks` e2e now
  asserts state restoration across a reload; docs: ADR-0020,
  `docs/api/README.md`, `docs/plugin-sdk/rev4-api.md`.

- **Isolated compute workers (rev4 §C2, `api.workers`).** Sandboxed plugins can
  spawn compute Workers inside their own opaque-origin sandbox
  (`plugins/rev4-worker/` sample): the manifest declares an allowlist of
  self-contained worker entry scripts (`workers: ["workers/double.js",
  "workers/triple.mjs"]`, install-time validated safe relative `.js`/`.mjs`
  paths), and `api.workers.spawn({entry, signal?})` requires the new
  `compute.worker` capability. The host verifies the bundle same-origin
  (≤ `workers.maxBundleBytes` = 2 MiB; `.mjs` additionally ≤
  `workers.maxModuleDataUrlBytes` = 1.5 MiB; MIME `text/javascript`,
  manifest-pinned path) and streams it over a kernel stream; the sandbox
  constructs the Worker in its own realm (`.js` → classic from a blob URL,
  `.mjs` → `{ type: 'module' }` from a base64 data: URL — blob: module
  workers cannot resolve their entry across opaque origins), so the Worker
  inherits the sandbox CSP (`worker-src blob: data:`, `connect-src 'none'`) —
  compute without DOM, direct network, app storage or credentials (data
  authority stays separate: the plugin shuttles data via `postMessage`).
  Handles expose `postMessage(message, transfer?)`, `onMessage`/`onError`
  (unregister), `closed` and `terminate()`. Live workers are capped at
  `limits.workers.maxInstances` (default 2) with the host ledger reconciled
  by sandbox `workers.exited`/`workers.error` reports; session teardown
  (disable/uninstall/navigation) and `compute.worker` revocation terminate
  every live worker. New stable error code `WORKER_SPAWN_FAILED` (retryable).
  v1: self-contained bundles only (classic — no `import`/`export`/
  `importScripts`, module — no `import`), `name`/`memoryBudgetMiB` advisory,
  no SharedWorker/ServiceWorker; backend compute (`compute.backend`) remains
  the fallback for data/network-bound work. Design: ADR-0018; covered by
  kernel unit tests and the rev4 e2e suite (round-trips `doubled 21 -> 42`,
  `tripled 14 -> 42`).
- **Cross-plugin services (rev4 §D, `api.services`).** Sandboxed plugins can
  publish and consume host-mediated RPC: a provider registers service metadata
  with `api.services.provide({name, methods, handle})` (capability
  `services.provide`) and a consumer discovers services, binds a connection
  and calls methods with `api.services.list/connect/invoke/disconnect`
  (capability `services.connect`). Service ids are host-prefixed
  (`<pluginId>.<name>`), so squatting another plugin's id is impossible by
  construction. Every call is routed by the host into the PROVIDER's own
  sandbox session — handlers never cross plugin boundaries as function
  objects and results are JSON-safe. Bounds: 16 services per plugin, 64
  methods per service, 64 connections per consumer, 256 host-wide, payloads
  up to 256 KiB both ways, per-service deadline (default 10 s, capped 60 s).
  Stable error codes for consumers (`SERVICE_NOT_FOUND`,
  `SERVICE_METHOD_NOT_FOUND`, `SERVICE_UNAVAILABLE`, `SERVICE_TIMEOUT`,
  `OPERATION_ABORTED`, `SERVICE_ERROR` with the provider's code in details);
  disabling a provider drops its registry and connections, so stale calls
  degrade gracefully. v1 is web-only (backend plugins are an explicit
  non-goal). Samples: `plugins/rev4-service/` (provider: greet/echo) and
  `plugins/rev4-service-client/` (consumer commands), covered by the rev4 e2e
  suite. Design: ADR-0017.
- **Plugin OAuth connections (rev4 §K5, `api.auth`).** Sandboxed plugins can
  manage host-owned OAuth connections to external services: manifest declares
  public OAuth clients (`authClients`: `clientId`, `authorizationUrl`,
  `tokenUrl`, `scopes` — HTTPS-only with a plain-HTTP loopback exception for
  local IdPs), and the SDK exposes `api.auth.list/get/connect/revoke`. The
  server runs the whole PKCE S256 dance (one-shot `state` + `code_verifier`
  stored per connection); the access token lives only in the new
  `plugin_auth_connections` table (migration 0017) and NEVER reaches the
  sandbox or the UI — authenticated traffic goes through
  `api.network.fetch(url, {connectionId})`, which the server-side proxy signs
  with the stored token. Connection statuses (`pending/connected/expired/
  revoked`), `plugin.auth.connected/revoked/expired` events (SSE + `api.events
  .subscribe`), and revoke wipes the token server-side. v1 does not refresh
  expired tokens automatically. New API: `GET/POST /api/v2/plugins/:id/auth/
  connections|connect|revoke|fetch` and the IdP callback
  `GET /api/v2/plugins/:id/auth/callback` (browser redirect to
  `#/plugin-auth-result`). A host-owned Connections dialog in the Plugins
  panel (`data-component="plugin-auth-manager"`) lists services, scopes and
  statuses without ever exposing token values, and the popup result screen
  (`#/plugin-auth-result`) auto-closes on success. Sample:
  `plugins/rev4-auth/` (mock local IdP, signed-request command), covered by
  the rev4 e2e suite. Requires capability `auth.connections`. Design:
  ADR-0016.
- **Plugin self-diagnostics (rev4 §C).** Sandboxed plugins can read their own
  runtime state: `api.diagnostics.get()` returns a read-only
  `DiagnosticsSnapshot` with protocol/sdk versions, the sandbox `instanceId`,
  registry identity (id, name, version, apiVersion, status, lastErrorCode,
  compatibilityLevel), the active limits, the host feature registry and the
  granted capabilities (capped at 64). The snapshot is built host-side from
  public registry fields only — it never contains secrets, manifests or other
  plugins' state — and requires no capability (the data is the plugin's own,
  like `capabilities.list`). Revoked grants disappear from the next snapshot.
- **Runtime capability grants (rev4 §B2).** Sandboxed plugins can request a
  capability while running: `api.capabilities.request({name, scope?})` shows a
  host-owned consent dialog (one per plugin, 60 s timeout), and an approved
  grant is persisted server-side via
  `POST /api/v2/plugins/:id/capabilities` (idempotent: an already-active grant
  returns as-is without revision churn). Web-side enforcement sees the new
  grant immediately; backend plugin processes pick it up on the next plugin
  activation. Denial, timeout or a busy consent queue reject with
  `CAPABILITY_DENIED` (details.reason `user-denied` / `consent-timeout` /
  `consent-pending`), an unreachable server with `BACKEND_UNAVAILABLE`, and
  unknown names with `VALIDATION_FAILED` / `unknown-capability`. Grants
  survive page reloads. The consent dialog is host-rendered (Radix, portaled
  into `modal.layer`) and exposes `data-component="plugin-consent-dialog"`
  with `data-part="allow"/"deny"` styling hooks.
- **Immediate revocation on the web host.** `plugin.capability.revoked` now
  removes the grant from the live frame grant list (`kernelHasCapability`,
  `capabilities.list`) and from the sandbox `K.grants` at once, so
  enforcement stops without waiting for a plugin-list refetch.
- **Rev4 runtime grant sample.** `plugins/rev4-grant/` demonstrates the full
  consent cycle (request → deny → allow → reload persistence), covered by the
  rev4 e2e suite (deny/allow/persist/immediate re-request).
- **Rev4 kernel events slice (plugin SDK).** Sandboxed plugins can subscribe
  to whitelisted app events over the kernel port:
  `api.events.subscribe(event, listener)` / `api.events.unsubscribe(event,
  listener)` (cleanup returned on subscribe). The allowlist mirrors the SSE
  stream the app already sends to browsers (`BROWSER_APP_EVENTS` plus
  `plugin.capability.revoked`, `plugin.job.due`, `plugin.chat.updated`,
  `plugin.chat.message`); unknown event names fail with `VALIDATION_FAILED`.
  Events carrying chat content (`generation.*`, `chat.message.*`) require the
  `chats.read.current` capability at subscribe time and stop at emit time if
  the grant was revoked (fail-closed). Delivery uses the existing `evt.emit`
  envelope `{event, payload, eventId, cursor?}` with per-listener error
  isolation; subscriptions live in the session scope and are torn down on
  deactivate/uninstall. The rev4-tools sample now subscribes to `chat.opened`
  and the e2e suite verifies end-to-end delivery.
- **Message block overscan.** Blocks attached to chat messages
  (`ui.messageBlock` renderers) are now mounted only while the message is in
  the viewport: leaving the viewport serializes the renderer state
  (`blocks.freeze` → `serialize`) and removes host containers; returning
  remounts and restores (`blocks.unfreeze` → `restore`). The overscan anchor
  is the message element itself, so unmounted blocks never collapse the slot;
  without `IntersectionObserver` blocks stay mounted (previous behavior).
- **Kernel overlay layout deduplication.** `ui.overlay.layout` pushes skip
  geometry-identical rect sets (fingerprint per frame), so layout feedback —
  e.g. block remounts — can no longer ping-pong host↔sandbox at frame rate;
  the revision counter only advances on real geometry changes.
- **Plugin sandbox Permissions-Policy.** The sandbox iframe now carries an
  `allow` attribute denying every sensitive browser feature (`camera 'none'`,
  `microphone 'none'`, `geolocation 'none'`, clipboard, usb/serial/hid/
  bluetooth, local fonts, high-entropy UA data, storage access, credential
  and OTP flows, local-network access, sensors, display capture, fullscreen,
  etc.). Unknown directive names are ignored by browsers, so the deny-list
  stays forward-compatible. Sandboxed frontends can no longer observe
  devices, location, or user data even if the app-level policy broadens.
- **Install plugins from a Git repository link.** The Plugin Manager accepts a
  GitHub/GitLab URL (`POST /api/v2/plugins/install-git`): the server downloads
  the repository archive over HTTPS (no `git` binary), validates it exactly
  like a `.stplugin` ZIP, and installs it with the same atomic replace +
  rollback and consent flow. Only `https://` links on `github.com`/
  `gitlab.com` are accepted; GitLab requires an explicit branch/tag/commit
  ref. The feature can be disabled with `ST2_PLUGIN_GIT_INSTALL=false`.
- **Built-in npm dependency installer for plugins.** When a plugin package
  ships a `package.json` with `dependencies`, the server resolves them from
  the npm registry (no `npm` invocation, install scripts never executed),
  verifies each tarball against the registry `integrity` hash, rejects
  native/executable files, and lays them out in the package's `node_modules`
  (flat hoisting). Backend plugins may then bare-import those modules inside
  their sandbox; the loader still confines resolution to the package root and
  keeps `node:*`/`data:`/`http(s):` blocked. Installed packages are recorded
  in `node_modules/.st2-deps.json` and shown in the Plugin Manager with a
  third-party warning before activation. Authors are strongly encouraged to
  bundle dependencies (esbuild/rollup) instead — on-the-fly resolution targets
  heavy WASM/ML libraries. Config: `ST2_PLUGIN_REGISTRY`,
  `ST2_PLUGIN_DEPS_MAX_PACKAGES`, `ST2_PLUGIN_DEPS_MAX_BYTES`.
- New `@st2/shared` error codes and en/ru localizations:
  `PLUGIN_SOURCE_UNSUPPORTED`, `PLUGIN_SOURCE_INVALID`,
  `PLUGIN_DEPS_UNSUPPORTED`, `PLUGIN_DEPS_CONFLICT`, `PLUGIN_DEPS_FAILED`,
  `PLUGIN_DEPS_FORBIDDEN_FILE`.
- Migration **0015** adds nullable `plugin_registry.source` and
  `plugin_registry.dependencies`; `InstalledPlugin` now exposes optional
  `source` (`zip`/`git`) and `dependencies` provenance.
- **Plugin SDK capability kernel (rev4).** Permissions are now scoped
  capability grants: the manifest requests `{ name, scope }` capabilities,
  the user consents to any subset, and grants persist in
  `plugin_capability_grants` (migration **0016**) with a monotonic revision.
  The same kernel code (`@st2/plugin-sdk` namespace `kernel`) enforces grants
  in the web host and the server capability broker. Sandboxes receive
  `grantedCapabilities`, `supportedFeatures` and `limits` over a single
  transferred `MessagePort` (one-shot nonce bootstrap); feature negotiation
  goes through `api.runtime.supports(feature, version)`. Revocation publishes
  `plugin.capability.revoked` over the SSE whitelist, the web host relays it
  into live kernel sessions, and in-flight operations end with
  `CAPABILITY_REVOKED`. Plugin user state moved out of the registry into
  `plugin_state` (scope `user|workspace|chat|installation`, CAS `revision`
  separate from `schema_version`). New endpoint
  `GET /api/v2/plugins/:id/capabilities` lists active grants. The rev4 kernel
  API surface lands in the sandbox incrementally: `api.storage` (scoped KV with
  CAS revisions + content-addressed blobs), `api.commands`/`api.surfaces`
  (unified registrations), `api.overlays` (`none`/`full`/`native-regions`/
  `proxy-regions` hit policies with normalized pointer packets), `api.chats`
  (scoped handles, message revisions, streaming drafts), `api.blocks`
  (persisted message-block descriptors) and `api.jobs`/`api.network`/
  `api.actions` (background jobs, allowlisted outbound fetch, user-activation
  host actions). Reference samples `plugins/rev4-storage/` and
  `plugins/rev4-overlay/` plus `docs/plugin-sdk/rev4-api.md` and
  `docs/plugin-sdk/examples/rev4-overlay-game.md` document the contract. Docs
  updated (`docs/plugin-sdk/README.md`, `docs/api/README.md`,
  `docs/migrations/README.md`, `docs/data/README.md`,
  [ADR-0014](docs/adr/0014-plugin-capability-kernel.md)).
- New `@st2/gestures` package provides framework-agnostic row gesture
  recognition (context menu on right-click / stationary touch hold, mouse and
  touch drag-and-drop reordering) with configurable travel thresholds,
  long-press delay and per-item drag permission. The host wraps it as
  `useRowGestures` in `@st2/ui`; plugins consume the same core through the
  `@st2/plugin-sdk/gestures` subpath. The Chats panel, the prompt template
  editor and the Backgrounds panel now share this single implementation
  instead of three private copies; the backgrounds panel long-press delay is
  aligned with the rest of the app at 700 ms (was 500 ms). Component, package
  and SDK tests updated; docs updated (`packages/gestures/README.md`,
  `docs/plugin-sdk/README.md`, `docs/architecture/README.md`).
- The sidebar **Backgrounds** panel manages chat wallpapers from the context
  rail: a grid of uploadable backgrounds backed by a new
  `/api/v2/backgrounds` REST surface (list/upload/delete) with content-
  addressed storage in `data/files/backgrounds/` (ST1-imported originals show
  up automatically) and lazily regenerated thumbnails served through the
  existing `/api/v2/assets/thumbnails` route. Uploads are limited to 25 MB,
  validated by MIME and content (`sharp`), and deduped by SHA-256; deletes
  remove the original plus its thumbnail and detach the reference from every
  chat. `PATCH /api/v2/chats/:id` accepts `backgroundId` (or `null`), and the
  chat workspace applies the selection by overriding the Theme SDK token
  `--st-chat-wallpaper-image` via a scoped custom property. Migration 0014
  adds `chats.background_id` (TEXT, nullable, filesystem-authoritative, no
  FK). The `backgrounds` rail item id was added to the Theme SDK
  (`NAVIGATION_RAIL_ITEM_IDS`) and the `backgrounds` i18n namespace covers
  en/ru incl. `FILE_TOO_LARGE` / `FILE_TYPE_NOT_ALLOWED` /
  `FILE_NOT_FOUND` error keys. Component, API, migration and Theme SDK tests
  updated; docs updated (`docs/api/README.md`, `docs/data/README.md`,
  `docs/theme-sdk/README.md`).
- The sidebar **Lorebooks** panel provides full world-info management on the
  context rail: a cursor-paginated book list with global/character scope
  filter, deferred search, and a New Book action; per-book editing (rename,
  debounced description, character linking via `characterId`, soft delete)
  and an entries tab with add/edit/delete dialogs, primary/secondary keys,
  content, `position`, and `constant`/`selective`/`enabled` toggles backed by
  the existing `/api/v2/lorebooks` REST surface (`LorebookListQuery` hooks in
  `useLorebooks`/`useLorebookEntries`, mutation hooks with cache
  invalidation). The Character Management panel's Advanced tab links books to
  a character and offers "new book for character" + unlink shortcuts. The
  `lorebooks` rail item id was added to the Theme SDK
  (`NAVIGATION_RAIL_ITEM_IDS`, all bundled themes, starter theme) and the
  `lorebooks` i18n namespace covers en/ru incl. `LOREBOOK_NOT_FOUND` /
  `LORE_ENTRY_NOT_FOUND` error keys. Component tests, Theme SDK tests and
  docs updated (`docs/ux/README.md`, `docs/api/README.md`,
  `docs/theme-sdk/README.md`).
- The sidebar **Chats** panel manages conversations from the context rail:
  a cursor-paginated chat list automatically scoped to the current
  conversation's character or the pinned Home character, without a character
  picker; deferred search over chat
  titles/summaries and message content via `chats_fts` / `messages_fts`; a
  New Chat action above the list creating a chat for the current/pinned
  character and returning to `/home`. Each row's context menu provides open,
  rename, export
  (`GET /api/v2/chats/:id/export`), move up/down and delete (soft-delete into
  the trash, confirmed in a dialog). Reordering via context-menu commands or
  whole-row mouse/touch drag-and-drop persists optimistically through
  `PUT /api/v2/chats/order` and is only enabled in a single-character,
  non-search list where ordering is meaningful. A stationary touch hold opens
  the context menu, while movement starts reordering; portalled menus render
  above the full-screen phone sidebar. Migration 0013 adds
  `chats.sort_order` with a `chats_character_sort_idx
  (character_id, sort_order, updated_at, id)` index; new chats default to 0
  and surface on top via the existing `updated_at DESC` tie-break, so no
  backfill is needed. Component, i18n and API docs updated
  (`docs/ux/README.md`, `docs/api/README.md`, `docs/data/README.md`,
  `docs/migrations/README.md`).
- The character catalog supports an expanded sort vocabulary: `name` (A–Z),
  `name-desc` (Z–A), `newest`, `oldest`, `favorites`, `used` (recently used,
  never-used last), `chats-most` / `chats-least`, `tokens-most` /
  `tokens-least`, `random` (a single shuffled page with no cursor), and
  `relevance`. Deprecated aliases `recent` → `newest`, `created` → `oldest`,
  `usage` → `used` stay accepted. Migration 0012 adds `favorite`, `chat_count`
  and `token_count` columns to `characters` (backfilled and kept in sync by
  SQL triggers on `chats` / `messages`; trash is excluded; `token_count` is a
  content-length proxy in characters, not real tokens). `favorite` mirrors
  `ext.favorite` / `ext.legacy.favorite` so "favorites first" is indexable
  while `ext` stays the source of truth (API contract unchanged). New
  `(favorite|chat_count|token_count DESC, name, id)` indexes keep a 100k
  catalog within the 300 ms first-page target. The browser select exposes all
  options with localized labels (`characters:sort_*`); `random` returns a
  fresh page on each load (`staleTime: 0`). Repository integration tests cover
  ordering, tie-breaks, cursor pagination, legacy aliases, and trash
  exclusion; the migration test covers backfill + trigger behavior
  (`packages/db/test/charactersSorting.test.ts`).
- Character search (`GET /api/v2/characters?q=`) supports a query syntax:
  free text, exact phrases in quotes, `tag:` / `-tag:` / `author:` /
  `-author:` / `name:` / `-name:` filters, and full-text column filters
  `desc:` / `persona:` / `scenario:`. Queries with positive terms are
  evaluated through the FTS5 index with bm25 relevance ranking regardless of
  the requested `sort`; negative-only or degraded queries fall back to SQL
  filters. Migration 0011 adds a `tags` column to `characters_fts`
  (backfilled, kept in sync by triggers on `character_tags` and recreated
  `characters` triggers, included in the diagnostics rebuild), so free text
  also finds characters by tag name. `tag:` / `-tag:` match by tag-name
  prefix (case-insensitive, `tag:sf` finds `sfw`); the legacy `tag` query
  param stays an exact match. Parser unit tests and repository integration
  tests cover the grammar, ranking, cursors, and soft-deleted rows
  (`packages/db/src/repositories/characterQuery.ts`,
  `packages/db/test/characterQuery.test.ts`,
  `packages/db/test/charactersSearch.test.ts`).
- The distribution now ships a curated set of bundled themes (AMOLED, GitHub
  Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night, Catppuccin Mocha,
  Solarized Dark, One Dark). On first boot `seedBundledThemes` copies each
  package from `apps/server/assets/themes/` into `data/themes/<id>/` and
  registers it in `theme_registry`, so the Themes manager opens with real
  themes instead of an empty list. An `app_meta` marker tracks installed ids:
  themes added in a later release appear on update, user-deleted ones are not
  re-created, and no theme is activated automatically — the built-in light/dark
  tokens remain the safe-mode/reset fallback. Previews are generated
  deterministically by `pnpm theme:previews`.
- Connection profiles are now available through typed CRUD/apply endpoints on the
  server. The AI Settings **API** tab is the supported UI for saving and
  activating provider connection profiles; the separate Profiles tab has been
  removed.
- `GenerationRequest.assistantPrefill`, profile stop-string merging, and the
  Provider SDK prefill capability. Built-in chat and text adapters serialize
  supported prefills.
- Multi-surface sandbox composition: one clipped iframe per plugin, isolated
  roots per registration, batched layout updates, and selective cleanup.
- Shared responsive action contract in `@st2/ui`: `ActionBar` /
  `ActionBarGroup`, structured Button `icon`/`label` parts, and Tabs
  layout/overflow strategies. Theme SDK documents the stable hooks and ships
  an editable, deterministically generated three-file starter kit.
- Theme tokens `shell-panel-min-width` and `shell-panel-max-width` now bound
  resizable context panels without hardcoded runtime limits.
- Theme SDK navigation composition through
  `shellLayout.navigationRail.main/bottom`: themes can reorder core rail
  actions and place or omit `menu-toggle`. Collapsing keeps only the rail root
  and its single configured toggle mounted, removes other items from
  DOM/layout/paint, closes and unmounts `panel.left` with its content, and
  reuses that toggle to restore the rail. The built-in layout now places the
  toggle first; the same control remains the first rail item and is aligned with
  `chat.header` on desktop and mobile without creating a duplicate. The mobile
  rail remains a full-height shell block above the header
  layer: opening it reserves rail width and shifts the main canvas while the
  toggle stays in the rail's top cell. The regular navigation group now starts
  after that toggle and its structural divider (`chats` is first by default),
  rather than attaching the divider to a specific destination. On every viewport
  this compact rail-only divider shares the exact vertical boundary and color of
  `chat.header`; the mobile header divider uses the same non-zero inset on both
  inline edges as the rail, keeping both segments compact instead of extending
  the header line to the viewport edge. When the rail is collapsed, its toggle
  no longer paints that divider over the header line. Theme-defined
  `main`/`bottom` ordering is now preserved on mobile instead of being
  overridden by the host.

- Server theme contract tests (`apps/server/test/api.test.ts`,
  `describe('themes')`): rejected malformed archives (non-ZIP 400, missing or
  broken manifest, traversal asset paths, forbidden CSS — remote `url()`,
  `behavior:url(#default#VML)`, `javascript:` URLs, `!important`), inheritance
  cycles and missing parents, asset serving (`FILE_NOT_FOUND` 404,
  `FILE_TYPE_NOT_ALLOWED` 415) and per-theme settings lifecycle
  (defaults, validated patches, cleanup on theme delete).
- E2E theme contract suite (`e2e/theme-contract.spec.ts`): localized install
  errors in the UI, traversal-entry archives, persisted theme settings emitted
  as CSS variables after a reload, and deleting the active theme clears its
  document overrides. Shared helpers moved to `e2e/helpers.ts`
  (`zipBuffer`, `postJson`, `expectNoA11yViolations`).
- Visual snapshot with an active installed theme
  (`e2e/visual.spec.ts` → `home-installed-theme.png`).
- Per-theme settings endpoints documented in `docs/api/README.md`
  (`GET/PATCH /api/v2/themes/:id/settings`).
- New canonical theme tokens: typography (`font-size-2xs`, `font-weight-*`),
  `radius-panel`, control geometry (`control-height-sm/xs/2xs`, `switch-*`,
  `menu-min-width`, `dialog-max-width/max-height`, `textarea-min-height`,
  `spinner-size`) and the chat column width (`size-chat-column-max`). All
  literal usages in the built-in CSS were migrated to these tokens with
  pixel-identical values.
- Theme SDK now ships a breakpoint registry
  (`packages/theme-sdk/src/breakpoints.ts`): `VIEWPORT_BREAKPOINTS`
  (`480…1080px`) and `CONTAINER_BREAKPOINTS` (`20…44rem`). Container queries
  must use rem; the single px container query (`560px`) was migrated to
  `35rem`.
- A style-contract test suite (`packages/theme-sdk/test/style-contract.test.ts`)
  fails the build when built-in CSS uses numeric `font-weight`, px `font-size`,
  numeric `z-index`, raw px `border-radius`, control-size literals
  (`32/36/40/44/52px`), unregistered viewport/container breakpoints, or
  `!important` outside the a11y override stylesheet.
- A theme-starter contract test
  (`packages/theme-sdk/test/theme-starter.test.ts`) verifies the shipped
  `theme-starter.zip` parses as ZIP, passes `validateThemeManifest`, references
  existing assets, and only uses known tokens and documented hooks.
- Shell slot registry aligned with ADR-0011: `character.browser` added on the
  Characters page, the inner chat canvas is `data-part="canvas"` (the outer
  `<main>` keeps `data-slot="chat.viewport"`), and the docs now list exactly
  the implemented slots (`navigation.secondary` / `panel.right` are not part
  of v1).
- ADR-0011 «Shell layout v1» documents slots as stable skin-targets, content
  geometry as an explicit exception, and the breakpoint/style contract;
  ADR-0006 references it for the shell rearrangement limitation.
- Tab lists are unified across system surfaces: Personas, Characters, AI
  Settings and plugin panels/character tabs all use the shared segment
  variant instead of per-panel underline/grid reimplementations. The `Tabs`
  root is now a flex column with a documented `order` contract on
  `[data-component="tabs-list"]`: inside the sidebar panel the tab list moves
  to the bottom at the ≤600px overlay breakpoint (mobile tab bar), and themes
  can override the placement declaratively through the `theme` layer
  (docs/theme-sdk/README.md, ADR-0011 component-level placement).

### Fixed

- **Segment tabs now animate a sliding active indicator (`@st2/ui` `Tabs`,
  `variant="segment"`).** AI Settings, Personas, Characters, Settings and
  plugin panels share the same segment control; switching Config / API /
  Advanced slides the highlight via CSS custom properties instead of measuring
  DOM nodes (Radix unmounts inactive tab panels, which previously reset the
  indicator through `ResizeObserver`).

- **Kernel byte streams no longer truncate when the producer ends before the
  consumer's initial credit arrives (`packages/plugin-sdk/src/kernel/session.ts`,
  `apps/server/src/plugin/sandboxRev4.ts`).** `openOutboundStream(...).end()`
  sent `stream.end` immediately and dropped the outbound state; the consumer's
  `stream.credit` (one macrotask after `stream.open`) then found no producer,
  so queued chunks were never pumped and the peer read 0 bytes. `end()` now
  defers the `stream.end` envelope until the queue drains. This race was the
  true cause of the 2026 "Chromium kills blob:/data: module workers" finding:
  worker bundles arrived empty and module workers die silently on empty
  source. With the fix, `.mjs` worker entries are enabled, the
  `plugins/rev4-worker` sample gains `workers/triple.mjs`, and spike 6 pins
  the positive module-worker capability (ADR-0018). The sandbox CSP
  `script-src` now includes `blob:` (module workers load their entry through
  script-src; `connect-src 'none'` is unchanged), and spike 8 pins module
  workers under the production CSP.
- **rev4 sample plugins and e2e suite (`plugins/rev4-tools`, `plugins/rev4-blocks`,
  `plugins/rev4-agent`, `e2e/rev4-samples.spec.ts`).** The kernel command
  registrations pass `{ kernel: true }` so toolbar buttons invoke runners over
  the kernel port instead of the legacy v2 postMessage path; `ui.notifications`
  is the host feature name checked by `runtime.supports` (the capability grant
  remains `notifications.show`); capability presence is probed with
  `api.capabilities.granted(name)` rather than `supports(feature)`;
  `chats.listMessages({})` without an explicit `chatId` targets the current
  chat under `chats.read.current` (an explicit foreign `chatId` requires
  `chats.read.all`), and message pages are newest-first so `items[0]` is the
  last message. Message-block content lives in the sandbox iframe container
  (`data-st2-registration="blk:..."`) anchored by the host slot
  (`data-part="plugin-block"`) in the message DOM. The server dispatcher now
  passes plain JSON worker responses through untouched and only normalizes
  responses that actually carry the `PluginResponse` envelope. All three
  samples pass the full user cycle (install → consent → activate → toolbar).
- Sidebar panels now stay mounted and non-interactive through their token-driven
  exit animation, then unmount on `animationend`; rapid reopen no longer loses
  the panel DOM or produces an abrupt close.
- Character Management header now switches between a neutral eye action for
  read-only preview and a neutral pencil action for editing. The unrelated
  full-library shortcut, duplicate editor preview action and viewer action bar
  were removed.
- Full-height Personas and Characters tabs now start at the inset top of their
  shared menu ScrollArea and scroll away with its content on desktop. Theme SDK
  exposes the inherited `shellLayout.managementTabs.pinned` switch (`false` by
  default); themes can set `true` for sticky behavior. The existing bottom
  placement and safe-area inset remain unchanged on mobile.
- Navigation-panel headers no longer add the redundant `Workspace` eyebrow.
  Their shared chrome now uses one `--st-control-height-large` row on desktop
  and mobile, with the top safe area owned by that row instead of an extra
  outer panel inset. The header now sits one stacking step above panel content,
  while its separator is painted as a dedicated overlay in the original
  `--st-color-border`. Scrolling content and floating controls can no longer
  cover the line without changing its established color.
- Persona Management and Character Management now use the same inset content
  frame as AI Settings. Their segmented tabs now float as a translucent cloud
  above the full-height ScrollArea, so the surrounding inset is genuinely
  transparent and scrolled content can pass behind it. A dedicated scrolling
  spacer keeps controls reachable without adding padding to the Radix wrapper
  or shrinking full-bleed viewers; desktop-top and mobile-bottom placements
  are covered by geometry, axe and visual regressions. The base cloud no
  longer casts a shadow, and mobile panels ignore stale desktop resize widths
  so they fill the viewport from the navigation rail to the opposite edge.
  Mobile shell padding no longer doubles the top/bottom gaps: safe areas are
  owned by the header, scroll body, and floating cloud instead.
- Text actions such as Character Management `New` / `Import`, dialog footers,
  settings maintenance controls, plugin/theme actions and plugin toolbar items
  no longer squeeze, lose icons or overlap at narrow panel widths. Compact
  toolbars measure their natural content width against their own available
  space, use hysteresis, keep icon actions horizontal and visually hide only
  their labels; no viewport threshold is involved. Forms retain
  wrapping/stacking. Character tabs use local overflow, panel resizing uses
  logical RTL-aware geometry, and the 320 px state is covered by behavioural,
  accessibility and visual tests.
- Sidebar resizing now clamps the stored runtime width to Theme SDK min/max
  tokens, and the visible panel and shifted chat use the same effective width.
  Dragging past a limit no longer moves the chat behind a stationary panel;
  the resize handle is also keyboard-operable in LTR and RTL.

- Default theme message colors now meet WCAG 2.2 AA (4.5:1) on the chat
  surface: light-mode `color-message-quote`/`color-message-emphasis` darkened,
  dark-mode `color-message-quote` brightened; mirrored in
  `packages/ui/src/styles/tokens.css` and `@st2/theme-sdk` default tokens.
- E2E `flows.spec.ts` expected the untranslated `Context Usage` instead of the
  i18n `chat:contextUsage` string.
- E2E `release.spec.ts` AI-settings flow was order-dependent: it reused the
  plugin connection profile left behind by the prompt-order test. The profile
  is now reset to the built-in one before editing.
- The SillyTavern archive migration test no longer leaves the default persona
  behind, which polluted the `assembled N message(s)` audit in later
  generation tests.
- Theme token contract is now single-source and verified: undefined tokens
  `--st-font-size-xs`, `--st-space-2xs`, `--st-radius-pill` and
  `--st-shadow-panel` used by components are resolved. `font-size-xs` and
  `space-2xs` joined the canonical `TOKEN_NAMES`; `radius-pill` usages were
  replaced with `radius-round` and `shadow-panel` with `shadow-overlay`.
  Panel/content sizes and scrollbar tokens (`size-*`, `scrollbar-*`) became
  theme-overridable instead of CSS-only. A contract test
  (`packages/theme-sdk/test/token-contract.test.ts`) fails the build when a
  `var(--st-*)` in the UI source is not a canonical token or when
  `packages/ui/src/styles/tokens.css` drifts from the SDK defaults.

- All app CSS modules (`apps/web/src/**/*.module.css`) now declare
  `@layer components`, matching the required stack
  `reset, tokens, base, components, plugin-base, theme, user`. Previously
  unlayered module CSS outranked every cascade layer, so theme `skin` CSS could
  not override component styles; now the `theme` layer wins over components at
  equal specificity.

- `packages/shared` macro test asserted a stale weekday (`Thursday` for
  `2026-07-31`, which is a Friday); the assertion now matches the resolved
  date.

- Chat and home greeting messages now expand `{{user}}`, `{{char}}`, time/date,
  `{{random:…}}`, and settings `macroVariables` for display and in-chat search
  while keeping the raw authored text in storage. Legacy `substituteMacros`
  uses the same resolver as the prompt pipeline (active persona + character
  names). Macro helpers live in `@st2/shared` for backend and frontend parity.

- Personas are fully manageable from the sidebar panel: create, rename,
  duplicate, delete, description editing, active/default selection, and a
  per-chat persona override in the chat header. New chats inherit the active
  persona; generation falls back to the default persona when none is selected.

- Home and live chat composers no longer drift: Send/Stop, the utility row
  (settings shortcut, scroll-to-latest, reset), empty-state heading level,
  submit-error placement under the composer, and context-trigger loading
  chrome are owned by the shared `ChatComposer` / `ChatWorkspace` surface.
  Scroll-to-latest uses its own label instead of reusing «Load older
  messages».

- Home and chat now use one shared context-usage panel instead of separate
  implementations. Home runs a side-effect-free preview through the current
  character card, persona, lorebook, prompt-template, tokenizer, and
  context-shifting pipeline; an existing chat reads its latest prompt audit.
  Placeholder character/world-info counts were removed, and only included
  prompt entries contribute to the displayed categories. Home preloads the
  preview while the panel is closed and keeps the latest real breakdown and
  tokenizer label visible while a 500 ms debounced draft update is
  recalculated.

- The pinned character's authored greeting now renders as the first assistant
  message with character identity on the chat-first home screen instead of
  appearing as centered empty-state copy. Its header is reduced to character
  identity and an inline search that highlights matches in the current
  conversation.

- Home composer no longer shows persistent provider and keyboard-hint copy
  beneath the message field; the disabled Send action remains the clear state
  indicator.
- Pressing Escape over an open dropdown menu no longer closes the sidebar
  panel underneath: the sidebar's global Escape handler now listens in the
  capture phase (React synchronously unmounts dialogs/menus before the
  bubbling phase) and ignores the key while a `[role="dialog"]` or
  `[role="menu"]` element exists.
- The prompt template editor no longer wipes in-progress edits: hydration
  from refetched settings is skipped while a block dialog is open, when the
  incoming state only echoes a save this client already sent, or when it is
  not newer than the last hydration (e.g. a failed refetch left a stale
  snapshot behind).
- The character card export menu now renders real links: `DropdownMenuItem`
  supports `asChild`, and the export actions are `<a href>` anchors so the
  menu stays keyboard-focusable and openable in new tabs/background tabs.
- E2E: the visual suite waits for thumbnail images to finish loading before
  screenshots (thumbnails are generated lazily in a fresh data directory per
  run); the home light/dark, installed-theme and pseudo-mobile-RTL goldens
  were regenerated. The export-menu assertions target the portalled menu at
  page level (`role="menu"` + `href`), and the release flow switches to Chat
  Template explicitly so it no longer depends on the shared server's
  persisted prompt mode.

### Changed

- **Plugin kernel protocol version normalized to strict semver (rev4 §A4).**
  The kernel advertises `protocolVersion: '2.0.0'` everywhere (host
  handshake, sandbox `api.runtime`, diagnostics snapshot) so the value
  parses with the SDK's own strict `x.y.z` version negotiation; the
  authoring contract now also types `api.events.subscribe/unsubscribe`.
- Context usage panel (`ContextUsagePanel`) is transparent inside the glass
  composer shell; metric/icon chips use light tints instead of opaque surfaces.
- The bundled AMOLED theme (`1.1.8`) keeps context usage on the composer glass
  layer (transparent panel, tinted metric/icon chips) instead of a second opaque
  shell.
- The bundled AMOLED theme (`1.1.7`) drops all shell layout overrides (legacy
  `chat-panel > chat.composer` grid overlay, `composer-sticky` hacks, and
  `::after` gap fills). Composer geometry is host-only like Nord/Dracula;
  AMOLED `components.css` supplies glass skin (elevated 92% shell, transparent
  inner parts, glass context-usage panel).
- The bundled AMOLED theme (`1.1.6`) restores translucent glass on the composer
  and context-usage panel: one elevated outer shell with transparent inner
  parts (pure `#000` token stacks otherwise read as a solid block), and a
  `composer-sticky::after` fill for the sticky bottom inset only — host geometry
  unchanged.
- The bundled AMOLED theme (`1.1.5`) uses the same host composer contract as every
  other bundled theme (sticky `composer-sticky`, shared glass layers, markdown
  column width). AMOLED no longer overrides composer inset, panel padding, or
  inner toolbar/field transparency; only an opaque `chat-panel` canvas prevents
  wallpaper bleed in the sticky offset on pure black.
- Shared chat shell: sticky glass composer inside the scroll viewport (no
  `ResizeObserver`), single `backdrop-filter` layer on `.composer`, light inner
  tints (≤12%), scrollbar gutter via `margin-inline-end` on the composer wrap.
- The Settings menu is now a tabbed sidebar panel (role="tablist", shared
  segment variant) with **General / Themes / Data** tabs instead of links into
  separate pages. The Themes tab lists built-in and installed themes with
  apply/reset actions and installs packages directly; the System/Light/Dark
  mode selector was removed everywhere. The Data tab hosts SillyTavern
  migration and backups (create/refresh/restore). The full `/settings` page
  is gone — deep links to it fall through to `/home`; the onboarding
  "Import existing data" card was removed, and `themes:openManager` keeps the
  full theme manager (safe mode, delete, starter kit) reachable from the
  Themes tab.
- The General settings tab no longer shows the Conversation defaults section
  or the Workspace density control. Existing stored preferences and API
  contracts remain unchanged.
- The Themes tab now uses a responsive dropdown for switching between the
  built-in interface and installed themes instead of a long card list.
- Successful theme selection in Settings no longer shows a transient
  `Applied ...` notice; actionable errors remain visible.
- The local Vite API proxy no longer forwards the browser `Origin` to Fastify,
  so a fallback dev-server port does not cause a CORS failure; remote mode
  keeps exact Origin validation.
- The bundled AMOLED theme now uses translucent "glass" surfaces throughout:
  dialogs, menus, comboboxes, cards, text fields, the sidebar panel, nav rail
  and panel headers render at ~70% opacity with `backdrop-filter` blur, and the
  chat wallpaper overlay is lightened (`rgba(0,0,0,0.5)`), so a wallpaper shows
  through the whole interface instead of flat opaque black. The chat composer
  keeps its field and textarea transparent inside one translucent outer surface,
  overlaps the bottom of the message viewport, and reserves enough scroll space
  to reveal the final message above it. This prevents nested black backgrounds
  from appearing opaque. Theme CSS URLs now include an install-version
  cache-buster, so replacing a package with the same id applies its new styles
  without a stale browser cache. The collapsed navigation rail no longer
  paints its glass background over the first 60 px of the chat or composer.
  Toolbar, context details, metric cells, field and textarea now share the
  composer's single outer glass surface instead of stacking translucent or
  opaque black backgrounds (theme `1.1.2`).

### Added

- Chat messages render sanitized Markdown with SillyTavern 1 roleplay defaults:
  `"..."` dialogue quotes, `*emphasis*`, `**strong**`, and `` `code` ``.
  Quote / emphasis / code colors are theme tokens (`color-message-quote`,
  `color-message-emphasis`, `color-message-code`, `color-message-code-bg`) with
  stable `data-part` hooks; streaming replies use the same renderer.

- Home and live chats keep readable side padding in the message viewport, and
  authored greetings with alternates can be switched with a `‹ N/M ›` pager or
  horizontal swipe. `POST /chats` accepts `greetingIndex` and stores
  `{ greeting, swipes, swipeId }` on the first assistant message.

- Prompt Template now uses an ST1-style Prompt Manager instead of stacked
  include cards: a dense Name/Tokens list, stable mouse/touch drag ordering,
  source/type markers, an enable control before each name, custom prompt
  creation, and a full modal editor for name, role, triggers, relative/in-chat
  position, depth/order, override protection, and prompt text. Draft changes
  autosave without footer actions, while row and total token counts use the
  latest prompt audit when available. `Chat History` and
  `Post-History Instructions` are fixed as the final two blocks. Custom entries
  persist in settings and presets and are applied by the server pipeline,
  including macro expansion, generation-trigger filtering, and in-chat
  insertion.

- Character Management: Edit now includes a complete read-only card viewer.
  Creator's notes render Markdown and sanitized HTML/CSS together in the card's
  central, auto-sized sandboxed preview. Its permanent identity header exposes
  the original avatar across the panel width and
  well-spaced tags, while Description and Greetings
  stay collapsed until opened; each greeting is separately collapsed. Creator
  documents are sized to their content, leaving one panel scrollbar. The viewer
  exposes only a return-to-edit control and cannot change character data. Selecting,
  importing, creating, or duplicating a character opens this viewer first.

- Character Management now follows the SillyTavern workflow in one sidebar
  surface: Cards, Edit, Advanced, and Gallery. It supports real create/import,
  pin/select, search/sort, list/grid, avatar upload, favorite metadata,
  compact alternate greetings, chip-based tags, explicit PNG/JSON export,
  duplication, prompt overrides, creator metadata, Character's Note
  depth/role, talkativeness, dialogue examples, thumbnail previews that open
  local full-resolution originals, and manually selected 1–4 column gallery
  layouts. Edit/Advanced share one header save action instead of duplicating a
  sticky Delete/Save footer.
  Character galleries use the existing attachment store for content-addressed
  upload/list/delete and primary-avatar selection without a schema migration.
- Search: tag filter for character scope, date/name sorting, dedicated FTS5
  index over lorebooks (books themselves are searchable, not only entries),
  transactional index rebuild, and `last_used_at` usage tracking with a
  `usage` catalog sort; `relevance` sorting is now FTS-rank driven.
- Data: chat trash restore/purge (`POST /chats/:id/restore`,
  `DELETE /chats/:id?purge=true`), character version history snapshots on
  every edit with list/restore endpoints, `GET /personas/:id`, typed
  `CHAT_BRANCH_NOT_FOUND` for unknown branches, and a pre-migration backup in
  the standalone `pnpm db:migrate` runner.
- Memory/RAG: `memories` store (migration 0006) with keyword retrieval wired
  into the prompt pipeline as the Memory stage, plus `/api/v2/memories` CRUD.
- Providers: HTTP status differentiation (`UNAUTHORIZED`, `RATE_LIMITED`,
  `MODEL_NOT_FOUND`), no raw upstream error bodies on the wire, streaming
  token usage (`stream_options.include_usage`), `contextLimit` in model
  listings, exact offline tokenizers in adapter `countTokens`, provider
  diagnostics logging, and `validateConfig` enforced on create/update/
  generate. Multimodal foundation per ТЗ §4.3: speech/image/transcription
  contracts, optional adapter methods with capability declaration, offline
  echo implementations, `/api/v2/providers/:id/{speech,images,transcribe}`
  routes and plugin-worker forwarding.
- Provider setup now uses a persisted source catalog, write-only credentials,
  connection tests/model discovery, capability-driven samplers, and a native
  Anthropic Messages adapter with prompt caching. The inline AI settings no
  longer use demo providers, keys, models, statuses, or preset actions.
- Provider secrets manager (SillyTavern-style): each provider now stores
  multiple labelled API keys with exactly one active. New `provider_secrets`
  table (migration 0009) and `/api/v2/providers/:id/secrets` CRUD plus a gated
  `/reveal` endpoint and `/api/v2/secrets/exposure`. Secret values stay
  write-only (masked in lists); reveal requires the server flag
  `ST2_ALLOW_SECRETS_EXPOSURE` (default off). The provider editor's key field
  now opens a multi-key manager (add / make active / rename / copy / delete).
- API tab redesign (SillyTavern-style): the provider editor adds a Prompt
  Post-Processing mode select, an Additional Parameters dialog (include body /
  exclude body / include headers, authored as JSON and validated client- and
  server-side), a "View hidden API keys" affordance, a `/v1` base-URL hint for
  custom sources, and an "Auto-connect to Last Server" toggle. Connecting now
  persists `settings.lastServer`; on launch `AutoConnectSync` restores and
  re-validates the last connection when `settings.autoConnect` is enabled.
  Additional parameters deliberately use structured JSON instead of ST1's YAML
  (see ADR-0008); forbidden headers (`Authorization`, `Content-Type`,
  `Content-Length`) cannot be overridden.
- API Settings: the inline API tab now keeps its connection-profile selector
  visible, provides an explicit available-models selector after `/v1/models`
  discovery, and gives API-key management a saved-key selector plus one
  dedicated manager control. Removed the redundant enabled switch, test
  message, save, additional-parameters, and send-test actions; connecting is
  now the sole bottom action.
- API tab parity (SillyTavern `main_api`): the provider editor now leads with a
  top-level **API** selector — Chat Completions vs Text Completions — derived
  from each catalog entry's `adapterKind`; the **Source** ("API Type") list is
  filtered to the selected API and resets to its first source on switch. The
  connection no longer needs a manual **Name**: the chosen source is the
  identity (SillyTavern-style), so a key saves immediately; the panel hides the
  Name field when a source is set, and the full profile editor keeps it as an
  optional override. The secrets manager dialog gains a quick **Active key**
  selector in its header for switching the active key without scrolling the
  list.
- Provider backends (SillyTavern parity): four new generation adapters behind
  the unified `ProviderAdapter` contract — a generic OpenAI-compatible
  **Text Completion** adapter (`/v1/completions`, prompt serialized as text)
  with `ooba` / `koboldcpp` / `vLLM` / `Ollama` source presets, plus
  **NovelAI**, **AI Horde** (async submit-and-poll queue, anonymous or keyed),
  and **KoboldAI Classic** (`/api/v1/generate`). The source catalog, provider
  kinds, and `adapterKind` union are widened accordingly. Text adapters
  consume the rendered instruct prompt (see prompt-pipeline `serializeAsText`),
  never a chat-message array; NovelAI/Horde/Kobold are plain-`fetch`
  integrations marked experimental where the upstream API is not formally
  stable, and are covered by mocked transport tests.
- Prompt pipeline (SillyTavern parity): the Prompt Post-Processing select now
  takes effect server-side. A port of SillyTavern's `mergeMessages` reshapes
  chat-mode messages right before provider serialization (`merge` / `semi` /
  `strict` / `single` and their `_tools` variants); text adapters skip the stage
  because instruct rendering already collapses roles into one prompt. The
  Additional Parameters (`customIncludeBody` / `customExcludeBody` /
  `customIncludeHeaders`) are now applied on the wire by the `openai-compatible`
  and `text-completion` adapters — merging and excluding request-body keys and
  adding extra headers, while the forbidden headers (`Authorization`,
  `Content-Type`, `Content-Length`) can never be overridden.
- Pipeline: time/date/weekday/random macros and settings-driven custom
  variables; selectable built-in instruct formats
  (`settings.instructFormatId` + `GET /settings/instruct-formats`);
  `AbortSignal` honored across assembly and hooks; context strategies run
  with a timeout and fall back to truncation; interceptor journal records
  prompt diffs; plugin provider streaming is bounded by an idle deadline
  instead of a fixed 30s RPC timeout.
- Prompt templates: Advanced settings can switch between Chat and Text modes,
  reorder/enable validated prompt blocks, edit post-history instructions, and
  import/export persisted prompt-template and generation presets. Each
  generation now persists the latest bounded per-chat context audit, exposed
  in the chat usage inspector with exact provider messages, exclusions,
  tokenizer budget, diagnostics, and terminal status.
- Events: `GET /api/v2/events` SSE channel delivering whitelisted app events
  to browsers for cache invalidation and multi-tab sync.
- Plugin SDK: partial consent (any subset of requested permissions; legacy
  entrypoints still require `legacy.trusted`), `chat.read` enforced on
  backend event subscriptions, declared interceptor `timeoutMs` honored,
  i18n bundles and notifications removed on deactivation, sandbox lifecycle
  errors surfaced, and backend app events (chat/generation lifecycle,
  language changes) delivered to frontend plugins.
- Theme SDK: persisted per-theme settings emitted as manifest-declared CSS
  custom properties (`GET/PATCH /themes/:id/settings`), theme translation
  resources (`locales` in theme.json) registered under `theme.<id>`.
- Legacy compatibility: extended `getContext()` (chat history, macros,
  token counting, `generate`, `power_user` subset, real request headers with
  CSRF), slash-command and prompt-interceptor bridges, more `event_types`,
  legacy i18n resources, version cache-busting on update, and Express host
  support for `res.write`/`res.end` streaming handlers.
- SillyTavern import (ТЗ §16): groups with group-chat transcripts,
  backgrounds, extension settings (into the legacy settings store),
  OpenAI-compatible API settings as disabled providers, UI extensions as
  consent-gated legacy plugin packages, and themes/custom CSS preservation.
- Backups: `DELETE /api/v2/backups/:id`.
- Logging: redacted structured log file under `data/logs/server.log` with
  startup rotation, alongside console output.
- i18n: Russian CLDR plural forms (one/few/many), missing-key logging in dev,
  a real ru↔en key-parity test and a pseudo-locale long-string test.
- Tests: corrupted character-card suite (all six rejection paths), contracts
  schema suite, and a ТЗ §18 performance benchmark (`pnpm benchmark`: 100k
  characters / 10k messages, catalog ≤300 ms and chat open ≤700 ms targets).
- CI: `ci.yml` runs lint, typecheck, unit/integration tests, web component
  tests, production build and the Playwright accessibility suite on every PR.
- Data: migration 0007 — covers the generation hot path
  (`messages(chat_id, branch_id, created_at DESC, id DESC)`), expression
  indexes for usage sort and import-hash lookups, COLLATE NOCASE name
  indexes, a `chats_au` trigger restricted to FTS-indexed columns, and a
  `memories_fts` backfill; stable `app_meta.install_id` generated on first
  open; migration runner records and verifies per-migration content hashes
  (edited applied migrations are rejected); `appMeta`, `cacheMetadata` and
  `attachments` repositories (the `cache_metadata`/`attachments` tables are
  no longer write-dead — thumbnail generation records cache metadata).
- Starter content: bundled Seraphina V3 character assets and the linked
  four-entry Eldoria lorebook are imported resumably once per installation;
  the initial chat is created atomically with the authored greeting, while
  post-import user edits or deletion are never restored on startup.
- Memory/RAG: retrieval now also activates memories whose content matches
  the context via the previously write-only `memories_fts` index
  (`ftsMatchRanks`, bm25), and `rebuild()` rebuilds `memories_fts` too.
- Events: the SSE channel is consumed at app level — backend-driven changes
  (other tabs, legacy bridge, plugins) invalidate TanStack Query caches;
  `character.selected` is emitted when a character chat opens.
- Desktop: core updater wired end-to-end — update check on open plus
  install/restart controls in the diagnostics panel (localized), Tauri CSP
  defense-in-depth, and `desktop:release` chains a per-platform release
  smoke.
- Plugins: bundled reference plugin `plugins/example-hello` (frontend
  toolbar/command/slash registrations + backend route).
- Contracts: `/health`, `/version` and `/settings/instruct-formats` moved
  from inline TypeBox to `@st2/contracts`.
- Tests: `packages/ui` brought into the vitest config with component tests;
  route suites for memories/personas/characterTransfer/events; web api and
  UI-state tests; shared/legacy-compat/db unit tests with a schema↔migration
  parity check; a legacy server-plugin contract suite; Playwright visual
  regression for the base theme and functional e2e flows.
- AI settings: generation sampler values are now editable number inputs —
  type a value directly and the slider follows, blur/Enter clamps it to the
  parameter's `min`/`max`/`step` (SillyTavern-style manual entry) — alongside
  an “Unlocked context size” toggle that lifts the default 200k context-size
  slider ceiling (up to 10M) for large-window models.

### Changed

- Security (ТЗ §13): Origin validation for state-changing API requests in
  local mode, host-side authoritative `network:<host>` enforcement for plugin
  fetch (worker check is fail-fast only), bounded plugin fetch responses,
  SSE parser buffer cap, typed `FILE_TOO_LARGE` for oversized JSON bodies,
  and structural validation of worker→host RPC envelopes.
- Chat list title filtering goes through the trigger-synced `chats_fts`
  index (prefix search) instead of an unindexable `LIKE '%…%'` scan.
- Provider API keys moved from the single `provider_configs.api_key` column to
  the dedicated `provider_secrets` table; migration 0009 transfers an existing
  key into an active "migrated" secret and nulls the column. The column is kept
  only as a read fallback for unmigrated databases.
- Profiles: the active profile is tracked in `app_meta` (`setActive`/
  `delete` added); `getCurrent()` falls back to the oldest profile.
- Desktop packaging scripts resolve native modules via `require.resolve`
  and honor `TAURI_ENV_TARGET_TRIPLE` for Sharp and better-sqlite3 instead
  of host platform/arch and a hard-coded node_modules path.
- AI settings: context-size bounds now come from shared `@st2/contracts`
  limits; the `maxContextTokens` schema ceiling is raised from 200000 to
  10 000 000 (200k stays the default UI cap until unlocked), and the context
  and max-tokens slider steps no longer strand their maximum below the
  configured cap (e.g. 199936 / 199937).

### Fixed

- Legacy Express dispatcher no longer hangs on handlers using
  `res.write`/`res.end` (previously waited out the 30s timeout).
- Message counting uses `COUNT(*)` instead of materializing row ids.
- Stability (ТЗ §13): plugin worker spawn failures (`child.on('error')`) no
  longer crash the server; process-level unhandled-rejection/uncaught-
  exception guards; legacy async handler rejections contained; profile
  export temp cleanup and plugin install rollback can no longer escape as
  unhandled rejections or mask the original error; shutdown exit code
  reflects close failures.
- SSE generation errors no longer leak raw error text (SQL, paths, provider
  internals) to clients — only app-authored messages cross the boundary;
  failures are logged server-side; client disconnects report
  `GENERATION_CANCELLED`; writes honor backpressure and dead sockets.
- Hijacked SSE responses (`/generate`, `/events`) carry the security
  headers the `onSend` hook cannot add.
- Fastify client errors (malformed JSON body, unsupported content type)
  return their 4xx status with a typed `BAD_REQUEST` envelope instead of
  `INTERNAL`/500; schema validation keeps the `VALIDATION` envelope.
- Plugin worker: IPC disconnect exits instead of orphaning, event handler
  failures and failed `deactivate()` are reported (no silent deaths,
  non-zero exit on failed teardown).
- Backup listing distinguishes an unreadable backup directory from "no
  backups".

### Changed

- Sidebar panel chrome is unified: Persona Management and Character Management
  now use the same header (eyebrow, title, close button, optional avatar and
  actions) as AI Settings / Settings, with standard panel padding and
  translucent shell background instead of the previous full-bleed opaque
  header. A shared `SidebarPanelHeader` component is the single source of
  truth; legacy `data-part="personas-header"` /
  `data-part="character-management-header"` hooks are preserved, and the new
  `data-component="sidebar-panel-header"` hook (parts `identity`, `avatar`,
  `eyebrow`, `title`, `actions`, `close`) is documented in the Theme SDK.

## 2.0.0-pre.3 (prior)

### Added

- Expanded the inline AI Config tab with context size, sampling, penalties, seed,
  streaming and reasoning controls, and added a persisted custom chat-template
  editor under Advanced.
- Generation now applies saved defaults, context limits and custom instruct
  formats; OpenAI-compatible providers receive every supported sampling option
  and can return either streamed or non-streamed completions.
- Added the installable Plugin Manager with atomic bounded `.stplugin`
  replacement, explicit permission consent/re-consent, safe mode, isolated
  package assets, lifecycle status and cleanup.
- Added sandboxed frontend plugin pages, settings/sidebar panels, toolbar and
  message actions, commands, hotkeys, notifications, dialogs, character tabs,
  safe text message renderers, i18n resources and app-event subscriptions.
- Added process-isolated backend plugins with capability-checked routes,
  storage, virtual files, network fetch, providers, async tokenizers, context
  strategies and a bounded namespaced event bus.
- Added an SSE rendezvous for frontend prompt interceptors with one-time
  response tokens, timeout isolation, protected-message restoration and final
  server-side token-budget enforcement.
- Added explicit trusted legacy frontend/Express entry points behind
  `legacy.trusted` consent, plus safe-mode bypass and deterministic teardown.
- Added migration `0004_plugin_consent` separating manifest requests from
  explicit grants and retaining a stable plugin runtime error code.
- Added a complete local Theme Manager with bounded `.sttheme` ZIP install,
  atomic replacement/rollback, inheritance-aware activation, persisted
  component/shell CSS, built-in reset, deletion and a pre-load `?safe=1`
  recovery path.
- Added a reproducible Windows portable ZIP with adjacent SHA-256, marker-based
  local data directory and automated packaged-sidecar/Tauri lifecycle smoke
  checks covering SQLite, Sharp, SPA resources and orphan cleanup.
- Added a local diagnostics and recovery panel with SQLite integrity/migration
  state, aggregate library/storage/runtime health, a versioned redacted JSON
  report, FTS rebuild, safe-mode entry and thumbnail-only cache cleanup.
- Added a streaming, idempotent SillyTavern full-data ZIP migration for
  characters, solo JSONL chats and swipes, personas, Worlds/lorebooks and JSON
  presets, with bounded extraction, path/symlink checks, cancellation and a
  localized Settings report.
- Added migration `0002_import_artifacts` so interrupted streamed chat imports
  recover without duplicates and completed source artifacts remain traceable.
- Added a read-only SillyTavern ZIP preflight with 30-minute bounded staging,
  per-category counts, damaged-record and conflict reporting, category
  selection, explicit `skip`/`copy`/`merge`/`replace` policies, confirmation,
  cancellation and a pre-write safety backup.
- Added migration `0003_repeatable_import_jobs` so the same archive can be
  intentionally confirmed more than once with different categories or conflict
  policies while compatibility clients can still find the latest result.
- Added Mistral and Command-R instruct presets, detached versioned preset
  export, and exact offline `o200k_base`/`cl100k_base` tokenization for known
  OpenAI model families.
- Added signed Tauri core updater commands and updater artifacts, plus native
  macOS/Linux sidecar and bundle lifecycle gates in the desktop release
  workflow.

### Changed

- UX/UI: chat is now the only primary workspace. Characters, chat history,
  providers, settings, themes and plugins open as route-aware modal surfaces
  without unmounting the current chat; deep links, Back, Escape and focus
  restoration remain supported.
- First-run UX now provides an inline language/text-size checklist, direct
  provider and character setup, an existing-data import shortcut, session-only
  per-chat drafts, offline status, destructive-action confirmation and
  persisted density/scale/contrast/reduced-motion preferences.
- Theme Manager now offers a ready-to-edit `theme-starter.zip`; shell slots and
  system-surface hooks are documented for no-build-tools customization.

- Replaced the generic navigation drawer content with contextual inline
  workspace panels. AI generation/provider/context controls now stay beside
  the chat, and desktop chat content is centered in the remaining width while
  the panel is open. Theme SDK now exposes `shell-rail-width` and
  `shell-panel-width` for this layout.
- Theme API v1 now defines `shell` as declarative CSS instead of an executable
  module proposal; JavaScript themes, remote CSS resources and unsafe archives
  are rejected before installation.
- Desktop external native-module loading now handles packaged Node reliably,
  Windows resource paths are normalized before crossing into the sidecar, and
  an unexpected backend termination closes the Tauri shell instead of leaving
  a broken window running.
- Tauri uses platform-native bundle targets on each build host (`all`): NSIS/MSI
  on Windows, app/DMG on macOS and Linux packages including AppImage where the
  runner provides the required system tooling.
- Remote/LAN mode now fails closed unless explicitly enabled with a strong
  bootstrap token and trusted HTTPS origin. Remote browser access uses bounded
  HttpOnly sessions, exact Origin and CSRF validation, login rate limiting,
  in-memory-only frontend credentials and explicit logout; Bearer auth remains
  available for deliberate CLI/API clients.
- Offline PWA reloads now keep the cached app shell visible with an explicit
  offline status while API, SSE, credentials and user responses remain
  uncached and unavailable.
- Prompt pipeline now assembles ranked Lorebook and Memory/RAG blocks, applies
  character post-history instructions, shifts context before plugin
  interceptors, and enforces the token budget again after all interceptors.
- Tool-call/result messages can be linked by stable call ID and are removed as
  one context-shifting group even when non-adjacent.
- Generation now reports tokenizer profile/accuracy metadata and fails with
  `TOKEN_BUDGET_EXCEEDED` when protected context cannot fit safely.
- Chat message deletion, variant activation and active-branch updates now
  validate chat ownership before mutation.
- SQLite backup restore now uses the online backup API and keeps the live
  database connection writable without a process restart.
- Backend Plugin SDK post-processors now participate in host-enforced cleanup;
  cache metrics exclude expired unpruned entries.
- Profile ZIP export now has an explicit binary TypeBox response contract, and
  API documentation covers personas, profiles, variants and regeneration
  semantics.
- Added selectable `truncate`, local `summarize`, relevance-aware
  `vector-recall`, and persisted `manual` context strategies with a
  host-enforced strategy registry and Plugin SDK cleanup.
- Chat message actions can include or exclude individual messages from manual
  prompt context without deleting them.

### Fixed

- Fixed sandbox mounts inside portal-based plugin dialogs and character tabs,
  stable registration snapshots, focus restoration and deterministic hotkey
  collision handling.
- Inline navigation panels now use a secondary heading, preserving one
  unambiguous page-level heading on routes such as Settings.

## [2.0.0-pre.3] — 2026-07-26

### Fixed

- Windows packaged sidecar normalizes absolute bundled SQLite paths before loading the native addon; startup is verified for drive paths and directory names containing spaces.

## [2.0.0-pre.2] — 2026-07-26

### Fixed

- Windows packaged sidecar handling for bundled `better-sqlite3` was updated after a drive-letter startup failure.

## [2.0.0-pre.1] — 2026-07-26

### Changed

- Chat composer now uses a two-layer frosted-glass shell with a distinct input surface, while preserving send, stop, keyboard, and localization behavior.
- The chat composer now mirrors the reference interaction model: settings, draft reset, regeneration, scroll controls, context details, and the compact mobile toolbar.
- SSE generation accepts `regenerate: true` to replace the newest assistant response in the active chat branch.
- Navigation now uses a permanent icon rail with an attached inline settings panel; language, theme, provider and token-limit controls no longer require opening a modal.
- Chat messages now expose inline edit and delete controls. Message edits are persisted through `PATCH /api/v2/chats/:id/messages/:messageId`.
- The local-storage status badge now meets WCAG AA contrast in the dark theme, and release E2E coverage follows the permanent navigation rail interaction model.
- Windows desktop sidecar now normalizes bundled native-module paths before loading SQLite, fixing startup on installed drives other than the system drive.

Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow semver.

## [2.0.0-pre.0] — 2026-07-25

First pre-release of the SillyTavern 2 core.

### Added

- New chat-first App Shell: a start home screen with a locally pinned
  character, chat creation deferred until the first message, shared desktop
  and mobile sliding navigation, a seamless chat canvas, and full
  loading/empty/error states.
- Theme SDK contract for a custom chat background (`chat-wallpaper-*`) and a
  stable `data-part="chat-wallpaper"` without tying React components to a
  specific image.
- Host-enforced Plugin SDK lifecycle: automatic cleanup of
  UI/routes/events/i18n/providers, rollback of partial activation, and
  cleanup even when `deactivate()` throws.
- Tauri 2 desktop shell with a self-contained Node.js 24/Fastify sidecar,
  bundled `better-sqlite3`/Sharp runtime, app icon, and Windows NSIS
  installer.
- Installable PWA manifest and a versioned offline app-shell cache without
  caching API, SSE, or sensitive responses.
- A dedicated UX spec: user groups, information architecture, key scenarios,
  responsive behavior, states, accessibility, and acceptance criteria.
- Idempotent Character Card V1/V2 import/export: JSON/PNG, preservation of
  unknown metadata, SHA-256 deduplication, atomic storage of originals, and
  rebuildable WebP thumbnails.
- Migration `0001_content_and_imports`: character versions, attachments,
  lorebooks, FTS5 lore entries, presets, cache metadata, and the import log.
- pnpm workspaces monorepo: `apps/server`, `apps/web`, and the
  `shared`, `contracts`, `db`, `provider-sdk`, `plugin-sdk`, `theme-sdk`,
  `i18n`, `ui`, `legacy-compat` packages.
- Fastify 5 backend with TypeBox schemas under `/api/v2`: characters, chats,
  messages, personas, providers, settings, search, backups.
- SSE streaming generation with a prompt pipeline (macros, ChatML/Llama3/Alpaca
  instruct formats, context shifting, interceptor isolation).
- Providers: an OpenAI-compatible adapter and an offline `echo`; a registry
  that lets plugins register new kinds.
- SQLite (better-sqlite3 + Drizzle): WAL, foreign_keys, STRICT tables, FTS5
  search with sync triggers, cursor pagination, transactional migrations.
- Frontend React 19 + Vite 8: virtualized character catalog, chat with token
  batching via requestAnimationFrame, settings, providers.
- i18n: en/ru, namespaces, error-code localization, pseudo-locale, RTL.
- Theme SDK: tokens, inheritance, safe mode; base tokens and a dark theme.
- Legacy layer: `window.SillyTavern`, `eventSource`/`event_types`,
  `extension_settings`, jQuery, DOM islands; an Express host for server
  plugins.
- Security: bind on 127.0.0.1, CORS restriction, CSP, error envelope with
  traceId, API keys never appear in responses or logs.

### Tests

- 101 backend/unit/integration tests and 5 frontend component tests (Vitest +
  Fastify inject + Testing Library).
- 6 Playwright E2E tests: character creation, main navigation, keyboard focus,
  and an automated axe WCAG A/AA audit of the Characters, Chats, Providers,
  and Settings pages.
