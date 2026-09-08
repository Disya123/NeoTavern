//! The chat route session, split from the former single-file `session.rs`
//! (B1). One mechanical `impl ChatSession` block per feature cluster, cut at
//! method boundaries with zero code changes:
//!
//! - `core` — construction, wire access, quotas, surface/viewport, height index;
//! - `composer` — drafts, send/retry/prepend, streaming, cancellation;
//! - `view` — view-model (`view`/`shell_view`), macros, snapshots, tracing;
//! - `chat_nav` — workspace load, panels, chats list, statuses, intents;
//! - `messages` — message actions: copy/delete/edit/history/variants/rollback;
//! - `characters` — character CRUD, editor drafts, greetings, avatars;
//! - `personas` — personas + lorebooks and their entries;
//! - `settings` — plugins, AI settings, prompt blocks/templates, instruct;
//! - `profiles` — profiles, chat rename, prompt plan, run transcripts, themes;
//! - `presets` — generation presets + provider configs;
//! - `diagnostics` — diagnostics export, backups, memories;
//! - `wire_ops` — chats.get/messages paging, asset hydration, wire helpers;
//! - `helpers` — free functions (slash commands, presets, height models).
//!
//! Privacy contract: `ChatSession` is declared in `mod.rs`, so every child
//! `impl` block sees the private fields as a descendant of this module —
//! the split changed no visibility. The former public surface (free
//! functions, consts, types) is re-exported verbatim below, so `crate::`
//! imports and `pub use session::...` consumers stay untouched.
use contracts_generated::generated::{
    decode_backup_dto, decode_character_dto, decode_chat_dto, decode_lorebook_dto,
    decode_lorebook_entry_dto, decode_memory_dto, decode_message_draft_dto, decode_message_dto,
    decode_paged_characters, decode_paged_chats, decode_paged_generation_events,
    decode_paged_messages, decode_persona_dto, decode_preset_dto, decode_prompt_plan,
    decode_provider_config_dto, decode_result_assets_put, decode_result_assets_thumb,
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
    decode_result_snapshots_rollback, decode_result_themes_list, decode_themes_item, BackupDto,
    CardExportFormat, CharacterDto, ChatDto, ErrorDto, FreeObject, GenerationEvent, LorebookDto,
    LorebookEntryDto, LorebookEntryInput, LorebookEntryPatch, MemoryDto, MemoryScope,
    MessageDraftDto, MessageDto, MessageRevisionDto, MessageRole, MessageVariantDto,
    PagedCharacters, PagedChats, PagedMessages, PersonaDto, PluginsItem, PresetDto, ProfilesItem,
    PromptPlan, ProviderConfigDto, RequestAssetsPut, RequestAssetsThumb, RequestBackupsRestore,
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
    RequestUpdatePreset, ResultAssetsThumb, ResultChatSnapshot, ResultDataActivationStatus,
    ResultDiagnosticsExport, ResultListLorebookEntries, ResultListLorebooks, ResultListPersonas,
    ResultListPresets, ResultListProviders, ResultPluginsList, ResultProfilesList,
    ResultSecretsStatus, ResultSettings, SettingsItem, SnapshotOrigin, ThemesItem, ToolSpec,
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
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

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
pub(crate) struct PresetGenerationDefaults {
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
    /// CSS-px offset the side-panel content is scrolled by (native shim for
    /// React's native panel scrolling, which Blitz paint does not provide:
    /// the shell applies it as a negative top margin on the panel body and
    /// the host clamps it to the rendered content height). Reset to `0` on
    /// tab / panel / character switches.
    pub panel_scroll_css: f32,
    pub insets: SafeAreaInsets,
    /// Full draft for the selected character (Edit / Advanced / Gallery tabs).
    pub character_draft: Option<CharacterDraftView>,
    /// React `useCharacters(limit: 50)` paging: how many filtered cards the
    /// browser lays out. `characters.load-more` bumps it by one page
    /// (`CHARACTERS_PAGE`); the catalog itself is already in memory.
    pub character_browser_limit: usize,
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
    /// Active theme resolved design tokens (Theme SDK Level 1).
    pub active_theme_tokens: Option<neotavern_presentation_design_system::ThemeTokens>,
    /// Active theme generated stylesheet for Blitz injection.
    pub active_theme_css: Option<String>,
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
    /// `avatar_ready_token`). A hit only promotes the LRU order. The same
    /// thumb also lands in the session asset store as a PNG so the in-scene
    /// `<img src="asset:{id}">` raster can decode (image audit, stage B).
    pub(crate) fn insert_avatar_thumb(
        &mut self,
        asset_id: String,
        thumb: crate::avatar::AvatarThumb,
        store: &neotavern_presentation_m0_d2::AssetStore,
    ) -> bool {
        if self.avatar_thumbs.contains_key(&asset_id) {
            self.touch_avatar(&asset_id);
            return false;
        }
        if let Some(png) = crate::avatar::display_png_from_thumb(&thumb) {
            store.insert(&asset_id, png);
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
    /// Per-session raster store (B2): the produce seam registers this store
    /// with the document's `LocalNetProvider`, so decoded thumbnails never
    /// leak between chats and the process-global store is gone.
    asset_store: neotavern_presentation_m0_d2::AssetStore,
    /// Bumped whenever the character catalog rows change (`refresh_characters`);
    /// keys the filtered-cards cache — `shell_view` runs per produce, so the
    /// filter+sort must not re-lowercase and re-clone the catalog per frame.
    characters_revision: u64,
    /// Filtered+sorted cards shared with the shell view as an `Arc`, rebuilt
    /// only when the revision, search or sort changes.
    characters_cards: RefCell<Option<CharacterCardsCache>>,
}

impl<W: ProductWire> ChatSession<W> {
    /// The session's raster store (B2): the produce seam registers this store
    /// with the document's `LocalNetProvider`, so decoded thumbnails never
    /// leak between chats and the process-global store is gone.
    pub fn asset_store(&self) -> neotavern_presentation_m0_d2::AssetStore {
        self.asset_store.clone()
    }
}

mod characters;
mod chat_nav;
mod composer;
mod core;
mod diagnostics;
mod helpers;
mod messages;
mod personas;
mod presets;
mod profiles;
mod settings;
mod view;
mod wire_ops;

// Cluster modules see every free item of the former single-file module through
// this re-export (each cluster opens with `use super::*;`); items live as
// `pub(crate)` in `helpers`, so they stay invisible outside the crate.
pub(crate) use chat_nav::{CharacterCardsCache, CHARACTERS_PAGE};
pub(crate) use helpers::*;
