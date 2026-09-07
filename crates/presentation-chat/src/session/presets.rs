//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    /// Selects a provider card (`settings.update` key `activeProviderConfigId`,
    /// React `ProviderProfileEditor` Connect flow persistence).
    pub fn select_provider(&mut self, id: &str) {
        self.state.active_provider_id = Some(id.to_string());
        let req = RequestSettingsUpdate {
            settings: vec![RequestSettingsUpdateSettings {
                key: "activeProviderConfigId".into(),
                value: json!(id),
            }],
        };
        match self.call_value("settings.update", &req) {
            Ok(_) => {
                self.state.status_message = Some("Provider selected.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Selects a generation preset card (`settings.update` key
    /// `activeGenerationPresetId`, React `GenerationPresetEditor`). Like
    /// React `selectPreset`, the preset values are applied too:
    /// maxContextTokens + generationDefaults ride the same settings.update.
    pub fn select_preset(&mut self, id: &str) {
        self.state.active_preset_id = Some(id.to_string());
        if let Some(preset) = self.state.presets.iter().find(|item| item.id == id) {
            let parsed: PresetGenerationData =
                serde_json::from_value(preset.data.clone()).unwrap_or_default();
            self.state.preset_draft_max_context = parsed.max_context_tokens;
            self.state.preset_draft_defaults =
                serde_json::to_value(&parsed.generation_defaults).unwrap_or_else(|_| json!({}));
            self.state.preset_unlocked_context =
                parsed.max_context_tokens > CONTEXT_TOKEN_DEFAULT_MAX;
            self.state.preset_draft_dirty = false;
            self.clear_preset_value_edit();
            let req = RequestSettingsUpdate {
                settings: vec![
                    RequestSettingsUpdateSettings {
                        key: "activeGenerationPresetId".into(),
                        value: json!(id),
                    },
                    RequestSettingsUpdateSettings {
                        key: "maxContextTokens".into(),
                        value: json!(parsed.max_context_tokens),
                    },
                    RequestSettingsUpdateSettings {
                        key: "generationDefaults".into(),
                        value: serde_json::to_value(&parsed.generation_defaults)
                            .unwrap_or_else(|_| json!({})),
                    },
                ],
            };
            match self.call_value("settings.update", &req) {
                Ok(_) => {
                    self.state.status_message = Some("Preset selected.".into());
                }
                Err(err) => self.record_error(err),
            }
        } else {
            self.state.status_message = Some("Preset selected.".into());
        }
        self.bump_scene();
    }

    /// Applies the current draft (`settings.update` maxContextTokens +
    /// generationDefaults + activeGenerationPresetId; React `applyDraft`).
    pub fn apply_preset_draft(&mut self) {
        self.commit_preset_value_edit();
        let defaults = self.state.preset_draft_defaults.clone();
        let req = RequestSettingsUpdate {
            settings: vec![
                RequestSettingsUpdateSettings {
                    key: "maxContextTokens".into(),
                    value: json!(self.state.preset_draft_max_context),
                },
                RequestSettingsUpdateSettings {
                    key: "generationDefaults".into(),
                    value: defaults,
                },
                RequestSettingsUpdateSettings {
                    key: "activeGenerationPresetId".into(),
                    value: json!(self.state.active_preset_id.clone()),
                },
            ],
        };
        match self.call_value("settings.update", &req) {
            Ok(_) => {
                self.state.preset_draft_dirty = false;
                self.state.status_message = Some("Generation settings applied.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// React `GenerationPresetEditor.exportPreset`: host-owned JSON envelope
    /// (no wire op). Parks the live draft in `last_export`.
    pub(crate) fn export_generation_preset(&mut self) {
        let name = self
            .active_preset()
            .map(|item| item.name.as_str())
            .unwrap_or("generation");
        let filename = json_export_filename(name, "generation");
        let payload = json!({
            "version": 1,
            "kind": "generation",
            "name": name,
            "data": self.generation_preset_draft_json(),
        });
        match serde_json::to_vec_pretty(&payload) {
            Ok(bytes) => {
                self.state.last_export = Some(LastExport {
                    filename: filename.clone(),
                    bytes,
                });
                self.state.status_message = Some(format!("Export ready: {filename}."));
                self.state.preset_form_error = None;
            }
            Err(_) => {
                self.state.preset_form_error = Some(INVALID_GENERATION_PRESET.to_string());
            }
        }
        self.bump_scene();
    }

    pub(crate) fn open_generation_preset_import(&mut self) {
        if self.state.generation_preset_import_open {
            return;
        }
        self.state.card_import_dialog_open = false;
        self.state.prompt_template_import_open = false;
        self.state.generation_preset_path_draft.clear();
        self.state.generation_preset_import_open = true;
        self.bump_scene();
    }

    pub(crate) fn close_generation_preset_import(&mut self) {
        self.state.generation_preset_import_open = false;
        self.state.generation_preset_path_draft.clear();
        self.bump_scene();
    }

    pub fn set_generation_preset_path_draft(&mut self, draft: &str) {
        if self.state.generation_preset_import_open {
            self.state.generation_preset_path_draft = draft.to_string();
            self.bump_scene();
        }
    }

    /// React `GenerationPresetEditor.importPreset`: read JSON from a host
    /// path, validate `GenerationPresetData`, then `presets.create` +
    /// `settings.update` (`activeGenerationPresetId` + sampler keys).
    pub(crate) fn confirm_generation_preset_import(&mut self) {
        let path = self.state.generation_preset_path_draft.trim().to_string();
        if path.is_empty() {
            self.state.status_message =
                Some("Provide a generation preset JSON file from this device.".into());
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
            .unwrap_or_else(|| "generation".into());
        let Some((name, data)) = parse_generation_preset_import(&bytes, &fallback_name) else {
            self.state.preset_form_error = Some(INVALID_GENERATION_PRESET.to_string());
            self.bump_scene();
            return;
        };
        let parsed: PresetGenerationData = serde_json::from_value(data.clone()).unwrap_or_default();
        let req = RequestCreatePreset {
            kind: "generation".into(),
            name: name.clone(),
            data: Some(data),
        };
        match self.call_decode("presets.create", &req, decode_preset_dto) {
            Ok(dto) => {
                self.state.preset_draft_max_context = parsed.max_context_tokens;
                self.state.preset_draft_defaults =
                    serde_json::to_value(&parsed.generation_defaults).unwrap_or_else(|_| json!({}));
                self.state.preset_unlocked_context =
                    parsed.max_context_tokens > CONTEXT_TOKEN_DEFAULT_MAX;
                self.state.preset_draft_dirty = false;
                self.clear_preset_value_edit();
                let apply = RequestSettingsUpdate {
                    settings: vec![
                        RequestSettingsUpdateSettings {
                            key: "activeGenerationPresetId".into(),
                            value: json!(dto.id.clone()),
                        },
                        RequestSettingsUpdateSettings {
                            key: "maxContextTokens".into(),
                            value: json!(parsed.max_context_tokens),
                        },
                        RequestSettingsUpdateSettings {
                            key: "generationDefaults".into(),
                            value: serde_json::to_value(&parsed.generation_defaults)
                                .unwrap_or_else(|_| json!({})),
                        },
                    ],
                };
                if let Err(err) = self.call_value("settings.update", &apply) {
                    self.record_error(err);
                    self.bump_scene();
                    return;
                }
                self.state.active_preset_id = Some(dto.id);
                self.load_presets_list();
                self.close_generation_preset_import();
                self.state.preset_form_error = None;
                self.state.status_message = Some(format!("Imported {name}."));
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.preset_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    pub(crate) fn generation_preset_draft_json(&self) -> Value {
        json!({
            "maxContextTokens": self.state.preset_draft_max_context,
            "generationDefaults": self.state.preset_draft_defaults,
        })
    }

    pub(crate) fn clear_preset_value_edit(&mut self) {
        self.state.preset_edit_key = None;
        self.state.preset_edit_text.clear();
    }

    pub(crate) fn toggle_preset_unlock(&mut self) {
        self.commit_preset_value_edit();
        let next = !self.state.preset_unlocked_context;
        self.state.preset_unlocked_context = next;
        if !next && self.state.preset_draft_max_context > CONTEXT_TOKEN_DEFAULT_MAX {
            self.state.preset_draft_max_context = CONTEXT_TOKEN_DEFAULT_MAX;
        }
        self.state.preset_draft_dirty = true;
        self.bump_scene();
    }

    pub(crate) fn focus_preset_value(&mut self, id: &str) {
        if self.state.preset_edit_key.as_deref() == Some(id) {
            return;
        }
        self.commit_preset_value_edit();
        let formatted = self.formatted_preset_value(id);
        self.state.preset_edit_key = Some(id.to_string());
        self.state.preset_edit_text = formatted;
        self.bump_scene();
    }

    pub(crate) fn toggle_preset_flag(&mut self, id: &str) {
        self.commit_preset_value_edit();
        let parsed = self.parsed_preset_defaults();
        let current = match id {
            "reasoning" => parsed.reasoning,
            "stream" => parsed.stream,
            _ => return,
        };
        self.ensure_preset_defaults_object()
            .insert(id.to_string(), json!(!current));
        self.state.preset_draft_dirty = true;
        self.bump_scene();
    }

    /// Keyboard input into the focused sampler number field.
    pub fn set_preset_value_draft(&mut self, value: &str) {
        let Some(id) = self.state.preset_edit_key.clone() else {
            return;
        };
        self.state.preset_edit_text = value.to_string();
        if let Some(parsed) = parse_sampler_number(value) {
            self.assign_preset_number(&id, parsed);
            self.state.preset_draft_dirty = true;
        }
        self.bump_scene();
    }

    pub(crate) fn commit_preset_value_edit(&mut self) {
        let Some(id) = self.state.preset_edit_key.clone() else {
            return;
        };
        let text = self.state.preset_edit_text.clone();
        if let Some(parsed) = parse_sampler_number(&text) {
            self.assign_preset_number(&id, parsed);
            self.state.preset_draft_dirty = true;
        }
        self.clear_preset_value_edit();
    }

    pub(crate) fn formatted_preset_value(&self, id: &str) -> String {
        if id == "maxContextTokens" {
            return self.state.preset_draft_max_context.to_string();
        }
        let defaults = self.parsed_preset_defaults();
        let (value, integer) = match id {
            "maxTokens" => (defaults.max_tokens, true),
            "temperature" => (defaults.temperature, false),
            "topP" => (defaults.top_p, false),
            "topK" => (defaults.top_k, true),
            "minP" => (defaults.min_p, false),
            "topA" => (defaults.top_a, false),
            "repetitionPenalty" => (defaults.repetition_penalty, false),
            "frequencyPenalty" => (defaults.frequency_penalty, false),
            "presencePenalty" => (defaults.presence_penalty, false),
            "seed" => (defaults.seed, true),
            _ => return String::new(),
        };
        format_sampler_number(value, integer)
    }

    pub(crate) fn assign_preset_number(&mut self, id: &str, raw: f64) {
        let clamped = clamp_sampler_number(id, raw, self.state.preset_unlocked_context);
        if id == "maxContextTokens" {
            self.state.preset_draft_max_context = clamped.round() as i64;
            return;
        }
        let integer = sampler_bound(id)
            .map(|bound| bound.integer)
            .unwrap_or(false);
        let stored = if integer {
            json!(clamped.round() as i64)
        } else {
            json!(clamped)
        };
        self.ensure_preset_defaults_object()
            .insert(id.to_string(), stored);
    }

    pub(crate) fn ensure_preset_defaults_object(&mut self) -> &mut serde_json::Map<String, Value> {
        if !self.state.preset_draft_defaults.is_object() {
            self.state.preset_draft_defaults =
                serde_json::to_value(PresetGenerationDefaults::default())
                    .unwrap_or_else(|_| json!({}));
        }
        self.state
            .preset_draft_defaults
            .as_object_mut()
            .expect("generationDefaults object")
    }

    pub fn set_preset_name_draft(&mut self, value: &str) {
        self.state.preset_name_draft = value.to_string();
        self.bump_scene();
    }

    /// Opens the name dialog in create mode ("Save as new").
    pub fn open_preset_create(&mut self) {
        self.begin_preset_dialog("generation", "create", String::new());
    }

    /// Opens the name dialog in rename mode prefilled with the active name.
    pub fn open_preset_rename(&mut self) {
        let active_name = self.active_preset().map(|item| item.name.clone());
        let Some(active_name) = active_name else {
            return;
        };
        self.begin_preset_dialog("generation", "rename", active_name);
    }

    pub fn close_preset_name(&mut self) {
        self.state.preset_name_dialog_open = false;
        self.state.preset_name_mode = None;
        self.state.preset_name_draft.clear();
        self.bump_scene();
    }

    pub fn close_preset_delete(&mut self) {
        self.state.preset_delete_open = false;
        self.bump_scene();
    }

    pub(crate) fn active_preset(&self) -> Option<&PresetDto> {
        let id = self.state.active_preset_id.as_deref()?;
        self.state.presets.iter().find(|item| item.id == id)
    }

    pub(crate) fn load_presets_list(&mut self) {
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

    /// Confirms the name dialog: create ("Save as new") or rename, mirroring
    /// React `submitNameAction`. An empty name stays client-side.
    pub fn confirm_preset_name(&mut self) {
        let name = self.state.preset_name_draft.trim().to_string();
        if name.is_empty() || self.state.preset_name_mode.is_none() {
            self.state.preset_form_error = Some("REQUIRED".into());
            self.bump_scene();
            return;
        }
        let mode = self.state.preset_name_mode.clone().unwrap_or_default();
        if self.state.preset_dialog_kind == "prompt-template" {
            self.confirm_prompt_preset_name(name, &mode);
            return;
        }
        let outcome = if mode == "rename" {
            match self.active_preset().cloned() {
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
            let req = RequestCreatePreset {
                kind: "generation".into(),
                name,
                data: Some(self.generation_preset_draft_json()),
            };
            self.call_decode("presets.create", &req, decode_preset_dto)
                .map(|dto| dto.id)
                .and_then(|id| {
                    // A created preset becomes the active one, exactly like
                    // React `submitNameAction`.
                    let req = RequestSettingsUpdate {
                        settings: vec![RequestSettingsUpdateSettings {
                            key: "activeGenerationPresetId".into(),
                            value: json!(id.clone()),
                        }],
                    };
                    self.state.active_preset_id = Some(id);
                    self.call_value("settings.update", &req).map(|_| ())
                })
        };
        match outcome {
            Ok(_) => {
                let was_create = mode != "rename";
                self.close_preset_name();
                self.load_presets_list();
                if was_create {
                    self.state.status_message = Some("Preset created.".into());
                } else {
                    self.state.status_message = Some("Preset renamed.".into());
                }
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.preset_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    /// Duplicates the active preset as "<name> (copy)" and selects it
    /// (React duplicate flow).
    pub fn duplicate_preset(&mut self) {
        let (name, data) = match self.active_preset() {
            Some(active) => (
                format!("{} (copy)", active.name),
                self.generation_preset_draft_json(),
            ),
            None => (
                "generation (copy)".to_string(),
                self.generation_preset_draft_json(),
            ),
        };
        let req = RequestCreatePreset {
            kind: "generation".into(),
            name,
            data: Some(data),
        };
        match self.call_decode("presets.create", &req, decode_preset_dto) {
            Ok(dto) => {
                let sel = RequestSettingsUpdate {
                    settings: vec![RequestSettingsUpdateSettings {
                        key: "activeGenerationPresetId".into(),
                        value: json!(dto.id.clone()),
                    }],
                };
                let _ = self.call_value("settings.update", &sel);
                self.state.active_preset_id = Some(dto.id);
                self.state.status_message = Some("Preset duplicated.".into());
                self.load_presets_list();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn open_preset_delete(&mut self) {
        if self.active_preset().is_some() {
            self.state.preset_dialog_kind = "generation".into();
            self.state.preset_delete_open = true;
            self.bump_scene();
        }
    }

    /// Deletes the active preset and clears the selection
    /// (React `confirmDelete`).
    pub fn confirm_preset_delete(&mut self) {
        if self.state.preset_dialog_kind == "prompt-template" {
            self.confirm_prompt_preset_delete();
            return;
        }
        let Some(active) = self.active_preset().cloned() else {
            return;
        };
        self.state.preset_delete_open = false;
        let req = RequestDeletePreset {
            preset_id: active.id,
        };
        match self.call_value("presets.delete", &req) {
            Ok(_) => {
                let clear = RequestSettingsUpdate {
                    settings: vec![RequestSettingsUpdateSettings {
                        key: "activeGenerationPresetId".into(),
                        value: Value::Null,
                    }],
                };
                let _ = self.call_value("settings.update", &clear);
                self.state.active_preset_id = None;
                self.state.status_message = Some("Preset deleted.".into());
                self.load_presets_list();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Reads provider connection profiles (`providers.config.list`; React
    /// `useProviders` on the kernel plane).
    pub fn load_provider_configs(&mut self) {
        match self.call_decode(
            "providers.config.list",
            &RequestListProviderConfigs { provider: None },
            decode_result_list_provider_configs,
        ) {
            Ok(result) => self.state.provider_configs = result.items,
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub(crate) fn reload_provider_configs(&mut self) {
        match self.call_decode(
            "providers.config.list",
            &RequestListProviderConfigs { provider: None },
            decode_result_list_provider_configs,
        ) {
            Ok(result) => self.state.provider_configs = result.items,
            Err(err) => self.record_error(err),
        }
    }

    pub fn set_provider_name_draft(&mut self, value: &str) {
        self.state.provider_name_draft = value.to_string();
        self.bump_scene();
    }

    /// Cycles the adapter kind for the new-profile dialog (React uses a
    /// `<select>` over the catalog; the catalog op is UnsupportedError on the
    /// kernel plane, so this plane cycles the registered adapters).
    pub fn cycle_provider_kind(&mut self) {
        if !self.state.providers.is_empty() {
            self.state.provider_kind_index =
                (self.state.provider_kind_index + 1) % self.state.providers.len();
        }
        self.bump_scene();
    }

    pub fn open_provider_create(&mut self) {
        self.state.provider_create_dialog_open = true;
        self.state.provider_name_draft.clear();
        self.state.provider_form_error = None;
        self.bump_scene();
    }

    pub fn close_provider_create(&mut self) {
        self.state.provider_create_dialog_open = false;
        self.state.provider_name_draft.clear();
        self.bump_scene();
    }

    /// Confirms the new-profile dialog (`providers.config.set` upsert keyed
    /// by provider + name), then selects the profile — React saves and sets
    /// `activeProviderConfigId`. API keys stay host-side (SecretStore); a
    /// profile without a key is created without one.
    pub fn confirm_provider_create(&mut self) {
        let name = self.state.provider_name_draft.trim().to_string();
        if name.is_empty() {
            self.state.provider_form_error = Some("REQUIRED".into());
            self.bump_scene();
            return;
        }
        let kind = self
            .state
            .providers
            .get(self.state.provider_kind_index)
            .map(|item| item.id.clone())
            .unwrap_or_else(|| "fake".into());
        let req = RequestSetProviderConfig {
            provider: kind.clone(),
            name: name.clone(),
            config: None,
            api_key: None,
        };
        match self.call_decode("providers.config.set", &req, decode_provider_config_dto) {
            Ok(dto) => {
                let sel = RequestSettingsUpdate {
                    settings: vec![RequestSettingsUpdateSettings {
                        key: "activeProviderConfigId".into(),
                        value: json!(dto.id.clone()),
                    }],
                };
                let _ = self.call_value("settings.update", &sel);
                self.state.active_provider_id = Some(dto.id);
                self.close_provider_create();
                self.reload_provider_configs();
                self.state.status_message = Some("Profile saved.".into());
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.provider_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    pub fn open_provider_delete(&mut self, id: &str) {
        if self.state.provider_configs.iter().any(|item| item.id == id) {
            self.state.provider_delete_target_id = Some(id.to_string());
            self.bump_scene();
        }
    }

    pub fn close_provider_delete(&mut self) {
        self.state.provider_delete_target_id = None;
        self.bump_scene();
    }

    /// Deletes a profile (`providers.config.delete`, keyed by provider +
    /// name). Deleting the active profile clears the selection.
    pub fn confirm_provider_delete(&mut self) {
        let Some(id) = self.state.provider_delete_target_id.take() else {
            return;
        };
        let Some(dto) = self
            .state
            .provider_configs
            .iter()
            .find(|item| item.id == id)
        else {
            return;
        };
        let was_active = self.state.active_provider_id.as_deref() == Some(id.as_str());
        let req = RequestDeleteProviderConfig {
            provider: dto.provider.clone(),
            name: dto.name.clone(),
        };
        match self.call_value("providers.config.delete", &req) {
            Ok(_) => {
                if was_active {
                    let clear = RequestSettingsUpdate {
                        settings: vec![RequestSettingsUpdateSettings {
                            key: "activeProviderConfigId".into(),
                            value: Value::Null,
                        }],
                    };
                    let _ = self.call_value("settings.update", &clear);
                    self.state.active_provider_id = None;
                }
                self.reload_provider_configs();
                self.state.status_message = Some("Profile deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }
}
