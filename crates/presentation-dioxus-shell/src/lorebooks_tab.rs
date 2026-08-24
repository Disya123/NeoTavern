//! Lorebooks rail panel. Mirrors `apps/web/src/components/LorebookPanel.tsx`.

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{
    icon, icon_fill, lorebook_card_description, management_shell, overlay_dialog, PanelTab,
    ProductShellView, LOREBOOK_MANAGER_TITLE,
};

pub fn lorebooks_panel(view: &ProductShellView) -> Element {
    let selected = view
        .lorebooks
        .iter()
        .find(|item| Some(item.id.as_str()) == view.selected_lorebook_id.as_deref());
    let letter = selected.map(|item| {
        item.name
            .chars()
            .next()
            .map(|ch| ch.to_uppercase().to_string())
            .unwrap_or_default()
    });
    let tabs = [
        PanelTab {
            id: "books",
            label: "Books",
            disabled: false,
        },
        PanelTab {
            id: "book",
            label: "Book",
            disabled: view.selected_lorebook_id.is_none(),
        },
        PanelTab {
            id: "entries",
            label: "Entries",
            disabled: view.selected_lorebook_id.is_none(),
        },
    ];
    let body = match view.lorebook_tab.as_str() {
        "book" if selected.is_some() => lorebook_edit_tab(view),
        "entries" if selected.is_some() => lorebook_entries_tab(view),
        _ => lorebook_books_tab(view),
    };
    let chrome = management_shell(
        view,
        "lorebook-panel",
        "lorebooks-header",
        LOREBOOK_MANAGER_TITLE,
        "BookOpenText",
        letter.as_deref().filter(|s| !s.is_empty()),
        &tabs,
        &view.lorebook_tab,
        body,
    );
    rsx! {
        div {
            style: "display:flex;flex-direction:column;height:100%;min-height:0;",
            {chrome}
            if view.lorebook_create_open {
                {create_dialog(view)}
            }
            if view.lorebook_delete_open {
                {delete_dialog(view)}
            }
        }
    }
}

fn create_dialog(view: &ProductShellView) -> Element {
    let actions = rsx! {
        label {
            class: "LorebookPanel_editorField",
            span { "Book name" }
            input { value: "{view.lorebook_create_name}", placeholder: "New lorebook" }
        }
        div {
            class: "LorebookPanel_dialogActions",
            button { class: "st-button", r#type: "button", span { "data-part": "label", "Cancel" } }
            button {
                class: "st-button",
                r#type: "button",
                "data-variant": "primary",
                span { "data-part": "label", "Create" }
            }
        }
    };
    overlay_dialog(
        "New lorebook",
        "Name the book, then add keyword-activated entries.",
        actions,
    )
}

fn delete_dialog(view: &ProductShellView) -> Element {
    let name = view
        .lorebooks
        .iter()
        .find(|item| Some(item.id.as_str()) == view.selected_lorebook_id.as_deref())
        .map(|item| item.name.as_str())
        .unwrap_or("");
    let description = format!("Delete \"{name}\"? All its entries will be removed.");
    let actions = rsx! {
        div {
            class: "LorebookPanel_dialogActions",
            button { class: "st-button", r#type: "button", span { "data-part": "label", "Cancel" } }
            button {
                class: "st-button",
                r#type: "button",
                "data-variant": "danger",
                span { "data-part": "label", "Delete" }
            }
        }
    };
    overlay_dialog("Delete lorebook", &description, actions)
}

fn lorebook_books_tab(view: &ProductShellView) -> Element {
    let loaded = view.lorebooks.len();
    let query = view.lorebook_search.trim().to_lowercase();
    let items: Vec<_> = view
        .lorebooks
        .iter()
        .filter(|item| query.is_empty() || item.name.to_lowercase().contains(&query))
        .collect();
    let empty = items.is_empty();
    let searching = !query.is_empty();
    rsx! {
        div {
            class: "LorebookPanel_booksTab",
            "data-part": "lorebook-books",
            div {
                class: "st-action-bar LorebookPanel_cardToolbar",
                "data-part": "lorebook-toolbar",
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-variant": "primary",
                    span { "data-part": "icon", "aria-hidden": "true", {icon_fill("Plus", 18, "#2a130b")} }
                    span { "data-part": "label", "New" }
                }
            }
            label {
                class: "LorebookPanel_searchControl",
                {icon_fill("MagnifyingGlass", 17, "#998f87")}
                span { class: "LorebookPanel_srOnly", "Search books…" }
                input {
                    r#type: "search",
                    placeholder: "Search books…",
                    value: "{view.lorebook_search}",
                }
            }
            div { class: "LorebookPanel_listMeta", span { "{loaded} loaded" } }
            if empty {
                div {
                    class: "LorebookPanel_emptyState",
                    {icon("BookOpenText", 32)}
                    strong {
                        if searching { "No matching books" } else { "No lorebooks yet" }
                    }
                    p {
                        if searching {
                            "Try a different search term."
                        } else {
                            "Create a lorebook to fill your world with places, factions and rules that activate on keywords."
                        }
                    }
                }
            } else {
                div {
                    class: "LorebookPanel_bookList",
                    for item in items.into_iter() {
                        {
                            let selected = view.selected_lorebook_id.as_deref() == Some(item.id.as_str());
                            let desc = lorebook_card_description(&item.description).to_string();
                            let scope = if item.character_id.is_some() {
                                "For a character"
                            } else {
                                "Global"
                            };
                            let card_style = if selected {
                                "border-color:#e38a62;background:#492a20;"
                            } else {
                                ""
                            };
                            rsx! {
                                button {
                                    class: "LorebookPanel_bookCard",
                                    r#type: "button",
                                    style: "{card_style}",
                                    "data-part": "lorebook-card",
                                    "data-state": if selected { "selected" } else { "idle" },
                                    span {
                                        class: "LorebookPanel_cardCopy",
                                        strong { "{item.name}" }
                                        span { "{desc}" }
                                        span { class: "LorebookPanel_badges", span { "{scope}" } span { "{item.entry_count} entries" } }
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

fn lorebook_edit_tab(view: &ProductShellView) -> Element {
    rsx! {
        div {
            class: "LorebookPanel_bookTab",
            "data-part": "lorebook-editor",
            div {
                class: "LorebookPanel_editorActionBar",
                button { class: "st-button", r#type: "button", span { "data-part": "label", "Back to books" } }
                button { class: "st-button", r#type: "button", {icon("Trash", 16)} span { "data-part": "label", "Delete" } }
            }
            label {
                class: "LorebookPanel_editorField",
                span { "Book name" }
                input { value: "{view.lorebook_name_draft}" }
            }
            label {
                class: "LorebookPanel_editorField",
                span { "Book description" }
                textarea {
                    placeholder: "Describe what this book covers…",
                    value: "{view.lorebook_description_draft}",
                }
            }
        }
    }
}

fn lorebook_entries_tab(view: &ProductShellView) -> Element {
    let book = view
        .lorebooks
        .iter()
        .find(|item| Some(item.id.as_str()) == view.selected_lorebook_id.as_deref());
    let Some(book) = book else {
        return rsx! {
            div {
                class: "LorebookPanel_entriesTab",
                "data-part": "lorebook-entries",
                div {
                    class: "LorebookPanel_emptyState",
                    {icon("PencilSimple", 32)}
                    strong { "No entries yet" }
                    p { "Add entries that activate on names, places, objects or any keywords." }
                }
            }
        };
    };
    let _ = book;
    let entries: Vec<&crate::product_shell::LorebookEntryCardView> =
        view.lorebook_entries.iter().collect();
    let empty = entries.is_empty();
    let hint = if empty {
        "Add entries that activate on names, places, objects or any keywords."
    } else {
        "Entries activate on their keys; constant entries always inject."
    };
    rsx! {
        div {
            class: "LorebookPanel_entriesTab",
            "data-part": "lorebook-entries",
            div {
                class: "LorebookPanel_editorActionBar",
                style: "display:flex;flex:none;flex-direction:row;align-items:center;justify-content:space-between;gap:8px;padding:8px 16px;",
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-size": "sm",
                    span { "data-part": "label", "Back to books" }
                }
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "primary",
                    "data-size": "sm",
                    span { "data-part": "icon", "aria-hidden": "true", {icon_fill("Plus", 18, "#2a130b")} }
                    span { "data-part": "label", "Add entry" }
                }
            }
            p {
                class: "LorebookPanel_hint",
                style: "flex:none;margin:0;padding:0 16px 8px;color:#998f87;font-size:0.75rem;",
                "{hint}"
            }
            if empty {
                div {
                    class: "LorebookPanel_emptyState",
                    style: "display:flex;flex-direction:column;gap:8px;align-items:center;text-align:center;padding:24px 16px;",
                    {icon("PencilSimple", 32)}
                    strong { "No entries yet" }
                    p { "Add entries that activate on names, places, objects or any keywords." }
                }
            } else {
                div {
                    class: "LorebookPanel_entryList",
                    style: "display:flex;flex-direction:column;gap:4px;padding:0 16px 16px;overflow:hidden;",
                    for item in entries.into_iter() {
                        {
                            let headline = item
                                .keys
                                .first()
                                .cloned()
                                .unwrap_or_else(|| {
                                    if item.constant {
                                        "Constant".into()
                                    } else {
                                        "No description".into()
                                    }
                                });
                            let snippet = item.content.trim();
                            let snippet = if snippet.is_empty() {
                                "No description".to_string()
                            } else {
                                let chars: Vec<char> = snippet.chars().take(120).collect();
                                chars.into_iter().collect()
                            };
                            let row_style = if item.enabled {
                                "display:flex;min-width:0;padding:8px;align-items:center;justify-content:space-between;gap:8px;border:1px solid #39342f;border-radius:16px;background:#24211e;"
                            } else {
                                "display:flex;min-width:0;padding:8px;align-items:center;justify-content:space-between;gap:8px;border:1px solid #39342f;border-radius:16px;background:#24211e;opacity:0.6;"
                            };
                            let track_style = if item.enabled {
                                "width:36px;height:20px;border-radius:10px;background:#e38a62;position:relative;flex:none;"
                            } else {
                                "width:36px;height:20px;border-radius:10px;background:#39342f;position:relative;flex:none;"
                            };
                            let thumb_style = if item.enabled {
                                "position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:8px;background:#2a130b;"
                            } else {
                                "position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:8px;background:#998f87;"
                            };
                            rsx! {
                                div {
                                    class: "LorebookPanel_entryRow",
                                    style: "{row_style}",
                                    "data-part": "entry-row",
                                    "data-state": if item.enabled { "enabled" } else { "disabled" },
                                    div {
                                        class: "LorebookPanel_entryMain",
                                        style: "display:flex;min-width:0;flex-direction:column;gap:4px;",
                                        strong { style: "color:#f3eee8;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", "{headline}" }
                                        span { style: "color:#998f87;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", "{snippet}" }
                                        if item.constant || item.selective {
                                            span {
                                                class: "LorebookPanel_badges",
                                                if item.constant {
                                                    span { class: "LorebookPanel_badge", "Constant" }
                                                }
                                                if item.selective {
                                                    span { class: "LorebookPanel_badge", "Selective" }
                                                }
                                            }
                                        }
                                    }
                                    div {
                                        class: "LorebookPanel_entryActions",
                                        style: "display:flex;flex:none;align-items:center;gap:4px;",
                                        button {
                                            r#type: "button",
                                            "data-part": "entry-toggle",
                                            "data-state": if item.enabled { "on" } else { "off" },
                                            "aria-label": "Toggle entry",
                                            title: "Toggle entry",
                                            style: "padding:0;border:0;background:transparent;cursor:pointer;",
                                            span { style: "{track_style}", span { style: "{thumb_style}" } }
                                        }
                                        button {
                                            class: "LorebookPanel_iconButton",
                                            r#type: "button",
                                            "data-part": "entry-edit",
                                            "aria-label": "Edit entry",
                                            title: "Edit entry",
                                            style: "display:grid;width:40px;height:40px;place-items:center;border:1px solid transparent;border-radius:10px;color:#998f87;background:transparent;",
                                            {icon_fill("PencilSimple", 15, "#998f87")}
                                        }
                                        button {
                                            class: "LorebookPanel_iconButtonDanger",
                                            r#type: "button",
                                            "data-part": "entry-delete",
                                            "aria-label": "Delete entry",
                                            title: "Delete entry",
                                            style: "display:grid;width:40px;height:40px;place-items:center;border:1px solid transparent;border-radius:10px;color:#998f87;background:transparent;",
                                            {icon_fill("Trash", 15, "#998f87")}
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
