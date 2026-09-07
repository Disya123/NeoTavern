//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    pub(crate) fn load_plugins(&mut self) {
        match self.call_decode("plugins.list", &RequestEmpty {}, decode_result_plugins_list) {
            Ok(ResultPluginsList { items }) => self.state.plugins = items,
            Err(err) => self.record_error(err),
        }
    }

    pub(crate) fn load_ai_settings(&mut self) {
        match self.call_decode(
            "providers.list",
            &RequestEmpty {},
            decode_result_list_providers,
        ) {
            Ok(ResultListProviders { items }) => {
                self.state.providers = items
                    .into_iter()
                    .map(|row| ProviderCardView {
                        id: row.id,
                        name: row.name,
                        availability: match row.availability {
                            contracts_generated::generated::ProviderAvailability::Available => {
                                "available".into()
                            }
                            contracts_generated::generated::ProviderAvailability::Degraded {
                                ..
                            } => "degraded".into(),
                            contracts_generated::generated::ProviderAvailability::Unavailable {
                                ..
                            } => "unavailable".into(),
                        },
                    })
                    .collect();
            }
            Err(err) => self.record_error(err),
        }
        match self.call_decode(
            "presets.list",
            &RequestListPresets {
                kind: Some("generation".into()),
            },
            decode_result_list_presets,
        ) {
            Ok(ResultListPresets { items }) => self.state.presets = items,
            Err(err) => self.record_error(err),
        }
    }

    /// Live sampler rows for the Config tab from the generation draft
    /// (React `GenerationPresetEditor` RangeField / Switch). Range sliders
    /// stay on React; native uses compact numeric fields.
    pub(crate) fn preset_value_rows(&self) -> Vec<PresetValueRow> {
        let defaults = self.parsed_preset_defaults();
        let focused = self.state.preset_edit_key.as_deref();
        let display = |id: &str, formatted: String| {
            if focused == Some(id) {
                self.state.preset_edit_text.clone()
            } else {
                formatted
            }
        };
        vec![
            PresetValueRow {
                id: "maxContextTokens".into(),
                label: "Context size (tokens)".into(),
                value: display(
                    "maxContextTokens",
                    self.state.preset_draft_max_context.to_string(),
                ),
                kind: "number".into(),
                focused: focused == Some("maxContextTokens"),
            },
            PresetValueRow {
                id: "maxTokens".into(),
                label: "Max tokens".into(),
                value: display(
                    "maxTokens",
                    format_sampler_number(defaults.max_tokens, true),
                ),
                kind: "number".into(),
                focused: focused == Some("maxTokens"),
            },
            PresetValueRow {
                id: "temperature".into(),
                label: "Temperature".into(),
                value: display(
                    "temperature",
                    format_sampler_number(defaults.temperature, false),
                ),
                kind: "number".into(),
                focused: focused == Some("temperature"),
            },
            PresetValueRow {
                id: "topP".into(),
                label: "Top P".into(),
                value: display("topP", format_sampler_number(defaults.top_p, false)),
                kind: "number".into(),
                focused: focused == Some("topP"),
            },
            PresetValueRow {
                id: "topK".into(),
                label: "Top K".into(),
                value: display("topK", format_sampler_number(defaults.top_k, true)),
                kind: "number".into(),
                focused: focused == Some("topK"),
            },
            PresetValueRow {
                id: "minP".into(),
                label: "Min P".into(),
                value: display("minP", format_sampler_number(defaults.min_p, false)),
                kind: "number".into(),
                focused: focused == Some("minP"),
            },
            PresetValueRow {
                id: "topA".into(),
                label: "Top A".into(),
                value: display("topA", format_sampler_number(defaults.top_a, false)),
                kind: "number".into(),
                focused: focused == Some("topA"),
            },
            PresetValueRow {
                id: "repetitionPenalty".into(),
                label: "Repetition penalty".into(),
                value: display(
                    "repetitionPenalty",
                    format_sampler_number(defaults.repetition_penalty, false),
                ),
                kind: "number".into(),
                focused: focused == Some("repetitionPenalty"),
            },
            PresetValueRow {
                id: "frequencyPenalty".into(),
                label: "Frequency penalty".into(),
                value: display(
                    "frequencyPenalty",
                    format_sampler_number(defaults.frequency_penalty, false),
                ),
                kind: "number".into(),
                focused: focused == Some("frequencyPenalty"),
            },
            PresetValueRow {
                id: "presencePenalty".into(),
                label: "Presence penalty".into(),
                value: display(
                    "presencePenalty",
                    format_sampler_number(defaults.presence_penalty, false),
                ),
                kind: "number".into(),
                focused: focused == Some("presencePenalty"),
            },
            PresetValueRow {
                id: "seed".into(),
                label: "Seed".into(),
                value: display("seed", format_sampler_number(defaults.seed, true)),
                kind: "number".into(),
                focused: focused == Some("seed"),
            },
            PresetValueRow {
                id: "reasoning".into(),
                label: "Request model reasoning".into(),
                value: defaults.reasoning.to_string(),
                kind: "toggle".into(),
                focused: false,
            },
            PresetValueRow {
                id: "stream".into(),
                label: "Streaming".into(),
                value: defaults.stream.to_string(),
                kind: "toggle".into(),
                focused: false,
            },
        ]
    }

    pub(crate) fn parsed_preset_defaults(&self) -> PresetGenerationDefaults {
        merge_preset_defaults(&self.state.preset_draft_defaults)
    }

    pub(crate) fn load_settings(&mut self) {
        match self.call_decode(
            "settings.get",
            &RequestSettingsGet { keys: None },
            decode_result_settings,
        ) {
            Ok(ResultSettings { items }) => {
                if let Some(language) = settings_string(&items, "language") {
                    self.state.language = language;
                    self.state.dir = match self.state.language.as_str() {
                        "ar" | "he" | "fa" | "ur" => "rtl".into(),
                        _ => "ltr".into(),
                    };
                }
                if let Some(id) = settings_string(&items, "active-persona-id") {
                    self.state.active_persona_id = Some(id);
                }
                self.state.macro_variables = settings_macro_variables(&items);
                self.hydrate_instruct_settings(&items);
                self.hydrate_generation_settings(&items);
            }
            Err(err) => self.record_error(err),
        }
    }

    pub(crate) fn hydrate_instruct_settings(&mut self, items: &[SettingsItem]) {
        if let Some(value) = settings_unwrapped(items, "prompt-template") {
            if value.is_object() {
                self.state.prompt_template = value.clone();
            }
        }
        if let Some(value) = settings_unwrapped(items, "active-prompt-template-preset-id") {
            if value.is_null() {
                self.state.active_prompt_preset_id = None;
            } else if let Some(id) = value.as_str() {
                if !id.is_empty() {
                    self.state.active_prompt_preset_id = Some(id.to_string());
                }
            }
        }
        if let Some(value) = settings_unwrapped(items, "instruct-format") {
            if value.is_null() {
                self.state.instruct_format = None;
            } else if value.is_object() {
                self.state.instruct_format = Some(value.clone());
                self.state.instruct_selection = "custom".into();
                return;
            }
        }
        // Kernel plane has no instruct-format catalog, so a stored catalog id
        // is treated as native (React would still list only native + custom).
        self.state.instruct_selection = "native".into();
        self.state.instruct_format_id = settings_string(items, "instruct-format-id");
    }

    pub(crate) fn hydrate_generation_settings(&mut self, items: &[SettingsItem]) {
        if self.state.preset_draft_dirty {
            return;
        }
        let fallback = PresetGenerationData::default();
        let tokens = settings_unwrapped(items, "maxContextTokens")
            .and_then(Value::as_i64)
            .unwrap_or(fallback.max_context_tokens);
        let defaults = settings_unwrapped(items, "generationDefaults")
            .map(merge_preset_defaults_value)
            .unwrap_or_else(|| {
                serde_json::to_value(&fallback.generation_defaults).unwrap_or_else(|_| json!({}))
            });
        self.state.preset_draft_max_context = tokens;
        self.state.preset_draft_defaults = defaults;
        self.state.preset_unlocked_context = tokens > CONTEXT_TOKEN_DEFAULT_MAX;
        self.clear_preset_value_edit();
        if let Some(value) = settings_unwrapped(items, "activeGenerationPresetId") {
            if value.is_null() {
                self.state.active_preset_id = None;
            } else if let Some(id) = value.as_str() {
                if !id.is_empty() {
                    self.state.active_preset_id = Some(id.to_string());
                }
            }
        }
    }

    /// React `GeneralTab.changeLanguage`: Zustand + `settings.update` language.
    pub fn cycle_language(&mut self) {
        let next = next_choice(LANGUAGES, &self.state.language);
        self.state.language = next.to_string();
        self.state.dir = match next {
            "ar" | "he" | "fa" | "ur" => "rtl".into(),
            _ => "ltr".into(),
        };
        let req = RequestSettingsUpdate {
            settings: vec![RequestSettingsUpdateSettings {
                key: "language".into(),
                value: json!({ "value": next }),
            }],
        };
        if let Err(err) = self.call_value("settings.update", &req) {
            self.record_error(err);
        }
        self.bump_scene();
    }

    /// React `AdvancedPromptSettings.changeMode`. Switching to text seeds the
    /// default block list (`DEFAULT_PROMPT_TEMPLATE`) when none is stored.
    pub fn cycle_prompt_mode(&mut self) {
        let current = self
            .state
            .prompt_template
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("chat");
        let next = if current == "text" { "chat" } else { "text" };
        if let Some(obj) = self.state.prompt_template.as_object_mut() {
            obj.insert("mode".into(), json!(next));
        } else {
            self.state.prompt_template = json!({ "mode": next });
        }
        if next == "text" {
            self.ensure_prompt_template_blocks();
            self.load_prompt_presets_list();
        }
        self.persist_prompt_template();
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.addPrompt`. Inserts a `custom-*` block
    /// before the terminal anchors, persists immediately, and opens the
    /// compact name/content editor.
    pub(crate) fn add_prompt_block(&mut self) {
        self.ensure_prompt_template_blocks();
        let existing = self
            .state
            .prompt_template
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let id = next_custom_prompt_id(&existing);
        let new_block = json!({
            "id": id,
            "enabled": true,
            "name": "New Prompt",
            "role": "system",
            "content": "",
            "injectionPosition": "relative",
            "injectionDepth": 4,
            "injectionOrder": 100,
            "triggers": PROMPT_TRIGGER_IDS,
            "forbidOverrides": false,
        });
        let Some(blocks) = self
            .state
            .prompt_template
            .get_mut("blocks")
            .and_then(Value::as_array_mut)
        else {
            return;
        };
        blocks.push(new_block);
        let ordered = normalize_prompt_block_order(std::mem::take(blocks));
        *blocks = ordered;
        self.state.prompt_block_edit_id = Some(id);
        self.state.prompt_block_name_draft = "New Prompt".into();
        self.state.prompt_block_content_draft.clear();
        self.state.prompt_block_injection_position = "relative".into();
        self.state.prompt_block_depth_draft = "4".into();
        self.state.prompt_block_order_draft = "100".into();
        self.state.prompt_block_role = "system".into();
        self.state.prompt_block_triggers = default_prompt_block_triggers();
        self.state.prompt_block_forbid_overrides = false;
        self.state.prompt_block_model_draft.clear();
        self.persist_prompt_template();
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.removePrompt`. Core (host-owned) ids are
    /// a no-op; unknown custom ids also do not persist.
    pub(crate) fn remove_prompt_block(&mut self, block_id: &str) {
        if PROMPT_BLOCK_IDS.contains(&block_id) {
            return;
        }
        self.ensure_prompt_template_blocks();
        let Some(blocks) = self
            .state
            .prompt_template
            .get_mut("blocks")
            .and_then(Value::as_array_mut)
        else {
            return;
        };
        let before = blocks.len();
        blocks.retain(|block| block.get("id").and_then(Value::as_str) != Some(block_id));
        if blocks.len() == before {
            return;
        }
        let close_editor = self.state.prompt_block_edit_id.as_deref() == Some(block_id);
        if close_editor {
            self.clear_prompt_block_editor_drafts();
        }
        self.persist_prompt_template();
        self.bump_scene();
    }

    /// React `setEditingBlockId` — compact name + content drafts. Unknown
    /// ids are a no-op.
    pub(crate) fn edit_prompt_block(&mut self, block_id: &str) {
        self.ensure_prompt_template_blocks();
        let post_history = self
            .state
            .prompt_template
            .get("postHistoryInstructions")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some(block) = self
            .state
            .prompt_template
            .get("blocks")
            .and_then(Value::as_array)
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
            })
        else {
            return;
        };
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| prompt_block_label(block_id));
        let content = if block_id == "post-history-instructions" {
            post_history
        } else {
            block
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        self.state.prompt_block_edit_id = Some(block_id.to_string());
        self.state.prompt_block_name_draft = name;
        self.state.prompt_block_content_draft = content;
        self.state.prompt_block_injection_position =
            prompt_block_injection_position(block).to_string();
        self.state.prompt_block_depth_draft =
            prompt_block_u32(block, "injectionDepth", 4).to_string();
        self.state.prompt_block_order_draft =
            prompt_block_u32(block, "injectionOrder", 100).to_string();
        self.state.prompt_block_role = prompt_block_role(block).to_string();
        self.state.prompt_block_triggers = prompt_block_triggers(block);
        self.state.prompt_block_forbid_overrides = prompt_block_forbid_overrides(block);
        self.state.prompt_block_model_draft = prompt_block_model(block);
        self.bump_scene();
    }

    pub(crate) fn close_prompt_block_editor(&mut self) {
        self.clear_prompt_block_editor_drafts();
        self.bump_scene();
    }

    pub(crate) fn clear_prompt_block_editor_drafts(&mut self) {
        self.state.prompt_block_edit_id = None;
        self.state.prompt_block_name_draft.clear();
        self.state.prompt_block_content_draft.clear();
        self.state.prompt_block_injection_position.clear();
        self.state.prompt_block_depth_draft.clear();
        self.state.prompt_block_order_draft.clear();
        self.state.prompt_block_role.clear();
        self.state.prompt_block_triggers.clear();
        self.state.prompt_block_forbid_overrides = false;
        self.state.prompt_block_model_draft.clear();
    }

    /// React `injectionPosition` select. Local draft until Save.
    pub(crate) fn cycle_prompt_block_position(&mut self) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        self.state.prompt_block_injection_position =
            if self.state.prompt_block_injection_position == "in-chat" {
                "relative".into()
            } else {
                "in-chat".into()
            };
        self.bump_scene();
    }

    /// React `role` select. Local draft until Save. Unknown stored roles
    /// (`tool` / `plugin`) snap to `system`, matching the authoring menu.
    pub(crate) fn cycle_prompt_block_role(&mut self) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        self.state.prompt_block_role =
            next_choice(PROMPT_BLOCK_ROLES, &self.state.prompt_block_role).to_string();
        self.bump_scene();
    }

    /// React `toggleTrigger`. Local draft until Save. Unknown ids are a
    /// no-op; clearing the last selected chip restores every kind.
    pub(crate) fn toggle_prompt_block_trigger(&mut self, trigger: &str) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        if !PROMPT_TRIGGER_IDS.contains(&trigger) {
            return;
        }
        let mut next = self.state.prompt_block_triggers.clone();
        if next.iter().any(|id| id == trigger) {
            next.retain(|id| id != trigger);
        } else {
            next.push(trigger.to_string());
        }
        if next.is_empty() {
            next = default_prompt_block_triggers();
        }
        self.state.prompt_block_triggers = next;
        self.bump_scene();
    }

    /// React `forbidOverrides` Switch. Local draft until Save. Hidden
    /// unless content is editable and role is `system`.
    pub(crate) fn toggle_prompt_block_forbid_overrides(&mut self) {
        let Some(id) = self.state.prompt_block_edit_id.clone() else {
            return;
        };
        if !prompt_block_content_editable(&id) {
            return;
        }
        if prompt_block_role_draft(&self.state.prompt_block_role) != "system" {
            return;
        }
        self.state.prompt_block_forbid_overrides = !self.state.prompt_block_forbid_overrides;
        self.bump_scene();
    }

    /// React `ModelMenu.onLoadModels`. Kernel plane has no wire discovery.
    pub(crate) fn load_prompt_block_models(&mut self) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        if self.state.active_provider_id.is_none() {
            return;
        }
        self.record_error(ChatRouteError::Product(ErrorDto {
            code: "CAPABILITY_UNAVAILABLE".into(),
            params: json!({ "operationId": "providers.models.discovery" }),
            trace_id: None,
            correlation_id: None,
        }));
        self.bump_scene();
    }

    /// React `PromptBlockEditorDialog` submit: name is required; content is
    /// written only for custom / main-prompt / post-history-instructions.
    pub(crate) fn save_prompt_block_editor(&mut self) {
        let Some(id) = self.state.prompt_block_edit_id.clone() else {
            return;
        };
        let name = self.state.prompt_block_name_draft.trim().to_string();
        if name.is_empty() {
            return;
        }
        let content = self.state.prompt_block_content_draft.clone();
        let editable = prompt_block_content_editable(&id);
        let position = if self.state.prompt_block_injection_position == "in-chat" {
            "in-chat"
        } else {
            "relative"
        };
        let depth = parse_prompt_injection_u32(&self.state.prompt_block_depth_draft, 4);
        let order = parse_prompt_injection_u32(&self.state.prompt_block_order_draft, 100);
        let role = prompt_block_role_draft(&self.state.prompt_block_role);
        let triggers = self
            .state
            .prompt_block_triggers
            .iter()
            .filter(|id| PROMPT_TRIGGER_IDS.contains(&id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        let forbid_overrides = self.state.prompt_block_forbid_overrides;
        let model = clamp_prompt_block_model(self.state.prompt_block_model_draft.trim());
        {
            let Some(block) = self
                .state
                .prompt_template
                .get_mut("blocks")
                .and_then(Value::as_array_mut)
                .and_then(|blocks| {
                    blocks
                        .iter_mut()
                        .find(|block| block.get("id").and_then(Value::as_str) == Some(id.as_str()))
                })
            else {
                return;
            };
            let Some(obj) = block.as_object_mut() else {
                return;
            };
            obj.insert("name".into(), json!(name));
            if editable {
                obj.insert("content".into(), json!(content));
            }
            obj.insert("injectionPosition".into(), json!(position));
            obj.insert("injectionDepth".into(), json!(depth));
            obj.insert("injectionOrder".into(), json!(order));
            obj.insert("role".into(), json!(role));
            obj.insert("triggers".into(), json!(triggers));
            obj.insert("forbidOverrides".into(), json!(forbid_overrides));
            if model.is_empty() {
                obj.remove("model");
            } else {
                obj.insert("model".into(), json!(model));
            }
        }
        if id == "post-history-instructions" {
            if let Some(obj) = self.state.prompt_template.as_object_mut() {
                obj.insert("postHistoryInstructions".into(), json!(content));
            }
        }
        self.clear_prompt_block_editor_drafts();
        self.persist_prompt_template();
        self.bump_scene();
    }

    pub fn set_prompt_block_name_draft(&mut self, value: &str) {
        self.state.prompt_block_name_draft = value.to_string();
        self.bump_scene();
    }

    pub fn set_prompt_block_content_draft(&mut self, value: &str) {
        self.state.prompt_block_content_draft = value.to_string();
        self.bump_scene();
    }

    pub fn set_prompt_block_depth_draft(&mut self, value: &str) {
        self.state.prompt_block_depth_draft = sanitize_prompt_int_draft(value);
        self.bump_scene();
    }

    pub fn set_prompt_block_order_draft(&mut self, value: &str) {
        self.state.prompt_block_order_draft = sanitize_prompt_int_draft(value);
        self.bump_scene();
    }

    /// React `ModelMenu` free-text id. Disabled without an active provider.
    /// Contract maxLength 256.
    pub fn set_prompt_block_model_draft(&mut self, value: &str) {
        if self.state.prompt_block_edit_id.is_none() {
            return;
        }
        if self.state.active_provider_id.is_none() {
            return;
        }
        self.state.prompt_block_model_draft = clamp_prompt_block_model(value);
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.moveBlock(from, from ± 1)`. Terminals,
    /// index 0 going up, and a movable whose next neighbour is a terminal
    /// going down are no-ops (no persist).
    pub(crate) fn move_prompt_block(&mut self, block_id: &str, delta: isize) {
        self.ensure_prompt_template_blocks();
        let Some(blocks) = self
            .state
            .prompt_template
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
        else {
            return;
        };
        let Some(from) = blocks
            .iter()
            .position(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
        else {
            return;
        };
        if is_terminal_prompt_block_id(block_id) {
            return;
        }
        if delta < 0 && from == 0 {
            return;
        }
        let to = from as isize + delta;
        if to < 0 || to >= blocks.len() as isize {
            return;
        }
        let to = to as usize;
        if delta > 0 {
            if let Some(next_id) = blocks
                .get(to)
                .and_then(|block| block.get("id").and_then(Value::as_str))
            {
                if is_terminal_prompt_block_id(next_id) {
                    return;
                }
            }
        }
        let reordered = reorder_prompt_blocks(blocks, from, to);
        let Some(actual) = reordered
            .iter()
            .position(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
        else {
            return;
        };
        if actual == from {
            return;
        }
        let name = reordered
            .get(actual)
            .and_then(|block| block.get("name").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| prompt_block_label(block_id));
        let Some(slots) = self
            .state
            .prompt_template
            .get_mut("blocks")
            .and_then(Value::as_array_mut)
        else {
            return;
        };
        *slots = reordered;
        self.state.status_message = Some(format!("{name} moved to position {}.", actual + 1));
        self.persist_prompt_template();
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.toggleBlock`. Unknown ids are a no-op.
    pub(crate) fn toggle_prompt_block(&mut self, block_id: &str) {
        self.ensure_prompt_template_blocks();
        {
            let Some(blocks) = self
                .state
                .prompt_template
                .get_mut("blocks")
                .and_then(Value::as_array_mut)
            else {
                return;
            };
            let Some(block) = blocks
                .iter_mut()
                .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
            else {
                return;
            };
            let enabled = block
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let Some(obj) = block.as_object_mut() else {
                return;
            };
            obj.insert("enabled".into(), json!(!enabled));
        }
        self.persist_prompt_template();
        self.bump_scene();
    }

    pub(crate) fn ensure_prompt_template_blocks(&mut self) {
        let has_blocks = self
            .state
            .prompt_template
            .get("blocks")
            .and_then(Value::as_array)
            .is_some_and(|blocks| !blocks.is_empty());
        if has_blocks {
            return;
        }
        let mode = self
            .state
            .prompt_template
            .get("mode")
            .cloned()
            .unwrap_or_else(|| json!("chat"));
        let mut template = default_prompt_template();
        if let Some(obj) = template.as_object_mut() {
            obj.insert("mode".into(), mode);
        }
        self.state.prompt_template = template;
    }

    pub(crate) fn persist_prompt_template(&mut self) {
        let req = RequestSettingsUpdate {
            settings: vec![RequestSettingsUpdateSettings {
                key: "prompt-template".into(),
                value: self.state.prompt_template.clone(),
            }],
        };
        if let Err(err) = self.call_value("settings.update", &req) {
            self.record_error(err);
            self.state.instruct_form_error = Some(
                self.state
                    .last_error
                    .as_ref()
                    .map(|e| e.code.clone())
                    .unwrap_or_else(|| "SETTINGS_UPDATE_FAILED".into()),
            );
        } else {
            self.state.instruct_form_error = None;
        }
    }

    pub(crate) fn load_prompt_presets_list(&mut self) {
        match self.call_decode(
            "presets.list",
            &RequestListPresets {
                kind: Some("prompt-template".into()),
            },
            decode_result_list_presets,
        ) {
            Ok(ResultListPresets { items }) => self.state.prompt_presets = items,
            Err(err) => self.record_error(err),
        }
    }

    pub(crate) fn active_prompt_preset(&self) -> Option<&PresetDto> {
        let id = self.state.active_prompt_preset_id.as_deref()?;
        self.state.prompt_presets.iter().find(|item| item.id == id)
    }

    pub(crate) fn persist_prompt_template_and_active(&mut self, active_id: Option<String>) {
        self.state.active_prompt_preset_id = active_id.clone();
        let req = RequestSettingsUpdate {
            settings: vec![
                RequestSettingsUpdateSettings {
                    key: "prompt-template".into(),
                    value: self.state.prompt_template.clone(),
                },
                RequestSettingsUpdateSettings {
                    key: "active-prompt-template-preset-id".into(),
                    value: json!({ "value": active_id }),
                },
            ],
        };
        if let Err(err) = self.call_value("settings.update", &req) {
            self.record_error(err);
            self.state.instruct_form_error = Some(
                self.state
                    .last_error
                    .as_ref()
                    .map(|e| e.code.clone())
                    .unwrap_or_else(|| "SETTINGS_UPDATE_FAILED".into()),
            );
        } else {
            self.state.instruct_form_error = None;
        }
    }

    /// React `PromptTemplateEditor.selectPreset` (native cycle through
    /// Unsaved → each `presets.list` row).
    pub(crate) fn cycle_prompt_preset(&mut self) {
        self.ensure_prompt_template_blocks();
        let mut ids: Vec<Option<String>> = vec![None];
        ids.extend(
            self.state
                .prompt_presets
                .iter()
                .map(|item| Some(item.id.clone())),
        );
        if ids.len() == 1 {
            return;
        }
        let current = self.state.active_prompt_preset_id.clone();
        let idx = ids.iter().position(|id| *id == current).unwrap_or(0);
        let next = ids[(idx + 1) % ids.len()].clone();
        match next {
            None => self.persist_prompt_template_and_active(None),
            Some(id) => self.apply_prompt_preset(&id),
        }
        self.bump_scene();
    }

    pub(crate) fn apply_prompt_preset(&mut self, preset_id: &str) {
        let Some(preset) = self
            .state
            .prompt_presets
            .iter()
            .find(|item| item.id == preset_id)
            .cloned()
        else {
            self.record_error(ChatRouteError::Product(ErrorDto {
                code: "PRESET_NOT_FOUND".into(),
                params: json!({ "presetId": preset_id }),
                trace_id: None,
                correlation_id: None,
            }));
            return;
        };
        if !prompt_template_is_complete(&preset.data) {
            self.state.instruct_form_error = Some(INVALID_PROMPT_TEMPLATE_PRESET.to_string());
            return;
        }
        let mut next = preset.data.clone();
        if let Some(obj) = next.as_object_mut() {
            obj.insert("mode".into(), json!("text"));
        }
        self.state.prompt_template = next;
        self.persist_prompt_template_and_active(Some(preset.id));
    }

    /// React `PromptTemplateEditor.savePreset`: update the active record, or
    /// open the name dialog to create one.
    pub(crate) fn save_prompt_preset(&mut self) {
        self.ensure_prompt_template_blocks();
        let Some(active) = self.active_prompt_preset().cloned() else {
            self.begin_preset_dialog("prompt-template", "create", String::new());
            return;
        };
        let req = RequestUpdatePreset {
            preset_id: active.id.clone(),
            name: None,
            data: Some(self.state.prompt_template.clone()),
        };
        match self.call_decode("presets.update", &req, decode_preset_dto) {
            Ok(_) => {
                self.persist_prompt_template_and_active(Some(active.id));
                self.load_prompt_presets_list();
                self.state.status_message = Some("Preset saved.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// React `PromptTemplateEditor.exportPreset`: host-owned JSON envelope
    /// (no wire op). Parks in `last_export` for the desktop file sink.
    pub(crate) fn export_prompt_template(&mut self) {
        self.ensure_prompt_template_blocks();
        let name = self
            .active_prompt_preset()
            .map(|item| item.name.as_str())
            .unwrap_or("prompt");
        let filename = json_export_filename(
            self.active_prompt_preset()
                .map(|item| item.name.as_str())
                .unwrap_or("prompt-template"),
            "prompt-template",
        );
        let payload = json!({
            "version": 1,
            "kind": "prompt-template",
            "name": name,
            "data": self.state.prompt_template.clone(),
        });
        match serde_json::to_vec_pretty(&payload) {
            Ok(bytes) => {
                self.state.last_export = Some(LastExport {
                    filename: filename.clone(),
                    bytes,
                });
                self.state.status_message = Some(format!("Export ready: {filename}."));
                self.state.instruct_form_error = None;
            }
            Err(_) => {
                self.state.instruct_form_error = Some(INVALID_PROMPT_TEMPLATE_PRESET.to_string());
            }
        }
        self.bump_scene();
    }

    pub(crate) fn open_prompt_template_import(&mut self) {
        if self.state.prompt_template_import_open {
            return;
        }
        self.state.card_import_dialog_open = false;
        self.state.generation_preset_import_open = false;
        self.state.prompt_template_path_draft.clear();
        self.state.prompt_template_import_open = true;
        self.bump_scene();
    }

    pub(crate) fn close_prompt_template_import(&mut self) {
        self.state.prompt_template_import_open = false;
        self.state.prompt_template_path_draft.clear();
        self.bump_scene();
    }

    pub fn set_prompt_template_path_draft(&mut self, draft: &str) {
        if self.state.prompt_template_import_open {
            self.state.prompt_template_path_draft = draft.to_string();
            self.bump_scene();
        }
    }

    /// React `PromptTemplateEditor.importPreset`: read JSON from a host path,
    /// validate the 12 host-owned ids, then `presets.create` +
    /// `settings.update` (`prompt-template` + active id).
    pub(crate) fn confirm_prompt_template_import(&mut self) {
        let path = self.state.prompt_template_path_draft.trim().to_string();
        if path.is_empty() {
            self.state.status_message =
                Some("Provide a prompt template JSON file from this device.".into());
            self.bump_scene();
            return;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => {
                self.state.status_message = Some(format!("Cannot read {path}: {err}"));
                self.bump_scene();
                return;
            }
        };
        let fallback_name = std::path::Path::new(&path)
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "prompt-template".into());
        let Some((name, next)) = parse_prompt_template_import(&bytes, &fallback_name) else {
            self.state.instruct_form_error = Some(INVALID_PROMPT_TEMPLATE_PRESET.to_string());
            self.bump_scene();
            return;
        };
        let req = RequestCreatePreset {
            kind: "prompt-template".into(),
            name: name.clone(),
            data: Some(next.clone()),
        };
        match self.call_decode("presets.create", &req, decode_preset_dto) {
            Ok(dto) => {
                self.state.prompt_template = next;
                self.persist_prompt_template_and_active(Some(dto.id));
                self.load_prompt_presets_list();
                self.close_prompt_template_import();
                self.state.instruct_form_error = None;
                self.state.status_message = Some(format!("Imported {name}."));
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.instruct_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    pub(crate) fn open_prompt_preset_rename(&mut self) {
        let Some(name) = self.active_prompt_preset().map(|item| item.name.clone()) else {
            return;
        };
        self.begin_preset_dialog("prompt-template", "rename", name);
    }

    pub(crate) fn open_prompt_preset_duplicate(&mut self) {
        self.ensure_prompt_template_blocks();
        let base = self
            .active_prompt_preset()
            .map(|item| item.name.as_str())
            .unwrap_or("Prompt template preset");
        self.begin_preset_dialog("prompt-template", "duplicate", format!("{base} copy"));
    }

    pub(crate) fn open_prompt_preset_delete(&mut self) {
        if self.active_prompt_preset().is_none() {
            return;
        }
        self.state.preset_dialog_kind = "prompt-template".into();
        self.state.preset_delete_open = true;
        self.bump_scene();
    }

    pub(crate) fn begin_preset_dialog(&mut self, kind: &str, mode: &str, draft: String) {
        self.state.preset_dialog_kind = kind.to_string();
        self.state.preset_name_dialog_open = true;
        self.state.preset_name_mode = Some(mode.to_string());
        self.state.preset_name_draft = draft;
        self.state.preset_form_error = None;
        self.bump_scene();
    }

    pub(crate) fn confirm_prompt_preset_name(&mut self, name: String, mode: &str) {
        let outcome = if mode == "rename" {
            match self.active_prompt_preset().cloned() {
                Some(active) => {
                    let req = RequestUpdatePreset {
                        preset_id: active.id,
                        name: Some(name),
                        data: None,
                    };
                    self.call_decode("presets.update", &req, decode_preset_dto)
                        .map(|_| ())
                }
                None => Ok(()),
            }
        } else {
            self.ensure_prompt_template_blocks();
            let req = RequestCreatePreset {
                kind: "prompt-template".into(),
                name,
                data: Some(self.state.prompt_template.clone()),
            };
            self.call_decode("presets.create", &req, decode_preset_dto)
                .map(|dto| {
                    self.persist_prompt_template_and_active(Some(dto.id));
                })
        };
        match outcome {
            Ok(_) => {
                self.close_preset_name();
                self.load_prompt_presets_list();
                self.state.status_message = Some(if mode == "rename" {
                    "Preset renamed.".into()
                } else if mode == "duplicate" {
                    "Preset duplicated.".into()
                } else {
                    "Preset created.".into()
                });
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.preset_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    pub(crate) fn confirm_prompt_preset_delete(&mut self) {
        let Some(active) = self.active_prompt_preset().cloned() else {
            return;
        };
        self.state.preset_delete_open = false;
        let req = RequestDeletePreset {
            preset_id: active.id,
        };
        match self.call_value("presets.delete", &req) {
            Ok(_) => {
                self.state.active_prompt_preset_id = None;
                let clear = RequestSettingsUpdate {
                    settings: vec![RequestSettingsUpdateSettings {
                        key: "active-prompt-template-preset-id".into(),
                        value: json!({ "value": null }),
                    }],
                };
                if let Err(err) = self.call_value("settings.update", &clear) {
                    self.record_error(err);
                }
                self.state.status_message = Some("Preset deleted.".into());
                self.load_prompt_presets_list();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// React `ChatTemplateEditor.changeSelection`. Custom is local until save;
    /// native writes `instruct-format` / `instruct-format-id` null.
    pub fn cycle_instruct_selection(&mut self) {
        if self.state.instruct_selection == "custom" {
            self.apply_instruct_native();
            return;
        }
        self.state.instruct_selection = "custom".into();
        if self.state.instruct_format.is_none() {
            self.state.instruct_format = Some(default_custom_instruct());
        }
        self.state.instruct_form_error = None;
        self.bump_scene();
    }

    pub(crate) fn apply_instruct_native(&mut self) {
        let req = RequestSettingsUpdate {
            settings: vec![
                RequestSettingsUpdateSettings {
                    key: "instruct-format".into(),
                    value: json!({ "value": Value::Null }),
                },
                RequestSettingsUpdateSettings {
                    key: "instruct-format-id".into(),
                    value: json!({ "value": Value::Null }),
                },
            ],
        };
        match self.call_value("settings.update", &req) {
            Ok(_) => {
                self.state.instruct_selection = "native".into();
                self.state.instruct_format = None;
                self.state.instruct_format_id = None;
                self.state.instruct_form_error = None;
            }
            Err(err) => {
                self.state.instruct_form_error = Some(err.reason_code());
                self.record_error(err);
            }
        }
        self.bump_scene();
    }

    /// React `ChatTemplateEditor.save`.
    pub fn save_instruct_template(&mut self) {
        let draft = self
            .state
            .instruct_format
            .clone()
            .unwrap_or_else(default_custom_instruct);
        let req = RequestSettingsUpdate {
            settings: vec![
                RequestSettingsUpdateSettings {
                    key: "instruct-format".into(),
                    value: draft.clone(),
                },
                RequestSettingsUpdateSettings {
                    key: "instruct-format-id".into(),
                    value: json!({ "value": Value::Null }),
                },
            ],
        };
        match self.call_value("settings.update", &req) {
            Ok(_) => {
                self.state.instruct_format = Some(draft);
                self.state.instruct_selection = "custom".into();
                self.state.instruct_format_id = None;
                self.state.instruct_form_error = None;
            }
            Err(err) => {
                self.state.instruct_form_error = Some(err.reason_code());
                self.record_error(err);
            }
        }
        self.bump_scene();
    }

    /// React `ChatTemplateEditor` textarea onChange. Local until Save.
    /// `role` is a ChatML key (`system` / `user` / `assistant` / `tool` /
    /// `promptSuffix` / `stopStrings`).
    pub fn set_instruct_role(&mut self, role: &str, value: &str) {
        let mut draft = self
            .state
            .instruct_format
            .clone()
            .unwrap_or_else(default_custom_instruct);
        match role {
            "stopStrings" => {
                let stops: Vec<Value> = value
                    .split('\n')
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(Value::from)
                    .collect();
                if let Some(obj) = draft.as_object_mut() {
                    obj.insert("stopStrings".into(), Value::Array(stops));
                }
            }
            "system" | "user" | "assistant" | "tool" | "promptSuffix" => {
                if let Some(obj) = draft.as_object_mut() {
                    obj.insert(role.to_string(), Value::from(value));
                }
            }
            _ => return,
        }
        self.state.instruct_format = Some(draft);
        self.state.instruct_form_error = None;
        self.bump_scene();
    }
}
