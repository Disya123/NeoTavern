use contracts_generated::generated::{
    CharacterDto, ChatDto, ErrorDto, GenerationEvent, LorebookDto, LorebookEntryDto,
    LorebookEntryInput, LorebookEntryPatch, MessageDraftDto, MessageDto, MessageRole,
    PagedCharacters, PagedChats, PagedMessages, PersonaDto, PluginsItem, RequestAssetsContent,
    RequestCancelGeneration, RequestCreateCharacter, RequestCreateChat, RequestCreateLorebook,
    RequestCreateLorebookEntry, RequestCreateMessage, RequestCreatePersona, RequestDeleteCharacter,
    RequestDeleteLorebook, RequestDeleteLorebookEntry, RequestDeleteMessage, RequestDeletePersona,
    RequestEmpty, RequestGetCharacter, RequestGetChat, RequestListCharacters, RequestListChats,
    RequestListLorebookEntries, RequestListLorebooks, RequestListMessages, RequestListPresets,
    RequestMessageDraftCommit, RequestMessageDraftDiscard, RequestMessageDraftGet,
    RequestMessageDraftSave, RequestMessageVariantActivate, RequestMessageVariantsList,
    RequestPluginsDisable, RequestPluginsEnable, RequestPluginsUninstall,
    RequestRetryGeneration, RequestSettingsGet, RequestSnapshotsRollback, RequestStartGeneration,
    RequestUpdateCharacter, RequestUpdateLorebookEntry, RequestProfileExport, RequestProfilesCreate,
    RequestProfilesDelete, RequestProfilesRename, RequestUpdateChat, RequestDeleteChat,
    RequestGetPromptPlan, ResultAssetsContent,
    ResultListLorebookEntries, ResultListLorebooks, ResultListPersonas, ResultListPresets,
    ResultListProviders, ResultPluginsList, ResultProfileExport, ResultProfilesCreate,
    ResultProfilesList, ResultSettings, SettingsItem, decode_character_dto,
    decode_chat_dto, decode_lorebook_dto, decode_lorebook_entry_dto, decode_message_draft_dto,
    decode_message_dto, decode_paged_characters, decode_paged_chats, decode_paged_messages,
    decode_persona_dto, decode_prompt_plan, decode_result_assets_content,
    decode_result_list_lorebook_entries,
    decode_result_list_lorebooks, decode_result_list_personas, decode_result_list_presets,
    decode_result_list_providers, decode_result_message_variant_list, decode_result_plugins_list,
    decode_result_profile_export, decode_result_profiles_create, decode_result_profiles_list,
    decode_result_settings, decode_result_snapshots_rollback, ProfilesItem, PromptPlan,
    ResultThemesList, RequestThemesActivate, RequestThemesUninstall, ThemesItem,
    decode_result_themes_list, decode_themes_item, ResultSecretsLock, ResultSecretsStatus,
    decode_result_secrets_lock, decode_result_secrets_status, ResultListTools, ToolSpec,
    decode_result_list_tools, RequestSettingsUpdate, RequestSettingsUpdateSettings,
    BackupDto, ResultBackupsRestore, RequestBackupsRestore, decode_backup_dto,
    decode_result_list_backups, decode_result_backups_restore,
    MemoryDto, MemoryScope, RequestListMemories, RequestCreateMemory, RequestUpdateMemory,
    RequestDeleteMemory, decode_result_list_memories, decode_memory_dto,
    PresetDto, RequestCreatePreset, RequestUpdatePreset, RequestDeletePreset, decode_preset_dto,
};
use neotavern_chat_viewport::{
    GeometrySnapshot, HeightIndex, HeightKind, LogicalItemId, PredictorBudgets, PresentDecision,
    PresentOutcome, TileCache, ViewportSession,
};
use neotavern_presentation_dioxus_shell::{
    assert_registered_command, chrome_metrics, mount_product_chat, CharacterCardView,
    CharacterDraftView, ChatCardView, ContextUsageBreakdownV1, ContextUsageSummaryV1,
    LorebookCardView, LorebookEntryCardView, PersonaCardView, PluginCardView, PresetCardView,
    ProfileCardView,
    ProductChatView, ProductChrome, ProductShellView, ProviderCardView, RowKind, SafeAreaInsets,
    ThemeCardView, ToolCardView, VisibleRow, PRODUCT_PATH_VISIBLE,
    BackupCardView, MemoryCardView, PresetValueRow,
};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

use crate::error::ChatRouteError;
use crate::shell_hit::{ShellAction, next_sort};
use crate::wire::{PAGE_LIMIT, ProductWire, StreamFrame};

/// Bounded CPU avatar thumbnail cache: one entry per `asset_id` is shared by
/// header and card, evicted LRU under a byte budget and wired to the same
/// pressure signal as the GPU cache.
pub const AVATAR_CPU_MAX_ENTRIES: usize = 64;
pub const AVATAR_CPU_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Parsed `GenerationPresetData` contract subset used for the Config tab
/// draft display and settings persistence (React `GenerationPresetEditor`).
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct PresetGenerationData {
    #[serde(rename = "maxContextTokens", default)]
    max_context_tokens: i64,
    #[serde(rename = "generationDefaults", default)]
    generation_defaults: PresetGenerationDefaults,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
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

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatRouteState {
    pub chat: Option<ChatDto>,
    pub messages: Vec<MessageDto>,
    pub next_cursor: Option<String>,
    pub draft: Option<MessageDraftDto>,
    pub composer_text: String,
    pub streaming_text: String,
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
    pub status_message: Option<String>,
    pub personas: Vec<PersonaDto>,
    pub selected_persona_id: Option<String>,
    pub persona_tab: String,
    pub persona_search: String,
    pub persona_sort: String,
    pub persona_name_draft: String,
    pub persona_description_draft: String,
    pub active_persona_id: Option<String>,
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
    /// Generation draft applied through `settings.update` (React
    /// `GenerationPresetEditor`): context size plus the sampler defaults,
    /// kept as the contract JSON.
    pub preset_draft_max_context: i64,
    pub preset_draft_defaults: Value,
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
    /// Composer context-meter popover visibility (`chat.composer.context`).
    pub context_panel_open: bool,
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
        session.state.persona_tab = "cards".into();
        session.state.persona_sort = "asc".into();
        session.state.lorebook_tab = "books".into();
        session.state.language = "en".into();
        session.state.dir = "ltr".into();
        session.state.ai_tab = "providers".into();
        session.state.settings_tab = "general".into();
        session.state.context_panel_open = false;
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
                    GenerationEvent::GenerationStep { .. }
                    | GenerationEvent::ConsumerLagged { .. } => {}
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
        if let Some(workflow_id) = self.state.active_run_id.clone() {
            let _ = self.call_value(
                "generation.cancel",
                &RequestCancelGeneration { workflow_id },
            );
        }
        if let Some(handle) = self.state.stream_handle.clone() {
            let _ = self.wire.cancel_stream(&handle);
            let _ = self.drain_stream();
        }
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
    /// role plus an en-US `Intl`-style timestamp label.
    fn build_row(&self, message: &MessageDto) -> VisibleRow {
        let author = if message.role == MessageRole::User {
            "You".into()
        } else {
            self.assistant_author()
        };
        VisibleRow {
            id: message.id.clone(),
            role: role_name(&message.role).into(),
            content: message.content.clone(),
            kind: row_kind(&message.content),
            author,
            timestamp: neotavern_presentation_dioxus_shell::format_timestamp(&message.created_at),
            run_id: message.generation_run_id.clone(),
        }
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
            });
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
            viewport_width: self.viewport_width,
            viewport_height: self.viewport_height,
            column_width: self.chat_column_width(),
            context_panel_open: self.state.context_panel_open,
            context_summary,
        }
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
            font_scale: "medium".into(),
            insets: self.state.insets,
            editor_mode: "view".into(),
            create_dialog_open: self.state.create_dialog_open,
            delete_dialog_open: self.state.delete_dialog_open,
            create_name: self.state.create_name.clone(),
            create_description: self.state.create_description.clone(),
            create_first_message: self.state.create_first_message.clone(),
            status_message: self.state.status_message.clone(),
            error_message: self.state.last_error.as_ref().map(|err| err.code.clone()),
            gallery_columns: 3,
            gallery_sort: "oldest".into(),
            expanded_greeting: None,
            tag_input: String::new(),
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
            selected_preset_id: self.state.active_preset_id.clone(),
            preset_rows: self.preset_value_rows(),
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
            backups: self
                .state
                .backups
                .iter()
                .map(|item| BackupCardView {
                    id: item.id.clone(),
                    title: item.created_at.clone(),
                    detail: format!("Manual backup · {:.1} MB", item.size_bytes as f64 / 1024.0 / 1024.0),
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
            "providers" => self.load_ai_settings(),
            "settings" => {
                self.load_settings();
                self.load_profiles();
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
        self.bump_scene();
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
                    self.state.ai_tab = tab;
                    // React `MemoryEditor` queries on mount.
                    if is_memories {
                        self.load_memories();
                    }
                    self.bump_scene();
                }
                "settings" => {
                    let is_themes = tab == "themes";
                    let is_secrets = tab == "secrets";
                    let is_tools = tab == "tools";
                    let is_data = tab == "data";
                    self.state.settings_tab = tab;
                    // React `ThemesTab` / `SecretsPanel` / `ToolsPanel` /
                    // DataTab query on mount: load when the tab opens so the
                    // surface is real, not a stub.
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
            ShellAction::Import => {
                self.state.status_message =
                    Some("Import a JSON or PNG character card from this device.".into());
                self.bump_scene();
            }
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
            ShellAction::PresetSaveAsOpen => self.open_preset_create(),
            ShellAction::PresetRenameOpen => self.open_preset_rename(),
            ShellAction::PresetNameCancel => self.close_preset_name(),
            ShellAction::PresetNameSubmit => self.confirm_preset_name(),
            ShellAction::PresetDuplicate => self.duplicate_preset(),
            ShellAction::PresetDeleteOpen => self.open_preset_delete(),
            ShellAction::PresetDeleteClose => self.close_preset_delete(),
            ShellAction::PresetDeleteConfirm => self.confirm_preset_delete(),
        }
    }

    pub fn save_selected_character(&mut self) {
        let Some(draft) = self.state.character_draft.clone() else {
            return;
        };
        let req = RequestUpdateCharacter {
            character_id: draft.id,
            name: Some(draft.name),
            description: Some(draft.description),
            tags: Some(draft.tags),
            avatar_asset_id: draft.avatar_asset_id,
            profile_id: None,
        };
        match self.call_decode("characters.update", &req, decode_character_dto) {
            Ok(_) => {
                self.refresh_characters();
                self.state.status_message = Some("Saved.".into());
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
                self.state.character_draft = Some(draft);
                self.load_avatar_data_uri(dto.avatar_asset_id.as_deref());
            }
            Err(err) => {
                self.record_error(err);
                self.state.character_draft = None;
                self.state.avatar_data_uri = None;
            }
        }
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

    /// Read-only sampler rows for the Config tab, parsed from the active
    /// preset's `GenerationPresetData` (React renders them as range fields;
    /// per-sampler editing is not ported to this plane yet).
    fn preset_value_rows(&self) -> Vec<PresetValueRow> {
        let parsed: PresetGenerationData = match self.active_preset() {
            Some(preset) => serde_json::from_value(preset.data.clone()).unwrap_or_default(),
            None => PresetGenerationData::default(),
        };
        let d = &parsed.generation_defaults;
        let fmt = |v: f64| {
            if v.fract() == 0.0 {
                format!("{}", v as i64)
            } else {
                format!("{v:.2}")
            }
        };
        vec![
            PresetValueRow { label: "Context size".into(), value: parsed.max_context_tokens.to_string() },
            PresetValueRow { label: "Max tokens".into(), value: fmt(d.max_tokens) },
            PresetValueRow { label: "Temperature".into(), value: fmt(d.temperature) },
            PresetValueRow { label: "Top P".into(), value: fmt(d.top_p) },
            PresetValueRow { label: "Top K".into(), value: fmt(d.top_k) },
            PresetValueRow { label: "Min P".into(), value: fmt(d.min_p) },
            PresetValueRow { label: "Top A".into(), value: fmt(d.top_a) },
            PresetValueRow { label: "Repetition penalty".into(), value: fmt(d.repetition_penalty) },
            PresetValueRow { label: "Frequency penalty".into(), value: fmt(d.frequency_penalty) },
            PresetValueRow { label: "Presence penalty".into(), value: fmt(d.presence_penalty) },
            PresetValueRow { label: "Seed".into(), value: fmt(d.seed) },
            PresetValueRow { label: "Reasoning".into(), value: d.reasoning.to_string() },
            PresetValueRow { label: "Streaming".into(), value: d.stream.to_string() },
        ]
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
            }
            Err(err) => self.record_error(err),
        }
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
        let Some(chat) = self.state.chat_list.iter().find(|row| row.id == chat_id).cloned() else {
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
        match self.call_value("chats.delete", &RequestDeleteChat { chat_id: id.clone() }) {
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

    pub fn close_prompt_plan(&mut self) {
        self.state.prompt_plan_open = false;
        self.state.prompt_plan_run_id = None;
        self.state.prompt_plan = None;
        self.state.prompt_plan_not_found = false;
        self.state.prompt_plan_error = None;
        self.bump_scene();
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
        match self.call_decode("secrets.status", &RequestEmpty {}, decode_result_secrets_status)
        {
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
        match self.call_decode("generation.tools.list", &RequestEmpty {}, decode_result_list_tools)
        {
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
    /// generationDefaults; React `applyDraft`).
    pub fn apply_preset_draft(&mut self) {
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
            ],
        };
        match self.call_value("settings.update", &req) {
            Ok(_) => {
                self.state.status_message = Some("Generation settings applied.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_preset_name_draft(&mut self, value: &str) {
        self.state.preset_name_draft = value.to_string();
        self.bump_scene();
    }

    /// Opens the name dialog in create mode ("Save as new").
    pub fn open_preset_create(&mut self) {
        self.state.preset_name_dialog_open = true;
        self.state.preset_name_mode = Some("create".into());
        self.state.preset_name_draft.clear();
        self.state.preset_form_error = None;
        self.bump_scene();
    }

    /// Opens the name dialog in rename mode prefilled with the active name.
    pub fn open_preset_rename(&mut self) {
        let active_name = self.active_preset().map(|item| item.name.clone());
        let Some(active_name) = active_name else {
            return;
        };
        self.state.preset_name_dialog_open = true;
        self.state.preset_name_mode = Some("rename".into());
        self.state.preset_name_draft = active_name;
        self.state.preset_form_error = None;
        self.bump_scene();
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

    fn preset_data_json(&self) -> Value {
        match self.active_preset() {
            Some(preset) => preset.data.clone(),
            None => serde_json::to_value(PresetGenerationData::default())
                .unwrap_or_else(|_| json!({})),
        }
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
                data: Some(self.preset_data_json()),
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
            Some(active) => (format!("{} (copy)", active.name), active.data.clone()),
            None => (
                "generation (copy)".to_string(),
                serde_json::to_value(PresetGenerationData::default()).unwrap_or_else(|_| json!({})),
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
            self.state.preset_delete_open = true;
            self.bump_scene();
        }
    }

    /// Deletes the active preset and clears the selection
    /// (React `confirmDelete`).
    pub fn confirm_preset_delete(&mut self) {
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
            if let Some(pos) = self
                .state
                .characters
                .iter()
                .position(|character| Some(character.id.as_str()) == item.character_id.as_deref())
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
        let req = RequestDeleteMemory {
            memory_id: id,
        };
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

fn virtualized_window(
    messages: &[MessageDto],
    viewport_height: f64,
    scroll_from_bottom_css: f64,
    assistant_author: &str,
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
            visible_rows(messages, assistant_author),
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
                let author = if message.role == MessageRole::User {
                    "You".to_string()
                } else {
                    assistant_author.to_string()
                };
                visible.push(VisibleRow {
                    id: message.id.clone(),
                    role: role_name(&message.role).into(),
                    content: message.content.clone(),
                    kind: row_kind(&message.content),
                    author,
                    timestamp: neotavern_presentation_dioxus_shell::format_timestamp(
                        &message.created_at,
                    ),
                    run_id: message.generation_run_id.clone(),
                });
            }
        }
    }
    if visible.is_empty() {
        visible = visible_rows(messages, assistant_author);
    }
    (visible, outcome)
}

fn estimate_height(message: &MessageDto) -> f64 {
    48.0 + (message.content.len() as f64 / 8.0).min(160.0)
}

fn visible_rows(messages: &[MessageDto], assistant_author: &str) -> Vec<VisibleRow> {
    let start = messages.len().saturating_sub(PRODUCT_PATH_VISIBLE);
    messages[start..]
        .iter()
        .map(|row| VisibleRow {
            id: row.id.clone(),
            role: role_name(&row.role).into(),
            content: row.content.clone(),
            kind: row_kind(&row.content),
            author: if row.role == MessageRole::User {
                "You".into()
            } else {
                assistant_author.to_string()
            },
            timestamp: neotavern_presentation_dioxus_shell::format_timestamp(&row.created_at),
            run_id: row.generation_run_id.clone(),
        })
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
