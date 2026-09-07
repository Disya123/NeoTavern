//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    /// Observability for declarative `custom.<owner>.<name>` intents. They
    /// carry no Product Wire authority by contract, so the default behavior
    /// is an honest trace toast; a future plugin registry attaches real
    /// handlers without changing the document or this call site.
    pub fn custom_intent(&mut self, name: &str) {
        self.state.status_message = Some(format!("[custom] {name} — no handler attached."));
        self.bump_scene();
    }

    /// Full text of a message row by id (host clipboard copy reads this; the
    /// actual OS clipboard write stays on the host, off the shared surface).
    pub fn message_text(&self, row_id: &str) -> Option<String> {
        self.state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .map(|row| row.content.clone())
    }

    /// Reflect that the host copied a message to the OS clipboard. The toast is
    /// only honest: the host writes the clipboard first and calls this after
    /// the write succeeded. Mirrors React `MessageBubble` copy (client-side).
    pub fn copied_message(&mut self, row_id: &str) {
        if self.state.messages.iter().any(|row| row.id == row_id) {
            self.state.status_message = Some("Message copied to clipboard.".into());
            self.bump_scene();
        }
    }

    /// Delete a message via `chats.messages.delete` (React builtin action,
    /// `data-action="delete"` in the inline row).
    pub fn delete_message(&mut self, row_id: &str) {
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_value(
            "chats.messages.delete",
            &RequestDeleteMessage {
                chat_id,
                message_id: row_id.to_string(),
            },
        ) {
            Ok(_) => {
                self.state.messages.retain(|row| row.id != row_id);
                // Keep the cached chat DTO in step with the wire store (the
                // count also feeds the header/chats panel).
                if let Some(chat) = self.state.chat.as_mut() {
                    chat.message_count = (chat.message_count - 1).max(0);
                }
                self.state.status_message = Some("Message deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Open the inline message editor (React `MessageBubble` edit state,
    /// `data-action="edit"`): seeds the draft from the stored content. The
    /// streaming row and an already-open editor are honest no-ops.
    pub fn start_message_edit(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        if self.state.message_edit_id.as_deref() == Some(row_id) {
            return;
        }
        let Some(message) = self.state.messages.iter().find(|row| row.id == row_id) else {
            return;
        };
        self.state.message_edit_id = Some(row_id.to_string());
        self.state.message_edit_draft = message.content.clone();
        self.state.history_message_id = None;
        self.bump_scene();
    }

    pub fn set_message_edit_draft(&mut self, draft: &str) {
        if self.state.message_edit_id.is_some() {
            self.state.message_edit_draft = draft.to_string();
            self.bump_scene();
        }
    }

    /// Close the editor without touching the wire (React Cancel / Escape).
    pub fn cancel_message_edit(&mut self) {
        self.state.message_edit_id = None;
        self.state.message_edit_draft.clear();
        self.bump_scene();
    }

    /// Save the inline editor via `chats.messages.update`. React parity: an
    /// empty or unchanged draft just closes the editor without a wire call;
    /// a failed update keeps the draft open (the error surfaces via
    /// `record_error`).
    pub fn submit_message_edit(&mut self) {
        let Some(row_id) = self.state.message_edit_id.clone() else {
            return;
        };
        let next = self.state.message_edit_draft.trim().to_string();
        let Some(current) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .map(|row| row.content.clone())
        else {
            self.cancel_message_edit();
            return;
        };
        if next.is_empty() || next == current {
            self.cancel_message_edit();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.messages.update",
            &RequestUpdateMessage {
                chat_id,
                message_id: row_id.clone(),
                content: Some(next),
                meta: None,
                clear_checkpoint_chat_id: None,
            },
            decode_message_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                    row.content = updated.content;
                }
                self.state.message_edit_id = None;
                self.state.message_edit_draft.clear();
                self.state.status_message = Some("Message updated.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Open the revision-history card (React `MessageRevisionHistoryCard`,
    /// `data-action="history"`): loads the immutable previous contents of one
    /// message via `chats.messages.revisions.list`.
    pub fn open_message_history(&mut self, row_id: &str) {
        if row_id == "streaming" {
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.messages.revisions.list",
            &RequestMessageRevisionsList {
                chat_id,
                message_id: row_id.to_string(),
            },
            decode_result_message_revision_list,
        ) {
            Ok(result) => {
                self.state.history_message_id = Some(row_id.to_string());
                self.state.message_revisions = result
                    .items
                    .iter()
                    .map(|rev: &MessageRevisionDto| RevisionRow {
                        content: rev.content.clone(),
                        created_at: rev.created_at.clone(),
                    })
                    .collect();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn close_message_history(&mut self) {
        self.state.history_message_id = None;
        self.state.message_revisions.clear();
        self.bump_scene();
    }

    /// Toggle or open the message details card (`data-action="details"`).
    pub fn open_message_details(&mut self, row_id: &str) {
        if self.state.details_message_id.as_deref() == Some(row_id) {
            self.state.details_message_id = None;
            self.state.details_mode = "details".into();
        } else {
            self.state.details_message_id = Some(row_id.to_string());
            self.state.details_mode = "details".into();
        }
        self.bump_scene();
    }

    /// Close the message details card (`data-action="details-close"`).
    pub fn close_message_details(&mut self) {
        if self.state.details_message_id.is_some() {
            self.state.details_message_id = None;
            self.state.details_mode = "details".into();
            self.state.message_edit_id = None;
            self.state.message_edit_draft.clear();
            self.bump_scene();
        }
    }

    /// Set message details mode (`"details"`, `"actions"`, or `"edit"`).
    pub fn set_message_details_mode(&mut self, mode: &str) {
        if self.state.details_mode != mode {
            self.state.details_mode = mode.to_string();
            if mode == "edit" {
                if let Some(msg_id) = self.state.details_message_id.clone() {
                    self.state.message_edit_id = Some(msg_id.clone());
                    if let Some(msg) = self.state.messages.iter().find(|m| m.id == msg_id) {
                        self.state.message_edit_draft = msg.content.clone();
                    }
                }
            } else if mode == "details" || mode == "actions" {
                self.state.message_edit_id = None;
                self.state.message_edit_draft.clear();
            }
            self.bump_scene();
        }
    }

    /// Submit the message details editor (React `MessageDetailsCardV2` save).
    pub fn submit_message_details_edit(&mut self) {
        let Some(row_id) = self.state.details_message_id.clone() else {
            return;
        };
        let next = self.state.message_edit_draft.trim().to_string();
        let Some(current) = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .map(|row| row.content.clone())
        else {
            self.close_message_details();
            return;
        };
        if next.is_empty() || next == current {
            self.close_message_details();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.messages.update",
            &RequestUpdateMessage {
                chat_id,
                message_id: row_id.clone(),
                content: Some(next),
                meta: None,
                clear_checkpoint_chat_id: None,
            },
            decode_message_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                    row.content = updated.content;
                }
                self.state.message_edit_id = None;
                self.state.message_edit_draft.clear();
                self.state.details_message_id = None;
                self.state.details_mode = "details".into();
                self.state.status_message = Some("Message updated.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Step UI opacity by a signed delta, clamped to `[0, 100]` (React range slider / stepper).
    pub fn step_ui_opacity(&mut self, delta: i32) {
        let current = self.state.ui_opacity as i32;
        self.state.ui_opacity = (current + delta).clamp(0, 100) as u32;
        self.bump_scene();
    }

    /// Step glass blur by a signed delta, clamped to `[0, 40]` (React range slider / stepper).
    pub fn step_ui_glass_blur(&mut self, delta: i32) {
        let current = self.state.ui_glass_blur as i32;
        self.state.ui_glass_blur = (current + delta).clamp(0, 40) as u32;
        self.bump_scene();
    }

    /// Toggle the snapshots menu (React `ChatSnapshotsMenu` header trigger).
    /// Opening loads the child chats of the active chat via
    /// `chats.snapshots.list`; a chat without snapshots shows the honest
    /// empty state, exactly like React.
    pub fn toggle_snapshots_menu(&mut self) {
        if self.state.snapshots_menu_open {
            self.close_snapshots_menu();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.snapshots.list",
            &RequestSnapshotsList {
                chat_id,
                cursor: None,
                limit: None,
            },
            decode_result_snapshots_list,
        ) {
            Ok(result) => {
                self.state.snapshot_items = result.items;
                self.state.snapshots_menu_open = true;
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn close_snapshots_menu(&mut self) {
        self.state.snapshots_menu_open = false;
        self.state.snapshot_items.clear();
        self.bump_scene();
    }

    /// Open a snapshot row (React navigates to the child chat's own route):
    /// closes the menu and switches to that chat.
    pub fn open_snapshot(&mut self, chat_id: &str) {
        self.close_snapshots_menu();
        self.open_chat(chat_id);
    }

    /// Export one chat via `chats.export` (React `ChatManagementPanel`
    /// "Export" item): the wire returns a kind-tagged JSON document as
    /// base64; the session decodes it and parks it in `last_export` for the
    /// host's file sink (React downloads to the browser, the desktop host
    /// writes a file).
    pub fn export_chat(&mut self, chat_id: &str) {
        match self.call_decode(
            "chats.export",
            &RequestChatsExport {
                chat_id: chat_id.to_string(),
            },
            decode_result_chats_export,
        ) {
            Ok(result) => {
                use base64::Engine as _;
                match base64::engine::general_purpose::STANDARD.decode(&result.content_base64) {
                    Ok(bytes) => {
                        self.state.last_export = Some(LastExport {
                            filename: result.filename.clone(),
                            bytes,
                        });
                        self.state.status_message =
                            Some(format!("Export ready: {}.", result.filename));
                    }
                    Err(_) => self.record_error(ChatRouteError::product(
                        "CONTRACT_VIOLATION",
                        serde_json::json!({ "field": "contentBase64" }),
                    )),
                }
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Host-side sink handoff: consume the parked export after writing it.
    pub fn take_last_export(&mut self) -> Option<LastExport> {
        self.state.last_export.take()
    }

    /// Host confirms where the export landed; the status reflects it.
    pub fn note_export_path(&mut self, path: &str) {
        if self.state.last_export.is_none() {
            self.state.status_message = Some(format!("Exported to {path}"));
            self.bump_scene();
        }
    }

    /// Open the card-import dialog (React `CharacterManagementPanel` hidden
    /// file input; the native host prompts for a path instead).
    pub fn open_card_import(&mut self) {
        if self.state.card_import_dialog_open {
            return;
        }
        self.state.card_path_draft.clear();
        self.state.card_import_dialog_open = true;
        self.bump_scene();
    }

    pub fn close_card_import(&mut self) {
        self.state.card_import_dialog_open = false;
        self.state.card_path_draft.clear();
        self.bump_scene();
    }

    pub fn set_card_path_draft(&mut self, draft: &str) {
        if self.state.card_import_dialog_open {
            self.state.card_path_draft = draft.to_string();
            self.bump_scene();
        }
    }

    /// Stage the file via `assets.put` (kind `card`) and import it through
    /// `imports.character.card` — kernel dedupes by content sha256, so a
    /// re-import reports the existing character (`created == false`). The
    /// imported character becomes the selected one, like React.
    pub fn confirm_card_import(&mut self) {
        let path = self.state.card_path_draft.trim().to_string();
        if path.is_empty() {
            self.state.status_message =
                Some("Provide a JSON or PNG character card from this device.".into());
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
        let filename = std::path::Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "card.json".into());
        let content_type = if filename.to_lowercase().ends_with(".png") {
            "image/png"
        } else {
            "application/json"
        };
        use base64::Engine as _;
        let staged = self.call_decode(
            "assets.put",
            &RequestAssetsPut {
                kind: "card".into(),
                filename: filename.clone(),
                content_type: Some(content_type.into()),
                content_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            },
            decode_result_assets_put,
        );
        let asset_id = match staged {
            Ok(result) => result.asset.id,
            Err(err) => {
                self.record_error(err);
                self.bump_scene();
                return;
            }
        };
        match self.call_decode(
            "imports.character.card",
            &RequestImportsCharacterCard { asset_id },
            decode_result_imports_character_card,
        ) {
            Ok(result) => {
                self.refresh_characters();
                self.select_character(&result.character.id);
                self.close_card_import();
                self.state.status_message = Some(if result.created {
                    format!("Imported {}.", result.character.name)
                } else {
                    format!("Already imported ({}).", result.character.name)
                });
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Export the selected character's card via `characters.export.card`
    /// (JSON format): the SillyTavern container comes back base64-encoded
    /// and parks in `last_export` for the host's file sink.
    pub fn export_character_card(&mut self, character_id: &str) {
        match self.call_decode(
            "characters.export.card",
            &RequestCharactersExportCard {
                character_id: character_id.to_string(),
                format: CardExportFormat::Json,
            },
            decode_result_characters_export_card,
        ) {
            Ok(result) => {
                use base64::Engine as _;
                match base64::engine::general_purpose::STANDARD.decode(&result.content_base64) {
                    Ok(bytes) => {
                        self.state.last_export = Some(LastExport {
                            filename: result.filename.clone(),
                            bytes,
                        });
                        self.state.status_message =
                            Some(format!("Export ready: {}.", result.filename));
                    }
                    Err(_) => self.record_error(ChatRouteError::product(
                        "CONTRACT_VIOLATION",
                        serde_json::json!({ "field": "contentBase64" }),
                    )),
                }
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    const PROFILE_IMPORT_POLICIES: [RequestProfileImportPolicy; 3] = [
        RequestProfileImportPolicy::Reject,
        RequestProfileImportPolicy::Replace,
        RequestProfileImportPolicy::Remap,
    ];

    pub fn set_profile_import_path(&mut self, path: &str) {
        self.state.profile_import_path = path.to_string();
        self.bump_scene();
    }

    /// Cycle the duplicate policy (React `<select>`: reject / replace /
    /// remap); the host renders it as a cycling button.
    pub fn cycle_profile_import_policy(&mut self) {
        let next =
            (self.state.profile_import_policy_index + 1) % Self::PROFILE_IMPORT_POLICIES.len();
        self.state.profile_import_policy_index = next;
        self.bump_scene();
    }

    /// Import a verified profile container via `profile.import` (React
    /// `ProfilesPanel` import form): the relative `containerPath` plus the
    /// duplicate policy; success refreshes the library surfaces React
    /// invalidates (characters / chats / lorebooks / presets).
    pub fn submit_profile_import(&mut self) {
        let container_path = self.state.profile_import_path.trim().to_string();
        if container_path.is_empty() {
            self.state.status_message =
                Some("Provide the container path staged under the data root.".into());
            self.bump_scene();
            return;
        }
        let policy = Self::PROFILE_IMPORT_POLICIES[self.state.profile_import_policy_index].clone();
        match self.call_decode(
            "profile.import",
            &RequestProfileImport {
                container_path,
                policy,
            },
            decode_result_profile_import,
        ) {
            Ok(result) => {
                self.refresh_characters();
                self.load_chat_list();
                self.load_lorebooks();
                self.load_presets_list();
                self.load_prompt_presets_list();
                let orphans_note = if result.orphans.is_empty() {
                    String::new()
                } else {
                    format!(" ({} orphans)", result.orphans.len())
                };
                self.state.status_message = Some(format!(
                    "Imported: {inserted} inserted, {updated} updated, {skipped} skipped.{orphans_note}",
                    inserted = result.inserted,
                    updated = result.updated,
                    skipped = result.skipped
                ));
                self.state.profile_import_path.clear();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Freeze the prefix up to and including this message into a fresh child
    /// chat via `chats.snapshots.create` (React builtin actions
    /// `data-action="checkpoint"` / `"branch"`). The user stays in the
    /// current chat; the child appears in the chats list and the snapshots
    /// menu (React parity: a notification offers the jump instead).
    pub fn create_message_snapshot(&mut self, row_id: &str, checkpoint: bool) {
        if row_id == "streaming" {
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.snapshots.create",
            &RequestCreateChatSnapshot {
                chat_id,
                message_id: row_id.to_string(),
                kind: if checkpoint {
                    SnapshotOrigin::Checkpoint
                } else {
                    SnapshotOrigin::Branch
                },
                title: None,
            },
            decode_result_chat_snapshot,
        ) {
            Ok(ResultChatSnapshot {
                chat: child,
                copied_messages,
            }) => {
                if checkpoint {
                    if let Some(row) = self.state.messages.iter_mut().find(|row| row.id == row_id) {
                        row.checkpoint_chat_id = Some(child.id.clone());
                    }
                }
                // The child chat is a real chat: keep the sidebar list honest.
                self.load_chat_list();
                self.state.status_message = Some(if checkpoint {
                    format!("Checkpoint created ({copied_messages} messages copied).")
                } else {
                    format!("Branch created ({copied_messages} messages copied).")
                });
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Roll the chat back to this message via `chats.snapshots.rollback`
    /// (React builtin action, `data-action="rollback"`): the wire store
    /// removes everything after the target (higher sequence), the message
    /// itself stays. The visible window is rebuilt from the authoritative
    /// store so the target may sit outside the previously cached page.
    pub fn rollback_to_message(&mut self, row_id: &str) {
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.snapshots.rollback",
            &RequestSnapshotsRollback {
                chat_id: chat_id.clone(),
                to_message_id: row_id.to_string(),
            },
            decode_result_snapshots_rollback,
        ) {
            Ok(result) => {
                match self.list_messages(&chat_id, None) {
                    Ok(page) => {
                        self.state.messages.clear();
                        self.absorb_latest_page(page);
                    }
                    Err(err) => self.record_error(err),
                }
                if let Some(chat) = self.state.chat.as_mut() {
                    chat.message_count = (chat.message_count - result.deleted).max(0);
                }
                self.state.status_message = Some(format!(
                    "Chat rolled back ({deleted} messages removed).",
                    deleted = result.deleted
                ));
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Regenerate one assistant response via `generation.retry` with that
    /// row's own source run (`MessageDto.generation_run_id`) — the React
    /// version-controls "Regenerate" action. Rows without a stored run
    /// surface an honest error instead of silently retrying the latest run.
    pub fn regenerate_message(&mut self, row_id: &str) {
        let Some(source_run_id) = self
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
            return;
        };
        if let Err(err) = self.start_stream_op(
            "generation.retry",
            &RequestRetryGeneration { source_run_id },
        ) {
            self.record_error(err);
        }
        self.bump_scene();
    }

    /// Swipe to the previous/next variant of an assistant response
    /// (`chats.messages.variants.list` + `.activate`, React
    /// `MessageSwipePager`). The current position is derived from the row's
    /// content; activation swaps the message content on the wire and the
    /// visible window is refreshed from the authoritative store.
    pub fn swipe_variant(&mut self, row_id: &str, direction: i32) {
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        let mut items = match self.call_decode(
            "chats.messages.variants.list",
            &RequestMessageVariantsList {
                chat_id: chat_id.clone(),
                message_id: row_id.to_string(),
            },
            decode_result_message_variant_list,
        ) {
            Ok(result) => result.items,
            Err(err) => {
                self.record_error(err);
                return;
            }
        };
        if items.len() < 2 {
            self.state.status_message = Some("No other variants.".into());
            self.bump_scene();
            return;
        }
        items.sort_by_key(|variant| variant.position);
        let current = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| {
                items
                    .iter()
                    .position(|variant| variant.content == row.content)
            })
            .unwrap_or(0);
        let target_index = current as isize + direction as isize;
        if target_index < 0 || target_index >= items.len() as isize {
            self.state.status_message = Some("No more variants.".into());
            self.bump_scene();
            return;
        }
        if let Err(err) = self.call_value(
            "chats.messages.variants.activate",
            &RequestMessageVariantActivate {
                chat_id: chat_id.clone(),
                message_id: row_id.to_string(),
                variant_id: items[target_index as usize].id.clone(),
            },
        ) {
            self.record_error(err);
            return;
        }
        match self.list_messages(&chat_id, None) {
            Ok(page) => {
                self.state.messages.clear();
                self.absorb_latest_page(page);
            }
            Err(err) => self.record_error(err),
        }
        self.state.status_message = Some(format!(
            "Variant {current} of {total}.",
            current = target_index + 1,
            total = items.len()
        ));
        // The pager counter follows the activation (React invalidates the
        // variants query and re-derives `currentSwipe`).
        self.hydrate_swipe_label(row_id, &items);
        self.bump_scene();
    }
    pub fn open_variant_picker(&mut self, row_id: &str) {
        if self.state.variant_picker_for.as_deref() == Some(row_id) {
            self.state.variant_picker_for = None;
            self.bump_scene();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        match self.call_decode(
            "chats.messages.variants.list",
            &RequestMessageVariantsList {
                chat_id: chat_id.clone(),
                message_id: row_id.to_string(),
            },
            decode_result_message_variant_list,
        ) {
            Ok(result) => {
                self.state.variant_picker_for = Some(row_id.to_string());
                self.state.variant_picker_variants = result.items.clone();
                self.hydrate_swipe_label(row_id, &result.items);
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn close_variant_picker(&mut self) {
        self.state.variant_picker_for = None;
        self.state.variant_picker_variants.clear();
        self.bump_scene();
    }

    /// Pick a row inside the picker popover: the active row is a no-op
    /// (React `if (!row.active)`), otherwise `variants.activate` by the
    /// variant id (the synthesized `active-` row never crosses the wire).
    pub fn pick_variant(&mut self, row_id: &str, variant_id: &str) {
        if variant_id.starts_with("active-") {
            // React closes the popover on the active row without mutating.
            self.close_variant_picker();
            return;
        }
        let Some(chat_id) = self.chat_id().map(str::to_string) else {
            return;
        };
        if let Err(err) = self.call_value(
            "chats.messages.variants.activate",
            &RequestMessageVariantActivate {
                chat_id: chat_id.clone(),
                message_id: row_id.to_string(),
                variant_id: variant_id.to_string(),
            },
        ) {
            self.record_error(err);
            return;
        }
        match self.list_messages(&chat_id, None) {
            Ok(page) => {
                self.state.messages.clear();
                self.absorb_latest_page(page);
            }
            Err(err) => self.record_error(err),
        }
        // Re-list the variants so the picker rows and the swipe counter
        // reflect the activation (React invalidates the variants query).
        match self.list_variants(&chat_id, row_id) {
            Ok(items) => {
                self.state.variant_picker_variants = items.clone();
                self.hydrate_swipe_label(row_id, &items);
            }
            Err(err) => self.record_error(err),
        }
        self.state.variant_picker_for = None;
        self.bump_scene();
    }

    pub(crate) fn list_variants(
        &mut self,
        chat_id: &str,
        message_id: &str,
    ) -> Result<Vec<MessageVariantDto>, ChatRouteError> {
        let result = self.call_decode(
            "chats.messages.variants.list",
            &RequestMessageVariantsList {
                chat_id: chat_id.to_string(),
                message_id: message_id.to_string(),
            },
            decode_result_message_variant_list,
        )?;
        Ok(result.items)
    }

    /// React `ChatPage` counter derivation over the fetched variant list:
    /// the active content matches a stored variant (1-based `position + 1`)
    /// or is the implicit last row (= total = stored count + 1); fewer than
    /// two rows hide the pager (React renders `null` when `total <= 1`).
    pub(crate) fn hydrate_swipe_label(&mut self, row_id: &str, items: &[MessageVariantDto]) {
        let mut items: Vec<&MessageVariantDto> = items.iter().collect();
        items.sort_by_key(|variant| variant.position);
        if items.is_empty() {
            self.state.swipe_label_for = None;
            self.state.swipe_label = String::new();
            return;
        }
        let total = items.len() + 1;
        let current = self
            .state
            .messages
            .iter()
            .find(|row| row.id == row_id)
            .and_then(|row| {
                items
                    .iter()
                    .position(|variant| variant.content == row.content)
            })
            .map(|index| items[index].position + 1)
            .unwrap_or(total as i64);
        self.state.swipe_label_for = Some(row_id.to_string());
        self.state.swipe_label = format!("{current}/{total}");
    }
}
