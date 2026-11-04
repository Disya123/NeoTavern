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
  GalleryListRequestDto,
  GalleryListResultDto,
  GalleryAddRequestDto,
  GalleryAddResultDto,
  GalleryDeleteRequestDto,
  GalleryDeleteResultDto,
  CharacterCardImportResultDto,
  FullBackupAnalyzeResultDto,
  FullBackupExecuteRequestDto,
  FullBackupExecuteResultDto,
  CharacterVersionRestoreRequestDto,
  CharacterVersionsResultDto,
  ChatsExportResultDto,
  CharacterDto,
  ChatDto,
  ChatSnapshotResultDto,
  ChatsReorderRequestDto,
  ChatsReorderResultDto,
  CommitMessageDraftRequestDto,
  CreateCharacterRequestDto,
  CreateChatRequestDto,
  CreateProviderSecretRequestDto,
  CreateProviderSecretResultDto,
  DeleteProviderSecretRequestDto,
  ListProviderSecretsRequestDto,
  ListProviderSecretsResultDto,
  ProviderCatalogResultDto,
  ProviderModelsRequestDto,
  ProviderModelsResultDto,
  ProviderSecretDto,
  ProviderTestRequestDto,
  ProviderTestResultDto,
  RevealProviderSecretRequestDto,
  RevealProviderSecretResultDto,
  SecretsExposureResultDto,
  UpdateProviderSecretRequestDto,
  CreateChatSnapshotRequestDto,
  RollbackChatSnapshotRequestDto,
  RollbackChatSnapshotResultDto,
  ListChatSnapshotsRequestDto,
  ListChatSnapshotsResultDto,
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
  AttachMessageBlockRequestDto,
  DeleteMessageBlockRequestDto,
  ListMessageBlocksRequestDto,
  ListMessageBlocksResultDto,
  MessageBlockDto,
  UpdateMessageBlockRequestDto,
  CacheCleanupResultDto,
  DiagnosticsExportResultDto,
  DiscardMessageDraftRequestDto,
  EmptyResultDto,
  SearchRequestDto,
  SearchResultDto,
  GenerationRunDto,
  GenerationToolResultRequestDto,
  GetAssetContentResultDto,
  GetAssetThumbResultDto,
  GetAssetResultDto,
  GetMessageDraftRequestDto,
  GetSettingsRequestDto,
  InstallPluginRequestDto,
  InstallPluginResultDto,
  InstallThemeRequestDto,
  InstallThemeResultDto,
  ListToolsResultDto,
  PromptPlanDto,
  ChatContextAuditResultDto,
  ChatPromptPreviewRequestDto,
  ChatPromptPreviewResultDto,
  AppEventsPollRequestDto,
  AppEventsPageDto,
  WireGenerationEvent,
  BackupsRestoreResultDto,
  BackupsDeleteResultDto,
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
  PluginStateDto,
  PluginStateRequestDto,
  SetPluginStateRequestDto,
  SetPluginStateResultDto,
  DeletePluginStateResultDto,
  BeginPluginBlobRequestDto,
  BeginPluginBlobResultDto,
  AppendPluginBlobRequestDto,
  AppendPluginBlobResultDto,
  FinishPluginBlobRequestDto,
  PluginBlobDto,
  ListPluginBlobsRequestDto,
  ListPluginBlobsResultDto,
  ReadPluginBlobRequestDto,
  ReadPluginBlobResultDto,
  DeletePluginBlobRequestDto,
  DeletePluginBlobResultDto,
  PluginSecretDto,
  ListPluginSecretsRequestDto,
  ListPluginSecretsResultDto,
  SetPluginSecretRequestDto,
  DeletePluginSecretRequestDto,
  DeletePluginSecretResultDto,
  RevealPluginSecretRequestDto,
  RevealPluginSecretResultDto,
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
  ThemeSettingsResultDto,
  ThemeSettingsUpdateRequestDto,
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
  ProfileImportRequestDto,
  ProfileImportResultDto,
  ProviderConfigDto,
  PutAssetRequestDto,
  BeginAssetUploadRequestDto,
  BeginAssetUploadResultDto,
  AppendAssetUploadRequestDto,
  AppendAssetUploadResultDto,
  FinishAssetUploadRequestDto,
  AbortAssetUploadRequestDto,
  AbortAssetUploadResultDto,
  ListAssetsRequestDto,
  PagedAssetsDto,
  PutAssetResultDto,
  RenameProfileRequestDto,
  InstructFormatsResultDto,
  ResultSettingsDto,
  SaveMessageDraftRequestDto,
  SecretsStatusResultDto,
  SecretsLockResultDto,
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
  ProviderTranscribeRequestDto,
  ProvidersSpeechRequestDto,
  ProvidersSpeechResultDto,
  ProvidersImagesRequestDto,
  ProvidersImagesResultDto,
  ProviderTranscribeResultDto,
  PluginJobResultDto,
  PluginsJobsEnqueueRequestDto,
  PluginsJobsListRequestDto,
  PluginsJobsListResultDto,
  PluginJobIdRequestDto,
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
  /** Soft-delete a character by id (the row moves to the trash; `purge`
   * selects the irreversible hard delete — wire `characters.delete`). */
  del(characterId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /**
   * Bring a trashed character back (wire `characters.restore`, M7 Etap-4
   * cluster 26). Idempotent: an active character answers unchanged.
   */
  restore(characterId: string, opts?: BackendCallOptions): Promise<CharacterDto>;
  /**
   * List a character's stored snapshots, newest first (wire
   * `characters.versions.list`, M7 Etap-4 cluster 26). Every edit records
   * the state it replaced (ТЗ §10.2); `truncated` says when older snapshots
   * exist beyond the returned page.
   */
  versionsList(characterId: string, opts?: BackendCallOptions): Promise<CharacterVersionsResultDto>;
  /**
   * Apply one stored snapshot back onto the character (wire
   * `characters.versions.restore`, M7 Etap-4 cluster 26). The current state
   * is snapshotted first, so the restore itself is reversible; the character
   * is returned as the saved state.
   */
  versionsRestore(
    req: CharacterVersionRestoreRequestDto,
    opts?: BackendCallOptions,
  ): Promise<CharacterDto>;
  /**
   * Export a character card (legacy card container, `json` or `png`; wire
   * `characters.export.card`, Этап 4.5). Imported characters round-trip the
   * original card object verbatim (preserved under `ext_json._card`); the
   * result carries the base64-encoded container for download.
   */
  exportCard(
    characterId: string,
    format: WireCardExportFormat,
    opts?: BackendCallOptions,
  ): Promise<CharacterCardExportResultDto>;
  /** List a character's gallery (wire `characters.gallery.list`). */
  galleryList(req: GalleryListRequestDto, opts?: BackendCallOptions): Promise<GalleryListResultDto>;
  /** Publish image bytes into the asset store and link them to the
   * character's gallery (wire `characters.gallery.add`). */
  galleryAdd(req: GalleryAddRequestDto, opts?: BackendCallOptions): Promise<GalleryAddResultDto>;
  /** Remove a gallery link (idempotent; the asset bytes are never
   * destroyed — wire `characters.gallery.delete`). */
  galleryDelete(
    req: GalleryDeleteRequestDto,
    opts?: BackendCallOptions,
  ): Promise<GalleryDeleteResultDto>;
}

/** Chat and message domain operations (wire `chats.*`). */
export interface ChatsApi {
  /** List chats (cursor-paginated, optionally scoped to a character). */
  list(req: ListChatsRequestDto, opts?: BackendCallOptions): Promise<PagedChatsDto>;
  /** Fetch one chat by id. */
  get(chatId: string, opts?: BackendCallOptions): Promise<ChatDto>;
  /**
   * Latest durable prompt plan of a chat (wire `chats.context.audit`, M7
   * Etap-4 cluster 17 part 1): what context entered the chat's most recent
   * provider request. `plan` is omitted when the chat has no generation yet.
   */
  contextAudit(chatId: string, opts?: BackendCallOptions): Promise<ChatContextAuditResultDto>;
  /**
   * Side-effect-free prompt preview of a chat's next turn (wire
   * `chats.prompt.preview`, M7 Etap-4 cluster 17 part 2): the plan the next
   * request WOULD send, built without a generation run — nothing persisted,
   * no provider contacted. The payload is the prompt-plan shape minus the run
   * identity (`wire.prompt.preview`).
   */
  previewPrompt(
    req: ChatPromptPreviewRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ChatPromptPreviewResultDto>;
  /** Create a chat for an existing character. */
  create(req: CreateChatRequestDto, opts?: BackendCallOptions): Promise<ChatDto>;
  /** Rename a chat. */
  update(req: UpdateChatRequestDto, opts?: BackendCallOptions): Promise<ChatDto>;
  /** Delete a chat (cascades to its messages). */
  del(chatId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /**
   * Persist the manual drag-and-drop order of one character's chats (wire
   * `chats.reorder`, M7 Etap-4 cluster 25): the listed chats take the
   * leading block in the requested order; unlisted chats of the same
   * character keep their relative order below it.
   */
  reorder(req: ChatsReorderRequestDto, opts?: BackendCallOptions): Promise<ChatsReorderResultDto>;
  /** List messages of a chat (cursor-paginated). */
  listMessages(req: ListMessagesRequestDto, opts?: BackendCallOptions): Promise<PagedMessagesDto>;
  /** Append a message to a chat (sequence allocated atomically). */
  createMessage(req: CreateMessageRequestDto, opts?: BackendCallOptions): Promise<MessageDto>;
  /** Edit a message's content. */
  updateMessage(req: UpdateMessageRequestDto, opts?: BackendCallOptions): Promise<MessageDto>;
  /** Delete a message. */
  delMessage(req: DeleteMessageRequestDto, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /**
   * Batch-read the block attachments of one rendered message page (wire
   * `chats.blocks.list`, M7 Etap-4 cluster 15): one call per page, no N+1.
   * Only attachments of messages that belong to `chatId` are returned.
   */
  listBlocks(
    req: ListMessageBlocksRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ListMessageBlocksResultDto>;
  /** Durably attach one plugin block to a message (wire `chats.blocks.attach`). */
  attachBlock(
    req: AttachMessageBlockRequestDto,
    opts?: BackendCallOptions,
  ): Promise<MessageBlockDto>;
  /** Replace the descriptor and/or persist (or clear) the renderer state
   * (wire `blocks.update`). */
  updateBlock(
    req: UpdateMessageBlockRequestDto,
    opts?: BackendCallOptions,
  ): Promise<MessageBlockDto>;
  /** Detach one block by id; `BLOCK_NOT_FOUND` when it is already gone
   * (wire `blocks.delete`). */
  deleteBlock(
    req: DeleteMessageBlockRequestDto,
    opts?: BackendCallOptions,
  ): Promise<EmptyResultDto>;
  /** Freeze the chat prefix into a fresh child chat (checkpoint/branch). */
  createSnapshot(
    req: CreateChatSnapshotRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ChatSnapshotResultDto>;
  /** Atomically roll a chat back to a kept message: everything after it is
   * removed in ONE transaction, with the removed suffix first frozen into an
   * auto-created checkpoint child chat (a recoverable safety copy); a no-op
   * rollback returns `deleted: 0` without inventing a checkpoint. */
  rollbackSnapshot(
    req: RollbackChatSnapshotRequestDto,
    opts?: BackendCallOptions,
  ): Promise<RollbackChatSnapshotResultDto>;
  /** List the child chats (checkpoints/branches) of a chat, newest first,
   * cursor-paginated (wire `chats.snapshots.list`). */
  listSnapshots(
    req: ListChatSnapshotsRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ListChatSnapshotsResultDto>;
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
  /** Restore a backup container over the active data root (ТЗ §10.4:
   * offline staged restore + activation; the kernel closes and re-opens its
   * database around the swap). Resolves with `{ status: 'committed' }` when
   * the activation completed in this call; `{ status: 'activation_pending' }`
   * means the swap must be finished by a restart. */
  restore(backupId: string, opts?: BackendCallOptions): Promise<BackupsRestoreResultDto>;
  /** Delete a backup container (wire `backups.delete`; idempotent —
   * `deleted: false` means it was already gone). */
  del(backupId: string, opts?: BackendCallOptions): Promise<BackupsDeleteResultDto>;
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
  /**
   * Read one KV state row of a plugin (wire plugins.state.get, M7 cluster 21
   * part 1). PLUGIN_STATE_NOT_FOUND when that scope/owner was never written;
   * PLUGIN_PERMISSION_DENIED when the installation never consented to
   * storage.<scope>.
   */
  stateGet(req: PluginStateRequestDto, opts?: BackendCallOptions): Promise<PluginStateDto>;
  /**
   * Whole-value CAS write of one KV state row (plugins.state.set). A stale
   * expectedRevision is REVISION_CONFLICT carrying the current revision, so
   * two writers can never clobber each other silently.
   */
  stateSet(
    req: SetPluginStateRequestDto,
    opts?: BackendCallOptions,
  ): Promise<SetPluginStateResultDto>;
  /** Remove one KV state row (plugins.state.delete); idempotent. */
  stateDelete(
    req: PluginStateRequestDto,
    opts?: BackendCallOptions,
  ): Promise<DeletePluginStateResultDto>;
  /**
   * Reserve a chunked blob upload (wire plugins.blobs.begin, M7 cluster 21a).
   * Blobs are plugin-scoped and content-addressed; the declared `totalBytes`
   * is authoritative and bounded by the 8 MiB rev4 cap. Requires the
   * `storage.blobs` grant.
   */
  blobBegin(
    req: BeginPluginBlobRequestDto,
    opts?: BackendCallOptions,
  ): Promise<BeginPluginBlobResultDto>;
  /** Stage one sequential chunk (plugins.blobs.append). */
  blobAppend(
    req: AppendPluginBlobRequestDto,
    opts?: BackendCallOptions,
  ): Promise<AppendPluginBlobResultDto>;
  /** Publish the staged bytes as one blob (plugins.blobs.finish). */
  blobFinish(req: FinishPluginBlobRequestDto, opts?: BackendCallOptions): Promise<PluginBlobDto>;
  /** List the plugin's blobs, newest first (plugins.blobs.list). */
  blobsList(
    req: ListPluginBlobsRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ListPluginBlobsResultDto>;
  /** Read one bounded range (plugins.blobs.read); loop until `eof`. */
  blobRead(
    req: ReadPluginBlobRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ReadPluginBlobResultDto>;
  /** Remove one blob (plugins.blobs.delete); idempotent. */
  blobDelete(
    req: DeletePluginBlobRequestDto,
    opts?: BackendCallOptions,
  ): Promise<DeletePluginBlobResultDto>;
  /**
   * Enqueue one plugin job (wire `plugins.jobs.enqueue`, ADR-0064). The payload
   * is opaque JSON bounded to 64 KiB and is NOT a secret channel: the executor
   * resolves secrets at run time through the kernel broker.
   */
  jobsEnqueue(
    req: PluginsJobsEnqueueRequestDto,
    opts?: BackendCallOptions,
  ): Promise<PluginJobResultDto>;
  /** List jobs newest first, optionally by plugin/state (plugins.jobs.list). */
  jobsList(
    req: PluginsJobsListRequestDto,
    opts?: BackendCallOptions,
  ): Promise<PluginsJobsListResultDto>;
  /** Read one job (plugins.jobs.get). */
  jobsGet(req: PluginJobIdRequestDto, opts?: BackendCallOptions): Promise<PluginJobResultDto>;
  /** Cancel a queued or leased job (plugins.jobs.cancel); terminal jobs refuse. */
  jobsCancel(req: PluginJobIdRequestDto, opts?: BackendCallOptions): Promise<PluginJobResultDto>;
  /**
   * List the plugin's own secret keys in one scope (wire
   * plugins.secrets.list, M7 cluster 21 part 2). Value-free by construction:
   * every item carries only a `masked` hint derived from the opaque store
   * reference. Requires the `secrets.manageOwn` grant.
   */
  secretsList(
    req: ListPluginSecretsRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ListPluginSecretsResultDto>;
  /**
   * Store (upsert) one plugin secret (plugins.secrets.set). The value is
   * write-only: it goes into the host SecretStore and never comes back through
   * any DTO; SECRET_UNAVAILABLE when no store is wired (fail-closed).
   */
  secretSet(req: SetPluginSecretRequestDto, opts?: BackendCallOptions): Promise<PluginSecretDto>;
  /** Remove one plugin secret (plugins.secrets.delete); idempotent. */
  secretsDelete(
    req: DeletePluginSecretRequestDto,
    opts?: BackendCallOptions,
  ): Promise<DeletePluginSecretResultDto>;
  /**
   * Reveal one plugin secret in plaintext (plugins.secrets.reveal) — the only
   * operation that returns a value. Refused with SECRETS_EXPOSURE_DISABLED
   * unless the host enabled the exposure policy, and with
   * PLUGIN_PERMISSION_DENIED without the `secrets.reveal` grant.
   */
  secretReveal(
    req: RevealPluginSecretRequestDto,
    opts?: BackendCallOptions,
  ): Promise<RevealPluginSecretResultDto>;
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
  /**
   * Read one theme's manifest-merged settings (wire `themes.settings.get`,
   * М7 Этап-4 cluster 14): every manifest-declared setting id resolved to
   * its persisted value or the manifest default. Unknown id → NOT_FOUND.
   */
  getSettings(themeId: string, opts?: BackendCallOptions): Promise<ThemeSettingsResultDto>;
  /**
   * Partially merge persisted theme settings (wire `themes.settings.update`):
   * every supplied key is validated against the theme manifest definition —
   * one unknown key or type-violating value refuses the whole update.
   */
  updateSettings(
    req: ThemeSettingsUpdateRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ThemeSettingsResultDto>;
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
  /**
   * Import a verified profile export container (wire `profile.import`,
   * SEC-02 round trip, М5 slice 42). The host stages the container under the
   * data root; `containerPath` is relative to it (the same convention
   * `profile.export` uses). `policy` selects the duplicate-id behavior:
   * `reject` skips existing ids (re-running adds nothing), `replace` updates
   * them, `remap` assigns fresh ids and remaps child references. Orphans are
   * reported, never invented; the whole record set applies in one
   * transaction or nothing does.
   */
  import(req: ProfileImportRequestDto, opts?: BackendCallOptions): Promise<ProfileImportResultDto>;
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
  /**
   * The static built-in instruct-format catalog (wire
   * `settings.instructformats.list`, M7 Etap-4 cluster 27): ids, versions and
   * stop strings for the five AGENTS.md §9 formats. Pure metadata — no
   * database read; custom user formats are not part of the catalog.
   */
  instructFormats(opts?: BackendCallOptions): Promise<InstructFormatsResultDto>;
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
  /**
   * Delete the kernel's REGENERABLE cache (diagnostics.cache.clear, M7
   * Этап-4 cluster 23). Scope is the derived-artifact tree only — original
   * user files are never touched; the counts report what was removed, and a
   * second call on an empty cache is a no-op.
   */
  cacheClear(opts?: BackendCallOptions): Promise<CacheCleanupResultDto>;
}

/**
 * App-event subscription (M7 Etap-4 cluster 18). The canonical plane has a
 * single writer and a durable, resumable event log, so a client subscribes by
 * POLLING a cursor instead of holding a socket: echo the last `sequence` you
 * saw as `afterSequence`, and treat `hasMore` as "poll again immediately" and
 * `truncated` as "your cursor aged out — reset your caches". Events carry
 * ids only, so they can never smuggle message text; the subscriber re-reads
 * whatever it needs through the normal read operations.
 */
export interface EventsApi {
  /** One page of the app-event log after an exclusive cursor. */
  poll(req?: AppEventsPollRequestDto, opts?: BackendCallOptions): Promise<AppEventsPageDto>;
}

/**
 * Secret-store operations (wire `secrets.status` / `secrets.lock`,
 * SEC-01.1). `status` reports the explicit store mode WITHOUT invoking get —
 * a value can never cross the DTO. `lock` performs the manual lock: the
 * portable store drops its derived key material in memory (best-effort
 * zeroization); reads/writes fail with `SECRET_STORE_LOCKED` until the host
 * re-opens the store with the master passphrase.
 */
export interface SecretsApi {
  /** Report the explicit secret-store mode and backend metadata. */
  status(opts?: BackendCallOptions): Promise<SecretsStatusResultDto>;
  /** Lock the secret store (idempotent; fail-closed without a store). */
  lock(opts?: BackendCallOptions): Promise<SecretsLockResultDto>;
  /**
   * Host plaintext-exposure policy for provider secrets (`secrets.exposure`,
   * M7 Etap-4 cluster 7). `allowSecretsExposure: false` means
   * `providers.secrets.reveal` fails closed; the UI must hide copy/reveal
   * affordances instead of showing a broken action.
   */
  exposure(opts?: BackendCallOptions): Promise<SecretsExposureResultDto>;
}

/**
 * Asset domain operations (wire `assets.*`, ТЗ §5.1 AssetStore port,
 * AGENTS.md §12). Metadata is served without content; bytes go through
 * `content` (base64, size-capped by the wire response limit) and larger
 * assets are addressed by `relativeKey` through host transports.
 */
export interface AssetsApi {
  /**
   * Asset catalog (wire `assets.list`): newest first, optionally narrowed by
   * `kind`, opaque keyset cursor. Features enumerate their own assets from
   * here (wallpapers = `background`, gallery = `gallery`) instead of owning
   * a second store.
   */
  list(req?: ListAssetsRequestDto, opts?: BackendCallOptions): Promise<PagedAssetsDto>;
  /** Asset metadata read (wire `assets.get`). */
  get(assetId: string, opts?: BackendCallOptions): Promise<GetAssetResultDto>;
  /** Asset content read (wire `assets.content`, base64 of the originals). */
  content(assetId: string, opts?: BackendCallOptions): Promise<GetAssetContentResultDto>;
  /**
   * Asset thumbnail read (wire `assets.thumb`): a bounded, aspect-preserving
   * derivative cached by `(original sha256, maxPx, algorithm)` so the original
   * never travels just to fill a catalog grid.
   */
  thumb(assetId: string, maxPx: number, opts?: BackendCallOptions): Promise<GetAssetThumbResultDto>;
  /** Asset publish (wire `assets.put`, idempotent re-import). */
  put(req: PutAssetRequestDto, opts?: BackendCallOptions): Promise<PutAssetResultDto>;
  /** Asset delete (wire `assets.delete`). */
  del(assetId: string, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /**
   * Reserve a chunked upload (wire `assets.upload.begin`, ADR-0061) — the only
   * path for a file larger than the `assets.put` request cap. Returns the
   * upload id, the maximum raw chunk size and the staged-bytes expiry.
   */
  uploadBegin(
    req: BeginAssetUploadRequestDto,
    opts?: BackendCallOptions,
  ): Promise<BeginAssetUploadResultDto>;
  /**
   * Append one sequential chunk (wire `assets.upload.append`). `index` must be
   * the previous `nextIndex`; a lost chunk is a stable CONFLICT rather than a
   * silently corrupt file.
   */
  uploadAppend(
    req: AppendAssetUploadRequestDto,
    opts?: BackendCallOptions,
  ): Promise<AppendAssetUploadResultDto>;
  /**
   * Publish the assembled upload (wire `assets.upload.finish`). The result is
   * the same DTO `put` returns — an immutable, content-addressed, deduplicated
   * asset — and `ASSET_UPLOAD_INCOMPLETE` refuses a truncated transfer.
   */
  uploadFinish(
    req: FinishAssetUploadRequestDto,
    opts?: BackendCallOptions,
  ): Promise<PutAssetResultDto>;
  /** Drop a staged upload (wire `assets.upload.abort`); idempotent. */
  uploadAbort(
    req: AbortAssetUploadRequestDto,
    opts?: BackendCallOptions,
  ): Promise<AbortAssetUploadResultDto>;
}

/**
 * Import domain operations (Этап 4.5). The card file is staged first through
 * `assets.put` (kind `card`); `characterCard` parses it, deduplicates by the
 * sha256 of the original bytes and creates the character (`created` is false
 * for a re-import, AGENTS.md §11).
 *
 * Cutover-registry row 10 (legacy full-data backup) is a two-step over ONE staged
 * asset produced by the chunked `assets.upload.*` ingestion contract (ADR-0061):
 * `fullBackupAnalyze` reports what the archive contains and writes nothing,
 * `fullBackupExecute` imports the confirmed categories under an explicit
 * conflict policy. Both halves are exposed together so the migration panel has
 * a single surface and no silent fallback.
 */
export interface ImportsApi {
  /** Character-card import (wire `imports.character.card`). */
  characterCard(assetId: string, opts?: BackendCallOptions): Promise<CharacterCardImportResultDto>;
  /**
   * Read-only full-data backup analysis (wire
   * `imports.fullbackup.analyze`): the eleven legacy categories with
   * `discovered` / `dependentRecords` / `invalid` / `sizeBytes`, archive
   * totals, the archive sha256 and a bounded warning sample.
   */
  fullBackupAnalyze(
    assetId: string,
    opts?: BackendCallOptions,
  ): Promise<FullBackupAnalyzeResultDto>;
  /**
   * Destructive full-data backup import (wire `imports.fullbackup.execute`):
   * imports the selected categories from the same staged archive under
   * `conflictPolicy` (`skip` / `copy` / `merge` / `replace`) and reports
   * per-category `imported` / `reused` / `skipped` / `conflicted` / `invalid`
   * counts. Re-running the same archive is idempotent through
   * `import_receipts`, and `archiveAlreadyImported` says so.
   */
  fullBackupExecute(
    req: FullBackupExecuteRequestDto,
    opts?: BackendCallOptions,
  ): Promise<FullBackupExecuteResultDto>;
}

/** Provider domain operations (wire `providers.*`). */
export interface ProvidersApi {
  /** List providers. */
  list(): Promise<ListProvidersResultDto>;
  /**
   * Canonical provider source catalog (wire `providers.catalog`, M7 Etap-4
   * cluster 7): the sources the backend can actually materialize, with the
   * per-source editable-field and sampler hints the editor drives from.
   */
  catalog(opts?: BackendCallOptions): Promise<ProviderCatalogResultDto>;
  /** Provider configuration (wire `providers.config.*`). */
  config: ProviderConfigsApi;
  /**
   * Named provider keys (wire `providers.secrets.*`, M7 Etap-4 cluster 7):
   * several labelled keys per config with exactly one ACTIVE key.
   */
  secrets: ProviderSecretsApi;
  /**
   * Live model discovery for one stored config (wire `providers.models`, M7
   * Etap-4 cluster 8). Resolves the config's endpoint and key kernel-side; an
   * adapter that cannot enumerate models fails with `CAPABILITY_UNAVAILABLE`
   * instead of a synthesized list.
   */
  models(
    req: ProviderModelsRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ProviderModelsResultDto>;
  /**
   * ONE non-streaming test message through one stored config (wire
   * `providers.test`, M7 Etap-4 cluster 8) — the legacy
   * `/providers/:id/test` parity: the answer text plus attempt accounting.
   */
  test(req: ProviderTestRequestDto, opts?: BackendCallOptions): Promise<ProviderTestResultDto>;
  /**
   * Transcribes one STAGED audio asset through one stored config (wire
   * `providers.transcribe`, ADR-0063): the audio is an asset id produced by the
   * ADR-0061 staging family, so bytes never ride the request. A provider
   * without the capability answers `CAPABILITY_UNAVAILABLE` rather than an empty
   * transcript.
   */
  transcribe(
    req: ProviderTranscribeRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ProviderTranscribeResultDto>;
  /**
   * Synthesizes speech (wire `providers.speech`, ADR-0063): text in, the
   * produced audio staged as a `generated-audio` asset id out — bytes never ride
   * the response.
   */
  speech(
    req: ProvidersSpeechRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ProvidersSpeechResultDto>;
  /**
   * Generates one image (wire `providers.images`, ADR-0063): prompt in, the
   * produced image staged as a `generated-image` asset id out.
   */
  images(
    req: ProvidersImagesRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ProvidersImagesResultDto>;
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
 * Named provider keys (wire `providers.secrets.*`, M7 Etap-4 cluster 7, ТЗ
 * §9.4/SEC-01).
 *
 * Every surface except `reveal` is value-free: `list`/`update` report a mask
 * derived from the opaque stored reference, never the key. `reveal` is the
 * single plaintext-carrying operation and is gated by the host's exposure
 * policy (`secrets.exposure`) — with the policy off it fails closed with
 * `SECRETS_EXPOSURE_DISABLED`.
 */
export interface ProviderSecretsApi {
  /** List a config's keys (active first; masked, no values). */
  list(
    req: ListProviderSecretsRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ListProviderSecretsResultDto>;
  /** Store a new key; it becomes the ACTIVE one (siblings deactivate). */
  create(
    req: CreateProviderSecretRequestDto,
    opts?: BackendCallOptions,
  ): Promise<CreateProviderSecretResultDto>;
  /** Rename (empty string clears) and/or activate a key. */
  update(
    req: UpdateProviderSecretRequestDto,
    opts?: BackendCallOptions,
  ): Promise<ProviderSecretDto>;
  /** Delete a key (revives the most recent remaining one if it was active). */
  del(req: DeleteProviderSecretRequestDto, opts?: BackendCallOptions): Promise<EmptyResultDto>;
  /** The ONLY plaintext-carrying op; fail-closed unless the host opted in. */
  reveal(
    req: RevealProviderSecretRequestDto,
    opts?: BackendCallOptions,
  ): Promise<RevealProviderSecretResultDto>;
}

/**
 * Full-text search operations (wire `search.*`, M7 Etap-4 cluster 16, ТЗ
 * §12). `query` runs the FTS5 index over characters/chats/messages/lorebooks;
 * `rebuild` repopulates every index transactionally (the legacy rebuild
 * route's parity).
 */
export interface SearchApi {
  /** Global full-text search (wire `search.query`). */
  query(req: SearchRequestDto, opts?: BackendCallOptions): Promise<SearchResultDto>;
  /** Rebuild every FTS index from the base tables (wire `search.rebuild`). */
  rebuild(opts?: BackendCallOptions): Promise<SearchResultDto>;
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
  search: SearchApi;
  /** App-event cursor (cluster 18); kernel-only, legacy refuses honestly. */
  events: EventsApi;
}
