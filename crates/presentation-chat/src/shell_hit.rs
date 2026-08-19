//! Density-aware hit testing for the Rust App Shell / Character Manager.
//!
//! Regions follow packed React CSS tokens (`--st-shell-rail-width` 60,
//! `--st-shell-panel-width` 380, `--st-control-height*` / `--st-space-*`).
//! This is not a Blitz layout query: the compositor host does not yet expose
//! a DOM hit tree, so geometry is reconstructed from the same tokens the
//! RSX uses.

use neotavern_presentation_dioxus_shell::ProductShellView;

const RAIL_WIDTH: f32 = 60.0;
const PANEL_WIDTH: f32 = 380.0;
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
    OpenCreate,
    CloseCreate,
    ConfirmCreate,
    OpenDelete,
    CloseDelete,
    ConfirmDelete,
    ToggleFavorite,
    BackToCards,
    Import,
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

fn panel_origin(view: &ProductShellView) -> (f32, f32) {
    let (width, _) = css_size(view);
    let panel_w = PANEL_WIDTH.min((width - RAIL_WIDTH).max(0.0));
    (RAIL_WIDTH, panel_w)
}

fn chrome_top(view: &ProductShellView) -> f32 {
    if css_size(view).0 <= 600.0 {
        view.insets.top.max(SPACE_2XL)
    } else {
        view.insets.top.max(SPACE_SM)
    }
}

fn chrome_bottom(view: &ProductShellView) -> f32 {
    if css_size(view).0 <= 600.0 {
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
    if view.create_dialog_open {
        let dlg_w = 320.0_f32.min(width - 32.0);
        let dlg_h = 360.0_f32.min(height - 48.0);
        let x0 = (width - dlg_w) * 0.5;
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
        let x0 = (width - dlg_w) * 0.5;
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
    if !view.rail_expanded && css_size(view).0 > 600.0 {
        return Some(ShellHit::Absorb);
    }
    let mut cursor = menu_bottom + SPACE_SM + SPACE_XS;
    for panel in RAIL_PANELS {
        let bottom = cursor + CONTROL_SM + SPACE_XS;
        if y >= cursor && y < bottom {
            return Some(ShellHit::Action(ShellAction::SetPanel((*panel).into())));
        }
        cursor = bottom;
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
    let (_, height) = css_size(view);
    let tab_margin = chrome_bottom(view);
    let tabs_bottom = height - tab_margin;
    let tabs_top = tabs_bottom - CONTROL;
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
    let content_top = header_end;
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
    if let Some(hit) = dialog_hit(view, css_x, css_y) {
        return Some(hit);
    }
    if let Some(hit) = rail_hit(view, css_x, css_y) {
        return Some(hit);
    }
    if view.sidebar_open && view.panel == "characters" {
        if let Some(hit) = character_manager_hit(view, css_x, css_y) {
            return Some(hit);
        }
    } else if view.sidebar_open {
        let (panel_x, panel_w) = panel_origin(view);
        if contains(
            css_x,
            css_y,
            panel_x,
            0.0,
            panel_x + panel_w,
            css_size(view).1,
        ) {
            let header_end = header_bottom(view);
            if css_y < header_end && css_x >= panel_x + panel_w - CONTROL_SM - SPACE_LG {
                return Some(ShellHit::Action(ShellAction::ClosePanel));
            }
            return Some(ShellHit::Absorb);
        }
    }
    None
}
