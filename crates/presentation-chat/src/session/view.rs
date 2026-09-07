//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    /// Message header data (React `MessageBubble` header): author name per
    /// role plus an en-US `Intl`-style timestamp label. Display macros are
    /// expanded on committed rows (not while streaming).
    pub(crate) fn macro_context(&self) -> crate::macros::MacroContext {
        crate::macros::build_macro_context(
            self.user_display_name(),
            self.char_display_name(),
            self.state.macro_variables.clone(),
            None,
        )
    }

    pub(crate) fn user_display_name(&self) -> String {
        let chat_persona = self
            .state
            .chat
            .as_ref()
            .and_then(|chat| chat.persona_id.as_deref());
        let app = self.state.active_persona_id.as_deref();
        pick_active_persona(&self.state.personas, chat_persona, app)
            .map(|row| row.name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "User".into())
    }

    pub(crate) fn char_display_name(&self) -> String {
        self.state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .or(self
                .state
                .chat
                .as_ref()
                .map(|chat| chat.character_id.as_str()))
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .map(|card| card.name.clone())
            })
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Assistant".into())
    }

    pub(crate) fn assistant_author(&self) -> String {
        self.state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .map(|card| card.name.clone())
            })
            .or_else(|| self.state.chat.as_ref().map(|chat| chat.title.clone()))
            .unwrap_or_else(|| "Assistant".into())
    }

    /// Chat main-area width in CSS px: surface minus the occupied rail/panel
    /// strip (`shell_hit::chat_origin_from_parts`), so the RSX column and the
    /// host hit zones size against the area React's `<main>` actually gives
    /// the workspace — not the full window.
    pub(crate) fn chat_column_width(&self) -> u32 {
        let occupied = crate::shell_hit::chat_origin_from_parts(
            self.viewport_width.max(1) as f32,
            self.state.sidebar_open,
            self.panel_width(),
        );
        (self.viewport_width as f32 - occupied).max(1.0) as u32
    }

    pub fn view(&self) -> ProductChatView {
        let title = self
            .state
            .chat
            .as_ref()
            .map(|chat| chat.title.clone())
            .unwrap_or_else(|| "Chat".into());
        let (mut visible, _) = self.visible_window();
        if !self.state.streaming_text.is_empty() {
            visible.push(VisibleRow {
                id: "streaming".into(),
                role: "assistant".into(),
                content: self.state.streaming_text.clone(),
                kind: RowKind::Markdown,
                author: self.assistant_author(),
                timestamp: String::new(),
                run_id: None,
                manual_excluded: false,
                checkpoint_chat_id: None,
                swipe_label: String::new(),
                model: None,
                generation_time: None,
                token_count: None,
            });
        }
        // Hydrate the pager counter onto its row: `hydrate_swipe_label` filled
        // the cache after `variants.list`/`.activate`; empty = hidden
        // (React renders the counter only when `total > 1`).
        if let Some(label_row) = self.state.swipe_label_for.as_deref() {
            if let Some(row) = visible.iter_mut().find(|row| row.id == label_row) {
                row.swipe_label = self.state.swipe_label.clone();
            }
        }
        // React chat chrome is header + composer only; the TripleGlass /
        // PaintOrder variants are M0 glass-layering probes (perf-probe
        // scenarios construct them explicitly), not product UI.
        let chrome = ProductChrome::HeaderComposer;
        let composer_placeholder = self
            .state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .map(|card| card.name.clone())
            })
            .map(|name| format!("Message {name}…"))
            .unwrap_or_else(|| "Message…".into());
        let character_name = self
            .state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .map(|card| card.name.clone())
            })
            .unwrap_or_default();
        // React header/message avatars use the pinned character's asset.
        let character_avatar_asset = self
            .state
            .pinned_character_id
            .as_deref()
            .or(self.state.selected_character_id.as_deref())
            .and_then(|id| {
                self.state
                    .characters
                    .iter()
                    .find(|card| card.id == id)
                    .and_then(|card| card.avatar_asset_id.clone())
            })
            .unwrap_or_default();
        let context_summary = Some(self.context_estimate(&visible));
        // Variant picker popover (React `MessageVariantPicker`): rows derive
        // from the last successful `chats.messages.variants.list` — stored
        // variants plus the active content row (kernel mode carries no
        // permutation fields on the message, so the active text joins as the
        // implicit last item and the list sorts by position).
        let variant_picker_rows = self.variant_picker_row_views();
        ProductChatView {
            title,
            message_count: self.kernel_message_count(),
            visible,
            chrome,
            composer_text: self.state.composer_text.clone(),
            composer_placeholder,
            character_avatar_asset,
            character_name,
            active_theme_tokens: self.state.active_theme_tokens.clone(),
            error_code: self.state.last_error.as_ref().map(|err| err.code.clone()),
            streaming: !self.state.streaming_text.is_empty() || self.state.stream_handle.is_some(),
            tool_activity_name: if !self.state.streaming_text.is_empty()
                || self.state.stream_handle.is_some()
            {
                self.state.tool_activity_name.clone()
            } else {
                None
            },
            viewport_width: self.viewport_width,
            viewport_height: self.viewport_height,
            column_width: self.chat_column_width(),
            context_panel_open: self.state.context_panel_open,
            context_summary,
            editing_message_id: self.state.message_edit_id.clone(),
            editing_draft: self.state.message_edit_draft.clone(),
            history_open_for: self.state.history_message_id.clone(),
            details_message_id: self.state.details_message_id.clone(),
            details_mode: if self.state.details_mode.is_empty() {
                "details".to_string()
            } else {
                self.state.details_mode.clone()
            },
            revision_history: self.state.message_revisions.clone(),
            snapshots_menu_open: self.state.snapshots_menu_open,
            snapshot_items: self
                .state
                .snapshot_items
                .iter()
                .map(|chat| SnapshotItemView {
                    id: chat.id.clone(),
                    title: chat.title.clone(),
                    origin_label: match chat.origin.as_ref() {
                        Some(SnapshotOrigin::Branch) => "Branch".to_string(),
                        _ => "Checkpoint".to_string(),
                    },
                    message_count: chat.message_count,
                })
                .collect(),
            header_search_open: self.state.header_search_open,
            header_search_query: self.state.header_search_query.clone(),
            header_search_match_count: self.state.header_search_match_count,
            variant_picker_for: self.state.variant_picker_for.clone(),
            variant_picker_rows,
            // `None` variants = the lazy list query still loading (React
            // `variants.isLoading`); a fetched-but-empty list shows the
            // honest empty copy.
            variant_picker_empty: self.state.variant_picker_for.is_some()
                && self.state.variant_picker_variants.is_empty(),
            parent_chat_id: self
                .state
                .chat
                .as_ref()
                .and_then(|chat| chat.parent_chat_id.clone()),
        }
    }

    /// React `MessageVariantPicker` rows (kernel mode: the message carries
    /// no permutation fields, so the picker always takes the second branch).
    /// Stored variants keep their wire positions; the active message text
    /// appends as the implicit last item when it is not a stored row; the
    /// stored row matching the active content is marked active. Sorted by
    /// position — the React listbox order.
    pub(crate) fn variant_picker_row_views(
        &self,
    ) -> Vec<neotavern_presentation_dioxus_shell::VariantRowView> {
        let Some(message_id) = self.state.variant_picker_for.as_deref() else {
            return Vec::new();
        };
        let Some(row) = self.state.messages.iter().find(|row| row.id == message_id) else {
            return Vec::new();
        };
        let stored = &self.state.variant_picker_variants;
        let content_index = stored
            .iter()
            .position(|variant| variant.content == row.content);
        let total = stored.len().saturating_add(1);
        let mut rows: Vec<neotavern_presentation_dioxus_shell::VariantRowView> = stored
            .iter()
            .enumerate()
            .map(
                |(index, variant)| neotavern_presentation_dioxus_shell::VariantRowView {
                    id: variant.id.clone(),
                    index_label: format!("{}/{}", variant.position + 1, total),
                    preview: preview_text(&variant.content),
                    active: Some(index) == content_index,
                },
            )
            .collect();
        if content_index.is_none() {
            // The active text is not a stored variant: React appends it
            // (id `active-<messageId>`, position = stored length).
            rows.push(neotavern_presentation_dioxus_shell::VariantRowView {
                id: format!("active-{message_id}"),
                index_label: format!("{total}/{total}"),
                preview: preview_text(&row.content),
                active: true,
            });
        }
        rows.sort_by_key(|row| {
            row.index_label
                .split_once('/')
                .and_then(|(current, _)| current.parse::<u64>().ok())
                .unwrap_or(u64::MAX)
        });
        rows
    }

    /// Local context estimate for the composer context meter (React
    /// `useConversationContextPreview` fallback branch: no prompt audit on
    /// this plane, so the summary is always the draft-estimate state).
    /// History = the visible rows' script-aware estimate; the draft adds the
    /// composer text; the whole sum lands in `chat_history` exactly like the
    /// React fallback breakdown.
    pub(crate) fn context_estimate(&self, visible: &[VisibleRow]) -> ContextUsageSummaryV1 {
        const CONTEXT_LIMIT: u64 = 16_032; // contracts CONTEXT_TOKEN_DEFAULT
        const RESERVED_FOR_REPLY: u64 = 4_000;

        let history: u64 = visible
            .iter()
            .filter(|row| !row.manual_excluded)
            .map(|row| estimate_tokens(&row.content))
            .sum();
        let draft = estimate_tokens(&self.state.composer_text);
        let prompt_tokens = history + draft;
        let available = CONTEXT_LIMIT
            .saturating_sub(RESERVED_FOR_REPLY)
            .saturating_sub(prompt_tokens);
        let usage_percent = (((prompt_tokens + RESERVED_FOR_REPLY) * 100) / CONTEXT_LIMIT).min(100);
        ContextUsageSummaryV1 {
            prompt_tokens,
            context_limit: CONTEXT_LIMIT,
            reserved_for_reply: RESERVED_FOR_REPLY,
            available_tokens: available,
            usage_percent,
            breakdown: ContextUsageBreakdownV1 {
                chat_history: prompt_tokens,
                ..ContextUsageBreakdownV1::default()
            },
        }
    }

    pub fn shell_view(&self) -> ProductShellView {
        let mut characters: Vec<CharacterCardView> = self
            .state
            .characters
            .iter()
            .filter(|row| {
                let q = self.state.character_search.trim().to_lowercase();
                if q.is_empty() {
                    return true;
                }
                row.name.to_lowercase().contains(&q)
                    || row
                        .description
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&q)
                    || row.tags.iter().any(|tag| tag.to_lowercase().contains(&q))
            })
            .map(|row| CharacterCardView {
                id: row.id.clone(),
                name: row.name.clone(),
                description: row.description.clone().unwrap_or_default(),
                tags: row.tags.clone(),
                avatar_asset_id: row.avatar_asset_id.clone(),
                avatar_data_uri: None,
            })
            .collect();
        match self.state.character_sort.as_str() {
            "name-desc" => {
                characters.sort_by(|a, b| b.name.to_lowercase().cmp(&a.name.to_lowercase()))
            }
            "newest" | "oldest" => {}
            _ => characters.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
        }
        if self.state.character_sort == "oldest" {
            characters.reverse();
        }
        let selected = self
            .state
            .selected_character_id
            .clone()
            .or_else(|| characters.first().map(|row| row.id.clone()));
        let selected_draft = self.state.character_draft.clone();
        ProductShellView {
            chat: self.view(),
            characters,
            selected_character_id: selected.clone(),
            selected_draft,
            pinned_character_id: self
                .state
                .pinned_character_id
                .clone()
                .or_else(|| selected.clone()),
            search: self.state.character_search.clone(),
            sort: self.state.character_sort.clone(),
            view: self.state.character_view.clone(),
            tab: self.state.character_tab.clone(),
            panel: self.state.sidebar_panel.clone(),
            sidebar_open: self.state.sidebar_open,
            rail_expanded: self.state.rail_expanded,
            panel_width: self.panel_width(),
            density: "comfortable".into(),
            font_scale: if matches!(self.state.ui_scale.as_str(), "small" | "medium" | "large") {
                self.state.ui_scale.clone()
            } else {
                "medium".into()
            },
            insets: self.state.insets,
            editor_mode: if self.state.character_editor_mode.is_empty() {
                "view".into()
            } else {
                self.state.character_editor_mode.clone()
            },
            create_dialog_open: self.state.create_dialog_open,
            delete_dialog_open: self.state.delete_dialog_open,
            create_name: self.state.create_name.clone(),
            create_description: self.state.create_description.clone(),
            create_first_message: self.state.create_first_message.clone(),
            status_message: self.state.status_message.clone(),
            error_message: self.state.last_error.as_ref().map(|err| err.code.clone()),
            gallery_columns: if (1..=4).contains(&self.state.gallery_columns) {
                self.state.gallery_columns
            } else {
                3
            },
            gallery_sort: if self.state.gallery_sort == "newest" {
                "newest".into()
            } else {
                "oldest".into()
            },
            expanded_greeting: self.state.expanded_greeting,
            tag_input: self.state.tag_input.clone(),
            panel_scroll_css: self.state.panel_scroll_css,
            personas: self.persona_cards(),
            selected_persona_id: self.state.selected_persona_id.clone(),
            persona_tab: self.state.persona_tab.clone(),
            persona_search: self.state.persona_search.clone(),
            persona_sort: self.state.persona_sort.clone(),
            persona_name_draft: self.state.persona_name_draft.clone(),
            persona_description_draft: self.state.persona_description_draft.clone(),
            persona_create_open: self.state.sidebar_panel == "personas"
                && self.state.create_dialog_open,
            persona_delete_open: self.state.sidebar_panel == "personas"
                && self.state.delete_dialog_open,
            persona_create_name: self.state.create_name.clone(),
            active_persona_id: self.state.active_persona_id.clone(),
            lorebooks: self.lorebook_cards(),
            selected_lorebook_id: self.state.selected_lorebook_id.clone(),
            lorebook_tab: self.state.lorebook_tab.clone(),
            lorebook_search: self.state.lorebook_search.clone(),
            lorebook_create_open: self.state.sidebar_panel == "lorebooks"
                && self.state.create_dialog_open,
            lorebook_delete_open: self.state.sidebar_panel == "lorebooks"
                && self.state.delete_dialog_open,
            lorebook_create_name: self.state.create_name.clone(),
            lorebook_name_draft: self.state.lorebook_name_draft.clone(),
            lorebook_description_draft: self.state.lorebook_description_draft.clone(),
            lorebook_entries: self
                .state
                .lorebook_entries
                .iter()
                .map(|row| LorebookEntryCardView {
                    id: row.id.clone(),
                    keys: row.keys.clone(),
                    secondary_keys: row.secondary_keys.clone(),
                    content: row.content.clone(),
                    enabled: row.enabled,
                    constant: row.constant,
                    selective: row.selective,
                })
                .collect(),
            editing_lorebook_entry_id: self.state.editing_lorebook_entry_id.clone(),
            entry_dialog_open: self.state.entry_dialog_open,
            entry_delete_open: self.state.entry_delete_open,
            entry_keys_draft: self.state.entry_keys_draft.clone(),
            entry_secondary_keys_draft: self.state.entry_secondary_keys_draft.clone(),
            entry_content_draft: self.state.entry_content_draft.clone(),
            entry_enabled_draft: self.state.entry_enabled_draft,
            entry_constant_draft: self.state.entry_constant_draft,
            entry_selective_draft: self.state.entry_selective_draft,
            entry_delete_target_id: self.state.entry_delete_target_id.clone(),
            entry_content_tokens: estimate_tokens(&self.state.entry_content_draft),
            profiles: self
                .state
                .profiles
                .iter()
                .map(|row| ProfileCardView {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    created_at: row.created_at.clone(),
                    updated_at: row.updated_at.clone(),
                })
                .collect(),
            profile_create_name: self.state.profile_create_name.clone(),
            profile_renaming_id: self.state.profile_renaming_id.clone(),
            profile_rename_name: self.state.profile_rename_name.clone(),
            profile_delete_open: self.state.profile_delete_open,
            profile_delete_target_id: self.state.profile_delete_target_id.clone(),
            plugin_uninstall_open: self.state.plugin_uninstall_open,
            plugin_uninstall_target_id: self.state.plugin_uninstall_target_id.clone(),
            chat_rename_open: self.state.chat_rename_open,
            chat_renaming_id: self.state.chat_renaming_id.clone(),
            chat_rename_draft: self.state.chat_rename_draft.clone(),
            chat_delete_open: self.state.chat_delete_open,
            chat_delete_target_id: self.state.chat_delete_target_id.clone(),
            prompt_plan_open: self.state.prompt_plan_open,
            prompt_plan_run_id: self.state.prompt_plan_run_id.clone(),
            prompt_plan: self.state.prompt_plan.clone(),
            prompt_plan_not_found: self.state.prompt_plan_not_found,
            prompt_plan_error: self.state.prompt_plan_error.clone(),
            run_transcript_open: self.state.run_transcript_open,
            run_transcript_run_id: self.state.run_transcript_run_id.clone(),
            run_transcript_steps: self.state.run_transcript_steps.clone(),
            run_transcript_error: self.state.run_transcript_error.clone(),
            checkpoint_delete_open: self.state.checkpoint_delete_open,
            checkpoint_delete_message_id: self.state.checkpoint_delete_message_id.clone(),
            themes: self
                .state
                .themes
                .iter()
                .map(|row| ThemeCardView {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    version: row.version.clone(),
                    active: row.active,
                    trust_state: row.trust_state.clone(),
                })
                .collect(),
            theme_delete_open: self.state.theme_delete_open,
            theme_delete_target_id: self.state.theme_delete_target_id.clone(),
            active_theme_tokens: self.state.active_theme_tokens.clone(),
            active_theme_css: self.state.active_theme_css.clone(),
            secrets_status: self.state.secrets_status.clone(),
            selected_provider_id: self.state.active_provider_id.clone(),
            provider_configs: self
                .state
                .provider_configs
                .iter()
                .map(|item| ProviderConfigCardView {
                    id: item.id.clone(),
                    name: item.name.clone(),
                    detail: format!(
                        "{} · API key {}",
                        item.provider,
                        if item.has_api_key { "saved" } else { "not set" }
                    ),
                })
                .collect(),
            provider_create_dialog_open: self.state.provider_create_dialog_open,
            provider_kind_label: self
                .state
                .providers
                .get(self.state.provider_kind_index)
                .map(|item| item.name.clone()),
            provider_name_draft: self.state.provider_name_draft.clone(),
            provider_form_error: self.state.provider_form_error.clone(),
            provider_delete_target_id: self.state.provider_delete_target_id.clone(),
            card_import_dialog_open: self.state.card_import_dialog_open,
            card_path_draft: self.state.card_path_draft.clone(),
            prompt_template_import_open: self.state.prompt_template_import_open,
            prompt_template_path_draft: self.state.prompt_template_path_draft.clone(),
            generation_preset_import_open: self.state.generation_preset_import_open,
            generation_preset_path_draft: self.state.generation_preset_path_draft.clone(),
            profile_import_path: self.state.profile_import_path.clone(),
            profile_import_policy_label: match self.state.profile_import_policy_index {
                1 => "Replace".to_string(),
                2 => "Remap".to_string(),
                _ => "Reject".to_string(),
            },
            selected_preset_id: self.state.active_preset_id.clone(),
            preset_rows: self.preset_value_rows(),
            preset_unlocked_context: self.state.preset_unlocked_context,
            preset_active_name: self
                .state
                .presets
                .iter()
                .find(|item| Some(item.id.as_str()) == self.state.active_preset_id.as_deref())
                .map(|item| item.name.clone()),
            preset_name_dialog_open: self.state.preset_name_dialog_open,
            preset_name_mode: self.state.preset_name_mode.clone(),
            preset_name_draft: self.state.preset_name_draft.clone(),
            preset_form_error: self.state.preset_form_error.clone(),
            preset_delete_open: self.state.preset_delete_open,
            preset_dialog_kind: if self.state.preset_dialog_kind.is_empty() {
                "generation".into()
            } else {
                self.state.preset_dialog_kind.clone()
            },
            prompt_presets: self
                .state
                .prompt_presets
                .iter()
                .map(|item| PresetCardView {
                    id: item.id.clone(),
                    name: item.name.clone(),
                    kind: item.kind.clone(),
                })
                .collect(),
            active_prompt_preset_id: self.state.active_prompt_preset_id.clone(),
            prompt_preset_active_name: self
                .state
                .prompt_presets
                .iter()
                .find(|item| {
                    Some(item.id.as_str()) == self.state.active_prompt_preset_id.as_deref()
                })
                .map(|item| item.name.clone()),
            backups: self
                .state
                .backups
                .iter()
                .map(|item| BackupCardView {
                    id: item.id.clone(),
                    title: item.created_at.clone(),
                    detail: format!(
                        "Manual backup · {:.1} MB",
                        item.size_bytes as f64 / 1024.0 / 1024.0
                    ),
                })
                .collect(),
            memories: self
                .state
                .memories
                .iter()
                .map(|item| {
                    let scope_label = match item.scope {
                        MemoryScope::Global => "Global".to_string(),
                        MemoryScope::Character => item
                            .character_id
                            .as_deref()
                            .and_then(|id| {
                                self.state
                                    .characters
                                    .iter()
                                    .find(|character| character.id == id)
                            })
                            .map(|character| character.name.clone())
                            .unwrap_or_else(|| "Character".to_string()),
                    };
                    let meta = if item.keys.is_empty() {
                        scope_label
                    } else {
                        format!("{} — {}", scope_label, item.keys.join(", "))
                    };
                    MemoryCardView {
                        id: item.id.clone(),
                        meta,
                        content: item.content.clone(),
                        enabled: item.enabled,
                    }
                })
                .collect(),
            memory_edit_id: self.state.memory_edit_id.clone(),
            memory_draft_content: self.state.memory_draft_content.clone(),
            memory_draft_keys: self.state.memory_draft_keys.clone(),
            memory_draft_scope_character: self.state.memory_draft_scope_character,
            memory_draft_character_label: if self.state.memory_draft_scope_character {
                self.memory_character_id().and_then(|id| {
                    self.state
                        .characters
                        .iter()
                        .find(|character| character.id == id)
                        .map(|character| character.name.clone())
                })
            } else {
                None
            },
            memory_draft_enabled: self.state.memory_draft_enabled,
            memory_form_error: self.state.memory_form_error.clone(),
            memory_delete_open: self.state.memory_delete_open,
            memory_delete_target_id: self.state.memory_delete_target_id.clone(),
            tools: self
                .state
                .tools
                .iter()
                .map(|row| ToolCardView {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    description: row.description.clone(),
                    required: row
                        .input_schema
                        .get("required")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|value| value.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect(),
            plugins: self
                .state
                .plugins
                .iter()
                .map(|row| PluginCardView {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    version: row.version.clone(),
                    enabled: row.enabled,
                    trust_state: row.trust_state.clone(),
                    permissions: row.permissions.clone(),
                })
                .collect(),
            providers: self.state.providers.clone(),
            presets: self
                .state
                .presets
                .iter()
                .map(|item| PresetCardView {
                    id: item.id.clone(),
                    name: item.name.clone(),
                    kind: item.kind.clone(),
                })
                .collect(),
            chat_list: {
                let query = self.state.chat_search.trim().to_lowercase();
                self.state
                    .chat_list
                    .iter()
                    .filter(|row| query.is_empty() || row.title.to_lowercase().contains(&query))
                    .map(|row| {
                        let character_label = if row.character_id.is_empty() {
                            String::new()
                        } else {
                            self.state
                                .characters
                                .iter()
                                .find(|card| card.id == row.character_id)
                                .map(|card| card.name.clone())
                                .unwrap_or_default()
                        };
                        ChatCardView {
                            id: row.id.clone(),
                            title: row.title.clone(),
                            message_count: row.message_count,
                            character_label,
                        }
                    })
                    .collect()
            },
            selected_chat_id: self.chat_id.clone(),
            chat_search: self.state.chat_search.clone(),
            language: if self.state.language.is_empty() {
                "en".into()
            } else {
                self.state.language.clone()
            },
            dir: if self.state.dir.is_empty() {
                "ltr".into()
            } else {
                self.state.dir.clone()
            },
            ai_tab: self.state.ai_tab.clone(),
            settings_tab: self.state.settings_tab.clone(),
            ui_contrast: self.state.ui_contrast.clone(),
            ui_font_profile: self.state.ui_font_profile.clone(),
            ui_motion: self.state.ui_motion.clone(),
            open_home_on_load: self.state.open_home_on_load,
            chat_style: self.state.chat_style.clone(),
            chat_avatar_style: self.state.chat_avatar_style.clone(),
            user_message_position: self.state.user_message_position.clone(),
            character_message_position: self.state.character_message_position.clone(),
            ui_opacity: self.state.ui_opacity.min(100),
            ui_glass_blur: self.state.ui_glass_blur.min(40),
            diagnostics: self.state.diagnostics.clone(),
            data_activation: self.state.data_activation.clone(),
            prompt_template_mode: self
                .state
                .prompt_template
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("chat")
                .to_string(),
            instruct_selection: if self.state.instruct_selection.is_empty() {
                "native".into()
            } else {
                self.state.instruct_selection.clone()
            },
            instruct_form_error: self.state.instruct_form_error.clone(),
            prompt_blocks: prompt_block_views(&self.state.prompt_template),
            prompt_block_edit_open: self.state.prompt_block_edit_id.is_some(),
            prompt_block_name_draft: self.state.prompt_block_name_draft.clone(),
            prompt_block_content_draft: self.state.prompt_block_content_draft.clone(),
            prompt_block_content_editable: self
                .state
                .prompt_block_edit_id
                .as_deref()
                .is_some_and(prompt_block_content_editable),
            prompt_block_injection_position: self.state.prompt_block_injection_position.clone(),
            prompt_block_depth_draft: self.state.prompt_block_depth_draft.clone(),
            prompt_block_order_draft: self.state.prompt_block_order_draft.clone(),
            prompt_block_role: self.state.prompt_block_role.clone(),
            prompt_block_triggers: self.state.prompt_block_triggers.clone(),
            prompt_block_forbid_overrides: self.state.prompt_block_forbid_overrides,
            prompt_block_model_draft: self.state.prompt_block_model_draft.clone(),
            instruct_system: instruct_role_text(&self.state.instruct_format, "system"),
            instruct_user: instruct_role_text(&self.state.instruct_format, "user"),
            instruct_assistant: instruct_role_text(&self.state.instruct_format, "assistant"),
            instruct_tool: instruct_role_text(&self.state.instruct_format, "tool"),
            instruct_prompt_suffix: instruct_role_text(&self.state.instruct_format, "promptSuffix"),
            instruct_stop_strings: instruct_stop_text(&self.state.instruct_format),
        }
    }

    pub(crate) fn persona_cards(&self) -> Vec<PersonaCardView> {
        self.state
            .personas
            .iter()
            .map(|row| PersonaCardView {
                id: row.id.clone(),
                name: row.name.clone(),
                description: row.description.clone().unwrap_or_default(),
                is_default: row.is_default,
                is_active: self.state.active_persona_id.as_deref() == Some(row.id.as_str()),
            })
            .collect()
    }

    pub(crate) fn lorebook_cards(&self) -> Vec<LorebookCardView> {
        self.state
            .lorebooks
            .iter()
            .map(|row| LorebookCardView {
                id: row.id.clone(),
                name: row.name.clone(),
                description: row.description.clone().unwrap_or_default(),
                entry_count: row.entry_count,
                character_id: row.character_id.clone(),
            })
            .collect()
    }

    pub fn present_visible(&self) -> (Vec<VisibleRow>, PresentOutcome) {
        self.visible_window()
    }

    pub fn selected_text(&self) -> Option<String> {
        self.state.messages.last().map(|row| row.content.clone())
    }

    pub(crate) fn visible_window(&self) -> (Vec<VisibleRow>, PresentOutcome) {
        let (_, _, viewport_h, _) = chrome_metrics(self.viewport_width, self.viewport_height);
        virtualized_window(
            &self.state.messages,
            f64::from(viewport_h),
            f64::from(self.state.scroll_offset_css),
            &self.assistant_author(),
            &self.macro_context(),
        )
    }

    pub fn mount_vdom(&self) -> usize {
        mount_product_chat(self.view())
    }

    pub fn snapshot_json(&self) -> String {
        let view = self.view();
        let visible: Vec<Value> = view
            .visible
            .iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "role": row.role,
                    "content": row.content,
                })
            })
            .collect();
        json!({
            "chatId": self.chat_id,
            "title": view.title,
            "messageCount": view.message_count,
            "kernelMessageCount": view.message_count,
            "pageLen": self.state.messages.len(),
            "composer": view.composer_text,
            "error": view.error_code,
            "streaming": view.streaming,
            "issued": self.issued,
            "requestId": self.state.last_send_request_id.as_ref().or(self.state.last_request_id.as_ref()),
            "operationId": self.state.last_send_operation_id.as_ref().or(self.state.last_operation_id.as_ref()),
            "durableMessageId": self.state.last_durable_message_id,
            "sceneEpoch": self.state.scene_epoch,
            "sendAccepted": self.state.send_accepted,
            "visible": visible,
        })
        .to_string()
    }

    /// Host debug line. Never includes message or composer content.
    pub fn send_trace_line(&self) -> String {
        let error = self
            .state
            .last_error
            .as_ref()
            .map(|err| err.code.as_str())
            .unwrap_or("none");
        format!(
            "chat_send live_wire=true requestId={} operationId={} durableMessageId={} kernelMessageCount={} pageLen={} sceneEpoch={} sendAccepted={} error={} production_cutover=false",
            self.state
                .last_send_request_id
                .as_deref()
                .or(self.state.last_request_id.as_deref())
                .unwrap_or("-"),
            self.state
                .last_send_operation_id
                .as_deref()
                .or(self.state.last_operation_id.as_deref())
                .unwrap_or("-"),
            self.state.last_durable_message_id.as_deref().unwrap_or("-"),
            self.kernel_message_count(),
            self.state.messages.len(),
            self.state.scene_epoch,
            self.state.send_accepted,
            error,
        )
    }
}
