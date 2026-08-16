/**
 * NeoBackend facade tests (ТЗ §15): Local/Remote parity, local kernel
 * validation, and LegacyBackend mapping. No server is started — the local
 * transport is faked and the remote transport runs over a stub fetch.
 */
import { describe, expect, it } from 'vitest';
import {
  WIRE_SCHEMA_HASH,
  type AssetDto,
  type CharacterDto,
  type CreateProfileResultDto,
  type DiagnosticsExportResultDto,
  type GenerationRunDto,
  type GetAssetContentResultDto,
  type GetAssetResultDto,
  type InstallPluginResultDto,
  type InstallThemeResultDto,
  type ListLorebooksResultDto,
  type ListMemoriesResultDto,
  type LorebookDto,
  type ListPluginsResultDto,
  type ListPresetsResultDto,
  type ListProfilesResultDto,
  type ListProvidersResultDto,
  type ListThemesResultDto,
  type ListToolsResultDto,
  type ListMessageRevisionsResultDto,
  type ListMessageVariantsResultDto,
  type EmptyResultDto,
  type MemoryDto,
  type MessageDraftDto,
  type MessageRevisionDto,
  type MessageVariantDto,
  type MetaDto,
  type PagedCharactersDto,
  type PagedGenerationEventsDto,
  type PagedMessagesDto,
  type CharacterCardExportResultDto,
  type CharacterCardImportResultDto,
  type ChatsExportResultDto,
  type PromptPlanDto,
  type BackupsRestoreResultDto,
  type DataActivationStatusResultDto,
  type PluginDto,
  type PresetDto,
  type ProfileDto,
  type ProfileExportResultDto,
  type ProfileImportResultDto,
  type PutAssetResultDto,
  type ResultSettingsDto,
  type SecretsStatusResultDto,
  type ThemeDto,
  type WireGenerationEvent,
} from '@neotavern/contracts';
import { ClientSdk, HttpTransport, ProductError, type StreamEvent } from '@neotavern/client-sdk';
import {
  ContractMismatchError,
  LegacyBackend,
  LocalBackend,
  RemoteBackend,
  UnsupportedError,
  ValidationError,
  type LocalCallResult,
  type LocalTransport,
} from '../src/index.js';

const CHARACTER: CharacterDto = {
  id: '9f8e7d6c-5b4a-4932-81f0-123456789abc',
  name: 'Ada Lovelace',
  description: 'First programmer; canonical fixture.',
  tags: ['scientist', 'pioneer'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const PAGED_CHARACTERS: PagedCharactersDto = {
  items: [CHARACTER],
  nextCursor: 'page-2',
};

const META: MetaDto = {
  appVersion: '0.1.0',
  api: { major: 2, minor: 0 },
  productWire: { major: 1, minor: 0 },
  features: { core: 1 },
};

// --- Canonical providers fixture (wire fixture shape from
// `packages/contracts/src/wire/registry.ts` PROVIDER_VALUE). ---
const PROVIDERS: ListProvidersResultDto = {
  items: [
    {
      id: 'fake',
      name: 'Fake Provider',
      builtin: true,
      availability: { status: 'available' },
      capabilities: {
        tools: false,
        vision: false,
        thinking: false,
        jsonMode: false,
        streaming: true,
      },
      models: [{ id: 'fake-1', name: 'Fake 1', contextLimit: 8192 }],
    },
  ],
};

// --- Canonical generation fixtures (ТЗ §62–64, Phase 6). ---
const RUN_ID = '6f5e4d3c-2b1a-4f0e-9d8c-7a6b5c4d3e2f';
const CHAT_ID = '01234567-89ab-4cde-8f01-23456789abcd';
const BACKUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = '12345678-90ab-4cde-8f01-23456789abcd';
const TIMESTAMP = '2026-06-01T12:00:00.000Z';

// --- Canonical memories/presets fixtures (Этап 4 slice 3; wire fixture
// shapes from `packages/contracts/src/wire/registry.ts` MEMORY_VALUE and
// PRESET_VALUE). ---
const PRESET: PresetDto = {
  id: '3c4d5e6f-7a8b-4c0d-9e1f-2a3b4c5d6e7f',
  kind: 'generation',
  name: 'Balanced',
  data: { maxContextTokens: 8192, generationDefaults: { temperature: 0.8 } },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PRESET_LIST: ListPresetsResultDto = { items: [PRESET] };

const MEMORY: MemoryDto = {
  id: '4d5e6f70-8a9b-4c1d-9e2f-3a4b5c6d7e80',
  scope: 'character',
  characterId: CHARACTER.id,
  keys: ['aria', 'clockwork'],
  content: 'Aria guards the clockwork orchard.',
  enabled: true,
  position: 0,
  metadata: { source: 'canonical' },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const MEMORY_LIST: ListMemoriesResultDto = { items: [MEMORY] };

const LOREBOOK: LorebookDto = {
  id: '4d5e6f70-8a9b-4c1d-9e2f-3a4b5c6d7e81',
  name: 'World lore',
  description: 'Shared world facts',
  entryCount: 2,
  characterId: CHARACTER.id,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const LOREBOOK_LIST: ListLorebooksResultDto = { items: [LOREBOOK] };

// --- M5 slice 6/7 canonical fixtures (wire fixture shapes from
// `packages/contracts/src/wire/registry.ts`: PLUGIN_VALUE, THEME_VALUE,
// PROFILE_VALUE, SETTINGS_VALUE, DIAGNOSTICS_VALUE, SECRETS_STATUS_VALUE). ---
const PLUGIN: PluginDto = {
  id: 'lorebook-searcher',
  name: 'Lorebook Searcher',
  version: '1.2.0',
  enabled: false,
  trustState: 'verified-publisher',
  publisherKeyId: 'fp-9f2c7a1b',
  permissions: ['plugin.storage', 'lorebooks.list'],
  installedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  manifest: { id: 'lorebook-searcher', main: 'dist/index.js' },
};
const PLUGIN_LIST: ListPluginsResultDto = { items: [PLUGIN] };
const PLUGIN_INSTALL: InstallPluginResultDto = { plugin: PLUGIN };
const ENABLED_PLUGIN: PluginDto = { ...PLUGIN, enabled: true };

const THEME: ThemeDto = {
  id: 'wii-u-dark',
  name: 'Wii U Dark',
  version: '2.0.1',
  active: false,
  trustState: 'verified-publisher',
  publisherKeyId: 'fp-9f2c7a1b',
  cssAssetId: '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f',
  installedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  manifest: { id: 'wii-u-dark', level: 'shell' },
};
const THEME_LIST: ListThemesResultDto = { items: [THEME] };
const THEME_INSTALL: InstallThemeResultDto = { theme: THEME };
const ACTIVE_THEME: ThemeDto = { ...THEME, active: true };

const PROFILE_ID = 'aaaaaaa4-4444-4444-8444-444444444444';
const PROFILE: ProfileDto = {
  id: PROFILE_ID,
  name: 'Main',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const PROFILE_LIST: ListProfilesResultDto = { items: [PROFILE] };
const PROFILE_CREATE: CreateProfileResultDto = { profile: PROFILE };

/** `profile.export` result (canonical `wire.result.profile-export` shape). */
const PROFILE_EXPORT: ProfileExportResultDto = {
  containerPath: 'exports/profile-aaaaaaa4-4444-4444-8444-444444444444.ndjson.zip',
  formatVersion: 1,
  createdAt: TIMESTAMP,
  records: { characters: 2, chats: 2, messages: 4, lorebooks: 1, presets: 1 },
  assets: 1,
  sizeBytes: 2048,
  manifestSha256: 'f'.repeat(64),
  profileId: PROFILE_ID,
};

/** `profile.import` result (canonical `wire.result.profile-import` shape). */
const PROFILE_IMPORT: ProfileImportResultDto = {
  inserted: 5,
  updated: 0,
  skipped: 1,
  formatVersion: 1,
  appliedAt: TIMESTAMP,
  orphans: ['chat 99999999-9999-4999-8999-999999999999: references missing character'],
};

const SETTINGS: ResultSettingsDto = {
  items: [
    { key: 'ui.theme', value: { theme: 'dark' }, updatedAt: TIMESTAMP },
    { key: 'app.language', value: { locale: 'en' }, updatedAt: TIMESTAMP },
  ],
};

const DIAGNOSTICS: DiagnosticsExportResultDto = {
  generatedAt: TIMESTAMP,
  traceId: RUN_ID,
  schemaHash: 'a'.repeat(64),
  schemaRevision: 14,
  storageFormat: 1,
  sqliteVersion: '3.49.0',
  appVersion: '0.1.0',
  wireVersion: { major: 1, minor: 0 },
  redaction: 'allowlist',
  sections: ['meta', 'storage', 'settings', 'generation'],
  settings: { count: 2 },
  generationRuns: { total: 1, completed: 1, failed: 0, waiting: 0 },
};

const SECRETS_STATUS: SecretsStatusResultDto = {
  kind: 'portable',
  persistent: true,
  writable: true,
  available: true,
  recordCount: 2,
  formatVersion: 1,
};

const ASSET_ID = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f';
const ASSET: AssetDto = {
  id: ASSET_ID,
  kind: 'avatar',
  relativeKey: 'avatar/9f2c7a1b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80.png',
  checksumSha256: '9f2c7a1b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8',
  sizeBytes: 512,
  createdAt: TIMESTAMP,
};
const ASSET_GET: GetAssetResultDto = { asset: ASSET };
const ASSET_CONTENT: GetAssetContentResultDto = {
  assetId: ASSET_ID,
  contentType: 'image/png',
  contentBase64: 'iVBORw0KGgoAAAANSUhEUg==',
};
const ASSET_PUT: PutAssetResultDto = { asset: ASSET, deduplicated: false };

/** `imports.character.card` response (Этап 4.5): the imported character. */
const CHARACTER_CARD_IMPORT: CharacterCardImportResultDto = {
  character: {
    id: CHARACTER.id,
    name: 'Ada Lovelace',
    description: 'First programmer of the analytical engine.',
    avatarAssetId: ASSET_ID,
    tags: ['analytical', 'historical'],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  created: true,
  sourceHash: 'abababababababababababababababababababababababababababababababab',
  warnings: [],
};

/** `characters.export.card` response (Этап 4.5): the exported container. */
const CHARACTER_CARD_EXPORT: CharacterCardExportResultDto = {
  filename: 'ada-lovelace.json',
  contentType: 'application/json',
  contentBase64: 'eyJuYW1lIjoiQWRhIExvdmVsYWNlIn0=',
  warnings: [],
};

/** `chats.export` response (М5 slice 36): the chat dump container. */
const CHAT_EXPORT: ChatsExportResultDto = {
  filename: 'chat-018f0000-0000-7000-8000-000000000099.json',
  contentType: 'application/json',
  contentBase64: 'eyJraW5kIjoibmVvdGF2ZXJuYS1jaGF0LWV4cG9ydCJ9',
  warnings: [],
};

/** `generation.prompt.plan` response (М5 slice 37): the durable plan. */
const PROMPT_PLAN: PromptPlanDto = {
  runId: RUN_ID,
  chatId: CHAT_ID,
  provider: 'openai-compatible',
  model: 'gpt-4o-mini',
  instructFormat: 'chatml',
  tokenizerProfile: 'heuristic',
  approximateTokens: true,
  contextLimit: 8192,
  responseReserved: 1024,
  inputTokens: 1200,
  overBudget: false,
  userName: 'Ada',
  systemBlocks: [
    { source: 'character', text: 'You are Ada Lovelace.' },
    { source: 'instruct', text: 'Respond as Ada.' },
  ],
  messages: [{ role: 'user', content: 'Hello.' }],
  excluded: [],
  createdAt: TIMESTAMP,
};

/** `data.activation.status` response (М5 slice 38): durable activation state. */
const ACTIVATION_STATUS: DataActivationStatusResultDto = {
  layoutVersion: 2,
  activeRootId: 'a1b2c3d4',
  activeRoot: '/data/neotavern/roots/root-a1b2c3d4',
  journalFormat: 'neotavern-activation-journal',
  journalFormatVersion: 2,
  entries: [
    {
      id: '1f2e3d4c-5b6a-4a98-8765-4321fedcba98',
      kind: 'restore',
      status: 'committed',
      fromRoot: '/data/neotavern/roots/root-old',
      toRoot: '/data/neotavern/roots/root-a1b2c3d4',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
  ],
};

/** `backups.restore` response (М5 slice 39): the activation outcome. */
const RESTORE_RESULT: BackupsRestoreResultDto = {
  status: 'committed',
};

/** `chats.messages.list` response: one canonical wire message (Этап 2.10). */
const PAGED_MESSAGES: PagedMessagesDto = {
  items: [
    {
      id: MESSAGE_ID,
      chatId: CHAT_ID,
      role: 'assistant',
      content: 'Hello world.',
      createdAt: TIMESTAMP,
      sequence: 0,
      generationRunId: RUN_ID,
      meta: {},
    },
  ],
  nextCursor: 'page-2',
};

const GENERATION_RUN: GenerationRunDto = {
  runId: RUN_ID,
  chatId: CHAT_ID,
  attempt: 2,
  status: 'completed',
  provider: 'fake',
  model: 'steps=4',
  revision: 12,
  lastEventSequence: 9,
  partialTextLength: 0,
  partialTruncated: false,
  messageId: MESSAGE_ID,
  startedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

/** `generation.keep` response: run kept as a final assistant message. */
const KEEP_RUN: GenerationRunDto = { ...GENERATION_RUN, status: 'failed' };

/** `generation.discard` response: partial output dropped. */
const DISCARD_RUN: GenerationRunDto = { ...GENERATION_RUN, status: 'interrupted' };

/** `generation.tools.list` response: one registered tool (Этап 2.10). */
const TOOLS: ListToolsResultDto = {
  items: [
    {
      id: 'lookup-weather',
      name: 'Lookup weather',
      description: 'Fake tool for the golden slice.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ],
};

/** `generation.tool.result` response: the resumed run (still waiting). */
const TOOL_RESULT_RUN: GenerationRunDto = { ...GENERATION_RUN, status: 'waiting_for_tool' };

// --- Этап 4 slice 2 fixtures: message variants / revisions / drafts. ---
const VARIANT_ID = 'aaaaaaa1-1111-4111-8111-111111111111';
const REVISION_ID = 'aaaaaaa2-2222-4222-8222-222222222222';
const DRAFT_ID = 'aaaaaaa3-3333-4333-8333-333333333333';

const WIRE_VARIANT: MessageVariantDto = {
  id: VARIANT_ID,
  messageId: MESSAGE_ID,
  content: 'Hello (swipe)',
  position: 0,
  createdAt: TIMESTAMP,
};
const VARIANT_LIST: ListMessageVariantsResultDto = { items: [WIRE_VARIANT] };

const WIRE_REVISION: MessageRevisionDto = {
  id: REVISION_ID,
  messageId: MESSAGE_ID,
  content: 'Hello',
  position: 0,
  createdAt: TIMESTAMP,
};
const REVISION_LIST: ListMessageRevisionsResultDto = { items: [WIRE_REVISION] };

const WIRE_DRAFT: MessageDraftDto = {
  id: DRAFT_ID,
  chatId: CHAT_ID,
  role: 'assistant',
  content: 'Streaming…',
  sequence: 3,
  revision: 2,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const EMPTY_RESULT: EmptyResultDto = {};

/** `generation.events` response: canonical event page. */
const GENERATION_EVENTS: PagedGenerationEventsDto = {
  items: [
    {
      streamId: RUN_ID,
      sequence: 0,
      type: 'generation.delta',
      payload: { type: 'generation.delta', text: 'Hello' },
    },
    {
      streamId: RUN_ID,
      sequence: 1,
      type: 'generation.checkpoint',
      payload: { type: 'generation.checkpoint', sequence: 1, partialLength: 5 },
    },
  ],
  hasMore: false,
};

const FINAL_MESSAGE = {
  id: MESSAGE_ID,
  chatId: CHAT_ID,
  role: 'assistant',
  content: 'Attempt two: hello world.',
  createdAt: '2026-06-02T10:00:00.000Z',
  sequence: 0,
  generationRunId: RUN_ID,
  meta: {},
};

/** Events streamed by `generation.start` / `generation.retry` (identical on both transports). */
const GENERATION_STREAM_EVENTS: WireGenerationEvent[] = [
  { type: 'generation.delta', text: 'Attempt two: hello ' },
  { type: 'generation.delta', text: 'world.' },
  { type: 'generation.checkpoint', sequence: 1, partialLength: 21 },
  { type: 'generation.completed', finalMessage: FINAL_MESSAGE },
];

/** In-process kernel transport returning canned canonical wire values. */
class FakeKernelTransport implements LocalTransport {
  calls = 0;
  requests: Array<{ operationId: string; payload: unknown }> = [];

  async call(
    operationId: string,
    payload: unknown,
    _opts: { signal?: AbortSignal },
  ): Promise<LocalCallResult> {
    this.calls += 1;
    this.requests.push({ operationId, payload });
    switch (operationId) {
      case 'characters.list':
        return { ok: true, value: PAGED_CHARACTERS };
      case 'chats.messages.list':
        return { ok: true, value: PAGED_MESSAGES };
      case 'providers.list':
        return { ok: true, value: PROVIDERS };
      case 'generation.get':
        return { ok: true, value: GENERATION_RUN };
      case 'generation.events':
        return { ok: true, value: GENERATION_EVENTS };
      case 'generation.keep':
        return { ok: true, value: KEEP_RUN };
      case 'generation.discard':
        return { ok: true, value: DISCARD_RUN };
      case 'generation.tools.list':
        return { ok: true, value: TOOLS };
      case 'generation.tool.result':
        return { ok: true, value: TOOL_RESULT_RUN };
      case 'chats.messages.variants.list':
        return { ok: true, value: VARIANT_LIST };
      case 'chats.messages.variants.create':
        return { ok: true, value: WIRE_VARIANT };
      case 'chats.messages.variants.activate':
        return { ok: true, value: PAGED_MESSAGES.items[0] };
      case 'chats.messages.variants.delete':
        return { ok: true, value: EMPTY_RESULT };
      case 'chats.messages.revisions.list':
        return { ok: true, value: REVISION_LIST };
      case 'chats.messages.drafts.get':
        return { ok: true, value: WIRE_DRAFT };
      case 'chats.messages.drafts.save':
        return { ok: true, value: WIRE_DRAFT };
      case 'chats.messages.drafts.commit':
        return { ok: true, value: PAGED_MESSAGES.items[0] };
      case 'chats.messages.drafts.discard':
        return { ok: true, value: EMPTY_RESULT };
      case 'presets.list':
        return { ok: true, value: PRESET_LIST };
      case 'presets.get':
      case 'presets.create':
      case 'presets.update':
        return { ok: true, value: PRESET };
      case 'presets.delete':
        return { ok: true, value: EMPTY_RESULT };
      case 'memories.list':
        return { ok: true, value: MEMORY_LIST };
      case 'memories.create':
      case 'memories.update':
        return { ok: true, value: MEMORY };
      case 'memories.delete':
        return { ok: true, value: EMPTY_RESULT };
      case 'plugins.list':
        return { ok: true, value: PLUGIN_LIST };
      case 'plugins.install':
        return { ok: true, value: PLUGIN_INSTALL };
      case 'plugins.enable':
        return { ok: true, value: ENABLED_PLUGIN };
      case 'plugins.disable':
        return { ok: true, value: PLUGIN };
      case 'plugins.uninstall':
        return { ok: true, value: EMPTY_RESULT };
      case 'themes.list':
        return { ok: true, value: THEME_LIST };
      case 'themes.install':
        return { ok: true, value: THEME_INSTALL };
      case 'themes.activate':
        return { ok: true, value: ACTIVE_THEME };
      case 'themes.uninstall':
        return { ok: true, value: EMPTY_RESULT };
      case 'profiles.list':
        return { ok: true, value: PROFILE_LIST };
      case 'profiles.create':
        return { ok: true, value: PROFILE_CREATE };
      case 'profiles.rename':
        return { ok: true, value: PROFILE };
      case 'profiles.delete':
        return { ok: true, value: EMPTY_RESULT };
      case 'profile.export':
        return { ok: true, value: PROFILE_EXPORT };
      case 'profile.import':
        return { ok: true, value: PROFILE_IMPORT };
      case 'settings.get':
      case 'settings.update':
        return { ok: true, value: SETTINGS };
      case 'diagnostics.export':
        return { ok: true, value: DIAGNOSTICS };
      case 'secrets.status':
        return { ok: true, value: SECRETS_STATUS };
      case 'secrets.lock':
        return { ok: true, value: { locked: true } };
      case 'lorebooks.list':
        return { ok: true, value: LOREBOOK_LIST };
      case 'lorebooks.create':
        return { ok: true, value: LOREBOOK };
      case 'assets.get':
        return { ok: true, value: ASSET_GET };
      case 'assets.content':
        return { ok: true, value: ASSET_CONTENT };
      case 'assets.put':
        return { ok: true, value: ASSET_PUT };
      case 'assets.delete':
        return { ok: true, value: EMPTY_RESULT };
      case 'imports.character.card':
        return { ok: true, value: CHARACTER_CARD_IMPORT };
      case 'characters.export.card':
        return { ok: true, value: CHARACTER_CARD_EXPORT };
      case 'chats.export':
        return { ok: true, value: CHAT_EXPORT };
      case 'generation.prompt.plan':
        return { ok: true, value: PROMPT_PLAN };
      case 'data.activation.status':
        return { ok: true, value: ACTIVATION_STATUS };
      case 'backups.restore':
        return { ok: true, value: RESTORE_RESULT };
      default:
        return { ok: false, error: { code: 'NOT_FOUND', params: {}, traceId: 'kernel-trace' } };
    }
  }

  async *stream(
    operationId: string,
    _payload: unknown,
    _opts: { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent> {
    if (operationId === 'generation.start' || operationId === 'generation.retry') {
      for (const [index, event] of GENERATION_STREAM_EVENTS.entries()) {
        yield { streamId: RUN_ID, sequence: index, type: event.type, payload: event };
      }
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Canonical `POST /rpc` result for an operation (null when not stubbed). */
function rpcResult(operationId: string | undefined): unknown {
  switch (operationId) {
    case 'characters.list':
      return PAGED_CHARACTERS;
    case 'chats.messages.list':
      return PAGED_MESSAGES;
    case 'providers.list':
      return PROVIDERS;
    case 'generation.get':
      return GENERATION_RUN;
    case 'generation.events':
      return GENERATION_EVENTS;
    case 'generation.keep':
      return KEEP_RUN;
    case 'generation.discard':
      return DISCARD_RUN;
    case 'generation.tools.list':
      return TOOLS;
    case 'generation.tool.result':
      return TOOL_RESULT_RUN;
    case 'chats.messages.variants.list':
      return VARIANT_LIST;
    case 'chats.messages.variants.create':
      return WIRE_VARIANT;
    case 'chats.messages.variants.activate':
      return PAGED_MESSAGES.items[0];
    case 'chats.messages.variants.delete':
      return EMPTY_RESULT;
    case 'chats.messages.revisions.list':
      return REVISION_LIST;
    case 'chats.messages.drafts.get':
      return WIRE_DRAFT;
    case 'chats.messages.drafts.save':
      return WIRE_DRAFT;
    case 'chats.messages.drafts.commit':
      return PAGED_MESSAGES.items[0];
    case 'chats.messages.drafts.discard':
      return EMPTY_RESULT;
    case 'presets.list':
      return PRESET_LIST;
    case 'presets.get':
    case 'presets.create':
    case 'presets.update':
      return PRESET;
    case 'presets.delete':
      return EMPTY_RESULT;
    case 'memories.list':
      return MEMORY_LIST;
    case 'memories.create':
    case 'memories.update':
      return MEMORY;
    case 'memories.delete':
      return EMPTY_RESULT;
    case 'plugins.list':
      return PLUGIN_LIST;
    case 'plugins.install':
      return PLUGIN_INSTALL;
    case 'plugins.enable':
      return ENABLED_PLUGIN;
    case 'plugins.disable':
      return PLUGIN;
    case 'plugins.uninstall':
      return EMPTY_RESULT;
    case 'themes.list':
      return THEME_LIST;
    case 'themes.install':
      return THEME_INSTALL;
    case 'themes.activate':
      return ACTIVE_THEME;
    case 'themes.uninstall':
      return EMPTY_RESULT;
    case 'profiles.list':
      return PROFILE_LIST;
    case 'profiles.create':
      return PROFILE_CREATE;
    case 'profiles.rename':
      return PROFILE;
    case 'profiles.delete':
      return EMPTY_RESULT;
    case 'profile.export':
      return PROFILE_EXPORT;
    case 'profile.import':
      return PROFILE_IMPORT;
    case 'settings.get':
    case 'settings.update':
      return SETTINGS;
    case 'diagnostics.export':
      return DIAGNOSTICS;
    case 'secrets.status':
      return SECRETS_STATUS;
    case 'secrets.lock':
      return { locked: true };
    case 'lorebooks.list':
      return LOREBOOK_LIST;
    case 'lorebooks.create':
      return LOREBOOK;
    case 'assets.get':
      return ASSET_GET;
    case 'assets.content':
      return ASSET_CONTENT;
    case 'assets.put':
      return ASSET_PUT;
    case 'assets.delete':
      return EMPTY_RESULT;
    case 'imports.character.card':
      return CHARACTER_CARD_IMPORT;
    case 'characters.export.card':
      return CHARACTER_CARD_EXPORT;
    case 'chats.export':
      return CHAT_EXPORT;
    case 'generation.prompt.plan':
      return PROMPT_PLAN;
    case 'data.activation.status':
      return ACTIVATION_STATUS;
    case 'backups.restore':
      return RESTORE_RESULT;
    default:
      return null;
  }
}

/**
 * Stub fetch serving the ClientSdk HttpTransport surface: `GET /meta` for the
 * handshake, `POST /rpc` with a canonical RequestEnvelope → ResponseEnvelope,
 * and `POST /stream` with NDJSON event envelopes for streaming operations.
 */
class StubFetch {
  readonly rpcRequests: Array<{ operationId: string; requestId: string }> = [];

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(url).pathname;
    if (pathname === '/meta') {
      return jsonResponse(META);
    }
    const envelope = JSON.parse(String(init?.body ?? '{}')) as {
      operationId?: string;
      requestId?: string;
      payload?: unknown;
    };
    if (pathname === '/stream') {
      if (
        envelope.operationId === 'generation.start' ||
        envelope.operationId === 'generation.retry'
      ) {
        const body = GENERATION_STREAM_EVENTS.map((event, index) =>
          JSON.stringify({ streamId: RUN_ID, sequence: index, type: event.type, payload: event }),
        ).join('\n');
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      return jsonResponse({ code: 'INTERNAL', params: {}, traceId: 'stub' }, 404);
    }
    if (pathname === '/rpc') {
      this.rpcRequests.push({
        operationId: envelope.operationId ?? '',
        requestId: envelope.requestId ?? '',
      });
      return jsonResponse({
        kind: 'ok',
        requestId: envelope.requestId ?? 'missing',
        result: rpcResult(envelope.operationId),
      });
    }
    return jsonResponse({ code: 'INTERNAL', params: {}, traceId: 'stub' }, 404);
  };
}

function makeRemoteBackend(): RemoteBackend {
  return new RemoteBackend({
    sdk: new ClientSdk({
      transport: new HttpTransport({ baseUrl: 'http://stub.local', fetchImpl: stub.handle }),
    }),
  });
}

const stub = new StubFetch();

describe('Local vs Remote parity', () => {
  it('characters.list returns deep-equal canonical DTOs from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.characters.list({ limit: 10 }),
      remote.characters.list({ limit: 10 }),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PAGED_CHARACTERS);
  });

  it('chats.messages.list forwards the desc order, deep-equal DTOs (Этап 2.10)', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.chats.listMessages({ chatId: CHAT_ID, order: 'desc' }),
      remote.chats.listMessages({ chatId: CHAT_ID, order: 'desc' }),
    ]);

    expect(kernel.requests).toEqual([
      { operationId: 'chats.messages.list', payload: { chatId: CHAT_ID, order: 'desc' } },
    ]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PAGED_MESSAGES);
  });

  it('remote handshake surfaces validated MetaDto', async () => {
    const remote = makeRemoteBackend();
    await expect(remote.meta()).resolves.toEqual(META);
  });
});

describe('Memories/presets Local vs Remote parity (Этап 4 slice 3)', () => {
  it('presets.list returns deep-equal ListPresetsResultDto from both backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.presets.list({ kind: 'generation' }),
      remote.presets.list({ kind: 'generation' }),
    ]);

    expect(kernel.requests).toEqual([
      { operationId: 'presets.list', payload: { kind: 'generation' } },
    ]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PRESET_LIST);
  });

  it('presets.get/create/update/del forward payloads and decode canonical DTOs', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [getLocal, getRemote] = await Promise.all([
      local.presets.get(PRESET.id),
      remote.presets.get(PRESET.id),
    ]);
    expect(getLocal).toEqual(getRemote);
    expect(getLocal).toEqual(PRESET);

    const createReq = { kind: 'generation', name: 'Balanced', data: { maxContextTokens: 8192 } };
    const [createLocal, createRemote] = await Promise.all([
      local.presets.create(createReq),
      remote.presets.create(createReq),
    ]);
    expect(createLocal).toEqual(createRemote);
    expect(createLocal).toEqual(PRESET);

    const updateReq = { presetId: PRESET.id, name: 'Balanced v2' };
    const [updateLocal, updateRemote] = await Promise.all([
      local.presets.update(updateReq),
      remote.presets.update(updateReq),
    ]);
    expect(updateLocal).toEqual(updateRemote);
    expect(updateLocal).toEqual(PRESET);

    const [delLocal, delRemote] = await Promise.all([
      local.presets.del(PRESET.id),
      remote.presets.del(PRESET.id),
    ]);
    expect(delLocal).toEqual(delRemote);
    expect(delLocal).toEqual(EMPTY_RESULT);

    expect(kernel.requests).toEqual([
      { operationId: 'presets.get', payload: { presetId: PRESET.id } },
      { operationId: 'presets.create', payload: createReq },
      { operationId: 'presets.update', payload: updateReq },
      { operationId: 'presets.delete', payload: { presetId: PRESET.id } },
    ]);
  });

  it('memories.list returns deep-equal ListMemoriesResultDto from both backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const req = { scope: 'character' as const, characterId: CHARACTER.id, enabled: true };
    const [localResult, remoteResult] = await Promise.all([
      local.memories.list(req),
      remote.memories.list(req),
    ]);

    expect(kernel.requests).toEqual([{ operationId: 'memories.list', payload: req }]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(MEMORY_LIST);
  });

  it('memories.create/update/del forward payloads and decode canonical DTOs', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const createReq = {
      scope: 'character' as const,
      characterId: CHARACTER.id,
      keys: ['aria'],
      content: 'Aria guards the clockwork orchard.',
    };
    const [createLocal, createRemote] = await Promise.all([
      local.memories.create(createReq),
      remote.memories.create(createReq),
    ]);
    expect(createLocal).toEqual(createRemote);
    expect(createLocal).toEqual(MEMORY);

    const updateReq = { memoryId: MEMORY.id, content: 'Updated.', enabled: false };
    const [updateLocal, updateRemote] = await Promise.all([
      local.memories.update(updateReq),
      remote.memories.update(updateReq),
    ]);
    expect(updateLocal).toEqual(updateRemote);
    expect(updateLocal).toEqual(MEMORY);

    const [delLocal, delRemote] = await Promise.all([
      local.memories.del(MEMORY.id),
      remote.memories.del(MEMORY.id),
    ]);
    expect(delLocal).toEqual(delRemote);
    expect(delLocal).toEqual(EMPTY_RESULT);

    expect(kernel.requests).toEqual([
      { operationId: 'memories.create', payload: createReq },
      { operationId: 'memories.update', payload: updateReq },
      { operationId: 'memories.delete', payload: { memoryId: MEMORY.id } },
    ]);
  });
});

describe('Providers Local vs Remote parity (Phase 7)', () => {
  it('providers.list returns deep-equal canonical ListProvidersResultDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.providers.list(),
      remote.providers.list(),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PROVIDERS);
  });

  it('providers.list sends the canonical empty request payload to the kernel', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.providers.list()).resolves.toEqual(PROVIDERS);
    expect(kernel.requests).toEqual([{ operationId: 'providers.list', payload: {} }]);
  });
});

describe('Generation Local vs Remote parity (Phase 6)', () => {
  it('generation.get returns deep-equal canonical GenerationRunDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.generation.get(RUN_ID),
      remote.generation.get(RUN_ID),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(GENERATION_RUN);
  });

  it('generation.events returns deep-equal canonical PagedGenerationEventsDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const req = { workflowId: RUN_ID, afterSequence: -1, limit: 50 };
    const [localResult, remoteResult] = await Promise.all([
      local.generation.events(req),
      remote.generation.events(req),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(GENERATION_EVENTS);
  });

  it('generation.keep returns deep-equal canonical GenerationRunDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.generation.keep(RUN_ID),
      remote.generation.keep(RUN_ID),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(KEEP_RUN);
  });

  it('generation.discard returns deep-equal canonical GenerationRunDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.generation.discard(RUN_ID),
      remote.generation.discard(RUN_ID),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(DISCARD_RUN);
  });

  it('generation.start streams the same canonical events from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();
    const req = { chatId: CHAT_ID, message: 'Hello there' };

    const localEvents: WireGenerationEvent[] = [];
    for await (const event of local.generation.start(req)) {
      localEvents.push(event);
    }
    const remoteEvents: WireGenerationEvent[] = [];
    for await (const event of remote.generation.start(req)) {
      remoteEvents.push(event);
    }

    expect(localEvents).toEqual(remoteEvents);
    expect(localEvents).toEqual(GENERATION_STREAM_EVENTS);
  });

  it('generation.retry streams the same canonical events from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const localEvents: WireGenerationEvent[] = [];
    for await (const event of local.generation.retry(RUN_ID)) {
      localEvents.push(event);
    }
    const remoteEvents: WireGenerationEvent[] = [];
    for await (const event of remote.generation.retry(RUN_ID)) {
      remoteEvents.push(event);
    }

    expect(localEvents).toEqual(remoteEvents);
    expect(localEvents).toEqual(GENERATION_STREAM_EVENTS);
  });
});

describe('Generation tools Local vs Remote parity (Этап 2.10)', () => {
  it('generation.tools.list returns deep-equal ListToolsResultDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.generation.tools.list(),
      remote.generation.tools.list(),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(TOOLS);
  });

  it('generation.tools.list sends the canonical empty request payload to the kernel', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.generation.tools.list()).resolves.toEqual(TOOLS);
    expect(kernel.requests).toEqual([{ operationId: 'generation.tools.list', payload: {} }]);
  });

  it('generation.tool.result returns the deep-equal resumed run from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const req = {
      runId: RUN_ID,
      toolCallId: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
      result: { temperature: 21 },
    };
    const [localResult, remoteResult] = await Promise.all([
      local.generation.tools.result(req),
      remote.generation.tools.result(req),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(TOOL_RESULT_RUN);
  });

  it('generation.tool.result sends the canonical request payload to the kernel', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    const req = {
      runId: RUN_ID,
      toolCallId: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
      result: { temperature: 21 },
    };
    await expect(backend.generation.tools.result(req)).resolves.toEqual(TOOL_RESULT_RUN);
    expect(kernel.requests).toEqual([{ operationId: 'generation.tool.result', payload: req }]);
  });
});

describe('Message variants/revisions/drafts Local vs Remote parity (Этап 4 slice 2)', () => {
  it('variants.list returns deep-equal ListMessageVariantsResultDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.chats.listMessageVariants({ chatId: CHAT_ID, messageId: MESSAGE_ID }),
      remote.chats.listMessageVariants({ chatId: CHAT_ID, messageId: MESSAGE_ID }),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(VARIANT_LIST);
  });

  it('variants.create forwards the content and resolves the created variant', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });

    await expect(
      local.chats.createMessageVariant({
        chatId: CHAT_ID,
        messageId: MESSAGE_ID,
        content: 'Hello (swipe)',
      }),
    ).resolves.toEqual(WIRE_VARIANT);
    expect(kernel.requests).toEqual([
      {
        operationId: 'chats.messages.variants.create',
        payload: { chatId: CHAT_ID, messageId: MESSAGE_ID, content: 'Hello (swipe)' },
      },
    ]);
  });

  it('variants.activate resolves the updated MessageDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.chats.activateMessageVariant({
        chatId: CHAT_ID,
        messageId: MESSAGE_ID,
        variantId: VARIANT_ID,
      }),
      remote.chats.activateMessageVariant({
        chatId: CHAT_ID,
        messageId: MESSAGE_ID,
        variantId: VARIANT_ID,
      }),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PAGED_MESSAGES.items[0]);
  });

  it('variants.delete resolves EmptyResultDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.chats.delMessageVariant({
        chatId: CHAT_ID,
        messageId: MESSAGE_ID,
        variantId: VARIANT_ID,
      }),
      remote.chats.delMessageVariant({
        chatId: CHAT_ID,
        messageId: MESSAGE_ID,
        variantId: VARIANT_ID,
      }),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(EMPTY_RESULT);
  });

  it('revisions.list returns deep-equal ListMessageRevisionsResultDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.chats.listMessageRevisions({ chatId: CHAT_ID, messageId: MESSAGE_ID }),
      remote.chats.listMessageRevisions({ chatId: CHAT_ID, messageId: MESSAGE_ID }),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(REVISION_LIST);
  });

  it('drafts.get resolves the canonical draft from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.chats.getMessageDraft({ chatId: CHAT_ID, draftId: DRAFT_ID }),
      remote.chats.getMessageDraft({ chatId: CHAT_ID, draftId: DRAFT_ID }),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(WIRE_DRAFT);
  });

  it('drafts.save forwards the upsert payload and resolves the canonical draft', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });

    await expect(
      local.chats.saveMessageDraft({
        chatId: CHAT_ID,
        draftId: DRAFT_ID,
        role: 'assistant',
        content: 'Streaming…',
        sequence: 3,
      }),
    ).resolves.toEqual(WIRE_DRAFT);
    expect(kernel.requests).toEqual([
      {
        operationId: 'chats.messages.drafts.save',
        payload: {
          chatId: CHAT_ID,
          draftId: DRAFT_ID,
          role: 'assistant',
          content: 'Streaming…',
          sequence: 3,
        },
      },
    ]);
  });

  it('drafts.commit resolves the committed MessageDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.chats.commitMessageDraft({ chatId: CHAT_ID, draftId: DRAFT_ID }),
      remote.chats.commitMessageDraft({ chatId: CHAT_ID, draftId: DRAFT_ID }),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PAGED_MESSAGES.items[0]);
  });

  it('drafts.discard resolves EmptyResultDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.chats.discardMessageDraft({ chatId: CHAT_ID, draftId: DRAFT_ID }),
      remote.chats.discardMessageDraft({ chatId: CHAT_ID, draftId: DRAFT_ID }),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(EMPTY_RESULT);
  });

  it('rejects a non-uuid draft id with ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(
      backend.chats.getMessageDraft({ chatId: CHAT_ID, draftId: 'not-a-uuid' }),
    ).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });
});

describe('LocalBackend generation validation (Phase 6)', () => {
  it('generation.get with a non-uuid workflowId throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.generation.get('not-a-uuid')).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });

  it('generation.retry with a non-uuid sourceRunId throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    const collect = async (): Promise<WireGenerationEvent[]> => {
      const events: WireGenerationEvent[] = [];
      for await (const event of backend.generation.retry('not-a-uuid')) {
        events.push(event);
      }
      return events;
    };
    await expect(collect()).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });
});

describe('LocalBackend handshake', () => {
  it('throws ContractMismatchError for a wrong expectedSchemaHash', () => {
    expect(
      () =>
        new LocalBackend({
          transport: new FakeKernelTransport(),
          expectedSchemaHash: 'deadbeef'.repeat(8),
        }),
    ).toThrow(ContractMismatchError);
  });

  it('accepts the canonical schema hash', () => {
    expect(
      () =>
        new LocalBackend({
          transport: new FakeKernelTransport(),
          expectedSchemaHash: WIRE_SCHEMA_HASH,
        }),
    ).not.toThrow();
  });
});

describe('LocalBackend outbound validation', () => {
  it('characters.get with a non-uuid id throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.characters.get('not-a-uuid')).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });
});

describe('LegacyBackend', () => {
  const VERSION = { name: 'NeoTavern', version: '0.1.0', apiVersion: 2 };
  const HEALTH = { status: 'ok', uptime: 42 };
  const SUMMARY = {
    id: '9f8e7d6c-5b4a-4932-81f0-123456789abc',
    name: 'Ada Lovelace',
    avatar: '/api/v2/assets/avatars/ada.png',
    description: 'First programmer; legacy fixture.',
    tags: ['scientist'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const PAGE = { items: [SUMMARY], nextCursor: 'next-page', hasMore: true };
  const FULL = {
    ...SUMMARY,
    personality: 'analytical',
    scenario: 'Victorian London',
    firstMessage: 'Good day.',
    exampleDialogues: '',
    systemPrompt: null,
    postHistoryInstructions: null,
    creator: null,
    creatorNotes: null,
    ext: {},
    lastUsedAt: null,
    deletedAt: null,
  };

  function makeLegacyBackend(routes: Map<string, unknown>): LegacyBackend {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(url).pathname;
      const route = routes.get(pathname);
      if (route === undefined) {
        return jsonResponse({ code: 'NOT_FOUND', params: {}, traceId: 'legacy' }, 404);
      }
      return jsonResponse(route);
    };
    return new LegacyBackend({ baseUrl: 'http://legacy.local', fetchImpl });
  }

  it('meta() maps /api/v2/version and /api/v2/health to MetaDto', async () => {
    const backend = makeLegacyBackend(
      new Map([
        ['/api/v2/version', VERSION],
        ['/api/v2/health', HEALTH],
      ]),
    );
    await expect(backend.meta()).resolves.toEqual({
      appVersion: '0.1.0',
      api: { major: 2, minor: 0 },
      productWire: { major: 1, minor: 0 },
      features: { core: 1 },
    });
  });

  it('characters.list() maps items and passes cursor/limit as query params', async () => {
    const backend = makeLegacyBackend(new Map([['/api/v2/characters', PAGE]]));
    await expect(backend.characters.list({ cursor: 'c1', limit: 25 })).resolves.toEqual({
      items: [
        {
          id: SUMMARY.id,
          name: SUMMARY.name,
          description: SUMMARY.description,
          tags: SUMMARY.tags,
          createdAt: SUMMARY.createdAt,
          updatedAt: SUMMARY.updatedAt,
        },
      ],
      nextCursor: 'next-page',
    });
  });

  it('characters.get() maps a full legacy character to the canonical DTO', async () => {
    const backend = makeLegacyBackend(
      new Map([['/api/v2/characters/9f8e7d6c-5b4a-4932-81f0-123456789abc', FULL]]),
    );
    await expect(backend.characters.get(CHARACTER.id)).resolves.toEqual({
      id: SUMMARY.id,
      name: SUMMARY.name,
      description: SUMMARY.description,
      tags: SUMMARY.tags,
      createdAt: SUMMARY.createdAt,
      updatedAt: SUMMARY.updatedAt,
    });
  });

  it('maps legacy error envelopes to ProductError with code passthrough', async () => {
    const backend = makeLegacyBackend(new Map());
    const promise = backend.characters.get(CHARACTER.id);
    await expect(promise).rejects.toBeInstanceOf(ProductError);
    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND', traceId: 'legacy' });
  });

  it('generation.start throws UnsupportedError', () => {
    const backend = makeLegacyBackend(new Map());
    expect(() => backend.generation.start({ chatId: CHARACTER.id, message: 'hello' })).toThrow(
      UnsupportedError,
    );
  });

  it('generation.get throws UnsupportedError', () => {
    const backend = makeLegacyBackend(new Map());
    expect(() => backend.generation.get(RUN_ID)).toThrow(UnsupportedError);
  });

  it('providers.list throws UnsupportedError', () => {
    const backend = makeLegacyBackend(new Map());
    expect(() => backend.providers.list()).toThrow(UnsupportedError);
  });

  it('generation.tools.list throws UnsupportedError (no legacy route)', () => {
    const backend = makeLegacyBackend(new Map());
    expect(() => backend.generation.tools.list()).toThrow(UnsupportedError);
  });

  it('generation.tool.result throws UnsupportedError (no legacy route)', () => {
    const backend = makeLegacyBackend(new Map());
    expect(() =>
      backend.generation.tools.result({ runId: RUN_ID, toolCallId: 'x', result: {} }),
    ).toThrow(UnsupportedError);
  });

  it('updateMessage maps the wire request onto the legacy PATCH route via the host transport (Этап 2.10)', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const backend = new LegacyBackend({
      baseUrl: 'http://legacy.local',
      transport: {
        request: async (method, path, body) => {
          calls.push({ method, path, body });
          return {
            id: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
            chatId: CHAT_ID,
            role: 'user',
            content: 'edited text',
            createdAt: TIMESTAMP,
          };
        },
      },
    });

    const result = await backend.chats.updateMessage({
      chatId: CHAT_ID,
      messageId: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
      content: 'edited text',
    });

    expect(result).toEqual({
      id: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
      chatId: CHAT_ID,
      role: 'user',
      content: 'edited text',
      createdAt: TIMESTAMP,
      sequence: 0,
      meta: {},
    });
    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: `/api/v2/chats/${CHAT_ID}/messages/9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d`,
        body: { content: 'edited text' },
      },
    ]);
  });

  it('updateMessage falls back to plain fetch when no host transport is supplied', async () => {
    const backend = new LegacyBackend({
      baseUrl: 'http://legacy.local',
      fetchImpl: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('/api/v2/chats/')) {
          return jsonResponse({ code: 'NOT_FOUND', params: {}, traceId: 'legacy' }, 404);
        }
        return jsonResponse({
          id: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
          chatId: CHAT_ID,
          role: 'user',
          content: 'edited text',
          createdAt: TIMESTAMP,
        });
      },
    });

    await expect(
      backend.chats.updateMessage({
        chatId: CHAT_ID,
        messageId: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
        content: 'edited text',
      }),
    ).resolves.toMatchObject({ content: 'edited text', sequence: 0 });
  });

  it('delMessage maps onto the legacy DELETE route and returns EmptyResultDto (Этап 2.10)', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const backend = new LegacyBackend({
      baseUrl: 'http://legacy.local',
      transport: {
        request: async (method, path) => {
          calls.push({ method, path });
          return { ok: true };
        },
      },
    });

    await expect(
      backend.chats.delMessage({
        chatId: CHAT_ID,
        messageId: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      {
        method: 'DELETE',
        path: `/api/v2/chats/${CHAT_ID}/messages/9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d`,
      },
    ]);
  });

  it('raw passthrough forwards the host transport for unmigrated routes (ТЗ Фаза 0)', async () => {
    const calls: Array<{
      method: string;
      path: string;
      body?: unknown;
      signal?: AbortSignal;
    }> = [];
    const backend = new LegacyBackend({
      baseUrl: 'http://legacy.local',
      transport: {
        request: async (method, path, body, signal) => {
          calls.push({ method, path, body, signal });
          return { items: [] };
        },
      },
    });
    const result = await backend.raw.request<{ items: never[] }>('GET', '/chats/c1/messages');
    expect(result).toEqual({ items: [] });
    expect(calls).toEqual([
      { method: 'GET', path: '/chats/c1/messages', body: undefined, signal: undefined },
    ]);
  });

  it('raw passthrough throws UnsupportedError without a transport', () => {
    const backend = makeLegacyBackend(new Map());
    expect(() => backend.raw).toThrow(UnsupportedError);
  });

  it('raw passthrough is stable across accesses', () => {
    const transport = { request: async () => ({ ok: true }) };
    const backend = new LegacyBackend({
      baseUrl: 'http://legacy.local',
      transport,
    });
    expect(backend.raw.request).toBe(transport.request);
  });

  // --- М5 slice 3: memories/presets over the legacy /api/v2 routes. ---
  const LEGACY_PRESET = {
    id: PRESET.id,
    kind: 'generation',
    name: 'Balanced',
    data: { maxContextTokens: 8192, generationDefaults: { temperature: 0.8 } },
    createdAt: new Date(TIMESTAMP).getTime(),
    updatedAt: new Date(TIMESTAMP).getTime(),
  };
  const LEGACY_MEMORY = {
    id: MEMORY.id,
    scope: 'character',
    characterId: CHARACTER.id,
    keys: ['aria', 'clockwork'],
    content: 'Aria guards the clockwork orchard.',
    enabled: true,
    position: 0,
    metadata: { source: 'canonical' },
    createdAt: new Date(TIMESTAMP).getTime(),
    updatedAt: new Date(TIMESTAMP).getTime(),
  };

  it('presets.list() maps ms timestamps and the kind filter over GET /api/v2/presets', async () => {
    const backend = makeLegacyBackend(new Map([['/api/v2/presets', { items: [LEGACY_PRESET] }]]));
    await expect(backend.presets.list({ kind: 'generation' })).resolves.toEqual({
      items: [PRESET],
    });
  });

  it('presets.get() maps a full legacy preset to the canonical DTO', async () => {
    const backend = makeLegacyBackend(
      new Map([['/api/v2/presets/3c4d5e6f-7a8b-4c0d-9e1f-2a3b4c5d6e7f', LEGACY_PRESET]]),
    );
    await expect(backend.presets.get(PRESET.id)).resolves.toEqual(PRESET);
  });

  it('presets.create/update/del map onto POST/PATCH/DELETE /api/v2/presets routes', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const backend = new LegacyBackend({
      baseUrl: 'http://legacy.local',
      transport: {
        request: async (method, path, body) => {
          calls.push({ method, path, body });
          return method === 'DELETE' ? { ok: true } : LEGACY_PRESET;
        },
      },
    });

    await expect(backend.presets.create({ kind: 'generation', name: 'Balanced' })).resolves.toEqual(
      PRESET,
    );
    await expect(
      backend.presets.update({ presetId: PRESET.id, name: 'Balanced v2' }),
    ).resolves.toEqual(PRESET);
    await expect(backend.presets.del(PRESET.id)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      { method: 'POST', path: '/api/v2/presets', body: { kind: 'generation', name: 'Balanced' } },
      {
        method: 'PATCH',
        path: '/api/v2/presets/3c4d5e6f-7a8b-4c0d-9e1f-2a3b4c5d6e7f',
        body: { name: 'Balanced v2' },
      },
      {
        method: 'DELETE',
        path: '/api/v2/presets/3c4d5e6f-7a8b-4c0d-9e1f-2a3b4c5d6e7f',
        body: undefined,
      },
    ]);
  });

  it('memories.list() maps the legacy shape (null characterId → absent) over GET /api/v2/memories', async () => {
    const backend = makeLegacyBackend(
      new Map([
        [
          '/api/v2/memories',
          {
            items: [
              LEGACY_MEMORY,
              {
                ...LEGACY_MEMORY,
                id: '5e6f7081-9a8b-4c2d-8e3f-4a5b6c7d8e91',
                scope: 'global',
                characterId: null,
              },
            ],
          },
        ],
      ]),
    );
    await expect(backend.memories.list({ scope: 'character' })).resolves.toEqual({
      items: [
        MEMORY,
        {
          id: '5e6f7081-9a8b-4c2d-8e3f-4a5b6c7d8e91',
          scope: 'global',
          keys: ['aria', 'clockwork'],
          content: 'Aria guards the clockwork orchard.',
          enabled: true,
          position: 0,
          metadata: { source: 'canonical' },
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ],
    });
  });

  it('memories.create/update/del map onto POST/PATCH/DELETE /api/v2/memories routes', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const backend = new LegacyBackend({
      baseUrl: 'http://legacy.local',
      transport: {
        request: async (method, path, body) => {
          calls.push({ method, path, body });
          return method === 'DELETE' ? { ok: true } : LEGACY_MEMORY;
        },
      },
    });

    await expect(
      backend.memories.create({ scope: 'character', characterId: CHARACTER.id, content: 'x' }),
    ).resolves.toEqual(MEMORY);
    await expect(
      backend.memories.update({ memoryId: MEMORY.id, content: 'Updated.' }),
    ).resolves.toEqual(MEMORY);
    await expect(backend.memories.del(MEMORY.id)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/v2/memories',
        body: { scope: 'character', characterId: CHARACTER.id, content: 'x' },
      },
      {
        method: 'PATCH',
        path: '/api/v2/memories/4d5e6f70-8a9b-4c1d-9e2f-3a4b5c6d7e80',
        body: { content: 'Updated.' },
      },
      {
        method: 'DELETE',
        path: '/api/v2/memories/4d5e6f70-8a9b-4c1d-9e2f-3a4b5c6d7e80',
        body: undefined,
      },
    ]);
  });

  it('memories/presets error envelopes surface as ProductError with code passthrough', async () => {
    const backend = makeLegacyBackend(new Map());
    const getPreset = backend.presets.get(PRESET.id);
    await expect(getPreset).rejects.toBeInstanceOf(ProductError);
    await expect(getPreset).rejects.toMatchObject({ code: 'NOT_FOUND', traceId: 'legacy' });
    const getMemory = backend.memories.del(MEMORY.id);
    await expect(getMemory).rejects.toMatchObject({ code: 'NOT_FOUND', traceId: 'legacy' });
  });

  it('legacy backend translates backups.restore onto the legacy sidecar endpoint', async () => {
    const backend = makeLegacyBackend(
      new Map([[`/backups/${BACKUP_ID}/restore`, { restored: true, restartRequired: false }]]),
    );
    await expect(backend.backups.restore(BACKUP_ID)).resolves.toEqual({ status: 'committed' });
  });

  it('legacy backend maps restartRequired onto activation_pending', async () => {
    const backend = makeLegacyBackend(
      new Map([[`/backups/${BACKUP_ID}/restore`, { restored: false, restartRequired: true }]]),
    );
    await expect(backend.backups.restore(BACKUP_ID)).resolves.toEqual({
      status: 'activation_pending',
    });
  });
});

describe('Extensions/theme/profile/settings/diagnostics/secrets Local vs Remote parity (M5 slices 6-7)', () => {
  it('plugins.list returns deep-equal ListPluginsResultDto from both backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.plugins.list(),
      remote.plugins.list(),
    ]);
    expect(kernel.requests).toEqual([{ operationId: 'plugins.list', payload: {} }]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PLUGIN_LIST);
  });

  it('plugins.install forwards the consent payload and decodes InstallPluginResultDto', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const req = {
      id: 'lorebook-searcher',
      name: 'Lorebook Searcher',
      version: '1.2.0',
      trustState: 'verified-publisher' as const,
      permissions: ['plugin.storage'],
    };
    const [localResult, remoteResult] = await Promise.all([
      local.plugins.install(req),
      remote.plugins.install(req),
    ]);
    expect(kernel.requests).toEqual([{ operationId: 'plugins.install', payload: req }]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PLUGIN_INSTALL);
  });

  it('plugins.enable/disable/uninstall forward the id and decode canonical DTOs', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [enableLocal, enableRemote] = await Promise.all([
      local.plugins.enable(PLUGIN.id),
      remote.plugins.enable(PLUGIN.id),
    ]);
    expect(enableLocal).toEqual(enableRemote);
    expect(enableLocal).toEqual(ENABLED_PLUGIN);

    const [disableLocal, disableRemote] = await Promise.all([
      local.plugins.disable(PLUGIN.id),
      remote.plugins.disable(PLUGIN.id),
    ]);
    expect(disableLocal).toEqual(disableRemote);
    expect(disableLocal).toEqual(PLUGIN);

    const [uninstallLocal, uninstallRemote] = await Promise.all([
      local.plugins.uninstall(PLUGIN.id),
      remote.plugins.uninstall(PLUGIN.id),
    ]);
    expect(uninstallLocal).toEqual(uninstallRemote);
    expect(uninstallLocal).toEqual(EMPTY_RESULT);

    expect(kernel.requests).toEqual([
      { operationId: 'plugins.enable', payload: { id: PLUGIN.id } },
      { operationId: 'plugins.disable', payload: { id: PLUGIN.id } },
      { operationId: 'plugins.uninstall', payload: { id: PLUGIN.id } },
    ]);
  });

  it('themes.list/install/activate/uninstall forward payloads and decode canonical DTOs', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [listLocal, listRemote] = await Promise.all([local.themes.list(), remote.themes.list()]);
    expect(listLocal).toEqual(listRemote);
    expect(listLocal).toEqual(THEME_LIST);

    const installReq = {
      id: 'wii-u-dark',
      name: 'Wii U Dark',
      version: '2.0.1',
      trustState: 'verified-publisher' as const,
      cssAssetId: '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f',
    };
    const [installLocal, installRemote] = await Promise.all([
      local.themes.install(installReq),
      remote.themes.install(installReq),
    ]);
    expect(installLocal).toEqual(installRemote);
    expect(installLocal).toEqual(THEME_INSTALL);

    const [activateLocal, activateRemote] = await Promise.all([
      local.themes.activate(THEME.id),
      remote.themes.activate(THEME.id),
    ]);
    expect(activateLocal).toEqual(activateRemote);
    expect(activateLocal).toEqual(ACTIVE_THEME);

    const [uninstallLocal, uninstallRemote] = await Promise.all([
      local.themes.uninstall(THEME.id),
      remote.themes.uninstall(THEME.id),
    ]);
    expect(uninstallLocal).toEqual(uninstallRemote);
    expect(uninstallLocal).toEqual(EMPTY_RESULT);

    expect(kernel.requests).toEqual([
      { operationId: 'themes.list', payload: {} },
      { operationId: 'themes.install', payload: installReq },
      { operationId: 'themes.activate', payload: { id: THEME.id } },
      { operationId: 'themes.uninstall', payload: { id: THEME.id } },
    ]);
  });

  it('profiles.list/create/rename/del forward payloads and decode canonical DTOs', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [listLocal, listRemote] = await Promise.all([
      local.profiles.list(),
      remote.profiles.list(),
    ]);
    expect(listLocal).toEqual(listRemote);
    expect(listLocal).toEqual(PROFILE_LIST);

    const [createLocal, createRemote] = await Promise.all([
      local.profiles.create({ name: 'Main' }),
      remote.profiles.create({ name: 'Main' }),
    ]);
    expect(createLocal).toEqual(createRemote);
    expect(createLocal).toEqual(PROFILE_CREATE);

    const renameReq = { id: PROFILE_ID, name: 'Primary' };
    const [renameLocal, renameRemote] = await Promise.all([
      local.profiles.rename(renameReq),
      remote.profiles.rename(renameReq),
    ]);
    expect(renameLocal).toEqual(renameRemote);
    expect(renameLocal).toEqual(PROFILE);

    const [delLocal, delRemote] = await Promise.all([
      local.profiles.del(PROFILE_ID),
      remote.profiles.del(PROFILE_ID),
    ]);
    expect(delLocal).toEqual(delRemote);
    expect(delLocal).toEqual(EMPTY_RESULT);

    expect(kernel.requests).toEqual([
      { operationId: 'profiles.list', payload: {} },
      { operationId: 'profiles.create', payload: { name: 'Main' } },
      { operationId: 'profiles.rename', payload: renameReq },
      { operationId: 'profiles.delete', payload: { id: PROFILE_ID } },
    ]);
  });

  it('profile.export forwards the scope and decodes ProfileExportResultDto', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    // Scoped export (SEC-02 per-profile filtering, ADR-0047 waiver 4).
    const scopedReq = { includeAssets: true, profileId: PROFILE_ID };
    const [scopedLocal, scopedRemote] = await Promise.all([
      local.profiles.export(scopedReq),
      remote.profiles.export(scopedReq),
    ]);
    expect(scopedLocal).toEqual(scopedRemote);
    expect(scopedLocal).toEqual(PROFILE_EXPORT);

    // Unscoped export = full library, profileId absent in the request.
    const [fullLocal, fullRemote] = await Promise.all([
      local.profiles.export(),
      remote.profiles.export(),
    ]);
    expect(fullLocal).toEqual(fullRemote);
    expect(fullLocal).toEqual(PROFILE_EXPORT);

    expect(kernel.requests).toEqual([
      { operationId: 'profile.export', payload: scopedReq },
      { operationId: 'profile.export', payload: {} },
    ]);
  });

  it('profile.import is routed identically by local and remote backends (М5 slice 42)', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const importReq = {
      containerPath: 'imports/profile-import-2c2c/',
      policy: 'remap',
    };
    const [importLocal, importRemote] = await Promise.all([
      local.profiles.import(importReq),
      remote.profiles.import(importReq),
    ]);
    expect(importLocal).toEqual(importRemote);
    expect(importLocal).toEqual(PROFILE_IMPORT);
    expect(kernel.requests).toEqual([{ operationId: 'profile.import', payload: importReq }]);
  });

  it('settings.get/update return deep-equal ResultSettingsDto from both backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [getLocal, getRemote] = await Promise.all([local.settings.get(), remote.settings.get()]);
    expect(getLocal).toEqual(getRemote);
    expect(getLocal).toEqual(SETTINGS);

    const updateReq = { settings: [{ key: 'ui.theme', value: { theme: 'dark' } }] };
    const [updateLocal, updateRemote] = await Promise.all([
      local.settings.update(updateReq),
      remote.settings.update(updateReq),
    ]);
    expect(updateLocal).toEqual(updateRemote);
    expect(updateLocal).toEqual(SETTINGS);

    expect(kernel.requests).toEqual([
      { operationId: 'settings.get', payload: {} },
      { operationId: 'settings.update', payload: updateReq },
    ]);
  });

  it('diagnostics.export returns the redacted allowlist bundle from both backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.diagnostics.export(),
      remote.diagnostics.export(),
    ]);
    expect(kernel.requests).toEqual([{ operationId: 'diagnostics.export', payload: {} }]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(DIAGNOSTICS);
    expect(localResult.redaction).toBe('allowlist');
  });

  it('secrets.status reports the value-free store mode from both backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.secrets.status(),
      remote.secrets.status(),
    ]);
    expect(kernel.requests).toEqual([{ operationId: 'secrets.status', payload: {} }]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(SECRETS_STATUS);
  });

  it('secrets.lock is routed identically by local and remote backends (SEC-01.1 manual lock)', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.secrets.lock(),
      remote.secrets.lock(),
    ]);
    expect(kernel.requests).toEqual([{ operationId: 'secrets.lock', payload: {} }]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual({ locked: true });
  });

  it('assets.get/content/put/delete forward the canonical ops and decode the DTOs from both backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [getLocal, getRemote] = await Promise.all([
      local.assets.get(ASSET_ID),
      remote.assets.get(ASSET_ID),
    ]);
    expect(getLocal).toEqual(getRemote);
    expect(getLocal).toEqual(ASSET_GET);

    const [contentLocal, contentRemote] = await Promise.all([
      local.assets.content(ASSET_ID),
      remote.assets.content(ASSET_ID),
    ]);
    expect(contentLocal).toEqual(contentRemote);
    expect(contentLocal).toEqual(ASSET_CONTENT);

    const putReq: PutAssetRequestDto = {
      kind: 'avatar',
      filename: 'avatar.png',
      contentType: 'image/png',
      contentBase64: 'iVBORw0KGgoAAAANSUhEUg==',
    };
    const [putLocal, putRemote] = await Promise.all([
      local.assets.put(putReq),
      remote.assets.put(putReq),
    ]);
    expect(putLocal).toEqual(putRemote);
    expect(putLocal).toEqual(ASSET_PUT);

    const [delLocal, delRemote] = await Promise.all([
      local.assets.del(ASSET_ID),
      remote.assets.del(ASSET_ID),
    ]);
    expect(delLocal).toEqual(delRemote);
    expect(delLocal).toEqual(EMPTY_RESULT);

    expect(kernel.requests).toEqual([
      { operationId: 'assets.get', payload: { assetId: ASSET_ID } },
      { operationId: 'assets.content', payload: { assetId: ASSET_ID } },
      { operationId: 'assets.put', payload: putReq },
      { operationId: 'assets.delete', payload: { assetId: ASSET_ID } },
    ]);
  });

  it('imports.character.card is routed identically by local and remote backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.imports.characterCard(ASSET_ID),
      remote.imports.characterCard(ASSET_ID),
    ]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(CHARACTER_CARD_IMPORT);
    expect(kernel.requests).toEqual([
      { operationId: 'imports.character.card', payload: { assetId: ASSET_ID } },
    ]);
  });

  it('imports.character.card with a non-uuid asset id throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.imports.characterCard('nope')).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });

  it('characters.export.card is routed identically by local and remote backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.characters.exportCard(CHARACTER.id, 'json'),
      remote.characters.exportCard(CHARACTER.id, 'json'),
    ]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(CHARACTER_CARD_EXPORT);
    expect(kernel.requests).toEqual([
      {
        operationId: 'characters.export.card',
        payload: { characterId: CHARACTER.id, format: 'json' },
      },
    ]);
  });

  it('characters.export.card with a bad format throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    // @ts-expect-error deliberate invalid format at the facade boundary
    await expect(backend.characters.exportCard(CHARACTER.id, 'xml')).rejects.toThrow(
      ValidationError,
    );
    expect(kernel.calls).toBe(0);
  });

  it('chats.export is routed identically by local and remote backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.chats.export(CHAT_ID),
      remote.chats.export(CHAT_ID),
    ]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(CHAT_EXPORT);
    expect(kernel.requests).toEqual([
      {
        operationId: 'chats.export',
        payload: { chatId: CHAT_ID },
      },
    ]);
  });

  it('chats.export with a non-uuid chat id throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.chats.export('nope')).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });

  it('generation.prompt.plan is routed identically by local and remote backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.generation.promptPlan(RUN_ID),
      remote.generation.promptPlan(RUN_ID),
    ]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PROMPT_PLAN);
    expect(kernel.requests).toEqual([
      {
        operationId: 'generation.prompt.plan',
        payload: { runId: RUN_ID },
      },
    ]);
  });

  it('generation.prompt.plan with a non-uuid run id throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.generation.promptPlan('nope')).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });

  it('data.activation.status is routed identically by local and remote backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.data.activationStatus(),
      remote.data.activationStatus(),
    ]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(ACTIVATION_STATUS);
    expect(kernel.requests).toEqual([
      {
        operationId: 'data.activation.status',
        payload: {},
      },
    ]);
  });

  it('backups.restore is routed identically by local and remote backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.backups.restore(BACKUP_ID),
      remote.backups.restore(BACKUP_ID),
    ]);
    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(RESTORE_RESULT);
    expect(kernel.requests).toEqual([
      {
        operationId: 'backups.restore',
        payload: { backupId: BACKUP_ID },
      },
    ]);
  });

  it('backups.restore with a non-uuid backup id throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.backups.restore('nope')).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });

  it('assets.get with a non-uuid id throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.assets.get('nope')).rejects.toThrow(ValidationError);
    await expect(
      backend.assets.put({ kind: 'avatar', filename: 'a.png', contentBase64: 'nope!' }),
    ).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });

  it('lorebooks.list with characterId and lorebooks.create forward the scoped request from both backends', async () => {
    const kernel = new FakeKernelTransport();
    const local = new LocalBackend({ transport: kernel });
    const remote = makeRemoteBackend();

    const scopedReq = { characterId: CHARACTER.id };
    const [listLocal, listRemote] = await Promise.all([
      local.lorebooks.list(scopedReq),
      remote.lorebooks.list(scopedReq),
    ]);
    expect(listLocal).toEqual(listRemote);
    expect(listLocal).toEqual(LOREBOOK_LIST);

    const createReq = { name: 'World lore', characterId: CHARACTER.id };
    const [createLocal, createRemote] = await Promise.all([
      local.lorebooks.create(createReq),
      remote.lorebooks.create(createReq),
    ]);
    expect(createLocal).toEqual(createRemote);
    expect(createLocal).toEqual(LOREBOOK);

    expect(kernel.requests).toEqual([
      { operationId: 'lorebooks.list', payload: scopedReq },
      { operationId: 'lorebooks.create', payload: createReq },
    ]);
  });

  it('profiles.rename with a non-uuid id throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.profiles.rename({ id: 'nope', name: 'x' })).rejects.toThrow(
      ValidationError,
    );
    expect(kernel.calls).toBe(0);
  });

  it('legacy backend throws UnsupportedError for every kernel-only canonical domain', () => {
    const backend = new LegacyBackend({ baseUrl: 'http://legacy.local' });
    expect(() => backend.plugins.list()).toThrow(UnsupportedError);
    expect(() => backend.themes.activate('wii-u-dark')).toThrow(UnsupportedError);
    expect(() => backend.profiles.create({ name: 'Main' })).toThrow(UnsupportedError);
    expect(() => backend.profiles.export({ profileId: PROFILE_ID })).toThrow(UnsupportedError);
    expect(() =>
      backend.profiles.import({ containerPath: 'exports/x/', policy: 'reject' }),
    ).toThrow(UnsupportedError);
    expect(() => backend.settings.get()).toThrow(UnsupportedError);
    expect(() => backend.diagnostics.export()).toThrow(UnsupportedError);
    expect(() => backend.secrets.status()).toThrow(UnsupportedError);
    expect(() => backend.secrets.lock()).toThrow(UnsupportedError);
    expect(() => backend.assets.get(ASSET_ID)).toThrow(UnsupportedError);
    expect(() => backend.assets.content(ASSET_ID)).toThrow(UnsupportedError);
    expect(() =>
      backend.assets.put({ kind: 'avatar', filename: 'a.png', contentBase64: 'aGk=' }),
    ).toThrow(UnsupportedError);
    expect(() => backend.assets.del(ASSET_ID)).toThrow(UnsupportedError);
    expect(() => backend.data.activationStatus()).toThrow(UnsupportedError);
  });
});
