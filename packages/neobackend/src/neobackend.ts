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
  WireCardExportFormat,
  CharacterCardExportResultDto,
  CharacterCardImportResultDto,
  ChatsExportResultDto,
  CharacterDto,
  ChatDto,
  ChatSnapshotResultDto,
  CommitMessageDraftRequestDto,
  CreateCharacterRequestDto,
  CreateChatRequestDto,
  CreateChatSnapshotRequestDto,
  CreateLorebookEntryRequestDto,
  CreateLorebookRequestDto,
  CreateMemoryRequestDto,
  CreateMessageRequestDto,
  CreateMessageVariantRequestDto,
  CreatePersonaRequestDto,
  CreatePresetRequestDto,
  CreateProfileRequestDto,
  CreateProfileResultDto,
  DeleteMessageRequestDto,
  DeleteMessageVariantRequestDto,
  DiagnosticsExportResultDto,
  DiscardMessageDraftRequestDto,
  EmptyResultDto,
  GenerationRunDto,
  GenerationToolResultRequestDto,
  GetAssetContentResultDto,
  GetAssetResultDto,
  GetMessageDraftRequestDto,
  GetSettingsRequestDto,
  InstallPluginRequestDto,
  InstallPluginResultDto,
  InstallThemeRequestDto,
  InstallThemeResultDto,
  ListToolsResultDto,
  PromptPlanDto,
  WireGenerationEvent,
  DataActivationStatusResultDto,
  ListBackupsResultDto,
  ListCharactersRequestDto,
  ListChatsRequestDto,
  ListGenerationEventsRequestDto,
  ListLorebookEntriesResultDto,
  ListLorebooksResultDto,
  ListMemoriesRequestDto,
  ListLorebooksRequestDto,
  ListMemoriesResultDto,
  ListMessageRevisionsRequestDto,
  ListMessageRevisionsResultDto,
  ListMessagesRequestDto,
  ListMessageVariantsRequestDto,
  ListMessageVariantsResultDto,
  ListPersonasResultDto,
  ListPluginsResultDto,
  ListPresetsRequestDto,
  ListPresetsResultDto,
  ListProfilesResultDto,
  ListProviderConfigsRequestDto,
  ListProviderConfigsResultDto,
  ListProvidersResultDto,
  ListThemesResultDto,
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
  PluginDto,
  PresetDto,
  ProfileDto,
  ProfileExportRequestDto,
  ProfileExportResultDto,
  ProviderConfigDto,
  PutAssetRequestDto,
  PutAssetResultDto,
  RenameProfileRequestDto,
  ResultSettingsDto,
  SaveMessageDraftRequestDto,
  SecretsStatusResultDto,
  StartGenerationRequestDto,
  SetProviderConfigRequestDto,
  ThemeDto,
  UpdateCharacterRequestDto,
  UpdateChatRequestDto,
  UpdateLorebookEntryRequestDto,
  UpdateLorebookRequestDto,
  UpdateMemoryRequestDto,
  UpdateMessageRequestDto,
  UpdatePersonaRequestDto,
  UpdatePresetRequestDto,
  UpdateSettingsRequestDto,
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
  /**
   * Export a character card (SillyTavern container, `json` or `png`; wire
   * `characters.export.card`, Этап 4.5). Imported characters round-trip the
   * original card object verbatim (preserved under `ext_json._card`); the
   * result carries the base64-encoded container for download.
   */
  exportCard(
    characterId: string,
    format: WireCardExportFormat,
    opts?: BackendCallOptions,
  ): Promise<CharacterCardExportResultDto>;
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
  /** Freeze the chat prefix into a fresh child chat (checkpoint/branch). */
  createSnapshot(
    req: CreateChatSnapshotRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ChatSnapshotResultDto>;
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
  getMessageDraft(
    req: GetMessageDraftRequestDto,
    opts?: BackendCallOptions,
  ): Promise<MessageDraftDto>;
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
  /**
   * Export one chat as the `neotavern-chat-export` v2 JSON container (chat +
   * character name + message/variant/revision dump), base64-encoded for
   * download (wire `chats.export`, М5 slice 36).
   */
  export(chatId: string, opts?: BackendCallOptions): Promise<ChatsExportResultDto>;
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
  /**
   * Fetch the durable prompt plan of a run (wire `generation.prompt.plan`,
   * ТЗ §9.2): what context entered the provider request — system blocks,
   * selected history, token counts and every excluded message — so the user
   * can inspect what was included or cut.
   */
  promptPlan(runId: string, opts?: BackendCallOptions): Promise<PromptPlanDto>;
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

/** Data lifecycle operations (ТЗ §10.2–§10.3, wire `data.*`). */
export interface DataApi {
  /** Durable data-root activation status: layout version, active root, the
   * full activation journal and any pending activation. Strictly read-only. */
  activationStatus(opts?: BackendCallOptions): Promise<DataActivationStatusResultDto>;
}

/** Lorebook domain operations (wire `lorebooks.*`). */
export interface LorebooksApi {
  /** List lorebooks; optional `characterId` filters to one character's books
   * (character↔lorebook scoping, ADR-0047 waiver 2). */
  list(req?: ListLorebooksRequestDto, opts?: BackendCallOptions): Promise<ListLorebooksResultDto>;
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
  deleteEntry(
    lorebookId: string,
    entryId: string,
    opts?: BackendCallOptions,
  ): Promise<EmptyResultDto>;
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

/**
 * Extensions registry operations (wire `plugins.*`, ТЗ §8.1 Extensions,
 * §SEC-05, ARC-08, Этап 4 slice 6).
 *
 * The kernel durably records what the host ALREADY verified (publisher
 * signature + per-file digest + ZIP traversal/symlink/bomb rejection stays
 * in the host package verifier) and the GRANTED permission set — the
 * install/update request IS the consent moment. Install/enable/disable/
 * uninstall are idempotent; a version change that would lower the recorded
 * SEC-05 trust rank is rejected by the kernel (PLUGIN_TRUST_DOWNGRADE).
 */
export interface PluginsApi {
  /** List installed plugins. */
  list(opts?: BackendCallOptions): Promise<ListPluginsResultDto>;
  /** Install a verified plugin package (records trust + granted permissions). */
  install(req: InstallPluginRequestDto, opts?: BackendCallOptions): Promise<InstallPluginResultDto>;
  /** Uninstall a plugin (executor archive cleanup is host-side). */
  uninstall(pluginId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /** Enable a plugin (idempotent flag transition). */
  enable(pluginId: string, opts?: BackendCallOptions): Promise<PluginDto>;
  /** Disable a plugin (idempotent; runtime cleanup is the executor's job, SEC-06). */
  disable(pluginId: string, opts?: BackendCallOptions): Promise<PluginDto>;
}

/**
 * Theme-SDK registry operations (wire `themes.*`, ТЗ §5.2 theme-sdk,
 * §SEC-05, AGENTS.md §19, Этап 4 slice 6 part 2).
 *
 * A theme is DATA, never code: the CSS lives as a content-addressed asset
 * (`assets.put` kind `theme-css`, existence validated by the kernel at
 * install). The single active theme is switched by `activate`; uninstalling
 * the active theme clears the flag so the shell falls back to the default
 * (a broken theme must never block the interface reset).
 */
export interface ThemesApi {
  /** List installed themes. */
  list(opts?: BackendCallOptions): Promise<ListThemesResultDto>;
  /** Install a verified theme (records trust + CSS asset reference). */
  install(req: InstallThemeRequestDto, opts?: BackendCallOptions): Promise<InstallThemeResultDto>;
  /** Uninstall a theme (clears `active` if it was the applied theme). */
  uninstall(themeId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /** Activate one theme (idempotent; exactly one active at a time). */
  activate(themeId: string, opts?: BackendCallOptions): Promise<ThemeDto>;
  /**
   * Deactivate the active theme (idempotent; no active theme is a successful
   * no-op). The shell falls back to the default theme — the explicit "stop
   * applying a theme" consent, distinct from uninstall which also removes
   * the row.
   */
  deactivate(opts?: BackendCallOptions): Promise<EmptyResultDto>;
}

/**
 * Configuration profiles operations (wire `profiles.*`, ТЗ §8.1
 * Configuration, Этап 4 slice 5 remainder part 2).
 *
 * Named user contexts; per-profile FK columns on product tables and SEC-02
 * export filtering (ADR-0047 waiver 4) are the slice-5 remainder follow-up
 * this model unblocks.
 */
export interface ProfilesApi {
  /** List profiles (ordered by name, case-insensitive). */
  list(opts?: BackendCallOptions): Promise<ListProfilesResultDto>;
  /** Create a named profile (uuid-v7 id, idempotent by nature). */
  create(req: CreateProfileRequestDto, opts?: BackendCallOptions): Promise<CreateProfileResultDto>;
  /** Rename a profile (fresh `updatedAt`). */
  rename(req: RenameProfileRequestDto, opts?: BackendCallOptions): Promise<ProfileDto>;
  /** Delete a profile (unknown id is PROFILE_NOT_FOUND). */
  del(profileId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /**
   * Export a logical profile container (wire `profile.export`, SEC-02,
   * ADR-0047 waiver 4). An optional `profileId` scopes the export to one
   * Configuration profile: only its characters (and, transitively, their
   * chats and messages) are exported; lorebooks and presets are the shared
   * library and always included. Secrets never enter the container.
   */
  export(req?: ProfileExportRequestDto, opts?: BackendCallOptions): Promise<ProfileExportResultDto>;
}

/**
 * Non-secret settings operations (wire `settings.*`, ТЗ §8.1 Configuration,
 * Этап 4 slice 7). Transactional key → JSON-object upserts over the STRICT
 * settings table; values are never secrets (SEC-07 structural redaction).
 */
export interface SettingsApi {
  /** Read a settings snapshot (absent `keys` = all). */
  get(req?: GetSettingsRequestDto, opts?: BackendCallOptions): Promise<ResultSettingsDto>;
  /** Upsert the provided settings; resolves with the post-update snapshot. */
  update(req: UpdateSettingsRequestDto, opts?: BackendCallOptions): Promise<ResultSettingsDto>;
}

/**
 * Diagnostics operations (wire `diagnostics.export`, ТЗ §15, SEC-07, Этап 4
 * slice 7). Allowlist redacted bundle: app/wire versions, schema hash +
 * revision, storage format, SQLite version, setting count and
 * generation-run counters. Provider configs, secret refs and message
 * content are never read.
 */
export interface DiagnosticsApi {
  /** Export the redacted allowlist diagnostics bundle. */
  export(opts?: BackendCallOptions): Promise<DiagnosticsExportResultDto>;
}

/**
 * Secret-store status operations (wire `secrets.status`, SEC-01.1, Этап 4
 * slice 7 remainder). Reports the explicit store mode WITHOUT invoking get —
 * a value can never cross the DTO.
 */
export interface SecretsApi {
  /** Report the explicit secret-store mode and backend metadata. */
  status(opts?: BackendCallOptions): Promise<SecretsStatusResultDto>;
}

/**
 * Asset domain operations (wire `assets.*`, ТЗ §5.1 AssetStore port,
 * AGENTS.md §12). Metadata is served without content; bytes go through
 * `content` (base64, size-capped by the wire response limit) and larger
 * assets are addressed by `relativeKey` through host transports.
 */
export interface AssetsApi {
  /** Asset metadata read (wire `assets.get`). */
  get(assetId: string, opts?: BackendCallOptions): Promise<GetAssetResultDto>;
  /** Asset content read (wire `assets.content`, base64 of the originals). */
  content(assetId: string, opts?: BackendCallOptions): Promise<GetAssetContentResultDto>;
  /** Asset publish (wire `assets.put`, idempotent re-import). */
  put(req: PutAssetRequestDto, opts?: BackendCallOptions): Promise<PutAssetResultDto>;
  /** Asset delete (wire `assets.delete`). */
  del(assetId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
}

/**
 * Import domain operations (Этап 4.5). The card file is staged first through
 * `assets.put` (kind `card`); `characterCard` parses it, deduplicates by the
 * sha256 of the original bytes and creates the character (`created` is false
 * for a re-import, AGENTS.md §11).
 */
export interface ImportsApi {
  /** Character-card import (wire `imports.character.card`). */
  characterCard(assetId: string, opts?: BackendCallOptions): Promise<CharacterCardImportResultDto>;
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
  data: DataApi;
  plugins: PluginsApi;
  themes: ThemesApi;
  profiles: ProfilesApi;
  settings: SettingsApi;
  diagnostics: DiagnosticsApi;
  secrets: SecretsApi;
  assets: AssetsApi;
  imports: ImportsApi;
}
