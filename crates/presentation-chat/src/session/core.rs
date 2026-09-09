//! Split of the former single-file `session.rs` (B1): one mechanical
//! `impl ChatSession` block per feature cluster. The clusters are cut at
//! method boundaries with zero code changes; `mod.rs` re-exports the former
//! public surface (AGENTS: no public contract changes without an explicit
//! assignment).
use super::*;
impl<W: ProductWire> ChatSession<W> {
    /// Read-only route state for hot input paths (keyboard, pointer):
    /// `shell_view` clones characters, visible rows and drafts on every
    /// call, so a keystroke reads its draft field directly instead.
    pub(crate) fn route_state(&self) -> &ChatRouteState {
        &self.state
    }

    /// Last `set_surface_size` viewport width in CSS px.
    pub(crate) fn viewport_width(&self) -> u32 {
        self.viewport_width
    }

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
            asset_store: neotavern_presentation_m0_d2::AssetStore::new(),
            characters_revision: 0,
            characters_cards: RefCell::new(None),
        };
        if let Err(err) = session.load_workspace() {
            session.record_error(err);
        }
        // React `ui.ts` initial shell state: the app starts IN THE CHAT
        // (`sidebarOpen: false`), and the sidebar's resting panel is `home`
        // (`activeSidebarPanel: 'home'`). The panel-over-chat startup this
        // replaces shifted every hit surface from the first second and made
        // wheel-over-panel scroll the hidden chat behind it.
        session.state.sidebar_panel = "home".into();
        session.state.sidebar_open = false;
        session.state.rail_expanded = true;
        session.state.panel_width = 380.0;
        session.state.character_sort = "name".into();
        session.state.character_view = "list".into();
        session.state.character_tab = "cards".into();
        session.state.character_browser_limit = CHARACTERS_PAGE;
        // React `CharacterManagementPanel` mounts in the read-only viewer
        // mode; the header pencil button enters the editor.
        session.state.character_editor_mode = "view".into();
        session.state.gallery_columns = 3;
        session.state.gallery_sort = "oldest".into();
        session.state.persona_tab = "cards".into();
        session.state.persona_sort = "asc".into();
        session.state.lorebook_tab = "books".into();
        session.state.language = "en".into();
        session.state.dir = "ltr".into();
        session.state.ai_tab = "providers".into();
        session.state.settings_tab = "general".into();
        session.state.ui_scale = "medium".into();
        session.state.ui_contrast = "normal".into();
        session.state.ui_font_profile = "default".into();
        session.state.ui_motion = "system".into();
        session.state.open_home_on_load = true;
        session.state.chat_style = "clean".into();
        session.state.chat_avatar_style = "round".into();
        session.state.user_message_position = "right".into();
        session.state.character_message_position = "left".into();
        session.state.ui_opacity = 70;
        session.state.ui_glass_blur = 16;
        session.state.prompt_template = json!({ "mode": "chat" });
        session.state.instruct_selection = "native".into();
        session.state.context_panel_open = false;
        session.state.message_edit_id = None;
        session.state.history_message_id = None;
        session.state.variant_picker_for = None;
        session.state.details_message_id = None;
        session.state.details_mode = "details".into();
        session.state.swipe_label_for = None;
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

    /// Whether the shell sidebar is currently open (desktop hosts shrink the
    /// chat viewport by the sidebar when it is; Android overlays it instead).
    pub fn sidebar_open(&self) -> bool {
        self.state.sidebar_open
    }

    /// React `--st-shell-panel-width`, clamped to the token min/max.
    pub fn panel_width(&self) -> f32 {
        let width = self.state.panel_width;
        if width < 1.0 {
            380.0
        } else {
            width.clamp(260.0, 720.0)
        }
    }

    pub fn set_panel_width(&mut self, width: f32) {
        let next = width.clamp(260.0, 720.0);
        if (self.panel_width() - next).abs() < 0.5 {
            return;
        }
        self.state.panel_width = next;
        self.bump_scene();
    }

    /// Current chat scroll offset in CSS px (0 = pinned to the newest
    /// messages). Read side of [`ChatSession::scroll_chat_by`]; the smooth
    /// scroll animation samples against it between impulses.
    pub fn scroll_offset_css(&self) -> f32 {
        self.state.scroll_offset_css
    }

    /// Maximum chat scroll offset (content extent minus the viewport, CSS
    /// px). Same gap-aware heights the presentation window selects rows with
    /// (`virtualized_window`), so the clamp lands exactly at the newest row's
    /// bottom.
    pub fn scroll_max_css(&self) -> f32 {
        let (_, _, viewport_h, _) = chrome_metrics(self.viewport_width, self.viewport_height);
        let extent: f64 = self
            .state
            .messages
            .iter()
            .map(|row| corrected_height(row, &self.state.height_corrections) + ROW_GAP_CSS)
            .sum();
        (extent - f64::from(viewport_h)).max(0.0) as f32
    }

    pub fn scroll_chat_by(&mut self, dy_css: f32) {
        if dy_css == 0.0 {
            return;
        }
        let next = (self.state.scroll_offset_css + dy_css).clamp(0.0, self.scroll_max_css());
        if (next - self.state.scroll_offset_css).abs() <= f32::EPSILON {
            return;
        }
        self.state.scroll_offset_css = next;
        self.bump_scene();
    }

    /// Direct offset setter (host re-pin): a fling-to-top clamps against the
    /// extent the host knew at impulse time; once learning grows the extent,
    /// the host re-pins the pinned offset to the new maximum. Clamped and
    /// bump-guarded like `scroll_chat_by`.
    pub fn set_scroll_offset_css(&mut self, offset_css: f32) {
        let next = offset_css.clamp(0.0, self.scroll_max_css());
        if (next - self.state.scroll_offset_css).abs() <= f32::EPSILON {
            return;
        }
        self.state.scroll_offset_css = next;
        self.bump_scene();
    }

    pub fn set_safe_area_physical(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        let scale = self.hidpi_scale.max(1.0);
        self.state.insets = SafeAreaInsets {
            top: (top / scale).round(),
            right: (right / scale).round(),
            bottom: (bottom / scale).round(),
            left: (left / scale).round(),
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

    /// L3 height feedback: learn the measured painted row heights from the
    /// last produce. `rects` are the painted message boxes
    /// (`paint_layout().messages`, keyed by `data-message-id`). Returns
    /// `true` when at least one correction CHANGED — the host then runs one
    /// settle produce so the row window (selected by the corrected heights)
    /// matches the paint; a stable layout re-learns nothing and never loops.
    /// An edited row invalidates its own correction via the captured estimate
    /// (see `corrected_height_kind`).
    pub fn learn_measured_heights(
        &mut self,
        rects: &[neotavern_presentation_m0_d2::MessageRect],
    ) -> bool {
        let mut changed = false;
        for rect in rects {
            let Some(row) = self.state.messages.iter().find(|row| row.id == rect.id) else {
                continue;
            };
            let measured = f64::from(rect.css_height);
            if self.state.height_correction(&rect.id) != Some(measured) {
                let estimate = estimate_height(row);
                self.state
                    .learn_height_correction(&rect.id, measured, estimate);
                changed = true;
            }
        }
        changed
    }

    /// The single shared row height (L3): the measured painted height when a
    /// fresh correction exists, the A3 estimate otherwise.
    pub fn row_height_css(&self, row: &MessageDto) -> f64 {
        match self.state.height_corrections.get(&row.id) {
            Some((measured, captured)) if *captured == estimate_height(row) => *measured,
            _ => estimate_height(row),
        }
    }

    pub fn compositor_height_index(&self) -> HeightIndex {
        let mut index = HeightIndex::new();
        let n = self
            .kernel_message_count()
            .max(self.state.messages.len())
            .max(1);
        // A3 height-model unification: the base per-row estimate comes from
        // the SAME `estimate_height` the presentation window uses; the
        // compositor adds its photo over-cover on top (never below), then
        // scales to physical px. The compositor viewport must OVER-cover the
        // real raster — an under-estimate would open a transparent gap
        // (debug_assert in chat-viewport `present`).
        // L3: a learned painted height replaces the estimate — the
        // measurement is the real raster (photo included), so the +436
        // over-cover applies only to estimated rows; a measured row floors
        // at the bubble baseline and needs no margin above the truth.
        let scale = f64::from(self.hidpi_scale());
        for i in 0..n {
            let Some(row) = self.state.messages.get(i) else {
                let _ = index.push(
                    LogicalItemId(i as u64 + 1),
                    48.0 * scale,
                    HeightKind::Estimated,
                );
                continue;
            };
            match self.state.height_corrections.get(&row.id) {
                Some((measured, captured)) if *captured == estimate_height(row) => {
                    let _ = index.push(
                        LogicalItemId(i as u64 + 1),
                        measured.max(COMPOSITOR_ROW_CSS) * scale,
                        HeightKind::Exact,
                    );
                }
                _ => {
                    let base = estimate_height(row);
                    let has_photo =
                        !neotavern_presentation_dioxus_shell::asset_image_refs(&row.content)
                            .is_empty();
                    let h = (base.max(COMPOSITOR_ROW_CSS) + if has_photo { 436.0 } else { 0.0 })
                        * scale;
                    let _ = index.push(LogicalItemId(i as u64 + 1), h, HeightKind::Estimated);
                }
            }
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
}
