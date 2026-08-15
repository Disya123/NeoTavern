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
  EmptyResultDto,
  GenerationRunDto,
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
  MetaDto,
  PagedCharactersDto,
  PagedChatsDto,
  PagedGenerationEventsDto,
  PagedMessagesDto,
  PersonaDto,
  PresetDto,
  ProviderConfigDto,
} from '@neotavern/contracts';
import type {
  BackendCallOptions,
  BackupsApi,
  CharactersApi,
  ChatsApi,
  GenerationApi,
  LorebooksApi,
  MemoriesApi,
  NeoBackend,
  PersonasApi,
  PresetsApi,
  ProvidersApi,
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
    list: () => this.sdk.call<ListLorebooksResultDto>('lorebooks.list', {}),
    get: (lorebookId) => this.sdk.call<LorebookDto>('lorebooks.get', { lorebookId }),
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
