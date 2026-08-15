/**
 * RemoteBackend — NeoBackend over a remote wire endpoint via
 * `@neotavern/client-sdk` (ТЗ §57). Every call delegates to the SDK with the
 * canonical registry operation ids; the SDK owns envelope framing, retries,
 * timeouts and response validation.
 */
import type { ClientSdk } from '@neotavern/client-sdk';
import type {
  BackupDto,
  CharacterDto,
  ChatDto,
  CreateProfileResultDto,
  DiagnosticsExportResultDto,
  EmptyResultDto,
  GenerationRunDto,
  InstallPluginResultDto,
  InstallThemeResultDto,
  ListPluginsResultDto,
  ListProfilesResultDto,
  ListThemesResultDto,
  ListToolsResultDto,
  WireGenerationEvent,
  ListBackupsResultDto,
  ListLorebookEntriesResultDto,
  ListLorebooksResultDto,
  ListMemoriesResultDto,
  ListPersonasResultDto,
  ListPresetsResultDto,
  ListProviderConfigsResultDto,
  ListProvidersResultDto,
  LorebookDto,
  LorebookEntryDto,
  MemoryDto,
  MessageDto,
  MessageDraftDto,
  MessageVariantDto,
  ListMessageRevisionsResultDto,
  ListMessageVariantsResultDto,
  ChatSnapshotResultDto,
  MetaDto,
  PagedCharactersDto,
  PagedChatsDto,
  PagedGenerationEventsDto,
  PagedMessagesDto,
  PersonaDto,
  PluginDto,
  PresetDto,
  ProfileDto,
  ProfileExportResultDto,
  ProviderConfigDto,
  ResultSettingsDto,
  SecretsStatusResultDto,
  ThemeDto,
  GetAssetContentResultDto,
  GetAssetResultDto,
  PutAssetResultDto,
} from '@neotavern/contracts';
import type {
  BackendCallOptions,
  AssetsApi,
  BackupsApi,
  CharactersApi,
  ChatsApi,
  DiagnosticsApi,
  GenerationApi,
  LorebooksApi,
  MemoriesApi,
  NeoBackend,
  PersonasApi,
  PluginsApi,
  PresetsApi,
  ProfilesApi,
  ProvidersApi,
  SecretsApi,
  SettingsApi,
  ThemesApi,
} from './neobackend.js';

/** RemoteBackend constructor options. */
export interface RemoteBackendOptions {
  /** Client SDK bound to a remote wire transport. */
  sdk: ClientSdk;
}

/**
 * NeoBackend delegating every operation to a `ClientSdk`. `meta()` performs
 * the SDK handshake against the transport's raw meta endpoint.
 */
export class RemoteBackend implements NeoBackend {
  private readonly sdk: ClientSdk;

  constructor(options: RemoteBackendOptions) {
    this.sdk = options.sdk;
  }

  /** Wire metadata via the SDK handshake (validated `MetaDto`). */
  async meta(): Promise<MetaDto> {
    return this.sdk.handshake();
  }

  readonly characters: CharactersApi = {
    list: (req, opts) =>
      this.sdk.call<PagedCharactersDto>('characters.list', req, { signal: opts?.signal }),
    get: (characterId, opts) =>
      this.sdk.call<CharacterDto>('characters.get', { characterId }, { signal: opts?.signal }),
    create: (req, opts) =>
      this.sdk.call<CharacterDto>('characters.create', req, { signal: opts?.signal }),
    update: (req, opts) =>
      this.sdk.call<CharacterDto>('characters.update', req, { signal: opts?.signal }),
    del: (characterId, opts) =>
      this.sdk.call<EmptyResultDto>(
        'characters.delete',
        { characterId },
        {
          signal: opts?.signal,
        },
      ),
  };

  readonly chats: ChatsApi = {
    list: (req) => this.sdk.call<PagedChatsDto>('chats.list', req),
    get: (chatId) => this.sdk.call<ChatDto>('chats.get', { chatId }),
    create: (req) => this.sdk.call<ChatDto>('chats.create', req),
    update: (req) => this.sdk.call<ChatDto>('chats.update', req),
    del: (chatId) => this.sdk.call<EmptyResultDto>('chats.delete', { chatId }),
    listMessages: (req) => this.sdk.call<PagedMessagesDto>('chats.messages.list', req),
    createMessage: (req) => this.sdk.call<MessageDto>('chats.messages.create', req),
    updateMessage: (req) => this.sdk.call<MessageDto>('chats.messages.update', req),
    delMessage: (req) => this.sdk.call<EmptyResultDto>('chats.messages.delete', req),
    createSnapshot: (req) =>
      this.sdk.call<ChatSnapshotResultDto>('chats.snapshots.create', req),
    listMessageVariants: (req) =>
      this.sdk.call<ListMessageVariantsResultDto>('chats.messages.variants.list', req),
    createMessageVariant: (req) =>
      this.sdk.call<MessageVariantDto>('chats.messages.variants.create', req),
    delMessageVariant: (req) =>
      this.sdk.call<EmptyResultDto>('chats.messages.variants.delete', req),
    activateMessageVariant: (req) =>
      this.sdk.call<MessageDto>('chats.messages.variants.activate', req),
    listMessageRevisions: (req) =>
      this.sdk.call<ListMessageRevisionsResultDto>('chats.messages.revisions.list', req),
    getMessageDraft: (req) => this.sdk.call<MessageDraftDto>('chats.messages.drafts.get', req),
    saveMessageDraft: (req) => this.sdk.call<MessageDraftDto>('chats.messages.drafts.save', req),
    commitMessageDraft: (req) => this.sdk.call<MessageDto>('chats.messages.drafts.commit', req),
    discardMessageDraft: (req) =>
      this.sdk.call<EmptyResultDto>('chats.messages.drafts.discard', req),
  };

  readonly generation: GenerationApi = {
    start: (req, opts) => this.streamOperation('generation.start', req, opts),
    cancel: (workflowId) => this.sdk.call<EmptyResultDto>('generation.cancel', { workflowId }),
    get: (workflowId, opts) =>
      this.sdk.call<GenerationRunDto>('generation.get', { workflowId }, { signal: opts?.signal }),
    events: (req, opts) =>
      this.sdk.call<PagedGenerationEventsDto>('generation.events', req, {
        signal: opts?.signal,
      }),
    retry: (sourceRunId, opts) => this.streamOperation('generation.retry', { sourceRunId }, opts),
    keep: (workflowId, opts) =>
      this.sdk.call<GenerationRunDto>(
        'generation.keep',
        { workflowId },
        {
          signal: opts?.signal,
        },
      ),
    discard: (workflowId, opts) =>
      this.sdk.call<GenerationRunDto>(
        'generation.discard',
        { workflowId },
        {
          signal: opts?.signal,
        },
      ),
    tools: {
      list: (opts) =>
        this.sdk.call<ListToolsResultDto>('generation.tools.list', {}, { signal: opts?.signal }),
      result: (req, opts) =>
        this.sdk.call<GenerationRunDto>('generation.tool.result', req, {
          signal: opts?.signal,
        }),
    },
  };

  readonly backups: BackupsApi = {
    create: () => this.sdk.call<BackupDto>('backups.create', {}),
    list: () => this.sdk.call<ListBackupsResultDto>('backups.list', {}),
  };

  readonly lorebooks: LorebooksApi = {
    list: (req, opts) =>
      this.sdk.call<ListLorebooksResultDto>('lorebooks.list', req ?? {}, { signal: opts?.signal }),
    get: (lorebookId, opts) =>
      this.sdk.call<LorebookDto>('lorebooks.get', { lorebookId }, { signal: opts?.signal }),
    create: (req) => this.sdk.call<LorebookDto>('lorebooks.create', req),
    update: (req) => this.sdk.call<LorebookDto>('lorebooks.update', req),
    del: (lorebookId) => this.sdk.call<EmptyResultDto>('lorebooks.delete', { lorebookId }),
    listEntries: (lorebookId) =>
      this.sdk.call<ListLorebookEntriesResultDto>('lorebooks.entries.list', { lorebookId }),
    createEntry: (req) => this.sdk.call<LorebookEntryDto>('lorebooks.entries.create', req),
    updateEntry: (req) => this.sdk.call<LorebookEntryDto>('lorebooks.entries.update', req),
    deleteEntry: (lorebookId, entryId) =>
      this.sdk.call<EmptyResultDto>('lorebooks.entries.delete', { lorebookId, entryId }),
  };

  readonly personas: PersonasApi = {
    list: () => this.sdk.call<ListPersonasResultDto>('personas.list', {}),
    get: (personaId) => this.sdk.call<PersonaDto>('personas.get', { personaId }),
    create: (req) => this.sdk.call<PersonaDto>('personas.create', req),
    update: (req) => this.sdk.call<PersonaDto>('personas.update', req),
    del: (personaId) => this.sdk.call<EmptyResultDto>('personas.delete', { personaId }),
  };

  readonly presets: PresetsApi = {
    list: (req) => this.sdk.call<ListPresetsResultDto>('presets.list', req ?? {}),
    get: (presetId) => this.sdk.call<PresetDto>('presets.get', { presetId }),
    create: (req) => this.sdk.call<PresetDto>('presets.create', req),
    update: (req) => this.sdk.call<PresetDto>('presets.update', req),
    del: (presetId) => this.sdk.call<EmptyResultDto>('presets.delete', { presetId }),
  };

  readonly memories: MemoriesApi = {
    list: (req) => this.sdk.call<ListMemoriesResultDto>('memories.list', req ?? {}),
    create: (req) => this.sdk.call<MemoryDto>('memories.create', req),
    update: (req) => this.sdk.call<MemoryDto>('memories.update', req),
    del: (memoryId) => this.sdk.call<EmptyResultDto>('memories.delete', { memoryId }),
  };

  readonly providers: ProvidersApi = {
    list: () => this.sdk.call<ListProvidersResultDto>('providers.list', {}),
    config: {
      set: (req) => this.sdk.call<ProviderConfigDto>('providers.config.set', req),
      get: (provider, name) =>
        this.sdk.call<ProviderConfigDto>('providers.config.get', { provider, name }),
      list: (req) => this.sdk.call<ListProviderConfigsResultDto>('providers.config.list', req),
      del: (provider, name) =>
        this.sdk.call<EmptyResultDto>('providers.config.delete', { provider, name }),
    },
  };

  readonly plugins: PluginsApi = {
    list: (opts) =>
      this.sdk.call<ListPluginsResultDto>('plugins.list', {}, { signal: opts?.signal }),
    install: (req, opts) =>
      this.sdk.call<InstallPluginResultDto>('plugins.install', req, { signal: opts?.signal }),
    uninstall: (pluginId, opts) =>
      this.sdk.call<EmptyResultDto>(
        'plugins.uninstall',
        { id: pluginId },
        { signal: opts?.signal },
      ),
    enable: (pluginId, opts) =>
      this.sdk.call<PluginDto>('plugins.enable', { id: pluginId }, { signal: opts?.signal }),
    disable: (pluginId, opts) =>
      this.sdk.call<PluginDto>('plugins.disable', { id: pluginId }, { signal: opts?.signal }),
  };

  readonly themes: ThemesApi = {
    list: (opts) => this.sdk.call<ListThemesResultDto>('themes.list', {}, { signal: opts?.signal }),
    install: (req, opts) =>
      this.sdk.call<InstallThemeResultDto>('themes.install', req, { signal: opts?.signal }),
    uninstall: (themeId, opts) =>
      this.sdk.call<EmptyResultDto>('themes.uninstall', { id: themeId }, { signal: opts?.signal }),
    activate: (themeId, opts) =>
      this.sdk.call<ThemeDto>('themes.activate', { id: themeId }, { signal: opts?.signal }),
  };

  readonly profiles: ProfilesApi = {
    list: (opts) =>
      this.sdk.call<ListProfilesResultDto>('profiles.list', {}, { signal: opts?.signal }),
    create: (req, opts) =>
      this.sdk.call<CreateProfileResultDto>('profiles.create', req, { signal: opts?.signal }),
    rename: (req, opts) =>
      this.sdk.call<ProfileDto>('profiles.rename', req, { signal: opts?.signal }),
    del: (profileId, opts) =>
      this.sdk.call<EmptyResultDto>('profiles.delete', { id: profileId }, { signal: opts?.signal }),
    export: (req, opts) =>
      this.sdk.call<ProfileExportResultDto>('profile.export', req ?? {}, {
        signal: opts?.signal,
      }),
  };

  readonly settings: SettingsApi = {
    get: (req, opts) =>
      this.sdk.call<ResultSettingsDto>('settings.get', req ?? {}, { signal: opts?.signal }),
    update: (req, opts) =>
      this.sdk.call<ResultSettingsDto>('settings.update', req, { signal: opts?.signal }),
  };

  readonly diagnostics: DiagnosticsApi = {
    export: (opts) =>
      this.sdk.call<DiagnosticsExportResultDto>('diagnostics.export', {}, { signal: opts?.signal }),
  };

  readonly secrets: SecretsApi = {
    status: (opts) =>
      this.sdk.call<SecretsStatusResultDto>('secrets.status', {}, { signal: opts?.signal }),
  };

  readonly assets: AssetsApi = {
    get: (assetId, opts) =>
      this.sdk.call<GetAssetResultDto>('assets.get', { assetId }, { signal: opts?.signal }),
    content: (assetId, opts) =>
      this.sdk.call<GetAssetContentResultDto>(
        'assets.content',
        { assetId },
        { signal: opts?.signal },
      ),
    put: (req, opts) =>
      this.sdk.call<PutAssetResultDto>('assets.put', req, { signal: opts?.signal }),
    del: (assetId, opts) =>
      this.sdk.call<EmptyResultDto>('assets.delete', { assetId }, { signal: opts?.signal }),
  };

  private async *streamOperation(
    operationId: 'generation.start' | 'generation.retry',
    payload: unknown,
    opts: BackendCallOptions | undefined,
  ): AsyncGenerator<WireGenerationEvent> {
    for await (const event of this.sdk.stream(operationId, payload, {
      signal: opts?.signal,
    })) {
      // The SDK validates each event payload against the operation's event
      // schema; the facade only unwraps the envelope.
      yield event.payload as WireGenerationEvent;
    }
  }
}
