use contracts_generated::generated::{
    decode_character_dto, decode_chat_dto, decode_message_draft_dto, decode_message_dto,
    decode_paged_characters, decode_paged_chats, decode_paged_messages,
    decode_result_assets_content, CharacterDto, ChatDto, ErrorDto, GenerationEvent,
    MessageDraftDto, MessageDto, MessageRole, PagedCharacters, PagedChats, PagedMessages,
    RequestAssetsContent, RequestCancelGeneration, RequestCreateCharacter, RequestCreateMessage,
    RequestDeleteCharacter, RequestGetCharacter, RequestGetChat, RequestListCharacters,
    RequestListChats, RequestListMessages, RequestMessageDraftCommit, RequestMessageDraftDiscard,
    RequestMessageDraftGet, RequestMessageDraftSave, RequestRetryGeneration,
    RequestStartGeneration, RequestUpdateCharacter, ResultAssetsContent,
};
use neotavern_chat_viewport::{
    GeometrySnapshot, HeightIndex, HeightKind, LogicalItemId, PredictorBudgets, PresentDecision,
    PresentOutcome, TileCache, ViewportSession,
};
use neotavern_presentation_dioxus_shell::{
    assert_registered_command, chrome_metrics, mount_product_chat, CharacterCardView,
    CharacterDraftView, ProductChatView, ProductChrome, ProductShellView, RowKind, SafeAreaInsets,
    VisibleRow, PRODUCT_PATH_VISIBLE,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

use crate::error::ChatRouteError;
use crate::shell_hit::{next_sort, ShellAction};
use crate::wire::{ProductWire, StreamFrame, PAGE_LIMIT};

/// Bounded CPU avatar thumbnail cache: one entry per `asset_id` is shared by
/// header and card, evicted LRU under a byte budget and wired to the same
/// pressure signal as the GPU cache.
pub const AVATAR_CPU_MAX_ENTRIES: usize = 64;
pub const AVATAR_CPU_MAX_BYTES: usize = 8 * 1024 * 1024;

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
    pub characters: Vec<CharacterDto>,
    pub selected_character_id: Option<String>,
    pub character_search: String,
    pub character_sort: String,
    pub character_view: String,
    pub character_tab: String,
    pub sidebar_panel: String,
    pub sidebar_open: bool,
    pub rail_expanded: bool,
    pub insets: SafeAreaInsets,
    /// Full draft for the selected character (Edit / Advanced / Gallery tabs).
    pub character_draft: Option<CharacterDraftView>,
    /// Cached cover-cropped premultiplied thumbnails keyed by avatar asset id.
    pub avatar_thumbs: HashMap<String, crate::avatar::AvatarThumb>,
    pub(crate) avatar_order: VecDeque<String>,
    pub(crate) avatar_total_bytes: usize,
    pub avatar_ready_token: u64,
    /// Always `None` on the paint path (no `data:` URI in Blitz).
    pub avatar_data_uri: Option<String>,
    /// Matches React `useUiStore.pinnedCharacterId` (select also pins).
    pub pinned_character_id: Option<String>,
    pub create_dialog_open: bool,
    pub delete_dialog_open: bool,
    pub create_name: String,
    pub create_description: String,
    pub create_first_message: String,
    pub status_message: Option<String>,
}

impl ChatRouteState {
    fn touch_avatar(&mut self, asset_id: &str) {
        if let Some(pos) = self.avatar_order.iter().position(|k| k == asset_id) {
            self.avatar_order.remove(pos);
            self.avatar_order.push_front(asset_id.to_string());
        }
    }

    fn make_avatar_room(&mut self, need_bytes: usize) {
        while (self.avatar_total_bytes.saturating_add(need_bytes) > AVATAR_CPU_MAX_BYTES
            || self.avatar_order.len() + 1 > AVATAR_CPU_MAX_ENTRIES)
            && !self.avatar_order.is_empty()
        {
            let Some(key) = self.avatar_order.pop_back() else {
                break;
            };
            if let Some(thumb) = self.avatar_thumbs.remove(&key) {
                self.avatar_total_bytes = self.avatar_total_bytes.saturating_sub(thumb.byte_len());
            }
        }
    }

    /// Insert a CPU thumbnail keyed by `asset_id` (shared header/card handle).
    /// Returns `true` when the entry was newly inserted (caller should bump
    /// `avatar_ready_token`). A hit only promotes the LRU order.
    pub(crate) fn insert_avatar_thumb(
        &mut self,
        asset_id: String,
        thumb: crate::avatar::AvatarThumb,
    ) -> bool {
        if self.avatar_thumbs.contains_key(&asset_id) {
            self.touch_avatar(&asset_id);
            return false;
        }
        let need = thumb.byte_len();
        self.make_avatar_room(need);
        self.avatar_order.push_front(asset_id.clone());
        self.avatar_total_bytes = self.avatar_total_bytes.saturating_add(need);
        self.avatar_thumbs.insert(asset_id, thumb);
        self.avatar_ready_token = self.avatar_ready_token.saturating_add(1);
        true
    }

    /// Evict the least-recently used CPU thumbnails until `bytes_to_free` have
    /// been released. Returns the number of evicted entries.
    pub fn evict_avatars_for_pressure(&mut self, bytes_to_free: usize) -> usize {
        let mut freed = 0usize;
        let mut evicted = 0usize;
        while freed < bytes_to_free {
            let Some(key) = self.avatar_order.pop_back() else {
                break;
            };
            if let Some(thumb) = self.avatar_thumbs.remove(&key) {
                freed = freed.saturating_add(thumb.byte_len());
                self.avatar_total_bytes = self.avatar_total_bytes.saturating_sub(thumb.byte_len());
                evicted += 1;
            }
        }
        if evicted > 0 {
            self.avatar_ready_token = self.avatar_ready_token.saturating_add(1);
        }
        evicted
    }
}

pub struct ChatSession<W: ProductWire> {
    wire: W,
    chat_id: Option<String>,
    state: ChatRouteState,
    issued: Vec<String>,
    send_in_flight: bool,
    last_acked_epoch: u64,
    viewport_width: u32,
    viewport_height: u32,
    hidpi_scale: f32,
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
            viewport_width: 320,
            viewport_height: 200,
            hidpi_scale: 1.0,
        };
        if let Err(err) = session.load_workspace() {
            session.record_error(err);
        }
        session.state.sidebar_panel = "characters".into();
        session.state.sidebar_open = true;
        session.state.rail_expanded = true;
        session.state.character_sort = "name".into();
        session.state.character_view = "list".into();
        session.state.character_tab = "cards".into();
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

    pub fn avatar_thumbs(&self) -> &HashMap<String, crate::avatar::AvatarThumb> {
        &self.state.avatar_thumbs
    }

    pub fn avatar_thumb(&self, asset_id: &str) -> Option<&crate::avatar::AvatarThumb> {
        self.state.avatar_thumbs.get(asset_id)
    }

    pub fn evict_avatars_for_pressure(&mut self, bytes: usize) -> usize {
        self.state.evict_avatars_for_pressure(bytes)
    }

    pub fn avatar_ready_token(&self) -> u64 {
        self.state.avatar_ready_token
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

    pub fn set_surface_size(&mut self, width: u32, height: u32, scale: f32) {
        let scale = scale.max(1.0);
        self.hidpi_scale = scale;
        self.viewport_width = ((width as f32) / scale).round().max(1.0) as u32;
        self.viewport_height = ((height as f32) / scale).round().max(1.0) as u32;
    }

    pub fn set_safe_area_physical(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        let scale = self.hidpi_scale.max(1.0);
        self.state.insets = SafeAreaInsets {
            top: top / scale,
            right: right / scale,
            bottom: bottom / scale,
            left: left / scale,
        };
    }

    pub fn insets(&self) -> SafeAreaInsets {
        self.state.insets
    }

    pub fn hidpi_scale(&self) -> f32 {
        self.hidpi_scale.max(1.0)
    }

    pub fn surface_size(&self) -> (u32, u32) {
        (self.viewport_width, self.viewport_height)
    }

    pub fn compositor_height_index(&self) -> HeightIndex {
        let mut index = HeightIndex::new();
        let n = self
            .kernel_message_count()
            .max(self.state.messages.len())
            .max(1);
        let row_h = 56.0 * f64::from(self.hidpi_scale());
        for i in 0..n {
            let _ = index.push(LogicalItemId(i as u64 + 1), row_h, HeightKind::Estimated);
        }
        index
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
            viewport_width: self.viewport_width,
            viewport_height: self.viewport_height,
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
            density: "comfortable".into(),
            font_scale: "medium".into(),
            insets: self.state.insets,
            editor_mode: "view".into(),
            create_dialog_open: self.state.create_dialog_open,
            delete_dialog_open: self.state.delete_dialog_open,
            create_name: self.state.create_name.clone(),
            create_description: self.state.create_description.clone(),
            create_first_message: self.state.create_first_message.clone(),
            status_message: self.state.status_message.clone(),
            error_message: self.state.last_error.as_ref().map(|err| err.code.clone()),
            gallery_columns: 3,
            gallery_sort: "oldest".into(),
            expanded_greeting: None,
            tag_input: String::new(),
        }
    }

    pub fn present_visible(&self) -> (Vec<VisibleRow>, PresentOutcome) {
        self.visible_window()
    }

    pub fn selected_text(&self) -> Option<String> {
        self.state.messages.last().map(|row| row.content.clone())
    }

    fn visible_window(&self) -> (Vec<VisibleRow>, PresentOutcome) {
        let (_, _, viewport_h, _) = chrome_metrics(self.viewport_width, self.viewport_height);
        virtualized_window(&self.state.messages, f64::from(viewport_h))
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
        let chat_result = self.load_open_chat();
        self.load_characters();
        chat_result
    }

    fn load_open_chat(&mut self) -> Result<(), ChatRouteError> {
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

    fn load_characters(&mut self) {
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

    /// Select a character by id and load its draft + avatar.
    pub fn select_character(&mut self, id: &str) {
        if self.state.selected_character_id.as_deref() == Some(id) {
            return;
        }
        self.state.selected_character_id = Some(id.to_string());
        self.state.pinned_character_id = Some(id.to_string());
        self.load_character_draft();
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
        self.bump_scene();
    }

    pub fn set_panel(&mut self, panel: &str) {
        self.state.sidebar_panel = panel.to_string();
        self.state.sidebar_open = true;
        self.bump_scene();
    }

    pub fn toggle_sidebar(&mut self) {
        self.state.sidebar_open = !self.state.sidebar_open;
        self.bump_scene();
    }

    pub fn toggle_rail(&mut self) {
        self.state.rail_expanded = !self.state.rail_expanded;
        self.bump_scene();
    }

    pub fn open_create_dialog(&mut self) {
        self.state.create_dialog_open = true;
        if self.state.create_name.trim().is_empty() {
            self.state.create_name = "New character".into();
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

    pub fn set_create_description(&mut self, value: &str) {
        self.state.create_description = value.to_string();
        self.bump_scene();
    }

    pub fn set_create_first_message(&mut self, value: &str) {
        self.state.create_first_message = value.to_string();
        self.bump_scene();
    }

    /// Create a character via `characters.create` and refresh the list.
    pub fn confirm_create_character(&mut self) {
        let name = self.state.create_name.trim().to_string();
        if name.is_empty() {
            self.record_error(ChatRouteError::product(
                "CHARACTER_NAME_REQUIRED",
                json!({ "field": "name" }),
            ));
            return;
        }
        let description = if self.state.create_description.trim().is_empty() {
            None
        } else {
            Some(self.state.create_description.clone())
        };
        let req = RequestCreateCharacter {
            name,
            description,
            tags: None,
            avatar_asset_id: None,
            profile_id: None,
        };
        match self.call_decode("characters.create", &req, decode_character_dto) {
            Ok(created) => {
                self.state.create_dialog_open = false;
                self.state.create_name.clear();
                self.state.create_description.clear();
                self.state.create_first_message.clear();
                self.state.selected_character_id = Some(created.id.clone());
                self.state.pinned_character_id = Some(created.id.clone());
                self.state.character_tab = "edit".into();
                self.refresh_characters();
                self.state.status_message = Some("Character created.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    pub fn open_delete_dialog(&mut self) {
        if self.state.selected_character_id.is_some() {
            self.state.delete_dialog_open = true;
            self.bump_scene();
        }
    }

    pub fn close_delete_dialog(&mut self) {
        self.state.delete_dialog_open = false;
        self.bump_scene();
    }

    /// Delete the selected character via `characters.delete` and refresh.
    pub fn confirm_delete_character(&mut self) {
        let Some(id) = self.state.selected_character_id.clone() else {
            self.state.delete_dialog_open = false;
            return;
        };
        match self.call_value(
            "characters.delete",
            &RequestDeleteCharacter { character_id: id },
        ) {
            Ok(_) => {
                self.state.delete_dialog_open = false;
                self.state.selected_character_id = None;
                self.state.character_draft = None;
                self.state.avatar_data_uri = None;
                self.state.character_tab = "cards".into();
                self.refresh_characters();
                self.state.status_message = Some("Character deleted.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Toggle favorite flag on the local draft (Kernel contract does not yet
    /// persist favorites; this keeps the UI state honest until it does).
    pub fn toggle_favorite(&mut self) {
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.favorite = !draft.favorite;
            self.bump_scene();
        }
    }

    pub fn apply_shell_action(&mut self, action: ShellAction) {
        match action {
            ShellAction::ToggleRail => self.toggle_rail(),
            ShellAction::SetPanel(panel) => self.set_panel(&panel),
            ShellAction::ClosePanel => {
                self.state.sidebar_open = false;
                self.bump_scene();
            }
            ShellAction::SetTab(tab) => self.set_character_tab(&tab),
            ShellAction::SetView(view) => self.set_character_view(&view),
            ShellAction::CycleSort => {
                let next = next_sort(&self.state.character_sort);
                self.set_character_sort(next);
            }
            ShellAction::SelectCharacter(id) => self.select_character(&id),
            ShellAction::OpenCreate => self.open_create_dialog(),
            ShellAction::CloseCreate => self.close_create_dialog(),
            ShellAction::ConfirmCreate => self.confirm_create_character(),
            ShellAction::OpenDelete => self.open_delete_dialog(),
            ShellAction::CloseDelete => self.close_delete_dialog(),
            ShellAction::ConfirmDelete => self.confirm_delete_character(),
            ShellAction::ToggleFavorite => self.toggle_favorite(),
            ShellAction::BackToCards => self.set_character_tab("cards"),
            ShellAction::Import => {
                self.state.status_message =
                    Some("Import a JSON or PNG character card from this device.".into());
                self.bump_scene();
            }
        }
    }

    pub fn save_selected_character(&mut self) {
        let Some(draft) = self.state.character_draft.clone() else {
            return;
        };
        let req = RequestUpdateCharacter {
            character_id: draft.id,
            name: Some(draft.name),
            description: Some(draft.description),
            tags: Some(draft.tags),
            avatar_asset_id: draft.avatar_asset_id,
            profile_id: None,
        };
        match self.call_decode("characters.update", &req, decode_character_dto) {
            Ok(_) => {
                self.refresh_characters();
                self.state.status_message = Some("Saved.".into());
            }
            Err(err) => self.record_error(err),
        }
        self.bump_scene();
    }

    /// Load the full draft for the currently selected character.
    fn load_character_draft(&mut self) {
        let Some(id) = self.state.selected_character_id.clone() else {
            self.state.character_draft = None;
            self.state.avatar_data_uri = None;
            return;
        };
        match self.call_decode(
            "characters.get",
            &RequestGetCharacter {
                character_id: id.clone(),
            },
            decode_character_dto,
        ) {
            Ok(dto) => {
                let mut draft = CharacterDraftView::default();
                draft.id = dto.id.clone();
                draft.name = dto.name.clone();
                draft.description = dto.description.clone().unwrap_or_default();
                draft.tags = dto.tags.clone();
                draft.avatar_asset_id = dto.avatar_asset_id.clone();
                self.state.character_draft = Some(draft);
                self.load_avatar_data_uri(dto.avatar_asset_id.as_deref());
            }
            Err(err) => {
                self.record_error(err);
                self.state.character_draft = None;
                self.state.avatar_data_uri = None;
            }
        }
    }

    /// Resolve avatars for every listed character via Product Wire `assets.content`.
    fn hydrate_character_avatars(&mut self) {
        let asset_ids: Vec<String> = self
            .state
            .characters
            .iter()
            .filter_map(|row| row.avatar_asset_id.clone())
            .collect();
        for asset_id in asset_ids {
            if self.state.avatar_thumbs.contains_key(&asset_id) {
                self.state.touch_avatar(&asset_id);
                continue;
            }
            if let Some(thumb) = self.fetch_avatar_thumb(&asset_id) {
                self.state.insert_avatar_thumb(asset_id, thumb);
            }
        }
    }

    fn fetch_avatar_thumb(&mut self, asset_id: &str) -> Option<crate::avatar::AvatarThumb> {
        match self.call_decode(
            "assets.content",
            &RequestAssetsContent {
                asset_id: asset_id.to_string(),
            },
            decode_result_assets_content,
        ) {
            Ok(ResultAssetsContent { content_base64, .. }) => {
                crate::avatar::premultiplied_cover_thumbnail(&content_base64)
            }
            Err(_) => None,
        }
    }

    /// Resolve the avatar asset into a GPU thumbnail. Never a `data:` URI.
    fn load_avatar_data_uri(&mut self, asset_id: Option<&str>) {
        let Some(asset_id) = asset_id else {
            self.state.avatar_data_uri = None;
            return;
        };
        if self.state.avatar_thumbs.contains_key(asset_id) {
            self.state.touch_avatar(asset_id);
            self.state.avatar_data_uri = None;
            if let Some(draft) = self.state.character_draft.as_mut() {
                draft.avatar_data_uri = None;
            }
            return;
        }
        if let Some(thumb) = self.fetch_avatar_thumb(asset_id) {
            self.state.insert_avatar_thumb(asset_id.to_string(), thumb);
        }
        self.state.avatar_data_uri = None;
        if let Some(draft) = self.state.character_draft.as_mut() {
            draft.avatar_data_uri = None;
        }
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

fn virtualized_window(
    messages: &[MessageDto],
    viewport_height: f64,
) -> (Vec<VisibleRow>, PresentOutcome) {
    let mut index = HeightIndex::new();
    for message in messages {
        let _ = index.push(
            LogicalItemId(message.sequence as u64),
            estimate_height(message),
            HeightKind::Estimated,
        );
    }
    let viewport_height = viewport_height.max(1.0);
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
