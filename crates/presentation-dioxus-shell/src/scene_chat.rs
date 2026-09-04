//! Blueprint-driven chat chrome renderer (M2 phase 2).
//!
//! Renders the header, message viewport and composer from a materialized
//! [`UiSceneV1`] instead of the hand-written RSX in `lib.rs`, proving the M2
//! promise: structure is data. The scene comes from the canonical
//! `ui-blueprint-document-chat-v1.json` (or any document supplied through
//! `NEOTA_CHAT_BLUEPRINT_DOC`), so editing the JSON — adding, removing or
//! moving controls — changes the live UI without recompiling this crate.
//!
//! Presentation details (classes, inline styles, icons) stay keyed by the
//! stable document node ids below; they migrate into packed CSS and theme
//! tokens over time. The parity test
//! (`tests/../presentation-chat/tests/compositor_host.rs::
//! blueprint_chrome_skeleton_matches_legacy_rsx`) fails if this walker ever
//! drifts from the legacy RSX.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::SystemTime;

use contracts_generated::generated::{FreeObject, MessageDto, MessageRole};
use dioxus_core::Element;
use dioxus_core_macro::rsx;
use neotavern_presentation_blueprint::v1::{ContextUsageSummaryV1, UiNodeV1, UiSceneV1};
use neotavern_presentation_blueprint::{
    materialize_chat_scene_v1_from_document, ChatSurfaceStateV1, UiActionV1, UiBlueprintDocumentV1,
    ViewportClassV1,
};

use crate::product_path::{ProductChatView, ProductChrome};

/// Where the chat blueprint document is loaded from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatBlueprintSource {
    /// Legacy hand-written RSX only (default).
    Disabled,
    /// The fixture compiled into the workspace
    /// (`packages/contracts/src/presentation/fixtures/`).
    Embedded,
    /// A runtime document path; reloaded when its mtime changes.
    Path(PathBuf),
}

impl ChatBlueprintSource {
    /// Reads `NEOTA_CHAT_BLUEPRINT_DOC`; an empty or unset variable keeps the
    /// blueprint mode off.
    pub fn from_env() -> Self {
        match std::env::var("NEOTA_CHAT_BLUEPRINT_DOC") {
            Ok(path) if !path.is_empty() => Self::Path(PathBuf::from(path)),
            _ => Self::Disabled,
        }
    }
}

thread_local! {
    static BLUEPRINT_SOURCE: RefCell<ChatBlueprintSource> =
        const { RefCell::new(ChatBlueprintSource::Disabled) };

    static CACHED_DOCUMENT: RefCell<Option<DocumentCacheEntry>> = const { RefCell::new(None) };

    /// Wallpaper mode: the shell base turns transparent so the host-composited
    /// photo (destination-over under the scene) shows through the glass
    /// panels, exactly like React's fixed wallpaper child over an opaque
    /// shell. Off by default: the packed `.AppShell_shell` canvas keeps the
    /// scene opaque.
    static WALLPAPER_MODE: RefCell<bool> = const { RefCell::new(false) };
}

struct DocumentCacheEntry {
    /// `None` marks the embedded fixture, which never changes for a process.
    mtime: Option<SystemTime>,
    document: Result<UiBlueprintDocumentV1, String>,
    /// Last rejection already reported on stderr — a per-frame fallback must
    /// not repeat it (the document is re-read whenever its mtime changes).
    notified_error: Option<String>,
}

/// Switches the blueprint source for this thread's render tree. The desktop
/// host calls this once before mounting; tests switch it under a lock.
pub fn set_chat_blueprint_source(source: ChatBlueprintSource) {
    CACHED_DOCUMENT.with(|cell| *cell.borrow_mut() = None);
    BLUEPRINT_SOURCE.with(|cell| *cell.borrow_mut() = source);
}

/// Enables/disables wallpaper mode for this thread's render tree. The desktop
/// host calls this once when `--wallpaper` is loaded.
pub fn set_chat_wallpaper_mode(enabled: bool) {
    WALLPAPER_MODE.with(|cell| *cell.borrow_mut() = enabled);
}

pub fn chat_wallpaper_mode() -> bool {
    WALLPAPER_MODE.with(|cell| *cell.borrow())
}

fn current_source() -> ChatBlueprintSource {
    BLUEPRINT_SOURCE.with(|cell| cell.borrow().clone())
}

/// Materializes the chat scene from the active document source. Returns
/// `Err` when the mode is disabled or the document failed to load — the
/// caller falls back to the legacy RSX so a bad file can never take the chat
/// down. The parsed document is cached and re-read only when a path-backed
/// file's mtime changes.
fn materialize_scene(state: &ChatSurfaceStateV1) -> Result<UiSceneV1, String> {
    const EMBEDDED: &str = include_str!(
        "../../../packages/contracts/src/presentation/fixtures/ui-blueprint-document-chat-v1.json"
    );
    let source = current_source();
    if source == ChatBlueprintSource::Disabled {
        return Err("chat blueprint disabled".to_owned());
    }
    CACHED_DOCUMENT.with(|cell| {
        let mut cell = cell.borrow_mut();
        let fresh_mtime = match &source {
            ChatBlueprintSource::Disabled | ChatBlueprintSource::Embedded => None,
            ChatBlueprintSource::Path(path) => std::fs::metadata(path)
                .ok()
                .and_then(|meta| meta.modified().ok()),
        };
        let cached_valid = cell
            .as_ref()
            .map(|entry| entry.mtime == fresh_mtime && entry.document.is_ok())
            .unwrap_or(false);
        if !cached_valid {
            let parsed = match &source {
                ChatBlueprintSource::Path(path) => std::fs::read_to_string(path)
                    .map_err(|err| format!("NEOTA_CHAT_BLUEPRINT_DOC read failed: {err}"))
                    .and_then(|raw| {
                        serde_json::from_str(&raw)
                            .map_err(|err| format!("blueprint document parse failed: {err}"))
                    }),
                _ => serde_json::from_str(EMBEDDED)
                    .map_err(|err| format!("embedded blueprint parse failed: {err}")),
            };
            // Surface authoring mistakes when they first appear (or change) —
            // a per-frame fallback must not repeat the same line forever.
            let previous_error = cell
                .as_ref()
                .as_ref()
                .and_then(|entry| entry.notified_error.clone());
            let notified_error = match &parsed {
                Err(error) => {
                    if previous_error.as_deref() != Some(error.as_str()) {
                        eprintln!("[neocompositor] {error}");
                    }
                    Some(error.clone())
                }
                Ok(_) => None,
            };
            *cell = Some(DocumentCacheEntry {
                mtime: fresh_mtime,
                document: parsed,
                notified_error,
            });
        }
        let entry = cell.as_ref().expect("cache refreshed above");
        let document = match &entry.document {
            Ok(document) => document,
            // A rejected document never takes the chat down; the caller
            // falls back to the legacy RSX chrome.
            Err(error) => return Err(error.clone()),
        };
        materialize_chat_scene_v1_from_document(document, state, ViewportClassV1::Expanded)
    })
}

fn find_node<'a>(node: &'a UiNodeV1, id: &str) -> Option<&'a UiNodeV1> {
    if node.id == id {
        return Some(node);
    }
    node.children.iter().find_map(|child| find_node(child, id))
}

/// Per-frame dynamic values the walker needs beyond the scene nodes.
struct ChromeCtx {
    header_style: String,
    viewport_style: String,
    scroll_style: String,
    composer_style: String,
    composer_color: String,
    composer_label: String,
    header_title: String,
    avatar_asset: String,
    assistant_author: String,
    streaming: bool,
    compact: bool,
    font_px: u32,
    /// Composer context-meter popover visibility + the local estimate it
    /// renders (React `ChatComposer` `contextPanel` slot).
    context_panel_open: bool,
    context_summary: Option<ContextUsageSummaryV1>,
    /// Waiting `tool_call` name (React `ToolActivityBadge`). `None` hides
    /// the badge. Arguments/results never travel here.
    tool_activity_name: Option<String>,
    /// Hydrated swipe counters by row id (`VisibleRow.swipe_label` from the
    /// session view): the blueprint `swipe-label` node renders the same
    /// "N/M" string the legacy pager does.
    swipe_labels: HashMap<String, String>,
}

/// One values scoped to one instantiated message row.
struct RowView<'a> {
    uuid: &'a str,
    message: &'a MessageDto,
    user: bool,
    author: &'a str,
    streaming_state: bool,
    /// Pre-formatted swipe counter (React `MessageSwipePager` "N/M"); empty
    /// hides the label, exactly like the legacy path.
    swipe_label: &'a str,
}

/// Pre-rendered chat chrome fragments for one frame. `Element` clones are
/// cheap (shared VNode).
pub struct ChromeElements {
    pub header: Element,
    pub viewport: Element,
    pub composer: Element,
}

/// One-time notice when an active blueprint source meets a chrome variant the
/// document does not cover yet (compact height, overlay/nested glass). The
/// frame still renders via legacy RSX — this only keeps the fallback honest
/// instead of silent.
fn warn_uncovered_variant(reason: &str) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        eprintln!(
            "[neocompositor] blueprint chrome not covering {reason} variant yet — legacy RSX renders this mode (ADR-0056)"
        );
    });
}

/// Renders the whole inner chat chrome (header / viewport / composer) from
/// the blueprint scene. Returns `None` whenever the mode is off or the chrome
/// variant is not covered by the document yet (compact height, nested dialog,
/// overlay glass) — the caller then renders the legacy RSX unchanged.
pub fn blueprint_chrome(view: &ProductChatView) -> Option<ChromeElements> {
    // Compact height is DOCUMENT-COVERED (ADR-0056 stage 2): the renderer
    // mirrors the legacy compact composer/bubble presentation below.
    // Overlay/nested stay guarded — they are M0 perf-probe glass scenarios,
    // never product UI (`ChatSession::shell_view` pins `HeaderComposer`).
    let compact = view.viewport_height <= 240;
    let overlay = matches!(
        view.chrome,
        ProductChrome::TripleGlass | ProductChrome::PaintOrder
    );
    let nested = matches!(
        view.chrome,
        ProductChrome::NestedDialog | ProductChrome::PaintOrder
    );
    // Interactive session states (inline editor, revision-history card,
    // snapshots menu, variant picker) are not covered by authored documents
    // yet — the legacy RSX renders them.
    let interactive = view.editing_message_id.is_some()
        || view.history_open_for.is_some()
        || view.details_message_id.is_some()
        || view.snapshots_menu_open
        || view.variant_picker_for.is_some()
        || view.header_search_open;
    if overlay || nested || interactive {
        if current_source() != ChatBlueprintSource::Disabled {
            let reason = if interactive {
                "interactive-edit"
            } else if compact {
                "compact"
            } else if overlay && nested {
                "overlay+nested"
            } else if overlay {
                "overlay"
            } else {
                "nested"
            };
            warn_uncovered_variant(reason);
        }
        return None;
    }

    let (_, header_h, _, composer_h) =
        crate::chrome_metrics(view.viewport_width, view.viewport_height);
    // Compact mirrors the legacy breakpoint formulas exactly (lib.rs):
    // tighter padding, smaller font, and a flat composer bar instead of the
    // rounded floating pill.
    let pad = if compact { 8u32 } else { 16u32 };
    let font_px = if compact { 12u32 } else { 18u32 };
    let display_name = if view.character_name.is_empty() {
        view.title.clone()
    } else {
        view.character_name.clone()
    };
    let assistant_author = if display_name.is_empty() {
        "Assistant".to_owned()
    } else {
        display_name.clone()
    };
    let color = if view.composer_text.is_empty() {
        "#998f87"
    } else {
        "#f3eee8"
    };
    let label = if view.composer_text.is_empty() {
        if view.composer_placeholder.is_empty() {
            "Message".to_owned()
        } else {
            view.composer_placeholder.clone()
        }
    } else {
        view.composer_text.clone()
    };
    let composer_style = if compact {
        format!(
            "position:relative;width:100%;height:{composer_h}px;box-sizing:border-box;padding:{pad}px;background:rgba(36,33,30,0.88);color:{color};font-size:{font_px}px;"
        )
    } else {
        // Closed composer keeps the exact fixed box (golden geometry); the
        // context-meter popover switches it to content-driven height so the
        // popover expands the pill and the viewport flexes. Taffy distributes
        // the inner flex differently between `height`/`min-height` even at
        // the same resolved size, which would drift every golden by a few px.
        let height_rule = if view.context_panel_open {
            "min-height"
        } else {
            "height"
        };
        format!(
            "position:relative;width:100%;{height_rule}:{composer_h}px;box-sizing:border-box;padding:0;overflow:hidden;border:1px solid rgba(243,238,232,0.10);border-radius:28px;background:rgba(21,19,17,0.78);color:{color};font-size:{font_px}px;"
        )
    };

    let ctx = ChromeCtx {
        header_style: format!(
            "flex:none;position:relative;z-index:2;width:100%;height:{header_h}px;box-sizing:border-box;padding:0 {pad}px;background:rgba(36,33,30,0.82);color:#f3eee8;border-bottom:1px solid rgba(57,52,47,0.48);display:flex;align-items:center;justify-content:space-between;gap:8px;"
        ),
        viewport_style: "flex:1 1 auto;position:relative;width:100%;min-height:0;box-sizing:border-box;overflow:hidden;background:transparent;".to_owned(),
        scroll_style: format!(
            "display:flex;flex-direction:column;gap:24px;box-sizing:border-box;min-height:100%;padding:{pad}px;"
        ),
        composer_style,
        composer_color: color.to_owned(),
        composer_label: label,
        header_title: display_name,
        avatar_asset: view.character_avatar_asset.clone(),
        assistant_author,
        streaming: view.streaming,
        compact,
        font_px,
        context_panel_open: view.context_panel_open,
        context_summary: view.context_summary.clone(),
        tool_activity_name: view.tool_activity_name.clone(),
        swipe_labels: view
            .visible
            .iter()
            .filter(|row| !row.swipe_label.is_empty())
            .map(|row| (row.id.clone(), row.swipe_label.clone()))
            .collect(),
    };

    let state = ChatSurfaceStateV1 {
        revision: 0,
        messages: synthesized_messages(view),
        composer_draft: view.composer_text.clone(),
        character_name: view.character_name.clone(),
        streaming: view.streaming,
        context_panel_open: view.context_panel_open,
        context_summary: view.context_summary.clone(),
    };
    let scene = materialize_scene(&state).ok()?;
    let header_node = find_node(&scene.root, "chat-header")?.clone();
    let viewport_node = find_node(&scene.root, "chat-viewport")?.clone();
    let composer_node = find_node(&scene.root, "chat-composer")?.clone();

    Some(ChromeElements {
        header: render_header(&header_node, &ctx),
        viewport: render_viewport_root(&viewport_node, &ctx),
        composer: render_composer(&composer_node, &ctx),
    })
}

/// Synthesizes the scene-state messages from the visible session rows. The
/// formatted timestamp travels in `created_at`; roles map directly.
fn synthesized_messages(view: &ProductChatView) -> Vec<MessageDto> {
    view.visible
        .iter()
        .map(|row| MessageDto {
            id: row.id.clone(),
            chat_id: String::new(),
            role: match row.role.as_str() {
                "user" => MessageRole::User,
                "assistant" => MessageRole::Assistant,
                _ => MessageRole::System,
            },
            content: row.content.clone(),
            created_at: row.timestamp.clone(),
            sequence: 0,
            generation_run_id: row.run_id.clone(),
            meta: FreeObject {
                payload: if row.manual_excluded {
                    serde_json::json!({ "manualExcluded": true })
                } else {
                    serde_json::json!({ "manualExcluded": false })
                },
            },
            checkpoint_chat_id: row.checkpoint_chat_id.clone(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

fn render_header(node: &UiNodeV1, ctx: &ChromeCtx) -> Element {
    rsx! {
        div {
            class: "ChatWorkspace_chatHeader neoui-glass",
            "data-neoui": "glass",
            "data-slot": "chat.header",
            role: "banner",
            style: "{ctx.header_style}",
            for child in node.children.iter() { {render_header_child(child, ctx)} }
        }
    }
}

fn render_header_child(node: &UiNodeV1, ctx: &ChromeCtx) -> Element {
    match node.id.as_str() {
        "chat-identity" => render_identity(node, ctx),
        "header-search" => render_search_button(),
        "snapshots-trigger" => render_snapshots_trigger(),
        _ => render_plain_container(node, ctx, None),
    }
}

/// Native snapshots-menu trigger (`snapshots-trigger` in lib.rs): same
/// markup; the `custom.*` action rides the shared hit table verbatim.
fn render_snapshots_trigger() -> Element {
    rsx! {
        button {
            class: "ChatWorkspace_headerSearch",
            r#type: "button",
            "data-action": "custom.chat.snapshots-menu",
            "data-part": "snapshots-trigger",
            "aria-label": "Chat snapshots",
            title: "Chat snapshots",
            style: "flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:none;border-radius:20px;background:transparent;color:#c5bbb2;",
            {crate::product_shell::icon("GitBranch", 17)}
        }
    }
}

fn render_identity(node: &UiNodeV1, ctx: &ChromeCtx) -> Element {
    rsx! {
        div {
            class: "ChatWorkspace_chatIdentity",
            "data-part": "character-identity",
            style: "display:flex;align-items:center;gap:8px;min-width:0;flex:1;",
            for child in node.children.iter() { {render_identity_child(child, ctx)} }
        }
    }
}

fn render_identity_child(node: &UiNodeV1, ctx: &ChromeCtx) -> Element {
    match node.id.as_str() {
        // The avatar span only exists when an asset is present (legacy `if`).
        "identity-avatar" => {
            if ctx.avatar_asset.is_empty() {
                rsx! {}
            } else {
                let asset = ctx.avatar_asset.clone();
                rsx! {
                    span {
                        class: "ChatWorkspace_headerAvatar",
                        "data-part": "character-avatar",
                        "aria-hidden": "true",
                        style: "flex:none;width:32px;height:32px;border-radius:16px;overflow:hidden;background:#302c28;",
                        span {
                            "data-part": "avatar-fallback",
                            "data-avatar-asset": "{asset}",
                            class: "headerAvatar",
                            style: "display:block;width:32px;height:32px;border-radius:16px;background:#302c28;",
                        }
                    }
                }
            }
        }
        "identity-title" => rsx! {
            h1 {
                style: "margin:0;overflow:hidden;min-width:0;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap;color:#f3eee8;",
                "{ctx.header_title}"
            }
        },
        _ => render_plain_container(node, ctx, None),
    }
}

fn render_search_button() -> Element {
    rsx! {
        button {
            class: "ChatWorkspace_headerSearch",
            r#type: "button",
            "data-action": "header-search",
            "data-part": "header-search",
            "aria-label": "Search messages",
            title: "Search messages",
            style: "flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:none;border-radius:20px;background:transparent;color:#c5bbb2;",
            {crate::product_shell::icon("MagnifyingGlass", 17)}
        }
    }
}

// ---------------------------------------------------------------------------
// Viewport and rows
// ---------------------------------------------------------------------------

fn render_viewport_root(node: &UiNodeV1, ctx: &ChromeCtx) -> Element {
    match node.id.as_str() {
        "chat-viewport" => {
            let streaming = node.hook.states.iter().any(|s| s == "streaming");
            rsx! {
                div {
                    class: "ChatWorkspace_viewport",
                    "data-component": "chat-viewport",
                    "data-part": "canvas",
                    "data-region": "chat-viewport",
                    role: "list",
                    "aria-label": "Chat messages",
                    "data-state": if streaming { "streaming" } else { "idle" },
                    style: "{ctx.viewport_style}",
                    for child in node.children.iter() { {render_viewport_root(child, ctx)} }
                }
            }
        }
        "chat-scroll" => rsx! {
            div {
                class: "ChatWorkspace_scrollBody",
                "data-part": "chat-scroll",
                style: "{ctx.scroll_style}",
                for child in node.children.iter() { {render_viewport_root(child, ctx)} }
            }
        },
        "chat-message-list" => rsx! {
            div {
                class: "ChatPage_messageCanvas",
                "data-component": "chat-message-list",
                style: "display:flex;flex-direction:column;gap:24px;min-height:0;",
                for child in node.children.iter() {
                    { rsx! {
                        if is_streaming_message_node(child) {
                            if let Some(name) = ctx.tool_activity_name.as_deref() {
                                {crate::tool_activity_badge(name)}
                            }
                        }
                        {render_viewport_root(child, ctx)}
                    } }
                }
                if ctx.tool_activity_name.is_some()
                    && !node.children.iter().any(is_streaming_message_node)
                {
                    {crate::tool_activity_badge(ctx.tool_activity_name.as_deref().unwrap_or("tool"))}
                }
            }
        },
        _ => match row_of(node) {
            Some(message) => render_row(node, ctx, &message),
            None => render_plain_container(node, ctx, None),
        },
    }
}

fn is_streaming_message_node(node: &UiNodeV1) -> bool {
    node.id.rsplit(':').next() == Some("streaming")
}

/// Extracts the row's message from its scene content (`ChatMessage`).
fn row_of(node: &UiNodeV1) -> Option<MessageDto> {
    match &node.content {
        neotavern_presentation_blueprint::v1::UiContentV1::ChatMessage { message } => {
            Some(message.clone())
        }
        _ => None,
    }
}

fn render_row(node: &UiNodeV1, ctx: &ChromeCtx, message: &MessageDto) -> Element {
    let uuid = node.id.split_once(':').map(|(_, id)| id).unwrap_or("");
    let user = message.role == MessageRole::User;
    // The hydrated swipe counter rides the same `VisibleRow` map the legacy
    // pager renders: empty = hidden (React total <= 1).
    let swipe_label = ctx.swipe_labels.get(uuid).map(String::as_str).unwrap_or("");
    let row = RowView {
        uuid,
        message,
        user,
        author: if user {
            "You"
        } else {
            ctx.assistant_author.as_str()
        },
        streaming_state: ctx.streaming && uuid == "streaming",
        swipe_label,
    };
    let role_name = if user { "user" } else { "assistant" };
    let style = crate::message_bubble_style(user, ctx.compact, ctx.font_px);
    let author = row.author;
    rsx! {
        article {
            class: if user { "MessageBubble_rowUser" } else { "MessageBubble_rowAssistant" },
            "data-component": "chat-message",
            "data-role": "{role_name}",
            "data-state": if row.streaming_state { "streaming" } else { "done" },
            "data-format": "markdown",
            "data-message-id": "{uuid}",
            role: "listitem",
            "aria-label": "{author}",
            style: "{style}",
            for child in node.children.iter() { {render_row_child(child, ctx, &row)} }
        }
    }
}

fn row_suffix(node: &UiNodeV1) -> &str {
    node.id.rsplit('.').next().unwrap_or("")
}

fn render_row_child(node: &UiNodeV1, ctx: &ChromeCtx, row: &RowView) -> Element {
    match row_suffix(node) {
        "message-header" => rsx! {
            header {
                class: "MessageBubble_messageHeader",
                "data-part": "message-header",
                style: "display:flex;align-items:center;width:100%;gap:8px;margin-bottom:4px;",
                for child in node.children.iter() { {render_row_child(child, ctx, row)} }
            }
        },
        "message-avatar" => {
            let image = !row.user && !ctx.avatar_asset.is_empty();
            rsx! {
                span {
                    class: "MessageBubble_avatar",
                    "data-part": "message-avatar",
                    "data-state": if image { "image" } else { "fallback" },
                    "aria-hidden": "true",
                    style: "flex:none;width:36px;height:36px;border-radius:18px;overflow:hidden;background:#492a20;",
                    if image {
                        span {
                            "data-part": "avatar-fallback",
                            "data-avatar-asset": "{ctx.avatar_asset}",
                            class: "messageAvatar",
                            style: "display:block;width:36px;height:36px;border-radius:18px;background:#302c28;",
                        }
                    }
                }
            }
        }
        "message-identity" => rsx! {
            span {
                class: "MessageBubble_identity",
                "data-part": "message-identity",
                style: "display:flex;align-items:baseline;gap:8px;min-width:0;",
                for child in node.children.iter() { {render_row_child(child, ctx, row)} }
            }
        },
        "message-author" => {
            let author = row.author;
            rsx! {
                span {
                    class: "MessageBubble_author",
                    "data-part": "message-author",
                    style: "color:#f3eee8;font-size:13px;font-weight:700;",
                    "{author}"
                }
            }
        }
        "message-timestamp" => {
            let timestamp = &row.message.created_at;
            rsx! {
                if !timestamp.is_empty() {
                    span {
                        class: "MessageBubble_timestamp",
                        "data-part": "message-timestamp",
                        style: "overflow:hidden;color:#998f87;font-size:12px;text-overflow:ellipsis;white-space:nowrap;",
                        "{timestamp}"
                    }
                }
            }
        }
        "message-action-bar" => rsx! {
            div {
                class: "MessageBubble_actionBar",
                "data-component": "message-action-bar",
                "data-part": "message-actions-inline",
                "data-state": "idle",
                style: "display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-left:auto;",
                {message_action_button("details", row)}
                for child in node.children.iter() { {render_row_child(child, ctx, row)} }
            }
        },
        "message-content" => rsx! {
            div {
                class: "MessageBubble_content",
                "data-part": "message-content",
                for child in node.children.iter() { {render_row_child(child, ctx, row)} }
            }
        },
        "message-frame" => rsx! {
            div {
                class: "MessageBubble_messageFrame",
                "data-part": "message-frame",
                for child in node.children.iter() { {render_row_child(child, ctx, row)} }
            }
        },
        "message-bubble" => rsx! {
            div {
                class: "MessageBubble_bubble",
                "data-part": "message-body",
                style: "position:relative;width:100%;box-sizing:border-box;",
                {crate::markdown::message_markdown(row.message.content.as_str(), row.streaming_state)}
            }
        },
        "message-art" => {
            if row.user || ctx.avatar_asset.is_empty() {
                rsx! {}
            } else {
                rsx! {
                    span {
                        class: "MessageBubble_messageArt",
                        "data-part": "message-art",
                        "aria-hidden": "true",
                        style: "display:none;",
                    }
                }
            }
        }
        // Assistant-only version controls; hidden entirely on compact and on
        // user rows (legacy conditionals).
        "version-controls" => {
            if row.user || ctx.compact {
                rsx! {}
            } else {
                rsx! {
                    div {
                        "data-component": "message-version-controls",
                        "data-part": "message-version-controls",
                        style: "display:flex;align-items:center;gap:8px;margin-top:8px;",
                        for child in node.children.iter() { {render_row_child(child, ctx, row)} }
                    }
                }
            }
        }
        "version-actions" => rsx! {
            div {
                "data-part": "message-version-actions",
                style: "display:flex;align-items:center;gap:8px;",
                for child in node.children.iter() { {render_row_child(child, ctx, row)} }
            }
        },
        "swipe-pager" => rsx! {
            div {
                "data-component": "message-swipe-pager",
                "data-part": "message-swipes",
                style: "display:flex;align-items:center;gap:4px;",
                for child in node.children.iter() { {render_row_child(child, ctx, row)} }
            }
        },
        // Hydrated swipe counter (`chat:swipeCounter` in React); a kernel
        // message starts empty and variants.list fills it in — the empty
        // span is skipped entirely, matching the legacy conditional (an
        // empty span still eats its flex gap in this Blitz build).
        "swipe-label" => {
            let label = row.swipe_label;
            if label.is_empty() {
                rsx! {}
            } else {
                rsx! {
                    span {
                        "aria-live": "polite",
                        style: "color:#998f87;font-size:12px;",
                        "{label}"
                    }
                }
            }
        }
        kind if kind.starts_with("message-action-") => {
            message_action_button(&kind["message-action-".len()..], row)
        }
        "version-history" => {
            version_button("history", "Revision history", "ClockCounterClockwise", true)
        }
        "version-regenerate" => {
            version_button("regenerate", "Regenerate", "ArrowCounterClockwise", true)
        }
        "swipe-previous" => {
            version_button("swipe-previous", "Previous variant", "CaretLeft", false)
        }
        // React `MessageVariantPicker` trigger between the pager arrows.
        "swipe-picker" => version_button("swipe-picker", "Variants", "CaretDown", false),
        "swipe-next" => version_button("swipe-next", "Next variant", "CaretRight", false),
        _ => render_plain_container(node, ctx, None),
    }
}

/// Native action-bar button (`message_action_button` in lib.rs): v1 style,
/// icon size 16, carries `data-message-id`, aria-label + title.
fn message_action_button(kind: &str, row: &RowView) -> Element {
    // React renders the prompt-plan / steps triggers only for rows whose
    // meta carries `generationRunId` (MessageDetailsCardV2 footer actions).
    if (kind == "prompt" || kind == "steps") && row.message.generation_run_id.is_none() {
        return rsx! {};
    }
    if kind == "delete-checkpoint" && row.message.checkpoint_chat_id.is_none() {
        return rsx! {};
    }
    let excluded =
        row.message.meta.payload.get("manualExcluded") == Some(&serde_json::Value::Bool(true));
    let (label, icon) = match kind {
        "details" => ("Message details", "TextAlignLeft"),
        "context" if excluded => ("Include in prompt context", "Eye"),
        "context" => ("Exclude from prompt context", "EyeSlash"),
        "edit" => ("Edit message", "PencilSimple"),
        "copy" => ("Copy", "Copy"),
        "checkpoint" => ("Checkpoint", "Flag"),
        "branch" => ("Branch", "GitBranch"),
        "delete-checkpoint" => ("Remove checkpoint", "Flag"),
        "delete" => ("Delete message", "Trash"),
        "rollback" => ("Rollback to here", "ArrowUUpLeft"),
        "history" => ("Edit history", "ClockCounterClockwise"),
        "prompt" => ("View prompt plan", "BookOpenText"),
        "steps" => ("View run steps", "List"),
        _ => ("", ""),
    };
    let uuid = row.uuid;
    rsx! {
        button {
            class: "MessageBubble_actionButton",
            r#type: "button",
            "data-action": "{kind}",
            "data-message-id": "{uuid}",
            "aria-label": "{label}",
            title: "{label}",
            style: "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(243,238,232,0.10);border-radius:16px;background:rgba(36,33,30,0.62);color:#c5bbb2;cursor:pointer;",
            {crate::product_shell::icon(icon, 16)}
        }
    }
}

/// Version-control / swipe-pager pill (`v2` style): icon size 14, no
/// `data-message-id`; history/regenerate carry titles, swipes do not.
fn version_button(
    action: &'static str,
    label: &'static str,
    icon: &'static str,
    titled: bool,
) -> Element {
    rsx! {
        button {
            class: "MessageBubble_actionButton",
            r#type: "button",
            "data-action": "{action}",
            "aria-label": "{label}",
            title: titled.then_some(label),
            style: "display:flex;align-items:center;justify-content:center;gap:4px;width:32px;height:32px;border-radius:16px;border:1px solid rgba(57,52,47,0.70);background:rgba(36,33,30,0.70);color:#998f87;",
            {crate::product_shell::icon(icon, 14)}
        }
    }
}

// ---------------------------------------------------------------------------
// Composer (proven walker from slice 2, fed from the shared context)
// ---------------------------------------------------------------------------

fn render_composer(node: &UiNodeV1, ctx: &ChromeCtx) -> Element {
    // Compact breakpoint: the legacy composer collapses to a flat bar —
    // plain label text plus one absolutely-positioned Send button; no
    // toolbar/field/utilities structure. Mirrored 1:1 from lib.rs.
    if ctx.compact {
        let style = ctx.composer_style.clone();
        let label = ctx.composer_label.clone();
        return rsx! {
            div {
                class: "ChatWorkspace_composer neoui-glass",
                "data-neoui": "glass",
                role: "region",
                "aria-label": "Message composer",
                "data-state": if ctx.streaming { "streaming" } else { "idle" },
                "data-slot": "chat.composer",
                style: "{style}",
                "{label}"
                if ctx.streaming {
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "danger",
                        "data-size": "md",
                        "data-action": "stop",
                        style: "position:absolute;right:12px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;min-width:44px;min-height:36px;padding:4px 16px;border:none;border-radius:10px;color:#fee2e2;background:#b91c1c;font-size:13px;font-weight:500;",
                        span { "data-part": "label", "Stop" }
                        span {
                            "data-part": "icon",
                            "data-position": "end",
                            "aria-hidden": "true",
                            {crate::product_shell::icon("StopCircle", 16)}
                        }
                    }
                } else {
                    button {
                        class: "st-button",
                        r#type: "button",
                        "data-component": "button",
                        "data-variant": "primary",
                        "data-size": "md",
                        "data-action": "send",
                        style: "position:absolute;right:12px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;min-width:44px;min-height:36px;padding:4px 16px;border:none;border-radius:10px;color:#2a130b;background:#e38a62;font-size:13px;font-weight:500;",
                        span { "data-part": "label", "Send" }
                        span {
                            "data-part": "icon",
                            "data-position": "end",
                            "aria-hidden": "true",
                            {crate::product_shell::icon_fill("PaperPlaneRight", 16, "#2a130b")}
                        }
                    }
                }
            }
        };
    }
    let composer_ctx = ComposerCtx {
        style: ctx.composer_style.clone(),
        color: ctx.composer_color.clone(),
        label: ctx.composer_label.clone(),
        context_panel_open: ctx.context_panel_open,
        context_summary: ctx.context_summary.clone(),
        streaming: ctx.streaming,
    };
    render_node(node, &composer_ctx)
}

/// Shared per-render values the composer walker needs beyond the scene nodes.
struct ComposerCtx {
    style: String,
    color: String,
    label: String,
    context_panel_open: bool,
    context_summary: Option<ContextUsageSummaryV1>,
    streaming: bool,
}

fn render_node(node: &UiNodeV1, ctx: &ComposerCtx) -> Element {
    if node.semantic.role == "button" {
        render_button(node, ctx.streaming)
    } else {
        render_container(node, ctx)
    }
}

/// Static presentation per stable node id: `(class, data-part, inline style)`.
/// Groups carry classes only, mirroring the packed sheet selectors.
fn container_look(id: &str) -> (Option<&'static str>, Option<&'static str>, &'static str) {
    match id {
        "chat-composer" => (Some("ChatWorkspace_composer"), None, ""),
        "composer-toolbar" => (
            Some("ChatWorkspace_composerToolbar"),
            Some("toolbar"),
            "display:flex;align-items:center;justify-content:space-between;width:100%;height:42px;padding:0 16px;box-sizing:border-box;border-bottom:1px solid rgba(243,238,232,0.08);",
        ),
        "composer-toolbar-actions" => (
            Some("ChatWorkspace_toolbarActions"),
            None,
            "display:flex;align-items:center;gap:4px;",
        ),
        "composer-field" => (
            Some("ChatWorkspace_composerField"),
            Some("field"),
            "display:flex;flex-direction:column;flex:1;min-height:0;padding:12px 16px 8px;box-sizing:border-box;background:rgba(36,33,30,0.55);",
        ),
        "composer-actions" => (
            None,
            Some("composer-actions"),
            // `flex-start` + the utilities' auto margin: see the Send-button
            // Taffy note in lib.rs. The packed `.composerActions` class is
            // deliberately NOT applied (class rules beat the inline workaround
            // in this Blitz build and the packed flex-end re-breaks wide
            // columns) — `data-part` keeps the theme contract.
            "display:flex;align-items:center;justify-content:flex-start;gap:12px;margin-top:8px;",
        ),
        "composer-utilities" => (
            None,
            Some("composer-utilities"),
            // `margin-right:auto` replaces the packed utilities rule (same
            // reason as the row above: the auto margin must live inline).
            "display:flex;align-items:center;gap:4px;margin-right:auto;",
        ),
        _ => (None, None, ""),
    }
}

fn render_plain_container(node: &UiNodeV1, _ctx: &ChromeCtx, _row: Option<&MessageDto>) -> Element {
    rsx! {
        div {
            for child in node.children.iter() { {render_plain_container(child, _ctx, _row)} }
        }
    }
}

/// Appends authored token declarations after a built-in inline style so a
/// document override wins the inline cascade without mutating the tables.
fn overrides_style(node: &UiNodeV1) -> String {
    let mut style = String::new();
    for reference in &node.overrides.style_refs {
        style.push_str(&reference.property);
        style.push(':');
        style.push_str(&reference.token);
        style.push(';');
    }
    style
}

fn render_container(node: &UiNodeV1, ctx: &ComposerCtx) -> Element {
    if node.id == "composer-textarea" {
        let color = ctx.color.clone();
        let label = ctx.label.clone();
        return rsx! {
            div {
                "data-component": "textarea",
                style: "flex:1;min-height:48px;color:{color};font-size:16px;line-height:1.4;",
                "{label}"
            }
        };
    }
    if node.id == "composer-context-panel" {
        // State-conditional structure: the document carries the node, the
        // renderer mounts it only while the popover is open (React
        // `{open ? <ContextUsagePanel/> : null}`). Closed = `display:none`,
        // not an empty node — an empty block still occupies a line box in
        // this Blitz build and shifts the whole composer ~8px.
        return render_context_panel_slot(ctx.context_panel_open, ctx.context_summary.as_ref());
    }
    if node.id == "chat-composer" {
        let style = ctx.style.clone();
        let streaming = node.hook.states.iter().any(|state| state == "streaming");
        return rsx! {
            div {
                class: "ChatWorkspace_composer neoui-glass",
                "data-neoui": "glass",
                role: "region",
                "aria-label": "Message composer",
                "data-state": if streaming { "streaming" } else { "idle" },
                "data-slot": "chat.composer",
                style: "{style}",
                for child in node.children.iter() { {render_node(child, ctx)} }
            }
        };
    }
    let (class, part, look_style) = container_look(&node.id);
    let authored_style = overrides_style(node);
    rsx! {
        div {
            class: class.map(|value| value.to_string()),
            "data-part": part.map(|value| value.to_string()),
            style: "{look_style}{authored_style}",
            for child in node.children.iter() { {render_node(child, ctx)} }
        }
    }
}

/// Composer context-meter popover slot shared by the blueprint renderer and
/// the legacy RSX chrome (the skeleton-parity contract requires both trees to
/// carry the node). Closed = `display:none` placeholder; open = the full
/// `ContextUsagePanel` parity render.
pub(crate) fn render_context_panel_slot(
    open: bool,
    summary: Option<&ContextUsageSummaryV1>,
) -> Element {
    if !open {
        return rsx! {
            div {
                "data-component": "context-usage-panel",
                style: "display:none;",
            }
        };
    }
    let Some(summary) = summary else {
        return rsx! {};
    };
    let b = &summary.breakdown;
    let usage = format!("{} / {}", summary.prompt_tokens, summary.context_limit);
    let prompt_budget = summary
        .context_limit
        .saturating_sub(summary.reserved_for_reply);
    let rows = [
        ("ChatsCircle", "History", b.chat_history),
        ("BookOpen", "World info", b.world_info),
        ("Sparkle", "Character", b.character),
        ("UserCircle", "Persona", b.persona),
        ("SquaresFour", "Other", b.other),
    ];
    rsx! {
        div {
            "data-component": "context-usage-panel",
            "data-state": "estimate",
            style: "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;width:100%;box-sizing:border-box;padding:16px 24px;color:#f3eee8;background:rgba(27,25,23,0.92);border-bottom:1px solid rgba(243,238,232,0.08);",
            // Left column: summary
            div {
                "data-part": "summary",
                style: "display:flex;flex-direction:column;gap:12px;min-width:0;",
                div {
                    "data-part": "header",
                    style: "display:flex;align-items:center;gap:12px;",
                    div {
                        "data-part": "icon",
                        "aria-hidden": "true",
                        style: "display:flex;align-items:center;justify-content:center;width:35px;height:35px;flex:none;border-radius:8px;background:rgba(48,44,40,0.85);",
                        {crate::product_shell::icon("Database", 18)}
                    }
                    div {
                        div {
                            "data-part": "header-title",
                            style: "color:#c5bbb2;font-size:12px;font-weight:600;line-height:1.2;",
                            "Draft estimate"
                        }
                        div {
                            "data-part": "usage",
                            style: "margin-top:2px;font-size:14px;font-weight:700;line-height:1.2;",
                            "{usage}"
                        }
                    }
                }
                div {
                    "data-part": "metrics",
                    style: "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;",
                    div {
                        "data-part": "metric",
                        style: "display:grid;gap:2px;padding:8px 12px;border:1px solid rgba(57,52,47,0.7);border-radius:8px;background:rgba(36,33,30,0.4);",
                        div { style: "color:#998f87;font-size:12px;", "Context usage" }
                        div { style: "font-weight:700;", "{summary.usage_percent}%" }
                    }
                    div {
                        "data-part": "metric",
                        style: "display:grid;gap:2px;padding:8px 12px;border:1px solid rgba(57,52,47,0.7);border-radius:8px;background:rgba(36,33,30,0.4);",
                        div { style: "color:#998f87;font-size:12px;", "Available" }
                        div { style: "font-weight:700;", "{summary.available_tokens}" }
                    }
                    div {
                        "data-part": "metric",
                        style: "display:grid;gap:2px;padding:8px 12px;border:1px solid rgba(57,52,47,0.7);border-radius:8px;background:rgba(36,33,30,0.4);",
                        div { style: "color:#998f87;font-size:12px;", "Prompt tokens" }
                        div { style: "font-weight:700;", "{summary.prompt_tokens} / {prompt_budget}" }
                    }
                    div {
                        "data-part": "metric",
                        style: "display:grid;gap:2px;padding:8px 12px;border:1px solid rgba(57,52,47,0.7);border-radius:8px;background:rgba(36,33,30,0.4);",
                        div { style: "color:#998f87;font-size:12px;", "Reserved for reply" }
                        div { style: "font-weight:700;", "{summary.reserved_for_reply}" }
                    }
                }
                div {
                    "data-part": "status",
                    style: "display:flex;align-items:center;gap:6px;padding-top:8px;border-top:1px dashed rgba(57,52,47,0.9);color:#998f87;font-size:12px;",
                    {crate::product_shell::icon("Info", 14)}
                    "Local estimate from chat history and draft. Exact audit comes from the Kernel prompt preview on the packaged host."
                }
            }
            // Right column: breakdown
            div {
                "data-part": "details",
                style: "display:flex;flex-direction:column;justify-content:center;gap:8px;padding-left:16px;border-left:1px solid rgba(57,52,47,0.7);min-width:0;",
                for row in rows.iter() {
                    div {
                        "data-part": "breakdown-row",
                        style: "display:flex;align-items:center;gap:12px;font-size:12px;",
                        div {
                            "data-part": "breakdown-label",
                            style: "display:flex;align-items:center;gap:6px;flex:0 1 9rem;color:#c5bbb2;",
                            {crate::product_shell::icon(row.0, 15)}
                            "{row.1}"
                        }
                        div {
                            "aria-hidden": "true",
                            style: "height:4px;flex:1;overflow:hidden;border-radius:2px;background:rgba(48,44,40,0.85);",
                            div {
                                "data-part": "breakdown-fill",
                                style: "height:100%;border-radius:2px;background:#998f87;width:{fill_percent(row.2, summary.prompt_tokens)}%;",
                            }
                        }
                        div {
                            "data-part": "breakdown-count",
                            style: "width:4.5rem;color:#998f87;text-align:end;",
                            "{row.2}"
                        }
                    }
                }
            }
        }
    }
}

fn fill_percent(tokens: u64, prompt_tokens: u64) -> u64 {
    if prompt_tokens == 0 {
        0
    } else {
        (tokens * 100).min(prompt_tokens * 100) / prompt_tokens
    }
}

/// Static button presentation keyed by stable node id. Fields mirror the
/// legacy RSX exactly (`aria` always present; `title` only where the legacy
/// button has one; the Send button leads with its `data-part="label"` span).
struct ButtonLook {
    class: Option<&'static str>,
    action: &'static str,
    aria: &'static str,
    title: Option<&'static str>,
    icon: &'static str,
    icon_size: u32,
    /// Fill color routes the icon through `icon_fill` (Send button).
    icon_fill_color: Option<&'static str>,
    /// Trailing plain span (`toolbar` Settings / Context percentage).
    trailing_label: Option<&'static str>,
    /// Leading `data-part="label"` span (Send button).
    lead_label: bool,
    primary: bool,
    danger: bool,
}

fn button_look(id: &str, streaming: bool) -> ButtonLook {
    match id {
        "composer-settings" => ButtonLook {
            class: Some("ChatWorkspace_menuButton"),
            action: "composer-settings",
            aria: "Settings",
            title: Some("Settings"),
            icon: "GearSix",
            icon_size: 15,
            trailing_label: Some("Settings"),
            ..BUTTON_GEOMETRY
        },
        "composer-reset" => ButtonLook {
            class: Some("ChatWorkspace_iconButton"),
            action: "composer-reset",
            aria: "Reset",
            title: Some("Reset"),
            icon: "X",
            icon_size: 17,
            ..BUTTON_GEOMETRY
        },
        "composer-context" => ButtonLook {
            class: Some("ChatWorkspace_contextTrigger"),
            action: "composer-context",
            aria: "Context",
            title: Some("Context 4%"),
            icon: "Database",
            icon_size: 15,
            trailing_label: Some("4%"),
            ..BUTTON_GEOMETRY
        },
        "utility-settings" => ButtonLook {
            action: "composer-settings",
            aria: "Settings",
            icon: "List",
            ..BUTTON_GEOMETRY
        },
        "utility-scroll-latest" => ButtonLook {
            action: "scroll-latest",
            aria: "Scroll to latest",
            icon: "ArrowDown",
            ..BUTTON_GEOMETRY
        },
        "utility-wand" => ButtonLook {
            action: "composer-reset",
            aria: "Reset",
            icon: "MagicWand",
            ..BUTTON_GEOMETRY
        },
        "composer-send" => {
            if streaming {
                ButtonLook {
                    class: Some("st-button"),
                    action: "stop",
                    aria: "Stop",
                    title: Some("Stop"),
                    icon: "StopCircle",
                    icon_size: 16,
                    icon_fill_color: None,
                    trailing_label: Some("Stop"),
                    lead_label: true,
                    primary: true,
                    danger: true,
                }
            } else {
                ButtonLook {
                    class: Some("st-button"),
                    action: "send",
                    aria: "Send",
                    title: Some("Send"),
                    icon: "PaperPlaneRight",
                    icon_size: 16,
                    icon_fill_color: Some("#2a130b"),
                    trailing_label: Some("Send"),
                    lead_label: true,
                    primary: true,
                    danger: false,
                }
            }
        }
        _ => BUTTON_GEOMETRY,
    }
}

/// Shared defaults for the fields every composer button has in common
/// (`icon_size`, fill/label flags). Struct-update syntax keeps each arm
/// focused on what makes it distinct.
const BUTTON_GEOMETRY: ButtonLook = ButtonLook {
    class: None,
    action: "",
    aria: "",
    title: None,
    icon: "",
    icon_size: 19,
    icon_fill_color: None,
    trailing_label: None,
    lead_label: false,
    primary: false,
    danger: false,
};

fn render_button(node: &UiNodeV1, streaming: bool) -> Element {
    let look = button_look(&node.id, streaming);
    // Authored document overrides win over the built-in table: label text
    // replaces aria/title/visible spans, icon name and token-backed style
    // declarations come straight from the document.
    // Authored label text replaces existing text surfaces (aria/title and a
    // visible span only where the built-in look already renders one); it
    // never adds a visible span to an icon-only button.
    let is_streaming_send = streaming && node.id == "composer-send";
    let authored_label = node.overrides.label.as_ref();
    let aria: String = if is_streaming_send {
        "Stop".to_owned()
    } else {
        authored_label
            .map(|label| label.text.clone())
            .unwrap_or_else(|| look.aria.to_owned())
    };
    let title: Option<String> = if is_streaming_send {
        Some("Stop".to_owned())
    } else {
        authored_label
            .map(|label| Some(label.text.clone()))
            .unwrap_or_else(|| look.title.map(str::to_owned))
    };
    let renders_text = look.trailing_label.is_some() || look.lead_label;
    let trailing_label: Option<String> = if is_streaming_send {
        Some("Stop".to_owned())
    } else if renders_text {
        Some(
            authored_label
                .map(|label| label.text.clone())
                .unwrap_or_else(|| look.trailing_label.unwrap_or_default().to_owned()),
        )
    } else {
        None
    };
    let icon_name: String = if is_streaming_send {
        "StopCircle".to_owned()
    } else {
        node.overrides
            .icon
            .clone()
            .unwrap_or_else(|| look.icon.to_owned())
    };
    let action_attr: Option<String> = if is_streaming_send {
        Some("stop".to_owned())
    } else {
        node.action
            .as_ref()
            .and_then(|action| data_action_attr(action).or_else(|| non_empty(look.action)))
    };
    let mut style = button_style(&node.id, look.primary, look.danger);
    style.push_str(&overrides_style(node));
    let icon_element = match look.icon_fill_color {
        Some(fill) if !look.danger => {
            crate::product_shell::icon_fill(&icon_name, look.icon_size, fill)
        }
        _ => crate::product_shell::icon(&icon_name, look.icon_size),
    };
    let icon_child = if look.primary {
        rsx! {
            span {
                "data-part": "icon",
                "data-position": "end",
                "aria-hidden": "true",
                {icon_element}
            }
        }
    } else {
        icon_element
    };
    let variant = if look.danger {
        Some("danger".to_owned())
    } else if look.primary {
        Some("primary".to_owned())
    } else {
        None
    };
    rsx! {
        button {
            class: look.class.map(|value| value.to_string()),
            r#type: "button",
            "data-component": if look.primary { Some("button".to_owned()) } else { None },
            "data-variant": variant,
            "data-size": if look.primary { Some("md".to_owned()) } else { None },
            "data-action": action_attr,
            "aria-label": "{aria}",
            title,
            style: "{style}",
            if look.lead_label {
                span {
                    "data-part": "label",
                    {trailing_label.clone().unwrap_or_default()}
                }
            }
            {icon_child}
            if !look.lead_label {
                if let Some(text) = trailing_label {
                    span {
                        style: "font-size:13px;",
                        "{text}"
                    }
                }
            }
        }
    }
}

/// Maps the closed action union onto the `data-action` strings shared with
/// React, the native RSX and the hit-test decision table.
fn data_action_attr(action: &UiActionV1) -> Option<String> {
    let name = match action {
        UiActionV1::ChatSend => "send",
        UiActionV1::ChatComposerSettings => "composer-settings",
        UiActionV1::ChatComposerReset => "composer-reset",
        UiActionV1::ChatComposerContext => "composer-context",
        UiActionV1::ChatScrollLatest => "scroll-latest",
        UiActionV1::ChatMessageContext { .. } => "context",
        UiActionV1::ChatMessageEdit { .. } => "edit",
        UiActionV1::ChatMessageCopy { .. } => "copy",
        UiActionV1::ChatMessageCheckpoint { .. } => "checkpoint",
        UiActionV1::ChatMessageBranch { .. } => "branch",
        UiActionV1::ChatMessageDelete { .. } => "delete",
        UiActionV1::ChatMessageRollback { .. } => "rollback",
        UiActionV1::ChatMessageHistory => "history",
        UiActionV1::ChatMessageRegenerate => "regenerate",
        UiActionV1::ChatMessageSwipePrevious => "swipe-previous",
        UiActionV1::ChatMessageSwipeNext => "swipe-next",
        UiActionV1::ChatMessageSwipePicker => "swipe-picker",
        UiActionV1::ChatMessagePrompt { .. } => "prompt",
        UiActionV1::ChatMessageSteps { .. } => "steps",
        UiActionV1::ChatMessageDeleteCheckpoint { .. } => "delete-checkpoint",
        // Declarative custom intents publish their full authored name so the
        // hit table can route them without a kernel round-trip.
        UiActionV1::Custom { name, .. } => return Some(name.clone()),
        _ => return None,
    };
    Some(name.to_owned())
}

fn non_empty(value: &'static str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

fn button_style(id: &str, primary: bool, danger: bool) -> String {
    if danger {
        return "display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:44px;padding:4px 16px;border:none;border-radius:10px;color:#fee2e2;background:#b91c1c;font-size:13px;font-weight:500;".to_owned();
    }
    if primary {
        // React send = the default `st-button` control height (--st-control-height: 44px).
        return "display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:44px;padding:4px 16px;border:none;border-radius:10px;color:#2a130b;background:#e38a62;font-size:13px;font-weight:500;".to_owned();
    }
    match id {
        "composer-settings" | "composer-context" => "display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid rgba(243,238,232,0.10);border-radius:16px;color:#c5bbb2;background:rgba(243,238,232,0.05);".to_owned(),
        "composer-reset" => "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;border-radius:16px;background:transparent;color:#998f87;".to_owned(),
        "utility-settings" | "utility-scroll-latest" | "utility-wand" => "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:#998f87;".to_owned(),
        _ => String::new(),
    }
}
