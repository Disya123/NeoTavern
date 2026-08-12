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
  WireGenerationEvent,
  ListBackupsResultDto,
  ListLorebooksResultDto,
  ListPresetsResultDto,
  MetaDto,
  PagedCharactersDto,
  PagedChatsDto,
  PagedGenerationEventsDto,
  PagedMessagesDto,
} from '@neotavern/contracts';
import type {
  BackendCallOptions,
  BackupsApi,
  CharactersApi,
  ChatsApi,
  GenerationApi,
  LorebooksApi,
  NeoBackend,
  PresetsApi,
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
    listMessages: (req) => this.sdk.call<PagedMessagesDto>('chats.messages.list', req),
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
    retry: (sourceRunId, opts) =>
      this.streamOperation('generation.retry', { sourceRunId }, opts),
    keep: (workflowId, opts) =>
      this.sdk.call<GenerationRunDto>('generation.keep', { workflowId }, {
        signal: opts?.signal,
      }),
    discard: (workflowId, opts) =>
      this.sdk.call<GenerationRunDto>('generation.discard', { workflowId }, {
        signal: opts?.signal,
      }),
  };

  readonly backups: BackupsApi = {
    create: () => this.sdk.call<BackupDto>('backups.create', {}),
    list: () => this.sdk.call<ListBackupsResultDto>('backups.list', {}),
  };

  readonly lorebooks: LorebooksApi = {
    list: () => this.sdk.call<ListLorebooksResultDto>('lorebooks.list', {}),
  };

  readonly presets: PresetsApi = {
    list: () => this.sdk.call<ListPresetsResultDto>('presets.list', {}),
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
