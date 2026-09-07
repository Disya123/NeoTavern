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

/// Shared chats-panel geometry — the single source for both the renderer
/// below and the native hit-rect pass (`presentation_chat::shell_hit`).
/// Values mirror the packed React `ChatManagementPanel` styles; row heights
/// are pinned onto the rendered rows so hit rects and paint can never drift.
pub mod chats_layout {
    /// `.toolbar` vertical padding (packed: `padding:8px 16px`).
    pub const TOOLBAR_PAD_Y: f32 = 8.0;
    /// `.searchControl` min-height.
    pub const SEARCH_MIN_H: f32 = 44.0;
    /// `SidebarPanelHeader_headerDivider` thickness between toolbar and body.
    pub const HEADER_DIVIDER_H: f32 = 1.0;
    /// `.body` padding-top and flex gap between the action row and the list.
    pub const BODY_PAD_TOP: f32 = 8.0;
    pub const BODY_GAP: f32 = 8.0;
    /// `newChatAction` button: primary sm control, measured on the live
    /// Windows render (snapshot band [146,190) at 1100×760).
    pub const NEW_CHAT_H: f32 = 44.0;
    /// Measured three-line row (title + meta + character label) from the
    /// live Windows render.
    pub const ROW_H_LABELED: f32 = 76.0;
    /// One meta line (11px text) inside the measured row pitch.
    pub const META_LINE_H: f32 = 17.0;
    /// Two-line row: the measured pitch minus the character-label line.
    pub const ROW_H: f32 = ROW_H_LABELED - META_LINE_H;

    /// Row box height for one chat row; the renderer pins this onto the
    /// `<li>` so the hit pass can use the exact same number.
    pub fn row_height(character_label_empty: bool) -> f32 {
        if character_label_empty {
            ROW_H
        } else {
            ROW_H_LABELED
        }
    }
}

pub fn chats_panel(view: &ProductShellView) -> Element {
    let new_chat_h = chats_layout::NEW_CHAT_H;
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
                    style: "min-height:{new_chat_h}px;",
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
                    {chat_item(index, item, view.selected_chat_id.as_deref())}
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

fn chat_item(index: usize, item: &ChatCardView, selected_id: Option<&str>) -> Element {
    let row_h = chats_layout::row_height(item.character_label.is_empty());
    rsx! {
        li {
            "data-chat-index": "{index}",
            // Pinned row box: the hit pass derives the same height from
            // `chats_layout`, so they stay in sync regardless of text flow.
            style: "height:{row_h}px;box-sizing:border-box;",
            {chat_row(item, selected_id)}
        }
    }
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
