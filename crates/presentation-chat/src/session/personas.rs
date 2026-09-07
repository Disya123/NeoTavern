//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    pub(crate) fn load_personas(&mut self) {
        match self.call_decode(
            "personas.list",
            &RequestEmpty {},
            decode_result_list_personas,
        ) {
            Ok(ResultListPersonas { items }) => {
                self.state.personas = items;
                if self.state.selected_persona_id.is_none() {
                    self.state.selected_persona_id =
                        self.state.personas.first().map(|row| row.id.clone());
                }
                if let Some(id) = self.state.selected_persona_id.clone() {
                    self.seed_persona_draft(&id);
                }
            }
            Err(err) => self.record_error(err),
        }
        self.load_settings();
    }

    pub(crate) fn seed_persona_draft(&mut self, id: &str) {
        if let Some(row) = self.state.personas.iter().find(|item| item.id == id) {
            self.state.persona_name_draft = row.name.clone();
            self.state.persona_description_draft = row.description.clone().unwrap_or_default();
        }
    }

    pub fn set_persona_name_draft(&mut self, draft: &str) {
        self.state.persona_name_draft = draft.to_string();
        self.bump_scene();
    }

    pub fn set_persona_description_draft(&mut self, draft: &str) {
        self.state.persona_description_draft = draft.to_string();
        self.bump_scene();
    }

    /// Save the persona editor (React `PersonasPanel` edit tab): only
    /// changed fields cross the wire; an empty trimmed name keeps the stored
    /// one; a no-op save skips the wire call.
    pub fn save_persona_meta(&mut self) {
        let Some(id) = self.state.selected_persona_id.clone() else {
            return;
        };
        let Some(current) = self
            .state
            .personas
            .iter()
            .find(|item| item.id == id)
            .map(|item| (item.name.clone(), item.description.clone()))
        else {
            return;
        };
        let (current_name, current_description) = current;
        let next_name = self.state.persona_name_draft.trim().to_string();
        let next_description = self.state.persona_description_draft.clone();
        let name_change = !next_name.is_empty() && next_name != current_name;
        let description_change = Some(next_description.clone()) != current_description
            && !(next_description.is_empty() && current_description.is_none());
        if !name_change && !description_change {
            self.state.status_message = Some("No changes.".into());
            self.bump_scene();
            return;
        }
        match self.call_decode(
            "personas.update",
            &RequestUpdatePersona {
                persona_id: id,
                name: if name_change { Some(next_name) } else { None },
                description: if description_change {
                    Some(next_description)
                } else {
                    None
                },
                avatar: None,
                is_default: None,
            },
            decode_persona_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self
                    .state
                    .personas
                    .iter_mut()
                    .find(|item| item.id == updated.id)
                {
                    row.name = updated.name.clone();
                    row.description = updated.description.clone();
                }
                self.seed_persona_draft(&updated.id);
                self.state.status_message = Some("Persona updated.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn select_persona(&mut self, id: &str) {
        self.state.selected_persona_id = Some(id.to_string());
        self.seed_persona_draft(id);
        self.state.persona_tab = "edit".into();
        self.bump_scene();
    }

    pub fn set_persona_tab(&mut self, tab: &str) {
        self.state.persona_tab = tab.to_string();
        self.bump_scene();
    }

    pub(crate) fn confirm_create_persona(&mut self) {
        let name = self.state.create_name.trim();
        let name = if name.is_empty() { "New persona" } else { name };
        let req = RequestCreatePersona {
            name: name.to_string(),
            description: None,
            avatar: None,
            is_default: Some(self.state.personas.is_empty()),
        };
        match self.call_decode("personas.create", &req, decode_persona_dto) {
            Ok(created) => {
                self.state.create_dialog_open = false;
                self.state.create_name.clear();
                self.state.selected_persona_id = Some(created.id.clone());
                self.state.persona_tab = "edit".into();
                if self.state.active_persona_id.is_none() {
                    self.state.active_persona_id = Some(created.id);
                }
                self.load_personas();
                self.state.status_message = Some("Persona created.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub(crate) fn confirm_delete_persona(&mut self) {
        let Some(id) = self.state.selected_persona_id.clone() else {
            self.state.delete_dialog_open = false;
            return;
        };
        if self.state.personas.len() <= 1 {
            self.state.delete_dialog_open = false;
            self.state.status_message = Some("At least one persona must remain.".into());
            self.bump_scene();
            return;
        }
        match self.call_value(
            "personas.delete",
            &RequestDeletePersona {
                persona_id: id.clone(),
            },
        ) {
            Ok(_) => {
                self.state.delete_dialog_open = false;
                if self.state.active_persona_id.as_deref() == Some(id.as_str()) {
                    self.state.active_persona_id = self
                        .state
                        .personas
                        .iter()
                        .find(|row| row.id != id)
                        .map(|row| row.id.clone());
                }
                self.state.selected_persona_id = None;
                self.state.persona_tab = "cards".into();
                self.load_personas();
                self.state.status_message = Some("Persona deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub(crate) fn load_lorebooks(&mut self) {
        match self.call_decode(
            "lorebooks.list",
            &RequestListLorebooks { character_id: None },
            decode_result_list_lorebooks,
        ) {
            Ok(ResultListLorebooks { items }) => {
                self.state.lorebooks = items;
                if self.state.selected_lorebook_id.is_none() {
                    self.state.selected_lorebook_id =
                        self.state.lorebooks.first().map(|row| row.id.clone());
                }
                if let Some(id) = self.state.selected_lorebook_id.clone() {
                    self.seed_lorebook_draft(&id);
                }
                if self.state.lorebook_tab == "entries" {
                    self.load_lorebook_entries();
                }
            }
            Err(err) => self.record_error(err),
        }
    }

    /// Load `lorebooks.entries.list` for the selected lorebook (React
    /// `useLorebookEntries`; kernel returns the full list in one page).
    pub(crate) fn load_lorebook_entries(&mut self) {
        let Some(id) = self.state.selected_lorebook_id.clone() else {
            self.state.lorebook_entries.clear();
            return;
        };
        match self.call_decode(
            "lorebooks.entries.list",
            &RequestListLorebookEntries { lorebook_id: id },
            decode_result_list_lorebook_entries,
        ) {
            Ok(ResultListLorebookEntries { items }) => self.state.lorebook_entries = items,
            Err(err) => self.record_error(err),
        }
    }

    pub(crate) fn seed_lorebook_draft(&mut self, id: &str) {
        if let Some(row) = self.state.lorebooks.iter().find(|item| item.id == id) {
            self.state.lorebook_name_draft = row.name.clone();
            self.state.lorebook_description_draft = row.description.clone().unwrap_or_default();
        }
    }

    pub fn set_lorebook_name_draft(&mut self, draft: &str) {
        self.state.lorebook_name_draft = draft.to_string();
        self.bump_scene();
    }

    pub fn set_lorebook_description_draft(&mut self, draft: &str) {
        self.state.lorebook_description_draft = draft.to_string();
        self.bump_scene();
    }

    /// Save the book editor (React `BookTab` name-on-blur + debounced
    /// description autosave, collapsed into one explicit action): only the
    /// fields that actually changed cross the wire; an empty trimmed name
    /// keeps the stored one (React never persists empty names).
    pub fn save_lorebook_meta(&mut self) {
        let Some(id) = self.state.selected_lorebook_id.clone() else {
            return;
        };
        let Some(card) = self
            .state
            .lorebooks
            .iter()
            .find(|item| item.id == id)
            .map(|item| (item.name.clone(), item.description.clone()))
        else {
            return;
        };
        let (current_name, current_description) = card;
        let next_name = self.state.lorebook_name_draft.trim().to_string();
        let next_description = self.state.lorebook_description_draft.clone();
        let name_change = !next_name.is_empty() && next_name != current_name;
        let description_change = Some(next_description.clone()) != current_description
            && !(next_description.is_empty() && current_description.is_none());
        if !name_change && !description_change {
            self.state.status_message = Some("No changes.".into());
            self.bump_scene();
            return;
        }
        match self.call_decode(
            "lorebooks.update",
            &RequestUpdateLorebook {
                lorebook_id: id,
                name: if name_change { Some(next_name) } else { None },
                description: if description_change {
                    Some(next_description)
                } else {
                    None
                },
                entries: None,
                character_id: None,
            },
            decode_lorebook_dto,
        ) {
            Ok(updated) => {
                if let Some(row) = self
                    .state
                    .lorebooks
                    .iter_mut()
                    .find(|item| item.id == updated.id)
                {
                    row.name = updated.name;
                    row.description = updated.description.clone();
                }
                self.seed_lorebook_draft(&updated.id);
                self.state.status_message = Some("Book updated.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn select_lorebook(&mut self, id: &str) {
        self.state.selected_lorebook_id = Some(id.to_string());
        self.seed_lorebook_draft(id);
        self.state.lorebook_tab = "book".into();
        self.bump_scene();
    }

    pub fn set_lorebook_tab(&mut self, tab: &str) {
        self.state.lorebook_tab = tab.to_string();
        if tab == "entries" {
            self.load_lorebook_entries();
        }
        self.bump_scene();
    }

    /// Open the entry dialog for a NEW entry (React `EntryDialog` with
    /// `entry: null`); `enabled` defaults to true like the React form.
    pub fn open_entry_dialog(&mut self) {
        self.state.editing_lorebook_entry_id = None;
        self.state.entry_keys_draft.clear();
        self.state.entry_secondary_keys_draft.clear();
        self.state.entry_content_draft.clear();
        self.state.entry_enabled_draft = true;
        self.state.entry_constant_draft = false;
        self.state.entry_selective_draft = false;
        self.state.entry_dialog_open = true;
        self.bump_scene();
    }

    /// Open the entry dialog pre-filled with an existing entry's values.
    pub fn open_entry_dialog_for(&mut self, entry_id: &str) {
        let Some(entry) = self
            .state
            .lorebook_entries
            .iter()
            .find(|row| row.id == entry_id)
            .cloned()
        else {
            return;
        };
        self.state.editing_lorebook_entry_id = Some(entry.id);
        self.state.entry_keys_draft = entry.keys.join("\n");
        self.state.entry_secondary_keys_draft = entry.secondary_keys.unwrap_or_default().join("\n");
        self.state.entry_content_draft = entry.content;
        self.state.entry_enabled_draft = entry.enabled;
        self.state.entry_constant_draft = entry.constant;
        self.state.entry_selective_draft = entry.selective;
        self.state.entry_dialog_open = true;
        self.bump_scene();
    }

    pub fn close_entry_dialog(&mut self) {
        self.state.entry_dialog_open = false;
        self.state.editing_lorebook_entry_id = None;
        self.bump_scene();
    }

    /// Split newline-separated draft keys exactly like React `EntryDialog`
    /// (`splitKeys`: trim + drop empties).
    pub(crate) fn split_entry_keys(value: &str) -> Vec<String> {
        value
            .split('\n')
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// Save the entry dialog: create (`lorebooks.entries.create`) or update
    /// (`lorebooks.entries.update`) for the edited id. The wire DTO carries
    /// no position/metadata (kernel-owned), so the dialog honestly has no
    /// position field.
    pub fn save_entry(&mut self) {
        let Some(book_id) = self.state.selected_lorebook_id.clone() else {
            return;
        };
        let keys = Self::split_entry_keys(&self.state.entry_keys_draft);
        if keys.is_empty() {
            self.state.status_message = Some("Entry needs at least one key.".into());
            self.bump_scene();
            return;
        }
        let secondary_keys = Self::split_entry_keys(&self.state.entry_secondary_keys_draft);
        let content = self.state.entry_content_draft.trim().to_string();
        let enabled = self.state.entry_enabled_draft;
        let constant = self.state.entry_constant_draft;
        let selective = self.state.entry_selective_draft;
        if let Some(entry_id) = self.state.editing_lorebook_entry_id.clone() {
            let req = RequestUpdateLorebookEntry {
                lorebook_id: book_id,
                entry_id,
                patch: LorebookEntryPatch {
                    keys: Some(keys),
                    secondary_keys: Some(secondary_keys),
                    content: Some(content),
                    enabled: Some(enabled),
                    constant: Some(constant),
                    selective: Some(selective),
                },
            };
            match self.call_value("lorebooks.entries.update", &req) {
                Ok(_) => {
                    self.state.entry_dialog_open = false;
                    self.state.editing_lorebook_entry_id = None;
                    self.load_lorebook_entries();
                    self.state.status_message = Some("Entry updated.".into());
                }
                Err(err) => self.record_error(err),
            }
        } else {
            let req = RequestCreateLorebookEntry {
                lorebook_id: book_id,
                entry: LorebookEntryInput {
                    keys,
                    secondary_keys: Some(secondary_keys),
                    content,
                    enabled: Some(enabled),
                    constant: Some(constant),
                    selective: Some(selective),
                },
            };
            match self.call_decode("lorebooks.entries.create", &req, decode_lorebook_entry_dto) {
                Ok(_) => {
                    self.state.entry_dialog_open = false;
                    self.load_lorebook_entries();
                    self.state.status_message = Some("Entry added.".into());
                }
                Err(err) => self.record_error(err),
            }
        }
        self.bump_scene();
    }

    /// Entry-row switch toggle (React `EntryRow` `Switch`): flips `enabled`
    /// through `lorebooks.entries.update`.
    pub fn toggle_lorebook_entry(&mut self, entry_id: &str) {
        let Some(book_id) = self.state.selected_lorebook_id.clone() else {
            return;
        };
        let Some(enabled) = self
            .state
            .lorebook_entries
            .iter()
            .find(|row| row.id == entry_id)
            .map(|row| !row.enabled)
        else {
            return;
        };
        let req = RequestUpdateLorebookEntry {
            lorebook_id: book_id,
            entry_id: entry_id.to_string(),
            patch: LorebookEntryPatch {
                keys: None,
                secondary_keys: None,
                content: None,
                enabled: Some(enabled),
                constant: None,
                selective: None,
            },
        };
        match self.call_value("lorebooks.entries.update", &req) {
            Ok(_) => self.load_lorebook_entries(),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub(crate) fn confirm_delete_entry(&mut self) {
        let Some(book_id) = self.state.selected_lorebook_id.clone() else {
            self.state.entry_delete_open = false;
            return;
        };
        let Some(entry_id) = self.state.entry_delete_target_id.clone() else {
            self.state.entry_delete_open = false;
            return;
        };
        match self.call_value(
            "lorebooks.entries.delete",
            &RequestDeleteLorebookEntry {
                lorebook_id: book_id,
                entry_id,
            },
        ) {
            Ok(_) => {
                self.state.entry_delete_open = false;
                self.state.entry_delete_target_id = None;
                self.load_lorebook_entries();
                self.state.status_message = Some("Entry deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_entry_keys_draft(&mut self, value: &str) {
        self.state.entry_keys_draft = value.to_string();
        self.bump_scene();
    }

    pub fn set_entry_secondary_keys_draft(&mut self, value: &str) {
        self.state.entry_secondary_keys_draft = value.to_string();
        self.bump_scene();
    }

    pub fn set_entry_content_draft(&mut self, value: &str) {
        self.state.entry_content_draft = value.to_string();
        self.bump_scene();
    }

    pub(crate) fn confirm_create_lorebook(&mut self) {
        let name = self.state.create_name.trim();
        let name = if name.is_empty() {
            "New lorebook"
        } else {
            name
        };
        let req = RequestCreateLorebook {
            name: name.to_string(),
            description: None,
            entries: None,
            character_id: None,
        };
        match self.call_decode("lorebooks.create", &req, decode_lorebook_dto) {
            Ok(created) => {
                self.state.create_dialog_open = false;
                self.state.create_name.clear();
                self.state.selected_lorebook_id = Some(created.id);
                self.state.lorebook_tab = "book".into();
                self.load_lorebooks();
                self.state.status_message = Some("Lorebook created.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub(crate) fn confirm_delete_lorebook(&mut self) {
        let Some(id) = self.state.selected_lorebook_id.clone() else {
            self.state.delete_dialog_open = false;
            return;
        };
        match self.call_value(
            "lorebooks.delete",
            &RequestDeleteLorebook { lorebook_id: id },
        ) {
            Ok(_) => {
                self.state.delete_dialog_open = false;
                self.state.selected_lorebook_id = None;
                self.state.lorebook_tab = "books".into();
                self.load_lorebooks();
                self.state.status_message = Some("Lorebook deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }
}
