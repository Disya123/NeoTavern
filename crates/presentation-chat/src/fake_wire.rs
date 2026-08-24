use contracts_generated::generated::{
    CharacterDto, ChatDto, GenerationEvent, LorebookDto, LorebookEntryDto, LorebookEntryInput,
    LorebookEntryPatch, MessageDraftDto, MessageDto, MessageRole, MessageVariantDto,
    PagedCharacters, PagedChats, PagedMessages, PersonaDto, PluginsItem, ProfileExportCounts,
    ProfilesItem, RequestProfileExport, RequestProfilesCreate, RequestProfilesDelete,
    RequestProfilesRename, ResultListLorebookEntries, ResultListLorebooks, ResultListPersonas,
    ResultListPresets, ResultListProviders, ResultMessageVariantList, ResultPluginsList,
    ResultProfileExport, ResultProfilesCreate, ResultProfilesList, ResultSettings,
    ResultSnapshotsRollback, SettingsItem,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};

use base64::Engine as _;

use crate::error::ChatRouteError;
use crate::wire::{ProductWire, StreamFrame, WireCall};

// Real Hazel portrait (downscaled 192×288) bundled with the crate; serves as
// the demo `assets.content` so the GPU avatar overlay composites an actual
// character picture, matching the Android surface.
const DEMO_AVATAR_PNG: &[u8] = include_bytes!("../assets/demo_avatar.png");

pub const DEMO_CHAT_ID: &str = "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c";
pub const DEMO_CHARACTER_ID: &str = "4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a";
pub const DEMO_AVATAR_ASSET_ID: &str = "8a1b2c3d-4e5f-4061-8a9b-0c1d2e3f4a5b";
pub const DEMO_PERSONA_ID: &str = "0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f";
pub const DEMO_SERAPHINA_ID: &str = "5c6d7e8f-0a1b-4c2d-8e3f-4a5b6c7d8e9f";
pub const DEMO_VAYLE_ID: &str = "6d7e8f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
pub const DEMO_LOREBOOK_ID: &str = "3e9f1a2b-4c5d-4e6f-8a7b-0c1d2e3f4a5b";
const TS: &str = "2026-08-12T10:00:00Z";

#[derive(Clone, Copy)]
struct CursorCut {
    sequence: i64,
    desc: bool,
}

/// In-memory Product Wire for host tests. Cursors are opaque tokens; the
/// session must pass them through without parsing.
pub struct FakeWire {
    characters: HashMap<String, CharacterDto>,
    chats: HashMap<String, ChatDto>,
    messages: HashMap<String, Vec<MessageDto>>,
    /// Per-message response variants (`chats.messages.variants.*`), keyed by
    /// `(chatId, messageId)`; activation rewrites the message content.
    variants: HashMap<(String, String), Vec<MessageVariantDto>>,
    drafts: HashMap<String, MessageDraftDto>,
    personas: HashMap<String, PersonaDto>,
    lorebooks: HashMap<String, LorebookDto>,
    /// Per-book entries (`lorebooks.entries.*`), keyed by lorebook id. The
    /// wire DTO carries no position/metadata — those are kernel-owned.
    lorebook_entries: HashMap<String, Vec<LorebookEntryDto>>,
    /// Configuration profiles (`profiles.*`, React `ProfilesPanel`); the
    /// built-in "Main" profile is always present, exactly like the kernel.
    profiles: HashMap<String, ProfilesItem>,
    plugins: Vec<PluginsItem>,
    settings: Vec<SettingsItem>,
    streams: HashMap<String, VecDeque<StreamFrame>>,
    cursors: HashMap<String, CursorCut>,
    fail_ops: HashSet<String>,
    next: u64,
}

impl Default for FakeWire {
    fn default() -> Self {
        Self {
            characters: HashMap::new(),
            chats: HashMap::new(),
            messages: HashMap::new(),
            variants: HashMap::new(),
            drafts: HashMap::new(),
            personas: HashMap::new(),
            lorebooks: HashMap::new(),
            lorebook_entries: HashMap::new(),
            profiles: HashMap::new(),
            plugins: vec![
                PluginsItem {
                    id: "tavern-speed-dial".into(),
                    name: "Tavern Speed Dial".into(),
                    version: "1.2.0".into(),
                    enabled: true,
                    trust_state: "verified-publisher".into(),
                    publisher_key_id: None,
                    permissions: vec!["ui.quick-actions".into()],
                    last_error_code: None,
                    installed_at: TS.into(),
                    updated_at: TS.into(),
                    manifest: None,
                },
                PluginsItem {
                    id: "lore-almanac".into(),
                    name: "Lore Almanac".into(),
                    version: "0.4.1".into(),
                    enabled: false,
                    trust_state: "unsigned-untrusted".into(),
                    publisher_key_id: None,
                    permissions: Vec::new(),
                    last_error_code: Some("E0107".into()),
                    installed_at: TS.into(),
                    updated_at: TS.into(),
                    manifest: None,
                },
            ],
            settings: vec![
                SettingsItem {
                    key: "language".into(),
                    value: json!({ "value": "en" }),
                    updated_at: TS.into(),
                },
                SettingsItem {
                    key: "active-persona-id".into(),
                    value: json!({ "value": DEMO_PERSONA_ID }),
                    updated_at: TS.into(),
                },
            ],
            streams: HashMap::new(),
            cursors: HashMap::new(),
            fail_ops: HashSet::new(),
            next: 0x9000,
        }
    }
}

impl FakeWire {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn demo() -> Self {
        let mut wire = Self::default();
        wire.insert_character(demo_character());
        wire.insert_character(demo_seraphina());
        wire.insert_character(demo_vayle());
        wire.insert_persona(demo_persona());
        wire.insert_chat(demo_chat(2));
        wire.push_message(user_message(DEMO_CHAT_ID, 0, "Hello there"));
        wire.push_message(assistant_message(
            DEMO_CHAT_ID,
            1,
            "Hi — live Product Wire.",
            Some(wire_id(0x6e7f8091ab2c)),
        ));
        // Demo lorebook so the Lorebooks panel shows real rows and the
        // Entries tab has content to port (React `LorebookPanel` EntriesTab).
        let demo_book_id = DEMO_LOREBOOK_ID.to_string();
        wire.lorebooks.insert(
            demo_book_id.clone(),
            LorebookDto {
                id: demo_book_id.clone(),
                name: "Kestrel Vales".into(),
                description: Some(
                    "Routes, ruins and rumors of the Kestrel Vales, mapped by the caravans.".into(),
                ),
                entry_count: 2,
                character_id: None,
                created_at: TS.into(),
                updated_at: TS.into(),
            },
        );
        let entry = |id_high: u64, keys: &[&str], content: &str, enabled, constant, selective| {
            LorebookEntryDto {
                id: wire_id(id_high),
                keys: keys.iter().map(|key| (*key).to_string()).collect(),
                secondary_keys: None,
                content: content.to_string(),
                enabled,
                constant,
                selective,
            }
        };
        wire.lorebook_entries.insert(
            demo_book_id.clone(),
            vec![
                entry(
                    0x4201,
                    &["Ashfall Crossing"],
                    "The ford at Ashfall Crossing floods after the spring melt; caravans wait for the kestrels to call the water down.",
                    true,
                    false,
                    false,
                ),
                entry(
                    0x4202,
                    &["Salt Wind"],
                    "A warm salt wind off the Broken Coast: the sailors say it carries the voices of drowned bells.",
                    true,
                    true,
                    false,
                ),
            ],
        );
        // Demo profiles so the Settings Profiles tab lists real rows (React
        // `ProfilesPanel`): the kernel always seeds the built-in "Main"
        // profile; the second one exercises rename/delete.
        let profile = |id: u64, name: &str| ProfilesItem {
            id: wire_id(id),
            name: name.into(),
            created_at: TS.into(),
            updated_at: TS.into(),
        };
        wire.profiles.insert(wire_id(0x51), profile(0x51, "Main"));
        wire.profiles.insert(wire_id(0x52), profile(0x52, "Caravan"));
        wire
    }

    /// Kernel can have characters without a chat. Character Manager still lists them.
    pub fn character_catalog() -> Self {
        let mut wire = Self::default();
        wire.insert_character(demo_character());
        wire.insert_persona(demo_persona());
        wire
    }

    pub fn with_message_count(count: u32) -> Self {
        let mut wire = Self::default();
        wire.insert_character(demo_character());
        wire.insert_character(demo_seraphina());
        wire.insert_character(demo_vayle());
        wire.insert_persona(demo_persona());
        wire.insert_chat(demo_chat(i64::from(count)));
        for index in 0..count {
            let content = if index.is_multiple_of(5) {
                format!("![photo {index}](asset:thumb-{index})")
            } else if index.is_multiple_of(2) {
                format!("**msg {index}**\n\n- item one\n- `code`")
            } else {
                format!(
                    "**msg {index}**\n\n\"Stay close.\" *the kestrel clicks her tongue.*\n\n- item one\n- `code`"
                )
            };
            if index.is_multiple_of(2) {
                wire.push_message(user_message(DEMO_CHAT_ID, i64::from(index), &content));
            } else {
                wire.push_message(assistant_message(
                    DEMO_CHAT_ID,
                    i64::from(index),
                    &content,
                    Some(wire_id(u64::from(index) + 1)),
                ));
            }
        }
        // Response variants for the tail assistant message: position 0 keeps
        // the original content so the active-variant cursor starts there.
        // React `MessageSwipePager` (swipe previous/next) navigates these.
        let tail_id = wire_id((u64::from(count - 1)) + 0x2000);
        let tail_content = format!(
            "**msg {}**\n\n\"Stay close.\" *the kestrel clicks her tongue.*\n\n- item one\n- `code`",
            count - 1
        );
        if count >= 2 {
            let variant = |position, id_high, content: String| MessageVariantDto {
                id: wire_id(id_high),
                message_id: tail_id.clone(),
                content,
                position,
                created_at: TS.into(),
            };
            let original = tail_content.clone();
            let alt_a = format!("*variant A* of {tail_content}");
            let alt_b = format!("*variant B* of {tail_content}");
            let list = vec![
                variant(0, 0x3101, original),
                variant(1, 0x3102, alt_a),
                variant(2, 0x3103, alt_b),
            ];
            wire.variants
                .insert((DEMO_CHAT_ID.to_string(), tail_id), list);
        }
        // A second chat so the home/chats panel lists real `chats.list` rows
        // and switching works (React `ChatManagementPanel`). Sequences start
        // at 0x40 so the derived message ids stay unique across chats.
        let archive_id = wire_id(0x51);
        wire.insert_chat(ChatDto {
            id: archive_id.clone(),
            title: "Archived ideas".into(),
            character_id: DEMO_CHARACTER_ID.into(),
            persona_id: Some(DEMO_PERSONA_ID.into()),
            message_count: 2,
            created_at: TS.into(),
            updated_at: TS.into(),
            parent_chat_id: None,
            origin: None,
            source_message_id: None,
        });
        wire.push_message(user_message(
            &archive_id,
            0x40,
            "Draft: voice notes pipeline",
        ));
        wire.push_message(assistant_message(
            &archive_id,
            0x41,
            "Saved to the ideas chat.",
            None,
        ));
        wire
    }

    pub fn fail_operation(&mut self, operation_id: &str) {
        self.fail_ops.insert(operation_id.to_string());
    }

    pub fn chat_count(&self) -> usize {
        self.chats.len()
    }

    pub fn message_count(&self, chat_id: &str) -> usize {
        self.messages.get(chat_id).map(Vec::len).unwrap_or(0)
    }

    fn insert_character(&mut self, character: CharacterDto) {
        self.characters.insert(character.id.clone(), character);
    }

    fn insert_chat(&mut self, chat: ChatDto) {
        self.chats.insert(chat.id.clone(), chat);
    }

    fn insert_persona(&mut self, persona: PersonaDto) {
        self.personas.insert(persona.id.clone(), persona);
    }

    fn push_message(&mut self, message: MessageDto) {
        self.messages
            .entry(message.chat_id.clone())
            .or_default()
            .push(message);
    }

    fn alloc_id(&mut self) -> String {
        let n = self.next;
        self.next += 1;
        wire_id(n)
    }

    fn ok_call(&mut self, operation_id: &str, result: Value) -> Result<WireCall, ChatRouteError> {
        Ok(WireCall {
            request_id: self.alloc_id(),
            operation_id: operation_id.to_string(),
            result,
        })
    }

    fn wrap_call(
        &mut self,
        operation_id: &str,
        result: Result<Value, ChatRouteError>,
    ) -> Result<WireCall, ChatRouteError> {
        self.ok_call(operation_id, result?)
    }

    fn product(code: &str, key: &str, value: &str) -> ChatRouteError {
        ChatRouteError::product(code, json!({ key: value }))
    }

    fn require_character(&self, character_id: &str) -> Result<&CharacterDto, ChatRouteError> {
        self.characters
            .get(character_id)
            .ok_or_else(|| Self::product("CHARACTER_NOT_FOUND", "characterId", character_id))
    }

    fn require_chat(&self, chat_id: &str) -> Result<&ChatDto, ChatRouteError> {
        self.chats
            .get(chat_id)
            .ok_or_else(|| Self::product("CHAT_NOT_FOUND", "chatId", chat_id))
    }

    fn require_lorebook(&self, lorebook_id: &str) -> Result<&LorebookDto, ChatRouteError> {
        self.lorebooks
            .get(lorebook_id)
            .ok_or_else(|| Self::product("LOREBOOK_NOT_FOUND", "lorebookId", lorebook_id))
    }

    fn list_characters(&self, limit: i64) -> PagedCharacters {
        let mut items: Vec<CharacterDto> = self.characters.values().cloned().collect();
        items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        let cap = limit.clamp(1, 200) as usize;
        if items.len() > cap {
            items.truncate(cap);
        }
        PagedCharacters {
            items,
            next_cursor: None,
        }
    }

    fn list_chats(&self, limit: i64) -> PagedChats {
        let mut items: Vec<ChatDto> = self.chats.values().cloned().collect();
        items.sort_by(|a, b| a.id.cmp(&b.id));
        let cap = limit.clamp(1, 200) as usize;
        if items.len() > cap {
            items.truncate(cap);
        }
        PagedChats {
            items,
            next_cursor: None,
        }
    }

    fn list_messages(
        &mut self,
        chat_id: &str,
        cursor: Option<&str>,
        limit: i64,
        order: Option<&str>,
    ) -> Result<PagedMessages, ChatRouteError> {
        self.require_chat(chat_id)?;
        let desc = order != Some("asc");
        let cap = limit.clamp(1, 200) as usize;
        let all = self.messages.get(chat_id).cloned().unwrap_or_default();
        let cut = cursor.and_then(|token| self.cursors.get(token).copied());
        let mut matching: Vec<MessageDto> = all
            .into_iter()
            .filter(|row| match cut {
                None => true,
                Some(CursorCut { sequence, desc: d }) if d => row.sequence < sequence,
                Some(CursorCut { sequence, desc: _ }) => row.sequence > sequence,
            })
            .collect();
        if desc {
            matching.sort_by_key(|row| std::cmp::Reverse(row.sequence));
        } else {
            matching.sort_by_key(|row| row.sequence);
        }
        let has_more = matching.len() > cap;
        matching.truncate(cap);
        let next_cursor = if has_more {
            let edge = if desc {
                matching.last().map(|row| row.sequence)
            } else {
                matching.last().map(|row| row.sequence)
            };
            edge.map(|sequence| {
                let token = format!("tok-{}", self.next);
                self.next += 1;
                self.cursors
                    .insert(token.clone(), CursorCut { sequence, desc });
                token
            })
        } else {
            None
        };
        Ok(PagedMessages {
            items: matching,
            next_cursor,
        })
    }

    fn create_message(&mut self, payload: &Value) -> Result<MessageDto, ChatRouteError> {
        let chat_id = payload_str(payload, "chatId")?;
        self.require_chat(&chat_id)?;
        let content = payload_str(payload, "content")?;
        let role = payload_role(payload)?;
        let sequence = self
            .messages
            .get(&chat_id)
            .and_then(|rows| rows.iter().map(|row| row.sequence).max())
            .unwrap_or(-1)
            + 1;
        let message = MessageDto {
            id: self.alloc_id(),
            chat_id: chat_id.clone(),
            role,
            content,
            created_at: TS.into(),
            sequence,
            generation_run_id: None,
            meta: contracts_generated::generated::FreeObject {
                payload: json!({ "manualExcluded": false }),
            },
            checkpoint_chat_id: None,
        };
        self.push_message(message.clone());
        let count = self.message_count(&chat_id);
        if let Some(chat) = self.chats.get_mut(&chat_id) {
            chat.message_count = i64::try_from(count).unwrap_or(0);
            chat.updated_at = TS.into();
        }
        Ok(message)
    }

    /// Remove one message (`chats.messages.delete`); keeps the chat's
    /// `message_count` honest like `create_message` does.
    /// `chats.messages.variants.activate`: the activated variant becomes the
    /// message content (kernel semantics); the chat's updated_at moves.
    fn activate_variant(
        &mut self,
        chat_id: &str,
        message_id: &str,
        variant_id: &str,
    ) -> Result<(), ChatRouteError> {
        self.require_chat(chat_id)?;
        let key = (chat_id.to_string(), message_id.to_string());
        let variants = self
            .variants
            .get(&key)
            .ok_or_else(|| Self::product("VARIANT_NOT_FOUND", "variantId", variant_id))?;
        let variant = variants
            .iter()
            .find(|variant| variant.id == variant_id)
            .ok_or_else(|| Self::product("VARIANT_NOT_FOUND", "variantId", variant_id))?
            .clone();
        let rows = self
            .messages
            .get_mut(chat_id)
            .ok_or_else(|| Self::product("MESSAGE_NOT_FOUND", "messageId", message_id))?;
        let row = rows
            .iter_mut()
            .find(|row| row.id == message_id)
            .ok_or_else(|| Self::product("MESSAGE_NOT_FOUND", "messageId", message_id))?;
        row.content = variant.content;
        if let Some(chat) = self.chats.get_mut(chat_id) {
            chat.updated_at = TS.into();
        }
        Ok(())
    }

    /// `chats.snapshots.rollback`: keep everything up to and including
    /// `to_message_id`, remove the higher-sequence suffix, decrement the chat
    /// counter. FakeWire keeps no checkpoint-child store yet, so
    /// `checkpointChatId` stays honestly absent (no recoverable copy).
    fn rollback_chat(
        &mut self,
        chat_id: &str,
        to_message_id: &str,
    ) -> Result<ResultSnapshotsRollback, ChatRouteError> {
        self.require_chat(chat_id)?;
        let rows = self
            .messages
            .get_mut(chat_id)
            .ok_or_else(|| Self::product("MESSAGE_NOT_FOUND", "toMessageId", to_message_id))?;
        let pos = rows
            .iter()
            .position(|row| row.id == to_message_id)
            .ok_or_else(|| Self::product("MESSAGE_NOT_FOUND", "toMessageId", to_message_id))?;
        let removed = rows.len() - pos - 1;
        rows.truncate(pos + 1);
        if let Some(chat) = self.chats.get_mut(chat_id) {
            chat.message_count = i64::try_from(rows.len()).unwrap_or(0);
            chat.updated_at = TS.into();
        }
        Ok(ResultSnapshotsRollback {
            deleted: i64::try_from(removed).unwrap_or(0),
            checkpoint_chat_id: None,
        })
    }

    fn delete_message(&mut self, chat_id: &str, message_id: &str) -> Result<(), ChatRouteError> {
        self.require_chat(chat_id)?;
        let rows = self
            .messages
            .get_mut(chat_id)
            .ok_or_else(|| Self::product("MESSAGE_NOT_FOUND", "messageId", message_id))?;
        let pos = rows
            .iter()
            .position(|row| row.id == message_id)
            .ok_or_else(|| Self::product("MESSAGE_NOT_FOUND", "messageId", message_id))?;
        rows.remove(pos);
        if let Some(chat) = self.chats.get_mut(chat_id) {
            chat.message_count = i64::try_from(rows.len()).unwrap_or(0);
            chat.updated_at = TS.into();
        }
        Ok(())
    }

    fn create_character(&mut self, payload: &Value) -> Result<CharacterDto, ChatRouteError> {
        let name = payload_str(payload, "name")?;
        let tags = payload
            .get("tags")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let character = CharacterDto {
            id: self.alloc_id(),
            name,
            description: payload
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            avatar_asset_id: None,
            tags,
            profile_id: None,
            created_at: TS.into(),
            updated_at: TS.into(),
        };
        self.insert_character(character.clone());
        Ok(character)
    }

    fn create_chat(&mut self, payload: &Value) -> Result<ChatDto, ChatRouteError> {
        let character_id = payload_str(payload, "characterId")?;
        self.require_character(&character_id)?;
        let title = payload
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Chat")
            .to_string();
        let chat = ChatDto {
            id: self.alloc_id(),
            title,
            character_id,
            persona_id: payload
                .get("personaId")
                .and_then(Value::as_str)
                .map(str::to_string),
            message_count: 0,
            created_at: TS.into(),
            updated_at: TS.into(),
            parent_chat_id: None,
            origin: None,
            source_message_id: None,
        };
        self.insert_chat(chat.clone());
        Ok(chat)
    }

    fn save_draft(&mut self, payload: &Value) -> Result<MessageDraftDto, ChatRouteError> {
        let chat_id = payload_str(payload, "chatId")?;
        self.require_chat(&chat_id)?;
        let content = payload_str(payload, "content")?;
        let role = payload_role(payload)?;
        let id = payload
            .get("draftId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| self.alloc_id());
        let existing = self.drafts.get(&id);
        let revision = existing.map(|row| row.revision + 1).unwrap_or(1);
        let created_at = existing
            .map(|row| row.created_at.clone())
            .unwrap_or_else(|| TS.into());
        let draft = MessageDraftDto {
            id: id.clone(),
            chat_id,
            role,
            content,
            sequence: payload.get("sequence").and_then(Value::as_i64).unwrap_or(0),
            revision,
            committed_message_id: existing.and_then(|row| row.committed_message_id.clone()),
            created_at,
            updated_at: TS.into(),
        };
        self.drafts.insert(id, draft.clone());
        Ok(draft)
    }

    fn get_draft(&self, payload: &Value) -> Result<MessageDraftDto, ChatRouteError> {
        let chat_id = payload_str(payload, "chatId")?;
        let draft_id = payload_str(payload, "draftId")?;
        self.drafts
            .get(&draft_id)
            .filter(|row| row.chat_id == chat_id)
            .cloned()
            .ok_or_else(|| Self::product("MESSAGE_DRAFT_NOT_FOUND", "draftId", &draft_id))
    }

    fn commit_draft(&mut self, payload: &Value) -> Result<MessageDto, ChatRouteError> {
        let chat_id = payload_str(payload, "chatId")?;
        let draft_id = payload_str(payload, "draftId")?;
        let draft = self.get_draft(payload)?;
        if let Some(message_id) = &draft.committed_message_id {
            if let Some(found) = self
                .messages
                .get(&chat_id)
                .and_then(|rows| rows.iter().find(|row| row.id == *message_id))
            {
                return Ok(found.clone());
            }
        }
        let created = self.create_message(&json!({
            "chatId": chat_id,
            "role": role_str(&draft.role),
            "content": draft.content,
        }))?;
        if let Some(row) = self.drafts.get_mut(&draft_id) {
            row.committed_message_id = Some(created.id.clone());
            row.revision += 1;
        }
        Ok(created)
    }

    fn discard_draft(&mut self, payload: &Value) -> Result<Value, ChatRouteError> {
        let draft_id = payload_str(payload, "draftId")?;
        self.get_draft(payload)?;
        self.drafts.remove(&draft_id);
        Ok(json!({}))
    }

    fn start_generation(&mut self, op: &str, payload: &Value) -> Result<String, ChatRouteError> {
        let run_id = self.alloc_id();
        let (chat_id, reply) = if op == "generation.retry" {
            let source = payload_str(payload, "sourceRunId")?;
            let found = self
                .messages
                .values()
                .flatten()
                .find(|row| row.generation_run_id.as_deref() == Some(source.as_str()));
            let Some(source_msg) = found else {
                return Err(Self::product(
                    "GENERATION_RUN_NOT_FOUND",
                    "sourceRunId",
                    &source,
                ));
            };
            (source_msg.chat_id.clone(), format!("retry of {source}"))
        } else {
            let chat_id = payload_str(payload, "chatId")?;
            self.require_chat(&chat_id)?;
            let message = payload_str(payload, "message")?;
            (chat_id, format!("echo: {message}"))
        };
        let sequence = self
            .messages
            .get(&chat_id)
            .and_then(|rows| rows.iter().map(|row| row.sequence).max())
            .unwrap_or(-1)
            + 1;
        let final_message = assistant_message(&chat_id, sequence, &reply, Some(run_id.clone()));
        let first: String = reply.chars().take(6).collect();
        let rest: String = reply.chars().skip(6).collect();
        let mut frames = VecDeque::new();
        frames.push_back(StreamFrame::from_sequenced(
            0,
            GenerationEvent::GenerationDelta {
                text: first.clone(),
            },
        ));
        // Replay of envelope sequence 0 must not double-append.
        frames.push_back(StreamFrame::from_sequenced(
            0,
            GenerationEvent::GenerationDelta { text: first },
        ));
        frames.push_back(StreamFrame::from_sequenced(
            1,
            GenerationEvent::GenerationDelta { text: rest },
        ));
        frames.push_back(StreamFrame::from_sequenced(
            2,
            GenerationEvent::GenerationCompleted { final_message },
        ));
        frames.push_back(StreamFrame::Terminal);
        self.streams.insert(run_id.clone(), frames);
        Ok(run_id)
    }
}

impl ProductWire for FakeWire {
    fn call(&mut self, operation_id: &str, payload: Value) -> Result<WireCall, ChatRouteError> {
        if self.fail_ops.contains(operation_id) {
            return Err(Self::product("WIRE_FAILED", "operationId", operation_id));
        }
        match operation_id {
            "characters.create" => {
                let created = self.create_character(&payload)?;
                self.wrap_call(operation_id, to_value(&created))
            }
            "characters.list" => {
                let page = self
                    .list_characters(payload.get("limit").and_then(Value::as_i64).unwrap_or(50));
                self.wrap_call(operation_id, to_value(&page))
            }
            "characters.get" => {
                let character_id = payload_str(&payload, "characterId")?;
                let character = self.require_character(&character_id)?.clone();
                self.wrap_call(operation_id, to_value(&character))
            }
            "characters.update" => {
                let character_id = payload_str(&payload, "characterId")?;
                let mut character = self.require_character(&character_id)?.clone();
                if let Some(name) = payload.get("name").and_then(Value::as_str) {
                    character.name = name.to_string();
                }
                if let Some(description) = payload.get("description").and_then(Value::as_str) {
                    character.description = Some(description.to_string());
                }
                if let Some(tags) = payload.get("tags").and_then(Value::as_array) {
                    character.tags = tags
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                }
                character.updated_at = TS.into();
                self.insert_character(character.clone());
                self.wrap_call(operation_id, to_value(&character))
            }
            "characters.delete" => {
                let character_id = payload_str(&payload, "characterId")?;
                self.require_character(&character_id)?;
                self.characters.remove(&character_id);
                self.ok_call(operation_id, json!({}))
            }
            "assets.content" => {
                let asset_id = payload_str(&payload, "assetId")?;
                self.ok_call(
                    operation_id,
                    json!({
                        "assetId": asset_id,
                        "contentType": "image/png",
                        "contentBase64": base64::engine::general_purpose::STANDARD
                            .encode(DEMO_AVATAR_PNG),
                    }),
                )
            }
            "chats.create" => {
                let created = self.create_chat(&payload)?;
                self.wrap_call(operation_id, to_value(&created))
            }
            "chats.list" => {
                let page =
                    self.list_chats(payload.get("limit").and_then(Value::as_i64).unwrap_or(50));
                self.wrap_call(operation_id, to_value(&page))
            }
            "chats.get" => {
                let chat_id = payload_str(&payload, "chatId")?;
                let chat = self.require_chat(&chat_id)?.clone();
                self.wrap_call(operation_id, to_value(&chat))
            }
            "chats.messages.list" => {
                let chat_id = payload_str(&payload, "chatId")?;
                let page = self.list_messages(
                    &chat_id,
                    payload.get("cursor").and_then(Value::as_str),
                    payload.get("limit").and_then(Value::as_i64).unwrap_or(50),
                    payload.get("order").and_then(Value::as_str),
                )?;
                self.wrap_call(operation_id, to_value(&page))
            }
            "chats.messages.create" => {
                let created = self.create_message(&payload)?;
                self.wrap_call(operation_id, to_value(&created))
            }
            "chats.messages.delete" => {
                let chat_id = payload_str(&payload, "chatId")?;
                let message_id = payload_str(&payload, "messageId")?;
                self.delete_message(&chat_id, &message_id)?;
                self.ok_call(operation_id, json!({}))
            }
            "chats.snapshots.rollback" => {
                let chat_id = payload_str(&payload, "chatId")?;
                let to_message_id = payload_str(&payload, "toMessageId")?;
                let result = self.rollback_chat(&chat_id, &to_message_id)?;
                self.wrap_call(operation_id, to_value(&result))
            }
            "chats.messages.variants.list" => {
                let chat_id = payload_str(&payload, "chatId")?;
                let message_id = payload_str(&payload, "messageId")?;
                self.require_chat(&chat_id)?;
                let mut items = self
                    .variants
                    .get(&(chat_id, message_id))
                    .cloned()
                    .unwrap_or_default();
                items.sort_by_key(|variant| variant.position);
                self.wrap_call(operation_id, to_value(&ResultMessageVariantList { items }))
            }
            "chats.messages.variants.activate" => {
                let chat_id = payload_str(&payload, "chatId")?;
                let message_id = payload_str(&payload, "messageId")?;
                let variant_id = payload_str(&payload, "variantId")?;
                self.activate_variant(&chat_id, &message_id, &variant_id)?;
                self.ok_call(operation_id, json!({}))
            }
            "chats.messages.drafts.save" => {
                let draft = self.save_draft(&payload)?;
                self.wrap_call(operation_id, to_value(&draft))
            }
            "chats.messages.drafts.get" => {
                let draft = self.get_draft(&payload)?;
                self.wrap_call(operation_id, to_value(&draft))
            }
            "chats.messages.drafts.commit" => {
                let committed = self.commit_draft(&payload)?;
                self.wrap_call(operation_id, to_value(&committed))
            }
            "chats.messages.drafts.discard" => {
                let discarded = self.discard_draft(&payload)?;
                self.ok_call(operation_id, discarded)
            }
            "generation.cancel" => self.ok_call(operation_id, json!({})),
            "personas.list" => {
                let mut items: Vec<PersonaDto> = self.personas.values().cloned().collect();
                items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                self.wrap_call(operation_id, to_value(&ResultListPersonas { items }))
            }
            "personas.create" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("New persona")
                    .to_string();
                let created = PersonaDto {
                    id: self.alloc_id(),
                    name,
                    description: payload
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    avatar: None,
                    is_default: payload
                        .get("isDefault")
                        .and_then(Value::as_bool)
                        .unwrap_or(self.personas.is_empty()),
                    created_at: TS.into(),
                    updated_at: TS.into(),
                };
                self.insert_persona(created.clone());
                self.wrap_call(operation_id, to_value(&created))
            }
            "personas.update" => {
                let persona_id = payload_str(&payload, "personaId")?;
                let mut persona =
                    self.personas.get(&persona_id).cloned().ok_or_else(|| {
                        Self::product("PERSONA_NOT_FOUND", "personaId", &persona_id)
                    })?;
                if let Some(name) = payload.get("name").and_then(Value::as_str) {
                    persona.name = name.to_string();
                }
                if let Some(description) = payload.get("description").and_then(Value::as_str) {
                    persona.description = Some(description.to_string());
                }
                persona.updated_at = TS.into();
                self.insert_persona(persona.clone());
                self.wrap_call(operation_id, to_value(&persona))
            }
            "personas.delete" => {
                let persona_id = payload_str(&payload, "personaId")?;
                self.personas.remove(&persona_id);
                self.ok_call(operation_id, json!({}))
            }
            "lorebooks.list" => {
                let mut items: Vec<LorebookDto> = self.lorebooks.values().cloned().collect();
                items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                self.wrap_call(operation_id, to_value(&ResultListLorebooks { items }))
            }
            "lorebooks.get" => {
                let lorebook_id = payload_str(&payload, "lorebookId")?;
                let book = self.lorebooks.get(&lorebook_id).cloned().ok_or_else(|| {
                    Self::product("LOREBOOK_NOT_FOUND", "lorebookId", &lorebook_id)
                })?;
                self.wrap_call(operation_id, to_value(&book))
            }
            "lorebooks.update" => {
                let lorebook_id = payload_str(&payload, "lorebookId")?;
                let mut book = self.lorebooks.get(&lorebook_id).cloned().ok_or_else(|| {
                    Self::product("LOREBOOK_NOT_FOUND", "lorebookId", &lorebook_id)
                })?;
                if let Some(name) = payload.get("name").and_then(Value::as_str) {
                    book.name = name.to_string();
                }
                if let Some(description) = payload.get("description").and_then(Value::as_str) {
                    book.description = Some(description.to_string());
                }
                book.updated_at = TS.into();
                self.lorebooks.insert(lorebook_id.clone(), book.clone());
                self.wrap_call(operation_id, to_value(&book))
            }
            "lorebooks.create" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("New lorebook")
                    .to_string();
                let created = LorebookDto {
                    id: self.alloc_id(),
                    name,
                    description: payload
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    entry_count: 0,
                    character_id: payload
                        .get("characterId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    created_at: TS.into(),
                    updated_at: TS.into(),
                };
                self.lorebooks.insert(created.id.clone(), created.clone());
                self.wrap_call(operation_id, to_value(&created))
            }
            "lorebooks.entries.list" => {
                let lorebook_id = payload_str(&payload, "lorebookId")?;
                self.require_lorebook(&lorebook_id)?;
                let items = self
                    .lorebook_entries
                    .get(&lorebook_id)
                    .cloned()
                    .unwrap_or_default();
                self.wrap_call(operation_id, to_value(&ResultListLorebookEntries { items }))
            }
            "lorebooks.entries.create" => {
                let lorebook_id = payload_str(&payload, "lorebookId")?;
                self.require_lorebook(&lorebook_id)?;
                let input: LorebookEntryInput =
                    serde_json::from_value(payload.get("entry").cloned().unwrap_or(Value::Null))?;
                let created = LorebookEntryDto {
                    id: self.alloc_id(),
                    keys: input.keys,
                    secondary_keys: input.secondary_keys,
                    content: input.content,
                    enabled: input.enabled.unwrap_or(true),
                    constant: input.constant.unwrap_or(false),
                    selective: input.selective.unwrap_or(false),
                };
                self.lorebook_entries
                    .entry(lorebook_id.clone())
                    .or_default()
                    .push(created.clone());
                if let Some(book) = self.lorebooks.get_mut(&lorebook_id) {
                    book.entry_count = i64::try_from(
                        self.lorebook_entries
                            .get(&lorebook_id)
                            .map(Vec::len)
                            .unwrap_or(0),
                    )
                    .unwrap_or(0);
                    book.updated_at = TS.into();
                }
                self.wrap_call(operation_id, to_value(&created))
            }
            "lorebooks.entries.update" => {
                let lorebook_id = payload_str(&payload, "lorebookId")?;
                let entry_id = payload_str(&payload, "entryId")?;
                let patch: LorebookEntryPatch =
                    serde_json::from_value(payload.get("patch").cloned().unwrap_or(Value::Null))?;
                let updated = {
                    let Some(rows) = self.lorebook_entries.get_mut(&lorebook_id) else {
                        return Err(Self::product(
                            "LOREBOOK_NOT_FOUND",
                            "lorebookId",
                            &lorebook_id,
                        ));
                    };
                    let Some(entry) = rows.iter_mut().find(|row| row.id == entry_id) else {
                        return Err(Self::product(
                            "LOREBOOK_ENTRY_NOT_FOUND",
                            "entryId",
                            &entry_id,
                        ));
                    };
                    if let Some(keys) = patch.keys {
                        entry.keys = keys;
                    }
                    if let Some(secondary_keys) = patch.secondary_keys {
                        entry.secondary_keys = Some(secondary_keys);
                    }
                    if let Some(content) = patch.content {
                        entry.content = content;
                    }
                    if let Some(enabled) = patch.enabled {
                        entry.enabled = enabled;
                    }
                    if let Some(constant) = patch.constant {
                        entry.constant = constant;
                    }
                    if let Some(selective) = patch.selective {
                        entry.selective = selective;
                    }
                    entry.clone()
                };
                if let Some(book) = self.lorebooks.get_mut(&lorebook_id) {
                    book.updated_at = TS.into();
                }
                self.wrap_call(operation_id, to_value(&updated))
            }
            "lorebooks.entries.delete" => {
                let lorebook_id = payload_str(&payload, "lorebookId")?;
                let entry_id = payload_str(&payload, "entryId")?;
                let Some(rows) = self.lorebook_entries.get_mut(&lorebook_id) else {
                    return Err(Self::product(
                        "LOREBOOK_NOT_FOUND",
                        "lorebookId",
                        &lorebook_id,
                    ));
                };
                let before = rows.len();
                rows.retain(|row| row.id != entry_id);
                if rows.len() == before {
                    return Err(Self::product(
                        "LOREBOOK_ENTRY_NOT_FOUND",
                        "entryId",
                        &entry_id,
                    ));
                }
                if let Some(book) = self.lorebooks.get_mut(&lorebook_id) {
                    book.entry_count = i64::try_from(rows.len()).unwrap_or(0);
                    book.updated_at = TS.into();
                }
                self.ok_call(operation_id, json!({}))
            }
            "lorebooks.delete" => {
                let lorebook_id = payload_str(&payload, "lorebookId")?;
                self.lorebooks.remove(&lorebook_id);
                self.ok_call(operation_id, json!({}))
            }
            "plugins.list" => self.wrap_call(
                operation_id,
                to_value(&ResultPluginsList {
                    items: self.plugins.clone(),
                }),
            ),
            "providers.list" => self.wrap_call(
                operation_id,
                to_value(&ResultListProviders { items: Vec::new() }),
            ),
            "presets.list" => self.wrap_call(
                operation_id,
                to_value(&ResultListPresets { items: Vec::new() }),
            ),
            "settings.get" => self.wrap_call(
                operation_id,
                to_value(&ResultSettings {
                    items: self.settings.clone(),
                }),
            ),
            "profiles.list" => {
                let mut items: Vec<ProfilesItem> = self.profiles.values().cloned().collect();
                items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                self.wrap_call(operation_id, to_value(&ResultProfilesList { items }))
            }
            "profiles.create" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Self::product("PROFILE_NAME_REQUIRED", "name", ""))?;
                let created = ProfilesItem {
                    id: self.alloc_id(),
                    name: name.to_string(),
                    created_at: TS.into(),
                    updated_at: TS.into(),
                };
                self.profiles.insert(created.id.clone(), created.clone());
                self.wrap_call(operation_id, to_value(&ResultProfilesCreate { profile: created }))
            }
            "profiles.rename" => {
                let id = payload_str(&payload, "id")?;
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Self::product("PROFILE_NAME_REQUIRED", "name", ""))?;
                let renamed = {
                    let Some(profile) = self.profiles.get_mut(&id) else {
                        return Err(Self::product("PROFILE_NOT_FOUND", "profileId", &id));
                    };
                    profile.name = name.to_string();
                    profile.updated_at = TS.into();
                    profile.clone()
                };
                self.wrap_call(operation_id, to_value(&renamed))
            }
            "profiles.delete" => {
                let id = payload_str(&payload, "id")?;
                if self.profiles.remove(&id).is_none() {
                    return Err(Self::product("PROFILE_NOT_FOUND", "profileId", &id));
                }
                self.ok_call(operation_id, json!({}))
            }
            "profile.export" => {
                let id = payload_str(&payload, "profileId")?;
                if self.profiles.get(&id).is_none() {
                    return Err(Self::product("PROFILE_NOT_FOUND", "profileId", &id));
                }
                let characters = i64::try_from(self.characters.len()).unwrap_or(0);
                let chats = i64::try_from(self.chats.len()).unwrap_or(0);
                let messages = self
                    .messages
                    .values()
                    .map(Vec::len)
                    .sum::<usize>()
                    .try_into()
                    .unwrap_or(0);
                let result = ResultProfileExport {
                    container_path: format!("exports/profile-{id}-{TS}.zip"),
                    format_version: 2,
                    created_at: TS.into(),
                    records: ProfileExportCounts {
                        characters,
                        chats,
                        messages,
                        lorebooks: 0,
                        presets: 0,
                    },
                    assets: 0,
                    size_bytes: 0,
                    manifest_sha256: "0000000000000000000000000000000000000000000000000000000000000000"
                        .into(),
                    profile_id: Some(id),
                };
                self.wrap_call(operation_id, to_value(&result))
            }
            other => Err(ChatRouteError::UnknownCommand(other.to_string())),
        }
    }

    fn start_stream(
        &mut self,
        operation_id: &str,
        payload: Value,
    ) -> Result<String, ChatRouteError> {
        if self.fail_ops.contains(operation_id) {
            return Err(Self::product("WIRE_FAILED", "operationId", operation_id));
        }
        match operation_id {
            "generation.start" | "generation.retry" => {
                self.start_generation(operation_id, &payload)
            }
            other => Err(ChatRouteError::UnknownCommand(other.to_string())),
        }
    }

    fn poll_stream(
        &mut self,
        handle: &str,
        _timeout_ms: u32,
    ) -> Result<StreamFrame, ChatRouteError> {
        let Some(frames) = self.streams.get_mut(handle) else {
            return Ok(StreamFrame::Timeout);
        };
        let frame = frames.pop_front().unwrap_or(StreamFrame::Timeout);
        if let StreamFrame::Event { event, .. } = &frame {
            if let GenerationEvent::GenerationCompleted { final_message } = event.as_ref() {
                if !self
                    .messages
                    .get(&final_message.chat_id)
                    .is_some_and(|rows| rows.iter().any(|row| row.id == final_message.id))
                {
                    let chat_id = final_message.chat_id.clone();
                    self.push_message(final_message.clone());
                    let count = self.message_count(&chat_id);
                    if let Some(chat) = self.chats.get_mut(&chat_id) {
                        chat.message_count = i64::try_from(count).unwrap_or(0);
                    }
                }
            }
        }
        Ok(frame)
    }

    fn cancel_stream(&mut self, handle: &str) -> Result<(), ChatRouteError> {
        if let Some(frames) = self.streams.get_mut(handle) {
            frames.clear();
            frames.push_back(StreamFrame::from_sequenced(
                i64::MAX,
                GenerationEvent::GenerationCancelled,
            ));
            frames.push_back(StreamFrame::Terminal);
        }
        Ok(())
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, ChatRouteError> {
    Ok(serde_json::to_value(value)?)
}

fn payload_str(payload: &Value, key: &str) -> Result<String, ChatRouteError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ChatRouteError::Json(format!("missing {key}")))
}

fn payload_role(payload: &Value) -> Result<MessageRole, ChatRouteError> {
    match payload.get("role").and_then(Value::as_str) {
        Some("user") => Ok(MessageRole::User),
        Some("assistant") => Ok(MessageRole::Assistant),
        Some("system") => Ok(MessageRole::System),
        Some("tool") => Ok(MessageRole::Tool),
        _ => Err(ChatRouteError::Json("missing role".into())),
    }
}

fn role_str(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::Tool => "tool",
    }
}

fn wire_id(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

fn demo_character() -> CharacterDto {
    CharacterDto {
        id: DEMO_CHARACTER_ID.into(),
        name: "Hazel".into(),
        description: Some(
            "[Hazel's Personality= \"sharp\", \"wry\", \"self-taught\", \"stubborn\", \"streetwise\"]"
                .into(),
        ),
        avatar_asset_id: Some(DEMO_AVATAR_ASSET_ID.into()),
        tags: vec![
            "sharp".into(),
            "wry".into(),
            "self-taught".into(),
            "stubborn".into(),
            "streetwise".into(),
        ],
        profile_id: None,
        created_at: TS.into(),
        updated_at: TS.into(),
    }
}

fn demo_seraphina() -> CharacterDto {
    CharacterDto {
        id: DEMO_SERAPHINA_ID.into(),
        name: "Seraphina".into(),
        description: Some(
            "A celestial archivist who keeps the old names. Soft-spoken, precise, and a little too fond of rules."
                .into(),
        ),
        avatar_asset_id: Some(DEMO_AVATAR_ASSET_ID.into()),
        tags: vec!["sfw".into(), "fantasy".into()],
        profile_id: None,
        created_at: TS.into(),
        updated_at: TS.into(),
    }
}

fn demo_vayle() -> CharacterDto {
    CharacterDto {
        id: DEMO_VAYLE_ID.into(),
        name: "Vayle".into(),
        description: Some(
            "Woodland elf with a dry sense of humor and a bow she never quite puts down.".into(),
        ),
        avatar_asset_id: Some(DEMO_AVATAR_ASSET_ID.into()),
        tags: vec!["Elf".into()],
        profile_id: None,
        created_at: TS.into(),
        updated_at: TS.into(),
    }
}

fn demo_persona() -> PersonaDto {
    PersonaDto {
        id: DEMO_PERSONA_ID.into(),
        name: "You".into(),
        description: Some("The user.".into()),
        avatar: None,
        is_default: true,
        created_at: TS.into(),
        updated_at: TS.into(),
    }
}

fn demo_chat(message_count: i64) -> ChatDto {
    ChatDto {
        id: DEMO_CHAT_ID.into(),
        title: "Live wire chat".into(),
        character_id: DEMO_CHARACTER_ID.into(),
        persona_id: Some(DEMO_PERSONA_ID.into()),
        message_count,
        created_at: TS.into(),
        updated_at: TS.into(),
        parent_chat_id: None,
        origin: None,
        source_message_id: None,
    }
}

fn user_message(chat_id: &str, sequence: i64, content: &str) -> MessageDto {
    MessageDto {
        id: wire_id((sequence as u64) + 0x1000),
        chat_id: chat_id.into(),
        role: MessageRole::User,
        content: content.into(),
        created_at: TS.into(),
        sequence,
        generation_run_id: None,
        meta: contracts_generated::generated::FreeObject {
            payload: json!({ "manualExcluded": false }),
        },
        checkpoint_chat_id: None,
    }
}

fn assistant_message(
    chat_id: &str,
    sequence: i64,
    content: &str,
    run_id: Option<String>,
) -> MessageDto {
    MessageDto {
        id: wire_id((sequence as u64) + 0x2000),
        chat_id: chat_id.into(),
        role: MessageRole::Assistant,
        content: content.into(),
        created_at: TS.into(),
        sequence,
        generation_run_id: run_id,
        meta: contracts_generated::generated::FreeObject {
            payload: json!({ "manualExcluded": false }),
        },
        checkpoint_chat_id: None,
    }
}
