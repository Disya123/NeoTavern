//! Layout-derived hit rectangles for the native hosts.
//!
//! Replaces hand-measured pixel bands ("anchors taken from the rendered
//! pixels"): every interactive target is read back from the Blitz/Taffy layout
//! through the same [`SlotSkeleton`] that feeds the DOM-parity dumps, keyed by
//! Theme SDK hooks (`data-action`, `data-part`, …) exactly like the React
//! oracle. Geometry exists in ONE place — the layout tree — so moving a button
//! in RSX can never desync its input zone.

use neotavern_presentation_m0_d2::SlotSkeleton;

/// One tappable/hittable node rect in window CSS px.
#[derive(Clone, Debug, PartialEq)]
pub struct HitRect {
    /// Composite Theme SDK identity (`slot:X+component:Y+part:Z+action:A`),
    /// identical to the DOM-parity dump format.
    pub identity: String,
    /// `data-action` when present (`send`, `copy`, `composer-settings`, …).
    pub action: Option<String>,
    /// `data-ui-key` || `data-message-id` — stable owner id (message rows).
    pub key: Option<String>,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl HitRect {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

/// Snapshot of hooked layout rects for one produced frame.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HitRects {
    pub width: u32,
    pub height: u32,
    pub rects: Vec<HitRect>,
}

impl HitRects {
    /// Collect every node that carries any Theme SDK hook. Broad on purpose:
    /// region lookups are string-scoped, and 300–400 cheap rects per frame are
    /// negligible next to the vello raster.
    ///
    /// Nodes inherit the nearest ancestor's `data-ui-key` / `data-message-id`
    /// (`effective_key`): version-control buttons live inside a message row
    /// but carry no key of their own, exactly like the React oracle. Skeleton
    /// nodes arrive in DFS pre-order and encode ancestry in `path`
    /// (`identity > identity`), so the owner lookup is a prefix-chain scan.
    pub fn from_skeleton(skel: &SlotSkeleton) -> Self {
        // Path -> own key for every element seen so far (parents first).
        let mut keys: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
        let rects = skel
            .nodes
            .iter()
            .map(|node| {
                let mut effective_key = node.key.as_deref();
                if effective_key.is_none() {
                    // Nearest ancestor with a key owns this node: walk the
                    // ancestor prefixes longest-first
                    // (`identity > identity > …`).
                    let path = node.path.as_str();
                    let mut end = path.len();
                    while let Some(i) = path[..end].rfind(" > ") {
                        end = i;
                        if let Some(key) = keys.get(&path[..end]) {
                            effective_key = Some(key);
                            break;
                        }
                    }
                }
                if let Some(key) = node.key.as_deref() {
                    keys.insert(node.path.as_str(), key);
                }
                HitRect {
                    identity: node.identity.clone(),
                    action: node.action.clone(),
                    key: effective_key.map(str::to_owned),
                    x: node.css_x,
                    y: node.css_y,
                    w: node.css_width,
                    h: node.css_height,
                }
            })
            .collect();
        Self {
            width: skel.width,
            height: skel.height,
            rects,
        }
    }

    /// Last rect (paint order = document order tail) containing the point.
    pub fn top_at(&self, x: f32, y: f32) -> Option<&HitRect> {
        self.rects.iter().rev().find(|rect| rect.contains(x, y))
    }

    /// Topmost `data-action` at the point, with its owner key if present.
    pub fn top_action(&self, x: f32, y: f32) -> Option<(&str, Option<&str>)> {
        self.rects
            .iter()
            .rev()
            .find(|rect| rect.action.is_some() && rect.contains(x, y))
            .map(|rect| (rect.action.as_deref().unwrap_or(""), rect.key.as_deref()))
    }

    /// True when ANY rect whose identity contains `needle` covers the point.
    pub fn covers(&self, x: f32, y: f32, needle: &str) -> bool {
        self.rects
            .iter()
            .any(|rect| rect.identity.contains(needle) && rect.contains(x, y))
    }

    /// Topmost rect containing `(x, y)` whose identity contains `needle`.
    pub fn top_matching(&self, x: f32, y: f32, needle: &str) -> Option<&HitRect> {
        self.rects
            .iter()
            .rev()
            .find(|rect| rect.identity.contains(needle) && rect.contains(x, y))
    }
}

/// Shared press-slop (CSS px): a move beyond this cancels the tap. Mirrors the
/// Android `try_push` threshold; desktop wheel/tap pipeline uses the same.
pub const TOUCH_SLOP_CSS: f32 = 16.0;

/// Composer/viewport quick intents every host can execute against
/// `ChatSession`. `ComposerSettings` maps onto the existing
/// `ShellAction::SetPanel("settings")`; the rest are direct session calls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuickIntent {
    Send,
    Stop,
    ComposerSettings,
    ComposerReset,
    ComposerContext,
    ScrollLatest,
    /// Chat-header message search (React `ChatHeader` magnifying-glass).
    HeaderSearch,
}

/// Per-row message operations shared by both hosts. The kind names the
/// documented `data-action` string; execution lands host-side (clipboard,
/// session, kernel bridge) and may be an honest not-wired-yet log until its
/// feature slice lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageActionKind {
    Context,
    Edit,
    Copy,
    Checkpoint,
    Branch,
    Delete,
    Rollback,
    History,
    Regenerate,
    SwipePrevious,
    SwipeNext,
    /// Open/toggle the variant picker popover (`data-action="swipe-picker"`).
    SwipePicker,
    /// Close button inside the picker popover
    /// (`data-action="swipe-picker-close"`); carries the owner row.
    SwipePickerClose,
    /// Save button of the inline editor (`data-action="message-edit-save"`).
    EditSave,
    /// Cancel button of the inline editor
    /// (`data-action="message-edit-cancel"`).
    EditCancel,
    /// Close button of the revision-history card
    /// (`data-action="message-history-close"`).
    HistoryClose,
    /// View the durable prompt plan (`data-action="prompt"`).
    Prompt,
    /// View the run-step transcript (`data-action="steps"`).
    Steps,
    /// Remove the checkpoint link (`data-action="delete-checkpoint"`).
    DeleteCheckpoint,
}

impl MessageActionKind {
    fn from_action(action: &str) -> Option<Self> {
        Some(match action {
            "context" => Self::Context,
            "edit" => Self::Edit,
            "copy" => Self::Copy,
            "checkpoint" => Self::Checkpoint,
            "branch" => Self::Branch,
            "delete" => Self::Delete,
            "rollback" => Self::Rollback,
            "history" => Self::History,
            "regenerate" => Self::Regenerate,
            "swipe-previous" => Self::SwipePrevious,
            "swipe-next" => Self::SwipeNext,
            "swipe-picker" => Self::SwipePicker,
            "swipe-picker-close" => Self::SwipePickerClose,
            "message-edit-save" => Self::EditSave,
            "message-edit-cancel" => Self::EditCancel,
            "message-history-close" => Self::HistoryClose,
            "prompt" => Self::Prompt,
            "steps" => Self::Steps,
            "delete-checkpoint" => Self::DeleteCheckpoint,
            _ => return None,
        })
    }
}

/// Everything the layout snapshot decides about one tap point. Hosts share
/// this decision table so desktop and Android stay behaviorally identical;
/// platform differences start only at execution (clipboard, IME, redraw).
#[derive(Clone, Debug, PartialEq)]
pub enum TapIntent {
    Quick(QuickIntent),
    /// A per-row control: kind + owning row via `effective_key`
    /// (own `data-message-id`, or the nearest keyed ancestor — version
    /// controls inherit their row).
    MessageAction {
        kind: MessageActionKind,
        row_id: String,
    },
    /// No hooked control under the point — hosts fall back to their own
    /// shell hit-test, text focus and scroll tracking.
    None,
    /// A declarative `custom.<owner>.<name>` intent authored in a document.
    /// Carries no Product Wire authority; hosts resolve it through their own
    /// registry and default to an observable no-op trace.
    Custom {
        name: String,
    },
}

impl HitRects {
    /// Resolve a tap against layout rects. Topmost (paint-order tail)
    /// `data-action` wins; message actions without an owner key are ignored
    /// so un-keyed controls can never act as message operations.
    pub fn resolve_tap(&self, x: f32, y: f32) -> TapIntent {
        let Some((action, key)) = self.top_action(x, y) else {
            return TapIntent::None;
        };
        match (action, key) {
            ("send", _) => TapIntent::Quick(QuickIntent::Send),
            ("stop", _) => TapIntent::Quick(QuickIntent::Stop),
            ("composer-settings", _) => TapIntent::Quick(QuickIntent::ComposerSettings),
            ("composer-context", _) => TapIntent::Quick(QuickIntent::ComposerContext),
            ("composer-reset", _) => TapIntent::Quick(QuickIntent::ComposerReset),
            ("scroll-latest", _) => TapIntent::Quick(QuickIntent::ScrollLatest),
            ("header-search", _) => TapIntent::Quick(QuickIntent::HeaderSearch),
            // Declarative custom intents route by their authored name before
            // the builtin kind table — they never masquerade as row actions.
            (action, _) if action.starts_with("custom.") => TapIntent::Custom {
                name: action.to_string(),
            },
            (_, Some(row_id)) => match MessageActionKind::from_action(action) {
                Some(kind) => TapIntent::MessageAction {
                    kind,
                    row_id: row_id.to_string(),
                },
                None => TapIntent::None,
            },
            _ => TapIntent::None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neotavern_presentation_m0_d2::SlotNode;

    fn node(identity: &str, x: f32, y: f32, w: f32, h: f32) -> SlotNode {
        SlotNode {
            tag: "div".into(),
            component: None,
            part: None,
            slot: None,
            role: None,
            action: None,
            state: None,
            key: None,
            identity: identity.into(),
            path: String::new(),
            css_x: x,
            css_y: y,
            css_width: w,
            css_height: h,
        }
    }

    #[test]
    fn top_at_prefers_the_last_containing_rect() {
        let mut bg = node("component:chat-view", 0.0, 0.0, 100.0, 100.0);
        bg.action = Some("background".into());
        let mut btn = node("action:send", 40.0, 40.0, 20.0, 20.0);
        btn.action = Some("send".into());
        btn.key = Some("msg-9".into());
        let skel = SlotSkeleton {
            source: "native".into(),
            width: 100,
            height: 100,
            nodes: vec![bg, btn],
        };
        let rects = HitRects::from_skeleton(&skel);
        let top = rects.top_at(50.0, 50.0).expect("hit");
        assert_eq!(top.action.as_deref(), Some("send"));
        assert_eq!(top.key.as_deref(), Some("msg-9"));
        assert_eq!(
            rects.top_action(10.0, 10.0).map(|(a, _)| a),
            Some("background")
        );
        assert!(rects.covers(50.0, 50.0, "chat-view"));
        assert!(!rects.covers(50.0, 50.0, "chat.header"));
    }

    #[test]
    fn resolve_tap_maps_the_shared_decision_table() {
        let mut send = node("action:send", 900.0, 700.0, 86.0, 36.0);
        send.action = Some("send".into());
        let mut copy = node("action:copy", 600.0, 300.0, 32.0, 32.0);
        copy.action = Some("copy".into());
        copy.key = Some("00000000-0000-4000-8000-000000000003".into());
        // Un-keyed message action: must never act as a message operation.
        let mut ghost = node("action:delete", 700.0, 300.0, 32.0, 32.0);
        ghost.action = Some("delete".into());
        let mut settings = node("action:composer-settings", 480.0, 580.0, 96.0, 32.0);
        settings.action = Some("composer-settings".into());
        let skel = SlotSkeleton {
            source: "native".into(),
            width: 1100,
            height: 760,
            nodes: vec![settings, ghost, copy, send],
        };
        let rects = HitRects::from_skeleton(&skel);

        assert_eq!(
            rects.resolve_tap(940.0, 715.0),
            TapIntent::Quick(QuickIntent::Send)
        );
        assert_eq!(
            rects.resolve_tap(610.0, 310.0),
            TapIntent::MessageAction {
                kind: MessageActionKind::Copy,
                row_id: "00000000-0000-4000-8000-000000000003".into()
            }
        );
        // Un-keyed delete falls through to None.
        assert_eq!(rects.resolve_tap(710.0, 310.0), TapIntent::None);
        assert_eq!(
            rects.resolve_tap(500.0, 590.0),
            TapIntent::Quick(QuickIntent::ComposerSettings)
        );
        // Empty point.
        assert_eq!(rects.resolve_tap(5.0, 5.0), TapIntent::None);
    }

    #[test]
    fn version_controls_inherit_the_row_key_from_layout_ancestry() {
        // Version-control buttons carry no `data-message-id` of their own —
        // they must resolve to the owning row via the skeleton's ancestor
        // chain, or taps on them would be dropped.
        let mut row = node(
            "component:chat-message+key:row-uuid",
            0.0,
            200.0,
            600.0,
            220.0,
        );
        row.component = Some("chat-message".into());
        row.key = Some("row-uuid".into());
        row.path = "slot:chat.viewport > component:chat-message".into();
        let mut history = node("action:history", 20.0, 380.0, 32.0, 32.0);
        history.action = Some("history".into());
        history.path =
            "slot:chat.viewport > component:chat-message > part:message-version-actions".into();
        let mut ghost_history = node("action:history", 60.0, 380.0, 32.0, 32.0);
        ghost_history.action = Some("history".into());
        let skel = SlotSkeleton {
            source: "native".into(),
            width: 1100,
            height: 760,
            nodes: vec![row, history, ghost_history],
        };
        let rects = HitRects::from_skeleton(&skel);

        assert_eq!(
            rects.resolve_tap(30.0, 390.0),
            TapIntent::MessageAction {
                kind: MessageActionKind::History,
                row_id: "row-uuid".into()
            }
        );
        // Same control without a keyed ancestor must never act as a message
        // operation.
        assert_eq!(rects.resolve_tap(70.0, 390.0), TapIntent::None);
    }

    #[test]
    fn custom_intents_route_by_their_authored_name() {
        let mut pinned = node("action:custom.demo.pin-chat", 10.0, 10.0, 40.0, 24.0);
        pinned.action = Some("custom.demo.pin-chat".into());
        let skel = SlotSkeleton {
            source: "native".into(),
            width: 100,
            height: 100,
            nodes: vec![pinned],
        };
        let rects = HitRects::from_skeleton(&skel);
        assert_eq!(
            rects.resolve_tap(20.0, 20.0),
            TapIntent::Custom {
                name: "custom.demo.pin-chat".into()
            }
        );
        // Outside the control: plain None.
        assert_eq!(rects.resolve_tap(80.0, 80.0), TapIntent::None);
    }
}
