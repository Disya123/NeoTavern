//! Backgrounds rail panel. Mirrors `apps/web/src/components/BackgroundsPanel.tsx`.
//!
//! Kernel plane has no wallpaper catalog (React `useBackgrounds` returns an
//! honest empty list). This surface states that emptiness; it does not call a
//! non-existent Product Wire op.

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{
    icon, icon_fill, management_shell, ProductShellView, BACKGROUNDS_MANAGER_TITLE,
};

pub fn backgrounds_panel(view: &ProductShellView) -> Element {
    let body = rsx! {
        div {
            class: "BackgroundsPanel_body",
            "data-part": "background-gallery",
            p {
                class: "BackgroundsPanel_hint",
                style: "padding:8px 16px;color:#c5bbb2;",
                "PNG, JPEG, WebP or GIF. Originals stay on this device."
            }
            div {
                class: "BackgroundsPanel_emptyState",
                style: "padding:24px 16px;display:flex;flex-direction:column;gap:8px;align-items:center;text-align:center;",
                {icon("ImageSquare", 34)}
                strong { "No backgrounds yet" }
                p { "The Kernel has no wallpaper catalog. Upload stays on the legacy sidecar; this surface stays empty instead of inventing a Wire op." }
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "default",
                    disabled: true,
                    span { "data-part": "icon", "aria-hidden": "true", {icon_fill("UploadSimple", 18, "#998f87")} }
                    span { "data-part": "label", "Upload background" }
                }
            }
        }
    };
    management_shell(
        view,
        "backgrounds-panel",
        "backgrounds-header",
        BACKGROUNDS_MANAGER_TITLE,
        "ImageSquare",
        None,
        &[],
        "",
        body,
    )
}
