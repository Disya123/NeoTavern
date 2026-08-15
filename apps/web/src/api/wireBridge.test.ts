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
  const isKernelMode = vi.fn(() => true);
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
  const assets = {
    get: vi.fn(),
    content: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  };
  const themes = {
    list: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    activate: vi.fn(),
  };
  const plugins = {
    list: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  };
  const meta = {
    get: vi.fn(),
  };
  const metaFn = vi.fn();
  const settings = {
    get: vi.fn(),
    update: vi.fn(),
  };
  return {
    characters,
    chats,
    lorebooks,
    personas,
    presets,
    memories,
    assets,
    themes,
    plugins,
    meta,
    metaFn,
    settings,
    isKernelMode,
  };
});

vi.mock('./backend.js', () => ({
  backend: {
    characters: mocks.characters,
    chats: mocks.chats,
    lorebooks: mocks.lorebooks,
    personas: mocks.personas,
    presets: mocks.presets,
    memories: mocks.memories,
    assets: mocks.assets,
    themes: mocks.themes,
    plugins: mocks.plugins,
    meta: mocks.metaFn,
    settings: mocks.settings,
  },
  isKernelMode: mocks.isKernelMode,
}));

import {
  activateMessageVariant,
  avatarOriginalUrl,
  wallpaperBackgroundUrl,
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
  createBridgeChatMessage,
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
  readAssetContentDataUrl,
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
  updateChatMessage,
  updateLorebook,
  updateLorebookEntry,
  updateMemory,
  updatePersona,
  updatePreset,
  uploadCharacterAvatar,
  readThemes,
  activateTheme,
  resetActiveTheme,
  deleteTheme,
  installTheme,
  readThemeSettings,
  userCssUrl,
  readPlugins,
  activatePlugin,
  disablePlugin,
  deletePlugin,
  installPlugin,
  installPluginFromGit,
  enterPluginSafeMode,
  exitPluginSafeMode,
  readPluginAuthConnections,
  connectPluginAuth,
  revokePluginAuth,
  readAppVersion,
  readSettings,
  updateSettings,
  exportCharacterCard,
  exportChat,
  importCharacter,
  warmProviderModels,
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
  personaId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
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
  meta: { manualExcluded: false },
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
  meta: {},
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
      avatarAssetId: null,
      description: 'A test character.',
      tags: ['test'],
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });
  });

  it('carries the canonical avatar asset reference through the summary translation', () => {
    const summary = translateCharacterSummary({
      ...WIRE_CHARACTER,
      avatarAssetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
    expect(summary.avatarAssetId).toBe('0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f');
    expect(summary.avatar).toBeNull();
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
});

describe('avatar data plane (M5 slice 6, ТЗ §34 avatar→asset)', () => {
  it('resolves a canonical avatar asset to a data: URI over the kernel plane', async () => {
    mocks.assets.content.mockResolvedValue({
      assetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
      contentType: 'image/png',
      contentBase64: 'aGVsbG8=',
    });
    const dataUrl = await readAssetContentDataUrl('0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f');
    expect(dataUrl).toBe('data:image/png;base64,aGVsbG8=');
    expect(mocks.assets.content).toHaveBeenCalledWith(
      '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
      undefined,
    );
  });

  it('falls back to image/png when the wire record omits the content type', async () => {
    mocks.assets.content.mockResolvedValue({
      assetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
      contentBase64: 'aGVsbG8=',
    });
    const dataUrl = await readAssetContentDataUrl('0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f');
    expect(dataUrl).toBe('data:image/png;base64,aGVsbG8=');
  });

  it('builds the legacy avatar-original URL only for characters with a legacy avatar', () => {
    expect(avatarOriginalUrl(CHAR_ID, '/api/v2/assets/avatars/abc.png')).toBe(
      `/api/v2/characters/${CHAR_ID}/avatar-original`,
    );
    expect(avatarOriginalUrl(CHAR_ID, null)).toBeNull();
  });

  it('routes the wallpaper URL through the transport: legacy URL on the legacy plane, honest null on the kernel plane', () => {
    expect(wallpaperBackgroundUrl(undefined)).toBeNull();
    mocks.isKernelMode.mockReturnValue(false);
    expect(wallpaperBackgroundUrl('wall-of-storms.webp')).toBe(
      '/api/v2/assets/backgrounds/wall-of-storms.webp',
    );
    expect(wallpaperBackgroundUrl('a b.png')).toBe('/api/v2/assets/backgrounds/a%20b.png');
    mocks.isKernelMode.mockReturnValue(true);
    expect(wallpaperBackgroundUrl('wall-of-storms.webp')).toBeNull();
    mocks.isKernelMode.mockReturnValue(true);
  });

  it('refuses asset content on the legacy plane honestly (no silent downgrade)', async () => {
    mocks.isKernelMode.mockReturnValue(false);
    await expect(readAssetContentDataUrl(CHAR_ID)).rejects.toBeInstanceOf(UnsupportedError);
    mocks.isKernelMode.mockReturnValue(true);
  });

  it('publishes an avatar asset and links it via the kernel character update', async () => {
    mocks.assets.put.mockResolvedValue({
      asset: {
        id: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
        kind: 'avatar',
        relativeKey: 'avatar/abc.png',
        checksumSha256: 'abc',
        sizeBytes: 1,
        createdAt: NOW,
      },
      deduplicated: false,
    });
    mocks.characters.update.mockResolvedValue({
      ...WIRE_CHARACTER,
      avatarAssetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
    const result = await uploadCharacterAvatar(
      CHAR_ID,
      new File(['x'], 'alice.png', { type: 'image/png' }),
    );
    expect(result.avatarAssetId).toBe('0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f');
    expect(result.avatar).toBeNull();
    expect(mocks.assets.put).toHaveBeenCalledWith({
      kind: 'avatar',
      filename: 'alice.png',
      contentType: 'image/png',
      contentBase64: 'eA==',
    });
    expect(mocks.characters.update).toHaveBeenCalledWith({
      characterId: CHAR_ID,
      avatarAssetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
  });

  it('forwards an avatarAssetId in the kernel character update patch', async () => {
    mocks.characters.update.mockResolvedValue({
      ...WIRE_CHARACTER,
      avatarAssetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
    const character = await updateCharacter(CHAR_ID, {
      name: 'Alice II',
      avatarAssetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
    expect(character.avatarAssetId).toBe('0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f');
    expect(mocks.characters.update).toHaveBeenCalledWith({
      characterId: CHAR_ID,
      name: 'Alice II',
      avatarAssetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
  });
});

describe('wire→UI translation', () => {
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

  it('maps a wire chat onto the full Chat with the persona link (Этап 4 slice 3)', () => {
    const chat = translateChat(WIRE_CHAT);
    expect(chat.personaId).toBe('0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f');
    expect(chat.activeBranchId).toBeNull();
    expect(chat.summary).toBe('');
    expect(chat.deletedAt).toBeNull();
    // Without a linked persona the field is an honest null.
    expect(translateChat({ ...WIRE_CHAT, personaId: undefined }).personaId).toBeNull();
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
      meta: { manualExcluded: false },
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

  it('continues with a persona link (Этап 4 slice 3)', async () => {
    mocks.chats.list.mockResolvedValue({ items: [], nextCursor: null });
    mocks.chats.create.mockResolvedValue(WIRE_CHAT);
    const result = await continueCharacterChat({
      characterId: CHAR_ID,
      title: 'T',
      personaId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
    expect(result).toEqual({ chatId: CHAT_ID, created: true });
    expect(mocks.chats.create).toHaveBeenCalledWith({
      characterId: CHAR_ID,
      title: 'T',
      personaId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
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

  it('creates a chat with a persona link (Этап 4 slice 3)', async () => {
    mocks.chats.create.mockResolvedValue(WIRE_CHAT);
    const chat = await createChat({
      characterId: CHAR_ID,
      personaId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
    expect(mocks.chats.create).toHaveBeenCalledWith({
      characterId: CHAR_ID,
      personaId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
    expect(chat.personaId).toBe('0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f');
  });

  it('rejects greeting inputs and missing character honestly', async () => {
    await expect(createChat({ greetingIndex: 2 })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(createChat({ personaId: 'p1' })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(createChat({})).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('renames and re-links the persona; rejects null clear and other fields', async () => {
    mocks.chats.update.mockResolvedValue(WIRE_CHAT);
    await updateChat(CHAT_ID, { title: 'Renamed' });
    expect(mocks.chats.update).toHaveBeenCalledWith({ chatId: CHAT_ID, title: 'Renamed' });
    await updateChat(CHAT_ID, {
      personaId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
    expect(mocks.chats.update).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      personaId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    });
    await expect(updateChat(CHAT_ID, { summary: 's' })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(updateChat(CHAT_ID, { personaId: null })).rejects.toBeInstanceOf(UnsupportedError);
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

  it('patches message meta through the canonical messages.update op', async () => {
    mocks.chats.updateMessage.mockResolvedValue({
      ...WIRE_MESSAGE_DTO,
      meta: { manualExcluded: true },
    });
    const message = await updateChatMessage(CHAT_ID, MESSAGE_ID, {
      meta: { manualExcluded: true },
    });
    expect(mocks.chats.updateMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
      meta: { manualExcluded: true },
    });
    expect(message.meta).toEqual({ manualExcluded: true });
  });

  it('patches content + meta together on the kernel plane', async () => {
    mocks.chats.updateMessage.mockResolvedValue({
      ...WIRE_MESSAGE_DTO,
      content: 'Rewritten',
      meta: { greeting: true, swipes: ['a'], swipeId: 0 },
    });
    const message = await updateChatMessage(CHAT_ID, MESSAGE_ID, {
      content: 'Rewritten',
      meta: { greeting: true, swipes: ['a'], swipeId: 0 },
    });
    expect(mocks.chats.updateMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
      content: 'Rewritten',
      meta: { greeting: true, swipes: ['a'], swipeId: 0 },
    });
    expect(message.content).toBe('Rewritten');
    expect(message.meta.swipeId).toBe(0);
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
    expect(mocks.lorebooks.list).toHaveBeenCalledWith({});
    expect(page).toEqual({
      items: [expect.objectContaining({ id: WIRE_LOREBOOK.id, name: 'Arcanum' })],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('forwards a character-scoped catalog to the kernel (ADR-0047 waiver 2)', async () => {
    mocks.lorebooks.list.mockResolvedValue({ items: [WIRE_LOREBOOK] });
    const page = await readLorebooks({ characterId: CHAR_ID });
    expect(mocks.lorebooks.list).toHaveBeenCalledWith({ characterId: CHAR_ID });
    expect(page.items).toHaveLength(1);
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

  it('creates a lorebook bound to a character (ADR-0047 waiver 2)', async () => {
    mocks.lorebooks.create.mockResolvedValue(WIRE_LOREBOOK);
    await createLorebook({ name: 'X', characterId: CHAR_ID });
    expect(mocks.lorebooks.create).toHaveBeenCalledWith({
      name: 'X',
      characterId: CHAR_ID,
    });
  });

  it('updates name/description and forwards a character link move', async () => {
    mocks.lorebooks.update.mockResolvedValue(WIRE_LOREBOOK);
    await updateLorebook(WIRE_LOREBOOK.id, { name: 'Renamed', description: 'd' });
    expect(mocks.lorebooks.update).toHaveBeenCalledWith({
      lorebookId: WIRE_LOREBOOK.id,
      name: 'Renamed',
      description: 'd',
    });
    await updateLorebook(WIRE_LOREBOOK.id, { characterId: CHAR_ID });
    expect(mocks.lorebooks.update).toHaveBeenCalledWith({
      lorebookId: WIRE_LOREBOOK.id,
      characterId: CHAR_ID,
    });
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
    expect(translateMemory({ ...WIRE_MEMORY, scope: 'global', characterId: undefined })).toEqual(
      expect.objectContaining({ scope: 'global', characterId: null }),
    );
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

describe('themes (Этап 4 context 6 part 3, wire themes.*)', () => {
  const THEME_DTO = {
    id: 'wii-u-dark',
    name: 'Wii U Dark',
    version: '1.2.0',
    active: true,
    trustState: 'verified' as const,
    cssAssetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
    installedAt: NOW,
    updatedAt: NOW,
    manifest: { name: 'Wii U Dark', version: '1.2.0' },
  };

  it('lists themes and resolves the active id through the facade', async () => {
    mocks.themes.list.mockResolvedValue({
      items: [
        THEME_DTO,
        { ...THEME_DTO, id: 'plain', name: 'Plain', active: false, cssAssetId: undefined },
      ],
    });
    mocks.assets.content.mockResolvedValue({
      assetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
      contentType: 'text/css',
      contentBase64: 'Ym9keXt9',
    });
    const result = await readThemes();
    expect(result.activeThemeId).toBe('wii-u-dark');
    expect(result.items).toHaveLength(2);
    const [first, second] = result.items;
    expect(first?.id).toBe('wii-u-dark');
    expect(first?.componentsCssUrl).toBe('data:text/css;base64,Ym9keXt9');
    expect(first?.shellCssUrl).toBeNull();
    expect(first?.previewUrl).toBeNull();
    expect(second?.componentsCssUrl).toBeNull();
    expect(mocks.themes.list).toHaveBeenCalledWith();
  });

  it('degrades honestly when the css asset read fails', async () => {
    mocks.themes.list.mockResolvedValue({ items: [THEME_DTO] });
    mocks.assets.content.mockRejectedValue(new Error('cap'));
    const result = await readThemes();
    expect(result.items[0]?.componentsCssUrl).toBeNull();
  });

  it('activates a theme through the facade', async () => {
    mocks.themes.activate.mockResolvedValue(THEME_DTO);
    const result = await activateTheme('wii-u-dark');
    expect(result.activeThemeId).toBe('wii-u-dark');
    expect(mocks.themes.activate).toHaveBeenCalledWith('wii-u-dark');
  });

  it('deletes a theme and reports the truthful remaining active theme', async () => {
    mocks.themes.uninstall.mockResolvedValue({ ok: true });
    mocks.themes.list.mockResolvedValue({ items: [THEME_DTO] });
    mocks.assets.content.mockResolvedValue({
      assetId: '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f',
      contentType: 'text/css',
      contentBase64: 'Ym9keXt9',
    });
    const result = await deleteTheme('plain');
    expect(mocks.themes.uninstall).toHaveBeenCalledWith('plain');
    expect(result.deleted).toBe(true);
    expect(result.activeThemeId).toBe('wii-u-dark');
  });

  it('rejects install and reset on the kernel plane honestly', async () => {
    await expect(installTheme(new File(['z'], 't.zip'))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(resetActiveTheme()).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('reports no theme settings and no user css on the kernel plane', async () => {
    expect(await readThemeSettings('wii-u-dark')).toBeUndefined();
    expect(userCssUrl()).toBeNull();
  });
});

describe('plugins (Этап 4 context 6 part 4, wire plugins.*)', () => {
  const PLUGIN_DTO = {
    id: 'lorebook-searcher',
    name: 'Lorebook Searcher',
    version: '1.3.0',
    enabled: true,
    trustState: 'verified-publisher' as const,
    publisherKeyId: 'k-abc',
    permissions: ['plugin.storage', 'lorebooks.list'],
    installedAt: NOW,
    updatedAt: NOW,
    manifest: { name: 'Lorebook Searcher', version: '1.3.0' },
  };

  it('lists plugins with honest neutral fields through the facade', async () => {
    mocks.plugins.list.mockResolvedValue({
      items: [PLUGIN_DTO, { ...PLUGIN_DTO, id: 'off', name: 'Off', enabled: false }],
    });
    const result = await readPlugins();
    expect(result.safeMode).toBe(false);
    const [on, off] = result.items;
    expect(on?.enabled).toBe(true);
    expect(on?.status).toBe('active');
    expect(on?.grantedPermissions).toEqual(['plugin.storage', 'lorebooks.list']);
    expect(on?.requestedPermissions).toEqual([]);
    expect(on?.trust).toBe('verified-publisher');
    expect(on?.publisherKeyId).toBe('k-abc');
    expect(on?.compatibilityLevel).toBe('native-v3');
    expect(on?.hasLegacyFrontend).toBe(false);
    expect(off?.status).toBe('disabled');
    expect(mocks.plugins.list).toHaveBeenCalledWith();
  });

  it('maps a last error to the error status', async () => {
    mocks.plugins.list.mockResolvedValue({
      items: [{ ...PLUGIN_DTO, enabled: true, lastErrorCode: 'E_BOOM' }],
    });
    const result = await readPlugins();
    expect(result.items[0]?.status).toBe('error');
    expect(result.items[0]?.lastErrorCode).toBe('E_BOOM');
  });

  it('activates a plugin when the requested permissions match the record', async () => {
    mocks.plugins.list.mockResolvedValue({ items: [PLUGIN_DTO] });
    mocks.plugins.enable.mockResolvedValue(PLUGIN_DTO);
    const result = await activatePlugin('lorebook-searcher', {
      grantedPermissions: ['lorebooks.list', 'plugin.storage'],
    });
    expect(result.plugin.enabled).toBe(true);
    expect(mocks.plugins.enable).toHaveBeenCalledWith('lorebook-searcher');
  });

  it('refuses a permission change that the wire cannot express', async () => {
    mocks.plugins.list.mockResolvedValue({ items: [PLUGIN_DTO] });
    await expect(
      activatePlugin('lorebook-searcher', { grantedPermissions: ['lorebooks.list'] }),
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(mocks.plugins.enable).not.toHaveBeenCalled();
  });

  it('disables and deletes through the facade', async () => {
    mocks.plugins.disable.mockResolvedValue({ ...PLUGIN_DTO, enabled: false });
    const disabled = await disablePlugin('lorebook-searcher');
    expect(disabled.plugin.enabled).toBe(false);
    expect(mocks.plugins.disable).toHaveBeenCalledWith('lorebook-searcher');

    mocks.plugins.uninstall.mockResolvedValue({ ok: true });
    const removed = await deletePlugin('lorebook-searcher');
    expect(removed.deleted).toBe(true);
    expect(mocks.plugins.uninstall).toHaveBeenCalledWith('lorebook-searcher');
  });

  it('rejects host-side and executor-only flows on the kernel plane honestly', async () => {
    await expect(installPlugin(new File(['z'], 'p.zip'))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(installPluginFromGit({ url: 'https://example.com/repo' })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    await expect(enterPluginSafeMode()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(exitPluginSafeMode()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(readPluginAuthConnections('lorebook-searcher')).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    await expect(
      connectPluginAuth('lorebook-searcher', { serviceId: 'github' }),
    ).rejects.toBeInstanceOf(UnsupportedError);
    await expect(
      revokePluginAuth('lorebook-searcher', { connectionId: 'c1' }),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('meta (wire meta.get)', () => {
  it('reads the app version through the facade', async () => {
    mocks.metaFn.mockResolvedValue({
      appVersion: '4.5.0',
      api: { major: 3, minor: 2 },
      productWire: { major: 1, minor: 0 },
      minimumClientVersion: '4.0.0',
      features: { 'characters.list': 1 },
    });
    const version = await readAppVersion();
    expect(version.name).toBe('NeoTavern');
    expect(version.version).toBe('4.5.0');
    expect(version.apiVersion).toBe(3);
    expect(mocks.metaFn).toHaveBeenCalledWith();
  });
});

describe('settings (wire settings.get/update)', () => {
  const NOW = '2026-08-20T00:00:00Z';

  it('reads the full AppSettings projection with defaults and scalar unwrap', async () => {
    mocks.settings.get.mockResolvedValue({
      items: [
        { key: 'language', value: { value: 'ru' }, updatedAt: NOW },
        { key: 'max-context-tokens', value: { value: 32000 }, updatedAt: NOW },
        { key: 'prompt-template', value: { system: 'You are {{char}}.' }, updatedAt: NOW },
      ],
    });
    const settings = await readSettings();
    expect(settings.language).toBe('ru');
    expect(settings.maxContextTokens).toBe(32000);
    expect(settings.promptTemplate).toEqual({ system: 'You are {{char}}.' });
    // Untouched defaults stay at the contract values.
    expect(settings.themeId).toBeNull();
    expect(settings.contextStrategy).toBe('truncate');
    expect(settings.activePersonaId).toBeNull();
    // Object-valued settings pass through unwrapped.
    expect(settings.generationDefaults).toEqual({});
  });

  it('writes fields through canonical kebab keys with scalar wrapping', async () => {
    mocks.settings.get.mockResolvedValue({ items: [] });
    mocks.settings.update.mockResolvedValue({
      items: [
        { key: 'theme-id', value: { value: null }, updatedAt: NOW },
        { key: 'last-server', value: { providerConfigId: 'p1', model: 'gpt-4o' }, updatedAt: NOW },
      ],
    });
    const result = await updateSettings({
      themeId: null,
      lastServer: { providerConfigId: 'p1', model: 'gpt-4o' },
    });
    expect(mocks.settings.update).toHaveBeenCalledWith({
      settings: [
        { key: 'theme-id', value: { value: null } },
        { key: 'last-server', value: { providerConfigId: 'p1', model: 'gpt-4o' } },
      ],
    });
    // Post-update projection re-reads the full snapshot.
    expect(result.themeId).toBeNull();
    expect(result.lastServer).toEqual({ providerConfigId: 'p1', model: 'gpt-4o' });
  });

  it('normalizes the extensions.legacyFrontend key', async () => {
    mocks.settings.update.mockResolvedValue({ items: [] });
    await updateSettings({ 'extensions.legacyFrontend': true });
    expect(mocks.settings.update).toHaveBeenCalledWith({
      settings: [{ key: 'extensions.legacy-frontend', value: { value: true } }],
    });
  });
});

describe('imports/exports (kernel plane honest refusals)', () => {
  it('refuses character card export on the kernel plane', async () => {
    await expect(exportCharacterCard('c1', 'png')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(exportCharacterCard('c1', 'json')).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('refuses chat export on the kernel plane', async () => {
    await expect(exportChat('chat-1')).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('refuses character import on the kernel plane', async () => {
    await expect(importCharacter(new File(['x'], 'card.png'))).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });

  it('refuses provider model discovery on the kernel plane', async () => {
    await expect(warmProviderModels('p1')).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('legacy bridge message creation', () => {
  it('routes sendChatMessage to chats.messages.create on the kernel plane', async () => {
    mocks.chats.createMessage.mockResolvedValue({
      id: MESSAGE_ID,
      chatId: CHAT_ID,
      role: 'user',
      content: 'Hello',
      createdAt: NOW_MS,
      sequence: 1,
      meta: {},
    });
    const message = await createBridgeChatMessage(CHAT_ID, 'Hello');
    expect(mocks.chats.createMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      role: 'user',
      content: 'Hello',
    });
    expect(message.id).toBe(MESSAGE_ID);
    expect(message.content).toBe('Hello');
  });
});
