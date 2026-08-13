---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0019-chat-cas-drafts-outbox.md
---

# ADR-0019: Chat CAS, server-side drafts and outbox for chat writes (rev4 stage 3)

## Context

Streaming message writes (plugin drafts, `type()` emulation) worked before this revision as "create a message with role `plugin` and overwrite it with PATCH up to 10 times per second". This creates four classes of problems:

1. **DB/SSE churn.** The full message content is rewritten at up to 10 Hz: each flush is an UPDATE of the row plus `chat.message.updated` on the SSE stream.
2. **Races.** The overwrite is unconditional: two writers (UI editor and streaming host) silently clobber each other; the client has no way to know that its edit lost.
3. **Garbage after a crash.** If the host crashes between create and commit, a half-written message with role `plugin` (empty or truncated) remains in the chat. Reconnect does not restore state.
4. **No idempotency.** A retry after a lost response duplicates the message; there is neither a sequence nor a deduplication key.

Alternatives:

1. **Leave as is** — technical debt accumulates; "10 Hz" stays an observable part of the protocol.
2. **CAS only (revision)** — solves races, but not churn or garbage.
3. **CAS + server-side draft object + outbox idempotency** (chosen) — each problem class is closed on its own layer.

## Decision

### 1. CAS: `revision` on messages

- `messages.revision INTEGER NOT NULL DEFAULT 1`, bumped on every update (`revision + 1`, atomically in the same UPDATE), plus `updated_at`.
- `PATCH /chats/:id/messages/:messageId` accepts an optional `expectedRevision`; atomic `UPDATE … WHERE id = ? AND revision = ?` (no check-then-update window). A mismatch → 409 `MESSAGE_CONFLICT` with `currentRevision`; the writer re-reads and retries.
- `chat.message.updated` carries the current `revision` — subscribers see the version they are working with.
- App editors (UI edit, generate regenerate) write unconditionally: they own their message; CAS is the contract for concurrent programmatic writers.

### 2. Server-side draft object (draft-commit)

- Table `message_drafts` (STRICT): role, content, name, meta, monotonic `sequence`, CAS `revision`, `committed_message_id`, timestamps.
- `POST /chats/:id/drafts` → `PATCH …/drafts/:id` (sequence: a repeated PATCH with the old sequence is an idempotent no-op) → `POST …/commit` (atomic message materialization + `chat.message.created`) or `DELETE …/drafts/:id` (abandon).
- **Until a draft is committed it is not in the message list** — a writer crash leaves only a draft row.
- **Commit is idempotent**: the row is kept with `committed_message_id`; a retry returns the same `messageId` (`alreadyCommitted: true`).
- **Sweep**: at server start and on an hourly timer, committed drafts older than 1 h and uncommitted drafts older than 24 h are deleted. No hidden destructive operations on read (AGENTS §11).
- 10 Hz remains the host's internal policy: the sandbox sees only `start/append/commit/abort`; the wire contract does not promise a frequency.

### 3. Outbox: idempotent writes

- `messages.idempotency_key` (unique per chat, partial index): a repeated `POST …/messages` with the same key returns the original message.
- `api.chats.append({ …, idempotencyKey })` forwards the key from the sandbox through the kernel port to REST (the plugin chooses the key itself for retry semantics).
- Draft writes are structurally idempotent: draftId is the anchor, sequence the order, commit — `alreadyCommitted`.

## Consequences

- A streaming writer never touches committed rows again: the SSE stream gets exactly one `chat.message.created` per message.
- Concurrent writers get a deterministic `MESSAGE_CONFLICT` instead of silently losing an edit.
- After a crash a draft remains (sweep garbage), not an empty message.
- Retry after reconnect does not duplicate appends or commits.
- Cost: one table + two columns, four new REST routes, a sweep timer. `revision`/`updatedAt` added to `Message` (contract break at the type level — clients must update types; the wire schema extends additively).

## Migration

`0018_chat_cas_and_drafts` — additive DDL (ALTER TABLE + CREATE TABLE + indexes); backup before applying on a populated DB is done by the standard migration runner. Rollback — restore the backup.
