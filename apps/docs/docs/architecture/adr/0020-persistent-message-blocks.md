---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0020-persistent-message-blocks.md
---

# ADR-0020: Persistent message blocks (rev4 stage 4)

## Context

Plugin blocks (`api.blocks`) attach to chat messages and mount DOM content in the plugin's sandbox. Before this revision, attachments (including a renderer's serialized state) were stored only in a module-level Map in the host cache: a page reload lost both the binding and the state, and a second client never saw other clients' blocks at all. At the same time, renderers are host state by nature (functions live in the plugin's live session) — their persistence is impossible and unnecessary.

Alternatives:

1. **Keep in-memory** — blocks disappear after reload; the "host stores the attachment" contract stays temporary.
2. **Client-side persistence (localStorage)** — state is not shared between clients and does not survive a machine change.
3. **Server table + REST + host cache** (chosen) — the attachment is durable data; the renderer is session-bound host state. The split follows the nature of the entities.

## Decision

1. **Table `message_block_attachments`** (STRICT, migration 0019): id, message_id (FK → messages ON DELETE CASCADE), plugin_id (FK → plugin_registry ON DELETE CASCADE), block_type, renderer_id, descriptor_json, serialized_state_json, created_at/updated_at. Cascades give uninstall/delete cleanup without code.
2. **REST**: `GET /chats/:id/blocks?messageIds=` (batch, ≤100, ownership filtering by chat), `POST /chats/:id/messages/:messageId/blocks`, `PATCH /blocks/:blockId` (descriptor/state; `null` clears), `DELETE /blocks/:blockId`. PATCH/DELETE are not scoped by chat: the host knows only the blockId (the attachment is mounted from the cache without a chat binding).
3. **Host cache as a view**: `ensureBlocksLoaded(chatId, messageId)` pulls attachments into the cache (once per session) and sends `BLOCKS_CHANGED`; `attach` POSTs to the server first, then updates the cache; `freeze` on a real unmount (overscan, chat switch) PATCHes the serialized state — a reload survives both the binding and the state.
4. **Cross-client synchronization**: mutations send `chat.message.block.changed` (SSE whitelist + kernel events allowlist); the host invalidates the message cache and re-reads from the server — a second client sees other clients' blocks and their updates.
5. **Renderer reload race**: an attachment can load before the plugin re-registers its renderer. The empty slot subscribes to `BLOCK_RENDERER_REGISTERED` (window event from `registerRenderer`) and mounts in place — no remount storm, no freeze cycles.

## Consequences

- Blocks survive reload and are visible in any client; renderer state is restored via `serialize`/`restore`.
- Plugin uninstall and message deletion clean attachments by cascade — no manual code, no garbage.
- Freeze persistence fires only on real unmounts: remount storms (which overwrote fresh server state with stale DOM) are excluded by construction.
- Renderers remain host state: an attachment without a live renderer shows an empty slot (explicit degradation, rev4 invariant 8).
- Cost: one table, four REST routes, one event in two whitelists, a host cache with a per-session load marker.

## Migration

`0019_message_block_attachments` — additive DDL (CREATE TABLE + indexes); backup before applying on a populated DB — standard runner. Rollback — restore the backup.
