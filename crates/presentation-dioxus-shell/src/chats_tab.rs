//! Home / Chats rail panel: the open chat from Product Wire, not a page.

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{icon, management_shell, ProductShellView, CHATS_MANAGER_TITLE};

pub fn chats_panel(view: &ProductShellView) -> Element {
    let title = if view.chat.title.is_empty() {
        "Live wire chat"
    } else {
        view.chat.title.as_str()
    };
    let count = view.chat.message_count;
    let body = rsx! {
        div {
            class: "ChatManagementPanel_list",
            "data-part": "chat-list",
            style: "padding:8px 16px;display:flex;flex-direction:column;gap:8px;",
            button {
                class: "ChatManagementPanel_chatCard",
                r#type: "button",
                "data-part": "chat-card",
                "data-state": "selected",
                span {
                    strong { "{title}" }
                    span { "{count} messages" }
                }
            }
            if view.chat.title.is_empty() && view.chat.message_count == 0 {
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
        "chats-panel",
        "chats-header",
        CHATS_MANAGER_TITLE,
        "ChatsCircle",
        None,
        &[],
        "",
        body,
    )
}
