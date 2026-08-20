//! Personas rail panel. Mirrors `apps/web/src/components/PersonasPanel.tsx`.

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{
    icon, icon_fill, management_shell, overlay_dialog, persona_card_description, PanelTab,
    ProductShellView, PERSONA_MANAGER_TITLE,
};

pub fn personas_panel(view: &ProductShellView) -> Element {
    let selected = view
        .personas
        .iter()
        .find(|item| Some(item.id.as_str()) == view.selected_persona_id.as_deref());
    let letter = selected.map(|item| {
        item.name
            .chars()
            .next()
            .map(|ch| ch.to_uppercase().to_string())
            .unwrap_or_default()
    });
    let tabs = [
        PanelTab {
            id: "cards",
            label: "Cards",
            disabled: false,
        },
        PanelTab {
            id: "edit",
            label: "Edit",
            disabled: view.selected_persona_id.is_none(),
        },
    ];
    let body = match view.persona_tab.as_str() {
        "edit" if selected.is_some() => persona_edit_tab(view),
        _ => persona_cards_tab(view),
    };
    let chrome = management_shell(
        view,
        "personas-panel",
        "personas-header",
        PERSONA_MANAGER_TITLE,
        "Smiley",
        letter.as_deref().filter(|s| !s.is_empty()),
        &tabs,
        &view.persona_tab,
        body,
    );
    rsx! {
        div {
            style: "display:flex;flex-direction:column;height:100%;min-height:0;",
            {chrome}
            if view.persona_create_open {
                {create_dialog(view)}
            }
            if view.persona_delete_open {
                {delete_dialog(view)}
            }
        }
    }
}

fn create_dialog(view: &ProductShellView) -> Element {
    let actions = rsx! {
        label {
            class: "PersonasPanel_editorField",
            span { "Persona name" }
            input { value: "{view.persona_create_name}", placeholder: "New persona" }
        }
        div {
            class: "PersonasPanel_dialogActions",
            button {
                class: "st-button",
                r#type: "button",
                "data-component": "button",
                span { "data-part": "label", "Cancel" }
            }
            button {
                class: "st-button",
                r#type: "button",
                "data-component": "button",
                "data-variant": "primary",
                span { "data-part": "label", "Create" }
            }
        }
    };
    overlay_dialog(
        "New persona",
        "Choose a display name. You can add a description afterwards.",
        actions,
    )
}

fn delete_dialog(view: &ProductShellView) -> Element {
    let name = view
        .personas
        .iter()
        .find(|item| Some(item.id.as_str()) == view.selected_persona_id.as_deref())
        .map(|item| item.name.as_str())
        .unwrap_or("");
    let description = format!(
        "Delete \"{name}\"? Chats keep their stored messages, but this persona will be removed."
    );
    let actions = rsx! {
        div {
            class: "PersonasPanel_dialogActions",
            button {
                class: "st-button",
                r#type: "button",
                "data-component": "button",
                span { "data-part": "label", "Cancel" }
            }
            button {
                class: "st-button",
                r#type: "button",
                "data-component": "button",
                "data-variant": "danger",
                span { "data-part": "label", "Delete" }
            }
        }
    };
    overlay_dialog("Delete persona", &description, actions)
}

fn persona_cards_tab(view: &ProductShellView) -> Element {
    let loaded = view.personas.len();
    let query = view.persona_search.trim().to_lowercase();
    let mut items: Vec<&crate::product_shell::PersonaCardView> = view
        .personas
        .iter()
        .filter(|item| query.is_empty() || item.name.to_lowercase().contains(&query))
        .collect();
    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if view.persona_sort == "desc" {
        items.reverse();
    }
    let empty = items.is_empty();
    let searching = !query.is_empty();
    rsx! {
        div {
            class: "PersonasPanel_cardsTab",
            "data-part": "persona-cards",
            div {
                class: "st-action-bar PersonasPanel_cardToolbar",
                "data-component": "action-bar",
                "data-part": "persona-card-toolbar",
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "primary",
                    "data-has-icon": "start",
                    span { "data-part": "icon", "aria-hidden": "true", {icon_fill("Plus", 18, "#2a130b")} }
                    span { "data-part": "label", "New" }
                }
                label {
                    class: "PersonasPanel_sortControl",
                    span { class: "PersonasPanel_srOnly", "Sort personas" }
                    span { if view.persona_sort == "desc" { "Z–A" } else { "A–Z" } }
                }
            }
            label {
                class: "PersonasPanel_searchControl",
                {icon_fill("MagnifyingGlass", 17, "#998f87")}
                span { class: "PersonasPanel_srOnly", "Search personas…" }
                if view.persona_search.trim().is_empty() {
                    span {
                        "data-part": "placeholder",
                        style: "color:#998f87;flex:1;min-width:0;",
                        "Search personas…"
                    }
                }
                input {
                    r#type: "search",
                    placeholder: "Search personas…",
                    value: "{view.persona_search}",
                }
            }
            div { class: "PersonasPanel_listMeta", span { "{loaded} loaded" } }
            if empty {
                div {
                    class: "PersonasPanel_emptyState",
                    {icon("Smiley", 32)}
                    strong {
                        if searching { "No matching personas" } else { "No personas yet" }
                    }
                    p {
                        if searching {
                            "Try a different search term."
                        } else {
                            "Create a persona to replace the generic {{{{user}}}} placeholder in chats."
                        }
                    }
                }
            } else {
                div {
                    class: "PersonasPanel_personaList",
                    for item in items.into_iter() {
                        {
                            let selected = view.selected_persona_id.as_deref() == Some(item.id.as_str());
                            let desc = persona_card_description(&item.description).to_string();
                            let letter = item
                                .name
                                .chars()
                                .next()
                                .map(|ch| ch.to_uppercase().to_string())
                                .unwrap_or_default();
                            let card_style = if selected {
                                "border-color:#e38a62;background:#492a20;"
                            } else {
                                ""
                            };
                            rsx! {
                                button {
                                    class: "PersonasPanel_personaCard",
                                    r#type: "button",
                                    style: "{card_style}",
                                    "data-part": "persona-card",
                                    "data-state": if selected { "selected" } else { "idle" },
                                    "aria-pressed": selected,
                                    span {
                                        class: "PersonasPanel_cardAvatar",
                                        "aria-hidden": "true",
                                        "{letter}"
                                    }
                                    span {
                                        class: "PersonasPanel_cardCopy",
                                        strong { "{item.name}" }
                                        span { "{desc}" }
                                        if item.is_active || item.is_default {
                                            span {
                                                class: "PersonasPanel_badges",
                                                if item.is_active {
                                                    span { class: "PersonasPanel_badge", "Active" }
                                                }
                                                if item.is_default {
                                                    span { class: "PersonasPanel_badge", "Default" }
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

fn persona_edit_tab(view: &ProductShellView) -> Element {
    let Some(persona) = view
        .personas
        .iter()
        .find(|item| Some(item.id.as_str()) == view.selected_persona_id.as_deref())
    else {
        return persona_cards_tab(view);
    };
    let tokens = view.persona_description_draft.chars().count() / 4;
    let token_label = format!("Tokens: {tokens}");
    rsx! {
        div {
            class: "PersonasPanel_editor",
            "data-part": "persona-editor",
            div {
                class: "PersonasPanel_editorActionBar",
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-size": "sm",
                    span { "data-part": "label", "Back to personas" }
                }
                div {
                    class: "PersonasPanel_primaryActions",
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-size": "sm",
                        {icon("Copy", 16)}
                        span { "data-part": "label", "Duplicate" }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-size": "sm",
                        {icon("Trash", 16)}
                        span { "data-part": "label", "Delete" }
                    }
                }
            }
            label {
                class: "PersonasPanel_editorField",
                span { "Persona name" }
                input { r#type: "text", value: "{view.persona_name_draft}" }
            }
            div {
                class: "PersonasPanel_editorField",
                div {
                    class: "PersonasPanel_fieldHeader",
                    span { "Persona description" }
                    span { class: "PersonasPanel_tokenCount", "{token_label}" }
                }
                textarea {
                    value: "{view.persona_description_draft}",
                    placeholder: "Example:\n[{{{{user}}}} is a 28-year-old traveler who maps forgotten routes.]",
                }
            }
            div {
                class: "PersonasPanel_editorField",
                span { class: "PersonasPanel_sectionLabel", "Connections" }
                div {
                    class: "PersonasPanel_connections",
                    role: "group",
                    button {
                        class: "PersonasPanel_connectionButton",
                        r#type: "button",
                        "data-state": if persona.is_default || persona.is_active { "active" } else { "inactive" },
                        {icon("Crown", 18)}
                        span { class: "PersonasPanel_connectionLabel", "Default" }
                    }
                    button {
                        class: "PersonasPanel_connectionButton",
                        r#type: "button",
                        "data-state": "inactive",
                        disabled: true,
                        title: "Per-character persona binding is not available yet.",
                        {icon("User", 18)}
                        span { class: "PersonasPanel_connectionLabel", "Character" }
                    }
                    button {
                        class: "PersonasPanel_connectionButton",
                        r#type: "button",
                        "data-state": "inactive",
                        {icon("ChatsCircle", 18)}
                        span { class: "PersonasPanel_connectionLabel", "Chat" }
                    }
                }
            }
        }
    }
}
