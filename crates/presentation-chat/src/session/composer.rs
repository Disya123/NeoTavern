//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
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
        // A live stream means the previous send is still generating: the
        // handle only clears on Terminal/Error, so a double tap cannot start
        // a second run. FakeWire drains synchronously inside `send_inner`,
        // so the in-memory host is unaffected.
        if self.state.stream_handle.is_some() {
            return Ok(());
        }
        self.send_in_flight = true;
        self.state.send_accepted = false;
        let result = self.send_inner(text);
        self.send_in_flight = false;
        result
    }

    pub(crate) fn send_inner(&mut self, text: Option<&str>) -> Result<(), ChatRouteError> {
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
        // React `ChatPage.send`: text starting with `/` is a slash command,
        // never a user message. Native has no plugin/legacy slash runtime, so
        // every `/cmd` is `SLASH_COMMAND_NOT_FOUND` — composer stays, no wire.
        if message.starts_with('/') {
            let command = slash_command_name(&message);
            self.record_error(ChatRouteError::product(
                "SLASH_COMMAND_NOT_FOUND",
                json!({ "command": command }),
            ));
            self.bump_scene();
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
        self.apply_stream_frame(&frame);
        Ok(frame)
    }

    /// Host frame pump: applies every currently-queued stream frame (deltas,
    /// checkpoints, terminal frames) until the wire reports `Timeout`, then
    /// returns whether anything was applied. The host marks the frame dirty
    /// once per pump instead of once per event, so a burst of deltas that
    /// arrived between two redraws coalesces into a single produce.
    pub fn pump_stream(&mut self) -> bool {
        let mut progressed = false;
        for _ in 0..64 {
            match self.poll_stream(0) {
                Ok(StreamFrame::Event { .. }) => progressed = true,
                Ok(StreamFrame::Terminal | StreamFrame::Error(_)) => {
                    progressed = true;
                    break;
                }
                Ok(StreamFrame::Timeout) => break,
                Err(_) => break,
            }
        }
        progressed
    }

    /// Applies a stream frame, skipping duplicate envelope `sequence` values
    /// and identical unsequenced deltas at the same offset.
    pub fn apply_stream_frame(&mut self, frame: &StreamFrame) {
        match frame {
            StreamFrame::Event { sequence, event } => {
                if !self.accept_stream_sequence(*sequence) {
                    return;
                }
                match event.as_ref() {
                    GenerationEvent::GenerationDelta { text } => {
                        self.state.streaming_text.push_str(text);
                    }
                    GenerationEvent::GenerationCheckpoint {
                        sequence: checkpoint,
                        partial_length,
                    } => {
                        if self
                            .state
                            .last_checkpoint_sequence
                            .is_some_and(|prev| *checkpoint <= prev)
                        {
                            return;
                        }
                        self.state.last_checkpoint_sequence = Some(*checkpoint);
                        let keep = usize::try_from(*partial_length).unwrap_or(0);
                        if self.state.streaming_text.len() > keep {
                            self.state.streaming_text.truncate(keep);
                        }
                    }
                    GenerationEvent::GenerationCompleted { final_message } => {
                        self.clear_stream_progress();
                        self.note_durable(final_message);
                        self.state.active_run_id = final_message.generation_run_id.clone();
                        let _ = self.refresh_chat();
                    }
                    GenerationEvent::GenerationFailed { error } => {
                        self.clear_stream_progress();
                        self.surface_error(error.clone());
                    }
                    GenerationEvent::GenerationCancelled => {
                        self.clear_stream_progress();
                    }
                    GenerationEvent::GenerationStep { step } => {
                        apply_generation_step(&mut self.state, step);
                    }
                    GenerationEvent::ConsumerLagged { .. } => {}
                }
            }
            StreamFrame::Error(error) => {
                self.surface_error(error.clone());
                self.state.stream_handle = None;
                self.clear_stream_progress();
            }
            StreamFrame::Terminal => {
                self.state.stream_handle = None;
                self.clear_stream_progress();
            }
            StreamFrame::Timeout => {}
        }
    }

    pub(crate) fn accept_stream_sequence(&mut self, sequence: Option<i64>) -> bool {
        let Some(seq) = sequence else {
            return true;
        };
        if self
            .state
            .last_applied_stream_sequence
            .is_some_and(|prev| seq <= prev)
        {
            return false;
        }
        self.state.last_applied_stream_sequence = Some(seq);
        true
    }

    pub(crate) fn clear_stream_progress(&mut self) {
        self.state.streaming_text.clear();
        self.state.last_checkpoint_sequence = None;
        self.state.tool_activity_name = None;
    }

    /// Full stream/draft teardown for leaving the open chat (React navigates
    /// away; the native session must not keep polling the OLD chat's run).
    /// Unsubscribes from the live stream without cancelling it — the wire
    /// side keeps committing, and re-entering the chat reads the finished
    /// state back — then clears every per-run and per-chat input field.
    pub(crate) fn reset_stream_state(&mut self) {
        if let Some(handle) = self.state.stream_handle.take() {
            let _ = self.wire.drop_stream(&handle);
        }
        self.state.active_run_id = None;
        self.state.last_applied_stream_sequence = None;
        self.clear_stream_progress();
        self.state.composer_text.clear();
        self.state.draft = None;
    }

    /// Pumps the live stream until it ends: both wires guarantee a
    /// `Terminal` frame after the terminal event (FakeWire deque tail;
    /// `KernelProductWire` returns it from the next poll), and `Timeout` is
    /// the fuse for a still-running kernel stream — the host frame loop
    /// keeps pumping those.
    pub fn drain_stream(&mut self) -> Result<(), ChatRouteError> {
        for _ in 0..64 {
            match self.poll_stream(0)? {
                StreamFrame::Timeout | StreamFrame::Terminal | StreamFrame::Error(_) => break,
                StreamFrame::Event { .. } => {}
            }
        }
        Ok(())
    }

    pub fn cancel_generation(&mut self) -> Result<(), ChatRouteError> {
        if let Some(workflow_id) = self.state.active_run_id.take() {
            let _ = self.call_value(
                "generation.cancel",
                &RequestCancelGeneration { workflow_id },
            );
        }
        if let Some(handle) = self.state.stream_handle.take() {
            let _ = self.wire.cancel_stream(&handle);
            let _ = self.drain_stream();
        }
        self.clear_stream_progress();
        self.bump_scene();
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
}
