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
  ActivateMessageVariantRequestDto,
  BackupDto,
  CharacterDto,
  ChatDto,
  CommitMessageDraftRequestDto,
  CreateCharacterRequestDto,
  CreateChatRequestDto,
  CreateLorebookEntryRequestDto,
  CreateLorebookRequestDto,
  CreateMemoryRequestDto,
  CreateMessageRequestDto,
  CreateMessageVariantRequestDto,
  CreatePersonaRequestDto,
  CreatePresetRequestDto,
  DeleteMessageRequestDto,
  DeleteMessageVariantRequestDto,
  DiscardMessageDraftRequestDto,
  EmptyResultDto,
  GenerationRunDto,
  GenerationToolResultRequestDto,
  GetMessageDraftRequestDto,
  ListToolsResultDto,
  WireGenerationEvent,
  ListBackupsResultDto,
  ListCharactersRequestDto,
  ListChatsRequestDto,
  ListGenerationEventsRequestDto,
  ListLorebookEntriesResultDto,
  ListLorebooksResultDto,
  ListMemoriesRequestDto,
  ListMemoriesResultDto,
  ListMessageRevisionsRequestDto,
  ListMessageRevisionsResultDto,
  ListMessagesRequestDto,
  ListMessageVariantsRequestDto,
  ListMessageVariantsResultDto,
  ListPersonasResultDto,
  ListPresetsRequestDto,
  ListPresetsResultDto,
  ListProviderConfigsRequestDto,
  ListProviderConfigsResultDto,
  ListProvidersResultDto,
  LorebookDto,
  LorebookEntryDto,
  MemoryDto,
  MessageDto,
  MessageDraftDto,
  MessageVariantDto,
  MetaDto,
  PagedCharactersDto,
  PagedChatsDto,
  PagedGenerationEventsDto,
  PagedMessagesDto,
  PersonaDto,
  PresetDto,
  ProviderConfigDto,
  SaveMessageDraftRequestDto,
  StartGenerationRequestDto,
  SetProviderConfigRequestDto,
  UpdateCharacterRequestDto,
  UpdateChatRequestDto,
  UpdateLorebookEntryRequestDto,
  UpdateLorebookRequestDto,
  UpdateMemoryRequestDto,
  UpdateMessageRequestDto,
  UpdatePersonaRequestDto,
  UpdatePresetRequestDto,
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
  /** List the swipe variants of one message (wire `chats.messages.variants.list`). */
  listMessageVariants(
    req: ListMessageVariantsRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ListMessageVariantsResultDto>;
  /** Append a swipe variant; the position is allocated atomically (MAX+1). */
  createMessageVariant(
    req: CreateMessageVariantRequestDto,
    opts?: BackendCallOptions,
  ): Promise<MessageVariantDto>;
  /** Delete one variant (permanent). */
  delMessageVariant(
    req: DeleteMessageVariantRequestDto,
    opts?: BackendCallOptions,
  ): Promise<EmptyResultDto>;
  /** Activate a variant; the previous active text is recorded as a revision. */
  activateMessageVariant(
    req: ActivateMessageVariantRequestDto,
    opts?: BackendCallOptions,
  ): Promise<MessageDto>;
  /** List the immutable content revisions of one message (wire `chats.messages.revisions.list`). */
  listMessageRevisions(
    req: ListMessageRevisionsRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ListMessageRevisionsResultDto>;
  /** Fetch one server-side draft (wire `chats.messages.drafts.get`). */
  getMessageDraft(req: GetMessageDraftRequestDto, opts?: BackendCallOptions): Promise<MessageDraftDto>;
  /** Create or update a server-side draft (upsert by id; wire `chats.messages.drafts.save`). */
  saveMessageDraft(
    req: SaveMessageDraftRequestDto,
    opts?: BackendCallOptions,
  ): Promise<MessageDraftDto>;
  /** Materialize a draft exactly once; resolves with the committed message. */
  commitMessageDraft(
    req: CommitMessageDraftRequestDto,
    opts?: BackendCallOptions,
  ): Promise<MessageDto>;
  /** Discard a draft (permanent; never touches the committed message). */
  discardMessageDraft(
    req: DiscardMessageDraftRequestDto,
    opts?: BackendCallOptions,
  ): Promise<EmptyResultDto>;
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
  /** Tool registry for active runs (wire `generation.tools.*`, ТЗ §8.3). */
  tools: GenerationToolsApi;
}

/**
 * Tool registry operations for generation runs (wire `generation.tools.*`).
 *
 * The kernel never executes tools itself: the host inspects the durable
 * tool-call step, performs the effect, and submits the result via `result`
 * (which returns the resumed run). `list` exposes the tools the kernel
 * currently has registered for tool-capable runs.
 */
export interface GenerationToolsApi {
  /** List tools registered with the kernel for tool-capable runs. */
  list(opts?: BackendCallOptions): Promise<ListToolsResultDto>;
  /** Submit the result of one durable tool call; resolves with the resumed run. */
  result(req: GenerationToolResultRequestDto, opts?: BackendCallOptions): Promise<GenerationRunDto>;
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
  /** Fetch one lorebook. */
  get(lorebookId: string, opts?: BackendCallOptions): Promise<LorebookDto>;
  /** Create a lorebook (optionally with entries). */
  create(req: CreateLorebookRequestDto, opts?: BackendCallOptions): Promise<LorebookDto>;
  /** Update name/description/entries of one lorebook. */
  update(req: UpdateLorebookRequestDto, opts?: BackendCallOptions): Promise<LorebookDto>;
  /** Delete one lorebook (permanent). */
  del(lorebookId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /** List the entries of one lorebook (wire `lorebooks.entries.list`). */
  listEntries(lorebookId: string, opts?: BackendCallOptions): Promise<ListLorebookEntriesResultDto>;
  /** Append one entry to a lorebook (wire `lorebooks.entries.create`). */
  createEntry(
    req: CreateLorebookEntryRequestDto,
    opts?: BackendCallOptions,
  ): Promise<LorebookEntryDto>;
  /** Patch one entry (wire `lorebooks.entries.update`). */
  updateEntry(
    req: UpdateLorebookEntryRequestDto,
    opts?: BackendCallOptions,
  ): Promise<LorebookEntryDto>;
  /** Delete one entry (wire `lorebooks.entries.delete`). */
  deleteEntry(lorebookId: string, entryId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
}

/** Persona domain operations (wire `personas.*`, Этап 4.1). */
export interface PersonasApi {
  /** List personas. */
  list(): Promise<ListPersonasResultDto>;
  /** Fetch one persona. */
  get(personaId: string, opts?: BackendCallOptions): Promise<PersonaDto>;
  /** Create a persona (optionally the default). */
  create(req: CreatePersonaRequestDto, opts?: BackendCallOptions): Promise<PersonaDto>;
  /** Update name/description/avatar/isDefault of one persona. */
  update(req: UpdatePersonaRequestDto, opts?: BackendCallOptions): Promise<PersonaDto>;
  /** Delete one persona (permanent). */
  del(personaId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
}

/** Preset domain operations (wire `presets.*`, Этап 4 slice 3). */
export interface PresetsApi {
  /** List presets, optionally filtered by kind. */
  list(req?: ListPresetsRequestDto, opts?: BackendCallOptions): Promise<ListPresetsResultDto>;
  /** Fetch one preset. */
  get(presetId: string, opts?: BackendCallOptions): Promise<PresetDto>;
  /** Create a preset (kind + name + free-form data). */
  create(req: CreatePresetRequestDto, opts?: BackendCallOptions): Promise<PresetDto>;
  /** Update name/data of one preset. */
  update(req: UpdatePresetRequestDto, opts?: BackendCallOptions): Promise<PresetDto>;
  /** Delete one preset (permanent). */
  del(presetId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
}

/** Memory domain operations (wire `memories.*`, Этап 4 slice 3, ТЗ §4.4). */
export interface MemoriesApi {
  /** List memories, optionally filtered by scope/characterId/enabled. */
  list(req?: ListMemoriesRequestDto, opts?: BackendCallOptions): Promise<ListMemoriesResultDto>;
  /** Create a memory (global or character-scoped). */
  create(req: CreateMemoryRequestDto, opts?: BackendCallOptions): Promise<MemoryDto>;
  /** Update the provided fields of one memory. */
  update(req: UpdateMemoryRequestDto, opts?: BackendCallOptions): Promise<MemoryDto>;
  /** Delete one memory (permanent). */
  del(memoryId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
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
  personas: PersonasApi;
  presets: PresetsApi;
  memories: MemoriesApi;
  providers: ProvidersApi;
  generation: GenerationApi;
  backups: BackupsApi;
}
