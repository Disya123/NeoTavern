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
 *   `/api/v2` client unchanged (full-fidelity legacy entities).
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
  type Message,
  type CharacterDto,
  type ChatDto,
  type MessageDto,
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
 * Honest-input guards.
 * ------------------------------------------------------------------------ */

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
