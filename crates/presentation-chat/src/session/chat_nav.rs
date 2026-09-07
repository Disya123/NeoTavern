//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;

/// React `useCharacters(limit: 50)`: one browser page of cards.
pub(crate) const CHARACTERS_PAGE: usize = 50;

/// Keyed cache of the filtered+sorted browser cards (see
/// [`ChatSession::filtered_character_cards`]).
pub(crate) struct CharacterCardsCache {
    pub(crate) revision: u64,
    pub(crate) search: String,
    pub(crate) sort: String,
    pub(crate) cards: std::sync::Arc<Vec<CharacterCardView>>,
}

impl<W: ProductWire> ChatSession<W> {
    pub(crate) fn load_workspace(&mut self) -> Result<(), ChatRouteError> {
        let chat_result = self.load_open_chat();
        self.load_characters();
        self.load_chat_list();
        // Personas + settings feed display macros (`{{user}}` / custom vars).
        self.load_personas();
        chat_result
    }

    /// Refresh the home/chats panel list (`chats.list`).
    pub(crate) fn load_chat_list(&mut self) {
        match self.call_decode(
            "chats.list",
            &RequestListChats {
                character_id: None,
                cursor: None,
                limit: Some(PAGE_LIMIT),
            },
            decode_paged_chats,
        ) {
            Ok(PagedChats { items, .. }) => self.state.chat_list = items,
            Err(err) => self.record_error(err),
        }
    }

    /// Chat search field on the home/chats panel (client-side title filter,
    /// like the React `searchInput` state).
    pub fn set_chat_search(&mut self, query: &str) {
        self.state.chat_search = query.to_string();
        self.bump_scene();
    }

    /// "New chat" action from the home/chats panel: durable `chats.create` on
    /// the pinned (or first) character, then open the fresh chat in place —
    /// React's `handleCreate` navigates to the new chat.
    pub fn create_chat(&mut self) {
        let Some(character_id) = self
            .state
            .pinned_character_id
            .clone()
            .or_else(|| self.state.selected_character_id.clone())
        else {
            return;
        };
        match self.call_decode(
            "chats.create",
            &RequestCreateChat {
                character_id,
                title: None,
                persona_id: None,
            },
            decode_chat_dto,
        ) {
            Ok(chat) => {
                let chat_id = chat.id.clone();
                self.load_chat_list();
                self.open_chat(&chat_id);
            }
            Err(err) => self.record_error(err),
        }
    }

    /// Open another chat from the home/chats list (React opens it in place —
    /// the workspace stays on this screen).
    pub fn open_chat(&mut self, chat_id: &str) {
        if self.chat_id.as_deref() == Some(chat_id) {
            return;
        }
        match self.call_decode(
            "chats.get",
            &RequestGetChat {
                chat_id: chat_id.to_string(),
            },
            decode_chat_dto,
        ) {
            Ok(chat) => {
                self.chat_id = Some(chat.id.clone());
                self.state.chat = Some(chat);
                self.state.messages.clear();
                self.state.scroll_offset_css = 0.0;
                // The previous chat's run must not leak in: stop polling it
                // (unsubscribe, no cancel) and drop its draft/composer text
                // before the new chat's rows load.
                self.reset_stream_state();
                // Interactive overlays never outlive their chat.
                self.state.message_edit_id = None;
                self.state.message_edit_draft.clear();
                self.state.history_message_id = None;
                self.state.message_revisions.clear();
                self.state.snapshots_menu_open = false;
                self.state.snapshot_items.clear();
                self.state.variant_picker_for = None;
                self.state.variant_picker_variants.clear();
                self.state.swipe_label_for = None;
                self.state.swipe_label.clear();
                match self.list_messages(chat_id, None) {
                    Ok(page) => self.absorb_latest_page(page),
                    Err(err) => self.record_error(err),
                }
                self.load_chat_list();
                self.bump_scene();
            }
            Err(err) => self.record_error(err),
        }
    }

    /// Jump back to the parent chat of this branch/checkpoint (React
    /// `ChatHeader` `backToParentChatId` -> `data-component="back-to-parent"`).
    pub fn open_parent_chat(&mut self) {
        if let Some(parent_id) = self
            .state
            .chat
            .as_ref()
            .and_then(|c| c.parent_chat_id.clone())
        {
            self.open_chat(&parent_id);
        }
    }

    pub(crate) fn load_open_chat(&mut self) -> Result<(), ChatRouteError> {
        let chat_id = match self.chat_id.clone() {
            Some(id) => id,
            None => {
                let page: PagedChats = self.call_decode(
                    "chats.list",
                    &RequestListChats {
                        character_id: None,
                        cursor: None,
                        limit: Some(PAGE_LIMIT),
                    },
                    decode_paged_chats,
                )?;
                if let Some(first) = page.items.first() {
                    first.id.clone()
                } else {
                    // No chat yet on a fresh device. If a starter character (Hazel) exists, create the first chat
                    // so `live_open` does not fail with EMPTY_LIBRARY on a clean install. The starter seeds the
                    // character via `NEOTA_SEED_STARTER=1` (mobile-ffi `nt_kernel_open` sets the env), but not a chat.
                    let characters_page: PagedCharacters = self.call_decode(
                        "characters.list",
                        &RequestListCharacters {
                            cursor: None,
                            limit: Some(PAGE_LIMIT),
                        },
                        decode_paged_characters,
                    )?;
                    let character_id = if let Some(character) = characters_page.items.first() {
                        character.id.clone()
                    } else {
                        // No character at all (clean DB and starter did not run). Create a minimal Hazel so the
                        // first chat can be created. This mirrors the desktop starter fallback and keeps the
                        // live route usable on a fresh install without requiring `pm clear` data.
                        let hazel: CharacterDto = self.call_decode(
                            "characters.create",
                            &RequestCreateCharacter {
                                name: "Hazel".to_string(),
                                description: Some("[Hazel's Personality= \"sharp\", \"wry\", \"self-taught\", \"stubborn\", \"streetwise\"]".to_string()),
                                tags: Some(vec!["wry".to_string()]),
                                avatar_asset_id: None,
                                profile_id: None,
                            },
                            decode_character_dto,
                        )?;
                        hazel.id.clone()
                    };
                    let created: ChatDto = self.call_decode(
                        "chats.create",
                        &RequestCreateChat {
                            character_id,
                            title: None,
                            persona_id: None,
                        },
                        decode_chat_dto,
                    )?;
                    created.id.clone()
                }
            }
        };
        let chat = self.call_decode(
            "chats.get",
            &RequestGetChat {
                chat_id: chat_id.clone(),
            },
            decode_chat_dto,
        )?;
        self.chat_id = Some(chat.id.clone());
        self.state.chat = Some(chat);
        self.bump_scene();
        let page = self.list_messages(&chat_id, None)?;
        self.absorb_latest_page(page);
        Ok(())
    }

    pub(crate) fn load_characters(&mut self) {
        match self.call_decode(
            "characters.list",
            &RequestListCharacters {
                cursor: None,
                limit: Some(PAGE_LIMIT),
            },
            decode_paged_characters,
        ) {
            Ok(PagedCharacters { items, .. }) => {
                if self.state.selected_character_id.is_none() {
                    self.state.selected_character_id = items.first().map(|row| row.id.clone());
                    self.load_character_draft();
                }
                if self.state.pinned_character_id.is_none() {
                    self.state.pinned_character_id = self.state.selected_character_id.clone();
                }
                self.state.characters = items;
                self.characters_revision += 1;
                self.hydrate_character_avatars();
            }
            Err(err) => self.record_error(err),
        }
    }

    /// Reload the character list from the Kernel and refresh the draft.
    pub fn refresh_characters(&mut self) {
        self.load_characters();
        self.load_character_draft();
    }

    /// React `characters.load-more`: reveal one more page of the browser.
    /// Paging bounds the DOM, not the fetch — the catalog is in memory.
    pub fn load_more_characters(&mut self) {
        self.state.character_browser_limit += CHARACTERS_PAGE;
        self.bump_scene();
    }

    /// Filtered + sorted character cards, built once per (catalog, search,
    /// sort) change and shared as an `Arc` (Send for the JNI host Mutex).
    /// this must not re-lowercase and re-clone the catalog per frame.
    pub(crate) fn filtered_character_cards(&self) -> std::sync::Arc<Vec<CharacterCardView>> {
        let search = self.state.character_search.trim().to_lowercase();
        let sort = self.state.character_sort.clone();
        let revision = self.characters_revision;
        if let Some(cache) = self.characters_cards.borrow().as_ref() {
            if cache.revision == revision && cache.search == search && cache.sort == sort {
                return std::sync::Arc::clone(&cache.cards);
            }
        }
        let mut cards: Vec<CharacterCardView> = self
            .state
            .characters
            .iter()
            .filter(|row| {
                search.is_empty()
                    || row.name.to_lowercase().contains(&search)
                    || row
                        .description
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&search)
                    || row
                        .tags
                        .iter()
                        .any(|tag| tag.to_lowercase().contains(&search))
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
        match sort.as_str() {
            "name-desc" => cards.sort_by_key(|card| std::cmp::Reverse(card.name.to_lowercase())),
            "newest" | "oldest" => {}
            _ => cards.sort_by_key(|card| card.name.to_lowercase()),
        }
        if sort == "oldest" {
            cards.reverse();
        }
        let cards = std::sync::Arc::new(cards);
        *self.characters_cards.borrow_mut() = Some(CharacterCardsCache {
            revision,
            search,
            sort,
            cards: std::sync::Arc::clone(&cards),
        });
        cards
    }

    /// Select a character by id and load its draft + avatar.
    pub fn select_character(&mut self, id: &str) {
        if self.state.selected_character_id.as_deref() == Some(id) {
            // React `selectCharacter` has no re-tap guard: tapping the
            // selected card again resets to the read-only card view.
            if self.state.character_editor_mode != "view" {
                self.state.character_editor_mode = "view".into();
                self.reset_panel_scroll();
                self.bump_scene();
            }
            return;
        }
        self.state.selected_character_id = Some(id.to_string());
        self.state.pinned_character_id = Some(id.to_string());
        // React `selectCharacter` resets to the read-only card view on every
        // selection, not only re-taps.
        self.state.character_editor_mode = "view".into();
        self.load_character_draft();
        self.reset_panel_scroll();
        self.bump_scene();
    }

    pub fn set_character_search(&mut self, query: &str) {
        self.state.character_search = query.to_string();
        self.bump_scene();
    }

    pub fn set_character_sort(&mut self, sort: &str) {
        self.state.character_sort = sort.to_string();
        self.bump_scene();
    }

    pub fn set_character_view(&mut self, view: &str) {
        self.state.character_view = view.to_string();
        self.bump_scene();
    }

    pub fn set_character_tab(&mut self, tab: &str) {
        self.state.character_tab = tab.to_string();
        if tab == "advanced" {
            // React `CharacterLorebooks` queries `lorebooks.list` on mount.
            self.load_lorebooks();
        }
        self.reset_panel_scroll();
        self.bump_scene();
    }

    /// Native shim for React's native side-panel scrolling: the host routes
    /// wheel input over the panel here and clamps against the rendered
    /// content height. `0` = scrolled to the top. Returns `true` when the
    /// offset changed (host re-produces).
    pub fn scroll_panel_by(&mut self, dy_css: f32, max_offset_css: f32) -> bool {
        let next = (self.state.panel_scroll_css + dy_css).clamp(0.0, max_offset_css.max(0.0));
        if (next - self.state.panel_scroll_css).abs() > f32::EPSILON {
            self.state.panel_scroll_css = next;
            self.bump_scene();
            return true;
        }
        false
    }

    pub fn reset_panel_scroll(&mut self) {
        if self.state.panel_scroll_css != 0.0 {
            self.state.panel_scroll_css = 0.0;
        }
    }

    pub fn toggle_character_editor_mode(&mut self) {
        if self.state.sidebar_panel != "characters" || self.state.selected_character_id.is_none() {
            return;
        }
        if self.state.character_tab != "edit" {
            self.state.character_tab = "edit".into();
            self.state.character_editor_mode = "view".into();
        } else if self.state.character_editor_mode == "view" {
            self.state.character_editor_mode = "edit".into();
        } else {
            self.state.character_editor_mode = "view".into();
        }
        self.reset_panel_scroll();
        self.bump_scene();
    }

    pub fn set_character_editor_mode(&mut self, mode: &str) {
        self.state.character_editor_mode = mode.to_string();
        self.bump_scene();
    }

    pub fn set_panel(&mut self, panel: &str) {
        if panel == "home" && self.viewport_width <= 600 {
            // Mobile bottom navigation: Home returns to the chat workspace
            // (React navigates to the chat route).
            self.state.sidebar_open = false;
            self.state.sidebar_panel = "home".to_string();
            self.bump_scene();
            return;
        }
        self.state.sidebar_panel = panel.to_string();
        self.state.sidebar_open = true;
        self.reset_panel_scroll();
        match panel {
            "characters" => self.refresh_characters(),
            "personas" => self.load_personas(),
            "lorebooks" => self.load_lorebooks(),
            "plugins" => self.load_plugins(),
            "providers" => {
                self.load_ai_settings();
                self.load_provider_configs();
            }
            "settings" => {
                self.load_settings();
                self.load_profiles();
                self.load_diagnostics();
            }
            // Desktop rail Home opens the chats management panel over the
            // workspace (React `ChatManagementPanel`).
            "home" => self.load_chat_list(),
            _ => {}
        }
        self.bump_scene();
    }

    pub fn toggle_sidebar(&mut self) {
        self.state.sidebar_open = !self.state.sidebar_open;
        self.bump_scene();
    }

    pub fn toggle_rail(&mut self) {
        // React `Sidebar_railButton[data-action=menu-toggle]` ("Close menu"):
        // the rail's top button collapses/expands the side panel itself, the
        // 60px icon rail always stays.
        self.state.sidebar_open = !self.state.sidebar_open;
        self.bump_scene();
    }

    /// Composer context-meter popover (`chat.composer.context`). Display-only
    /// state: opening the meter never issues a Wire command.
    pub fn toggle_context_panel(&mut self) {
        self.state.context_panel_open = !self.state.context_panel_open;
        self.bump_scene();
    }

    pub fn open_create_dialog(&mut self) {
        self.state.create_dialog_open = true;
        if self.state.create_name.trim().is_empty() {
            self.state.create_name = match self.state.sidebar_panel.as_str() {
                "personas" => "New persona".into(),
                "lorebooks" => "New lorebook".into(),
                _ => "New character".into(),
            };
        }
        self.state.create_description.clear();
        self.state.create_first_message.clear();
        self.bump_scene();
    }

    pub fn close_create_dialog(&mut self) {
        self.state.create_dialog_open = false;
        self.bump_scene();
    }

    pub fn set_create_name(&mut self, value: &str) {
        self.state.create_name = value.to_string();
        self.bump_scene();
    }

    /// Clear the transient status message (toast) shown by the host.
    pub fn clear_status_message(&mut self) {
        if self.state.status_message.is_some() {
            self.state.status_message = None;
            self.bump_scene();
        }
    }
}
