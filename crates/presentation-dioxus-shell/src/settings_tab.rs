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

/// React `ProfilesPanel`: list/create/rename/delete of configuration
/// profiles over Product Wire (`profiles.list` / `create` / `rename` /
/// `delete`), plus the per-profile logical export (`profile.export`, SEC-02).
/// The import section stays an honest labeled note: the packaged host owns
/// the file picker, so there is no path input on this plane.
/// Geometry mirrors `shell_hit.rs::profiles_hit` (label 16 + gap 8 → create
/// row 36; import block 108; list heading/hint 48; rows 64 + 4).
fn profiles_tab(view: &ProductShellView) -> Element {
    let create_value = if view.profile_create_name.is_empty() {
        "New profile name…"
    } else {
        view.profile_create_name.as_str()
    };
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "settings-profiles",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:8px;",
            label {
                class: "SettingsPanel_field",
                style: "line-height:16px;",
                span { "Profile name" }
            }
            div {
                style: "display:flex;gap:8px;align-items:center;",
                span {
                    "data-part": "profile-create-name",
                    style: "flex:1;min-width:0;height:36px;box-sizing:border-box;display:flex;align-items:center;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                    "{create_value}"
                }
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "primary",
                    "data-size": "sm",
                    "data-part": "profile-create-submit",
                    style: "flex:none;width:96px;height:36px;",
                    span { "data-part": "label", "Create" }
                }
            }
            div {
                style: "margin-top:4px;",
                h2 { style: "margin:0;height:20px;line-height:20px;font-size:0.9375rem;color:#f3eee8;", "Import profile" }
                p {
                    style: "color:#c5bbb2;font-size:0.75rem;margin:8px 0;height:32px;line-height:16px;",
                    "Container import runs through the packaged host file picker; this surface has no path input."
                }
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "default",
                    "data-size": "sm",
                    disabled: true,
                    style: "height:36px;",
                    span { "data-part": "label", "Import (.zip)" }
                }
            }
            div {
                style: "margin-top:4px;",
                h2 { style: "margin:0;height:20px;line-height:20px;font-size:0.9375rem;color:#f3eee8;", "Profiles" }
                p {
                    style: "color:#998f87;font-size:0.75rem;margin:4px 0 0;height:16px;line-height:16px;",
                    "Characters bind to a profile; deleting one leaves its characters unassigned."
                }
            }
            if view.profiles.is_empty() {
                p { style: "color:#998f87;font-size:0.8125rem;margin:8px 0 0;", "No profiles yet." }
            } else {
                ul {
                    class: "SettingsPanel_profiles",
                    style: "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;",
                    for item in view.profiles.iter() {
                        li {
                            class: "SettingsPanel_profileRow",
                            "data-part": "profile-row",
                            style: "display:flex;align-items:center;gap:8px;height:64px;box-sizing:border-box;padding:0 8px;border:1px solid #39342f;border-radius:16px;background:#24211e;",
                            span {
                                style: "flex:none;width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;background:#39342f;color:#f3eee8;font-weight:600;font-size:0.9375rem;",
                                {item.name.chars().next().map(|ch| ch.to_uppercase().collect::<String>()).unwrap_or_default()}
                            }
                            span {
                                style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;",
                                strong { style: "color:#f3eee8;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", "{item.name}" }
                                small { style: "color:#998f87;font-size:0.6875rem;", "Created {item.created_at}" }
                            }
                            if view.profile_renaming_id.as_deref() == Some(item.id.as_str()) {
                                span {
                                    "data-part": "profile-rename-input",
                                    style: "flex:1;min-width:0;height:36px;box-sizing:border-box;display:flex;align-items:center;padding:0 12px;border:1px solid #e38a62;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                                    if view.profile_rename_name.is_empty() { "Profile name…" } else { "{view.profile_rename_name}" }
                                }
                                button {
                                    class: "st-button",
                                    r#type: "button",
                                    "data-component": "button",
                                    "data-size": "sm",
                                    "data-part": "profile-rename-save",
                                    style: "flex:none;width:88px;height:36px;",
                                    span { "data-part": "label", "Save" }
                                }
                                button {
                                    class: "st-button",
                                    r#type: "button",
                                    "data-component": "button",
                                    "data-size": "sm",
                                    "data-part": "profile-rename-cancel",
                                    style: "flex:none;width:88px;height:36px;",
                                    span { "data-part": "label", "Cancel" }
                                }
                            } else {
                                div {
                                    style: "flex:none;display:flex;align-items:center;gap:4px;",
                                    button {
                                        class: "SettingsPanel_profileAction",
                                        r#type: "button",
                                        "data-part": "profile-export",
                                        "aria-label": "Export profile",
                                        title: "Export profile",
                                        style: "display:grid;width:44px;height:44px;place-items:center;border:1px solid transparent;border-radius:10px;color:#998f87;background:transparent;",
                                        {icon_fill("DownloadSimple", 16, "#998f87")}
                                    }
                                    button {
                                        class: "SettingsPanel_profileAction",
                                        r#type: "button",
                                        "data-part": "profile-rename",
                                        "aria-label": "Rename profile",
                                        title: "Rename profile",
                                        style: "display:grid;width:44px;height:44px;place-items:center;border:1px solid transparent;border-radius:10px;color:#998f87;background:transparent;",
                                        {icon_fill("PencilSimple", 16, "#998f87")}
                                    }
                                    button {
                                        class: "SettingsPanel_profileActionDanger",
                                        r#type: "button",
                                        "data-part": "profile-delete",
                                        "aria-label": "Delete profile",
                                        title: "Delete profile",
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
