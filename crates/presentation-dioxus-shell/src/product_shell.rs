//! App Shell + Character Manager RSX using packed React CSS modules.
//!
//! Class names, tokens, Phosphor regular paths, and English copy come from the
//! React source (`apps/web/src/components/*` + `packages/i18n/src/resources/en.ts`).
//! This is not a Dioxus restyle. The view model is rebuilt from the session each
//! frame; event handlers call back into the session via JNI to mutate state and
//! mark the compositor dirty.

use std::cell::RefCell;

use contracts_generated::generated::{
    MessageRole, PromptPlan, ResultDataActivationStatus, ResultDiagnosticsExport,
    ResultSecretsStatus,
};
use dioxus_core::Element;
use dioxus_core_macro::rsx;
use neotavern_presentation_design_system::{
    phosphor_path, product_stylesheets_dev, SafeAreaInsets,
};

use crate::{product_chat_app, ProductChatView};

/// Full character draft (mirrors React `CharacterDraft`).
#[derive(Clone, Debug, PartialEq)]
pub struct CharacterDraftView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub personality: String,
    pub scenario: String,
    pub first_message: String,
    pub example_dialogues: String,
    pub system_prompt: String,
    pub post_history_instructions: String,
    pub creator: String,
    pub creator_notes: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub alternate_greetings: Vec<String>,
    pub character_version: String,
    pub character_note: String,
    pub character_note_depth: u32,
    pub character_note_role: String,
    pub talkativeness: f32,
    pub avatar_asset_id: Option<String>,
    /// Never a `data:` URI in the Dioxus tree. GPU overlay uses `avatar_asset_id`.
    pub avatar_data_uri: Option<String>,
}

impl Default for CharacterDraftView {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            personality: String::new(),
            scenario: String::new(),
            first_message: String::new(),
            example_dialogues: String::new(),
            system_prompt: String::new(),
            post_history_instructions: String::new(),
            creator: String::new(),
            creator_notes: String::new(),
            tags: Vec::new(),
            favorite: false,
            alternate_greetings: Vec::new(),
            character_version: String::new(),
            character_note: String::new(),
            character_note_depth: 4,
            character_note_role: "system".into(),
            talkativeness: 0.5,
            avatar_asset_id: None,
            avatar_data_uri: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterCardView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    /// Product Wire asset id. GPU compositor samples a cached texture; Blitz never sees a `data:` URI.
    pub avatar_asset_id: Option<String>,
    /// Always `None` on the paint path. Kept so older view constructors compile.
    pub avatar_data_uri: Option<String>,
}

/// React `CharacterManagementPanel` card copy:
/// `item.description || t('characters:noDescription')`.
pub fn character_card_description(description: &str) -> &str {
    if description.is_empty() {
        "No character description yet."
    } else {
        description
    }
}

/// React `PersonasPanel` card copy: `persona.description.trim() || t('personas:noDescription')`.
pub fn persona_card_description(description: &str) -> &str {
    if description.trim().is_empty() {
        "No description"
    } else {
        description
    }
}

/// React `LorebookPanel` card copy.
pub fn lorebook_card_description(description: &str) -> &str {
    if description.trim().is_empty() {
        "No description"
    } else {
        description
    }
}

/// React `SidebarPanelHeader` title. Packed CSS is `font-size: 1.25rem`.
pub const CHARACTER_MANAGER_TITLE: &str = "Character Management";
pub const PERSONA_MANAGER_TITLE: &str = "Persona Management";
pub const LOREBOOK_MANAGER_TITLE: &str = "Lorebooks";
pub const BACKGROUNDS_MANAGER_TITLE: &str = "Backgrounds";
pub const AI_SETTINGS_TITLE: &str = "AI Settings";
pub const PLUGINS_MANAGER_TITLE: &str = "Plugins";
pub const SETTINGS_TITLE: &str = "Settings";
pub const CHATS_MANAGER_TITLE: &str = "Chats";

/// Unmanaged DOM insertion points for documented SillyTavern legacy
/// extensions. Mirrors `LEGACY_ISLANDS` in `packages/legacy-compat` (single
/// source of truth lives there; keep the two lists in the same order).
pub const LEGACY_ISLAND_SLOTS: &[&str] = &[
    "legacy.extensions.settings",
    "legacy.chat.actions",
    "legacy.character.actions",
    "legacy.toolbar",
    "legacy.drawer",
    "legacy.modal",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersonaCardView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_default: bool,
    pub is_active: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LorebookCardView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub entry_count: i64,
    pub character_id: Option<String>,
}

/// React `LorebookPanel` `EntriesTab` row: the wire entry subset (the wire
/// DTO carries no position/metadata — kernel-owned, appended at the end).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LorebookEntryCardView {
    pub id: String,
    pub keys: Vec<String>,
    pub secondary_keys: Option<Vec<String>>,
    pub content: String,
    pub enabled: bool,
    pub constant: bool,
    pub selective: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginCardView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub trust_state: String,
    pub permissions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderCardView {
    pub id: String,
    pub name: String,
    pub availability: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresetCardView {
    pub id: String,
    pub name: String,
    pub kind: String,
}

/// Configuration profile row (`React ProfilesPanel` list; `profiles.list`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileCardView {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Home/chats panel row (React `ChatManagementPanel_chatRow`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatCardView {
    pub id: String,
    pub title: String,
    pub message_count: i64,
    pub character_label: String,
}

/// Installed theme row (React `ThemesPage` theme-card / Settings `ThemesTab`
/// picker); `themes.list` over the wire, `active` drives the badge and the
/// Apply / Use-built-in actions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThemeCardView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub active: bool,
    pub trust_state: String,
}

/// Host tool registry row (React `ToolsPanel`); `generation.tools.list` over
/// the wire. `required` is the `inputSchema.required` array of the declarative
/// contract — arguments and results never reach this panel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCardView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub required: Vec<String>,
}

/// One backup row (React DataTab list item): creation timestamp as the title
/// and the honest "Manual backup · N MB" detail line.
#[derive(Clone, Debug, PartialEq)]
pub struct BackupCardView {
    pub id: String,
    pub title: String,
    pub detail: String,
}

/// One memory card (React `MemoryEditor` list item): scope label + activation
/// keys as the meta line, the durable content, and the enabled flag.
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryCardView {
    pub id: String,
    pub meta: String,
    pub content: String,
    pub enabled: bool,
}

/// One text-completion prompt block (React `PromptTemplateEditor` row).
#[derive(Clone, Debug, PartialEq)]
pub struct PromptBlockView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub custom: bool,
    /// React `movePromptBlockUp` — false for terminals and index 0.
    pub can_move_up: bool,
    /// React `canMoveDown` — false for terminals and when the next row is
    /// a terminal anchor.
    pub can_move_down: bool,
    /// `injectionPosition === "in-chat"` (React `@ {depth}` on the row).
    pub injection_in_chat: bool,
    pub injection_depth: u32,
}

/// One generation-preset control on the Config tab (React `RangeField` /
/// Switch). Native uses a compact numeric field or toggle instead of a
/// range slider; `id` is the contract key (`maxContextTokens`, `temperature`,
/// `stream`, …).
#[derive(Clone, Debug, PartialEq)]
pub struct PresetValueRow {
    pub id: String,
    pub label: String,
    pub value: String,
    /// `"number"` or `"toggle"`.
    pub kind: String,
    pub focused: bool,
}

/// One provider connection profile row (API tab): display name plus a
/// "provider · API key …" detail line. The key value itself never leaves
/// SecretStore.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderConfigCardView {
    pub id: String,
    pub name: String,
    pub detail: String,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct PanelTab {
    pub id: &'static str,
    pub label: &'static str,
    pub disabled: bool,
}

/// Blitz clips `overflow: hidden` and does not paint `text-overflow: ellipsis`.
/// Trim `text` to the real Outfit advance width measured by Parley so the
/// visible string includes `…` and actually fits. The fixed `font_size * 0.52`
/// heuristic is gone.
pub fn ellipsize_css(text: &str, max_css_px: f32, font_size_px: f32) -> String {
    neotavern_presentation_design_system::ellipsize_to_width(text, max_css_px, font_size_px)
}

/// Title that fits a management header on a CSS viewport.
pub fn panel_header_title(title: &str, viewport_css_width: u32) -> String {
    let css_w = viewport_css_width.max(1) as f32;
    let panel_w = (css_w - 60.0).max(120.0);
    let avail = (panel_w - 140.0).max(120.0);
    ellipsize_css(title, avail, 18.0)
}

/// Title that fits the Character Manager header on a CSS viewport.
pub fn character_manager_title(viewport_css_width: u32) -> String {
    let css_w = viewport_css_width.max(1) as f32;
    let panel_w = (css_w - 60.0).max(120.0);
    let avail = (panel_w - 215.0).max(80.0);
    ellipsize_css(CHARACTER_MANAGER_TITLE, avail, 18.0)
}

/// One durable generation step in the run-transcript dialog (React
/// `RunTranscriptPanel` row). Tool `input`/`output` never travel this
/// view — SEC-07: the wireBridge keeps them out of the UI shape.
#[derive(Clone, Debug, PartialEq)]
pub struct RunStepView {
    pub sequence: i64,
    pub step_type: String,
    pub status: String,
    pub attempt: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProductShellView {
    pub chat: ProductChatView,
    pub characters: Vec<CharacterCardView>,
    pub selected_character_id: Option<String>,
    pub selected_draft: Option<CharacterDraftView>,
    pub pinned_character_id: Option<String>,
    pub search: String,
    pub sort: String,
    pub view: String,
    pub tab: String,
    pub panel: String,
    pub sidebar_open: bool,
    pub rail_expanded: bool,
    /// CSS-px width of the open desktop side panel (`--st-shell-panel-width`).
    /// Clamped to `--st-shell-panel-min-width`/`max-width` (260..720).
    pub panel_width: f32,
    pub density: String,
    pub font_scale: String,
    pub insets: SafeAreaInsets,
    pub editor_mode: String,
    pub create_dialog_open: bool,
    pub delete_dialog_open: bool,
    pub create_name: String,
    pub create_description: String,
    pub create_first_message: String,
    pub status_message: Option<String>,
    pub error_message: Option<String>,
    pub gallery_columns: u32,
    pub gallery_sort: String,
    pub expanded_greeting: Option<usize>,
    pub tag_input: String,
    pub personas: Vec<PersonaCardView>,
    pub selected_persona_id: Option<String>,
    pub persona_tab: String,
    pub persona_search: String,
    pub persona_sort: String,
    pub persona_name_draft: String,
    pub persona_description_draft: String,
    pub persona_create_open: bool,
    pub persona_delete_open: bool,
    pub persona_create_name: String,
    pub active_persona_id: Option<String>,
    pub lorebooks: Vec<LorebookCardView>,
    pub selected_lorebook_id: Option<String>,
    pub lorebook_tab: String,
    pub lorebook_search: String,
    pub lorebook_create_open: bool,
    pub lorebook_delete_open: bool,
    pub lorebook_create_name: String,
    pub lorebook_name_draft: String,
    pub lorebook_description_draft: String,
    /// Entries of the selected lorebook (`lorebooks.entries.list`), mapped
    /// to the shell card shape (React `LorebookPanel` EntriesTab rows).
    pub lorebook_entries: Vec<LorebookEntryCardView>,
    pub editing_lorebook_entry_id: Option<String>,
    pub entry_dialog_open: bool,
    pub entry_delete_open: bool,
    pub entry_keys_draft: String,
    pub entry_secondary_keys_draft: String,
    pub entry_content_draft: String,
    pub entry_enabled_draft: bool,
    pub entry_constant_draft: bool,
    pub entry_selective_draft: bool,
    pub entry_delete_target_id: Option<String>,
    /// Script-aware token estimate for the entry content draft (React
    /// `EntryDialog` token label; computed in the session view model).
    pub entry_content_tokens: u64,
    /// Configuration profiles (`profiles.list`; React `ProfilesPanel`).
    pub profiles: Vec<ProfileCardView>,
    pub profile_create_name: String,
    /// Profile row currently in inline-rename mode.
    pub profile_renaming_id: Option<String>,
    pub profile_rename_name: String,
    pub profile_delete_open: bool,
    /// Profile the delete-confirm dialog asks about.
    pub profile_delete_target_id: Option<String>,
    /// Plugin uninstall confirm dialog (`plugins.uninstall`).
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
    /// `PROMPT_PLAN_NOT_FOUND` → honest empty state ("This run has no
    /// recorded prompt plan.").
    pub prompt_plan_not_found: bool,
    /// Any other error renders inside the dialog (React `isError` state).
    pub prompt_plan_error: Option<String>,
    /// Run-step transcript dialog (`generation.events`; React
    /// `RunTranscriptPanel`). Mutually exclusive with the prompt-plan
    /// dialog: opening one closes the other.
    pub run_transcript_open: bool,
    pub run_transcript_run_id: Option<String>,
    pub run_transcript_steps: Vec<RunStepView>,
    pub run_transcript_error: Option<String>,
    /// Delete-checkpoint confirm (React `deleteCheckpointConfirm`, 300×200).
    pub checkpoint_delete_open: bool,
    pub checkpoint_delete_message_id: Option<String>,
    /// Theme catalog (`themes.list`; React `ThemesPage` / Settings `ThemesTab`).
    pub themes: Vec<ThemeCardView>,
    /// Theme the delete-confirm dialog asks about.
    pub theme_delete_open: bool,
    pub theme_delete_target_id: Option<String>,
    /// Secret-store status (`secrets.status`; React `SecretsPanel`); `None`
    /// = React loading state. The DTO is value-free by contract.
    pub secrets_status: Option<ResultSecretsStatus>,
    /// Host tool registry (`generation.tools.list`; React `ToolsPanel`).
    pub tools: Vec<ToolCardView>,
    /// Selected AI provider / preset card ids (React `settings.update`
    /// `activeProviderConfigId` / `activeGenerationPresetId`).
    pub selected_provider_id: Option<String>,
    pub selected_preset_id: Option<String>,
    /// Backup catalog (`backups.list`; React SettingsPanel DataTab).
    pub backups: Vec<BackupCardView>,
    /// Memory editor state (React `MemoryEditor`): the card list plus the
    /// inline create/edit draft. `memory_edit_id == None` means create mode.
    pub memories: Vec<MemoryCardView>,
    pub memory_edit_id: Option<String>,
    pub memory_draft_content: String,
    pub memory_draft_keys: String,
    pub memory_draft_scope_character: bool,
    pub memory_draft_character_label: Option<String>,
    pub memory_draft_enabled: bool,
    pub memory_form_error: Option<String>,
    pub memory_delete_open: bool,
    pub memory_delete_target_id: Option<String>,
    /// Config tab preset editor state (React `GenerationPresetEditor`):
    /// live sampler draft (numeric fields + toggles), unlock-context switch,
    /// its name, the rename / save-as dialog and delete confirmation.
    pub preset_rows: Vec<PresetValueRow>,
    pub preset_unlocked_context: bool,
    pub preset_active_name: Option<String>,
    pub preset_name_dialog_open: bool,
    pub preset_name_mode: Option<String>,
    pub preset_name_draft: String,
    pub preset_form_error: Option<String>,
    pub preset_delete_open: bool,
    /// Shared name/delete dialog family (`generation` / `prompt-template`).
    pub preset_dialog_kind: String,
    /// Advanced tab prompt-template presets (React `PromptTemplateEditor`).
    pub prompt_presets: Vec<PresetCardView>,
    pub active_prompt_preset_id: Option<String>,
    pub prompt_preset_active_name: Option<String>,
    /// API tab provider profiles (`providers.config.*`) and the new-profile
    /// dialog state.
    pub provider_configs: Vec<ProviderConfigCardView>,
    pub provider_create_dialog_open: bool,
    pub provider_kind_label: Option<String>,
    pub provider_name_draft: String,
    pub provider_form_error: Option<String>,
    pub provider_delete_target_id: Option<String>,
    /// Character-card import dialog (React hidden file input): path prompt.
    pub card_import_dialog_open: bool,
    pub card_path_draft: String,
    /// Prompt-template import dialog (React hidden file input): path prompt.
    pub prompt_template_import_open: bool,
    pub prompt_template_path_draft: String,
    /// Generation-preset import dialog (React hidden file input): path prompt.
    pub generation_preset_import_open: bool,
    pub generation_preset_path_draft: String,
    /// Profile container import (React `ProfilesPanel` import form).
    pub profile_import_path: String,
    pub profile_import_policy_label: String,
    pub plugins: Vec<PluginCardView>,
    pub providers: Vec<ProviderCardView>,
    pub presets: Vec<PresetCardView>,
    pub chat_list: Vec<ChatCardView>,
    pub selected_chat_id: Option<String>,
    pub chat_search: String,
    pub language: String,
    pub dir: String,
    pub ai_tab: String,
    pub settings_tab: String,
    /// React `useUiStore` appearance (General tab). `font_scale` is the
    /// interface scale (`small`/`medium`/`large`); density stays comfortable
    /// until a density control is ported.
    pub ui_contrast: String,
    pub ui_font_profile: String,
    pub ui_motion: String,
    pub open_home_on_load: bool,
    pub chat_style: String,
    pub chat_avatar_style: String,
    pub user_message_position: String,
    pub character_message_position: String,
    /// React `useUiStore` sliders (General tab).
    pub ui_opacity: u32,
    pub ui_glass_blur: u32,
    /// Kernel diagnostics bundle (`diagnostics.export`).
    pub diagnostics: Option<ResultDiagnosticsExport>,
    /// Data-root activation (`data.activation.status`).
    pub data_activation: Option<ResultDataActivationStatus>,
    /// AI Advanced tab (React `AdvancedPromptSettings` / `ChatTemplateEditor`).
    /// Kernel plane has no instruct-format catalog (`useInstructFormats` → `[]`).
    pub prompt_template_mode: String,
    pub instruct_selection: String,
    pub instruct_form_error: Option<String>,
    /// Text-completion prompt blocks (React `PromptTemplateEditor` list).
    /// Empty until the template is hydrated (mode `text` seeds the default).
    pub prompt_blocks: Vec<PromptBlockView>,
    /// Compact prompt-block editor (React `PromptBlockEditorDialog`).
    pub prompt_block_edit_open: bool,
    pub prompt_block_name_draft: String,
    pub prompt_block_content_draft: String,
    pub prompt_block_content_editable: bool,
    /// React `injectionPosition` draft (`relative` / `in-chat`).
    pub prompt_block_injection_position: String,
    pub prompt_block_depth_draft: String,
    pub prompt_block_order_draft: String,
    /// React `role` draft (`system` / `user` / `assistant`).
    pub prompt_block_role: String,
    /// React `triggers` draft. Omitted stored list hydrates as every kind.
    pub prompt_block_triggers: Vec<String>,
    /// React `forbidOverrides` draft. Switch is visible only for editable
    /// `system` blocks.
    pub prompt_block_forbid_overrides: bool,
    /// React `model` draft. Empty = every model (no binding).
    pub prompt_block_model_draft: String,
    /// Custom ChatML role templates (React `ChatTemplateEditor` textareas).
    /// Empty when serialization is native.
    pub instruct_system: String,
    pub instruct_user: String,
    pub instruct_assistant: String,
    pub instruct_tool: String,
    pub instruct_prompt_suffix: String,
    /// Newline-joined stopping strings (React `stopStrings.join('\n')`).
    pub instruct_stop_strings: String,
}

impl Default for ProductShellView {
    fn default() -> Self {
        Self {
            chat: ProductChatView::default(),
            characters: Vec::new(),
            selected_character_id: None,
            selected_draft: None,
            pinned_character_id: None,
            search: String::new(),
            sort: "name".into(),
            view: "list".into(),
            tab: "cards".into(),
            panel: "characters".into(),
            sidebar_open: true,
            rail_expanded: true,
            panel_width: 380.0,
            density: "comfortable".into(),
            font_scale: "medium".into(),
            insets: SafeAreaInsets::default(),
            editor_mode: "view".into(),
            create_dialog_open: false,
            delete_dialog_open: false,
            create_name: String::new(),
            create_description: String::new(),
            create_first_message: String::new(),
            status_message: None,
            error_message: None,
            gallery_columns: 3,
            gallery_sort: "oldest".into(),
            expanded_greeting: None,
            tag_input: String::new(),
            personas: Vec::new(),
            selected_persona_id: None,
            persona_tab: "cards".into(),
            persona_search: String::new(),
            persona_sort: "asc".into(),
            persona_name_draft: String::new(),
            persona_description_draft: String::new(),
            persona_create_open: false,
            persona_delete_open: false,
            persona_create_name: String::new(),
            active_persona_id: None,
            lorebooks: Vec::new(),
            selected_lorebook_id: None,
            lorebook_tab: "books".into(),
            lorebook_search: String::new(),
            lorebook_create_open: false,
            lorebook_delete_open: false,
            lorebook_create_name: String::new(),
            lorebook_name_draft: String::new(),
            lorebook_description_draft: String::new(),
            lorebook_entries: Vec::new(),
            editing_lorebook_entry_id: None,
            entry_dialog_open: false,
            entry_delete_open: false,
            entry_keys_draft: String::new(),
            entry_secondary_keys_draft: String::new(),
            entry_content_draft: String::new(),
            entry_enabled_draft: true,
            entry_constant_draft: false,
            entry_selective_draft: false,
            entry_delete_target_id: None,
            entry_content_tokens: 0,
            profiles: Vec::new(),
            profile_create_name: String::new(),
            profile_renaming_id: None,
            profile_rename_name: String::new(),
            profile_delete_open: false,
            profile_delete_target_id: None,
            plugin_uninstall_open: false,
            plugin_uninstall_target_id: None,
            chat_rename_open: false,
            chat_renaming_id: None,
            chat_rename_draft: String::new(),
            chat_delete_open: false,
            chat_delete_target_id: None,
            prompt_plan_open: false,
            prompt_plan_run_id: None,
            prompt_plan: None,
            prompt_plan_not_found: false,
            prompt_plan_error: None,
            run_transcript_open: false,
            run_transcript_run_id: None,
            run_transcript_steps: Vec::new(),
            run_transcript_error: None,
            checkpoint_delete_open: false,
            checkpoint_delete_message_id: None,
            themes: Vec::new(),
            theme_delete_open: false,
            theme_delete_target_id: None,
            secrets_status: None,
            tools: Vec::new(),
            selected_provider_id: None,
            selected_preset_id: None,
            backups: Vec::new(),
            memories: Vec::new(),
            memory_edit_id: None,
            memory_draft_content: String::new(),
            memory_draft_keys: String::new(),
            memory_draft_scope_character: false,
            memory_draft_character_label: None,
            memory_draft_enabled: true,
            memory_form_error: None,
            memory_delete_open: false,
            memory_delete_target_id: None,
            preset_rows: Vec::new(),
            preset_unlocked_context: false,
            preset_active_name: None,
            preset_name_dialog_open: false,
            preset_name_mode: None,
            preset_name_draft: String::new(),
            preset_form_error: None,
            preset_delete_open: false,
            preset_dialog_kind: "generation".into(),
            prompt_presets: Vec::new(),
            active_prompt_preset_id: None,
            prompt_preset_active_name: None,
            provider_configs: Vec::new(),
            provider_create_dialog_open: false,
            provider_kind_label: None,
            provider_name_draft: String::new(),
            provider_form_error: None,
            provider_delete_target_id: None,
            card_import_dialog_open: false,
            card_path_draft: String::new(),
            prompt_template_import_open: false,
            prompt_template_path_draft: String::new(),
            generation_preset_import_open: false,
            generation_preset_path_draft: String::new(),
            profile_import_path: String::new(),
            profile_import_policy_label: "Reject".into(),
            plugins: Vec::new(),
            providers: Vec::new(),
            presets: Vec::new(),
            chat_list: Vec::new(),
            selected_chat_id: None,
            chat_search: String::new(),
            language: "en".into(),
            dir: "ltr".into(),
            ai_tab: "providers".into(),
            settings_tab: "general".into(),
            ui_contrast: "normal".into(),
            ui_font_profile: "default".into(),
            ui_motion: "system".into(),
            open_home_on_load: true,
            chat_style: "clean".into(),
            chat_avatar_style: "round".into(),
            user_message_position: "right".into(),
            character_message_position: "left".into(),
            ui_opacity: 70,
            ui_glass_blur: 16,
            diagnostics: None,
            data_activation: None,
            prompt_template_mode: "chat".into(),
            instruct_selection: "native".into(),
            instruct_form_error: None,
            prompt_blocks: Vec::new(),
            prompt_block_edit_open: false,
            prompt_block_name_draft: String::new(),
            prompt_block_content_draft: String::new(),
            prompt_block_content_editable: false,
            prompt_block_injection_position: String::new(),
            prompt_block_depth_draft: String::new(),
            prompt_block_order_draft: String::new(),
            prompt_block_role: String::new(),
            prompt_block_triggers: Vec::new(),
            prompt_block_forbid_overrides: false,
            prompt_block_model_draft: String::new(),
            instruct_system: String::new(),
            instruct_user: String::new(),
            instruct_assistant: String::new(),
            instruct_tool: String::new(),
            instruct_prompt_suffix: String::new(),
            instruct_stop_strings: String::new(),
        }
    }
}

thread_local! {
    static PRODUCT_SHELL: RefCell<ProductShellView> = RefCell::new(ProductShellView::default());
}

pub fn install_product_shell(view: ProductShellView) {
    crate::install_product_chat(view.chat.clone());
    PRODUCT_SHELL.with(|slot| *slot.borrow_mut() = view);
}

pub fn current_product_shell() -> ProductShellView {
    PRODUCT_SHELL.with(|slot| slot.borrow().clone())
}

struct RailSpec {
    theme_id: &'static str,
    panel: &'static str,
    label: &'static str,
    icon: &'static str,
}

const RAIL: &[RailSpec] = &[
    RailSpec {
        theme_id: "chats",
        panel: "home",
        label: "Chats",
        icon: "ChatsCircle",
    },
    RailSpec {
        theme_id: "characters",
        panel: "characters",
        label: "Characters",
        icon: "UsersThree",
    },
    RailSpec {
        theme_id: "personas",
        panel: "personas",
        label: "Personas",
        icon: "Smiley",
    },
    RailSpec {
        theme_id: "lorebooks",
        panel: "lorebooks",
        label: "Lorebooks",
        icon: "BookOpenText",
    },
    RailSpec {
        theme_id: "backgrounds",
        panel: "backgrounds",
        label: "Backgrounds",
        icon: "ImageSquare",
    },
    RailSpec {
        theme_id: "ai-settings",
        panel: "providers",
        label: "AI Settings",
        icon: "Globe",
    },
    RailSpec {
        theme_id: "plugins",
        panel: "plugins",
        label: "Plugins",
        icon: "Cube",
    },
    RailSpec {
        theme_id: "settings",
        panel: "settings",
        label: "Settings",
        icon: "SlidersHorizontal",
    },
];

pub(crate) fn icon(name: &str, size: u32) -> Element {
    icon_fill(name, size, "#998f87")
}

/// Wire `MessageRole` → display label (React `messageRole` capitalize).
pub(crate) fn role_label(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::Tool => "tool",
    }
}

fn step_type_label(step_type: &str) -> &'static str {
    match step_type {
        "provider_turn" => "Provider turn",
        "tool_call" => "Tool call",
        "tool_result" => "Tool result",
        "final_commit" => "Final commit",
        _ => "Step",
    }
}

fn step_status_label(status: &str) -> &'static str {
    match status {
        "running" => "Running",
        "waiting" => "Waiting",
        "completed" => "Completed",
        "failed" => "Failed",
        _ => "Unknown",
    }
}

pub(crate) fn icon_fill(name: &str, size: u32, fill: &str) -> Element {
    let path = phosphor_path(name).unwrap_or("");
    let class = format!("nt-icon nt-icon-{name}");
    rsx! {
        span {
            class: "{class}",
            style: "width:{size}px;height:{size}px;background:transparent;",
            "aria-hidden": "true",
            svg {
                xmlns: "http://www.w3.org/2000/svg",
                view_box: "0 0 256 256",
                width: "{size}",
                height: "{size}",
                fill: "{fill}",
                style: "display:block;width:100%;height:100%;",
                path {
                    d: "{path}",
                    fill: "{fill}",
                }
            }
        }
    }
}

/// `icon_fill` sized to fill its 40x40 rail button with a static 9.5px
/// padding, so the 21px glyph needs no flex centering at all — this Blitz
/// build's taffy mis-centers a fixed-size span inside a fixed-size flex box
/// (loc x=18 instead of 9.5, traced via NEOTA_TEXT_TRACE elem/svg-trace;
/// percentage-width containers center fine).
pub(crate) fn icon_fill_centered(name: &str, size: u32, fill: &str) -> Element {
    let path = phosphor_path(name).unwrap_or("");
    let class = format!("nt-icon nt-icon-{name}");
    let pad = (40.0 - size as f32) / 2.0;
    rsx! {
        span {
            class: "{class}",
            style: "width:40px;height:40px;padding:{pad}px;box-sizing:border-box;background:transparent;",
            "aria-hidden": "true",
            svg {
                xmlns: "http://www.w3.org/2000/svg",
                view_box: "0 0 256 256",
                width: "{size}",
                height: "{size}",
                fill: "{fill}",
                style: "display:block;width:100%;height:100%;",
                path {
                    d: "{path}",
                    fill: "{fill}",
                }
            }
        }
    }
}

fn sort_label(sort: &str) -> &'static str {
    match sort {
        "name-desc" => "Z–A",
        "newest" => "Newest",
        "oldest" => "Oldest",
        "favorites" => "Favorites",
        "used" => "Recently used",
        "chats-most" => "Most chats",
        "chats-least" => "Least chats",
        "tokens-most" => "Most content",
        "tokens-least" => "Least content",
        "random" => "Random",
        _ => "A–Z",
    }
}

pub(crate) fn chrome_insets(view: &ProductShellView) -> (f32, f32) {
    let compact = view.chat.viewport_width <= 600;
    // React compact chrome: max(--st-space-2xl, --nt-inset-*).
    // Floor at 48px on compact mobile so rail and header chrome stay comfortably below status bar clock.
    let top = if compact {
        view.insets.top.max(48.0)
    } else {
        view.insets.top.max(8.0)
    };
    let bottom = if compact {
        view.insets.bottom.max(32.0)
    } else {
        view.insets.bottom.max(8.0)
    };
    (top, bottom)
}

pub(crate) fn tab_trigger_style(active: bool) -> &'static str {
    if active {
        "flex:1;min-height:44px;border-radius:10px;background:#492a20;color:#ffc4a8;font-weight:600;"
    } else {
        "flex:1;min-height:44px;border-radius:10px;background:transparent;color:#c5bbb2;"
    }
}

fn rail_button(item: &RailSpec, selected: bool) -> Element {
    let class = if selected {
        "Sidebar_railItem"
    } else {
        "Sidebar_railItem"
    };
    let control = if selected {
        "Sidebar_railButtonActive"
    } else {
        "Sidebar_railButton"
    };
    let state = if selected { "active" } else { "inactive" };
    let fill = if selected { "#ffc4a8" } else { "#998f87" };
    rsx! {
        span {
            class: "{class}",
            "data-part": "item",
            "data-item": "{item.theme_id}",
            "data-group": "main",
            button {
                class: "{control}",
                r#type: "button",
                // This Blitz build's taffy mis-resolves justify-content:center
                // on a fixed-size flex box whose child is a fixed-size span
                // (the icon lands at the flex-end position, x=18 instead of
                // 9.5 — traced via NEOTA_TEXT_TRACE elem/svg-trace). Auto
                // margins center correctly, so the button delegates centering
                // to the child's margin:auto and sets no justify/align.
                style: "display:flex;width:40px;height:40px;padding:0;",
                "data-part": "item-control",
                "data-state": "{state}",
                "aria-label": "{item.label}",
                title: "{item.label}",
                "aria-expanded": selected,
                {icon_fill_centered(item.icon, 21, fill)}
            }
        }
    }
}

fn character_avatar(name: &str, class: &'static str, asset_id: Option<&str>) -> Element {
    let letter = name
        .chars()
        .next()
        .map(|ch| ch.to_uppercase().to_string())
        .unwrap_or_default();
    let asset = asset_id.unwrap_or("");
    let box_style = if class.contains("headerAvatar") {
        "width:44px;height:44px;max-width:44px;max-height:44px;flex:none;align-self:center;overflow:hidden;"
    } else if class.contains("editorAvatar") {
        "width:64px;height:64px;max-width:64px;max-height:64px;flex:none;align-self:start;overflow:hidden;"
    } else if class.contains("galleryAvatar") {
        "width:100%;max-width:100%;aspect-ratio:4/5;flex:none;align-self:stretch;overflow:hidden;"
    } else {
        // React parity: cardAvatar is var(--st-control-height-large) = 48px, not 52px.
        "width:48px;height:48px;max-width:48px;max-height:48px;flex:none;align-self:start;overflow:hidden;"
    };
    rsx! {
        span {
            class: "{class}",
            style: "{box_style}",
            "aria-hidden": "true",
            "data-part": "avatar-fallback",
            "data-avatar-asset": "{asset}",
            if letter.is_empty() {
                {icon("UsersThree", 20)}
            } else {
                span {
                    "data-part": "avatar-initial",
                    style: "display:flex;width:100%;overflow:hidden;align-items:center;justify-content:center;",
                    "{letter}"
                }
            }
        }
    }
}

fn character_avatar_with_asset(name: &str, asset_id: Option<&str>, class: &'static str) -> Element {
    character_avatar(name, class, asset_id)
}

fn editor_field(
    label: &str,
    value: &str,
    placeholder: Option<&str>,
    multiline: bool,
    tall: bool,
    required: bool,
) -> Element {
    let approx = (value.len() / 4).max(0);
    let approx_tokens = format!("≈ {approx} tokens");
    rsx! {
        label {
            class: "CharacterManagementPanel_editorField",
            span {
                class: "CharacterManagementPanel_fieldHeading",
                strong { "{label}" }
                if multiline {
                    small { "{approx_tokens}" }
                }
            }
            if multiline {
                textarea {
                    class: if tall {
                        "CharacterManagementPanel_textareaTall"
                    } else {
                        "CharacterManagementPanel_textarea"
                    },
                    value: "{value}",
                    placeholder: placeholder.unwrap_or(""),
                    required: required,
                }
            } else {
                input {
                    value: "{value}",
                    placeholder: placeholder.unwrap_or(""),
                    required: required,
                }
            }
        }
    }
}

fn cards_tab(view: &ProductShellView) -> Element {
    let loaded = view.characters.len();
    let list_active = view.view != "grid";
    let empty = view.characters.is_empty();
    rsx! {
        div {
            class: "CharacterManagementPanel_cardsTab",
            "data-part": "character-cards",
            style: "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;gap:12px;padding:8px 16px 16px;",
            div {
                class: "st-action-bar CharacterManagementPanel_cardToolbar",
                "data-component": "action-bar",
                "data-align": "start",
                "data-collapse": "compact",
                "data-part": "character-card-toolbar",
                div {
                    "data-part": "inner",
                    div {
                        class: "st-action-bar-group",
                        "data-part": "group",
                        "data-role": "primary",
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            "data-has-icon": "start",
                            span { "data-part": "icon", "data-position": "start", "aria-hidden": "true", {icon_fill("Plus", 18, "#2a130b")} }
                            span { "data-part": "label", "New" }
                        }
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "default",
                            "data-size": "md",
                            "data-has-icon": "start",
                            span { "data-part": "icon", "data-position": "start", "aria-hidden": "true", {icon_fill("UploadSimple", 18, "#f3eee8")} }
                            span { "data-part": "label", "Import" }
                        }
                    }
                    label {
                        class: "CharacterManagementPanel_sortControl",
                        span { class: "CharacterManagementPanel_srOnly", "Sort characters" }
                        button {
                            r#type: "button",
                            "data-part": "sort",
                            "aria-haspopup": "listbox",
                            span { "{sort_label(&view.sort)}" }
                            {icon_fill("CaretDown", 14, "#998f87")}
                        }
                    }
                }
            }
            label {
                class: "CharacterManagementPanel_searchControl",
                style: "display:flex;flex-direction:row;align-items:center;gap:8px;padding:0 12px;min-height:40px;border:1px solid #39342f;border-radius:8px;background:#1e1b18;",
                {icon_fill("MagnifyingGlass", 17, "#998f87")}
                span {
                    class: "CharacterManagementPanel_srOnly",
                    style: "display:none;",
                    "Search characters..."
                }
                if view.search.trim().is_empty() {
                    span {
                        "data-part": "placeholder",
                        style: "color:#998f87;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;",
                        "Search characters..."
                    }
                }
                input {
                    r#type: "search",
                    // Theme SDK hook for the native hit-rect snapshot
                    // (`presentation_chat::hit_rects`) — mirrors React's
                    // CharacterManagementPanel search control.
                    "data-component": "text-field",
                    "data-part": "search",
                    placeholder: "Search characters...",
                    value: "{view.search}",
                    style: if view.search.trim().is_empty() {
                        "flex:1;min-width:0;background:transparent;border:none;outline:none;color:transparent;font-size:14px;"
                    } else {
                        "flex:1;min-width:0;background:transparent;border:none;outline:none;color:#f3eee8;font-size:14px;"
                    }
                }
            }
            div {
                class: "CharacterManagementPanel_listMeta",
                style: "display:flex;flex-direction:row;flex-wrap:nowrap;width:100%;align-items:center;justify-content:space-between;box-sizing:border-box;padding:4px 0;",
                div {
                    class: "CharacterManagementPanel_viewToggle",
                    "data-part": "view-toggle",
                    "aria-label": "Character view",
                    style: "display:flex;flex:none;flex-direction:row;align-items:center;padding:2px;gap:2px;border:1px solid #39342f;border-radius:8px;background:#1e1b18;",
                    button {
                        class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "ghost",
                        "data-icon": "",
                        "data-state": if list_active { "active" } else { "inactive" },
                        "aria-label": "List view",
                        "aria-pressed": list_active,
                        style: if list_active {
                            "display:flex;align-items:center;justify-content:center;width:30px;height:28px;min-width:30px;min-height:28px;padding:0;border:none;border-radius:6px;background:#352e28;color:#f3eee8;"
                        } else {
                            "display:flex;align-items:center;justify-content:center;width:30px;height:28px;min-width:30px;min-height:28px;padding:0;border:none;border-radius:6px;background:transparent;color:#998f87;"
                        },
                        {icon("List", 16)}
                    }
                    button {
                        class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "ghost",
                        "data-icon": "",
                        "data-state": if list_active { "inactive" } else { "active" },
                        "aria-label": "Grid view",
                        "aria-pressed": !list_active,
                        style: if !list_active {
                            "display:flex;align-items:center;justify-content:center;width:30px;height:28px;min-width:30px;min-height:28px;padding:0;border:none;border-radius:6px;background:#352e28;color:#f3eee8;"
                        } else {
                            "display:flex;align-items:center;justify-content:center;width:30px;height:28px;min-width:30px;min-height:28px;padding:0;border:none;border-radius:6px;background:transparent;color:#998f87;"
                        },
                        {icon("SquaresFour", 16)}
                    }
                }
                div {
                    class: "CharacterManagementPanel_loadedCount",
                    "data-part": "loaded-count",
                    style: "display:flex;flex:none;align-items:center;justify-content:flex-end;color:#998f87;font-size:12px;font-weight:400;height:28px;line-height:28px;text-align:right;white-space:nowrap;",
                    "{loaded} loaded"
                }
            }
            if empty {
                div {
                    class: "CharacterManagementPanel_emptyState",
                    {icon("UsersThree", 32)}
                    strong {
                        if view.search.trim().is_empty() {
                            "Your cast starts here"
                        } else {
                            "No matching characters"
                        }
                    }
                    p {
                        if view.search.trim().is_empty() {
                            "Create a character or import an existing JSON or PNG character card."
                        } else {
                            "Try a shorter name, another tag, or clear the search."
                        }
                    }
                }
            } else {
                div {
                    class: "CharacterManagementPanel_characterList",
                    "data-view": "{view.view}",
                    style: if view.view == "grid" {
                        "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:100%;box-sizing:border-box;flex:1;min-height:0;overflow:auto;"
                    } else {
                        "display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box;flex:1;min-height:0;overflow:auto;"
                    },
                    for item in view.characters.iter() {
                        {
                            let selected = view.selected_character_id.as_deref() == Some(item.id.as_str());
                            // React fallback: pinned defaults to selected when pinned is None (Home pinned character).
                            let pinned = view
                                .pinned_character_id
                                .as_deref()
                                .or(view.selected_character_id.as_deref())
                                == Some(item.id.as_str());
                            let desc_raw = character_card_description(&item.description);
                            let desc = if desc_raw.chars().count() > 80 {
                                let base: String = desc_raw.chars().take(78).collect();
                                format!("{}...", base.trim_end_matches([',', '.', ' ', ';', ':']))
                            } else {
                                desc_raw.to_string()
                            };
                            let card_style = if selected { "border-color:#e38a62;background:#492a20;" } else { "" };
                            rsx! {
                                button {
                                    class: "CharacterManagementPanel_characterCard",
                                    r#type: "button",
                                    style: "{card_style}",
                                    "data-part": "character-card",
                                    "data-name": "{item.name}",
                                    "data-state": if selected { "selected" } else { "idle" },
                                    "data-pinned": if pinned { "true" } else { "false" },
                                    "aria-pressed": selected,
                                    {character_avatar_with_asset(&item.name, item.avatar_asset_id.as_deref(), "CharacterManagementPanel_cardAvatar")}
                                    span {
                                        class: "CharacterManagementPanel_cardCopy",
                                        strong { "{item.name}" }
                                        span {
                                            "data-part": "card-description",
                                            style: "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;",
                                            "{desc}"
                                        }
                                        if !item.tags.is_empty() {
                                            span {
                                                class: "CharacterManagementPanel_tags",
                                                for tag in item.tags.iter().take(3) {
                                                    span { "{tag}" }
                                                }
                                            }
                                        }
                                    }
                                    if pinned {
                                        span {
                                            class: "CharacterManagementPanel_pinnedIcon",
                                            "aria-label": "Pinned",
                                            {icon_fill("PushPin", 18, "#e38a62")}
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn character_card_viewer(_view: &ProductShellView, draft: &CharacterDraftView) -> Element {
    let character_name = if draft.name.is_empty() {
        "Unnamed character"
    } else {
        draft.name.as_str()
    };
    rsx! {
        div {
            class: "CharacterManagementPanel_viewer",
            "data-component": "character-card-viewer",
            "data-part": "character-viewer",
            "data-state": "read-only",
            style: "padding:16px;display:flex;flex-direction:column;gap:16px;overflow-y:auto;flex:1;min-height:0;box-sizing:border-box;",
            section {
                class: "CharacterManagementPanel_viewerIdentity",
                "data-part": "character-viewer-identity",
                style: "display:flex;align-items:center;gap:12px;",
                {character_avatar_with_asset(&draft.name, draft.avatar_asset_id.as_deref(), "CharacterManagementPanel_viewerAvatar")}
                div {
                    class: "CharacterManagementPanel_viewerIdentityCopy",
                    style: "display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;",
                    h2 {
                        style: "margin:0;font-size:1.125rem;font-weight:600;color:#f3eee8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                        "{character_name}"
                    }
                    div {
                        class: "CharacterManagementPanel_viewerTags",
                        "data-part": "character-viewer-tags",
                        style: "display:flex;flex-wrap:wrap;gap:4px;",
                        if draft.tags.is_empty() {
                            small { style: "color:#998f87;font-size:0.75rem;", "No tags" }
                        } else {
                            for tag in draft.tags.iter() {
                                span {
                                    key: "{tag}",
                                    style: "display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;background:#2a2622;color:#c5bbb2;font-size:0.75rem;",
                                    "{tag}"
                                }
                            }
                        }
                    }
                }
            }
            if !draft.creator_notes.trim().is_empty() {
                div {
                    class: "CharacterManagementPanel_viewerDisclosures",
                    "data-part": "character-viewer-creator-notes",
                    style: "padding:12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;display:flex;flex-direction:column;gap:6px;",
                    strong { style: "color:#f3eee8;font-size:0.8125rem;", "Creator's notes" }
                    p { style: "margin:0;color:#c5bbb2;font-size:0.8125rem;line-height:1.4;white-space:pre-wrap;", "{draft.creator_notes}" }
                }
            }
            div {
                class: "CharacterManagementPanel_viewerDisclosures",
                "data-part": "character-viewer-details",
                style: "display:flex;flex-direction:column;gap:8px;",
                if !draft.description.trim().is_empty() {
                    details {
                        class: "CharacterManagementPanel_viewerDisclosure",
                        "data-part": "character-viewer-description",
                        open: true,
                        style: "border:1px solid #39342f;border-radius:10px;background:#1e1b18;padding:8px 12px;",
                        summary {
                            style: "cursor:pointer;font-weight:600;font-size:0.8125rem;color:#f3eee8;padding:4px 0;",
                            "Description"
                        }
                        div {
                            class: "CharacterManagementPanel_viewerMarkdown",
                            style: "padding:8px 0 4px;color:#c5bbb2;font-size:0.8125rem;line-height:1.4;white-space:pre-wrap;",
                            p { style: "margin:0;", "{draft.description}" }
                        }
                    }
                }
                if !draft.first_message.trim().is_empty() || !draft.alternate_greetings.is_empty() {
                    details {
                        class: "CharacterManagementPanel_viewerDisclosure",
                        "data-part": "character-viewer-greetings",
                        open: true,
                        style: "border:1px solid #39342f;border-radius:10px;background:#1e1b18;padding:8px 12px;",
                        summary {
                            style: "cursor:pointer;font-weight:600;font-size:0.8125rem;color:#f3eee8;padding:4px 0;",
                            "Greetings"
                        }
                        div {
                            class: "CharacterManagementPanel_viewerGreetingList",
                            style: "display:flex;flex-direction:column;gap:8px;padding:8px 0 4px;",
                            if !draft.first_message.trim().is_empty() {
                                div {
                                    class: "CharacterManagementPanel_viewerDisclosure",
                                    "data-part": "character-viewer-greeting",
                                    style: "padding:8px;border-radius:8px;background:#24211e;",
                                    strong { style: "display:block;margin-bottom:4px;color:#f3eee8;font-size:0.75rem;", "First message" }
                                    p { style: "margin:0;color:#c5bbb2;font-size:0.8125rem;line-height:1.4;white-space:pre-wrap;", "{draft.first_message}" }
                                }
                            }
                            for (index, greeting) in draft.alternate_greetings.iter().enumerate() {
                                {
                                    let label = format!("Alternate greeting #{}", index + 1);
                                    rsx! {
                                        div {
                                            class: "CharacterManagementPanel_viewerDisclosure",
                                            key: "{index}",
                                            "data-part": "character-viewer-greeting",
                                            style: "padding:8px;border-radius:8px;background:#24211e;",
                                            strong { style: "display:block;margin-bottom:4px;color:#f3eee8;font-size:0.75rem;", "{label}" }
                                            p { style: "margin:0;color:#c5bbb2;font-size:0.8125rem;line-height:1.4;white-space:pre-wrap;", "{greeting}" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn edit_tab(view: &ProductShellView, draft: &CharacterDraftView) -> Element {
    let first_msg_tokens = format!("≈ {} tokens", (draft.first_message.len() / 4).max(0));
    rsx! {
        div {
            class: "CharacterManagementPanel_editor",
            "data-part": "character-editor",
            div {
                class: "CharacterManagementPanel_characterActionBar",
                button {
                    class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                    r#type: "button",
                    "aria-label": "Back to character cards",
                    {icon("ArrowLeft", 18)}
                }
                span { class: "CharacterManagementPanel_actionBarSpacer" }
                button {
                    class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                    r#type: "button",
                    "data-state": if draft.favorite { "active" } else { "inactive" },
                    "aria-label": if draft.favorite { "Remove from favorites" } else { "Add to favorites" },
                    "aria-pressed": draft.favorite,
                    {icon("Star", 18)}
                }
                button {
                    class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                    r#type: "button",
                    "aria-label": "Export character card",
                    {icon("DownloadSimple", 18)}
                }
                button {
                    class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                    r#type: "button",
                    "aria-label": "Duplicate character",
                    {icon("Copy", 18)}
                }
                button {
                    class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                    r#type: "button",
                    "aria-label": "Delete character",
                    {icon("Trash", 18)}
                }
            }
            section {
                class: "CharacterManagementPanel_identity",
                button {
                    class: "CharacterManagementPanel_avatarButton",
                    r#type: "button",
                    "aria-label": "Change",
                    {character_avatar_with_asset(&draft.name, draft.avatar_asset_id.as_deref(), "CharacterManagementPanel_editorAvatar")}
                    span { {icon("Pencil", 11)} }
                }
                div {
                    h3 {
                        if draft.name.is_empty() { "Unnamed character" } else { "{draft.name}" }
                    }
                    p { "Identity, greeting, attribution, and tags." }
                }
            }
            label {
                class: "CharacterManagementPanel_editorField",
                style: "display:flex;flex-direction:column;gap:4px;height:56px;box-sizing:border-box;",
                span { class: "CharacterManagementPanel_fieldHeading", strong { "Name" } }
                span {
                    "data-part": "character-name-input",
                    style: "display:block;width:100%;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;",
                    "{draft.name}"
                }
            }
            label {
                class: "CharacterManagementPanel_editorField",
                style: "display:flex;flex-direction:column;gap:4px;height:88px;box-sizing:border-box;",
                span { class: "CharacterManagementPanel_fieldHeading", strong { "Description" } }
                span {
                    "data-part": "character-description-input",
                    style: "display:block;width:100%;height:64px;line-height:20px;padding:8px 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;overflow:hidden;box-sizing:border-box;",
                    if draft.description.is_empty() {
                        span { style: "color:#998f87;", "No character description yet." }
                    } else {
                        "{draft.description}"
                    }
                }
            }
            button {
                class: "st-button",
                r#type: "button",
                "data-part": "character-save",
                "data-variant": "primary",
                style: "width:96px;height:36px;",
                span { "data-part": "label", "Save" }
            }
            section {
                class: "CharacterManagementPanel_tagEditor",
                "data-part": "character-tag-editor",
                style: "display:flex;flex-direction:column;gap:8px;",
                strong { style: "height:20px;font-size:0.875rem;", "Tags" }
                div {
                    class: "CharacterManagementPanel_tagInputRow",
                    style: "display:flex;align-items:center;gap:8px;height:36px;",
                    span {
                        "data-part": "character-tag-input",
                        "aria-label": "New tag",
                        style: "flex:1;min-width:0;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;",
                        if view.tag_input.is_empty() {
                            span { style: "color:#998f87;", "Type one tag" }
                        } else {
                            "{view.tag_input}"
                        }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "default",
                        "data-size": "sm",
                        "data-part": "character-tag-add",
                        "aria-label": "Add tag",
                        style: "width:96px;height:36px;flex:none;",
                        span { "data-part": "icon", "aria-hidden": "true", {icon("Plus", 15)} }
                        span { "data-part": "label", "Add tag" }
                    }
                }
                if draft.tags.is_empty() {
                    small { class: "CharacterManagementPanel_inlineEmpty", "No tags assigned." }
                } else {
                    div {
                        class: "CharacterManagementPanel_tagChips",
                        "data-part": "character-tag-chips",
                        "aria-label": "Assigned tags",
                        style: "display:flex;flex-direction:column;gap:4px;",
                        for tag in draft.tags.iter() {
                            {
                                let tag = tag.clone();
                                let remove_aria = format!("Remove tag {tag}");
                                rsx! {
                                    button {
                                        class: "st-button",
                                        r#type: "button",
                                        key: "{tag}",
                                        "data-part": "character-tag-chip",
                                        "aria-label": "{remove_aria}",
                                        style: "height:28px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;width:100%;box-sizing:border-box;",
                                        span {
                                            style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                                            "{tag}"
                                        }
                                        span { "aria-hidden": "true", {icon("X", 13)} }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            label {
                class: "CharacterManagementPanel_editorField",
                style: "display:flex;flex-direction:column;gap:4px;height:88px;box-sizing:border-box;",
                span {
                    class: "CharacterManagementPanel_fieldHeading",
                    strong { "First message" }
                    small { "{first_msg_tokens}" }
                }
                span {
                    "data-part": "character-first-message-input",
                    style: "display:block;width:100%;height:64px;line-height:20px;padding:8px 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;overflow:hidden;box-sizing:border-box;",
                    if draft.first_message.is_empty() {
                        span { style: "color:#998f87;", "No opening message yet." }
                    } else {
                        "{draft.first_message}"
                    }
                }
            }
            label {
                class: "CharacterManagementPanel_editorField",
                style: "display:flex;flex-direction:column;gap:4px;height:88px;box-sizing:border-box;",
                span {
                    class: "CharacterManagementPanel_fieldHeading",
                    strong { "Creator's notes" }
                }
                span {
                    "data-part": "character-creator-notes-input",
                    style: "display:block;width:100%;height:64px;line-height:20px;padding:8px 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;overflow:hidden;box-sizing:border-box;",
                    if draft.creator_notes.is_empty() {
                        span { style: "color:#998f87;", "No creator notes yet." }
                    } else {
                        "{draft.creator_notes}"
                    }
                }
            }
            section {
                class: "CharacterManagementPanel_greetings",
                div {
                    class: "CharacterManagementPanel_subsectionHeader",
                    div {
                        strong { "Alternate greetings" }
                        small { "Additional opening messages available when a chat starts." }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "default",
                        "data-size": "sm",
                        "data-action": "character-greeting-add",
                        "data-part": "character-greeting-add",
                        span { "data-part": "label", "Add" }
                    }
                }
                if draft.alternate_greetings.is_empty() {
                    p { class: "CharacterManagementPanel_inlineEmpty", "No alternate greetings." }
                } else {
                    for (idx, greeting) in draft.alternate_greetings.iter().enumerate() {
                        {
                            let approx = (greeting.len() / 4).max(0);
                            let approx_tokens = format!("≈ {approx} tokens");
                            let label = format!("Greeting {}", idx + 1);
                            let is_open = view.expanded_greeting == Some(idx);
                            let state = if is_open { "open" } else { "closed" };
                            let idx_str = idx.to_string();
                            rsx! {
                                div {
                                    class: "CharacterManagementPanel_greetingItem",
                                    key: "{idx}",
                                    "data-state": "{state}",
                                    div {
                                        class: "CharacterManagementPanel_greetingHeader",
                                        button {
                                            class: "CharacterManagementPanel_greetingToggle",
                                            r#type: "button",
                                            "data-action": "character-greeting-toggle",
                                            "data-index": "{idx_str}",
                                            "aria-expanded": is_open,
                                            {icon("CaretDown", 15)}
                                            span {
                                                strong { "{label}" }
                                                small { "{approx_tokens}" }
                                            }
                                        }
                                        button {
                                            class: "CharacterManagementPanel_compactIconButton",
                                            r#type: "button",
                                            "data-action": "character-greeting-remove",
                                            "data-index": "{idx_str}",
                                            "aria-label": "Remove greeting {idx + 1}",
                                            {icon("Trash", 15)}
                                        }
                                    }
                                    if is_open {
                                        div {
                                            class: "CharacterManagementPanel_editorField",
                                            style: "padding:8px 12px;display:flex;flex-direction:column;gap:4px;",
                                            span {
                                                "data-part": "character-greeting-input",
                                                "data-index": "{idx_str}",
                                                style: "display:block;width:100%;min-height:64px;line-height:20px;padding:8px 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;overflow:hidden;box-sizing:border-box;",
                                                if greeting.is_empty() {
                                                    span { style: "color:#998f87;", "Type alternate greeting text..." }
                                                } else {
                                                    "{greeting}"
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn advanced_tab(view: &ProductShellView, draft: &CharacterDraftView) -> Element {
    let advanced_title = format!("{} — advanced definitions", draft.name);
    let talk_pct = (draft.talkativeness * 100.0).round() as i32;
    let talk_pct_label = format!("{talk_pct}%");
    let character_id = view.selected_character_id.clone().unwrap_or_default();
    let linked: Vec<LorebookCardView> = view
        .lorebooks
        .iter()
        .filter(|book| book.character_id.as_deref() == Some(character_id.as_str()))
        .cloned()
        .collect();
    let linked_empty = linked.is_empty();
    rsx! {
        div {
            class: "CharacterManagementPanel_editor",
            "data-part": "character-advanced",
            details {
                class: "CharacterManagementPanel_advancedSection",
                open: "",
                summary { "Lorebooks" }
                div {
                    class: "CharacterManagementPanel_advancedSectionBody",
                    "data-component": "character-lorebooks",
                    p { class: "CharacterManagementPanel_lorebookHint", "Books linked to this character are injected into its chats. Global books apply everywhere." }
                    div {
                        class: "CharacterManagementPanel_lorebookActions",
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "default",
                            "data-size": "sm",
                            span { "data-part": "icon", "aria-hidden": "true", {icon("Plus", 18)} }
                            span { "data-part": "label", "New book for {draft.name}" }
                        }
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "default",
                            "data-size": "sm",
                            span { "data-part": "label", "Open lorebooks" }
                        }
                    }
                    if linked_empty {
                        p { class: "CharacterManagementPanel_lorebookHint", "No books linked to this character yet." }
                    } else {
                        ul {
                            class: "CharacterManagementPanel_lorebookList",
                            for book in linked.iter() {
                                li {
                                    class: "CharacterManagementPanel_lorebookRow",
                                    span { class: "CharacterManagementPanel_lorebookName", "{book.name}" }
                                    button {
                                        class: "st-button",
                                        r#type: "button",
                                        "data-component": "button",
                                        "data-variant": "ghost",
                                        "data-size": "sm",
                                        span { "data-part": "label", "Unlink" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            div {
                class: "CharacterManagementPanel_sectionHeading",
                h3 { "{advanced_title}" }
                p { "Prompt fields used to keep roleplay behavior and context consistent." }
            }
            details {
                class: "CharacterManagementPanel_advancedSection",
                summary { "Prompt Overrides" }
                div {
                    class: "CharacterManagementPanel_advancedSectionBody",
                    p { "These values replace the corresponding defaults for this character." }
                    {editor_field("System prompt", &draft.system_prompt, None, true, false, false)}
                    {editor_field("Post-history instructions", &draft.post_history_instructions, None, true, false, false)}
                }
            }
            details {
                class: "CharacterManagementPanel_advancedSection",
                summary { "Creator's Metadata" }
                div {
                    class: "CharacterManagementPanel_advancedSectionBody",
                    p { "Optional metadata; it is not sent with the AI prompt." }
                    {editor_field("Creator", &draft.creator, None, false, false, false)}
                    {editor_field("Character version", &draft.character_version, None, false, false, false)}
                }
            }
            {editor_field("Personality summary", &draft.personality, Some("A brief description of the personality"), true, false, false)}
            {editor_field("Scenario", &draft.scenario, Some("Circumstances and context of the interaction"), true, false, false)}
            section {
                class: "CharacterManagementPanel_noteSection",
                {editor_field("Character's Note", &draft.character_note, Some("Text inserted into the chat prompt at the selected depth and role"), true, false, false)}
                div {
                    class: "CharacterManagementPanel_noteControls",
                    label {
                        class: "CharacterManagementPanel_compactField",
                        span { "Depth" }
                        input {
                            r#type: "number",
                            min: "0",
                            max: "9999",
                            value: "{draft.character_note_depth}",
                        }
                    }
                    label {
                        class: "CharacterManagementPanel_compactField",
                        span { "Role" }
                        select {
                            value: "{draft.character_note_role}",
                            option { value: "system", "System" }
                            option { value: "user", "User" }
                            option { value: "assistant", "Assistant" }
                        }
                    }
                }
            }
            label {
                class: "CharacterManagementPanel_rangeField",
                span {
                    class: "CharacterManagementPanel_fieldHeading",
                    strong { "Talkativeness" }
                    small { "{talk_pct_label}" }
                }
                input {
                    r#type: "range",
                    min: "0",
                    max: "1",
                    step: "0.05",
                    value: "{draft.talkativeness}",
                }
                span {
                    class: "CharacterManagementPanel_rangeLabels",
                    small { "Shy" }
                    small { "Normal" }
                    small { "Chatty" }
                }
            }
            {editor_field("Example dialogues", &draft.example_dialogues, Some("Begin each example with <START> on a new line."), true, true, false)}
        }
    }
}

/// Character gallery (React `GalleryTab`). Kernel plane has no gallery
/// catalog (`useCharacterGallery` → `[]`; upload/delete → `UnsupportedError`).
/// When the character has an avatar that is not a gallery item (always, on
/// this plane), the grid shows it as the primary figure — never a `data:` URI.
fn gallery_tab(view: &ProductShellView, draft: &CharacterDraftView) -> Element {
    let columns = if (1..=4).contains(&view.gallery_columns) {
        view.gallery_columns
    } else {
        3
    };
    let columns_s = columns.to_string();
    let sort_newest = view.gallery_sort == "newest";
    let has_avatar = draft.avatar_asset_id.is_some();
    let name = if draft.name.is_empty() {
        "Unnamed character".to_string()
    } else {
        draft.name.clone()
    };
    let asset_id = draft.avatar_asset_id.clone();
    rsx! {
        div {
            class: "CharacterManagementPanel_gallery",
            "data-part": "character-gallery",
            div {
                class: "CharacterManagementPanel_galleryToolbar",
                div {
                    class: "CharacterManagementPanel_galleryHeading",
                    "data-part": "gallery-heading",
                    h3 { "Image Gallery" }
                    p { "Character-owned images stored locally with their originals preserved." }
                }
                div {
                    class: "CharacterManagementPanel_galleryControls",
                    "data-part": "gallery-controls",
                    label {
                        class: "CharacterManagementPanel_sortControl",
                        "data-part": "gallery-columns",
                        span { class: "CharacterManagementPanel_srOnly", "Gallery columns" }
                        select {
                            value: "{columns_s}",
                            option { value: "1", selected: columns == 1, "1 column" }
                            option { value: "2", selected: columns == 2, "2 columns" }
                            option { value: "3", selected: columns == 3, "3 columns" }
                            option { value: "4", selected: columns == 4, "4 columns" }
                        }
                    }
                    label {
                        class: "CharacterManagementPanel_sortControl",
                        "data-part": "gallery-sort",
                        span { class: "CharacterManagementPanel_srOnly", "Sort gallery images" }
                        select {
                            value: if sort_newest { "newest" } else { "oldest" },
                            option { value: "oldest", selected: !sort_newest, "Oldest" }
                            option { value: "newest", selected: sort_newest, "Newest" }
                        }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "default",
                        "data-size": "sm",
                        "data-part": "gallery-add",
                        span { "data-part": "icon", "aria-hidden": "true", {icon("Plus", 18)} }
                        span { "data-part": "label", "Add image" }
                    }
                }
            }
            if has_avatar {
                div {
                    class: "CharacterManagementPanel_galleryGrid",
                    "data-part": "gallery-grid",
                    "data-columns": "{columns_s}",
                    figure {
                        class: "CharacterManagementPanel_galleryItem",
                        "data-part": "gallery-figure",
                        "data-state": "primary",
                        {character_avatar_with_asset(
                            &name,
                            asset_id.as_deref(),
                            "CharacterManagementPanel_galleryAvatar",
                        )}
                        figcaption {
                            span {
                                strong { "{name}" }
                                small { "Primary avatar" }
                            }
                            span {
                                class: "CharacterManagementPanel_galleryActions",
                                {icon("Check", 17)}
                            }
                        }
                    }
                }
            } else {
                div {
                    class: "CharacterManagementPanel_emptyState",
                    "data-part": "gallery-empty",
                    {icon("Image", 34)}
                    strong { "No gallery images" }
                    p { "Add PNG, JPEG, WebP, or GIF images from this device." }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "default",
                        "data-size": "md",
                        "data-part": "gallery-add",
                        span { "data-part": "icon", "aria-hidden": "true", {icon("Plus", 18)} }
                        span { "data-part": "label", "Add image" }
                    }
                }
            }
        }
    }
}

fn character_manager(view: &ProductShellView) -> Element {
    let can_edit = view.selected_character_id.is_some();
    let selected = view
        .characters
        .iter()
        .find(|item| Some(item.id.as_str()) == view.selected_character_id.as_deref());
    let tab = view.tab.as_str();
    let (_pad_top, pad_bottom) = chrome_insets(view);
    let header_min = 52.0_f32;
    let header_title = character_manager_title(view.chat.viewport_width);
    let root_style = "display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:rgba(36,33,30,0.72);";
    let header_style = format!(
        "flex:none;position:relative;z-index:0;display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;min-width:0;width:100%;overflow:hidden;padding:8px 16px 8px;min-height:{header_min}px;background:transparent;"
    );
    let body_style = format!(
        "flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;position:relative;padding-bottom:{pad_bottom}px;"
    );
    let tabs_style = "display:flex;flex-direction:row;flex:none;box-sizing:border-box;align-self:stretch;position:static;width:auto;max-width:100%;order:0;z-index:0;margin:8px 16px 8px;padding:4px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;";
    let cards_tab_style = tab_trigger_style(tab == "cards");
    let edit_tab_style = tab_trigger_style(tab == "edit");
    let advanced_tab_style = tab_trigger_style(tab == "advanced");
    let gallery_tab_style = tab_trigger_style(tab == "gallery");
    rsx! {
        div {
            class: "FloatingTabPanel_root",
            style: "{root_style}",
            "data-component": "character-management",
            "data-role": "floating-tab-panel",
            header {
                class: "SidebarPanelHeader_header",
                style: "{header_style}",
                "data-component": "sidebar-panel-header",
                "data-part": "character-management-header",
                div {
                    class: "SidebarPanelHeader_identity",
                    "data-part": "identity",
                    style: "display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;min-width:0;flex:1 1 auto;",
                    span {
                        class: "SidebarPanelHeader_avatar",
                        "data-part": "avatar",
                        {character_avatar_with_asset(
                            selected.map(|item| item.name.as_str()).unwrap_or(""),
                            selected.and_then(|item| item.avatar_asset_id.as_deref()),
                            "CharacterManagementPanel_headerAvatar",
                        )}
                    }
                    div {
                        class: "SidebarPanelHeader_copy",
                        "data-part": "title-group",
                        style: "min-width:0;flex:1 1 auto;overflow:hidden;",
                        h2 {
                            class: "SidebarPanelHeader_title",
                            "data-part": "title",
                            style: "font-size:13.5px;font-weight:600;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto;margin:0;color:#f3eee8;",
                            "{header_title}"
                        }
                    }
                }
                div {
                    class: "SidebarPanelHeader_actions",
                    "data-part": "actions",
                    style: "display:flex;flex:none;align-items:center;",
                    if view.tab == "edit" && view.editor_mode == "view" {
                        button {
                            class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "ghost",
                            "data-icon": "",
                            "data-action": "character-edit-mode",
                            style: "min-width:40px;min-height:40px;width:40px;height:40px;padding:0;flex:none;background:transparent;",
                            disabled: !can_edit,
                            "aria-label": "Edit card",
                            title: "Edit card",
                            {icon("Pencil", 19)}
                        }
                    } else {
                        button {
                            class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "ghost",
                            "data-icon": "",
                            "data-action": "character-view-mode",
                            style: "min-width:40px;min-height:40px;width:40px;height:40px;padding:0;flex:none;background:transparent;",
                            disabled: !can_edit,
                            "aria-label": "View character card",
                            title: "View character card",
                            {icon("Eye", 19)}
                        }
                    }
                }
                button {
                    class: "SidebarPanelHeader_close",
                    r#type: "button",
                    "data-part": "close",
                    style: "min-width:40px;min-height:40px;width:40px;height:40px;padding:0;flex:none;background:transparent;",
                    "aria-label": "Close menu",
                    {icon("X", 20)}
                }
            }
            div {
                class: "SidebarPanelHeader_headerDivider",
                "data-part": "header-divider",
                style: "flex:none;width:100%;height:1px;min-height:1px;background:#39342f;pointer-events:none;",
            }
            div {
                class: "st-tabs CharacterManagementPanel_tabs",
                style: "{body_style}",
                "data-component": "tabs",
                "data-variant": "segment",
                "data-scroll-mode": "root",
                div {
                    "data-component": "tabs-list",
                    "data-part": "list",
                    "data-variant": "segment",
                    "data-layout": "content",
                    "aria-label": "Character management sections",
                    style: "{tabs_style}",
                    button {
                        "data-component": "tabs-trigger",
                        "data-part": "trigger",
                        "data-state": if tab == "cards" { "active" } else { "inactive" },
                        style: "{cards_tab_style}",
                        "Cards"
                    }
                    button {
                        "data-component": "tabs-trigger",
                        "data-part": "trigger",
                        "data-state": if tab == "edit" { "active" } else { "inactive" },
                        disabled: !can_edit,
                        style: "{edit_tab_style}",
                        "Edit"
                    }
                    button {
                        "data-component": "tabs-trigger",
                        "data-part": "trigger",
                        "data-state": if tab == "advanced" { "active" } else { "inactive" },
                        disabled: !can_edit,
                        style: "{advanced_tab_style}",
                        "Advanced"
                    }
                    button {
                        "data-component": "tabs-trigger",
                        "data-part": "trigger",
                        "data-state": if tab == "gallery" { "active" } else { "inactive" },
                        disabled: !can_edit,
                        style: "{gallery_tab_style}",
                        "Gallery"
                    }
                }
                div {
                    "data-component": "tabs-scroll-content",
                    "data-part": "scroll-content",
                    // Packed css gives the scroll root `flex:1;min-height:0`
                    // inside the tab column; Blitz misses those descendant
                    // rules, so the geometry rides inline. Explicit `order`
                    // keeps the list above the content (a packed `order:1`
                    // rule otherwise leaks onto the wrong node).
                    style: "flex:1 1 0%;min-height:0;overflow:hidden;display:flex;flex-direction:column;order:1;",
                    div {
                        class: "CharacterManagementPanel_tabPanel",
                        "data-component": "tabs-content",
                        "data-part": "content",
                        div {
                            "data-part": "floating-tab-content",
                            match tab {
                                "cards" => {cards_tab(view)},
                                "edit" => {
                                    if let Some(draft) = &view.selected_draft {
                                        if view.editor_mode == "view" {
                                            character_card_viewer(view, draft)
                                        } else {
                                            edit_tab(view, draft)
                                        }
                                    } else {
                                        cards_tab(view)
                                    }
                                }
                                "advanced" => {
                                    if let Some(draft) = &view.selected_draft {
                                        {advanced_tab(view, draft)}
                                    } else {
                                        {cards_tab(view)}
                                    }
                                }
                                "gallery" => {
                                    if let Some(draft) = &view.selected_draft {
                                        {gallery_tab(view, draft)}
                                    } else {
                                        {cards_tab(view)}
                                    }
                                }
                                _ => {cards_tab(view)},
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Modal geometry in window CSS px — centered over the chat main area with
/// the React dialog sizes. Mirrors `shell_hit::dialog_hit` (rail 60 + panel
/// 380 offset on non-compact open sidebars).
fn modal_geometry(view: &ProductShellView, dw: f32, dh: f32) -> (f32, f32, f32, f32) {
    let width = view.chat.viewport_width.max(1) as f32;
    let height = view.chat.viewport_height.max(1) as f32;
    let compact = width <= 600.0;
    let panel_w = if view.panel_width < 1.0 {
        380.0
    } else {
        view.panel_width.clamp(260.0, 720.0)
    };
    let chat_x0 = if compact {
        0.0
    } else if view.sidebar_open {
        60.0 + panel_w
    } else {
        60.0
    };
    (
        chat_x0 + (width - chat_x0 - dw).max(0.0) * 0.5,
        (height - dh) * 0.5,
        dw,
        dh,
    )
}

/// React `Switch` track + thumb styles for the entry dialog rows — same
/// geometry as the entries-row switch (36×20 track, 16×16 thumb).
fn entry_switch_style(on: bool) -> (String, String) {
    let track = if on {
        "display:inline-flex;width:36px;height:20px;border-radius:10px;background:#e38a62;position:relative;flex:none;"
    } else {
        "display:inline-flex;width:36px;height:20px;border-radius:10px;background:#39342f;position:relative;flex:none;"
    };
    let thumb = if on {
        "position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:8px;background:#2a130b;"
    } else {
        "position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:8px;background:#998f87;"
    };
    (track.to_string(), thumb.to_string())
}

/// Shared React `FloatingTabPanel` chrome: header, divider, body, bottom tabs.
pub(crate) fn management_shell(
    view: &ProductShellView,
    component: &'static str,
    header_part: &'static str,
    title: &str,
    avatar_icon: &'static str,
    avatar_letter: Option<&str>,
    tabs: &[PanelTab],
    active_tab: &str,
    body: Element,
) -> Element {
    let (_pad_top, pad_bottom) = chrome_insets(view);
    let header_min = 52.0_f32;
    let header_title = panel_header_title(title, view.chat.viewport_width);
    let root_style = "display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:rgba(36,33,30,0.72);";
    let header_style = format!(
        "flex:none;position:relative;z-index:0;display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;min-width:0;width:100%;overflow:hidden;padding:8px 16px 8px;min-height:{header_min}px;background:transparent;"
    );
    let body_style = format!(
        "flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;position:relative;padding-bottom:{pad_bottom}px;"
    );
    let tabs_style = "display:flex;flex-direction:row;flex:none;box-sizing:border-box;align-self:stretch;position:static;width:auto;max-width:100%;order:0;z-index:0;margin:8px 16px 8px;padding:4px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;";
    let letter = avatar_letter.unwrap_or("");
    rsx! {
        div {
            class: "FloatingTabPanel_root",
            style: "{root_style}",
            "data-component": "{component}",
            "data-role": "floating-tab-panel",
            header {
                class: "SidebarPanelHeader_header",
                style: "{header_style}",
                "data-component": "sidebar-panel-header",
                "data-part": "{header_part}",
                div {
                    class: "SidebarPanelHeader_identity",
                    "data-part": "identity",
                    style: "display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;min-width:0;flex:1 1 auto;",
                    span {
                        class: "SidebarPanelHeader_avatar",
                        "data-part": "avatar",
                        style: "width:44px;height:44px;max-width:44px;max-height:44px;flex:none;align-self:center;overflow:hidden;display:flex;align-items:center;justify-content:center;",
                        if letter.is_empty() {
                            {icon(avatar_icon, 20)}
                        } else {
                            span {
                                "data-part": "avatar-initial",
                                style: "display:flex;width:100%;overflow:hidden;align-items:center;justify-content:center;font-weight:600;",
                                "{letter}"
                            }
                        }
                    }
                    div {
                        class: "SidebarPanelHeader_copy",
                        "data-part": "title-group",
                        style: "min-width:0;flex:1 1 auto;overflow:hidden;",
                        h2 {
                            class: "SidebarPanelHeader_title",
                            "data-part": "title",
                            style: "font-size:13.5px;font-weight:600;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto;margin:0;color:#f3eee8;",
                            "{header_title}"
                        }
                    }
                }
                button {
                    class: "SidebarPanelHeader_close",
                    r#type: "button",
                    "data-part": "close",
                    style: "min-width:40px;min-height:40px;width:40px;height:40px;padding:0;flex:none;background:transparent;",
                    "aria-label": "Close menu",
                    {icon("X", 20)}
                }
            }
            div {
                class: "SidebarPanelHeader_headerDivider",
                "data-part": "header-divider",
                style: "flex:none;width:100%;height:1px;min-height:1px;background:#39342f;pointer-events:none;",
            }
            div {
                class: "st-tabs",
                style: "{body_style}",
                "data-component": "tabs",
                "data-variant": "segment",
                "data-scroll-mode": "root",
                if !tabs.is_empty() {
                    div {
                        "data-component": "tabs-list",
                        "data-part": "list",
                        "data-variant": "segment",
                        "data-layout": "content",
                        style: "{tabs_style}",
                        for tab in tabs.iter() {
                            {
                                let style = tab_trigger_style(tab.id == active_tab);
                                let state = if tab.id == active_tab { "active" } else { "inactive" };
                                rsx! {
                                    button {
                                        "data-component": "tabs-trigger",
                                        "data-part": "trigger",
                                        "data-state": "{state}",
                                        disabled: tab.disabled,
                                        style: "{style}",
                                        "{tab.label}"
                                    }
                                }
                            }
                        }
                    }
                }
                div {
                    "data-component": "tabs-scroll-content",
                    "data-part": "scroll-content",
                    style: "flex:1 1 0%;min-height:0;overflow:hidden;display:flex;flex-direction:column;order:1;",
                    div {
                        "data-component": "tabs-content",
                        "data-part": "content",
                        div {
                            "data-part": "floating-tab-content",
                            {body}
                        }
                    }
                }
            }
        }
    }
}

pub(crate) fn overlay_dialog(title: &str, description: &str, body: Element) -> Element {
    rsx! {
        div {
            "data-component": "dialog-overlay",
            "data-state": "open",
            div {
                "data-component": "dialog-content",
                role: "dialog",
                "aria-modal": "true",
                h2 { "data-component": "dialog-title", "{title}" }
                p { "data-component": "dialog-description", "{description}" }
                {body}
            }
        }
    }
}

/// Fallback for any unmigrated or unknown route/panel. WebView is a
/// temporary migration blocker only; unknown routes must render this Rust
/// surface, never a hidden WebView.
fn not_yet_migrated(title: &str) -> Element {
    rsx! {
        div {
            class: "FloatingTabPanel_root",
            "data-component": "not-yet-migrated",
            "data-role": "floating-tab-panel",
            header {
                class: "SidebarPanelHeader_header",
                "data-component": "sidebar-panel-header",
                "data-part": "header",
                div {
                    class: "SidebarPanelHeader_identity",
                    "data-part": "identity",
                    div {
                        class: "SidebarPanelHeader_copy",
                        "data-part": "title-group",
                        h2 { class: "SidebarPanelHeader_title", "data-part": "title", "{title}" }
                    }
                }
                button {
                    class: "SidebarPanelHeader_close",
                    r#type: "button",
                    "data-part": "close",
                    "aria-label": "Close menu",
                    {icon("X", 20)}
                }
            }
            p {
                "data-part": "not-yet-migrated",
                style: "padding: 16px;",
                "This surface is not yet migrated."
            }
        }
    }
}

fn bottom_nav_bar(view: &ProductShellView) -> Element {
    let (_, pad_bottom) = chrome_insets(view);
    let nav_style = format!(
        "display:flex;flex-direction:row;align-items:center;justify-content:space-around;width:100%;min-height:56px;padding-bottom:{pad_bottom}px;background:#151311;border-top:1px solid #39342f;flex:none;z-index:100;"
    );
    let nav_items: &[RailSpec] = &[
        RailSpec {
            theme_id: "chats",
            panel: "home",
            label: "Chats",
            icon: "ChatsCircle",
        },
        RailSpec {
            theme_id: "characters",
            panel: "characters",
            label: "Characters",
            icon: "UsersThree",
        },
        RailSpec {
            theme_id: "personas",
            panel: "personas",
            label: "Personas",
            icon: "Smiley",
        },
        RailSpec {
            theme_id: "lorebooks",
            panel: "lorebooks",
            label: "Lorebooks",
            icon: "BookOpenText",
        },
        RailSpec {
            theme_id: "settings",
            panel: "settings",
            label: "Settings",
            icon: "SlidersHorizontal",
        },
    ];
    rsx! {
        nav {
            class: "BottomNav_root",
            style: "{nav_style}",
            "data-component": "bottom-navigation",
            "aria-label": "Mobile navigation",
            for item in nav_items.iter() {
                {
                    let active = if !view.sidebar_open {
                        item.panel == "home"
                    } else {
                        view.panel == item.panel
                    };
                    let fill = if active { "#ffc4a8" } else { "#998f87" };
                    let text_color = if active { "#ffc4a8" } else { "#998f87" };
                    let btn_style = format!(
                        "display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;min-height:48px;padding:4px 0;background:transparent;border:none;color:{text_color};"
                    );
                    rsx! {
                        button {
                            class: "BottomNav_item",
                            r#type: "button",
                            style: "{btn_style}",
                            "data-part": "bottom-nav-item",
                            "data-item": "{item.theme_id}",
                            "data-state": if active { "active" } else { "inactive" },
                            "aria-label": "{item.label}",
                            {icon_fill(item.icon, 22, fill)}
                            span {
                                style: "font-size:11px;font-weight:500;margin-top:2px;color:{text_color};",
                                "{item.label}"
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Product App Shell with Character Manager as the first golden route.
pub fn product_shell_app() -> Element {
    let view = current_product_shell();
    let is_compact = view.chat.viewport_width <= 600;
    let rail_state = if view.rail_expanded {
        "expanded"
    } else {
        "collapsed"
    };
    let sidebar_state = if view.sidebar_open { "open" } else { "closed" };
    // The main area's geometry is fully inline: this Blitz build mis-resolves
    // the packed `margin-left: calc(60px + min(clamp(...), calc(100% - 60px)))`
    // at wide windows (the chat then shifts right past the sidebar edge, and
    // the capped 1080 column loses its centering). The flex row already places
    // the main right after the rail + sidebar, so no margin is needed; the
    // translucent frame background is inlined as well.
    let main_style = format!(
        "flex:1 1 auto;width:auto;height:100%;min-width:0;min-height:0;overflow:hidden;position:relative;z-index:1;margin-left:0;background:rgba(27,25,23,0.7);"
    );
    let panel_title = RAIL
        .iter()
        .find(|item| item.panel == view.panel)
        .map(|item| item.label)
        .unwrap_or("Home");
    let (pad_top, pad_bottom) = chrome_insets(&view);
    let rtl = view.dir == "rtl";
    // React `AppShell` status strip sits right of the 60px rail with a 12px
    // gutter (`AppShell.module.css` grid); the slot is passive either way.
    let status_left = if rtl { 8.0 } else { 72.0 };
    let (pad_start, pad_end) = if rtl {
        (view.insets.right, view.insets.left)
    } else {
        (view.insets.left, view.insets.right)
    };
    let panel_w = if view.panel_width < 1.0 {
        380.0
    } else {
        view.panel_width.clamp(260.0, 720.0)
    };
    let rail_pad = format!(
        "flex:none;width:60px;height:100%;z-index:2;box-sizing:border-box;padding-bottom:{pad_bottom}px;padding-left:calc(4px + {pad_start}px);padding-right:calc(4px + {pad_end}px);background:rgba(21,19,17,0.82);"
    );
    let panel_pad = if is_compact {
        format!(
            "display:flex;flex-direction:column;flex:1 1 calc(100% - 60px);min-width:calc(100% - 60px);width:calc(100% - 60px);max-width:calc(100% - 60px);height:100%;margin:0;padding-top:{pad_top}px;padding-bottom:0;box-sizing:border-box;overflow:hidden;background:rgba(36,33,30,0.88);position:relative;"
        )
    } else {
        format!(
            "display:flex;flex-direction:column;flex:0 0 {panel_w}px;min-width:260px;width:{panel_w}px;max-width:720px;height:100%;margin:0;padding-bottom:0;overflow:hidden;background:rgba(36,33,30,0.88);position:relative;"
        )
    };
    let row_dir = if rtl { "row-reverse" } else { "row" };
    let sidebar_style = if is_compact {
        format!(
            "display:flex;flex-direction:{row_dir};flex-wrap:nowrap;align-items:stretch;width:100%;height:100%;min-width:100%;position:absolute;inset:0;z-index:20;padding-top:{pad_top}px;box-sizing:border-box;"
        )
    } else {
        format!(
            "display:flex;flex-direction:{row_dir};flex-wrap:nowrap;align-items:stretch;height:100%;min-width:0;flex:none;position:relative;z-index:2;"
        )
    };
    let shell_style = format!(
        "display:flex;flex-direction:{row_dir};width:100%;height:100%;background:transparent;color:#f3eee8;position:relative;overflow:hidden;"
    );
    // Wallpaper mode (host `--wallpaper`): the packed `.AppShell_shell` paints
    // an OPAQUE `--st-color-surface-canvas` over the whole window, which would
    // hide the host-composited photo beneath the scene. React keeps the shell
    // background too, but its wallpaper is a DOM child ABOVE it; the native
    // equivalent draws the photo at resolve level UNDER the scene, so the
    // opaque shell base must go. Dropping the class keeps the data-* contract
    // (and the transparent inline style) while the packed sheet's background
    // stops applying.
    let wallpaper_mode = crate::scene_chat::chat_wallpaper_mode();
    let shell_class = if wallpaper_mode { "" } else { "AppShell_shell" };
    let overlay_alpha = (view.ui_opacity.min(100) as f32 / 100.0) * 0.45;
    let pref_vars = {
        let motion = if view.ui_motion == "reduced" {
            "--st-motion-duration-fast:1ms;--st-motion-duration-normal:1ms;--st-motion-duration-slow:1ms;"
        } else {
            ""
        };
        format!(
            "--st-custom-ui-opacity:{}%;--st-custom-glass-blur:{}px;--st-effect-glass-blur:{}px;--st-custom-wallpaper-overlay-alpha:{overlay_alpha:.2};{motion}",
            view.ui_opacity.min(100),
            view.ui_glass_blur.min(40),
            view.ui_glass_blur.min(40),
        )
    };
    let shell_css = if wallpaper_mode {
        format!(
            "display:flex;flex-direction:{row_dir};width:100%;height:100%;background:transparent;color:#f3eee8;position:relative;overflow:hidden;{pref_vars}"
        )
    } else {
        format!("{shell_style}{pref_vars}")
    };
    let product_css = product_stylesheets_dev(view.insets).join("\n");
    let show_rail = !is_compact || view.rail_expanded || view.sidebar_open;
    let show_panel = view.sidebar_open;
    let show_chat = !is_compact || !view.sidebar_open;
    let show_bottom_nav = is_compact && !view.sidebar_open;

    // Modal geometry (window CSS px) mirrors `shell_hit::dialog_hit`: centered
    // over the chat main area; surface = packer-baked `.st-card` tokens
    // (bg #292522 / border #39342f / radius 16px / shadow rgba(0,0,0,.35)).
    let (cdlg_x, cdlg_y, cdlg_w, cdlg_h) = modal_geometry(&view, 320.0, 360.0);
    let create_style = format!(
        "position:absolute;left:{cdlg_x}px;top:{cdlg_y}px;width:{cdlg_w}px;height:{cdlg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let (ddlg_x, ddlg_y, ddlg_w, ddlg_h) = modal_geometry(&view, 300.0, 200.0);
    let delete_style = format!(
        "position:absolute;left:{ddlg_x}px;top:{ddlg_y}px;width:{ddlg_w}px;height:{ddlg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let delete_name = view
        .selected_draft
        .as_ref()
        .map(|draft| draft.name.as_str())
        .or_else(|| {
            view.characters
                .iter()
                .find(|item| Some(item.id.as_str()) == view.selected_character_id.as_deref())
                .map(|item| item.name.as_str())
        })
        .unwrap_or("");
    let delete_confirm = format!("Delete \"{delete_name}\"? It will move to trash.");

    // Lorebook entry dialog geometry mirrors `shell_hit::dialog_hit`
    // (400×520; switch rows at y0+240/276/312; actions at y0+dh-56).
    let (edlg_x, edlg_y, edlg_w, edlg_h) = modal_geometry(&view, 400.0, 520.0);
    let entry_dialog_style = format!(
        "position:absolute;left:{edlg_x}px;top:{edlg_y}px;width:{edlg_w}px;height:{edlg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let entry_dialog_book_name = view
        .lorebooks
        .iter()
        .find(|item| Some(item.id.as_str()) == view.selected_lorebook_id.as_deref())
        .map(|item| item.name.as_str())
        .unwrap_or("");
    let (xdlg_x, xdlg_y, xdlg_w, xdlg_h) = modal_geometry(&view, 300.0, 200.0);
    let entry_delete_style = format!(
        "position:absolute;left:{xdlg_x}px;top:{xdlg_y}px;width:{xdlg_w}px;height:{xdlg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let entry_delete_book_name = entry_dialog_book_name;
    let entry_delete_confirm = format!("Delete this entry from \"{entry_delete_book_name}\"?");

    // Profile delete confirm (300×200, mirrors `shell_hit::dialog_hit`).
    let (pdlg_x, pdlg_y, pdlg_w, pdlg_h) = modal_geometry(&view, 300.0, 200.0);
    let profile_delete_style = format!(
        "position:absolute;left:{pdlg_x}px;top:{pdlg_y}px;width:{pdlg_w}px;height:{pdlg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let theme_delete_name = view
        .themes
        .iter()
        .find(|item| Some(item.id.as_str()) == view.theme_delete_target_id.as_deref())
        .map(|item| item.name.as_str())
        .unwrap_or("");
    let theme_delete_confirm = format!("Remove \"{theme_delete_name}\" and its local theme files?");
    let memory_delete_confirm = "Delete this memory? It will no longer be injected into prompts.";
    let (ndlg_x, ndlg_y, ndlg_w, ndlg_h) = modal_geometry(&view, 320.0, 220.0);
    let preset_name_style = format!(
        "position:absolute;left:{ndlg_x}px;top:{ndlg_y}px;width:{ndlg_w}px;height:{ndlg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let preset_name_title = match view.preset_name_mode.as_deref() {
        Some("rename") => "Rename preset",
        Some("duplicate") => "Duplicate preset as",
        _ => "New preset name",
    };
    let preset_name_value = view.preset_name_draft.clone();
    let prompt_block_in_chat = view.prompt_block_injection_position == "in-chat";
    let (pb_x, pb_y, pb_w, pb_h) = modal_geometry(
        &view,
        400.0,
        if prompt_block_in_chat { 584.0 } else { 500.0 },
    );
    let prompt_block_editor_style = format!(
        "position:absolute;left:{pb_x}px;top:{pb_y}px;width:{pb_w}px;height:{pb_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let prompt_block_name_value = view.prompt_block_name_draft.clone();
    let prompt_block_content_value = view.prompt_block_content_draft.clone();
    let prompt_block_content_editable = view.prompt_block_content_editable;
    let prompt_block_position_label = if prompt_block_in_chat {
        "In-chat"
    } else {
        "Relative"
    };
    let prompt_block_position_state = if prompt_block_in_chat {
        "in-chat"
    } else {
        "relative"
    };
    let prompt_block_depth_value = view.prompt_block_depth_draft.clone();
    let prompt_block_order_value = view.prompt_block_order_draft.clone();
    let prompt_block_role_state = match view.prompt_block_role.as_str() {
        "user" => "user",
        "assistant" => "assistant",
        _ => "system",
    };
    let prompt_block_role_label = match prompt_block_role_state {
        "user" => "User",
        "assistant" => "AI Assistant",
        _ => "System",
    };
    let prompt_block_trigger_row0 = if prompt_block_in_chat { 264.0 } else { 204.0 };
    let prompt_block_trigger_chip_w = (pb_w - 32.0 - 16.0) / 3.0;
    let prompt_block_trigger_chips: Vec<(String, String, bool, f32, f32)> = [
        ("normal", "Normal"),
        ("continue", "Continue"),
        ("impersonate", "Impersonate"),
        ("swipe", "Swipe"),
        ("regenerate", "Regenerate"),
        ("quiet", "Quiet"),
    ]
    .iter()
    .enumerate()
    .map(|(i, (id, label))| {
        let pressed = view.prompt_block_triggers.iter().any(|item| item == id);
        let col = (i % 3) as f32;
        let row = (i / 3) as f32;
        let left = 16.0 + col * (prompt_block_trigger_chip_w + 8.0);
        let top = prompt_block_trigger_row0 + row * 44.0;
        (id.to_string(), label.to_string(), pressed, left, top)
    })
    .collect();
    let prompt_block_content_top = if prompt_block_in_chat { 352 } else { 292 };
    let prompt_block_forbid_visible =
        prompt_block_content_editable && prompt_block_role_state == "system";
    let prompt_block_forbid_on = view.prompt_block_forbid_overrides;
    let prompt_block_forbid_state = if prompt_block_forbid_on { "on" } else { "off" };
    let (prompt_block_forbid_track, prompt_block_forbid_thumb) =
        entry_switch_style(prompt_block_forbid_on);
    let prompt_block_field_top = if prompt_block_forbid_visible {
        prompt_block_content_top + 36
    } else {
        prompt_block_content_top
    };
    let prompt_block_content_box_h = if prompt_block_forbid_visible { 36 } else { 72 };
    let prompt_block_content_field_h = if prompt_block_forbid_visible { 32 } else { 56 };
    let prompt_block_model_top = if prompt_block_in_chat { 432 } else { 372 };
    let prompt_block_model_hint_top = prompt_block_model_top + 40;
    let prompt_block_model_value = view.prompt_block_model_draft.clone();
    let prompt_block_model_empty = prompt_block_model_value.is_empty();
    let prompt_block_model_display = if prompt_block_model_empty {
        "Every model (no binding)".to_string()
    } else {
        prompt_block_model_value
    };
    let prompt_block_has_provider = view.selected_provider_id.is_some();
    let prompt_block_model_hint = if prompt_block_has_provider {
        "Bind this prompt to one model of the active provider."
    } else {
        "No active provider — pick a model first in the API tab."
    };
    let prompt_block_model_color = if !prompt_block_has_provider || prompt_block_model_empty {
        "#998f87"
    } else {
        "#e8eef7"
    };
    let preset_delete_name = if view.preset_dialog_kind == "prompt-template" {
        view.prompt_preset_active_name.clone().unwrap_or_default()
    } else {
        view.preset_active_name.clone().unwrap_or_default()
    };
    let preset_delete_copy = if view.preset_dialog_kind == "prompt-template" {
        format!(
            "Delete \"{preset_delete_name}\"? The selection returns to Unsaved current template."
        )
    } else {
        format!(
            "Delete \"{preset_delete_name}\"? The selection returns to unsaved generation settings."
        )
    };
    let (pvdlg_x, pvdlg_y, pvdlg_w, pvdlg_h) = modal_geometry(&view, 320.0, 240.0);
    let provider_dlg_style = format!(
        "position:absolute;left:{pvdlg_x}px;top:{pvdlg_y}px;width:{pvdlg_w}px;height:{pvdlg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let provider_kind_label = view
        .provider_kind_label
        .clone()
        .unwrap_or_else(|| "No adapters".to_string());
    let provider_name_value = view.provider_name_draft.clone();
    let profile_delete_name = view
        .profiles
        .iter()
        .find(|item| Some(item.id.as_str()) == view.profile_delete_target_id.as_deref())
        .map(|item| item.name.as_str())
        .unwrap_or("");
    let profile_delete_confirm = format!(
        "Delete \"{profile_delete_name}\"? Its characters stay unassigned; nothing is removed."
    );

    // Plugin uninstall confirm (320×220, mirrors `shell_hit::dialog_hit`).
    let (uplg_x, uplg_y, uplg_w, uplg_h) = modal_geometry(&view, 320.0, 220.0);
    let plugin_uninstall_style = format!(
        "position:absolute;left:{uplg_x}px;top:{uplg_y}px;width:{uplg_w}px;height:{uplg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let plugin_uninstall_name = view
        .plugins
        .iter()
        .find(|item| Some(item.id.as_str()) == view.plugin_uninstall_target_id.as_deref())
        .map(|item| item.name.as_str())
        .unwrap_or("");
    let plugin_uninstall_confirm = format!(
        "Uninstall \"{plugin_uninstall_name}\"? Frontend slots shut down and every handler is removed."
    );

    // Chat rename dialog (320×220, mirrors `shell_hit::dialog_hit`).
    let (crlg_x, crlg_y, crlg_w, crlg_h) = modal_geometry(&view, 320.0, 220.0);
    let chat_rename_style = format!(
        "position:absolute;left:{crlg_x}px;top:{crlg_y}px;width:{crlg_w}px;height:{crlg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let chat_rename_value = if view.chat_rename_draft.is_empty() {
        "Chat title…"
    } else {
        view.chat_rename_draft.as_str()
    };

    // Chat delete confirm (300×200, mirrors `shell_hit::dialog_hit`).
    let (cdlg_x, cdlg_y, cdlg_w, cdlg_h) = modal_geometry(&view, 300.0, 200.0);
    let chat_delete_style = format!(
        "position:absolute;left:{cdlg_x}px;top:{cdlg_y}px;width:{cdlg_w}px;height:{cdlg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    let chat_delete_title = view
        .chat_list
        .iter()
        .find(|item| Some(item.id.as_str()) == view.chat_delete_target_id.as_deref())
        .map(|item| item.title.as_str())
        .unwrap_or("");
    let chat_delete_confirm =
        format!("Delete \"{chat_delete_title}\"? Its messages are removed with it.");

    // Prompt plan dialog (640×560, mirrors `shell_hit::dialog_hit`).
    let (plg_x, plg_y, plg_w, plg_h) = modal_geometry(&view, 640.0, 560.0);
    let prompt_plan_style = format!(
        "position:absolute;left:{plg_x}px;top:{plg_y}px;width:{plg_w}px;height:{plg_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;display:flex;flex-direction:column;"
    );
    let run_transcript_style = prompt_plan_style.clone();
    let (cptd_x, cptd_y, cptd_w, cptd_h) = modal_geometry(&view, 300.0, 200.0);
    let checkpoint_delete_style = format!(
        "position:absolute;left:{cptd_x}px;top:{cptd_y}px;width:{cptd_w}px;height:{cptd_h}px;box-sizing:border-box;z-index:50;padding:16px;color:#f3eee8;"
    );
    // Entry dialog switches (track, thumb) — same geometry as row switches.
    let (switch_constant, switch_selective, switch_enabled) = (
        entry_switch_style(view.entry_constant_draft),
        entry_switch_style(view.entry_selective_draft),
        entry_switch_style(view.entry_enabled_draft),
    );

    rsx! {
        style { "{product_css}" }
        div {
            class: "{shell_class}",
            style: "{shell_css}",
            lang: "{view.language}",
            dir: "{view.dir}",
            "data-component": "app-shell",
            "data-slot": "app.shell",
            "data-theme-mode": "dark",
            "data-theme-id": if let Some(active) = view.themes.iter().find(|item| item.active) {
                Some(active.id.as_str())
            } else {
                None
            },
            "data-dir": "{view.dir}",
            "data-lang": "{view.language}",
            "data-sidebar": "{sidebar_state}",
            "data-ui-density": "{view.density}",
            "data-ui-scale": "{view.font_scale}",
            "data-ui-contrast": "{view.ui_contrast}",
            "data-ui-font": "{view.ui_font_profile}",
            "data-ui-motion": "{view.ui_motion}",
            "data-chat-style": "{view.chat_style}",
            "data-chat-avatar-style": "{view.chat_avatar_style}",
            "data-user-message-position": "{view.user_message_position}",
            "data-character-message-position": "{view.character_message_position}",
            // Packed 600px-breakpoint rules gate on this attribute (the
            // packer cannot rely on Blitz @media evaluation): set whenever
            // the viewport is the mobile/overlay width — the Android product
            // path always, the desktop host when the window shrinks.
            "data-ui-compact": if view.chat.viewport_width <= 600 {
                Some("true")
            } else {
                None
            },
            a { class: "AppShell_skipLink", href: "#chat-workspace", "Skip to chat" }
            div {
                "data-part": "chat-wallpaper",
                "aria-hidden": "true",
                style: "position:absolute;left:-16px;top:-16px;right:-16px;bottom:-16px;z-index:0;pointer-events:none;background:transparent;",
            }
            div {
                "data-part": "chat-wallpaper-overlay",
                "aria-hidden": "true",
                style: "position:absolute;left:0;top:0;right:0;bottom:-16px;z-index:0;pointer-events:none;background:rgba(18,16,14,{overlay_alpha});",
            }
            if show_rail || show_panel {
                aside {
                    class: "Sidebar_sidebar",
                    style: "{sidebar_style}",
                    "data-component": "navigation-rail",
                    "data-state": "{rail_state}",
                    if show_rail {
                        nav {
                            id: "primary-navigation",
                            class: "Sidebar_rail",
                            "data-slot": "navigation.primary",
                            "data-state": "{rail_state}",
                            "data-has-menu-toggle": "true",
                            "data-leading-menu-toggle": "true",
                            "aria-label": "Main navigation",
                            style: "{rail_pad}",
                            div {
                                class: "Sidebar_railMain",
                                "data-part": "main-items",
                                span {
                                    class: "Sidebar_railItem",
                                    "data-part": "item",
                                    "data-item": "menu-toggle",
                                    "data-group": "main",
                                    button {
                                        class: "Sidebar_railButton",
                                        r#type: "button",
                                        // Centering via the padded full-size icon
                                        // box (see icon_fill_centered): taffy in
                                        // this Blitz build mis-centers a
                                        // fixed-size span in a fixed-size flex box.
                                        style: "display:flex;width:40px;height:40px;padding:0;",
                                        "data-part": "item-control",
                                        "data-action": "menu-toggle",
                                        "data-state": "{rail_state}",
                                        "aria-label": "Close menu",
                                        title: "Close menu",
                                        "aria-expanded": view.rail_expanded,
                                        "aria-controls": "primary-navigation",
                                        {icon_fill_centered("SidebarSimple", 21, "#998f87")}
                                    }
                                }
                                for item in RAIL.iter() {
                                    {rail_button(item, view.sidebar_open && view.panel == item.panel)}
                                }
                            }
                        }
                    }
                    if show_panel {
                        section {
                            id: "navigation-context-panel",
                            class: "Sidebar_panelOpen",
                            style: "{panel_pad}",
                            "data-component": "navigation-panel",
                            "data-state": "open",
                            "data-panel": "{view.panel}",
                            "data-slot": "panel.left",
                            "data-management-tabs-pinned": "false",
                            "aria-label": "{panel_title}",
                            match view.panel.as_str() {
                                "characters" => {character_manager(&view)},
                                "personas" => {crate::personas_tab::personas_panel(&view)},
                                "lorebooks" => {crate::lorebooks_tab::lorebooks_panel(&view)},
                                "backgrounds" => {crate::backgrounds_tab::backgrounds_panel(&view)},
                                "providers" => {crate::ai_settings_tab::ai_settings_panel(&view)},
                                "plugins" => {crate::plugins_tab::plugins_panel(&view)},
                                "settings" => {crate::settings_tab::settings_panel(&view)},
                                "home" => {crate::chats_tab::chats_panel(&view)},
                                _ => {not_yet_migrated(panel_title)},
                            }
                            if !is_compact {
                                button {
                                    class: "Sidebar_resizeHandle",
                                    r#type: "button",
                                    "data-part": "resize-handle",
                                    "aria-label": "Drag to resize panel",
                                    title: "Drag to resize panel",
                                    style: "position:absolute;top:0;bottom:0;right:-4px;width:8px;padding:0;border:0;background:transparent;z-index:6;",
                                }
                            }
                        }
                    }
                }
            }
            if show_chat {
                main {
                    id: "chat-workspace",
                    // No `AppShell_mainShifted` class: the packed
                    // margin-left calc mis-resolves at wide windows (see the
                    // inline `main_style` above).
                    "data-component": "main-area",
                    "data-slot": "chat.viewport",
                    tabindex: "-1",
                    style: "{main_style}",
                    {product_chat_app()}
                }
            }
            // React `AppShell` named regions the native shell did not mount
            // yet. They are passive mount points (pointer-events:none) so
            // themes and the DOM-parity contract see the same slots.
            div {
                class: "AppShell_statusArea",
                "data-slot": "status.area",
                style: "position:absolute;top:8px;left:{status_left}px;right:8px;height:0;display:flex;align-items:flex-start;justify-content:flex-end;pointer-events:none;z-index:3;",
            }
            div {
                class: "AppShell_pluginRuntimeLayer",
                "data-component": "plugin-runtime-layer",
                "data-slot": "modal.layer",
                style: "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2;",
            }
            // Unmanaged DOM insertion points for documented SillyTavern
            // legacy extensions (`packages/legacy-compat` LEGACY_ISLANDS).
            div {
                class: "LegacyIslands_layer",
                "data-component": "legacy-island-layer",
                style: "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;",
                for island_slot in LEGACY_ISLAND_SLOTS {
                    div {
                        class: "LegacyIslands_island",
                        id: "native-island-{island_slot}",
                        "data-component": "legacy-island",
                        "data-slot": "{island_slot}",
                        style: "position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;",
                    }
                }
            }
            if show_bottom_nav {
                {bottom_nav_bar(&view)}
            }
            // Modals render at the shell root (the panel subtree clips at
            // overflow:hidden, so a centered dialog would never paint there).
            // Inline `if { div ... }` is what this Blitz RSX translation
            // actually mounts (a component call `{fn}` is dropped under any
            // conditional), so the dialog markup is inlined here. The React
            // `[data-component='dialog-overlay']` style (position:relative /
            // inset:0, product.css) overrides inline absolute geometry in the
            // Blitz cascade and hid the dialog, so no dialog-* data attrs are
            // used on the positioned box — the packer-baked `.st-card` tokens
            // give the surface (see presentation-boundary parity notes).
            if view.create_dialog_open {
                div {
                    class: "st-card",
                    style: "{create_style}",
                    div {
                        "data-component": "dialog-title",
                        "New character"
                    }
                    div {
                        "data-component": "dialog-description",
                        style: "margin:4px 0 12px;",
                        "Start with the essentials. You can expand the character later."
                    }
                    div {
                        class: "CharacterManagementPanel_createForm",
                        div {
                            class: "CharacterManagementPanel_editorField",
                            // Hit-rect focus target for the bin's keyboard
                            // typing (create dialog renders values as text).
                            "data-part": "create-name",
                            span { class: "CharacterManagementPanel_fieldHeading", strong { "Name" } }
                            strong { style: "display:block;font-weight:400;color:#e8eef7;", "{view.create_name}" }
                        }
                        div {
                            class: "CharacterManagementPanel_editorField",
                            span { class: "CharacterManagementPanel_fieldHeading", strong { "Description" } }
                            span { style: "color:#c5bbb2;", "{view.create_description}" }
                        }
                        div {
                            class: "CharacterManagementPanel_editorField",
                            span { class: "CharacterManagementPanel_fieldHeading", strong { "First message" } }
                            span { style: "color:#c5bbb2;", "{view.create_first_message}" }
                        }
                        div {
                            class: "CharacterManagementPanel_dialogActions",
                            style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                            button {
                                r#type: "button",
                                "data-variant": "default",
                                "data-size": "md",
                                span { "Cancel" }
                            }
                            button {
                                r#type: "submit",
                                "data-variant": "primary",
                                "data-size": "md",
                                span { "Create" }
                            }
                        }
                    }
                }
            }
            if view.delete_dialog_open {
                div {
                    class: "st-card",
                    style: "{delete_style}",
                    div {
                        "data-component": "dialog-title",
                        "Delete character"
                    }
                    div { "data-component": "dialog-description", "{delete_confirm}" }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "danger",
                            "data-size": "md",
                            span { "Delete character" }
                        }
                    }
                }
            }
            // Lorebook entry dialog (`React LorebookPanel` EntryDialog) at the
            // shell root — same clipping reason as the create/delete dialogs.
            // Geometry mirrors `shell_hit::dialog_hit` (400×520, switch rows
            // at y0+240/276/312, actions at y0+dh-56). The wire DTO has no
            // position/metadata (kernel-owned), so the position field of the
            // React legacy form is honestly absent here.
            if view.entry_dialog_open {
                div {
                    class: "st-card",
                    style: "{entry_dialog_style}",
                    div {
                        "data-component": "dialog-title",
                        if view.editing_lorebook_entry_id.is_some() { "Edit entry" } else { "Add entry" }
                    }
                    div { "data-component": "dialog-description", "{entry_dialog_book_name}" }
                    div {
                        class: "LorebookPanel_dialogField",
                        "data-part": "entry-keys",
                        style: "position:absolute;left:16px;top:72px;right:16px;height:48px;display:flex;flex-direction:column;gap:2px;",
                        span { style: "font-size:0.75rem;color:#998f87;", "Keywords (one per line)" }
                        span { style: "color:#e8eef7;font-size:0.8125rem;white-space:pre-line;overflow:hidden;", "{view.entry_keys_draft}" }
                    }
                    div {
                        class: "LorebookPanel_dialogField",
                        "data-part": "entry-secondary-keys",
                        style: "position:absolute;left:16px;top:124px;right:16px;height:40px;display:flex;flex-direction:column;gap:2px;",
                        span { style: "font-size:0.75rem;color:#998f87;", "Secondary keywords (one per line)" }
                        span { style: "color:#c5bbb2;font-size:0.75rem;white-space:pre-line;overflow:hidden;", "{view.entry_secondary_keys_draft}" }
                    }
                    div {
                        class: "LorebookPanel_dialogField LorebookPanel_contentField",
                        "data-part": "entry-content",
                        style: "position:absolute;left:16px;top:168px;right:16px;height:64px;display:flex;flex-direction:column;gap:2px;",
                        div {
                            style: "display:flex;justify-content:space-between;",
                            span { style: "font-size:0.75rem;color:#998f87;", "Content" }
                            span { class: "LorebookPanel_tokenCount", style: "font-size:0.75rem;color:#998f87;", "Tokens: {view.entry_content_tokens}" }
                        }
                        span { style: "color:#e8eef7;font-size:0.8125rem;white-space:pre-line;overflow:hidden;", "{view.entry_content_draft}" }
                    }
                    div {
                        class: "LorebookPanel_checkboxRow",
                        "data-part": "entry-switch-constant",
                        style: "position:absolute;left:16px;top:240px;right:16px;height:32px;display:flex;align-items:center;justify-content:space-between;",
                        span { style: "font-size:0.8125rem;color:#f3eee8;", "Always include" }
                        span { style: "{switch_constant.0}", span { style: "{switch_constant.1}" } }
                    }
                    div {
                        class: "LorebookPanel_checkboxRow",
                        "data-part": "entry-switch-selective",
                        style: "position:absolute;left:16px;top:276px;right:16px;height:32px;display:flex;align-items:center;justify-content:space-between;",
                        span { style: "font-size:0.8125rem;color:#f3eee8;", "Selective (primary + secondary match)" }
                        span { style: "{switch_selective.0}", span { style: "{switch_selective.1}" } }
                    }
                    div {
                        class: "LorebookPanel_checkboxRow",
                        "data-part": "entry-switch-enabled",
                        style: "position:absolute;left:16px;top:312px;right:16px;height:32px;display:flex;align-items:center;justify-content:space-between;",
                        span { style: "font-size:0.8125rem;color:#f3eee8;", "Enabled" }
                        span { style: "{switch_enabled.0}", span { style: "{switch_enabled.1}" } }
                    }
                    div {
                        class: "LorebookPanel_dialogActions",
                        style: "position:absolute;left:16px;right:16px;bottom:12px;display:flex;gap:8px;justify-content:flex-end;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            span { "Save" }
                        }
                    }
                }
            }
            if view.entry_delete_open {
                div {
                    class: "st-card",
                    style: "{entry_delete_style}",
                    div {
                        "data-component": "dialog-title",
                        "Delete entry"
                    }
                    div { "data-component": "dialog-description", "{entry_delete_confirm}" }
                    div {
                        class: "LorebookPanel_dialogActions",
                        style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "danger",
                            "data-size": "md",
                            span { "Delete" }
                        }
                    }
                }
            }
            if view.profile_delete_open {
                div {
                    class: "st-card",
                    style: "{profile_delete_style}",
                    div {
                        "data-component": "dialog-title",
                        "Delete profile"
                    }
                    div { "data-component": "dialog-description", "{profile_delete_confirm}" }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "danger",
                            "data-size": "md",
                            span { "Delete" }
                        }
                    }
                }
            }
            if view.theme_delete_open {
                div {
                    class: "st-card",
                    style: "{profile_delete_style}",
                    div {
                        "data-component": "dialog-title",
                        "Remove theme"
                    }
                    div { "data-component": "dialog-description", "{theme_delete_confirm}" }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "danger",
                            "data-size": "md",
                            span { "Delete" }
                        }
                    }
                }
            }
            if view.memory_delete_open {
                div {
                    class: "st-card",
                    style: "{profile_delete_style}",
                    div {
                        "data-component": "dialog-title",
                        "Delete memory"
                    }
                    div { "data-component": "dialog-description", "{memory_delete_confirm}" }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "danger",
                            "data-size": "md",
                            span { "Delete" }
                        }
                    }
                }
            }
            if view.card_import_dialog_open {
                div {
                    class: "st-card",
                    style: "{provider_dlg_style}",
                    div {
                        "data-component": "dialog-title",
                        "Import character card"
                    }
                    p {
                        style: "position:absolute;left:16px;top:44px;right:16px;margin:0;color:#998f87;font-size:0.75rem;",
                        "Path to a SillyTavern card (V2 JSON or PNG) on this device."
                    }
                    span {
                        "data-part": "card-path-input",
                        style: "position:absolute;left:16px;top:72px;right:16px;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                        if view.card_path_draft.is_empty() {
                            span { style: "color:#998f87;", "\u{00a0}" }
                        } else {
                            "{view.card_path_draft}"
                        }
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "position:absolute;left:16px;right:16px;bottom:16px;display:flex;gap:8px;justify-content:flex-end;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            span { "Import" }
                        }
                    }
                }
            }
            if view.prompt_template_import_open {
                div {
                    class: "st-card",
                    "data-part": "prompt-template-import",
                    style: "{provider_dlg_style}",
                    div {
                        "data-component": "dialog-title",
                        "Import prompt template preset"
                    }
                    p {
                        style: "position:absolute;left:16px;top:44px;right:16px;margin:0;color:#998f87;font-size:0.75rem;",
                        "Path to a prompt template JSON file on this device."
                    }
                    span {
                        "data-part": "prompt-template-path-input",
                        style: "position:absolute;left:16px;top:72px;right:16px;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                        if view.prompt_template_path_draft.is_empty() {
                            span { style: "color:#998f87;", "\u{00a0}" }
                        } else {
                            "{view.prompt_template_path_draft}"
                        }
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "position:absolute;left:16px;right:16px;bottom:16px;display:flex;gap:8px;justify-content:flex-end;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            span { "Import" }
                        }
                    }
                }
            }
            if view.generation_preset_import_open {
                div {
                    class: "st-card",
                    "data-part": "generation-preset-import",
                    style: "{provider_dlg_style}",
                    div {
                        "data-component": "dialog-title",
                        "Import generation preset"
                    }
                    p {
                        style: "position:absolute;left:16px;top:44px;right:16px;margin:0;color:#998f87;font-size:0.75rem;",
                        "Path to a generation preset JSON file on this device."
                    }
                    span {
                        "data-part": "generation-preset-path-input",
                        style: "position:absolute;left:16px;top:72px;right:16px;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                        if view.generation_preset_path_draft.is_empty() {
                            span { style: "color:#998f87;", "\u{00a0}" }
                        } else {
                            "{view.generation_preset_path_draft}"
                        }
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "position:absolute;left:16px;right:16px;bottom:16px;display:flex;gap:8px;justify-content:flex-end;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            span { "Import" }
                        }
                    }
                }
            }
            if view.preset_name_dialog_open {
                div {
                    class: "st-card",
                    style: "{preset_name_style}",
                    div {
                        "data-component": "dialog-title",
                        "{preset_name_title}"
                    }
                    div {
                        style: "position:absolute;left:16px;top:72px;right:16px;height:48px;display:flex;flex-direction:column;gap:2px;",
                        span { class: "CharacterManagementPanel_fieldHeading", strong { "Name" } }
                        span {
                            "data-part": "preset-name-input",
                            style: "height:32px;line-height:32px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                            "{preset_name_value}"
                        }
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "position:absolute;left:16px;right:16px;bottom:16px;display:flex;gap:8px;justify-content:flex-end;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            span { "Save" }
                        }
                    }
                }
            }
            if view.prompt_block_edit_open {
                div {
                    class: "st-card",
                    "data-component": "prompt-block-editor",
                    style: "{prompt_block_editor_style}",
                    div {
                        "data-component": "dialog-title",
                        "Edit prompt"
                    }
                    div {
                        style: "position:absolute;left:16px;top:56px;right:16px;height:52px;display:flex;flex-direction:column;gap:2px;",
                        span { class: "CharacterManagementPanel_fieldHeading", strong { "Name" } }
                        span {
                            "data-part": "prompt-block-name-input",
                            style: "height:32px;line-height:32px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                            "{prompt_block_name_value}"
                        }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-part": "prompt-block-role-cycle",
                        "data-state": "{prompt_block_role_state}",
                        "aria-label": "Role",
                        style: "position:absolute;left:16px;right:16px;top:116px;height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;",
                        span { "Role" }
                        span { "{prompt_block_role_label}" }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-part": "prompt-block-position-cycle",
                        "data-state": "{prompt_block_position_state}",
                        "aria-label": "Position",
                        style: "position:absolute;left:16px;right:16px;top:160px;height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;",
                        span { "Position" }
                        span { "{prompt_block_position_label}" }
                    }
                    if prompt_block_in_chat {
                        div {
                            style: "position:absolute;left:16px;top:204px;width:calc(50% - 20px);height:52px;display:flex;flex-direction:column;gap:2px;",
                            span { class: "CharacterManagementPanel_fieldHeading", strong { "Depth" } }
                            span {
                                "data-part": "prompt-block-depth-input",
                                style: "height:32px;line-height:32px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                                "{prompt_block_depth_value}"
                            }
                        }
                        div {
                            style: "position:absolute;right:16px;top:204px;width:calc(50% - 20px);height:52px;display:flex;flex-direction:column;gap:2px;",
                            span { class: "CharacterManagementPanel_fieldHeading", strong { "Order" } }
                            span {
                                "data-part": "prompt-block-order-input",
                                style: "height:32px;line-height:32px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                                "{prompt_block_order_value}"
                            }
                        }
                    }
                    for (id, label, pressed, left, top) in prompt_block_trigger_chips.iter() {
                        {
                            let id = id.clone();
                            let label = label.clone();
                            let pressed = *pressed;
                            let left = *left;
                            let top = *top;
                            let chip_w = prompt_block_trigger_chip_w;
                            let state = if pressed { "on" } else { "off" };
                            let bg = if pressed { "#3d342e" } else { "#1e1b18" };
                            let color = if pressed { "#f3eee8" } else { "#c5bbb2" };
                            let border = if pressed { "#e38a62" } else { "#39342f" };
                            rsx! {
                                button {
                                    class: "st-button",
                                    r#type: "button",
                                    "data-part": "prompt-block-trigger",
                                    "data-trigger": "{id}",
                                    "data-state": "{state}",
                                    "aria-pressed": pressed,
                                    "aria-label": "{label}",
                                    style: "position:absolute;left:{left}px;top:{top}px;width:{chip_w}px;height:36px;padding:0 4px;border:1px solid {border};background:{bg};color:{color};font-size:0.75rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                                    span { "{label}" }
                                }
                            }
                        }
                    }
                    if prompt_block_forbid_visible {
                        button {
                            r#type: "button",
                            "data-part": "prompt-block-forbid-overrides",
                            "data-state": "{prompt_block_forbid_state}",
                            "aria-pressed": prompt_block_forbid_on,
                            "aria-label": "Forbid Overrides",
                            style: "position:absolute;left:16px;top:{prompt_block_content_top}px;right:16px;height:36px;display:flex;align-items:center;justify-content:space-between;padding:0;border:0;background:transparent;color:#f3eee8;",
                            span { style: "font-size:0.8125rem;", "Forbid Overrides" }
                            span { style: "{prompt_block_forbid_track}", span { style: "{prompt_block_forbid_thumb}" } }
                        }
                    }
                    if prompt_block_content_editable {
                        div {
                            style: "position:absolute;left:16px;top:{prompt_block_field_top}px;right:16px;height:{prompt_block_content_box_h}px;display:flex;flex-direction:column;gap:2px;",
                            if !prompt_block_forbid_visible {
                                span { class: "CharacterManagementPanel_fieldHeading", strong { "Prompt" } }
                            }
                            span {
                                "data-part": "prompt-block-content-input",
                                style: "height:{prompt_block_content_field_h}px;line-height:20px;padding:8px 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;overflow:hidden;",
                                if prompt_block_content_value.is_empty() {
                                    span { style: "color:#998f87;", "The prompt to be sent." }
                                } else {
                                    "{prompt_block_content_value}"
                                }
                            }
                        }
                    } else {
                        p {
                            "data-part": "external-prompt-source",
                            style: "position:absolute;left:16px;top:{prompt_block_field_top}px;right:16px;margin:0;color:#c5bbb2;font-size:0.75rem;height:{prompt_block_content_field_h}px;line-height:16px;overflow:hidden;",
                            "The content of this prompt is pulled from elsewhere and cannot be edited here."
                        }
                    }
                    div {
                        "data-part": "prompt-block-model-binding",
                        style: "position:absolute;left:16px;top:{prompt_block_model_top}px;right:16px;height:36px;display:flex;align-items:center;gap:8px;",
                        span {
                            "data-part": "prompt-block-model-input",
                            style: "flex:1;min-width:0;height:32px;line-height:32px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:{prompt_block_model_color};font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                            "{prompt_block_model_display}"
                        }
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-part": "prompt-block-model-load",
                            "aria-label": "Load models",
                            style: "width:96px;height:36px;flex:none;",
                            span { "Load" }
                        }
                    }
                    p {
                        "data-part": "prompt-block-model-hint",
                        style: "position:absolute;left:16px;right:16px;top:{prompt_block_model_hint_top}px;margin:0;color:#998f87;font-size:0.75rem;height:16px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                        "{prompt_block_model_hint}"
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "position:absolute;left:16px;right:16px;bottom:16px;display:flex;gap:8px;justify-content:flex-end;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            span { "Save" }
                        }
                    }
                }
            }
            if view.provider_create_dialog_open {
                div {
                    class: "st-card",
                    style: "{provider_dlg_style}",
                    div {
                        "data-component": "dialog-title",
                        "New provider profile"
                    }
                    button {
                        r#type: "button",
                        "data-component": "button",
                        "data-part": "provider-kind-cycle",
                        style: "position:absolute;left:16px;top:72px;width:calc(100% - 32px);height:36px;",
                        span { "{provider_kind_label}" }
                    }
                    div {
                        style: "position:absolute;left:16px;top:116px;right:16px;display:flex;flex-direction:column;gap:2px;",
                        span { class: "CharacterManagementPanel_fieldHeading", strong { "Profile name" } }
                        span {
                            "data-part": "provider-name-input",
                            style: "height:32px;line-height:32px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                            "{provider_name_value}"
                        }
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "position:absolute;left:16px;right:16px;bottom:16px;display:flex;gap:8px;justify-content:flex-end;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            span { "Save" }
                        }
                    }
                }
            }
            if view.preset_delete_open {
                div {
                    class: "st-card",
                    style: "{profile_delete_style}",
                    div {
                        "data-component": "dialog-title",
                        "Delete preset"
                    }
                    div {
                        "data-component": "dialog-description",
                        "{preset_delete_copy}"
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "danger",
                            "data-size": "md",
                            span { "Delete" }
                        }
                    }
                }
            }
            if view.plugin_uninstall_open {
                div {
                    class: "st-card",
                    style: "{plugin_uninstall_style}",
                    div {
                        "data-component": "dialog-title",
                        "Uninstall plugin"
                    }
                    div { "data-component": "dialog-description", "{plugin_uninstall_confirm}" }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "danger",
                            "data-size": "md",
                            span { "Uninstall" }
                        }
                    }
                }
            }
            if view.chat_rename_open {
                div {
                    class: "st-card",
                    style: "{chat_rename_style}",
                    div {
                        "data-component": "dialog-title",
                        "Rename chat"
                    }
                    div { "data-component": "dialog-description", "Set a new title for this chat." }
                    div {
                        class: "CharacterManagementPanel_editorField",
                        style: "position:absolute;left:16px;top:72px;right:16px;height:48px;display:flex;flex-direction:column;gap:2px;",
                        span { class: "CharacterManagementPanel_fieldHeading", strong { "Title" } }
                        span {
                            "data-part": "chat-rename-input",
                            style: "height:32px;line-height:32px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                            "{chat_rename_value}"
                        }
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "position:absolute;left:16px;right:16px;bottom:12px;display:flex;gap:8px;justify-content:flex-end;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            span { "Save" }
                        }
                    }
                }
            }
            if view.chat_delete_open {
                div {
                    class: "st-card",
                    style: "{chat_delete_style}",
                    div {
                        "data-component": "dialog-title",
                        "Delete chat"
                    }
                    div { "data-component": "dialog-description", "{chat_delete_confirm}" }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "danger",
                            "data-size": "md",
                            span { "Delete" }
                        }
                    }
                }
            }
            // Prompt plan dialog (`generation.prompt.plan`; React
            // `PromptPlanPanel`): header + close, then one of the four React
            // states - error, no recorded plan, or the durable plan content
            // (meta dl, over-budget alert, system blocks, selected messages,
            // excluded). The body is a fixed box with `overflow-y:auto`.
            if view.prompt_plan_open {
                div {
                    class: "st-card",
                    style: "{prompt_plan_style}",
                    div {
                        "data-component": "dialog-title",
                        style: "flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;",
                        span { "Prompt plan" }
                        button {
                            class: "PromptPlanPanel_close",
                            r#type: "button",
                            "data-part": "prompt-plan-close",
                            "aria-label": "Close",
                            title: "Close",
                            style: "display:grid;width:40px;height:40px;place-items:center;border:1px solid rgba(243,238,232,0.10);border-radius:16px;background:rgba(36,33,30,0.62);color:#c5bbb2;cursor:pointer;",
                            {crate::product_shell::icon("X", 16)}
                        }
                    }
                    div {
                        "data-part": "prompt-plan-body",
                        role: "region",
                        style: "flex:1;min-height:0;margin-top:12px;overflow-y:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;",
                        if let Some(err) = view.prompt_plan_error.as_deref() {
                            p { role: "alert", style: "color:#e0716b;font-size:14px;", "{err}" }
                        } else if view.prompt_plan_not_found {
                            p { style: "color:#c5bbb2;font-size:14px;", "This run has no recorded prompt plan." }
                        } else if let Some(plan) = view.prompt_plan.as_ref() {
                            dl {
                                "data-part": "prompt-plan-meta",
                                style: "display:grid;grid-template-columns:110px 1fr;gap:6px 12px;font-size:13px;",
                                dt { style: "color:#998f87;", "Model" }
                                dd { style: "color:#f3eee8;margin:0;", "{plan.provider}/{plan.model}" }
                                dt { style: "color:#998f87;", "Instruct format" }
                                dd { style: "color:#f3eee8;margin:0;", "{plan.instruct_format}" }
                                dt { style: "color:#998f87;", "Tokenizer" }
                                dd { style: "color:#f3eee8;margin:0;",
                                    span { "{plan.tokenizer_profile}" }
                                    if plan.approximate_tokens {
                                        span { style: "color:#998f87;", " · approximate" }
                                    }
                                }
                                dt { style: "color:#998f87;", "Tokens" }
                                dd { style: "color:#f3eee8;margin:0;",
                                    span { "Input {plan.input_tokens}" }
                                    span { style: "color:#998f87;", " · " }
                                    span { "Response reserve {plan.response_reserved}" }
                                    span { style: "color:#998f87;", " · " }
                                    span { "Context limit {plan.context_limit}" }
                                }
                            }
                            if plan.over_budget {
                                p { role: "alert", style: "color:#e0716b;font-size:13px;", "The plan still exceeds the context window after dropping all unpinned history." }
                            }
                            if !plan.system_blocks.is_empty() {
                                section {
                                    "data-part": "prompt-plan-blocks",
                                    h3 { style: "color:#f3eee8;font-size:14px;margin:0 0 6px;", "System blocks ({plan.system_blocks.len()})" }
                                    ul { style: "display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;",
                                        for block in plan.system_blocks.iter() {
                                            li {
                                                class: "block",
                                                "data-source": "{block.source}",
                                                style: "display:flex;flex-direction:column;gap:2px;",
                                                span { class: "blockSource", style: "color:#998f87;font-size:12px;text-transform:capitalize;", "{block.source}" }
                                                pre { class: "blockText", style: "margin:0;color:#e8eef7;font-size:12px;white-space:pre-wrap;", "{block.text}" }
                                            }
                                        }
                                    }
                                }
                            }
                            if !plan.messages.is_empty() {
                                section {
                                    "data-part": "prompt-plan-messages",
                                    h3 { style: "color:#f3eee8;font-size:14px;margin:0 0 6px;", "Selected messages ({plan.messages.len()})" }
                                    ul { style: "display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;",
                                        for message in plan.messages.iter() {
                                            li {
                                                class: "message",
                                                "data-role": "{role_label(&message.role)}",
                                                style: "display:flex;flex-direction:column;gap:2px;",
                                                span { class: "messageRole", style: "color:#998f87;font-size:12px;text-transform:capitalize;", "{role_label(&message.role)}" }
                                                pre { class: "messageContent", style: "margin:0;color:#e8eef7;font-size:12px;white-space:pre-wrap;", "{message.content}" }
                                            }
                                        }
                                    }
                                }
                            }
                            section {
                                "data-part": "prompt-plan-excluded",
                                h3 { style: "color:#f3eee8;font-size:14px;margin:0 0 6px;", "Excluded from context ({plan.excluded.len()})" }
                                if plan.excluded.is_empty() {
                                    p { style: "color:#c5bbb2;font-size:13px;", "Nothing was excluded." }
                                } else {
                                    ul { style: "display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;",
                                        for item in plan.excluded.iter() {
                                            li {
                                                class: "excluded",
                                                style: "display:flex;gap:8px;font-size:12px;",
                                                span { class: "excludedId", style: "color:#998f87;", "{item.message_id}" }
                                                span { class: "excludedReason", style: "color:#e8eef7;",
                                                    if item.reason == "token_budget" {
                                                        "Removed by token budget"
                                                    } else {
                                                        "{item.reason}"
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if view.checkpoint_delete_open {
                div {
                    class: "st-card",
                    style: "{checkpoint_delete_style}",
                    div {
                        "data-component": "dialog-title",
                        "Remove checkpoint"
                    }
                    div {
                        "data-component": "dialog-description",
                        "Remove the checkpoint link from this message? The snapshot chat stays in your chat list."
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
                        button {
                            r#type: "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "Cancel" }
                        }
                        button {
                            r#type: "button",
                            "data-variant": "danger",
                            "data-size": "md",
                            span { "Remove" }
                        }
                    }
                }
            }
            if view.run_transcript_open {
                div {
                    class: "st-card",
                    style: "{run_transcript_style}",
                    div {
                        "data-component": "dialog-title",
                        style: "flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;",
                        span { "Run steps" }
                        button {
                            class: "PromptPlanPanel_close",
                            r#type: "button",
                            "data-part": "run-transcript-close",
                            "aria-label": "Close",
                            title: "Close",
                            style: "display:grid;width:40px;height:40px;place-items:center;border:1px solid rgba(243,238,232,0.10);border-radius:16px;background:rgba(36,33,30,0.62);color:#c5bbb2;cursor:pointer;",
                            {crate::product_shell::icon("X", 16)}
                        }
                    }
                    div {
                        "data-part": "run-transcript-body",
                        role: "region",
                        style: "flex:1;min-height:0;margin-top:12px;overflow-y:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;",
                        if let Some(err) = view.run_transcript_error.as_deref() {
                            p { role: "alert", style: "color:#e0716b;font-size:14px;", "{err}" }
                        } else if view.run_transcript_steps.is_empty() {
                            p { style: "color:#c5bbb2;font-size:14px;", "No durable run steps recorded for this run." }
                        } else {
                            ol {
                                "data-part": "run-transcript-steps",
                                style: "margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;",
                                for step in view.run_transcript_steps.iter() {
                                    li {
                                        class: "step",
                                        "data-step-type": "{step.step_type}",
                                        "data-step-status": "{step.status}",
                                        style: "display:flex;align-items:baseline;gap:8px;font-size:13px;",
                                        span {
                                            "data-part": "step-sequence",
                                            style: "flex:none;color:#998f87;min-width:1.5em;",
                                            "{step.sequence}"
                                        }
                                        span {
                                            style: "flex:1;color:#f3eee8;",
                                            strong { "{step_type_label(&step.step_type)}" }
                                            span {
                                                "data-part": "step-status",
                                                style: "margin-left:8px;color:#c5bbb2;",
                                                "{step_status_label(&step.status)}"
                                            }
                                            if step.attempt > 1 {
                                                span {
                                                    "data-part": "step-attempt",
                                                    style: "margin-left:8px;color:#998f87;",
                                                    "attempt {step.attempt}"
                                                }
                                            }
                                        }
                                        span {
                                            style: "flex:none;color:#998f87;font-size:12px;",
                                            "{step.created_at}"
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Phase C toast: transient `status_message` (e.g. "Character
            // created.") as a bottom-left status strip. Visual = packer-baked
            // `.st-card` rule (background #292522 / border #39342f / radius 16 /
            // shadow rgba(0,0,0,.35)) + shell text #f3eee8; this React build
            // packs no app-toast CSS, so this is a documented waiver (see
            // presentation-boundary parity notes).
            if let Some(msg) = view.status_message.as_deref() {
                div {
                    "data-component": "toast",
                    "data-state": "open",
                    role: "status",
                    "aria-live": "polite",
                    style: "position:absolute;left:16px;bottom:16px;z-index:60;max-width:340px;box-sizing:border-box;padding:12px 16px;background:#292522;border:1px solid #39342f;border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,.35);color:#f3eee8;font-size:14px;",
                    "{msg}"
                }
            }
        }
    }
}
