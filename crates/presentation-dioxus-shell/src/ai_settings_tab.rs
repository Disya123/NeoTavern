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
                            span {
                                strong { "{item.name}" }
                                span { "{item.availability}" }
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
                            span {
                                strong { "{item.name}" }
                                span { "{item.kind}" }
                            }
                        }
                    }
                }
            }
        }
    }
}
