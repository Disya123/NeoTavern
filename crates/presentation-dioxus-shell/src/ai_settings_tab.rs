//! AI Settings rail panel. Mirrors `apps/web/src/components/AiSettingsPanel.tsx`
//! as a providers/presets catalog over Product Wire.

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{icon, management_shell, PanelTab, ProductShellView, AI_SETTINGS_TITLE};

pub fn ai_settings_panel(view: &ProductShellView) -> Element {
    let tabs = [
        PanelTab {
            id: "providers",
            label: "API",
            disabled: false,
        },
        PanelTab {
            id: "presets",
            label: "Config",
            disabled: false,
        },
    ];
    let body = match view.ai_tab.as_str() {
        "presets" => presets_tab(view),
        _ => providers_tab(view),
    };
    management_shell(
        view,
        "ai-settings-panel",
        "ai-settings-header",
        AI_SETTINGS_TITLE,
        "Globe",
        None,
        &tabs,
        &view.ai_tab,
        body,
    )
}

fn providers_tab(view: &ProductShellView) -> Element {
    let empty = view.providers.is_empty();
    rsx! {
        div {
            class: "AiSettings_tabBody",
            "data-part": "ai-providers",
            if empty {
                div {
                    class: "AiSettings_emptyState",
                    {icon("Globe", 32)}
                    strong { "No providers configured" }
                    p { "Provider adapters are listed through Product Wire providers.list. Secrets stay in SecretStore and never enter this surface." }
                }
            } else {
                div {
                    class: "AiSettings_providerList",
                    for item in view.providers.iter() {
                        button {
                            class: "AiSettings_providerCard",
                            r#type: "button",
                            "data-part": "provider-card",
                            "data-state": if Some(item.id.as_str()) == view.selected_provider_id.as_deref() { "active" } else { "idle" },
                            style: "display:flex;align-items:center;gap:8px;width:100%;height:60px;box-sizing:border-box;padding:0 12px;border:1px solid #39342f;border-radius:16px;background:#24211e;color:#f3eee8;",
                            span {
                                style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;",
                                strong { style: "font-size:0.8125rem;", "{item.name}" }
                                span { style: "color:#998f87;font-size:0.6875rem;", "{item.availability}" }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn presets_tab(view: &ProductShellView) -> Element {
    let empty = view.presets.is_empty();
    rsx! {
        div {
            class: "AiSettings_tabBody",
            "data-part": "ai-presets",
            if empty {
                div {
                    class: "AiSettings_emptyState",
                    {icon("SlidersHorizontal", 32)}
                    strong { "No generation presets" }
                    p { "Reusable sampler settings come from Product Wire presets.list." }
                }
            } else {
                div {
                    class: "AiSettings_presetList",
                    for item in view.presets.iter() {
                        button {
                            class: "AiSettings_presetCard",
                            r#type: "button",
                            "data-part": "preset-card",
                            "data-state": if Some(item.id.as_str()) == view.selected_preset_id.as_deref() { "active" } else { "idle" },
                            style: "display:flex;align-items:center;gap:8px;width:100%;height:60px;box-sizing:border-box;padding:0 12px;border:1px solid #39342f;border-radius:16px;background:#24211e;color:#f3eee8;",
                            span {
                                style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;",
                                strong { style: "font-size:0.8125rem;", "{item.name}" }
                                span { style: "color:#998f87;font-size:0.6875rem;", "{item.kind}" }
                            }
                        }
                    }
                }
            }
        }
    }
}
