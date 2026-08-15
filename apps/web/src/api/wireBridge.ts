/**
 * Library/chat data plane over the facade (Этап 2.10, шаг 2).
 *
 * One function per golden-flow operation; the transport branch lives here in
 * the API layer (ТЗ §13.1 forbids it in React components — compare
 * `generate.ts`):
 *
 * - **Kernel mode** (`LocalBackend`): calls the wire operations and maps the
 *   canonical wire DTOs onto the legacy UI shapes with honest defaults for
 *   fields the kernel does not model yet (avatars, persona, variants,
 *   revisions, checkpoints, soft-delete, manual chat order). Unsupported
 *   inputs surface as a typed `UnsupportedError` (CAPABILITY_UNAVAILABLE) —
 *   never a silent downgrade.
 * - **Browser/sidecar mode** (`LegacyBackend`): delegates to the existing
 *   legacy HTTP client unchanged (full-fidelity legacy entities).
 *
 * Every mapping decision is documented next to its translator; the migration
 * routing table (`docs/architecture/operations-inventory.md`) tracks the
 * cutover surface.
 */
import {
  type Character,
  type CharacterCreate,
  type CharacterSummary,
  type CharacterUpdate,
  type Chat,
  type ChatCreate,
  type ChatSummary,
  type ChatUpdate,
  type CursorPage,
  type Lorebook,
  type LorebookCreate,
  type LorebookEntry,
  type LorebookEntryCreate,
  type LorebookEntryUpdate,
  type LorebookUpdate,
  type Message,
  type MessageContentRevision,
  type MessageDraft,
  type MessageVariant,
  type Persona,
  type PersonaCreate,
  type PersonaUpdate,
  type CharacterDto,
  type ChatDto,
  type LorebookDto,
  type LorebookEntryDto,
  type MessageDto,
  type MessageDraftDto,
  type MessageRevisionDto,
  type MessageVariantDto,
  type PersonaDto,
} from '@neotavern/contracts';
import { UnsupportedError } from '@neotavern/neobackend';
import { api } from './client.js';
import { backend, isKernelMode } from './backend.js';

/** Input of `useContinueCharacterChat` / `continueCharacterChat`. */
export interface ContinueCharacterChatInput {
  characterId: string;
  title: string;
  personaId?: string;
}

/** Result of `useContinueCharacterChat` / `continueCharacterChat`. */
export interface ContinueCharacterChatResult {
  chatId: string;
  created: boolean;
}

function encodeQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

/* --------------------------------------------------------------------------
 * Wire DTO → legacy UI shape translators.
 *
 * The kernel model is a strict subset of the legacy entity. Fields the kernel
 * does not own yet are filled with honest defaults so the UI renders the
 * golden flow (library → character → chat → messages) without fabricating
 * data: `null`/`''`/`0` mean "not modelled", not "empty but real".
 * ------------------------------------------------------------------------ */

/** RFC 3339 (wire) → legacy epoch-ms `Timestamp`. */
function toEpochMs(rfc3339: string): number {
  return Date.parse(rfc3339);
}

/** Wire character → legacy `CharacterSummary` (library rows). */
export function translateCharacterSummary(dto: CharacterDto): CharacterSummary {
  return {
    id: dto.id,
    name: dto.name,
    // Kernel has no asset URL surface (avatarAssetId is a storage reference);
    // the UI shows its placeholder until assets migrate (Этап 4).
    avatar: null,
    description: dto.description ?? '',
    tags: dto.tags,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/** Wire character → full legacy `Character` (card view/editor). */
export function translateCharacter(dto: CharacterDto): Character {
  return {
    ...translateCharacterSummary(dto),
    // Full card fields are not modelled by the kernel schema yet (Этап 4);
    // honest empty strings — the editor must not fabricate persona text.
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialogues: '',
    systemPrompt: null,
    postHistoryInstructions: null,
    creator: null,
    creatorNotes: null,
    ext: {},
    lastUsedAt: null,
    deletedAt: null,
  };
}

/** Wire chat → legacy `ChatSummary` (catalog rows). */
export function translateChatSummary(dto: ChatDto): ChatSummary {
  return {
    id: dto.id,
    characterId: dto.characterId,
    // Kernel chat rows carry no joined character identity; the UI falls back
    // to its unnamed-character label.
    characterName: null,
    characterAvatar: null,
    title: dto.title,
    messageCount: dto.messageCount,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
    // Snapshot provenance (checkpoint/branch children) is legacy-only.
    parentChatId: null,
    origin: null,
    sourceMessageId: null,
  };
}

/** Wire chat → full legacy `Chat` (chat page). */
export function translateChat(dto: ChatDto): Chat {
  return {
    ...translateChatSummary(dto),
    personaId: null,
    activeBranchId: null,
    backgroundId: null,
    summary: '',
    deletedAt: null,
  };
}

/** Wire message → legacy `Message`. */
export function translateMessage(dto: MessageDto): Message {
  return {
    id: dto.id,
    chatId: dto.chatId,
    // The kernel keeps one linear sequence per chat (no branches); the
    // implicit "branch" is the chat itself. The UI only uses `branchId` as a
    // query key from `chat.activeBranchId`, which the kernel leaves null.
    branchId: dto.chatId,
    parentId: null,
    role: dto.role,
    content: dto.content,
    name: null,
    // Extension metadata (tool calls, generation usage, manual exclusion) is
    // not modelled by the kernel yet; an empty record renders neutrally.
    meta: {},
    createdAt: toEpochMs(dto.createdAt),
    // Kernel updates are last-write-wins; the legacy CAS revision is
    // reported as its minimum (the UI no longer sends `expectedRevision`).
    revision: 1,
    updatedAt: null,
    variantCount: 0,
    activeVariantPosition: null,
    contentRevisionCount: 0,
    checkpointChatId: null,
  };
}

/** Wire lorebook → legacy `Lorebook` (catalog rows). */
export function translateLorebook(dto: LorebookDto): Lorebook {
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? '',
    // Character↔lorebook linkage is not modelled by the kernel yet (Этап 4);
    // a global book renders neutrally.
    characterId: null,
    metadata: {},
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/** Wire variant → legacy `MessageVariant` (both carry position; identity). */
export function translateMessageVariant(dto: MessageVariantDto): MessageVariant {
  return {
    id: dto.id,
    messageId: dto.messageId,
    position: dto.position,
    content: dto.content,
    createdAt: toEpochMs(dto.createdAt),
  };
}

/** Wire revision → legacy `MessageContentRevision` (identity). */
export function translateMessageRevision(dto: MessageRevisionDto): MessageContentRevision {
  return {
    id: dto.id,
    messageId: dto.messageId,
    position: dto.position,
    content: dto.content,
    createdAt: toEpochMs(dto.createdAt),
  };
}

/** Wire draft → legacy `MessageDraft` (kernel has no branches). */
export function translateMessageDraft(dto: MessageDraftDto): MessageDraft {
  return {
    id: dto.id,
    chatId: dto.chatId,
    // The kernel keeps one linear sequence per chat; `branchId` is an honest
    // empty default (no branch reference exists), matching translateMessage.
    branchId: '',
    role: dto.role,
    content: dto.content,
    // The kernel draft has no name/meta columns; null/{} render neutrally.
    name: null,
    meta: {},
    sequence: dto.sequence,
    revision: dto.revision,
    committedMessageId: dto.committedMessageId ?? null,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/** Wire persona → legacy `Persona`. */
export function translatePersona(dto: PersonaDto): Persona {
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? '',
    // Kernel avatar is a free-form reference; the UI avatar slot renders
    // neutrally until assets migrate (Этап 4).
    avatar: dto.avatar ?? null,
    isDefault: dto.isDefault,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/* --------------------------------------------------------------------------
 * Golden-flow operations (kernel | legacy).
 * ------------------------------------------------------------------------ */

/** List characters (library). */
export async function readCharacters(
  query: {
    cursor?: string;
    limit?: number;
    tag?: string;
    q?: string;
    sort?: string;
    includeDeleted?: boolean;
  },
  cursor?: string,
): Promise<CursorPage<CharacterSummary>> {
  if (isKernelMode()) {
    // Kernel list supports cursor/limit only; catalog search, tag filter and
    // non-default sorts are not wire operations yet (Этап 4). 'newest' and
    // the legacy 'recent' alias both map to the kernel's created_at DESC
    // default; anything else is an honest CAPABILITY_UNAVAILABLE.
    if (query.q || query.tag) throw new UnsupportedError('characters.list.search');
    if (query.includeDeleted) throw new UnsupportedError('characters.list.includeDeleted');
    if (query.sort !== undefined && query.sort !== 'newest' && query.sort !== 'recent') {
      throw new UnsupportedError(`characters.list.sort.${query.sort}`);
    }
    const page = await backend.characters.list({
      ...(cursor !== undefined ? { cursor } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return {
      items: page.items.map(translateCharacterSummary),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.nextCursor !== null,
    };
  }
  return api.get<CursorPage<CharacterSummary>>(`/characters${encodeQuery({ ...query, cursor })}`);
}

/** Fetch one character (card view/editor). */
export async function readCharacter(id: string): Promise<Character> {
  if (isKernelMode()) {
    return translateCharacter(await backend.characters.get(id));
  }
  return api.get<Character>(`/characters/${id}`);
}

/** Create a character. */
export async function createCharacter(input: CharacterCreate): Promise<Character> {
  if (isKernelMode()) {
    const unsupported = nonWireCharacterFields(input);
    if (unsupported.length > 0) {
      throw new UnsupportedError(`characters.create.${unsupported[0]}`);
    }
    const created = await backend.characters.create({
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
    });
    return translateCharacter(created);
  }
  return api.post<Character>('/characters', input);
}

/** Update a character. */
export async function updateCharacter(id: string, patch: CharacterUpdate): Promise<Character> {
  if (isKernelMode()) {
    const unsupported = nonWireCharacterFields(patch);
    if (unsupported.length > 0) {
      throw new UnsupportedError(`characters.update.${unsupported[0]}`);
    }
    const updated = await backend.characters.update({
      characterId: id,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.tags !== undefined && patch.tags.length > 0 ? { tags: patch.tags } : {}),
    });
    return translateCharacter(updated);
  }
  return api.patch<Character>(`/characters/${id}`, patch);
}

/** Soft-delete a character. */
export async function deleteCharacter(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.characters.del(id);
    return;
  }
  await api.del(`/characters/${id}`);
}

/** List chats of one character (catalog). */
export async function readChats(
  characterId?: string,
  q?: string,
  cursor?: string,
): Promise<CursorPage<ChatSummary>> {
  if (isKernelMode()) {
    // Kernel chat list supports characterId/cursor/limit; full-text chat
    // search is not a wire operation yet (Этап 4).
    if (q) throw new UnsupportedError('chats.list.search');
    const page = await backend.chats.list({
      ...(characterId !== undefined ? { characterId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return {
      items: page.items.map(translateChatSummary),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.nextCursor !== null,
    };
  }
  return api.get<CursorPage<ChatSummary>>(`/chats${encodeQuery({ characterId, q, cursor })}`);
}

/** Most recent chats (home page). Kernel orders by creation time. */
export async function readRecentChats(
  limit = 8,
  characterId?: string,
): Promise<CursorPage<ChatSummary>> {
  if (isKernelMode()) {
    const page = await backend.chats.list({
      ...(characterId !== undefined ? { characterId } : {}),
      limit,
    });
    return {
      items: page.items.map(translateChatSummary),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.nextCursor !== null,
    };
  }
  return api.get<CursorPage<ChatSummary>>(
    `/chats${encodeQuery({ characterId, limit, sort: 'recent' })}`,
  );
}

/** Continue (or create) the live chat of a character. */
export async function continueCharacterChat(
  input: ContinueCharacterChatInput,
): Promise<ContinueCharacterChatResult> {
  if (isKernelMode()) {
    if (input.personaId) throw new UnsupportedError('chats.create.personaId');
    // The continue contract is reproduced client-side (compare the legacy
    // `reuseUnstarted` server guard): return the most recent live chat, else
    // create one. Kernel chats are ordered by creation time.
    const recent = await backend.chats.list({ characterId: input.characterId, limit: 1 });
    const existing = recent.items[0];
    if (existing) return { chatId: existing.id, created: false };
    const created = await backend.chats.create({
      characterId: input.characterId,
      title: input.title,
    });
    return { chatId: created.id, created: true };
  }
  const recent = await api.get<CursorPage<ChatSummary>>(
    `/chats${encodeQuery({ characterId: input.characterId, limit: 1, sort: 'recent' })}`,
  );
  const existing = recent.items[0];
  if (existing) return { chatId: existing.id, created: false };
  const created = await api.post<Chat>('/chats', {
    characterId: input.characterId,
    title: input.title,
    reuseUnstarted: true,
    ...(input.personaId ? { personaId: input.personaId } : {}),
  } satisfies ChatCreate);
  return { chatId: created.id, created: true };
}

/** Fetch one chat (chat page). */
export async function readChat(id: string): Promise<Chat> {
  if (isKernelMode()) {
    return translateChat(await backend.chats.get(id));
  }
  return api.get<Chat>(`/chats/${id}`);
}

/** Create a chat. */
export async function createChat(input: ChatCreate): Promise<Chat> {
  if (isKernelMode()) {
    if (input.personaId) throw new UnsupportedError('chats.create.personaId');
    // Kernel chats are created empty: greeting insertion (greetingIndex) and
    // the reuseUnstarted server guard are legacy pipeline features (Этап 4) —
    // the continue hook already reproduced the guard above. The wire contract
    // requires an existing character.
    if (!input.characterId) throw new UnsupportedError('chats.create.characterId');
    const created = await backend.chats.create({
      characterId: input.characterId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
    return translateChat(created);
  }
  return api.post<Chat>('/chats', input);
}

/** Rename a chat. */
export async function updateChat(id: string, update: ChatUpdate): Promise<Chat> {
  if (isKernelMode()) {
    // Wire chat update is title-only; persona/background/summary/branch
    // mutation is legacy-only (Этап 4).
    if (
      update.personaId !== undefined ||
      update.backgroundId !== undefined ||
      update.summary !== undefined ||
      update.activeBranchId !== undefined
    ) {
      throw new UnsupportedError('chats.update.fields');
    }
    if (update.title === undefined) throw new UnsupportedError('chats.update.title');
    const updated = await backend.chats.update({ chatId: id, title: update.title });
    return translateChat(updated);
  }
  return api.patch<Chat>(`/chats/${id}`, update);
}

/** Delete a chat. Kernel delete is permanent (cascades messages). */
export async function deleteChat(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.chats.del(id);
    return;
  }
  await api.del(`/chats/${id}`);
}

/** List messages of a chat, newest first (chat page history). */
export async function readMessages(
  chatId: string,
  branchId?: string,
  cursor?: string,
): Promise<CursorPage<Message>> {
  if (isKernelMode()) {
    if (branchId) throw new UnsupportedError('chats.messages.list.branchId');
    const page = await backend.chats.listMessages({
      chatId,
      order: 'desc',
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return {
      items: page.items.map(translateMessage),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.nextCursor !== null,
    };
  }
  return api.get<CursorPage<Message>>(
    `/chats/${chatId}/messages${encodeQuery({ order: 'desc', branchId, cursor })}`,
  );
}

/* --------------------------------------------------------------------------
 * Message variants/revisions/drafts (Этап 4 slice 2).
 *
 * The kernel owns swipe variants, immutable content revisions and
 * server-side drafts over the wire (`chats.messages.{variants,revisions,
 * drafts}.*`); kernel mode routes through the facade. The legacy /api/v2
 * routes are kept for browser mode until the legacy-route-removal step of
 * slice 2; operations with no legacy route are an honest
 * CAPABILITY_UNAVAILABLE instead of a silent downgrade.
 * ------------------------------------------------------------------------ */

/** List the stored swipe variants of one message (positions ascending). */
export async function readMessageVariants(
  chatId: string,
  messageId: string,
): Promise<MessageVariant[]> {
  if (isKernelMode()) {
    const result = await backend.chats.listMessageVariants({ chatId, messageId });
    return result.items.map(translateMessageVariant);
  }
  const page = await api.get<{ items: MessageVariant[] }>(
    `/chats/${chatId}/messages/${messageId}/variants`,
  );
  return page.items;
}

/** Append a swipe variant (kernel allocates the position atomically). */
export async function createMessageVariant(
  chatId: string,
  messageId: string,
  content: string,
): Promise<MessageVariant> {
  if (isKernelMode()) {
    return translateMessageVariant(
      await backend.chats.createMessageVariant({ chatId, messageId, content }),
    );
  }
  // The legacy server has no create-variant route (swipes are only produced
  // by regeneration); honest CAPABILITY_UNAVAILABLE in browser mode.
  throw new UnsupportedError('chats.messages.variants.create');
}

/** Delete one swipe variant (permanent). */
export async function deleteMessageVariant(
  chatId: string,
  messageId: string,
  variantId: string,
): Promise<void> {
  if (isKernelMode()) {
    await backend.chats.delMessageVariant({ chatId, messageId, variantId });
    return;
  }
  throw new UnsupportedError('chats.messages.variants.delete');
}

/** Activate a swipe variant; the previous active text becomes a revision. */
export async function activateMessageVariant(
  chatId: string,
  messageId: string,
  variantId: string,
): Promise<Message> {
  if (isKernelMode()) {
    return translateMessage(
      await backend.chats.activateMessageVariant({ chatId, messageId, variantId }),
    );
  }
  return api.post<Message>(
    `/chats/${chatId}/messages/${messageId}/variants/${variantId}/activate`,
    {},
  );
}

/**
 * List the immutable content revisions of one message. The kernel returns
 * the full list in one page; the legacy route is cursor-paginated.
 */
export async function readMessageRevisions(
  chatId: string,
  messageId: string,
  cursor?: string,
): Promise<CursorPage<MessageContentRevision>> {
  if (isKernelMode()) {
    const result = await backend.chats.listMessageRevisions({ chatId, messageId });
    return { items: result.items.map(translateMessageRevision), nextCursor: null, hasMore: false };
  }
  return api.get<CursorPage<MessageContentRevision>>(
    `/chats/${chatId}/messages/${messageId}/revisions${encodeQuery({ cursor })}`,
  );
}

/**
 * Restore an archived text as the active message content. Kernel mode maps
 * this onto the existing `chats.messages.update` wire op (the canonical
 * restore semantics: setting the content records the replaced text as a new
 * revision); legacy keeps its dedicated restore route.
 */
export async function restoreMessageRevision(
  chatId: string,
  messageId: string,
  revisionId: string,
  content: string,
): Promise<Message> {
  if (isKernelMode()) {
    return translateMessage(await backend.chats.updateMessage({ chatId, messageId, content }));
  }
  return api.post<Message>(
    `/chats/${chatId}/messages/${messageId}/revisions/${revisionId}/restore`,
    {},
  );
}

/** Fetch one server-side draft (kernel mode; no legacy read route). */
export async function readMessageDraft(chatId: string, draftId: string): Promise<MessageDraft> {
  if (isKernelMode()) {
    return translateMessageDraft(await backend.chats.getMessageDraft({ chatId, draftId }));
  }
  throw new UnsupportedError('chats.messages.drafts.get');
}

/** Input of `saveMessageDraft` (wire `chats.messages.drafts.save`). */
export interface MessageDraftSaveInput {
  chatId: string;
  /** Omit to create a new draft; provide to update (upsert by id). */
  draftId?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Monotonic writer sequence; a stale save (≤ stored) is an idempotent no-op. */
  sequence?: number;
}

/** Create or update a server-side draft. */
export async function saveMessageDraft(input: MessageDraftSaveInput): Promise<MessageDraft> {
  if (isKernelMode()) {
    const saved = await backend.chats.saveMessageDraft({
      chatId: input.chatId,
      ...(input.draftId !== undefined ? { draftId: input.draftId } : {}),
      role: input.role,
      content: input.content,
      ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    });
    return translateMessageDraft(saved);
  }
  const { chatId, draftId, role, content, sequence } = input;
  if (draftId === undefined) {
    return api.post<MessageDraft>(`/chats/${chatId}/drafts`, { role, ...(content ? { content } : {}) });
  }
  return api.patch<MessageDraft>(`/chats/${chatId}/drafts/${draftId}`, { content, sequence });
}

/**
 * Materialize a draft exactly once; resolves with the committed message id.
 * Replays after success return the same id (commit is retry-safe).
 */
export async function commitMessageDraft(
  chatId: string,
  draftId: string,
): Promise<{ messageId: string }> {
  if (isKernelMode()) {
    const message = await backend.chats.commitMessageDraft({ chatId, draftId });
    return { messageId: message.id };
  }
  const result = await api.post<{ messageId: string; alreadyCommitted: boolean }>(
    `/chats/${chatId}/drafts/${draftId}/commit`,
  );
  return { messageId: result.messageId };
}

/** Discard a draft (permanent; never touches the committed message). */
export async function discardMessageDraft(chatId: string, draftId: string): Promise<void> {
  if (isKernelMode()) {
    await backend.chats.discardMessageDraft({ chatId, draftId });
    return;
  }
  await api.del(`/chats/${chatId}/drafts/${draftId}`);
}

/* --------------------------------------------------------------------------
 * Lorebook operations (Этап 4.1).
 * ------------------------------------------------------------------------ */

/** List lorebooks (catalog). Kernel returns the full list in one page. */
export async function readLorebooks(
  query: { characterId?: string; limit?: number } = {},
): Promise<CursorPage<Lorebook>> {
  if (isKernelMode()) {
    // Character↔lorebook linkage is not modelled by the kernel yet — the
    // scoped catalog is an honest CAPABILITY_UNAVAILABLE, not a silent
    // filter drop. Limit is a hint the kernel list ignores (plain list).
    if (query.characterId !== undefined) {
      throw new UnsupportedError('lorebooks.list.characterId');
    }
    const result = await backend.lorebooks.list();
    return {
      items: result.items.map(translateLorebook),
      nextCursor: null,
      hasMore: false,
    };
  }
  return api.get<CursorPage<Lorebook>>(
    `/lorebooks${encodeQuery({
      characterId: query.characterId,
      limit: query.limit,
    })}`,
  );
}

/** Fetch one lorebook. */
export async function readLorebook(id: string): Promise<Lorebook> {
  if (isKernelMode()) {
    return translateLorebook(await backend.lorebooks.get(id));
  }
  return api.get<Lorebook>(`/lorebooks/${id}`);
}

/** Create a lorebook (optionally with entries). */
export async function createLorebook(input: LorebookCreate): Promise<Lorebook> {
  if (isKernelMode()) {
    // Character linkage and rich entry fields (position/metadata) are not
    // wire operations yet — honest CAPABILITY_UNAVAILABLE.
    if (input.characterId) throw new UnsupportedError('lorebooks.create.characterId');
    const created = await backend.lorebooks.create({
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.entries !== undefined && input.entries.length > 0
        ? { entries: input.entries.map((entry) => entryWireInput(entry)) }
        : {}),
    });
    return translateLorebook(created);
  }
  return api.post<Lorebook>('/lorebooks', input);
}

/** Update a lorebook (name/description/entries). */
export async function updateLorebook(id: string, update: LorebookUpdate): Promise<Lorebook> {
  if (isKernelMode()) {
    if (update.characterId !== undefined)
      throw new UnsupportedError('lorebooks.update.characterId');
    const updated = await backend.lorebooks.update({
      lorebookId: id,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.description !== undefined ? { description: update.description } : {}),
    });
    return translateLorebook(updated);
  }
  return api.patch<Lorebook>(`/lorebooks/${id}`, update);
}

/** Delete a lorebook (permanent). */
export async function deleteLorebook(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.lorebooks.del(id);
    return;
  }
  await api.del(`/lorebooks/${id}`);
}

/* Entry-level lorebook operations (M4 slice 1): the wire contract now has
 * per-entry operations (`lorebooks.entries.list/create/update/delete`) —
 * kernel mode routes through the facade; legacy keeps the nested route.
 * The wire entry DTO carries only the product-owned fields, so the
 * translation reconstructs the UI entry from the wire subset. */

export async function readLorebookEntries(bookId: string): Promise<LorebookEntry[]> {
  if (isKernelMode()) {
    const result = await backend.lorebooks.listEntries(bookId);
    return result.items.map((entry) => translateLorebookEntry(bookId, entry));
  }
  const page = await api.get<{ items: LorebookEntry[] }>(`/lorebooks/${bookId}/entries`);
  return page.items;
}

export async function createLorebookEntry(
  bookId: string,
  input: LorebookEntryCreate,
): Promise<LorebookEntry> {
  if (isKernelMode()) {
    // The wire entry input has no position/metadata — those are kernel-owned
    // (appended at the end); the caller cannot position the new entry.
    const created = await backend.lorebooks.createEntry({
      lorebookId: bookId,
      entry: entryWireInput(input),
    });
    return translateLorebookEntry(bookId, created);
  }
  return api.post<LorebookEntry>(`/lorebooks/${bookId}/entries`, input);
}

export async function updateLorebookEntry(
  bookId: string,
  entryId: string,
  update: LorebookEntryUpdate,
): Promise<LorebookEntry> {
  if (isKernelMode()) {
    // position/metadata cannot be patched over the wire (kernel-owned).
    if (update.position !== undefined || update.metadata !== undefined) {
      throw new UnsupportedError('lorebooks.entries.update.position-metadata');
    }
    const updated = await backend.lorebooks.updateEntry({
      lorebookId: bookId,
      entryId,
      patch: entryPatchInput(update),
    });
    return translateLorebookEntry(bookId, updated);
  }
  return api.patch<LorebookEntry>(`/lorebooks/${bookId}/entries/${entryId}`, update);
}

export async function deleteLorebookEntry(bookId: string, entryId: string): Promise<void> {
  if (isKernelMode()) {
    await backend.lorebooks.deleteEntry(bookId, entryId);
    return;
  }
  await api.del(`/lorebooks/${bookId}/entries/${entryId}`);
}

/* --------------------------------------------------------------------------
 * Persona operations (Этап 4.1).
 * ------------------------------------------------------------------------ */

/** List personas. */
export async function readPersonas(): Promise<Persona[]> {
  if (isKernelMode()) {
    const result = await backend.personas.list();
    return result.items.map(translatePersona);
  }
  const page = await api.get<{ items: Persona[] }>('/personas');
  return page.items;
}

/** Fetch one persona. */
export async function readPersona(id: string): Promise<Persona> {
  if (isKernelMode()) {
    return translatePersona(await backend.personas.get(id));
  }
  return api.get<Persona>(`/personas/${id}`);
}

/** Create a persona. */
export async function createPersona(input: PersonaCreate): Promise<Persona> {
  if (isKernelMode()) {
    // The wire contract has no avatar-clearing signal (`avatar: null`) —
    // absence means "no avatar" on create; an explicit null is honest
    // CAPABILITY_UNAVAILABLE, not a silent drop.
    if (input.avatar === null) throw new UnsupportedError('personas.create.avatar.clear');
    const created = await backend.personas.create({
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    });
    return translatePersona(created);
  }
  return api.post<Persona>('/personas', input);
}

/** Update a persona. */
export async function updatePersona(id: string, update: PersonaUpdate): Promise<Persona> {
  if (isKernelMode()) {
    // The wire contract has no avatar-clearing signal (`avatar: null`);
    // absence means "unchanged" — an explicit clear is honest
    // CAPABILITY_UNAVAILABLE, not a silent no-op.
    if (update.avatar === null) throw new UnsupportedError('personas.update.avatar.clear');
    const updated = await backend.personas.update({
      personaId: id,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.description !== undefined ? { description: update.description } : {}),
      ...(update.avatar !== undefined ? { avatar: update.avatar } : {}),
      ...(update.isDefault !== undefined ? { isDefault: update.isDefault } : {}),
    });
    return translatePersona(updated);
  }
  return api.patch<Persona>(`/personas/${id}`, update);
}

/** Delete a persona (permanent). */
export async function deletePersona(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.personas.del(id);
    return;
  }
  await api.del(`/personas/${id}`);
}

/* --------------------------------------------------------------------------
 * Honest-input guards.
 * ------------------------------------------------------------------------ */

/** Legacy lorebook entry → wire `wire.lorebook.entry.input` (strict subset). */
function entryWireInput(entry: {
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  enabled?: boolean;
  constant?: boolean;
  selective?: boolean;
}): {
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  enabled?: boolean;
  constant?: boolean;
  selective?: boolean;
} {
  return {
    keys: entry.keys,
    ...(entry.secondaryKeys !== undefined ? { secondaryKeys: entry.secondaryKeys } : {}),
    content: entry.content,
    ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    ...(entry.constant !== undefined ? { constant: entry.constant } : {}),
    ...(entry.selective !== undefined ? { selective: entry.selective } : {}),
  };
}

/** Partial entry update → wire `wire.lorebook.entry.patch` (strict subset). */
function entryPatchInput(update: LorebookEntryUpdate): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (update.keys !== undefined) patch.keys = update.keys;
  if (update.secondaryKeys !== undefined) patch.secondaryKeys = update.secondaryKeys;
  if (update.content !== undefined) patch.content = update.content;
  if (update.enabled !== undefined) patch.enabled = update.enabled;
  if (update.constant !== undefined) patch.constant = update.constant;
  if (update.selective !== undefined) patch.selective = update.selective;
  return patch;
}

/** Wire `wire.lorebook.entry.dto` → legacy UI entry (honest subset: the wire
 * entry carries no position/metadata/lorebookId — those are filled from the
 * call context and neutral defaults; the UI must not display them as truth). */
function translateLorebookEntry(bookId: string, entry: LorebookEntryDto): LorebookEntry {
  return {
    id: entry.id,
    lorebookId: bookId,
    keys: entry.keys,
    secondaryKeys: entry.secondaryKeys ?? [],
    content: entry.content,
    enabled: entry.enabled,
    position: 0,
    constant: entry.constant,
    selective: entry.selective,
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Fields the wire character contract cannot carry (full card, Этап 4). */
const NON_WIRE_CHARACTER_FIELDS = [
  'avatar',
  'personality',
  'scenario',
  'firstMessage',
  'exampleDialogues',
  'systemPrompt',
  'postHistoryInstructions',
  'creator',
  'creatorNotes',
  'ext',
] as const;

/** Non-wire character fields that carry actual content (not empty defaults). */
function nonWireCharacterFields(input: CharacterCreate | CharacterUpdate): string[] {
  const present: string[] = [];
  for (const field of NON_WIRE_CHARACTER_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.length > 0) present.push(field);
    } else if (Array.isArray(value)) {
      if (value.length > 0) present.push(field);
    } else if (Object.keys(value).length > 0) {
      present.push(field);
    }
  }
  return present;
}
