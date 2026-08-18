use contracts_generated::generated::{
    decode_chat_dto, decode_message_draft_dto, decode_message_dto, decode_paged_chats,
    decode_paged_messages, ChatDto, ErrorDto, GenerationEvent, MessageDraftDto, MessageDto,
    MessageRole, PagedChats, PagedMessages, RequestCancelGeneration, RequestCreateMessage,
    RequestGetChat, RequestListChats, RequestListMessages, RequestMessageDraftCommit,
    RequestMessageDraftDiscard, RequestMessageDraftGet, RequestMessageDraftSave,
    RequestRetryGeneration, RequestStartGeneration,
};
use neotavern_chat_viewport::{
    GeometrySnapshot, HeightIndex, HeightKind, LogicalItemId, PredictorBudgets, PresentDecision,
    PresentOutcome, TileCache, ViewportSession,
};
use neotavern_presentation_dioxus_shell::{
    assert_registered_command, mount_product_chat, ProductChatView, ProductChrome, RowKind,
    VisibleRow, PRODUCT_PATH_VISIBLE,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::ChatRouteError;
use crate::wire::{ProductWire, StreamFrame, PAGE_LIMIT};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatRouteState {
    pub chat: Option<ChatDto>,
    pub messages: Vec<MessageDto>,
    pub next_cursor: Option<String>,
    pub draft: Option<MessageDraftDto>,
    pub composer_text: String,
    pub streaming_text: String,
    pub active_run_id: Option<String>,
    pub last_error: Option<ErrorDto>,
    pub stream_handle: Option<String>,
    pub safe_mode: bool,
    pub last_request_id: Option<String>,
    pub last_operation_id: Option<String>,
    pub last_send_request_id: Option<String>,
    pub last_send_operation_id: Option<String>,
    pub last_durable_message_id: Option<String>,
    pub send_accepted: bool,
    pub scene_epoch: u64,
}

pub struct ChatSession<W: ProductWire> {
    wire: W,
    chat_id: Option<String>,
    state: ChatRouteState,
    issued: Vec<String>,
    send_in_flight: bool,
    last_acked_epoch: u64,
}

impl<W: ProductWire> ChatSession<W> {
    pub fn open(wire: W, preferred_chat_id: Option<&str>) -> Result<Self, ChatRouteError> {
        let mut session = Self {
            wire,
            chat_id: preferred_chat_id.map(str::to_string),
            state: ChatRouteState::default(),
            issued: Vec::new(),
            send_in_flight: false,
            last_acked_epoch: 0,
        };
        if let Err(err) = session.load_workspace() {
            session.record_error(err);
        }
        Ok(session)
    }

    pub fn wire(&self) -> &W {
        &self.wire
    }

    pub fn wire_mut(&mut self) -> &mut W {
        &mut self.wire
    }

    pub fn into_wire(self) -> W {
        self.wire
    }

    pub fn kernel_message_count(&self) -> usize {
        self.state
            .chat
            .as_ref()
            .map(|chat| usize::try_from(chat.message_count.max(0)).unwrap_or(0))
            .unwrap_or(0)
    }

    pub fn scene_epoch(&self) -> u64 {
        self.state.scene_epoch
    }

    pub fn last_durable_message_id(&self) -> Option<&str> {
        self.state.last_durable_message_id.as_deref()
    }

    pub fn send_accepted(&self) -> bool {
        self.state.send_accepted
    }

    /// Stale presenter epochs must not drop a newer Kernel revision.
    pub fn ack_revision(&mut self, observed_epoch: u64) -> bool {
        if observed_epoch < self.state.scene_epoch {
            return false;
        }
        if observed_epoch == self.state.scene_epoch {
            self.last_acked_epoch = observed_epoch;
            return true;
        }
        false
    }

    pub fn last_acked_epoch(&self) -> u64 {
        self.last_acked_epoch
    }

    pub fn set_send_in_flight(&mut self, in_flight: bool) {
        self.send_in_flight = in_flight;
    }

    pub fn state(&self) -> &ChatRouteState {
        &self.state
    }

    pub fn issued_commands(&self) -> &[String] {
        &self.issued
    }

    pub fn chat_id(&self) -> Option<&str> {
        self.chat_id.as_deref()
    }

    pub fn set_safe_mode(&mut self, enabled: bool) {
        self.state.safe_mode = enabled;
    }

    pub fn set_composer_text(&mut self, text: impl Into<String>) -> Result<(), ChatRouteError> {
        self.state.composer_text = text.into();
        self.save_draft()
    }

    pub fn save_draft(&mut self) -> Result<(), ChatRouteError> {
        let Some(chat_id) = self.chat_id.clone() else {
            return Ok(());
        };
        let req = RequestMessageDraftSave {
            chat_id,
            draft_id: self.state.draft.as_ref().map(|row| row.id.clone()),
            role: MessageRole::User,
            content: self.state.composer_text.clone(),
            sequence: None,
        };
        if req.content.is_empty() && req.draft_id.is_none() {
            return Ok(());
        }
        match self.call_decode("chats.messages.drafts.save", &req, decode_message_draft_dto) {
            Ok(draft) => {
                self.state.draft = Some(draft);
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    pub fn discard_draft(&mut self) -> Result<(), ChatRouteError> {
        let (Some(chat_id), Some(draft)) = (self.chat_id.clone(), self.state.draft.clone()) else {
            self.state.composer_text.clear();
            return Ok(());
        };
        let req = RequestMessageDraftDiscard {
            chat_id,
            draft_id: draft.id,
        };
        match self.call_value("chats.messages.drafts.discard", &req) {
            Ok(_) => {
                self.state.draft = None;
                self.state.composer_text.clear();
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    pub fn commit_draft(&mut self) -> Result<(), ChatRouteError> {
        let (Some(chat_id), Some(draft)) = (self.chat_id.clone(), self.state.draft.clone()) else {
            return Ok(());
        };
        let req = RequestMessageDraftCommit {
            chat_id,
            draft_id: draft.id,
        };
        match self.call_decode("chats.messages.drafts.commit", &req, decode_message_dto) {
            Ok(message) => {
                self.note_durable(&message);
                let _ = self.refresh_chat();
                self.state.draft = None;
                self.state.composer_text.clear();
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    pub fn send(&mut self, text: Option<&str>) -> Result<(), ChatRouteError> {
        if self.send_in_flight {
            return Ok(());
        }
        self.send_in_flight = true;
        self.state.send_accepted = false;
        let result = self.send_inner(text);
        self.send_in_flight = false;
        result
    }

    fn send_inner(&mut self, text: Option<&str>) -> Result<(), ChatRouteError> {
        if let Some(text) = text {
            self.state.composer_text = text.to_string();
        }
        let Some(chat_id) = self.chat_id.clone() else {
            self.record_error(ChatRouteError::EmptyLibrary);
            return Ok(());
        };
        let message = self.state.composer_text.trim().to_string();
        if message.is_empty() {
            self.record_error(ChatRouteError::product(
                "EMPTY_MESSAGE",
                json!({ "field": "content" }),
            ));
            return Ok(());
        }
        let _ = self.save_draft();
        let created = match self.call_decode(
            "chats.messages.create",
            &RequestCreateMessage {
                chat_id: chat_id.clone(),
                role: MessageRole::User,
                content: message.clone(),
                generation_run_id: None,
            },
            decode_message_dto,
        ) {
            Ok(row) => row,
            Err(err) => {
                self.record_error(err);
                return Ok(());
            }
        };
        self.note_durable(&created);
        self.state.last_send_request_id = self.state.last_request_id.clone();
        self.state.last_send_operation_id = Some("chats.messages.create".into());
        let _ = self.refresh_chat();
        self.state.send_accepted = true;
        let _ = self.discard_draft();
        let _ = self.start_stream_op(
            "generation.start",
            &RequestStartGeneration {
                chat_id,
                message,
                provider: None,
                model: None,
            },
        );
        let _ = self.refresh_chat();
        Ok(())
    }

    pub fn retry(&mut self) -> Result<(), ChatRouteError> {
        let Some(source_run_id) = self.last_run_id().map(str::to_string) else {
            self.record_error(ChatRouteError::NoActiveRun);
            return Ok(());
        };
        self.start_stream_op(
            "generation.retry",
            &RequestRetryGeneration { source_run_id },
        )
    }

    pub fn prepend(&mut self) -> Result<(), ChatRouteError> {
        let Some(chat_id) = self.chat_id.clone() else {
            return Ok(());
        };
        let Some(cursor) = self.state.next_cursor.clone() else {
            return Ok(());
        };
        match self.list_messages(&chat_id, Some(cursor)) {
            Ok(page) => {
                self.absorb_older_page(page);
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    pub fn poll_stream(&mut self, timeout_ms: u32) -> Result<StreamFrame, ChatRouteError> {
        let Some(handle) = self.state.stream_handle.clone() else {
            return Ok(StreamFrame::Timeout);
        };
        let frame = self.wire.poll_stream(&handle, timeout_ms)?;
        match &frame {
            StreamFrame::Event(event) => match event.as_ref() {
                GenerationEvent::GenerationDelta { text } => {
                    self.state.streaming_text.push_str(text);
                }
                GenerationEvent::GenerationCompleted { final_message } => {
                    self.state.streaming_text.clear();
                    self.note_durable(final_message);
                    self.state.active_run_id = final_message.generation_run_id.clone();
                    let _ = self.refresh_chat();
                }
                GenerationEvent::GenerationFailed { error } => {
                    self.state.streaming_text.clear();
                    self.state.last_error = Some(error.clone());
                }
                GenerationEvent::GenerationCancelled => {
                    self.state.streaming_text.clear();
                }
                GenerationEvent::GenerationCheckpoint { .. }
                | GenerationEvent::GenerationStep { .. }
                | GenerationEvent::ConsumerLagged { .. } => {}
            },
            StreamFrame::Error(error) => {
                self.state.last_error = Some(error.clone());
                self.state.stream_handle = None;
            }
            StreamFrame::Terminal => {
                self.state.stream_handle = None;
                self.state.streaming_text.clear();
            }
            StreamFrame::Timeout => {}
        }
        Ok(frame)
    }

    pub fn drain_stream(&mut self) -> Result<(), ChatRouteError> {
        for _ in 0..64 {
            match self.poll_stream(0)? {
                StreamFrame::Timeout | StreamFrame::Terminal | StreamFrame::Error(_) => break,
                StreamFrame::Event(event)
                    if matches!(
                        event.as_ref(),
                        GenerationEvent::GenerationCompleted { .. }
                            | GenerationEvent::GenerationFailed { .. }
                            | GenerationEvent::GenerationCancelled
                    ) =>
                {
                    let _ = self.poll_stream(0)?;
                    break;
                }
                StreamFrame::Event(_) => {}
            }
        }
        Ok(())
    }

    pub fn cancel_generation(&mut self) -> Result<(), ChatRouteError> {
        if let Some(workflow_id) = self.state.active_run_id.clone() {
            let _ = self.call_value(
                "generation.cancel",
                &RequestCancelGeneration { workflow_id },
            );
        }
        if let Some(handle) = self.state.stream_handle.clone() {
            let _ = self.wire.cancel_stream(&handle);
            let _ = self.drain_stream();
        }
        Ok(())
    }

    pub fn reload_draft(&mut self) -> Result<(), ChatRouteError> {
        let (Some(chat_id), Some(draft_id)) = (
            self.chat_id.clone(),
            self.state.draft.as_ref().map(|row| row.id.clone()),
        ) else {
            return Ok(());
        };
        match self.call_decode(
            "chats.messages.drafts.get",
            &RequestMessageDraftGet { chat_id, draft_id },
            decode_message_draft_dto,
        ) {
            Ok(draft) => {
                self.state.composer_text = draft.content.clone();
                self.state.draft = Some(draft);
            }
            Err(err) => self.record_error(err),
        }
        Ok(())
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
            });
        }
        let chrome = if self
            .state
            .messages
            .iter()
            .any(|row| row.content.contains("!["))
        {
            ProductChrome::TripleGlass
        } else {
            ProductChrome::HeaderComposer
        };
        ProductChatView {
            title,
            message_count: self.kernel_message_count(),
            visible,
            chrome,
            composer_text: self.state.composer_text.clone(),
            error_code: self.state.last_error.as_ref().map(|err| err.code.clone()),
            streaming: !self.state.streaming_text.is_empty() || self.state.stream_handle.is_some(),
        }
    }

    pub fn present_visible(&self) -> (Vec<VisibleRow>, PresentOutcome) {
        self.visible_window()
    }

    pub fn selected_text(&self) -> Option<String> {
        self.state.messages.last().map(|row| row.content.clone())
    }

    fn visible_window(&self) -> (Vec<VisibleRow>, PresentOutcome) {
        virtualized_window(&self.state.messages)
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
            self.state.last_send_request_id.as_deref().or(self.state.last_request_id.as_deref()).unwrap_or("-"),
            self.state.last_send_operation_id.as_deref().or(self.state.last_operation_id.as_deref()).unwrap_or("-"),
            self.state.last_durable_message_id.as_deref().unwrap_or("-"),
            self.kernel_message_count(),
            self.state.messages.len(),
            self.state.scene_epoch,
            self.state.send_accepted,
            error,
        )
    }

    fn load_workspace(&mut self) -> Result<(), ChatRouteError> {
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
                let Some(first) = page.items.first() else {
                    return Err(ChatRouteError::EmptyLibrary);
                };
                first.id.clone()
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

    fn refresh_chat(&mut self) -> Result<(), ChatRouteError> {
        let Some(chat_id) = self.chat_id.clone() else {
            return Ok(());
        };
        match self.call_decode("chats.get", &RequestGetChat { chat_id }, decode_chat_dto) {
            Ok(chat) => {
                self.state.chat = Some(chat);
                Ok(())
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    fn list_messages(
        &mut self,
        chat_id: &str,
        cursor: Option<String>,
    ) -> Result<PagedMessages, ChatRouteError> {
        self.call_decode(
            "chats.messages.list",
            &RequestListMessages {
                chat_id: chat_id.to_string(),
                cursor,
                limit: Some(PAGE_LIMIT),
                order: Some("desc".into()),
            },
            decode_paged_messages,
        )
    }

    fn absorb_latest_page(&mut self, page: PagedMessages) {
        self.state.next_cursor = page.next_cursor;
        let mut items = page.items;
        items.reverse();
        for message in items {
            self.push_unique(message);
        }
    }

    fn absorb_older_page(&mut self, page: PagedMessages) {
        self.state.next_cursor = page.next_cursor;
        let mut older = page.items;
        older.reverse();
        older.retain(|message| !self.state.messages.iter().any(|row| row.id == message.id));
        older.append(&mut self.state.messages);
        self.state.messages = older;
    }

    fn start_stream_op<T: Serialize>(
        &mut self,
        operation_id: &str,
        payload: &T,
    ) -> Result<(), ChatRouteError> {
        assert_registered_command(operation_id)?;
        self.issued.push(operation_id.to_string());
        self.state.last_operation_id = Some(operation_id.to_string());
        let value = serde_json::to_value(payload)?;
        match self.wire.start_stream(operation_id, value) {
            Ok(handle) => {
                self.state.stream_handle = Some(handle.clone());
                self.state.active_run_id = Some(handle);
                self.state.streaming_text.clear();
                self.state.last_error = None;
                self.drain_stream()
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    fn call_decode<T: Serialize, R: DeserializeOwned>(
        &mut self,
        operation_id: &str,
        payload: &T,
        decode: fn(&[u8]) -> Result<R, contracts_generated::WireError>,
    ) -> Result<R, ChatRouteError> {
        let value = self.call_value(operation_id, payload)?;
        let bytes = serde_json::to_vec(&value)?;
        decode(&bytes).map_err(|err| ChatRouteError::Wire(err.message))
    }

    fn call_value<T: Serialize>(
        &mut self,
        operation_id: &str,
        payload: &T,
    ) -> Result<Value, ChatRouteError> {
        assert_registered_command(operation_id)?;
        self.issued.push(operation_id.to_string());
        self.state.last_operation_id = Some(operation_id.to_string());
        let value = serde_json::to_value(payload)?;
        let call = self.wire.call(operation_id, value)?;
        self.state.last_request_id = Some(call.request_id);
        Ok(call.result)
    }

    fn bump_scene(&mut self) {
        self.state.scene_epoch = self.state.scene_epoch.saturating_add(1);
    }

    fn note_durable(&mut self, message: &MessageDto) {
        let is_new = !self.state.messages.iter().any(|row| row.id == message.id);
        self.push_unique(message.clone());
        self.state.last_durable_message_id = Some(message.id.clone());
        if is_new {
            self.bump_scene();
        }
    }

    fn push_unique(&mut self, message: MessageDto) {
        if self.state.messages.iter().any(|row| row.id == message.id) {
            return;
        }
        self.state.messages.push(message);
        self.state.messages.sort_by_key(|row| row.sequence);
    }

    fn last_run_id(&self) -> Option<&str> {
        self.state.active_run_id.as_deref().or_else(|| {
            self.state
                .messages
                .iter()
                .rev()
                .find_map(|row| row.generation_run_id.as_deref())
        })
    }

    fn record_error(&mut self, err: ChatRouteError) {
        match err {
            ChatRouteError::Product(dto) => self.state.last_error = Some(dto),
            other => {
                self.state.last_error = Some(ErrorDto {
                    code: other.reason_code(),
                    params: json!({ "message": other.to_string() }),
                    trace_id: None,
                    correlation_id: None,
                });
            }
        }
    }
}

fn virtualized_window(messages: &[MessageDto]) -> (Vec<VisibleRow>, PresentOutcome) {
    let mut index = HeightIndex::new();
    for message in messages {
        let _ = index.push(
            LogicalItemId(message.sequence as u64),
            estimate_height(message),
            HeightKind::Estimated,
        );
    }
    let viewport_height = 124.0;
    let extent = index.extent();
    if messages.is_empty() || extent <= viewport_height {
        return (
            visible_rows(messages),
            PresentOutcome {
                decision: PresentDecision::Prepared,
                blank_px: 0.0,
                waited_on_producer: false,
                snapshot: GeometrySnapshot::empty(),
            },
        );
    }
    let mut viewport = ViewportSession::new(
        index,
        PredictorBudgets::default(),
        TileCache::new(64, 256 * 1024),
        viewport_height,
        8_333_333,
    );
    let extent = viewport.index().extent();
    viewport.teleport((extent - viewport_height).max(0.0));
    let outcome = viewport.present();
    let start = viewport.offset();
    let span = viewport
        .index()
        .span_covering(start, start + viewport_height);
    let mut visible = Vec::new();
    for i in span.start..span.end {
        if let Some((id, _, _)) = viewport.index().height_at(i) {
            if let Some(message) = messages.iter().find(|row| row.sequence as u64 == id.0) {
                visible.push(VisibleRow {
                    id: message.id.clone(),
                    role: role_name(&message.role).into(),
                    content: message.content.clone(),
                    kind: row_kind(&message.content),
                });
            }
        }
    }
    if visible.is_empty() {
        visible = visible_rows(messages);
    }
    (visible, outcome)
}

fn estimate_height(message: &MessageDto) -> f64 {
    48.0 + (message.content.len() as f64 / 8.0).min(160.0)
}

fn visible_rows(messages: &[MessageDto]) -> Vec<VisibleRow> {
    let start = messages.len().saturating_sub(PRODUCT_PATH_VISIBLE);
    messages[start..]
        .iter()
        .map(|row| VisibleRow {
            id: row.id.clone(),
            role: role_name(&row.role).into(),
            content: row.content.clone(),
            kind: row_kind(&row.content),
        })
        .collect()
}

pub(crate) fn role_name(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::Tool => "tool",
    }
}

pub(crate) fn row_kind(content: &str) -> RowKind {
    let image = content.contains("![");
    let markdown = content.contains("**") || content.contains('\n');
    match (image, markdown) {
        (true, true) => RowKind::Mixed,
        (true, false) => RowKind::Image,
        _ => RowKind::Markdown,
    }
}
