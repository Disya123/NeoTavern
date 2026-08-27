//! AI Settings rail panel. Mirrors `apps/web/src/components/ai-settings/AiSettingsPanel.tsx`
//! as a providers/presets catalog, the memories editor, and the Advanced
//! chat-template editor over Product Wire. Custom ChatML role templates are
//! edited locally and saved through `settings.update`. Text-completion
//! prompt blocks list, toggle `enabled`, custom add/remove, compact
//! editor (name / content / placement / role / triggers / forbidOverrides /
//! model), and `prompt-template` presets (`presets.*`) over the same settings keys.
//! The kernel plane has no instruct-format catalog (`useInstructFormats` → `{ formats: [] }`).

use dioxus_core::Element;
use dioxus_core_macro::rsx;

use crate::product_shell::{
    management_shell, PanelTab, PresetValueRow, ProductShellView, AI_SETTINGS_TITLE,
};

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
        PanelTab {
            id: "advanced",
            label: "Advanced",
            disabled: false,
        },
    ];
    let body = match view.ai_tab.as_str() {
        "presets" => presets_tab(view),
        "memories" => memories_tab(view),
        "advanced" => advanced_tab(view),
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

/// React `ProviderProfileEditor` (API tab) over `providers.config.*`:
/// connection profiles (name, provider, honest "API key saved/not set" — the
/// key value never leaves SecretStore), a New profile dialog
/// (`providers.config.set` upsert), per-row delete, then the registered
/// adapters from `providers.list` as read-only rows. Model discovery stays
/// UnsupportedError on React's kernel plane and is not ported.
/// Geometry mirrors `shell_hit.rs::providers_hit`: profiles section (label 20
/// + new button 36 + rows 64+4), gap 8, adapters section (label 20 + rows
/// 60+4); body padding 12 + heading 20 + hint 16.
fn providers_tab(view: &ProductShellView) -> Element {
    let adapter_empty = view.providers.is_empty();
    rsx! {
        div {
            class: "AiSettings_tabBody",
            "data-part": "ai-providers",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:8px;",
            strong { style: "font-size:0.9375rem;height:20px;", "Provider profiles" }
            button {
                class: "st-button", r#type: "button",
                "data-variant": "primary",
                "data-part": "provider-new",
                style: "width:140px;height:36px;",
                span { "New profile" }
            }
            if view.provider_configs.is_empty() {
                p { style: "margin:0;color:#998f87;font-size:0.75rem;", "No connection profiles yet." }
            } else {
                div {
                    class: "AiSettings_providerList",
                    for item in view.provider_configs.iter() {
                        div {
                            class: "AiSettings_profileRow",
                            "data-component": "provider-config-row",
                            "data-part": "provider-profile-row",
                            "data-state": if Some(item.id.as_str()) == view.selected_provider_id.as_deref() { "active" } else { "idle" },
                            style: "display:flex;align-items:center;gap:8px;width:100%;height:64px;box-sizing:border-box;padding:0 12px;border:1px solid #39342f;border-radius:16px;background:#24211e;color:#f3eee8;",
                            span {
                                style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;",
                                strong { style: "font-size:0.8125rem;", "{item.name}" }
                                span { style: "color:#998f87;font-size:0.6875rem;", "{item.detail}" }
                            }
                            button {
                                class: "st-button", r#type: "button",
                                "data-variant": "danger",
                                "data-part": "provider-profile-delete",
                                style: "width:96px;height:36px;flex:none;",
                                span { "Delete" }
                            }
                        }
                    }
                }
            }
            strong { style: "font-size:0.9375rem;height:20px;margin-top:8px;", "Adapters" }
            p { style: "margin:0;color:#998f87;font-size:0.75rem;height:16px;", "Registered provider adapters come from Product Wire providers.list." }
            if adapter_empty {
                p { style: "margin:0;color:#998f87;font-size:0.75rem;", "No adapters configured." }
            } else {
                div {
                    class: "AiSettings_providerList",
                    for item in view.providers.iter() {
                        div {
                            class: "AiSettings_providerCard",
                            "data-part": "adapter-row",
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

/// React `GenerationPresetEditor` (Config tab): the preset selector cards
/// (tap = select, applies values through `settings.update`), a management
/// toolbar (save-as / rename / duplicate / delete), read-only sampler rows of
/// the active preset and Apply. Per-sampler range editing stays on React for
/// now; import/export are host-owned file dialogs.
/// Geometry mirrors `shell_hit.rs::presets_config_hit`: body padding 12 +
/// heading 20 + gap 8 + hint 16 + gap 8 + toolbar 36 + gap 8 + values card
/// (8*2 + rows*20) + gap 8; selector cards 60 + 4.
fn presets_tab(view: &ProductShellView) -> Element {
    let empty = view.presets.is_empty();
    let active_label = view
        .preset_active_name
        .clone()
        .unwrap_or_else(|| "Unsaved generation settings".to_string());
    let rows: Vec<PresetValueRow> = view.preset_rows.clone();
    rsx! {
        div {
            class: "AiSettings_tabBody",
            "data-part": "ai-presets",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:8px;",
            strong { style: "font-size:0.9375rem;height:20px;", "Generation presets" }
            p { style: "margin:0;color:#998f87;font-size:0.75rem;height:16px;", "Reusable sampler settings come from Product Wire presets.list." }
            div {
                style: "display:flex;align-items:center;gap:8px;height:20px;",
                span { style: "flex:1;min-width:0;color:#998f87;font-size:0.75rem;", "{active_label}" }
            }
            div {
                style: "display:flex;align-items:center;gap:8px;height:36px;",
                button {
                    class: "st-button", r#type: "button",
                    "data-part": "preset-save-as",
                    style: "width:96px;height:36px;",
                    span { "Save as" }
                }
                button {
                    class: "st-button", r#type: "button",
                    "data-part": "preset-rename",
                    style: "width:96px;height:36px;",
                    span { "Rename" }
                }
                button {
                    class: "st-button", r#type: "button",
                    "data-part": "preset-duplicate",
                    style: "width:96px;height:36px;",
                    span { "Duplicate" }
                }
                button {
                    class: "st-button", r#type: "button",
                    "data-variant": "danger",
                    "data-part": "preset-delete",
                    style: "width:96px;height:36px;margin-left:auto;",
                    span { "Delete" }
                }
            }
            div {
                "data-part": "preset-values",
                style: "display:flex;flex-direction:column;gap:4px;width:100%;box-sizing:border-box;padding:8px;border:1px solid #39342f;border-radius:16px;background:#24211e;color:#f3eee8;",
                for row in rows.iter() {
                    div {
                        key: "{row.label}",
                        style: "display:flex;align-items:center;height:20px;",
                        span { style: "flex:1;color:#998f87;font-size:0.75rem;", "{row.label}" }
                        strong { style: "font-size:0.75rem;", "{row.value}" }
                    }
                }
            }
            button {
                class: "st-button", r#type: "button",
                "data-variant": "primary",
                "data-part": "preset-apply",
                style: "width:160px;height:36px;",
                span { "Apply settings" }
            }
            if empty {
                p { style: "margin:0;color:#998f87;font-size:0.75rem;", "No saved presets yet." }
            } else {
                div {
                    class: "AiSettings_presetList",
                    for item in view.presets.iter() {
                        button {
                            class: "AiSettings_presetCard",
                            r#type: "button",
                            "data-part": "preset-card",
                            "data-state": if Some(item.id.as_str()) == view.selected_preset_id.as_deref() { "active" } else { "idle" },
                            style: "display:flex;align-items:center;gap:8px;width:100%;height:60px;box-sizing:border-box;padding:0 12px;border:1px solid #39342f;border-radius:16px;background:#24211e;color:#f3eee8;transition:border-color var(--st-motion-duration-fast, 180ms) var(--st-motion-easing-standard, cubic-bezier(0.22, 1, 0.36, 1)),background-color var(--st-motion-duration-fast, 180ms) var(--st-motion-easing-standard, cubic-bezier(0.22, 1, 0.36, 1));",
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

/// React `AdvancedPromptSettings` + `ChatTemplateEditor` /
/// `PromptTemplateEditor` (block list + enabled toggle). Built-in instruct
/// formats are a legacy sidecar catalog — this plane lists native + custom
/// only. Prompt-template presets, custom blocks, reorder, and import/export
/// stay on the React plane; mode and `enabled` still persist through Wire.
fn advanced_tab(view: &ProductShellView) -> Element {
    let chat_mode = view.prompt_template_mode != "text";
    let custom = view.instruct_selection == "custom";
    let selection_label = if custom {
        "Custom role template"
    } else {
        "Native provider messages"
    };
    let hint = if custom {
        "Roles are rendered into one text prompt before the provider request."
    } else {
        "Recommended for chat APIs. Roles are sent as structured provider messages."
    };
    let prompt_preset_label = view
        .prompt_preset_active_name
        .clone()
        .unwrap_or_else(|| "Unsaved current template".to_string());
    rsx! {
        div {
            class: "AiSettings_tabBody",
            "data-part": "advanced-prompt-settings",
            "data-component": "advanced-prompt-settings",
            style: "padding:12px 16px;display:flex;flex-direction:column;gap:8px;",
            div {
                class: "AiSettings_modeSwitch",
                role: "radiogroup",
                "aria-label": "Prompt mode",
                "data-part": "prompt-mode",
                style: "display:flex;align-items:center;gap:8px;height:40px;",
                span { style: "font-size:0.75rem;color:#c5bbb2;", "Prompt mode" }
                button {
                    class: "st-button",
                    r#type: "button",
                    "data-state": if chat_mode { "active" } else { "inactive" },
                    style: "height:36px;",
                    span { if chat_mode { "Chat Template" } else { "Prompt Template" } }
                }
            }
            if chat_mode {
                section {
                    class: "AiSettings_templateEditor",
                    "data-component": "chat-template-editor",
                    style: "display:flex;flex-direction:column;gap:8px;",
                    strong { style: "font-size:0.9375rem;height:20px;", "Chat template" }
                    p { style: "margin:0;color:#c5bbb2;font-size:0.75rem;", "Create the instruct format used to serialize system, user, assistant, and tool messages." }
                    label {
                        class: "AiSettings_field",
                        "data-part": "instruct-selection",
                        style: "display:flex;flex-direction:column;gap:4px;",
                        span { "Chat serialization" }
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "default",
                            style: "height:36px;align-self:flex-start;",
                            span { "data-part": "label", "{selection_label}" }
                        }
                        small { style: "color:#998f87;", "{hint}" }
                    }
                    if custom {
                        {instruct_role_field(
                            "System message template",
                            "instruct-system-input",
                            &view.instruct_system,
                            None,
                        )}
                        {instruct_role_field(
                            "User message template",
                            "instruct-user-input",
                            &view.instruct_user,
                            None,
                        )}
                        {instruct_role_field(
                            "Assistant message template",
                            "instruct-assistant-input",
                            &view.instruct_assistant,
                            None,
                        )}
                        {instruct_role_field(
                            "Tool message template",
                            "instruct-tool-input",
                            &view.instruct_tool,
                            None,
                        )}
                        {instruct_role_field(
                            "Assistant prompt suffix",
                            "instruct-suffix-input",
                            &view.instruct_prompt_suffix,
                            None,
                        )}
                        {instruct_role_field(
                            "Stopping strings",
                            "instruct-stops-input",
                            &view.instruct_stop_strings,
                            Some("One stopping string per line."),
                        )}
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-variant": "primary",
                            "data-part": "instruct-save",
                            style: "width:140px;height:36px;",
                            span { "Save template" }
                        }
                    }
                }
            } else {
                section {
                    class: "AiSettings_templateEditor",
                    "data-component": "prompt-template-editor",
                    style: "display:flex;flex-direction:column;gap:8px;",
                    strong { style: "font-size:0.9375rem;height:20px;", "Text-completion prompt template" }
                    p {
                        style: "margin:0;color:#c5bbb2;font-size:0.75rem;height:32px;line-height:16px;overflow:hidden;",
                        "Arrange host context and custom prompts, control when they run, and save reusable presets."
                    }
                    p {
                        style: "margin:0;color:#998f87;font-size:0.75rem;height:16px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                        "Drag, import/export, and token audit stay on the React plane."
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-part": "prompt-preset-cycle",
                        "data-state": if view.active_prompt_preset_id.is_some() { "saved" } else { "unsaved" },
                        "aria-label": "Prompt template preset",
                        style: "height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;width:100%;box-sizing:border-box;transition:background-color var(--st-motion-duration-fast, 180ms) var(--st-motion-easing-standard, cubic-bezier(0.22, 1, 0.36, 1));",
                        span {
                            style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                            "{prompt_preset_label}"
                        }
                    }
                    div {
                        "data-part": "prompt-preset-actions",
                        style: "display:flex;align-items:center;gap:8px;height:36px;",
                        button {
                            class: "st-button", r#type: "button",
                            "data-part": "prompt-preset-save",
                            style: "width:96px;height:36px;",
                            span { "Save" }
                        }
                        button {
                            class: "st-button", r#type: "button",
                            "data-part": "prompt-preset-rename",
                            style: "width:96px;height:36px;",
                            span { "Rename" }
                        }
                        button {
                            class: "st-button", r#type: "button",
                            "data-part": "prompt-preset-duplicate",
                            style: "width:96px;height:36px;",
                            span { "Duplicate" }
                        }
                        button {
                            class: "st-button", r#type: "button",
                            "data-variant": "danger",
                            "data-part": "prompt-preset-delete",
                            style: "width:96px;height:36px;margin-left:auto;",
                            span { "Delete" }
                        }
                    }
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-part": "prompt-block-add",
                        "aria-label": "Add prompt",
                        style: "width:140px;height:36px;",
                        span { "Add prompt" }
                    }
                    div {
                        "data-part": "prompt-block-list",
                        style: "display:flex;flex-direction:column;gap:8px;",
                        for block in view.prompt_blocks.iter() {
                            {
                                let id = block.id.clone();
                                let name = block.name.clone();
                                let enabled = block.enabled;
                                let custom = block.custom;
                                let can_move_up = block.can_move_up;
                                let can_move_down = block.can_move_down;
                                let injection_in_chat = block.injection_in_chat;
                                let injection_depth = block.injection_depth;
                                let kind = if custom { "custom" } else { "marker" };
                                let state = if enabled { "enabled" } else { "disabled" };
                                let toggle = if enabled { "On" } else { "Off" };
                                let aria = if enabled {
                                    format!("Disable {name}")
                                } else {
                                    format!("Enable {name}")
                                };
                                let edit_aria = format!("Edit {name}");
                                let remove_aria = format!("Remove {name} from this template");
                                let up_aria = format!("Move {name} up");
                                let down_aria = format!("Move {name} down");
                                let display_name = if injection_in_chat {
                                    format!("{name} @ {injection_depth}")
                                } else {
                                    name.clone()
                                };
                                let up_state = if can_move_up { "enabled" } else { "disabled" };
                                let down_state = if can_move_down { "enabled" } else { "disabled" };
                                let up_color = if can_move_up { "#e8eef7" } else { "#998f87" };
                                let down_color = if can_move_down { "#e8eef7" } else { "#998f87" };
                                rsx! {
                                    div {
                                        key: "{id}",
                                        "data-part": "prompt-block",
                                        "data-block-id": "{id}",
                                        "data-kind": "{kind}",
                                        "data-state": "{state}",
                                        style: "height:36px;display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;",
                                        button {
                                            class: "st-button",
                                            r#type: "button",
                                            "data-part": "prompt-block-toggle",
                                            "aria-pressed": enabled,
                                            "aria-label": "{aria}",
                                            style: "width:48px;height:36px;flex:none;transition:background-color var(--st-motion-duration-fast, 180ms) var(--st-motion-easing-standard, cubic-bezier(0.22, 1, 0.36, 1));",
                                            span { "{toggle}" }
                                        }
                                        button {
                                            class: "st-button",
                                            r#type: "button",
                                            "data-part": "prompt-block-name",
                                            "aria-label": "{edit_aria}",
                                            style: "flex:1;height:36px;min-width:0;display:flex;align-items:center;padding:0 12px;overflow:hidden;transition:background-color var(--st-motion-duration-fast, 180ms) var(--st-motion-easing-standard, cubic-bezier(0.22, 1, 0.36, 1));",
                                            span {
                                                style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                                                "{display_name}"
                                            }
                                        }
                                        button {
                                            class: "st-button",
                                            r#type: "button",
                                            "data-part": "prompt-block-move-up",
                                            "data-state": "{up_state}",
                                            "aria-label": "{up_aria}",
                                            "aria-disabled": !can_move_up,
                                            style: "width:32px;height:36px;flex:none;color:{up_color};",
                                            span { "Up" }
                                        }
                                        button {
                                            class: "st-button",
                                            r#type: "button",
                                            "data-part": "prompt-block-move-down",
                                            "data-state": "{down_state}",
                                            "aria-label": "{down_aria}",
                                            "aria-disabled": !can_move_down,
                                            style: "width:32px;height:36px;flex:none;color:{down_color};",
                                            span { "Down" }
                                        }
                                        if custom {
                                            button {
                                                class: "st-button",
                                                r#type: "button",
                                                "data-variant": "danger",
                                                "data-part": "prompt-block-remove",
                                                "aria-label": "{remove_aria}",
                                                style: "width:36px;height:36px;flex:none;",
                                                span { "\u{00d7}" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if let Some(error) = view.instruct_form_error.as_deref() {
                p {
                    class: "AiSettings_inlineError",
                    role: "alert",
                    style: "margin:0;color:#f2b8b5;font-size:0.75rem;",
                    "{error}"
                }
            }
        }
    }
}

fn instruct_role_field(label: &str, part: &str, value: &str, hint: Option<&str>) -> Element {
    let height = if hint.is_some() { 72 } else { 56 };
    rsx! {
        label {
            class: "AiSettings_field",
            style: "display:flex;flex-direction:column;gap:4px;height:{height}px;box-sizing:border-box;",
            span { style: "flex:none;height:16px;font-size:0.75rem;color:#c5bbb2;", "{label}" }
            span {
                "data-part": "{part}",
                style: "display:block;width:100%;height:36px;line-height:36px;padding:0 12px;border:1px solid #39342f;border-radius:10px;background:#1e1b18;color:#e8eef7;font-size:0.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;",
                "{value}"
            }
            if let Some(hint) = hint {
                small { style: "flex:none;height:16px;color:#998f87;font-size:0.75rem;", "{hint}" }
            }
        }
    }
}
