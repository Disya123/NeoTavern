//! Settings rail panel. Mirrors `apps/web/src/components/SettingsPanel.tsx`
//! tab set: General / Themes / Data / Profiles / Secrets / Tools. The React
//! panel adds a desktop-shell-only `remote` tab (`isTauriRuntime()`); the
//! native compositor harness is not the packaged Tauri shell, so — same as
//! React in a browser — that tab is absent here. Secrets stay SecretStore
//! refs only: no secret value is ever read or rendered on this surface.

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{
    PanelTab, ProductShellView, SETTINGS_TITLE, icon, icon_fill, management_shell,
};

pub fn settings_panel(view: &ProductShellView) -> Element {
    let tabs = [
        PanelTab {
            id: "general",
            label: "General",
            disabled: false,
        },
        PanelTab {
            id: "themes",
            label: "Themes",
            disabled: false,
        },
        PanelTab {
            id: "data",
            label: "Data",
            disabled: false,
        },
        PanelTab {
            id: "profiles",
            label: "Profiles",
            disabled: false,
        },
        PanelTab {
            id: "secrets",
            label: "Secrets",
            disabled: false,
        },
        PanelTab {
            id: "tools",
            label: "Tools",
            disabled: false,
        },
    ];
    let body = match view.settings_tab.as_str() {
        "themes" => themes_tab(view),
        "data" => data_tab(view),
        "profiles" => profiles_tab(view),
        "secrets" => secrets_tab(view),
        "tools" => tools_tab(view),
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
    let density_label = match view.density.as_str() {
        "compact" => "Compact",
        _ => "Comfortable",
    };
    let scale_label = match view.font_scale.as_str() {
        "small" => "Small",
        "large" => "Large",
        _ => "Medium",
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
            label {
                class: "SettingsPanel_field",
                span { "Interface scale" }
                strong { "{density_label}" }
            }
            label {
                class: "SettingsPanel_field",
                span { "Text size" }
                strong { "{scale_label}" }
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

/// React `ThemesTab`: the theme picker + the package install + the manager
/// link. The fixture plane has no theme catalog Wire surface, so the select
/// honestly offers only the built-in theme and install stays a labeled
/// control without a file dialog (the packaged host owns the picker).
fn themes_tab(_view: &ProductShellView) -> Element {
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "theme-settings",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:12px;",
            label {
                class: "SettingsPanel_field",
                span { "Select theme" }
                strong { "Built-in theme" }
            }
            button {
                class: "st-button",
                r#type: "button",
                "data-component": "button",
                "data-variant": "primary",
                span { "data-part": "icon", "aria-hidden": "true", {icon_fill("DownloadSimple", 18, "#2a130b")} }
                span { "data-part": "label", "Install theme package (.zip / .sttheme)" }
            }
            p {
                style: "color:#998f87;font-size:0.75rem;",
                "Theme packages install through the packaged desktop host; this surface lists the built-in theme until the theme catalog Wire op is wired."
            }
            div {
                class: "SettingsPanel_field",
                span { "Theme manager" }
                strong { "Themes surface opens from the plugins rail entry" }
            }
        }
    }
}

/// React `DataTab`: backups (create / restore) and migration entry points.
/// The fixture plane has no backup Wire surface, so the section states that
/// honestly instead of inventing rows.
fn data_tab(_view: &ProductShellView) -> Element {
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "settings-data",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:12px;",
            div {
                class: "SettingsPanel_field",
                span { "Backups" }
                strong { "No backups yet" }
            }
            div {
                style: "display:flex;gap:8px;flex-wrap:wrap;",
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "primary",
                    span { "data-part": "label", "Create backup" }
                }
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    disabled: true,
                    span { "data-part": "label", "Restore" }
                }
            }
            p {
                style: "color:#998f87;font-size:0.75rem;",
                "Backups and restore run through the Kernel `data.backups.*` Wire ops on the packaged host; this harness plane has no backup catalog yet."
            }
        }
    }
}

/// React `ProfilesPanel`: UI profiles (density / text scale presets). The
/// harness reflects the current view-model values and keeps the profile
/// switcher honest about what it can change.
fn profiles_tab(view: &ProductShellView) -> Element {
    let density_label = match view.density.as_str() {
        "compact" => "Compact",
        _ => "Comfortable",
    };
    let scale_label = match view.font_scale.as_str() {
        "small" => "Small",
        "large" => "Large",
        _ => "Medium",
    };
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "settings-profiles",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:12px;",
            div {
                class: "SettingsPanel_field",
                span { "Active profile" }
                strong { "Built-in" }
            }
            label {
                class: "SettingsPanel_field",
                span { "Density" }
                strong { "{density_label}" }
            }
            label {
                class: "SettingsPanel_field",
                span { "Text size" }
                strong { "{scale_label}" }
            }
            p {
                style: "color:#998f87;font-size:0.75rem;",
                "Custom profiles persist with the user settings store; this harness plane renders the active built-in values."
            }
        }
    }
}

/// React `SecretsPanel` status block. SecretStore values never render here;
/// the status rows honestly report that the fixture plane cannot observe the
/// store (the packaged host owns `secrets.status`).
fn secrets_tab(_view: &ProductShellView) -> Element {
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "secrets-settings",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:12px;",
            h2 { style: "margin:0;font-size:1rem;", "Secrets" }
            p {
                style: "color:#c5bbb2;font-size:0.875rem;margin:0;",
                "Provider keys live in the OS-backed SecretStore. Values are write-only from this surface and never appear in exports or logs."
            }
            div {
                class: "SettingsPanel_field",
                span { "Store status" }
                strong { "Unavailable on this plane" }
            }
            div {
                class: "SettingsPanel_field",
                span { "Stored records" }
                strong { "—" }
            }
            p {
                style: "color:#998f87;font-size:0.75rem;",
                "Status (persistence, writability, record count) comes from the Kernel `secrets.status` Wire op on the packaged host."
            }
        }
    }
}

/// React `ToolsPanel`: the registered tool/MCP entries. The fixture plane has
/// no tool registry Wire surface, so the list is an honest empty state.
fn tools_tab(_view: &ProductShellView) -> Element {
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "settings-tools",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:12px;align-items:flex-start;",
            div {
                style: "display:flex;flex-direction:column;gap:8px;align-items:center;text-align:center;width:100%;padding:16px 0;",
                {icon("Wrench", 34)}
                strong { "No tools registered" }
                p {
                    style: "color:#c5bbb2;font-size:0.875rem;margin:0;",
                    "Tools and MCP servers register through the Plugin SDK on the packaged host."
                }
            }
        }
    }
}
