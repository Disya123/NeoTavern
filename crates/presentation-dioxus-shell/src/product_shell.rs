//! App Shell + Character Manager RSX using packed React CSS modules.
//!
//! Class names, tokens, Phosphor regular paths, and English copy come from the
//! React source (`apps/web/src/components/*` + `packages/i18n/src/resources/en.ts`).
//! This is not a Dioxus restyle. The view model is rebuilt from the session each
//! frame; event handlers call back into the session via JNI to mutate state and
//! mark the compositor dirty.

use std::cell::RefCell;

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginCardView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub trust_state: String,
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

/// Home/chats panel row (React `ChatManagementPanel_chatRow`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatCardView {
    pub id: String,
    pub title: String,
    pub message_count: i64,
    pub character_label: String,
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
                style: "display:flex;width:40px;height:40px;padding:0;align-items:center;justify-content:center;",
                "data-part": "item-control",
                "data-state": "{state}",
                "aria-label": "{item.label}",
                title: "{item.label}",
                "aria-expanded": selected,
                {icon_fill(item.icon, 21, fill)}
                span { class: "Sidebar_railLabel", "{item.label}" }
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

fn edit_tab(draft: &CharacterDraftView) -> Element {
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
            {editor_field("Name", &draft.name, None, false, false, true)}
            {editor_field("Creator's notes", &draft.creator_notes, None, true, false, false)}
            {editor_field("Description", &draft.description, None, true, true, false)}
            {editor_field("First message", &draft.first_message, None, true, true, false)}
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
                            rsx! {
                                div {
                                    class: "CharacterManagementPanel_greetingItem",
                                    key: "{idx}",
                                    "data-state": "closed",
                                    div {
                                        class: "CharacterManagementPanel_greetingHeader",
                                        button {
                                            class: "CharacterManagementPanel_greetingToggle",
                                            r#type: "button",
                                            "aria-expanded": false,
                                            {icon("CaretDown", 15)}
                                            span {
                                                strong { "{label}" }
                                                small { "{approx_tokens}" }
                                            }
                                        }
                                        button {
                                            class: "CharacterManagementPanel_compactIconButton",
                                            r#type: "button",
                                            "aria-label": "Remove greeting {idx + 1}",
                                            {icon("Trash", 15)}
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            section {
                class: "CharacterManagementPanel_tagEditor",
                strong { "Tags" }
                div {
                    class: "CharacterManagementPanel_tagInputRow",
                    input {
                        r#type: "text",
                        placeholder: "Type one tag",
                        "aria-label": "New tag",
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "default",
                        "data-size": "sm",
                        span { "data-part": "icon", "aria-hidden": "true", {icon("Plus", 15)} }
                        span { "data-part": "label", "Add tag" }
                    }
                }
                if draft.tags.is_empty() {
                    small { class: "CharacterManagementPanel_inlineEmpty", "No tags assigned." }
                } else {
                    div {
                        class: "CharacterManagementPanel_tagChips",
                        "aria-label": "Assigned tags",
                        for tag in draft.tags.iter() {
                            span {
                                key: "{tag}",
                                "{tag}"
                                button {
                                    r#type: "button",
                                    "aria-label": "Remove tag {tag}",
                                    {icon("X", 13)}
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn advanced_tab(draft: &CharacterDraftView) -> Element {
    let advanced_title = format!("{} — advanced definitions", draft.name);
    let talk_pct = (draft.talkativeness * 100.0).round() as i32;
    let talk_pct_label = format!("{talk_pct}%");
    rsx! {
        div {
            class: "CharacterManagementPanel_editor",
            "data-part": "character-advanced",
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
            details {
                class: "CharacterManagementPanel_advancedSection",
                open: "",
                summary { "Lorebooks" }
                div {
                    class: "CharacterManagementPanel_advancedSectionBody",
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
                    p { class: "CharacterManagementPanel_lorebookHint", "No books linked to this character yet." }
                }
            }
        }
    }
}

fn gallery_tab(_draft: &CharacterDraftView) -> Element {
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
                        span { class: "CharacterManagementPanel_srOnly", "Gallery columns" }
                        select {
                            option { value: "1", "1 column" }
                            option { value: "2", "2 columns" }
                            option { value: "3", "3 columns" }
                            option { value: "4", "4 columns" }
                        }
                    }
                    label {
                        class: "CharacterManagementPanel_sortControl",
                        span { class: "CharacterManagementPanel_srOnly", "Sort gallery images" }
                        select {
                            option { value: "oldest", "Oldest" }
                            option { value: "newest", "Newest" }
                        }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "default",
                        "data-size": "sm",
                        span { "data-part": "icon", "aria-hidden": "true", {icon("Plus", 18)} }
                        span { "data-part": "label", "Add image" }
                    }
                }
            }
            div {
                class: "CharacterManagementPanel_emptyState",
                {icon("Image", 34)}
                strong { "No gallery images" }
                p { "Add PNG, JPEG, WebP, or GIF images from this device." }
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "default",
                    "data-size": "md",
                    span { "data-part": "icon", "aria-hidden": "true", {icon("Plus", 18)} }
                    span { "data-part": "label", "Add image" }
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
    let (pad_top, pad_bottom) = chrome_insets(view);
    let header_min = 52.0_f32;
    let header_title = character_manager_title(view.chat.viewport_width);
    let root_style =
        "display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:rgba(36,33,30,0.72);";
    let header_style = format!(
        "flex:none;position:relative;z-index:0;display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;min-width:0;width:100%;overflow:hidden;padding:8px 16px 8px;min-height:{header_min}px;background:transparent;"
    );
    let body_style = format!(
        "flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;position:relative;padding-bottom:{pad_bottom}px;"
    );
    let tabs_style =
        "display:flex;flex-direction:row;flex:none;box-sizing:border-box;align-self:stretch;position:static;width:auto;max-width:100%;order:0;z-index:0;margin:8px 16px 8px;padding:4px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;";
    let tabs_wrap =
        "flex:none;align-self:stretch;box-sizing:border-box;width:100%;max-width:100%;overflow:visible;order:1;";
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
                    button {
                        class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "ghost",
                        "data-icon": "",
                        style: "min-width:40px;min-height:40px;width:40px;height:40px;padding:0;flex:none;background:transparent;",
                        disabled: !can_edit,
                        "aria-label": "View character card",
                        title: "View character card",
                        {icon("Eye", 19)}
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
                                        {edit_tab(draft)}
                                    } else {
                                        {cards_tab(view)}
                                    }
                                }
                                "advanced" => {
                                    if let Some(draft) = &view.selected_draft {
                                        {advanced_tab(draft)}
                                    } else {
                                        {cards_tab(view)}
                                    }
                                }
                                "gallery" => {
                                    if let Some(draft) = &view.selected_draft {
                                        {gallery_tab(draft)}
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
    let (pad_top, pad_bottom) = chrome_insets(view);
    let header_min = 52.0_f32;
    let header_title = panel_header_title(title, view.chat.viewport_width);
    let root_style =
        "display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:rgba(36,33,30,0.72);";
    let header_style = format!(
        "flex:none;position:relative;z-index:0;display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;min-width:0;width:100%;overflow:hidden;padding:8px 16px 8px;min-height:{header_min}px;background:transparent;"
    );
    let body_style = format!(
        "flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;position:relative;padding-bottom:{pad_bottom}px;"
    );
    let tabs_style =
        "display:flex;flex-direction:row;flex:none;box-sizing:border-box;align-self:stretch;position:static;width:auto;max-width:100%;order:0;z-index:0;margin:8px 16px 8px;padding:4px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;";
    let tabs_wrap =
        "flex:none;align-self:stretch;box-sizing:border-box;width:100%;max-width:100%;overflow:visible;order:1;";
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
    let rail_pad = format!("flex:none;width:60px;height:100%;z-index:2;box-sizing:border-box;padding-bottom:{pad_bottom}px;padding-left:calc(4px + {pad_start}px);padding-right:calc(4px + {pad_end}px);background:rgba(21,19,17,0.82);");
    let panel_pad = if is_compact {
        format!("display:flex;flex-direction:column;flex:1 1 calc(100% - 60px);min-width:calc(100% - 60px);width:calc(100% - 60px);max-width:calc(100% - 60px);height:100%;margin:0;padding-top:{pad_top}px;padding-bottom:0;box-sizing:border-box;overflow:hidden;background:rgba(36,33,30,0.88);position:relative;")
    } else {
        format!("display:flex;flex-direction:column;flex:0 0 {panel_w}px;min-width:260px;width:{panel_w}px;max-width:720px;height:100%;margin:0;padding-bottom:0;overflow:hidden;background:rgba(36,33,30,0.88);position:relative;")
    };
    let row_dir = if rtl { "row-reverse" } else { "row" };
    let sidebar_style = if is_compact {
        format!("display:flex;flex-direction:{row_dir};flex-wrap:nowrap;align-items:stretch;width:100%;height:100%;min-width:100%;position:absolute;inset:0;z-index:20;padding-top:{pad_top}px;box-sizing:border-box;")
    } else {
        format!("display:flex;flex-direction:{row_dir};flex-wrap:nowrap;align-items:stretch;height:100%;min-width:0;flex:none;position:relative;z-index:2;")
    };
    let shell_style = format!("display:flex;flex-direction:{row_dir};width:100%;height:100%;background:transparent;color:#f3eee8;position:relative;overflow:hidden;");
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
    let shell_css = if wallpaper_mode {
        format!("display:flex;flex-direction:{row_dir};width:100%;height:100%;background:transparent;color:#f3eee8;position:relative;overflow:hidden;")
    } else {
        shell_style
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
            "data-dir": "{view.dir}",
            "data-lang": "{view.language}",
            "data-sidebar": "{sidebar_state}",
            "data-ui-density": "{view.density}",
            "data-ui-scale": "{view.font_scale}",
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
                style: "position:absolute;left:0;top:0;right:0;bottom:-16px;z-index:0;pointer-events:none;background:rgba(18,16,14,0.30);",
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
                                        style: "display:flex;width:40px;height:40px;padding:0;align-items:center;justify-content:center;",
                                        "data-part": "item-control",
                                        "data-action": "menu-toggle",
                                        "data-state": "{rail_state}",
                                        "aria-label": "Close menu",
                                        title: "Close menu",
                                        "aria-expanded": view.rail_expanded,
                                        "aria-controls": "primary-navigation",
                                        {icon("SidebarSimple", 21)}
                                        span { class: "Sidebar_railLabel", "Close menu" }
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
