//! AI Settings rail panel. Mirrors `apps/web/src/components/ai-settings/AiSettingsPanel.tsx`
//! as a providers/presets catalog plus the memories editor over Product Wire.

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
        PanelTab {
            id: "memories",
            label: "Memories",
            disabled: false,
        },
    ];
    let body = match view.ai_tab.as_str() {
        "presets" => presets_tab(view),
        "memories" => memories_tab(view),
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

/// React `MemoryEditor`: CRUD over `memories.list/create/update/delete`.
/// Cards show scope + keys, the durable content and an enabled switch;
/// editing swaps a card's body for the draft inputs. The create form renders
/// while no card is being edited (React hides it during edits).
/// Geometry mirrors `shell_hit.rs::memories_hit`: body padding 12, heading 20,
/// hint 16, outer gaps 8; cards 112 (normal) / 172 (editing); create form
/// 36+4+36+4+36+4+36 = 156; error line 16.
fn memories_tab(view: &ProductShellView) -> Element {
    let character_label = view
        .memory_draft_character_label
        .clone()
        .unwrap_or_else(|| "No characters loaded".to_string());
    let draft_content = view.memory_draft_content.clone();
    let draft_keys = view.memory_draft_keys.clone();
    rsx! {
        div {
            class: "AiSettings_tabBody",
            "data-part": "ai-memories",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:8px;",
            strong { style: "font-size:0.9375rem;height:20px;", "Memories" }
            p { style: "margin:0;color:#998f87;font-size:0.75rem;height:16px;", "Memories inject context into prompts when a keyword matches the chat (keyword retrieval)." }
            for item in view.memories.iter() {
                { memory_card(view, item, &character_label, &draft_content, &draft_keys) }
            }
            if view.memories.is_empty() && view.memory_edit_id.is_none() {
                p { style: "margin:0;color:#998f87;font-size:0.75rem;height:16px;", "No memories yet - add one to inject durable context." }
            }
            if let Some(err) = view.memory_form_error.as_ref() {
                p { style: "margin:0;color:#d98f6a;font-size:0.75rem;height:16px;", "data-part": "memory-form-error", "{err}" }
            }
            if view.memory_edit_id.is_none() {
                div {
                    "data-part": "memory-create",
                    style: "display:flex;flex-direction:column;gap:4px;",
                    span {
                        "data-part": "memory-content-input",
                        style: "display:block;width:100%;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;",
                        "{draft_content}"
                    }
                    span {
                        "data-part": "memory-keys-input",
                        style: "display:block;width:100%;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;",
                        "{draft_keys}"
                    }
                    div {
                        style: "display:flex;align-items:center;gap:8px;height:36px;",
                        button {
                            class: "st-button", r#type: "button",
                            "data-part": "memory-scope-global",
                            "data-state": if !view.memory_draft_scope_character { "active" } else { "idle" },
                            style: "width:96px;height:36px;",
                            span { "Global" }
                        }
                        button {
                            class: "st-button", r#type: "button",
                            "data-part": "memory-scope-character",
                            "data-state": if view.memory_draft_scope_character { "active" } else { "idle" },
                            style: "width:96px;height:36px;",
                            span { "Character" }
                        }
                        if view.memory_draft_scope_character {
                            button {
                                class: "st-button", r#type: "button",
                                "data-part": "memory-character-cycle",
                                style: "flex:1;height:36px;",
                                span { "{character_label}" }
                            }
                        }
                        button {
                            class: "st-button", r#type: "button",
                            "data-part": "memory-draft-enabled",
                            "data-state": if view.memory_draft_enabled { "active" } else { "idle" },
                            style: "width:88px;height:36px;margin-left:auto;",
                            span { "Enabled" }
                        }
                    }
                    button {
                        class: "st-button", r#type: "button",
                        "data-variant": "primary",
                        "data-part": "memory-add",
                        style: "width:140px;height:36px;",
                        span { "Add memory" }
                    }
                }
            }
        }
    }
}

/// One memory card in `memories_tab`: 112 px tall normally, 172 px while the
/// card is being edited (draft inputs replace meta + content). Geometry is
/// mirrored by `shell_hit.rs::memories_hit`.
fn memory_card(
    view: &ProductShellView,
    item: &crate::product_shell::MemoryCardView,
    character_label: &str,
    draft_content: &str,
    draft_keys: &str,
) -> Element {
    let editing = view.memory_edit_id.as_deref() == Some(item.id.as_str());
    let card_height = if editing { 172 } else { 112 };
    let edit_label = if editing { "Save" } else { "Edit" };
    let character_label = character_label.to_string();
    let draft_content = draft_content.to_string();
    let draft_keys = draft_keys.to_string();
    rsx! {
        div {
            class: "AiSettings_memoryCard",
            "data-component": "memory-card",
            "data-part": "memory-card",
            "data-state": if item.enabled { "enabled" } else { "disabled" },
            style: "display:flex;flex-direction:column;gap:4px;width:100%;height:{card_height}px;box-sizing:border-box;padding:8px;border:1px solid #39342f;border-radius:16px;background:#24211e;color:#f3eee8;",
            if editing {
                span {
                    "data-part": "memory-content-input",
                    style: "display:block;width:100%;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;",
                    "{draft_content}"
                }
                span {
                    "data-part": "memory-keys-input",
                    style: "display:block;width:100%;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;",
                    "{draft_keys}"
                }
                div {
                    style: "display:flex;align-items:center;gap:8px;height:36px;",
                    button {
                        class: "st-button", r#type: "button",
                        "data-part": "memory-scope-global",
                        "data-state": if !view.memory_draft_scope_character { "active" } else { "idle" },
                        style: "width:96px;height:36px;",
                        span { "Global" }
                    }
                    button {
                        class: "st-button", r#type: "button",
                        "data-part": "memory-scope-character",
                        "data-state": if view.memory_draft_scope_character { "active" } else { "idle" },
                        style: "width:96px;height:36px;",
                        span { "Character" }
                    }
                    if view.memory_draft_scope_character {
                        button {
                            class: "st-button", r#type: "button",
                            "data-part": "memory-character-cycle",
                            style: "flex:1;height:36px;",
                            span { "{character_label}" }
                        }
                    }
                    button {
                        class: "st-button", r#type: "button",
                        "data-part": "memory-draft-enabled",
                        "data-state": if view.memory_draft_enabled { "active" } else { "idle" },
                        style: "width:88px;height:36px;margin-left:auto;",
                        span { "Enabled" }
                    }
                }
            } else {
                div {
                    style: "display:flex;align-items:center;gap:8px;height:20px;",
                    span { style: "flex:1;min-width:0;color:#998f87;font-size:0.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", "{item.meta}" }
                    button {
                        class: "st-button", r#type: "button",
                        "data-part": "memory-enabled",
                        "data-state": if item.enabled { "active" } else { "idle" },
                        style: "width:88px;height:20px;font-size:0.6875rem;",
                        span { "Enabled" }
                    }
                }
                p { style: "margin:0;height:32px;font-size:0.8125rem;color:#c5bbb2;overflow:hidden;", "{item.content}" }
            }
            div {
                style: "display:flex;align-items:center;gap:8px;height:36px;",
                button {
                    class: "st-button", r#type: "button",
                    "data-variant": if editing { "primary" } else { "default" },
                    "data-part": "memory-edit",
                    style: "width:96px;height:36px;",
                    span { "{edit_label}" }
                }
                if editing {
                    button {
                        class: "st-button", r#type: "button",
                        "data-part": "memory-cancel",
                        style: "width:88px;height:36px;",
                        span { "Cancel" }
                    }
                }
                button {
                    class: "st-button", r#type: "button",
                    "data-variant": "danger",
                    "data-part": "memory-delete",
                    style: "width:96px;height:36px;margin-left:auto;",
                    span { "Delete" }
                }
            }
        }
    }
}
