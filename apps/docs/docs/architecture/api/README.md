---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/api/README.md
---

# API

Main API: `/api/v2/*`. Format — JSON. Streaming generation — SSE.
All inputs/outputs are described by TypeBox schemas in `@neotavern/contracts` (single source of truth).

## Error envelope

Errors are returned by code rather than a ready-made string; the frontend localizes them:

```json
{ "code": "CHARACTER_NOT_FOUND", "params": { "characterId": "…" }, "traceId": "…" }
```

Codes: `VALIDATION`, `NOT_FOUND`, `CHARACTER_NOT_FOUND`, `CHAT_NOT_FOUND`,
`PROVIDER_NOT_FOUND`, `GENERATION_FAILED`, `GENERATION_CANCELLED`,
`BACKUP_FAILED` and others (see `packages/contracts`).

## Remote mode authorization

In loopback mode, authorization is not required. Non-loopback startup is allowed only
with an explicit `NEOTA_REMOTE_ACCESS=true`, a token and a trusted public origin.

- `GET /api/v2/auth/session` → `AuthSession`. A public endpoint reports whether
  sign-in is required; an authenticated response returns a CSRF token.
- `POST /api/v2/auth/session` with `{ "token": "…" }` and the exact `Origin` creates
  a 12-hour browser session. Token is input-only; the response and logs do not contain it.
- `DELETE /api/v2/auth/session` requires a session, the exact `Origin` and
  `X-CSRF-Token`, invalidates the server session and sends `Clear-Site-Data`.

The session ID lives only in a host-only `HttpOnly; Secure; SameSite=Strict`
cookie. The CSRF token lives only in SPA memory and is passed in
`X-CSRF-Token` for `POST`/`PUT`/`PATCH`/`DELETE`. At most 128 sessions, TTL —
12 hours; a restart invalidates them. After five incorrect token attempts within 15
minutes the IP gets `RATE_LIMITED`.

A CLI/API client may instead pass a bootstrap token in
`Authorization: Bearer …`; this mode does not use CSRF, since the browser does not
add the header automatically. CORS allows only the configured origin and
credentials; `*` is not used. Only `health`, `version` and session bootstrap remain
public; the rest of the core and plugin APIs are protected.

## Endpoints

### Meta

- `GET /api/v2/health` → `{ status: "ok", uptime }`
- `GET /api/v2/version` → `{ name, version, apiVersion }`

### Characters

- `GET /api/v2/characters?cursor&limit&tag&q&sort&includeDeleted` → cursor page of `CharacterSummary`.
  The `q` parameter supports the character search syntax (see below). `sort`
  accepts the canonical values `name` (A–Z), `name-desc` (Z–A), `newest`
  (newest first), `oldest` (oldest first), `favorites` (favorites first,
  then A–Z), `used` (recently used; NULL — last), `chats-most` /
  `chats-least` (by number of chats), `tokens-most` / `tokens-least` (by total
  message volume in characters — a content measure, not real tokens), `random`
  (one random page without a cursor — `hasMore: false`, `nextCursor: null`),
  `relevance` (FTS rank; without positive terms it degrades to `newest`).
  Deprecated aliases `recent` → `newest`, `created` → `oldest`, `usage` → `used`
  are kept for compatibility and marked deprecated. A query with positive FTS terms
  is always ranked by relevance regardless of `sort`.
- `POST /api/v2/characters` (body `CharacterCreate`) → `Character`.
- `POST /api/v2/characters/import` (`multipart/form-data`, field `file`, JSON or
  PNG Character Card, up to 25 MiB) → `CharacterImportResult`. Re-uploading the same
  file returns the existing character with `created: false`.
- `GET /api/v2/characters/:id` → `Character` | 404.
- `GET /api/v2/characters/:id/export?format=json|png` → downloadable character
  card. `json` (and a request without `format`) returns a Character Card V2 JSON;
  `png` normalizes the local avatar original to PNG and embeds the V2 card
  in a SillyTavern-compatible `chara` tEXt chunk. If there is no local avatar,
  a transparent portrait canvas is used; the server does not fetch network URLs.
- `PATCH /api/v2/characters/:id` (body `CharacterUpdate`).
- `DELETE /api/v2/characters/:id` → soft delete (trash).
- `POST /api/v2/characters/:id/restore`.
- `GET /api/v2/characters/:id/gallery?sort=oldest|newest` →
  `{ items: CharacterGalleryImage[] }`.
- `GET /api/v2/characters/:id/avatar-original` → redirect to the local
  original of the current avatar. Intended for opening the full-resolution file
  from a preview; external URLs are not proxied.
- `POST /api/v2/characters/:id/gallery` (`multipart/form-data`, field `file`,
  PNG/JPEG/WebP/GIF up to 25 MiB) → `CharacterGalleryImage`. Identical bytes for
  the same character reuse the existing attachment record.
- `DELETE /api/v2/characters/:id/gallery/:imageId` → removes the image's
  gallery membership but keeps the content-addressed original.

Import verifies the actual format, not just the MIME/extension. Unknown
fields and extension metadata are preserved. For PNG, the original is stored separately,
and the gallery gets a content-addressed WebP thumbnail.

ST1 fields that are not part of Character Card V2 directly (`favorite`,
`characterVersion`, `alternateGreetings`, `depthPrompt`, `talkativeness`)
are saved by the editor into `Character.ext`. `PATCH` merges them with the existing
`ext`, so unknown card fields and plugin data are not erased.

#### `q` syntax in `GET /api/v2/characters`

The query is parsed on the backend; when it parses successfully, the selection goes
through the FTS5 index `characters_fts` (name, description, personality, scenario, tags)
and is sorted by relevance regardless of `sort`. Supported:

- free text and exact quoted phrases: `magic sword`, `"magic sword"`;
  free text also searches tag names (`knight`, `NSFW` find characters
  with such tags);
- key filters (case-insensitive):
  - `tag:` — a tag by name prefix (case-insensitive; `tag:sf` finds the tag
    `sfw`), `-tag:` excludes;
  - `author:` — author match by substring (case-insensitive),
    `-author:` excludes, including characters without an author;
  - `name:` — name substring, `-name:` excludes;
  - `desc:`, `persona:`, `scenario:` — full-text filters on the FTS columns;
  - `-desc:`, `-persona:`, `-scenario:` — ignored (FTS5 does not support
    negative column filters);
- an unknown `key:value` is treated as free text;
- a quoted value after the key: `tag:"science fiction"`.

The separate `tag` query parameter (exact tag, case-insensitive) preserves
the previous behavior and combines with the filters from `q`.

Limitations and behavior:

- text is searched by exact word forms; `"magic sword"` does not match
  "magic swords" (no stemming);
- a query with only negative filters (`-tag:beta -author:x`) does not reach
  FTS5 (it requires positive terms) and is handled as an SQL filter without
  relevance sorting;
- garbage FTS syntax (e.g. broken operators) does not cause an
  error: the negative parts are kept, the rest is discarded, and the query
  is handled as an SQL filter;
- one query processes at most 10 tokens/keys, the rest are ignored.

Examples: `tag:NSFW author:Tidyup`, `-tag:beta "magic sword"`,
`name:"elven" -name:warrior`.

### Personas and profile

- `GET /api/v2/personas` → `{ items: Persona[] }`.
- `POST /api/v2/personas` (body `PersonaCreate`) → `Persona`.
- `PATCH /api/v2/personas/:id` (body `PersonaUpdate`) → `Persona` or
  `PERSONA_NOT_FOUND`.
- `DELETE /api/v2/personas/:id` → `{ ok: true }`.
- `GET /api/v2/profiles` → `ProfileListResponse`.
- `PATCH /api/v2/profiles/:id` (body `ProfileUpdate`) → `Profile`.
- `GET /api/v2/profiles/export` → `application/zip` stream per the
  `ProfileExportResponseSchema` schema. The archive contains a consistent SQLite snapshot,
  a manifest and user originals, but not secrets, caches, plugins or themes.

### Lorebooks (world info)

Lorebooks are sets of entries activated by keywords and injected into the prompt
at the Lorebook stage (see `docs/prompt-pipeline/README.md`). A book is either global
(`characterId: null` — applied in all chats) or bound to a character
(`metadata.characterId`). When generating for a character, its books are used
plus all global ones. Schemas: `LorebookSchema`, `LorebookEntrySchema` and companion
create/update schemas in `@neotavern/contracts`.

- `GET /api/v2/lorebooks?cursor&limit&characterId` → cursor page of
  `Lorebook`. `characterId` returns the character's books **plus** all global ones.
- `POST /api/v2/lorebooks` (body `LorebookCreate`, optional inline `entries`,
  up to 1000 entries) → `Lorebook`.
- `GET /api/v2/lorebooks/:id` → `Lorebook` or `LOREBOOK_NOT_FOUND`.
- `PATCH /api/v2/lorebooks/:id` (body `LorebookUpdate`; `characterId: null`
  unbinds the book) → `Lorebook` or `LOREBOOK_NOT_FOUND`.
- `DELETE /api/v2/lorebooks/:id` → soft delete (trash), `{ ok: true }`.
- `POST /api/v2/lorebooks/:id/restore` → restored `Lorebook` or
  `LOREBOOK_NOT_FOUND`.
- `GET /api/v2/lorebooks/:id/entries` → `{ items: LorebookEntry[] }` (all entries
  of the book, ordered by `position`).
- `POST /api/v2/lorebooks/:id/entries` (body `LorebookEntryCreate`, at least
  1 primary key required) → `LorebookEntry`.
- `PATCH /api/v2/lorebooks/:id/entries/:entryId` (body `LorebookEntryUpdate`) →
  `LorebookEntry` or `LORE_ENTRY_NOT_FOUND`.
- `DELETE /api/v2/lorebooks/:id/entries/:entryId` → `{ ok: true }` or
  `LORE_ENTRY_NOT_FOUND`.

An entry: `keys` (primary keys, substring activation without case sensitivity),
`secondaryKeys` (secondary; for `selective` entries a primary **and** secondary
match is required), `content` (up to 20,000 characters), `constant` (always in context,
without keys), `enabled`, `position` (order within the book), `metadata`
(arbitrary extensions are preserved losslessly). Search across books and entries
is available via FTS5 in `GET /api/v2/search` (`lorebooks_fts`, `lore_entries_fts`).

Lorebook import from SillyTavern (`worlds/*.json`) is done via
`POST /api/v2/imports/sillytavern` (categories `lorebooks`, `loreEntries`).

### File assets

- `GET /api/v2/assets/avatars/:filename` — immutable original.
- `GET /api/v2/assets/thumbnails/:filename` — regenerable thumbnail.

Names contain SHA-256 and are safe for long `immutable` caching.

### Chats and messages

`GET /api/v2/chats` accepts `sort=manual|recent`. `manual` remains the default
and preserves `sort_order ASC, updated_at DESC, id DESC`; `recent` ignores the
manual position and uses only `updated_at DESC, id DESC`. Recent pagination uses
a discriminated cursor that cannot be reused for manual pagination. Both global
and `characterId`-filtered queries exclude soft-deleted chats. `ChatSummary`
also exposes nullable `characterName` and `characterAvatar`, so callers can
render a cross-character recent list without follow-up requests.

- `GET /api/v2/chats?cursor&limit&characterId&q` → page of `ChatSummary`.
  Order: `sort_order ASC, updated_at DESC, id DESC` — manually reordered
  chats go on top, the rest "newest first". `characterId` limits the selection
  to a character. `q` searches chat titles/summaries **and** message content
  (FTS5 union of `chats_fts` + `messages_fts`); when `characterId` is given,
  the search is limited to its chats.
- `PUT /api/v2/chats/order` (body `ChatReorder` `{ characterId, order }`) →
  `{ reordered: number, invalidIds: string[] }`. Persists the manual chat order
  of a character. `order` may be partial: the listed chats get increasing
  `sort_order`, the unlisted ones keep their relative order below the reordered
  block. Duplicates in `order` are rejected (`CHAT_REORDER_DUPLICATE_IDS`); unknown
  or deleted ids are returned in `invalidIds` without changing their rows; a non-existent
  character — `CHARACTER_NOT_FOUND`.
  `POST /api/v2/chats` accepts optional `reuseUnstarted`. When true, it returns
  the newest non-deleted chat with the same character/persona and no user
  messages instead of creating another greeting-only chat. Concurrent requests
  for the same scope share one in-flight create. The default is false to preserve
  existing Plugin SDK and direct API behavior.

- `POST /api/v2/chats` → `Chat` (creates a `main` branch; if the selected
  character has authored greetings — `firstMessage` and non-empty
  `ext.alternateGreetings` — atomically saves the selected one as the first
  assistant message). Optional `greetingIndex` (default `0`)
  selects the greeting; `meta` gets `{ greeting: true, swipes, swipeId }`
  for ST1-compatible switching.
- `GET/PATCH/DELETE /api/v2/chats/:id`.
- `GET /api/v2/chats/:id/export` → downloadable JSON
  `{ kind: "neotavern-chat-export", version: 2, exportedAt, chat, characterName, messages, messageVariants, messageRevisions }`
  with `Content-Disposition: attachment` and the file name `chat-<id>.json`.
  Messages are read in batches and are not loaded into memory entirely.
- `GET /api/v2/chats/:id/messages?order=desc&cursor&branchId` — old messages are loaded in portions.
- `POST /api/v2/chats/:id/messages` (body `MessageCreate`) — optional
  `idempotencyKey` (outbox): a repeated create with the same key returns
  the original message, not a duplicate.
- `PATCH /api/v2/chats/:id/messages/:messageId` (body `MessageUpdate`) —
  in-place changes. Each message carries a `revision` (bumped on every
  update); when `expectedRevision` is passed and does not match, the response is 409
  `MESSAGE_CONFLICT` with `{ messageId, expectedRevision, currentRevision }`
  instead of silently overwriting someone else's edit (CAS).
  A content change archives the previous text as a manual edit revision and increments
  `contentRevisionCount`. A no-op, metadata-only update, greeting swipe, variant activation,
  and regeneration do not create an edit revision.
- `GET /api/v2/chats/:id/messages/:messageId/revisions?cursor&limit` returns
  `{ items: MessageContentRevision[], nextCursor }`, newest revision first. The cursor is
  opaque and pagination is stable by revision position.
- `POST /api/v2/chats/:id/messages/:messageId/revisions/:revisionId/restore` requires
  `{ expectedRevision }` and returns the updated `Message`. Restore is non-destructive:
  it archives the current text as the newest revision and keeps the selected revision.
  A stale CAS returns 409 `MESSAGE_CONFLICT`; a missing revision returns
  `MESSAGE_REVISION_NOT_FOUND`; a message outside `:id` returns `MESSAGE_NOT_FOUND`.
  The routes use the same authenticated chat access as the other message endpoints.
- `DELETE /api/v2/chats/:id/messages/:messageId`.
- `POST /api/v2/chats/:id/drafts` (body `MessageDraftCreate`) — creates
  a server-side streaming draft; streaming writes into the draft, not into the
  committed message.
- `PATCH /api/v2/chats/:id/drafts/:draftId` (body `MessageDraftUpdate`) —
  `content`/`role` with a monotonic `sequence`: a PATCH with an old sequence is an
  idempotent no-op. Someone else's/deleted draft — `MESSAGE_DRAFT_NOT_FOUND`.
- `POST /api/v2/chats/:id/drafts/:draftId/commit` — atomically materializes
  the message (role from the draft) and returns
  `{ messageId, alreadyCommitted }`; a retry after success returns the same
  `messageId`. Until the draft is committed, it is not in the message list.
- `DELETE /api/v2/chats/:id/drafts/:draftId` — abandon: the draft is deleted,
  no message is created. Stale drafts (committed >1 h or
  uncommitted >24 h) are swept by a server-side sweep at startup and on a timer.
- `GET /api/v2/chats/:id/blocks?messageIds=a,b,c` — batch of plugin block
  attachments for chat messages (≤100 ids; foreign messageIds
  are filtered out). Persistent block bindings (rev4 stage 4):
  survive reload and render in any client.
- `POST /api/v2/chats/:id/messages/:messageId/blocks` (body `BlockAttach`) —
  attach a plugin block to a message (FK on plugin_registry: uninstall
  cascades to delete the attachments). A foreign message — `MESSAGE_NOT_FOUND`.
- `PATCH /api/v2/blocks/:blockId` (body `BlockUpdate`) — update the descriptor
  and/or `serializedState` of the renderer (`null` clears). Used by the host
  on freeze (saving state on unmount).
- `DELETE /api/v2/blocks/:blockId` — detach a block.
- All three mutations send `chat.message.block.changed`
  `{ chatId, messageId, blockId }` — other clients re-read the message attachments
  and remount the blocks.
- `GET /api/v2/chats/:id/branches`.
- `GET /api/v2/chats/:id/messages/:messageId/variants` →
  `{ items: MessageVariant[] }` (ordered by `position`, then
  `createdAt`, `id`; each variant carries a 0-based `position` in the message's
  variant permutation).
- `POST /api/v2/chats/:id/messages/:messageId/variants/:variantId/activate`
  (body optional: `{ expectedRevision? }`) → updated `Message`.
  Non-destructive swipe by id: the current text atomically becomes a variant,
  the selected variant becomes the current text (positions are swapped), `revision`
  is incremented. On an `expectedRevision` mismatch — 409 `MESSAGE_CONFLICT`
  with `{ messageId, expectedRevision, currentRevision }`.
- `POST /api/v2/chats/:id/messages/:messageId/swipe` (body `SwipeActivate`
  `{ position, expectedRevision? }`) → updated `Message` (200). Makes
  the variant at 0-based position `position` active by the same non-destructive
  swap as activate; `MESSAGE_NOT_FOUND` if the position is absent,
  `MESSAGE_CONFLICT` (409) if `expectedRevision` did not match.
- `POST /api/v2/chats/:id/snapshots` (body `ChatSnapshotCreate`
  `{ messageId, kind: 'checkpoint'|'branch', replace?, title? }`) →
  `{ chat, copiedMessages }`. Copies the prefix of the chat's active branch up to
  and including `messageId` into a new child chat (`Chat` with
  `parentChatId`/`origin`/`sourceMessageId`; `messageCount = copiedMessages`).
  For `kind: 'checkpoint'`, the source message additionally gets the
  `checkpointChatId` flag (link); `replace: true` re-points the flag to the fresh
  snapshot — the previous child chat is **not deleted** in that case. `title` defaults
  to `"{parent title} — checkpoint|branch"`. Errors:
  `MESSAGE_NOT_FOUND` (no message or it is from another chat),
  `CHAT_BRANCH_NOT_FOUND` (message not in the active branch — the snapshot
  freezes only the active branch).

`Message` additionally carries `variantCount` (total variants, including the
active text; ≥ 1 after backfill), `activeVariantPosition` (0-based position
of the active text in the variant permutation; `null` until migration 0020), and
`checkpointChatId` (id of the child checkpoint chat or `null`).
`Chat`/`ChatSummary` additionally carry `parentChatId`, `origin`
(`'checkpoint'|'branch'|null`) and `sourceMessageId` — the origin
of the snapshot chat. `PATCH /messages/:messageId` accepts `checkpointChatId`
(`null` clears the flag).

Message and branch routes verify membership in `:id` before mutation.
A foreign `messageId` returns `MESSAGE_NOT_FOUND`, a foreign `activeBranchId` —
`CHAT_BRANCH_NOT_FOUND`; data of another chat is not modified.

### Chat backgrounds (wallpapers)

`PATCH /api/v2/chats/:id` accepts `backgroundId` — a background file name from the catalog
below (or `null` to reset to the theme). The frontend applies the selected background to
the chat via the CSS variable `--st-chat-wallpaper-image` (see `docs/theme-sdk/`).

- `GET /api/v2/backgrounds` → `{ items: BackgroundItem[] }`. The catalog scans
  `data/files/backgrounds/`, so files imported from SillyTavern 1
  appear automatically. The `thumbnailUrl` field is guaranteed to point to a
  regenerable thumbnail (`ensureBackgroundThumbnail` creates it lazily on
  the first request). Sorting: new files first.
- `POST /api/v2/backgrounds` — multipart upload (field `file`). Limit 25 MB.
  Only PNG/JPEG/WebP/GIF are accepted; the content is additionally verified
  via `sharp`. The original is stored content-addressed as
  `{sha256}{ext}` — re-uploading the same bytes deduplicates into the same
  file. Response — `BackgroundItem`.
- `DELETE /api/v2/backgrounds/:id` — deletes the original and its thumbnail from the
  cache and resets `background_id` in all chats that referenced the file (the `chats`
  record itself is not deleted).
- `GET /api/v2/assets/backgrounds/:filename` — serves the original with `Cache-Control:
public, max-age=3600`. `:filename` is validated (no path separators and
  invalid extensions); path traversal is impossible.

Stable error codes: `FILE_TOO_LARGE` (413), `FILE_TYPE_NOT_ALLOWED` (415,
wrong MIME, extension or non-decodable image), `FILE_NOT_FOUND`
(404, missing/invalid file), `BAD_REQUEST` (400, non-multipart request).

`BackgroundItem`:

```json
{
  "id": "a1b2…c3d4.png",
  "name": "a1b2…c3d4.png",
  "originalUrl": "/api/v2/assets/backgrounds/a1b2…c3d4.png",
  "thumbnailUrl": "/api/v2/assets/thumbnails/…-1280-v1.webp",
  "sizeBytes": 1048576,
  "createdAt": 1700000000000
}
```

### Generation (SSE)

`POST /api/v2/chats/:id/generate`, body:
`{ userMessage?, regenerate?, regenerateMessageId?, generationType?,
providerConfigId?, overrides? }`.

`regenerate: true` rewrites the newest assistant message of the active branch
in place (the ID is preserved); `regenerateMessageId` explicitly specifies the target — it
must remain the last assistant message of the branch, otherwise the request fails
immediately, before streaming, with 409 `REGENERATE_TARGET_MOVED`
(`{ chatId, messageId }`). The old text is not deleted: when the generation
completes, it is **atomically** archived as a variant (`variant_count + 1`,
the new text becomes active); on error or stream cancellation nothing is
persisted. Any `userMessage` in such a request is ignored.
`generationType` selects Prompt Manager triggers and accepts `normal`,
`continue`, `impersonate`, `swipe`, `regenerate`, `quiet`; by default
`normal` is used, and `regenerate: true` / `regenerateMessageId` always
set `regenerate`.

The response is a stream of SSE events (`GenerationEvent`):

```
data: {"type":"start","requestId":"…"}
data: {"type":"delta","text":"…"}
data: {"type":"done","text":"…","usage":{…}}
data: {"type":"error","code":"…","message":"…"}
```

Exactly one terminal event (`done` or `error`). When the client disconnects,
generation is cancelled via `AbortSignal`.

Before calling the provider, the prompt pipeline checks the token budget twice: before and
after plugin interceptors. If the required system/lorebook/pinned context does not
fit after the reply reservation, SSE returns an error event with the code
`TOKEN_BUDGET_EXCEEDED` and the parameters `contextLimit`, `reservedForReply`,
`promptTokens`.

After each attempt, the server saves a limited audit of the actually assembled
context. `GET /api/v2/chats/:id/context-audit` returns the last
`PromptContextAudit` or `{ "audit": null }` if no generations have happened yet. The audit
contains the order, inclusion/exclusion and token count of each block, the selected
provider/model, the template mode, the final provider messages, the token budget,
interceptor diagnostics and the terminal status (`completed`, `failed` or
`cancelled`). API keys and the provider error body do not get into the audit; a new attempt
replaces the previous full audit of this chat.

In addition to the audit, the server persists the metadata of the completed generation on
the assistant message itself: `meta.generation` (`generationId`, `providerConfigId`,
`providerKind`, `providerSource`, `model`, `durationMs`, `usage` — schema
`MessageGenerationMetaSchema`). Metadata is written both for new responses and on
regeneration (the old object is replaced with a new `generationId`). Messages
created before this version do not have the field — readers use the safe parser
`parseMessageGenerationMeta` (null instead of throwing an error) and show
only what exists. Legacy `meta.model` is kept for backward compatibility.

`POST /api/v2/context-preview` computes the context of a new or existing
conversation without writing to the DB and without calling the provider. The previous
payload with `characterId` remains compatible:

```json
{
  "characterId": "018f…",
  "userMessage": "Show me the clockwork orchard.",
  "providerConfigId": "018f…"
}
```

For an existing chat, the mutually exclusive variant with `chatId` is used:

```json
{
  "chatId": "018f…",
  "userMessage": "Continue from the western path."
}
```

`providerConfigId` is optional; when absent, the active
configuration is used. The response `{ "preview": PromptContextPreview }` contains the same
`entries`, `budget`, tokenizer metadata, provider messages and diagnostics
that the context panel needs. The `characterId` variant applies the card and
the active/explicitly passed persona; the `chatId` variant reads up to 200 recent
messages of the active branch, the chat-level persona, and temporarily appends
`userMessage`. Both run Lorebook/Memory retrieval, Prompt Template,
instruct format and context strategy. Frontend plugin interceptors are not
run, since the preview does not open the SSE generation channel. The request
is cancelled via `AbortSignal` when the client disconnects and never creates a chat,
branch, message or audit.

If the active provider configuration has no model selected yet, the preview uses
an explicitly marked approximate fallback tokenizer; strict model validation
remains on the generation route. Stable errors: `CHARACTER_NOT_FOUND`, `CHAT_NOT_FOUND`,
`TOKEN_BUDGET_EXCEEDED` and the standard `VALIDATION`. The endpoint uses the same
local API session as the other `/api/v2` routes; it has no separate plugin
permission or new versioning lifecycle.

### Providers

- `GET /api/v2/providers/catalog` → built-in catalog of safe public
  connection profiles: `source`, `adapterKind`, default URL, URL editability,
  key requirement, supported sampler ids and
  an optional list of `reasoningEfforts`. NanoGPT declares extended
  sampler fields and the levels `none`, `minimal`, `low`, `medium`, `high`, `xhigh`;
  the value `max` is not sent for it.
- `GET /api/v2/providers` → `{ items: ProviderConfig[] }` (the key is not returned,
  only `hasApiKey`).
- `POST /api/v2/providers` (accepts `apiKey` on write only).
- `PATCH/DELETE /api/v2/providers/:id`. If `apiKey` is absent in PATCH,
  the active secret is preserved; the editor uses separate secret routes for
  selecting, adding and deleting keys, so changing `source` or Base URL does not
  clear an explicitly selected key.
- `GET /api/v2/providers/:id/models` → list of models and `contextLimit`.
- `POST /api/v2/providers/:id/test` → `ProviderTestResponse`: checks
  the connection and returns the available models without generation.

The catalog includes OpenAI-compatible sources, the native Anthropic Messages API
and text backends of classic SillyTavern: `text-completion`
(`/v1/completions`, sources `ooba`/`koboldcpp`/`vllm`/`ollama`), `novelai`,
`ai-horde` (async queue, key optional) and `koboldai`
(`/api/v1/generate`). `adapterKind` defines the transport and the serialization
rule (chat adapters receive messages, text adapters — the rendered
instruct prompt; see [architecture](../architecture/README.md#source-catalog-and-adapters)).
`source` must match `kind`; the catalog URL may be changed only
for profiles with `baseUrlEditable: true`. A disabled profile cannot be selected
as active or used for generation. `validateConfig` runs on
creation, update, test/models and immediately before generation.
Upstream errors are normalized into stable codes (`UNAUTHORIZED`,
`RATE_LIMITED`, `MODEL_NOT_FOUND`, `GENERATION_FAILED`) without returning the raw
provider response.

#### Additional parameters and prompt post-processing

The `settings` field of the provider configuration accepts SillyTavern-compatible
"Additional Parameters" and a post-processing mode. Unlike classic
SillyTavern, the values are stored as **structured JSON** rather than YAML
(see [ADR-0008](../adr/README.md#adr-0008-json-instead-of-yaml-for-additional-parameters)).
All keys are optional and validated on write (`POST`/`PATCH /api/v2/providers`);
an invalid value returns `PROVIDER_CONFIG_INVALID` with an array of `issues`
(path + message).

- `promptPostProcessing` — a string, one of the modes: `''` (none), `merge`,
  `merge_tools`, `semi`, `semi_tools`, `strict`, `strict_tools`, `single`.
  The `_tools` variants preserve tool-call/tool-result pairs; the variants without the suffix
  remove tool messages. The mode is applied by the server at the request preparation
  stage (see [prompt pipeline](../prompt-pipeline/README.md)).
- `customIncludeBody` — JSON object, merged into the request body.
- `customExcludeBody` — JSON array of strings, lists the body keys to remove.
- `customIncludeHeaders` — JSON string→string object, additional headers.
  The `Authorization`, `Content-Type` and `Content-Length` headers must not be
  overridden (credential and content-negotiation protection); an attempt returns
  `PROVIDER_CONFIG_INVALID`.

### Provider secrets (API keys)

Each provider can store several named keys; exactly one of them is **active**
and used for generation. Secret values are **write-only**: neither list nor
state returns the plaintext key, only a masked preview (`masked`). Schemas —
`packages/contracts/src/secrets.ts`.

- `GET /api/v2/secrets/exposure` → `{ allowSecretsExposure }`: the server flag
  that allows showing plaintext values (env `NEOTA_ALLOW_SECRETS_EXPOSURE`,
  default `false`). The analogue of `allowKeysExposure` in SillyTavern.
- `GET /api/v2/providers/:id/secrets` → `{ items: ProviderSecret[] }`
  (active first; each item: `id`, `providerId`, `label`, `active`,
  `masked`, `createdAt` — without the value). 404 `PROVIDER_NOT_FOUND` if
  the provider does not exist.
- `POST /api/v2/providers/:id/secrets` (body `ProviderSecretCreate`
  `{ value, label? }`) → `{ id }`. A non-empty value becomes active and
  deactivates the others; an empty value is saved inactive (for local
  endpoints without a key).
- `PATCH /api/v2/providers/:id/secrets/:secretId` (body `ProviderSecretUpdate`
  `{ label?, active? }`) → updated `ProviderSecret`. `active: true`
  switches the active key. 404 `PROVIDER_SECRET_NOT_FOUND`.
- `DELETE /api/v2/providers/:id/secrets/:secretId` → `{ ok: true }`. When
  the active key is deleted, the last remaining non-empty one becomes active.
- `POST /api/v2/providers/:id/secrets/:secretId/reveal` → `{ value }`.
  Returns the plaintext key **only** when `allowSecretsExposure: true`, otherwise
  403 `SECRETS_EXPOSURE_DISABLED`.

Cascade: deleting the provider (`DELETE /api/v2/providers/:id`) deletes all its
secrets (FK `ON DELETE CASCADE`). Diagnostic export and logs do not contain
secret values. The legacy column `provider_configs.api_key` is no longer used for
writing and serves only as a read fallback for non-migrated databases.

### Themes

All response schemas live in `packages/contracts/src/theme.ts`; the manifest
is passed as JSON and validated by the single source of truth
`@neotavern/theme-sdk`.

- `GET /api/v2/themes` → `ThemeListResponse` with the installed themes, their
  asset URLs and a single `activeThemeId`.
- `POST /api/v2/themes/install` (`multipart/form-data`, field `file`, ZIP or
  `.sttheme`, up to 25 MiB) → `ThemeInstallResult`. Installation safely
  unpacks and validates the package, atomically replaces an existing version,
  but does not activate the new theme.
- `POST /api/v2/themes/:id/activate` → `ThemeActivationResult`. Validates the
  installed `extends` chain, then transactionally activates exactly one theme
  and synchronizes `settings.themeId`.
- `DELETE /api/v2/themes/active` → the built-in theme,
  `{ "activeThemeId": null }`.
- `DELETE /api/v2/themes/:id` → `ThemeDeleteResult`; deletes the record and the
  local package. Deleting the active theme first resets the active state.
- `GET /api/v2/themes/:id/assets/*` serves only the allowed CSS/image/font/audio
  files of the installed package with `Cache-Control: no-store`.
- `GET/PATCH /api/v2/themes/:id/settings` → per-theme user settings
  (`ThemeSettingsResponse`). PATCH accepts a "setting id → value" object,
  validates the values against the manifest and returns 422 `VALIDATION` for
  unknown or invalid settings; the settings are cleared when the theme is
  deleted.

All endpoints except auth bootstrap/health/version use the common remote-mode
authorization and CSRF policy. Typical errors: `THEME_INVALID` (422),
`THEME_NOT_FOUND` (404), `FILE_NOT_FOUND` (404), `FILE_TOO_LARGE` (413),
`FILE_TYPE_NOT_ALLOWED` (415). The Theme API version is set by the manifest
`apiVersion`; the current host accepts versions no newer than `1`.

### Settings, search, backups

- `GET/PATCH /api/v2/settings` → `AppSettings`. The `contextStrategy` field
  accepts `truncate`, `summarize`, `vector-recall`, `manual` or the id of a
  strategy registered by an active plugin. An unknown id returns `VALIDATION`.
  `maxContextTokens` sets the context budget, `generationDefaults` the provider
  parameters, and `instructFormat` holds custom Handlebars templates for roles,
  the reply suffix and stop strings. `instructFormat: null` enables the
  built-in structured serialization.
  `generationDefaults.reasoningEffort` accepts `none`, `minimal`, `low`,
  `medium`, `high`, `xhigh` or `max`. Leaving the field out leaves the choice
  to the provider; the actual set of supported values depends on the model.
  The `themeId` field activates only an installed theme; `null` resets it.
  An unknown id returns `THEME_NOT_FOUND`.

  `autoConnect` (optional boolean) and `lastServer` (optional
  `{ providerConfigId, source?, model? }` object or `null`) implement the
  SillyTavern "Auto-connect to Last Server" behavior. The "Connect" button in
  the provider editor writes `lastServer` together with
  `activeProviderConfigId`; on load, when `autoConnect: true`, the client
  restores and re-validates that connection (model discovery).
  `lastServer` references an existing provider config and stores `source`/
  `model` for display only. The field relates to application behavior, not
  layout, so it lives at the root of `AppSettings` rather than in `ui`.

`chatSerialization` selects how the context is sent: `native` keeps the array
of provider messages, `custom` applies the instruct format.
`promptTemplateMode` selects the Advanced mode: `chat` uses the system Chat
template, `text` assembles the enabled blocks in the saved order of
`promptTemplate.blocks[]`. `promptTemplate` holds the system prompt, the
post-history instructions template, and controls the inclusion of the lorebook,
persona, character, dialogue examples, memory, chat history and the current
user input. Host blocks cannot be removed from the template; additionally,
unique `custom-*` entries are allowed with `name`, `role`, `content`, `enabled`,
`triggers`, `injectionPosition`, `injectionDepth`, `injectionOrder`,
`forbidOverrides` and an optional `model` (binding the block to a single
model; the block is excluded from the assembly when the active model does not
match).
`in-chat` is inserted into the Chat History at the given depth, `relative`
follows the position in the array. The last two elements must be
`chat-history`, then `post-history-instructions`; a PATCH with a different
order returns `VALIDATION` with `reason: BLOCK_ORDER_INVALID`. The pipeline
normalizes legacy settings before assembly. `activePromptTemplatePresetId` and
`activeGenerationPresetId` point at `/api/v2/presets` records.

`GET/POST /api/v2/presets?kind=generation|prompt-template` and
`GET/PATCH/DELETE /api/v2/presets/:id` save, import and export user presets.
The payload is validated against `kind`: a generation preset cannot substitute
model/messages, a prompt-template preset must contain the full set of host
blocks exactly once, unique custom prompt ids and fixed terminal anchors. The
built-in default remains available without a DB row.

- `GET /api/v2/search?q&scope` → `SearchResponse` (FTS5). For
  `scope=characters`, search runs over `characters_fts` — including tag names
  (migration 0011).
- `POST /api/v2/search/rebuild` — rebuilds the FTS indexes from the base
  tables, including the `tags` column of `characters_fts`.
- `POST /api/v2/backups` → `Backup`, `GET /api/v2/backups` →
  `{ items: Backup[] }`.
- `POST /api/v2/backups/:id/restore` first creates and rotates a safety
  backup, validates the snapshot via SQLite `quick_check`, then restores it
  through the online backup API. Response:
  `{ restored: true, restartRequired: false }`; existing repositories and
  subsequent records remain functional. Errors use `RESTORE_FAILED`.

### Diagnostics and recovery

- `GET /api/v2/diagnostics` → `DiagnosticsSnapshot`. The read-only snapshot
  contains the runtime/API version, `PRAGMA quick_check`, the migration
  version and count, aggregated entity counts, storage sizes, free space and
  the provider/plugin/theme counts.
- `DELETE /api/v2/diagnostics/cache` → `CacheCleanupResult`. Deletes only
  `data/cache/thumbnails/` and the related `cache_metadata` rows; originals,
  the library, backups and temporary import staging directories are not
  affected.

`DiagnosticsSnapshot` has `formatVersion: 1` and a stable `privacy` block. By
design the contract contains no logs, absolute paths, provider settings,
API keys, bootstrap/session/CSRF tokens or user text. The SPA first shows the
report contents and creates the JSON file locally only on an explicit user
action. Both state-changing maintenance operations are protected in remote
mode by the common session/Origin/CSRF policy.

### SillyTavern data transfer

#### Analysis

`POST /api/v2/imports/sillytavern/analyze`

- content type: `multipart/form-data`;
- field: `file`, ZIP up to 4 GiB;
- permissions: there is no dedicated permission; the endpoint is only
  reachable through the local API, which by default listens on `127.0.0.1`;
- lifecycle: staging is kept for 30 minutes and removed after execution,
  explicit cancellation or TTL expiry; up to three staging sessions are
  allowed at the same time;
- cancellation: closing the request aborts saving, unpacking and analysis via
  `AbortSignal`;
- side effects: the library, `import_jobs` and backups are not modified;
- `200` response: `SillyTavernImportAnalysis`.

```json
{
  "analysisId": "0198…",
  "sourceHash": "64 hex characters",
  "sourceName": "sillytavern-data.zip",
  "expiresAt": 1785038400000,
  "archiveAlreadyImported": false,
  "totalCompressedBytes": 1048576,
  "totalExpandedBytes": 4194304,
  "categories": [
    {
      "id": "characters",
      "discovered": 12,
      "dependentRecords": 0,
      "invalid": 1,
      "conflicts": 3,
      "sizeBytes": 2097152
    }
  ],
  "conflictCount": 3,
  "conflicts": [
    {
      "category": "characters",
      "sourceKey": "characters/archive guide",
      "path": "characters/Archive Guide.json",
      "kind": "name",
      "targetId": "0197…",
      "targetName": "Archive Guide",
      "safePolicies": ["skip", "copy", "merge", "replace"]
    }
  ],
  "warningCount": 1,
  "warnings": [{ "code": "SECRETS_SKIPPED", "path": "secrets.json" }]
}
```

`conflicts` and `warnings` each hold at most 200 items; the full counts are in
`conflictCount` and `warningCount`.

#### Confirmation

`POST /api/v2/imports/sillytavern/:analysisId/execute`

Request:

```json
{
  "categories": ["characters", "chats", "personas"],
  "conflictPolicy": "skip"
}
```

`categories` accepts `characters`, `chats`, `personas`, `lorebooks`,
`presets`; the array is non-empty and without duplicates. `conflictPolicy`:
`skip`, `copy`, `merge` or `replace`. An SQLite backup is created before the
first write. With `replace` a character keeps its UUID and gets a version
snapshot. The old chat stays available until the new transcript is fully
written; after that it is atomically replaced by the new chat entity. `merge`
does not splice two chat transcripts: the existing chat is kept.

Response `200`: `SillyTavernImportResult`.

```json
{
  "jobId": "0198…",
  "sourceHash": "64 hex characters",
  "sourceName": "sillytavern-data.zip",
  "safetyBackupId": "pre-import-0198…",
  "reusedArchive": false,
  "selectedCategories": ["characters", "chats", "personas"],
  "conflictPolicy": "skip",
  "counts": {
    "characters": { "imported": 12, "reused": 0, "skipped": 1 },
    "chats": { "imported": 48, "reused": 0, "skipped": 2 },
    "messages": { "imported": 9321, "reused": 0, "skipped": 3 },
    "personas": { "imported": 2, "reused": 0, "skipped": 0 },
    "lorebooks": { "imported": 4, "reused": 0, "skipped": 0 },
    "loreEntries": { "imported": 318, "reused": 0, "skipped": 0 },
    "presets": { "imported": 9, "reused": 0, "skipped": 1 }
  },
  "warningCount": 4,
  "warnings": [{ "code": "SECRETS_SKIPPED", "path": "secrets.json" }]
}
```

Corrupted individual objects are skipped with a warning; an invalid/dangerous
ZIP is rejected as a whole.

`DELETE /api/v2/imports/sillytavern/:analysisId` deletes the unused staging
and answers `204`. A completed, cancelled or expired `analysisId` returns
`NOT_FOUND`.

#### Compatible one-step endpoint

`POST /api/v2/imports/sillytavern` is kept for existing clients. It accepts
the same multipart ZIP, imports all categories with the previous idempotent
behavior and answers `SillyTavernImportResult`. Re-sending the exact same
archive returns the last saved report with `reusedArchive: true`. The new UI
does not use this endpoint.

Errors: `BAD_REQUEST` (missing file, SillyTavern structure not found or a
dangerous ZIP), `FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE`, `CONFLICT`
(`IMPORT_ALREADY_RUNNING`, `IMPORT_ANALYSIS_ALREADY_RUNNING`,
`IMPORT_ANALYSIS_LIMIT_REACHED`), `NOT_FOUND` (`IMPORT_ANALYSIS_NOT_FOUND`),
`BACKUP_FAILED`, `ABORTED`, `MIGRATION_FAILED`.

### Plugins

All mutation endpoints require the usual local/remote API authorization. The
`.stplugin` package is a constrained ZIP with `plugin.json` at its root.

- `GET /api/v2/plugins` → `{ items: InstalledPlugin[], safeMode }`.
- `POST /api/v2/plugins/install` accepts a single multipart field `file` and
  returns `{ plugin, replaced }`. Installation validates path traversal,
  symlink/native/executable payloads, sizes, the manifest, entry points and
  permissions; directory replacement is atomic. A new package is not activated
  until consent.
- `POST /api/v2/plugins/install-git` with a JSON body
  `{ "url": "https://github.com/owner/repo", "ref": "v1.0.0"? }` downloads the
  repository archive over HTTPS (no git binary), validates it like a regular
  package and returns `{ plugin, replaced }`. Only `github.com` and
  `gitlab.com` are supported (GitLab requires an explicit `ref`). A `ref` from
  the body takes precedence over the ref from the URL. npm dependency
  installation is performed by the built-in installer (see Plugin SDK). The
  endpoint is disabled by the variable `NEOTA_PLUGIN_GIT_INSTALL=false` →
  `FORBIDDEN` with `params.reason = PLUGIN_GIT_INSTALL_DISABLED`.
- `POST /api/v2/plugins/:id/activate` with
  `{ "grantedPermissions": ["..."] }` requires an exact match with the
  permissions of the current manifest and returns `{ plugin }`.
- `POST /api/v2/plugins/:id/disable` immediately removes backend routes,
  providers, tokenizers, context strategies, event subscriptions and frontend
  registrations.
- `DELETE /api/v2/plugins/:id` first disables the runtime, then atomically
  detaches the package directory and removes the registry/storage entry;
  response `{ deleted }`.
- `POST /api/v2/plugins/runtime/safe-mode` stops all plugin runtimes;
  `DELETE` on the same path restarts only enabled/consented packages.
- `GET /api/v2/plugins/:id/capabilities` returns
  `{ items: CapabilityGrant[] }` — the plugin's active (not revoked and not
  expired) capability grants: `name`, `scope`, `revision`, `grantedAt`. Grants
  are created from the confirmed manifest capabilities on activation and
  revoked on disable/delete.

#### Plugin background jobs (rev4 stage 5)

All endpoints are gated by the `jobs.background` capability.

- `GET /api/v2/plugins/:id/jobs` → `{ items }`; each item: `jobId`, `name`,
  `status: 'active' | 'failed'`, `attempts`, `maxRetries?`, `lastError?`,
  `failedAt?`, `runAt?`, `intervalMs?`, `cron?`, `payload?`. `status:
'failed'` — the job is in the DLQ: it is never dispatched until brought back
  via `retry`.
- `POST /api/v2/plugins/:id/jobs` (body: `name`, exactly one of `runAt` /
  `intervalMs` / `cron`, `payload?`, `retries?` (0..20), `retryDelayMs?`
  (1s..1h)) → the created job. `cron` is a 5-field UTC expression
  (`minute hour dom month dow`, `*`, ranges, steps, lists; dow 0–7).
  With `retries > 0` dispatch is held until ack; backoff is exponential
  starting from `retryDelayMs` (default 5000), a missing ack for 5 minutes
  counts as a failure. Budget exhaustion → DLQ.
- `POST /api/v2/plugins/:id/jobs/:jobId/cancel` — delete the job.
- `POST /api/v2/plugins/:id/jobs/:jobId/ack` (body `{ ok, error? }`) →
  `{ acknowledged }`. Idempotent: an ack for a deleted/undispatched/DLQ job is
  a no-op without an error. `ok: false` — backoff-retry or DLQ.
- `POST /api/v2/plugins/:id/jobs/:jobId/retry` → the job is reset to
  `status: 'active'`, `attempts: 0`, dispatch on the next scan
  (404 for a nonexistent job).
- `DELETE /api/v2/plugins/:id/jobs/:jobId` → `{ deleted }`; deletes the job
  from any state, including the DLQ.
- Validation errors: `JOB_SCHEDULE_INVALID`, `JOB_SCHEDULE_EXCLUSIVE`,
  `JOB_CRON_INVALID`, `JOB_RETRIES_INVALID`, `JOB_RETRY_DELAY_INVALID`
  (all — 400).

#### Plugin OAuth connections

Plugin OAuth connections (rev4 §K5): a host-owned PKCE flow; tokens are stored
only on the server and never reach the sandbox. All mutation endpoints require
the `auth.connections` capability and an active enabled plugin outside safe
mode; otherwise `PLUGIN_NOT_FOUND`. Without the capability —
`PLUGIN_PERMISSION_DENIED` (`params.permission = "auth.connections"`).

- `GET /api/v2/plugins/:id/auth/connections` →
  `{ items: PluginAuthConnection[] }`. `PluginAuthConnection` is public
  metadata: `connectionId`, `serviceId`, `serviceName`, `scopes`, `status`
  (`pending`/`connected`/`expired`/`revoked`), `createdAt`, `updatedAt`. No
  tokens appear in the response.
- `POST /api/v2/plugins/:id/auth/connect` with
  `{ "serviceId": "com.example.idp", "scopes": ["profile.read"]? }` starts or
  reuses a connection. `serviceId` must be declared in the manifest's
  `authClients` (otherwise `PLUGIN_INVALID`,
  `params.reason = auth-service-not-declared`). `scopes` default to the ones
  from the client descriptor. Response:
  `{ connectionId, status, authorizationUrl }`. An already-connected service
  resolves immediately with `authorizationUrl: null`; otherwise the connection
  is created as `pending` and `authorizationUrl` is the IdP page (PKCE S256,
  `state`, a one-time `redirect_uri` to this same host) that the user opens.
- `POST /api/v2/plugins/:id/auth/revoke` with
  `{ "connectionId": "..." }` → `{ ok: true }`. The server deletes the token
  (`status = revoked`) and sends the `plugin.auth.revoked` event. A
  nonexistent connection — `BAD_REQUEST` (`AUTH_CONNECTION_NOT_FOUND`).
- `POST /api/v2/plugins/:id/auth/fetch` — an authorized fetch proxy for the
  web sandbox: `{ url, connectionId, method?, headers?, bodyText? }` →
  `{ status, headers, bodyText }`. The server checks the network allowlist
  (`network:*`, `network:<hostname>`, or the `network.domains` capability —
  `{kind:'all'}` or `{kind:'origins', origins:[origin]}`), resolves the
  connection token and injects `Authorization` server-side. Redirects are
  forbidden, timeout 15 s, response ≤ 1 MiB. Errors: `BAD_REQUEST`
  (`URL_INVALID`, `URL_SCHEME_NOT_ALLOWED`, `METHOD_INVALID`,
  `AUTH_CONNECTION_NOT_FOUND`, `AUTH_NOT_CONNECTED`, `AUTH_EXPIRED`,
  `AUTH_REVOKED`, `FETCH_TIMEOUT`, `FETCH_FAILED`), `TIMEOUT`,
  `PLUGIN_PERMISSION_DENIED`.
- `GET /api/v2/plugins/:id/auth/callback` — the IdP callback (not the
  sandbox): the one-time `state` proves the flow, so it does not require an
  enabled plugin (a half consent survives a plugin restart; when disabled, the
  state is not burned). Always answers with a browser redirect to
  `#/plugin-auth-result?pluginId=…&status=connected|error&…`. The events
  `plugin.auth.connected` / `plugin.auth.expired` are published to the event
  bus.

`InstalledPlugin` additionally carries `source` (`{type:'zip'}` or
`{type:'git', url, ref?, resolvedRef?}`) and `dependencies`
(`[{name, version, tarball?, integrity?}]`) — the provenance of installed
dependencies. The fields are nullable and absent for packages installed before
migration 0015.

An update with new permissions moves the package to `needs-consent`; the
previous runtime does not keep running with a stale grant. Errors:
`PLUGIN_INVALID`, `PLUGIN_NOT_FOUND`, `PLUGIN_PERMISSION_DENIED`,
`PLUGIN_LOAD_FAILED`, `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`, `CONFLICT`,
`PLUGIN_SOURCE_UNSUPPORTED`, `PLUGIN_SOURCE_INVALID`,
`PLUGIN_DEPS_UNSUPPORTED`, `PLUGIN_DEPS_CONFLICT`, `PLUGIN_DEPS_FAILED`,
`PLUGIN_DEPS_FORBIDDEN_FILE`, `FORBIDDEN` (git install disabled). Activating
a manifest with `apiVersion: 3` (vNext runtime, ADR-0027) starts a Worker in a
separate Plugin Runtime process: the plugin executes in a hardened SES
Compartment without Node authority, capability calls are resolved by the Main
Host broker (Stage A, spawn integration complete). `PLUGIN_RUNTIME_UNAVAILABLE`
(503) is returned only when the runtime process could not be started;
`PLUGIN_LOAD_FAILED` — on errors building/loading the signed module graph
(`moduleErrorCode` in `params`).

Events §18 (Stage F part 10): the worker subscribes via
`sdk.events.subscribe({ name, cursor? })` (async iterator, `close()` /
`events.unsubscribe`); the Main Host emits events through
`VNextRuntimeService.emitEvent(name, payload)`, and they are delivered to the
worker via the `HOST_BRIDGE_MESSAGE` wire frame (0x16, host→runtime→worker,
app-level; the reverse direction is `BRIDGE_MESSAGE` 0x15). Subscriptions live
host-side (up to 8 per plugin, core channel without a grant); routing is
cleared when the worker terminates.

Frontend host endpoints `/api/v2/plugins/:id/sandbox`,
`sandbox.js` and `assets/*` serve only the installed package. A native
frontend executes in an iframe with `sandbox="allow-scripts"`, a separate CSP
and no same-origin capability. `/api/v2/plugins/:id/legacy.js` is available
only to an active package with confirmed `legacy.trusted`; its code executes
in the main window and is therefore considered trusted. Backend routes are
available only as `/api/plugins/{pluginId}/...`.

#### Frontend prompt interceptor rendezvous

`POST /api/v2/chats/:id/generate` accepts
`frontendInterceptors: true`. After server-side context shifting the SSE may
emit a one-time event:

```json
{
  "type": "plugin_intercept",
  "requestId": "…",
  "responseToken": "…",
  "chatId": "…",
  "messages": [{ "id": "…", "role": "user", "content": "…" }],
  "meta": {}
}
```

The SPA runs the consented `prompt.modify` interceptors sequentially and sends
the result to `POST /api/v2/plugin-intercepts/:requestId` together with the
`responseToken`. The request ID is one-time, at most 32 pending requests are
kept at the same time, the browser timeout is 2.5 seconds, the pipeline
timeout is 3 seconds. An error or a missing response is isolated; the server
restores the deleted system/pinned/current-user messages and re-checks the
token budget.

#### Plugin events

A native backend can subscribe to core events (`chat.created`, `chat.opened`,
`chat.message.created/deleted`, `generation.started/delta/finished/error`)
through the SDK event bus. A custom event can only be published with the
plugin's own ID as prefix, for example `author.plugin.cache-invalidated`; the
payload must be JSON-safe and no larger than 256 KiB; one runtime can be
subscribed to at most 128 event names at the same time. Subscriptions are
removed on disable/crash/shutdown.
The browser SSE stream additionally relays `plugin.capability.revoked`
(payload `{ pluginId, name, revision }`): the web host revokes grants from a
live sandbox. The event is declared in the ready-frame whitelist on par with
core events. The installation lifecycle is relayed as `plugin.installed`,
`plugin.activated`, `plugin.disabled`, `plugin.deleted` (payload
`{ pluginId }`): the web host invalidates the `['plugins']` cache so that
sandbox frames and overlay hit surfaces disappear immediately after
uninstall/disable in any client, including other tabs.

OAuth connections publish `plugin.auth.connected`, `plugin.auth.revoked` and
`plugin.auth.expired` (payload `{ pluginId, connectionId, serviceId }`). A
plugin receives them via `api.events.subscribe`; the web host uses them to
update the connections dialog instantly without polling.

## Connection profiles

Connection profiles are versioned `@neotavern/contracts` TypeBox resources used to
apply a repeatable provider, secret, and generation configuration without
exposing credentials.

- `GET /api/v2/connection-profiles` returns `{ items: ConnectionProfile[] }`.
- `POST /api/v2/connection-profiles` accepts `ConnectionProfileCreate` and
  returns `{ id: string }`.
- `GET /api/v2/connection-profiles/:id`, `PATCH /api/v2/connection-profiles/:id`
  and `DELETE /api/v2/connection-profiles/:id` retrieve, update, and remove a
  profile. `PATCH` accepts `ConnectionProfileUpdate`; delete returns
  `{ ok: true }`.
- `POST /api/v2/connection-profiles/:id/apply` returns the active target plus
  the `appliedFields` and `excludedFields` names.

`includeHeaders` is write-only. Read responses contain a stable mask; sending
that same mask back preserves the stored value. Diagnostics and error payloads
never return the clear-text header. Apply reads the private stored value only
inside the server process.

Apply validates the target provider, selected secret, generation preset and
mode before opening one SQLite transaction. It writes the provider settings,
active secret, active generation preset and derived generation defaults as one
unit, or writes none of them. `source` is a compatibility check only and never
changes a provider kind. An `exclude` flag wins over a profile field.

Profile stop strings extend the provider stop strings. The prompt pipeline
combines them with the instruct-format and explicit generation stop strings,
preserving order and removing duplicates. `startReplyWith` becomes
`GenerationRequest.assistantPrefill`; built-in adapters serialize it as the
opening assistant response. A plugin provider must explicitly advertise
prefill support, otherwise apply fails rather than silently changing behavior.

Failures use stable API error codes: `CONNECTION_PROFILE_NOT_FOUND`,
`CONNECTION_PROFILE_TARGET_REQUIRED`, `CONNECTION_PROFILE_MODE_MISMATCH`,
`CONNECTION_PROFILE_SOURCE_MISMATCH`, `CONNECTION_PROFILE_SECRET_INVALID`,
and `CONNECTION_PROFILE_PREFILL_UNSUPPORTED`.

## Versioning

New backward-compatible fields stay within `/api/v2`. Breaking changes mean a
new major API version and a migration guide.
