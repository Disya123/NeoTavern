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

/// React `ThemesTab` / `ThemesPage` catalog over Product Wire
/// (`themes.list` / `activate` / `deactivate` / `uninstall`). The install row
/// stays a labeled control without a file dialog — the packaged host owns the
/// picker and verification, so the kernel plane rejects installs with
/// `CAPABILITY_UNAVAILABLE` (React `UnsupportedError('themes.install.host-verify')`).
/// Geometry mirrors `shell_hit.rs::themes_hit` (label 16 + gap 8 → install
/// row 36; note 32; built-in row 36; rows 64 + 4).
fn themes_tab(view: &ProductShellView) -> Element {
    let active = view.themes.iter().find(|item| item.active);
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "theme-settings",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:8px;",
            label {
                class: "SettingsPanel_field",
                style: "line-height:16px;",
                span { "Select theme" }
            }
            button {
                class: "st-button",
                r#type: "button",
                "data-component": "button",
                "data-variant": "primary",
                "data-part": "themes-install",
                style: "height:36px;",
                span { "data-part": "icon", "aria-hidden": "true", {icon_fill("DownloadSimple", 18, "#2a130b")} }
                span { "data-part": "label", "Install theme package (.zip / .sttheme)" }
            }
            p {
                style: "color:#998f87;font-size:0.75rem;margin:0;height:32px;line-height:16px;",
                "Package verification and CSS publishing run on the packaged desktop host; this plane cannot install a theme package."
            }
            if active.is_some() {
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "default",
                    "data-size": "sm",
                    "data-part": "themes-use-builtin",
                    style: "height:36px;",
                    span { "data-part": "label", "Use built-in theme" }
                }
            }
            if view.themes.is_empty() {
                p { style: "color:#998f87;font-size:0.8125rem;margin:8px 0 0;", "No custom themes installed." }
            } else {
                ul {
                    class: "SettingsPanel_themes",
                    style: "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;",
                    for item in view.themes.iter() {
                        li {
                            class: "SettingsPanel_themeRow",
                            "data-part": "theme-row",
                            "data-state": if item.active { "active" } else { "inactive" },
                            style: "display:flex;align-items:center;gap:8px;height:64px;box-sizing:border-box;padding:0 8px;border:1px solid #39342f;border-radius:16px;background:#24211e;",
                            span {
                                style: "flex:none;width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:#39342f;color:#f3eee8;",
                                {icon("Palette", 20)}
                            }
                            span {
                                style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;",
                                strong { style: "color:#f3eee8;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", "{item.name}" }
                                small { style: "color:#998f87;font-size:0.6875rem;", "{item.id} · v{item.version} · {item.trust_state}" }
                            }
                            if item.active {
                                span {
                                    style: "flex:none;display:flex;align-items:center;gap:4px;color:#e38a62;font-size:0.6875rem;font-weight:600;text-transform:uppercase;",
                                    {icon_fill("CheckCircle", 14, "#e38a62")}
                                    "Active"
                                }
                            } else {
                                div {
                                    style: "flex:none;display:flex;align-items:center;gap:4px;",
                                    button {
                                        class: "st-button",
                                        r#type: "button",
                                        "data-component": "button",
                                        "data-size": "sm",
                                        "data-part": "theme-apply",
                                        style: "flex:none;width:96px;height:36px;",
                                        span { "data-part": "label", "Apply" }
                                    }
                                    button {
                                        class: "SettingsPanel_profileActionDanger",
                                        r#type: "button",
                                        "data-part": "theme-delete",
                                        "aria-label": "Delete theme",
                                        title: "Delete theme",
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

/// React `SettingsPanel` DataTab over Product Wire: the section header, the
/// Create/Refresh action row (`backups.create` / `backups.list`), then backup
/// rows carrying Restore (`backups.restore`) in the right zone. The kernel
/// models no auto/manual split — every row is an honest "Manual backup".
/// Geometry mirrors `shell_hit.rs::data_hit` (padding 12 + title 20 + gap 8 +
/// hint 32 + gap 8 + actions 36 + gap 8; rows 64 + 4).
fn data_tab(view: &ProductShellView) -> Element {
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "settings-data",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:8px;",
            h2 { style: "margin:0;font-size:0.9375rem;", "Data & backups" }
            p { style: "margin:0;color:#998f87;font-size:0.75rem;", "Backups contain your local library and settings." }
            div {
                style: "display:flex;gap:8px;height:36px;",
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "primary",
                    "data-part": "create-backup",
                    style: "height:36px;",
                    span { "data-part": "label", "Create backup" }
                }
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "ghost",
                    "data-part": "refresh-backups",
                    style: "height:36px;",
                    span { "data-part": "label", "Refresh backups" }
                }
            }
            if view.backups.is_empty() {
                p {
                    style: "color:#998f87;font-size:0.75rem;",
                    "Refresh the list or create your first backup."
                }
            } else {
                div {
                    class: "SettingsPanel_backupList",
                    for item in view.backups.iter() {
                        div {
                            class: "SettingsPanel_backupItem",
                            "data-component": "backup-entry",
                            style: "display:flex;align-items:center;gap:8px;width:100%;height:64px;box-sizing:border-box;padding:0 12px;border:1px solid #39342f;border-radius:16px;background:#24211e;color:#f3eee8;",
                            span {
                                style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;",
                                strong { style: "font-size:0.8125rem;", "{item.title}" }
                                span { style: "color:#998f87;font-size:0.6875rem;", "{item.detail}" }
                            }
                            button {
                                class: "st-button",
                                r#type: "button",
                                "data-component": "button",
                                "data-part": "restore-backup",
                                style: "flex:none;width:96px;height:36px;",
                                span { "data-part": "label", "Restore" }
                            }
                        }
                    }
                }
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
                    style: "color:#c5bbb2;font-size:0.75rem;margin:8px 0;height:16px;line-height:16px;",
                    "Relative container path staged under the data root."
                }
                div {
                    style: "display:flex;gap:8px;align-items:center;",
                    span {
                        "data-part": "profile-import-path",
                        style: "flex:1;min-width:0;height:36px;box-sizing:border-box;display:flex;align-items:center;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                        if view.profile_import_path.is_empty() {
                            span { style: "color:#998f87;", "imports/profile-…/" }
                        } else {
                            "{view.profile_import_path}"
                        }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-part": "profile-import-policy",
                        style: "flex:none;width:96px;height:36px;",
                        span { "data-part": "label", "{view.profile_import_policy_label}" }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "primary",
                        "data-size": "sm",
                        "data-part": "profile-import-submit",
                        style: "flex:none;width:96px;height:36px;",
                        span { "data-part": "label", "Import" }
                    }
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

/// React `SecretsPanel`: the store mode card, the flag list, the lock button
/// (only for an available portable store) and the no-reveal note. Values
/// never render — the `secrets.status` DTO is value-free by contract.
/// Geometry mirrors `shell_hit.rs::secrets_hit` (padding 12 + title 20 +
/// gap 8 + hint 32 + gap 8 + mode card 64 + gap 8 + flags 20/row + gap 8 →
/// lock button 36).
fn secrets_tab(view: &ProductShellView) -> Element {
    let Some(status) = view.secrets_status.as_ref() else {
        return rsx! {
            div {
                class: "SettingsPanel_section",
                "data-part": "secrets-settings",
                style: "padding:12px 16px;display:flex;flex-direction:column;gap:12px;",
                h2 { style: "margin:0;font-size:1rem;height:20px;", "Secret storage" }
                p { role: "status", style: "color:#c5bbb2;font-size:0.875rem;margin:0;", "Reading secret-store status…" }
            }
        };
    };
    let (mode_label, mode_hint, mode_icon) = match status.kind.as_str() {
        "portable" => (
            "Portable encrypted",
            "Secrets are kept in an encrypted portable store (secrets.enc) protected by your master passphrase and travel with the data folder.",
            "LockKey",
        ),
        "env" => (
            "Machine-bound (environment)",
            "Secrets come from environment variables configured for this host (NEOTA_SECRET_*). Nothing is written by the app.",
            "Lock",
        ),
        "session" => (
            "Session-only",
            "Secrets live in memory for this session only and are gone when the app closes. Re-enter them next launch.",
            "Lock",
        ),
        _ => (
            "Secret storage unavailable",
            "No secure secret backend is wired in this configuration. Secret-requiring features fail closed rather than fall back to plaintext.",
            "Key",
        ),
    };
    let yes_no = |value: bool| if value { "Yes" } else { "No" };
    let can_lock = status.kind == "portable" && status.available;
    let show_locked_hint = status.kind == "portable" && !status.available;
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "secrets-settings",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:8px;",
            h2 { style: "margin:0;font-size:1rem;height:20px;line-height:20px;", "Secret storage" }
            p {
                style: "color:#c5bbb2;font-size:0.75rem;margin:0;height:32px;line-height:16px;",
                "How provider keys and other secrets are kept on this device. Secrets are never stored in the database and never appear in exports or diagnostics."
            }
            div {
                class: "SettingsPanel_secretsMode",
                "data-state": "{status.kind}",
                style: "height:64px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 12px;border:1px solid #39342f;border-radius:16px;background:#24211e;",
                {icon(mode_icon, 20)}
                span {
                    style: "min-width:0;display:flex;flex-direction:column;gap:2px;",
                    strong { style: "color:#f3eee8;font-size:0.8125rem;", "{mode_label}" }
                    small { style: "color:#998f87;font-size:0.6875rem;line-height:14px;", "{mode_hint}" }
                }
            }
            ul {
                class: "SettingsPanel_secretsFlags",
                style: "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;",
                li { style: "display:flex;align-items:center;justify-content:space-between;height:16px;font-size:0.75rem;", span { style: "color:#998f87;", "Persistent" } span { style: "color:#f3eee8;", "{yes_no(status.persistent)}" } }
                li { style: "display:flex;align-items:center;justify-content:space-between;height:16px;font-size:0.75rem;", span { style: "color:#998f87;", "Writable" } span { style: "color:#f3eee8;", "{yes_no(status.writable)}" } }
                li { style: "display:flex;align-items:center;justify-content:space-between;height:16px;font-size:0.75rem;", span { style: "color:#998f87;", "Available" } span { style: "color:#f3eee8;", "{yes_no(status.available)}" } }
                li { style: "display:flex;align-items:center;justify-content:space-between;height:16px;font-size:0.75rem;", span { style: "color:#998f87;", "Stored records" } span { style: "color:#f3eee8;", "{status.record_count}" } }
                if let Some(version) = status.format_version {
                    li { style: "display:flex;align-items:center;justify-content:space-between;height:16px;font-size:0.75rem;", span { style: "color:#998f87;", "Portable format" } span { style: "color:#f3eee8;", "v{version}" } }
                }
            }
            if show_locked_hint {
                p { role: "status", style: "color:#e38a62;font-size:0.75rem;margin:0;", "The store is locked: derived key material was dropped. Provider-key writes fail until the app is restarted and the store is re-opened with your master passphrase." }
            }
            if can_lock {
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-component": "button",
                    "data-variant": "primary",
                    "data-part": "lock-secrets",
                    style: "height:36px;",
                    span { "data-part": "label", "Lock now" }
                }
            }
            p {
                style: "color:#998f87;font-size:0.75rem;margin:0;",
                "There is no reveal operation: values never leave the store, so there is nothing to display here."
            }
        }
    }
}

/// React `ToolsPanel` over `generation.tools.list`: the declarative tool
/// contracts this host registered with the kernel. Read-only surface —
/// arguments and results never reach this panel; the kernel validates
/// provider tool calls against the registry but never executes tools.
fn tools_tab(view: &ProductShellView) -> Element {
    rsx! {
        div {
            class: "SettingsPanel_section",
            "data-part": "settings-tools",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:12px;",
            h2 { style: "margin:0;font-size:1rem;", "Tool registry" }
            p {
                style: "color:#c5bbb2;font-size:0.75rem;margin:0;",
                "The declarative tool contracts this host registered with the kernel. The kernel validates provider tool calls against them but never executes tools itself — the host performs the effect. Arguments and results never reach this panel."
            }
            if view.tools.is_empty() {
                p { style: "color:#998f87;font-size:0.8125rem;margin:0;", "No tools registered by this host." }
            } else {
                ul {
                    class: "SettingsPanel_tools",
                    style: "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;",
                    for tool in view.tools.iter() {
                        li {
                            "data-component": "tool-entry",
                            style: "display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid #39342f;border-radius:16px;background:#24211e;",
                            span {
                                style: "display:flex;align-items:center;gap:8px;",
                                {icon("Wrench", 16)}
                                strong { style: "color:#f3eee8;font-size:0.8125rem;", "{tool.name}" }
                            }
                            p {
                                style: "color:#c5bbb2;font-size:0.75rem;margin:0;",
                                if tool.description.is_empty() { "No description provided." } else { "{tool.description}" }
                            }
                            p {
                                "data-part": "tool-required",
                                style: "color:#998f87;font-size:0.6875rem;margin:0;",
                                if tool.required.is_empty() {
                                    "No required arguments."
                                } else {
                                    {format!("Requires: {}", tool.required.join(", "))}
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
