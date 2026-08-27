//! Feature-flagged Dioxus Product Wire shell (Milestone A).
//!
//! Not production JNI. Not `MainActivity`. Does not import Kernel, storage,
//! or network crates.

use contracts_generated::generated::{decode_chat_dto, decode_message_dto, ChatDto, MessageDto};
use dioxus_core::{Element, VirtualDom};
use dioxus_core_macro::rsx;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Mutex;

mod ai_settings_tab;
mod backgrounds_tab;
mod chat_route;
mod chats_tab;
mod lorebooks_tab;
mod markdown;
mod personas_tab;
mod plugins_tab;
mod product_path;
mod product_shell;
mod scene_chat;
mod settings_tab;
pub use chat_route::{chat_route_line, flagged_chat_route, ChatRouteReport};
pub use markdown::{contains_part, message_markdown, parse_document, parse_inline, Block, Inline};
pub use neotavern_presentation_blueprint::v1::{ContextUsageBreakdownV1, ContextUsageSummaryV1};
pub use neotavern_presentation_design_system::SafeAreaInsets;
pub use product_path::{
    chrome_metrics, current_product_chat, format_timestamp, install_product_chat, message_id,
    mixed_height, mixed_height_catalog, product_chat_from_fixture, product_chat_with_chrome,
    streaming_schedule, visible_rows, ProductChatView, ProductChrome, RevisionRow, RowKind,
    SnapshotItemView, VisibleRow, PRODUCT_PATH_CHAT_ID, PRODUCT_PATH_ITEMS, PRODUCT_PATH_VISIBLE,
};
pub use product_shell::{
    character_card_description, character_manager_title, current_product_shell, ellipsize_css,
    install_product_shell, lorebook_card_description, panel_header_title, persona_card_description,
    product_shell_app, BackupCardView, CharacterCardView, CharacterDraftView, ChatCardView,
    LorebookCardView, LorebookEntryCardView, MemoryCardView, PersonaCardView, PluginCardView,
    PresetCardView, PresetValueRow, ProductShellView, ProfileCardView, ProviderCardView,
    ProviderConfigCardView, RunStepView, ThemeCardView, ToolCardView, AI_SETTINGS_TITLE,
    BACKGROUNDS_MANAGER_TITLE, CHARACTER_MANAGER_TITLE, CHATS_MANAGER_TITLE,
    LOREBOOK_MANAGER_TITLE, PERSONA_MANAGER_TITLE, PLUGINS_MANAGER_TITLE, SETTINGS_TITLE,
};
pub use scene_chat::{
    chat_wallpaper_mode, set_chat_blueprint_source, set_chat_wallpaper_mode, ChatBlueprintSource,
};

pub const DIOXUS_SHELL_FLAG: &str = "NEOTA_DIOXUS_SHELL";
pub const CANONICAL_FIXTURE_JSON: &str =
    include_str!("../../../packages/contracts/src/presentation/fixtures/canonical-chat.json");
pub const EXPECTED_PROJECTION_JSON: &str =
    include_str!("../../../packages/contracts/src/presentation/fixtures/expected-projection.json");
const WIRE_OPERATION_IDS_JSON: &str =
    include_str!("../../../packages/contracts/src/presentation/fixtures/wire-operation-ids.json");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DioxusShellHost {
    Disabled,
    Flagged { feature_flag: bool },
}

pub fn dioxus_shell_from_flag(value: Option<&str>) -> DioxusShellHost {
    match value {
        Some("1") => DioxusShellHost::Flagged { feature_flag: true },
        _ => DioxusShellHost::Disabled,
    }
}

pub fn dioxus_shell_from_env() -> DioxusShellHost {
    dioxus_shell_from_flag(std::env::var(DIOXUS_SHELL_FLAG).ok().as_deref())
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct FixtureCommand {
    #[serde(rename = "wireOperationId")]
    pub wire_operation_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct StreamEvent {
    pub generation: u64,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct CanonicalFixture {
    pub chat: serde_json::Value,
    pub messages: Vec<serde_json::Value>,
    pub commands: Vec<FixtureCommand>,
    pub stream: Vec<StreamEvent>,
    #[serde(rename = "streamCap")]
    pub stream_cap: usize,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StreamResult {
    #[serde(rename = "acceptedText")]
    pub accepted_text: String,
    #[serde(rename = "lastGeneration")]
    pub last_generation: u64,
    #[serde(rename = "droppedStale")]
    pub dropped_stale: u64,
    #[serde(rename = "droppedBackpressure")]
    pub dropped_backpressure: u64,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CanonicalProjection {
    #[serde(rename = "chatId")]
    pub chat_id: String,
    pub title: String,
    #[serde(rename = "messageIds")]
    pub message_ids: Vec<String>,
    #[serde(rename = "issuedCommands")]
    pub issued_commands: Vec<String>,
    #[serde(flatten)]
    pub stream: StreamResult,
}

#[derive(Debug)]
pub enum ShellError {
    Json(String),
    Wire(String),
    UnknownCommand(String),
    FlagDisabled,
}

impl std::fmt::Display for ShellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(msg) | Self::Wire(msg) => write!(f, "{msg}"),
            Self::UnknownCommand(id) => {
                write!(
                    f,
                    "presentation command is not a Product Wire operation: {id}"
                )
            }
            Self::FlagDisabled => write!(f, "{DIOXUS_SHELL_FLAG} must be 1"),
        }
    }
}

pub fn wire_operation_ids() -> HashSet<String> {
    serde_json::from_str::<Vec<String>>(WIRE_OPERATION_IDS_JSON)
        .expect("wire-operation-ids.json")
        .into_iter()
        .collect()
}

pub fn assert_registered_command(operation_id: &str) -> Result<(), ShellError> {
    if wire_operation_ids().contains(operation_id) {
        Ok(())
    } else {
        Err(ShellError::UnknownCommand(operation_id.to_string()))
    }
}

pub fn load_canonical_fixture() -> Result<CanonicalFixture, ShellError> {
    serde_json::from_str(CANONICAL_FIXTURE_JSON).map_err(|err| ShellError::Json(err.to_string()))
}

pub fn decode_fixture_models(
    fixture: &CanonicalFixture,
) -> Result<(ChatDto, Vec<MessageDto>), ShellError> {
    let chat_bytes =
        serde_json::to_vec(&fixture.chat).map_err(|err| ShellError::Json(err.to_string()))?;
    let chat = decode_chat_dto(&chat_bytes).map_err(|err| ShellError::Wire(err.message))?;
    let mut messages = Vec::new();
    for row in &fixture.messages {
        let bytes = serde_json::to_vec(row).map_err(|err| ShellError::Json(err.to_string()))?;
        messages.push(decode_message_dto(&bytes).map_err(|err| ShellError::Wire(err.message))?);
    }
    Ok((chat, messages))
}

pub fn issue_commands(commands: &[FixtureCommand]) -> Result<Vec<String>, ShellError> {
    let mut issued = Vec::new();
    for command in commands {
        assert_registered_command(&command.wire_operation_id)?;
        issued.push(command.wire_operation_id.clone());
    }
    Ok(issued)
}

pub fn apply_presentation_stream(
    events: &[StreamEvent],
    cap: usize,
) -> Result<StreamResult, ShellError> {
    if cap < 1 {
        return Err(ShellError::Json(
            "presentation stream cap must be at least 1".into(),
        ));
    }
    let mut last_generation = 0u64;
    let mut accepted = Vec::new();
    let mut dropped_stale = 0u64;
    let mut dropped_backpressure = 0u64;
    for event in events {
        if event.generation < last_generation {
            dropped_stale += 1;
            continue;
        }
        last_generation = event.generation;
        if accepted.len() >= cap {
            dropped_backpressure += 1;
            continue;
        }
        accepted.push(event.text.as_str());
    }
    Ok(StreamResult {
        accepted_text: accepted.concat(),
        last_generation,
        dropped_stale,
        dropped_backpressure,
    })
}

pub fn project_canonical(fixture: &CanonicalFixture) -> Result<CanonicalProjection, ShellError> {
    let (chat, messages) = decode_fixture_models(fixture)?;
    let issued_commands = issue_commands(&fixture.commands)?;
    let stream = apply_presentation_stream(&fixture.stream, fixture.stream_cap)?;
    Ok(CanonicalProjection {
        chat_id: chat.id,
        title: chat.title,
        message_ids: messages.into_iter().map(|row| row.id).collect(),
        issued_commands,
        stream,
    })
}

static SHELL_TITLE: Mutex<String> = Mutex::new(String::new());
static SHELL_COUNT: Mutex<usize> = Mutex::new(0);

fn shell_app() -> Element {
    let title = SHELL_TITLE.lock().expect("shell title").clone();
    let count = *SHELL_COUNT.lock().expect("shell count");
    rsx! {
        div {
            "data-component": "chat-workspace",
            "{title} ({count})"
        }
    }
}

/// Build a Dioxus VirtualDom from Wire view models. Not a GPU/JNI mount.
pub fn mount_virtual_dom(title: &str, message_count: usize) -> usize {
    *SHELL_TITLE.lock().expect("shell title") = title.to_string();
    *SHELL_COUNT.lock().expect("shell count") = message_count;
    let mut vdom = VirtualDom::new(shell_app);
    let mutations = vdom.rebuild_to_vec();
    mutations.edits.len()
}

pub fn expected_projection() -> CanonicalProjection {
    serde_json::from_str(EXPECTED_PROJECTION_JSON).expect("expected-projection.json")
}

pub(crate) fn message_bubble_style(user: bool, compact: bool, font_px: u32) -> String {
    // React sheet (MessageBubble.module.css `.bubble`): messages are plain
    // text over the wallpaper glass — no box, no border. Assistant text uses
    // text-secondary (#c5bbb2), user text-primary (#f3eee8). The old baked
    // bubble boxes (bg #26221f/#36221b + borders) predate the translucent
    // wallpaper design and are gone from the React sheet.
    let color = if user { "#f3eee8" } else { "#c5bbb2" };
    // `position:relative` anchors the inline message action row (React
    // `MessageBubble` header) at the bubble's top-right.
    if compact {
        format!(
            "box-sizing:border-box;position:relative;min-height:24px;margin:4px 0;padding:8px 12px;color:{color};font-size:{font_px}px;white-space:pre-wrap;overflow-wrap:break-word;border-radius:16px;background:{};border:1px solid {};",
            if user {
                "rgba(54,34,27,0.72)"
            } else {
                "rgba(38,34,31,0.72)"
            },
            if user {
                "rgba(105,76,61,0.60)"
            } else {
                "rgba(57,52,47,0.60)"
            },
        )
    } else {
        let align = if user {
            "margin-left:auto;"
        } else {
            "margin-right:auto;"
        };
        format!(
            "box-sizing:border-box;position:relative;width:fit-content;max-width:78ch;{align}margin-top:8px;margin-bottom:8px;padding:8px 12px;color:{color};font-size:{font_px}px;white-space:pre-wrap;overflow-wrap:break-word;"
        )
    }
}

fn message_action_button(
    action: &'static str,
    label: &'static str,
    icon_name: &'static str,
    message_id: &str,
) -> Element {
    rsx! {
        button {
            class: "MessageBubble_actionButton",
            r#type: "button",
            "data-action": "{action}",
            // Lets the native hit-rect snapshot resolve the owning row
            // (`SlotNode.key` = data-ui-key || data-message-id).
            "data-message-id": "{message_id}",
            "aria-label": "{label}",
            title: "{label}",
            style: "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(243,238,232,0.10);border-radius:16px;background:rgba(36,33,30,0.62);color:#c5bbb2;cursor:pointer;",
            {crate::product_shell::icon(icon_name, 16)}
        }
    }
}

/// React `ToolActivityBadge`: status copy only, no Phosphor Lightning
/// (the icon is not in the packed native set). Arguments/results never
/// reach this node.
pub(crate) fn tool_activity_badge(name: &str) -> Element {
    let label = format!("Running tool: {name}…");
    rsx! {
        div {
            class: "ToolActivityBadge_toolActivity",
            "data-component": "tool-activity",
            role: "status",
            style: "display:flex;align-items:center;gap:8px;margin:0 auto;width:100%;max-width:820px;padding:8px 0;color:#998f87;font-size:13px;",
            span { "{label}" }
        }
    }
}

fn message_row_state(view: &ProductChatView, row: &VisibleRow) -> &'static str {
    if view.streaming && row.id == "streaming" {
        "streaming"
    } else if header_row_matches(view, &row.content) {
        "match"
    } else {
        "done"
    }
}

fn header_row_matches(view: &ProductChatView, content: &str) -> bool {
    let query = view.header_search_query.trim();
    !query.is_empty() && content.to_lowercase().contains(&query.to_lowercase())
}

fn search_match_label(count: u64) -> String {
    if count == 1 {
        "1 match".into()
    } else {
        format!("{count} matches")
    }
}

fn header_search_overlay(view: &ProductChatView) -> Element {
    let query = if view.header_search_query.is_empty() {
        String::new()
    } else {
        view.header_search_query.clone()
    };
    let show_count = !view.header_search_query.trim().is_empty();
    let count_label = search_match_label(view.header_search_match_count);
    rsx! {
        div {
            class: "ChatWorkspace_chatSearch",
            "data-part": "header-search-overlay",
            style: "display:flex;align-items:center;gap:8px;min-width:0;flex:1;",
            {crate::product_shell::icon("MagnifyingGlass", 17)}
            div {
                "data-part": "header-search-input",
                "aria-label": "Search messages",
                style: "flex:1;min-width:0;height:32px;padding:0 8px;border:1px solid rgba(243,238,232,0.16);border-radius:10px;background:#1e1b18;color:#f3eee8;font-size:13px;display:flex;align-items:center;overflow:hidden;white-space:nowrap;",
                if query.is_empty() {
                    span { style: "color:#998f87;", "Search messages…" }
                } else {
                    span { "{query}" }
                }
            }
            if show_count {
                span {
                    class: "ChatWorkspace_searchMatchCount",
                    role: "status",
                    "aria-live": "polite",
                    style: "flex:none;color:#c5bbb2;font-size:12px;white-space:nowrap;",
                    "{count_label}"
                }
            }
            button {
                class: "ChatWorkspace_headerSearch",
                r#type: "button",
                "data-action": "header-search",
                "data-part": "header-search-close",
                "aria-label": "Close search",
                title: "Close search",
                style: "flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:none;border-radius:20px;background:transparent;color:#c5bbb2;",
                {crate::product_shell::icon("X", 18)}
            }
        }
    }
}

/// Inline editor body for the row being edited (React `MessageBubble`
/// editing branch): a plain-text area plus Save/Cancel. The input carries
/// `data-part="message-edit-input"` so hosts route typing into
/// `set_message_edit_draft`; the buttons are keyed message actions
/// (`message-edit-save` / `message-edit-cancel`) so the shared hit table
/// resolves their owning row.
fn message_edit_editor(view: &ProductChatView, row_id: &str) -> Element {
    let draft = view.editing_draft.clone();
    rsx! {
        div {
            style: "display:flex;flex-direction:column;gap:8px;width:100%;",
            div {
                "data-part": "message-edit-input",
                style: "box-sizing:border-box;width:100%;min-height:72px;padding:8px 10px;border:1px solid rgba(243,238,232,0.16);border-radius:10px;background:#1e1b18;color:#f3eee8;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;",
                if draft.is_empty() {
                    span { style: "color:#998f87;", "\u{00a0}" }
                } else {
                    "{draft}"
                }
            }
            div {
                style: "display:flex;gap:8px;justify-content:flex-end;",
                button {
                    class: "MessageBubble_actionButton",
                    r#type: "button",
                    "data-action": "message-edit-cancel",
                    "data-message-id": "{row_id}",
                    "aria-label": "Cancel edit",
                    style: "width:auto;padding:0 12px;height:32px;border-radius:16px;font-size:12px;color:#c5bbb2;",
                    span { "Cancel" }
                }
                button {
                    class: "MessageBubble_actionButton",
                    r#type: "button",
                    "data-action": "message-edit-save",
                    "data-message-id": "{row_id}",
                    "aria-label": "Save edit",
                    style: "width:auto;padding:0 12px;height:32px;border-radius:16px;font-size:12px;color:#f3eee8;background:#5a3b2e;",
                    span { "Save" }
                }
            }
        }
    }
}

/// Revision-history card overlay (React `MessageRevisionHistoryCard`):
/// immutable previous contents of one message, oldest first, with a Close
/// action (`message-history-close`, keyed like a message action).
fn revision_history_card(view: &ProductChatView) -> Option<Element> {
    let owner = view.history_open_for.as_deref()?;
    let items = view.revision_history.clone();
    Some(rsx! {
        div {
            class: "MessageRevisionHistoryCard_card",
            "data-component": "revision-history-card",
            "data-part": "revision-history-card",
            style: "position:absolute;left:16px;right:16px;top:12px;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;max-height:60%;padding:12px;border:1px solid rgba(243,238,232,0.14);border-radius:16px;background:rgba(21,19,17,0.94);color:#f3eee8;overflow:hidden;",
            div {
                style: "display:flex;align-items:center;gap:8px;",
                strong { style: "font-size:13px;", "Edit history" }
                button {
                    class: "MessageBubble_actionButton",
                    r#type: "button",
                    "data-action": "message-history-close",
                    "data-message-id": "{owner}",
                    "aria-label": "Close history",
                    style: "margin-left:auto;width:28px;height:28px;border-radius:14px;",
                    {crate::product_shell::icon("X", 14)}
                }
            }
            if items.is_empty() {
                p { style: "margin:0;color:#998f87;font-size:12px;", "No previous versions." }
            } else {
                div {
                    style: "display:flex;flex-direction:column;gap:6px;overflow:hidden;",
                    for item in items.iter() {
                        div {
                            "data-part": "revision-row",
                            style: "padding:8px 10px;border:1px solid rgba(243,238,232,0.10);border-radius:10px;background:rgba(36,33,30,0.62);",
                            div {
                                style: "font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:64px;overflow:hidden;",
                                "{item.content}"
                            }
                            div {
                                style: "margin-top:4px;color:#998f87;font-size:11px;",
                                {crate::product_path::format_timestamp(&item.created_at)}
                            }
                        }
                    }
                }
            }
        }
    })
}

/// Snapshots menu panel overlay (React `ChatSnapshotsMenu` panel): child
/// chats of the active chat, newest first. Rows carry
/// `data-part="snapshot-row-{id}"` — the desktop bin resolves them by
/// identity (`covers`) because custom intents carry no key payload.
fn snapshots_menu_panel(view: &ProductChatView) -> Element {
    let items = view.snapshot_items.clone();
    rsx! {
        div {
            class: "ChatSnapshotsMenu_panel",
            "data-component": "chat-snapshots-menu",
            "data-part": "snapshots-panel",
            style: "position:absolute;left:16px;right:16px;top:12px;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;max-height:60%;padding:12px;border:1px solid rgba(243,238,232,0.14);border-radius:16px;background:rgba(21,19,17,0.94);color:#f3eee8;overflow:hidden;",
            div {
                style: "display:flex;align-items:center;gap:8px;",
                strong { style: "font-size:13px;", "Chat snapshots" }
                button {
                    class: "MessageBubble_actionButton",
                    r#type: "button",
                    "data-part": "snapshots-close",
                    "aria-label": "Close snapshots",
                    style: "margin-left:auto;width:28px;height:28px;border-radius:14px;",
                    {crate::product_shell::icon("X", 14)}
                }
            }
            if items.is_empty() {
                p { style: "margin:0;color:#998f87;font-size:12px;", "No checkpoints or branches yet." }
            } else {
                div {
                    style: "display:flex;flex-direction:column;gap:6px;overflow:hidden;",
                    for item in items.iter() {
                        button {
                            class: "MessageBubble_actionButton",
                            r#type: "button",
                            "data-part": "snapshot-row-{item.id}",
                            style: "display:flex;align-items:center;gap:8px;width:100%;height:48px;border-radius:12px;padding:0 10px;text-align:left;",
                            span {
                                style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;",
                                strong { style: "font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", "{item.title}" }
                                span { style: "color:#998f87;font-size:11px;", "{item.origin_label} · {item.message_count} messages" }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Flagged Product Wire chat workspace: header glass, visible Markdown/image
/// rows, composer glass. Blitz consumes this tree; callers must not inject a
/// hand-built `NeoDisplayList`.
///
/// The `data-*` hooks and CSS module class names match React
/// `ChatWorkspace` / `ChatHeader` / `ChatComposer` / `MessageBubble` so packed
/// `product.css` and the DOM-parity dump share one contract.
pub fn product_chat_app() -> Element {
    let view = current_product_chat();
    // Blueprint-driven chrome (M2 phase 2): when a document source is
    // installed, header/viewport/composer structure comes from the authored
    // JSON; the legacy RSX below stays the fallback and the parity oracle.
    let chrome_parts = crate::scene_chat::blueprint_chrome(&view);
    let (_width, header_h, _viewport_h, composer_h) =
        crate::chrome_metrics(view.viewport_width, view.viewport_height);
    let compact = view.viewport_height <= 240;
    let font_px = if compact { 12 } else { 18 };
    let pad = if compact { 8 } else { 16 };
    let header_title = if view.character_name.is_empty() {
        view.title.clone()
    } else {
        view.character_name.clone()
    };
    // React `.workspace`: a centered column capped at the
    // `--st-size-chat-column-max` token (1080px); the wallpaper stays visible
    // on both sides. Computed in CSS px because Blitz resolves var()/min()
    // from packed sheets against this tree unreliably (see rust-ui-style-port).
    // The base is the chat main area (`column_width`), not the full window:
    // sizing against the window overflowed the column past `<main>` and
    // clipped bubbles at the window edge.
    let chat_area_w = if view.column_width > 0 {
        view.column_width
    } else {
        view.viewport_width
    };
    let chat_column_w = chat_area_w.min(1080);
    // The workspace is absolutely positioned inside the relative page with
    // explicit pixel geometry: this Blitz build mishandles auto margins and
    // percentage + margin centering once the column hits the 1080 cap (the
    // render then hugs the main area's left edge while the skeleton still
    // reports centered positions — visible as a shifted composer at wide
    // windows). Absolute left/top/width is deterministic at every size.
    let chat_margin = chat_area_w.saturating_sub(chat_column_w) / 2;
    let workspace_style = format!(
        "position:absolute;left:{chat_margin}px;top:0;box-sizing:border-box;display:flex;flex-direction:column;width:{chat_column_w}px;height:100%;min-width:0;min-height:0;background:transparent;color:#f3eee8;font-family:sans-serif;"
    );
    let page_style = "position:relative;box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;background:transparent;color:#f3eee8;font-family:sans-serif;".to_owned();
    let panel_style = format!(
        "position:relative;box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;padding:0 {pad}px;background:rgba(36,33,30,0.70);"
    );
    let header_style = format!(
        // No `z-index`: any non-auto z-index on a positioned node makes Blitz
        // hoist the subtree to its stacking-context ancestor on the FIRST
        // layout and never re-anchor it on relayout (the header kept the
        // 1424-wide coordinates after resizing to 1920 — traced via
        // NEOTA_TEXT_TRACE: paint parent_tx=440 for the header subtree vs
        // 640 for the viewport). The bands don't overlap, so stacking is
        // unnecessary in the native flow.
        "flex:none;position:relative;width:100%;height:{header_h}px;box-sizing:border-box;padding:0 {pad}px;background:rgba(36,33,30,0.82);color:#f3eee8;border-bottom:1px solid rgba(57,52,47,0.48);display:flex;align-items:center;justify-content:space-between;gap:8px;"
    );
    let viewport_style = format!(
        "flex:1 1 auto;position:relative;width:100%;min-height:0;box-sizing:border-box;overflow:hidden;background:transparent;"
    );
    let scroll_style = format!(
        "display:flex;flex-direction:column;gap:24px;box-sizing:border-box;min-height:100%;padding:{pad}px;"
    );
    let composer_color = if view.composer_text.is_empty() {
        "#998f87"
    } else {
        "#f3eee8"
    };
    let composer_style = if compact {
        format!(
            "position:relative;width:100%;height:{composer_h}px;box-sizing:border-box;padding:{pad}px;background:rgba(36,33,30,0.88);color:{composer_color};font-size:{font_px}px;"
        )
    } else {
        format!(
            "position:relative;width:100%;height:{composer_h}px;box-sizing:border-box;padding:0;overflow:hidden;border:1px solid rgba(243,238,232,0.10);border-radius:28px;background:rgba(21,19,17,0.78);color:{composer_color};font-size:{font_px}px;"
        )
    };
    let overlay = matches!(
        view.chrome,
        ProductChrome::TripleGlass | ProductChrome::PaintOrder
    );
    let nested = matches!(
        view.chrome,
        ProductChrome::NestedDialog | ProductChrome::PaintOrder
    );
    let composer_label = if view.composer_text.is_empty() {
        if view.composer_placeholder.is_empty() {
            "Message"
        } else {
            view.composer_placeholder.as_str()
        }
    } else {
        view.composer_text.as_str()
    };
    rsx! {
        section {
            class: "ChatWorkspace_page",
            "data-component": "chat-view",
            style: "{page_style}",
            div {
                class: "ChatWorkspace_wallpaper",
                "data-part": "chat-wallpaper",
                "aria-hidden": "true",
                style: "position:absolute;left:0;top:0;right:0;bottom:0;z-index:0;pointer-events:none;background:transparent;",
            }
            div {
                // No `ChatWorkspace_workspace` class: the packed sheet's
                // `margin: 0 auto` would override the explicit inline margins
                // in this Blitz build (class rules beat inline styles), and
                // the auto margin is exactly what breaks at wide windows.
                style: "{workspace_style}",
                div {
                    class: "ChatWorkspace_chatPanel",
                    style: "{panel_style}",
                    "data-component": "chat-panel",
                    if let Some(parts) = &chrome_parts {
                        {parts.header.clone()}
                    } else {
                    div {
                        class: "ChatWorkspace_chatHeader neoui-glass",
                        "data-neoui": "glass",
                        "data-slot": "chat.header",
                        role: "banner",
                        style: "{header_style}",
                        if view.header_search_open {
                            {header_search_overlay(&view)}
                        } else {
                            div {
                                class: "ChatWorkspace_chatIdentity",
                                "data-part": "character-identity",
                                style: "display:flex;align-items:center;gap:8px;min-width:0;flex:1;",
                                if !view.character_avatar_asset.is_empty() {
                                    span {
                                        class: "ChatWorkspace_headerAvatar",
                                        "data-part": "character-avatar",
                                        "aria-hidden": "true",
                                        style: "flex:none;width:32px;height:32px;border-radius:16px;overflow:hidden;background:#302c28;",
                                        span {
                                            "data-part": "avatar-fallback",
                                            "data-avatar-asset": "{view.character_avatar_asset}",
                                            class: "headerAvatar",
                                            style: "display:block;width:32px;height:32px;border-radius:16px;background:#302c28;",
                                        }
                                    }
                                }
                                h1 {
                                    style: "margin:0;overflow:hidden;min-width:0;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap;color:#f3eee8;",
                                    "{header_title}"
                                }
                            }
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
                            button {
                                class: "ChatWorkspace_headerSearch",
                                r#type: "button",
                                // Custom intents render verbatim through the
                                // shared hit table; the desktop bin routes this
                                // one to `toggle_snapshots_menu`.
                                "data-action": "custom.chat.snapshots-menu",
                                "data-part": "snapshots-trigger",
                                "aria-label": "Chat snapshots",
                                title: "Chat snapshots",
                                style: "flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:none;border-radius:20px;background:transparent;color:#c5bbb2;",
                                {crate::product_shell::icon("GitBranch", 17)}
                            }
                            if nested {
                                div {
                                    class: "neoui-glass",
                                    "data-neoui": "glass",
                                    "data-part": "dialog",
                                    style: "position:absolute;left:48px;top:4px;width:160px;height:28px;background:#302c28;"
                                }
                            }
                        }
                    }
                    }
                    if let Some(parts) = &chrome_parts {
                        {parts.viewport.clone()}
                        // Interactive overlays are session-state driven and
                        // not covered by authored documents yet: the card
                        // renders above the blueprint viewport (same contract
                        // as the legacy path).
                        if view.history_open_for.is_some() {
                            {revision_history_card(&view)}
                        }
                        if view.snapshots_menu_open {
                            {snapshots_menu_panel(&view)}
                        }
                    } else {
                    div {
                        class: "ChatWorkspace_viewport",
                        "data-component": "chat-viewport",
                        "data-part": "canvas",
                        "data-region": "chat-viewport",
                        role: "list",
                        "aria-label": "Chat messages",
                        "data-state": if view.streaming { "streaming" } else { "idle" },
                        style: "{viewport_style}",
                        if view.history_open_for.is_some() {
                            {revision_history_card(&view)}
                        },
                        if view.snapshots_menu_open {
                            {snapshots_menu_panel(&view)}
                        },
                        div {
                            class: "ChatWorkspace_scrollBody",
                            "data-part": "chat-scroll",
                            style: "{scroll_style}",
                            // React `ChatPage` renders the virtualized rows
                            // inside a `data-component="chat-message-list"`
                            // canvas; the native surface publishes the same
                            // hook so themes can target both identically.
                            div {
                                class: "ChatPage_messageCanvas",
                                "data-component": "chat-message-list",
                                style: "display:flex;flex-direction:column;gap:24px;min-height:0;",
                            for row in view.visible.iter() {
                                { rsx! {
                                if row.id == "streaming" {
                                    if let Some(name) = view.tool_activity_name.as_deref() {
                                        {tool_activity_badge(name)}
                                    }
                                }
                                article {
                                    class: if row.role == "user" { "MessageBubble_rowUser" } else { "MessageBubble_rowAssistant" },
                                    "data-component": "chat-message",
                                    "data-role": "{row.role}",
                                    "data-state": message_row_state(&view, row),
                                    "data-excluded": if row.manual_excluded { "true" } else { "false" },
                                    "data-format": "markdown",
                                    "data-message-id": "{row.id}",
                                    role: "listitem",
                                    "aria-label": "{row.author}",
                                    style: message_bubble_style(row.role == "user", compact, font_px),
                                    header {
                                        class: "MessageBubble_messageHeader",
                                        "data-part": "message-header",
                                        style: "display:flex;align-items:center;width:100%;gap:8px;margin-bottom:4px;",
                                        span {
                                            class: "MessageBubble_avatar",
                                            "data-part": "message-avatar",
                                            "data-state": if !view.character_avatar_asset.is_empty() && row.role == "assistant" { "image" } else { "fallback" },
                                            "aria-hidden": "true",
                                            style: "flex:none;width:36px;height:36px;border-radius:18px;overflow:hidden;background:#492a20;",
                                            if !view.character_avatar_asset.is_empty() && row.role == "assistant" {
                                                span {
                                                    "data-part": "avatar-fallback",
                                                    "data-avatar-asset": "{view.character_avatar_asset}",
                                                    class: "messageAvatar",
                                                    style: "display:block;width:36px;height:36px;border-radius:18px;background:#302c28;",
                                                }
                                            }
                                        }
                                        span {
                                            class: "MessageBubble_identity",
                                            "data-part": "message-identity",
                                            style: "display:flex;align-items:baseline;gap:8px;min-width:0;",
                                            span {
                                                class: "MessageBubble_author",
                                                "data-part": "message-author",
                                                style: "color:#f3eee8;font-size:13px;font-weight:700;",
                                                "{row.author}"
                                            }
                                            if !row.timestamp.is_empty() {
                                                span {
                                                    class: "MessageBubble_timestamp",
                                                    "data-part": "message-timestamp",
                                                    style: "overflow:hidden;color:#998f87;font-size:12px;text-overflow:ellipsis;white-space:nowrap;",
                                                    "{row.timestamp}"
                                                }
                                            }
                                        }
                                        div {
                                            class: "MessageBubble_actionBar",
                                            "data-component": "message-action-bar",
                                            "data-part": "message-actions-inline",
                                            "data-state": "idle",
                                            style: "display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-left:auto;",
                                            {if row.manual_excluded {
                                                message_action_button("context", "Include in prompt context", "Eye", &row.id)
                                            } else {
                                                message_action_button("context", "Exclude from prompt context", "EyeSlash", &row.id)
                                            }}
                                            {message_action_button("edit", "Edit message", "PencilSimple", &row.id)}
                                            {message_action_button("copy", "Copy", "Copy", &row.id)}
                                            {message_action_button("checkpoint", "Checkpoint", "Flag", &row.id)}
                                            {message_action_button("branch", "Branch", "GitBranch", &row.id)}
                                            if row.checkpoint_chat_id.is_some() {
                                                {message_action_button("delete-checkpoint", "Remove checkpoint", "Flag", &row.id)}
                                            }
                                            {message_action_button("delete", "Delete message", "Trash", &row.id)}
                                            {message_action_button("rollback", "Rollback to here", "ArrowUUpLeft", &row.id)}
                                            {message_action_button("history", "Edit history", "ClockCounterClockwise", &row.id)}
                                            if row.run_id.is_some() {
                                                {message_action_button("prompt", "View prompt plan", "BookOpenText", &row.id)}
                                                {message_action_button("steps", "View run steps", "List", &row.id)}
                                            }
                                        }
                                    }
                                    div {
                                        class: "MessageBubble_content",
                                        "data-part": "message-content",
                                        div {
                                            class: "MessageBubble_messageFrame",
                                            "data-part": "message-frame",
                                            // Explicit width: the packed
                                            // `.rowUser .bubble` sheet uses
                                            // `margin-left:auto`, which Blitz
                                            // resolves against the wrong
                                            // containing block and collapses
                                            // the body to a sliver on user
                                            // rows.
                                                div {
                                                    class: "MessageBubble_bubble",
                                                    "data-part": "message-body",
                                                    style: "position:relative;width:100%;box-sizing:border-box;",
                                                    if Some(row.id.as_str()) == view.editing_message_id.as_deref() {
                                                        {message_edit_editor(&view, &row.id)}
                                                    } else {
                                                        {crate::markdown::message_markdown(&row.content, view.streaming && row.id == "streaming")}
                                                    }
                                                }
                                            // Assistant avatar art (React
                                            // `.messageArt`); hidden on the
                                            // desktop sheet, present for themes.
                                            if row.role == "assistant" && !view.character_avatar_asset.is_empty() {
                                                span {
                                                    class: "MessageBubble_messageArt",
                                                    "data-part": "message-art",
                                                    "aria-hidden": "true",
                                                    style: "display:none;",
                                                }
                                            }
                                        }
                                    }
                                    if row.role == "assistant" && !compact {
                                        div {
                                            // No `MessageBubble_versionControls`
                                            // class on purpose: the packed
                                            // sheet right-aligns
                                            // `[data-component='message-swipe-pager']`
                                            // via an auto margin that Blitz
                                            // resolves against the wrong
                                            // containing block.
                                            "data-component": "message-version-controls",
                                            "data-part": "message-version-controls",
                                            style: "display:flex;align-items:center;gap:8px;margin-top:8px;",
                                            // No `MessageBubble_versionQuickActions`
                                            // class either: the packed sheet
                                            // hides every `span` inside it,
                                            // and the native icon glyphs are
                                            // spans (`nt-icon`) Р Р†Р вЂљРІР‚Сњ the pills
                                            // would render empty.
                                            div {
                                                "data-part": "message-version-actions",
                                                style: "display:flex;align-items:center;gap:8px;",
                                                button {
                                                    class: "MessageBubble_actionButton",
                                                    r#type: "button",
                                                    "data-action": "history",
                                                    "aria-label": "Revision history",
                                                    title: "Revision history",
                                                    style: "display:flex;align-items:center;justify-content:center;gap:4px;width:32px;height:32px;border-radius:16px;border:1px solid rgba(57,52,47,0.70);background:rgba(36,33,30,0.70);color:#998f87;",
                                                    {crate::product_shell::icon("ClockCounterClockwise", 14)}
                                                }
                                                button {
                                                    class: "MessageBubble_actionButton",
                                                    r#type: "button",
                                                    "data-action": "regenerate",
                                                    "aria-label": "Regenerate",
                                                    title: "Regenerate",
                                                    style: "display:flex;align-items:center;justify-content:center;gap:4px;width:32px;height:32px;border-radius:16px;border:1px solid rgba(57,52,47,0.70);background:rgba(36,33,30,0.70);color:#998f87;",
                                                    {crate::product_shell::icon("ArrowCounterClockwise", 14)}
                                                }
                                            }
                                            // React `MessageSwipePager`: the
                                            // swipe pair lives in its own
                                            // `data-component` container.
                                            // Inline styles only Р Р†Р вЂљРІР‚Сњ the packed
                                            // `.pager` sheet carries a logical
                                            // auto-margin that Blitz resolves
                                            // against the wrong containing
                                            // block and pushes the pager off
                                            // the panel.
                                            div {
                                                "data-component": "message-swipe-pager",
                                                "data-part": "message-swipes",
                                                style: "display:flex;align-items:center;gap:4px;",
                                                button {
                                                    class: "MessageBubble_actionButton",
                                                    r#type: "button",
                                                    "data-action": "swipe-previous",
                                                    "aria-label": "Previous variant",
                                                    style: "width:32px;height:32px;border-radius:16px;border:1px solid rgba(57,52,47,0.70);background:rgba(36,33,30,0.70);color:#998f87;display:flex;align-items:center;justify-content:center;",
                                                    {crate::product_shell::icon("CaretLeft", 14)}
                                                }
                                                span {
                                                    "aria-live": "polite",
                                                    style: "color:#998f87;font-size:12px;",
                                                }
                                                button {
                                                    class: "MessageBubble_actionButton",
                                                    r#type: "button",
                                                    "data-action": "swipe-next",
                                                    "aria-label": "Next variant",
                                                    style: "width:32px;height:32px;border-radius:16px;border:1px solid rgba(57,52,47,0.70);background:rgba(36,33,30,0.70);color:#998f87;display:flex;align-items:center;justify-content:center;",
                                                    {crate::product_shell::icon("CaretRight", 14)}
                                                }
                                            }
                                        }
                                    }
                                }
                                } }
                            }
                            if view.tool_activity_name.is_some()
                                && !view.visible.iter().any(|row| row.id == "streaming")
                            {
                                {tool_activity_badge(view.tool_activity_name.as_deref().unwrap_or("tool"))}
                            }
                            }
                        }
                    }
                    }
                    // Composer sits AFTER the viewport as a flex sibling (the
                    // packed Blitz sheet models the same bands): the native
                    // surface materializes row windows from the canvas top, so
                    // a composer inside the scrolling subtree always ended up
                    // painted over the newest message. React keeps it inside
                    // via position:sticky, which Blitz cannot express.
                    div {
                        class: "ChatWorkspace_composerWrapper",
                        "data-part": "composer-sticky",
                            style: "flex:none;box-sizing:border-box;width:100%;padding:0 {pad}px {pad}px;",
                            if let Some(code) = view.error_code.as_deref() {
                                div {
                                    "data-part": "error",
                                    role: "alert",
                                    style: "padding:0 0 8px;color:#f2b8b5;font-size:{font_px}px;",
                                    "{code}"
                                }
                            }
                            // Blueprint-driven composer (M2 phase 2): when a
                            // document source is installed, structure comes
                            // from the authored JSON; the legacy RSX below
                            // stays the fallback and the parity oracle.
                            if let Some(parts) = &chrome_parts {
                                {parts.composer.clone()}
                            } else {
                            div {
                                class: "ChatWorkspace_composer neoui-glass",
                                "data-neoui": "glass",
                                role: "region",
                                "aria-label": "Message composer",
                                "data-state": if view.streaming { "streaming" } else { "idle" },
                                "data-slot": "chat.composer",
                                style: "{composer_style}",
                                if compact {
                                    "{composer_label}"
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
                                } else {
                                    div {
                                        class: "ChatWorkspace_composerToolbar",
                                        "data-part": "toolbar",
                                        style: "display:flex;align-items:center;justify-content:space-between;width:100%;height:42px;padding:0 16px;box-sizing:border-box;border-bottom:1px solid rgba(243,238,232,0.08);",
                                        div {
                                            class: "ChatWorkspace_toolbarActions",
                                            style: "display:flex;align-items:center;gap:4px;",
                                            button {
                                                class: "ChatWorkspace_menuButton",
                                                r#type: "button",
                                                "data-action": "composer-settings",
                                                "aria-label": "Settings",
                                                title: "Settings",
                                                style: "display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid rgba(243,238,232,0.10);border-radius:16px;color:#c5bbb2;background:rgba(243,238,232,0.05);",
                                                {crate::product_shell::icon("GearSix", 15)}
                                                span { style: "font-size:13px;", "Settings" }
                                            }
                                            button {
                                                class: "ChatWorkspace_iconButton",
                                                r#type: "button",
                                                "data-action": "composer-reset",
                                                "aria-label": "Reset",
                                                title: "Reset",
                                                style: "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;border-radius:16px;background:transparent;color:#998f87;",
                                                {crate::product_shell::icon("X", 17)}
                                            }
                                        }
                                        button {
                                            class: "ChatWorkspace_contextTrigger",
                                            r#type: "button",
                                            "data-action": "composer-context",
                                            "aria-label": "Context",
                                            title: "Context 4%",
                                            style: "display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid rgba(243,238,232,0.10);border-radius:16px;color:#c5bbb2;background:rgba(243,238,232,0.05);",
                                            {crate::product_shell::icon("Database", 15)}
                                            span { style: "font-size:13px;", "4%" }
                                        }
                                    }
                                    {crate::scene_chat::render_context_panel_slot(
                                        view.context_panel_open,
                                        view.context_summary.as_ref(),
                                    )}
                                    div {
                                        class: "ChatWorkspace_composerField",
                                        "data-part": "field",
                                        style: "display:flex;flex-direction:column;flex:1;min-height:0;padding:12px 16px 8px;box-sizing:border-box;background:rgba(36,33,30,0.55);",
                                        div {
                                            "data-component": "textarea",
                                            style: "flex:1;min-height:48px;color:{composer_color};font-size:16px;line-height:1.4;",
                                            "{composer_label}"
                                        }
                                        div {
                                            "data-part": "composer-actions",
                                            // React `.composerActions` uses
                                            // `justify-content:flex-end`, but
                                            // this Blitz/Taffy build misplaces
                                            // items when justify-content is
                                            // combined with the sibling's
                                            // `margin-inline-end:auto`
                                            // (`ChatWorkspace_composerUtilities`):
                                            // free space is distributed twice
                                            // and the Send button lands ~385px
                                            // past the row. `flex-start` plus
                                            // the auto margin produces the same
                                            // visual (utils left, Send right);
                                            // probe: presentation-m0-d2
                                            // examples/send_layout_probe.rs.
                                            // The packed `.composerActions`
                                            // class is deliberately NOT applied
                                            // (class rules beat the inline
                                            // workaround in this Blitz build,
                                            // and the flex-end re-breaks wide
                                            // columns) — `data-part` keeps the
                                            // theme contract.
                                            style: "display:flex;align-items:center;justify-content:flex-start;gap:12px;margin-top:8px;",
                                            div {
                                                "data-part": "composer-utilities",
                                                // `margin-right:auto` replaces
                                                // the packed
                                                // `.ChatWorkspace_composerUtilities`
                                                // rule for the same reason as
                                                // above: with the class gone
                                                // from the row, the auto margin
                                                // must live inline to push Send
                                                // to the right edge.
                                                style: "display:flex;align-items:center;gap:4px;margin-right:auto;",
                                                button {
                                                    r#type: "button",
                                                    "data-action": "composer-settings",
                                                    "aria-label": "Settings",
                                                    style: "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:#998f87;",
                                                    {crate::product_shell::icon("List", 19)}
                                                }
                                                button {
                                                    r#type: "button",
                                                    "data-action": "scroll-latest",
                                                    "aria-label": "Scroll to latest",
                                                    style: "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:#998f87;",
                                                    {crate::product_shell::icon("ArrowDown", 19)}
                                                }
                                                button {
                                                    r#type: "button",
                                                    "data-action": "composer-reset",
                                                    "aria-label": "Reset",
                                                    style: "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:#998f87;",
                                                    {crate::product_shell::icon("MagicWand", 19)}
                                                }
                                            }
                                            button {
                                                class: "st-button",
                                                r#type: "button",
                                                "data-component": "button",
                                                "data-variant": "primary",
                                                "data-size": "md",
                                                "data-action": "send",
                                                "aria-label": "Send",
                                                title: "Send",
                                                style: "display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:44px;padding:4px 16px;border:none;border-radius:10px;color:#2a130b;background:#e38a62;font-size:13px;font-weight:500;",
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
                                }
                            }
                            }
                        }
                    }
                }
            if overlay {
                div {
                    class: "neoui-glass",
                    "data-neoui": "glass",
                    "data-part": "overlay",
                    style: "position:absolute;left:240px;top:8px;width:72px;height:24px;background:#3a4a60;"
                }
            }
        }
    }
}

pub fn mount_product_chat(view: ProductChatView) -> usize {
    install_product_chat(view);
    let mut vdom = VirtualDom::new(product_chat_app);
    let mutations = vdom.rebuild_to_vec();
    mutations.edits.len()
}
