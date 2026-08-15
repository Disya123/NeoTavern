/**
 * Library/chat data plane (Этап 2.10, шаг 2): wire→UI translation and the
 * kernel-mode branch of the golden-flow operations.
 *
 * The kernel branch is exercised with a mocked `./backend.js` singleton
 * (LocalBackend-shaped stub); translation functions are pure and tested
 * directly. The legacy branch delegates to `client.ts` and is covered by the
 * hook tests (`hooks.test.ts`) through the real fetch stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsupportedError } from '@neotavern/neobackend';
import type {
  CharacterDto,
  ChatDto,
  LorebookDto,
  LorebookEntryDto,
  MemoryDto,
  MessageDto,
  MessageDraftDto,
  MessageRevisionDto,
  MessageVariantDto,
  PersonaDto,
  PresetDto,
} from '@neotavern/contracts';

const mocks = vi.hoisted(() => {
  const characters = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
  };
  const chats = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
    listMessages: vi.fn(),
    createMessage: vi.fn(),
    updateMessage: vi.fn(),
    delMessage: vi.fn(),
    listMessageVariants: vi.fn(),
    createMessageVariant: vi.fn(),
    delMessageVariant: vi.fn(),
    activateMessageVariant: vi.fn(),
    listMessageRevisions: vi.fn(),
    getMessageDraft: vi.fn(),
    saveMessageDraft: vi.fn(),
    commitMessageDraft: vi.fn(),
    discardMessageDraft: vi.fn(),
  };
  const lorebooks = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
    listEntries: vi.fn(),
    createEntry: vi.fn(),
    updateEntry: vi.fn(),
    deleteEntry: vi.fn(),
  };
  const personas = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
  };
  const presets = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
  };
  const memories = {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
  };
  return { characters, chats, lorebooks, personas, presets, memories };
});

vi.mock('./backend.js', () => ({
  backend: {
    characters: mocks.characters,
    chats: mocks.chats,
    lorebooks: mocks.lorebooks,
    personas: mocks.personas,
    presets: mocks.presets,
    memories: mocks.memories,
  },
  isKernelMode: () => true,
}));

import {
  activateMessageVariant,
  commitMessageDraft,
  continueCharacterChat,
  createCharacter,
  createChat,
  createLorebook,
  createLorebookEntry,
  createMemory,
  createMessageVariant,
  createPersona,
  createPreset,
  deleteCharacter,
  deleteChat,
  deleteLorebook,
  deleteLorebookEntry,
  deleteMemory,
  deleteMessageVariant,
  deletePersona,
  deletePreset,
  discardMessageDraft,
  readCharacters,
  readCharacter,
  readChats,
  readRecentChats,
  readChat,
  readLorebook,
  readLorebookEntries,
  readLorebooks,
  readMemories,
  readMessages,
  readMessageDraft,
  readMessageRevisions,
  readMessageVariants,
  readPersona,
  readPersonas,
  readPresets,
  restoreMessageRevision,
  saveMessageDraft,
  translateCharacter,
  translateCharacterSummary,
  translateChat,
  translateChatSummary,
  translateLorebook,
  translateMemory,
  translateMessage,
  translatePersona,
  translatePreset,
  updateCharacter,
  updateChat,
  updateLorebook,
  updateLorebookEntry,
  updateMemory,
  updatePersona,
  updatePreset,
} from './wireBridge.js';

const CHAR_ID = '11111111-2222-4333-8444-555555555555';
const CHAT_ID = '01234567-89ab-4cde-8f01-23456789abcd';
const NOW = '2026-06-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

const WIRE_CHARACTER: CharacterDto = {
  id: CHAR_ID,
  name: 'Alice',
  description: 'A test character.',
  tags: ['test'],
  createdAt: NOW,
  updatedAt: NOW,
};

const WIRE_CHAT: ChatDto = {
  id: CHAT_ID,
  title: 'First chat',
  characterId: CHAR_ID,
  messageCount: 2,
  createdAt: NOW,
  updatedAt: NOW,
};

const WIRE_MESSAGE: MessageDto = {
  id: '22334455-6677-8899-aabb-ccddeeff0011',
  chatId: CHAT_ID,
  role: 'user',
  content: 'Hello',
  createdAt: NOW,
  sequence: 0,
};

const WIRE_LOREBOOK: LorebookDto = {
  id: '33445566-7788-99aa-bbcc-ddeeff001122',
  name: 'Arcanum',
  description: 'A magic codex.',
  entryCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const WIRE_LOREBOOK_ENTRY: LorebookEntryDto = {
  id: '44556677-8899-aabb-ccdd-eeff00112233',
  keys: ['castle'],
  content: 'The castle is carved from living stone.',
  enabled: true,
  constant: false,
  selective: false,
};

const WIRE_PERSONA: PersonaDto = {
  id: '44556677-8899-aabb-ccdd-eeff00112233',
  name: 'Aria',
  description: 'A traveler.',
  isDefault: true,
  createdAt: NOW,
  updatedAt: NOW,
};

const WIRE_PRESET: PresetDto = {
  id: '3c4d5e6f-7a8b-4c0d-9e1f-2a3b4c5d6e7f',
  kind: 'generation',
  name: 'Balanced',
  data: { maxContextTokens: 8192, generationDefaults: { temperature: 0.8 } },
  createdAt: NOW,
  updatedAt: NOW,
};

const WIRE_MEMORY: MemoryDto = {
  id: '4d5e6f70-8a9b-4c1d-9e2f-3a4b5c6d7e80',
  scope: 'character',
  characterId: CHAR_ID,
  keys: ['aria', 'clockwork'],
  content: 'Aria guards the clockwork orchard.',
  enabled: true,
  position: 1,
  metadata: { source: 'test' },
  createdAt: NOW,
  updatedAt: NOW,
};

const MESSAGE_ID = '12345678-90ab-4cde-8f01-23456789abcd';
const VARIANT_ID = 'aaaaaaa1-1111-4111-8111-111111111111';
const REVISION_ID = 'aaaaaaa2-2222-4222-8222-222222222222';
const DRAFT_ID = 'aaaaaaa3-3333-4333-8333-333333333333';

const WIRE_MESSAGE_DTO: MessageDto = {
  id: MESSAGE_ID,
  chatId: CHAT_ID,
  role: 'assistant',
  content: 'Hello (swipe)',
  createdAt: NOW,
  sequence: 0,
};

const WIRE_VARIANT: MessageVariantDto = {
  id: VARIANT_ID,
  messageId: MESSAGE_ID,
  content: 'Hello (swipe)',
  position: 0,
  createdAt: NOW,
};

const WIRE_REVISION: MessageRevisionDto = {
  id: REVISION_ID,
  messageId: MESSAGE_ID,
  content: 'Hello',
  position: 0,
  createdAt: NOW,
};

const WIRE_DRAFT: MessageDraftDto = {
  id: DRAFT_ID,
  chatId: CHAT_ID,
  role: 'assistant',
  content: 'Streaming…',
  sequence: 3,
  revision: 2,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('wire→UI translation', () => {
  it('maps a wire character onto CharacterSummary with honest absent defaults', () => {
    const summary = translateCharacterSummary(WIRE_CHARACTER);
    expect(summary).toEqual({
      id: CHAR_ID,
      name: 'Alice',
      avatar: null,
      description: 'A test character.',
      tags: ['test'],
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });
  });

  it('maps a wire character onto the full Character with empty card fields', () => {
    const character = translateCharacter(WIRE_CHARACTER);
    expect(character.personality).toBe('');
    expect(character.firstMessage).toBe('');
    expect(character.systemPrompt).toBeNull();
    expect(character.creatorNotes).toBeNull();
    expect(character.ext).toEqual({});
    expect(character.deletedAt).toBeNull();
    expect(character.lastUsedAt).toBeNull();
  });

  it('maps a wire chat onto ChatSummary with null joined identity', () => {
    const summary = translateChatSummary(WIRE_CHAT);
    expect(summary).toEqual({
      id: CHAT_ID,
      characterId: CHAR_ID,
      characterName: null,
      characterAvatar: null,
      title: 'First chat',
      messageCount: 2,
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
      parentChatId: null,
      origin: null,
      sourceMessageId: null,
    });
  });

  it('maps a wire chat onto the full Chat with null branch/persona state', () => {
    const chat = translateChat(WIRE_CHAT);
    expect(chat.personaId).toBeNull();
    expect(chat.activeBranchId).toBeNull();
    expect(chat.summary).toBe('');
    expect(chat.deletedAt).toBeNull();
  });

  it('maps a wire message onto the legacy Message with safe branch/variant defaults', () => {
    const message = translateMessage(WIRE_MESSAGE);
    expect(message).toEqual({
      id: WIRE_MESSAGE.id,
      chatId: CHAT_ID,
      branchId: CHAT_ID,
      parentId: null,
      role: 'user',
      content: 'Hello',
      name: null,
      meta: {},
      createdAt: NOW_MS,
      revision: 1,
      updatedAt: null,
      variantCount: 0,
      activeVariantPosition: null,
      contentRevisionCount: 0,
      checkpointChatId: null,
    });
  });

  it('maps a wire lorebook onto the legacy Lorebook with neutral defaults', () => {
    const book = translateLorebook(WIRE_LOREBOOK);
    expect(book).toEqual({
      id: WIRE_LOREBOOK.id,
      name: 'Arcanum',
      description: 'A magic codex.',
      characterId: null,
      metadata: {},
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });
  });

  it('maps a wire persona onto the legacy Persona with an honest avatar default', () => {
    const persona = translatePersona(WIRE_PERSONA);
    expect(persona).toEqual({
      id: WIRE_PERSONA.id,
      name: 'Aria',
      description: 'A traveler.',
      avatar: null,
      isDefault: true,
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });
  });
});

describe('readCharacters (kernel)', () => {
  it('lists with cursor/limit and translates the page', async () => {
    mocks.characters.list.mockResolvedValue({ items: [WIRE_CHARACTER], nextCursor: 'c2' });
    const page = await readCharacters({ sort: 'newest' }, 'c1');
    expect(mocks.characters.list).toHaveBeenCalledWith({ cursor: 'c1' });
    expect(page.items[0]).toMatchObject({ id: CHAR_ID, name: 'Alice' });
    expect(page.nextCursor).toBe('c2');
    expect(page.hasMore).toBe(true);
  });

  it('rejects search and non-default sorts honestly', async () => {
    await expect(readCharacters({ q: 'Alice' })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(readCharacters({ tag: 'x' })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(readCharacters({ sort: 'random' })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(readCharacters({ includeDeleted: true })).rejects.toBeInstanceOf(UnsupportedError);
    expect(mocks.characters.list).not.toHaveBeenCalled();
  });
});

describe('readCharacter / create / update / delete (kernel)', () => {
  it('gets one character and translates it', async () => {
    mocks.characters.get.mockResolvedValue(WIRE_CHARACTER);
    await expect(readCharacter(CHAR_ID)).resolves.toMatchObject({ id: CHAR_ID });
    expect(mocks.characters.get).toHaveBeenCalledWith(CHAR_ID);
  });

  it('creates with wire-only fields', async () => {
    mocks.characters.create.mockResolvedValue(WIRE_CHARACTER);
    await createCharacter({ name: 'Alice', description: 'desc', tags: ['t'] });
    expect(mocks.characters.create).toHaveBeenCalledWith({
      name: 'Alice',
      description: 'desc',
      tags: ['t'],
    });
  });

  it('refuses persona/card fields instead of silently dropping them', async () => {
    await expect(createCharacter({ name: 'Alice', personality: 'witty' })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    await expect(createCharacter({ name: 'Alice', firstMessage: 'Hi' })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    expect(mocks.characters.create).not.toHaveBeenCalled();
  });

  it('updates wire-only fields and rejects card patches', async () => {
    mocks.characters.update.mockResolvedValue(WIRE_CHARACTER);
    await updateCharacter(CHAR_ID, { name: 'Bob' });
    expect(mocks.characters.update).toHaveBeenCalledWith({ characterId: CHAR_ID, name: 'Bob' });
    await expect(updateCharacter(CHAR_ID, { scenario: 's' })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });

  it('deletes through the facade', async () => {
    mocks.characters.del.mockResolvedValue({ ok: true });
    await deleteCharacter(CHAR_ID);
    expect(mocks.characters.del).toHaveBeenCalledWith(CHAR_ID);
  });
});

describe('readChats / readRecentChats / continue (kernel)', () => {
  it('lists chats by character without q', async () => {
    mocks.chats.list.mockResolvedValue({ items: [WIRE_CHAT], nextCursor: null });
    const page = await readChats(CHAR_ID, undefined, 'c1');
    expect(mocks.chats.list).toHaveBeenCalledWith({ characterId: CHAR_ID, cursor: 'c1' });
    expect(page.items[0]).toMatchObject({ id: CHAT_ID, title: 'First chat' });
  });

  it('rejects chat search honestly', async () => {
    await expect(readChats(CHAR_ID, 'query')).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('reads recent chats with an explicit limit', async () => {
    mocks.chats.list.mockResolvedValue({ items: [WIRE_CHAT], nextCursor: null });
    await readRecentChats(8, CHAR_ID);
    expect(mocks.chats.list).toHaveBeenCalledWith({ characterId: CHAR_ID, limit: 8 });
  });

  it('continues the most recent live chat without creating a duplicate', async () => {
    mocks.chats.list.mockResolvedValue({ items: [WIRE_CHAT], nextCursor: null });
    const result = await continueCharacterChat({ characterId: CHAR_ID, title: 'T' });
    expect(result).toEqual({ chatId: CHAT_ID, created: false });
    expect(mocks.chats.create).not.toHaveBeenCalled();
  });

  it('creates a chat when none exists', async () => {
    mocks.chats.list.mockResolvedValue({ items: [], nextCursor: null });
    mocks.chats.create.mockResolvedValue(WIRE_CHAT);
    const result = await continueCharacterChat({ characterId: CHAR_ID, title: 'T' });
    expect(result).toEqual({ chatId: CHAT_ID, created: true });
    expect(mocks.chats.create).toHaveBeenCalledWith({ characterId: CHAR_ID, title: 'T' });
  });

  it('rejects persona-scoped continuation honestly', async () => {
    await expect(
      continueCharacterChat({ characterId: CHAR_ID, title: 'T', personaId: 'p1' }),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('readChat / createChat / updateChat / deleteChat (kernel)', () => {
  it('gets one chat and translates it', async () => {
    mocks.chats.get.mockResolvedValue(WIRE_CHAT);
    await expect(readChat(CHAT_ID)).resolves.toMatchObject({ id: CHAT_ID });
    expect(mocks.chats.get).toHaveBeenCalledWith(CHAT_ID);
  });

  it('creates an empty chat for a character', async () => {
    mocks.chats.create.mockResolvedValue(WIRE_CHAT);
    await createChat({ characterId: CHAR_ID, title: 'New chat' });
    expect(mocks.chats.create).toHaveBeenCalledWith({ characterId: CHAR_ID, title: 'New chat' });
  });

  it('rejects persona/greeting legacy inputs and missing character', async () => {
    await expect(createChat({ personaId: 'p1' })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(createChat({ greetingIndex: 2 })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(createChat({})).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('renames a chat (title-only) and rejects other fields', async () => {
    mocks.chats.update.mockResolvedValue(WIRE_CHAT);
    await updateChat(CHAT_ID, { title: 'Renamed' });
    expect(mocks.chats.update).toHaveBeenCalledWith({ chatId: CHAT_ID, title: 'Renamed' });
    await expect(updateChat(CHAT_ID, { summary: 's' })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(updateChat(CHAT_ID, {})).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('deletes a chat through the facade', async () => {
    mocks.chats.del.mockResolvedValue({ ok: true });
    await deleteChat(CHAT_ID);
    expect(mocks.chats.del).toHaveBeenCalledWith(CHAT_ID);
  });
});

describe('readMessages (kernel)', () => {
  it('loads newest-first pages with the desc order and translates', async () => {
    mocks.chats.listMessages.mockResolvedValue({ items: [WIRE_MESSAGE], nextCursor: 'c2' });
    const page = await readMessages(CHAT_ID, undefined, 'c1');
    expect(mocks.chats.listMessages).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      order: 'desc',
      cursor: 'c1',
    });
    expect(page.items[0]).toMatchObject({ id: WIRE_MESSAGE.id, content: 'Hello' });
  });

  it('rejects a branch id honestly (branches are not modelled yet)', async () => {
    await expect(readMessages(CHAT_ID, 'b1')).rejects.toBeInstanceOf(UnsupportedError);
    expect(mocks.chats.listMessages).not.toHaveBeenCalled();
  });
});

describe('message variants/revisions/drafts (kernel, Этап 4 slice 2)', () => {
  it('lists variants through the facade and translates them', async () => {
    mocks.chats.listMessageVariants.mockResolvedValue({ items: [WIRE_VARIANT] });
    const items = await readMessageVariants(CHAT_ID, MESSAGE_ID);
    expect(mocks.chats.listMessageVariants).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
    });
    expect(items).toEqual([
      {
        id: VARIANT_ID,
        messageId: MESSAGE_ID,
        position: 0,
        content: 'Hello (swipe)',
        createdAt: NOW_MS,
      },
    ]);
  });

  it('creates a variant through the facade', async () => {
    mocks.chats.createMessageVariant.mockResolvedValue(WIRE_VARIANT);
    const variant = await createMessageVariant(CHAT_ID, MESSAGE_ID, 'Hello (swipe)');
    expect(mocks.chats.createMessageVariant).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
      content: 'Hello (swipe)',
    });
    expect(variant.id).toBe(VARIANT_ID);
  });

  it('deletes a variant through the facade', async () => {
    mocks.chats.delMessageVariant.mockResolvedValue({});
    await deleteMessageVariant(CHAT_ID, MESSAGE_ID, VARIANT_ID);
    expect(mocks.chats.delMessageVariant).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
      variantId: VARIANT_ID,
    });
  });

  it('activates a variant and translates the updated message', async () => {
    mocks.chats.activateMessageVariant.mockResolvedValue(WIRE_MESSAGE_DTO);
    const message = await activateMessageVariant(CHAT_ID, MESSAGE_ID, VARIANT_ID);
    expect(mocks.chats.activateMessageVariant).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
      variantId: VARIANT_ID,
    });
    expect(message).toMatchObject({ id: MESSAGE_ID, content: 'Hello (swipe)' });
  });

  it('lists revisions in one page through the facade', async () => {
    mocks.chats.listMessageRevisions.mockResolvedValue({ items: [WIRE_REVISION] });
    const page = await readMessageRevisions(CHAT_ID, MESSAGE_ID);
    expect(mocks.chats.listMessageRevisions).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
    });
    expect(page).toEqual({
      items: [
        {
          id: REVISION_ID,
          messageId: MESSAGE_ID,
          position: 0,
          content: 'Hello',
          createdAt: NOW_MS,
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('restores a revision through the canonical messages.update op', async () => {
    mocks.chats.updateMessage.mockResolvedValue(WIRE_MESSAGE_DTO);
    const message = await restoreMessageRevision(CHAT_ID, MESSAGE_ID, REVISION_ID, 'Hello');
    expect(mocks.chats.updateMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
      content: 'Hello',
    });
    expect(message.id).toBe(MESSAGE_ID);
  });

  it('gets a draft through the facade and translates it with honest defaults', async () => {
    mocks.chats.getMessageDraft.mockResolvedValue(WIRE_DRAFT);
    const draft = await readMessageDraft(CHAT_ID, DRAFT_ID);
    expect(mocks.chats.getMessageDraft).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      draftId: DRAFT_ID,
    });
    expect(draft).toEqual({
      id: DRAFT_ID,
      chatId: CHAT_ID,
      branchId: '',
      role: 'assistant',
      content: 'Streaming…',
      name: null,
      meta: {},
      sequence: 3,
      revision: 2,
      committedMessageId: null,
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });
  });

  it('saves a new draft (no id) through the facade', async () => {
    mocks.chats.saveMessageDraft.mockResolvedValue(WIRE_DRAFT);
    await saveMessageDraft({ chatId: CHAT_ID, role: 'assistant', content: 'Streaming…' });
    expect(mocks.chats.saveMessageDraft).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      role: 'assistant',
      content: 'Streaming…',
    });
  });

  it('saves an update (with id + sequence) through the facade', async () => {
    mocks.chats.saveMessageDraft.mockResolvedValue(WIRE_DRAFT);
    await saveMessageDraft({
      chatId: CHAT_ID,
      draftId: DRAFT_ID,
      role: 'assistant',
      content: 'Streaming…',
      sequence: 3,
    });
    expect(mocks.chats.saveMessageDraft).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      draftId: DRAFT_ID,
      role: 'assistant',
      content: 'Streaming…',
      sequence: 3,
    });
  });

  it('commits a draft and returns the committed message id', async () => {
    mocks.chats.commitMessageDraft.mockResolvedValue(WIRE_MESSAGE_DTO);
    const result = await commitMessageDraft(CHAT_ID, DRAFT_ID);
    expect(mocks.chats.commitMessageDraft).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      draftId: DRAFT_ID,
    });
    expect(result).toEqual({ messageId: MESSAGE_ID });
  });

  it('discards a draft through the facade', async () => {
    mocks.chats.discardMessageDraft.mockResolvedValue({});
    await discardMessageDraft(CHAT_ID, DRAFT_ID);
    expect(mocks.chats.discardMessageDraft).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      draftId: DRAFT_ID,
    });
  });
});

describe('lorebook CRUD (kernel, Этап 4.1)', () => {
  it('lists lorebooks in one page and translates them', async () => {
    mocks.lorebooks.list.mockResolvedValue({ items: [WIRE_LOREBOOK] });
    const page = await readLorebooks();
    expect(mocks.lorebooks.list).toHaveBeenCalledWith();
    expect(page).toEqual({
      items: [expect.objectContaining({ id: WIRE_LOREBOOK.id, name: 'Arcanum' })],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('rejects a character-scoped catalog honestly (linkage not modelled)', async () => {
    await expect(readLorebooks({ characterId: CHAR_ID })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    expect(mocks.lorebooks.list).not.toHaveBeenCalled();
  });

  it('gets one lorebook and translates it', async () => {
    mocks.lorebooks.get.mockResolvedValue(WIRE_LOREBOOK);
    await expect(readLorebook(WIRE_LOREBOOK.id)).resolves.toMatchObject({
      id: WIRE_LOREBOOK.id,
      characterId: null,
    });
    expect(mocks.lorebooks.get).toHaveBeenCalledWith(WIRE_LOREBOOK.id);
  });

  it('creates a lorebook with entries', async () => {
    mocks.lorebooks.create.mockResolvedValue(WIRE_LOREBOOK);
    await createLorebook({
      name: 'Arcanum',
      description: 'A magic codex.',
      entries: [{ keys: ['spell'], content: 'Mana flows.', enabled: true, constant: false }],
    });
    expect(mocks.lorebooks.create).toHaveBeenCalledWith({
      name: 'Arcanum',
      description: 'A magic codex.',
      entries: [{ keys: ['spell'], content: 'Mana flows.', enabled: true, constant: false }],
    });
  });

  it('rejects character-linked creation honestly', async () => {
    await expect(createLorebook({ name: 'X', characterId: CHAR_ID })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    expect(mocks.lorebooks.create).not.toHaveBeenCalled();
  });

  it('updates name/description and rejects character linkage', async () => {
    mocks.lorebooks.update.mockResolvedValue(WIRE_LOREBOOK);
    await updateLorebook(WIRE_LOREBOOK.id, { name: 'Renamed', description: 'd' });
    expect(mocks.lorebooks.update).toHaveBeenCalledWith({
      lorebookId: WIRE_LOREBOOK.id,
      name: 'Renamed',
      description: 'd',
    });
    await expect(
      updateLorebook(WIRE_LOREBOOK.id, { characterId: CHAR_ID }),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('deletes a lorebook through the facade', async () => {
    mocks.lorebooks.del.mockResolvedValue({ ok: true });
    await deleteLorebook(WIRE_LOREBOOK.id);
    expect(mocks.lorebooks.del).toHaveBeenCalledWith(WIRE_LOREBOOK.id);
  });

  it('routes entry-level operations through the facade (M4 slice 1)', async () => {
    mocks.lorebooks.listEntries.mockResolvedValue({ items: [WIRE_LOREBOOK_ENTRY] });
    const entries = await readLorebookEntries(WIRE_LOREBOOK.id);
    expect(mocks.lorebooks.listEntries).toHaveBeenCalledWith(WIRE_LOREBOOK.id);
    expect(entries).toEqual([
      expect.objectContaining({
        id: WIRE_LOREBOOK_ENTRY.id,
        keys: WIRE_LOREBOOK_ENTRY.keys,
        content: WIRE_LOREBOOK_ENTRY.content,
        lorebookId: WIRE_LOREBOOK.id,
      }),
    ]);

    mocks.lorebooks.createEntry.mockResolvedValue(WIRE_LOREBOOK_ENTRY);
    await createLorebookEntry(WIRE_LOREBOOK.id, { keys: ['k'], content: 'c' });
    expect(mocks.lorebooks.createEntry).toHaveBeenCalledWith({
      lorebookId: WIRE_LOREBOOK.id,
      entry: { keys: ['k'], content: 'c' },
    });

    mocks.lorebooks.updateEntry.mockResolvedValue(WIRE_LOREBOOK_ENTRY);
    await updateLorebookEntry(WIRE_LOREBOOK.id, WIRE_LOREBOOK_ENTRY.id, { content: 'c2' });
    expect(mocks.lorebooks.updateEntry).toHaveBeenCalledWith({
      lorebookId: WIRE_LOREBOOK.id,
      entryId: WIRE_LOREBOOK_ENTRY.id,
      patch: { content: 'c2' },
    });

    mocks.lorebooks.deleteEntry.mockResolvedValue({ ok: true });
    await deleteLorebookEntry(WIRE_LOREBOOK.id, WIRE_LOREBOOK_ENTRY.id);
    expect(mocks.lorebooks.deleteEntry).toHaveBeenCalledWith(
      WIRE_LOREBOOK.id,
      WIRE_LOREBOOK_ENTRY.id,
    );
  });

  it('keeps position/metadata patching honest in kernel mode', async () => {
    await expect(
      updateLorebookEntry(WIRE_LOREBOOK.id, 'e1', { position: 3 }),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('persona CRUD (kernel, Этап 4.1)', () => {
  it('lists personas and translates them', async () => {
    mocks.personas.list.mockResolvedValue({ items: [WIRE_PERSONA] });
    const personas = await readPersonas();
    expect(mocks.personas.list).toHaveBeenCalledWith();
    expect(personas).toEqual([expect.objectContaining({ id: WIRE_PERSONA.id, name: 'Aria' })]);
  });

  it('gets one persona and translates it', async () => {
    mocks.personas.get.mockResolvedValue(WIRE_PERSONA);
    await expect(readPersona(WIRE_PERSONA.id)).resolves.toMatchObject({
      id: WIRE_PERSONA.id,
      avatar: null,
    });
    expect(mocks.personas.get).toHaveBeenCalledWith(WIRE_PERSONA.id);
  });

  it('creates a persona (default flag included)', async () => {
    mocks.personas.create.mockResolvedValue(WIRE_PERSONA);
    await createPersona({ name: 'Aria', description: 'A traveler.', isDefault: true });
    expect(mocks.personas.create).toHaveBeenCalledWith({
      name: 'Aria',
      description: 'A traveler.',
      isDefault: true,
    });
  });

  it('rejects an explicit avatar clear on create honestly', async () => {
    await expect(createPersona({ name: 'A', avatar: null })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    expect(mocks.personas.create).not.toHaveBeenCalled();
  });

  it('updates name/avatar and rejects an explicit avatar clear', async () => {
    mocks.personas.update.mockResolvedValue(WIRE_PERSONA);
    await updatePersona(WIRE_PERSONA.id, { name: 'Aria II', avatar: 'aria.png' });
    expect(mocks.personas.update).toHaveBeenCalledWith({
      personaId: WIRE_PERSONA.id,
      name: 'Aria II',
      avatar: 'aria.png',
    });
    await expect(updatePersona(WIRE_PERSONA.id, { avatar: null })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });

  it('deletes a persona through the facade', async () => {
    mocks.personas.del.mockResolvedValue({ ok: true });
    await deletePersona(WIRE_PERSONA.id);
    expect(mocks.personas.del).toHaveBeenCalledWith(WIRE_PERSONA.id);
  });
});

describe('preset CRUD (kernel, Этап 4 slice 3)', () => {
  it('translates a wire preset onto the legacy Preset shape', () => {
    expect(translatePreset(WIRE_PRESET)).toEqual({
      id: WIRE_PRESET.id,
      kind: 'generation',
      name: 'Balanced',
      data: { maxContextTokens: 8192, generationDefaults: { temperature: 0.8 } },
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });
  });

  it('lists presets by kind through the facade', async () => {
    mocks.presets.list.mockResolvedValue({ items: [WIRE_PRESET] });
    await expect(readPresets('generation')).resolves.toEqual({
      items: [expect.objectContaining({ id: WIRE_PRESET.id, kind: 'generation' })],
    });
    expect(mocks.presets.list).toHaveBeenCalledWith({ kind: 'generation' });
  });

  it('creates a preset through the facade', async () => {
    mocks.presets.create.mockResolvedValue(WIRE_PRESET);
    await createPreset({ kind: 'generation', name: 'Balanced' });
    expect(mocks.presets.create).toHaveBeenCalledWith({
      kind: 'generation',
      name: 'Balanced',
    });
  });

  it('updates name/data and deletes through the facade', async () => {
    mocks.presets.update.mockResolvedValue(WIRE_PRESET);
    await updatePreset(WIRE_PRESET.id, { name: 'Balanced v2' });
    expect(mocks.presets.update).toHaveBeenCalledWith({
      presetId: WIRE_PRESET.id,
      name: 'Balanced v2',
    });
    mocks.presets.del.mockResolvedValue({ ok: true });
    await deletePreset(WIRE_PRESET.id);
    expect(mocks.presets.del).toHaveBeenCalledWith(WIRE_PRESET.id);
  });
});

describe('memory CRUD (kernel, Этап 4 slice 3)', () => {
  it('translates a wire memory onto the legacy Memory shape (characterId null for global)', () => {
    expect(translateMemory(WIRE_MEMORY)).toEqual({
      id: WIRE_MEMORY.id,
      scope: 'character',
      characterId: CHAR_ID,
      keys: ['aria', 'clockwork'],
      content: 'Aria guards the clockwork orchard.',
      enabled: true,
      position: 1,
      metadata: { source: 'test' },
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });
    expect(
      translateMemory({ ...WIRE_MEMORY, scope: 'global', characterId: undefined }),
    ).toEqual(expect.objectContaining({ scope: 'global', characterId: null }));
  });

  it('lists memories with filters through the facade', async () => {
    mocks.memories.list.mockResolvedValue({ items: [WIRE_MEMORY] });
    await readMemories({ scope: 'character', characterId: CHAR_ID });
    expect(mocks.memories.list).toHaveBeenCalledWith({
      scope: 'character',
      characterId: CHAR_ID,
    });
  });

  it('creates a memory through the facade (null characterId omitted)', async () => {
    mocks.memories.create.mockResolvedValue(WIRE_MEMORY);
    await createMemory({
      scope: 'character',
      characterId: CHAR_ID,
      keys: ['aria'],
      content: 'Aria guards the clockwork orchard.',
    });
    expect(mocks.memories.create).toHaveBeenCalledWith({
      scope: 'character',
      characterId: CHAR_ID,
      keys: ['aria'],
      content: 'Aria guards the clockwork orchard.',
    });
    await createMemory({ content: 'Global note.' });
    expect(mocks.memories.create).toHaveBeenCalledWith({ content: 'Global note.' });
  });

  it('updates fields and rejects a null characterId clear honestly', async () => {
    mocks.memories.update.mockResolvedValue(WIRE_MEMORY);
    await updateMemory(WIRE_MEMORY.id, { content: 'Updated.', enabled: false });
    expect(mocks.memories.update).toHaveBeenCalledWith({
      memoryId: WIRE_MEMORY.id,
      content: 'Updated.',
      enabled: false,
    });
    await expect(updateMemory(WIRE_MEMORY.id, { characterId: null })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });

  it('deletes a memory through the facade', async () => {
    mocks.memories.del.mockResolvedValue({ ok: true });
    await deleteMemory(WIRE_MEMORY.id);
    expect(mocks.memories.del).toHaveBeenCalledWith(WIRE_MEMORY.id);
  });
});
