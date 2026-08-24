//! Plugins rail panel: native catalog over `plugins.list` with lifecycle
//! actions (`plugins.enable` / `plugins.disable` / `plugins.uninstall`).
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
    let safe_mode = view.chat.error_code.as_deref() == Some("SAFE_MODE");
    let body = rsx! {
        div {
            class: "PluginsPage_root",
            "data-part": "plugin-catalog",
            "data-contained": "websurface",
            p {
                class: "PluginsPage_subtitle",
                style: "box-sizing:border-box;height:28px;padding:4px 16px;line-height:20px;margin:0;color:#c5bbb2;font-size:0.75rem;",
                "Install versioned plugin packages, review every requested capability, and control their lifecycle without a terminal."
            }
            div {
                class: "PluginsPage_containedNote",
                style: "box-sizing:border-box;height:56px;margin:8px 16px;padding:10px 12px;line-height:18px;border:1px solid #39342f;border-radius:10px;background:#302c28;overflow:hidden;",
                strong { style: "font-size:0.75rem;", "Frontend slots are contained" }
                p { style: "margin:0;color:#c5bbb2;font-size:0.6875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", "Plugin DOM islands and legacy window.SillyTavern run only in a sandboxed WebSurface." }
            }
            div {
                class: "st-action-bar",
                style: "box-sizing:border-box;height:36px;margin:8px 16px 0;padding:0 16px;",
                button {
                    class: "st-button",
                    r#type: "button",
                    disabled: true,
                    span { "data-part": "icon", "aria-hidden": "true", {icon_fill("UploadSimple", 18, "#998f87")} }
                    span { "data-part": "label", "Install plugin package" }
                }
            }
            div { class: "PluginsPage_listMeta", style: "box-sizing:border-box;height:20px;line-height:20px;padding:0 16px;", span { "{loaded} loaded" } }
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
                            // Card geometry mirrors `shell_hit.rs::plugins_hit`
                            // (112 px card, bottom 36 px = the actions row).
                            let status = if item.enabled { "active" } else { "error" };
                            let status_label = if item.enabled { "Active" } else { "Disabled" };
                            let status_color = if item.enabled { "#63c98d" } else { "#998f87" };
                            let card_style = if item.enabled {
                                "border-color:#63c98d;"
                            } else {
                                ""
                            };
                            let (track_style, thumb_style) = if item.enabled {
                                ("width:36px;height:20px;border-radius:10px;background:#e38a62;position:relative;flex:none;", "position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:8px;background:#2a130b;")
                            } else {
                                ("width:36px;height:20px;border-radius:10px;background:#39342f;position:relative;flex:none;", "position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:8px;background:#998f87;")
                            };
                            let permissions = item.permissions.join(", ");
                            rsx! {
                                div {
                                    class: "st-card PluginsPage_card",
                                    "data-component": "plugin-card",
                                    "data-plugin-id": "{item.id}",
                                    "data-enabled": "{item.enabled}",
                                    "data-state": "{status}",
                                    style: "height:112px;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;padding:8px 12px;{card_style}",
                                    div {
                                        class: "PluginsPage_cardHeader",
                                        style: "height:40px;display:flex;align-items:center;gap:8px;min-width:0;",
                                        span {
                                            class: "PluginsPage_pluginIcon",
                                            style: "flex:none;",
                                            {icon("Cube", 24)}
                                        }
                                        div {
                                            class: "PluginsPage_identity",
                                            style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;",
                                            strong { style: "color:#f3eee8;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", "{item.name}" }
                                            p { style: "margin:0;color:#998f87;font-size:0.6875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", "{item.id}" }
                                        }
                                        span { style: "flex:none;color:#c5bbb2;font-size:0.6875rem;", "v{item.version}" }
                                        span { class: "PluginsPage_status", style: "flex:none;font-size:0.6875rem;color:{status_color};", "{status_label}" }
                                    }
                                    div {
                                        class: "PluginsPage_permissions",
                                        "data-part": "plugin-permissions",
                                        style: "height:24px;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#998f87;font-size:0.6875rem;",
                                        if permissions.is_empty() { "No permissions requested" } else { "Permissions: {permissions}" }
                                    }
                                    div {
                                        class: "PluginsPage_cardActions",
                                        style: "height:32px;display:flex;align-items:center;justify-content:flex-end;gap:4px;",
                                        button {
                                            r#type: "button",
                                            "data-part": "plugin-toggle",
                                            "data-state": if item.enabled { "on" } else { "off" },
                                            "aria-label": "Toggle plugin",
                                            title: if item.enabled { "Disable plugin" } else { "Enable plugin" },
                                            disabled: safe_mode,
                                            style: "padding:0;border:0;background:transparent;cursor:pointer;",
                                            span { style: "{track_style}", span { style: "{thumb_style}" } }
                                        }
                                        button {
                                            class: "PluginsPage_iconButtonDanger",
                                            r#type: "button",
                                            "data-part": "plugin-uninstall",
                                            "aria-label": "Uninstall plugin",
                                            title: "Uninstall plugin",
                                            disabled: safe_mode,
                                            style: "display:grid;width:44px;height:44px;place-items:center;border:1px solid transparent;border-radius:10px;color:#998f87;background:transparent;",
                                            {icon_fill("Trash", 16, "#998f87")}
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
