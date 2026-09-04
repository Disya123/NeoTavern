//! Density-aware hit testing for the Rust App Shell / Character Manager.
//!
//! Regions follow packed React CSS tokens (`--st-shell-rail-width` 60,
//! `--st-shell-panel-width` 380, `--st-control-height*` / `--st-space-*`).
//! This is not a Blitz layout query: the compositor host does not yet expose
//! a DOM hit tree, so geometry is reconstructed from the same tokens the
//! RSX uses.

use neotavern_presentation_dioxus_shell::{chrome_metrics, PresetValueRow, ProductShellView};

pub const RAIL_WIDTH: f32 = 60.0;
pub const PANEL_WIDTH_DEFAULT: f32 = 380.0;
pub const PANEL_WIDTH_MIN: f32 = 260.0;
pub const PANEL_WIDTH_MAX: f32 = 720.0;
const CONTROL: f32 = 44.0;
const CONTROL_SM: f32 = 40.0;
const CONTROL_LG: f32 = 52.0;
const SPACE_XS: f32 = 4.0;
const SPACE_SM: f32 = 8.0;
const SPACE_MD: f32 = 12.0;
const SPACE_LG: f32 = 16.0;
const SPACE_2XL: f32 = 32.0;

pub const RAIL_PANELS: &[&str] = &[
    "home",
    "characters",
    "personas",
    "lorebooks",
    "backgrounds",
    "providers",
    "plugins",
    "settings",
];

pub const TABS: &[&str] = &["cards", "edit", "advanced", "gallery"];

pub const SORTS: &[&str] = &[
    "name",
    "name-desc",
    "newest",
    "oldest",
    "favorites",
    "used",
    "chats-most",
    "chats-least",
    "tokens-most",
    "tokens-least",
    "random",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShellAction {
    ToggleRail,
    SetPanel(String),
    ClosePanel,
    SetTab(String),
    SetView(String),
    CycleSort,
    SelectCharacter(String),
    SelectPersona(String),
    SelectLorebook(String),
    SelectChat(String),
    CreateChat,
    OpenCreate,
    CloseCreate,
    ConfirmCreate,
    OpenDelete,
    CloseDelete,
    ConfirmDelete,
    ToggleFavorite,
    BackToCards,
    Import,
    /// Lorebook entries (`React LorebookPanel` EntriesTab / EntryDialog).
    OpenEntryDialog,
    EditLorebookEntry(String),
    CloseEntryDialog,
    SaveEntry,
    ToggleLorebookEntry(String),
    OpenEntryDelete(String),
    CloseEntryDelete,
    ConfirmEntryDelete,
    EntryToggleEnabled,
    EntryToggleConstant,
    EntryToggleSelective,
    /// Settings Profiles tab (`React ProfilesPanel`): inline create row,
    /// inline rename, delete confirm and the per-profile export.
    CreateProfile,
    StartProfileRename(String),
    SubmitProfileRename,
    CancelProfileRename,
    OpenProfileDelete(String),
    CloseProfileDelete,
    ConfirmProfileDelete,
    ExportProfile(String),
    /// Plugins panel lifecycle (`plugins.enable` / `disable` / `uninstall`).
    TogglePlugin(String),
    OpenPluginUninstall(String),
    ClosePluginUninstall,
    ConfirmPluginUninstall,
    /// Chats panel rename/delete (`React ChatManagementPanel` dialogs).
    StartChatRename(String),
    CloseChatRename,
    SubmitChatRename,
    OpenChatDelete(String),
    CloseChatDelete,
    ConfirmChatDelete,
    /// Prompt plan dialog (`generation.prompt.plan`; React `PromptPlanPanel`,
    /// triggered from the per-message footer action).
    OpenPromptPlan(String),
    ClosePromptPlan,
    /// Run-step transcript (`generation.events`; React `RunTranscriptPanel`).
    OpenRunTranscript(String),
    CloseRunTranscript,
    /// Delete-checkpoint confirm (React `deleteCheckpoint` + ConfirmActionDialog).
    OpenCheckpointDelete(String),
    CloseCheckpointDelete,
    ConfirmCheckpointDelete,
    /// Duplicate the selected character (`characters.create` with
    /// `"{name} copy"`; React `duplicateSelectedCharacter`).
    DuplicateCharacter,
    /// Character Advanced lorebooks (React `CharacterLorebooks`): create a
    /// book bound to the selected character (`lorebooks.create` + open the
    /// lorebooks panel). Unlink is not expressible on the wire
    /// (`characterId: null` is a follow-up extension) — tap reports
    /// `CAPABILITY_UNAVAILABLE`.
    CreateCharacterLorebook,
    UnlinkCharacterLorebook(String),
    /// Character gallery upload: the kernel plane has no gallery catalog
    /// (legacy `/characters/:id/gallery`), so React `useUploadCharacterImage`
    /// rejects with `UnsupportedError('characters.gallery.upload')` — the
    /// session mirrors that honest error instead of inventing a Wire op.
    UploadGalleryImage,
    /// Cycle gallery column count `1 → 2 → 3 → 4 → 1` (Blitz `<select>` is
    /// not interactive; same pattern as `CycleSort`).
    CycleGalleryColumns,
    /// Toggle gallery sort `oldest ↔ newest`.
    CycleGallerySort,
    /// Stop/cancel an active generation stream (`generation.cancel`; React `ChatComposer` data-action="stop").
    StopGeneration,
    /// Character Management: alternate greetings interaction (React `CharacterManagementPanel.tsx`).
    ToggleAlternateGreeting(usize),
    AddAlternateGreeting,
    RemoveAlternateGreeting(usize),
    /// Message details modal (React `MessageDetailsCardV2.tsx`).
    OpenMessageDetails(String),
    CloseMessageDetails,
    SetMessageDetailsMode(String),
    SubmitMessageDetailsEdit,
    /// Settings → General appearance (React `GeneralTab` / `useUiStore`).
    /// Language is the only field that crosses Product Wire (`settings.update`).
    CycleLanguage,
    ToggleOpenHomeOnLoad,
    CycleUiScale,
    CycleContrast,
    CycleFontProfile,
    CycleMotion,
    CycleChatStyle,
    CycleChatAvatarStyle,
    CycleUserMessagePosition,
    CycleCharacterMessagePosition,
    /// React `useUiStore` sliders (Blitz range inputs are not interactive).
    /// Opacity steps 0→100 by 5; glass blur 0→40 by 4. Applied as CSS vars
    /// on the shell root (`setInterfacePreferences`).
    CycleUiOpacity,
    CycleUiGlassBlur,
    /// Settings → General `DiagnosticsPanel` (wire `diagnostics.export`).
    RunDiagnostics,
    /// Legacy sidecar maintenance: React kernel plane rejects with
    /// `UnsupportedError('search.rebuild')` / `('diagnostics.cache')`.
    RebuildSearch,
    ClearDiagnosticCache,
    /// Settings → Data `DataMigrationPanel`: kernel plane has no
    /// `imports.sillytavern.*` (legacy `/imports/sillytavern/analyze`).
    AnalyzeSillyTavern,
    /// AI Settings Advanced tab (React `AdvancedPromptSettings` /
    /// `ChatTemplateEditor`). Catalog of built-in instruct formats is empty
    /// on the kernel plane; persist via `settings.update`.
    CyclePromptMode,
    CycleInstructSelection,
    SaveInstructTemplate,
    /// React `PromptTemplateEditor.toggleBlock` — persist `enabled` via
    /// `settings.update` (`prompt-template`).
    TogglePromptBlock(String),
    /// React `PromptTemplateEditor.addPrompt` / `removePrompt` /
    /// `PromptBlockEditorDialog` (name + content + placement + role +
    /// triggers + forbidOverrides + model) / `moveBlock`. Drag and
    /// token audit stay on the React plane.
    AddPromptBlock,
    RemovePromptBlock(String),
    EditPromptBlock(String),
    PromptBlockEditCancel,
    PromptBlockEditSave,
    /// React `injectionPosition` select — local draft until Save.
    CyclePromptBlockPosition,
    /// React `role` select (`system` / `user` / `assistant`) — local draft
    /// until Save. `tool` / `plugin` are not in the React authoring menu.
    CyclePromptBlockRole,
    /// React `toggleTrigger` chip — local draft until Save. Omitted list
    /// means every kind; clearing the last chip restores the full set.
    TogglePromptBlockTrigger(String),
    /// React `forbidOverrides` Switch — local draft until Save. Visible
    /// only when content is editable and role is `system`.
    TogglePromptBlockForbidOverrides,
    /// React `ModelMenu` Load models — kernel plane has no wire discovery
    /// (`UnsupportedError('providers.models.discovery')`). No-op without an
    /// active provider, matching React `loadModels`.
    LoadPromptBlockModels,
    /// React `moveBlock(index, index ± 1)` — persist order via
    /// `settings.update`. Terminals and the last movable (next is a
    /// terminal) are no-ops.
    MovePromptBlockUp(String),
    MovePromptBlockDown(String),
    /// React `PromptTemplateEditor` preset toolbar (`presets.*` kind
    /// `prompt-template`, `active-prompt-template-preset-id`).
    CyclePromptPreset,
    PromptPresetSave,
    PromptPresetRename,
    PromptPresetDuplicate,
    PromptPresetDelete,
    /// React `PromptTemplateEditor` import/export. Export is a host-owned
    /// JSON download (no wire op); import reads a path, then
    /// `presets.create` + `settings.update` like React `importPreset`.
    PromptTemplateImportOpen,
    PromptTemplateImportClose,
    PromptTemplateImportConfirm,
    ExportPromptTemplate,
    /// Backgrounds panel upload button: the kernel plane has no wallpaper
    /// catalog, so React `useUploadBackground` rejects with
    /// `UnsupportedError('backgrounds.upload')` — the session mirrors that
    /// honest error instead of inventing a Wire op.
    UploadBackground,
    /// Themes catalog (`themes.*`; React `ThemesPage` / Settings `ThemesTab`).
    ActivateTheme(String),
    UseBuiltInTheme,
    /// React kernel plane rejects installs with
    /// `UnsupportedError('themes.install.host-verify')` (host-side package
    /// verification) — mirrored as an honest error, no invented Wire op.
    InstallTheme,
    OpenThemeDelete(String),
    CloseThemeDelete,
    ConfirmThemeDelete,
    /// Secrets tab lock button (`secrets.lock`; React `SecretsPanel` "Lock
    /// now", only for an available portable store).
    LockSecrets,
    /// AI settings card selection (`settings.update` `activeProviderConfigId`
    /// / `activeGenerationPresetId`; React `ProviderProfileEditor` /
    /// `GenerationPresetEditor`).
    SelectProvider(String),
    SelectPreset(String),
    /// Provider profile management (`providers.config.*`; React
    /// `ProviderProfileEditor` kernel plane).
    ProviderCreateOpen,
    ProviderCreateClose,
    ProviderCycleKind,
    ProviderCreateSubmit,
    ProviderDeleteOpen(String),
    ProviderDeleteClose,
    ProviderDeleteConfirm,
    /// Settings Data tab backup actions (`backups.create` / `backups.list`
    /// refresh / `backups.restore`; React DataTab).
    CreateBackup,
    RefreshBackups,
    RestoreBackup(String),
    /// AI Settings Memories tab (React `MemoryEditor` over `memories.*`).
    MemoryToggle(String),
    MemoryEditOpen(String),
    MemoryEditCancel,
    MemorySave,
    MemoryDeleteOpen(String),
    MemoryDeleteClose,
    MemoryDeleteConfirm,
    MemoryDraftToggleScope,
    MemoryCycleCharacter,
    MemoryDraftToggleEnabled,
    /// Config tab preset management (React `GenerationPresetEditor`):
    /// apply draft, save-as / rename dialog, duplicate, delete confirm.
    /// Import/export: host-owned JSON envelope; import then `presets.create`
    /// + `settings.update` like React `importPreset`. Sampler fields and
    /// unlock-context edit the live draft until Apply.
    PresetApply,
    PresetToggleUnlock,
    PresetFocusValue(String),
    PresetToggleFlag(String),
    PresetSaveAsOpen,
    PresetRenameOpen,
    PresetNameCancel,
    PresetNameSubmit,
    PresetDuplicate,
    PresetDeleteOpen,
    PresetDeleteClose,
    PresetDeleteConfirm,
    PresetImportOpen,
    PresetImportClose,
    PresetImportConfirm,
    PresetExport,
    /// Snapshots menu overlay in the chat viewport (React
    /// `ChatSnapshotsMenu`): close (also via outside click) and open a child
    /// chat row (`chats.snapshots.list` items). The header trigger rides the
    /// shared hit table as `custom.chat.snapshots-menu`.
    SnapshotsClose,
    OpenSnapshot(String),
    /// Variant picker popover (React `MessageVariantPicker`): outside tap and
    /// the ✕ button close it; a row tap activates the variant
    /// (`chats.messages.variants.activate`). The trigger and close buttons
    /// themselves ride the shared hit table via `data-action`.
    VariantPickerClose,
    /// Pick a row in the variant picker popover: message id + variant id
    /// (the synthesized `active-{id}` row closes without mutating).
    PickVariant(String, String),
    /// Chats panel row action (`chats.export`; React `ChatManagementPanel`
    /// "Export" item). The desktop host parks `last_export` and writes it.
    ExportChat(String),
    /// Book editor save (React `BookTab` name/description fields over
    /// `lorebooks.update`; only changed fields cross the wire).
    LorebookSaveMeta,
    /// Persona editor save (React `PersonasPanel` edit tab over
    /// `personas.update`; only changed fields cross the wire).
    PersonaSaveMeta,
    /// Character editor kernel fields (`characters.update`: name /
    /// description / tags). React autosaves the draft (600 ms); native
    /// Save is explicit for name+description, tags persist on add/remove.
    CharacterSaveMeta,
    AddCharacterTag,
    RemoveCharacterTag(String),
    /// Character-card import dialog (React hidden file input): path prompt
    /// staging `assets.put` → `imports.character.card`.
    ImportClose,
    ConfirmCardImport,
    /// Editor-bar action (`characters.export.card`, JSON format); the
    /// desktop host parks `last_export` and writes the file.
    ExportCharacterCard(String),
    /// Profile container import (React `ProfilesPanel` import form over
    /// `profile.import`): policy cycle + submit.
    ProfileImportPolicyCycle,
    ProfileImportSubmit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShellHit {
    Action(ShellAction),
    Absorb,
}

pub fn next_sort(current: &str) -> &'static str {
    let idx = SORTS.iter().position(|item| *item == current).unwrap_or(0);
    SORTS[(idx + 1) % SORTS.len()]
}

pub fn next_gallery_columns(current: u32) -> u32 {
    match current {
        1 => 2,
        2 => 3,
        3 => 4,
        _ => 1,
    }
}

pub fn next_gallery_sort(current: &str) -> &'static str {
    if current == "newest" {
        "oldest"
    } else {
        "newest"
    }
}

pub const LANGUAGES: &[&str] = &["en", "ru", "pseudo"];
pub const UI_SCALES: &[&str] = &["small", "medium", "large"];
pub const UI_CONTRASTS: &[&str] = &["normal", "high"];
pub const UI_FONT_PROFILES: &[&str] = &["default", "dyslexia"];
pub const UI_MOTIONS: &[&str] = &["system", "reduced"];
pub const CHAT_STYLES: &[&str] = &[
    "clean",
    "classic",
    "bubbles",
    "document",
    "cards",
    "paragraphs",
];
pub const CHAT_AVATAR_STYLES: &[&str] = &["round", "square", "portrait", "banner", "hidden"];
pub const MESSAGE_POSITIONS: &[&str] = &["left", "right"];
pub const AI_TABS: &[&str] = &["providers", "presets", "memories", "advanced"];

pub fn next_choice<'a>(options: &'a [&'a str], current: &str) -> &'a str {
    let idx = options
        .iter()
        .position(|item| *item == current)
        .unwrap_or(0);
    options[(idx + 1) % options.len()]
}

/// Cycle a stepped numeric control (React `<input type=range>`). Wraps to
/// `min` after `max`. Values that are not on the step grid snap down first.
pub fn next_step(current: u32, min: u32, max: u32, step: u32) -> u32 {
    if step == 0 || max < min {
        return current.clamp(min, max);
    }
    let aligned = ((current.saturating_sub(min)) / step) * step + min;
    let next = aligned.saturating_add(step);
    if next > max {
        min
    } else {
        next
    }
}

fn contains(x: f32, y: f32, x0: f32, y0: f32, x1: f32, y1: f32) -> bool {
    x >= x0 && x < x1 && y >= y0 && y < y1
}

fn css_size(view: &ProductShellView) -> (f32, f32) {
    (
        view.chat.viewport_width.max(1) as f32,
        view.chat.viewport_height.max(1) as f32,
    )
}

pub fn panel_css_width(view: &ProductShellView) -> f32 {
    let width = view.panel_width;
    if width < 1.0 {
        PANEL_WIDTH_DEFAULT
    } else {
        width.clamp(PANEL_WIDTH_MIN, PANEL_WIDTH_MAX)
    }
}

pub fn is_compact(view: &ProductShellView) -> bool {
    css_size(view).0 <= 600.0
}

/// Left edge of the chat main area in window CSS px.
pub fn chat_origin_x(view: &ProductShellView) -> f32 {
    chat_origin_from_parts(css_size(view).0, view.sidebar_open, view.panel_width)
}

/// Occupied CSS width of rail + open panel on desktop; 0 on compact overlay.
pub fn sidebar_occupied_css(view: &ProductShellView) -> f32 {
    chat_origin_from_parts(css_size(view).0, view.sidebar_open, view.panel_width)
}

/// `chat_origin_x` from raw shell inputs so callers that hold session state
/// (not a built [`ProductShellView`]) share the single origin rule.
pub fn chat_origin_from_parts(viewport_width: f32, sidebar_open: bool, panel_width: f32) -> f32 {
    if viewport_width <= 600.0 {
        0.0
    } else if sidebar_open {
        RAIL_WIDTH + panel_css_width_from(panel_width)
    } else {
        RAIL_WIDTH
    }
}

fn panel_css_width_from(panel_width: f32) -> f32 {
    if panel_width < 1.0 {
        PANEL_WIDTH_DEFAULT
    } else {
        panel_width.clamp(PANEL_WIDTH_MIN, PANEL_WIDTH_MAX)
    }
}

fn panel_origin(view: &ProductShellView) -> (f32, f32) {
    let (width, _) = css_size(view);
    if is_compact(view) {
        (RAIL_WIDTH, (width - RAIL_WIDTH).max(0.0))
    } else {
        let panel_w = panel_css_width(view).min((width - RAIL_WIDTH).max(0.0));
        (RAIL_WIDTH, panel_w)
    }
}

fn chrome_top(view: &ProductShellView) -> f32 {
    if is_compact(view) {
        view.insets.top.max(SPACE_2XL)
    } else {
        view.insets.top.max(SPACE_SM)
    }
}

fn chrome_bottom(view: &ProductShellView) -> f32 {
    if is_compact(view) {
        view.insets.bottom.max(SPACE_2XL)
    } else {
        view.insets.bottom.max(SPACE_SM)
    }
}

fn header_bottom(view: &ProductShellView) -> f32 {
    CONTROL_LG + chrome_top(view)
}

/// React `PromptTriggerIds` chips in `PromptBlockEditorDialog`. Two rows of
/// three; omitted list hydrates as every kind in the session, not here.
const PROMPT_BLOCK_TRIGGER_IDS: &[&str] = &[
    "normal",
    "continue",
    "impersonate",
    "swipe",
    "regenerate",
    "quiet",
];

fn prompt_block_trigger_hit(
    x: f32,
    y: f32,
    x0: f32,
    y0: f32,
    dlg_w: f32,
    in_chat: bool,
) -> Option<ShellHit> {
    let row0 = if in_chat { 264.0 } else { 204.0 };
    let band_top = y0 + row0;
    let band_h = 80.0;
    if y < band_top || y >= band_top + band_h {
        return None;
    }
    let gap = 8.0;
    let chip_w = (dlg_w - 32.0 - 16.0) / 3.0;
    for (i, id) in PROMPT_BLOCK_TRIGGER_IDS.iter().enumerate() {
        let col = (i % 3) as f32;
        let row = (i / 3) as f32;
        let cx = x0 + 16.0 + col * (chip_w + gap);
        let cy = band_top + row * 44.0;
        if contains(x, y, cx, cy, cx + chip_w, cy + 36.0) {
            return Some(ShellHit::Action(ShellAction::TogglePromptBlockTrigger(
                (*id).to_string(),
            )));
        }
    }
    Some(ShellHit::Absorb)
}

fn dialog_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    let (width, height) = css_size(view);
    let chat_x0 = chat_origin_x(view);
    if view.card_import_dialog_open {
        let dlg_w = 320.0_f32.min(width - 32.0);
        let dlg_h = 240.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ImportClose));
        }
        // Path input absorbs (focus resolves via the part rect).
        let field_top = y0 + 72.0;
        if y >= field_top && y < field_top + 48.0 {
            return Some(ShellHit::Absorb);
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ImportClose));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ConfirmCardImport));
        }
        return Some(ShellHit::Absorb);
    }
    if view.prompt_template_import_open {
        let dlg_w = 320.0_f32.min(width - 32.0);
        let dlg_h = 240.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PromptTemplateImportClose));
        }
        let field_top = y0 + 72.0;
        if y >= field_top && y < field_top + 48.0 {
            return Some(ShellHit::Absorb);
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PromptTemplateImportClose));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PromptTemplateImportConfirm));
        }
        return Some(ShellHit::Absorb);
    }
    if view.generation_preset_import_open {
        let dlg_w = 320.0_f32.min(width - 32.0);
        let dlg_h = 240.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PresetImportClose));
        }
        let field_top = y0 + 72.0;
        if y >= field_top && y < field_top + 48.0 {
            return Some(ShellHit::Absorb);
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PresetImportClose));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PresetImportConfirm));
        }
        return Some(ShellHit::Absorb);
    }
    if view.provider_create_dialog_open {
        let dlg_w = 320.0_f32.min(width - 32.0);
        let dlg_h = 240.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ProviderCreateClose));
        }
        // Kind cycle row.
        let kind_top = y0 + 72.0;
        if y >= kind_top && y < kind_top + 36.0 && x >= x0 + 16.0 && x < x0 + dlg_w - 16.0 {
            return Some(ShellHit::Action(ShellAction::ProviderCycleKind));
        }
        // Name input absorbs (focus resolves via the part rect).
        let field_top = kind_top + 44.0;
        if y >= field_top && y < field_top + 36.0 {
            return Some(ShellHit::Absorb);
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ProviderCreateClose));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ProviderCreateSubmit));
        }
        return Some(ShellHit::Absorb);
    }
    if view.preset_name_dialog_open {
        let dlg_w = 320.0_f32.min(width - 32.0);
        let dlg_h = 220.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PresetNameCancel));
        }
        let field_top = y0 + 72.0;
        if y >= field_top && y < field_top + 48.0 {
            return Some(ShellHit::Absorb);
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PresetNameCancel));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PresetNameSubmit));
        }
        return Some(ShellHit::Absorb);
    }
    if view.prompt_block_edit_open {
        let in_chat = view.prompt_block_injection_position == "in-chat";
        let dlg_w = 400.0_f32.min(width - 32.0);
        let dlg_h = if in_chat {
            584.0_f32.min(height - 48.0)
        } else {
            500.0_f32.min(height - 48.0)
        };
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PromptBlockEditCancel));
        }
        let name_top = y0 + 72.0;
        if y >= name_top && y < name_top + 36.0 {
            return Some(ShellHit::Absorb);
        }
        let role_top = y0 + 116.0;
        if y >= role_top && y < role_top + 36.0 {
            return Some(ShellHit::Action(ShellAction::CyclePromptBlockRole));
        }
        let position_top = y0 + 160.0;
        if y >= position_top && y < position_top + 36.0 {
            return Some(ShellHit::Action(ShellAction::CyclePromptBlockPosition));
        }
        if in_chat {
            let extras_top = y0 + 204.0;
            if y >= extras_top && y < extras_top + 52.0 {
                return Some(ShellHit::Absorb);
            }
        }
        if let Some(hit) = prompt_block_trigger_hit(x, y, x0, y0, dlg_w, in_chat) {
            return Some(hit);
        }
        let content_top = if in_chat { y0 + 352.0 } else { y0 + 292.0 };
        let role_system = !matches!(view.prompt_block_role.as_str(), "user" | "assistant");
        let forbid_visible = view.prompt_block_content_editable && role_system;
        if forbid_visible && y >= content_top && y < content_top + 36.0 {
            return Some(ShellHit::Action(
                ShellAction::TogglePromptBlockForbidOverrides,
            ));
        }
        let field_top = if forbid_visible {
            content_top + 36.0
        } else {
            content_top
        };
        let field_h = if forbid_visible { 36.0 } else { 72.0 };
        if y >= field_top && y < field_top + field_h {
            return Some(ShellHit::Absorb);
        }
        let model_top = if in_chat { y0 + 432.0 } else { y0 + 372.0 };
        if y >= model_top && y < model_top + 36.0 {
            let load_x0 = x0 + dlg_w - 16.0 - 96.0;
            if x >= load_x0 && x < x0 + dlg_w - 16.0 {
                return Some(ShellHit::Action(ShellAction::LoadPromptBlockModels));
            }
            return Some(ShellHit::Absorb);
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PromptBlockEditCancel));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PromptBlockEditSave));
        }
        return Some(ShellHit::Absorb);
    }
    if view.preset_delete_open {
        let dlg_w = 300.0_f32.min(width - 32.0);
        let dlg_h = 200.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PresetDeleteClose));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PresetDeleteClose));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::PresetDeleteConfirm));
        }
        return Some(ShellHit::Absorb);
    }
    if view.memory_delete_open {
        let dlg_w = 300.0_f32.min(width - 32.0);
        let dlg_h = 200.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::MemoryDeleteClose));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::MemoryDeleteClose));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::MemoryDeleteConfirm));
        }
        return Some(ShellHit::Absorb);
    }
    if view.theme_delete_open {
        let dlg_w = 300.0_f32.min(width - 32.0);
        let dlg_h = 200.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseThemeDelete));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseThemeDelete));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ConfirmThemeDelete));
        }
        return Some(ShellHit::Absorb);
    }
    if view.chat_delete_open {
        let dlg_w = 300.0_f32.min(width - 32.0);
        let dlg_h = 200.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseChatDelete));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseChatDelete));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ConfirmChatDelete));
        }
        return Some(ShellHit::Absorb);
    }
    if view.chat_rename_open {
        let dlg_w = 320.0_f32.min(width - 32.0);
        let dlg_h = 220.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseChatRename));
        }
        let field_top = y0 + 72.0;
        if y >= field_top && y < field_top + 48.0 {
            return Some(ShellHit::Absorb);
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseChatRename));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::SubmitChatRename));
        }
        return Some(ShellHit::Absorb);
    }
    if view.checkpoint_delete_open {
        let dlg_w = 300.0_f32.min(width - 32.0);
        let dlg_h = 200.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseCheckpointDelete));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseCheckpointDelete));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ConfirmCheckpointDelete));
        }
        return Some(ShellHit::Absorb);
    }
    if view.run_transcript_open {
        let dlg_w = 640.0_f32.min(width - 32.0);
        let dlg_h = 560.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseRunTranscript));
        }
        let close_y = y0 + 16.0;
        if contains(
            x,
            y,
            x0 + dlg_w - 44.0,
            close_y,
            x0 + dlg_w - 4.0,
            close_y + 40.0,
        ) {
            return Some(ShellHit::Action(ShellAction::CloseRunTranscript));
        }
        return Some(ShellHit::Absorb);
    }
    if view.prompt_plan_open {
        let dlg_w = 640.0_f32.min(width - 32.0);
        let dlg_h = 560.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ClosePromptPlan));
        }
        let close_y = y0 + 16.0;
        if contains(
            x,
            y,
            x0 + dlg_w - 44.0,
            close_y,
            x0 + dlg_w - 4.0,
            close_y + 40.0,
        ) {
            return Some(ShellHit::Action(ShellAction::ClosePromptPlan));
        }
        return Some(ShellHit::Absorb);
    }
    if view.plugin_uninstall_open {
        let dlg_w = 320.0_f32.min(width - 32.0);
        let dlg_h = 220.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ClosePluginUninstall));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ClosePluginUninstall));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ConfirmPluginUninstall));
        }
        return Some(ShellHit::Absorb);
    }
    if view.profile_delete_open {
        let dlg_w = 300.0_f32.min(width - 32.0);
        let dlg_h = 200.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseProfileDelete));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseProfileDelete));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ConfirmProfileDelete));
        }
        return Some(ShellHit::Absorb);
    }
    if view.entry_delete_open {
        let dlg_w = 300.0_f32.min(width - 32.0);
        let dlg_h = 200.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseEntryDelete));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseEntryDelete));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ConfirmEntryDelete));
        }
        return Some(ShellHit::Absorb);
    }
    if view.entry_dialog_open {
        let dlg_w = 400.0_f32.min(width - 32.0);
        let dlg_h = 520.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseEntryDialog));
        }
        // Switch rows: right-aligned 88px toggle zone per row (React rows
        // wrap a Radix `Switch`; only the switch itself toggles).
        let switch_zone = |row_y: f32| {
            contains(
                x,
                y,
                x0 + dlg_w - 16.0 - 88.0,
                row_y,
                x0 + dlg_w - 16.0,
                row_y + 32.0,
            )
        };
        if switch_zone(y0 + 240.0) {
            return Some(ShellHit::Action(ShellAction::EntryToggleConstant));
        }
        if switch_zone(y0 + 276.0) {
            return Some(ShellHit::Action(ShellAction::EntryToggleSelective));
        }
        if switch_zone(y0 + 312.0) {
            return Some(ShellHit::Action(ShellAction::EntryToggleEnabled));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseEntryDialog));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::SaveEntry));
        }
        return Some(ShellHit::Absorb);
    }
    if view.create_dialog_open {
        let dlg_w = 320.0_f32.min(width - 32.0);
        let dlg_h = 360.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseCreate));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseCreate));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ConfirmCreate));
        }
        return Some(ShellHit::Absorb);
    }
    if view.delete_dialog_open {
        let dlg_w = 300.0_f32.min(width - 32.0);
        let dlg_h = 200.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseDelete));
        }
        let actions_y = y0 + dlg_h - 56.0;
        if contains(x, y, x0, actions_y, x0 + dlg_w * 0.5, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::CloseDelete));
        }
        if contains(x, y, x0 + dlg_w * 0.5, actions_y, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ConfirmDelete));
        }
        return Some(ShellHit::Absorb);
    }
    None
}

fn rail_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    let (width, height) = css_size(view);
    if is_compact(view) && !view.sidebar_open {
        // Mobile bottom navigation bar hit testing
        let bottom_pad = chrome_bottom(view);
        let nav_top = height - 56.0 - bottom_pad;
        if y >= nav_top && y <= height {
            let nav_panels = ["home", "characters", "personas", "lorebooks", "settings"];
            let item_w = width / nav_panels.len() as f32;
            let idx = (x / item_w).floor() as usize;
            let panel = nav_panels[idx.min(nav_panels.len() - 1)];
            return Some(ShellHit::Action(ShellAction::SetPanel(panel.into())));
        }
        return None;
    }

    if x < 0.0 || x >= RAIL_WIDTH {
        return None;
    }
    let top = chrome_top(view);
    if y < top {
        return Some(ShellHit::Absorb);
    }
    let menu_bottom = top + CONTROL_LG;
    if y < menu_bottom {
        return Some(ShellHit::Action(ShellAction::ToggleRail));
    }
    let mut cursor = menu_bottom + SPACE_SM + SPACE_XS;
    for panel in RAIL_PANELS {
        let bottom = cursor + CONTROL_SM + SPACE_XS;
        if y >= cursor && y < bottom {
            return Some(ShellHit::Action(ShellAction::SetPanel((*panel).into())));
        }
        cursor = bottom + SPACE_XS;
    }
    Some(ShellHit::Absorb)
}

fn character_manager_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (panel_x, panel_w) = panel_origin(view);
    let x1 = panel_x + panel_w;
    if x < panel_x || x >= x1 {
        return None;
    }
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let tabs_top = header_end + SPACE_XS;
    let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
    let tabs_x0 = panel_x + SPACE_LG;
    let tabs_x1 = x1 - SPACE_LG;
    if y >= tabs_top && y < tabs_bottom && x >= tabs_x0 && x < tabs_x1 {
        let span = (tabs_x1 - tabs_x0).max(1.0);
        let idx = (((x - tabs_x0) / span) * TABS.len() as f32).floor() as usize;
        let tab = TABS[idx.min(TABS.len() - 1)];
        if tab != "cards" && view.selected_character_id.is_none() {
            return Some(ShellHit::Absorb);
        }
        return Some(ShellHit::Action(ShellAction::SetTab(tab.into())));
    }
    let content_top = tabs_bottom + SPACE_XS;
    match view.tab.as_str() {
        "cards" => cards_hit(view, panel_x, panel_w, x1, content_top, x, y),
        "edit" => editor_hit(view, panel_x, x1, content_top, x, y),
        "advanced" => character_advanced_hit(view, panel_x, x1, content_top, x, y),
        "gallery" => gallery_hit(view, panel_x, x1, content_top, x, y),
        _ => Some(ShellHit::Absorb),
    }
}

fn cards_hit(
    view: &ProductShellView,
    panel_x: f32,
    panel_w: f32,
    x1: f32,
    content_top: f32,
    x: f32,
    y: f32,
) -> Option<ShellHit> {
    let pad = SPACE_LG;
    let inner_x0 = panel_x + pad;
    let toolbar_top = content_top + SPACE_SM;
    let toolbar_bottom = toolbar_top + CONTROL;
    if contains(x, y, inner_x0, toolbar_top, inner_x0 + 88.0, toolbar_bottom) {
        return Some(ShellHit::Action(ShellAction::OpenCreate));
    }
    if contains(
        x,
        y,
        inner_x0 + 92.0,
        toolbar_top,
        inner_x0 + 180.0,
        toolbar_bottom,
    ) {
        return Some(ShellHit::Action(ShellAction::Import));
    }
    if contains(
        x,
        y,
        x1 - pad - 110.0,
        toolbar_top,
        x1 - pad,
        toolbar_bottom,
    ) {
        return Some(ShellHit::Action(ShellAction::CycleSort));
    }
    let search_top = toolbar_bottom + SPACE_MD;
    let search_bottom = search_top + CONTROL;
    let meta_top = search_bottom + SPACE_MD;
    let meta_bottom = meta_top + CONTROL_SM;
    if contains(x, y, inner_x0, meta_top, inner_x0 + CONTROL_SM, meta_bottom) {
        return Some(ShellHit::Action(ShellAction::SetView("list".into())));
    }
    if contains(
        x,
        y,
        inner_x0 + CONTROL_SM + SPACE_XS,
        meta_top,
        inner_x0 + CONTROL_SM * 2.0 + SPACE_XS,
        meta_bottom,
    ) {
        return Some(ShellHit::Action(ShellAction::SetView("grid".into())));
    }
    let list_top = meta_bottom + SPACE_MD;
    if y < list_top {
        return Some(ShellHit::Absorb);
    }
    if view.characters.is_empty() {
        return Some(ShellHit::Absorb);
    }
    if view.view == "grid" {
        let col_w = ((panel_w - pad * 2.0) / 2.0).max(1.0);
        let card_h = 168.0;
        for (index, card) in view.characters.iter().enumerate() {
            let col = (index % 2) as f32;
            let row = (index / 2) as f32;
            let x0 = inner_x0 + col * (col_w + SPACE_XS);
            let y0 = list_top + row * (card_h + SPACE_XS);
            if contains(x, y, x0, y0, x0 + col_w, y0 + card_h) {
                return Some(ShellHit::Action(ShellAction::SelectCharacter(
                    card.id.clone(),
                )));
            }
        }
        return Some(ShellHit::Absorb);
    }
    let card_h = CONTROL_LG + SPACE_SM * 2.0;
    for (index, card) in view.characters.iter().enumerate() {
        let y0 = list_top + index as f32 * (card_h + SPACE_XS);
        if contains(x, y, inner_x0, y0, x1 - pad, y0 + card_h) {
            return Some(ShellHit::Action(ShellAction::SelectCharacter(
                card.id.clone(),
            )));
        }
    }
    Some(ShellHit::Absorb)
}

fn editor_hit(
    view: &ProductShellView,
    panel_x: f32,
    x1: f32,
    content_top: f32,
    x: f32,
    y: f32,
) -> Option<ShellHit> {
    let bar_top = content_top + SPACE_SM;
    let bar_bottom = bar_top + CONTROL_SM;
    if y >= bar_top && y < bar_bottom {
        if x < panel_x + SPACE_LG + CONTROL_SM {
            return Some(ShellHit::Action(ShellAction::BackToCards));
        }
        let right = x1 - SPACE_LG;
        if x >= right - CONTROL_SM {
            return Some(ShellHit::Action(ShellAction::OpenDelete));
        }
        // Duplicate button (`characters.create` with "{name} copy").
        if x >= right - CONTROL_SM * 2.0 {
            return Some(ShellHit::Action(ShellAction::DuplicateCharacter));
        }
        if x >= right - CONTROL_SM * 3.0 {
            if let Some(id) = view.selected_character_id.as_deref() {
                return Some(ShellHit::Action(ShellAction::ExportCharacterCard(
                    id.into(),
                )));
            }
            return Some(ShellHit::Absorb);
        }
        if x >= right - CONTROL_SM * 4.0 {
            return Some(ShellHit::Action(ShellAction::ToggleFavorite));
        }
        return Some(ShellHit::Absorb);
    }
    let pad = SPACE_LG;
    let mut cursor = bar_bottom + SPACE_SM;
    // Identity row (avatar + title).
    cursor += 64.0 + SPACE_SM;
    if y >= cursor && y < cursor + 56.0 {
        return Some(ShellHit::Absorb);
    }
    cursor += 56.0 + SPACE_SM;
    if y >= cursor && y < cursor + 88.0 {
        return Some(ShellHit::Absorb);
    }
    cursor += 88.0 + SPACE_SM;
    if y >= cursor && y < cursor + 36.0 && x >= panel_x + pad && x < panel_x + pad + 96.0 {
        return Some(ShellHit::Action(ShellAction::CharacterSaveMeta));
    }
    cursor += 36.0 + SPACE_SM;
    // Tags heading 20 + gap 8.
    cursor += 20.0 + SPACE_SM;
    if y >= cursor && y < cursor + 36.0 && x >= panel_x + pad && x < x1 - pad {
        if x >= x1 - pad - 96.0 {
            return Some(ShellHit::Action(ShellAction::AddCharacterTag));
        }
        return Some(ShellHit::Absorb);
    }
    cursor += 36.0 + SPACE_SM;
    if let Some(draft) = view.selected_draft.as_ref() {
        for tag in draft.tags.iter() {
            if y >= cursor && y < cursor + 28.0 && x >= panel_x + pad && x < x1 - pad {
                return Some(ShellHit::Action(ShellAction::RemoveCharacterTag(
                    tag.clone(),
                )));
            }
            cursor += 28.0 + 4.0;
        }
        // First message (88px) + Creator notes (88px)
        cursor += 88.0 + SPACE_SM;
        cursor += 88.0 + SPACE_SM;
        // Greetings subsection header (title + Add button)
        let header_h = 36.0;
        if y >= cursor && y < cursor + header_h && x >= panel_x + pad && x < x1 - pad {
            if x >= x1 - pad - 96.0 {
                return Some(ShellHit::Action(ShellAction::AddAlternateGreeting));
            }
            return Some(ShellHit::Absorb);
        }
        cursor += header_h + SPACE_SM;
        for (idx, _greeting) in draft.alternate_greetings.iter().enumerate() {
            let row_h = 36.0;
            if y >= cursor && y < cursor + row_h && x >= panel_x + pad && x < x1 - pad {
                if x >= x1 - pad - CONTROL_SM {
                    return Some(ShellHit::Action(ShellAction::RemoveAlternateGreeting(idx)));
                } else {
                    return Some(ShellHit::Action(ShellAction::ToggleAlternateGreeting(idx)));
                }
            }
            cursor += row_h + 4.0;
            if view.expanded_greeting == Some(idx) {
                let edit_h = 88.0;
                cursor += edit_h + 4.0;
            }
        }
    }
    Some(ShellHit::Absorb)
}

/// Character Advanced lorebooks strip (React `CharacterLorebooks`). Native
/// puts the linked-books chrome at the top of Advanced so Blitz hit-testing
/// does not need to scroll past the prompt fields. No editor action bar —
/// React keeps that bar on Edit only.
fn character_advanced_hit(
    view: &ProductShellView,
    panel_x: f32,
    x1: f32,
    content_top: f32,
    x: f32,
    y: f32,
) -> Option<ShellHit> {
    let pad = SPACE_LG;
    let hint_top = content_top + SPACE_SM;
    let hint_h = 32.0;
    let actions_top = hint_top + hint_h + SPACE_SM;
    let actions_h = 36.0;
    if y >= actions_top && y < actions_top + actions_h && x >= panel_x + pad && x < x1 - pad {
        let mid = panel_x + (x1 - panel_x) * 0.5;
        if x < mid {
            return Some(ShellHit::Action(ShellAction::CreateCharacterLorebook));
        }
        return Some(ShellHit::Action(ShellAction::SetPanel("lorebooks".into())));
    }
    let mut row_top = actions_top + actions_h + SPACE_SM;
    let character_id = view.selected_character_id.as_deref();
    for book in view
        .lorebooks
        .iter()
        .filter(|book| character_id.is_some() && book.character_id.as_deref() == character_id)
    {
        let row_h = 40.0;
        if y >= row_top && y < row_top + row_h && x >= panel_x + pad && x < x1 - pad {
            if x >= x1 - pad - CONTROL_SM {
                return Some(ShellHit::Action(ShellAction::UnlinkCharacterLorebook(
                    book.id.clone(),
                )));
            }
            return Some(ShellHit::Absorb);
        }
        row_top += row_h + SPACE_XS;
    }
    Some(ShellHit::Absorb)
}

/// Gallery tab (React `GalleryTab`): toolbar selects + Add image. Kernel
/// plane has no gallery catalog, so upload maps to the honest
/// `CAPABILITY_UNAVAILABLE` error (no invented `characters.gallery.*` op).
/// The action bar lives on Edit only; gallery content starts at `content_top`.
fn gallery_hit(
    view: &ProductShellView,
    panel_x: f32,
    x1: f32,
    content_top: f32,
    x: f32,
    y: f32,
) -> Option<ShellHit> {
    let pad = SPACE_LG;
    let tool_top = content_top + SPACE_SM;
    let tool_bottom = tool_top + CONTROL_SM;
    if y >= tool_top && y < tool_bottom {
        let add_w = 120.0;
        let sort_w = 88.0;
        let cols_w = 88.0;
        if x >= x1 - pad - add_w {
            return Some(ShellHit::Action(ShellAction::UploadGalleryImage));
        }
        if x >= x1 - pad - add_w - sort_w {
            return Some(ShellHit::Action(ShellAction::CycleGallerySort));
        }
        if x >= x1 - pad - add_w - sort_w - cols_w {
            return Some(ShellHit::Action(ShellAction::CycleGalleryColumns));
        }
        return Some(ShellHit::Absorb);
    }
    let has_avatar = view
        .selected_draft
        .as_ref()
        .and_then(|draft| draft.avatar_asset_id.as_ref())
        .is_some();
    if !has_avatar {
        let empty_btn_top = tool_bottom + 96.0;
        let empty_btn_h = 36.0;
        if y >= empty_btn_top
            && y < empty_btn_top + empty_btn_h
            && x >= panel_x + pad
            && x < x1 - pad
        {
            return Some(ShellHit::Action(ShellAction::UploadGalleryImage));
        }
    }
    Some(ShellHit::Absorb)
}

/// Hit-test CSS-pixel coordinates against the current shell view.
pub fn hit_test(view: &ProductShellView, css_x: f32, css_y: f32) -> Option<ShellHit> {
    let (width, _) = css_size(view);
    let x = if view.dir == "rtl" {
        (width - css_x).max(0.0)
    } else {
        css_x
    };
    let y = css_y;
    if let Some(hit) = dialog_hit(view, x, y) {
        return Some(hit);
    }
    if let Some(hit) = rail_hit(view, x, y) {
        return Some(hit);
    }
    if view.sidebar_open && view.panel == "characters" {
        if let Some(hit) = character_manager_hit(view, x, y) {
            return Some(hit);
        }
    } else if view.sidebar_open && view.panel == "personas" {
        if let Some(hit) = personas_hit(view, x, y) {
            return Some(hit);
        }
    } else if view.sidebar_open && view.panel == "lorebooks" {
        if let Some(hit) = lorebooks_hit(view, x, y) {
            return Some(hit);
        }
    } else if view.sidebar_open && view.panel == "home" {
        if let Some(hit) = chats_hit(view, x, y) {
            return Some(hit);
        }
    } else if view.sidebar_open {
        let (panel_x, panel_w) = panel_origin(view);
        if !contains(x, y, panel_x, 0.0, panel_x + panel_w, css_size(view).1) {
            return None;
        }
        match view.panel.as_str() {
            "providers" => {
                if view.ai_tab == "memories" {
                    return memories_hit(view, x, y, panel_x, panel_x + panel_w);
                }
                if view.ai_tab == "presets" {
                    return presets_config_hit(view, x, y, panel_x, panel_x + panel_w);
                }
                if view.ai_tab == "advanced" {
                    return advanced_hit(view, x, y, panel_x, panel_x + panel_w);
                }
                return providers_hit(view, x, y, panel_x, panel_x + panel_w);
            }
            "settings" => {
                return settings_hit(view, x, y);
            }
            "plugins" => {
                return plugins_hit(view, x, y);
            }
            "backgrounds" => {
                return backgrounds_hit(view, x, y);
            }
            _ => {
                let header_end = header_bottom(view);
                if y < header_end && x >= panel_x + panel_w - CONTROL_SM - SPACE_LG {
                    return Some(ShellHit::Action(ShellAction::ClosePanel));
                }
                return Some(ShellHit::Absorb);
            }
        }
    }
    if view.chat.snapshots_menu_open {
        if let Some(hit) = snapshots_menu_hit(view, x, y) {
            return Some(hit);
        }
    }
    if view.chat.variant_picker_for.is_some() {
        if let Some(hit) = variant_picker_hit(view, x, y) {
            return Some(hit);
        }
    }
    None
}

/// Snapshots menu overlay (React `ChatSnapshotsMenu` panel): mirrors the
/// DOM geometry of `snapshots_menu_panel` in the dioxus shell — viewport
/// coordinates `left:16px; right:16px; top:12px`, padding 12, title row 28,
/// rows 48 + gap 6; a tap outside closes the menu like React's outside-click
/// handler.
fn snapshots_menu_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    let (width, height) = css_size(view);
    let chat_x0 = chat_origin_x(view);
    let (_, header_h, _, composer_h) = chrome_metrics(width as u32, height as u32);
    let composer_bottom = height - composer_h as f32 - chrome_bottom(view);
    let viewport_top = chrome_top(view) + header_h as f32;
    let items = &view.chat.snapshot_items;
    let list_h = if items.is_empty() {
        16.0
    } else {
        items.len() as f32 * 48.0 - 6.0
    };
    let panel_h = (12.0 + 28.0 + 8.0 + list_h + 12.0).min((composer_bottom - viewport_top) * 0.6);
    let px0 = chat_x0 + 16.0;
    let px1 = width - 16.0;
    let py0 = header_bottom(view) + SPACE_SM;
    let py1 = py0 + panel_h;
    if !contains(x, y, px0, py0, px1, py1) {
        return Some(ShellHit::Action(ShellAction::SnapshotsClose));
    }
    // Close button rides the title row's right edge.
    if contains(x, y, px1 - 40.0, py0 + 12.0, px1 - 12.0, py0 + 40.0) {
        return Some(ShellHit::Action(ShellAction::SnapshotsClose));
    }
    let mut cursor = py0 + 48.0;
    for item in items.iter() {
        if contains(x, y, px0 + 12.0, cursor, px1 - 12.0, cursor + 48.0) {
            return Some(ShellHit::Action(ShellAction::OpenSnapshot(item.id.clone())));
        }
        cursor += 48.0 + 6.0;
    }
    Some(ShellHit::Absorb)
}

/// Variant picker popover (React `MessageVariantPicker` listbox): mirrors the
/// DOM geometry of `variant_picker_popover` in the dioxus shell — same panel
/// scaffold as the snapshots menu (left/right 16, top 12, padding 12, header
/// 28) with 40px-min rows + 6 gap; the ✕ is a `data-action` button that the
/// hit-rect table resolves first, so only rows and outside lands here. A tap
/// outside closes the popover like React's outside-click handler.
fn variant_picker_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    let picker = view.chat.variant_picker_for.as_deref()?;
    let (width, height) = css_size(view);
    let chat_x0 = chat_origin_x(view);
    let (_, header_h, _, composer_h) = chrome_metrics(width as u32, height as u32);
    let composer_bottom = height - composer_h as f32 - chrome_bottom(view);
    let viewport_top = chrome_top(view) + header_h as f32;
    let items = &view.chat.variant_picker_rows;
    let list_h = if items.is_empty() {
        16.0
    } else {
        items.len() as f32 * 40.0 + (items.len().saturating_sub(1)) as f32 * 6.0
    };
    let panel_h = (12.0 + 28.0 + 6.0 + list_h + 12.0).min((composer_bottom - viewport_top) * 0.6);
    let px0 = chat_x0 + 16.0;
    let px1 = width - 16.0;
    let py0 = header_bottom(view) + SPACE_SM;
    let py1 = py0 + panel_h;
    if !contains(x, y, px0, py0, px1, py1) {
        return Some(ShellHit::Action(ShellAction::VariantPickerClose));
    }
    // Close button rides the title row's right edge (the hit-rect table
    // resolves it too — keep both honest).
    if contains(x, y, px1 - 40.0, py0 + 12.0, px1 - 12.0, py0 + 40.0) {
        return Some(ShellHit::Action(ShellAction::VariantPickerClose));
    }
    let mut cursor = py0 + 48.0;
    for item in view.chat.variant_picker_rows.iter() {
        let row_h = 40.0;
        if contains(x, y, px0 + 12.0, cursor, px1 - 12.0, cursor + row_h) {
            return Some(ShellHit::Action(ShellAction::PickVariant(
                picker.to_string(),
                item.id.clone(),
            )));
        }
        cursor += row_h + 6.0;
    }
    Some(ShellHit::Absorb)
}

/// Hit-test a managed catalog panel: optional tab row (AI providers/presets,
/// Settings general/host) plus a vertical selectable card list under it.
fn personas_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if view.persona_tab == "edit" && view.selected_persona_id.is_some() {
        return persona_edit_hit(view, x, y);
    }
    list_panel_hit(
        view,
        x,
        y,
        &["cards", "edit"],
        view.persona_tab.as_str(),
        view.selected_persona_id.is_some(),
        view.personas.iter().map(|item| item.id.as_str()),
        |id| ShellAction::SelectPersona(id.into()),
    )
}

/// React `PersonasPanel` edit tab: action bar (Back to personas / Duplicate /
/// Delete / Save) over the name input + description textarea; typing focus
/// resolves via `part:persona-name-input` / `part:persona-description-input`.
fn persona_edit_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (panel_x, panel_w) = panel_origin(view);
    let x1 = panel_x + panel_w;
    if x < panel_x || x >= x1 {
        return None;
    }
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let tabs_top = header_end + SPACE_XS;
    let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
    if y >= tabs_top && y < tabs_bottom {
        let tabs = ["cards", "edit"];
        let span = (panel_w - SPACE_LG * 2.0).max(1.0);
        let idx = (((x - (panel_x + SPACE_LG)) / span) * tabs.len() as f32).floor() as usize;
        return Some(ShellHit::Action(ShellAction::SetTab(
            tabs[idx.min(tabs.len() - 1)].into(),
        )));
    }
    let pad = SPACE_LG;
    // Action bar: Back (left), Duplicate / Delete / Save (right).
    let bar_top = tabs_bottom + SPACE_SM;
    let bar_bottom = bar_top + CONTROL_SM;
    if y >= bar_top && y < bar_bottom {
        if x < panel_x + pad + 160.0 {
            return Some(ShellHit::Action(ShellAction::SetTab("cards".into())));
        }
        if x >= x1 - pad - 200.0 && x < x1 - pad - 100.0 {
            return Some(ShellHit::Action(ShellAction::OpenDelete));
        }
        if x >= x1 - pad - 96.0 {
            return Some(ShellHit::Action(ShellAction::PersonaSaveMeta));
        }
        return Some(ShellHit::Absorb);
    }
    // Name field + description textarea absorb taps; typing focus is
    // bin-local via the part rects.
    Some(ShellHit::Absorb)
}

fn lorebooks_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if view.lorebook_tab == "entries" && view.selected_lorebook_id.is_some() {
        return lorebook_entries_hit(view, x, y);
    }
    if view.lorebook_tab == "book" && view.selected_lorebook_id.is_some() {
        return lorebook_book_hit(view, x, y);
    }
    list_panel_hit(
        view,
        x,
        y,
        &["books", "book", "entries"],
        view.lorebook_tab.as_str(),
        view.selected_lorebook_id.is_some(),
        view.lorebooks.iter().map(|item| item.id.as_str()),
        |id| ShellAction::SelectLorebook(id.into()),
    )
}

/// React `LorebookPanel` BookTab: action bar (Back to books / Delete / Save)
/// over the name input + description textarea (typing focus resolves via
/// `part:lorebook-name-input` / `part:lorebook-description-input`).
fn lorebook_book_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (panel_x, panel_w) = panel_origin(view);
    let x1 = panel_x + panel_w;
    if x < panel_x || x >= x1 {
        return None;
    }
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let tabs_top = header_end + SPACE_XS;
    let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
    if y >= tabs_top && y < tabs_bottom {
        let tabs = ["books", "book", "entries"];
        let span = (panel_w - SPACE_LG * 2.0).max(1.0);
        let idx = (((x - (panel_x + SPACE_LG)) / span) * tabs.len() as f32).floor() as usize;
        return Some(ShellHit::Action(ShellAction::SetTab(
            tabs[idx.min(tabs.len() - 1)].into(),
        )));
    }
    let pad = SPACE_LG;
    // Action bar: Back (left), Delete + Save (right).
    let bar_top = tabs_bottom + SPACE_SM;
    let bar_bottom = bar_top + CONTROL_SM;
    if y >= bar_top && y < bar_bottom {
        if x < panel_x + pad + 140.0 {
            return Some(ShellHit::Action(ShellAction::SetTab("books".into())));
        }
        if x >= x1 - pad - 44.0 - 4.0 && x < x1 - pad - 48.0 {
            return Some(ShellHit::Action(ShellAction::OpenDelete));
        }
        if x >= x1 - pad - 92.0 {
            return Some(ShellHit::Action(ShellAction::LorebookSaveMeta));
        }
        return Some(ShellHit::Absorb);
    }
    // Name field + description textarea absorb taps; typing focus is
    // bin-local via the part rects.
    return Some(ShellHit::Absorb);
}

/// React `LorebookPanel` EntriesTab: toolbar (Back to books / Add entry),
/// hint, then entry rows carrying the row actions (toggle / edit / delete).
fn lorebook_entries_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (panel_x, panel_w) = panel_origin(view);
    let x1 = panel_x + panel_w;
    if x < panel_x || x >= x1 {
        return None;
    }
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let tabs_top = header_end + SPACE_XS;
    let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
    if y >= tabs_top && y < tabs_bottom {
        let tabs = ["books", "book", "entries"];
        let span = (panel_w - SPACE_LG * 2.0).max(1.0);
        let idx = (((x - (panel_x + SPACE_LG)) / span) * tabs.len() as f32).floor() as usize;
        return Some(ShellHit::Action(ShellAction::SetTab(
            tabs[idx.min(tabs.len() - 1)].into(),
        )));
    }
    let content_top = tabs_bottom + SPACE_XS;
    let pad = SPACE_LG;
    let toolbar_top = content_top + SPACE_SM;
    let toolbar_bottom = toolbar_top + CONTROL_SM;
    if y >= toolbar_top && y < toolbar_bottom {
        if x < panel_x + pad + 140.0 {
            return Some(ShellHit::Action(ShellAction::SetTab("books".into())));
        }
        if x >= x1 - pad - 140.0 {
            return Some(ShellHit::Action(ShellAction::OpenEntryDialog));
        }
        return Some(ShellHit::Absorb);
    }
    let list_top = toolbar_bottom + SPACE_SM;
    if view.lorebook_entries.is_empty() {
        return Some(ShellHit::Absorb);
    }
    let row_h = 64.0;
    for (index, entry) in view.lorebook_entries.iter().enumerate() {
        let y0 = list_top + index as f32 * (row_h + SPACE_XS);
        if y < y0 || y >= y0 + row_h {
            continue;
        }
        let id = entry.id.clone();
        // Row actions occupy the right 132px: toggle / edit / delete.
        if x >= x1 - pad - 132.0 && x < x1 - pad - 88.0 {
            return Some(ShellHit::Action(ShellAction::ToggleLorebookEntry(id)));
        }
        if x >= x1 - pad - 88.0 && x < x1 - pad - 44.0 {
            return Some(ShellHit::Action(ShellAction::EditLorebookEntry(id)));
        }
        if x >= x1 - pad - 44.0 && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::OpenEntryDelete(id)));
        }
        return Some(ShellHit::Absorb);
    }
    Some(ShellHit::Absorb)
}

/// Settings panel: shared tab row (General / Themes / Data / Profiles /
/// Secrets / Tools), then tab-specific body regions.
fn settings_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (panel_x, panel_w) = panel_origin(view);
    let x1 = panel_x + panel_w;
    if x < panel_x || x >= x1 {
        return None;
    }
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let tabs = ["general", "themes", "data", "profiles", "secrets", "tools"];
    let tabs_top = header_end + SPACE_XS;
    let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
    if y >= tabs_top && y < tabs_bottom {
        let span = (panel_w - SPACE_LG * 2.0).max(1.0);
        let idx = (((x - (panel_x + SPACE_LG)) / span) * tabs.len() as f32).floor() as usize;
        return Some(ShellHit::Action(ShellAction::SetTab(
            tabs[idx.min(tabs.len() - 1)].into(),
        )));
    }
    if view.settings_tab == "profiles" {
        return profiles_hit(view, x, y, panel_x, x1, tabs_bottom);
    }
    if view.settings_tab == "themes" {
        return themes_hit(view, x, y, panel_x, x1, tabs_bottom);
    }
    if view.settings_tab == "secrets" {
        return secrets_hit(view, x, y, panel_x, x1, tabs_bottom);
    }
    if view.settings_tab == "data" {
        return data_hit(view, x, y, panel_x, x1, tabs_bottom);
    }
    general_hit(view, x, y, panel_x, x1, tabs_bottom)
}

/// React `GeneralTab` cycle rows. Geometry: padding 12 + Startup header
/// (20+12+16+12) + row 40+12 + Appearance header + language/dir/scale… rows.
fn general_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
    tabs_bottom: f32,
) -> Option<ShellHit> {
    let pad = SPACE_LG;
    if x < panel_x + pad || x >= x1 - pad {
        return Some(ShellHit::Absorb);
    }
    let header = 20.0 + 12.0 + 16.0 + 12.0;
    let row = CONTROL_SM + 12.0;
    let mut cursor = tabs_bottom + 12.0 + header;
    // Startup row.
    if y >= cursor && y < cursor + CONTROL_SM {
        return Some(ShellHit::Action(ShellAction::ToggleOpenHomeOnLoad));
    }
    cursor += row + header;
    let appearance = [
        ShellAction::CycleLanguage,
        ShellAction::CycleLanguage, // placeholder; index 1 is direction (Absorb)
        ShellAction::CycleUiScale,
        ShellAction::CycleFontProfile,
        ShellAction::CycleContrast,
        ShellAction::CycleMotion,
        ShellAction::CycleUserMessagePosition,
        ShellAction::CycleCharacterMessagePosition,
        ShellAction::CycleChatStyle,
        ShellAction::CycleChatAvatarStyle,
    ];
    // Index 1 is the read-only direction row.
    for (i, action) in appearance.iter().enumerate() {
        if y >= cursor && y < cursor + CONTROL_SM {
            if i == 1 {
                return Some(ShellHit::Absorb);
            }
            return Some(ShellHit::Action(action.clone()));
        }
        cursor += row;
    }
    // Opacity / glass-blur cycles (React range sliders).
    if y >= cursor && y < cursor + CONTROL_SM {
        return Some(ShellHit::Action(ShellAction::CycleUiOpacity));
    }
    cursor += row;
    if y >= cursor && y < cursor + CONTROL_SM {
        return Some(ShellHit::Action(ShellAction::CycleUiGlassBlur));
    }
    cursor += row;
    // Safe-mode field (20) + hint (16) + section gap, then Diagnostics
    // header (title 20 + hint 16) matching `general_tab`.
    cursor += CONTROL_SM + 12.0 + 16.0 + 12.0 + 20.0 + 12.0 + 16.0 + 12.0;
    if y >= cursor && y < cursor + 36.0 {
        return Some(ShellHit::Action(ShellAction::RunDiagnostics));
    }
    cursor += 36.0 + 12.0;
    if view.diagnostics.is_some() {
        cursor += 7.0 * 20.0 + 12.0;
    } else {
        cursor += 16.0 + 12.0;
    }
    cursor += 16.0 + 12.0; // privacy / kernel-maintenance note
    if y >= cursor && y < cursor + 36.0 {
        if x < panel_x + pad + 180.0 {
            return Some(ShellHit::Action(ShellAction::RebuildSearch));
        }
        return Some(ShellHit::Action(ShellAction::ClearDiagnosticCache));
    }
    Some(ShellHit::Absorb)
}

/// React `AdvancedPromptSettings` body: mode switch, then either Chat
/// template (serialization + optional Save) or Prompt template (block
/// enabled toggles). Shares the 4-tab band with API/Config/Memories.
fn advanced_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (_, panel_w) = panel_origin(view);
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let pad = SPACE_LG;
    let tabs_top = header_end + SPACE_XS;
    let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
    if y >= tabs_top && y < tabs_bottom {
        let tabs_x0 = panel_x + SPACE_LG;
        let span = (panel_w - SPACE_LG * 2.0).max(1.0);
        let idx = (((x - tabs_x0) / span) * AI_TABS.len() as f32).floor() as usize;
        return Some(ShellHit::Action(ShellAction::SetTab(
            AI_TABS[idx.min(AI_TABS.len() - 1)].into(),
        )));
    }
    let mut cursor = tabs_bottom + 12.0;
    if y >= cursor && y < cursor + 40.0 {
        return Some(ShellHit::Action(ShellAction::CyclePromptMode));
    }
    cursor += 40.0 + 8.0;
    if view.prompt_template_mode != "text" {
        // Chat template heading 20 + hint 16.
        cursor += 20.0 + 8.0 + 16.0 + 8.0;
        if y >= cursor && y < cursor + 36.0 && x >= panel_x + pad && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::CycleInstructSelection));
        }
        cursor += 36.0 + 8.0 + 16.0 + 8.0;
        if view.instruct_selection == "custom" {
            // Five role rows (56) + stopping-strings (72); `gap:8` between
            // each sibling inside the template editor.
            cursor += 5.0 * (56.0 + 8.0) + 72.0 + 8.0;
            if y >= cursor && y < cursor + 36.0 && x >= panel_x + pad && x < panel_x + pad + 140.0 {
                return Some(ShellHit::Action(ShellAction::SaveInstructTemplate));
            }
        }
    } else {
        // Title 20 + hint 32 + honesty 16 + preset cycle 36 + toolbar 36 +
        // import/export 36, then Add + 36px block rows.
        cursor += 20.0 + 8.0 + 32.0 + 8.0 + 16.0 + 8.0;
        if y >= cursor && y < cursor + 36.0 && x >= panel_x + pad && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::CyclePromptPreset));
        }
        cursor += 36.0 + 8.0;
        if y >= cursor && y < cursor + 36.0 {
            if x >= panel_x + pad && x < panel_x + pad + 96.0 {
                return Some(ShellHit::Action(ShellAction::PromptPresetSave));
            }
            if x >= panel_x + pad + 104.0 && x < panel_x + pad + 200.0 {
                return Some(ShellHit::Action(ShellAction::PromptPresetRename));
            }
            if x >= panel_x + pad + 208.0 && x < panel_x + pad + 304.0 {
                return Some(ShellHit::Action(ShellAction::PromptPresetDuplicate));
            }
            if x >= x1 - pad - 96.0 && x < x1 - pad {
                return Some(ShellHit::Action(ShellAction::PromptPresetDelete));
            }
            return Some(ShellHit::Absorb);
        }
        cursor += 36.0 + 8.0;
        if y >= cursor && y < cursor + 36.0 {
            if x >= panel_x + pad && x < panel_x + pad + 96.0 {
                return Some(ShellHit::Action(ShellAction::PromptTemplateImportOpen));
            }
            if x >= panel_x + pad + 104.0 && x < panel_x + pad + 200.0 {
                return Some(ShellHit::Action(ShellAction::ExportPromptTemplate));
            }
            return Some(ShellHit::Absorb);
        }
        cursor += 36.0 + 8.0;
        // Add sits above the list so it stays hittable without panel scroll
        // (React puts the footer after 12+ rows).
        if y >= cursor && y < cursor + 36.0 && x >= panel_x + pad && x < panel_x + pad + 140.0 {
            return Some(ShellHit::Action(ShellAction::AddPromptBlock));
        }
        cursor += 36.0 + 8.0;
        // Row: toggle 48 | name flex | Up 32 | Down 32 | [remove 36].
        // Hit from the right so remove / move zones do not overlap Edit.
        const MOVE: f32 = 32.0;
        const REMOVE: f32 = 36.0;
        for block in view.prompt_blocks.iter() {
            if y >= cursor && y < cursor + 36.0 && x >= panel_x + pad && x < x1 - pad {
                let mut edge = x1 - pad;
                if block.custom {
                    if x >= edge - REMOVE {
                        return Some(ShellHit::Action(ShellAction::RemovePromptBlock(
                            block.id.clone(),
                        )));
                    }
                    edge -= REMOVE + SPACE_SM;
                }
                if x >= edge - MOVE && x < edge {
                    if block.can_move_down {
                        return Some(ShellHit::Action(ShellAction::MovePromptBlockDown(
                            block.id.clone(),
                        )));
                    }
                    return Some(ShellHit::Absorb);
                }
                edge -= MOVE + SPACE_SM;
                if x >= edge - MOVE && x < edge {
                    if block.can_move_up {
                        return Some(ShellHit::Action(ShellAction::MovePromptBlockUp(
                            block.id.clone(),
                        )));
                    }
                    return Some(ShellHit::Absorb);
                }
                if x < panel_x + pad + 48.0 {
                    return Some(ShellHit::Action(ShellAction::TogglePromptBlock(
                        block.id.clone(),
                    )));
                }
                return Some(ShellHit::Action(ShellAction::EditPromptBlock(
                    block.id.clone(),
                )));
            }
            cursor += 36.0 + 8.0;
        }
    }
    Some(ShellHit::Absorb)
}

/// React `SettingsPanel` DataTab body: SillyTavern migration honesty,
/// activation status, then the Create/Refresh action row and backup rows.
/// Geometry mirrors `settings_tab.rs::data_tab`.
fn data_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
    tabs_bottom: f32,
) -> Option<ShellHit> {
    let pad = SPACE_LG;
    let mut cursor = tabs_bottom + 12.0;
    // Migration: title 20 + gap 8 + hint 32 + gap 8 + analyze 36.
    cursor += 20.0 + 8.0 + 32.0 + 8.0;
    if y >= cursor && y < cursor + 36.0 && x >= panel_x + pad && x < x1 - pad {
        return Some(ShellHit::Action(ShellAction::AnalyzeSillyTavern));
    }
    cursor += 36.0 + 8.0 + 32.0 + 8.0; // button + safety note
                                       // Activation status is read-only.
    cursor += 20.0 + 8.0 + 32.0 + 8.0; // title + hint
    if let Some(status) = view.data_activation.as_ref() {
        cursor += 20.0 + 8.0; // layout
        cursor += 20.0 + 8.0; // active root
        if status.active_root_id.is_some() {
            cursor += 20.0 + 8.0;
        }
        if status.pending.is_some() {
            cursor += 32.0 + 8.0;
        }
        cursor += 16.0 + 8.0; // journal heading
        if status.entries.is_empty() {
            cursor += 16.0 + 8.0;
        } else {
            cursor += status.entries.len() as f32 * (20.0 + 8.0);
        }
    } else {
        cursor += 16.0 + 8.0; // unavailable
    }
    // Backups: title 20 + gap 8 + hint 32 + gap 8 + actions 36.
    cursor += 20.0 + 8.0 + 32.0 + 8.0;
    let actions_top = cursor;
    if y >= actions_top && y < actions_top + 36.0 {
        // Primary "Create backup" first half, ghost "Refresh backups" second.
        if x >= panel_x + pad && x < panel_x + pad + 140.0 {
            return Some(ShellHit::Action(ShellAction::CreateBackup));
        }
        if x >= panel_x + pad + 148.0 && x < panel_x + pad + 288.0 {
            return Some(ShellHit::Action(ShellAction::RefreshBackups));
        }
        return Some(ShellHit::Absorb);
    }
    cursor = actions_top + 36.0 + 8.0;
    for item in view.backups.iter() {
        let bottom = cursor + 64.0 + 4.0;
        if y >= cursor && y < bottom - 4.0 && x >= x1 - pad - 96.0 && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::RestoreBackup(
                item.id.clone(),
            )));
        }
        cursor = bottom;
    }
    Some(ShellHit::Absorb)
}

/// React `MemoryEditor` body over `memories.*`. Owns the 4-tab band
/// (API / Config / Memories / Advanced), then heading 20 + hint 16 (outer gaps 8),
/// memory cards 112 (normal) / 172 (editing) separated by gap 8, an optional
/// empty note / error line, and the create form (156) while not editing.
/// Text inputs resolve keyboard focus via their `data-part` rects in the
/// desktop host, so they Absorb here. Mirrors
/// `ai_settings_tab.rs::memories_tab`.
fn memories_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (_, panel_w) = panel_origin(view);
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let pad = SPACE_LG;
    let tabs = AI_TABS;
    let tabs_top = header_end + SPACE_XS;
    let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
    if y >= tabs_top && y < tabs_bottom {
        let tabs_x0 = panel_x + SPACE_LG;
        let span = (panel_w - SPACE_LG * 2.0).max(1.0);
        let idx = (((x - tabs_x0) / span) * tabs.len() as f32).floor() as usize;
        return Some(ShellHit::Action(ShellAction::SetTab(
            tabs[idx.min(tabs.len() - 1)].into(),
        )));
    }
    let inner_l = panel_x + pad + 8.0;
    let inner_r = x1 - pad - 8.0;
    // Body: padding 12 + heading 20 + gap 8 + hint 16 + gap 8.
    let mut cursor = tabs_bottom + 12.0 + 20.0 + 8.0 + 16.0 + 8.0;
    for item in view.memories.iter() {
        let editing = view.memory_edit_id.as_deref() == Some(item.id.as_str());
        let h = if editing { 172.0 } else { 112.0 };
        let top = cursor;
        let act_top = top + h - 8.0 - 36.0;
        if y >= top && y < top + h {
            if y >= act_top && y < act_top + 36.0 {
                if x >= inner_l && x < inner_l + 96.0 {
                    return Some(ShellHit::Action(if editing {
                        ShellAction::MemorySave
                    } else {
                        ShellAction::MemoryEditOpen(item.id.clone())
                    }));
                }
                if editing && x >= inner_l + 104.0 && x < inner_l + 192.0 {
                    return Some(ShellHit::Action(ShellAction::MemoryEditCancel));
                }
                if x >= inner_r - 96.0 && x < inner_r {
                    return Some(ShellHit::Action(ShellAction::MemoryDeleteOpen(
                        item.id.clone(),
                    )));
                }
                return Some(ShellHit::Absorb);
            }
            if !editing && y >= top + 8.0 && y < top + 28.0 && x >= inner_r - 88.0 && x < inner_r {
                return Some(ShellHit::Action(ShellAction::MemoryToggle(item.id.clone())));
            }
            return Some(ShellHit::Absorb);
        }
        cursor = top + h + 8.0;
    }
    if view.memories.is_empty() && view.memory_edit_id.is_none() {
        cursor += 16.0 + 8.0; // empty note line
    }
    if view.memory_form_error.is_some() {
        cursor += 16.0 + 8.0; // form error line
    }
    if view.memory_edit_id.is_none() {
        // Create form: content 36, keys 36, scope row 36, add button 36 with
        // inner gaps of 4 → total 156.
        let scope_top = cursor + 36.0 + 4.0 + 36.0 + 4.0;
        let add_top = scope_top + 36.0 + 4.0;
        if y >= scope_top && y < scope_top + 36.0 {
            if x >= inner_l && x < inner_l + 96.0 {
                return Some(ShellHit::Action(ShellAction::MemoryDraftToggleScope));
            }
            if x >= inner_l + 104.0 && x < inner_l + 200.0 {
                return Some(ShellHit::Action(ShellAction::MemoryDraftToggleScope));
            }
            if view.memory_draft_scope_character && x >= inner_l + 208.0 && x < inner_r - 88.0 - 8.0
            {
                return Some(ShellHit::Action(ShellAction::MemoryCycleCharacter));
            }
            if x >= inner_r - 88.0 && x < inner_r {
                return Some(ShellHit::Action(ShellAction::MemoryDraftToggleEnabled));
            }
            return Some(ShellHit::Absorb);
        }
        if y >= add_top && y < add_top + 36.0 && x >= inner_l && x < inner_l + 140.0 {
            return Some(ShellHit::Action(ShellAction::MemorySave));
        }
    }
    Some(ShellHit::Absorb)
}

/// React `GenerationPresetEditor` body (Config tab): the management toolbar,
/// unlock-context, compact numeric sampler fields + reasoning/stream
/// switches, Apply, then the selector cards (tap = select). Geometry mirrors
/// `ai_settings_tab.rs::presets_tab`: padding 12 + heading 20 + gap 8 + hint
/// 16 + gap 8 + active label 20 + gap 8 + toolbar 36 + gap 8 + files 36 +
/// gap 8 + unlock 36 + gap 8 + hint 16 + gap 8 + values card + gap 8;
/// cards 60 + 4.
fn presets_config_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (_, panel_w) = panel_origin(view);
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let pad = SPACE_LG;
    let tabs = AI_TABS;
    let tabs_top = header_end + SPACE_XS;
    let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
    if y >= tabs_top && y < tabs_bottom {
        let tabs_x0 = panel_x + SPACE_LG;
        let span = (panel_w - SPACE_LG * 2.0).max(1.0);
        let idx = (((x - tabs_x0) / span) * tabs.len() as f32).floor() as usize;
        return Some(ShellHit::Action(ShellAction::SetTab(
            tabs[idx.min(tabs.len() - 1)].into(),
        )));
    }
    let inner_r = x1 - pad;
    // Body: heading 20 + hint 16 + active label 20 + toolbar 36 + files 36.
    let mut cursor = tabs_bottom + 12.0 + 20.0 + 8.0 + 16.0 + 8.0 + 20.0 + 8.0;
    // Toolbar: Save as / Rename / Duplicate left, Delete right.
    if y >= cursor && y < cursor + 36.0 {
        if x >= panel_x + pad && x < panel_x + pad + 96.0 {
            return Some(ShellHit::Action(ShellAction::PresetSaveAsOpen));
        }
        if x >= panel_x + pad + 104.0 && x < panel_x + pad + 200.0 {
            return Some(ShellHit::Action(ShellAction::PresetRenameOpen));
        }
        if x >= panel_x + pad + 208.0 && x < panel_x + pad + 304.0 {
            return Some(ShellHit::Action(ShellAction::PresetDuplicate));
        }
        if x >= inner_r - 96.0 && x < inner_r {
            return Some(ShellHit::Action(ShellAction::PresetDeleteOpen));
        }
        return Some(ShellHit::Absorb);
    }
    cursor += 36.0 + 8.0;
    if y >= cursor && y < cursor + 36.0 {
        if x >= panel_x + pad && x < panel_x + pad + 96.0 {
            return Some(ShellHit::Action(ShellAction::PresetImportOpen));
        }
        if x >= panel_x + pad + 104.0 && x < panel_x + pad + 200.0 {
            return Some(ShellHit::Action(ShellAction::PresetExport));
        }
        return Some(ShellHit::Absorb);
    }
    cursor += 36.0 + 8.0;
    if y >= cursor && y < cursor + 36.0 {
        if x >= panel_x + pad && x < inner_r {
            return Some(ShellHit::Action(ShellAction::PresetToggleUnlock));
        }
        return Some(ShellHit::Absorb);
    }
    cursor += 36.0 + 8.0;
    if y >= cursor && y < cursor + 16.0 {
        return Some(ShellHit::Absorb);
    }
    cursor += 16.0 + 8.0;
    // Values card: 8 px padding, 4 px gaps; context full-width, then 2-col
    // numeric pairs, then toggle rows.
    let card_top = cursor;
    let content_l = panel_x + pad + 8.0;
    let content_r = inner_r - 8.0;
    let mut inner = card_top + 8.0;
    if let Some(row) = view
        .preset_rows
        .iter()
        .find(|row| row.id == "maxContextTokens")
    {
        if y >= inner && y < inner + 28.0 && x >= content_l && x < content_r {
            return Some(ShellHit::Action(ShellAction::PresetFocusValue(
                row.id.clone(),
            )));
        }
        inner += 28.0 + 4.0;
    }
    let numeric: Vec<&PresetValueRow> = view
        .preset_rows
        .iter()
        .filter(|row| row.kind == "number" && row.id != "maxContextTokens")
        .collect();
    let col_w = ((content_r - content_l - 8.0) / 2.0).max(1.0);
    for chunk in numeric.chunks(2) {
        if y >= inner && y < inner + 28.0 {
            if x >= content_l && x < content_l + col_w {
                return Some(ShellHit::Action(ShellAction::PresetFocusValue(
                    chunk[0].id.clone(),
                )));
            }
            if chunk.len() > 1 && x >= content_l + col_w + 8.0 && x < content_r {
                return Some(ShellHit::Action(ShellAction::PresetFocusValue(
                    chunk[1].id.clone(),
                )));
            }
            return Some(ShellHit::Absorb);
        }
        inner += 28.0 + 4.0;
    }
    for row in view.preset_rows.iter().filter(|row| row.kind == "toggle") {
        if y >= inner && y < inner + 28.0 && x >= content_l && x < content_r {
            return Some(ShellHit::Action(ShellAction::PresetToggleFlag(
                row.id.clone(),
            )));
        }
        inner += 28.0 + 4.0;
    }
    let values_bottom = inner - 4.0 + 8.0;
    cursor = values_bottom.max(card_top) + 8.0;
    // Apply row.
    if y >= cursor && y < cursor + 36.0 {
        if x >= panel_x + pad && x < inner_r {
            return Some(ShellHit::Action(ShellAction::PresetApply));
        }
        return Some(ShellHit::Absorb);
    }
    cursor += 36.0 + 8.0;
    // Selector cards: tap selects the preset.
    for item in view.presets.iter() {
        let bottom = cursor + 60.0 + 4.0;
        if y >= cursor && y < bottom - 4.0 && x >= panel_x + pad && x < inner_r {
            return Some(ShellHit::Action(ShellAction::SelectPreset(item.id.clone())));
        }
        cursor = bottom;
    }
    Some(ShellHit::Absorb)
}

/// React `ProviderProfileEditor` body (API tab): the "New profile" button,
/// connection-profile rows carrying Delete in the right zone (tap elsewhere
/// on a row = select via `settings.update` `activeProviderConfigId`), then
/// read-only adapter rows from `providers.list`. Geometry mirrors
/// `ai_settings_tab.rs::providers_tab`: padding 12 + heading 20 + gap 8 +
/// button 36 + gap 8; profile rows 64 + 4; adapters label 20 + note 16 +
/// rows 60 + 4.
fn providers_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (_, panel_w) = panel_origin(view);
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let pad = SPACE_LG;
    let tabs = AI_TABS;
    let tabs_top = header_end + SPACE_XS;
    let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
    if y >= tabs_top && y < tabs_bottom {
        let tabs_x0 = panel_x + SPACE_LG;
        let span = (panel_w - SPACE_LG * 2.0).max(1.0);
        let idx = (((x - tabs_x0) / span) * tabs.len() as f32).floor() as usize;
        return Some(ShellHit::Action(ShellAction::SetTab(
            tabs[idx.min(tabs.len() - 1)].into(),
        )));
    }
    let inner_r = x1 - pad;
    let mut cursor = tabs_bottom + 12.0 + 20.0 + 8.0;
    // "New profile" button.
    if y >= cursor && y < cursor + 36.0 {
        if x >= panel_x + pad && x < panel_x + pad + 140.0 {
            return Some(ShellHit::Action(ShellAction::ProviderCreateOpen));
        }
        return Some(ShellHit::Absorb);
    }
    cursor += 36.0 + 8.0;
    // Empty note line when no profiles.
    if view.provider_configs.is_empty() {
        if y >= cursor && y < cursor + 16.0 {
            return Some(ShellHit::Absorb);
        }
        cursor += 16.0 + 8.0;
    }
    // Profile rows: tap = select, right zone = delete.
    for item in view.provider_configs.iter() {
        let bottom = cursor + 64.0 + 4.0;
        if y >= cursor && y < bottom - 4.0 && x >= panel_x + pad && x < inner_r {
            if x >= inner_r - 12.0 - 96.0 && x < inner_r - 12.0 {
                return Some(ShellHit::Action(ShellAction::ProviderDeleteOpen(
                    item.id.clone(),
                )));
            }
            return Some(ShellHit::Action(ShellAction::SelectProvider(
                item.id.clone(),
            )));
        }
        cursor = bottom;
    }
    // Adapters section label + hint.
    cursor += 8.0; // margin-top on the label
    if y >= cursor && y < cursor + 20.0 + 8.0 + 16.0 {
        return Some(ShellHit::Absorb);
    }
    cursor += 20.0 + 8.0 + 16.0 + 8.0;
    // Adapter rows are informational only.
    Some(ShellHit::Absorb)
}

/// React `SecretsPanel` body: title + hint, the mode card, the flag list
/// (5 rows + 1 for the portable format version), then the "Lock now" button
/// — only when the store is a portable and available one (React `canLock`).
/// Secret values never render; everything but the lock button is Absorb.
/// Geometry mirrors `settings_tab.rs::secrets_tab` (padding 12 + title 20 +
/// gap 8 + hint 32 + gap 8 + mode card 64 + gap 8 + flags 20/row).
fn secrets_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
    tabs_bottom: f32,
) -> Option<ShellHit> {
    let Some(status) = view.secrets_status.as_ref() else {
        return Some(ShellHit::Absorb);
    };
    if !(status.kind == "portable" && status.available) {
        return Some(ShellHit::Absorb);
    }
    let pad = SPACE_LG;
    let rows = 5.0
        + if status.format_version.is_some() {
            1.0
        } else {
            0.0
        };
    let button_top = tabs_bottom + 12.0 + 20.0 + 8.0 + 32.0 + 8.0 + 64.0 + 8.0 + rows * 20.0 + 8.0;
    if y >= button_top && y < button_top + 36.0 {
        if x >= panel_x + pad && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::LockSecrets));
        }
        return Some(ShellHit::Absorb);
    }
    Some(ShellHit::Absorb)
}

/// React `ThemesTab` body: the install row (kernel plane rejects it with
/// `CAPABILITY_UNAVAILABLE`), the honest host-verify note, the "Use built-in
/// theme" row while a theme is active, then theme rows carrying
/// Apply (96 px) / delete (44 px) in the right zone; an active row shows the
/// badge and is inert.
/// Geometry mirrors `settings_tab.rs::themes_tab` (label 16 + gap 8 → install
/// row 36; note 32; built-in row 36; rows 64 + 4).
fn themes_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
    tabs_bottom: f32,
) -> Option<ShellHit> {
    let pad = SPACE_LG;
    let install_top = tabs_bottom + SPACE_XS + 12.0 + 16.0 + 8.0;
    if y >= install_top && y < install_top + 36.0 {
        if x >= panel_x + pad && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::InstallTheme));
        }
        return Some(ShellHit::Absorb);
    }
    let note_top = install_top + 36.0 + 8.0;
    if y >= note_top && y < note_top + 32.0 {
        return Some(ShellHit::Absorb);
    }
    let mut rows_top = note_top + 32.0 + 8.0;
    if view.themes.iter().any(|item| item.active) {
        let builtin_top = rows_top;
        if y >= builtin_top && y < builtin_top + 36.0 {
            if x >= x1 - pad - 168.0 && x < x1 - pad {
                return Some(ShellHit::Action(ShellAction::UseBuiltInTheme));
            }
            return Some(ShellHit::Absorb);
        }
        rows_top = builtin_top + 36.0 + 8.0;
    }
    for (index, item) in view.themes.iter().enumerate() {
        let y0 = rows_top + index as f32 * (64.0 + SPACE_XS);
        if y < y0 || y >= y0 + 64.0 {
            continue;
        }
        if item.active {
            return Some(ShellHit::Absorb);
        }
        let id = item.id.clone();
        if x >= x1 - pad - 96.0 && x < x1 - pad - 44.0 {
            return Some(ShellHit::Action(ShellAction::ActivateTheme(id)));
        }
        if x >= x1 - pad - 44.0 && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::OpenThemeDelete(id)));
        }
        return Some(ShellHit::Absorb);
    }
    Some(ShellHit::Absorb)
}

/// React `ProfilesPanel` body: inline create row (input + Create button),
/// an honest import note (the packaged host owns the file picker), then
/// profile rows carrying export / rename / delete in the right 132 px. An
/// inline-renaming row swaps the actions for Save / Cancel.
/// Geometry mirrors `settings_tab.rs::profiles_tab` (label 16 + gap 8 →
/// create row 36; import block 104; rows 64 + 4).
fn profiles_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
    tabs_bottom: f32,
) -> Option<ShellHit> {
    let pad = SPACE_LG;
    let create_row_top = tabs_bottom + SPACE_XS + 12.0 + 16.0 + 8.0;
    let create_row_bottom = create_row_top + 36.0;
    if y >= create_row_top && y < create_row_bottom {
        if x >= x1 - pad - 96.0 {
            return Some(ShellHit::Action(ShellAction::CreateProfile));
        }
        return Some(ShellHit::Absorb);
    }
    let import_top = create_row_bottom + SPACE_MD;
    // Heading 20 + gap 8 + hint 16, then the input row (path absorb /
    // policy cycle / Import submit).
    let row_top = import_top + 44.0;
    let import_bottom = row_top + 36.0;
    if y >= import_top && y < import_bottom {
        if y >= row_top {
            if x >= x1 - pad - 96.0 {
                return Some(ShellHit::Action(ShellAction::ProfileImportSubmit));
            }
            if x >= x1 - pad - 96.0 - SPACE_SM - 96.0 && x < x1 - pad - 96.0 {
                return Some(ShellHit::Action(ShellAction::ProfileImportPolicyCycle));
            }
        }
        return Some(ShellHit::Absorb);
    }
    let rows_start = import_bottom + SPACE_MD + 40.0;
    let row_h = 64.0;
    let row_gap = SPACE_XS;
    for (index, profile) in view.profiles.iter().enumerate() {
        let y0 = rows_start + index as f32 * (row_h + row_gap);
        if y < y0 || y >= y0 + row_h {
            continue;
        }
        let id = profile.id.clone();
        if view.profile_renaming_id.as_deref() == Some(id.as_str()) {
            if x >= x1 - pad - 176.0 && x < x1 - pad - 88.0 {
                return Some(ShellHit::Action(ShellAction::SubmitProfileRename));
            }
            if x >= x1 - pad - 88.0 && x < x1 - pad {
                return Some(ShellHit::Action(ShellAction::CancelProfileRename));
            }
            return Some(ShellHit::Absorb);
        }
        if x >= x1 - pad - 132.0 && x < x1 - pad - 88.0 {
            return Some(ShellHit::Action(ShellAction::ExportProfile(id)));
        }
        if x >= x1 - pad - 88.0 && x < x1 - pad - 44.0 {
            return Some(ShellHit::Action(ShellAction::StartProfileRename(id)));
        }
        if x >= x1 - pad - 44.0 && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::OpenProfileDelete(id)));
        }
        return Some(ShellHit::Absorb);
    }
    Some(ShellHit::Absorb)
}

/// Plugins panel body: subtitle, contained note, install bar and list meta
/// form fixed blocks above the cards; each card carries a toggle switch and
/// an uninstall button in its bottom actions row. Safe mode disables every
/// lifecycle action (React disables the whole page surface).
/// Geometry mirrors `plugins_tab.rs::plugins_panel` (subtitle 28, note 56,
/// install bar 36, meta 20, cards 112 + 16 gap).
fn plugins_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (panel_x, panel_w) = panel_origin(view);
    let x1 = panel_x + panel_w;
    if x < panel_x || x >= x1 {
        return None;
    }
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let safe_mode = view.chat.error_code.as_deref() == Some("SAFE_MODE");
    let pad = SPACE_LG;
    // Subtitle 20 (padding 8) + note 56 (margin 8) + install bar 36
    // (padding 8) + meta 20 = 8 + 20 + 8 + 56 + 8 + 36 + 8 + 20.
    let list_top = header_end + 164.0;
    if y < list_top {
        return Some(ShellHit::Absorb);
    }
    if safe_mode || view.plugins.is_empty() {
        return Some(ShellHit::Absorb);
    }
    let card_h = 112.0;
    let card_gap = SPACE_LG;
    for (index, plugin) in view.plugins.iter().enumerate() {
        let y0 = list_top + index as f32 * (card_h + card_gap);
        if y < y0 || y >= y0 + card_h {
            continue;
        }
        let actions_top = y0 + card_h - 36.0;
        if y < actions_top {
            return Some(ShellHit::Absorb);
        }
        let id = plugin.id.clone();
        if x >= x1 - pad - 44.0 && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::TogglePlugin(id)));
        }
        if x >= x1 - pad - 88.0 && x < x1 - pad - 44.0 {
            return Some(ShellHit::Action(ShellAction::OpenPluginUninstall(id)));
        }
        return Some(ShellHit::Absorb);
    }
    Some(ShellHit::Absorb)
}

/// Backgrounds panel: header close button plus the upload button in the
/// empty state. There is no catalog to hit-test: the kernel plane honestly
/// lists zero wallpapers (React `useBackgrounds`), so the gallery body is
/// Absorb and the upload button maps to the honest `CAPABILITY_UNAVAILABLE`
/// error.
fn backgrounds_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (panel_x, panel_w) = panel_origin(view);
    let x1 = panel_x + panel_w;
    if x < panel_x || x >= x1 {
        return None;
    }
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    // Upload button: centered in the empty-state block under the hint
    // (hint 8+20+8, empty state starts 16 below, button ~36px tall).
    let button_top = header_end + 124.0;
    let button_h = 36.0;
    if y >= button_top && y < button_top + button_h {
        let button_w = 168.0;
        let button_x0 = x1 - SPACE_LG - button_w;
        if x >= button_x0 && x < x1 - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::UploadBackground));
        }
    }
    Some(ShellHit::Absorb)
}

/// Home/chats panel: the real `chats.list` rows; a tap opens that chat.
/// Dedicated helper (no tab row / create toolbar like the persona lists).
fn chats_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if !view.sidebar_open {
        return None;
    }
    let (panel_x, panel_w) = panel_origin(view);
    let x1 = panel_x + panel_w;
    if x < panel_x || x >= x1 {
        return None;
    }
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    // Measured from the live Windows render (snapshot color-band mapping at
    // 1100×760): the panel's own `SidebarPanelHeader` sits above these bands,
    // so anchors are taken from the rendered pixels, not re-derived:
    // search field [86,130), `newChatAction` button [146,190), list rows from
    // 198 with a measured ~76px row height (React chatCopy stacks
    // strong/span/characterLabel) plus the 4px list gap.
    let search_top = 86.0;
    let search_bottom = 130.0;
    if y >= search_top && y < search_bottom {
        // Typing focus is bin-local (like the character manager search).
        return Some(ShellHit::Absorb);
    }
    let new_chat_top = 146.0;
    let new_chat_bottom = 190.0;
    if contains(
        x,
        y,
        panel_x + SPACE_LG,
        new_chat_top,
        panel_x + SPACE_LG + 140.0,
        new_chat_bottom,
    ) {
        return Some(ShellHit::Action(ShellAction::CreateChat));
    }
    let mut cursor = 198.0;
    let pad = SPACE_LG;
    for item in view.chat_list.iter() {
        let bottom = cursor + 76.0;
        if y >= cursor && y < bottom {
            let id = item.id.clone();
            // Row actions in the right 132 px (rename / export / delete) —
            // same compact equivalent as the entries/profile rows; the rest
            // of the row opens the chat.
            if x >= x1 - pad - 132.0 && x < x1 - pad - 88.0 {
                return Some(ShellHit::Action(ShellAction::ExportChat(id)));
            }
            if x >= x1 - pad - 88.0 && x < x1 - pad - 44.0 {
                return Some(ShellHit::Action(ShellAction::StartChatRename(id)));
            }
            if x >= x1 - pad - 44.0 && x < x1 - pad {
                return Some(ShellHit::Action(ShellAction::OpenChatDelete(id)));
            }
            return Some(ShellHit::Action(ShellAction::SelectChat(id)));
        }
        cursor = bottom + SPACE_XS;
    }
    Some(ShellHit::Absorb)
}

fn list_panel_hit<'a, I, F>(
    view: &ProductShellView,
    x: f32,
    y: f32,
    tabs: &[&str],
    active_tab: &str,
    can_edit: bool,
    ids: I,
    select: F,
) -> Option<ShellHit>
where
    I: IntoIterator<Item = &'a str>,
    F: Fn(&str) -> ShellAction,
{
    if !view.sidebar_open {
        return None;
    }
    let (panel_x, panel_w) = panel_origin(view);
    let x1 = panel_x + panel_w;
    if x < panel_x || x >= x1 {
        return None;
    }
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    let mut content_top = header_end;
    if !tabs.is_empty() {
        let tabs_top = header_end + SPACE_XS;
        let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
        let tabs_x0 = panel_x + SPACE_LG;
        let tabs_x1 = x1 - SPACE_LG;
        if y >= tabs_top && y < tabs_bottom && x >= tabs_x0 && x < tabs_x1 {
            let span = (tabs_x1 - tabs_x0).max(1.0);
            let idx = (((x - tabs_x0) / span) * tabs.len() as f32).floor() as usize;
            let tab = tabs[idx.min(tabs.len() - 1)];
            if tab != tabs[0] && !can_edit {
                return Some(ShellHit::Absorb);
            }
            return Some(ShellHit::Action(ShellAction::SetTab(tab.into())));
        }
        content_top = tabs_bottom + SPACE_XS;
    }
    let pad = SPACE_LG;
    let inner_x0 = panel_x + pad;
    let toolbar_top = content_top + SPACE_SM;
    let toolbar_bottom = toolbar_top + CONTROL;
    if active_tab == tabs[0]
        && contains(x, y, inner_x0, toolbar_top, inner_x0 + 88.0, toolbar_bottom)
    {
        return Some(ShellHit::Action(ShellAction::OpenCreate));
    }
    if active_tab != tabs[0] && y < content_top + CONTROL + SPACE_SM {
        if x < panel_x + SPACE_LG + 140.0 {
            return Some(ShellHit::Action(ShellAction::BackToCards));
        }
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::OpenDelete));
        }
        return Some(ShellHit::Absorb);
    }
    if active_tab == tabs[0] {
        let mut cursor = toolbar_bottom + CONTROL + SPACE_MD;
        for id in ids {
            let bottom = cursor + CONTROL_LG + SPACE_SM;
            if y >= cursor && y < bottom {
                return Some(ShellHit::Action(select(id)));
            }
            cursor = bottom;
        }
    }
    Some(ShellHit::Absorb)
}
