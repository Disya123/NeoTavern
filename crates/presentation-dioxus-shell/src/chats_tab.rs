//! Home / Chats rail panel: the real `chats.list` rows from Product Wire, not
//! a page. A row tap opens that chat in the workspace; the `newChatAction`
//! button creates one (`chats.create`); the search toolbar filters titles
//! client-side. Structure/classes mirror the React component (`toolbar` /
//! `searchControl` / `chatList` / `chatRow` / `chatLink` / `chatAvatar` /
//! `chatCopy`).

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{
    icon, icon_fill, management_shell, ChatCardView, ProductShellView, CHATS_MANAGER_TITLE,
};

pub fn chats_panel(view: &ProductShellView) -> Element {
    let body = rsx! {
        // React `.toolbar`: search control over a bottom border. Typing is
        // wired through the host keyboard focus (like the character search).
        div {
            class: "ChatManagementPanel_toolbar",
            "data-part": "chat-toolbar",
            style: "display:flex;padding:8px 16px;align-items:center;gap:8px;border-bottom:1px solid #39342f;",
            label {
                class: "ChatManagementPanel_searchControl",
                style: "display:flex;flex-direction:row;align-items:center;gap:4px;padding:0 8px;min-height:44px;flex:1;min-width:0;border:1px solid #39342f;border-radius:8px;color:#998f87;background:#1e1b18;",
                {icon_fill("MagnifyingGlass", 17, "#998f87")}
                span {
                    class: "ChatManagementPanel_srOnly",
                    style: "display:none;",
                    "Search chats and messages…"
                }
                if view.chat_search.trim().is_empty() {
                    span {
                        "data-part": "placeholder",
                        style: "color:#998f87;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;",
                        "Search chats and messages…"
                    }
                }
                input {
                    r#type: "search",
                    // Theme SDK hook for the native hit-rect snapshot
                    // (`presentation_chat::hit_rects`).
                    "data-component": "text-field",
                    "data-part": "chat-search",
                    placeholder: "Search chats and messages…",
                    value: "{view.chat_search}",
                    style: if view.chat_search.trim().is_empty() {
                        "flex:1;min-width:0;background:transparent;border:none;outline:none;color:transparent;font-size:14px;"
                    } else {
                        "flex:1;min-width:0;background:transparent;border:none;outline:none;color:#f3eee8;font-size:14px;"
                    }
                }
            }
        }
        div {
            class: "ChatManagementPanel_body",
            "data-part": "chat-body",
            style: "padding:8px 16px 16px;display:flex;flex-direction:column;gap:8px;",
            // React `newChatAction`: primary sm `Button` with a Plus start
            // icon (`chat:newChat`).
            div {
                class: "ChatManagementPanel_newChatAction",
                "data-part": "chat-actions",
                style: "display:flex;justify-content:flex-start;",
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "primary",
                    "data-size": "sm",
                    "data-has-icon": "start",
                    span { "data-part": "icon", "data-position": "start", "aria-hidden": "true", {icon_fill("Plus", 18, "#2a130b")} }
                    span { "data-part": "label", "New chat" }
                }
            }
            ul {
                class: "ChatManagementPanel_chatList",
                "data-part": "chat-list",
                style: "display:flex;margin:0;padding:0;flex-direction:column;gap:4px;list-style:none;",
                for (index, item) in view.chat_list.iter().enumerate() {
                    li { "data-chat-index": "{index}", {chat_row(item, view.selected_chat_id.as_deref())} }
                }
            }
            if view.chat_list.is_empty() {
                div {
                    class: "ChatManagementPanel_emptyState",
                    {icon("ChatsCircle", 32)}
                    strong { "No chats yet" }
                    p { "Open a character to start a conversation. The workspace stays on this screen." }
                }
            }
        }
    };
    management_shell(
        view,
        "chat-management",
        "chat-management-header",
        CHATS_MANAGER_TITLE,
        "ChatsCircle",
        None,
        &[],
        "",
        body,
    )
}

fn chat_row(item: &ChatCardView, selected_id: Option<&str>) -> Element {
    let state = if Some(item.id.as_str()) == selected_id {
        "active"
    } else {
        "idle"
    };
    rsx! {
        div {
            class: "ChatManagementPanel_chatRow",
            "data-component": "chat-item",
            "data-state": "{state}",
            style: "display:flex;align-items:center;gap:4px;",
            span {
                class: "ChatManagementPanel_chatLink",
                "data-chat-id": "{item.id}",
                style: "flex:1;min-width:0;display:flex;align-items:center;gap:8px;",
                span {
                    class: "ChatManagementPanel_chatAvatar",
                    "aria-hidden": "true",
                    style: "flex:none;",
                    {icon("ChatsCircle", 20)}
                }
                span {
                    class: "ChatManagementPanel_chatCopy",
                    style: "min-width:0;display:flex;flex-direction:column;gap:1px;",
                    strong { style: "color:#f3eee8;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", "{item.title}" }
                    span { style: "color:#998f87;font-size:0.6875rem;", "{item.message_count} messages" }
                    if !item.character_label.is_empty() {
                        span { class: "ChatManagementPanel_characterLabel", style: "color:#998f87;font-size:0.6875rem;", "{item.character_label}" }
                    }
                }
            }
            div {
                style: "flex:none;display:flex;align-items:center;gap:4px;",
                button {
                    class: "ChatManagementPanel_rowAction",
                    r#type: "button",
                    "data-part": "chat-rename",
                    "aria-label": "Rename chat",
                    title: "Rename chat",
                    style: "display:grid;width:44px;height:44px;place-items:center;border:1px solid transparent;border-radius:10px;color:#998f87;background:transparent;",
                    {icon_fill("PencilSimple", 15, "#998f87")}
                }
                button {
                    class: "ChatManagementPanel_rowAction",
                    r#type: "button",
                    // React `ChatManagementPanel` dropdown "Export"
                    // (`chats.export`); the desktop host writes the file.
                    "data-part": "chat-export",
                    "aria-label": "Export chat",
                    title: "Export chat",
                    style: "display:grid;width:44px;height:44px;place-items:center;border:1px solid transparent;border-radius:10px;color:#998f87;background:transparent;",
                    {icon_fill("DownloadSimple", 15, "#998f87")}
                }
                button {
                    class: "ChatManagementPanel_rowActionDanger",
                    r#type: "button",
                    "data-part": "chat-delete",
                    "aria-label": "Delete chat",
                    title: "Delete chat",
                    style: "display:grid;width:44px;height:44px;place-items:center;border:1px solid transparent;border-radius:10px;color:#998f87;background:transparent;",
                    {icon_fill("Trash", 15, "#998f87")}
                }
            }
        }
    }
}
