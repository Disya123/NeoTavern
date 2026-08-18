use contracts_generated::generated::{
    ChatDto, GenerationEvent, MessageDraftDto, MessageDto, MessageRole, PagedChats, PagedMessages,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

use crate::error::ChatRouteError;
use crate::wire::{ProductWire, StreamFrame};

pub const DEMO_CHAT_ID: &str = "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c";
pub const DEMO_CHARACTER_ID: &str = "4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a";
pub const DEMO_PERSONA_ID: &str = "0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f";
const TS: &str = "2026-08-12T10:00:00Z";

#[derive(Clone, Copy)]
struct CursorCut {
    sequence: i64,
    desc: bool,
}

/// In-memory Product Wire for host tests. Cursors are opaque tokens; the
/// session must pass them through without parsing.
pub struct FakeWire {
    chats: HashMap<String, ChatDto>,
    messages: HashMap<String, Vec<MessageDto>>,
    drafts: HashMap<String, MessageDraftDto>,
    streams: HashMap<String, VecDeque<StreamFrame>>,
    cursors: HashMap<String, CursorCut>,
    fail_ops: HashSet<String>,
    next: u64,
}

impl Default for FakeWire {
    fn default() -> Self {
        Self {
            chats: HashMap::new(),
            messages: HashMap::new(),
            drafts: HashMap::new(),
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
        wire.insert_chat(demo_chat(2));
        wire.push_message(user_message(DEMO_CHAT_ID, 0, "Hello there"));
        wire.push_message(assistant_message(
            DEMO_CHAT_ID,
            1,
            "Hi — live Product Wire.",
            Some(wire_id(0x6e7f8091ab2c)),
        ));
        wire
    }

    pub fn with_message_count(count: u32) -> Self {
        let mut wire = Self::default();
        wire.insert_chat(demo_chat(i64::from(count)));
        for index in 0..count {
            let content = if index.is_multiple_of(5) {
                format!("![photo {index}](asset:thumb-{index})")
            } else {
                format!("**msg {index}**\n\n- item one\n- `code`")
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

    fn insert_chat(&mut self, chat: ChatDto) {
        self.chats.insert(chat.id.clone(), chat);
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

    fn product(code: &str, key: &str, value: &str) -> ChatRouteError {
        ChatRouteError::product(code, json!({ key: value }))
    }

    fn require_chat(&self, chat_id: &str) -> Result<&ChatDto, ChatRouteError> {
        self.chats
            .get(chat_id)
            .ok_or_else(|| Self::product("CHAT_NOT_FOUND", "chatId", chat_id))
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
        let mut frames = VecDeque::new();
        frames.push_back(StreamFrame::Event(Box::new(
            GenerationEvent::GenerationDelta {
                text: reply.chars().take(6).collect(),
            },
        )));
        frames.push_back(StreamFrame::Event(Box::new(
            GenerationEvent::GenerationDelta {
                text: reply.chars().skip(6).collect(),
            },
        )));
        frames.push_back(StreamFrame::Event(Box::new(
            GenerationEvent::GenerationCompleted { final_message },
        )));
        frames.push_back(StreamFrame::Terminal);
        self.streams.insert(run_id.clone(), frames);
        Ok(run_id)
    }
}

impl ProductWire for FakeWire {
    fn call(&mut self, operation_id: &str, payload: Value) -> Result<Value, ChatRouteError> {
        if self.fail_ops.contains(operation_id) {
            return Err(Self::product("WIRE_FAILED", "operationId", operation_id));
        }
        match operation_id {
            "chats.list" => to_value(
                &self.list_chats(payload.get("limit").and_then(Value::as_i64).unwrap_or(50)),
            ),
            "chats.get" => {
                let chat_id = payload_str(&payload, "chatId")?;
                to_value(self.require_chat(&chat_id)?)
            }
            "chats.messages.list" => {
                let chat_id = payload_str(&payload, "chatId")?;
                let page = self.list_messages(
                    &chat_id,
                    payload.get("cursor").and_then(Value::as_str),
                    payload.get("limit").and_then(Value::as_i64).unwrap_or(50),
                    payload.get("order").and_then(Value::as_str),
                )?;
                to_value(&page)
            }
            "chats.messages.create" => to_value(&self.create_message(&payload)?),
            "chats.messages.drafts.save" => to_value(&self.save_draft(&payload)?),
            "chats.messages.drafts.get" => to_value(&self.get_draft(&payload)?),
            "chats.messages.drafts.commit" => to_value(&self.commit_draft(&payload)?),
            "chats.messages.drafts.discard" => Ok(self.discard_draft(&payload)?),
            "generation.cancel" => Ok(json!({})),
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
        if let StreamFrame::Event(event) = &frame {
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
            frames.push_back(StreamFrame::Event(Box::new(
                GenerationEvent::GenerationCancelled,
            )));
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
