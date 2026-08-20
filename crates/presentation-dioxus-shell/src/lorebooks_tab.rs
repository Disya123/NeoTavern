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

fn lorebook_entries_tab(_view: &ProductShellView) -> Element {
    rsx! {
        div {
            class: "LorebookPanel_entriesTab",
            "data-part": "lorebook-entries",
            div {
                class: "LorebookPanel_emptyState",
                {icon("PencilSimple", 32)}
                strong { "No entries yet" }
                p { "Add entries that activate on names, places, objects or any keywords." }
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-variant": "primary",
                    span { "data-part": "label", "Add entry" }
                }
            }
        }
    }
}
