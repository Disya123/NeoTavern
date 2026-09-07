//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    /// Load `profiles.list` for the Settings Profiles tab (React
    /// `useProfiles`; the kernel returns the full list in one page).
    pub(crate) fn load_profiles(&mut self) {
        match self.call_decode(
            "profiles.list",
            &RequestEmpty {},
            decode_result_profiles_list,
        ) {
            Ok(ResultProfilesList { items }) => self.state.profiles = items,
            Err(err) => self.record_error(err),
        }
    }

    /// Inline create row (`profiles.create`); an empty name stays a local
    /// status message, exactly like React disabling the submit button.
    pub fn create_profile(&mut self) {
        let name = self.state.profile_create_name.trim().to_string();
        if name.is_empty() {
            self.state.status_message = Some("Profile needs a name.".into());
            self.bump_scene();
            return;
        }
        match self.call_decode(
            "profiles.create",
            &RequestProfilesCreate { name },
            decode_result_profiles_create,
        ) {
            Ok(_) => {
                self.state.profile_create_name.clear();
                self.load_profiles();
                self.state.status_message = Some("Profile created.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Enter inline rename mode for a profile row (React `startRename`).
    pub fn start_profile_rename(&mut self, profile_id: &str) {
        let Some(profile) = self
            .state
            .profiles
            .iter()
            .find(|row| row.id == profile_id)
            .cloned()
        else {
            return;
        };
        self.state.profile_renaming_id = Some(profile.id);
        self.state.profile_rename_name = profile.name;
        self.bump_scene();
    }

    /// Inline rename submit (`profiles.rename`).
    pub fn submit_profile_rename(&mut self) {
        let Some(id) = self.state.profile_renaming_id.clone() else {
            return;
        };
        let name = self.state.profile_rename_name.trim().to_string();
        if name.is_empty() {
            self.state.status_message = Some("Profile needs a name.".into());
            self.bump_scene();
            return;
        }
        match self.call_value("profiles.rename", &RequestProfilesRename { id, name }) {
            Ok(_) => {
                self.state.profile_renaming_id = None;
                self.state.profile_rename_name.clear();
                self.load_profiles();
                self.state.status_message = Some("Profile renamed.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub(crate) fn confirm_delete_profile(&mut self) {
        let Some(id) = self.state.profile_delete_target_id.clone() else {
            self.state.profile_delete_open = false;
            return;
        };
        match self.call_value("profiles.delete", &RequestProfilesDelete { id }) {
            Ok(_) => {
                self.state.profile_delete_open = false;
                self.state.profile_delete_target_id = None;
                self.load_profiles();
                self.state.status_message = Some("Profile deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Per-profile logical export (`profile.export`): the kernel builds the
    /// container and returns the verified report — the toast surfaces the
    /// honest record counts (React `runExport` notice).
    pub fn export_profile(&mut self, profile_id: &str) {
        let name = self
            .state
            .profiles
            .iter()
            .find(|row| row.id == profile_id)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        let req = RequestProfileExport {
            include_assets: None,
            profile_id: Some(profile_id.to_string()),
        };
        match self.call_decode("profile.export", &req, decode_result_profile_export) {
            Ok(result) => {
                self.state.status_message = Some(format!(
                    "Exported \"{name}\": {} characters, {} chats, {} messages.",
                    result.records.characters, result.records.chats, result.records.messages
                ));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_profile_create_name(&mut self, value: &str) {
        self.state.profile_create_name = value.to_string();
        self.bump_scene();
    }

    pub fn set_profile_rename_name(&mut self, value: &str) {
        self.state.profile_rename_name = value.to_string();
        self.bump_scene();
    }

    /// Plugin card switch: `plugins.enable` / `plugins.disable` by current
    /// state; the wire returns the updated row (React `PluginsPage` toggle).
    pub fn toggle_plugin(&mut self, plugin_id: &str) {
        let Some(plugin) = self
            .state
            .plugins
            .iter()
            .find(|row| row.id == plugin_id)
            .cloned()
        else {
            return;
        };
        let (_op, enabled, toast) = if plugin.enabled {
            (
                "plugins.disable",
                false,
                format!("Plugin \"{}\" disabled.", plugin.name),
            )
        } else {
            (
                "plugins.enable",
                true,
                format!("Plugin \"{}\" enabled.", plugin.name),
            )
        };
        let result = if enabled {
            self.call_value(
                "plugins.enable",
                &RequestPluginsEnable {
                    id: plugin_id.to_string(),
                },
            )
        } else {
            self.call_value(
                "plugins.disable",
                &RequestPluginsDisable {
                    id: plugin_id.to_string(),
                },
            )
        };
        match result {
            Ok(_) => {
                self.load_plugins();
                self.state.status_message = Some(toast);
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub(crate) fn confirm_uninstall_plugin(&mut self) {
        let Some(id) = self.state.plugin_uninstall_target_id.clone() else {
            self.state.plugin_uninstall_open = false;
            return;
        };
        let name = self
            .state
            .plugins
            .iter()
            .find(|row| row.id == id)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        match self.call_value("plugins.uninstall", &RequestPluginsUninstall { id }) {
            Ok(_) => {
                self.state.plugin_uninstall_open = false;
                self.state.plugin_uninstall_target_id = None;
                self.load_plugins();
                self.state.status_message = Some(format!("Plugin \"{name}\" uninstalled."));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Chats row rename action: opens the rename dialog pre-filled with the
    /// current title (React `ChatManagementPanel` rename Dialog).
    pub fn start_chat_rename(&mut self, chat_id: &str) {
        let Some(chat) = self
            .state
            .chat_list
            .iter()
            .find(|row| row.id == chat_id)
            .cloned()
        else {
            return;
        };
        self.state.chat_renaming_id = Some(chat.id);
        self.state.chat_rename_draft = chat.title;
        self.state.chat_rename_open = true;
        self.bump_scene();
    }

    /// Rename submit (`chats.update`); an empty title closes the dialog
    /// without a wire call, exactly like React's no-op guard.
    pub fn submit_chat_rename(&mut self) {
        let Some(id) = self.state.chat_renaming_id.clone() else {
            return;
        };
        let title = self.state.chat_rename_draft.trim().to_string();
        if title.is_empty() {
            self.state.chat_rename_open = false;
            self.state.chat_renaming_id = None;
            self.bump_scene();
            return;
        }
        let req = RequestUpdateChat {
            chat_id: id,
            title: Some(title),
            persona_id: None,
        };
        match self.call_value("chats.update", &req) {
            Ok(_) => {
                self.state.chat_rename_open = false;
                self.state.chat_renaming_id = None;
                self.load_chat_list();
                self.state.status_message = Some("Chat renamed.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub(crate) fn confirm_delete_chat(&mut self) {
        let Some(id) = self.state.chat_delete_target_id.clone() else {
            self.state.chat_delete_open = false;
            return;
        };
        match self.call_value(
            "chats.delete",
            &RequestDeleteChat {
                chat_id: id.clone(),
            },
        ) {
            Ok(_) => {
                self.state.chat_delete_open = false;
                self.state.chat_delete_target_id = None;
                // The deleted chat was open in the workspace: drop it so the
                // next refresh cannot hit CHAT_NOT_FOUND (React navigates away).
                if self.chat_id.as_deref() == Some(id.as_str()) {
                    self.chat_id = None;
                    self.state.chat = None;
                    self.state.messages.clear();
                    // Its live run (if any) stops being polled here too.
                    self.reset_stream_state();
                }
                self.load_chat_list();
                self.state.status_message = Some("Chat deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_chat_rename_draft(&mut self, value: &str) {
        self.state.chat_rename_draft = value.to_string();
        self.bump_scene();
    }

    /// Opens the prompt plan dialog for a run and loads the durable plan
    /// (`generation.prompt.plan`; React `PromptPlanPanel`). `PROMPT_PLAN_NOT_FOUND`
    /// becomes the honest empty state; any other error renders inside the
    /// dialog (React `isError`), not as a toast.
    pub fn open_prompt_plan(&mut self, run_id: &str) {
        self.close_run_transcript_state();
        self.state.prompt_plan_run_id = Some(run_id.to_string());
        self.state.prompt_plan_open = true;
        self.state.prompt_plan = None;
        self.state.prompt_plan_not_found = false;
        self.state.prompt_plan_error = None;
        match self.call_decode(
            "generation.prompt.plan",
            &RequestGetPromptPlan {
                run_id: run_id.to_string(),
            },
            decode_prompt_plan,
        ) {
            Ok(plan) => self.state.prompt_plan = Some(plan),
            Err(ChatRouteError::Product(dto)) if dto.code == "PROMPT_PLAN_NOT_FOUND" => {
                self.state.prompt_plan_not_found = true;
            }
            Err(err) => self.state.prompt_plan_error = Some(err.to_string()),
        }
        self.bump_scene();
    }

    /// Open the prompt plan for a message row (React footer "Prompt plan"
    /// tap). Looks up `MessageDto.generation_run_id`; streaming / unknown
    /// rows are honest no-ops.
    pub fn open_prompt_plan_for_message(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let Some(run_id) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| row.generation_run_id.clone())
        else {
            self.record_error(ChatRouteError::product(
                "GENERATION_RUN_NOT_FOUND",
                json!({ "messageId": row_id }),
            ));
            self.bump_scene();
            return;
        };
        self.open_prompt_plan(&run_id);
    }

    pub fn close_prompt_plan(&mut self) {
        self.state.prompt_plan_open = false;
        self.state.prompt_plan_run_id = None;
        self.state.prompt_plan = None;
        self.state.prompt_plan_not_found = false;
        self.state.prompt_plan_error = None;
        self.bump_scene();
    }

    pub(crate) fn close_prompt_plan_state(&mut self) {
        self.state.prompt_plan_open = false;
        self.state.prompt_plan_run_id = None;
        self.state.prompt_plan = None;
        self.state.prompt_plan_not_found = false;
        self.state.prompt_plan_error = None;
    }

    pub(crate) fn close_run_transcript_state(&mut self) {
        self.state.run_transcript_open = false;
        self.state.run_transcript_run_id = None;
        self.state.run_transcript_steps.clear();
        self.state.run_transcript_error = None;
    }

    /// Opens the run-step transcript (`generation.events`; React
    /// `RunTranscriptPanel`). Unknown run → error inside the dialog (React
    /// `isError`); empty journal → honest empty state.
    pub fn open_run_transcript(&mut self, run_id: &str) {
        self.close_prompt_plan_state();
        self.state.run_transcript_run_id = Some(run_id.to_string());
        self.state.run_transcript_open = true;
        self.state.run_transcript_steps.clear();
        self.state.run_transcript_error = None;
        match self.call_decode(
            "generation.events",
            &RequestListGenerationEvents {
                workflow_id: run_id.to_string(),
                after_sequence: None,
                limit: Some(50),
            },
            decode_paged_generation_events,
        ) {
            Ok(page) => {
                self.state.run_transcript_steps = page
                    .items
                    .into_iter()
                    .filter_map(run_step_from_envelope)
                    .collect();
            }
            Err(ChatRouteError::Product(dto)) => {
                self.state.run_transcript_error = Some(dto.code);
            }
            Err(err) => self.state.run_transcript_error = Some(err.to_string()),
        }
        self.bump_scene();
    }

    pub fn open_run_transcript_for_message(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let Some(run_id) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| row.generation_run_id.clone())
        else {
            self.record_error(ChatRouteError::product(
                "GENERATION_RUN_NOT_FOUND",
                json!({ "messageId": row_id }),
            ));
            self.bump_scene();
            return;
        };
        self.open_run_transcript(&run_id);
    }

    pub fn close_run_transcript(&mut self) {
        self.close_run_transcript_state();
        self.bump_scene();
    }

    /// Toggle `message.meta.manualExcluded` via `chats.messages.update`
    /// (React `toggleMessageContext`). The kernel replaces the whole meta
    /// object; we merge the flag onto a clone of the current payload.
    pub fn toggle_message_context(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        let Some(message) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .cloned()
        else {
            self.record_error(ChatRouteError::product(
                "MESSAGE_NOT_FOUND",
                json!({ "messageId": row_id }),
            ));
            self.bump_scene();
            return;
        };
        let excluded = manual_excluded(&message.meta);
        let meta = with_manual_excluded(&message.meta, !excluded);
        match self.call_decode(
            "chats.messages.update",
            &RequestUpdateMessage {
                chat_id,
                message_id: row_id.to_string(),
                content: None,
                meta: Some(meta),
                clear_checkpoint_chat_id: None,
            },
            decode_message_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                    *row = updated;
                }
                self.state.status_message = Some(if excluded {
                    "Included in prompt context.".into()
                } else {
                    "Excluded from prompt context.".into()
                });
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn open_checkpoint_delete(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let has_checkpoint = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| row.checkpoint_chat_id.as_ref())
            .is_some();
        if !has_checkpoint {
            return;
        }
        self.state.checkpoint_delete_message_id = Some(row_id.to_string());
        self.state.checkpoint_delete_open = true;
        self.bump_scene();
    }

    pub fn close_checkpoint_delete(&mut self) {
        self.state.checkpoint_delete_open = false;
        self.state.checkpoint_delete_message_id = None;
        self.bump_scene();
    }

    pub fn confirm_checkpoint_delete(&mut self) {
        let Some(row_id) = self.state.checkpoint_delete_message_id.clone() else {
            self.close_checkpoint_delete();
            return;
        };
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            self.close_checkpoint_delete();
            return;
        };
        match self.call_decode(
            "chats.messages.update",
            &RequestUpdateMessage {
                chat_id,
                message_id: row_id.clone(),
                content: None,
                meta: None,
                clear_checkpoint_chat_id: Some(true),
            },
            decode_message_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                    *row = updated;
                }
                self.state.status_message = Some("Checkpoint link removed.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.state.checkpoint_delete_open = false;
        self.state.checkpoint_delete_message_id = None;
        self.bump_scene();
    }

    pub fn toggle_header_search(&mut self) {
        if self.state.header_search_open {
            self.state.header_search_open = false;
            self.state.header_search_query.clear();
            self.state.header_search_match_count = 0;
        } else {
            self.state.header_search_open = true;
        }
        self.bump_scene();
    }

    pub fn set_header_search_query(&mut self, value: &str) {
        if !self.state.header_search_open {
            return;
        }
        let query: String = value.chars().take(500).collect();
        self.state.header_search_query = query;
        self.recompute_header_search_matches();
        self.bump_scene();
    }

    pub(crate) fn recompute_header_search_matches(&mut self) {
        self.state.header_search_match_count = self
            .state
            .messages
            .iter()
            .map(|row| count_text_matches(&row.content, &self.state.header_search_query))
            .sum();
    }

    /// Synchronize the active theme's tokens and generated stylesheet for
    /// runtime injection into Blitz and NeoCompositor (Live Theme Engine).
    pub fn apply_active_theme_styling(&mut self) {
        if let Some(active) = self.state.themes.iter().find(|item| item.active).cloned() {
            let tokens = neotavern_presentation_design_system::resolve_theme_tokens(
                &active.id,
                active.manifest.as_ref(),
            );
            let css = neotavern_presentation_design_system::render_theme_stylesheet(
                &active.id, &tokens, None,
            );
            self.state.active_theme_tokens = Some(tokens);
            self.state.active_theme_css = Some(css);
        } else {
            self.state.active_theme_tokens = None;
            self.state.active_theme_css = None;
        }
    }

    /// Loads the theme catalog (`themes.list`; React `useThemes`).
    pub fn load_themes(&mut self) {
        match self.call_decode("themes.list", &RequestEmpty {}, decode_result_themes_list) {
            Ok(result) => {
                self.state.themes = result.items;
                self.apply_active_theme_styling();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// `themes.activate` (React `applyTheme(theme.id, theme.name)`); the wire
    /// response is the item with `active: true`.
    pub fn activate_theme(&mut self, id: &str) {
        let name = self
            .state
            .themes
            .iter()
            .find(|row| row.id == id)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        match self.call_decode(
            "themes.activate",
            &RequestThemesActivate { id: id.to_string() },
            decode_themes_item,
        ) {
            Ok(updated) => {
                for row in self.state.themes.iter_mut() {
                    row.active = row.id == updated.id;
                }
                self.apply_active_theme_styling();
                self.state.status_message = Some(format!("Applied {name}."));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// `themes.deactivate` — restore the built-in interface (React
    /// `resetActiveTheme`).
    pub fn use_builtin_theme(&mut self) {
        match self.call_value("themes.deactivate", &RequestEmpty {}) {
            Ok(_) => {
                for row in self.state.themes.iter_mut() {
                    row.active = false;
                }
                self.apply_active_theme_styling();
                self.state.status_message = Some("Restored the built-in theme.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub(crate) fn confirm_delete_theme(&mut self) {
        let Some(id) = self.state.theme_delete_target_id.clone() else {
            self.state.theme_delete_open = false;
            return;
        };
        let name = self
            .state
            .themes
            .iter()
            .find(|row| row.id == id)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        match self.call_value("themes.uninstall", &RequestThemesUninstall { id }) {
            Ok(_) => {
                self.state.theme_delete_open = false;
                self.state.theme_delete_target_id = None;
                self.load_themes();
                self.state.status_message = Some(format!("Removed {name}."));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Reads the secret-store status (`secrets.status`; React
    /// `useSecretsStatus`, `staleTime: 30_000`). The DTO is value-free by
    /// contract — no secret ever travels it.
    pub fn load_secrets_status(&mut self) {
        match self.call_decode(
            "secrets.status",
            &RequestEmpty {},
            decode_result_secrets_status,
        ) {
            Ok(status) => self.state.secrets_status = Some(status),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Locks the store (`secrets.lock`; React `useLockSecrets` invalidates the
    /// status query afterwards, so the panel refetches the honest locked
    /// state).
    pub fn lock_secrets(&mut self) {
        match self.call_decode("secrets.lock", &RequestEmpty {}, decode_result_secrets_lock) {
            Ok(_) => self.load_secrets_status(),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Reads the host tool registry (`generation.tools.list`; React
    /// `useGenerationTools`). An empty registry is a success, never an error
    /// (kernel `generation_tools_list`).
    pub fn load_tools(&mut self) {
        match self.call_decode(
            "generation.tools.list",
            &RequestEmpty {},
            decode_result_list_tools,
        ) {
            Ok(result) => self.state.tools = result.items,
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }
}
