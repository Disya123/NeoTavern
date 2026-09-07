//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    /// Reads the SEC-07 allowlist diagnostics bundle (`diagnostics.export`;
    /// React `useKernelDiagnostics`).
    pub fn load_diagnostics(&mut self) {
        match self.call_decode(
            "diagnostics.export",
            &RequestEmpty {},
            decode_result_diagnostics_export,
        ) {
            Ok(bundle) => self.state.diagnostics = Some(bundle),
            Err(err) => {
                self.state.diagnostics = None;
                self.record_error(err);
            }
        }
        self.bump_scene();
    }

    /// Reads data-root activation (`data.activation.status`; React
    /// `ActivationStatusPanel` / `useDataActivationStatus`).
    pub fn load_data_activation(&mut self) {
        match self.call_decode(
            "data.activation.status",
            &RequestEmpty {},
            decode_result_data_activation_status,
        ) {
            Ok(status) => self.state.data_activation = Some(status),
            Err(err) => {
                self.state.data_activation = None;
                self.record_error(err);
            }
        }
        self.bump_scene();
    }

    /// Reads the backup catalog (`backups.list`; React DataTab `useBackups`).
    pub fn load_backups(&mut self) {
        match self.call_decode("backups.list", &RequestEmpty {}, decode_result_list_backups) {
            Ok(result) => self.state.backups = result.items,
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Creates a user-initiated backup (`backups.create`, kernel models every
    /// backup as manual) and refreshes the catalog.
    pub fn create_backup(&mut self) {
        match self.call_decode("backups.create", &RequestEmpty {}, decode_backup_dto) {
            Ok(_) => self.load_backups(),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Restores a backup (`backups.restore`; the kernel stages + activates
    /// around a database reopen). `activation_pending` maps to the reload
    /// hint, exactly like React `useRestoreBackup.restartRequired`.
    pub fn restore_backup(&mut self, id: &str) {
        let req = RequestBackupsRestore {
            backup_id: id.to_string(),
        };
        match self.call_decode("backups.restore", &req, decode_result_backups_restore) {
            Ok(result) => {
                if result.status == "activation_pending" {
                    self.state.status_message =
                        Some("Backup restored. Reload the app to apply it.".into());
                }
                self.load_backups();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Reads the memory list (`memories.list`; React `MemoryEditor`
    /// `useMemories`).
    pub fn load_memories(&mut self) {
        match self.call_decode(
            "memories.list",
            &RequestListMemories {
                scope: None,
                character_id: None,
                enabled: None,
            },
            decode_result_list_memories,
        ) {
            Ok(result) => self.state.memories = result.items,
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn set_memory_draft_content(&mut self, value: &str) {
        self.state.memory_draft_content = value.to_string();
        self.bump_scene();
    }

    pub fn set_memory_draft_keys(&mut self, value: &str) {
        self.state.memory_draft_keys = value.to_string();
        self.bump_scene();
    }

    /// Flips the draft scope Global ↔ Character (React scope select). Going
    /// character resets the cycle index so the first loaded character is used.
    pub fn toggle_memory_draft_scope(&mut self) {
        self.state.memory_draft_scope_character = !self.state.memory_draft_scope_character;
        if !self.state.memory_draft_scope_character {
            self.state.memory_draft_character_index = 0;
        }
        self.bump_scene();
    }

    /// Cycles the character pick for a character-scoped draft (the harness
    /// plane has no `<select>`; React uses one).
    pub fn cycle_memory_character(&mut self) {
        if !self.state.characters.is_empty() {
            self.state.memory_draft_character_index =
                (self.state.memory_draft_character_index + 1) % self.state.characters.len();
        }
        self.bump_scene();
    }

    pub fn toggle_memory_draft_enabled(&mut self) {
        self.state.memory_draft_enabled = !self.state.memory_draft_enabled;
        self.bump_scene();
    }

    /// Starts inline editing: prefills the draft from the card, like React
    /// `beginEdit`.
    pub fn begin_memory_edit(&mut self, id: &str) {
        let Some(item) = self.state.memories.iter().find(|item| item.id == id) else {
            return;
        };
        self.state.memory_edit_id = Some(id.to_string());
        self.state.memory_draft_content = item.content.clone();
        self.state.memory_draft_keys = item.keys.join(", ");
        self.state.memory_draft_scope_character = item.scope == MemoryScope::Character;
        self.state.memory_draft_enabled = item.enabled;
        if item.scope == MemoryScope::Character {
            if let Some(pos) =
                self.state.characters.iter().position(|character| {
                    Some(character.id.as_str()) == item.character_id.as_deref()
                })
            {
                self.state.memory_draft_character_index = pos;
            }
        }
        self.state.memory_form_error = None;
        self.bump_scene();
    }

    pub fn cancel_memory_edit(&mut self) {
        self.reset_memory_draft();
        self.bump_scene();
    }

    pub(crate) fn reset_memory_draft(&mut self) {
        self.state.memory_edit_id = None;
        self.state.memory_draft_content.clear();
        self.state.memory_draft_keys.clear();
        self.state.memory_draft_scope_character = false;
        self.state.memory_draft_character_index = 0;
        self.state.memory_draft_enabled = true;
        self.state.memory_form_error = None;
    }

    pub(crate) fn memory_keys(&self) -> Vec<String> {
        self.state
            .memory_draft_keys
            .split(',')
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .collect()
    }

    pub(crate) fn memory_character_id(&self) -> Option<String> {
        self.state
            .characters
            .get(self.state.memory_draft_character_index)
            .map(|character| character.id.clone())
    }

    /// Saves the draft (`memories.create` when not editing, `memories.update`
    /// otherwise), mirroring React `submitCreate` / `submitUpdate` including
    /// the two client-side validations.
    pub fn save_memory(&mut self) {
        let content = self.state.memory_draft_content.trim().to_string();
        if content.is_empty() {
            self.state.memory_form_error = Some("Memory content is required.".into());
            self.bump_scene();
            return;
        }
        let character_id = if self.state.memory_draft_scope_character {
            match self.memory_character_id() {
                Some(id) => Some(id),
                None => {
                    self.state.memory_form_error =
                        Some("A character is required for a character-scoped memory.".into());
                    self.bump_scene();
                    return;
                }
            }
        } else {
            None
        };
        let keys = self.memory_keys();
        let enabled = self.state.memory_draft_enabled;
        let outcome = if let Some(edit_id) = self.state.memory_edit_id.clone() {
            let req = RequestUpdateMemory {
                memory_id: edit_id,
                scope: Some(self.memory_scope()),
                character_id,
                keys: Some(keys),
                content: Some(content),
                enabled: Some(enabled),
                position: None,
                metadata: None,
            };
            self.call_decode("memories.update", &req, decode_memory_dto)
                .map(|_| ())
        } else {
            let req = RequestCreateMemory {
                scope: Some(self.memory_scope()),
                character_id,
                keys: Some(keys),
                content,
                enabled: Some(enabled),
                position: None,
                metadata: None,
            };
            self.call_decode("memories.create", &req, decode_memory_dto)
                .map(|_| ())
        };
        match outcome {
            Ok(_) => {
                self.reset_memory_draft();
                self.load_memories();
            }
            Err(err) => {
                let code = err.reason_code().to_string();
                self.state.memory_form_error = Some(code);
            }
        }
        self.bump_scene();
    }

    pub(crate) fn memory_scope(&self) -> MemoryScope {
        if self.state.memory_draft_scope_character {
            MemoryScope::Character
        } else {
            MemoryScope::Global
        }
    }

    /// Quick enable/disable from a card switch (`memories.update` with only
    /// `enabled` set — partial update shape).
    pub fn toggle_memory(&mut self, id: &str) {
        let Some(item) = self.state.memories.iter().find(|item| item.id == id) else {
            return;
        };
        let next = !item.enabled;
        let req = RequestUpdateMemory {
            memory_id: id.to_string(),
            scope: None,
            character_id: None,
            keys: None,
            content: None,
            enabled: Some(next),
            position: None,
            metadata: None,
        };
        match self.call_decode("memories.update", &req, decode_memory_dto) {
            Ok(_) => self.load_memories(),
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn open_memory_delete(&mut self, id: &str) {
        self.state.memory_delete_target_id = Some(id.to_string());
        self.state.memory_delete_open = true;
        self.bump_scene();
    }

    pub fn close_memory_delete(&mut self) {
        self.state.memory_delete_open = false;
        self.state.memory_delete_target_id = None;
        self.bump_scene();
    }

    pub fn confirm_memory_delete(&mut self) {
        let Some(id) = self.state.memory_delete_target_id.clone() else {
            return;
        };
        let was_editing = self.state.memory_edit_id.as_deref() == Some(id.as_str());
        self.state.memory_delete_open = false;
        self.state.memory_delete_target_id = None;
        let req = RequestDeleteMemory { memory_id: id };
        match self.call_value("memories.delete", &req) {
            Ok(_) => {
                if was_editing {
                    self.reset_memory_draft();
                }
                self.load_memories();
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }
}
