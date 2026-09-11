//! Pointer and touch input for the desktop host: capture at `Down`, slop
//! rules, quick/message/shell action dispatch at `Up`, drag-resize, and the
//! touch pipeline (drag scroll + fling).

use super::{
    write_export_file, App, PanelDrag, PendingMessageAction, PendingUi, QuickAction, TextFocus,
    TouchContact,
};
use crate::{hit_test, QuickIntent, ShellAction, ShellHit, TapIntent, RAIL_WIDTH, TOUCH_SLOP_CSS};
use neotavern_presentation_dioxus_shell::current_product_shell;

impl App {
    /// Down: capture native controls via `hit_test`, exactly like the Android
    /// `try_push(Down)`. Over the chat canvas (`None`) we capture nothing вЂ”
    /// wheel/drag handles that area.
    pub(super) fn pointer_down(&mut self, css_x: f32, css_y: f32) {
        // A grab lands any running scroll animation BEFORE capture: the
        // sync-back produce refreshes hit rects so they match the shifted
        // screen exactly (one ~30 ms produce per grab, not per scroll frame).
        if self.scroll_animation_active()
            || self.ack.drift(self.visual_scroll_css).abs() > f32::EPSILON
        {
            self.smooth_scroll = None;
            self.glide_velocity = 0.0;
            self.land_now();
            self.produce_and_render();
        }
        self.ensure_viewport();
        self.pending_message_action = None;
        self.pending_quick = None;
        self.pending_custom = None;
        self.panel_drag = None;
        let rects = self.hit_rects.clone();
        // Single geometry per tap: both hit systems read the INSTALLED view —
        // the same produce painted `rects` above. A fresh `shell_view()` here
        // cloned the whole view-model per pointer event AND diverged from the
        // painted frame whenever state mutated between produce and Down.
        let view = current_product_shell();
        // React `ChatSnapshotsMenu` closes its panel on a press anywhere
        // outside the host (document pointerdown). The painted frame marks
        // the panel, the trigger and every row with `snapshot*` parts, so
        // one needle separates inside from outside. Live route state, not
        // the installed view: the menu may have opened since the last
        // produce in tests and during the one-frame reproduce window.
        if self.session.route_state().snapshots_menu_open && !rects.covers(css_x, css_y, "snapshot")
        {
            self.session.close_snapshots_menu();
        }
        // React `MessageVariantPicker` closes the same way: a press outside
        // the popover (`data-part="swipe-picker-popover"`) or its rows
        // (`data-action="swipe-pick"`) dismisses it at press time.
        if self.session.route_state().variant_picker_for.is_some()
            && !rects.covers(css_x, css_y, "swipe-picker")
            && !rects.covers(css_x, css_y, "swipe-pick")
        {
            self.session.close_variant_picker();
        }
        if self.near_panel_resize(css_x) {
            self.panel_drag = Some(PanelDrag {
                start_x: css_x,
                start_width: self.session.panel_width(),
            });
            self.pending_ui = None;
            self.focus = TextFocus::None;
            return;
        }
        self.pending_ui = hit_test(&view, css_x, css_y).map(|hit| PendingUi { css_x, css_y, hit });
        // Layout-derived controls (HitRects): composer chrome + inline message
        // actions. The decision table is shared with the Android host
        // (`hit_rects::resolve_tap`) вЂ” geometry from the same Blitz/Taffy pass
        // that painted the frame, no hand-measured bands.
        match rects.resolve_tap(css_x, css_y) {
            TapIntent::Quick(quick) => {
                let quick = match quick {
                    QuickIntent::Send => QuickAction::Send,
                    QuickIntent::Stop => QuickAction::Stop,
                    QuickIntent::ComposerSettings => QuickAction::ComposerSettings,
                    QuickIntent::ComposerReset => QuickAction::ComposerReset,
                    QuickIntent::ComposerContext => QuickAction::ComposerContext,
                    QuickIntent::ScrollLatest => QuickAction::ScrollLatest,
                    QuickIntent::HeaderSearch => QuickAction::HeaderSearch,
                    QuickIntent::BackToParentChat => QuickAction::BackToParentChat,
                };
                self.pending_quick = Some((quick, css_x, css_y));
            }
            TapIntent::MessageAction { kind, row_id } => {
                self.pending_message_action = Some(PendingMessageAction {
                    css_x,
                    css_y,
                    kind,
                    row_id,
                });
            }
            // Capture custom controls through the same release/slop path as
            // builtins. The layout target supersedes geometric shell hits.
            TapIntent::Custom { name } => {
                self.pending_ui = None;
                self.pending_custom = Some((name, css_x, css_y));
            }
            TapIntent::None => {}
        }
        // Bin-local keyboard focus вЂ” targets resolved from the same snapshot.
        let mut focus = TextFocus::None;
        if view.card_import_dialog_open {
            if rects.covers(css_x, css_y, "part:card-path-input") {
                focus = TextFocus::CardPath;
            }
        } else if view.prompt_template_import_open {
            if rects.covers(css_x, css_y, "part:prompt-template-path-input") {
                focus = TextFocus::PromptTemplatePath;
            }
        } else if view.generation_preset_import_open {
            if rects.covers(css_x, css_y, "part:generation-preset-path-input") {
                focus = TextFocus::PresetImportPath;
            }
        } else if view.create_dialog_open {
            if rects.covers(css_x, css_y, "part:create-name") {
                focus = TextFocus::CreateName;
            }
        } else if view.prompt_block_edit_open {
            if rects.covers(css_x, css_y, "part:prompt-block-name-input") {
                focus = TextFocus::PromptBlockName;
            } else if rects.covers(css_x, css_y, "part:prompt-block-depth-input") {
                focus = TextFocus::PromptBlockDepth;
            } else if rects.covers(css_x, css_y, "part:prompt-block-order-input") {
                focus = TextFocus::PromptBlockOrder;
            } else if rects.covers(css_x, css_y, "part:prompt-block-content-input") {
                focus = TextFocus::PromptBlockContent;
            } else if rects.covers(css_x, css_y, "part:prompt-block-model-input")
                && view.selected_provider_id.is_some()
            {
                focus = TextFocus::PromptBlockModel;
            }
        } else if rects.covers(css_x, css_y, "slot:chat.composer")
            || rects.covers(css_x, css_y, "component:textarea")
        {
            focus = TextFocus::Composer;
        } else if rects.covers(css_x, css_y, "component:text-field+part:search") {
            focus = TextFocus::CharacterSearch;
        } else if rects.covers(css_x, css_y, "part:chat-search") {
            focus = TextFocus::ChatSearch;
        } else if rects.covers(css_x, css_y, "part:profile-create-name") {
            focus = TextFocus::ProfileCreateName;
        } else if rects.covers(css_x, css_y, "part:profile-rename-input") {
            focus = TextFocus::ProfileRename;
        } else if rects.covers(css_x, css_y, "part:chat-rename-input") {
            focus = TextFocus::ChatRename;
        } else if rects.covers(css_x, css_y, "part:memory-content-input") {
            focus = TextFocus::MemoryContent;
        } else if rects.covers(css_x, css_y, "part:memory-keys-input") {
            focus = TextFocus::MemoryKeys;
        } else if rects.covers(css_x, css_y, "part:preset-name-input") {
            focus = TextFocus::PresetName;
        } else if rects.covers(css_x, css_y, "part:provider-name-input") {
            focus = TextFocus::ProviderName;
        } else if rects.covers(css_x, css_y, "part:message-edit-input") {
            focus = TextFocus::MessageEdit;
        } else if rects.covers(css_x, css_y, "part:lorebook-name-input") {
            focus = TextFocus::LorebookName;
        } else if rects.covers(css_x, css_y, "part:lorebook-description-input") {
            focus = TextFocus::LorebookDescription;
        } else if rects.covers(css_x, css_y, "part:persona-name-input") {
            focus = TextFocus::PersonaName;
        } else if rects.covers(css_x, css_y, "part:persona-description-input") {
            focus = TextFocus::PersonaDescription;
        } else if rects.covers(css_x, css_y, "part:profile-import-path") {
            focus = TextFocus::ProfileImportPath;
        } else if rects.covers(css_x, css_y, "part:header-search-input") {
            focus = TextFocus::HeaderSearch;
        } else if rects.covers(css_x, css_y, "part:instruct-system-input") {
            focus = TextFocus::InstructSystem;
        } else if rects.covers(css_x, css_y, "part:instruct-user-input") {
            focus = TextFocus::InstructUser;
        } else if rects.covers(css_x, css_y, "part:instruct-assistant-input") {
            focus = TextFocus::InstructAssistant;
        } else if rects.covers(css_x, css_y, "part:instruct-tool-input") {
            focus = TextFocus::InstructTool;
        } else if rects.covers(css_x, css_y, "part:instruct-suffix-input") {
            focus = TextFocus::InstructSuffix;
        } else if rects.covers(css_x, css_y, "part:instruct-stops-input") {
            focus = TextFocus::InstructStops;
        } else if rects.covers(css_x, css_y, "part:character-name-input") {
            focus = TextFocus::CharacterName;
        } else if rects.covers(css_x, css_y, "part:character-description-input") {
            focus = TextFocus::CharacterDescription;
        } else if rects.covers(css_x, css_y, "part:character-tag-input") {
            focus = TextFocus::CharacterTag;
        } else if rects.covers(css_x, css_y, "part:character-first-message-input") {
            focus = TextFocus::CharacterFirstMessage;
        } else if rects.covers(css_x, css_y, "part:character-creator-notes-input") {
            focus = TextFocus::CharacterCreatorNotes;
        } else if let Some(rect) = rects.top_matching(css_x, css_y, "part:character-greeting-input")
        {
            if let Some(idx) = rect.key.as_deref().and_then(|k| k.parse::<usize>().ok()) {
                focus = TextFocus::CharacterGreeting(idx);
            }
        } else if rects.covers(css_x, css_y, "part:preset-value-input") {
            focus = TextFocus::PresetSampler;
        }
        self.focus = focus;
        // G5 focus feedback: publish the focused field's Theme SDK identity
        // so the renderers can draw the React focus ring on the same part.
        // `set_focused_part` only bumps on a CHANGE — re-tapping the already
        // focused field stays free.
        let focused_part = match focus {
            TextFocus::None => None,
            TextFocus::Composer => Some("slot:chat.composer"),
            TextFocus::CharacterSearch => Some("component:text-field+part:search"),
            TextFocus::ChatSearch => Some("part:chat-search"),
            TextFocus::CreateName => Some("part:create-name"),
            TextFocus::ProfileCreateName => Some("part:profile-create-name"),
            TextFocus::ProfileRename => Some("part:profile-rename-input"),
            TextFocus::ChatRename => Some("part:chat-rename-input"),
            TextFocus::MemoryContent => Some("part:memory-content-input"),
            TextFocus::MemoryKeys => Some("part:memory-keys-input"),
            TextFocus::PresetName => Some("part:preset-name-input"),
            TextFocus::ProviderName => Some("part:provider-name-input"),
            TextFocus::MessageEdit => Some("part:message-edit-input"),
            TextFocus::LorebookName => Some("part:lorebook-name-input"),
            TextFocus::LorebookDescription => Some("part:lorebook-description-input"),
            TextFocus::PersonaName => Some("part:persona-name-input"),
            TextFocus::PersonaDescription => Some("part:persona-description-input"),
            TextFocus::CardPath => Some("part:card-path-input"),
            TextFocus::PromptTemplatePath => Some("part:prompt-template-path-input"),
            TextFocus::PresetImportPath => Some("part:generation-preset-path-input"),
            TextFocus::ProfileImportPath => Some("part:profile-import-path"),
            TextFocus::HeaderSearch => Some("part:header-search-input"),
            TextFocus::InstructSystem => Some("part:instruct-system-input"),
            TextFocus::InstructUser => Some("part:instruct-user-input"),
            TextFocus::InstructAssistant => Some("part:instruct-assistant-input"),
            TextFocus::InstructTool => Some("part:instruct-tool-input"),
            TextFocus::InstructSuffix => Some("part:instruct-suffix-input"),
            TextFocus::InstructStops => Some("part:instruct-stops-input"),
            TextFocus::PromptBlockName => Some("part:prompt-block-name-input"),
            TextFocus::PromptBlockContent => Some("part:prompt-block-content-input"),
            TextFocus::PromptBlockDepth => Some("part:prompt-block-depth-input"),
            TextFocus::PromptBlockOrder => Some("part:prompt-block-order-input"),
            TextFocus::PromptBlockModel => Some("part:prompt-block-model-input"),
            TextFocus::CharacterName => Some("part:character-name-input"),
            TextFocus::CharacterDescription => Some("part:character-description-input"),
            TextFocus::CharacterTag => Some("part:character-tag-input"),
            TextFocus::CharacterFirstMessage => Some("part:character-first-message-input"),
            TextFocus::CharacterCreatorNotes => Some("part:character-creator-notes-input"),
            TextFocus::CharacterGreeting(_) => Some("part:character-greeting-input"),
            TextFocus::PresetSampler => Some("part:preset-value-input"),
        };
        self.session.set_focused_part(focused_part);
    }
    pub(super) fn near_panel_resize(&self, css_x: f32) -> bool {
        // Hot path (per pointer event): direct state reads, no view-model
        // build — `shell_view` clones characters, rows and drafts per call.
        if !self.session.route_state().sidebar_open || self.session.viewport_width() <= 600 {
            return false;
        }
        let edge = RAIL_WIDTH + self.session.panel_width();
        (css_x - edge).abs() <= 6.0
    }

    /// Send the composer draft (durable message via `chats.messages.create`).
    pub(super) fn send_composer(&mut self) {
        eprintln!("[neocompositor-desktop] composer send tapped");
        match self.session.send(None) {
            Ok(()) => {}
            Err(err) => eprintln!("[neocompositor-desktop] send error: {err}"),
        }
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }

    /// Inline message actions (copy/delete) resolve through the hit-rect
    /// snapshot in `pointer_down`; the row id arrives via the button's
    /// `data-message-id` (`SlotNode.key`), so no pixel offsets exist here.

    /// Copy a message to the OS clipboard (client-side React action) and
    /// surface the honest "copied" toast afterwards. The shared
    /// `PresentSurface` stays OS-neutral: the clipboard is a host capability.
    pub(super) fn copy_message(&mut self, row_id: String) {
        let Some(text) = self.session.message_text(&row_id) else {
            return;
        };
        let chars = text.chars().count();
        match arboard::Clipboard::new().and_then(|mut cb| cb.set_text(text)) {
            Ok(()) => {
                eprintln!(
                    "[neocompositor-desktop] message {row_id} copied ({chars} chars) to clipboard"
                );
                self.session.copied_message(&row_id);
                self.dirty = true;
                self.window.as_ref().map(|w| w.request_redraw());
            }
            Err(err) => eprintln!("[neocompositor-desktop] clipboard write failed: {err}"),
        }
    }

    /// Delete a message through `chats.messages.delete` (durable wire op) and
    /// surface the toast. Mirrors the React builtin delete action.
    pub(super) fn delete_message(&mut self, row_id: String) {
        eprintln!("[neocompositor-desktop] message delete tapped: {row_id}");
        self.session.delete_message(&row_id);
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }

    /// `chats.snapshots.rollback` (React builtin): remove everything after
    /// the tapped message; the message itself stays.
    pub(super) fn rollback_message(&mut self, row_id: String) {
        eprintln!("[neocompositor-desktop] rollback tapped: {row_id}");
        self.session.rollback_to_message(&row_id);
        self.dirty = true;
        self.window.as_ref().map(|w| w.request_redraw());
    }
    /// Move: a drag beyond the slop cancels the tap (Android 16 CSS-px rule).
    pub(super) fn pointer_move(&mut self, css_x: f32, css_y: f32) {
        // Wheel events carry no position in this winit version; the panel
        // scroll router uses the last tracked cursor instead.
        self.pointer_css = (css_x, css_y);
        if let Some(drag) = self.panel_drag.as_ref() {
            let target = drag.start_width + (css_x - drag.start_x);
            // One produce = full vdom mount + Blitz layout + vello raster of
            // the whole window (~30ms warm on the reference PC). Applying the
            // raw pointer delta would re-run it per event batch; quantizing
            // the live width keeps the divider tracking without falling
            // behind, and `pointer_up` snaps to the exact target.
            const PANEL_DRAG_QUANT_CSS: f32 = 6.0;
            if (target - self.session.panel_width()).abs() >= PANEL_DRAG_QUANT_CSS {
                self.session.set_panel_width(target);
                self.dirty = true;
                self.window.as_ref().map(|w| w.request_redraw());
            }
            return;
        }
        if let Some(pending) = self.pending_ui.as_mut() {
            if (css_x - pending.css_x).abs() > TOUCH_SLOP_CSS
                || (css_y - pending.css_y).abs() > TOUCH_SLOP_CSS
            {
                self.pending_ui = None;
            }
        }
        if let Some(pending) = self.pending_message_action.as_mut() {
            if (css_x - pending.css_x).abs() > TOUCH_SLOP_CSS
                || (css_y - pending.css_y).abs() > TOUCH_SLOP_CSS
            {
                self.pending_message_action = None;
            }
        }
        if let Some((_, px, py)) = self.pending_quick.as_ref() {
            if (css_x - px).abs() > TOUCH_SLOP_CSS || (css_y - py).abs() > TOUCH_SLOP_CSS {
                self.pending_quick = None;
            }
        }
        if let Some((_, px, py)) = self.pending_custom.as_ref() {
            if (css_x - px).abs() > TOUCH_SLOP_CSS || (css_y - py).abs() > TOUCH_SLOP_CSS {
                self.pending_custom = None;
            }
        }
        if let Some(window) = self.window.as_ref() {
            let icon = if self.near_panel_resize(css_x) {
                winit::window::CursorIcon::ColResize
            } else {
                winit::window::CursorIcon::Default
            };
            // Win32 `SetCursor` per pixel of travel adds visible input lag on
            // the resize edge; only cross the boundary when it changes.
            if self.cursor_icon != Some(icon) {
                window.set_cursor(icon);
                self.cursor_icon = Some(icon);
            }
        }
        // G5 hover feedback: the topmost interactive control under the
        // pointer, from the same hit-rect snapshot the tap capture uses.
        // `set_hover_target` bumps the scene only when the target CHANGES —
        // crossing dead space or moving within one button stays free. Skipped
        // while a capture is active (press/drag/panel-resize/touch): React
        // does not hover-highlight a control mid-gesture either, and a drag
        // that crosses buttons must not repaint per slop pixel.
        let capture_active = self.panel_drag.is_some()
            || self.pending_ui.is_some()
            || self.pending_message_action.is_some()
            || self.pending_quick.is_some()
            || self.pending_custom.is_some();
        if !capture_active {
            let hover = self
                .hit_rects
                .top_action(css_x, css_y)
                .map(|(action, key)| format!("{action}:{}", key.unwrap_or("-")));
            let hover = hover.as_deref();
            if self.session.route_state().hover_target.as_deref() != hover {
                self.session.set_hover_target(hover);
                self.dirty = true;
                self.window.as_ref().map(|w| w.request_redraw());
            }
        }
        let _ = css_y;
    }

    /// Up: dispatch the layout-resolved quick action (composer controls), then
    /// inline message actions, then the captured shell hit вЂ” all within slop.
    pub(super) fn pointer_up(&mut self, css_x: f32, css_y: f32) {
        if let Some(drag) = self.panel_drag.take() {
            // Snap the exact pointer width so quantized live steps never
            // leave the panel off by up to one quantum.
            let target = drag.start_width + (css_x - drag.start_x);
            self.session.set_panel_width(target);
            self.dirty = true;
            self.window.as_ref().map(|w| w.request_redraw());
            eprintln!(
                "[neocompositor-desktop] panel width -> {}",
                self.session.panel_width()
            );
            return;
        }
        if let Some((quick, px, py)) = self.pending_quick.take() {
            if (css_x - px).abs() <= TOUCH_SLOP_CSS && (css_y - py).abs() <= TOUCH_SLOP_CSS {
                match quick {
                    QuickAction::Send => {
                        self.pending_ui = None;
                        self.send_composer();
                    }
                    QuickAction::Stop => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] composer stop tapped");
                        let _ = self.session.cancel_generation();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::ComposerSettings => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] tap -> composer Settings");
                        self.session
                            .apply_shell_action(ShellAction::SetPanel("settings".into()));
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::ComposerReset => {
                        self.pending_ui = None;
                        let _ = self.session.set_composer_text(String::new());
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::ComposerContext => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] tap -> composer context meter");
                        self.session.toggle_context_panel();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::ScrollLatest => {
                        // Saturate the virtualized window at the newest rows
                        // (offset 0 = pinned to the bottom). The jump happens
                        // outside the animation, so the visual follows the
                        // baked offset (no stale shift). Positive offsets run
                        // toward OLDER messages — the pre-clamp code sent
                        // +1e6, which landed on the oldest rows.
                        self.pending_ui = None;
                        self.session.scroll_chat_by(-1.0e6);
                        self.visual_scroll_css = self.session.scroll_offset_css();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::HeaderSearch => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] header search toggled");
                        self.session.toggle_header_search();
                        self.focus = if self.session.view().header_search_open {
                            TextFocus::HeaderSearch
                        } else {
                            TextFocus::None
                        };
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    QuickAction::BackToParentChat => {
                        self.pending_ui = None;
                        eprintln!("[neocompositor-desktop] back to parent chat tapped");
                        self.session.open_parent_chat();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                }
                return;
            }
        }
        if let Some(pending) = self.pending_message_action.take() {
            if (css_x - pending.css_x).abs() <= TOUCH_SLOP_CSS
                && (css_y - pending.css_y).abs() <= TOUCH_SLOP_CSS
            {
                match pending.kind {
                    crate::MessageActionKind::Copy => self.copy_message(pending.row_id),
                    crate::MessageActionKind::Delete => self.delete_message(pending.row_id),
                    crate::MessageActionKind::Rollback => self.rollback_message(pending.row_id),
                    crate::MessageActionKind::Regenerate => {
                        eprintln!(
                            "[neocompositor-desktop] regenerate tapped: {}",
                            pending.row_id
                        );
                        self.session.regenerate_message(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::SwipePrevious => {
                        eprintln!("[neocompositor-desktop] swipe-previous tapped");
                        self.session.swipe_variant(&pending.row_id, -1);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::SwipeNext => {
                        eprintln!("[neocompositor-desktop] swipe-next tapped");
                        self.session.swipe_variant(&pending.row_id, 1);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::SwipePicker => {
                        eprintln!(
                            "[neocompositor-desktop] swipe-picker tapped: {}",
                            pending.row_id
                        );
                        self.session.open_variant_picker(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::SwipePickerClose => {
                        eprintln!("[neocompositor-desktop] swipe-picker-close tapped");
                        self.session.close_variant_picker();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::SwipePick => {
                        eprintln!(
                            "[neocompositor-desktop] swipe-pick tapped: {}",
                            pending.row_id
                        );
                        // The open picker names the owner message; the row
                        // key carries the variant id — the React row click
                        // (`ShellAction::PickVariant` → `variants.activate`).
                        if let Some(owner) = self.session.route_state().variant_picker_for.clone() {
                            self.session.apply_shell_action(ShellAction::PickVariant(
                                owner,
                                pending.row_id.clone(),
                            ));
                        }
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::Edit => {
                        eprintln!("[neocompositor-desktop] edit tapped: {}", pending.row_id);
                        if self.session.view().details_message_id.as_deref()
                            == Some(&pending.row_id)
                        {
                            self.session.set_message_details_mode("edit");
                        } else {
                            self.session.start_message_edit(&pending.row_id);
                        }
                        self.focus = TextFocus::MessageEdit;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::EditSave => {
                        eprintln!("[neocompositor-desktop] edit save tapped");
                        self.session.submit_message_edit();
                        self.focus = TextFocus::None;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::EditCancel => {
                        eprintln!("[neocompositor-desktop] edit cancel tapped");
                        self.session.cancel_message_edit();
                        self.focus = TextFocus::None;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::History => {
                        eprintln!("[neocompositor-desktop] history tapped: {}", pending.row_id);
                        self.session.open_message_history(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::HistoryClose => {
                        eprintln!("[neocompositor-desktop] history close tapped");
                        self.session.close_message_history();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::Checkpoint => {
                        eprintln!(
                            "[neocompositor-desktop] checkpoint tapped: {}",
                            pending.row_id
                        );
                        self.session.create_message_snapshot(&pending.row_id, true);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::Branch => {
                        eprintln!("[neocompositor-desktop] branch tapped: {}", pending.row_id);
                        self.session.create_message_snapshot(&pending.row_id, false);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::SnapshotOpen => {
                        eprintln!(
                            "[neocompositor-desktop] snapshot row tapped: {}",
                            pending.row_id
                        );
                        // Session closes the menu and opens the child chat
                        // (`ShellAction::OpenSnapshot`), like the React row.
                        self.session
                            .apply_shell_action(ShellAction::OpenSnapshot(pending.row_id.clone()));
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::Context => {
                        eprintln!("[neocompositor-desktop] context tapped: {}", pending.row_id);
                        self.session.toggle_message_context(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::Prompt => {
                        eprintln!("[neocompositor-desktop] prompt tapped: {}", pending.row_id);
                        self.session.open_prompt_plan_for_message(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::Steps => {
                        eprintln!("[neocompositor-desktop] steps tapped: {}", pending.row_id);
                        self.session
                            .open_run_transcript_for_message(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::DeleteCheckpoint => {
                        eprintln!(
                            "[neocompositor-desktop] delete-checkpoint tapped: {}",
                            pending.row_id
                        );
                        self.session.open_checkpoint_delete(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::Details => {
                        eprintln!("[neocompositor-desktop] details tapped: {}", pending.row_id);
                        self.session.open_message_details(&pending.row_id);
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::DetailsClose => {
                        eprintln!("[neocompositor-desktop] details-close tapped");
                        self.session.close_message_details();
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::DetailsModeActions => {
                        eprintln!("[neocompositor-desktop] details-mode-actions tapped");
                        self.session.set_message_details_mode("actions");
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::DetailsModeDetails => {
                        eprintln!("[neocompositor-desktop] details-mode-details tapped");
                        self.session.set_message_details_mode("details");
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::DetailsModeEdit => {
                        eprintln!("[neocompositor-desktop] details-mode-edit tapped");
                        self.session.set_message_details_mode("edit");
                        self.focus = TextFocus::MessageEdit;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                    crate::MessageActionKind::DetailsSaveEdit => {
                        eprintln!("[neocompositor-desktop] details-save-edit tapped");
                        self.session.submit_message_details_edit();
                        self.focus = TextFocus::None;
                        self.dirty = true;
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                }
                return;
            }
        }
        if let Some((name, px, py)) = self.pending_custom.take() {
            self.pending_ui = None;
            if (css_x - px).abs() > TOUCH_SLOP_CSS || (css_y - py).abs() > TOUCH_SLOP_CSS {
                return;
            }
            if let Some(action) = crate::character_custom_action(&name, &self.session.shell_view())
            {
                // Reuse shell dispatch, including its host-side export sink.
                self.pending_ui = Some(PendingUi {
                    css_x: px,
                    css_y: py,
                    hit: ShellHit::Action(action),
                });
            } else {
                if name == "custom.chat.snapshots-menu" {
                    self.session.toggle_snapshots_menu();
                } else {
                    self.session.custom_intent(&name);
                }
                self.dirty = true;
                self.window.as_ref().map(|w| w.request_redraw());
                return;
            }
        }
        let Some(pending) = self.pending_ui.take() else {
            return;
        };
        if (css_x - pending.css_x).abs() > TOUCH_SLOP_CSS
            || (css_y - pending.css_y).abs() > TOUCH_SLOP_CSS
        {
            return;
        }
        if let ShellHit::Action(action) = pending.hit {
            eprintln!("[neocompositor-desktop] tap -> {action:?}");
            self.session.apply_shell_action(action);
            // Host-side file sink for parked exports (`chats.export`,
            // `characters.export.card`, prompt-template JSON). React
            // downloads to the browser; the desktop host writes under
            // exports/, overridable via NEOTA_EXPORT_DIR.
            if let Some(export) = self.session.take_last_export() {
                match write_export_file(&export) {
                    Ok(path) => {
                        eprintln!("[neocompositor-desktop] export written: {path}");
                        self.session.note_export_path(&path);
                    }
                    Err(err) => {
                        eprintln!("[neocompositor-desktop] export write failed: {err}");
                    }
                }
                self.dirty = true;
            }
            self.dirty = true;
            self.window.as_ref().map(|w| w.request_redraw());
        }
    }
    /// Touch input: tap-through when a control captured the contact, drag
    /// scroll over the chat canvas (1 : 1 while dragging), fling on release.
    /// Single pointer; the digitizer's synthesized mouse events for the same
    /// contact are ignored while it is active.
    pub(super) fn touch_input(
        &mut self,
        pointer_id: u64,
        phase: winit::event::TouchPhase,
        css_x: f32,
        css_y: f32,
    ) {
        use winit::event::TouchPhase;
        match phase {
            TouchPhase::Started => {
                if self.touch.is_some() {
                    return;
                }
                let now = self.monotonic_ns();
                // Route the contact through the same `Down` capture as a
                // mouse press (controls, slop rules) so taps stay identical.
                self.pointer_down(css_x, css_y);
                let captured = self.pending_ui.is_some()
                    || self.pending_message_action.is_some()
                    || self.pending_quick.is_some()
                    || self.pending_custom.is_some()
                    || self.panel_drag.is_some();
                self.touch = Some(TouchContact {
                    pointer_id,
                    anchor_y: css_y,
                    last_y: css_y,
                    last_t_ns: now,
                    velocity: 0.0,
                    dragging: false,
                    captured,
                });
                if !captured {
                    // Canvas contact: drag-scroll candidate. Cancel any live
                    // smooth scroll so the finger takes over 1 : 1.
                    self.smooth_scroll = None;
                    self.glide_velocity = 0.0;
                }
            }
            TouchPhase::Moved => {
                if self
                    .touch
                    .as_ref()
                    .is_some_and(|contact| contact.pointer_id == pointer_id)
                {
                    self.pointer_move(css_x, css_y);
                }
                let now = self.monotonic_ns();
                if let Some(contact) = self.touch.as_mut() {
                    if contact.pointer_id != pointer_id {
                        return;
                    }
                    if contact.captured {
                        // pointer_move already applied cancellation beyond slop.
                        return;
                    }
                    if !contact.dragging {
                        if (css_y - contact.anchor_y).abs() > TOUCH_SLOP_CSS {
                            contact.dragging = true;
                        } else {
                            return;
                        }
                    }
                    let dt_ns = now.saturating_sub(contact.last_t_ns).max(1);
                    let dy = contact.last_y - css_y;
                    contact.velocity = f64::from(dy) / (dt_ns as f64 / 1e9);
                    contact.last_y = css_y;
                    contact.last_t_ns = now;
                    // The drag moves the visual directly: the frozen raster +
                    // blit shift present it 1:1 at the vsync cadence (the
                    // overscan runway shows real rows on the leading edge),
                    // and the frame loop lands the session when the ack drift
                    // crosses the baked runway cap.
                    self.visual_scroll_css =
                        (self.visual_scroll_css + dy).clamp(0.0, self.scroll_max_css);
                    self.window.as_ref().map(|w| w.request_redraw());
                }
            }
            TouchPhase::Ended => {
                if let Some(contact) = self.touch.take() {
                    if contact.pointer_id != pointer_id {
                        self.touch = Some(contact);
                        return;
                    }
                    if contact.captured || !contact.dragging {
                        // Tap (or a captured contact whose slop check runs
                        // inside `pointer_up`): the same dispatch as a mouse
                        // click.
                        self.pointer_up(css_x, css_y);
                    } else {
                        // Release starts the shared glide decay (Android
                        // fling constants); slow drags land immediately. The
                        // visual already carries every drag pixel (the drag
                        // moves it directly), so a fling integrates from the
                        // true position and a plain landing loses nothing.
                        if crate::scroll_dynamics::glide_active(contact.velocity) {
                            self.glide_velocity = contact.velocity;
                        } else {
                            self.land_now();
                        }
                        self.window.as_ref().map(|w| w.request_redraw());
                    }
                }
            }
            TouchPhase::Cancelled => {
                if !self
                    .touch
                    .as_ref()
                    .is_some_and(|contact| contact.pointer_id == pointer_id)
                {
                    return;
                }
                self.touch = None;
                self.pending_ui = None;
                self.pending_quick = None;
                self.pending_message_action = None;
                self.pending_custom = None;
                self.panel_drag = None;
                self.glide_velocity = 0.0;
                // The gesture died mid-flight: keep what the screen shows by
                // landing the visual into the session.
                self.land_now();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hit_rects::HitRect;
    use winit::event::TouchPhase;

    fn custom_button(name: &str) -> App {
        let mut app = App::new(1, None, None).expect("fake-wire app");
        app.size = (1100, 760);
        app.ensure_viewport();
        // Deliberately overlap a geometric rail target. The authored button
        // must own the click exclusively, regardless of that fallback hit.
        app.hit_rects.rects.push(HitRect {
            identity: format!("action:{name}"),
            action: Some(name.into()),
            key: None,
            x: 10.0,
            y: 90.0,
            w: 40.0,
            h: 40.0,
        });
        app.dirty = false;
        app
    }

    #[test]
    fn custom_click_waits_for_release_dispatches_once_and_marks_dirty() {
        let mut app = custom_button("custom.chat.snapshots-menu");
        let panel = app.session.shell_view().panel;
        app.pointer_down(30.0, 110.0);
        assert!(!app.session.view().snapshots_menu_open);
        assert!(!app.dirty);
        assert!(app.pending_ui.is_none());
        assert!(app.pending_custom.is_some());
        app.pointer_up(30.0, 110.0);
        assert!(app.session.view().snapshots_menu_open);
        assert!(app.dirty);
        assert_eq!(app.session.shell_view().panel, panel);
        app.dirty = false;
        app.pointer_up(30.0, 110.0);
        assert!(app.session.view().snapshots_menu_open);
        assert!(!app.dirty);
    }

    #[test]
    fn custom_click_stays_cancelled_after_drag_returns_to_origin() {
        let mut app = custom_button("custom.chat.snapshots-menu");
        app.pointer_down(30.0, 110.0);
        app.pointer_move(30.0, 110.0 + TOUCH_SLOP_CSS + 1.0);
        // The slop-cancel dropped the capture, so moving BACK over the
        // button is a plain hover (G5): the button highlights, one frame.
        app.pointer_move(30.0, 110.0);
        assert!(!app.session.view().snapshots_menu_open);
        assert!(app.dirty);
        assert_eq!(
            app.session.view().hover_target.as_deref(),
            Some("custom.chat.snapshots-menu:-")
        );
        assert!(app.pending_custom.is_none());
        app.dirty = false;
        app.pointer_up(30.0, 110.0);
        assert!(!app.session.view().snapshots_menu_open);
        assert!(!app.dirty);
        app.pointer_down(30.0, 110.0);
        app.pointer_up(30.0, 110.0 + TOUCH_SLOP_CSS + 1.0);
        assert!(!app.session.view().snapshots_menu_open);
        assert!(!app.dirty);
    }

    #[test]
    fn unregistered_custom_intent_requests_a_fresh_frame() {
        let mut app = custom_button("custom.test.notice");
        let epoch = app.session.scene_epoch();
        app.pointer_down(30.0, 110.0);
        assert_eq!(app.session.scene_epoch(), epoch);
        app.pointer_up(30.0, 110.0);
        assert!(app.session.scene_epoch() > epoch);
        assert!(app.dirty);
    }

    #[test]
    fn snapshot_row_tap_opens_the_child_chat_route_after_release() {
        let mut app = custom_button("custom.chat.snapshots-menu");
        app.pointer_down(30.0, 110.0);
        app.pointer_up(30.0, 110.0);
        assert!(app.session.view().snapshots_menu_open);
        // The row as the open panel paints it: identity carries the child
        // chat id, the action routes through the shared decision table.
        app.hit_rects.rects.push(HitRect {
            identity: "part:snapshot-row-chat-child-2".into(),
            action: Some("open-snapshot".into()),
            key: Some("chat-child-2".into()),
            x: 280.0,
            y: 90.0,
            w: 320.0,
            h: 44.0,
        });
        // Inside the row: the outside-close must NOT fire at Down...
        app.pointer_down(300.0, 100.0);
        assert!(app.session.view().snapshots_menu_open);
        // ...and the row dispatch closes it at Up (session `open_snapshot`).
        app.pointer_up(300.0, 100.0);
        assert!(!app.session.view().snapshots_menu_open);
    }

    #[test]
    fn tap_outside_the_snapshots_panel_closes_it_at_press() {
        let mut app = custom_button("custom.chat.snapshots-menu");
        app.pointer_down(30.0, 110.0);
        app.pointer_up(30.0, 110.0);
        assert!(app.session.view().snapshots_menu_open);
        // The panel root as the open panel paints it: non-interactive, but
        // its identity participates in the outside-press needle.
        app.hit_rects.rects.push(HitRect {
            identity: "part:snapshots-panel".into(),
            action: None,
            key: None,
            x: 280.0,
            y: 70.0,
            w: 320.0,
            h: 200.0,
        });
        // A press inside the panel host keeps the menu open, like React
        // (only presses OUTSIDE the host close it).
        app.pointer_down(400.0, 150.0);
        assert!(app.session.view().snapshots_menu_open);
        app.pointer_up(400.0, 150.0);
        assert!(app.session.view().snapshots_menu_open);
        // Dead space: the press itself closes (document pointerdown).
        app.pointer_down(700.0, 500.0);
        assert!(!app.session.view().snapshots_menu_open);
        app.pointer_up(700.0, 500.0);
    }

    #[test]
    fn hover_target_updates_only_on_change_and_reaches_the_view() {
        let mut app = custom_button("custom.chat.snapshots-menu");
        // Inside the authored button rect (10..50 x 90..130).
        app.dirty = false;
        app.pointer_move(30.0, 110.0);
        assert_eq!(
            app.session.view().hover_target.as_deref(),
            Some("custom.chat.snapshots-menu:-")
        );
        assert!(app.dirty, "a hover CHANGE must request a frame");
        // Moving within the same control: no extra bump, no extra produce.
        app.dirty = false;
        app.pointer_move(32.0, 112.0);
        assert!(!app.dirty, "same-target moves must stay free");
        // Leaving to dead space clears the target and requests one frame.
        app.pointer_move(400.0, 400.0);
        assert_eq!(app.session.view().hover_target, None);
        assert!(app.dirty);
    }

    #[test]
    fn focus_tap_publishes_the_focused_part_identity() {
        let mut app = custom_button("custom.chat.snapshots-menu");
        // Synthesize the composer field rect at (100..600, 600..660).
        app.hit_rects.rects.push(HitRect {
            identity: "slot:chat.composer".into(),
            action: None,
            key: None,
            x: 100.0,
            y: 600.0,
            w: 500.0,
            h: 60.0,
        });
        app.pointer_down(300.0, 630.0);
        assert_eq!(app.focus, TextFocus::Composer);
        assert_eq!(
            app.session.view().focused_part.as_deref(),
            Some("slot:chat.composer")
        );
        // Re-tapping the same field stays free (no bump).
        let epoch = app.session.scene_epoch();
        app.pointer_down(300.0, 630.0);
        assert_eq!(app.session.scene_epoch(), epoch);
    }

    #[test]
    fn session_mutation_becomes_visible_through_epoch_observation() {
        let mut app = custom_button("custom.chat.snapshots-menu");
        app.dirty = false;
        let epoch = app.session.scene_epoch();
        // A session mutation with zero App.dirty bookkeeping anywhere...
        app.session.scroll_chat_by(10.0);
        assert!(!app.dirty);
        // ...is picked up by the host's epoch observation, exactly once.
        assert!(app.observe_scene_epoch());
        assert!(app.dirty);
        assert_eq!(app.session.scene_epoch(), epoch + 1);
        assert!(!app.observe_scene_epoch());
    }

    #[test]
    fn scale_change_forces_cold_reproduce_at_new_density() {
        let mut app = custom_button("custom.chat.snapshots-menu");
        app.dirty = false;
        app.apply_scale_change(1.0);
        assert!(!app.dirty);
        app.apply_scale_change(1.5);
        assert_eq!(app.density, 1.5);
        assert!(app.dirty);
        assert!(app.vello_session.is_none());
        assert!(app.wallpaper_cache.is_none());
    }

    #[test]
    fn touch_custom_capture_honors_slop_and_contact_cancellation() {
        let mut app = custom_button("custom.chat.snapshots-menu");
        app.touch_input(1, TouchPhase::Started, 30.0, 110.0);
        assert!(app.touch.as_ref().is_some_and(|contact| contact.captured));
        app.touch_input(2, TouchPhase::Cancelled, 30.0, 110.0);
        assert!(app.pending_custom.is_some());
        app.touch_input(1, TouchPhase::Moved, 30.0, 110.0 + TOUCH_SLOP_CSS + 1.0);
        app.touch_input(1, TouchPhase::Ended, 30.0, 110.0);
        assert!(!app.session.view().snapshots_menu_open);
        app.touch_input(1, TouchPhase::Started, 30.0, 110.0);
        app.touch_input(1, TouchPhase::Cancelled, 30.0, 110.0);
        assert!(app.pending_custom.is_none());
        assert!(app.pending_ui.is_none());
        app.pointer_up(30.0, 110.0);
        assert!(!app.session.view().snapshots_menu_open);
    }
}
