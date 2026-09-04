use contracts_generated::generated::{
    decode_backup_dto, decode_character_dto, decode_chat_dto, decode_lorebook_dto,
    decode_lorebook_entry_dto, decode_memory_dto, decode_message_draft_dto, decode_message_dto,
    decode_paged_characters, decode_paged_chats, decode_paged_generation_events,
    decode_paged_messages, decode_persona_dto, decode_preset_dto, decode_prompt_plan,
    decode_provider_config_dto, decode_result_assets_content, decode_result_assets_put,
    decode_result_backups_restore, decode_result_characters_export_card,
    decode_result_chat_snapshot, decode_result_chats_export, decode_result_data_activation_status,
    decode_result_diagnostics_export, decode_result_imports_character_card,
    decode_result_list_backups, decode_result_list_lorebook_entries, decode_result_list_lorebooks,
    decode_result_list_memories, decode_result_list_personas, decode_result_list_presets,
    decode_result_list_provider_configs, decode_result_list_providers, decode_result_list_tools,
    decode_result_message_revision_list, decode_result_message_variant_list,
    decode_result_plugins_list, decode_result_profile_export, decode_result_profile_import,
    decode_result_profiles_create, decode_result_profiles_list, decode_result_secrets_lock,
    decode_result_secrets_status, decode_result_settings, decode_result_snapshots_list,
    decode_result_snapshots_rollback, decode_result_themes_list, decode_themes_item, AssetsItem,
    BackupDto, CardExportFormat, CharacterDto, ChatDto, ErrorDto, FreeObject, GenerationEvent,
    LorebookDto, LorebookEntryDto, LorebookEntryInput, LorebookEntryPatch, MemoryDto, MemoryScope,
    MessageDraftDto, MessageDto, MessageRevisionDto, MessageRole, MessageVariantDto,
    PagedCharacters, PagedChats, PagedMessages, PersonaDto, PluginsItem, PresetDto, ProfilesItem,
    PromptPlan, ProviderConfigDto, RequestAssetsContent, RequestAssetsPut, RequestBackupsRestore,
    RequestCancelGeneration, RequestCharactersExportCard, RequestChatsExport,
    RequestCreateCharacter, RequestCreateChat, RequestCreateChatSnapshot, RequestCreateLorebook,
    RequestCreateLorebookEntry, RequestCreateMemory, RequestCreateMessage, RequestCreatePersona,
    RequestCreatePreset, RequestDeleteCharacter, RequestDeleteChat, RequestDeleteLorebook,
    RequestDeleteLorebookEntry, RequestDeleteMemory, RequestDeleteMessage, RequestDeletePersona,
    RequestDeletePreset, RequestDeleteProviderConfig, RequestEmpty, RequestGetCharacter,
    RequestGetChat, RequestGetPromptPlan, RequestImportsCharacterCard, RequestListCharacters,
    RequestListChats, RequestListGenerationEvents, RequestListLorebookEntries,
    RequestListLorebooks, RequestListMemories, RequestListMessages, RequestListPresets,
    RequestListProviderConfigs, RequestMessageDraftCommit, RequestMessageDraftDiscard,
    RequestMessageDraftGet, RequestMessageDraftSave, RequestMessageRevisionsList,
    RequestMessageVariantActivate, RequestMessageVariantsList, RequestPluginsDisable,
    RequestPluginsEnable, RequestPluginsUninstall, RequestProfileExport, RequestProfileImport,
    RequestProfileImportPolicy, RequestProfilesCreate, RequestProfilesDelete,
    RequestProfilesRename, RequestRetryGeneration, RequestSetProviderConfig, RequestSettingsGet,
    RequestSettingsUpdate, RequestSettingsUpdateSettings, RequestSnapshotsList,
    RequestSnapshotsRollback, RequestStartGeneration, RequestThemesActivate,
    RequestThemesUninstall, RequestUpdateCharacter, RequestUpdateChat, RequestUpdateLorebook,
    RequestUpdateLorebookEntry, RequestUpdateMemory, RequestUpdateMessage, RequestUpdatePersona,
    RequestUpdatePreset, ResultAssetsContent, ResultAssetsPut, ResultBackupsRestore,
    ResultCharactersExportCard, ResultChatSnapshot, ResultChatsExport, ResultDataActivationStatus,
    ResultDiagnosticsExport, ResultImportsCharacterCard, ResultListLorebookEntries,
    ResultListLorebooks, ResultListPersonas, ResultListPresets, ResultListProviders,
    ResultListTools, ResultMessageRevisionList, ResultPluginsList, ResultProfileExport,
    ResultProfileImport, ResultProfilesCreate, ResultProfilesList, ResultSecretsLock,
    ResultSecretsStatus, ResultSettings, ResultThemesList, SettingsItem, SnapshotOrigin,
    ThemesItem, ToolSpec,
};
use neotavern_chat_viewport::{
    GeometrySnapshot, HeightIndex, HeightKind, LogicalItemId, PredictorBudgets, PresentDecision,
    PresentOutcome, TileCache, ViewportSession,
};
use neotavern_presentation_dioxus_shell::{
    assert_registered_command, chrome_metrics, mount_product_chat, BackupCardView,
    CharacterCardView, CharacterDraftView, ChatCardView, ContextUsageBreakdownV1,
    ContextUsageSummaryV1, LorebookCardView, LorebookEntryCardView, MemoryCardView,
    PersonaCardView, PluginCardView, PresetCardView, PresetValueRow, ProductChatView,
    ProductChrome, ProductShellView, ProfileCardView, PromptBlockView, ProviderCardView,
    ProviderConfigCardView, RevisionRow, RowKind, RunStepView, SafeAreaInsets, SnapshotItemView,
    ThemeCardView, ToolCardView, VisibleRow, PRODUCT_PATH_VISIBLE,
};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

use crate::error::ChatRouteError;
use crate::shell_hit::{
    next_choice, next_gallery_columns, next_gallery_sort, next_sort, next_step, ShellAction,
    CHAT_AVATAR_STYLES, CHAT_STYLES, LANGUAGES, MESSAGE_POSITIONS, UI_CONTRASTS, UI_FONT_PROFILES,
    UI_MOTIONS, UI_SCALES,
};
use crate::wire::{ProductWire, StreamFrame, PAGE_LIMIT};

/// Bounded CPU avatar thumbnail cache: one entry per `asset_id` is shared by
/// header and card, evicted LRU under a byte budget and wired to the same
/// pressure signal as the GPU cache.
pub const AVATAR_CPU_MAX_ENTRIES: usize = 64;
pub const AVATAR_CPU_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Parsed `GenerationPresetData` contract subset used for the Config tab
/// draft display and settings persistence (React `GenerationPresetEditor`).
#[derive(serde::Serialize, serde::Deserialize)]
struct PresetGenerationData {
    #[serde(rename = "maxContextTokens", default)]
    max_context_tokens: i64,
    #[serde(rename = "generationDefaults", default)]
    generation_defaults: PresetGenerationDefaults,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PresetGenerationDefaults {
    #[serde(rename = "maxTokens", default)]
    max_tokens: f64,
    #[serde(default)]
    temperature: f64,
    #[serde(rename = "topP", default)]
    top_p: f64,
    #[serde(rename = "topK", default)]
    top_k: f64,
    #[serde(rename = "minP", default)]
    min_p: f64,
    #[serde(rename = "topA", default)]
    top_a: f64,
    #[serde(rename = "repetitionPenalty", default)]
    repetition_penalty: f64,
    #[serde(rename = "frequencyPenalty", default)]
    frequency_penalty: f64,
    #[serde(rename = "presencePenalty", default)]
    presence_penalty: f64,
    #[serde(default)]
    seed: f64,
    #[serde(default)]
    reasoning: bool,
    #[serde(default)]
    stream: bool,
}

impl Default for PresetGenerationData {
    fn default() -> Self {
        Self {
            max_context_tokens: CONTEXT_TOKEN_DEFAULT,
            generation_defaults: PresetGenerationDefaults::default(),
        }
    }
}

impl Default for PresetGenerationDefaults {
    fn default() -> Self {
        Self {
            max_tokens: 2048.0,
            temperature: 0.8,
            top_p: 1.0,
            top_k: 0.0,
            min_p: 0.0,
            top_a: 0.0,
            repetition_penalty: 1.0,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            seed: -1.0,
            reasoning: false,
            stream: true,
        }
    }
}

/// One completed export (`chats.export`, `characters.export.card`, or a
/// host-owned prompt-template JSON envelope): filename plus bytes, ready
/// for the host's file sink.
#[derive(Clone, Debug, PartialEq)]
pub struct LastExport {
    pub filename: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatRouteState {
    pub chat: Option<ChatDto>,
    pub messages: Vec<MessageDto>,
    pub next_cursor: Option<String>,
    pub draft: Option<MessageDraftDto>,
    pub composer_text: String,
    pub streaming_text: String,
    /// Display name of the durable `tool_call` the run is waiting on
    /// (React `ToolActivityBadge`). Cleared on any other step type, a
    /// completed/failed/cancelled run, or a new `generation.start`.
    pub tool_activity_name: Option<String>,
    pub active_run_id: Option<String>,
    pub last_error: Option<ErrorDto>,
    pub stream_handle: Option<String>,
    pub safe_mode: bool,
    pub last_request_id: Option<String>,
    pub last_operation_id: Option<String>,
    pub last_send_request_id: Option<String>,
    pub last_send_operation_id: Option<String>,
    pub last_durable_message_id: Option<String>,
    pub send_accepted: bool,
    pub scene_epoch: u64,
    pub characters: Vec<CharacterDto>,
    pub selected_character_id: Option<String>,
    pub character_search: String,
    pub character_sort: String,
    pub character_view: String,
    pub character_tab: String,
    pub character_editor_mode: String,
    /// Gallery toolbar (React `GalleryTab` local state, not persisted).
    pub gallery_columns: u32,
    pub gallery_sort: String,
    pub sidebar_panel: String,
    pub sidebar_open: bool,
    pub rail_expanded: bool,
    /// CSS-px side panel width. `0` means "use the React default 380".
    pub panel_width: f32,
    /// CSS-px offset the chat viewport is scrolled from the bottom; `0` = stick
    /// to the latest messages (Android default). Clamped to the message extent
    /// inside `visible_window` on each `view()`.
    pub scroll_offset_css: f32,
    pub insets: SafeAreaInsets,
    /// Full draft for the selected character (Edit / Advanced / Gallery tabs).
    pub character_draft: Option<CharacterDraftView>,
    /// Tag chip composer (React `EditTab` `tagInput`).
    pub tag_input: String,
    /// Cached cover-cropped premultiplied thumbnails keyed by avatar asset id.
    pub avatar_thumbs: HashMap<String, crate::avatar::AvatarThumb>,
    pub(crate) avatar_order: VecDeque<String>,
    pub(crate) avatar_total_bytes: usize,
    pub avatar_ready_token: u64,
    /// Always `None` on the paint path (no `data:` URI in Blitz).
    pub avatar_data_uri: Option<String>,
    /// Matches React `useUiStore.pinnedCharacterId` (select also pins).
    pub pinned_character_id: Option<String>,
    pub create_dialog_open: bool,
    pub delete_dialog_open: bool,
    pub create_name: String,
    pub create_description: String,
    pub create_first_message: String,
    pub expanded_greeting: Option<usize>,
    pub status_message: Option<String>,
    pub personas: Vec<PersonaDto>,
    pub selected_persona_id: Option<String>,
    pub persona_tab: String,
    pub persona_search: String,
    pub persona_sort: String,
    pub persona_name_draft: String,
    pub persona_description_draft: String,
    pub active_persona_id: Option<String>,
    /// User-defined `{{name}}` variables (`settings` key `macro-variables`).
    pub macro_variables: HashMap<String, String>,
    pub lorebooks: Vec<LorebookDto>,
    pub selected_lorebook_id: Option<String>,
    pub lorebook_tab: String,
    pub lorebook_search: String,
    pub lorebook_name_draft: String,
    pub lorebook_description_draft: String,
    /// Entries of the selected lorebook (`lorebooks.entries.list`).
    pub lorebook_entries: Vec<LorebookEntryDto>,
    /// Entry being edited in the entry dialog (`None` = creating a new one).
    pub editing_lorebook_entry_id: Option<String>,
    pub entry_dialog_open: bool,
    pub entry_delete_open: bool,
    /// Entry dialog drafts (keys are one per line, React `EntryDialog`).
    pub entry_keys_draft: String,
    pub entry_secondary_keys_draft: String,
    pub entry_content_draft: String,
    pub entry_enabled_draft: bool,
    pub entry_constant_draft: bool,
    pub entry_selective_draft: bool,
    /// Entry the delete-confirm dialog asks about.
    pub entry_delete_target_id: Option<String>,
    pub plugins: Vec<PluginsItem>,
    pub providers: Vec<ProviderCardView>,
    pub presets: Vec<PresetDto>,
    /// Provider connection profiles (`providers.config.list`; React
    /// `ProviderProfileEditor` on the kernel plane). Keyed by
    /// `(provider, name)` on the wire.
    pub provider_configs: Vec<ProviderConfigDto>,
    /// New-profile dialog state: kind cycle (React uses a `<select>`) and
    /// the profile name input.
    pub provider_create_dialog_open: bool,
    pub provider_kind_index: usize,
    pub provider_name_draft: String,
    pub provider_form_error: Option<String>,
    pub provider_delete_target_id: Option<String>,
    /// Generation draft applied through `settings.update` (React
    /// `GenerationPresetEditor`): context size plus the sampler defaults,
    /// kept as the contract JSON.
    pub preset_draft_max_context: i64,
    pub preset_draft_defaults: Value,
    /// React `unlockedContext` local switch; clamps the context slider max.
    pub preset_unlocked_context: bool,
    /// Focused sampler key (`maxContextTokens`, `temperature`, …) and the
    /// in-progress text (React `RangeField` number input).
    pub preset_edit_key: Option<String>,
    pub preset_edit_text: String,
    /// Skip re-hydrating the draft from `settings.get` while the user has
    /// unapplied edits.
    pub preset_draft_dirty: bool,
    /// Preset name dialog state ("create" / "rename" mode) and its input.
    pub preset_name_dialog_open: bool,
    pub preset_name_mode: Option<String>,
    pub preset_name_draft: String,
    pub preset_form_error: Option<String>,
    pub preset_delete_open: bool,
    /// Home/chats panel rows (`chats.list`).
    pub chat_list: Vec<ChatDto>,
    /// Home/chats panel search query (client-side title filter).
    pub chat_search: String,
    pub language: String,
    pub dir: String,
    pub ai_tab: String,
    pub settings_tab: String,
    /// React `useUiStore` General-tab appearance (local, not Product Wire).
    pub ui_scale: String,
    pub ui_contrast: String,
    pub ui_font_profile: String,
    pub ui_motion: String,
    pub open_home_on_load: bool,
    pub chat_style: String,
    pub chat_avatar_style: String,
    pub user_message_position: String,
    pub character_message_position: String,
    /// React `useUiStore` sliders (local, 0–100 / 0–40).
    pub ui_opacity: u32,
    pub ui_glass_blur: u32,
    /// Kernel diagnostics bundle (`diagnostics.export`; React
    /// `useKernelDiagnostics`). `None` = not loaded yet.
    pub diagnostics: Option<ResultDiagnosticsExport>,
    /// Data-root activation (`data.activation.status`; React
    /// `ActivationStatusPanel`). `None` = not loaded / error.
    pub data_activation: Option<ResultDataActivationStatus>,
    /// AI Advanced (`prompt-template` / `instruct-format` / `instruct-format-id`).
    pub prompt_template: Value,
    pub instruct_format: Option<Value>,
    pub instruct_format_id: Option<String>,
    pub instruct_selection: String,
    pub instruct_form_error: Option<String>,
    /// Configuration profiles (`profiles.list`; React `ProfilesPanel`).
    pub profiles: Vec<ProfilesItem>,
    pub profile_create_name: String,
    /// Profile row currently in inline-rename mode.
    pub profile_renaming_id: Option<String>,
    pub profile_rename_name: String,
    pub profile_delete_open: bool,
    /// Profile the delete-confirm dialog asks about.
    pub profile_delete_target_id: Option<String>,
    /// Plugin uninstall confirm dialog.
    pub plugin_uninstall_open: bool,
    pub plugin_uninstall_target_id: Option<String>,
    /// Chats panel rename dialog (`React ChatManagementPanel` Dialog).
    pub chat_rename_open: bool,
    pub chat_renaming_id: Option<String>,
    pub chat_rename_draft: String,
    /// Chats panel delete confirm dialog.
    pub chat_delete_open: bool,
    pub chat_delete_target_id: Option<String>,
    /// Prompt plan dialog (`generation.prompt.plan`; React `PromptPlanPanel`).
    pub prompt_plan_open: bool,
    pub prompt_plan_run_id: Option<String>,
    pub prompt_plan: Option<PromptPlan>,
    /// `PROMPT_PLAN_NOT_FOUND` → honest empty state (React maps it to null).
    pub prompt_plan_not_found: bool,
    /// Any other error renders inside the dialog (React `isError` state).
    pub prompt_plan_error: Option<String>,
    /// Run-step transcript (`generation.events`; React `RunTranscriptPanel`).
    pub run_transcript_open: bool,
    pub run_transcript_run_id: Option<String>,
    pub run_transcript_steps: Vec<RunStepView>,
    pub run_transcript_error: Option<String>,
    /// Delete-checkpoint confirm dialog.
    pub checkpoint_delete_open: bool,
    pub checkpoint_delete_message_id: Option<String>,
    /// Header message-search overlay (React `ChatHeader`).
    pub header_search_open: bool,
    pub header_search_query: String,
    pub header_search_match_count: u64,
    /// Theme catalog (`themes.list`; React `ThemesPage` / Settings `ThemesTab`).
    pub themes: Vec<ThemesItem>,
    /// Theme the delete-confirm dialog asks about.
    pub theme_delete_open: bool,
    pub theme_delete_target_id: Option<String>,
    /// Secret-store status (`secrets.status`; React `SecretsPanel`). Values
    /// never travel this DTO — it is value-free by contract.
    pub secrets_status: Option<ResultSecretsStatus>,
    /// Host tool registry (`generation.tools.list`; React `ToolsPanel`). The
    /// kernel validates calls against it but never executes tools itself.
    pub tools: Vec<ToolSpec>,
    /// Selected provider / preset ids (React `settings.update`
    /// `activeProviderConfigId` / `activeGenerationPresetId`). The wire-side
    /// provider choice per request lives in `generation.start`.
    pub active_provider_id: Option<String>,
    pub active_preset_id: Option<String>,
    /// Prompt-template presets (`presets.list` kind `prompt-template`) and
    /// the active id (`active-prompt-template-preset-id`).
    pub prompt_presets: Vec<PresetDto>,
    pub active_prompt_preset_id: Option<String>,
    /// Which preset family the shared name/delete dialogs currently edit
    /// (`generation` or `prompt-template`).
    pub preset_dialog_kind: String,
    /// Compact prompt-block editor (React `PromptBlockEditorDialog` name +
    /// content + placement + role + triggers + forbidOverrides + model).
    pub prompt_block_edit_id: Option<String>,
    pub prompt_block_name_draft: String,
    pub prompt_block_content_draft: String,
    pub prompt_block_injection_position: String,
    pub prompt_block_depth_draft: String,
    pub prompt_block_order_draft: String,
    pub prompt_block_role: String,
    pub prompt_block_triggers: Vec<String>,
    pub prompt_block_forbid_overrides: bool,
    pub prompt_block_model_draft: String,
    /// Backup catalog (`backups.list`; React `SettingsPanel` DataTab). The
    /// kernel models no auto/manual split — every entry is user-initiated.
    pub backups: Vec<BackupDto>,
    /// Memory editor state (React `MemoryEditor`): the wire list plus the
    /// inline create/edit draft (`memory_edit_id == None` = create mode).
    pub memories: Vec<MemoryDto>,
    pub memory_edit_id: Option<String>,
    pub memory_draft_content: String,
    pub memory_draft_keys: String,
    pub memory_draft_scope_character: bool,
    pub memory_draft_character_index: usize,
    pub memory_draft_enabled: bool,
    pub memory_form_error: Option<String>,
    pub memory_delete_open: bool,
    pub memory_delete_target_id: Option<String>,
    /// Snapshots menu (React `ChatSnapshotsMenu`): panel visibility plus the
    /// child chats (checkpoints/branches) of the active chat.
    pub snapshots_menu_open: bool,
    pub snapshot_items: Vec<ChatDto>,
    /// Variant picker popover (React `MessageVariantPicker`): the message it
    /// is open for plus the lazily fetched `chats.messages.variants.list`
    /// rows (`None` = loading, matches the React disabled query).
    pub variant_picker_for: Option<String>,
    pub variant_picker_variants: Vec<MessageVariantDto>,
    /// Swipe counter state (React `ChatPage` `currentSwipe`/`totalSwipes`
    /// derived from the variants query): `(label, message_id)` of the last
    /// successful `chats.messages.variants.list` for the tail row.
    pub swipe_label_for: Option<String>,
    pub swipe_label: String,
    /// Composer context-meter popover visibility (`chat.composer.context`).
    pub context_panel_open: bool,
    /// Inline message editor (React `MessageBubble` editing state):
    /// target row + live draft (`chats.messages.update` on save).
    pub message_edit_id: Option<String>,
    pub message_edit_draft: String,
    /// Open revision-history card: owning message + immutable previous
    /// contents from `chats.messages.revisions.list`.
    pub history_message_id: Option<String>,
    pub details_message_id: Option<String>,
    pub details_mode: String,
    pub message_revisions: Vec<RevisionRow>,
    /// Completed export payload awaiting the host's file sink (React
    /// downloads the file; the desktop host writes it to disk):
    /// `chats.export`, `characters.export.card`, and the host-owned
    /// prompt-template JSON envelope.
    pub last_export: Option<LastExport>,
    /// Character-card import dialog (React hidden `<input type=file>`):
    /// a native path prompt + staged `assets.put` → `imports.character.card`.
    pub card_import_dialog_open: bool,
    pub card_path_draft: String,
    /// Prompt-template import dialog (React hidden `<input type=file>`):
    /// a native path prompt, then `presets.create` + `settings.update`.
    pub prompt_template_import_open: bool,
    pub prompt_template_path_draft: String,
    /// Generation-preset import dialog (React hidden `<input type=file>`):
    /// a native path prompt, then `presets.create` + `settings.update`.
    pub generation_preset_import_open: bool,
    pub generation_preset_path_draft: String,
    /// Profile container import (React `ProfilesPanel` import form):
    /// relative container path + duplicate policy.
    pub profile_import_path: String,
    /// Index into [Reject, Replace, Remap].
    pub profile_import_policy_index: usize,
    /// Last applied Kernel stream envelope sequence (`EventEnvelope.sequence`).
    pub last_applied_stream_sequence: Option<i64>,
    pub last_checkpoint_sequence: Option<i64>,
}

impl ChatRouteState {
    fn touch_avatar(&mut self, asset_id: &str) {
        if let Some(pos) = self.avatar_order.iter().position(|k| k == asset_id) {
            self.avatar_order.remove(pos);
            self.avatar_order.push_front(asset_id.to_string());
        }
    }

    fn make_avatar_room(&mut self, need_bytes: usize) {
        while (self.avatar_total_bytes.saturating_add(need_bytes) > AVATAR_CPU_MAX_BYTES
            || self.avatar_order.len() + 1 > AVATAR_CPU_MAX_ENTRIES)
            && !self.avatar_order.is_empty()
        {
            let Some(key) = self.avatar_order.pop_back() else {
                break;
            };
            if let Some(thumb) = self.avatar_thumbs.remove(&key) {
                self.avatar_total_bytes = self.avatar_total_bytes.saturating_sub(thumb.byte_len());
            }
        }
    }

    /// Insert a CPU thumbnail keyed by `asset_id` (shared header/card handle).
    /// Returns `true` when the entry was newly inserted (caller should bump
    /// `avatar_ready_token`). A hit only promotes the LRU order.
    pub(crate) fn insert_avatar_thumb(
        &mut self,
        asset_id: String,
        thumb: crate::avatar::AvatarThumb,
    ) -> bool {
        if self.avatar_thumbs.contains_key(&asset_id) {
            self.touch_avatar(&asset_id);
            return false;
        }
        let need = thumb.byte_len();
        self.make_avatar_room(need);
        self.avatar_order.push_front(asset_id.clone());
        self.avatar_total_bytes = self.avatar_total_bytes.saturating_add(need);
        self.avatar_thumbs.insert(asset_id, thumb);
        self.avatar_ready_token = self.avatar_ready_token.saturating_add(1);
        true
    }

    /// Evict the least-recently used CPU thumbnails until `bytes_to_free` have
    /// been released. Returns the number of evicted entries.
    pub fn evict_avatars_for_pressure(&mut self, bytes_to_free: usize) -> usize {
        let mut freed = 0usize;
        let mut evicted = 0usize;
        while freed < bytes_to_free {
            let Some(key) = self.avatar_order.pop_back() else {
                break;
            };
            if let Some(thumb) = self.avatar_thumbs.remove(&key) {
                freed = freed.saturating_add(thumb.byte_len());
                self.avatar_total_bytes = self.avatar_total_bytes.saturating_sub(thumb.byte_len());
                evicted += 1;
            }
        }
        if evicted > 0 {
            self.avatar_ready_token = self.avatar_ready_token.saturating_add(1);
        }
        evicted
    }
}

pub struct ChatSession<W: ProductWire> {
    wire: W,
    chat_id: Option<String>,
    state: ChatRouteState,
    issued: Vec<String>,
    send_in_flight: bool,
    last_acked_epoch: u64,
    viewport_width: u32,
    viewport_height: u32,
    hidpi_scale: f32,
}

impl<W: ProductWire> ChatSession<W> {
    pub fn open(wire: W, preferred_chat_id: Option<&str>) -> Result<Self, ChatRouteError> {
        let mut session = Self {
            wire,
            chat_id: preferred_chat_id.map(str::to_string),
            state: ChatRouteState::default(),
            issued: Vec::new(),
            send_in_flight: false,
            last_acked_epoch: 0,
            viewport_width: 320,
            viewport_height: 200,
            hidpi_scale: 1.0,
        };
        if let Err(err) = session.load_workspace() {
            session.record_error(err);
        }
        session.state.sidebar_panel = "characters".into();
        session.state.sidebar_open = true;
        session.state.rail_expanded = true;
        session.state.panel_width = 380.0;
        session.state.character_sort = "name".into();
        session.state.character_view = "list".into();
        session.state.character_tab = "cards".into();
        session.state.character_editor_mode = "edit".into();
        session.state.gallery_columns = 3;
        session.state.gallery_sort = "oldest".into();
        session.state.persona_tab = "cards".into();
        session.state.persona_sort = "asc".into();
        session.state.lorebook_tab = "books".into();
        session.state.language = "en".into();
        session.state.dir = "ltr".into();
        session.state.ai_tab = "providers".into();
        session.state.settings_tab = "general".into();
        session.state.ui_scale = "medium".into();
        session.state.ui_contrast = "normal".into();
        session.state.ui_font_profile = "default".into();
        session.state.ui_motion = "system".into();
        session.state.open_home_on_load = true;
        session.state.chat_style = "clean".into();
        session.state.chat_avatar_style = "round".into();
        session.state.user_message_position = "right".into();
        session.state.character_message_position = "left".into();
        session.state.ui_opacity = 70;
        session.state.ui_glass_blur = 16;
        session.state.prompt_template = json!({ "mode": "chat" });
        session.state.instruct_selection = "native".into();
        session.state.context_panel_open = false;
        session.state.message_edit_id = None;
        session.state.history_message_id = None;
        session.state.variant_picker_for = None;
        session.state.details_message_id = None;
        session.state.details_mode = "details".into();
        session.state.swipe_label_for = None;
        Ok(session)
    }

    pub fn wire(&self) -> &W {
        &self.wire
    }

    pub fn wire_mut(&mut self) -> &mut W {
        &mut self.wire
    }

    pub fn into_wire(self) -> W {
        self.wire
    }

    pub fn kernel_message_count(&self) -> usize {
        self.state
            .chat
            .as_ref()
            .map(|chat| usize::try_from(chat.message_count.max(0)).unwrap_or(0))
            .unwrap_or(0)
    }

    pub fn scene_epoch(&self) -> u64 {
        self.state.scene_epoch
    }

    pub fn avatar_thumbs(&self) -> &HashMap<String, crate::avatar::AvatarThumb> {
        &self.state.avatar_thumbs
    }

    pub fn avatar_thumb(&self, asset_id: &str) -> Option<&crate::avatar::AvatarThumb> {
        self.state.avatar_thumbs.get(asset_id)
    }

    pub fn evict_avatars_for_pressure(&mut self, bytes: usize) -> usize {
        self.state.evict_avatars_for_pressure(bytes)
    }

    pub fn avatar_ready_token(&self) -> u64 {
        self.state.avatar_ready_token
    }

    pub fn last_durable_message_id(&self) -> Option<&str> {
        self.state.last_durable_message_id.as_deref()
    }

    pub fn send_accepted(&self) -> bool {
        self.state.send_accepted
    }

    /// Stale presenter epochs must not drop a newer Kernel revision.
    pub fn ack_revision(&mut self, observed_epoch: u64) -> bool {
        if observed_epoch < self.state.scene_epoch {
            return false;
        }
        if observed_epoch == self.state.scene_epoch {
            self.last_acked_epoch = observed_epoch;
            return true;
        }
        false
    }

    pub fn last_acked_epoch(&self) -> u64 {
        self.last_acked_epoch
    }

    pub fn set_send_in_flight(&mut self, in_flight: bool) {
        self.send_in_flight = in_flight;
    }

    pub fn set_surface_size(&mut self, width: u32, height: u32, scale: f32) {
        let scale = scale.max(1.0);
        self.hidpi_scale = scale;
        self.viewport_width = ((width as f32) / scale).round().max(1.0) as u32;
        self.viewport_height = ((height as f32) / scale).round().max(1.0) as u32;
    }

    /// Whether the shell sidebar is currently open (desktop hosts shrink the
    /// chat viewport by the sidebar when it is; Android overlays it instead).
    pub fn sidebar_open(&self) -> bool {
        self.state.sidebar_open
    }

    /// React `--st-shell-panel-width`, clamped to the token min/max.
    pub fn panel_width(&self) -> f32 {
        let width = self.state.panel_width;
        if width < 1.0 {
            380.0
        } else {
            width.clamp(260.0, 720.0)
        }
    }

    pub fn set_panel_width(&mut self, width: f32) {
        let next = width.clamp(260.0, 720.0);
        if (self.panel_width() - next).abs() < 0.5 {
            return;
        }
        self.state.panel_width = next;
        self.bump_scene();
    }

    pub fn scroll_chat_by(&mut self, dy_css: f32) {
        if dy_css == 0.0 {
            return;
        }
        self.state.scroll_offset_css = (self.state.scroll_offset_css + dy_css).max(0.0);
        self.bump_scene();
    }

    pub fn set_safe_area_physical(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        let scale = self.hidpi_scale.max(1.0);
        self.state.insets = SafeAreaInsets {
            top: (top / scale).round(),
            right: (right / scale).round(),
            bottom: (bottom / scale).round(),
            left: (left / scale).round(),
        };
    }

    pub fn insets(&self) -> SafeAreaInsets {
        self.state.insets
    }

    pub fn hidpi_scale(&self) -> f32 {
        self.hidpi_scale.max(1.0)
    }

    pub fn surface_size(&self) -> (u32, u32) {
        (self.viewport_width, self.viewport_height)
    }

    pub fn compositor_height_index(&self) -> HeightIndex {
        let mut index = HeightIndex::new();
        let n = self
            .kernel_message_count()
            .max(self.state.messages.len())
            .max(1);
        let row_h = 56.0 * f64::from(self.hidpi_scale());
        for i in 0..n {
            let _ = index.push(LogicalItemId(i as u64 + 1), row_h, HeightKind::Estimated);
        }
        index
    }

    pub fn state(&self) -> &ChatRouteState {
        &self.state
    }

    pub fn issued_commands(&self) -> &[String] {
        &self.issued
    }

    pub fn chat_id(&self) -> Option<&str> {
        self.chat_id.as_deref()
    }

    pub fn set_safe_mode(&mut self, enabled: bool) {
        self.state.safe_mode = enabled;
    }

    pub fn set_composer_text(&mut self, text: impl Into<String>) -> Result<(), ChatRouteError> {
        self.state.composer_text = text.into();
        self.save_draft()
    }

    pub fn save_draft(&mut self) -> Result<(), ChatRouteError> {
        let Some(chat_id) = self.chat_id.clone() else {
            return Ok(());
        };
        let req = RequestMessageDraftSave {
            chat_id,
            draft_id: self.state.draft.as_ref().map(|row| row.id.clone()),
            role: MessageRole::User,
            content: self.state.composer_text.clone(),
            sequence: None,
        };
        if req.content.is_empty() && req.draft_id.is_none() {
            return Ok(());
        }
        match self.call_decode("chats.messages.drafts.save", &req, decode_message_draft_dto) {
            Ok(draft) => {
                self.state.draft = Some(draft);
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    pub fn discard_draft(&mut self) -> Result<(), ChatRouteError> {
        let (Some(chat_id), Some(draft)) = (self.chat_id.clone(), self.state.draft.clone()) else {
            self.state.composer_text.clear();
            return Ok(());
        };
        let req = RequestMessageDraftDiscard {
            chat_id,
            draft_id: draft.id,
        };
        match self.call_value("chats.messages.drafts.discard", &req) {
            Ok(_) => {
                self.state.draft = None;
                self.state.composer_text.clear();
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    pub fn commit_draft(&mut self) -> Result<(), ChatRouteError> {
        let (Some(chat_id), Some(draft)) = (self.chat_id.clone(), self.state.draft.clone()) else {
            return Ok(());
        };
        let req = RequestMessageDraftCommit {
            chat_id,
            draft_id: draft.id,
        };
        match self.call_decode("chats.messages.drafts.commit", &req, decode_message_dto) {
            Ok(message) => {
                self.note_durable(&message);
                let _ = self.refresh_chat();
                self.state.draft = None;
                self.state.composer_text.clear();
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    pub fn send(&mut self, text: Option<&str>) -> Result<(), ChatRouteError> {
        if self.send_in_flight {
            return Ok(());
        }
        self.send_in_flight = true;
        self.state.send_accepted = false;
        let result = self.send_inner(text);
        self.send_in_flight = false;
        result
    }

    fn send_inner(&mut self, text: Option<&str>) -> Result<(), ChatRouteError> {
        if let Some(text) = text {
            self.state.composer_text = text.to_string();
        }
        let Some(chat_id) = self.chat_id.clone() else {
            self.record_error(ChatRouteError::EmptyLibrary);
            return Ok(());
        };
        let message = self.state.composer_text.trim().to_string();
        if message.is_empty() {
            self.record_error(ChatRouteError::product(
                "EMPTY_MESSAGE",
                json!({ "field": "content" }),
            ));
            return Ok(());
        }
        // React `ChatPage.send`: text starting with `/` is a slash command,
        // never a user message. Native has no plugin/legacy slash runtime, so
        // every `/cmd` is `SLASH_COMMAND_NOT_FOUND` — composer stays, no wire.
        if message.starts_with('/') {
            let command = slash_command_name(&message);
            self.record_error(ChatRouteError::product(
                "SLASH_COMMAND_NOT_FOUND",
                json!({ "command": command }),
            ));
            self.bump_scene();
            return Ok(());
        }
        let _ = self.save_draft();
        let created = match self.call_decode(
            "chats.messages.create",
            &RequestCreateMessage {
                chat_id: chat_id.clone(),
                role: MessageRole::User,
                content: message.clone(),
                generation_run_id: None,
            },
            decode_message_dto,
        ) {
            Ok(row) => row,
            Err(err) => {
                self.record_error(err);
                return Ok(());
            }
        };
        self.note_durable(&created);
        self.state.last_send_request_id = self.state.last_request_id.clone();
        self.state.last_send_operation_id = Some("chats.messages.create".into());
        let _ = self.refresh_chat();
        self.state.send_accepted = true;
        let _ = self.discard_draft();
        let _ = self.start_stream_op(
            "generation.start",
            &RequestStartGeneration {
                chat_id,
                message,
                provider: None,
                model: None,
            },
        );
        let _ = self.refresh_chat();
        Ok(())
    }

    pub fn retry(&mut self) -> Result<(), ChatRouteError> {
        let Some(source_run_id) = self.last_run_id().map(str::to_string) else {
            self.record_error(ChatRouteError::NoActiveRun);
            return Ok(());
        };
        self.start_stream_op(
            "generation.retry",
            &RequestRetryGeneration { source_run_id },
        )
    }

    pub fn prepend(&mut self) -> Result<(), ChatRouteError> {
        let Some(chat_id) = self.chat_id.clone() else {
            return Ok(());
        };
        let Some(cursor) = self.state.next_cursor.clone() else {
            return Ok(());
        };
        match self.list_messages(&chat_id, Some(cursor)) {
            Ok(page) => {
                self.absorb_older_page(page);
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    pub fn poll_stream(&mut self, timeout_ms: u32) -> Result<StreamFrame, ChatRouteError> {
        let Some(handle) = self.state.stream_handle.clone() else {
            return Ok(StreamFrame::Timeout);
        };
        let frame = self.wire.poll_stream(&handle, timeout_ms)?;
        self.apply_stream_frame(&frame);
        Ok(frame)
    }

    /// Applies a stream frame, skipping duplicate envelope `sequence` values
    /// and identical unsequenced deltas at the same offset.
    pub fn apply_stream_frame(&mut self, frame: &StreamFrame) {
        match frame {
            StreamFrame::Event { sequence, event } => {
                if !self.accept_stream_sequence(*sequence) {
                    return;
                }
                match event.as_ref() {
                    GenerationEvent::GenerationDelta { text } => {
                        self.state.streaming_text.push_str(text);
                    }
                    GenerationEvent::GenerationCheckpoint {
                        sequence: checkpoint,
                        partial_length,
                    } => {
                        if self
                            .state
                            .last_checkpoint_sequence
                            .is_some_and(|prev| *checkpoint <= prev)
                        {
                            return;
                        }
                        self.state.last_checkpoint_sequence = Some(*checkpoint);
                        let keep = usize::try_from(*partial_length).unwrap_or(0);
                        if self.state.streaming_text.len() > keep {
                            self.state.streaming_text.truncate(keep);
                        }
                    }
                    GenerationEvent::GenerationCompleted { final_message } => {
                        self.clear_stream_progress();
                        self.note_durable(final_message);
                        self.state.active_run_id = final_message.generation_run_id.clone();
                        let _ = self.refresh_chat();
                    }
                    GenerationEvent::GenerationFailed { error } => {
                        self.clear_stream_progress();
                        self.state.last_error = Some(error.clone());
                    }
                    GenerationEvent::GenerationCancelled => {
                        self.clear_stream_progress();
                    }
                    GenerationEvent::GenerationStep { step } => {
                        apply_generation_step(&mut self.state, step);
                    }
                    GenerationEvent::ConsumerLagged { .. } => {}
                }
            }
            StreamFrame::Error(error) => {
                self.state.last_error = Some(error.clone());
                self.state.stream_handle = None;
                self.clear_stream_progress();
            }
            StreamFrame::Terminal => {
                self.state.stream_handle = None;
                self.clear_stream_progress();
            }
            StreamFrame::Timeout => {}
        }
    }

    fn accept_stream_sequence(&mut self, sequence: Option<i64>) -> bool {
        let Some(seq) = sequence else {
            return true;
        };
        if self
            .state
            .last_applied_stream_sequence
            .is_some_and(|prev| seq <= prev)
        {
            return false;
        }
        self.state.last_applied_stream_sequence = Some(seq);
        true
    }

    fn clear_stream_progress(&mut self) {
        self.state.streaming_text.clear();
        self.state.last_checkpoint_sequence = None;
        self.state.tool_activity_name = None;
    }

    pub fn drain_stream(&mut self) -> Result<(), ChatRouteError> {
        for _ in 0..64 {
            match self.poll_stream(0)? {
                StreamFrame::Timeout | StreamFrame::Terminal | StreamFrame::Error(_) => break,
                StreamFrame::Event { event, .. }
                    if matches!(
                        event.as_ref(),
                        GenerationEvent::GenerationCompleted { .. }
                            | GenerationEvent::GenerationFailed { .. }
                            | GenerationEvent::GenerationCancelled
                    ) =>
                {
                    let _ = self.poll_stream(0)?;
                    break;
                }
                StreamFrame::Event { .. } => {}
            }
        }
        Ok(())
    }

    pub fn cancel_generation(&mut self) -> Result<(), ChatRouteError> {
        if let Some(workflow_id) = self.state.active_run_id.take() {
            let _ = self.call_value(
                "generation.cancel",
                &RequestCancelGeneration { workflow_id },
            );
        }
        if let Some(handle) = self.state.stream_handle.take() {
            let _ = self.wire.cancel_stream(&handle);
            let _ = self.drain_stream();
        }
        self.clear_stream_progress();
        self.bump_scene();
        Ok(())
    }

    pub fn reload_draft(&mut self) -> Result<(), ChatRouteError> {
        let (Some(chat_id), Some(draft_id)) = (
            self.chat_id.clone(),
            self.state.draft.as_ref().map(|row| row.id.clone()),
        ) else {
            return Ok(());
        };
        match self.call_decode(
            "chats.messages.drafts.get",
            &RequestMessageDraftGet { chat_id, draft_id },
            decode_message_draft_dto,
        ) {
            Ok(draft) => {
                self.state.composer_text = draft.content.clone();
                self.state.draft = Some(draft);
            }
            Err(err) => self.record_error(err),
        }
        Ok(())
    }

    /// Message header data (React `MessageBubble` header): author name per
    /// role plus an en-US `Intl`-style timestamp label. Display macros are
    /// expanded on committed rows (not while streaming).
    fn macro_context(&self) -> crate::macros::MacroContext {
        crate::macros::build_macro_context(
            self.user_display_name(),
            self.char_display_name(),
            self.state.macro_variables.clone(),
            None,
        )
    }

    fn user_display_name(&self) -> String {
        let chat_persona = self
            .state
            .chat
            .as_ref()
            .and_then(|chat| chat.persona_id.as_deref());
        let app = self.state.active_persona_id.as_deref();
        pick_active_persona(&self.state.personas, chat_persona, app)
            .map(|row| row.name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "User".into())
    }

    fn char_display_name(&self) -> String {
        self.state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .or(self
                .state
                .chat
                .as_ref()
                .map(|chat| chat.character_id.as_str()))
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .map(|card| card.name.clone())
            })
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Assistant".into())
    }

    fn assistant_author(&self) -> String {
        self.state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .map(|card| card.name.clone())
            })
            .or_else(|| self.state.chat.as_ref().map(|chat| chat.title.clone()))
            .unwrap_or_else(|| "Assistant".into())
    }

    /// Chat main-area width in CSS px: surface minus the occupied rail/panel
    /// strip (`shell_hit::chat_origin_from_parts`), so the RSX column and the
    /// host hit zones size against the area React's `<main>` actually gives
    /// the workspace — not the full window.
    fn chat_column_width(&self) -> u32 {
        let occupied = crate::shell_hit::chat_origin_from_parts(
            self.viewport_width.max(1) as f32,
            self.state.sidebar_open,
            self.panel_width(),
        );
        (self.viewport_width as f32 - occupied).max(1.0) as u32
    }

    pub fn view(&self) -> ProductChatView {
        let title = self
            .state
            .chat
            .as_ref()
            .map(|chat| chat.title.clone())
            .unwrap_or_else(|| "Chat".into());
        let (mut visible, _) = self.visible_window();
        if !self.state.streaming_text.is_empty() {
            visible.push(VisibleRow {
                id: "streaming".into(),
                role: "assistant".into(),
                content: self.state.streaming_text.clone(),
                kind: RowKind::Markdown,
                author: self.assistant_author(),
                timestamp: String::new(),
                run_id: None,
                manual_excluded: false,
                checkpoint_chat_id: None,
                swipe_label: String::new(),
                model: None,
                generation_time: None,
                token_count: None,
            });
        }
        // Hydrate the pager counter onto its row: `hydrate_swipe_label` filled
        // the cache after `variants.list`/`.activate`; empty = hidden
        // (React renders the counter only when `total > 1`).
        if let Some(label_row) = self.state.swipe_label_for.as_deref() {
            if let Some(row) = visible.iter_mut().find(|row| row.id == label_row) {
                row.swipe_label = self.state.swipe_label.clone();
            }
        }
        // React chat chrome is header + composer only; the TripleGlass /
        // PaintOrder variants are M0 glass-layering probes (perf-probe
        // scenarios construct them explicitly), not product UI.
        let chrome = ProductChrome::HeaderComposer;
        let composer_placeholder = self
            .state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .map(|card| card.name.clone())
            })
            .map(|name| format!("Message {name}…"))
            .unwrap_or_else(|| "Message…".into());
        let character_name = self
            .state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .map(|card| card.name.clone())
            })
            .unwrap_or_default();
        // React header/message avatars use the pinned character's asset.
        let character_avatar_asset = self
            .state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .and_then(|card| card.avatar_asset_id.clone())
            })
            .unwrap_or_default();
        let context_summary = Some(self.context_estimate(&visible));
        // Variant picker popover (React `MessageVariantPicker`): rows derive
        // from the last successful `chats.messages.variants.list` — stored
        // variants plus the active content row (kernel mode carries no
        // permutation fields on the message, so the active text joins as the
        // implicit last item and the list sorts by position).
        let variant_picker_rows = self.variant_picker_row_views();
        ProductChatView {
            title,
            message_count: self.kernel_message_count(),
            visible,
            chrome,
            composer_text: self.state.composer_text.clone(),
            composer_placeholder,
            character_avatar_asset,
            character_name,
            error_code: self.state.last_error.as_ref().map(|err| err.code.clone()),
            streaming: !self.state.streaming_text.is_empty() || self.state.stream_handle.is_some(),
            tool_activity_name: if !self.state.streaming_text.is_empty()
                || self.state.stream_handle.is_some()
            {
                self.state.tool_activity_name.clone()
            } else {
                None
            },
            viewport_width: self.viewport_width,
            viewport_height: self.viewport_height,
            column_width: self.chat_column_width(),
            context_panel_open: self.state.context_panel_open,
            context_summary,
            editing_message_id: self.state.message_edit_id.clone(),
            editing_draft: self.state.message_edit_draft.clone(),
            history_open_for: self.state.history_message_id.clone(),
            details_message_id: self.state.details_message_id.clone(),
            details_mode: if self.state.details_mode.is_empty() {
                "details".to_string()
            } else {
                self.state.details_mode.clone()
            },
            revision_history: self.state.message_revisions.clone(),
            snapshots_menu_open: self.state.snapshots_menu_open,
            snapshot_items: self
                .state
                .snapshot_items
                .iter()
                .map(|chat| SnapshotItemView {
                    id: chat.id.clone(),
                    title: chat.title.clone(),
                    origin_label: match chat.origin.as_ref() {
                        Some(SnapshotOrigin::Branch) => "Branch".to_string(),
                        _ => "Checkpoint".to_string(),
                    },
                    message_count: chat.message_count,
                })
                .collect(),
            header_search_open: self.state.header_search_open,
            header_search_query: self.state.header_search_query.clone(),
            header_search_match_count: self.state.header_search_match_count,
            variant_picker_for: self.state.variant_picker_for.clone(),
            variant_picker_rows,
            // `None` variants = the lazy list query still loading (React
            // `variants.isLoading`); a fetched-but-empty list shows the
            // honest empty copy.
            variant_picker_empty: self.state.variant_picker_for.is_some()
                && self.state.variant_picker_variants.is_empty(),
            parent_chat_id: self
                .state
                .chat
                .as_ref()
                .and_then(|chat| chat.parent_chat_id.clone()),
        }
    }

    /// React `MessageVariantPicker` rows (kernel mode: the message carries
    /// no permutation fields, so the picker always takes the second branch).
    /// Stored variants keep their wire positions; the active message text
    /// appends as the implicit last item when it is not a stored row; the
    /// stored row matching the active content is marked active. Sorted by
    /// position — the React listbox order.
    fn variant_picker_row_views(&self) -> Vec<neotavern_presentation_dioxus_shell::VariantRowView> {
        let Some(message_id) = self.state.variant_picker_for.as_deref() else {
            return Vec::new();
        };
        let Some(row) = self.state.messages.iter().find(|row| row.id == message_id) else {
            return Vec::new();
        };
        let stored = &self.state.variant_picker_variants;
        let content_index = stored
            .iter()
            .position(|variant| variant.content == row.content);
        let total = stored.len().saturating_add(1);
        let mut rows: Vec<neotavern_presentation_dioxus_shell::VariantRowView> = stored
            .iter()
            .enumerate()
            .map(
                |(index, variant)| neotavern_presentation_dioxus_shell::VariantRowView {
                    id: variant.id.clone(),
                    index_label: format!("{}/{}", variant.position + 1, total),
                    preview: preview_text(&variant.content),
                    active: Some(index) == content_index,
                },
            )
            .collect();
        if content_index.is_none() {
            // The active text is not a stored variant: React appends it
            // (id `active-<messageId>`, position = stored length).
            rows.push(neotavern_presentation_dioxus_shell::VariantRowView {
                id: format!("active-{message_id}"),
                index_label: format!("{total}/{total}"),
                preview: preview_text(&row.content),
                active: true,
            });
        }
        rows.sort_by_key(|row| {
            row.index_label
                .split_once('/')
                .and_then(|(current, _)| current.parse::<u64>().ok())
                .unwrap_or(u64::MAX)
        });
        rows
    }

    /// Local context estimate for the composer context meter (React
    /// `useConversationContextPreview` fallback branch: no prompt audit on
    /// this plane, so the summary is always the draft-estimate state).
    /// History = the visible rows' script-aware estimate; the draft adds the
    /// composer text; the whole sum lands in `chat_history` exactly like the
    /// React fallback breakdown.
    fn context_estimate(&self, visible: &[VisibleRow]) -> ContextUsageSummaryV1 {
        const CONTEXT_LIMIT: u64 = 16_032; // contracts CONTEXT_TOKEN_DEFAULT
        const RESERVED_FOR_REPLY: u64 = 4_000;

        let history: u64 = visible
            .iter()
            .filter(|row| !row.manual_excluded)
            .map(|row| estimate_tokens(&row.content))
            .sum();
        let draft = estimate_tokens(&self.state.composer_text);
        let prompt_tokens = history + draft;
        let available = CONTEXT_LIMIT
            .saturating_sub(RESERVED_FOR_REPLY)
            .saturating_sub(prompt_tokens);
        let usage_percent = (((prompt_tokens + RESERVED_FOR_REPLY) * 100) / CONTEXT_LIMIT).min(100);
        ContextUsageSummaryV1 {
            prompt_tokens,
            context_limit: CONTEXT_LIMIT,
            reserved_for_reply: RESERVED_FOR_REPLY,
            available_tokens: available,
            usage_percent,
            breakdown: ContextUsageBreakdownV1 {
                chat_history: prompt_tokens,
                ..ContextUsageBreakdownV1::default()
            },
        }
    }

    pub fn shell_view(&self) -> ProductShellView {
        let mut characters: Vec<CharacterCardView> = self
            .state
            .characters
            .iter()
            .filter(|row| {
                let q = self.state.character_search.trim().to_lowercase();
                if q.is_empty() {
                    return true;
                }
                row.name.to_lowercase().contains(&q)
                    || row
                        .description
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&q)
                    || row.tags.iter().any(|tag| tag.to_lowercase().contains(&q))
            })
            .map(|row| CharacterCardView {
                id: row.id.clone(),
                name: row.name.clone(),
                description: row.description.clone().unwrap_or_default(),
                tags: row.tags.clone(),
                avatar_asset_id: row.avatar_asset_id.clone(),
                avatar_data_uri: None,
            })
            .collect();
        match self.state.character_sort.as_str() {
            "name-desc" => {
                characters.sort_by(|a, b| b.name.to_lowercase().cmp(&a.name.to_lowercase()))
            }
            "newest" | "oldest" => {}
            _ => characters.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
        }
        if self.state.character_sort == "oldest" {
            characters.reverse();
        }
        let selected = self
            .state
            .selected_character_id
            .clone()
            .or_else(|| characters.first().map(|row| row.id.clone()));
        let selected_draft = self.state.character_draft.clone();
        ProductShellView {
            chat: self.view(),
            characters,
            selected_character_id: selected.clone(),
            selected_draft,
            pinned_character_id: self
                .state
                .pinned_character_id
                .clone()
                .or_else(|| selected.clone()),
            search: self.state.character_search.clone(),
            sort: self.state.character_sort.clone(),
            view: self.state.character_view.clone(),
            tab: self.state.character_tab.clone(),
            panel: self.state.sidebar_panel.clone(),
            sidebar_open: self.state.sidebar_open,
            rail_expanded: self.state.rail_expanded,
            panel_width: self.panel_width(),
            density: "comfortable".into(),
            font_scale: if matches!(self.state.ui_scale.as_str(), "small" | "medium" | "large") {
                self.state.ui_scale.clone()
            } else {
                "medium".into()
            },
            insets: self.state.insets,
            editor_mode: if self.state.character_editor_mode.is_empty() {
                "edit".into()
            } else {
                self.state.character_editor_mode.clone()
            },
            create_dialog_open: self.state.create_dialog_open,
            delete_dialog_open: self.state.delete_dialog_open,
            create_name: self.state.create_name.clone(),
            create_description: self.state.create_description.clone(),
            create_first_message: self.state.create_first_message.clone(),
            status_message: self.state.status_message.clone(),
            error_message: self.state.last_error.as_ref().map(|err| err.code.clone()),
            gallery_columns: if (1..=4).contains(&self.state.gallery_columns) {
                self.state.gallery_columns
            } else {
                3
            },
            gallery_sort: if self.state.gallery_sort == "newest" {
                "newest".into()
            } else {
                "oldest".into()
            },
            expanded_greeting: self.state.expanded_greeting,
            tag_input: self.state.tag_input.clone(),
            personas: self.persona_cards(),
            selected_persona_id: self.state.selected_persona_id.clone(),
            persona_tab: self.state.persona_tab.clone(),
            persona_search: self.state.persona_search.clone(),
            persona_sort: self.state.persona_sort.clone(),
            persona_name_draft: self.state.persona_name_draft.clone(),
            persona_description_draft: self.state.persona_description_draft.clone(),
            persona_create_open: self.state.sidebar_panel == "personas"
                && self.state.create_dialog_open,
            persona_delete_open: self.state.sidebar_panel == "personas"
                && self.state.delete_dialog_open,
            persona_create_name: self.state.create_name.clone(),
            active_persona_id: self.state.active_persona_id.clone(),
            lorebooks: self.lorebook_cards(),
            selected_lorebook_id: self.state.selected_lorebook_id.clone(),
            lorebook_tab: self.state.lorebook_tab.clone(),
            lorebook_search: self.state.lorebook_search.clone(),
            lorebook_create_open: self.state.sidebar_panel == "lorebooks"
                && self.state.create_dialog_open,
            lorebook_delete_open: self.state.sidebar_panel == "lorebooks"
                && self.state.delete_dialog_open,
            lorebook_create_name: self.state.create_name.clone(),
            lorebook_name_draft: self.state.lorebook_name_draft.clone(),
            lorebook_description_draft: self.state.lorebook_description_draft.clone(),
            lorebook_entries: self
                .state
                .lorebook_entries
                .iter()
                .map(|row| LorebookEntryCardView {
                    id: row.id.clone(),
                    keys: row.keys.clone(),
                    secondary_keys: row.secondary_keys.clone(),
                    content: row.content.clone(),
                    enabled: row.enabled,
                    constant: row.constant,
                    selective: row.selective,
                })
                .collect(),
            editing_lorebook_entry_id: self.state.editing_lorebook_entry_id.clone(),
            entry_dialog_open: self.state.entry_dialog_open,
            entry_delete_open: self.state.entry_delete_open,
            entry_keys_draft: self.state.entry_keys_draft.clone(),
            entry_secondary_keys_draft: self.state.entry_secondary_keys_draft.clone(),
            entry_content_draft: self.state.entry_content_draft.clone(),
            entry_enabled_draft: self.state.entry_enabled_draft,
            entry_constant_draft: self.state.entry_constant_draft,
            entry_selective_draft: self.state.entry_selective_draft,
            entry_delete_target_id: self.state.entry_delete_target_id.clone(),
            entry_content_tokens: estimate_tokens(&self.state.entry_content_draft),
            profiles: self
                .state
                .profiles
                .iter()
                .map(|row| ProfileCardView {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    created_at: row.created_at.clone(),
                    updated_at: row.updated_at.clone(),
                })
                .collect(),
            profile_create_name: self.state.profile_create_name.clone(),
            profile_renaming_id: self.state.profile_renaming_id.clone(),
            profile_rename_name: self.state.profile_rename_name.clone(),
            profile_delete_open: self.state.profile_delete_open,
            profile_delete_target_id: self.state.profile_delete_target_id.clone(),
            plugin_uninstall_open: self.state.plugin_uninstall_open,
            plugin_uninstall_target_id: self.state.plugin_uninstall_target_id.clone(),
            chat_rename_open: self.state.chat_rename_open,
            chat_renaming_id: self.state.chat_renaming_id.clone(),
            chat_rename_draft: self.state.chat_rename_draft.clone(),
            chat_delete_open: self.state.chat_delete_open,
            chat_delete_target_id: self.state.chat_delete_target_id.clone(),
            prompt_plan_open: self.state.prompt_plan_open,
            prompt_plan_run_id: self.state.prompt_plan_run_id.clone(),
            prompt_plan: self.state.prompt_plan.clone(),
            prompt_plan_not_found: self.state.prompt_plan_not_found,
            prompt_plan_error: self.state.prompt_plan_error.clone(),
            run_transcript_open: self.state.run_transcript_open,
            run_transcript_run_id: self.state.run_transcript_run_id.clone(),
            run_transcript_steps: self.state.run_transcript_steps.clone(),
            run_transcript_error: self.state.run_transcript_error.clone(),
            checkpoint_delete_open: self.state.checkpoint_delete_open,
            checkpoint_delete_message_id: self.state.checkpoint_delete_message_id.clone(),
            themes: self
                .state
                .themes
                .iter()
                .map(|row| ThemeCardView {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    version: row.version.clone(),
                    active: row.active,
                    trust_state: row.trust_state.clone(),
                })
                .collect(),
            theme_delete_open: self.state.theme_delete_open,
            theme_delete_target_id: self.state.theme_delete_target_id.clone(),
            secrets_status: self.state.secrets_status.clone(),
            selected_provider_id: self.state.active_provider_id.clone(),
            provider_configs: self
                .state
                .provider_configs
                .iter()
                .map(|item| ProviderConfigCardView {
                    id: item.id.clone(),
                    name: item.name.clone(),
                    detail: format!(
                        "{} · API key {}",
                        item.provider,
                        if item.has_api_key { "saved" } else { "not set" }
                    ),
                })
                .collect(),
            provider_create_dialog_open: self.state.provider_create_dialog_open,
            provider_kind_label: self
                .state
                .providers
                .get(self.state.provider_kind_index)
                .map(|item| item.name.clone()),
            provider_name_draft: self.state.provider_name_draft.clone(),
            provider_form_error: self.state.provider_form_error.clone(),
            provider_delete_target_id: self.state.provider_delete_target_id.clone(),
            card_import_dialog_open: self.state.card_import_dialog_open,
            card_path_draft: self.state.card_path_draft.clone(),
            prompt_template_import_open: self.state.prompt_template_import_open,
            prompt_template_path_draft: self.state.prompt_template_path_draft.clone(),
            generation_preset_import_open: self.state.generation_preset_import_open,
            generation_preset_path_draft: self.state.generation_preset_path_draft.clone(),
            profile_import_path: self.state.profile_import_path.clone(),
            profile_import_policy_label: match self.state.profile_import_policy_index {
                1 => "Replace".to_string(),
                2 => "Remap".to_string(),
                _ => "Reject".to_string(),
            },
            selected_preset_id: self.state.active_preset_id.clone(),
            preset_rows: self.preset_value_rows(),
            preset_unlocked_context: self.state.preset_unlocked_context,
            preset_active_name: self
                .state
                .presets
                .iter()
                .find(|item| Some(item.id.as_str()) == self.state.active_preset_id.as_deref())
                .map(|item| item.name.clone()),
            preset_name_dialog_open: self.state.preset_name_dialog_open,
            preset_name_mode: self.state.preset_name_mode.clone(),
            preset_name_draft: self.state.preset_name_draft.clone(),
            preset_form_error: self.state.preset_form_error.clone(),
            preset_delete_open: self.state.preset_delete_open,
            preset_dialog_kind: if self.state.preset_dialog_kind.is_empty() {
                "generation".into()
            } else {
                self.state.preset_dialog_kind.clone()
            },
            prompt_presets: self
                .state
                .prompt_presets
                .iter()
                .map(|item| PresetCardView {
                    id: item.id.clone(),
                    name: item.name.clone(),
                    kind: item.kind.clone(),
                })
                .collect(),
            active_prompt_preset_id: self.state.active_prompt_preset_id.clone(),
            prompt_preset_active_name: self
                .state
                .prompt_presets
                .iter()
                .find(|item| {
                    Some(item.id.as_str()) == self.state.active_prompt_preset_id.as_deref()
                })
                .map(|item| item.name.clone()),
            backups: self
                .state
                .backups
                .iter()
                .map(|item| BackupCardView {
                    id: item.id.clone(),
                    title: item.created_at.clone(),
                    detail: format!(
                        "Manual backup · {:.1} MB",
                        item.size_bytes as f64 / 1024.0 / 1024.0
                    ),
                })
                .collect(),
            memories: self
                .state
                .memories
                .iter()
                .map(|item| {
                    let scope_label = match item.scope {
                        MemoryScope::Global => "Global".to_string(),
                        MemoryScope::Character => item
                            .character_id
                            .as_deref()
                            .and_then(|id| {
                                self.state
                                    .characters
                                    .iter()
                                    .find(|character| character.id == id)
                            })
                            .map(|character| character.name.clone())
                            .unwrap_or_else(|| "Character".to_string()),
                    };
                    let meta = if item.keys.is_empty() {
                        scope_label
                    } else {
                        format!("{} — {}", scope_label, item.keys.join(", "))
                    };
                    MemoryCardView {
                        id: item.id.clone(),
                        meta,
                        content: item.content.clone(),
                        enabled: item.enabled,
                    }
                })
                .collect(),
            memory_edit_id: self.state.memory_edit_id.clone(),
            memory_draft_content: self.state.memory_draft_content.clone(),
            memory_draft_keys: self.state.memory_draft_keys.clone(),
            memory_draft_scope_character: self.state.memory_draft_scope_character,
            memory_draft_character_label: if self.state.memory_draft_scope_character {
                self.memory_character_id().and_then(|id| {
                    self.state
                        .characters
                        .iter()
                        .find(|character| character.id == id)
                        .map(|character| character.name.clone())
                })
            } else {
                None
            },
            memory_draft_enabled: self.state.memory_draft_enabled,
            memory_form_error: self.state.memory_form_error.clone(),
            memory_delete_open: self.state.memory_delete_open,
            memory_delete_target_id: self.state.memory_delete_target_id.clone(),
            tools: self
                .state
                .tools
                .iter()
                .map(|row| ToolCardView {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    description: row.description.clone(),
                    required: row
                        .input_schema
                        .get("required")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|value| value.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect(),
            plugins: self
                .state
                .plugins
                .iter()
                .map(|row| PluginCardView {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    version: row.version.clone(),
                    enabled: row.enabled,
                    trust_state: row.trust_state.clone(),
                    permissions: row.permissions.clone(),
                })
                .collect(),
            providers: self.state.providers.clone(),
            presets: self
                .state
                .presets
                .iter()
                .map(|item| PresetCardView {
                    id: item.id.clone(),
                    name: item.name.clone(),
                    kind: item.kind.clone(),
                })
                .collect(),
            chat_list: {
                let query = self.state.chat_search.trim().to_lowercase();
                self.state
                    .chat_list
                    .iter()
                    .filter(|row| query.is_empty() || row.title.to_lowercase().contains(&query))
                    .map(|row| {
                        let character_label = if row.character_id.is_empty() {
                            String::new()
                        } else {
                            self.state
                                .characters
                                .iter()
                                .find(|card| card.id == row.character_id)
                                .map(|card| card.name.clone())
                                .unwrap_or_default()
                        };
                        ChatCardView {
                            id: row.id.clone(),
                            title: row.title.clone(),
                            message_count: row.message_count,
                            character_label,
                        }
                    })
                    .collect()
            },
            selected_chat_id: self.chat_id.clone(),
            chat_search: self.state.chat_search.clone(),
            language: if self.state.language.is_empty() {
                "en".into()
            } else {
                self.state.language.clone()
            },
            dir: if self.state.dir.is_empty() {
                "ltr".into()
            } else {
                self.state.dir.clone()
            },
            ai_tab: self.state.ai_tab.clone(),
            settings_tab: self.state.settings_tab.clone(),
            ui_contrast: self.state.ui_contrast.clone(),
            ui_font_profile: self.state.ui_font_profile.clone(),
            ui_motion: self.state.ui_motion.clone(),
            open_home_on_load: self.state.open_home_on_load,
            chat_style: self.state.chat_style.clone(),
            chat_avatar_style: self.state.chat_avatar_style.clone(),
            user_message_position: self.state.user_message_position.clone(),
            character_message_position: self.state.character_message_position.clone(),
            ui_opacity: self.state.ui_opacity.min(100),
            ui_glass_blur: self.state.ui_glass_blur.min(40),
            diagnostics: self.state.diagnostics.clone(),
            data_activation: self.state.data_activation.clone(),
            prompt_template_mode: self
                .state
                .prompt_template
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("chat")
                .to_string(),
            instruct_selection: if self.state.instruct_selection.is_empty() {
                "native".into()
            } else {
                self.state.instruct_selection.clone()
            },
            instruct_form_error: self.state.instruct_form_error.clone(),
            prompt_blocks: prompt_block_views(&self.state.prompt_template),
            prompt_block_edit_open: self.state.prompt_block_edit_id.is_some(),
            prompt_block_name_draft: self.state.prompt_block_name_draft.clone(),
            prompt_block_content_draft: self.state.prompt_block_content_draft.clone(),
            prompt_block_content_editable: self
                .state
                .prompt_block_edit_id
                .as_deref()
                .is_some_and(prompt_block_content_editable),
            prompt_block_injection_position: self.state.prompt_block_injection_position.clone(),
            prompt_block_depth_draft: self.state.prompt_block_depth_draft.clone(),
            prompt_block_order_draft: self.state.prompt_block_order_draft.clone(),
            prompt_block_role: self.state.prompt_block_role.clone(),
            prompt_block_triggers: self.state.prompt_block_triggers.clone(),
            prompt_block_forbid_overrides: self.state.prompt_block_forbid_overrides,
            prompt_block_model_draft: self.state.prompt_block_model_draft.clone(),
            instruct_system: instruct_role_text(&self.state.instruct_format, "system"),
            instruct_user: instruct_role_text(&self.state.instruct_format, "user"),
            instruct_assistant: instruct_role_text(&self.state.instruct_format, "assistant"),
            instruct_tool: instruct_role_text(&self.state.instruct_format, "tool"),
            instruct_prompt_suffix: instruct_role_text(&self.state.instruct_format, "promptSuffix"),
            instruct_stop_strings: instruct_stop_text(&self.state.instruct_format),
        }
    }

    fn persona_cards(&self) -> Vec<PersonaCardView> {
        self.state
            .personas
            .iter()
            .map(|row| PersonaCardView {
                id: row.id.clone(),
                name: row.name.clone(),
                description: row.description.clone().unwrap_or_default(),
                is_default: row.is_default,
                is_active: self.state.active_persona_id.as_deref() == Some(row.id.as_str()),
            })
            .collect()
    }

    fn lorebook_cards(&self) -> Vec<LorebookCardView> {
        self.state
            .lorebooks
            .iter()
            .map(|row| LorebookCardView {
                id: row.id.clone(),
                name: row.name.clone(),
                description: row.description.clone().unwrap_or_default(),
                entry_count: row.entry_count,
                character_id: row.character_id.clone(),
            })
            .collect()
    }

    pub fn present_visible(&self) -> (Vec<VisibleRow>, PresentOutcome) {
        self.visible_window()
    }

    pub fn selected_text(&self) -> Option<String> {
        self.state.messages.last().map(|row| row.content.clone())
    }

    fn visible_window(&self) -> (Vec<VisibleRow>, PresentOutcome) {
        let (_, _, viewport_h, _) = chrome_metrics(self.viewport_width, self.viewport_height);
        virtualized_window(
            &self.state.messages,
            f64::from(viewport_h),
            f64::from(self.state.scroll_offset_css),
            &self.assistant_author(),
            &self.macro_context(),
        )
    }

    pub fn mount_vdom(&self) -> usize {
        mount_product_chat(self.view())
    }

    pub fn snapshot_json(&self) -> String {
        let view = self.view();
        let visible: Vec<Value> = view
            .visible
            .iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "role": row.role,
                    "content": row.content,
                })
            })
            .collect();
        json!({
            "chatId": self.chat_id,
            "title": view.title,
            "messageCount": view.message_count,
            "kernelMessageCount": view.message_count,
            "pageLen": self.state.messages.len(),
            "composer": view.composer_text,
            "error": view.error_code,
            "streaming": view.streaming,
            "issued": self.issued,
            "requestId": self.state.last_send_request_id.as_ref().or(self.state.last_request_id.as_ref()),
            "operationId": self.state.last_send_operation_id.as_ref().or(self.state.last_operation_id.as_ref()),
            "durableMessageId": self.state.last_durable_message_id,
            "sceneEpoch": self.state.scene_epoch,
            "sendAccepted": self.state.send_accepted,
            "visible": visible,
        })
        .to_string()
    }

    /// Host debug line. Never includes message or composer content.
    pub fn send_trace_line(&self) -> String {
        let error = self
            .state
            .last_error
            .as_ref()
            .map(|err| err.code.as_str())
            .unwrap_or("none");
        format!(
            "chat_send live_wire=true requestId={} operationId={} durableMessageId={} kernelMessageCount={} pageLen={} sceneEpoch={} sendAccepted={} error={} production_cutover=false",
            self.state
                .last_send_request_id
                .as_deref()
                .or(self.state.last_request_id.as_deref())
                .unwrap_or("-"),
            self.state
                .last_send_operation_id
                .as_deref()
                .or(self.state.last_operation_id.as_deref())
                .unwrap_or("-"),
            self.state.last_durable_message_id.as_deref().unwrap_or("-"),
            self.kernel_message_count(),
            self.state.messages.len(),
            self.state.scene_epoch,
            self.state.send_accepted,
            error,
        )
    }

    fn load_workspace(&mut self) -> Result<(), ChatRouteError> {
        let chat_result = self.load_open_chat();
        self.load_characters();
        self.load_chat_list();
        // Personas + settings feed display macros (`{{user}}` / custom vars).
        self.load_personas();
        chat_result
    }

    /// Refresh the home/chats panel list (`chats.list`).
    fn load_chat_list(&mut self) {
        match self.call_decode(
            "chats.list",
            &RequestListChats {
                character_id: None,
                cursor: None,
                limit: Some(PAGE_LIMIT),
            },
            decode_paged_chats,
        ) {
            Ok(PagedChats { items, .. }) => self.state.chat_list = items,
            Err(err) => self.record_error(err),
        }
    }

    /// Chat search field on the home/chats panel (client-side title filter,
    /// like the React `searchInput` state).
    pub fn set_chat_search(&mut self, query: &str) {
        self.state.chat_search = query.to_string();
        self.bump_scene();
    }

    /// "New chat" action from the home/chats panel: durable `chats.create` on
    /// the pinned (or first) character, then open the fresh chat in place —
    /// React's `handleCreate` navigates to the new chat.
    pub fn create_chat(&mut self) {
        let Some(character_id) = self
            .state
            .pinned_character_id
            .clone()
            .or_else(|| self.state.selected_character_id.clone())
        else {
            return;
        };
        match self.call_decode(
            "chats.create",
            &RequestCreateChat {
                character_id,
                title: None,
                persona_id: None,
            },
            decode_chat_dto,
        ) {
            Ok(chat) => {
                let chat_id = chat.id.clone();
                self.load_chat_list();
                self.open_chat(&chat_id);
            }
            Err(err) => self.record_error(err),
        }
    }

    /// Open another chat from the home/chats list (React opens it in place —
    /// the workspace stays on this screen).
    pub fn open_chat(&mut self, chat_id: &str) {
        if self.chat_id.as_deref() == Some(chat_id) {
            return;
        }
        match self.call_decode(
            "chats.get",
            &RequestGetChat {
                chat_id: chat_id.to_string(),
            },
            decode_chat_dto,
        ) {
            Ok(chat) => {
                self.chat_id = Some(chat.id.clone());
                self.state.chat = Some(chat);
                self.state.messages.clear();
                self.state.scroll_offset_css = 0.0;
                // Interactive overlays never outlive their chat.
                self.state.message_edit_id = None;
                self.state.message_edit_draft.clear();
                self.state.history_message_id = None;
                self.state.message_revisions.clear();
                self.state.snapshots_menu_open = false;
                self.state.snapshot_items.clear();
                self.state.variant_picker_for = None;
                self.state.variant_picker_variants.clear();
                self.state.swipe_label_for = None;
                self.state.swipe_label.clear();
                match self.list_messages(chat_id, None) {
                    Ok(page) => self.absorb_latest_page(page),
                    Err(err) => self.record_error(err),
                }
                self.load_chat_list();
                self.bump_scene();
            }
            Err(err) => self.record_error(err),
        }
    }

    /// Jump back to the parent chat of this branch/checkpoint (React
    /// `ChatHeader` `backToParentChatId` -> `data-component="back-to-parent"`).
    pub fn open_parent_chat(&mut self) {
        if let Some(parent_id) = self.state.chat.as_ref().and_then(|c| c.parent_chat_id.clone()) {
            self.open_chat(&parent_id);
        }
    }

    fn load_open_chat(&mut self) -> Result<(), ChatRouteError> {
        let chat_id = match self.chat_id.clone() {
            Some(id) => id,
            None => {
                let page: PagedChats = self.call_decode(
                    "chats.list",
                    &RequestListChats {
                        character_id: None,
                        cursor: None,
                        limit: Some(PAGE_LIMIT),
                    },
                    decode_paged_chats,
                )?;
                if let Some(first) = page.items.first() {
                    first.id.clone()
                } else {
                    // No chat yet on a fresh device. If a starter character (Hazel) exists, create the first chat
                    // so `live_open` does not fail with EMPTY_LIBRARY on a clean install. The starter seeds the
                    // character via `NEOTA_SEED_STARTER=1` (mobile-ffi `nt_kernel_open` sets the env), but not a chat.
                    let characters_page: PagedCharacters = self.call_decode(
                        "characters.list",
                        &RequestListCharacters {
                            cursor: None,
                            limit: Some(PAGE_LIMIT),
                        },
                        decode_paged_characters,
                    )?;
                    let character_id = if let Some(character) = characters_page.items.first() {
                        character.id.clone()
                    } else {
                        // No character at all (clean DB and starter did not run). Create a minimal Hazel so the
                        // first chat can be created. This mirrors the desktop starter fallback and keeps the
                        // live route usable on a fresh install without requiring `pm clear` data.
                        let hazel: CharacterDto = self.call_decode(
                            "characters.create",
                            &RequestCreateCharacter {
                                name: "Hazel".to_string(),
                                description: Some("[Hazel's Personality= \"sharp\", \"wry\", \"self-taught\", \"stubborn\", \"streetwise\"]".to_string()),
                                tags: Some(vec!["wry".to_string()]),
                                avatar_asset_id: None,
                                profile_id: None,
                            },
                            decode_character_dto,
                        )?;
                        hazel.id.clone()
                    };
                    let created: ChatDto = self.call_decode(
                        "chats.create",
                        &RequestCreateChat {
                            character_id,
                            title: None,
                            persona_id: None,
                        },
                        decode_chat_dto,
                    )?;
                    created.id.clone()
                }
            }
        };
        let chat = self.call_decode(
            "chats.get",
            &RequestGetChat {
                chat_id: chat_id.clone(),
            },
            decode_chat_dto,
        )?;
        self.chat_id = Some(chat.id.clone());
        self.state.chat = Some(chat);
        self.bump_scene();
        let page = self.list_messages(&chat_id, None)?;
        self.absorb_latest_page(page);
        Ok(())
    }

    fn load_characters(&mut self) {
        match self.call_decode(
            "characters.list",
            &RequestListCharacters {
                cursor: None,
                limit: Some(PAGE_LIMIT),
            },
            decode_paged_characters,
        ) {
            Ok(PagedCharacters { items, .. }) => {
                if self.state.selected_character_id.is_none() {
                    self.state.selected_character_id = items.first().map(|row| row.id.clone());
                    self.load_character_draft();
                }
                if self.state.pinned_character_id.is_none() {
                    self.state.pinned_character_id = self.state.selected_character_id.clone();
                }
                self.state.characters = items;
                self.hydrate_character_avatars();
            }
            Err(err) => self.record_error(err),
        }
    }

    /// Reload the character list from the Kernel and refresh the draft.
    pub fn refresh_characters(&mut self) {
        self.load_characters();
        self.load_character_draft();
    }

    /// Select a character by id and load its draft + avatar.
    pub fn select_character(&mut self, id: &str) {
        if self.state.selected_character_id.as_deref() == Some(id) {
            return;
        }
        self.state.selected_character_id = Some(id.to_string());
        self.state.pinned_character_id = Some(id.to_string());
        self.load_character_draft();
        self.bump_scene();
    }

    pub fn set_character_search(&mut self, query: &str) {
        self.state.character_search = query.to_string();
        self.bump_scene();
    }

    pub fn set_character_sort(&mut self, sort: &str) {
        self.state.character_sort = sort.to_string();
        self.bump_scene();
    }

    pub fn set_character_view(&mut self, view: &str) {
        self.state.character_view = view.to_string();
        self.bump_scene();
    }

    pub fn set_character_tab(&mut self, tab: &str) {
        self.state.character_tab = tab.to_string();
        if tab == "advanced" {
            // React `CharacterLorebooks` queries `lorebooks.list` on mount.
            self.load_lorebooks();
        }
        self.bump_scene();
    }

    pub fn toggle_character_editor_mode(&mut self) {
        if self.state.sidebar_panel != "characters" || self.state.selected_character_id.is_none() {
            return;
        }
        if self.state.character_tab != "edit" {
            self.state.character_tab = "edit".into();
            self.state.character_editor_mode = "view".into();
        } else if self.state.character_editor_mode == "view" {
            self.state.character_editor_mode = "edit".into();
        } else {
            self.state.character_editor_mode = "view".into();
        }
        self.bump_scene();
    }

    pub fn set_character_editor_mode(&mut self, mode: &str) {
        self.state.character_editor_mode = mode.to_string();
        self.bump_scene();
    }

    pub fn set_panel(&mut self, panel: &str) {
        if panel == "home" && self.viewport_width <= 600 {
            // Mobile bottom navigation: Home returns to the chat workspace
            // (React navigates to the chat route).
            self.state.sidebar_open = false;
            self.state.sidebar_panel = "home".to_string();
            self.bump_scene();
            return;
        }
        self.state.sidebar_panel = panel.to_string();
        self.state.sidebar_open = true;
        match panel {
            "characters" => self.refresh_characters(),
            "personas" => self.load_personas(),
            "lorebooks" => self.load_lorebooks(),
            "plugins" => self.load_plugins(),
            "providers" => {
                self.load_ai_settings();
                self.load_provider_configs();
            }
            "settings" => {
                self.load_settings();
                self.load_profiles();
                self.load_diagnostics();
            }
            // Desktop rail Home opens the chats management panel over the
            // workspace (React `ChatManagementPanel`).
            "home" => self.load_chat_list(),
            _ => {}
        }
        self.bump_scene();
    }

    pub fn toggle_sidebar(&mut self) {
        self.state.sidebar_open = !self.state.sidebar_open;
        self.bump_scene();
    }

    pub fn toggle_rail(&mut self) {
        // React `Sidebar_railButton[data-action=menu-toggle]` ("Close menu"):
        // the rail's top button collapses/expands the side panel itself, the
        // 60px icon rail always stays.
        self.state.sidebar_open = !self.state.sidebar_open;
        self.bump_scene();
    }

    /// Composer context-meter popover (`chat.composer.context`). Display-only
    /// state: opening the meter never issues a Wire command.
    pub fn toggle_context_panel(&mut self) {
        self.state.context_panel_open = !self.state.context_panel_open;
        self.bump_scene();
    }

    pub fn open_create_dialog(&mut self) {
        self.state.create_dialog_open = true;
        if self.state.create_name.trim().is_empty() {
            self.state.create_name = match self.state.sidebar_panel.as_str() {
                "personas" => "New persona".into(),
                "lorebooks" => "New lorebook".into(),
                _ => "New character".into(),
            };
        }
        self.state.create_description.clear();
        self.state.create_first_message.clear();
        self.bump_scene();
    }

    pub fn close_create_dialog(&mut self) {
        self.state.create_dialog_open = false;
        self.bump_scene();
    }

    pub fn set_create_name(&mut self, value: &str) {
        self.state.create_name = value.to_string();
        self.bump_scene();
    }

    /// Clear the transient status message (toast) shown by the host.
    pub fn clear_status_message(&mut self) {
        if self.state.status_message.is_some() {
            self.state.status_message = None;
            self.bump_scene();
        }
    }

    /// Observability for declarative `custom.<owner>.<name>` intents. They
    /// carry no Product Wire authority by contract, so the default behavior
    /// is an honest trace toast; a future plugin registry attaches real
    /// handlers without changing the document or this call site.
    pub fn custom_intent(&mut self, name: &str) {
        self.state.status_message = Some(format!("[custom] {name} — no handler attached."));
        self.bump_scene();
    }

    /// Full text of a message row by id (host clipboard copy reads this; the
    /// actual OS clipboard write stays on the host, off the shared surface).
    pub fn message_text(&self, row_id: &str) -> Option<String> {
        self.state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .map(|row| row.content.clone())
    }

    /// Reflect that the host copied a message to the OS clipboard. The toast is
    /// only honest: the host writes the clipboard first and calls this after
    /// the write succeeded. Mirrors React `MessageBubble` copy (client-side).
    pub fn copied_message(&mut self, row_id: &str) {
        if self.state.messages.iter().any(|row| row.id == row_id) {
            self.state.status_message = Some("Message copied to clipboard.".into());
            self.bump_scene();
        }
    }

    /// Delete a message via `chats.messages.delete` (React builtin action,
    /// `data-action="delete"` in the inline row).
    pub fn delete_message(&mut self, row_id: &str) {
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_value(
            "chats.messages.delete",
            &RequestDeleteMessage {
                chat_id,
                message_id: row_id.to_string(),
            },
        ) {
            Ok(_) => {
                self.state.messages.retain(|row| row.id != row_id);
                // Keep the cached chat DTO in step with the wire store (the
                // count also feeds the header/chats panel).
                if let Some(chat) = self.state.chat.as_mut() {
                    chat.message_count = (chat.message_count - 1).max(0);
                }
                self.state.status_message = Some("Message deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Open the inline message editor (React `MessageBubble` edit state,
    /// `data-action="edit"`): seeds the draft from the stored content. The
    /// streaming row and an already-open editor are honest no-ops.
    pub fn start_message_edit(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        if self.state.message_edit_id.as_deref() == Some(row_id) {
            return;
        }
        let Some(message) = self.state.messages.iter().find(|row| row.id == row_id) else {
            return;
        };
        self.state.message_edit_id = Some(row_id.to_string());
        self.state.message_edit_draft = message.content.clone();
        self.state.history_message_id = None;
        self.bump_scene();
    }

    pub fn set_message_edit_draft(&mut self, draft: &str) {
        if self.state.message_edit_id.is_some() {
            self.state.message_edit_draft = draft.to_string();
            self.bump_scene();
        }
    }

    /// Close the editor without touching the wire (React Cancel / Escape).
    pub fn cancel_message_edit(&mut self) {
        self.state.message_edit_id = None;
        self.state.message_edit_draft.clear();
        self.bump_scene();
    }

    /// Save the inline editor via `chats.messages.update`. React parity: an
    /// empty or unchanged draft just closes the editor without a wire call;
    /// a failed update keeps the draft open (the error surfaces via
    /// `record_error`).
    pub fn submit_message_edit(&mut self) {
        let Some(row_id) = self.state.message_edit_id.clone() else {
            return;
        };
        let next = self.state.message_edit_draft.trim().to_string();
        let Some(current) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .map(|row| row.content.clone())
        else {
            self.cancel_message_edit();
            return;
        };
        if next.is_empty() || next == current {
            self.cancel_message_edit();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.messages.update",
            &RequestUpdateMessage {
                chat_id,
                message_id: row_id.clone(),
                content: Some(next),
                meta: None,
                clear_checkpoint_chat_id: None,
            },
            decode_message_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                    row.content = updated.content;
                }
                self.state.message_edit_id = None;
                self.state.message_edit_draft.clear();
                self.state.status_message = Some("Message updated.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Open the revision-history card (React `MessageRevisionHistoryCard`,
    /// `data-action="history"`): loads the immutable previous contents of one
    /// message via `chats.messages.revisions.list`.
    pub fn open_message_history(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.messages.revisions.list",
            &RequestMessageRevisionsList {
                chat_id,
                message_id: row_id.to_string(),
            },
            decode_result_message_revision_list,
        ) {
            Ok(result) => {
                self.state.history_message_id = Some(row_id.to_string());
                self.state.message_revisions = result
                    .items
                    .iter()
                    .map(|rev: &MessageRevisionDto| RevisionRow {
                        content: rev.content.clone(),
                        created_at: rev.created_at.clone(),
                    })
                    .collect();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn close_message_history(&mut self) {
        self.state.history_message_id = None;
        self.state.message_revisions.clear();
        self.bump_scene();
    }

    /// Toggle or open the message details card (`data-action="details"`).
    pub fn open_message_details(&mut self, row_id: &str) {
        if self.state.details_message_id.as_deref() == Some(row_id) {
            self.state.details_message_id = None;
            self.state.details_mode = "details".into();
        } else {
            self.state.details_message_id = Some(row_id.to_string());
            self.state.details_mode = "details".into();
        }
        self.bump_scene();
    }

    /// Close the message details card (`data-action="details-close"`).
    pub fn close_message_details(&mut self) {
        if self.state.details_message_id.is_some() {
            self.state.details_message_id = None;
            self.state.details_mode = "details".into();
            self.state.message_edit_id = None;
            self.state.message_edit_draft.clear();
            self.bump_scene();
        }
    }

    /// Set message details mode (`"details"`, `"actions"`, or `"edit"`).
    pub fn set_message_details_mode(&mut self, mode: &str) {
        if self.state.details_mode != mode {
            self.state.details_mode = mode.to_string();
            if mode == "edit" {
                if let Some(msg_id) = self.state.details_message_id.clone() {
                    self.state.message_edit_id = Some(msg_id.clone());
                    if let Some(msg) = self.state.messages.iter().find(|m| m.id == msg_id) {
                        self.state.message_edit_draft = msg.content.clone();
                    }
                }
            } else if mode == "details" || mode == "actions" {
                self.state.message_edit_id = None;
                self.state.message_edit_draft.clear();
            }
            self.bump_scene();
        }
    }

    /// Submit the message details editor (React `MessageDetailsCardV2` save).
    pub fn submit_message_details_edit(&mut self) {
        let Some(row_id) = self.state.details_message_id.clone() else {
            return;
        };
        let next = self.state.message_edit_draft.trim().to_string();
        let Some(current) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .map(|row| row.content.clone())
        else {
            self.close_message_details();
            return;
        };
        if next.is_empty() || next == current {
            self.close_message_details();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.messages.update",
            &RequestUpdateMessage {
                chat_id,
                message_id: row_id.clone(),
                content: Some(next),
                meta: None,
                clear_checkpoint_chat_id: None,
            },
            decode_message_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                    row.content = updated.content;
                }
                self.state.message_edit_id = None;
                self.state.message_edit_draft.clear();
                self.state.details_message_id = None;
                self.state.details_mode = "details".into();
                self.state.status_message = Some("Message updated.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Step UI opacity by a signed delta, clamped to `[0, 100]` (React range slider / stepper).
    pub fn step_ui_opacity(&mut self, delta: i32) {
        let current = self.state.ui_opacity as i32;
        self.state.ui_opacity = (current + delta).clamp(0, 100) as u32;
        self.bump_scene();
    }

    /// Step glass blur by a signed delta, clamped to `[0, 40]` (React range slider / stepper).
    pub fn step_ui_glass_blur(&mut self, delta: i32) {
        let current = self.state.ui_glass_blur as i32;
        self.state.ui_glass_blur = (current + delta).clamp(0, 40) as u32;
        self.bump_scene();
    }

    /// Toggle the snapshots menu (React `ChatSnapshotsMenu` header trigger).
    /// Opening loads the child chats of the active chat via
    /// `chats.snapshots.list`; a chat without snapshots shows the honest
    /// empty state, exactly like React.
    pub fn toggle_snapshots_menu(&mut self) {
        if self.state.snapshots_menu_open {
            self.close_snapshots_menu();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.snapshots.list",
            &RequestSnapshotsList {
                chat_id,
                cursor: None,
                limit: None,
            },
            decode_result_snapshots_list,
        ) {
            Ok(result) => {
                self.state.snapshot_items = result.items;
                self.state.snapshots_menu_open = true;
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn close_snapshots_menu(&mut self) {
        self.state.snapshots_menu_open = false;
        self.state.snapshot_items.clear();
        self.bump_scene();
    }

    /// Open a snapshot row (React navigates to the child chat's own route):
    /// closes the menu and switches to that chat.
    pub fn open_snapshot(&mut self, chat_id: &str) {
        self.close_snapshots_menu();
        self.open_chat(chat_id);
    }

    /// Export one chat via `chats.export` (React `ChatManagementPanel`
    /// "Export" item): the wire returns a kind-tagged JSON document as
    /// base64; the session decodes it and parks it in `last_export` for the
    /// host's file sink (React downloads to the browser, the desktop host
    /// writes a file).
    pub fn export_chat(&mut self, chat_id: &str) {
        match self.call_decode(
            "chats.export",
            &RequestChatsExport {
                chat_id: chat_id.to_string(),
            },
            decode_result_chats_export,
        ) {
            Ok(result) => {
                use base64::Engine as _;
                match base64::engine::general_purpose::STANDARD.decode(&result.content_base64) {
                    Ok(bytes) => {
                        self.state.last_export = Some(LastExport {
                            filename: result.filename.clone(),
                            bytes,
                        });
                        self.state.status_message =
                            Some(format!("Export ready: {}.", result.filename));
                    }
                    Err(_) => self.record_error(ChatRouteError::product(
                        "CONTRACT_VIOLATION",
                        serde_json::json!({ "field": "contentBase64" }),
                    )),
                }
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Host-side sink handoff: consume the parked export after writing it.
    pub fn take_last_export(&mut self) -> Option<LastExport> {
        self.state.last_export.take()
    }

    /// Host confirms where the export landed; the status reflects it.
    pub fn note_export_path(&mut self, path: &str) {
        if self.state.last_export.is_none() {
            self.state.status_message = Some(format!("Exported to {path}"));
            self.bump_scene();
        }
    }

    /// Open the card-import dialog (React `CharacterManagementPanel` hidden
    /// file input; the native host prompts for a path instead).
    pub fn open_card_import(&mut self) {
        if self.state.card_import_dialog_open {
            return;
        }
        self.state.card_path_draft.clear();
        self.state.card_import_dialog_open = true;
        self.bump_scene();
    }

    pub fn close_card_import(&mut self) {
        self.state.card_import_dialog_open = false;
        self.state.card_path_draft.clear();
        self.bump_scene();
    }

    pub fn set_card_path_draft(&mut self, draft: &str) {
        if self.state.card_import_dialog_open {
            self.state.card_path_draft = draft.to_string();
            self.bump_scene();
        }
    }

    /// Stage the file via `assets.put` (kind `card`) and import it through
    /// `imports.character.card` — kernel dedupes by content sha256, so a
    /// re-import reports the existing character (`created == false`). The
    /// imported character becomes the selected one, like React.
    pub fn confirm_card_import(&mut self) {
        let path = self.state.card_path_draft.trim().to_string();
        if path.is_empty() {
            self.state.status_message =
                Some("Provide a JSON or PNG character card from this device.".into());
            self.bump_scene();
            return;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => {
                self.state.status_message = Some(format!("Cannot read {path}: {err}"));
                self.bump_scene();
                return;
            }
        };
        let filename = std::path::Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "card.json".into());
        let content_type = if filename.to_lowercase().ends_with(".png") {
            "image/png"
        } else {
            "application/json"
        };
        use base64::Engine as _;
        let staged = self.call_decode(
            "assets.put",
            &RequestAssetsPut {
                kind: "card".into(),
                filename: filename.clone(),
                content_type: Some(content_type.into()),
                content_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            },
            decode_result_assets_put,
        );
        let asset_id = match staged {
            Ok(result) => result.asset.id,
            Err(err) => {
                self.record_error(err);
                self.bump_scene();
                return;
            }
        };
        match self.call_decode(
            "imports.character.card",
            &RequestImportsCharacterCard { asset_id },
            decode_result_imports_character_card,
        ) {
            Ok(result) => {
                self.refresh_characters();
                self.select_character(&result.character.id);
                self.close_card_import();
                self.state.status_message = Some(if result.created {
                    format!("Imported {}.", result.character.name)
                } else {
                    format!("Already imported ({}).", result.character.name)
                });
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Export the selected character's card via `characters.export.card`
    /// (JSON format): the SillyTavern container comes back base64-encoded
    /// and parks in `last_export` for the host's file sink.
    pub fn export_character_card(&mut self, character_id: &str) {
        match self.call_decode(
            "characters.export.card",
            &RequestCharactersExportCard {
                character_id: character_id.to_string(),
                format: CardExportFormat::Json,
            },
            decode_result_characters_export_card,
        ) {
            Ok(result) => {
                use base64::Engine as _;
                match base64::engine::general_purpose::STANDARD.decode(&result.content_base64) {
                    Ok(bytes) => {
                        self.state.last_export = Some(LastExport {
                            filename: result.filename.clone(),
                            bytes,
                        });
                        self.state.status_message =
                            Some(format!("Export ready: {}.", result.filename));
                    }
                    Err(_) => self.record_error(ChatRouteError::product(
                        "CONTRACT_VIOLATION",
                        serde_json::json!({ "field": "contentBase64" }),
                    )),
                }
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    const PROFILE_IMPORT_POLICIES: [RequestProfileImportPolicy; 3] = [
        RequestProfileImportPolicy::Reject,
        RequestProfileImportPolicy::Replace,
        RequestProfileImportPolicy::Remap,
    ];

    pub fn set_profile_import_path(&mut self, path: &str) {
        self.state.profile_import_path = path.to_string();
        self.bump_scene();
    }

    /// Cycle the duplicate policy (React `<select>`: reject / replace /
    /// remap); the host renders it as a cycling button.
    pub fn cycle_profile_import_policy(&mut self) {
        let next =
            (self.state.profile_import_policy_index + 1) % Self::PROFILE_IMPORT_POLICIES.len();
        self.state.profile_import_policy_index = next;
        self.bump_scene();
    }

    /// Import a verified profile container via `profile.import` (React
    /// `ProfilesPanel` import form): the relative `containerPath` plus the
    /// duplicate policy; success refreshes the library surfaces React
    /// invalidates (characters / chats / lorebooks / presets).
    pub fn submit_profile_import(&mut self) {
        let container_path = self.state.profile_import_path.trim().to_string();
        if container_path.is_empty() {
            self.state.status_message =
                Some("Provide the container path staged under the data root.".into());
            self.bump_scene();
            return;
        }
        let policy = Self::PROFILE_IMPORT_POLICIES[self.state.profile_import_policy_index].clone();
        match self.call_decode(
            "profile.import",
            &RequestProfileImport {
                container_path,
                policy,
            },
            decode_result_profile_import,
        ) {
            Ok(result) => {
                self.refresh_characters();
                self.load_chat_list();
                self.load_lorebooks();
                self.load_presets_list();
                self.load_prompt_presets_list();
                let orphans_note = if result.orphans.is_empty() {
                    String::new()
                } else {
                    format!(" ({} orphans)", result.orphans.len())
                };
                self.state.status_message = Some(format!(
                    "Imported: {inserted} inserted, {updated} updated, {skipped} skipped.{orphans_note}",
                    inserted = result.inserted,
                    updated = result.updated,
                    skipped = result.skipped
                ));
                self.state.profile_import_path.clear();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Freeze the prefix up to and including this message into a fresh child
    /// chat via `chats.snapshots.create` (React builtin actions
    /// `data-action="checkpoint"` / `"branch"`). The user stays in the
    /// current chat; the child appears in the chats list and the snapshots
    /// menu (React parity: a notification offers the jump instead).
    pub fn create_message_snapshot(&mut self, row_id: &str, checkpoint: bool) {
        if row_id == "streaming" {
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.snapshots.create",
            &RequestCreateChatSnapshot {
                chat_id,
                message_id: row_id.to_string(),
                kind: if checkpoint {
                    SnapshotOrigin::Checkpoint
                } else {
                    SnapshotOrigin::Branch
                },
                title: None,
            },
            decode_result_chat_snapshot,
        ) {
            Ok(ResultChatSnapshot {
                chat: child,
                copied_messages,
            }) => {
                if checkpoint {
                    if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                        row.checkpoint_chat_id = Some(child.id.clone());
                    }
                }
                // The child chat is a real chat: keep the sidebar list honest.
                self.load_chat_list();
                self.state.status_message = Some(if checkpoint {
                    format!("Checkpoint created ({copied_messages} messages copied).")
                } else {
                    format!("Branch created ({copied_messages} messages copied).")
                });
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Roll the chat back to this message via `chats.snapshots.rollback`
    /// (React builtin action, `data-action="rollback"`): the wire store
    /// removes everything after the target (higher sequence), the message
    /// itself stays. The visible window is rebuilt from the authoritative
    /// store so the target may sit outside the previously cached page.
    pub fn rollback_to_message(&mut self, row_id: &str) {
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.snapshots.rollback",
            &RequestSnapshotsRollback {
                chat_id: chat_id.clone(),
                to_message_id: row_id.to_string(),
            },
            decode_result_snapshots_rollback,
        ) {
            Ok(result) => {
                match self.list_messages(&chat_id, None) {
                    Ok(page) => {
                        self.state.messages.clear();
                        self.absorb_latest_page(page);
                    }
                    Err(err) => self.record_error(err),
                }
                if let Some(chat) = self.state.chat.as_mut() {
                    chat.message_count = (chat.message_count - result.deleted).max(0);
                }
                self.state.status_message = Some(format!(
                    "Chat rolled back ({deleted} messages removed).",
                    deleted = result.deleted
                ));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Regenerate one assistant response via `generation.retry` with that
    /// row's own source run (`MessageDto.generation_run_id`) — the React
    /// version-controls "Regenerate" action. Rows without a stored run
    /// surface an honest error instead of silently retrying the latest run.
    pub fn regenerate_message(&mut self, row_id: &str) {
        let Some(source_run_id) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| row.generation_run_id.clone())
        else {
            self.record_error(ChatRouteError::product(
                "GENERATION_RUN_NOT_FOUND",
                json!({ "messageId": row_id }),
            ));
            return;
        };
        if let Err(err) = self.start_stream_op(
            "generation.retry",
            &RequestRetryGeneration { source_run_id },
        ) {
            self.record_error(err);
        }
        self.bump_scene();
    }

    /// Swipe to the previous/next variant of an assistant response
    /// (`chats.messages.variants.list` + `.activate`, React
    /// `MessageSwipePager`). The current position is derived from the row's
    /// content; activation swaps the message content on the wire and the
    /// visible window is refreshed from the authoritative store.
    pub fn swipe_variant(&mut self, row_id: &str, direction: i32) {
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        let mut items = match self.call_decode(
            "chats.messages.variants.list",
            &RequestMessageVariantsList {
                chat_id: chat_id.clone(),
                message_id: row_id.to_string(),
            },
            decode_result_message_variant_list,
        ) {
            Ok(result) => result.items,
            Err(err) => {
                self.record_error(err);
                return;
            }
        };
        if items.len() < 2 {
            self.state.status_message = Some("No other variants.".into());
            self.bump_scene();
            return;
        }
        items.sort_by_key(|variant| variant.position);
        let current = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| {
                items
                    .iter()
                    .position(|variant| variant.content == row.content)
            })
            .unwrap_or(0);
        let target_index = current as isize + direction as isize;
        if target_index < 0 || target_index >= items.len() as isize {
            self.state.status_message = Some("No more variants.".into());
            self.bump_scene();
            return;
        }
        if let Err(err) = self.call_value(
            "chats.messages.variants.activate",
            &RequestMessageVariantActivate {
                chat_id: chat_id.clone(),
                message_id: row_id.to_string(),
                variant_id: items[target_index as usize].id.clone(),
            },
        ) {
            self.record_error(err);
            return;
        }
        match self.list_messages(&chat_id, None) {
            Ok(page) => {
                self.state.messages.clear();
                self.absorb_latest_page(page);
            }
            Err(err) => self.record_error(err),
        }
        self.state.status_message = Some(format!(
            "Variant {current} of {total}.",
            current = target_index + 1,
            total = items.len()
        ));
        // The pager counter follows the activation (React invalidates the
        // variants query and re-derives `currentSwipe`).
        self.hydrate_swipe_label(row_id, &items);
        self.bump_scene();
    }
    pub fn open_variant_picker(&mut self, row_id: &str) {
        if self.state.variant_picker_for.as_deref() == Some(row_id) {
            self.state.variant_picker_for = None;
            self.bump_scene();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.messages.variants.list",
            &RequestMessageVariantsList {
                chat_id: chat_id.clone(),
                message_id: row_id.to_string(),
            },
            decode_result_message_variant_list,
        ) {
            Ok(result) => {
                self.state.variant_picker_for = Some(row_id.to_string());
                self.state.variant_picker_variants = result.items.clone();
                self.hydrate_swipe_label(row_id, &result.items);
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn close_variant_picker(&mut self) {
        self.state.variant_picker_for = None;
        self.state.variant_picker_variants.clear();
        self.bump_scene();
    }

    /// Pick a row inside the picker popover: the active row is a no-op
    /// (React `if (!row.active)`), otherwise `variants.activate` by the
    /// variant id (the synthesized `active-` row never crosses the wire).
    pub fn pick_variant(&mut self, row_id: &str, variant_id: &str) {
        if variant_id.starts_with("active-") {
            // React closes the popover on the active row without mutating.
            self.close_variant_picker();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        if let Err(err) = self.call_value(
            "chats.messages.variants.activate",
            &RequestMessageVariantActivate {
                chat_id: chat_id.clone(),
                message_id: row_id.to_string(),
                variant_id: variant_id.to_string(),
            },
        ) {
            self.record_error(err);
            return;
        }
        match self.list_messages(&chat_id, None) {
            Ok(page) => {
                self.state.messages.clear();
                self.absorb_latest_page(page);
            }
            Err(err) => self.record_error(err),
        }
        // Re-list the variants so the picker rows and the swipe counter
        // reflect the activation (React invalidates the variants query).
        match self.list_variants(&chat_id, row_id) {
            Ok(items) => {
                self.state.variant_picker_variants = items.clone();
                self.hydrate_swipe_label(row_id, &items);
            }
            Err(err) => self.record_error(err),
        }
        self.state.variant_picker_for = None;
        self.bump_scene();
    }

    fn list_variants(
        &mut self,
        chat_id: &str,
        message_id: &str,
    ) -> Result<Vec<MessageVariantDto>, ChatRouteError> {
        let result = self.call_decode(
            "chats.messages.variants.list",
            &RequestMessageVariantsList {
                chat_id: chat_id.to_string(),
                message_id: message_id.to_string(),
            },
            decode_result_message_variant_list,
        )?;
        Ok(result.items)
    }

    /// React `ChatPage` counter derivation over the fetched variant list:
    /// the active content matches a stored variant (1-based `position + 1`)
    /// or is the implicit last row (= total = stored count + 1); fewer than
    /// two rows hide the pager (React renders `null` when `total <= 1`).
    fn hydrate_swipe_label(&mut self, row_id: &str, items: &[MessageVariantDto]) {
        let mut items: Vec<&MessageVariantDto> = items.iter().collect();
        items.sort_by_key(|variant| variant.position);
        if items.is_empty() {
            self.state.swipe_label_for = None;
            self.state.swipe_label = String::new();
            return;
        }
        let total = items.len() + 1;
        let current = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| {
                items
                    .iter()
                    .position(|variant| variant.content == row.content)
            })
            .map(|index| items[index].position + 1)
            .unwrap_or(total as i64);
        self.state.swipe_label_for = Some(row_id.to_string());
        self.state.swipe_label = format!("{current}/{total}");
    }

    pub fn set_create_description(&mut self, value: &str) {
        self.state.create_description = value.to_string();
        self.bump_scene();
    }

    pub fn set_create_first_message(&mut self, value: &str) {
        self.state.create_first_message = value.to_string();
        self.bump_scene();
    }

    /// Create a character via `characters.create` and refresh the list.
    pub fn confirm_create_character(&mut self) {
        let name = self.state.create_name.trim().to_string();
        if name.is_empty() {
            self.record_error(ChatRouteError::product(
                "CHARACTER_NAME_REQUIRED",
                json!({ "field": "name" }),
            ));
            return;
        }
        let description = if self.state.create_description.trim().is_empty() {
            None
        } else {
            Some(self.state.create_description.clone())
        };
        let req = RequestCreateCharacter {
            name,
            description,
            tags: None,
            avatar_asset_id: None,
            profile_id: None,
        };
        match self.call_decode("characters.create", &req, decode_character_dto) {
            Ok(created) => {
                self.state.create_dialog_open = false;
                self.state.create_name.clear();
                self.state.create_description.clear();
                self.state.create_first_message.clear();
                self.state.selected_character_id = Some(created.id.clone());
                self.state.pinned_character_id = Some(created.id.clone());
                self.state.character_tab = "edit".into();
                self.refresh_characters();
                self.state.status_message = Some("Character created.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Duplicate the selected character (`characters.create` with
    /// `"{name} copy"`; React `duplicateSelectedCharacter`). Only the fields
    /// the native create contract carries (name / description / tags /
    /// avatar) are copied.
    pub fn duplicate_selected_character(&mut self) {
        let Some(source) = self.state.selected_character_id.as_deref().and_then(|id| {
            self.state
                .characters
                .iter()
                .find(|row| row.id == id)
                .cloned()
        }) else {
            return;
        };
        let req = RequestCreateCharacter {
            name: format!("{} copy", source.name),
            description: source.description.clone(),
            tags: Some(source.tags.clone()),
            avatar_asset_id: source.avatar_asset_id.clone(),
            profile_id: None,
        };
        match self.call_decode("characters.create", &req, decode_character_dto) {
            Ok(created) => {
                self.state.selected_character_id = Some(created.id.clone());
                self.state.pinned_character_id = Some(created.id.clone());
                self.state.character_tab = "edit".into();
                self.refresh_characters();
                self.state.status_message = Some(format!("Created {}.", created.name));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// React `CharacterLorebooks.createForCharacter`: `lorebooks.create` with
    /// `characterId` + open the lorebooks manager.
    fn create_character_lorebook(&mut self) {
        let Some(character_id) = self.state.selected_character_id.clone() else {
            return;
        };
        let req = RequestCreateLorebook {
            name: "New lorebook".into(),
            description: None,
            entries: None,
            character_id: Some(character_id),
        };
        match self.call_decode("lorebooks.create", &req, decode_lorebook_dto) {
            Ok(created) => {
                self.state.selected_lorebook_id = Some(created.id);
                self.state.lorebook_tab = "book".into();
                self.state.status_message = Some("Lorebook created.".into());
                self.set_panel("lorebooks");
            }
            Err(err) => {
                self.record_error(err);
                self.bump_scene();
            }
        }
    }

    /// Wire DTO cannot express `characterId: null` (dto.ts: "null is not
    /// expressible yet"). React kernel-plane silently omits the field;
    /// native reports the honest capability gap instead of a no-op update.
    fn unlink_character_lorebook(&mut self) {
        self.record_error(ChatRouteError::Product(ErrorDto {
            code: "CAPABILITY_UNAVAILABLE".into(),
            params: json!({ "operationId": "lorebooks.update.unlink" }),
            trace_id: None,
            correlation_id: None,
        }));
        self.bump_scene();
    }

    pub fn open_delete_dialog(&mut self) {
        let can_delete = match self.state.sidebar_panel.as_str() {
            "personas" => self.state.selected_persona_id.is_some(),
            "lorebooks" => self.state.selected_lorebook_id.is_some(),
            _ => self.state.selected_character_id.is_some(),
        };
        if can_delete {
            self.state.delete_dialog_open = true;
            self.bump_scene();
        }
    }

    pub fn close_delete_dialog(&mut self) {
        self.state.delete_dialog_open = false;
        self.bump_scene();
    }

    /// Delete the selected character via `characters.delete` and refresh.
    pub fn confirm_delete_character(&mut self) {
        let Some(id) = self.state.selected_character_id.clone() else {
            self.state.delete_dialog_open = false;
            return;
        };
        match self.call_value(
            "characters.delete",
            &RequestDeleteCharacter { character_id: id },
        ) {
            Ok(_) => {
                self.state.delete_dialog_open = false;
                self.state.selected_character_id = None;
                self.state.character_draft = None;
                self.state.avatar_data_uri = None;
                self.state.character_tab = "cards".into();
                self.refresh_characters();
                self.state.status_message = Some("Character deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Toggle favorite flag on the local draft (Kernel contract does not yet
    /// persist favorites; this keeps the UI state honest until it does).
    pub fn toggle_favorite(&mut self) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.favorite = !draft.favorite;
            self.bump_scene();
        }
    }

    pub fn apply_shell_action(&mut self, action: ShellAction) {
        match action {
            ShellAction::ToggleRail => self.toggle_rail(),
            ShellAction::SetPanel(panel) => self.set_panel(&panel),
            ShellAction::ClosePanel => {
                self.state.sidebar_open = false;
                self.bump_scene();
            }
            ShellAction::SetTab(tab) => match self.state.sidebar_panel.as_str() {
                "personas" => self.set_persona_tab(&tab),
                "lorebooks" => self.set_lorebook_tab(&tab),
                "providers" => {
                    let is_memories = tab == "memories";
                    let is_advanced = tab == "advanced";
                    self.state.ai_tab = tab;
                    // React `MemoryEditor` queries on mount.
                    if is_memories {
                        self.load_memories();
                    }
                    // React `AdvancedPromptSettings` reads settings on mount.
                    if is_advanced {
                        self.load_settings();
                        self.load_prompt_presets_list();
                    }
                    self.bump_scene();
                }
                "settings" => {
                    let is_themes = tab == "themes";
                    let is_secrets = tab == "secrets";
                    let is_tools = tab == "tools";
                    let is_data = tab == "data";
                    let is_general = tab == "general";
                    self.state.settings_tab = tab;
                    // React `ThemesTab` / `SecretsPanel` / `ToolsPanel` /
                    // DataTab / GeneralTab query on mount: load when the tab
                    // opens so the surface is real, not a stub.
                    if is_themes {
                        self.load_themes();
                    }
                    if is_secrets {
                        self.load_secrets_status();
                    }
                    if is_tools {
                        self.load_tools();
                    }
                    if is_data {
                        self.load_backups();
                        self.load_data_activation();
                    }
                    if is_general {
                        self.load_diagnostics();
                    }
                    self.bump_scene();
                }
                _ => self.set_character_tab(&tab),
            },
            ShellAction::SetView(view) => self.set_character_view(&view),
            ShellAction::CycleSort => match self.state.sidebar_panel.as_str() {
                "personas" => {
                    self.state.persona_sort = if self.state.persona_sort == "asc" {
                        "desc".into()
                    } else {
                        "asc".into()
                    };
                    self.bump_scene();
                }
                _ => {
                    let next = next_sort(&self.state.character_sort);
                    self.set_character_sort(next);
                }
            },
            ShellAction::SelectCharacter(id) => self.select_character(&id),
            ShellAction::SelectPersona(id) => self.select_persona(&id),
            ShellAction::SelectLorebook(id) => self.select_lorebook(&id),
            ShellAction::SelectChat(id) => self.open_chat(&id),
            ShellAction::BackToParentChat => self.open_parent_chat(),
            ShellAction::CreateChat => self.create_chat(),
            ShellAction::OpenCreate => self.open_create_dialog(),
            ShellAction::CloseCreate => self.close_create_dialog(),
            ShellAction::ConfirmCreate => match self.state.sidebar_panel.as_str() {
                "personas" => self.confirm_create_persona(),
                "lorebooks" => self.confirm_create_lorebook(),
                _ => self.confirm_create_character(),
            },
            ShellAction::OpenDelete => self.open_delete_dialog(),
            ShellAction::CloseDelete => self.close_delete_dialog(),
            ShellAction::ConfirmDelete => match self.state.sidebar_panel.as_str() {
                "personas" => self.confirm_delete_persona(),
                "lorebooks" => self.confirm_delete_lorebook(),
                _ => self.confirm_delete_character(),
            },
            ShellAction::ToggleFavorite => self.toggle_favorite(),
            ShellAction::BackToCards => match self.state.sidebar_panel.as_str() {
                "personas" => self.set_persona_tab("cards"),
                "lorebooks" => self.set_lorebook_tab("books"),
                _ => self.set_character_tab("cards"),
            },
            ShellAction::OpenEntryDialog => self.open_entry_dialog(),
            ShellAction::EditLorebookEntry(id) => self.open_entry_dialog_for(&id),
            ShellAction::CloseEntryDialog => self.close_entry_dialog(),
            ShellAction::SaveEntry => self.save_entry(),
            ShellAction::ToggleLorebookEntry(id) => self.toggle_lorebook_entry(&id),
            ShellAction::OpenEntryDelete(id) => {
                self.state.entry_delete_target_id = Some(id);
                self.state.entry_delete_open = true;
                self.bump_scene();
            }
            ShellAction::CloseEntryDelete => {
                self.state.entry_delete_open = false;
                self.state.entry_delete_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmEntryDelete => self.confirm_delete_entry(),
            ShellAction::EntryToggleEnabled => {
                self.state.entry_enabled_draft = !self.state.entry_enabled_draft;
                self.bump_scene();
            }
            ShellAction::EntryToggleConstant => {
                self.state.entry_constant_draft = !self.state.entry_constant_draft;
                self.bump_scene();
            }
            ShellAction::EntryToggleSelective => {
                self.state.entry_selective_draft = !self.state.entry_selective_draft;
                self.bump_scene();
            }
            ShellAction::CreateProfile => self.create_profile(),
            ShellAction::StartProfileRename(id) => self.start_profile_rename(&id),
            ShellAction::SubmitProfileRename => self.submit_profile_rename(),
            ShellAction::CancelProfileRename => {
                self.state.profile_renaming_id = None;
                self.state.profile_rename_name.clear();
                self.bump_scene();
            }
            ShellAction::OpenProfileDelete(id) => {
                self.state.profile_delete_target_id = Some(id);
                self.state.profile_delete_open = true;
                self.bump_scene();
            }
            ShellAction::CloseProfileDelete => {
                self.state.profile_delete_open = false;
                self.state.profile_delete_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmProfileDelete => self.confirm_delete_profile(),
            ShellAction::ExportProfile(id) => self.export_profile(&id),
            ShellAction::TogglePlugin(id) => self.toggle_plugin(&id),
            ShellAction::OpenPluginUninstall(id) => {
                self.state.plugin_uninstall_target_id = Some(id);
                self.state.plugin_uninstall_open = true;
                self.bump_scene();
            }
            ShellAction::ClosePluginUninstall => {
                self.state.plugin_uninstall_open = false;
                self.state.plugin_uninstall_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmPluginUninstall => self.confirm_uninstall_plugin(),
            ShellAction::StartChatRename(id) => self.start_chat_rename(&id),
            ShellAction::CloseChatRename => {
                self.state.chat_rename_open = false;
                self.state.chat_renaming_id = None;
                self.bump_scene();
            }
            ShellAction::SubmitChatRename => self.submit_chat_rename(),
            ShellAction::OpenChatDelete(id) => {
                self.state.chat_delete_target_id = Some(id);
                self.state.chat_delete_open = true;
                self.bump_scene();
            }
            ShellAction::CloseChatDelete => {
                self.state.chat_delete_open = false;
                self.state.chat_delete_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmChatDelete => self.confirm_delete_chat(),
            ShellAction::OpenPromptPlan(run_id) => self.open_prompt_plan(&run_id),
            ShellAction::ClosePromptPlan => self.close_prompt_plan(),
            ShellAction::OpenRunTranscript(run_id) => self.open_run_transcript(&run_id),
            ShellAction::CloseRunTranscript => self.close_run_transcript(),
            ShellAction::OpenCheckpointDelete(id) => self.open_checkpoint_delete(&id),
            ShellAction::CloseCheckpointDelete => self.close_checkpoint_delete(),
            ShellAction::ConfirmCheckpointDelete => self.confirm_checkpoint_delete(),
            ShellAction::DuplicateCharacter => self.duplicate_selected_character(),
            ShellAction::ToggleCharacterEditorMode => self.toggle_character_editor_mode(),
            ShellAction::SetCharacterEditorMode(mode) => self.set_character_editor_mode(&mode),
            ShellAction::CreateCharacterLorebook => self.create_character_lorebook(),
            ShellAction::UnlinkCharacterLorebook(_) => self.unlink_character_lorebook(),
            ShellAction::UploadGalleryImage => {
                // Kernel plane has no character gallery: React
                // `useUploadCharacterImage` rejects with `UnsupportedError`.
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "characters.gallery.upload" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::CycleGalleryColumns => {
                self.state.gallery_columns = next_gallery_columns(self.state.gallery_columns);
                self.bump_scene();
            }
            ShellAction::CycleGallerySort => {
                self.state.gallery_sort = next_gallery_sort(&self.state.gallery_sort).to_string();
                self.bump_scene();
            }
            ShellAction::CycleLanguage => self.cycle_language(),
            ShellAction::ToggleOpenHomeOnLoad => {
                self.state.open_home_on_load = !self.state.open_home_on_load;
                self.bump_scene();
            }
            ShellAction::CycleUiScale => {
                self.state.ui_scale = next_choice(UI_SCALES, &self.state.ui_scale).to_string();
                self.bump_scene();
            }
            ShellAction::CycleContrast => {
                self.state.ui_contrast =
                    next_choice(UI_CONTRASTS, &self.state.ui_contrast).to_string();
                self.bump_scene();
            }
            ShellAction::CycleFontProfile => {
                self.state.ui_font_profile =
                    next_choice(UI_FONT_PROFILES, &self.state.ui_font_profile).to_string();
                self.bump_scene();
            }
            ShellAction::CycleMotion => {
                self.state.ui_motion = next_choice(UI_MOTIONS, &self.state.ui_motion).to_string();
                self.bump_scene();
            }
            ShellAction::CycleChatStyle => {
                self.state.chat_style =
                    next_choice(CHAT_STYLES, &self.state.chat_style).to_string();
                self.bump_scene();
            }
            ShellAction::CycleChatAvatarStyle => {
                self.state.chat_avatar_style =
                    next_choice(CHAT_AVATAR_STYLES, &self.state.chat_avatar_style).to_string();
                self.bump_scene();
            }
            ShellAction::CycleUserMessagePosition => {
                self.state.user_message_position =
                    next_choice(MESSAGE_POSITIONS, &self.state.user_message_position).to_string();
                self.bump_scene();
            }
            ShellAction::CycleCharacterMessagePosition => {
                self.state.character_message_position =
                    next_choice(MESSAGE_POSITIONS, &self.state.character_message_position)
                        .to_string();
                self.bump_scene();
            }
            ShellAction::CycleUiOpacity => {
                self.state.ui_opacity = next_step(self.state.ui_opacity, 0, 100, 5);
                self.bump_scene();
            }
            ShellAction::CycleUiGlassBlur => {
                self.state.ui_glass_blur = next_step(self.state.ui_glass_blur, 0, 40, 4);
                self.bump_scene();
            }
            ShellAction::StepUiOpacity(delta) => self.step_ui_opacity(delta),
            ShellAction::StepUiGlassBlur(delta) => self.step_ui_glass_blur(delta),
            ShellAction::RunDiagnostics => self.load_diagnostics(),
            ShellAction::RebuildSearch => {
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "search.rebuild" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::ClearDiagnosticCache => {
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "diagnostics.cache" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::AnalyzeSillyTavern => {
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "imports.sillytavern.analyze" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::CyclePromptMode => self.cycle_prompt_mode(),
            ShellAction::CycleInstructSelection => self.cycle_instruct_selection(),
            ShellAction::SaveInstructTemplate => self.save_instruct_template(),
            ShellAction::TogglePromptBlock(id) => self.toggle_prompt_block(&id),
            ShellAction::AddPromptBlock => self.add_prompt_block(),
            ShellAction::RemovePromptBlock(id) => self.remove_prompt_block(&id),
            ShellAction::MovePromptBlockUp(id) => self.move_prompt_block(&id, -1),
            ShellAction::MovePromptBlockDown(id) => self.move_prompt_block(&id, 1),
            ShellAction::EditPromptBlock(id) => self.edit_prompt_block(&id),
            ShellAction::PromptBlockEditCancel => self.close_prompt_block_editor(),
            ShellAction::PromptBlockEditSave => self.save_prompt_block_editor(),
            ShellAction::CyclePromptBlockPosition => self.cycle_prompt_block_position(),
            ShellAction::CyclePromptBlockRole => self.cycle_prompt_block_role(),
            ShellAction::TogglePromptBlockTrigger(id) => self.toggle_prompt_block_trigger(&id),
            ShellAction::TogglePromptBlockForbidOverrides => {
                self.toggle_prompt_block_forbid_overrides()
            }
            ShellAction::LoadPromptBlockModels => self.load_prompt_block_models(),
            ShellAction::CyclePromptPreset => self.cycle_prompt_preset(),
            ShellAction::PromptPresetSave => self.save_prompt_preset(),
            ShellAction::PromptPresetRename => self.open_prompt_preset_rename(),
            ShellAction::PromptPresetDuplicate => self.open_prompt_preset_duplicate(),
            ShellAction::PromptPresetDelete => self.open_prompt_preset_delete(),
            ShellAction::PromptTemplateImportOpen => self.open_prompt_template_import(),
            ShellAction::PromptTemplateImportClose => self.close_prompt_template_import(),
            ShellAction::PromptTemplateImportConfirm => self.confirm_prompt_template_import(),
            ShellAction::ExportPromptTemplate => self.export_prompt_template(),
            ShellAction::StopGeneration => {
                let _ = self.cancel_generation();
            }
            ShellAction::UploadBackground => {
                // Kernel plane has no wallpaper catalog: React
                // `useUploadBackground` rejects with `UnsupportedError`.
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "backgrounds.upload" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::ActivateTheme(id) => self.activate_theme(&id),
            ShellAction::UseBuiltInTheme => self.use_builtin_theme(),
            ShellAction::InstallTheme => {
                // React kernel plane: `installTheme` rejects with
                // `UnsupportedError('themes.install.host-verify')` — package
                // verification is host-side, so no Wire op is invented here.
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "themes.install.host-verify" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::OpenThemeDelete(id) => {
                self.state.theme_delete_target_id = Some(id);
                self.state.theme_delete_open = true;
                self.bump_scene();
            }
            ShellAction::CloseThemeDelete => {
                self.state.theme_delete_open = false;
                self.state.theme_delete_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmThemeDelete => self.confirm_delete_theme(),
            ShellAction::LockSecrets => self.lock_secrets(),
            ShellAction::SelectProvider(id) => self.select_provider(&id),
            ShellAction::SelectPreset(id) => self.select_preset(&id),
            ShellAction::CreateBackup => self.create_backup(),
            ShellAction::RefreshBackups => self.load_backups(),
            ShellAction::RestoreBackup(id) => self.restore_backup(&id),
            ShellAction::MemoryToggle(id) => self.toggle_memory(&id),
            ShellAction::MemoryEditOpen(id) => self.begin_memory_edit(&id),
            ShellAction::MemoryEditCancel => self.cancel_memory_edit(),
            ShellAction::MemorySave => self.save_memory(),
            ShellAction::MemoryDeleteOpen(id) => self.open_memory_delete(&id),
            ShellAction::MemoryDeleteClose => self.close_memory_delete(),
            ShellAction::MemoryDeleteConfirm => self.confirm_memory_delete(),
            ShellAction::MemoryDraftToggleScope => self.toggle_memory_draft_scope(),
            ShellAction::MemoryCycleCharacter => self.cycle_memory_character(),
            ShellAction::MemoryDraftToggleEnabled => self.toggle_memory_draft_enabled(),
            ShellAction::PresetApply => self.apply_preset_draft(),
            ShellAction::PresetToggleUnlock => self.toggle_preset_unlock(),
            ShellAction::PresetFocusValue(id) => self.focus_preset_value(&id),
            ShellAction::PresetToggleFlag(id) => self.toggle_preset_flag(&id),
            ShellAction::PresetSaveAsOpen => self.open_preset_create(),
            ShellAction::PresetRenameOpen => self.open_preset_rename(),
            ShellAction::PresetNameCancel => self.close_preset_name(),
            ShellAction::PresetNameSubmit => self.confirm_preset_name(),
            ShellAction::PresetDuplicate => self.duplicate_preset(),
            ShellAction::PresetDeleteOpen => self.open_preset_delete(),
            ShellAction::PresetDeleteClose => self.close_preset_delete(),
            ShellAction::PresetDeleteConfirm => self.confirm_preset_delete(),
            ShellAction::PresetImportOpen => self.open_generation_preset_import(),
            ShellAction::PresetImportClose => self.close_generation_preset_import(),
            ShellAction::PresetImportConfirm => self.confirm_generation_preset_import(),
            ShellAction::PresetExport => self.export_generation_preset(),
            ShellAction::ProviderCreateOpen => self.open_provider_create(),
            ShellAction::ProviderCreateClose => self.close_provider_create(),
            ShellAction::ProviderCycleKind => self.cycle_provider_kind(),
            ShellAction::ProviderCreateSubmit => self.confirm_provider_create(),
            ShellAction::ProviderDeleteOpen(id) => self.open_provider_delete(&id),
            ShellAction::ProviderDeleteClose => self.close_provider_delete(),
            ShellAction::ProviderDeleteConfirm => self.confirm_provider_delete(),
            ShellAction::SnapshotsClose => self.close_snapshots_menu(),
            ShellAction::OpenSnapshot(id) => self.open_snapshot(&id),
            ShellAction::VariantPickerClose => self.close_variant_picker(),
            ShellAction::PickVariant(message_id, variant_id) => {
                self.pick_variant(&message_id, &variant_id)
            }
            ShellAction::ExportChat(id) => self.export_chat(&id),
            ShellAction::LorebookSaveMeta => self.save_lorebook_meta(),
            ShellAction::PersonaSaveMeta => self.save_persona_meta(),
            ShellAction::CharacterSaveMeta => self.save_character_meta(),
            ShellAction::AddCharacterTag => self.add_character_tag(),
            ShellAction::RemoveCharacterTag(tag) => self.remove_character_tag(&tag),
            ShellAction::ToggleAlternateGreeting(idx) => self.toggle_alternate_greeting(idx),
            ShellAction::AddAlternateGreeting => self.add_alternate_greeting(),
            ShellAction::RemoveAlternateGreeting(idx) => self.remove_alternate_greeting(idx),
            ShellAction::OpenMessageDetails(id) => self.open_message_details(&id),
            ShellAction::CloseMessageDetails => self.close_message_details(),
            ShellAction::SetMessageDetailsMode(mode) => self.set_message_details_mode(&mode),
            ShellAction::SubmitMessageDetailsEdit => self.submit_message_details_edit(),
            ShellAction::Import => self.open_card_import(),
            ShellAction::ImportClose => self.close_card_import(),
            ShellAction::ConfirmCardImport => self.confirm_card_import(),
            ShellAction::ExportCharacterCard(id) => self.export_character_card(&id),
            ShellAction::ProfileImportPolicyCycle => self.cycle_profile_import_policy(),
            ShellAction::ProfileImportSubmit => self.submit_profile_import(),
        }
    }

    pub fn save_character_meta(&mut self) {
        let Some(draft) = self.state.character_draft.clone() else {
            return;
        };
        let Some(stored) = self
            .state
            .characters
            .iter()
            .find(|row| row.id == draft.id)
            .cloned()
        else {
            return;
        };
        let next_name = draft.name.trim().to_string();
        let name_change = !next_name.is_empty() && next_name != stored.name;
        let next_description = draft.description.clone();
        let stored_description = stored.description.clone().unwrap_or_default();
        let description_change = next_description != stored_description;
        if !name_change && !description_change {
            self.state.status_message = Some("No changes.".into());
            self.bump_scene();
            return;
        }
        let req = RequestUpdateCharacter {
            character_id: draft.id.clone(),
            name: if name_change {
                Some(next_name.clone())
            } else {
                None
            },
            description: if description_change {
                Some(next_description.clone())
            } else {
                None
            },
            tags: None,
            avatar_asset_id: None,
            profile_id: None,
        };
        match self.call_decode("characters.update", &req, decode_character_dto) {
            Ok(updated) => {
                if let Some(row) = self
                    .state
                    .characters
                    .iter_mut()
                    .find(|row| row.id == updated.id)
                {
                    row.name = updated.name.clone();
                    row.description = updated.description.clone();
                }
                if let Some(local) = self.state.character_draft.as_mut() {
                    if local.id == updated.id {
                        local.name = updated.name.clone();
                        local.description = updated.description.unwrap_or_default();
                    }
                }
                self.state.status_message = Some(format!("Saved {}.", updated.name));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_character_name_draft(&mut self, value: &str) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.name = value.to_string();
        }
        self.bump_scene();
    }

    pub fn set_character_description_draft(&mut self, value: &str) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.description = value.to_string();
        }
        self.bump_scene();
    }

    pub fn set_character_first_message(&mut self, value: &str) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.first_message = value.to_string();
        }
        self.bump_scene();
    }

    pub fn set_character_creator_notes(&mut self, value: &str) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.creator_notes = value.to_string();
        }
        self.bump_scene();
    }

    pub fn toggle_alternate_greeting(&mut self, index: usize) {
        if self.state.expanded_greeting == Some(index) {
            self.state.expanded_greeting = None;
        } else {
            self.state.expanded_greeting = Some(index);
        }
        self.bump_scene();
    }

    pub fn add_alternate_greeting(&mut self) {
        let Some(draft) = self.state.character_draft.as_mut() else {
            return;
        };
        draft.alternate_greetings.push(String::new());
        let new_idx = draft.alternate_greetings.len().saturating_sub(1);
        self.state.expanded_greeting = Some(new_idx);
        self.bump_scene();
    }

    pub fn remove_alternate_greeting(&mut self, index: usize) {
        let Some(draft) = self.state.character_draft.as_mut() else {
            return;
        };
        if index < draft.alternate_greetings.len() {
            draft.alternate_greetings.remove(index);
            if self.state.expanded_greeting == Some(index) {
                self.state.expanded_greeting = None;
            } else if let Some(expanded) = self.state.expanded_greeting {
                if expanded > index {
                    self.state.expanded_greeting = Some(expanded - 1);
                }
            }
        }
        self.bump_scene();
    }

    pub fn set_alternate_greeting(&mut self, index: usize, value: &str) {
        let Some(draft) = self.state.character_draft.as_mut() else {
            return;
        };
        if let Some(item) = draft.alternate_greetings.get_mut(index) {
            *item = value.to_string();
            self.bump_scene();
        }
    }

    pub fn set_tag_input(&mut self, value: &str) {
        self.state.tag_input = value.to_string();
        self.bump_scene();
    }

    /// React `EditTab.addTag`: trim, skip duplicates case-insensitively,
    /// cap at 32 tags / 64 chars, persist `tags` immediately.
    fn add_character_tag(&mut self) {
        let value = self.state.tag_input.trim().to_string();
        self.state.tag_input.clear();
        if value.is_empty() {
            self.bump_scene();
            return;
        }
        let value: String = value.chars().take(64).collect();
        let Some(draft) = self.state.character_draft.as_mut() else {
            self.bump_scene();
            return;
        };
        if draft.tags.len() >= 32 {
            self.bump_scene();
            return;
        }
        let lower = value.to_lowercase();
        if draft.tags.iter().any(|tag| tag.to_lowercase() == lower) {
            self.bump_scene();
            return;
        }
        draft.tags.push(value);
        self.persist_character_tags();
    }

    /// React `EditTab` chip remove. Unknown tags are a no-op.
    fn remove_character_tag(&mut self, tag: &str) {
        let Some(draft) = self.state.character_draft.as_mut() else {
            return;
        };
        let before = draft.tags.len();
        draft.tags.retain(|item| item != tag);
        if draft.tags.len() == before {
            return;
        }
        self.persist_character_tags();
    }

    fn persist_character_tags(&mut self) {
        let Some(draft) = self.state.character_draft.as_ref() else {
            return;
        };
        let req = RequestUpdateCharacter {
            character_id: draft.id.clone(),
            name: None,
            description: None,
            tags: Some(draft.tags.clone()),
            avatar_asset_id: None,
            profile_id: None,
        };
        match self.call_decode("characters.update", &req, decode_character_dto) {
            Ok(updated) => {
                if let Some(row) = self
                    .state
                    .characters
                    .iter_mut()
                    .find(|row| row.id == updated.id)
                {
                    row.tags = updated.tags.clone();
                }
                if let Some(local) = self.state.character_draft.as_mut() {
                    if local.id == updated.id {
                        local.tags = updated.tags;
                    }
                }
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Load the full draft for the currently selected character.
    fn load_character_draft(&mut self) {
        let Some(id) = self.state.selected_character_id.clone() else {
            self.state.character_draft = None;
            self.state.avatar_data_uri = None;
            self.state.tag_input.clear();
            return;
        };
        match self.call_decode(
            "characters.get",
            &RequestGetCharacter {
                character_id: id.clone(),
            },
            decode_character_dto,
        ) {
            Ok(dto) => {
                let mut draft = CharacterDraftView::default();
                draft.id = dto.id.clone();
                draft.name = dto.name.clone();
                draft.description = dto.description.clone().unwrap_or_default();
                draft.tags = dto.tags.clone();
                draft.avatar_asset_id = dto.avatar_asset_id.clone();
                draft.first_message = format!("*{} looks up.* Hey.", dto.name);
                draft.creator_notes = format!("Character card for {}.", dto.name);
                draft.alternate_greetings = vec![format!("*{} nods.* Good to see you.", dto.name)];
                self.state.character_draft = Some(draft);
                self.state.expanded_greeting = None;
                self.load_avatar_data_uri(dto.avatar_asset_id.as_deref());
            }
            Err(err) => {
                self.record_error(err);
                self.state.character_draft = None;
                self.state.avatar_data_uri = None;
            }
        }
        self.state.tag_input.clear();
    }

    /// Resolve avatars for every listed character via Product Wire `assets.content`.
    fn hydrate_character_avatars(&mut self) {
        let asset_ids: Vec<String> = self
            .state
            .characters
            .iter()
            .filter_map(|row| row.avatar_asset_id.clone())
            .collect();
        for asset_id in asset_ids {
            if self.state.avatar_thumbs.contains_key(&asset_id) {
                self.state.touch_avatar(&asset_id);
                continue;
            }
            if let Some(thumb) = self.fetch_avatar_thumb(&asset_id) {
                self.state.insert_avatar_thumb(asset_id, thumb);
            }
        }
    }

    fn fetch_avatar_thumb(&mut self, asset_id: &str) -> Option<crate::avatar::AvatarThumb> {
        match self.call_decode(
            "assets.content",
            &RequestAssetsContent {
                asset_id: asset_id.to_string(),
            },
            decode_result_assets_content,
        ) {
            Ok(ResultAssetsContent { content_base64, .. }) => {
                crate::avatar::premultiplied_cover_thumbnail(&content_base64)
            }
            Err(_) => None,
        }
    }

    /// Resolve the avatar asset into a GPU thumbnail. Never a `data:` URI.
    fn load_avatar_data_uri(&mut self, asset_id: Option<&str>) {
        let Some(asset_id) = asset_id else {
            self.state.avatar_data_uri = None;
            return;
        };
        if self.state.avatar_thumbs.contains_key(asset_id) {
            self.state.touch_avatar(asset_id);
            self.state.avatar_data_uri = None;
            if let Some(draft) = self.state.character_draft.as_mut() {
                draft.avatar_data_uri = None;
            }
            return;
        }
        if let Some(thumb) = self.fetch_avatar_thumb(asset_id) {
            self.state.insert_avatar_thumb(asset_id.to_string(), thumb);
        }
        self.state.avatar_data_uri = None;
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.avatar_data_uri = None;
        }
    }

    fn load_personas(&mut self) {
        match self.call_decode(
            "personas.list",
            &RequestEmpty {},
            decode_result_list_personas,
        ) {
            Ok(ResultListPersonas { items }) => {
                self.state.personas = items;
                if self.state.selected_persona_id.is_none() {
                    self.state.selected_persona_id =
                        self.state.personas.first().map(|row| row.id.clone());
                }
                if let Some(id) = self.state.selected_persona_id.clone() {
                    self.seed_persona_draft(&id);
                }
            }
            Err(err) => self.record_error(err),
        }
        self.load_settings();
    }

    fn seed_persona_draft(&mut self, id: &str) {
        if let Some(row) = self.state.personas.iter().find(|item| item.id == id) {
            self.state.persona_name_draft = row.name.clone();
            self.state.persona_description_draft = row.description.clone().unwrap_or_default();
        }
    }

    pub fn set_persona_name_draft(&mut self, draft: &str) {
        self.state.persona_name_draft = draft.to_string();
        self.bump_scene();
    }

    pub fn set_persona_description_draft(&mut self, draft: &str) {
        self.state.persona_description_draft = draft.to_string();
        self.bump_scene();
    }

    /// Save the persona editor (React `PersonasPanel` edit tab): only
    /// changed fields cross the wire; an empty trimmed name keeps the stored
    /// one; a no-op save skips the wire call.
    pub fn save_persona_meta(&mut self) {
        let Some(id) = self.state.selected_persona_id.clone() else {
            return;
        };
        let Some(current) = self
            .state
            .personas
            .iter()
            .find(|item| item.id == id)
            .map(|item| (item.name.clone(), item.description.clone()))
        else {
            return;
        };
        let (current_name, current_description) = current;
        let next_name = self.state.persona_name_draft.trim().to_string();
        let next_description = self.state.persona_description_draft.clone();
        let name_change = !next_name.is_empty() && next_name != current_name;
        let description_change = Some(next_description.clone()) != current_description
            && !(next_description.is_empty() && current_description.is_none());
        if !name_change && !description_change {
            self.state.status_message = Some("No changes.".into());
            self.bump_scene();
            return;
        }
        match self.call_decode(
            "personas.update",
            &RequestUpdatePersona {
                persona_id: id,
                name: if name_change { Some(next_name) } else { None },
                description: if description_change {
                    Some(next_description)
                } else {
                    None
                },
                avatar: None,
                is_default: None,
            },
            decode_persona_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self
                    .state
                    .personas
                    .iter_mut()
                    .find(|item| item.id == updated.id)
                {
                    row.name = updated.name.clone();
                    row.description = updated.description.clone();
                }
                self.seed_persona_draft(&updated.id);
                self.state.status_message = Some("Persona updated.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn select_persona(&mut self, id: &str) {
        self.state.selected_persona_id = Some(id.to_string());
        self.seed_persona_draft(id);
        self.state.persona_tab = "edit".into();
        self.bump_scene();
    }

    pub fn set_persona_tab(&mut self, tab: &str) {
        self.state.persona_tab = tab.to_string();
        self.bump_scene();
    }

    fn confirm_create_persona(&mut self) {
        let name = self.state.create_name.trim();
        let name = if name.is_empty() { "New persona" } else { name };
        let req = RequestCreatePersona {
            name: name.to_string(),
            description: None,
            avatar: None,
            is_default: Some(self.state.personas.is_empty()),
        };
        match self.call_decode("personas.create", &req, decode_persona_dto) {
            Ok(created) => {
                self.state.create_dialog_open = false;
                self.state.create_name.clear();
                self.state.selected_persona_id = Some(created.id.clone());
                self.state.persona_tab = "edit".into();
                if self.state.active_persona_id.is_none() {
                    self.state.active_persona_id = Some(created.id);
                }
                self.load_personas();
                self.state.status_message = Some("Persona created.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn confirm_delete_persona(&mut self) {
        let Some(id) = self.state.selected_persona_id.clone() else {
            self.state.delete_dialog_open = false;
            return;
        };
        if self.state.personas.len() <= 1 {
            self.state.delete_dialog_open = false;
            self.state.status_message = Some("At least one persona must remain.".into());
            self.bump_scene();
            return;
        }
        match self.call_value(
            "personas.delete",
            &RequestDeletePersona {
                persona_id: id.clone(),
            },
        ) {
            Ok(_) => {
                self.state.delete_dialog_open = false;
                if self.state.active_persona_id.as_deref() == Some(id.as_str()) {
                    self.state.active_persona_id = self
                        .state
                        .personas
                        .iter()
                        .find(|row| row.id != id)
                        .map(|row| row.id.clone());
                }
                self.state.selected_persona_id = None;
                self.state.persona_tab = "cards".into();
                self.load_personas();
                self.state.status_message = Some("Persona deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn load_lorebooks(&mut self) {
        match self.call_decode(
            "lorebooks.list",
            &RequestListLorebooks { character_id: None },
            decode_result_list_lorebooks,
        ) {
            Ok(ResultListLorebooks { items }) => {
                self.state.lorebooks = items;
                if self.state.selected_lorebook_id.is_none() {
                    self.state.selected_lorebook_id =
                        self.state.lorebooks.first().map(|row| row.id.clone());
                }
                if let Some(id) = self.state.selected_lorebook_id.clone() {
                    self.seed_lorebook_draft(&id);
                }
                if self.state.lorebook_tab == "entries" {
                    self.load_lorebook_entries();
                }
            }
            Err(err) => self.record_error(err),
        }
    }

    /// Load `lorebooks.entries.list` for the selected lorebook (React
    /// `useLorebookEntries`; kernel returns the full list in one page).
    fn load_lorebook_entries(&mut self) {
        let Some(id) = self.state.selected_lorebook_id.clone() else {
            self.state.lorebook_entries.clear();
            return;
        };
        match self.call_decode(
            "lorebooks.entries.list",
            &RequestListLorebookEntries { lorebook_id: id },
            decode_result_list_lorebook_entries,
        ) {
            Ok(ResultListLorebookEntries { items }) => self.state.lorebook_entries = items,
            Err(err) => self.record_error(err),
        }
    }

    fn seed_lorebook_draft(&mut self, id: &str) {
        if let Some(row) = self.state.lorebooks.iter().find(|item| item.id == id) {
            self.state.lorebook_name_draft = row.name.clone();
            self.state.lorebook_description_draft = row.description.clone().unwrap_or_default();
        }
    }

    pub fn set_lorebook_name_draft(&mut self, draft: &str) {
        self.state.lorebook_name_draft = draft.to_string();
        self.bump_scene();
    }

    pub fn set_lorebook_description_draft(&mut self, draft: &str) {
        self.state.lorebook_description_draft = draft.to_string();
        self.bump_scene();
    }

    /// Save the book editor (React `BookTab` name-on-blur + debounced
    /// description autosave, collapsed into one explicit action): only the
    /// fields that actually changed cross the wire; an empty trimmed name
    /// keeps the stored one (React never persists empty names).
    pub fn save_lorebook_meta(&mut self) {
        let Some(id) = self.state.selected_lorebook_id.clone() else {
            return;
        };
        let Some(card) = self
            .state
            .lorebooks
            .iter()
            .find(|item| item.id == id)
            .map(|item| (item.name.clone(), item.description.clone()))
        else {
            return;
        };
        let (current_name, current_description) = card;
        let next_name = self.state.lorebook_name_draft.trim().to_string();
        let next_description = self.state.lorebook_description_draft.clone();
        let name_change = !next_name.is_empty() && next_name != current_name;
        let description_change = Some(next_description.clone()) != current_description
            && !(next_description.is_empty() && current_description.is_none());
        if !name_change && !description_change {
            self.state.status_message = Some("No changes.".into());
            self.bump_scene();
            return;
        }
        match self.call_decode(
            "lorebooks.update",
            &RequestUpdateLorebook {
                lorebook_id: id,
                name: if name_change { Some(next_name) } else { None },
                description: if description_change {
                    Some(next_description)
                } else {
                    None
                },
                entries: None,
                character_id: None,
            },
            decode_lorebook_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self
                    .state
                    .lorebooks
                    .iter_mut()
                    .find(|item| item.id == updated.id)
                {
                    row.name = updated.name;
                    row.description = updated.description.clone();
                }
                self.seed_lorebook_draft(&updated.id);
                self.state.status_message = Some("Book updated.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn select_lorebook(&mut self, id: &str) {
        self.state.selected_lorebook_id = Some(id.to_string());
        self.seed_lorebook_draft(id);
        self.state.lorebook_tab = "book".into();
        self.bump_scene();
    }

    pub fn set_lorebook_tab(&mut self, tab: &str) {
        self.state.lorebook_tab = tab.to_string();
        if tab == "entries" {
            self.load_lorebook_entries();
        }
        self.bump_scene();
    }

    /// Open the entry dialog for a NEW entry (React `EntryDialog` with
    /// `entry: null`); `enabled` defaults to true like the React form.
    pub fn open_entry_dialog(&mut self) {
        self.state.editing_lorebook_entry_id = None;
        self.state.entry_keys_draft.clear();
        self.state.entry_secondary_keys_draft.clear();
        self.state.entry_content_draft.clear();
        self.state.entry_enabled_draft = true;
        self.state.entry_constant_draft = false;
        self.state.entry_selective_draft = false;
        self.state.entry_dialog_open = true;
        self.bump_scene();
    }

    /// Open the entry dialog pre-filled with an existing entry's values.
    pub fn open_entry_dialog_for(&mut self, entry_id: &str) {
        let Some(entry) = self
            .state
            .lorebook_entries
            .iter()
            .find(|row| row.id == entry_id)
            .cloned()
        else {
            return;
        };
        self.state.editing_lorebook_entry_id = Some(entry.id);
        self.state.entry_keys_draft = entry.keys.join("\n");
        self.state.entry_secondary_keys_draft = entry.secondary_keys.unwrap_or_default().join("\n");
        self.state.entry_content_draft = entry.content;
        self.state.entry_enabled_draft = entry.enabled;
        self.state.entry_constant_draft = entry.constant;
        self.state.entry_selective_draft = entry.selective;
        self.state.entry_dialog_open = true;
        self.bump_scene();
    }

    pub fn close_entry_dialog(&mut self) {
        self.state.entry_dialog_open = false;
        self.state.editing_lorebook_entry_id = None;
        self.bump_scene();
    }

    /// Split newline-separated draft keys exactly like React `EntryDialog`
    /// (`splitKeys`: trim + drop empties).
    fn split_entry_keys(value: &str) -> Vec<String> {
        value
            .split('\n')
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// Save the entry dialog: create (`lorebooks.entries.create`) or update
    /// (`lorebooks.entries.update`) for the edited id. The wire DTO carries
    /// no position/metadata (kernel-owned), so the dialog honestly has no
    /// position field.
    pub fn save_entry(&mut self) {
        let Some(book_id) = self.state.selected_lorebook_id.clone() else {
            return;
        };
        let keys = Self::split_entry_keys(&self.state.entry_keys_draft);
        if keys.is_empty() {
            self.state.status_message = Some("Entry needs at least one key.".into());
            self.bump_scene();
            return;
        }
        let secondary_keys = Self::split_entry_keys(&self.state.entry_secondary_keys_draft);
        let content = self.state.entry_content_draft.trim().to_string();
        let enabled = self.state.entry_enabled_draft;
        let constant = self.state.entry_constant_draft;
        let selective = self.state.entry_selective_draft;
        if let Some(entry_id) = self.state.editing_lorebook_entry_id.clone() {
            let req = RequestUpdateLorebookEntry {
                lorebook_id: book_id,
                entry_id,
                patch: LorebookEntryPatch {
                    keys: Some(keys),
                    secondary_keys: Some(secondary_keys),
                    content: Some(content),
                    enabled: Some(enabled),
                    constant: Some(constant),
                    selective: Some(selective),
                },
            };
            match self.call_value("lorebooks.entries.update", &req) {
                Ok(_) => {
                    self.state.entry_dialog_open = false;
                    self.state.editing_lorebook_entry_id = None;
                    self.load_lorebook_entries();
                    self.state.status_message = Some("Entry updated.".into());
                }
                Err(err) => self.record_error(err),
            }
        } else {
            let req = RequestCreateLorebookEntry {
                lorebook_id: book_id,
                entry: LorebookEntryInput {
                    keys,
                    secondary_keys: Some(secondary_keys),
                    content,
                    enabled: Some(enabled),
                    constant: Some(constant),
                    selective: Some(selective),
                },
            };
            match self.call_decode("lorebooks.entries.create", &req, decode_lorebook_entry_dto) {
                Ok(_) => {
                    self.state.entry_dialog_open = false;
                    self.load_lorebook_entries();
                    self.state.status_message = Some("Entry added.".into());
                }
                Err(err) => self.record_error(err),
            }
        }
        self.bump_scene();
    }

    /// Entry-row switch toggle (React `EntryRow` `Switch`): flips `enabled`
    /// through `lorebooks.entries.update`.
    pub fn toggle_lorebook_entry(&mut self, entry_id: &str) {
        let Some(book_id) = self.state.selected_lorebook_id.clone() else {
            return;
        };
        let Some(enabled) = self
            .state
            .lorebook_entries
            .iter()
            .find(|row| row.id == entry_id)
            .map(|row| !row.enabled)
        else {
            return;
        };
        let req = RequestUpdateLorebookEntry {
            lorebook_id: book_id,
            entry_id: entry_id.to_string(),
            patch: LorebookEntryPatch {
                keys: None,
                secondary_keys: None,
                content: None,
                enabled: Some(enabled),
                constant: None,
                selective: None,
            },
        };
        match self.call_value("lorebooks.entries.update", &req) {
            Ok(_) => self.load_lorebook_entries(),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn confirm_delete_entry(&mut self) {
        let Some(book_id) = self.state.selected_lorebook_id.clone() else {
            self.state.entry_delete_open = false;
            return;
        };
        let Some(entry_id) = self.state.entry_delete_target_id.clone() else {
            self.state.entry_delete_open = false;
            return;
        };
        match self.call_value(
            "lorebooks.entries.delete",
            &RequestDeleteLorebookEntry {
                lorebook_id: book_id,
                entry_id,
            },
        ) {
            Ok(_) => {
                self.state.entry_delete_open = false;
                self.state.entry_delete_target_id = None;
                self.load_lorebook_entries();
                self.state.status_message = Some("Entry deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_entry_keys_draft(&mut self, value: &str) {
        self.state.entry_keys_draft = value.to_string();
        self.bump_scene();
    }

    pub fn set_entry_secondary_keys_draft(&mut self, value: &str) {
        self.state.entry_secondary_keys_draft = value.to_string();
        self.bump_scene();
    }

    pub fn set_entry_content_draft(&mut self, value: &str) {
        self.state.entry_content_draft = value.to_string();
        self.bump_scene();
    }

    fn confirm_create_lorebook(&mut self) {
        let name = self.state.create_name.trim();
        let name = if name.is_empty() {
            "New lorebook"
        } else {
            name
        };
        let req = RequestCreateLorebook {
            name: name.to_string(),
            description: None,
            entries: None,
            character_id: None,
        };
        match self.call_decode("lorebooks.create", &req, decode_lorebook_dto) {
            Ok(created) => {
                self.state.create_dialog_open = false;
                self.state.create_name.clear();
                self.state.selected_lorebook_id = Some(created.id);
                self.state.lorebook_tab = "book".into();
                self.load_lorebooks();
                self.state.status_message = Some("Lorebook created.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn confirm_delete_lorebook(&mut self) {
        let Some(id) = self.state.selected_lorebook_id.clone() else {
            self.state.delete_dialog_open = false;
            return;
        };
        match self.call_value(
            "lorebooks.delete",
            &RequestDeleteLorebook { lorebook_id: id },
        ) {
            Ok(_) => {
                self.state.delete_dialog_open = false;
                self.state.selected_lorebook_id = None;
                self.state.lorebook_tab = "books".into();
                self.load_lorebooks();
                self.state.status_message = Some("Lorebook deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn load_plugins(&mut self) {
        match self.call_decode("plugins.list", &RequestEmpty {}, decode_result_plugins_list) {
            Ok(ResultPluginsList { items }) => self.state.plugins = items,
            Err(err) => self.record_error(err),
        }
    }

    fn load_ai_settings(&mut self) {
        match self.call_decode(
            "providers.list",
            &RequestEmpty {},
            decode_result_list_providers,
        ) {
            Ok(ResultListProviders { items }) => {
                self.state.providers = items
                    .into_iter()
                    .map(|row| ProviderCardView {
                        id: row.id,
                        name: row.name,
                        availability: match row.availability {
                            contracts_generated::generated::ProviderAvailability::Available => {
                                "available".into()
                            }
                            contracts_generated::generated::ProviderAvailability::Degraded {
                                ..
                            } => "degraded".into(),
                            contracts_generated::generated::ProviderAvailability::Unavailable {
                                ..
                            } => "unavailable".into(),
                        },
                    })
                    .collect();
            }
            Err(err) => self.record_error(err),
        }
        match self.call_decode(
            "presets.list",
            &RequestListPresets {
                kind: Some("generation".into()),
            },
            decode_result_list_presets,
        ) {
            Ok(ResultListPresets { items }) => self.state.presets = items,
            Err(err) => self.record_error(err),
        }
    }

    /// Live sampler rows for the Config tab from the generation draft
    /// (React `GenerationPresetEditor` RangeField / Switch). Range sliders
    /// stay on React; native uses compact numeric fields.
    fn preset_value_rows(&self) -> Vec<PresetValueRow> {
        let defaults = self.parsed_preset_defaults();
        let focused = self.state.preset_edit_key.as_deref();
        let display = |id: &str, formatted: String| {
            if focused == Some(id) {
                self.state.preset_edit_text.clone()
            } else {
                formatted
            }
        };
        vec![
            PresetValueRow {
                id: "maxContextTokens".into(),
                label: "Context size (tokens)".into(),
                value: display(
                    "maxContextTokens",
                    self.state.preset_draft_max_context.to_string(),
                ),
                kind: "number".into(),
                focused: focused == Some("maxContextTokens"),
            },
            PresetValueRow {
                id: "maxTokens".into(),
                label: "Max tokens".into(),
                value: display(
                    "maxTokens",
                    format_sampler_number(defaults.max_tokens, true),
                ),
                kind: "number".into(),
                focused: focused == Some("maxTokens"),
            },
            PresetValueRow {
                id: "temperature".into(),
                label: "Temperature".into(),
                value: display(
                    "temperature",
                    format_sampler_number(defaults.temperature, false),
                ),
                kind: "number".into(),
                focused: focused == Some("temperature"),
            },
            PresetValueRow {
                id: "topP".into(),
                label: "Top P".into(),
                value: display("topP", format_sampler_number(defaults.top_p, false)),
                kind: "number".into(),
                focused: focused == Some("topP"),
            },
            PresetValueRow {
                id: "topK".into(),
                label: "Top K".into(),
                value: display("topK", format_sampler_number(defaults.top_k, true)),
                kind: "number".into(),
                focused: focused == Some("topK"),
            },
            PresetValueRow {
                id: "minP".into(),
                label: "Min P".into(),
                value: display("minP", format_sampler_number(defaults.min_p, false)),
                kind: "number".into(),
                focused: focused == Some("minP"),
            },
            PresetValueRow {
                id: "topA".into(),
                label: "Top A".into(),
                value: display("topA", format_sampler_number(defaults.top_a, false)),
                kind: "number".into(),
                focused: focused == Some("topA"),
            },
            PresetValueRow {
                id: "repetitionPenalty".into(),
                label: "Repetition penalty".into(),
                value: display(
                    "repetitionPenalty",
                    format_sampler_number(defaults.repetition_penalty, false),
                ),
                kind: "number".into(),
                focused: focused == Some("repetitionPenalty"),
            },
            PresetValueRow {
                id: "frequencyPenalty".into(),
                label: "Frequency penalty".into(),
                value: display(
                    "frequencyPenalty",
                    format_sampler_number(defaults.frequency_penalty, false),
                ),
                kind: "number".into(),
                focused: focused == Some("frequencyPenalty"),
            },
            PresetValueRow {
                id: "presencePenalty".into(),
                label: "Presence penalty".into(),
                value: display(
                    "presencePenalty",
                    format_sampler_number(defaults.presence_penalty, false),
                ),
                kind: "number".into(),
                focused: focused == Some("presencePenalty"),
            },
            PresetValueRow {
                id: "seed".into(),
                label: "Seed".into(),
                value: display("seed", format_sampler_number(defaults.seed, true)),
                kind: "number".into(),
                focused: focused == Some("seed"),
            },
            PresetValueRow {
                id: "reasoning".into(),
                label: "Request model reasoning".into(),
                value: defaults.reasoning.to_string(),
                kind: "toggle".into(),
                focused: false,
            },
            PresetValueRow {
                id: "stream".into(),
                label: "Streaming".into(),
                value: defaults.stream.to_string(),
                kind: "toggle".into(),
                focused: false,
            },
        ]
    }

    fn parsed_preset_defaults(&self) -> PresetGenerationDefaults {
        merge_preset_defaults(&self.state.preset_draft_defaults)
    }

    fn load_settings(&mut self) {
        match self.call_decode(
            "settings.get",
            &RequestSettingsGet { keys: None },
            decode_result_settings,
        ) {
            Ok(ResultSettings { items }) => {
                if let Some(language) = settings_string(&items, "language") {
                    self.state.language = language;
                    self.state.dir = match self.state.language.as_str() {
                        "ar" | "he" | "fa" | "ur" => "rtl".into(),
                        _ => "ltr".into(),
                    };
                }
                if let Some(id) = settings_string(&items, "active-persona-id") {
                    self.state.active_persona_id = Some(id);
                }
                self.state.macro_variables = settings_macro_variables(&items);
                self.hydrate_instruct_settings(&items);
                self.hydrate_generation_settings(&items);
            }
            Err(err) => self.record_error(err),
        }
    }

    fn hydrate_instruct_settings(&mut self, items: &[SettingsItem]) {
        if let Some(value) = settings_unwrapped(items, "prompt-template") {
            if value.is_object() {
                self.state.prompt_template = value.clone();
            }
        }
        if let Some(value) = settings_unwrapped(items, "active-prompt-template-preset-id") {
            if value.is_null() {
                self.state.active_prompt_preset_id = None;
            } else if let Some(id) = value.as_str() {
                if !id.is_empty() {
                    self.state.active_prompt_preset_id = Some(id.to_string());
                }
            }
        }
        if let Some(value) = settings_unwrapped(items, "instruct-format") {
            if value.is_null() {
                self.state.instruct_format = None;
            } else if value.is_object() {
                self.state.instruct_format = Some(value.clone());
                self.state.instruct_selection = "custom".into();
                return;
            }
        }
        // Kernel plane has no instruct-format catalog, so a stored catalog id
        // is treated as native (React would still list only native + custom).
        self.state.instruct_selection = "native".into();
        self.state.instruct_format_id = settings_string(items, "instruct-format-id");
    }

    fn hydrate_generation_settings(&mut self, items: &[SettingsItem]) {
        if self.state.preset_draft_dirty {
            return;
        }
        let fallback = PresetGenerationData::default();
        let tokens = settings_unwrapped(items, "maxContextTokens")
            .and_then(Value::as_i64)
            .unwrap_or(fallback.max_context_tokens);
        let defaults = settings_unwrapped(items, "generationDefaults")
            .map(merge_preset_defaults_value)
            .unwrap_or_else(|| {
                serde_json::to_value(&fallback.generation_defaults).unwrap_or_else(|_| json!({}))
            });
        self.state.preset_draft_max_context = tokens;
        self.state.preset_draft_defaults = defaults;
        self.state.preset_unlocked_context = tokens > CONTEXT_TOKEN_DEFAULT_MAX;
        self.clear_preset_value_edit();
        if let Some(value) = settings_unwrapped(items, "activeGenerationPresetId") {
            if value.is_null() {
                self.state.active_preset_id = None;
            } else if let Some(id) = value.as_str() {
                if !id.is_empty() {
                    self.state.active_preset_id = Some(id.to_string());
                }
            }
        }
    }

    /// React `GeneralTab.changeLanguage`: Zustand + `settings.update` language.
    pub fn cycle_language(&mut self) {
        let next = next_choice(LANGUAGES, &self.state.language);
        self.state.language = next.to_string();
        self.state.dir = match next {
            "ar" | "he" | "fa" | "ur" => "rtl".into(),
            _ => "ltr".into(),
        };
        let req = RequestSettingsUpdate {
            settings: vec![RequestSettingsUpdateSettings {
                key: "language".into(),
                value: json!({ "value": next }),
            }],
        };
        if let Err(err) = self.call_value("settings.update", &req) {
            self.record_error(err);
        }
        self.bump_scene();
    }

    /// React `AdvancedPromptSettings.changeMode`. Switching to text seeds the
    /// default block list (`DEFAULT_PROMPT_TEMPLATE`) when none is stored.
    pub fn cycle_prompt_mode(&mut self) {
        let current = self
            .state
            .prompt_template
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("chat");
        let next = if current == "text" { "chat" } else { "text" };
        if let Some(obj) = self.state.prompt_template.as_object_mut() {
            obj.insert("mode".into(), json!(next));
        } else {
            self.state.prompt_template = json!({ "mode": next });
        }
        if next == "text" {
            self.ensure_prompt_template_blocks();
            self.load_prompt_presets_list();
        }
        self.persist_prompt_template();
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.addPrompt`. Inserts a `custom-*` block
    /// before the terminal anchors, persists immediately, and opens the
    /// compact name/content editor.
    fn add_prompt_block(&mut self) {
        self.ensure_prompt_template_blocks();
        let existing = self
            .state
            .prompt_template
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let id = next_custom_prompt_id(&existing);
        let new_block = json!({
            "id": id,
            "enabled": true,
            "name": "New Prompt",
            "role": "system",
            "content": "",
            "injectionPosition": "relative",
            "injectionDepth": 4,
            "injectionOrder": 100,
            "triggers": PROMPT_TRIGGER_IDS,
            "forbidOverrides": false,
        });
        let Some(blocks) = self
            .state
            .prompt_template
            .get_mut("blocks")
            .and_then(Value::as_array_mut)
        else {
            return;
        };
        blocks.push(new_block);
        let ordered = normalize_prompt_block_order(std::mem::take(blocks));
        *blocks = ordered;
        self.state.prompt_block_edit_id = Some(id);
        self.state.prompt_block_name_draft = "New Prompt".into();
        self.state.prompt_block_content_draft.clear();
        self.state.prompt_block_injection_position = "relative".into();
        self.state.prompt_block_depth_draft = "4".into();
        self.state.prompt_block_order_draft = "100".into();
        self.state.prompt_block_role = "system".into();
        self.state.prompt_block_triggers = default_prompt_block_triggers();
        self.state.prompt_block_forbid_overrides = false;
        self.state.prompt_block_model_draft.clear();
        self.persist_prompt_template();
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.removePrompt`. Core (host-owned) ids are
    /// a no-op; unknown custom ids also do not persist.
    fn remove_prompt_block(&mut self, block_id: &str) {
        if PROMPT_BLOCK_IDS.contains(&block_id) {
            return;
        }
        self.ensure_prompt_template_blocks();
        let Some(blocks) = self
            .state
            .prompt_template
            .get_mut("blocks")
            .and_then(Value::as_array_mut)
        else {
            return;
        };
        let before = blocks.len();
        blocks.retain(|block| block.get("id").and_then(Value::as_str) != Some(block_id));
        if blocks.len() == before {
            return;
        }
        let close_editor = self.state.prompt_block_edit_id.as_deref() == Some(block_id);
        if close_editor {
            self.clear_prompt_block_editor_drafts();
        }
        self.persist_prompt_template();
        self.bump_scene();
    }

    /// React `setEditingBlockId` — compact name + content drafts. Unknown
    /// ids are a no-op.
    fn edit_prompt_block(&mut self, block_id: &str) {
        self.ensure_prompt_template_blocks();
        let post_history = self
            .state
            .prompt_template
            .get("postHistoryInstructions")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some(block) = self
            .state
            .prompt_template
            .get("blocks")
            .and_then(Value::as_array)
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
            })
        else {
            return;
        };
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| prompt_block_label(block_id));
        let content = if block_id == "post-history-instructions" {
            post_history
        } else {
            block
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        self.state.prompt_block_edit_id = Some(block_id.to_string());
        self.state.prompt_block_name_draft = name;
        self.state.prompt_block_content_draft = content;
        self.state.prompt_block_injection_position =
            prompt_block_injection_position(block).to_string();
        self.state.prompt_block_depth_draft =
            prompt_block_u32(block, "injectionDepth", 4).to_string();
        self.state.prompt_block_order_draft =
            prompt_block_u32(block, "injectionOrder", 100).to_string();
        self.state.prompt_block_role = prompt_block_role(block).to_string();
        self.state.prompt_block_triggers = prompt_block_triggers(block);
        self.state.prompt_block_forbid_overrides = prompt_block_forbid_overrides(block);
        self.state.prompt_block_model_draft = prompt_block_model(block);
        self.bump_scene();
    }

    fn close_prompt_block_editor(&mut self) {
        self.clear_prompt_block_editor_drafts();
        self.bump_scene();
    }

    fn clear_prompt_block_editor_drafts(&mut self) {
        self.state.prompt_block_edit_id = None;
        self.state.prompt_block_name_draft.clear();
        self.state.prompt_block_content_draft.clear();
        self.state.prompt_block_injection_position.clear();
        self.state.prompt_block_depth_draft.clear();
        self.state.prompt_block_order_draft.clear();
        self.state.prompt_block_role.clear();
        self.state.prompt_block_triggers.clear();
        self.state.prompt_block_forbid_overrides = false;
        self.state.prompt_block_model_draft.clear();
    }

    /// React `injectionPosition` select. Local draft until Save.
    fn cycle_prompt_block_position(&mut self) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        self.state.prompt_block_injection_position =
            if self.state.prompt_block_injection_position == "in-chat" {
                "relative".into()
            } else {
                "in-chat".into()
            };
        self.bump_scene();
    }

    /// React `role` select. Local draft until Save. Unknown stored roles
    /// (`tool` / `plugin`) snap to `system`, matching the authoring menu.
    fn cycle_prompt_block_role(&mut self) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        self.state.prompt_block_role =
            next_choice(PROMPT_BLOCK_ROLES, &self.state.prompt_block_role).to_string();
        self.bump_scene();
    }

    /// React `toggleTrigger`. Local draft until Save. Unknown ids are a
    /// no-op; clearing the last selected chip restores every kind.
    fn toggle_prompt_block_trigger(&mut self, trigger: &str) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        if !PROMPT_TRIGGER_IDS.contains(&trigger) {
            return;
        }
        let mut next = self.state.prompt_block_triggers.clone();
        if next.iter().any(|id| id == trigger) {
            next.retain(|id| id != trigger);
        } else {
            next.push(trigger.to_string());
        }
        if next.is_empty() {
            next = default_prompt_block_triggers();
        }
        self.state.prompt_block_triggers = next;
        self.bump_scene();
    }

    /// React `forbidOverrides` Switch. Local draft until Save. Hidden
    /// unless content is editable and role is `system`.
    fn toggle_prompt_block_forbid_overrides(&mut self) {
        let Some(id) = self.state.prompt_block_edit_id.clone() else {
            return;
        };
        if !prompt_block_content_editable(&id) {
            return;
        }
        if prompt_block_role_draft(&self.state.prompt_block_role) != "system" {
            return;
        }
        self.state.prompt_block_forbid_overrides = !self.state.prompt_block_forbid_overrides;
        self.bump_scene();
    }

    /// React `ModelMenu.onLoadModels`. Kernel plane has no wire discovery.
    fn load_prompt_block_models(&mut self) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        if self.state.active_provider_id.is_none() {
            return;
        }
        self.record_error(ChatRouteError::Product(ErrorDto {
            code: "CAPABILITY_UNAVAILABLE".into(),
            params: json!({ "operationId": "providers.models.discovery" }),
            trace_id: None,
            correlation_id: None,
        }));
        self.bump_scene();
    }

    /// React `PromptBlockEditorDialog` submit: name is required; content is
    /// written only for custom / main-prompt / post-history-instructions.
    fn save_prompt_block_editor(&mut self) {
        let Some(id) = self.state.prompt_block_edit_id.clone() else {
            return;
        };
        let name = self.state.prompt_block_name_draft.trim().to_string();
        if name.is_empty() {
            return;
        }
        let content = self.state.prompt_block_content_draft.clone();
        let editable = prompt_block_content_editable(&id);
        let position = if self.state.prompt_block_injection_position == "in-chat" {
            "in-chat"
        } else {
            "relative"
        };
        let depth = parse_prompt_injection_u32(&self.state.prompt_block_depth_draft, 4);
        let order = parse_prompt_injection_u32(&self.state.prompt_block_order_draft, 100);
        let role = prompt_block_role_draft(&self.state.prompt_block_role);
        let triggers = self
            .state
            .prompt_block_triggers
            .iter()
            .filter(|id| PROMPT_TRIGGER_IDS.contains(&id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        let forbid_overrides = self.state.prompt_block_forbid_overrides;
        let model = clamp_prompt_block_model(self.state.prompt_block_model_draft.trim());
        {
            let Some(block) = self
                .state
                .prompt_template
                .get_mut("blocks")
                .and_then(Value::as_array_mut)
                .and_then(|blocks| {
                    blocks
                        .iter_mut()
                        .find(|block| block.get("id").and_then(Value::as_str) == Some(id.as_str()))
                })
            else {
                return;
            };
            let Some(obj) = block.as_object_mut() else {
                return;
            };
            obj.insert("name".into(), json!(name));
            if editable {
                obj.insert("content".into(), json!(content));
            }
            obj.insert("injectionPosition".into(), json!(position));
            obj.insert("injectionDepth".into(), json!(depth));
            obj.insert("injectionOrder".into(), json!(order));
            obj.insert("role".into(), json!(role));
            obj.insert("triggers".into(), json!(triggers));
            obj.insert("forbidOverrides".into(), json!(forbid_overrides));
            if model.is_empty() {
                obj.remove("model");
            } else {
                obj.insert("model".into(), json!(model));
            }
        }
        if id == "post-history-instructions" {
            if let Some(obj) = self.state.prompt_template.as_object_mut() {
                obj.insert("postHistoryInstructions".into(), json!(content));
            }
        }
        self.clear_prompt_block_editor_drafts();
        self.persist_prompt_template();
        self.bump_scene();
    }

    pub fn set_prompt_block_name_draft(&mut self, value: &str) {
        self.state.prompt_block_name_draft = value.to_string();
        self.bump_scene();
    }

    pub fn set_prompt_block_content_draft(&mut self, value: &str) {
        self.state.prompt_block_content_draft = value.to_string();
        self.bump_scene();
    }

    pub fn set_prompt_block_depth_draft(&mut self, value: &str) {
        self.state.prompt_block_depth_draft = sanitize_prompt_int_draft(value);
        self.bump_scene();
    }

    pub fn set_prompt_block_order_draft(&mut self, value: &str) {
        self.state.prompt_block_order_draft = sanitize_prompt_int_draft(value);
        self.bump_scene();
    }

    /// React `ModelMenu` free-text id. Disabled without an active provider.
    /// Contract maxLength 256.
    pub fn set_prompt_block_model_draft(&mut self, value: &str) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        if self.state.active_provider_id.is_none() {
            return;
        }
        self.state.prompt_block_model_draft = clamp_prompt_block_model(value);
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.moveBlock(from, from ± 1)`. Terminals,
    /// index 0 going up, and a movable whose next neighbour is a terminal
    /// going down are no-ops (no persist).
    fn move_prompt_block(&mut self, block_id: &str, delta: isize) {
        self.ensure_prompt_template_blocks();
        let Some(blocks) = self
            .state
            .prompt_template
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
        else {
            return;
        };
        let Some(from) = blocks
            .iter()
            .position(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
        else {
            return;
        };
        if is_terminal_prompt_block_id(block_id) {
            return;
        }
        if delta < 0 && from == 0 {
            return;
        }
        let to = from as isize + delta;
        if to < 0 || to >= blocks.len() as isize {
            return;
        }
        let to = to as usize;
        if delta > 0 {
            if let Some(next_id) = blocks
                .get(to)
                .and_then(|block| block.get("id").and_then(Value::as_str))
            {
                if is_terminal_prompt_block_id(next_id) {
                    return;
                }
            }
        }
        let reordered = reorder_prompt_blocks(blocks, from, to);
        let Some(actual) = reordered
            .iter()
            .position(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
        else {
            return;
        };
        if actual == from {
            return;
        }
        let name = reordered
            .get(actual)
            .and_then(|block| block.get("name").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| prompt_block_label(block_id));
        let Some(slots) = self
            .state
            .prompt_template
            .get_mut("blocks")
            .and_then(Value::as_array_mut)
        else {
            return;
        };
        *slots = reordered;
        self.state.status_message = Some(format!("{name} moved to position {}.", actual + 1));
        self.persist_prompt_template();
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.toggleBlock`. Unknown ids are a no-op.
    fn toggle_prompt_block(&mut self, block_id: &str) {
        self.ensure_prompt_template_blocks();
        {
            let Some(blocks) = self
                .state
                .prompt_template
                .get_mut("blocks")
                .and_then(Value::as_array_mut)
            else {
                return;
            };
            let Some(block) = blocks
                .iter_mut()
                .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
            else {
                return;
            };
            let enabled = block
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let Some(obj) = block.as_object_mut() else {
                return;
            };
            obj.insert("enabled".into(), json!(!enabled));
        }
        self.persist_prompt_template();
        self.bump_scene();
    }

    fn ensure_prompt_template_blocks(&mut self) {
        let has_blocks = self
            .state
            .prompt_template
            .get("blocks")
            .and_then(Value::as_array)
            .is_some_and(|blocks| !blocks.is_empty());
        if has_blocks {
            return;
        }
        let mode = self
            .state
            .prompt_template
            .get("mode")
            .cloned()
            .unwrap_or_else(|| json!("chat"));
        let mut template = default_prompt_template();
        if let Some(obj) = template.as_object_mut() {
            obj.insert("mode".into(), mode);
        }
        self.state.prompt_template = template;
    }

    fn persist_prompt_template(&mut self) {
        let req = RequestSettingsUpdate {
            settings: vec![RequestSettingsUpdateSettings {
                key: "prompt-template".into(),
                value: self.state.prompt_template.clone(),
            }],
        };
        if let Err(err) = self.call_value("settings.update", &req) {
            self.record_error(err);
            self.state.instruct_form_error = Some(
                self.state
                    .last_error
                    .as_ref()
                    .map(|e| e.code.clone())
                    .unwrap_or_else(|| "SETTINGS_UPDATE_FAILED".into()),
            );
        } else {
            self.state.instruct_form_error = None;
        }
    }

    fn load_prompt_presets_list(&mut self) {
        match self.call_decode(
            "presets.list",
            &RequestListPresets {
                kind: Some("prompt-template".into()),
            },
            decode_result_list_presets,
        ) {
            Ok(ResultListPresets { items }) => self.state.prompt_presets = items,
            Err(err) => self.record_error(err),
        }
    }

    fn active_prompt_preset(&self) -> Option<&PresetDto> {
        let id = self.state.active_prompt_preset_id.as_deref()?;
        self.state.prompt_presets.iter().find(|item| item.id == id)
    }

    fn persist_prompt_template_and_active(&mut self, active_id: Option<String>) {
        self.state.active_prompt_preset_id = active_id.clone();
        let req = RequestSettingsUpdate {
            settings: vec![
                RequestSettingsUpdateSettings {
                    key: "prompt-template".into(),
                    value: self.state.prompt_template.clone(),
                },
                RequestSettingsUpdateSettings {
                    key: "active-prompt-template-preset-id".into(),
                    value: json!({ "value": active_id }),
                },
            ],
        };
        if let Err(err) = self.call_value("settings.update", &req) {
            self.record_error(err);
            self.state.instruct_form_error = Some(
                self.state
                    .last_error
                    .as_ref()
                    .map(|e| e.code.clone())
                    .unwrap_or_else(|| "SETTINGS_UPDATE_FAILED".into()),
            );
        } else {
            self.state.instruct_form_error = None;
        }
    }

    /// React `PromptTemplateEditor.selectPreset` (native cycle through
    /// Unsaved → each `presets.list` row).
    fn cycle_prompt_preset(&mut self) {
        self.ensure_prompt_template_blocks();
        let mut ids: Vec<Option<String>> = vec![None];
        ids.extend(
            self.state
                .prompt_presets
                .iter()
                .map(|item| Some(item.id.clone())),
        );
        if ids.len() == 1 {
            return;
        }
        let current = self.state.active_prompt_preset_id.clone();
        let idx = ids.iter().position(|id| *id == current).unwrap_or(0);
        let next = ids[(idx + 1) % ids.len()].clone();
        match next {
            None => self.persist_prompt_template_and_active(None),
            Some(id) => self.apply_prompt_preset(&id),
        }
        self.bump_scene();
    }

    fn apply_prompt_preset(&mut self, preset_id: &str) {
        let Some(preset) = self
            .state
            .prompt_presets
            .iter()
            .find(|item| item.id == preset_id)
            .cloned()
        else {
            self.record_error(ChatRouteError::Product(ErrorDto {
                code: "PRESET_NOT_FOUND".into(),
                params: json!({ "presetId": preset_id }),
                trace_id: None,
                correlation_id: None,
            }));
            return;
        };
        if !prompt_template_is_complete(&preset.data) {
            self.state.instruct_form_error = Some(INVALID_PROMPT_TEMPLATE_PRESET.to_string());
            return;
        }
        let mut next = preset.data.clone();
        if let Some(obj) = next.as_object_mut() {
            obj.insert("mode".into(), json!("text"));
        }
        self.state.prompt_template = next;
        self.persist_prompt_template_and_active(Some(preset.id));
    }

    /// React `PromptTemplateEditor.savePreset`: update the active record, or
    /// open the name dialog to create one.
    fn save_prompt_preset(&mut self) {
        self.ensure_prompt_template_blocks();
        let Some(active) = self.active_prompt_preset().cloned() else {
            self.begin_preset_dialog("prompt-template", "create", String::new());
            return;
        };
        let req = RequestUpdatePreset {
            preset_id: active.id.clone(),
            name: None,
            data: Some(self.state.prompt_template.clone()),
        };
        match self.call_decode("presets.update", &req, decode_preset_dto) {
            Ok(_) => {
                self.persist_prompt_template_and_active(Some(active.id));
                self.load_prompt_presets_list();
                self.state.status_message = Some("Preset saved.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.exportPreset`: host-owned JSON envelope
    /// (no wire op). Parks in `last_export` for the desktop file sink.
    fn export_prompt_template(&mut self) {
        self.ensure_prompt_template_blocks();
        let name = self
            .active_prompt_preset()
            .map(|item| item.name.as_str())
            .unwrap_or("prompt");
        let filename = json_export_filename(
            self.active_prompt_preset()
                .map(|item| item.name.as_str())
                .unwrap_or("prompt-template"),
            "prompt-template",
        );
        let payload = json!({
            "version": 1,
            "kind": "prompt-template",
            "name": name,
            "data": self.state.prompt_template.clone(),
        });
        match serde_json::to_vec_pretty(&payload) {
            Ok(bytes) => {
                self.state.last_export = Some(LastExport {
                    filename: filename.clone(),
                    bytes,
                });
                self.state.status_message = Some(format!("Export ready: {filename}."));
                self.state.instruct_form_error = None;
            }
            Err(_) => {
                self.state.instruct_form_error = Some(INVALID_PROMPT_TEMPLATE_PRESET.to_string());
            }
        }
        self.bump_scene();
    }

    fn open_prompt_template_import(&mut self) {
        if self.state.prompt_template_import_open {
            return;
        }
        self.state.card_import_dialog_open = false;
        self.state.generation_preset_import_open = false;
        self.state.prompt_template_path_draft.clear();
        self.state.prompt_template_import_open = true;
        self.bump_scene();
    }

    fn close_prompt_template_import(&mut self) {
        self.state.prompt_template_import_open = false;
        self.state.prompt_template_path_draft.clear();
        self.bump_scene();
    }

    pub fn set_prompt_template_path_draft(&mut self, draft: &str) {
        if self.state.prompt_template_import_open {
            self.state.prompt_template_path_draft = draft.to_string();
            self.bump_scene();
        }
    }

    /// React `PromptTemplateEditor.importPreset`: read JSON from a host path,
    /// validate the 12 host-owned ids, then `presets.create` +
    /// `settings.update` (`prompt-template` + active id).
    fn confirm_prompt_template_import(&mut self) {
        let path = self.state.prompt_template_path_draft.trim().to_string();
        if path.is_empty() {
            self.state.status_message =
                Some("Provide a prompt template JSON file from this device.".into());
            self.bump_scene();
            return;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => {
                self.state.status_message = Some(format!("Cannot read {path}: {err}"));
                self.bump_scene();
                return;
            }
        };
        let fallback_name = std::path::Path::new(&path)
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "prompt-template".into());
        let Some((name, next)) = parse_prompt_template_import(&bytes, &fallback_name) else {
            self.state.instruct_form_error = Some(INVALID_PROMPT_TEMPLATE_PRESET.to_string());
            self.bump_scene();
            return;
        };
        let req = RequestCreatePreset {
            kind: "prompt-template".into(),
            name: name.clone(),
            data: Some(next.clone()),
        };
        match self.call_decode("presets.create", &req, decode_preset_dto) {
            Ok(dto) => {
                self.state.prompt_template = next;
                self.persist_prompt_template_and_active(Some(dto.id));
                self.load_prompt_presets_list();
                self.close_prompt_template_import();
                self.state.instruct_form_error = None;
                self.state.status_message = Some(format!("Imported {name}."));
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.instruct_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    fn open_prompt_preset_rename(&mut self) {
        let Some(name) = self.active_prompt_preset().map(|item| item.name.clone()) else {
            return;
        };
        self.begin_preset_dialog("prompt-template", "rename", name);
    }

    fn open_prompt_preset_duplicate(&mut self) {
        self.ensure_prompt_template_blocks();
        let base = self
            .active_prompt_preset()
            .map(|item| item.name.as_str())
            .unwrap_or("Prompt template preset");
        self.begin_preset_dialog("prompt-template", "duplicate", format!("{base} copy"));
    }

    fn open_prompt_preset_delete(&mut self) {
        if self.active_prompt_preset().is_none() {
            return;
        }
        self.state.preset_dialog_kind = "prompt-template".into();
        self.state.preset_delete_open = true;
        self.bump_scene();
    }

    fn begin_preset_dialog(&mut self, kind: &str, mode: &str, draft: String) {
        self.state.preset_dialog_kind = kind.to_string();
        self.state.preset_name_dialog_open = true;
        self.state.preset_name_mode = Some(mode.to_string());
        self.state.preset_name_draft = draft;
        self.state.preset_form_error = None;
        self.bump_scene();
    }

    fn confirm_prompt_preset_name(&mut self, name: String, mode: &str) {
        let outcome = if mode == "rename" {
            match self.active_prompt_preset().cloned() {
                Some(active) => {
                    let req = RequestUpdatePreset {
                        preset_id: active.id,
                        name: Some(name),
                        data: None,
                    };
                    self.call_decode("presets.update", &req, decode_preset_dto)
                        .map(|_| ())
                }
                None => Ok(()),
            }
        } else {
            self.ensure_prompt_template_blocks();
            let req = RequestCreatePreset {
                kind: "prompt-template".into(),
                name,
                data: Some(self.state.prompt_template.clone()),
            };
            self.call_decode("presets.create", &req, decode_preset_dto)
                .map(|dto| {
                    self.persist_prompt_template_and_active(Some(dto.id));
                })
        };
        match outcome {
            Ok(_) => {
                self.close_preset_name();
                self.load_prompt_presets_list();
                self.state.status_message = Some(if mode == "rename" {
                    "Preset renamed.".into()
                } else if mode == "duplicate" {
                    "Preset duplicated.".into()
                } else {
                    "Preset created.".into()
                });
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.preset_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    fn confirm_prompt_preset_delete(&mut self) {
        let Some(active) = self.active_prompt_preset().cloned() else {
            return;
        };
        self.state.preset_delete_open = false;
        let req = RequestDeletePreset {
            preset_id: active.id,
        };
        match self.call_value("presets.delete", &req) {
            Ok(_) => {
                self.state.active_prompt_preset_id = None;
                let clear = RequestSettingsUpdate {
                    settings: vec![RequestSettingsUpdateSettings {
                        key: "active-prompt-template-preset-id".into(),
                        value: json!({ "value": null }),
                    }],
                };
                if let Err(err) = self.call_value("settings.update", &clear) {
                    self.record_error(err);
                }
                self.state.status_message = Some("Preset deleted.".into());
                self.load_prompt_presets_list();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// React `ChatTemplateEditor.changeSelection`. Custom is local until save;
    /// native writes `instruct-format` / `instruct-format-id` null.
    pub fn cycle_instruct_selection(&mut self) {
        if self.state.instruct_selection == "custom" {
            self.apply_instruct_native();
            return;
        }
        self.state.instruct_selection = "custom".into();
        if self.state.instruct_format.is_none() {
            self.state.instruct_format = Some(default_custom_instruct());
        }
        self.state.instruct_form_error = None;
        self.bump_scene();
    }

    fn apply_instruct_native(&mut self) {
        let req = RequestSettingsUpdate {
            settings: vec![
                RequestSettingsUpdateSettings {
                    key: "instruct-format".into(),
                    value: json!({ "value": Value::Null }),
                },
                RequestSettingsUpdateSettings {
                    key: "instruct-format-id".into(),
                    value: json!({ "value": Value::Null }),
                },
            ],
        };
        match self.call_value("settings.update", &req) {
            Ok(_) => {
                self.state.instruct_selection = "native".into();
                self.state.instruct_format = None;
                self.state.instruct_format_id = None;
                self.state.instruct_form_error = None;
            }
            Err(err) => {
                self.state.instruct_form_error = Some(err.reason_code());
                self.record_error(err);
            }
        }
        self.bump_scene();
    }

    /// React `ChatTemplateEditor.save`.
    pub fn save_instruct_template(&mut self) {
        let draft = self
            .state
            .instruct_format
            .clone()
            .unwrap_or_else(default_custom_instruct);
        let req = RequestSettingsUpdate {
            settings: vec![
                RequestSettingsUpdateSettings {
                    key: "instruct-format".into(),
                    value: draft.clone(),
                },
                RequestSettingsUpdateSettings {
                    key: "instruct-format-id".into(),
                    value: json!({ "value": Value::Null }),
                },
            ],
        };
        match self.call_value("settings.update", &req) {
            Ok(_) => {
                self.state.instruct_format = Some(draft);
                self.state.instruct_selection = "custom".into();
                self.state.instruct_format_id = None;
                self.state.instruct_form_error = None;
            }
            Err(err) => {
                self.state.instruct_form_error = Some(err.reason_code());
                self.record_error(err);
            }
        }
        self.bump_scene();
    }

    /// React `ChatTemplateEditor` textarea onChange. Local until Save.
    /// `role` is a ChatML key (`system` / `user` / `assistant` / `tool` /
    /// `promptSuffix` / `stopStrings`).
    pub fn set_instruct_role(&mut self, role: &str, value: &str) {
        let mut draft = self
            .state
            .instruct_format
            .clone()
            .unwrap_or_else(default_custom_instruct);
        match role {
            "stopStrings" => {
                let stops: Vec<Value> = value
                    .split('\n')
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(Value::from)
                    .collect();
                if let Some(obj) = draft.as_object_mut() {
                    obj.insert("stopStrings".into(), Value::Array(stops));
                }
            }
            "system" | "user" | "assistant" | "tool" | "promptSuffix" => {
                if let Some(obj) = draft.as_object_mut() {
                    obj.insert(role.to_string(), Value::from(value));
                }
            }
            _ => return,
        }
        self.state.instruct_format = Some(draft);
        self.state.instruct_form_error = None;
        self.bump_scene();
    }

    /// Load `profiles.list` for the Settings Profiles tab (React
    /// `useProfiles`; the kernel returns the full list in one page).
    fn load_profiles(&mut self) {
        match self.call_decode(
            "profiles.list",
            &RequestEmpty {},
            decode_result_profiles_list,
        ) {
            Ok(ResultProfilesList { items }) => self.state.profiles = items,
            Err(err) => self.record_error(err),
        }
    }

    /// Inline create row (`profiles.create`); an empty name stays a local
    /// status message, exactly like React disabling the submit button.
    pub fn create_profile(&mut self) {
        let name = self.state.profile_create_name.trim().to_string();
        if name.is_empty() {
            self.state.status_message = Some("Profile needs a name.".into());
            self.bump_scene();
            return;
        }
        match self.call_decode(
            "profiles.create",
            &RequestProfilesCreate { name },
            decode_result_profiles_create,
        ) {
            Ok(_) => {
                self.state.profile_create_name.clear();
                self.load_profiles();
                self.state.status_message = Some("Profile created.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Enter inline rename mode for a profile row (React `startRename`).
    pub fn start_profile_rename(&mut self, profile_id: &str) {
        let Some(profile) = self
            .state
            .profiles
            .iter()
            .find(|row| row.id == profile_id)
            .cloned()
        else {
            return;
        };
        self.state.profile_renaming_id = Some(profile.id);
        self.state.profile_rename_name = profile.name;
        self.bump_scene();
    }

    /// Inline rename submit (`profiles.rename`).
    pub fn submit_profile_rename(&mut self) {
        let Some(id) = self.state.profile_renaming_id.clone() else {
            return;
        };
        let name = self.state.profile_rename_name.trim().to_string();
        if name.is_empty() {
            self.state.status_message = Some("Profile needs a name.".into());
            self.bump_scene();
            return;
        }
        match self.call_value("profiles.rename", &RequestProfilesRename { id, name }) {
            Ok(_) => {
                self.state.profile_renaming_id = None;
                self.state.profile_rename_name.clear();
                self.load_profiles();
                self.state.status_message = Some("Profile renamed.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn confirm_delete_profile(&mut self) {
        let Some(id) = self.state.profile_delete_target_id.clone() else {
            self.state.profile_delete_open = false;
            return;
        };
        match self.call_value("profiles.delete", &RequestProfilesDelete { id }) {
            Ok(_) => {
                self.state.profile_delete_open = false;
                self.state.profile_delete_target_id = None;
                self.load_profiles();
                self.state.status_message = Some("Profile deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Per-profile logical export (`profile.export`): the kernel builds the
    /// container and returns the verified report — the toast surfaces the
    /// honest record counts (React `runExport` notice).
    pub fn export_profile(&mut self, profile_id: &str) {
        let name = self
            .state
            .profiles
            .iter()
            .find(|row| row.id == profile_id)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        let req = RequestProfileExport {
            include_assets: None,
            profile_id: Some(profile_id.to_string()),
        };
        match self.call_decode("profile.export", &req, decode_result_profile_export) {
            Ok(result) => {
                self.state.status_message = Some(format!(
                    "Exported \"{name}\": {} characters, {} chats, {} messages.",
                    result.records.characters, result.records.chats, result.records.messages
                ));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_profile_create_name(&mut self, value: &str) {
        self.state.profile_create_name = value.to_string();
        self.bump_scene();
    }

    pub fn set_profile_rename_name(&mut self, value: &str) {
        self.state.profile_rename_name = value.to_string();
        self.bump_scene();
    }

    /// Plugin card switch: `plugins.enable` / `plugins.disable` by current
    /// state; the wire returns the updated row (React `PluginsPage` toggle).
    pub fn toggle_plugin(&mut self, plugin_id: &str) {
        let Some(plugin) = self
            .state
            .plugins
            .iter()
            .find(|row| row.id == plugin_id)
            .cloned()
        else {
            return;
        };
        let (op, enabled, toast) = if plugin.enabled {
            (
                "plugins.disable",
                false,
                format!("Plugin \"{}\" disabled.", plugin.name),
            )
        } else {
            (
                "plugins.enable",
                true,
                format!("Plugin \"{}\" enabled.", plugin.name),
            )
        };
        let result = if enabled {
            self.call_value(
                "plugins.enable",
                &RequestPluginsEnable {
                    id: plugin_id.to_string(),
                },
            )
        } else {
            self.call_value(
                "plugins.disable",
                &RequestPluginsDisable {
                    id: plugin_id.to_string(),
                },
            )
        };
        match result {
            Ok(_) => {
                self.load_plugins();
                self.state.status_message = Some(toast);
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn confirm_uninstall_plugin(&mut self) {
        let Some(id) = self.state.plugin_uninstall_target_id.clone() else {
            self.state.plugin_uninstall_open = false;
            return;
        };
        let name = self
            .state
            .plugins
            .iter()
            .find(|row| row.id == id)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        match self.call_value("plugins.uninstall", &RequestPluginsUninstall { id }) {
            Ok(_) => {
                self.state.plugin_uninstall_open = false;
                self.state.plugin_uninstall_target_id = None;
                self.load_plugins();
                self.state.status_message = Some(format!("Plugin \"{name}\" uninstalled."));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Chats row rename action: opens the rename dialog pre-filled with the
    /// current title (React `ChatManagementPanel` rename Dialog).
    pub fn start_chat_rename(&mut self, chat_id: &str) {
        let Some(chat) = self
            .state
            .chat_list
            .iter()
            .find(|row| row.id == chat_id)
            .cloned()
        else {
            return;
        };
        self.state.chat_renaming_id = Some(chat.id);
        self.state.chat_rename_draft = chat.title;
        self.state.chat_rename_open = true;
        self.bump_scene();
    }

    /// Rename submit (`chats.update`); an empty title closes the dialog
    /// without a wire call, exactly like React's no-op guard.
    pub fn submit_chat_rename(&mut self) {
        let Some(id) = self.state.chat_renaming_id.clone() else {
            return;
        };
        let title = self.state.chat_rename_draft.trim().to_string();
        if title.is_empty() {
            self.state.chat_rename_open = false;
            self.state.chat_renaming_id = None;
            self.bump_scene();
            return;
        }
        let req = RequestUpdateChat {
            chat_id: id,
            title: Some(title),
            persona_id: None,
        };
        match self.call_value("chats.update", &req) {
            Ok(_) => {
                self.state.chat_rename_open = false;
                self.state.chat_renaming_id = None;
                self.load_chat_list();
                self.state.status_message = Some("Chat renamed.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn confirm_delete_chat(&mut self) {
        let Some(id) = self.state.chat_delete_target_id.clone() else {
            self.state.chat_delete_open = false;
            return;
        };
        match self.call_value(
            "chats.delete",
            &RequestDeleteChat {
                chat_id: id.clone(),
            },
        ) {
            Ok(_) => {
                self.state.chat_delete_open = false;
                self.state.chat_delete_target_id = None;
                // The deleted chat was open in the workspace: drop it so the
                // next refresh cannot hit CHAT_NOT_FOUND (React navigates away).
                if self.chat_id.as_deref() == Some(id.as_str()) {
                    self.chat_id = None;
                    self.state.chat = None;
                    self.state.messages.clear();
                    self.state.draft = None;
                }
                self.load_chat_list();
                self.state.status_message = Some("Chat deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_chat_rename_draft(&mut self, value: &str) {
        self.state.chat_rename_draft = value.to_string();
        self.bump_scene();
    }

    /// Opens the prompt plan dialog for a run and loads the durable plan
    /// (`generation.prompt.plan`; React `PromptPlanPanel`). `PROMPT_PLAN_NOT_FOUND`
    /// becomes the honest empty state; any other error renders inside the
    /// dialog (React `isError`), not as a toast.
    pub fn open_prompt_plan(&mut self, run_id: &str) {
        self.close_run_transcript_state();
        self.state.prompt_plan_run_id = Some(run_id.to_string());
        self.state.prompt_plan_open = true;
        self.state.prompt_plan = None;
        self.state.prompt_plan_not_found = false;
        self.state.prompt_plan_error = None;
        match self.call_decode(
            "generation.prompt.plan",
            &RequestGetPromptPlan {
                run_id: run_id.to_string(),
            },
            decode_prompt_plan,
        ) {
            Ok(plan) => self.state.prompt_plan = Some(plan),
            Err(ChatRouteError::Product(dto)) if dto.code == "PROMPT_PLAN_NOT_FOUND" => {
                self.state.prompt_plan_not_found = true;
            }
            Err(err) => self.state.prompt_plan_error = Some(err.to_string()),
        }
        self.bump_scene();
    }

    /// Open the prompt plan for a message row (React footer "Prompt plan"
    /// tap). Looks up `MessageDto.generation_run_id`; streaming / unknown
    /// rows are honest no-ops.
    pub fn open_prompt_plan_for_message(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let Some(run_id) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| row.generation_run_id.clone())
        else {
            self.record_error(ChatRouteError::product(
                "GENERATION_RUN_NOT_FOUND",
                json!({ "messageId": row_id }),
            ));
            self.bump_scene();
            return;
        };
        self.open_prompt_plan(&run_id);
    }

    pub fn close_prompt_plan(&mut self) {
        self.state.prompt_plan_open = false;
        self.state.prompt_plan_run_id = None;
        self.state.prompt_plan = None;
        self.state.prompt_plan_not_found = false;
        self.state.prompt_plan_error = None;
        self.bump_scene();
    }

    fn close_prompt_plan_state(&mut self) {
        self.state.prompt_plan_open = false;
        self.state.prompt_plan_run_id = None;
        self.state.prompt_plan = None;
        self.state.prompt_plan_not_found = false;
        self.state.prompt_plan_error = None;
    }

    fn close_run_transcript_state(&mut self) {
        self.state.run_transcript_open = false;
        self.state.run_transcript_run_id = None;
        self.state.run_transcript_steps.clear();
        self.state.run_transcript_error = None;
    }

    /// Opens the run-step transcript (`generation.events`; React
    /// `RunTranscriptPanel`). Unknown run → error inside the dialog (React
    /// `isError`); empty journal → honest empty state.
    pub fn open_run_transcript(&mut self, run_id: &str) {
        self.close_prompt_plan_state();
        self.state.run_transcript_run_id = Some(run_id.to_string());
        self.state.run_transcript_open = true;
        self.state.run_transcript_steps.clear();
        self.state.run_transcript_error = None;
        match self.call_decode(
            "generation.events",
            &RequestListGenerationEvents {
                workflow_id: run_id.to_string(),
                after_sequence: None,
                limit: Some(50),
            },
            decode_paged_generation_events,
        ) {
            Ok(page) => {
                self.state.run_transcript_steps = page
                    .items
                    .into_iter()
                    .filter_map(run_step_from_envelope)
                    .collect();
            }
            Err(ChatRouteError::Product(dto)) => {
                self.state.run_transcript_error = Some(dto.code);
            }
            Err(err) => self.state.run_transcript_error = Some(err.to_string()),
        }
        self.bump_scene();
    }

    pub fn open_run_transcript_for_message(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let Some(run_id) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| row.generation_run_id.clone())
        else {
            self.record_error(ChatRouteError::product(
                "GENERATION_RUN_NOT_FOUND",
                json!({ "messageId": row_id }),
            ));
            self.bump_scene();
            return;
        };
        self.open_run_transcript(&run_id);
    }

    pub fn close_run_transcript(&mut self) {
        self.close_run_transcript_state();
        self.bump_scene();
    }

    /// Toggle `message.meta.manualExcluded` via `chats.messages.update`
    /// (React `toggleMessageContext`). The kernel replaces the whole meta
    /// object; we merge the flag onto a clone of the current payload.
    pub fn toggle_message_context(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        let Some(message) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .cloned()
        else {
            self.record_error(ChatRouteError::product(
                "MESSAGE_NOT_FOUND",
                json!({ "messageId": row_id }),
            ));
            self.bump_scene();
            return;
        };
        let excluded = manual_excluded(&message.meta);
        let meta = with_manual_excluded(&message.meta, !excluded);
        match self.call_decode(
            "chats.messages.update",
            &RequestUpdateMessage {
                chat_id,
                message_id: row_id.to_string(),
                content: None,
                meta: Some(meta),
                clear_checkpoint_chat_id: None,
            },
            decode_message_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                    *row = updated;
                }
                self.state.status_message = Some(if excluded {
                    "Included in prompt context.".into()
                } else {
                    "Excluded from prompt context.".into()
                });
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn open_checkpoint_delete(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let has_checkpoint = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| row.checkpoint_chat_id.as_ref())
            .is_some();
        if !has_checkpoint {
            return;
        }
        self.state.checkpoint_delete_message_id = Some(row_id.to_string());
        self.state.checkpoint_delete_open = true;
        self.bump_scene();
    }

    pub fn close_checkpoint_delete(&mut self) {
        self.state.checkpoint_delete_open = false;
        self.state.checkpoint_delete_message_id = None;
        self.bump_scene();
    }

    pub fn confirm_checkpoint_delete(&mut self) {
        let Some(row_id) = self.state.checkpoint_delete_message_id.clone() else {
            self.close_checkpoint_delete();
            return;
        };
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            self.close_checkpoint_delete();
            return;
        };
        match self.call_decode(
            "chats.messages.update",
            &RequestUpdateMessage {
                chat_id,
                message_id: row_id.clone(),
                content: None,
                meta: None,
                clear_checkpoint_chat_id: Some(true),
            },
            decode_message_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                    *row = updated;
                }
                self.state.status_message = Some("Checkpoint link removed.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.state.checkpoint_delete_open = false;
        self.state.checkpoint_delete_message_id = None;
        self.bump_scene();
    }

    pub fn toggle_header_search(&mut self) {
        if self.state.header_search_open {
            self.state.header_search_open = false;
            self.state.header_search_query.clear();
            self.state.header_search_match_count = 0;
        } else {
            self.state.header_search_open = true;
        }
        self.bump_scene();
    }

    pub fn set_header_search_query(&mut self, value: &str) {
        if !self.state.header_search_open {
            return;
        }
        let query: String = value.chars().take(500).collect();
        self.state.header_search_query = query;
        self.recompute_header_search_matches();
        self.bump_scene();
    }

    fn recompute_header_search_matches(&mut self) {
        self.state.header_search_match_count = self
            .state
            .messages
            .iter()
            .map(|row| count_text_matches(&row.content, &self.state.header_search_query))
            .sum();
    }

    /// Loads the theme catalog (`themes.list`; React `useThemes`).
    pub fn load_themes(&mut self) {
        match self.call_decode("themes.list", &RequestEmpty {}, decode_result_themes_list) {
            Ok(result) => self.state.themes = result.items,
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// `themes.activate` (React `applyTheme(theme.id, theme.name)`); the wire
    /// response is the item with `active: true`.
    pub fn activate_theme(&mut self, id: &str) {
        let name = self
            .state
            .themes
            .iter()
            .find(|row| row.id == id)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        match self.call_decode(
            "themes.activate",
            &RequestThemesActivate { id: id.to_string() },
            decode_themes_item,
        ) {
            Ok(updated) => {
                for row in self.state.themes.iter_mut() {
                    row.active = row.id == updated.id;
                }
                self.state.status_message = Some(format!("Applied {name}."));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// `themes.deactivate` — restore the built-in interface (React
    /// `resetActiveTheme`).
    pub fn use_builtin_theme(&mut self) {
        match self.call_value("themes.deactivate", &RequestEmpty {}) {
            Ok(_) => {
                for row in self.state.themes.iter_mut() {
                    row.active = false;
                }
                self.state.status_message = Some("Restored the built-in theme.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn confirm_delete_theme(&mut self) {
        let Some(id) = self.state.theme_delete_target_id.clone() else {
            self.state.theme_delete_open = false;
            return;
        };
        let name = self
            .state
            .themes
            .iter()
            .find(|row| row.id == id)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        match self.call_value("themes.uninstall", &RequestThemesUninstall { id }) {
            Ok(_) => {
                self.state.theme_delete_open = false;
                self.state.theme_delete_target_id = None;
                self.load_themes();
                self.state.status_message = Some(format!("Removed {name}."));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Reads the secret-store status (`secrets.status`; React
    /// `useSecretsStatus`, `staleTime: 30_000`). The DTO is value-free by
    /// contract — no secret ever travels it.
    pub fn load_secrets_status(&mut self) {
        match self.call_decode(
            "secrets.status",
            &RequestEmpty {},
            decode_result_secrets_status,
        ) {
            Ok(status) => self.state.secrets_status = Some(status),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Locks the store (`secrets.lock`; React `useLockSecrets` invalidates the
    /// status query afterwards, so the panel refetches the honest locked
    /// state).
    pub fn lock_secrets(&mut self) {
        match self.call_decode("secrets.lock", &RequestEmpty {}, decode_result_secrets_lock) {
            Ok(_) => self.load_secrets_status(),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Reads the host tool registry (`generation.tools.list`; React
    /// `useGenerationTools`). An empty registry is a success, never an error
    /// (kernel `generation_tools_list`).
    pub fn load_tools(&mut self) {
        match self.call_decode(
            "generation.tools.list",
            &RequestEmpty {},
            decode_result_list_tools,
        ) {
            Ok(result) => self.state.tools = result.items,
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Selects a provider card (`settings.update` key `activeProviderConfigId`,
    /// React `ProviderProfileEditor` Connect flow persistence).
    pub fn select_provider(&mut self, id: &str) {
        self.state.active_provider_id = Some(id.to_string());
        let req = RequestSettingsUpdate {
            settings: vec![RequestSettingsUpdateSettings {
                key: "activeProviderConfigId".into(),
                value: json!(id),
            }],
        };
        match self.call_value("settings.update", &req) {
            Ok(_) => {
                self.state.status_message = Some("Provider selected.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Selects a generation preset card (`settings.update` key
    /// `activeGenerationPresetId`, React `GenerationPresetEditor`). Like
    /// React `selectPreset`, the preset values are applied too:
    /// maxContextTokens + generationDefaults ride the same settings.update.
    pub fn select_preset(&mut self, id: &str) {
        self.state.active_preset_id = Some(id.to_string());
        if let Some(preset) = self.state.presets.iter().find(|item| item.id == id) {
            let parsed: PresetGenerationData =
                serde_json::from_value(preset.data.clone()).unwrap_or_default();
            self.state.preset_draft_max_context = parsed.max_context_tokens;
            self.state.preset_draft_defaults =
                serde_json::to_value(&parsed.generation_defaults).unwrap_or_else(|_| json!({}));
            self.state.preset_unlocked_context =
                parsed.max_context_tokens > CONTEXT_TOKEN_DEFAULT_MAX;
            self.state.preset_draft_dirty = false;
            self.clear_preset_value_edit();
            let req = RequestSettingsUpdate {
                settings: vec![
                    RequestSettingsUpdateSettings {
                        key: "activeGenerationPresetId".into(),
                        value: json!(id),
                    },
                    RequestSettingsUpdateSettings {
                        key: "maxContextTokens".into(),
                        value: json!(parsed.max_context_tokens),
                    },
                    RequestSettingsUpdateSettings {
                        key: "generationDefaults".into(),
                        value: serde_json::to_value(&parsed.generation_defaults)
                            .unwrap_or_else(|_| json!({})),
                    },
                ],
            };
            match self.call_value("settings.update", &req) {
                Ok(_) => {
                    self.state.status_message = Some("Preset selected.".into());
                }
                Err(err) => self.record_error(err),
            }
        } else {
            self.state.status_message = Some("Preset selected.".into());
        }
        self.bump_scene();
    }

    /// Applies the current draft (`settings.update` maxContextTokens +
    /// generationDefaults + activeGenerationPresetId; React `applyDraft`).
    pub fn apply_preset_draft(&mut self) {
        self.commit_preset_value_edit();
        let defaults = self.state.preset_draft_defaults.clone();
        let req = RequestSettingsUpdate {
            settings: vec![
                RequestSettingsUpdateSettings {
                    key: "maxContextTokens".into(),
                    value: json!(self.state.preset_draft_max_context),
                },
                RequestSettingsUpdateSettings {
                    key: "generationDefaults".into(),
                    value: defaults,
                },
                RequestSettingsUpdateSettings {
                    key: "activeGenerationPresetId".into(),
                    value: json!(self.state.active_preset_id.clone()),
                },
            ],
        };
        match self.call_value("settings.update", &req) {
            Ok(_) => {
                self.state.preset_draft_dirty = false;
                self.state.status_message = Some("Generation settings applied.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// React `GenerationPresetEditor.exportPreset`: host-owned JSON envelope
    /// (no wire op). Parks the live draft in `last_export`.
    fn export_generation_preset(&mut self) {
        let name = self
            .active_preset()
            .map(|item| item.name.as_str())
            .unwrap_or("generation");
        let filename = json_export_filename(name, "generation");
        let payload = json!({
            "version": 1,
            "kind": "generation",
            "name": name,
            "data": self.generation_preset_draft_json(),
        });
        match serde_json::to_vec_pretty(&payload) {
            Ok(bytes) => {
                self.state.last_export = Some(LastExport {
                    filename: filename.clone(),
                    bytes,
                });
                self.state.status_message = Some(format!("Export ready: {filename}."));
                self.state.preset_form_error = None;
            }
            Err(_) => {
                self.state.preset_form_error = Some(INVALID_GENERATION_PRESET.to_string());
            }
        }
        self.bump_scene();
    }

    fn open_generation_preset_import(&mut self) {
        if self.state.generation_preset_import_open {
            return;
        }
        self.state.card_import_dialog_open = false;
        self.state.prompt_template_import_open = false;
        self.state.generation_preset_path_draft.clear();
        self.state.generation_preset_import_open = true;
        self.bump_scene();
    }

    fn close_generation_preset_import(&mut self) {
        self.state.generation_preset_import_open = false;
        self.state.generation_preset_path_draft.clear();
        self.bump_scene();
    }

    pub fn set_generation_preset_path_draft(&mut self, draft: &str) {
        if self.state.generation_preset_import_open {
            self.state.generation_preset_path_draft = draft.to_string();
            self.bump_scene();
        }
    }

    /// React `GenerationPresetEditor.importPreset`: read JSON from a host
    /// path, validate `GenerationPresetData`, then `presets.create` +
    /// `settings.update` (`activeGenerationPresetId` + sampler keys).
    fn confirm_generation_preset_import(&mut self) {
        let path = self.state.generation_preset_path_draft.trim().to_string();
        if path.is_empty() {
            self.state.status_message =
                Some("Provide a generation preset JSON file from this device.".into());
            self.bump_scene();
            return;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => {
                self.state.status_message = Some(format!("Cannot read {path}: {err}"));
                self.bump_scene();
                return;
            }
        };
        let fallback_name = std::path::Path::new(&path)
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "generation".into());
        let Some((name, data)) = parse_generation_preset_import(&bytes, &fallback_name) else {
            self.state.preset_form_error = Some(INVALID_GENERATION_PRESET.to_string());
            self.bump_scene();
            return;
        };
        let parsed: PresetGenerationData = serde_json::from_value(data.clone()).unwrap_or_default();
        let req = RequestCreatePreset {
            kind: "generation".into(),
            name: name.clone(),
            data: Some(data),
        };
        match self.call_decode("presets.create", &req, decode_preset_dto) {
            Ok(dto) => {
                self.state.preset_draft_max_context = parsed.max_context_tokens;
                self.state.preset_draft_defaults =
                    serde_json::to_value(&parsed.generation_defaults).unwrap_or_else(|_| json!({}));
                self.state.preset_unlocked_context =
                    parsed.max_context_tokens > CONTEXT_TOKEN_DEFAULT_MAX;
                self.state.preset_draft_dirty = false;
                self.clear_preset_value_edit();
                let apply = RequestSettingsUpdate {
                    settings: vec![
                        RequestSettingsUpdateSettings {
                            key: "activeGenerationPresetId".into(),
                            value: json!(dto.id.clone()),
                        },
                        RequestSettingsUpdateSettings {
                            key: "maxContextTokens".into(),
                            value: json!(parsed.max_context_tokens),
                        },
                        RequestSettingsUpdateSettings {
                            key: "generationDefaults".into(),
                            value: serde_json::to_value(&parsed.generation_defaults)
                                .unwrap_or_else(|_| json!({})),
                        },
                    ],
                };
                if let Err(err) = self.call_value("settings.update", &apply) {
                    self.record_error(err);
                    self.bump_scene();
                    return;
                }
                self.state.active_preset_id = Some(dto.id);
                self.load_presets_list();
                self.close_generation_preset_import();
                self.state.preset_form_error = None;
                self.state.status_message = Some(format!("Imported {name}."));
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.preset_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    fn generation_preset_draft_json(&self) -> Value {
        json!({
            "maxContextTokens": self.state.preset_draft_max_context,
            "generationDefaults": self.state.preset_draft_defaults,
        })
    }

    fn clear_preset_value_edit(&mut self) {
        self.state.preset_edit_key = None;
        self.state.preset_edit_text.clear();
    }

    fn toggle_preset_unlock(&mut self) {
        self.commit_preset_value_edit();
        let next = !self.state.preset_unlocked_context;
        self.state.preset_unlocked_context = next;
        if !next && self.state.preset_draft_max_context > CONTEXT_TOKEN_DEFAULT_MAX {
            self.state.preset_draft_max_context = CONTEXT_TOKEN_DEFAULT_MAX;
        }
        self.state.preset_draft_dirty = true;
        self.bump_scene();
    }

    fn focus_preset_value(&mut self, id: &str) {
        if self.state.preset_edit_key.as_deref() == Some(id) {
            return;
        }
        self.commit_preset_value_edit();
        let formatted = self.formatted_preset_value(id);
        self.state.preset_edit_key = Some(id.to_string());
        self.state.preset_edit_text = formatted;
        self.bump_scene();
    }

    fn toggle_preset_flag(&mut self, id: &str) {
        self.commit_preset_value_edit();
        let parsed = self.parsed_preset_defaults();
        let current = match id {
            "reasoning" => parsed.reasoning,
            "stream" => parsed.stream,
            _ => return,
        };
        self.ensure_preset_defaults_object()
            .insert(id.to_string(), json!(!current));
        self.state.preset_draft_dirty = true;
        self.bump_scene();
    }

    /// Keyboard input into the focused sampler number field.
    pub fn set_preset_value_draft(&mut self, value: &str) {
        let Some(id) = self.state.preset_edit_key.clone() else {
            return;
        };
        self.state.preset_edit_text = value.to_string();
        if let Some(parsed) = parse_sampler_number(value) {
            self.assign_preset_number(&id, parsed);
            self.state.preset_draft_dirty = true;
        }
        self.bump_scene();
    }

    fn commit_preset_value_edit(&mut self) {
        let Some(id) = self.state.preset_edit_key.clone() else {
            return;
        };
        let text = self.state.preset_edit_text.clone();
        if let Some(parsed) = parse_sampler_number(&text) {
            self.assign_preset_number(&id, parsed);
            self.state.preset_draft_dirty = true;
        }
        self.clear_preset_value_edit();
    }

    fn formatted_preset_value(&self, id: &str) -> String {
        if id == "maxContextTokens" {
            return self.state.preset_draft_max_context.to_string();
        }
        let defaults = self.parsed_preset_defaults();
        let (value, integer) = match id {
            "maxTokens" => (defaults.max_tokens, true),
            "temperature" => (defaults.temperature, false),
            "topP" => (defaults.top_p, false),
            "topK" => (defaults.top_k, true),
            "minP" => (defaults.min_p, false),
            "topA" => (defaults.top_a, false),
            "repetitionPenalty" => (defaults.repetition_penalty, false),
            "frequencyPenalty" => (defaults.frequency_penalty, false),
            "presencePenalty" => (defaults.presence_penalty, false),
            "seed" => (defaults.seed, true),
            _ => return String::new(),
        };
        format_sampler_number(value, integer)
    }

    fn assign_preset_number(&mut self, id: &str, raw: f64) {
        let clamped = clamp_sampler_number(id, raw, self.state.preset_unlocked_context);
        if id == "maxContextTokens" {
            self.state.preset_draft_max_context = clamped.round() as i64;
            return;
        }
        let integer = sampler_bound(id)
            .map(|bound| bound.integer)
            .unwrap_or(false);
        let stored = if integer {
            json!(clamped.round() as i64)
        } else {
            json!(clamped)
        };
        self.ensure_preset_defaults_object()
            .insert(id.to_string(), stored);
    }

    fn ensure_preset_defaults_object(&mut self) -> &mut serde_json::Map<String, Value> {
        if !self.state.preset_draft_defaults.is_object() {
            self.state.preset_draft_defaults =
                serde_json::to_value(PresetGenerationDefaults::default())
                    .unwrap_or_else(|_| json!({}));
        }
        self.state
            .preset_draft_defaults
            .as_object_mut()
            .expect("generationDefaults object")
    }

    pub fn set_preset_name_draft(&mut self, value: &str) {
        self.state.preset_name_draft = value.to_string();
        self.bump_scene();
    }

    /// Opens the name dialog in create mode ("Save as new").
    pub fn open_preset_create(&mut self) {
        self.begin_preset_dialog("generation", "create", String::new());
    }

    /// Opens the name dialog in rename mode prefilled with the active name.
    pub fn open_preset_rename(&mut self) {
        let active_name = self.active_preset().map(|item| item.name.clone());
        let Some(active_name) = active_name else {
            return;
        };
        self.begin_preset_dialog("generation", "rename", active_name);
    }

    pub fn close_preset_name(&mut self) {
        self.state.preset_name_dialog_open = false;
        self.state.preset_name_mode = None;
        self.state.preset_name_draft.clear();
        self.bump_scene();
    }

    pub fn close_preset_delete(&mut self) {
        self.state.preset_delete_open = false;
        self.bump_scene();
    }

    fn active_preset(&self) -> Option<&PresetDto> {
        let id = self.state.active_preset_id.as_deref()?;
        self.state.presets.iter().find(|item| item.id == id)
    }

    fn load_presets_list(&mut self) {
        match self.call_decode(
            "presets.list",
            &RequestListPresets {
                kind: Some("generation".into()),
            },
            decode_result_list_presets,
        ) {
            Ok(ResultListPresets { items }) => self.state.presets = items,
            Err(err) => self.record_error(err),
        }
    }

    /// Confirms the name dialog: create ("Save as new") or rename, mirroring
    /// React `submitNameAction`. An empty name stays client-side.
    pub fn confirm_preset_name(&mut self) {
        let name = self.state.preset_name_draft.trim().to_string();
        if name.is_empty() || self.state.preset_name_mode.is_none() {
            self.state.preset_form_error = Some("REQUIRED".into());
            self.bump_scene();
            return;
        }
        let mode = self.state.preset_name_mode.clone().unwrap_or_default();
        if self.state.preset_dialog_kind == "prompt-template" {
            self.confirm_prompt_preset_name(name, &mode);
            return;
        }
        let outcome = if mode == "rename" {
            match self.active_preset().cloned() {
                Some(active) => {
                    let req = RequestUpdatePreset {
                        preset_id: active.id,
                        name: Some(name),
                        data: None,
                    };
                    self.call_decode("presets.update", &req, decode_preset_dto)
                        .map(|_| ())
                }
                None => Ok(()),
            }
        } else {
            let req = RequestCreatePreset {
                kind: "generation".into(),
                name,
                data: Some(self.generation_preset_draft_json()),
            };
            self.call_decode("presets.create", &req, decode_preset_dto)
                .map(|dto| dto.id)
                .and_then(|id| {
                    // A created preset becomes the active one, exactly like
                    // React `submitNameAction`.
                    let req = RequestSettingsUpdate {
                        settings: vec![RequestSettingsUpdateSettings {
                            key: "activeGenerationPresetId".into(),
                            value: json!(id.clone()),
                        }],
                    };
                    self.state.active_preset_id = Some(id);
                    self.call_value("settings.update", &req).map(|_| ())
                })
        };
        match outcome {
            Ok(_) => {
                let was_create = mode != "rename";
                self.close_preset_name();
                self.load_presets_list();
                if was_create {
                    self.state.status_message = Some("Preset created.".into());
                } else {
                    self.state.status_message = Some("Preset renamed.".into());
                }
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.preset_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    /// Duplicates the active preset as "<name> (copy)" and selects it
    /// (React duplicate flow).
    pub fn duplicate_preset(&mut self) {
        let (name, data) = match self.active_preset() {
            Some(active) => (
                format!("{} (copy)", active.name),
                self.generation_preset_draft_json(),
            ),
            None => (
                "generation (copy)".to_string(),
                self.generation_preset_draft_json(),
            ),
        };
        let req = RequestCreatePreset {
            kind: "generation".into(),
            name,
            data: Some(data),
        };
        match self.call_decode("presets.create", &req, decode_preset_dto) {
            Ok(dto) => {
                let sel = RequestSettingsUpdate {
                    settings: vec![RequestSettingsUpdateSettings {
                        key: "activeGenerationPresetId".into(),
                        value: json!(dto.id.clone()),
                    }],
                };
                let _ = self.call_value("settings.update", &sel);
                self.state.active_preset_id = Some(dto.id);
                self.state.status_message = Some("Preset duplicated.".into());
                self.load_presets_list();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn open_preset_delete(&mut self) {
        if self.active_preset().is_some() {
            self.state.preset_dialog_kind = "generation".into();
            self.state.preset_delete_open = true;
            self.bump_scene();
        }
    }

    /// Deletes the active preset and clears the selection
    /// (React `confirmDelete`).
    pub fn confirm_preset_delete(&mut self) {
        if self.state.preset_dialog_kind == "prompt-template" {
            self.confirm_prompt_preset_delete();
            return;
        }
        let Some(active) = self.active_preset().cloned() else {
            return;
        };
        self.state.preset_delete_open = false;
        let req = RequestDeletePreset {
            preset_id: active.id,
        };
        match self.call_value("presets.delete", &req) {
            Ok(_) => {
                let clear = RequestSettingsUpdate {
                    settings: vec![RequestSettingsUpdateSettings {
                        key: "activeGenerationPresetId".into(),
                        value: Value::Null,
                    }],
                };
                let _ = self.call_value("settings.update", &clear);
                self.state.active_preset_id = None;
                self.state.status_message = Some("Preset deleted.".into());
                self.load_presets_list();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Reads provider connection profiles (`providers.config.list`; React
    /// `useProviders` on the kernel plane).
    pub fn load_provider_configs(&mut self) {
        match self.call_decode(
            "providers.config.list",
            &RequestListProviderConfigs { provider: None },
            decode_result_list_provider_configs,
        ) {
            Ok(result) => self.state.provider_configs = result.items,
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn reload_provider_configs(&mut self) {
        match self.call_decode(
            "providers.config.list",
            &RequestListProviderConfigs { provider: None },
            decode_result_list_provider_configs,
        ) {
            Ok(result) => self.state.provider_configs = result.items,
            Err(err) => self.record_error(err),
        }
    }

    pub fn set_provider_name_draft(&mut self, value: &str) {
        self.state.provider_name_draft = value.to_string();
        self.bump_scene();
    }

    /// Cycles the adapter kind for the new-profile dialog (React uses a
    /// `<select>` over the catalog; the catalog op is UnsupportedError on the
    /// kernel plane, so this plane cycles the registered adapters).
    pub fn cycle_provider_kind(&mut self) {
        if !self.state.providers.is_empty() {
            self.state.provider_kind_index =
                (self.state.provider_kind_index + 1) % self.state.providers.len();
        }
        self.bump_scene();
    }

    pub fn open_provider_create(&mut self) {
        self.state.provider_create_dialog_open = true;
        self.state.provider_name_draft.clear();
        self.state.provider_form_error = None;
        self.bump_scene();
    }

    pub fn close_provider_create(&mut self) {
        self.state.provider_create_dialog_open = false;
        self.state.provider_name_draft.clear();
        self.bump_scene();
    }

    /// Confirms the new-profile dialog (`providers.config.set` upsert keyed
    /// by provider + name), then selects the profile — React saves and sets
    /// `activeProviderConfigId`. API keys stay host-side (SecretStore); a
    /// profile without a key is created without one.
    pub fn confirm_provider_create(&mut self) {
        let name = self.state.provider_name_draft.trim().to_string();
        if name.is_empty() {
            self.state.provider_form_error = Some("REQUIRED".into());
            self.bump_scene();
            return;
        }
        let kind = self
            .state
            .providers
            .get(self.state.provider_kind_index)
            .map(|item| item.id.clone())
            .unwrap_or_else(|| "fake".into());
        let req = RequestSetProviderConfig {
            provider: kind.clone(),
            name: name.clone(),
            config: None,
            api_key: None,
        };
        match self.call_decode("providers.config.set", &req, decode_provider_config_dto) {
            Ok(dto) => {
                let sel = RequestSettingsUpdate {
                    settings: vec![RequestSettingsUpdateSettings {
                        key: "activeProviderConfigId".into(),
                        value: json!(dto.id.clone()),
                    }],
                };
                let _ = self.call_value("settings.update", &sel);
                self.state.active_provider_id = Some(dto.id);
                self.close_provider_create();
                self.reload_provider_configs();
                self.state.status_message = Some("Profile saved.".into());
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.provider_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    pub fn open_provider_delete(&mut self, id: &str) {
        if self.state.provider_configs.iter().any(|item| item.id == id) {
            self.state.provider_delete_target_id = Some(id.to_string());
            self.bump_scene();
        }
    }

    pub fn close_provider_delete(&mut self) {
        self.state.provider_delete_target_id = None;
        self.bump_scene();
    }

    /// Deletes a profile (`providers.config.delete`, keyed by provider +
    /// name). Deleting the active profile clears the selection.
    pub fn confirm_provider_delete(&mut self) {
        let Some(id) = self.state.provider_delete_target_id.take() else {
            return;
        };
        let Some(dto) = self
            .state
            .provider_configs
            .iter()
            .find(|item| item.id == id)
        else {
            return;
        };
        let was_active = self.state.active_provider_id.as_deref() == Some(id.as_str());
        let req = RequestDeleteProviderConfig {
            provider: dto.provider.clone(),
            name: dto.name.clone(),
        };
        match self.call_value("providers.config.delete", &req) {
            Ok(_) => {
                if was_active {
                    let clear = RequestSettingsUpdate {
                        settings: vec![RequestSettingsUpdateSettings {
                            key: "activeProviderConfigId".into(),
                            value: Value::Null,
                        }],
                    };
                    let _ = self.call_value("settings.update", &clear);
                    self.state.active_provider_id = None;
                }
                self.reload_provider_configs();
                self.state.status_message = Some("Profile deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Reads the SEC-07 allowlist diagnostics bundle (`diagnostics.export`;
    /// React `useKernelDiagnostics`).
    pub fn load_diagnostics(&mut self) {
        match self.call_decode(
            "diagnostics.export",
            &RequestEmpty {},
            decode_result_diagnostics_export,
        ) {
            Ok(bundle) => self.state.diagnostics = Some(bundle),
            Err(err) => {
                self.state.diagnostics = None;
                self.record_error(err);
            }
        }
        self.bump_scene();
    }

    /// Reads data-root activation (`data.activation.status`; React
    /// `ActivationStatusPanel` / `useDataActivationStatus`).
    pub fn load_data_activation(&mut self) {
        match self.call_decode(
            "data.activation.status",
            &RequestEmpty {},
            decode_result_data_activation_status,
        ) {
            Ok(status) => self.state.data_activation = Some(status),
            Err(err) => {
                self.state.data_activation = None;
                self.record_error(err);
            }
        }
        self.bump_scene();
    }

    /// Reads the backup catalog (`backups.list`; React DataTab `useBackups`).
    pub fn load_backups(&mut self) {
        match self.call_decode("backups.list", &RequestEmpty {}, decode_result_list_backups) {
            Ok(result) => self.state.backups = result.items,
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Creates a user-initiated backup (`backups.create`, kernel models every
    /// backup as manual) and refreshes the catalog.
    pub fn create_backup(&mut self) {
        match self.call_decode("backups.create", &RequestEmpty {}, decode_backup_dto) {
            Ok(_) => self.load_backups(),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Restores a backup (`backups.restore`; the kernel stages + activates
    /// around a database reopen). `activation_pending` maps to the reload
    /// hint, exactly like React `useRestoreBackup.restartRequired`.
    pub fn restore_backup(&mut self, id: &str) {
        let req = RequestBackupsRestore {
            backup_id: id.to_string(),
        };
        match self.call_decode("backups.restore", &req, decode_result_backups_restore) {
            Ok(result) => {
                if result.status == "activation_pending" {
                    self.state.status_message =
                        Some("Backup restored. Reload the app to apply it.".into());
                }
                self.load_backups();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Reads the memory list (`memories.list`; React `MemoryEditor`
    /// `useMemories`).
    pub fn load_memories(&mut self) {
        match self.call_decode(
            "memories.list",
            &RequestListMemories {
                scope: None,
                character_id: None,
                enabled: None,
            },
            decode_result_list_memories,
        ) {
            Ok(result) => self.state.memories = result.items,
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_memory_draft_content(&mut self, value: &str) {
        self.state.memory_draft_content = value.to_string();
        self.bump_scene();
    }

    pub fn set_memory_draft_keys(&mut self, value: &str) {
        self.state.memory_draft_keys = value.to_string();
        self.bump_scene();
    }

    /// Flips the draft scope Global ↔ Character (React scope select). Going
    /// character resets the cycle index so the first loaded character is used.
    pub fn toggle_memory_draft_scope(&mut self) {
        self.state.memory_draft_scope_character = !self.state.memory_draft_scope_character;
        if !self.state.memory_draft_scope_character {
            self.state.memory_draft_character_index = 0;
        }
        self.bump_scene();
    }

    /// Cycles the character pick for a character-scoped draft (the harness
    /// plane has no `<select>`; React uses one).
    pub fn cycle_memory_character(&mut self) {
        if !self.state.characters.is_empty() {
            self.state.memory_draft_character_index =
                (self.state.memory_draft_character_index + 1) % self.state.characters.len();
        }
        self.bump_scene();
    }

    pub fn toggle_memory_draft_enabled(&mut self) {
        self.state.memory_draft_enabled = !self.state.memory_draft_enabled;
        self.bump_scene();
    }

    /// Starts inline editing: prefills the draft from the card, like React
    /// `beginEdit`.
    pub fn begin_memory_edit(&mut self, id: &str) {
        let Some(item) = self.state.memories.iter().find(|item| item.id == id) else {
            return;
        };
        self.state.memory_edit_id = Some(id.to_string());
        self.state.memory_draft_content = item.content.clone();
        self.state.memory_draft_keys = item.keys.join(", ");
        self.state.memory_draft_scope_character = item.scope == MemoryScope::Character;
        self.state.memory_draft_enabled = item.enabled;
        if item.scope == MemoryScope::Character {
            if let Some(pos) =
                self.state.characters.iter().position(|character| {
                    Some(character.id.as_str()) == item.character_id.as_deref()
                })
            {
                self.state.memory_draft_character_index = pos;
            }
        }
        self.state.memory_form_error = None;
        self.bump_scene();
    }

    pub fn cancel_memory_edit(&mut self) {
        self.reset_memory_draft();
        self.bump_scene();
    }

    fn reset_memory_draft(&mut self) {
        self.state.memory_edit_id = None;
        self.state.memory_draft_content.clear();
        self.state.memory_draft_keys.clear();
        self.state.memory_draft_scope_character = false;
        self.state.memory_draft_character_index = 0;
        self.state.memory_draft_enabled = true;
        self.state.memory_form_error = None;
    }

    fn memory_keys(&self) -> Vec<String> {
        self.state
            .memory_draft_keys
            .split(',')
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .collect()
    }

    fn memory_character_id(&self) -> Option<String> {
        self.state
            .characters
            .get(self.state.memory_draft_character_index)
            .map(|character| character.id.clone())
    }

    /// Saves the draft (`memories.create` when not editing, `memories.update`
    /// otherwise), mirroring React `submitCreate` / `submitUpdate` including
    /// the two client-side validations.
    pub fn save_memory(&mut self) {
        let content = self.state.memory_draft_content.trim().to_string();
        if content.is_empty() {
            self.state.memory_form_error = Some("Memory content is required.".into());
            self.bump_scene();
            return;
        }
        let character_id = if self.state.memory_draft_scope_character {
            match self.memory_character_id() {
                Some(id) => Some(id),
                None => {
                    self.state.memory_form_error =
                        Some("A character is required for a character-scoped memory.".into());
                    self.bump_scene();
                    return;
                }
            }
        } else {
            None
        };
        let keys = self.memory_keys();
        let enabled = self.state.memory_draft_enabled;
        let outcome = if let Some(edit_id) = self.state.memory_edit_id.clone() {
            let req = RequestUpdateMemory {
                memory_id: edit_id,
                scope: Some(self.memory_scope()),
                character_id,
                keys: Some(keys),
                content: Some(content),
                enabled: Some(enabled),
                position: None,
                metadata: None,
            };
            self.call_decode("memories.update", &req, decode_memory_dto)
                .map(|_| ())
        } else {
            let req = RequestCreateMemory {
                scope: Some(self.memory_scope()),
                character_id,
                keys: Some(keys),
                content,
                enabled: Some(enabled),
                position: None,
                metadata: None,
            };
            self.call_decode("memories.create", &req, decode_memory_dto)
                .map(|_| ())
        };
        match outcome {
            Ok(_) => {
                self.reset_memory_draft();
                self.load_memories();
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.memory_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    fn memory_scope(&self) -> MemoryScope {
        if self.state.memory_draft_scope_character {
            MemoryScope::Character
        } else {
            MemoryScope::Global
        }
    }

    /// Quick enable/disable from a card switch (`memories.update` with only
    /// `enabled` set — partial update shape).
    pub fn toggle_memory(&mut self, id: &str) {
        let Some(item) = self.state.memories.iter().find(|item| item.id == id) else {
            return;
        };
        let next = !item.enabled;
        let req = RequestUpdateMemory {
            memory_id: id.to_string(),
            scope: None,
            character_id: None,
            keys: None,
            content: None,
            enabled: Some(next),
            position: None,
            metadata: None,
        };
        match self.call_decode("memories.update", &req, decode_memory_dto) {
            Ok(_) => self.load_memories(),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn open_memory_delete(&mut self, id: &str) {
        self.state.memory_delete_target_id = Some(id.to_string());
        self.state.memory_delete_open = true;
        self.bump_scene();
    }

    pub fn close_memory_delete(&mut self) {
        self.state.memory_delete_open = false;
        self.state.memory_delete_target_id = None;
        self.bump_scene();
    }

    pub fn confirm_memory_delete(&mut self) {
        let Some(id) = self.state.memory_delete_target_id.clone() else {
            return;
        };
        let was_editing = self.state.memory_edit_id.as_deref() == Some(id.as_str());
        self.state.memory_delete_open = false;
        self.state.memory_delete_target_id = None;
        let req = RequestDeleteMemory { memory_id: id };
        match self.call_value("memories.delete", &req) {
            Ok(_) => {
                if was_editing {
                    self.reset_memory_draft();
                }
                self.load_memories();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    fn refresh_chat(&mut self) -> Result<(), ChatRouteError> {
        let Some(chat_id) = self.chat_id.clone() else {
            return Ok(());
        };
        match self.call_decode("chats.get", &RequestGetChat { chat_id }, decode_chat_dto) {
            Ok(chat) => {
                self.state.chat = Some(chat);
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    fn list_messages(
        &mut self,
        chat_id: &str,
        cursor: Option<String>,
    ) -> Result<PagedMessages, ChatRouteError> {
        self.call_decode(
            "chats.messages.list",
            &RequestListMessages {
                chat_id: chat_id.to_string(),
                cursor,
                limit: Some(PAGE_LIMIT),
                order: Some("desc".into()),
            },
            decode_paged_messages,
        )
    }

    fn absorb_latest_page(&mut self, page: PagedMessages) {
        self.state.next_cursor = page.next_cursor;
        let mut items = page.items;
        items.reverse();
        for message in items {
            self.push_unique(message);
        }
    }

    fn absorb_older_page(&mut self, page: PagedMessages) {
        self.state.next_cursor = page.next_cursor;
        let mut older = page.items;
        older.reverse();
        older.retain(|message| !self.state.messages.iter().any(|row| row.id == message.id));
        older.append(&mut self.state.messages);
        self.state.messages = older;
    }

    fn start_stream_op<T: Serialize>(
        &mut self,
        operation_id: &str,
        payload: &T,
    ) -> Result<(), ChatRouteError> {
        assert_registered_command(operation_id)?;
        self.issued.push(operation_id.to_string());
        self.state.last_operation_id = Some(operation_id.to_string());
        let value = serde_json::to_value(payload)?;
        match self.wire.start_stream(operation_id, value) {
            Ok(handle) => {
                self.state.stream_handle = Some(handle.clone());
                self.state.active_run_id = Some(handle);
                self.state.streaming_text.clear();
                self.state.tool_activity_name = None;
                self.state.last_applied_stream_sequence = None;
                self.state.last_checkpoint_sequence = None;
                self.state.last_error = None;
                self.drain_stream()
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    fn call_decode<T: Serialize, R: DeserializeOwned>(
        &mut self,
        operation_id: &str,
        payload: &T,
        decode: fn(&[u8]) -> Result<R, contracts_generated::WireError>,
    ) -> Result<R, ChatRouteError> {
        let value = self.call_value(operation_id, payload)?;
        let bytes = serde_json::to_vec(&value)?;
        decode(&bytes).map_err(|err| ChatRouteError::Wire(err.message))
    }

    fn call_value<T: Serialize>(
        &mut self,
        operation_id: &str,
        payload: &T,
    ) -> Result<Value, ChatRouteError> {
        assert_registered_command(operation_id)?;
        self.issued.push(operation_id.to_string());
        self.state.last_operation_id = Some(operation_id.to_string());
        let value = serde_json::to_value(payload)?;
        let call = self.wire.call(operation_id, value)?;
        self.state.last_request_id = Some(call.request_id);
        Ok(call.result)
    }

    fn bump_scene(&mut self) {
        self.state.scene_epoch = self.state.scene_epoch.saturating_add(1);
    }

    fn note_durable(&mut self, message: &MessageDto) {
        let is_new = !self.state.messages.iter().any(|row| row.id == message.id);
        self.push_unique(message.clone());
        self.state.last_durable_message_id = Some(message.id.clone());
        if is_new {
            self.bump_scene();
        }
    }

    fn push_unique(&mut self, message: MessageDto) {
        if self.state.messages.iter().any(|row| row.id == message.id) {
            return;
        }
        self.state.messages.push(message);
        self.state.messages.sort_by_key(|row| row.sequence);
    }

    fn last_run_id(&self) -> Option<&str> {
        self.state.active_run_id.as_deref().or_else(|| {
            self.state
                .messages
                .iter()
                .rev()
                .find_map(|row| row.generation_run_id.as_deref())
        })
    }

    fn record_error(&mut self, err: ChatRouteError) {
        match err {
            ChatRouteError::Product(dto) => self.state.last_error = Some(dto),
            other => {
                self.state.last_error = Some(ErrorDto {
                    code: other.reason_code(),
                    params: json!({ "message": other.to_string() }),
                    trace_id: None,
                    correlation_id: None,
                });
            }
        }
    }
}

/// React `ChatPage.send` `/^\/([^\s]+)(?:\s+(.*))?$/`: first token after `/`,
/// or the whole text when the command name is empty (`/`).
fn slash_command_name(message: &str) -> String {
    let rest = message.strip_prefix('/').unwrap_or(message);
    let name = rest.split_whitespace().next().unwrap_or("");
    if name.is_empty() {
        message.to_string()
    } else {
        name.to_string()
    }
}

fn settings_string(items: &[SettingsItem], key: &str) -> Option<String> {
    let item = items.iter().find(|row| row.key == key)?;
    if let Some(text) = item.value.as_str() {
        return Some(text.to_string());
    }
    let obj = item.value.as_object()?;
    obj.get("value")
        .and_then(Value::as_str)
        .or_else(|| obj.get("locale").and_then(Value::as_str))
        .map(str::to_string)
}

fn settings_unwrapped<'a>(items: &'a [SettingsItem], key: &str) -> Option<&'a Value> {
    let item = items.iter().find(|row| row.key == key)?;
    let value = &item.value;
    if let Some(obj) = value.as_object() {
        if obj.len() == 1 && obj.contains_key("value") {
            return obj.get("value");
        }
    }
    Some(value)
}

/// Host-owned text-completion block ids (`PromptBlockIds` in contracts).
const PROMPT_BLOCK_IDS: &[&str] = &[
    "main-prompt",
    "world-info-before",
    "persona",
    "character-description",
    "character-personality",
    "scenario",
    "world-info-after",
    "dialogue-examples",
    "memory",
    "authors-note",
    "chat-history",
    "post-history-instructions",
];

/// React `PromptBlockEditorDialog` role `<select>` — not the full
/// `MessageRole` union (`tool` / `plugin` stay off the authoring menu).
const PROMPT_BLOCK_ROLES: &[&str] = &["system", "user", "assistant"];

const PROMPT_TRIGGER_IDS: &[&str] = &[
    "normal",
    "continue",
    "impersonate",
    "swipe",
    "regenerate",
    "quiet",
];

/// English golden copy (`settings:invalidPromptTemplatePreset`).
const INVALID_PROMPT_TEMPLATE_PRESET: &str = "This file is not a valid prompt template preset.";
/// English golden copy (`settings:invalidGenerationPreset`).
const INVALID_GENERATION_PRESET: &str = "This file is not a valid generation preset.";
const CONTEXT_TOKEN_MIN: i64 = 256;
const CONTEXT_TOKEN_DEFAULT: i64 = 16_032;
const CONTEXT_TOKEN_DEFAULT_MAX: i64 = 200_000;
const CONTEXT_TOKEN_UNLOCKED_MAX: i64 = 10_000_000;

struct SamplerBound {
    id: &'static str,
    min: f64,
    max: f64,
    step: f64,
    integer: bool,
}

/// Mirrors `GENERATION_PARAMETER_BOUNDS` in `packages/contracts/src/provider.ts`.
const SAMPLER_BOUNDS: &[SamplerBound] = &[
    SamplerBound {
        id: "maxTokens",
        min: 1.0,
        max: 200_000.0,
        step: 1.0,
        integer: true,
    },
    SamplerBound {
        id: "temperature",
        min: 0.0,
        max: 2.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "topP",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "topK",
        min: 0.0,
        max: 100_000.0,
        step: 1.0,
        integer: true,
    },
    SamplerBound {
        id: "minP",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "topA",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "repetitionPenalty",
        min: 0.0,
        max: 2.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "frequencyPenalty",
        min: -2.0,
        max: 2.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "presencePenalty",
        min: -2.0,
        max: 2.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "seed",
        min: -1.0,
        max: 2_147_483_647.0,
        step: 1.0,
        integer: true,
    },
];

fn sampler_bound(id: &str) -> Option<&'static SamplerBound> {
    SAMPLER_BOUNDS.iter().find(|bound| bound.id == id)
}

fn parse_sampler_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "-" || trimmed == "." || trimmed == "-." {
        return None;
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn clamp_sampler_number(id: &str, raw: f64, unlocked: bool) -> f64 {
    if id == "maxContextTokens" {
        let max = if unlocked {
            CONTEXT_TOKEN_UNLOCKED_MAX
        } else {
            CONTEXT_TOKEN_DEFAULT_MAX
        };
        return raw.round().clamp(CONTEXT_TOKEN_MIN as f64, max as f64);
    }
    let Some(bound) = sampler_bound(id) else {
        return raw;
    };
    let stepped = ((raw - bound.min) / bound.step).round() * bound.step + bound.min;
    let clamped = stepped.clamp(bound.min, bound.max);
    (clamped * 1e10).round() / 1e10
}

fn format_sampler_number(value: f64, integer: bool) -> String {
    if integer || value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value:.2}")
    }
}

fn merge_preset_defaults(value: &Value) -> PresetGenerationDefaults {
    let mut merged = PresetGenerationDefaults::default();
    let Ok(incoming) = serde_json::from_value::<PresetGenerationDefaults>(value.clone()) else {
        return merged;
    };
    if let Some(obj) = value.as_object() {
        if obj.contains_key("maxTokens") {
            merged.max_tokens = incoming.max_tokens;
        }
        if obj.contains_key("temperature") {
            merged.temperature = incoming.temperature;
        }
        if obj.contains_key("topP") {
            merged.top_p = incoming.top_p;
        }
        if obj.contains_key("topK") {
            merged.top_k = incoming.top_k;
        }
        if obj.contains_key("minP") {
            merged.min_p = incoming.min_p;
        }
        if obj.contains_key("topA") {
            merged.top_a = incoming.top_a;
        }
        if obj.contains_key("repetitionPenalty") {
            merged.repetition_penalty = incoming.repetition_penalty;
        }
        if obj.contains_key("frequencyPenalty") {
            merged.frequency_penalty = incoming.frequency_penalty;
        }
        if obj.contains_key("presencePenalty") {
            merged.presence_penalty = incoming.presence_penalty;
        }
        if obj.contains_key("seed") {
            merged.seed = incoming.seed;
        }
        if obj.contains_key("reasoning") {
            merged.reasoning = incoming.reasoning;
        }
        if obj.contains_key("stream") {
            merged.stream = incoming.stream;
        }
    }
    merged
}

fn merge_preset_defaults_value(value: &Value) -> Value {
    serde_json::to_value(merge_preset_defaults(value)).unwrap_or_else(|_| json!({}))
}

/// Mirrors `DEFAULT_PROMPT_TEMPLATE` in `packages/contracts/src/promptTemplate.ts`.
fn default_prompt_template() -> Value {
    let blocks: Vec<Value> = PROMPT_BLOCK_IDS
        .iter()
        .map(|id| {
            if *id == "main-prompt" {
                json!({
                    "id": id,
                    "enabled": true,
                    "role": "system",
                    "content": "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
                    "injectionPosition": "relative",
                    "triggers": PROMPT_TRIGGER_IDS,
                    "forbidOverrides": false,
                })
            } else {
                json!({ "id": id, "enabled": true })
            }
        })
        .collect();
    json!({
        "mode": "chat",
        "blocks": blocks,
        "postHistoryInstructions": "Keep the roleplay engaging. Drive the story forward proactively while staying in character.",
    })
}

fn prompt_block_label(id: &str) -> String {
    match id {
        "main-prompt" => "Main Prompt",
        "world-info-before" => "World Info (before)",
        "persona" => "Persona",
        "character-description" => "Character Description",
        "character-personality" => "Character Personality",
        "scenario" => "Scenario",
        "world-info-after" => "World Info (after)",
        "dialogue-examples" => "Dialogue Examples",
        "memory" => "Memory",
        "authors-note" => "Author\u{2019}s Note",
        "chat-history" => "Chat History",
        "post-history-instructions" => "Post-History Instructions",
        _ => "Custom Prompt",
    }
    .into()
}

fn prompt_block_content_editable(id: &str) -> bool {
    !PROMPT_BLOCK_IDS.contains(&id) || matches!(id, "main-prompt" | "post-history-instructions")
}

fn prompt_block_injection_position(block: &Value) -> &'static str {
    match block.get("injectionPosition").and_then(Value::as_str) {
        Some("in-chat") => "in-chat",
        _ => "relative",
    }
}

fn prompt_block_role(block: &Value) -> &'static str {
    prompt_block_role_draft(block.get("role").and_then(Value::as_str).unwrap_or(""))
}

fn prompt_block_role_draft(role: &str) -> &'static str {
    match role {
        "user" => "user",
        "assistant" => "assistant",
        _ => "system",
    }
}

fn default_prompt_block_triggers() -> Vec<String> {
    PROMPT_TRIGGER_IDS
        .iter()
        .map(|id| (*id).to_string())
        .collect()
}

fn prompt_block_triggers(block: &Value) -> Vec<String> {
    match block.get("triggers").and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| PROMPT_TRIGGER_IDS.contains(id))
            .map(str::to_string)
            .collect(),
        None => default_prompt_block_triggers(),
    }
}

fn prompt_block_forbid_overrides(block: &Value) -> bool {
    block
        .get("forbidOverrides")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn prompt_block_model(block: &Value) -> String {
    clamp_prompt_block_model(block.get("model").and_then(Value::as_str).unwrap_or(""))
}

fn clamp_prompt_block_model(value: &str) -> String {
    value.chars().take(256).collect()
}

fn prompt_block_u32(block: &Value, key: &str, default: u32) -> u32 {
    block
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n.min(9999) as u32)
        .unwrap_or(default)
}

fn parse_prompt_injection_u32(raw: &str, default: u32) -> u32 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return default;
    }
    trimmed
        .parse::<u32>()
        .ok()
        .map(|n| n.min(9999))
        .unwrap_or(default)
}

fn sanitize_prompt_int_draft(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(4)
        .collect()
}

/// Sequential `custom-N` ids that satisfy `CustomPromptBlockIdSchema`
/// (`^custom-[A-Za-z0-9][A-Za-z0-9._-]*$`, minLength 8). React uses UUID;
/// the native host stays deterministic without a `uuid` crate.
fn next_custom_prompt_id(blocks: &[Value]) -> String {
    let mut n = 1u32;
    loop {
        let candidate = format!("custom-{n}");
        let taken = blocks
            .iter()
            .any(|block| block.get("id").and_then(Value::as_str) == Some(candidate.as_str()));
        if !taken {
            return candidate;
        }
        n = n.saturating_add(1);
        if n == u32::MAX {
            return "custom-overflow".into();
        }
    }
}

fn is_terminal_prompt_block_id(id: &str) -> bool {
    matches!(id, "chat-history" | "post-history-instructions")
}

fn prompt_block_json_id(block: &Value) -> Option<&str> {
    block.get("id").and_then(Value::as_str)
}

/// React `normalizePromptBlockOrder`: movable blocks first, then the two
/// terminal anchors in semantic order.
fn normalize_prompt_block_order(blocks: Vec<Value>) -> Vec<Value> {
    let mut movable = Vec::new();
    let mut chat_history = None;
    let mut post_history = None;
    for block in blocks {
        match block.get("id").and_then(Value::as_str) {
            Some("chat-history") if chat_history.is_none() => chat_history = Some(block),
            Some("post-history-instructions") if post_history.is_none() => {
                post_history = Some(block)
            }
            _ => movable.push(block),
        }
    }
    movable.extend(chat_history);
    movable.extend(post_history);
    movable
}

/// React `PromptTemplateEditor.reorderBlocks`. `from`/`to` index the
/// normalized full list; terminals stay pinned after the movable prefix.
fn reorder_prompt_blocks(blocks: Vec<Value>, from: usize, to: usize) -> Vec<Value> {
    let normalized = normalize_prompt_block_order(blocks);
    let Some(moved_id) = normalized
        .get(from)
        .and_then(prompt_block_json_id)
        .map(str::to_string)
    else {
        return normalized;
    };
    if is_terminal_prompt_block_id(&moved_id) {
        return normalized;
    }
    let target_id = normalized
        .get(to)
        .and_then(prompt_block_json_id)
        .map(str::to_string);
    let mut movable: Vec<Value> = normalized
        .iter()
        .filter(|block| {
            prompt_block_json_id(block).is_some_and(|id| !is_terminal_prompt_block_id(id))
        })
        .cloned()
        .collect();
    let Some(from_movable) = movable
        .iter()
        .position(|block| prompt_block_json_id(block) == Some(moved_id.as_str()))
    else {
        return normalized;
    };
    let Some(target_movable) = (match target_id.as_deref() {
        Some(id) if is_terminal_prompt_block_id(id) => Some(movable.len().saturating_sub(1)),
        Some(id) => movable
            .iter()
            .position(|block| prompt_block_json_id(block) == Some(id)),
        None => Some(from_movable),
    }) else {
        return normalized;
    };
    let removed = movable.remove(from_movable);
    let insert_at = target_movable.min(movable.len());
    movable.insert(insert_at, removed);
    let terminals: Vec<Value> = normalized
        .iter()
        .filter(|block| prompt_block_json_id(block).is_some_and(is_terminal_prompt_block_id))
        .cloned()
        .collect();
    normalize_prompt_block_order(movable.into_iter().chain(terminals).collect())
}

fn prompt_block_views(template: &Value) -> Vec<PromptBlockView> {
    let Some(blocks) = template.get("blocks").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut views: Vec<PromptBlockView> = blocks
        .iter()
        .filter_map(|block| {
            let id = block.get("id")?.as_str()?.to_string();
            let enabled = block
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| prompt_block_label(&id));
            let custom = !PROMPT_BLOCK_IDS.contains(&id.as_str());
            let injection_in_chat = prompt_block_injection_position(block) == "in-chat";
            let injection_depth = prompt_block_u32(block, "injectionDepth", 4);
            Some(PromptBlockView {
                id,
                name,
                enabled,
                custom,
                can_move_up: false,
                can_move_down: false,
                injection_in_chat,
                injection_depth,
            })
        })
        .collect();
    let n = views.len();
    for i in 0..n {
        let terminal = is_terminal_prompt_block_id(&views[i].id);
        let next_terminal = views
            .get(i + 1)
            .is_some_and(|next| is_terminal_prompt_block_id(&next.id));
        views[i].can_move_up = !terminal && i > 0;
        views[i].can_move_down = !terminal && i + 1 < n && !next_terminal;
    }
    views
}

fn prompt_template_is_complete(template: &Value) -> bool {
    let Some(blocks) = template.get("blocks").and_then(Value::as_array) else {
        return false;
    };
    if blocks.len() < PROMPT_BLOCK_IDS.len() {
        return false;
    }
    let ids: Vec<&str> = blocks
        .iter()
        .filter_map(|block| block.get("id").and_then(Value::as_str))
        .collect();
    if ids.len() != blocks.len() {
        return false;
    }
    if !PROMPT_BLOCK_IDS.iter().all(|id| ids.contains(id)) {
        return false;
    }
    let n = ids.len();
    ids[n - 2] == "chat-history" && ids[n - 1] == "post-history-instructions"
}

/// React `PromptTemplateEditor.importPreset`: envelope `{ data, name }` or a
/// bare template object. Forces `mode: "text"` and requires the 12 host-owned
/// ids with terminal anchors last.
fn parse_prompt_template_import(bytes: &[u8], fallback_name: &str) -> Option<(String, Value)> {
    let raw: Value = serde_json::from_slice(bytes).ok()?;
    let (imported_name, mut candidate) = if let Some(obj) = raw.as_object() {
        if obj.contains_key("data") {
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(fallback_name);
            (name.to_string(), obj.get("data")?.clone())
        } else {
            (fallback_name.to_string(), raw)
        }
    } else {
        return None;
    };
    if !candidate.is_object() {
        return None;
    }
    if let Some(obj) = candidate.as_object_mut() {
        obj.insert("mode".into(), json!("text"));
    }
    if !prompt_template_is_complete(&candidate) {
        return None;
    }
    let trimmed = imported_name.trim();
    let name = if trimmed.is_empty() {
        "prompt-template".to_string()
    } else {
        trimmed.chars().take(500).collect()
    };
    Some((name, candidate))
}

fn json_export_filename(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    let base = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    let mut safe = String::new();
    for ch in base.chars() {
        if safe.len() >= 80 {
            break;
        }
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            safe.push('-');
        } else if !ch.is_control() {
            safe.push(ch);
        }
    }
    if safe.is_empty() {
        format!("{fallback}.json")
    } else {
        format!("{safe}.json")
    }
}

/// React `GenerationPresetEditor.importPreset`: envelope `{ data, name }` or a
/// bare `GenerationPresetData` object. `maxContextTokens` must sit in the
/// contract range; `generationDefaults` is a required object.
fn parse_generation_preset_import(bytes: &[u8], fallback_name: &str) -> Option<(String, Value)> {
    let raw: Value = serde_json::from_slice(bytes).ok()?;
    let (imported_name, candidate) = if let Some(obj) = raw.as_object() {
        if obj.contains_key("data") {
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(fallback_name);
            (name.to_string(), obj.get("data")?.clone())
        } else {
            (fallback_name.to_string(), raw)
        }
    } else {
        return None;
    };
    if !generation_preset_data_is_valid(&candidate) {
        return None;
    }
    let trimmed = imported_name.trim();
    let name = if trimmed.is_empty() {
        "generation".to_string()
    } else {
        trimmed.chars().take(500).collect()
    };
    Some((name, candidate))
}

fn generation_preset_data_is_valid(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    if obj
        .keys()
        .any(|key| key != "maxContextTokens" && key != "generationDefaults")
    {
        return false;
    }
    let Some(tokens) = obj.get("maxContextTokens").and_then(Value::as_i64) else {
        return false;
    };
    if !(CONTEXT_TOKEN_MIN..=CONTEXT_TOKEN_UNLOCKED_MAX).contains(&tokens) {
        return false;
    }
    match obj.get("generationDefaults") {
        Some(Value::Object(defaults)) => {
            const ALLOWED: &[&str] = &[
                "maxTokens",
                "temperature",
                "topP",
                "topK",
                "minP",
                "topA",
                "repetitionPenalty",
                "frequencyPenalty",
                "presencePenalty",
                "seed",
                "reasoning",
                "reasoningEffort",
                "stop",
                "stream",
            ];
            defaults.keys().all(|key| ALLOWED.contains(&key.as_str()))
        }
        _ => false,
    }
}

fn default_custom_instruct() -> Value {
    json!({
        "id": "custom-chatml",
        "version": 1,
        "system": "<|im_start|>system\n{{{content}}}<|im_end|>\n",
        "user": "<|im_start|>user\n{{{content}}}<|im_end|>\n",
        "assistant": "<|im_start|>assistant\n{{{content}}}<|im_end|>\n",
        "tool": "<|im_start|>tool\n{{{content}}}<|im_end|>\n",
        "promptSuffix": "<|im_start|>assistant\n",
        "stopStrings": ["<|im_end|>"],
    })
}

fn instruct_role_text(format: &Option<Value>, key: &str) -> String {
    format
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn instruct_stop_text(format: &Option<Value>) -> String {
    format
        .as_ref()
        .and_then(|value| value.get("stopStrings"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn virtualized_window(
    messages: &[MessageDto],
    viewport_height: f64,
    scroll_from_bottom_css: f64,
    assistant_author: &str,
    macros: &crate::macros::MacroContext,
) -> (Vec<VisibleRow>, PresentOutcome) {
    let mut index = HeightIndex::new();
    for message in messages {
        let _ = index.push(
            LogicalItemId(message.sequence as u64),
            estimate_height(message),
            HeightKind::Estimated,
        );
    }
    let viewport_height = viewport_height.max(1.0);
    let extent = index.extent();
    if messages.is_empty() || extent <= viewport_height {
        return (
            visible_rows(messages, assistant_author, macros),
            PresentOutcome {
                decision: PresentDecision::Prepared,
                blank_px: 0.0,
                waited_on_producer: false,
                snapshot: GeometrySnapshot::empty(),
            },
        );
    }
    let mut viewport = ViewportSession::new(
        index,
        PredictorBudgets::default(),
        TileCache::new(64, 256 * 1024),
        viewport_height,
        8_333_333,
    );
    let extent = viewport.index().extent();
    let budget = (extent - viewport_height).max(0.0);
    let scroll = scroll_from_bottom_css.max(0.0).min(budget);
    viewport.teleport(budget - scroll);
    let outcome = viewport.present();
    let start = viewport.offset();
    let span = viewport
        .index()
        .span_covering(start, start + viewport_height);
    let mut visible = Vec::new();
    for i in span.start..span.end {
        if let Some((id, _, _)) = viewport.index().height_at(i) {
            if let Some(message) = messages.iter().find(|row| row.sequence as u64 == id.0) {
                visible.push(message_visible_row(message, assistant_author, macros));
            }
        }
    }
    if visible.is_empty() {
        visible = visible_rows(messages, assistant_author, macros);
    }
    (visible, outcome)
}

fn estimate_height(message: &MessageDto) -> f64 {
    48.0 + (message.content.len() as f64 / 8.0).min(160.0)
}

fn visible_rows(
    messages: &[MessageDto],
    assistant_author: &str,
    macros: &crate::macros::MacroContext,
) -> Vec<VisibleRow> {
    let start = messages.len().saturating_sub(PRODUCT_PATH_VISIBLE);
    messages[start..]
        .iter()
        .map(|row| message_visible_row(row, assistant_author, macros))
        .collect()
}

fn message_visible_row(
    message: &MessageDto,
    assistant_author: &str,
    macros: &crate::macros::MacroContext,
) -> VisibleRow {
    let content = crate::macros::replace_macros(&message.content, macros);
    let model = message
        .meta
        .payload
        .get("generation")
        .and_then(|g| g.get("model"))
        .and_then(|m| m.as_str())
        .or_else(|| message.meta.payload.get("model").and_then(|m| m.as_str()))
        .map(|s| s.to_string());
    let generation_time = message
        .meta
        .payload
        .get("generation")
        .and_then(|g| g.get("durationMs"))
        .and_then(|d| d.as_u64())
        .map(|ms| format!("{:.1}s", ms as f64 / 1000.0));
    let token_count = message
        .meta
        .payload
        .get("generation")
        .and_then(|g| g.get("usage"))
        .and_then(|u| u.get("totalTokens"))
        .and_then(|t| t.as_i64())
        .or_else(|| message.meta.payload.get("tokenCount").and_then(|t| t.as_i64()))
        .or_else(|| message.meta.payload.get("tokens").and_then(|t| t.as_i64()));
    VisibleRow {
        id: message.id.clone(),
        role: role_name(&message.role).into(),
        content: content.clone(),
        kind: row_kind(&content),
        author: if message.role == MessageRole::User {
            "You".into()
        } else {
            assistant_author.to_string()
        },
        timestamp: neotavern_presentation_dioxus_shell::format_timestamp(&message.created_at),
        run_id: message.generation_run_id.clone(),
        manual_excluded: manual_excluded(&message.meta),
        checkpoint_chat_id: message.checkpoint_chat_id.clone(),
        // React `MessageSwipePager` counter ("N/M"). Kernel-plane messages do
        // not carry the legacy permutation fields (translateMessage reports
        // 0/null) — the label hydrates from the variants cache in `view()`,
        // exactly like the React query-derived `currentSwipe`.
        swipe_label: String::new(),
        model,
        generation_time,
        token_count,
    }
}

fn pick_active_persona<'a>(
    personas: &'a [PersonaDto],
    chat_persona_id: Option<&str>,
    app_persona_id: Option<&str>,
) -> Option<&'a PersonaDto> {
    if let Some(id) = chat_persona_id {
        if let Some(row) = personas.iter().find(|item| item.id == id) {
            return Some(row);
        }
    }
    if let Some(id) = app_persona_id {
        if let Some(row) = personas.iter().find(|item| item.id == id) {
            return Some(row);
        }
    }
    personas.iter().find(|item| item.is_default)
}

fn settings_macro_variables(items: &[SettingsItem]) -> HashMap<String, String> {
    let Some(value) = settings_unwrapped(items, "macro-variables") else {
        return HashMap::new();
    };
    let Some(obj) = value.as_object() else {
        return HashMap::new();
    };
    obj.iter()
        .filter_map(|(key, item)| item.as_str().map(|text| (key.clone(), text.to_string())))
        .collect()
}

pub(crate) fn role_name(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::Tool => "tool",
    }
}

pub(crate) fn row_kind(content: &str) -> RowKind {
    let image = content.contains("![");
    let markdown = content.contains("**") || content.contains('\n');
    match (image, markdown) {
        (true, true) => RowKind::Mixed,
        (true, false) => RowKind::Image,
        _ => RowKind::Markdown,
    }
}

/// Script-aware token estimation, ported from
/// `packages/shared/src/estimateTokens.ts` (the shared isomorphic fallback
/// counter). Measured densities: Latin ~5.1 chars/token, Cyrillic ~4.0,
/// CJK ~1.7, digits ~2.0, punctuation/space ~3.0, emoji ~1.1. Contributes
/// `1/rate` per character so mixed text stays within a few percent of the
/// exact tokenizer.
fn estimate_tokens(text: &str) -> u64 {
    const EMOJI_RATE: f64 = 1.1;
    const CJK_RATE: f64 = 1.7;
    const CYRILLIC_RATE: f64 = 4.0;
    const DIGIT_RATE: f64 = 2.0;
    const LETTER_RATE: f64 = 4.6;
    const OTHER_RATE: f64 = 3.0;
    let mut tokens = 0.0f64;
    for ch in text.chars() {
        let rate = if is_emoji(ch) {
            EMOJI_RATE
        } else if is_cjk(ch) {
            CJK_RATE
        } else if ('\u{0400}'..='\u{04FF}').contains(&ch) {
            CYRILLIC_RATE
        } else if ch.is_ascii_digit() {
            DIGIT_RATE
        } else if ch.is_alphabetic() {
            LETTER_RATE
        } else {
            OTHER_RATE
        };
        tokens += 1.0 / rate;
    }
    tokens.round() as u64
}

fn is_emoji(ch: char) -> bool {
    ('\u{1F000}'..='\u{1FAFF}').contains(&ch)
        || ('\u{2600}'..='\u{27BF}').contains(&ch)
        || ('\u{FE00}'..='\u{FE0F}').contains(&ch)
        || ('\u{1F1E6}'..='\u{1F1FF}').contains(&ch)
}

fn is_cjk(ch: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&ch)
        || ('\u{3400}'..='\u{4DBF}').contains(&ch)
        || ('\u{3040}'..='\u{30FF}').contains(&ch)
        || ('\u{AC00}'..='\u{D7AF}').contains(&ch)
}

fn manual_excluded(meta: &FreeObject) -> bool {
    meta.payload.get("manualExcluded") == Some(&Value::Bool(true))
}

/// Variant picker row preview (React `PREVIEW_MAX_LENGTH = 140`): the first
/// 140 characters of the variant content — a byte-safe char-bounded slice.
fn preview_text(content: &str) -> String {
    content.chars().take(140).collect()
}

fn with_manual_excluded(meta: &FreeObject, excluded: bool) -> FreeObject {
    let mut payload = meta.payload.clone();
    match &mut payload {
        Value::Object(map) => {
            map.insert("manualExcluded".into(), json!(excluded));
        }
        _ => {
            payload = json!({ "manualExcluded": excluded });
        }
    }
    FreeObject { payload }
}

/// Non-overlapping case-insensitive count, matching React `ChatHeader`
/// `countTextMatches` (`indexOf` loop).
fn count_text_matches(text: &str, query: &str) -> u64 {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return 0;
    }
    let haystack = text.to_lowercase();
    let mut count = 0u64;
    let mut offset = 0usize;
    while offset < haystack.len() {
        let Some(found) = haystack[offset..].find(&needle) else {
            break;
        };
        count += 1;
        offset += found + needle.len();
        if needle.is_empty() {
            break;
        }
    }
    count
}

fn run_step_from_envelope(
    envelope: contracts_generated::generated::EventEnvelope,
) -> Option<RunStepView> {
    if envelope.r#type != "generation.step" {
        return None;
    }
    let event: GenerationEvent = serde_json::from_value(envelope.payload).ok()?;
    let GenerationEvent::GenerationStep { step } = event else {
        return None;
    };
    let step_type = match step.r#type {
        contracts_generated::generated::GenerationStepType::ProviderTurn => "provider_turn",
        contracts_generated::generated::GenerationStepType::ToolCall => "tool_call",
        contracts_generated::generated::GenerationStepType::ToolResult => "tool_result",
        contracts_generated::generated::GenerationStepType::FinalCommit => "final_commit",
    };
    let status = match step.status {
        contracts_generated::generated::GenerationStepStatus::Running => "running",
        contracts_generated::generated::GenerationStepStatus::Waiting => "waiting",
        contracts_generated::generated::GenerationStepStatus::Completed => "completed",
        contracts_generated::generated::GenerationStepStatus::Failed => "failed",
    };
    Some(RunStepView {
        sequence: step.sequence,
        step_type: step_type.into(),
        status: status.into(),
        attempt: step.attempt,
        created_at: step.created_at,
    })
}

/// React `ChatPage.onStep`: a waiting `tool_call` stores only
/// `step.input.toolCall.name` (fallback `"tool"`). Any other step type, or a
/// non-waiting tool_call, clears the badge. Arguments and results are never
/// copied into session state (SEC-07).
fn apply_generation_step(
    state: &mut ChatRouteState,
    step: &contracts_generated::generated::GenerationStep,
) {
    use contracts_generated::generated::{GenerationStepStatus, GenerationStepType};
    match step.r#type {
        GenerationStepType::ToolCall if matches!(step.status, GenerationStepStatus::Waiting) => {
            state.tool_activity_name = Some(tool_call_display_name(&step.input));
        }
        _ => {
            state.tool_activity_name = None;
        }
    }
}

fn tool_call_display_name(input: &Option<Value>) -> String {
    input
        .as_ref()
        .and_then(|value| value.get("toolCall"))
        .and_then(|value| value.get("name"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("tool")
        .to_string()
}
