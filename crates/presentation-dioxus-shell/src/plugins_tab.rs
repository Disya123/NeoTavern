//! Plugins rail panel: native catalog over `plugins.list`.
//!
//! Frontend slots and `window.SillyTavern` stay CONTAINED in WebSurface
//! ([ADR-0054](../../../docs/adr/0054-plugin-visual-surface-contained.md)).
//! This RSX must not execute plugin HTML/JS.

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{
    icon, icon_fill, management_shell, ProductShellView, PLUGINS_MANAGER_TITLE,
};

pub fn plugins_panel(view: &ProductShellView) -> Element {
    let loaded = view.plugins.len();
    let empty = view.plugins.is_empty();
    let body = rsx! {
        div {
            class: "PluginsPage_root",
            "data-part": "plugin-catalog",
            "data-contained": "websurface",
            p {
                class: "PluginsPage_subtitle",
                style: "padding:8px 16px;color:#c5bbb2;",
                "Install versioned plugin packages, review every requested capability, and control their lifecycle without a terminal."
            }
            div {
                class: "PluginsPage_containedNote",
                style: "margin:8px 16px;padding:12px;border:1px solid #39342f;border-radius:10px;background:#302c28;",
                {icon("ShieldCheck", 18)}
                strong { "Frontend slots are contained" }
                p { "Plugin DOM islands and legacy window.SillyTavern run only in a sandboxed WebSurface. This catalog lists Product Wire plugins.* rows; it is not a Plugin SDK rewrite." }
            }
            div {
                class: "st-action-bar",
                style: "padding:8px 16px;",
                button {
                    class: "st-button",
                    r#type: "button",
                    disabled: true,
                    span { "data-part": "icon", "aria-hidden": "true", {icon_fill("UploadSimple", 18, "#998f87")} }
                    span { "data-part": "label", "Install plugin package" }
                }
            }
            div { class: "PluginsPage_listMeta", style: "padding:0 16px;", span { "{loaded} loaded" } }
            if empty {
                div {
                    class: "PluginsPage_emptyState",
                    style: "padding:24px 16px;display:flex;flex-direction:column;gap:8px;align-items:center;text-align:center;",
                    {icon("Cube", 32)}
                    strong { "No plugins installed" }
                    p { "Choose a .stplugin or ZIP package. Native binaries and unsafe archives are rejected." }
                }
            } else {
                div {
                    class: "PluginsPage_list",
                    style: "padding:8px 16px;display:flex;flex-direction:column;gap:16px;",
                    for item in view.plugins.iter() {
                        {
                            // React `PluginsPage.tsx` sets `data-state` = plugin
                            // status and brightens the enabled card border:
                            // `.PluginsPage_card[data-state='active'] { border-color:
                            // #63c98d }` — inlined because Blitz drops attribute
                            // selectors. `st-card` is the shared card primitive
                            // React applies via cx('st-card', styles.card).
                            let status = if item.enabled { "active" } else { "error" };
                            let status_label = if item.enabled { "Active" } else { "Disabled" };
                            let card_style = if item.enabled {
                                "border-color:#63c98d;"
                            } else {
                                ""
                            };
                            rsx! {
                                div {
                                    class: "st-card PluginsPage_card",
                                    "data-component": "plugin-card",
                                    "data-plugin-id": "{item.id}",
                                    "data-enabled": "{item.enabled}",
                                    "data-state": "{status}",
                                    style: "{card_style}",
                                    div {
                                        class: "PluginsPage_cardHeader",
                                        span {
                                            class: "PluginsPage_pluginIcon",
                                            {icon("Cube", 24)}
                                        }
                                        div {
                                            class: "PluginsPage_identity",
                                            div {
                                                strong { "{item.name}" }
                                                p { "{item.id}" }
                                            }
                                            span { "v{item.version}" }
                                        }
                                        div {
                                            class: "PluginsPage_cardMeta",
                                            span {
                                                class: "PluginsPage_sourceBadge",
                                                "data-source": "zip",
                                                {icon_fill("Package", 14, "#998f87")}
                                            }
                                            span { class: "PluginsPage_status", "{status_label}" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };
    management_shell(
        view,
        "plugins-panel",
        "plugins-header",
        PLUGINS_MANAGER_TITLE,
        "Cube",
        None,
        &[],
        "",
        body,
    )
}
