/**
 * NeoBackend facade contracts (ТЗ §15).
 *
 * `NeoBackend` is the single UI-facing surface over the NeoTavern product
 * wire API. Every operation is typed with the canonical wire DTOs from
 * `@neotavern/contracts`; implementations translate those operations to an
 * in-process kernel (`LocalBackend`), a remote wire endpoint
 * (`RemoteBackend`) or the legacy `/api/v2` server (`LegacyBackend`).
 */
import type {
  BackupDto,
  CharacterDto,
  ChatDto,
  CreateCharacterRequestDto,
  CreateChatRequestDto,
  CreateMessageRequestDto,
  DeleteMessageRequestDto,
  EmptyResultDto,
  GenerationRunDto,
  WireGenerationEvent,
  ListBackupsResultDto,
  ListCharactersRequestDto,
  ListChatsRequestDto,
  ListGenerationEventsRequestDto,
  ListLorebooksResultDto,
  ListMessagesRequestDto,
  ListPresetsResultDto,
  ListProviderConfigsRequestDto,
  ListProviderConfigsResultDto,
  ListProvidersResultDto,
  MessageDto,
  MetaDto,
  PagedCharactersDto,
  PagedChatsDto,
  PagedGenerationEventsDto,
  PagedMessagesDto,
  ProviderConfigDto,
  StartGenerationRequestDto,
  SetProviderConfigRequestDto,
  UpdateCharacterRequestDto,
  UpdateChatRequestDto,
  UpdateMessageRequestDto,
} from '@neotavern/contracts';

/** Options accepted by facade calls (ТЗ §15). */
export interface BackendCallOptions {
  /** Abort the in-flight call or stream. */
  signal?: AbortSignal;
}

/** Character domain operations (wire `characters.*`). */
export interface CharactersApi {
  /** List characters (cursor-paginated). */
  list(req: ListCharactersRequestDto, opts?: BackendCallOptions): Promise<PagedCharactersDto>;
  /** Fetch one character by id. */
  get(characterId: string, opts?: BackendCallOptions): Promise<CharacterDto>;
  /** Create a character. */
  create(req: CreateCharacterRequestDto, opts?: BackendCallOptions): Promise<CharacterDto>;
  /** Update a character. */
  update(req: UpdateCharacterRequestDto, opts?: BackendCallOptions): Promise<CharacterDto>;
  /** Soft-delete a character by id. */
  del(characterId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
}

/** Chat and message domain operations (wire `chats.*`). */
export interface ChatsApi {
  /** List chats (cursor-paginated, optionally scoped to a character). */
  list(req: ListChatsRequestDto, opts?: BackendCallOptions): Promise<PagedChatsDto>;
  /** Fetch one chat by id. */
  get(chatId: string, opts?: BackendCallOptions): Promise<ChatDto>;
  /** Create a chat for an existing character. */
  create(req: CreateChatRequestDto, opts?: BackendCallOptions): Promise<ChatDto>;
  /** Rename a chat. */
  update(req: UpdateChatRequestDto, opts?: BackendCallOptions): Promise<ChatDto>;
  /** Delete a chat (cascades to its messages). */
  del(chatId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /** List messages of a chat (cursor-paginated). */
  listMessages(req: ListMessagesRequestDto, opts?: BackendCallOptions): Promise<PagedMessagesDto>;
  /** Append a message to a chat (sequence allocated atomically). */
  createMessage(req: CreateMessageRequestDto, opts?: BackendCallOptions): Promise<MessageDto>;
  /** Edit a message's content. */
  updateMessage(req: UpdateMessageRequestDto, opts?: BackendCallOptions): Promise<MessageDto>;
  /** Delete a message. */
  delMessage(req: DeleteMessageRequestDto, opts?: BackendCallOptions): Promise<EmptyResultDto>;
}

/** Generation domain operations (wire `generation.*`). */
export interface GenerationApi {
  /** Start a generation; yields canonical wire generation events. */
  start(
    req: StartGenerationRequestDto,
    opts?: BackendCallOptions,
  ): AsyncIterable<WireGenerationEvent>;
  /** Cancel a running generation workflow. */
  cancel(workflowId: string): Promise<EmptyResultDto>;
  /** Fetch the durable run record of a generation workflow. */
  get(workflowId: string, opts?: BackendCallOptions): Promise<GenerationRunDto>;
  /** List generation events (resume-friendly page of the durable log). */
  events(
    req: ListGenerationEventsRequestDto,
    opts?: BackendCallOptions,
  ): Promise<PagedGenerationEventsDto>;
  /** Retry a failed/cancelled/interrupted run; yields canonical wire events. */
  retry(sourceRunId: string, opts?: BackendCallOptions): AsyncIterable<WireGenerationEvent>;
  /** Keep the partial output as a final assistant message. */
  keep(workflowId: string, opts?: BackendCallOptions): Promise<GenerationRunDto>;
  /** Discard the partial output of a non-terminal run. */
  discard(workflowId: string, opts?: BackendCallOptions): Promise<GenerationRunDto>;
}

/** Backup domain operations (wire `backups.*`). */
export interface BackupsApi {
  /** Create an online backup (workflow; result is the backup record). */
  create(): Promise<BackupDto>;
  /** List backups. */
  list(): Promise<ListBackupsResultDto>;
}

/** Lorebook domain operations (wire `lorebooks.*`). */
export interface LorebooksApi {
  /** List lorebooks. */
  list(): Promise<ListLorebooksResultDto>;
}

/** Preset domain operations (wire `presets.*`). */
export interface PresetsApi {
  /** List presets. */
  list(): Promise<ListPresetsResultDto>;
}

/** Provider domain operations (wire `providers.*`). */
export interface ProvidersApi {
  /** List providers. */
  list(): Promise<ListProvidersResultDto>;
  /** Provider configuration (wire `providers.config.*`). */
  config: ProviderConfigsApi;
}

/**
 * Provider configuration operations (wire `providers.config.*`, ТЗ §9.4).
 *
 * Secrets are never part of the DTOs: `set` with `apiKey` stores the value
 * through the SecretStore and the database keeps only the opaque reference;
 * `get`/`list` report `hasApiKey` and nothing else.
 */
export interface ProviderConfigsApi {
  /** Upsert a provider config (optionally storing/replacing the API key). */
  set(req: SetProviderConfigRequestDto, opts?: BackendCallOptions): Promise<ProviderConfigDto>;
  /** Fetch one config (no secret value — only `hasApiKey`). */
  get(provider: string, name: string, opts?: BackendCallOptions): Promise<ProviderConfigDto>;
  /** List configs, optionally filtered by provider. */
  list(
    req: ListProviderConfigsRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ListProviderConfigsResultDto>;
  /** Delete a config (revokes its stored secret). */
  del(provider: string, name: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
}

/**
 * The UI-facing backend surface (ТЗ §15).
 *
 * Implementations: `LocalBackend` (in-process kernel transport),
 * `RemoteBackend` (wire endpoint via `@neotavern/client-sdk`),
 * `LegacyBackend` (temporary `/api/v2` adapter).
 */
export interface NeoBackend {
  /** Wire metadata (version, protocol, feature flags). */
  meta(): Promise<MetaDto>;
  characters: CharactersApi;
  chats: ChatsApi;
  lorebooks: LorebooksApi;
  presets: PresetsApi;
  providers: ProvidersApi;
  generation: GenerationApi;
  backups: BackupsApi;
}
