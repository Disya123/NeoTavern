//! Density-aware hit testing for the Rust App Shell / Character Manager.
//!
//! Regions follow packed React CSS tokens (`--st-shell-rail-width` 60,
//! `--st-shell-panel-width` 380, `--st-control-height*` / `--st-space-*`).
//! This is not a Blitz layout query: the compositor host does not yet expose
//! a DOM hit tree, so geometry is reconstructed from the same tokens the
//! RSX uses.

use neotavern_presentation_dioxus_shell::ProductShellView;

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
    /// Settings Data tab backup actions (`backups.create` / `backups.list`
    /// refresh / `backups.restore`; React DataTab).
    CreateBackup,
    RefreshBackups,
    RestoreBackup(String),
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

fn dialog_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    let (width, height) = css_size(view);
    let chat_x0 = chat_origin_x(view);
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
    if view.prompt_plan_open {
        let dlg_w = 640.0_f32.min(width - 32.0);
        let dlg_h = 560.0_f32.min(height - 48.0);
        let x0 = chat_x0 + (width - chat_x0 - dlg_w).max(0.0) * 0.5;
        let y0 = (height - dlg_h) * 0.5;
        if !contains(x, y, x0, y0, x0 + dlg_w, y0 + dlg_h) {
            return Some(ShellHit::Action(ShellAction::ClosePromptPlan));
        }
        let close_y = y0 + 16.0;
        if contains(x, y, x0 + dlg_w - 44.0, close_y, x0 + dlg_w - 4.0, close_y + 40.0) {
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
        "edit" | "advanced" | "gallery" => editor_hit(view, panel_x, x1, content_top, x, y),
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
        if x >= right - CONTROL_SM * 3.0 {
            return Some(ShellHit::Absorb);
        }
        if x >= right - CONTROL_SM * 4.0 {
            return Some(ShellHit::Action(ShellAction::ToggleFavorite));
        }
        return Some(ShellHit::Absorb);
    }
    let _ = view;
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
                let (ids, select): (
                    Box<dyn Iterator<Item = &str>>,
                    fn(&str) -> ShellAction,
                ) = if view.ai_tab == "presets" {
                    (
                        Box::new(view.presets.iter().map(|item| item.id.as_str())),
                        |id: &str| ShellAction::SelectPreset(id.into()),
                    )
                } else {
                    (
                        Box::new(view.providers.iter().map(|item| item.id.as_str())),
                        |id: &str| ShellAction::SelectProvider(id.into()),
                    )
                };
                return catalog_panel_hit(
                    view,
                    x,
                    y,
                    &["providers", "presets"],
                    view.ai_tab.as_str(),
                    52.0,
                    ids,
                    select,
                );
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
    None
}

/// Hit-test a managed catalog panel: optional tab row (AI providers/presets,
/// Settings general/host) plus a vertical selectable card list under it.
fn catalog_panel_hit<'a, I, F>(
    view: &ProductShellView,
    x: f32,
    y: f32,
    tabs: &[&str],
    _active_tab: &str,
    rows_top_relative: f32,
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
    let header_end = header_bottom(view);
    if y < header_end {
        if x >= x1 - CONTROL_SM - SPACE_LG {
            return Some(ShellHit::Action(ShellAction::ClosePanel));
        }
        return Some(ShellHit::Absorb);
    }
    if !tabs.is_empty() {
        let tabs_top = header_end + SPACE_XS;
        let tabs_bottom = tabs_top + CONTROL_SM + SPACE_XS;
        let tabs_x0 = panel_x + SPACE_LG;
        let tabs_x1 = x1 - SPACE_LG;
        if y >= tabs_top && y < tabs_bottom && x >= tabs_x0 && x < tabs_x1 {
            let span = (tabs_x1 - tabs_x0).max(1.0);
            let idx = (((x - tabs_x0) / span) * tabs.len() as f32).floor() as usize;
            return Some(ShellHit::Action(ShellAction::SetTab(
                tabs[idx.min(tabs.len() - 1)].into(),
            )));
        }
    }
    // Selectable card list below the tab row / chrome.
    let mut cursor = header_end + rows_top_relative;
    for id in ids {
        let bottom = cursor + CONTROL_LG + SPACE_MD;
        if y >= cursor && y < bottom {
            return Some(ShellHit::Action(select(id)));
        }
        cursor = bottom;
    }
    Some(ShellHit::Absorb)
}

fn personas_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
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

fn lorebooks_hit(view: &ProductShellView, x: f32, y: f32) -> Option<ShellHit> {
    if view.lorebook_tab == "entries" && view.selected_lorebook_id.is_some() {
        return lorebook_entries_hit(view, x, y);
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
/// Secrets / Tools), then tab-specific body regions. Only the Profiles tab
/// is interactive here (create/rename/delete/export); the other tabs are
/// read-only surfaces (absorb).
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
    Some(ShellHit::Absorb)
}

/// React `SettingsPanel` DataTab body: the Create/Refresh action row, then
/// backup rows carrying Restore in the right zone. Geometry mirrors
/// `settings_tab.rs::data_tab` (padding 12 + title 20 + gap 8 + hint 32 +
/// gap 8 + actions 36 + gap 8; rows 64 + 4).
fn data_hit(
    view: &ProductShellView,
    x: f32,
    y: f32,
    panel_x: f32,
    x1: f32,
    tabs_bottom: f32,
) -> Option<ShellHit> {
    let pad = SPACE_LG;
    let actions_top = tabs_bottom + 12.0 + 20.0 + 8.0 + 32.0 + 8.0;
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
    let mut cursor = actions_top + 36.0 + 8.0;
    for item in view.backups.iter() {
        let bottom = cursor + 64.0 + 4.0;
        if y >= cursor && y < bottom - 4.0 && x >= x1 - pad - 96.0 && x < x1 - pad {
            return Some(ShellHit::Action(ShellAction::RestoreBackup(item.id.clone())));
        }
        cursor = bottom;
    }
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
    let rows = 5.0 + if status.format_version.is_some() { 1.0 } else { 0.0 };
    let button_top =
        tabs_bottom + 12.0 + 20.0 + 8.0 + 32.0 + 8.0 + 64.0 + 8.0 + rows * 20.0 + 8.0;
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
    let import_bottom = import_top + 104.0;
    if y >= import_top && y < import_bottom {
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
            // Row actions in the right 88 px (rename / delete) — same
            // compact equivalent as the entries/profile rows; the rest of
            // the row opens the chat.
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
