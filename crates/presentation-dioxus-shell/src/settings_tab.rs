//! Settings rail panel. Mirrors `apps/web/src/components/SettingsPanel.tsx`
//! general/language/safe-mode chrome. Secrets stay SecretStore refs only.

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{icon, management_shell, PanelTab, ProductShellView, SETTINGS_TITLE};

pub fn settings_panel(view: &ProductShellView) -> Element {
    let tabs = [
        PanelTab {
            id: "general",
            label: "General",
            disabled: false,
        },
        PanelTab {
            id: "host",
            label: "Host",
            disabled: false,
        },
    ];
    let body = match view.settings_tab.as_str() {
        "host" => host_tab(view),
        _ => general_tab(view),
    };
    management_shell(
        view,
        "settings-panel",
        "settings-header",
        SETTINGS_TITLE,
        "SlidersHorizontal",
        None,
        &tabs,
        &view.settings_tab,
        body,
    )
}

fn general_tab(view: &ProductShellView) -> Element {
    let dir_label = if view.dir == "rtl" { "RTL" } else { "LTR" };
    let safe = if view.chat.error_code.as_deref() == Some("SAFE_MODE") {
        "On"
    } else {
        "Off"
    };
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "settings-general",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:12px;",
            label {
                class: "SettingsPanel_field",
                span { "Language" }
                strong { "{view.language}" }
            }
            label {
                class: "SettingsPanel_field",
                span { "Text direction" }
                strong { "{dir_label}" }
            }
            p {
                style: "color:#c5bbb2;font-size:0.875rem;",
                "Catalogs come from packages/i18n. Rust loads the same language id; copy on this surface is the English React golden until the isolated namespace is wired."
            }
            div {
                class: "SettingsPanel_field",
                span { "Safe mode" }
                strong { "{safe}" }
            }
            p {
                style: "color:#998f87;font-size:0.75rem;",
                "NEOTA_SAFE_MODE disables third-party themes and plugins. SecretStore values never appear here."
            }
        }
    }
}

fn host_tab(_view: &ProductShellView) -> Element {
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "settings-host",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:12px;",
            {icon("SlidersHorizontal", 24)}
            strong { "This device" }
            p { "This device can use the on-device kernel or a Desktop / Headless pairing link." }
            button {
                class: "st-button",
                r#type: "button",
                span { "data-part": "label", "Change host" }
            }
        }
    }
}
