//! Keyboard input for the desktop host: every `TextFocus` target maps to one
//! session draft setter (`type_char` / `backspace`).

use super::{instruct_focus_role, App, TextFocus};

impl App {
    pub(super) fn instruct_field_text(&self, role: &str) -> String {
        let format = &self.session.route_state().instruct_format;
        match role {
            "system" => crate::session::instruct_role_text(format, "system"),
            "user" => crate::session::instruct_role_text(format, "user"),
            "assistant" => crate::session::instruct_role_text(format, "assistant"),
            "tool" => crate::session::instruct_role_text(format, "tool"),
            "promptSuffix" => crate::session::instruct_role_text(format, "promptSuffix"),
            "stopStrings" => crate::session::instruct_stop_text(format),
            _ => String::new(),
        }
    }

    /// Type one character into the focused text field (keyboard or `--type`).
    pub(super) fn type_char(&mut self, ch: char) {
        match self.focus {
            TextFocus::Composer => {
                let current = self.session.view().composer_text;
                let next = format!("{current}{ch}");
                self.session
                    .set_composer_text(next.clone())
                    .unwrap_or_else(|err| eprintln!("[neocompositor-desktop] composer: {err}"));
                eprintln!("[neocompositor-desktop] typed '{ch}' -> composer=\"{next}\"");
            }
            TextFocus::CharacterSearch => {
                let current = self.session.route_state().character_search.clone();
                let next = format!("{current}{ch}");
                self.session.set_character_search(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> search=\"{next}\"");
            }
            TextFocus::ChatSearch => {
                let current = self.session.route_state().chat_search.clone();
                let next = format!("{current}{ch}");
                self.session.set_chat_search(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> chat_search=\"{next}\"");
            }
            TextFocus::CreateName => {
                let current = self.session.route_state().create_name.clone();
                let next = format!("{current}{ch}");
                self.session.set_create_name(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> create_name=\"{next}\"");
            }
            TextFocus::ProfileCreateName => {
                let current = self.session.route_state().profile_create_name.clone();
                let next = format!("{current}{ch}");
                self.session.set_profile_create_name(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> profile_create_name=\"{next}\"");
            }
            TextFocus::ProfileRename => {
                let current = self.session.route_state().profile_rename_name.clone();
                let next = format!("{current}{ch}");
                self.session.set_profile_rename_name(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> profile_rename_name=\"{next}\"");
            }
            TextFocus::ChatRename => {
                let current = self.session.route_state().chat_rename_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_chat_rename_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> chat_rename=\"{next}\"");
            }
            TextFocus::MemoryContent => {
                let current = self.session.route_state().memory_draft_content.clone();
                let next = format!("{current}{ch}");
                self.session.set_memory_draft_content(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> memory_content=\"{next}\"");
            }
            TextFocus::MemoryKeys => {
                let current = self.session.route_state().memory_draft_keys.clone();
                let next = format!("{current}{ch}");
                self.session.set_memory_draft_keys(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> memory_keys=\"{next}\"");
            }
            TextFocus::PresetName => {
                let current = self.session.route_state().preset_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_preset_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> preset_name=\"{next}\"");
            }
            TextFocus::ProviderName => {
                let current = self.session.route_state().provider_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_provider_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> provider_name=\"{next}\"");
            }
            TextFocus::MessageEdit => {
                let current = self.session.view().editing_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_message_edit_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> edit_draft=\"{next}\"");
            }
            TextFocus::LorebookName => {
                let current = self.session.route_state().lorebook_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_lorebook_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> lorebook_name=\"{next}\"");
            }
            TextFocus::LorebookDescription => {
                let current = self.session.route_state().lorebook_description_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_lorebook_description_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> lorebook_desc+{ch}");
            }
            TextFocus::PersonaName => {
                let current = self.session.route_state().persona_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_persona_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> persona_name=\"{next}\"");
            }
            TextFocus::PersonaDescription => {
                let current = self.session.route_state().persona_description_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_persona_description_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> persona_desc+{ch}");
            }
            TextFocus::CardPath => {
                let current = self.session.route_state().card_path_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_card_path_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> card_path+{ch}");
            }
            TextFocus::PromptTemplatePath => {
                let current = self.session.route_state().prompt_template_path_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_template_path_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_template_path+{ch}");
            }
            TextFocus::PresetImportPath => {
                let current = self
                    .session
                    .route_state()
                    .generation_preset_path_draft
                    .clone();
                let next = format!("{current}{ch}");
                self.session.set_generation_preset_path_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> generation_preset_path+{ch}");
            }
            TextFocus::ProfileImportPath => {
                let current = self.session.route_state().profile_import_path.clone();
                let next = format!("{current}{ch}");
                self.session.set_profile_import_path(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> import_path+{ch}");
            }
            TextFocus::HeaderSearch => {
                let current = self.session.view().header_search_query;
                let next = format!("{current}{ch}");
                self.session.set_header_search_query(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> header_search=\"{next}\"");
            }
            TextFocus::InstructSystem
            | TextFocus::InstructUser
            | TextFocus::InstructAssistant
            | TextFocus::InstructTool
            | TextFocus::InstructSuffix
            | TextFocus::InstructStops => {
                let role = instruct_focus_role(self.focus).expect("instruct focus");
                let current = self.instruct_field_text(role);
                let next = format!("{current}{ch}");
                self.session.set_instruct_role(role, &next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> instruct.{role}");
            }
            TextFocus::PromptBlockName => {
                let current = self.session.route_state().prompt_block_name_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_name=\"{next}\"");
            }
            TextFocus::PromptBlockContent => {
                let current = self.session.route_state().prompt_block_content_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_content_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_content+{ch}");
            }
            TextFocus::PromptBlockDepth => {
                let current = self.session.route_state().prompt_block_depth_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_depth_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_depth=\"{next}\"");
            }
            TextFocus::PromptBlockOrder => {
                let current = self.session.route_state().prompt_block_order_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_order_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_order=\"{next}\"");
            }
            TextFocus::PromptBlockModel => {
                let current = self.session.route_state().prompt_block_model_draft.clone();
                let next = format!("{current}{ch}");
                self.session.set_prompt_block_model_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> prompt_block_model=\"{next}\"");
            }
            TextFocus::CharacterName => {
                let current = self
                    .session
                    .route_state()
                    .character_draft
                    .as_ref()
                    .map(|draft| draft.name.clone())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_character_name_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> character_name=\"{next}\"");
            }
            TextFocus::CharacterDescription => {
                let current = self
                    .session
                    .route_state()
                    .character_draft
                    .as_ref()
                    .map(|draft| draft.description.clone())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_character_description_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> character_desc+{ch}");
            }
            TextFocus::CharacterTag => {
                let current = self.session.route_state().tag_input.clone();
                let next = format!("{current}{ch}");
                self.session.set_tag_input(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> tag_input=\"{next}\"");
            }
            TextFocus::CharacterFirstMessage => {
                let current = self
                    .session
                    .route_state()
                    .character_draft
                    .as_ref()
                    .map(|draft| draft.first_message.clone())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_character_first_message(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> character_first_msg+{ch}");
            }
            TextFocus::CharacterCreatorNotes => {
                let current = self
                    .session
                    .route_state()
                    .character_draft
                    .as_ref()
                    .map(|draft| draft.creator_notes.clone())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_character_creator_notes(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> character_creator_notes+{ch}");
            }
            TextFocus::CharacterGreeting(idx) => {
                let current = self
                    .session
                    .route_state()
                    .character_draft
                    .as_ref()
                    .and_then(|draft| draft.alternate_greetings.get(idx).cloned())
                    .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_alternate_greeting(idx, &next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> greeting[{idx}]+{ch}");
            }
            TextFocus::PresetSampler => {
                let current = self
            .session
            .preset_value_rows()
            .iter()
            .find(|row| row.focused)
            .map(|row| row.value.clone())
            .unwrap_or_default();
                let next = format!("{current}{ch}");
                self.session.set_preset_value_draft(&next);
                eprintln!("[neocompositor-desktop] typed '{ch}' -> preset_sampler=\"{next}\"");
            }
            TextFocus::None => return,
        }
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }

    /// Backspace into the focused text field.
    pub(super) fn backspace(&mut self) {
        let current = match self.focus {
            TextFocus::Composer => self.session.view().composer_text,
            TextFocus::CharacterSearch => self.session.route_state().character_search.clone(),
            TextFocus::ChatSearch => self.session.route_state().chat_search.clone(),
            TextFocus::CreateName => self.session.route_state().create_name.clone(),
            TextFocus::ProfileCreateName => self.session.route_state().profile_create_name.clone(),
            TextFocus::ProfileRename => self.session.route_state().profile_rename_name.clone(),
            TextFocus::ChatRename => self.session.route_state().chat_rename_draft.clone(),
            TextFocus::MemoryContent => self.session.route_state().memory_draft_content.clone(),
            TextFocus::MemoryKeys => self.session.route_state().memory_draft_keys.clone(),
            TextFocus::PresetName => self.session.route_state().preset_name_draft.clone(),
            TextFocus::ProviderName => self.session.route_state().provider_name_draft.clone(),
            TextFocus::MessageEdit => self.session.view().editing_draft.clone(),
            TextFocus::LorebookName => self.session.route_state().lorebook_name_draft.clone(),
            TextFocus::LorebookDescription => {
                self.session.route_state().lorebook_description_draft.clone()
            }
            TextFocus::PersonaName => self.session.route_state().persona_name_draft.clone(),
            TextFocus::PersonaDescription => {
                self.session.route_state().persona_description_draft.clone()
            }
            TextFocus::CardPath => self.session.route_state().card_path_draft.clone(),
            TextFocus::PromptTemplatePath => {
                self.session.route_state().prompt_template_path_draft.clone()
            }
            TextFocus::PresetImportPath => self
                .session
                .route_state()
                .generation_preset_path_draft
                .clone(),
            TextFocus::ProfileImportPath => self.session.route_state().profile_import_path.clone(),
            TextFocus::HeaderSearch => self.session.view().header_search_query,
            TextFocus::InstructSystem
            | TextFocus::InstructUser
            | TextFocus::InstructAssistant
            | TextFocus::InstructTool
            | TextFocus::InstructSuffix
            | TextFocus::InstructStops => {
                let role = instruct_focus_role(self.focus).expect("instruct focus");
                self.instruct_field_text(role)
            }
            TextFocus::PromptBlockName => self.session.route_state().prompt_block_name_draft.clone(),
            TextFocus::PromptBlockContent => {
                self.session.route_state().prompt_block_content_draft.clone()
            }
            TextFocus::PromptBlockDepth => {
                self.session.route_state().prompt_block_depth_draft.clone()
            }
            TextFocus::PromptBlockOrder => {
                self.session.route_state().prompt_block_order_draft.clone()
            }
            TextFocus::PromptBlockModel => {
                self.session.route_state().prompt_block_model_draft.clone()
            }
            TextFocus::CharacterName => self
                .session
                .route_state()
                .character_draft
                .as_ref()
                .map(|draft| draft.name.clone())
                .unwrap_or_default(),
            TextFocus::CharacterDescription => self
                .session
                .route_state()
                .character_draft
                .as_ref()
                .map(|draft| draft.description.clone())
                .unwrap_or_default(),
            TextFocus::CharacterTag => self.session.route_state().tag_input.clone(),
            TextFocus::CharacterFirstMessage => self
                .session
                .route_state()
                .character_draft
                .as_ref()
                .map(|draft| draft.first_message.clone())
                .unwrap_or_default(),
            TextFocus::CharacterCreatorNotes => self
                .session
                .route_state()
                .character_draft
                .as_ref()
                .map(|draft| draft.creator_notes.clone())
                .unwrap_or_default(),
            TextFocus::CharacterGreeting(idx) => self
                .session
                .route_state()
                .character_draft
                .as_ref()
                .and_then(|draft| draft.alternate_greetings.get(idx).cloned())
                .unwrap_or_default(),
            TextFocus::PresetSampler => self
            .session
            .preset_value_rows()
            .iter()
            .find(|row| row.focused)
            .map(|row| row.value.clone())
            .unwrap_or_default(),
            TextFocus::None => return,
        };
        let next: String = current
            .chars()
            .take(current.chars().count().saturating_sub(1))
            .collect();
        match self.focus {
            TextFocus::Composer => {
                let _ = self.session.set_composer_text(next);
            }
            TextFocus::CharacterSearch => self.session.set_character_search(&next),
            TextFocus::ChatSearch => self.session.set_chat_search(&next),
            TextFocus::CreateName => self.session.set_create_name(&next),
            TextFocus::ProfileCreateName => self.session.set_profile_create_name(&next),
            TextFocus::ProfileRename => self.session.set_profile_rename_name(&next),
            TextFocus::ChatRename => self.session.set_chat_rename_draft(&next),
            TextFocus::MemoryContent => self.session.set_memory_draft_content(&next),
            TextFocus::MemoryKeys => self.session.set_memory_draft_keys(&next),
            TextFocus::PresetName => self.session.set_preset_name_draft(&next),
            TextFocus::ProviderName => self.session.set_provider_name_draft(&next),
            TextFocus::MessageEdit => self.session.set_message_edit_draft(&next),
            TextFocus::LorebookName => self.session.set_lorebook_name_draft(&next),
            TextFocus::LorebookDescription => self.session.set_lorebook_description_draft(&next),
            TextFocus::PersonaName => self.session.set_persona_name_draft(&next),
            TextFocus::PersonaDescription => self.session.set_persona_description_draft(&next),
            TextFocus::CardPath => self.session.set_card_path_draft(&next),
            TextFocus::PromptTemplatePath => self.session.set_prompt_template_path_draft(&next),
            TextFocus::PresetImportPath => self.session.set_generation_preset_path_draft(&next),
            TextFocus::ProfileImportPath => self.session.set_profile_import_path(&next),
            TextFocus::HeaderSearch => self.session.set_header_search_query(&next),
            TextFocus::InstructSystem
            | TextFocus::InstructUser
            | TextFocus::InstructAssistant
            | TextFocus::InstructTool
            | TextFocus::InstructSuffix
            | TextFocus::InstructStops => {
                let role = instruct_focus_role(self.focus).expect("instruct focus");
                self.session.set_instruct_role(role, &next);
            }
            TextFocus::PromptBlockName => self.session.set_prompt_block_name_draft(&next),
            TextFocus::PromptBlockContent => self.session.set_prompt_block_content_draft(&next),
            TextFocus::PromptBlockDepth => self.session.set_prompt_block_depth_draft(&next),
            TextFocus::PromptBlockOrder => self.session.set_prompt_block_order_draft(&next),
            TextFocus::PromptBlockModel => self.session.set_prompt_block_model_draft(&next),
            TextFocus::CharacterName => self.session.set_character_name_draft(&next),
            TextFocus::CharacterDescription => self.session.set_character_description_draft(&next),
            TextFocus::CharacterTag => self.session.set_tag_input(&next),
            TextFocus::CharacterFirstMessage => self.session.set_character_first_message(&next),
            TextFocus::CharacterCreatorNotes => self.session.set_character_creator_notes(&next),
            TextFocus::CharacterGreeting(idx) => self.session.set_alternate_greeting(idx, &next),
            TextFocus::PresetSampler => self.session.set_preset_value_draft(&next),
            TextFocus::None => {}
        }
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }
}
