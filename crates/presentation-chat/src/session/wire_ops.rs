//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    pub(crate) fn refresh_chat(&mut self) -> Result<(), ChatRouteError> {
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

    pub(crate) fn list_messages(
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

    pub(crate) fn absorb_latest_page(&mut self, page: PagedMessages) {
        self.state.next_cursor = page.next_cursor;
        let mut items = page.items;
        items.reverse();
        for message in items {
            self.push_unique(message);
        }
        self.hydrate_message_assets();
    }

    pub(crate) fn absorb_older_page(&mut self, page: PagedMessages) {
        self.state.next_cursor = page.next_cursor;
        let mut older = page.items;
        older.reverse();
        older.retain(|message| !self.state.messages.iter().any(|row| row.id == message.id));
        older.append(&mut self.state.messages);
        self.state.messages = older;
        self.hydrate_message_assets();
    }

    /// Fetch the raw bytes of an asset from Product Wire `assets.content`.
    /// Returns `None` when the wire errors or the id is unknown — the message
    /// keeps its placeholder block instead of blocking the route.
    /// Kernel-side message-image thumbnail bytes (image audit stage C):
    /// `assets.thumb` returns an encoded, aspect-preserving raster ready for
    /// the in-scene Blitz `<img>` (the kernel never ships the original).
    pub(crate) fn fetch_asset_thumb_bytes(
        &mut self,
        asset_id: &str,
        max_px: i64,
    ) -> Option<Vec<u8>> {
        use base64::Engine as _;
        let result: ResultAssetsThumb = self
            .call_decode(
                "assets.thumb",
                &RequestAssetsThumb {
                    asset_id: asset_id.to_string(),
                    max_px,
                },
                decode_result_assets_thumb,
            )
            .ok()?;
        let compact: String = result
            .content_base64
            .chars()
            .filter(|ch| !ch.is_ascii_whitespace())
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(compact.as_bytes())
            .ok()
    }

    /// Resolve `![alt](asset:{id})` references in the loaded messages into
    /// the process asset store, so the in-scene `<img>` rasters decode
    /// (image audit, stage B). Bounded per call: at most
    /// [`MESSAGE_ASSET_HYDRATE_LIMIT`] fetches; already-stored ids short-
    /// circuit. Failures are silent — the message keeps the placeholder
    /// block instead of blocking the route.
    ///
    /// A3 window-first order: ids inside the *visible* span (per the
    /// compositor height-index model + current scroll offset, with overscan)
    /// are fetched before everything else, so a jump/scroll paints images
    /// where the user is looking rather than at the head of the list.
    pub(crate) fn hydrate_message_assets(&mut self) -> bool {
        const LIMIT: usize = 32;
        let mut ids: Vec<String> = Vec::new();
        let push_id = |ids: &mut Vec<String>, id: String| {
            if !ids.contains(&id) {
                ids.push(id);
            }
        };
        // Pass 1: the visible window (id order preserved so the nearest
        // offscreen overscan rows hydrate before far ones).
        for row_id in self.visible_message_row_ids() {
            let Some(row) = self.state.messages.iter().find(|row| row.id == row_id) else {
                continue;
            };
            for id in neotavern_presentation_dioxus_shell::asset_image_refs(&row.content) {
                push_id(&mut ids, id);
                if ids.len() >= LIMIT {
                    break;
                }
            }
            if ids.len() >= LIMIT {
                break;
            }
        }
        // Pass 2: the rest of the loaded page in the former head-first order.
        if ids.len() < LIMIT {
            'outer: for row in &self.state.messages {
                for id in neotavern_presentation_dioxus_shell::asset_image_refs(&row.content) {
                    push_id(&mut ids, id);
                    if ids.len() >= LIMIT {
                        break 'outer;
                    }
                }
            }
        }
        let store = self.asset_store();
        let mut hydrated = 0usize;
        for id in ids {
            if store.contains(&id) {
                continue;
            }
            let Some(thumb_bytes) =
                self.fetch_asset_thumb_bytes(&id, i64::from(crate::avatar::MESSAGE_IMAGE_MAX_PX))
            else {
                continue;
            };
            store.insert(&id, thumb_bytes);
            hydrated += 1;
        }
        hydrated > 0
    }

    /// Scroll-settle trigger (A3): hosts call this when the visible window
    /// changed without a page absorb (wheel/glide landed, grab, resize) so
    /// the just-revealed images hydrate before the next paint. Cheap when
    /// everything visible is already stored (`contains` short-circuits).
    /// Returns whether any new asset landed — the host requests one redraw
    /// so the next produce paints it.
    pub fn refresh_visible_assets(&mut self) -> bool {
        self.hydrate_message_assets()
    }

    /// Diagnostic/observability view of the A3 hydration window: the row ids
    /// [`Self::hydrate_message_assets`]'s first pass targets right now
    /// (visible span + overscan). Exposed for tests and diagnostics.
    pub fn visible_asset_window_ids(&self) -> Vec<String> {
        self.visible_message_row_ids()
    }

    /// Row ids inside the visible chat window per the compositor height model
    /// (`compositor_height_index`), scrolled to the current offset with an
    /// overscan of a few rows on both sides (a hydrate lands between produces,
    /// so estimates drift — overscan absorbs it). Falls back to the newest
    /// rows when the window math cannot produce a span (empty index, zero
    /// extent, or a span that resolved to nothing).
    pub(crate) fn visible_message_row_ids(&self) -> Vec<String> {
        const OVERSCAN_ROWS: usize = 4;
        let index = self.compositor_height_index();
        let extent = index.extent();
        if index.is_empty() || extent <= 0.0 {
            return self
                .state
                .messages
                .iter()
                .rev()
                .take(8)
                .map(|row| row.id.clone())
                .collect();
        }
        let (_, _, viewport_h, _) = chrome_metrics(self.viewport_width, self.viewport_height);
        let viewport = f64::from(viewport_h).max(1.0);
        let budget = (extent - viewport).max(0.0);
        let scroll = f64::from(self.state.scroll_offset_css).min(budget);
        // `teleport(budget - scroll)` — the same bottom-anchored offset the
        // `virtualized_window` presentation path uses.
        let top = budget - scroll;
        let span =
            index.span_covering((top - OVERSCAN_ROWS as f64 * 56.0).max(0.0), top + viewport);
        let mut ids = Vec::new();
        for i in span.start..span.end {
            if let Some((id, _, _)) = index.height_at(i) {
                // `compositor_height_index` keys rows by `i + 1` (1-based
                // sequence); map back to the message row.
                if let Some(row) = self.state.messages.get((id.0 as usize).wrapping_sub(1)) {
                    ids.push(row.id.clone());
                }
            }
        }
        if ids.is_empty() {
            return self
                .state
                .messages
                .iter()
                .rev()
                .take(8)
                .map(|row| row.id.clone())
                .collect();
        }
        ids
    }

    pub(crate) fn start_stream_op<T: Serialize>(
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
                self.state.tool_activity_name = None;
                self.state.last_applied_stream_sequence = None;
                self.state.last_checkpoint_sequence = None;
                self.state.last_error = None;
                self.drain_stream()
            }
            Err(err) => {
                self.record_error(err);
                Ok(())
            }
        }
    }

    pub(crate) fn call_decode<T: Serialize, R: DeserializeOwned>(
        &mut self,
        operation_id: &str,
        payload: &T,
        decode: fn(&[u8]) -> Result<R, contracts_generated::WireError>,
    ) -> Result<R, ChatRouteError> {
        let value = self.call_value(operation_id, payload)?;
        let bytes = serde_json::to_vec(&value)?;
        decode(&bytes).map_err(|err| ChatRouteError::Wire(err.message))
    }

    pub(crate) fn call_value<T: Serialize>(
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

    pub(crate) fn bump_scene(&mut self) {
        self.state.scene_epoch = self.state.scene_epoch.saturating_add(1);
    }

    pub(crate) fn note_durable(&mut self, message: &MessageDto) {
        let is_new = !self.state.messages.iter().any(|row| row.id == message.id);
        self.push_unique(message.clone());
        self.state.last_durable_message_id = Some(message.id.clone());
        if is_new {
            self.hydrate_message_assets();
            self.bump_scene();
        }
    }

    pub(crate) fn push_unique(&mut self, message: MessageDto) {
        if self.state.messages.iter().any(|row| row.id == message.id) {
            return;
        }
        self.state.messages.push(message);
        self.state.messages.sort_by_key(|row| row.sequence);
    }

    pub(crate) fn last_run_id(&self) -> Option<&str> {
        self.state.active_run_id.as_deref().or_else(|| {
            self.state
                .messages
                .iter()
                .rev()
                .find_map(|row| row.generation_run_id.as_deref())
        })
    }

    pub(crate) fn record_error(&mut self, err: ChatRouteError) {
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

/// The host consumes the `refresh_visible_assets` bool to decide whether to
/// re-arm a redraw (a hydrated asset paints on the next produce): fresh
/// hydration must report exactly once, then short-circuit.
#[cfg(test)]
mod hydration_flag_tests {
    use crate::{start_flagged_session, DEMO_CHAT_ID};

    #[test]
    fn refresh_visible_assets_reports_fresh_hydration_once() {
        let (mut session, _) = start_flagged_session(
            Some("1"),
            crate::FakeWire::with_message_count(40),
            Some(DEMO_CHAT_ID),
            None,
        )
        .expect("route");
        assert!(
            !session.refresh_visible_assets(),
            "the settled window is fully hydrated right after open"
        );
        // Point the bottom-anchored tail row at a synthetic id: the visible
        // window now references an asset the store never fetched. The demo
        // `assets.thumb` serves bytes for any id, so the fetch succeeds.
        let tail = session
            .state
            .messages
            .last_mut()
            .expect("the demo chat has rows");
        tail.content = "![fresh](asset:00000000-0000-4000-8000-00000000feed)".to_string();
        assert!(
            session.refresh_visible_assets(),
            "a visible unhydrated id must be reported"
        );
        assert!(
            !session.refresh_visible_assets(),
            "the second call must short-circuit (already stored)"
        );
    }
}
