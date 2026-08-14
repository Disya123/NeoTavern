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
import type { CharacterDto, ChatDto, LorebookDto, MessageDto, PersonaDto } from '@neotavern/contracts';

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
  };
  const lorebooks = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
  };
  const personas = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
  };
  return { characters, chats, lorebooks, personas };
});

vi.mock('./backend.js', () => ({
  backend: {
    characters: mocks.characters,
    chats: mocks.chats,
    lorebooks: mocks.lorebooks,
    personas: mocks.personas,
  },
  isKernelMode: () => true,
}));

import {
  continueCharacterChat,
  createCharacter,
  createChat,
  createLorebook,
  createLorebookEntry,
  createPersona,
  deleteCharacter,
  deleteChat,
  deleteLorebook,
  deleteLorebookEntry,
  deletePersona,
  readCharacters,
  readCharacter,
  readChats,
  readRecentChats,
  readChat,
  readLorebook,
  readLorebookEntries,
  readLorebooks,
  readMessages,
  readPersona,
  readPersonas,
  translateCharacter,
  translateCharacterSummary,
  translateChat,
  translateChatSummary,
  translateLorebook,
  translateMessage,
  translatePersona,
  updateCharacter,
  updateChat,
  updateLorebook,
  updateLorebookEntry,
  updatePersona,
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

const WIRE_PERSONA: PersonaDto = {
  id: '44556677-8899-aabb-ccdd-eeff00112233',
  name: 'Aria',
  description: 'A traveler.',
  isDefault: true,
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

  it('surfaces entry-level operations as honest CAPABILITY_UNAVAILABLE', async () => {
    await expect(readLorebookEntries(WIRE_LOREBOOK.id)).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    await expect(
      createLorebookEntry(WIRE_LOREBOOK.id, { keys: ['k'], content: 'c' }),
    ).rejects.toBeInstanceOf(UnsupportedError);
    await expect(
      updateLorebookEntry(WIRE_LOREBOOK.id, 'e1', { content: 'c2' }),
    ).rejects.toBeInstanceOf(UnsupportedError);
    await expect(deleteLorebookEntry(WIRE_LOREBOOK.id, 'e1')).rejects.toBeInstanceOf(
      UnsupportedError,
    );
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
