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
    phosphor_path, product_stylesheets, SafeAreaInsets,
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

/// React `SidebarPanelHeader` title. Packed CSS is `font-size: 1.25rem`.
pub const CHARACTER_MANAGER_TITLE: &str = "Character Management";

/// Blitz clips `overflow: hidden` and does not paint `text-overflow: ellipsis`.
/// Approximate Outfit advance at `font_size_px` so the visible string includes `…`.
pub fn ellipsize_css(text: &str, max_css_px: f32, font_size_px: f32) -> String {
    let advance = font_size_px.max(1.0) * 0.52;
    let max_chars = (max_css_px.max(0.0) / advance).floor() as usize;
    let n = text.chars().count();
    if max_chars == 0 {
        return String::new();
    }
    if n <= max_chars {
        return text.to_string();
    }
    let take = max_chars.saturating_sub(1).max(1);
    let mut out: String = text.chars().take(take).collect();
    out.push('…');
    out
}

/// Title that fits the Character Manager header on a CSS viewport.
/// Rail 60 + header padding 32 + avatar 44 + gaps + two 40px actions.
pub fn character_manager_title(viewport_css_width: u32) -> String {
    let css_w = viewport_css_width.max(1) as f32;
    let avail = css_w - 60.0 - 32.0 - 44.0 - 8.0 - 40.0 - 8.0 - 40.0;
    ellipsize_css(CHARACTER_MANAGER_TITLE, avail.max(48.0), 20.0)
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

fn icon(name: &'static str, size: u32) -> Element {
    icon_fill(name, size, "#998f87")
}

fn icon_fill(name: &'static str, size: u32, fill: &'static str) -> Element {
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

fn chrome_insets(view: &ProductShellView) -> (f32, f32) {
    let compact = view.chat.viewport_width <= 600;
    // React compact chrome: max(--st-space-2xl, --nt-inset-*).
    let top = if compact {
        view.insets.top.max(32.0)
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

fn tab_trigger_style(active: bool) -> &'static str {
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
        "width:52px;height:52px;max-width:52px;max-height:52px;flex:none;align-self:start;overflow:hidden;"
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
                {icon_fill("MagnifyingGlass", 17, "#998f87")}
                span {
                    class: "CharacterManagementPanel_srOnly",
                    style: "display:none;",
                    "Search characters…"
                }
                if view.search.trim().is_empty() {
                    span {
                        "data-part": "placeholder",
                        style: "color:#998f87;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                        "Search characters…"
                    }
                }
                input {
                    r#type: "search",
                    placeholder: "Search characters…",
                    value: "{view.search}",
                    style: if view.search.trim().is_empty() {
                        "flex:1;min-width:0;color:transparent;"
                    } else {
                        "flex:1;min-width:0;color:#f3eee8;"
                    }
                }
            }
            div {
                class: "CharacterManagementPanel_listMeta",
                div {
                    class: "CharacterManagementPanel_viewToggle",
                    "data-part": "view-toggle",
                    "aria-label": "Character view",
                    button {
                        class: "st-button st-icon-button CharacterManagementPanel_iconButton",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "ghost",
                        "data-icon": "",
                        "data-state": if list_active { "active" } else { "inactive" },
                        "aria-label": "List view",
                        "aria-pressed": list_active,
                        {icon("List", 17)}
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
                        {icon("SquaresFour", 17)}
                    }
                }
                span {
                    "data-part": "loaded-count",
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
                    for item in view.characters.iter() {
                        {
                            let selected = view.selected_character_id.as_deref() == Some(item.id.as_str());
                            let pinned = view.pinned_character_id.as_deref() == Some(item.id.as_str());
                            let desc = character_card_description(&item.description).to_string();
                            let card_style = if selected {
                                "height:auto;max-height:140px;align-self:flex-start;flex:none;border:1px solid #e38a62;background:#492a20;"
                            } else {
                                "height:auto;max-height:140px;align-self:flex-start;flex:none;"
                            };
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
                                            style: "display:block;overflow:hidden;max-height:2.9em;line-height:1.45;font-size:0.75rem;color:#c5bbb2;",
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
    let header_min = 52.0 + pad_top;
    let header_title = character_manager_title(view.chat.viewport_width);
    let root_style =
        "display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:#24211e;";
    let header_style = format!(
        "flex:none;position:relative;z-index:0;display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;min-width:0;width:100%;overflow:hidden;padding:{pad_top}px 16px 8px;min-height:{header_min}px;background:#24211e;"
    );
    let body_style =
        "flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;position:relative;";
    let tabs_style = format!(
        "display:flex;flex-direction:row;flex:none;box-sizing:border-box;align-self:stretch;position:relative;top:auto;bottom:auto;left:auto;right:auto;z-index:0;width:auto;max-width:100%;margin:8px 16px {pad_bottom}px;padding:4px;border:1px solid #39342f;border-radius:10px;background:#24211e;"
    );
    let tabs_wrap =
        "flex:none;align-self:stretch;box-sizing:border-box;width:100%;max-width:100%;overflow:visible;";
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
                            style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto;",
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
                    "data-component": "tabs-scroll-content",
                    "data-part": "scroll-content",
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
            div {
                style: "{tabs_wrap}",
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
            }
            if view.create_dialog_open {
                {create_character_dialog(view)}
            }
            if view.delete_dialog_open {
                {delete_character_dialog(view)}
            }
        }
    }
}

fn create_character_dialog(view: &ProductShellView) -> Element {
    rsx! {
        div {
            "data-component": "dialog-overlay",
            "data-state": "open",
            div {
                "data-component": "dialog-content",
                role: "dialog",
                "aria-modal": "true",
                "aria-labelledby": "create-character-title",
                h2 {
                    id: "create-character-title",
                    "data-component": "dialog-title",
                    "New character"
                }
                p {
                    "data-component": "dialog-description",
                    "Start with the essentials. You can expand the character later."
                }
                form {
                    class: "CharacterManagementPanel_createForm",
                    label {
                        class: "CharacterManagementPanel_editorField",
                        span { class: "CharacterManagementPanel_fieldHeading", strong { "Name" } }
                        input {
                            value: "{view.create_name}",
                            required: true,
                        }
                    }
                    label {
                        class: "CharacterManagementPanel_editorField",
                        span { class: "CharacterManagementPanel_fieldHeading", strong { "Description" } }
                        textarea {
                            class: "CharacterManagementPanel_textarea",
                            value: "{view.create_description}",
                        }
                    }
                    label {
                        class: "CharacterManagementPanel_editorField",
                        span { class: "CharacterManagementPanel_fieldHeading", strong { "First message" } }
                        textarea {
                            class: "CharacterManagementPanel_textarea",
                            value: "{view.create_first_message}",
                        }
                    }
                    div {
                        class: "CharacterManagementPanel_dialogActions",
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "default",
                            "data-size": "md",
                            span { "data-part": "label", "Cancel" }
                        }
                        button {
                            class: "st-button",
                            r#type: "submit",
                            "data-component": "button",
                            "data-variant": "primary",
                            "data-size": "md",
                            span { "data-part": "label", "Create" }
                        }
                    }
                }
            }
        }
    }
}

fn delete_character_dialog(view: &ProductShellView) -> Element {
    let name = view
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
    let confirm = format!("Delete \"{name}\"? It will move to trash.");
    rsx! {
        div {
            "data-component": "dialog-overlay",
            "data-state": "open",
            div {
                "data-component": "dialog-content",
                role: "dialog",
                "aria-modal": "true",
                "aria-labelledby": "delete-character-title",
                h2 {
                    id: "delete-character-title",
                    "data-component": "dialog-title",
                    "Delete character"
                }
                p { "data-component": "dialog-description", "{confirm}" }
                div {
                    class: "CharacterManagementPanel_dialogActions",
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "default",
                        "data-size": "md",
                        span { "data-part": "label", "Cancel" }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "danger",
                        "data-size": "md",
                        span { "data-part": "label", "Delete character" }
                    }
                }
            }
        }
    }
}

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

/// Product App Shell with Character Manager as the first golden route.
pub fn product_shell_app() -> Element {
    let view = current_product_shell();
    let rail_state = if view.rail_expanded {
        "expanded"
    } else {
        "collapsed"
    };
    let sidebar_state = if view.sidebar_open { "open" } else { "closed" };
    let main_class = if view.sidebar_open {
        "AppShell_mainShifted"
    } else {
        "AppShell_main"
    };
    let panel_title = RAIL
        .iter()
        .find(|item| item.panel == view.panel)
        .map(|item| item.label)
        .unwrap_or("Home");
    let (pad_top, pad_bottom) = chrome_insets(&view);
    let rail_pad = format!("flex:none;width:60px;height:100%;z-index:2;padding-top:{pad_top}px;padding-bottom:{pad_bottom}px;background:#151311;");
    let panel_pad = format!("display:flex;flex-direction:column;flex:1 1 auto;min-width:0;width:auto;max-width:none;height:100%;margin:0;padding-bottom:0;overflow:hidden;background:#24211e;");
    let sidebar_style = "display:flex;flex-direction:row;flex-wrap:nowrap;align-items:stretch;width:100%;height:100%;min-width:0;";
    let shell_style = "display:flex;flex-direction:row;width:100%;height:100%;background:#151311;color:#f3eee8;";
    let product_css = product_stylesheets(view.insets).join("\n");
    rsx! {
        style { "{product_css}" }
        div {
            class: "AppShell_shell",
            style: "{shell_style}",
            "data-component": "app-shell",
            "data-slot": "app.shell",
            "data-theme-mode": "dark",
            "data-sidebar": "{sidebar_state}",
            "data-ui-density": "{view.density}",
            "data-ui-scale": "{view.font_scale}",
            a { class: "AppShell_skipLink", href: "#chat-workspace", "Skip to chat" }
            aside {
                class: "Sidebar_sidebar",
                style: "{sidebar_style}",
                "data-component": "navigation-rail",
                "data-state": "{rail_state}",
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
                        div {
                            class: "Sidebar_railSeparator",
                            "data-part": "rail-separator",
                            "aria-hidden": "true",
                        }
                        for item in RAIL.iter() {
                            {rail_button(item, view.sidebar_open && view.panel == item.panel)}
                        }
                    }
                }
                if view.sidebar_open {
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
                        if view.panel == "characters" {
                            {character_manager(&view)}
                        } else {
                            {not_yet_migrated(panel_title)}
                        }
                    }
                }
            }
            main {
                id: "chat-workspace",
                class: "{main_class}",
                "data-component": "main-area",
                "data-slot": "chat.viewport",
                tabindex: "-1",
                {product_chat_app()}
            }
        }
    }
}
