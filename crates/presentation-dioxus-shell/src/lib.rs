//! Feature-flagged Dioxus Product Wire shell (Milestone A).
//!
//! Not production JNI. Not `MainActivity`. Does not import Kernel, storage,
//! or network crates.

use contracts_generated::generated::{decode_chat_dto, decode_message_dto, ChatDto, MessageDto};
use dioxus_core::{Element, VirtualDom};
use dioxus_core_macro::rsx;
use serde::Deserialize;
use std::collections::HashSet;

mod ai_settings_tab;
mod backgrounds_tab;
mod chat_route;
mod chats_tab;

pub use chats_tab::chats_layout;
mod lorebooks_tab;
mod markdown;
mod personas_tab;
mod plugins_tab;
mod product_path;
mod product_shell;
mod scene_chat;
mod settings_tab;

/// URL scheme for locally resolved image assets: `<img src="asset:{id}">`.
/// The m0-d2 `LocalNetProvider` resolves these hrefs against the process
/// asset store, so images paint in-scene (z-order/clip/opacity for free).
/// Single source of truth — the producer seam re-exports this constant.
pub const ASSET_URL_PREFIX: &str = "asset:";

pub use chat_route::{chat_route_line, flagged_chat_route, ChatRouteReport};
pub use markdown::{
    asset_image_refs, contains_part, message_markdown, parse_document, parse_inline, Block, Inline,
};
pub use neotavern_presentation_blueprint::v1::{ContextUsageBreakdownV1, ContextUsageSummaryV1};
pub use neotavern_presentation_design_system::SafeAreaInsets;
pub use neotavern_presentation_design_system::{
    builtin_theme_tokens, parse_theme_tokens_from_manifest, render_theme_stylesheet,
    resolve_theme_tokens, ThemeTokens,
};
pub use product_path::{
    chrome_metrics, current_product_chat, format_timestamp, install_product_chat, message_id,
    mixed_height, mixed_height_catalog, product_chat_from_fixture, product_chat_with_chrome,
    streaming_schedule, visible_rows, ProductChatView, ProductChrome, RevisionRow, RowKind,
    SnapshotItemView, VariantRowView, VisibleRow, PRODUCT_PATH_CHAT_ID, PRODUCT_PATH_ITEMS,
    PRODUCT_PATH_VISIBLE,
};
pub use product_shell::{
    character_card_description, character_manager_title, current_product_shell, ellipsize_css,
    install_product_shell, lorebook_card_description, panel_header_title, persona_card_description,
    product_shell_app, BackupCardView, CharacterCardView, CharacterDraftView, ChatCardView,
    LorebookCardView, LorebookEntryCardView, MemoryCardView, PersonaCardView, PluginCardView,
    PresetCardView, PresetValueRow, ProductShellView, ProfileCardView, PromptBlockView,
    ProviderCardView, ProviderConfigCardView, RunStepView, ThemeCardView, ToolCardView,
    AI_SETTINGS_TITLE, BACKGROUNDS_MANAGER_TITLE, CHARACTER_MANAGER_TITLE, CHATS_MANAGER_TITLE,
    LOREBOOK_MANAGER_TITLE, PERSONA_MANAGER_TITLE, PLUGINS_MANAGER_TITLE, SETTINGS_TITLE,
};
pub use scene_chat::{
    chat_blueprint_file_changed, chat_wallpaper_mode, set_chat_blueprint_source,
    set_chat_wallpaper_mode, ChatBlueprintSource,
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

/// Props for the canonical-projection smoke component (B2: the former
/// `SHELL_TITLE`/`SHELL_COUNT` process globals became a plain parameter, so
/// concurrent mounts cannot leak state into each other).
#[derive(Clone)]
struct ShellProbeProps {
    title: String,
    count: usize,
}

fn shell_app(props: ShellProbeProps) -> Element {
    rsx! {
        div {
            "data-component": "chat-workspace",
            "{props.title} ({props.count})"
        }
    }
}

/// Build a Dioxus VirtualDom from Wire view models. Not a GPU/JNI mount.
pub fn mount_virtual_dom(title: &str, message_count: usize) -> usize {
    let mut vdom = VirtualDom::new_with_props(
        shell_app,
        ShellProbeProps {
            title: title.to_string(),
            count: message_count,
        },
    );
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
    hover_target: Option<&str>,
) -> Element {
    // React `.MessageBubble_actionButton:hover` — color #f3eee8 over
    // background #302c28 (G5; pseudo-classes do not exist in this Blitz
    // build, so the host resolves the hover target from the same hit-rect
    // snapshot the tap capture uses).
    let hovered = hover_target == Some(&format!("{action}:{message_id}"));
    let style = if hovered {
        "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(243,238,232,0.10);border-radius:16px;background:#302c28;color:#f3eee8;cursor:pointer;"
    } else {
        "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(243,238,232,0.10);border-radius:16px;background:rgba(36,33,30,0.62);color:#c5bbb2;cursor:pointer;"
    };
    rsx! {
        button {
            class: "MessageBubble_actionButton",
            r#type: "button",
            "data-action": "{action}",
            "data-state": if hovered { "hover" } else { "idle" },
            // Lets the native hit-rect snapshot resolve the owning row
            // (`SlotNode.key` = data-ui-key || data-message-id).
            "data-message-id": "{message_id}",
            "aria-label": "{label}",
            title: "{label}",
            style: style,
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
    // React `.chatSearch` (ChatWorkspace): muted icons/count, a borderless
    // transparent input at `--st-control-height-xs` 36px, match count muted
    // 13px. The close button shares the header ghost hover (G5).
    let close_hover = view.hover_target.as_deref() == Some("header-search:-");
    rsx! {
        div {
            class: "ChatWorkspace_chatSearch",
            "data-part": "header-search-overlay",
            style: "display:flex;align-items:center;gap:8px;min-width:0;flex:1;color:#998f87;",
            {crate::product_shell::icon("MagnifyingGlass", 17)}
            div {
                "data-part": "header-search-input",
                "aria-label": "Search messages",
                style: "flex:1;min-width:0;height:36px;padding:0;border:0;background:transparent;color:#f3eee8;font-size:16px;display:flex;align-items:center;overflow:hidden;white-space:nowrap;",
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
                    style: "flex:none;color:#998f87;font-size:13px;white-space:nowrap;",
                    "{count_label}"
                }
            }
            button {
                class: "ChatWorkspace_headerSearch",
                r#type: "button",
                "data-action": "header-search",
                "data-part": "header-search-close",
                "data-state": if close_hover { "hover" } else { "idle" },
                "aria-label": "Close search",
                title: "Close search",
                style: if close_hover {
                    "flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:none;border-radius:20px;background:rgba(33,27,23,0.07);color:#f3eee8;"
                } else {
                    "flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:none;border-radius:20px;background:transparent;color:#c5bbb2;"
                },
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
    // React `.editor` (MessageBubble): the card itself is the surface
    // (surface-secondary 72% + inverse-10% border + radius-card + inset
    // highlight), the textarea is transparent inside, `--st-textarea-
    // min-height` 96px. Save disables at an empty draft (opacity .45).
    let save_disabled = draft.trim().is_empty();
    let hover = view.hover_target.as_deref();
    let ghost_idle = "display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;gap:4px;padding:0 8px;border:1px solid rgba(33,27,23,0.1);border-radius:999px;color:#c5bbb2;background:rgba(36,33,30,0.62);cursor:pointer;";
    let ghost_hover = "display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;gap:4px;padding:0 8px;border:1px solid rgba(33,27,23,0.1);border-radius:999px;color:#f3eee8;background:#302c28;cursor:pointer;";
    rsx! {
        div {
            style: "display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box;padding:12px;border:1px solid rgba(33,27,23,0.1);border-radius:16px;background:rgba(36,33,30,0.72);box-shadow:inset 0 1px 0 rgba(33,27,23,0.08);",
            div {
                "data-part": "message-edit-input",
                style: "box-sizing:border-box;width:100%;min-height:96px;padding:0;border:0;background:transparent;color:#f3eee8;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;",
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
                    "data-state": if hover == Some(&format!("message-edit-cancel:{row_id}")) { "hover" } else { "idle" },
                    "aria-label": "Cancel edit",
                    style: if hover == Some(&format!("message-edit-cancel:{row_id}")) { ghost_hover } else { ghost_idle },
                    {crate::product_shell::icon("X", 15)}
                    span { "Cancel" }
                }
                button {
                    class: "MessageBubble_actionButton",
                    r#type: "button",
                    "data-action": "message-edit-save",
                    "data-message-id": "{row_id}",
                    "data-state": if save_disabled { "disabled" } else if hover == Some(&format!("message-edit-save:{row_id}")) { "hover" } else { "idle" },
                    "aria-label": "Save edit",
                    style: if save_disabled {
                        "display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;gap:4px;padding:0 8px;border:1px solid rgba(33,27,23,0.1);border-radius:999px;color:#c5bbb2;background:rgba(36,33,30,0.62);opacity:0.45;cursor:not-allowed;"
                    } else if hover == Some(&format!("message-edit-save:{row_id}")) { ghost_hover } else { ghost_idle },
                    {crate::product_shell::icon("Check", 15)}
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
            style: "position:absolute;left:50%;transform:translateX(-50%);top:12px;z-index:30;box-sizing:border-box;width:min(560px,calc(100% - 16px));display:flex;flex-direction:column;gap:8px;max-height:85%;padding:24px;border:1px solid #39342f;border-radius:20px;background:#292522;color:#f3eee8;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.58);",
            div {
                style: "display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:12px;",
                strong { style: "font-size:20px;font-weight:600;color:#f3eee8;", "Revision history" }
                button {
                    class: "MessageBubble_actionButton",
                    r#type: "button",
                    "data-action": "message-history-close",
                    "data-message-id": "{owner}",
                    "aria-label": "Close history",
                    style: "display:inline-grid;place-items:center;width:44px;height:44px;padding:0;border:1px solid #39342f;border-radius:10px;background:#24211e;color:#c5bbb2;cursor:pointer;",
                    {crate::product_shell::icon("X", 14)}
                }
            }
            if items.is_empty() {
                p { style: "margin:0;padding:12px;color:#998f87;font-size:13px;text-align:center;", "No previous versions." }
            } else {
                div {
                    style: "display:flex;flex-direction:column;gap:8px;overflow:hidden;",
                    for item in items.iter() {
                        div {
                            "data-part": "revision-row",
                            style: "padding:12px;border:1px solid #39342f;border-radius:16px;background:#24211e;",
                            div {
                                style: "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;",
                                time {
                                    style: "color:#998f87;font-size:12px;text-align:end;",
                                    {crate::product_path::format_timestamp(&item.created_at)}
                                }
                            }
                            div {
                                style: "color:#c5bbb2;font-size:13px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;max-height:87px;overflow:hidden;",
                                "{item.content}"
                            }
                        }
                    }
                }
            }
        }
    })
}

/// Snapshots menu panel overlay (React `ChatSnapshotsMenu` panel, G3
/// parity). Visual contract resolved from the dark-sheet tokens the React
/// panel consumes: `--st-color-surface-elevated` #292522, `--st-color-border`
/// #39342f, `--st-radius-control` 10px, `--st-space-2xs` 2px gap/padding,
/// muted copy #998f87, overlay shadow. React anchors the panel right under
/// the header trigger; the native overlay lives in the viewport wrapper, so
/// it anchors to the viewport's right edge (the trigger's right edge).
/// React closes on outside press / Escape / trigger toggle; the host
/// implements the outside press and the trigger toggle — Escape stays a
/// documented native gap (no keyboard overlay wiring yet).
fn snapshots_menu_panel(view: &ProductChatView) -> Element {
    let hover = view.hover_target.as_deref();
    let items = view.snapshot_items.clone();
    rsx! {
        div {
            class: "ChatSnapshotsMenu_panel",
            "data-component": "chat-snapshots-menu",
            "data-part": "snapshots-panel",
            style: "position:absolute;top:12px;right:16px;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:320px;max-width:calc(100% - 16px);max-height:min(360px,60%);padding:2px;overflow-y:auto;border:1px solid #39342f;border-radius:10px;background:#292522;color:#f3eee8;box-shadow:0 24px 64px rgba(0,0,0,0.58);",
            div {
                "data-part": "snapshots-title",
                style: "padding:0 2px;color:#998f87;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;",
                "Snapshots of this chat"
            }
            if items.is_empty() {
                p {
                    "data-part": "snapshots-state",
                    style: "margin:0;padding:10px;color:#998f87;font-size:13px;",
                    {"No snapshots yet. Use \"Roll back\" or \"Checkpoint\" on a message to create one."}
                }
            } else {
                div {
                    "data-part": "snapshots-list",
                    style: "display:flex;flex-direction:column;gap:2px;",
                    for item in items.iter() {
                        {snapshot_row(item, hover)}
                    }
                }
            }
        }
    }
}

/// One snapshots-menu row (React `.item` / `.itemTitle` / `.itemMeta`): a
/// two-line column — ellipsized title, then origin badge left and message
/// count right. The row navigates to the child chat (`data-action=
/// "open-snapshot"` + `data-message-id` = chat id) exactly like the React
/// row's `navigate(/chats/{id})`; hover follows the shared G5 contract.
fn snapshot_row(item: &SnapshotItemView, hover: Option<&str>) -> Element {
    let hovered = hover == Some(&format!("open-snapshot:{}", item.id));
    let count_word = if item.message_count == 1 {
        "message"
    } else {
        "messages"
    };
    let style = if hovered {
        "display:flex;flex-direction:column;align-items:stretch;gap:2px;width:100%;padding:4px 8px;border:1px solid transparent;border-radius:4px;background:rgba(33,27,23,0.07);color:#f3eee8;text-align:left;cursor:pointer;"
    } else {
        "display:flex;flex-direction:column;align-items:stretch;gap:2px;width:100%;padding:4px 8px;border:1px solid transparent;border-radius:4px;background:transparent;color:#f3eee8;text-align:left;cursor:pointer;"
    };
    rsx! {
        button {
            class: "ChatSnapshotsMenu_item",
            r#type: "button",
            "data-action": "open-snapshot",
            "data-state": if hovered { "hover" } else { "idle" },
            "data-message-id": "{item.id}",
            "data-part": "snapshot-row-{item.id}",
            "aria-label": "Open {item.title}",
            title: "{item.title}",
            style: style,
            span {
                "data-part": "snapshot-item-title",
                style: "overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap;",
                "{item.title}"
            }
            span {
                "data-part": "snapshot-item-meta",
                style: "display:flex;align-items:center;justify-content:space-between;gap:8px;color:#998f87;font-size:12px;",
                span { "data-part": "snapshot-origin", "{item.origin_label}" }
                span { "data-part": "snapshot-count", "{item.message_count} {count_word}" }
            }
        }
    }
}

/// Variant picker popover overlay (React `MessageVariantPicker` listbox, G3
/// parity): the lazily fetched stored variants plus the active content row.
/// Visual contract resolved from the dark-sheet tokens the popover consumes:
/// `--st-color-surface-overlay` #292522, border `color-mix(border 60%)` =
/// rgba(57,52,47,0.6), `--st-radius-control` 10px, `--st-space-xs` 4px
/// padding / `--st-space-2xs` 2px gap, min-width 260px, overlay shadow.
/// React closes on outside press / Escape / trigger toggle — the host
/// implements the outside press and the trigger toggle (input.rs). Rows
/// carry `data-action="swipe-pick"` with the variant id as `data-ui-key`;
/// the popover root keys the owner message (`data-message-id`). Loading
/// state (query disabled) renders nothing, like the React popover before
/// the query resolves.
fn variant_picker_popover(view: &ProductChatView) -> Option<Element> {
    let owner = view.variant_picker_for.as_deref()?;
    let hover = view.hover_target.as_deref();
    let rows = view.variant_picker_rows.clone();
    Some(rsx! {
        div {
            class: "MessageVariantPicker_popover",
            "data-component": "message-variant-picker",
            "data-part": "swipe-picker-popover",
            role: "listbox",
            "aria-label": "Variants",
            "data-message-id": "{owner}",
            style: "position:absolute;top:12px;right:16px;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;min-width:260px;max-width:calc(100% - 16px);max-height:min(280px,60%);padding:4px;overflow-y:auto;border:1px solid rgba(57,52,47,0.6);border-radius:10px;background:#292522;color:#f3eee8;box-shadow:0 24px 64px rgba(0,0,0,0.58);",
            if rows.is_empty() && view.variant_picker_empty {
                div {
                    "data-part": "swipe-picker-empty",
                    style: "padding:8px;color:#998f87;font-size:13px;",
                    "No other variants"
                }
            } else {
                for item in rows.iter() {
                    {variant_row(item, hover)}
                }
            }
        }
    })
}

/// One variant-picker row (React `.popover button` grid): muted tabular
/// index label, then a single-line ellipsized content preview. React paints
/// the active row with `--st-color-accent-soft` #492a20; the G5 hover target
/// paints `--st-color-surface-tertiary` #302c28 — never over the active row
/// (the React attribute selector outranks `:hover`).
fn variant_row(item: &VariantRowView, hover: Option<&str>) -> Element {
    let active = item.active;
    let hovered = !active && hover == Some(&format!("swipe-pick:{}", item.id));
    let style = if active {
        "display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;width:100%;padding:8px;border:0;border-radius:10px;color:#f3eee8;background:#492a20;font-size:13px;text-align:left;cursor:pointer;"
    } else if hovered {
        "display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;width:100%;padding:8px;border:0;border-radius:10px;color:#f3eee8;background:#302c28;font-size:13px;text-align:left;cursor:pointer;"
    } else {
        "display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;width:100%;padding:8px;border:0;border-radius:10px;color:#c5bbb2;background:transparent;font-size:13px;text-align:left;cursor:pointer;"
    };
    rsx! {
        button {
            class: "MessageVariantPicker_option",
            r#type: "button",
            role: "option",
            "data-action": "swipe-pick",
            "data-state": if active { "active" } else if hovered { "hover" } else { "idle" },
            "data-ui-key": "{item.id}",
            "data-part": "swipe-row-{item.id}",
            "aria-selected": "{item.active}",
            style: style,
            span {
                "data-part": "swipe-index",
                style: "color:#998f87;font-variant-numeric:tabular-nums;white-space:nowrap;",
                "{item.index_label}"
            }
            span {
                "data-part": "swipe-preview",
                style: "overflow:hidden;min-width:0;text-overflow:ellipsis;white-space:nowrap;",
                "{item.preview}"
            }
        }
    }
}

/// Flagged Product Wire chat workspace: header glass, visible Markdown/image
/// rows, composer glass. Blitz consumes this tree; callers must not inject a
/// hand-built `NeoDisplayList`.
/// Message details card modal overlay (React `MessageDetailsCardV2`):
/// displays message metadata (sent time, model name, generation duration,
/// token count), content preview, and action triggers (copy, context,
/// prompt plan, run steps) with Close action (`details-close`).
fn message_details_card(view: &ProductChatView) -> Option<Element> {
    let owner = view.details_message_id.as_deref()?;
    // Resolved from the full message list in `ChatSession::view` — the card
    // survives its owner leaving the visible window.
    let row = view.details_row.as_ref()?;
    let author = row.author.clone();
    let is_user = row.role == "user";
    let token_label = row.token_count.map(|c| format!("{c}t"));
    let timestamp = if row.timestamp.is_empty() {
        None
    } else {
        Some(row.timestamp.clone())
    };
    let model = row.model.clone();
    let duration = row.generation_time.clone();
    let content = row.content.clone();
    let run_id = row.run_id.clone();
    let excluded = row.manual_excluded;

    let is_actions_mode = view.details_mode == "actions";
    let is_edit_mode = view.details_mode == "edit";

    if is_edit_mode {
        let draft = if !view.editing_draft.is_empty() {
            view.editing_draft.clone()
        } else {
            content.clone()
        };
        return Some(rsx! {
            div {
                class: "MessageDetailsCardV2_root",
                "data-component": "dialog",
                "data-part": "details-card",
                "data-state": "edit",
                role: "dialog",
                "aria-label": "Edit message",
                style: "position:absolute;left:50%;transform:translateX(-50%);top:12px;z-index:35;box-sizing:border-box;width:min(560px,calc(100% - 16px));display:flex;flex-direction:column;gap:10px;max-height:85%;padding:24px;border:1px solid #39342f;border-radius:20px;background:#292522;color:#f3eee8;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.58);",
                div {
                    class: "MessageDetailsCardV2_editor",
                    "data-part": "details-editor",
                    style: "display:flex;flex-direction:column;gap:10px;",
                    // Header: Identity & Back/Cancel button
                    div {
                        class: "MessageDetailsCardV2_actionHeader",
                        "data-part": "details-header",
                        style: "display:flex;align-items:center;justify-content:space-between;gap:8px;",
                        div {
                            style: "display:flex;align-items:center;gap:8px;flex:1;min-width:0;",
                            span {
                                style: "width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(243,238,232,0.1);color:#c5bbb2;",
                                {crate::product_shell::icon("PencilSimple", 14)}
                            }
                            strong {
                                style: "font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                                "Edit message"
                            }
                        }
                        button {
                            class: "MessageBubble_actionButton",
                            r#type: "button",
                            "data-action": "details-mode-details",
                            "data-message-id": "{owner}",
                            "aria-label": "Cancel edit",
                            style: "width:44px;height:44px;border-radius:999px;display:flex;align-items:center;justify-content:center;border:1px solid #39342f;background:#24211e;color:#c5bbb2;cursor:pointer;",
                            {crate::product_shell::icon("X", 14)}
                        }
                    }
                    // Editor input area
                    div {
                        class: "MessageDetailsCardV2_textareaWrap",
                        "data-part": "details-editor-input",
                        style: "min-height:96px;max-height:220px;overflow-y:auto;padding:8px 12px;border-radius:10px;background:#24211e;border:1px solid #39342f;font-size:16px;line-height:1.45;color:#f3eee8;white-space:pre-wrap;overflow-wrap:anywhere;",
                        "{draft}"
                    }
                    // Editor action buttons (Cancel / Save)
                    div {
                        class: "MessageDetailsCardV2_editorActions",
                        "data-part": "details-editor-actions",
                        style: "display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:4px;",
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "ghost",
                            "data-action": "details-mode-details",
                            "data-message-id": "{owner}",
                            "aria-label": "Cancel",
                            style: "display:flex;align-items:center;gap:6px;min-height:44px;padding:0 16px;border-radius:10px;border:1px solid #39342f;background:#24211e;color:#f3eee8;font-size:16px;cursor:pointer;",
                            span { "data-part": "label", "Cancel" }
                        }
                        button {
                            class: "st-button",
                            r#type: "button",
                            "data-component": "button",
                            "data-variant": "primary",
                            "data-action": "details-save-edit",
                            "data-message-id": "{owner}",
                            "aria-label": "Save message",
                            style: "display:flex;align-items:center;gap:6px;min-height:44px;padding:0 16px;border-radius:10px;border:0;background:#e38a62;color:#2a130b;font-size:16px;font-weight:600;cursor:pointer;",
                            {crate::product_shell::icon("Check", 14)}
                            span { "data-part": "label", "Save" }
                        }
                    }
                }
            }
        });
    }

    if is_actions_mode {
        return Some(rsx! {
            div {
                class: "MessageDetailsCardV2_root",
                "data-component": "dialog",
                "data-part": "details-card",
                role: "dialog",
                "aria-label": "Message actions",
                style: "position:absolute;left:50%;transform:translateX(-50%);top:12px;z-index:35;box-sizing:border-box;width:min(560px,calc(100% - 16px));display:flex;flex-direction:column;gap:10px;max-height:85%;padding:24px;border:1px solid #39342f;border-radius:20px;background:#292522;color:#f3eee8;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.58);",
                div {
                    class: "MessageDetailsCardV2_actionMode",
                    "data-part": "details-action-menu",
                    style: "display:flex;flex-direction:column;gap:10px;overflow:hidden;",
                    // Header: Identity & Back/Close button
                    div {
                        class: "MessageDetailsCardV2_actionHeader",
                        "data-part": "details-header",
                        style: "display:flex;align-items:center;justify-content:space-between;gap:8px;",
                        div {
                            style: "display:flex;align-items:center;gap:8px;flex:1;min-width:0;",
                            span {
                                style: "width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(243,238,232,0.1);color:#c5bbb2;",
                                if is_user {
                                    {crate::product_shell::icon("User", 14)}
                                } else {
                                    {crate::product_shell::icon("Robot", 14)}
                                }
                            }
                            strong {
                                style: "font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                                "{author}"
                            }
                        }
                        button {
                            class: "MessageBubble_actionButton",
                            r#type: "button",
                            "data-action": "details-mode-details",
                            "data-message-id": "{owner}",
                            "aria-label": "Close message actions",
                            style: "width:44px;height:44px;border-radius:999px;display:flex;align-items:center;justify-content:center;border:1px solid #39342f;background:#24211e;color:#c5bbb2;cursor:pointer;",
                            {crate::product_shell::icon("X", 14)}
                        }
                    }
                    // Preview
                    div {
                        class: "MessageDetailsCardV2_preview",
                        "data-part": "details-action-preview",
                        style: "margin:4px 0 8px;max-height:66px;overflow:hidden;padding:12px;border-radius:16px;background:#24211e;font-size:13px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;color:#c5bbb2;",
                        "{content}"
                    }
                    // Action scroll container
                    div {
                        class: "MessageDetailsCardV2_actionScroll",
                        "data-part": "details-actions-scroll",
                        style: "display:flex;flex-direction:column;gap:10px;overflow-y:auto;max-height:280px;padding-right:4px;",
                        // Danger zone
                        section {
                            class: "MessageDetailsCardV2_actionGroup",
                            "data-part": "details-danger-zone",
                            style: "display:flex;flex-direction:column;gap:0;",
                            h3 {
                                style: "margin:0 0 4px 0;font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:0.05em;color:#b23b35;",
                                "Danger zone"
                            }
                            button {
                                class: "MessageBubble_actionButton",
                                r#type: "button",
                                "data-action": "delete",
                                "data-message-id": "{owner}",
                                "aria-label": "Delete message and all versions",
                                style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#b23b35;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                {crate::product_shell::icon("Trash", 14)}
                                span { "Delete message and all versions" }
                            }
                        }
                        // Core actions
                        section {
                            class: "MessageDetailsCardV2_actionGroup",
                            "data-part": "details-core-actions",
                            style: "display:flex;flex-direction:column;gap:0;",
                            h3 {
                                style: "margin:0 0 4px 0;font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:0.05em;color:#998f87;",
                                "Message actions"
                            }
                            button {
                                class: "MessageBubble_actionButton",
                                r#type: "button",
                                "data-action": "copy",
                                "data-message-id": "{owner}",
                                "aria-label": "Copy message",
                                style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                {crate::product_shell::icon("Copy", 14)}
                                span { "Copy message" }
                            }
                            button {
                                class: "MessageBubble_actionButton",
                                r#type: "button",
                                "data-action": "context",
                                "data-message-id": "{owner}",
                                "aria-label": if excluded { "Include in prompt context" } else { "Exclude from prompt context" },
                                style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                if excluded {
                                    {crate::product_shell::icon("Eye", 14)}
                                    span { "Include in prompt context" }
                                } else {
                                    {crate::product_shell::icon("EyeSlash", 14)}
                                    span { "Exclude from prompt context" }
                                }
                            }
                            button {
                                class: "MessageBubble_actionButton",
                                r#type: "button",
                                "data-action": "edit",
                                "data-message-id": "{owner}",
                                "aria-label": "Edit message",
                                style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                {crate::product_shell::icon("PencilSimple", 14)}
                                span { "Edit message" }
                            }
                            button {
                                class: "MessageBubble_actionButton",
                                r#type: "button",
                                "data-action": "history",
                                "data-message-id": "{owner}",
                                "aria-label": "Revision history",
                                style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                {crate::product_shell::icon("ClockCounterClockwise", 14)}
                                span { "Revision history" }
                            }
                            button {
                                class: "MessageBubble_actionButton",
                                r#type: "button",
                                "data-action": "regenerate",
                                "data-message-id": "{owner}",
                                "aria-label": "Regenerate",
                                style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                {crate::product_shell::icon("ArrowClockwise", 14)}
                                span { "Regenerate" }
                            }
                            button {
                                class: "MessageBubble_actionButton",
                                r#type: "button",
                                "data-action": "rollback",
                                "data-message-id": "{owner}",
                                "aria-label": "Rollback to here",
                                style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                {crate::product_shell::icon("ArrowUUpLeft", 14)}
                                span { "Rollback to here" }
                            }
                            button {
                                class: "MessageBubble_actionButton",
                                r#type: "button",
                                "data-action": "checkpoint",
                                "data-message-id": "{owner}",
                                "aria-label": "Set checkpoint",
                                style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                {crate::product_shell::icon("Flag", 14)}
                                span { "Set checkpoint" }
                            }
                            button {
                                class: "MessageBubble_actionButton",
                                r#type: "button",
                                "data-action": "branch",
                                "data-message-id": "{owner}",
                                "aria-label": "Branch from here",
                                style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                {crate::product_shell::icon("GitBranch", 14)}
                                span { "Branch from here" }
                            }
                            if run_id.is_some() {
                                button {
                                    class: "MessageBubble_actionButton",
                                    r#type: "button",
                                    "data-action": "prompt",
                                    "data-message-id": "{owner}",
                                    "aria-label": "View prompt plan",
                                    style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                    {crate::product_shell::icon("BookOpenText", 14)}
                                    span { "View prompt plan" }
                                }
                                button {
                                    class: "MessageBubble_actionButton",
                                    r#type: "button",
                                    "data-action": "steps",
                                    "data-message-id": "{owner}",
                                    "aria-label": "View run steps",
                                    style: "display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px;border:0;border-bottom:1px solid #39342f;border-radius:0;background:transparent;color:#f3eee8;font-size:16px;font-weight:650;text-align:start;cursor:pointer;",
                                    {crate::product_shell::icon("List", 14)}
                                    span { "View run steps" }
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    Some(rsx! {
        div {
            class: "MessageDetailsCardV2_root",
            "data-component": "dialog",
            "data-part": "details-card",
            role: "dialog",
            "aria-label": "Message details",
            style: "position:absolute;left:50%;transform:translateX(-50%);top:12px;z-index:35;box-sizing:border-box;width:min(560px,calc(100% - 16px));display:flex;flex-direction:column;gap:10px;max-height:85%;padding:24px;border:1px solid #39342f;border-radius:20px;background:#292522;color:#f3eee8;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.58);",
            // Header: Identity & Badges
            div {
                class: "MessageDetailsCardV2_header",
                "data-part": "details-header",
                style: "display:flex;align-items:center;gap:10px;",
                div {
                    style: "display:flex;align-items:center;gap:8px;flex:1;min-width:0;",
                    span {
                        style: "width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(243,238,232,0.1);color:#c5bbb2;",
                        if is_user {
                            {crate::product_shell::icon("User", 14)}
                        } else {
                            {crate::product_shell::icon("Robot", 14)}
                        }
                    }
                    strong {
                        style: "font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
                        "{author}"
                    }
                }
                div {
                    class: "MessageDetailsCardV2_badges",
                    "data-part": "details-badges",
                    style: "display:flex;align-items:center;gap:6px;",
                    if let Some(tok) = token_label {
                        span {
                            style: "display:flex;align-items:center;gap:3px;padding:2px 6px;border-radius:10px;background:#492a20;color:#f0d9cb;font-size:11px;",
                            {crate::product_shell::icon("Lightning", 12)}
                            "{tok}"
                        }
                    }
                    button {
                        class: "MessageBubble_actionButton",
                        r#type: "button",
                        "data-action": "details-close",
                        "data-message-id": "{owner}",
                        "aria-label": "Close details",
                        style: "width:44px;height:44px;border-radius:999px;display:flex;align-items:center;justify-content:center;border:1px solid #39342f;background:#24211e;color:#c5bbb2;cursor:pointer;",
                        {crate::product_shell::icon("X", 14)}
                    }
                }
            }
            // Meta definition list (Sent at, Model, Generation Time)
            div {
                class: "MessageDetailsCardV2_meta",
                "data-part": "details-meta",
                style: "display:flex;flex-direction:column;",
                if let Some(time) = timestamp {
                    div {
                        style: "display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;border-bottom:1px solid #39342f;font-size:13px;",
                        span { style: "color:#998f87;gap:8px;", {crate::product_shell::icon("CalendarBlank", 13)}, "Sent" }
                        span { style: "color:#f3eee8;font-weight:650;text-align:end;overflow-wrap:anywhere;", "{time}" }
                    }
                }
                if let Some(mdl) = model {
                    div {
                        style: "display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;border-bottom:1px solid #39342f;font-size:13px;",
                        span { style: "color:#998f87;gap:8px;", {crate::product_shell::icon("Robot", 13)}, "Model" }
                        span { style: "color:#f3eee8;font-weight:650;text-align:end;overflow-wrap:anywhere;", "{mdl}" }
                    }
                }
                if let Some(dur) = duration {
                    div {
                        style: "display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;border-bottom:1px solid #39342f;font-size:13px;",
                        span { style: "color:#998f87;gap:8px;", {crate::product_shell::icon("Timer", 13)}, "Time" }
                        span { style: "color:#f3eee8;font-weight:650;text-align:end;overflow-wrap:anywhere;", "{dur}" }
                    }
                }
            }
            // Message content preview
            div {
                class: "MessageDetailsCardV2_content",
                "data-part": "details-content",
                style: "flex:1;min-height:48px;max-height:160px;overflow-y:auto;margin-bottom:12px;padding:12px 12px 16px;border:1px solid #39342f;border-radius:16px;background:#24211e;font-size:13px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;color:#c5bbb2;",
                "{content}"
            }
            // Actions / footer
            div {
                class: "MessageDetailsCardV2_footer",
                "data-part": "details-footer",
                style: "display:flex;align-items:center;justify-content:space-around;gap:2px;padding-top:8px;border-top:1px solid #39342f;",
                button {
                    class: "MessageBubble_actionButton",
                    r#type: "button",
                    "data-action": "copy",
                    "data-message-id": "{owner}",
                    "aria-label": "Copy message",
                    style: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:44px;min-height:44px;padding:0 2px;border:0;border-radius:10px;background:transparent;color:#c5bbb2;cursor:pointer;",
                    {crate::product_shell::icon("Copy", 13)}
                    span { "Copy" }
                }
                button {
                    class: "MessageBubble_actionButton",
                    r#type: "button",
                    "data-action": "context",
                    "data-message-id": "{owner}",
                    "aria-label": "Toggle context",
                    style: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:44px;min-height:44px;padding:0 2px;border:0;border-radius:10px;background:transparent;color:#c5bbb2;cursor:pointer;",
                    if excluded {
                        {crate::product_shell::icon("Eye", 13)}
                        span { "Include" }
                    } else {
                        {crate::product_shell::icon("EyeSlash", 13)}
                        span { "Exclude" }
                    }
                }
                button {
                    class: "MessageBubble_actionButton",
                    r#type: "button",
                    "data-action": "actions",
                    "data-message-id": "{owner}",
                    "aria-label": "More message actions",
                    title: "More message actions",
                    style: "display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:13px;border:1px solid rgba(243,238,232,0.1);background:rgba(36,33,30,0.62);color:#c5bbb2;cursor:pointer;",
                    {crate::product_shell::icon("Plus", 13)}
                }
                if run_id.is_some() {
                    button {
                        class: "MessageBubble_actionButton",
                        r#type: "button",
                        "data-action": "prompt",
                        "data-message-id": "{owner}",
                        "aria-label": "Prompt plan",
                        style: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:44px;min-height:44px;padding:0 2px;border:0;border-radius:10px;background:transparent;color:#c5bbb2;cursor:pointer;",
                        {crate::product_shell::icon("BookOpenText", 13)}
                        span { "Prompt" }
                    }
                    button {
                        class: "MessageBubble_actionButton",
                        r#type: "button",
                        "data-action": "steps",
                        "data-message-id": "{owner}",
                        "aria-label": "Run steps",
                        style: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:44px;min-height:44px;padding:0 2px;border:0;border-radius:10px;background:transparent;color:#c5bbb2;cursor:pointer;",
                        {crate::product_shell::icon("List", 13)}
                        span { "Steps" }
                    }
                }
            }
        }
    })
}

///
/// The `data-*` hooks and CSS module class names match React
/// `ChatWorkspace` / `ChatHeader` / `ChatComposer` / `MessageBubble` so packed
/// `product.css` and the DOM-parity dump share one contract.
pub fn product_chat_app() -> Element {
    let view = current_product_chat();
    // Resolved design tokens: avatar slot sizes/radii come from the same
    // sheet the React CSS uses (live theme or canonical dark defaults).
    let tokens = view.active_theme_tokens.clone().unwrap_or_default();
    // React parity: ChatWorkspace `.headerAvatar` = `var(--st-control-height-2xs)`,
    // MessageBubble `.avatar` = `var(--st-control-height-xs)`; both round
    // (half-size radius).
    let header_px = tokens.control_height_2xs_px();
    let header_radius = header_px / 2.0;
    let msg_px = tokens.control_height_xs_px();
    let msg_radius = msg_px / 2.0;
    // G5 hover feedback for the message action bar (React
    // `.MessageBubble_actionButton:hover`): the host resolves the hover
    // target from the same hit-rect snapshot the taps use.
    let hover = view.hover_target.as_deref();
    // Blueprint-driven chrome (M2 phase 2): when a document source is
    // installed, header/viewport/composer structure comes from the authored
    // JSON; the legacy RSX below stays the fallback and the parity oracle.
    let chrome_parts = crate::scene_chat::blueprint_chrome(&view);
    // Honest context-meter label (audit P2: the trigger carried "4%").
    let (context_meter_title, context_meter_label) =
        crate::scene_chat::context_meter_label(view.context_summary.as_ref());
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
    // G5 focus ring on the composer field (React
    // `[data-component='textarea']:focus`): box-shadow 0 0 0 3px
    // rgba(227,138,98,.2) — pseudo-classes do not exist in this Blitz build,
    // the focused part arrives from the host's focus resolution.
    let composer_focused = view.focused_part.as_deref() == Some("slot:chat.composer");
    let composer_field_style = if composer_focused {
        "flex:1;min-height:48px;font-size:16px;line-height:1.4;box-shadow:0 0 0 3px rgba(227,138,98,0.2);border-radius:8px;"
    } else {
        "flex:1;min-height:48px;font-size:16px;line-height:1.4;"
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
                                        style: "flex:none;width:{header_px}px;height:{header_px}px;border-radius:{header_radius}px;overflow:hidden;background:#302c28;",
                                        span {
                                            "data-part": "avatar-fallback",
                                            "data-avatar-asset": "{view.character_avatar_asset}",
                                            "data-avatar-radius": "{header_radius}",
                                            class: "headerAvatar",
                                            style: "display:block;width:{header_px}px;height:{header_px}px;border-radius:{header_radius}px;background:#302c28;",
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
                            // React `ChatSnapshotsMenu` trigger: aria-label
                            // "Snapshots", round 40px ghost button, hover
                            // text-primary over inverse-7% background (G5).
                            button {
                                class: "ChatWorkspace_headerSearch",
                                r#type: "button",
                                // Custom intents render verbatim through the
                                // shared hit table; the desktop bin routes this
                                // one to `toggle_snapshots_menu`.
                                "data-action": "custom.chat.snapshots-menu",
                                "data-part": "snapshots-trigger",
                                "data-state": if hover == Some("custom.chat.snapshots-menu:-") { "hover" } else { "idle" },
                                "aria-label": "Snapshots",
                                "aria-haspopup": "menu",
                                "aria-expanded": if view.snapshots_menu_open { "true" } else { "false" },
                                title: "Snapshots",
                                style: if hover == Some("custom.chat.snapshots-menu:-") { "flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:none;border-radius:20px;background:rgba(33,27,23,0.07);color:#f3eee8;" } else { "flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:none;border-radius:20px;background:transparent;color:#c5bbb2;" },
                                {crate::product_shell::icon("GitBranch", 17)}
                            }
                            if let Some(ref parent_id) = view.parent_chat_id {
                                button {
                                    class: "ChatWorkspace_headerSearch",
                                    r#type: "button",
                                    "data-component": "back-to-parent",
                                    "data-action": "back-to-parent",
                                    "data-parent-chat-id": "{parent_id}",
                                    "aria-label": "Back to parent chat",
                                    title: "Back to parent chat",
                                    style: "flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:none;border-radius:20px;background:transparent;color:#c5bbb2;",
                                    {crate::product_shell::icon("ArrowLeft", 17)}
                                }
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
                        if view.details_message_id.is_some() {
                            {message_details_card(&view)}
                        }
                        if view.snapshots_menu_open {
                            {snapshots_menu_panel(&view)}
                        }
                        if view.variant_picker_for.is_some() {
                            {variant_picker_popover(&view)}
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
                        if view.details_message_id.is_some() {
                            {message_details_card(&view)}
                        },
                        if view.snapshots_menu_open {
                            {snapshots_menu_panel(&view)}
                        },
                        if view.variant_picker_for.is_some() {
                            {variant_picker_popover(&view)}
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
                                        // Layout comes from the packed class only (React
                                        // parity: flex row, wrap, gap 12px) — mirrors the
                                        // blueprint branch in scene_chat.rs.
                                        span {
                                            class: "MessageBubble_avatar",
                                            "data-part": "message-avatar",
                                            "data-state": if !view.character_avatar_asset.is_empty() && row.role == "assistant" { "image" } else { "fallback" },
                                            "aria-hidden": "true",
                                            style: "flex:none;width:{msg_px}px;height:{msg_px}px;border-radius:{msg_radius}px;overflow:hidden;background:#492a20;",
                                            if !view.character_avatar_asset.is_empty() && row.role == "assistant" {
                                                span {
                                                    "data-part": "avatar-fallback",
                                                    "data-avatar-asset": "{view.character_avatar_asset}",
                                                    "data-avatar-radius": "{msg_radius}",
                                                    class: "messageAvatar",
                                                    style: "display:block;width:{msg_px}px;height:{msg_px}px;border-radius:{msg_radius}px;background:#302c28;",
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
                                            // Packed class governs (flex row, wrap, gap 4px,
                                            // margin-left:auto) — see the message-header note.
                                            {message_action_button("details", "Message details", "TextAlignLeft", &row.id, hover)}
                                            {if row.manual_excluded {
                                                message_action_button("context", "Include in prompt context", "Eye", &row.id, hover)
                                            } else {
                                                message_action_button("context", "Exclude from prompt context", "EyeSlash", &row.id, hover)
                                            }}
                                            {message_action_button("edit", "Edit message", "PencilSimple", &row.id, hover)}
                                            {message_action_button("copy", "Copy", "Copy", &row.id, hover)}
                                            {message_action_button("checkpoint", "Checkpoint", "Flag", &row.id, hover)}
                                            {message_action_button("branch", "Branch", "GitBranch", &row.id, hover)}
                                            if row.checkpoint_chat_id.is_some() {
                                                {message_action_button("delete-checkpoint", "Remove checkpoint", "Flag", &row.id, hover)}
                                            }
                                            {message_action_button("delete", "Delete message", "Trash", &row.id, hover)}
                                            {message_action_button("rollback", "Rollback to here", "ArrowUUpLeft", &row.id, hover)}
                                            {message_action_button("history", "Edit history", "ClockCounterClockwise", &row.id, hover)}
                                            if row.run_id.is_some() {
                                                {message_action_button("prompt", "View prompt plan", "BookOpenText", &row.id, hover)}
                                                {message_action_button("steps", "View run steps", "List", &row.id, hover)}
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
                                                if !row.swipe_label.is_empty() {
                                                    span {
                                                        class: "MessageSwipePager_counter",
                                                        "aria-live": "polite",
                                                        "data-part": "swipe-counter",
                                                        style: "color:#998f87;font-size:12px;",
                                                        "{row.swipe_label}"
                                                    }
                                                }
                                                // React `MessageVariantPicker`
                                                // trigger (`chat:swipePicker`
                                                // = "Variants") — opens the
                                                // variant listbox popover.
                                                button {
                                                    class: "MessageBubble_actionButton",
                                                    r#type: "button",
                                                    "data-action": "swipe-picker",
                                                    "aria-label": "Variants",
                                                    title: "Variants",
                                                    "aria-expanded": view.variant_picker_for.as_deref() == Some(row.id.as_str()),
                                                    "aria-haspopup": "listbox",
                                                    style: "display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:16px;border:1px solid rgba(57,52,47,0.70);background:rgba(36,33,30,0.70);color:#998f87;",
                                                    {crate::product_shell::icon("CaretDown", 14)}
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
                                    if view.streaming {
                                        button {
                                            class: "st-button",
                                            r#type: "button",
                                            "data-component": "button",
                                            "data-variant": "danger",
                                            "data-size": "md",
                                            "data-action": "stop",
                                            "data-state": "idle",
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
                                            // G5 hover: React primary-button :hover (#f09a73).
                                            "data-state": if hover == Some("send:-") { "hover" } else { "idle" },
                                            style: if hover == Some("send:-") {
                                                "position:absolute;right:12px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;min-width:44px;min-height:36px;padding:4px 16px;border:none;border-radius:10px;color:#2a130b;background:#f09a73;font-size:13px;font-weight:500;"
                                            } else {
                                                "position:absolute;right:12px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;min-width:44px;min-height:36px;padding:4px 16px;border:none;border-radius:10px;color:#2a130b;background:#e38a62;font-size:13px;font-weight:500;"
                                            },
                                            span { "data-part": "label", "Send" }
                                            span {
                                                "data-part": "icon",
                                                "data-position": "end",
                                                "aria-hidden": "true",
                                                {crate::product_shell::icon_fill("PaperPlaneRight", 16, "#2a130b")}
                                            }
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
                                                // React `.ChatWorkspace_menuButton:hover`
                                                // (G5; no pseudo-classes in this Blitz build).
                                                "data-state": if hover == Some("composer-settings:-") { "hover" } else { "idle" },
                                                "aria-label": "Settings",
                                                title: "Settings",
                                                style: if hover == Some("composer-settings:-") {
                                                    "display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid rgba(243,238,232,0.10);border-radius:16px;color:#f3eee8;background:rgba(33,27,23,0.10);"
                                                } else {
                                                    "display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid rgba(243,238,232,0.10);border-radius:16px;color:#c5bbb2;background:rgba(243,238,232,0.05);"
                                                },
                                                {crate::product_shell::icon("GearSix", 15)}
                                                span { style: "font-size:13px;", "Settings" }
                                            }
                                            button {
                                                class: "ChatWorkspace_iconButton",
                                                r#type: "button",
                                                "data-action": "composer-reset",
                                                "data-state": if hover == Some("composer-reset:-") { "hover" } else { "idle" },
                                                "aria-label": "Reset",
                                                title: "Reset",
                                                style: if hover == Some("composer-reset:-") {
                                                    "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;border-radius:16px;background:rgba(33,27,23,0.10);color:#f3eee8;"
                                                } else {
                                                    "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;border-radius:16px;background:transparent;color:#998f87;"
                                                },
                                                {crate::product_shell::icon("X", 17)}
                                            }
                                        }
                                        button {
                                            class: "ChatWorkspace_contextTrigger",
                                            r#type: "button",
                                            "data-action": "composer-context",
                                            // React `.ChatWorkspace_contextTrigger:hover`
                                            // (G5; no pseudo-classes in this Blitz build).
                                            "data-state": if hover == Some("composer-context:-") { "hover" } else { "idle" },
                                            "aria-label": "Context",
                                            // Honest estimate from the session
                                            // summary (see `context_meter_label`).
                                            title: "{context_meter_title}",
                                            style: if hover == Some("composer-context:-") {
                                                "display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid rgba(243,238,232,0.10);border-radius:16px;color:#f3eee8;background:rgba(33,27,23,0.10);"
                                            } else {
                                                "display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid rgba(243,238,232,0.10);border-radius:16px;color:#c5bbb2;background:rgba(243,238,232,0.05);"
                                            },
                                            {crate::product_shell::icon("Database", 15)}
                                            span { style: "font-size:13px;", "{context_meter_label}" }
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
                                            "data-state": if composer_focused { "focused" } else { "idle" },
                                            style: "color:{composer_color};{composer_field_style}",
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
                                                    // React `.ChatWorkspace_composerUtilities button:hover`
                                                    // (G5, no pseudo-classes in this Blitz build).
                                                    "data-state": if hover == Some("composer-settings:-") { "hover" } else { "idle" },
                                                    "aria-label": "Settings",
                                                    style: if hover == Some("composer-settings:-") {
                                                        "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:rgba(33,27,23,0.10);color:#f3eee8;"
                                                    } else {
                                                        "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:#998f87;"
                                                    },
                                                    {crate::product_shell::icon("List", 19)}
                                                }
                                                button {
                                                    r#type: "button",
                                                    "data-action": "scroll-latest",
                                                    "data-state": if hover == Some("scroll-latest:-") { "hover" } else { "idle" },
                                                    "aria-label": "Scroll to latest",
                                                    style: if hover == Some("scroll-latest:-") {
                                                        "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:rgba(33,27,23,0.10);color:#f3eee8;"
                                                    } else {
                                                        "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:#998f87;"
                                                    },
                                                    {crate::product_shell::icon("ArrowDown", 19)}
                                                }
                                                button {
                                                    r#type: "button",
                                                    "data-action": "composer-reset",
                                                    "data-state": if hover == Some("composer-reset:-") { "hover" } else { "idle" },
                                                    "aria-label": "Reset",
                                                    style: if hover == Some("composer-reset:-") {
                                                        "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:rgba(33,27,23,0.10);color:#f3eee8;"
                                                    } else {
                                                        "width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:#998f87;"
                                                    },
                                                    {crate::product_shell::icon("MagicWand", 19)}
                                                }
                                            }
                                            if view.streaming {
                                                button {
                                                    class: "st-button",
                                                    r#type: "button",
                                                    "data-component": "button",
                                                    "data-variant": "danger",
                                                    "data-size": "md",
                                                    "data-action": "stop",
                                                    "data-state": "idle",
                                                    "aria-label": "Stop",
                                                    title: "Stop",
                                                    style: "display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:44px;padding:4px 16px;border:none;border-radius:10px;color:#fee2e2;background:#b91c1c;font-size:13px;font-weight:500;",
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
                                                    "aria-label": "Send",
                                                    title: "Send",
                                                    "data-state": if hover == Some("send:-") { "hover" } else { "idle" },
                                                    style: if hover == Some("send:-") {
                                                        "display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:44px;padding:4px 16px;border:none;border-radius:10px;color:#2a130b;background:#f09a73;font-size:13px;font-weight:500;"
                                                    } else {
                                                        "display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:44px;padding:4px 16px;border:none;border-radius:10px;color:#2a130b;background:#e38a62;font-size:13px;font-weight:500;"
                                                    },
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
