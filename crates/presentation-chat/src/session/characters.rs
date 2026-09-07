//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    pub fn set_create_description(&mut self, value: &str) {
        self.state.create_description = value.to_string();
        self.bump_scene();
    }

    pub fn set_create_first_message(&mut self, value: &str) {
        self.state.create_first_message = value.to_string();
        self.bump_scene();
    }

    /// Create a character via `characters.create` and refresh the list.
    pub fn confirm_create_character(&mut self) {
        let name = self.state.create_name.trim().to_string();
        if name.is_empty() {
            self.record_error(ChatRouteError::product(
                "CHARACTER_NAME_REQUIRED",
                json!({ "field": "name" }),
            ));
            return;
        }
        let description = if self.state.create_description.trim().is_empty() {
            None
        } else {
            Some(self.state.create_description.clone())
        };
        let req = RequestCreateCharacter {
            name,
            description,
            tags: None,
            avatar_asset_id: None,
            profile_id: None,
        };
        match self.call_decode("characters.create", &req, decode_character_dto) {
            Ok(created) => {
                self.state.create_dialog_open = false;
                self.state.create_name.clear();
                self.state.create_description.clear();
                self.state.create_first_message.clear();
                self.state.selected_character_id = Some(created.id.clone());
                self.state.pinned_character_id = Some(created.id.clone());
                self.state.character_tab = "edit".into();
                self.refresh_characters();
                self.state.status_message = Some("Character created.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Duplicate the selected character (`characters.create` with
    /// `"{name} copy"`; React `duplicateSelectedCharacter`). Only the fields
    /// the native create contract carries (name / description / tags /
    /// avatar) are copied.
    pub fn duplicate_selected_character(&mut self) {
        let Some(source) = self.state.selected_character_id.as_deref().and_then(|id| {
            self.state
                .characters
                .iter()
                .find(|row| row.id == id)
                .cloned()
        }) else {
            return;
        };
        let req = RequestCreateCharacter {
            name: format!("{} copy", source.name),
            description: source.description.clone(),
            tags: Some(source.tags.clone()),
            avatar_asset_id: source.avatar_asset_id.clone(),
            profile_id: None,
        };
        match self.call_decode("characters.create", &req, decode_character_dto) {
            Ok(created) => {
                self.state.selected_character_id = Some(created.id.clone());
                self.state.pinned_character_id = Some(created.id.clone());
                self.state.character_tab = "edit".into();
                self.refresh_characters();
                self.state.status_message = Some(format!("Created {}.", created.name));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// React `CharacterLorebooks.createForCharacter`: `lorebooks.create` with
    /// `characterId` + open the lorebooks manager.
    pub(crate) fn create_character_lorebook(&mut self) {
        let Some(character_id) = self.state.selected_character_id.clone() else {
            return;
        };
        let req = RequestCreateLorebook {
            name: "New lorebook".into(),
            description: None,
            entries: None,
            character_id: Some(character_id),
        };
        match self.call_decode("lorebooks.create", &req, decode_lorebook_dto) {
            Ok(created) => {
                self.state.selected_lorebook_id = Some(created.id);
                self.state.lorebook_tab = "book".into();
                self.state.status_message = Some("Lorebook created.".into());
                self.set_panel("lorebooks");
            }
            Err(err) => {
                self.record_error(err);
                self.bump_scene();
            }
        }
    }

    /// Wire DTO cannot express `characterId: null` (dto.ts: "null is not
    /// expressible yet"). React kernel-plane silently omits the field;
    /// native reports the honest capability gap instead of a no-op update.
    pub(crate) fn unlink_character_lorebook(&mut self) {
        self.record_error(ChatRouteError::Product(ErrorDto {
            code: "CAPABILITY_UNAVAILABLE".into(),
            params: json!({ "operationId": "lorebooks.update.unlink" }),
            trace_id: None,
            correlation_id: None,
        }));
        self.bump_scene();
    }

    pub fn open_delete_dialog(&mut self) {
        let can_delete = match self.state.sidebar_panel.as_str() {
            "personas" => self.state.selected_persona_id.is_some(),
            "lorebooks" => self.state.selected_lorebook_id.is_some(),
            _ => self.state.selected_character_id.is_some(),
        };
        if can_delete {
            self.state.delete_dialog_open = true;
            self.bump_scene();
        }
    }

    pub fn close_delete_dialog(&mut self) {
        self.state.delete_dialog_open = false;
        self.bump_scene();
    }

    /// Delete the selected character via `characters.delete` and refresh.
    pub fn confirm_delete_character(&mut self) {
        let Some(id) = self.state.selected_character_id.clone() else {
            self.state.delete_dialog_open = false;
            return;
        };
        match self.call_value(
            "characters.delete",
            &RequestDeleteCharacter { character_id: id },
        ) {
            Ok(_) => {
                self.state.delete_dialog_open = false;
                self.state.selected_character_id = None;
                self.state.character_draft = None;
                self.state.avatar_data_uri = None;
                self.state.character_tab = "cards".into();
                self.refresh_characters();
                self.state.status_message = Some("Character deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Toggle favorite flag on the local draft (Kernel contract does not yet
    /// persist favorites; this keeps the UI state honest until it does).
    pub fn toggle_favorite(&mut self) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.favorite = !draft.favorite;
            self.bump_scene();
        }
    }

    pub fn apply_shell_action(&mut self, action: ShellAction) {
        match action {
            ShellAction::ToggleRail => self.toggle_rail(),
            ShellAction::SetPanel(panel) => self.set_panel(&panel),
            ShellAction::ClosePanel => {
                self.state.sidebar_open = false;
                self.bump_scene();
            }
            ShellAction::SetTab(tab) => match self.state.sidebar_panel.as_str() {
                "personas" => self.set_persona_tab(&tab),
                "lorebooks" => self.set_lorebook_tab(&tab),
                "providers" => {
                    let is_memories = tab == "memories";
                    let is_advanced = tab == "advanced";
                    self.state.ai_tab = tab;
                    // React `MemoryEditor` queries on mount.
                    if is_memories {
                        self.load_memories();
                    }
                    // React `AdvancedPromptSettings` reads settings on mount.
                    if is_advanced {
                        self.load_settings();
                        self.load_prompt_presets_list();
                    }
                    self.bump_scene();
                }
                "settings" => {
                    let is_themes = tab == "themes";
                    let is_secrets = tab == "secrets";
                    let is_tools = tab == "tools";
                    let is_data = tab == "data";
                    let is_general = tab == "general";
                    self.state.settings_tab = tab;
                    // React `ThemesTab` / `SecretsPanel` / `ToolsPanel` /
                    // DataTab / GeneralTab query on mount: load when the tab
                    // opens so the surface is real, not a stub.
                    if is_themes {
                        self.load_themes();
                    }
                    if is_secrets {
                        self.load_secrets_status();
                    }
                    if is_tools {
                        self.load_tools();
                    }
                    if is_data {
                        self.load_backups();
                        self.load_data_activation();
                    }
                    if is_general {
                        self.load_diagnostics();
                    }
                    self.bump_scene();
                }
                _ => self.set_character_tab(&tab),
            },
            ShellAction::SetView(view) => self.set_character_view(&view),
            ShellAction::CycleSort => match self.state.sidebar_panel.as_str() {
                "personas" => {
                    self.state.persona_sort = if self.state.persona_sort == "asc" {
                        "desc".into()
                    } else {
                        "asc".into()
                    };
                    self.bump_scene();
                }
                _ => {
                    let next = next_sort(&self.state.character_sort);
                    self.set_character_sort(next);
                }
            },
            ShellAction::SelectCharacter(id) => self.select_character(&id),
            ShellAction::SelectPersona(id) => self.select_persona(&id),
            ShellAction::SelectLorebook(id) => self.select_lorebook(&id),
            ShellAction::SelectChat(id) => self.open_chat(&id),
            ShellAction::BackToParentChat => self.open_parent_chat(),
            ShellAction::CreateChat => self.create_chat(),
            ShellAction::OpenCreate => self.open_create_dialog(),
            ShellAction::CloseCreate => self.close_create_dialog(),
            ShellAction::ConfirmCreate => match self.state.sidebar_panel.as_str() {
                "personas" => self.confirm_create_persona(),
                "lorebooks" => self.confirm_create_lorebook(),
                _ => self.confirm_create_character(),
            },
            ShellAction::OpenDelete => self.open_delete_dialog(),
            ShellAction::CloseDelete => self.close_delete_dialog(),
            ShellAction::ConfirmDelete => match self.state.sidebar_panel.as_str() {
                "personas" => self.confirm_delete_persona(),
                "lorebooks" => self.confirm_delete_lorebook(),
                _ => self.confirm_delete_character(),
            },
            ShellAction::ToggleFavorite => self.toggle_favorite(),
            ShellAction::BackToCards => match self.state.sidebar_panel.as_str() {
                "personas" => self.set_persona_tab("cards"),
                "lorebooks" => self.set_lorebook_tab("books"),
                _ => self.set_character_tab("cards"),
            },
            ShellAction::OpenEntryDialog => self.open_entry_dialog(),
            ShellAction::EditLorebookEntry(id) => self.open_entry_dialog_for(&id),
            ShellAction::CloseEntryDialog => self.close_entry_dialog(),
            ShellAction::SaveEntry => self.save_entry(),
            ShellAction::ToggleLorebookEntry(id) => self.toggle_lorebook_entry(&id),
            ShellAction::OpenEntryDelete(id) => {
                self.state.entry_delete_target_id = Some(id);
                self.state.entry_delete_open = true;
                self.bump_scene();
            }
            ShellAction::CloseEntryDelete => {
                self.state.entry_delete_open = false;
                self.state.entry_delete_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmEntryDelete => self.confirm_delete_entry(),
            ShellAction::EntryToggleEnabled => {
                self.state.entry_enabled_draft = !self.state.entry_enabled_draft;
                self.bump_scene();
            }
            ShellAction::EntryToggleConstant => {
                self.state.entry_constant_draft = !self.state.entry_constant_draft;
                self.bump_scene();
            }
            ShellAction::EntryToggleSelective => {
                self.state.entry_selective_draft = !self.state.entry_selective_draft;
                self.bump_scene();
            }
            ShellAction::CreateProfile => self.create_profile(),
            ShellAction::StartProfileRename(id) => self.start_profile_rename(&id),
            ShellAction::SubmitProfileRename => self.submit_profile_rename(),
            ShellAction::CancelProfileRename => {
                self.state.profile_renaming_id = None;
                self.state.profile_rename_name.clear();
                self.bump_scene();
            }
            ShellAction::OpenProfileDelete(id) => {
                self.state.profile_delete_target_id = Some(id);
                self.state.profile_delete_open = true;
                self.bump_scene();
            }
            ShellAction::CloseProfileDelete => {
                self.state.profile_delete_open = false;
                self.state.profile_delete_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmProfileDelete => self.confirm_delete_profile(),
            ShellAction::ExportProfile(id) => self.export_profile(&id),
            ShellAction::TogglePlugin(id) => self.toggle_plugin(&id),
            ShellAction::OpenPluginUninstall(id) => {
                self.state.plugin_uninstall_target_id = Some(id);
                self.state.plugin_uninstall_open = true;
                self.bump_scene();
            }
            ShellAction::ClosePluginUninstall => {
                self.state.plugin_uninstall_open = false;
                self.state.plugin_uninstall_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmPluginUninstall => self.confirm_uninstall_plugin(),
            ShellAction::StartChatRename(id) => self.start_chat_rename(&id),
            ShellAction::CloseChatRename => {
                self.state.chat_rename_open = false;
                self.state.chat_renaming_id = None;
                self.bump_scene();
            }
            ShellAction::SubmitChatRename => self.submit_chat_rename(),
            ShellAction::OpenChatDelete(id) => {
                self.state.chat_delete_target_id = Some(id);
                self.state.chat_delete_open = true;
                self.bump_scene();
            }
            ShellAction::CloseChatDelete => {
                self.state.chat_delete_open = false;
                self.state.chat_delete_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmChatDelete => self.confirm_delete_chat(),
            ShellAction::OpenPromptPlan(run_id) => self.open_prompt_plan(&run_id),
            ShellAction::ClosePromptPlan => self.close_prompt_plan(),
            ShellAction::OpenRunTranscript(run_id) => self.open_run_transcript(&run_id),
            ShellAction::CloseRunTranscript => self.close_run_transcript(),
            ShellAction::OpenCheckpointDelete(id) => self.open_checkpoint_delete(&id),
            ShellAction::CloseCheckpointDelete => self.close_checkpoint_delete(),
            ShellAction::ConfirmCheckpointDelete => self.confirm_checkpoint_delete(),
            ShellAction::DuplicateCharacter => self.duplicate_selected_character(),
            ShellAction::LoadMoreCharacters => self.load_more_characters(),
            ShellAction::ToggleCharacterEditorMode => self.toggle_character_editor_mode(),
            ShellAction::SetCharacterEditorMode(mode) => self.set_character_editor_mode(&mode),
            ShellAction::CreateCharacterLorebook => self.create_character_lorebook(),
            ShellAction::UnlinkCharacterLorebook(_) => self.unlink_character_lorebook(),
            ShellAction::UploadGalleryImage => {
                // Kernel plane has no character gallery: React
                // `useUploadCharacterImage` rejects with `UnsupportedError`.
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "characters.gallery.upload" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::CycleGalleryColumns => {
                self.state.gallery_columns = next_gallery_columns(self.state.gallery_columns);
                self.bump_scene();
            }
            ShellAction::CycleGallerySort => {
                self.state.gallery_sort = next_gallery_sort(&self.state.gallery_sort).to_string();
                self.bump_scene();
            }
            ShellAction::CycleLanguage => self.cycle_language(),
            ShellAction::ToggleOpenHomeOnLoad => {
                self.state.open_home_on_load = !self.state.open_home_on_load;
                self.bump_scene();
            }
            ShellAction::CycleUiScale => {
                self.state.ui_scale = next_choice(UI_SCALES, &self.state.ui_scale).to_string();
                self.bump_scene();
            }
            ShellAction::CycleContrast => {
                self.state.ui_contrast =
                    next_choice(UI_CONTRASTS, &self.state.ui_contrast).to_string();
                self.bump_scene();
            }
            ShellAction::CycleFontProfile => {
                self.state.ui_font_profile =
                    next_choice(UI_FONT_PROFILES, &self.state.ui_font_profile).to_string();
                self.bump_scene();
            }
            ShellAction::CycleMotion => {
                self.state.ui_motion = next_choice(UI_MOTIONS, &self.state.ui_motion).to_string();
                self.bump_scene();
            }
            ShellAction::CycleChatStyle => {
                self.state.chat_style =
                    next_choice(CHAT_STYLES, &self.state.chat_style).to_string();
                self.bump_scene();
            }
            ShellAction::CycleChatAvatarStyle => {
                self.state.chat_avatar_style =
                    next_choice(CHAT_AVATAR_STYLES, &self.state.chat_avatar_style).to_string();
                self.bump_scene();
            }
            ShellAction::CycleUserMessagePosition => {
                self.state.user_message_position =
                    next_choice(MESSAGE_POSITIONS, &self.state.user_message_position).to_string();
                self.bump_scene();
            }
            ShellAction::CycleCharacterMessagePosition => {
                self.state.character_message_position =
                    next_choice(MESSAGE_POSITIONS, &self.state.character_message_position)
                        .to_string();
                self.bump_scene();
            }
            ShellAction::CycleUiOpacity => {
                self.state.ui_opacity = next_step(self.state.ui_opacity, 0, 100, 5);
                self.bump_scene();
            }
            ShellAction::CycleUiGlassBlur => {
                self.state.ui_glass_blur = next_step(self.state.ui_glass_blur, 0, 40, 4);
                self.bump_scene();
            }
            ShellAction::StepUiOpacity(delta) => self.step_ui_opacity(delta),
            ShellAction::StepUiGlassBlur(delta) => self.step_ui_glass_blur(delta),
            ShellAction::RunDiagnostics => self.load_diagnostics(),
            ShellAction::RebuildSearch => {
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "search.rebuild" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::ClearDiagnosticCache => {
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "diagnostics.cache" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::AnalyzeSillyTavern => {
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "imports.sillytavern.analyze" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::CyclePromptMode => self.cycle_prompt_mode(),
            ShellAction::CycleInstructSelection => self.cycle_instruct_selection(),
            ShellAction::SaveInstructTemplate => self.save_instruct_template(),
            ShellAction::TogglePromptBlock(id) => self.toggle_prompt_block(&id),
            ShellAction::AddPromptBlock => self.add_prompt_block(),
            ShellAction::RemovePromptBlock(id) => self.remove_prompt_block(&id),
            ShellAction::MovePromptBlockUp(id) => self.move_prompt_block(&id, -1),
            ShellAction::MovePromptBlockDown(id) => self.move_prompt_block(&id, 1),
            ShellAction::EditPromptBlock(id) => self.edit_prompt_block(&id),
            ShellAction::PromptBlockEditCancel => self.close_prompt_block_editor(),
            ShellAction::PromptBlockEditSave => self.save_prompt_block_editor(),
            ShellAction::CyclePromptBlockPosition => self.cycle_prompt_block_position(),
            ShellAction::CyclePromptBlockRole => self.cycle_prompt_block_role(),
            ShellAction::TogglePromptBlockTrigger(id) => self.toggle_prompt_block_trigger(&id),
            ShellAction::TogglePromptBlockForbidOverrides => {
                self.toggle_prompt_block_forbid_overrides()
            }
            ShellAction::LoadPromptBlockModels => self.load_prompt_block_models(),
            ShellAction::CyclePromptPreset => self.cycle_prompt_preset(),
            ShellAction::PromptPresetSave => self.save_prompt_preset(),
            ShellAction::PromptPresetRename => self.open_prompt_preset_rename(),
            ShellAction::PromptPresetDuplicate => self.open_prompt_preset_duplicate(),
            ShellAction::PromptPresetDelete => self.open_prompt_preset_delete(),
            ShellAction::PromptTemplateImportOpen => self.open_prompt_template_import(),
            ShellAction::PromptTemplateImportClose => self.close_prompt_template_import(),
            ShellAction::PromptTemplateImportConfirm => self.confirm_prompt_template_import(),
            ShellAction::ExportPromptTemplate => self.export_prompt_template(),
            ShellAction::StopGeneration => {
                let _ = self.cancel_generation();
            }
            ShellAction::UploadBackground => {
                // Kernel plane has no wallpaper catalog: React
                // `useUploadBackground` rejects with `UnsupportedError`.
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "backgrounds.upload" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::ActivateTheme(id) => self.activate_theme(&id),
            ShellAction::UseBuiltInTheme => self.use_builtin_theme(),
            ShellAction::InstallTheme => {
                // React kernel plane: `installTheme` rejects with
                // `UnsupportedError('themes.install.host-verify')` — package
                // verification is host-side, so no Wire op is invented here.
                self.record_error(ChatRouteError::Product(ErrorDto {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    params: json!({ "operationId": "themes.install.host-verify" }),
                    trace_id: None,
                    correlation_id: None,
                }));
                self.bump_scene();
            }
            ShellAction::OpenThemeDelete(id) => {
                self.state.theme_delete_target_id = Some(id);
                self.state.theme_delete_open = true;
                self.bump_scene();
            }
            ShellAction::CloseThemeDelete => {
                self.state.theme_delete_open = false;
                self.state.theme_delete_target_id = None;
                self.bump_scene();
            }
            ShellAction::ConfirmThemeDelete => self.confirm_delete_theme(),
            ShellAction::LockSecrets => self.lock_secrets(),
            ShellAction::SelectProvider(id) => self.select_provider(&id),
            ShellAction::SelectPreset(id) => self.select_preset(&id),
            ShellAction::CreateBackup => self.create_backup(),
            ShellAction::RefreshBackups => self.load_backups(),
            ShellAction::RestoreBackup(id) => self.restore_backup(&id),
            ShellAction::MemoryToggle(id) => self.toggle_memory(&id),
            ShellAction::MemoryEditOpen(id) => self.begin_memory_edit(&id),
            ShellAction::MemoryEditCancel => self.cancel_memory_edit(),
            ShellAction::MemorySave => self.save_memory(),
            ShellAction::MemoryDeleteOpen(id) => self.open_memory_delete(&id),
            ShellAction::MemoryDeleteClose => self.close_memory_delete(),
            ShellAction::MemoryDeleteConfirm => self.confirm_memory_delete(),
            ShellAction::MemoryDraftToggleScope => self.toggle_memory_draft_scope(),
            ShellAction::MemoryCycleCharacter => self.cycle_memory_character(),
            ShellAction::MemoryDraftToggleEnabled => self.toggle_memory_draft_enabled(),
            ShellAction::PresetApply => self.apply_preset_draft(),
            ShellAction::PresetToggleUnlock => self.toggle_preset_unlock(),
            ShellAction::PresetFocusValue(id) => self.focus_preset_value(&id),
            ShellAction::PresetToggleFlag(id) => self.toggle_preset_flag(&id),
            ShellAction::PresetSaveAsOpen => self.open_preset_create(),
            ShellAction::PresetRenameOpen => self.open_preset_rename(),
            ShellAction::PresetNameCancel => self.close_preset_name(),
            ShellAction::PresetNameSubmit => self.confirm_preset_name(),
            ShellAction::PresetDuplicate => self.duplicate_preset(),
            ShellAction::PresetDeleteOpen => self.open_preset_delete(),
            ShellAction::PresetDeleteClose => self.close_preset_delete(),
            ShellAction::PresetDeleteConfirm => self.confirm_preset_delete(),
            ShellAction::PresetImportOpen => self.open_generation_preset_import(),
            ShellAction::PresetImportClose => self.close_generation_preset_import(),
            ShellAction::PresetImportConfirm => self.confirm_generation_preset_import(),
            ShellAction::PresetExport => self.export_generation_preset(),
            ShellAction::ProviderCreateOpen => self.open_provider_create(),
            ShellAction::ProviderCreateClose => self.close_provider_create(),
            ShellAction::ProviderCycleKind => self.cycle_provider_kind(),
            ShellAction::ProviderCreateSubmit => self.confirm_provider_create(),
            ShellAction::ProviderDeleteOpen(id) => self.open_provider_delete(&id),
            ShellAction::ProviderDeleteClose => self.close_provider_delete(),
            ShellAction::ProviderDeleteConfirm => self.confirm_provider_delete(),
            ShellAction::SnapshotsClose => self.close_snapshots_menu(),
            ShellAction::OpenSnapshot(id) => self.open_snapshot(&id),
            ShellAction::VariantPickerClose => self.close_variant_picker(),
            ShellAction::PickVariant(message_id, variant_id) => {
                self.pick_variant(&message_id, &variant_id)
            }
            ShellAction::ExportChat(id) => self.export_chat(&id),
            ShellAction::LorebookSaveMeta => self.save_lorebook_meta(),
            ShellAction::PersonaSaveMeta => self.save_persona_meta(),
            ShellAction::CharacterSaveMeta => self.save_character_meta(),
            ShellAction::AddCharacterTag => self.add_character_tag(),
            ShellAction::RemoveCharacterTag(tag) => self.remove_character_tag(&tag),
            ShellAction::ToggleAlternateGreeting(idx) => self.toggle_alternate_greeting(idx),
            ShellAction::AddAlternateGreeting => self.add_alternate_greeting(),
            ShellAction::RemoveAlternateGreeting(idx) => self.remove_alternate_greeting(idx),
            ShellAction::OpenMessageDetails(id) => self.open_message_details(&id),
            ShellAction::CloseMessageDetails => self.close_message_details(),
            ShellAction::SetMessageDetailsMode(mode) => self.set_message_details_mode(&mode),
            ShellAction::SubmitMessageDetailsEdit => self.submit_message_details_edit(),
            ShellAction::Import => self.open_card_import(),
            ShellAction::ImportClose => self.close_card_import(),
            ShellAction::ConfirmCardImport => self.confirm_card_import(),
            ShellAction::ExportCharacterCard(id) => self.export_character_card(&id),
            ShellAction::ProfileImportPolicyCycle => self.cycle_profile_import_policy(),
            ShellAction::ProfileImportSubmit => self.submit_profile_import(),
        }
    }

    pub fn save_character_meta(&mut self) {
        let Some(draft) = self.state.character_draft.clone() else {
            return;
        };
        let Some(stored) = self
            .state
            .characters
            .iter()
            .find(|row| row.id == draft.id)
            .cloned()
        else {
            return;
        };
        let next_name = draft.name.trim().to_string();
        let name_change = !next_name.is_empty() && next_name != stored.name;
        let next_description = draft.description.clone();
        let stored_description = stored.description.clone().unwrap_or_default();
        let description_change = next_description != stored_description;
        if !name_change && !description_change {
            self.state.status_message = Some("No changes.".into());
            self.bump_scene();
            return;
        }
        let req = RequestUpdateCharacter {
            character_id: draft.id.clone(),
            name: if name_change {
                Some(next_name.clone())
            } else {
                None
            },
            description: if description_change {
                Some(next_description.clone())
            } else {
                None
            },
            tags: None,
            avatar_asset_id: None,
            profile_id: None,
        };
        match self.call_decode("characters.update", &req, decode_character_dto) {
            Ok(updated) => {
                if let Some(row) = self
                    .state
                    .characters
                    .iter_mut()
                    .find(|row| row.id == updated.id)
                {
                    row.name = updated.name.clone();
                    row.description = updated.description.clone();
                }
                self.characters_revision += 1;
                if let Some(local) = self.state.character_draft.as_mut() {
                    if local.id == updated.id {
                        local.name = updated.name.clone();
                        local.description = updated.description.unwrap_or_default();
                    }
                }
                self.state.status_message = Some(format!("Saved {}.", updated.name));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_character_name_draft(&mut self, value: &str) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.name = value.to_string();
        }
        self.bump_scene();
    }

    pub fn set_character_description_draft(&mut self, value: &str) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.description = value.to_string();
        }
        self.bump_scene();
    }

    pub fn set_character_first_message(&mut self, value: &str) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.first_message = value.to_string();
        }
        self.bump_scene();
    }

    pub fn set_character_creator_notes(&mut self, value: &str) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.creator_notes = value.to_string();
        }
        self.bump_scene();
    }

    pub fn toggle_alternate_greeting(&mut self, index: usize) {
        if self.state.expanded_greeting == Some(index) {
            self.state.expanded_greeting = None;
        } else {
            self.state.expanded_greeting = Some(index);
        }
        self.bump_scene();
    }

    pub fn add_alternate_greeting(&mut self) {
        let Some(draft) = self.state.character_draft.as_mut() else {
            return;
        };
        draft.alternate_greetings.push(String::new());
        let new_idx = draft.alternate_greetings.len().saturating_sub(1);
        self.state.expanded_greeting = Some(new_idx);
        self.bump_scene();
    }

    pub fn remove_alternate_greeting(&mut self, index: usize) {
        let Some(draft) = self.state.character_draft.as_mut() else {
            return;
        };
        if index < draft.alternate_greetings.len() {
            draft.alternate_greetings.remove(index);
            if self.state.expanded_greeting == Some(index) {
                self.state.expanded_greeting = None;
            } else if let Some(expanded) = self.state.expanded_greeting {
                if expanded > index {
                    self.state.expanded_greeting = Some(expanded - 1);
                }
            }
        }
        self.bump_scene();
    }

    pub fn set_alternate_greeting(&mut self, index: usize, value: &str) {
        let Some(draft) = self.state.character_draft.as_mut() else {
            return;
        };
        if let Some(item) = draft.alternate_greetings.get_mut(index) {
            *item = value.to_string();
            self.bump_scene();
        }
    }

    pub fn set_tag_input(&mut self, value: &str) {
        self.state.tag_input = value.to_string();
        self.bump_scene();
    }

    /// React `EditTab.addTag`: trim, skip duplicates case-insensitively,
    /// cap at 32 tags / 64 chars, persist `tags` immediately.
    pub(crate) fn add_character_tag(&mut self) {
        let value = self.state.tag_input.trim().to_string();
        self.state.tag_input.clear();
        if value.is_empty() {
            self.bump_scene();
            return;
        }
        let value: String = value.chars().take(64).collect();
        let Some(draft) = self.state.character_draft.as_mut() else {
            self.bump_scene();
            return;
        };
        if draft.tags.len() >= 32 {
            self.bump_scene();
            return;
        }
        let lower = value.to_lowercase();
        if draft.tags.iter().any(|tag| tag.to_lowercase() == lower) {
            self.bump_scene();
            return;
        }
        draft.tags.push(value);
        self.persist_character_tags();
    }

    /// React `EditTab` chip remove. Unknown tags are a no-op.
    pub(crate) fn remove_character_tag(&mut self, tag: &str) {
        let Some(draft) = self.state.character_draft.as_mut() else {
            return;
        };
        let before = draft.tags.len();
        draft.tags.retain(|item| item != tag);
        if draft.tags.len() == before {
            return;
        }
        self.persist_character_tags();
    }

    pub(crate) fn persist_character_tags(&mut self) {
        let Some(draft) = self.state.character_draft.as_ref() else {
            return;
        };
        let req = RequestUpdateCharacter {
            character_id: draft.id.clone(),
            name: None,
            description: None,
            tags: Some(draft.tags.clone()),
            avatar_asset_id: None,
            profile_id: None,
        };
        match self.call_decode("characters.update", &req, decode_character_dto) {
            Ok(updated) => {
                if let Some(row) = self
                    .state
                    .characters
                    .iter_mut()
                    .find(|row| row.id == updated.id)
                {
                    row.tags = updated.tags.clone();
                }
                self.characters_revision += 1;
                if let Some(local) = self.state.character_draft.as_mut() {
                    if local.id == updated.id {
                        local.tags = updated.tags;
                    }
                }
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Load the full draft for the currently selected character.
    pub(crate) fn load_character_draft(&mut self) {
        let Some(id) = self.state.selected_character_id.clone() else {
            self.state.character_draft = None;
            self.state.avatar_data_uri = None;
            self.state.tag_input.clear();
            return;
        };
        match self.call_decode(
            "characters.get",
            &RequestGetCharacter {
                character_id: id.clone(),
            },
            decode_character_dto,
        ) {
            Ok(dto) => {
                let mut draft = CharacterDraftView::default();
                draft.id = dto.id.clone();
                draft.name = dto.name.clone();
                draft.description = dto.description.clone().unwrap_or_default();
                draft.tags = dto.tags.clone();
                draft.avatar_asset_id = dto.avatar_asset_id.clone();
                draft.first_message = format!("*{} looks up.* Hey.", dto.name);
                draft.creator_notes = format!("Character card for {}.", dto.name);
                draft.alternate_greetings = vec![format!("*{} nods.* Good to see you.", dto.name)];
                self.state.character_draft = Some(draft);
                self.state.expanded_greeting = None;
                self.load_avatar_data_uri(dto.avatar_asset_id.as_deref());
            }
            Err(err) => {
                self.record_error(err);
                self.state.character_draft = None;
                self.state.avatar_data_uri = None;
            }
        }
        self.state.tag_input.clear();
    }

    /// Resolve avatars for every listed character via Product Wire `assets.content`.
    pub(crate) fn hydrate_character_avatars(&mut self) {
        let asset_ids: Vec<String> = self
            .state
            .characters
            .iter()
            .filter_map(|row| row.avatar_asset_id.clone())
            .collect();
        for asset_id in asset_ids {
            if self.state.avatar_thumbs.contains_key(&asset_id) {
                self.state.touch_avatar(&asset_id);
                continue;
            }
            if let Some(thumb) = self.fetch_avatar_thumb(&asset_id) {
                self.state
                    .insert_avatar_thumb(asset_id, thumb, &self.asset_store);
            }
        }
    }

    pub(crate) fn fetch_avatar_thumb(
        &mut self,
        asset_id: &str,
    ) -> Option<crate::avatar::AvatarThumb> {
        // Kernel-side thumbnail (image audit stage C): the 2.2 MiB original
        // never crosses the wire. No cover crop — the GPU overlay cover-fits
        // (stage A) and the in-scene `<img>` uses object-fit.
        match self.call_decode(
            "assets.thumb",
            &RequestAssetsThumb {
                asset_id: asset_id.to_string(),
                max_px: i64::from(crate::avatar::AVATAR_DISPLAY_MAX_PX),
            },
            decode_result_assets_thumb,
        ) {
            Ok(result) => crate::avatar::premultiplied_from_encoded(&result.content_base64),
            Err(_) => None,
        }
    }

    /// Resolve the avatar asset into a GPU thumbnail. Never a `data:` URI.
    pub(crate) fn load_avatar_data_uri(&mut self, asset_id: Option<&str>) {
        let Some(asset_id) = asset_id else {
            self.state.avatar_data_uri = None;
            return;
        };
        if self.state.avatar_thumbs.contains_key(asset_id) {
            self.state.touch_avatar(asset_id);
            self.state.avatar_data_uri = None;
            if let Some(draft) = self.state.character_draft.as_mut() {
                draft.avatar_data_uri = None;
            }
            return;
        }
        if let Some(thumb) = self.fetch_avatar_thumb(asset_id) {
            self.state
                .insert_avatar_thumb(asset_id.to_string(), thumb, &self.asset_store);
        }
        self.state.avatar_data_uri = None;
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.avatar_data_uri = None;
        }
    }
}
