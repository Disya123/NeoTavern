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

mod chat_route;
mod product_path;
mod product_shell;
pub use chat_route::{chat_route_line, flagged_chat_route, ChatRouteReport};
pub use neotavern_presentation_design_system::SafeAreaInsets;
pub use product_path::{
    chrome_metrics, current_product_chat, install_product_chat, message_id, mixed_height,
    mixed_height_catalog, product_chat_from_fixture, product_chat_with_chrome, streaming_schedule,
    visible_rows, ProductChatView, ProductChrome, RowKind, VisibleRow, PRODUCT_PATH_CHAT_ID,
    PRODUCT_PATH_ITEMS, PRODUCT_PATH_VISIBLE,
};
pub use product_shell::{
    character_card_description, current_product_shell, install_product_shell, product_shell_app,
    CharacterCardView, CharacterDraftView, ProductShellView,
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

fn message_bubble_style(user: bool, compact: bool, font_px: u32) -> String {
    let bg = if user { "#2a4a6a" } else { "#243044" };
    if compact {
        format!(
            "box-sizing:border-box;min-height:24px;margin:4px 0;padding:6px 8px;color:#e8eef7;font-size:{font_px}px;white-space:pre-wrap;overflow-wrap:break-word;background:{bg};"
        )
    } else {
        let start = if user { "20%" } else { "0" };
        format!(
            "box-sizing:border-box;width:80%;margin:8px 0;margin-left:{start};padding:10px 12px;color:#e8eef7;font-size:{font_px}px;white-space:pre-wrap;overflow-wrap:break-word;background:{bg};"
        )
    }
}

/// Flagged Product Wire chat workspace: header glass, visible Markdown/image
/// rows, composer glass. Blitz consumes this tree; callers must not inject a
/// hand-built `NeoDisplayList`.
pub fn product_chat_app() -> Element {
    let view = current_product_chat();
    let (width, header_h, viewport_h, composer_h) =
        crate::chrome_metrics(view.viewport_width, view.viewport_height);
    let composer_top = header_h.saturating_add(viewport_h);
    let compact = view.viewport_height <= 240;
    let font_px = if compact { 12 } else { 18 };
    let title_px = if compact { 13 } else { 20 };
    let pad = if compact { 8 } else { 16 };
    let workspace_style = format!(
        "position:relative;box-sizing:border-box;width:{width}px;height:{}px;background:#101820;color:#e8eef7;font-family:sans-serif;",
        view.viewport_height.max(1)
    );
    let wallpaper_style = format!(
        "position:absolute;left:0;top:0;width:{width}px;height:{}px;background:#243044;",
        view.viewport_height.max(1)
    );
    let header_style = format!(
        "position:absolute;left:0;top:0;width:{width}px;height:{header_h}px;box-sizing:border-box;padding:{pad}px;background:#15202b;color:#f2f6fb;font-size:{title_px}px;"
    );
    let viewport_style = format!(
        "position:absolute;left:0;top:{header_h}px;width:{width}px;height:{viewport_h}px;box-sizing:border-box;padding:{pad}px;overflow:hidden;background:#101820;"
    );
    let composer_style = format!(
        "position:absolute;left:0;top:{composer_top}px;width:{width}px;height:{composer_h}px;box-sizing:border-box;padding:{pad}px;background:#15202b;color:#d7e3f0;font-size:{font_px}px;"
    );
    let wallpaper = matches!(view.chrome, ProductChrome::PaintOrder);
    let overlay = matches!(
        view.chrome,
        ProductChrome::TripleGlass | ProductChrome::PaintOrder
    );
    let nested = matches!(
        view.chrome,
        ProductChrome::NestedDialog | ProductChrome::PaintOrder
    );
    let composer_label = if view.composer_text.is_empty() {
        "Message"
    } else {
        view.composer_text.as_str()
    };
    rsx! {
        div {
            "data-component": "chat-workspace",
            style: "{workspace_style}",
            if wallpaper {
                div {
                    "data-part": "wallpaper",
                    style: "{wallpaper_style}"
                }
            }
            div {
                class: "neoui-glass",
                "data-neoui": "glass",
                "data-part": "header",
                role: "banner",
                style: "{header_style}",
                "{view.title} ({view.message_count})"
                if nested {
                    div {
                        class: "neoui-glass",
                        "data-neoui": "glass",
                        "data-part": "dialog",
                        style: "position:absolute;left:48px;top:4px;width:160px;height:28px;background:#243044;"
                    }
                }
            }
            div {
                "data-part": "viewport",
                "data-region": "chat-viewport",
                role: "list",
                "aria-label": "Chat messages",
                "data-state": if view.streaming { "streaming" } else { "idle" },
                style: "{viewport_style}",
                for row in view.visible.iter() {
                    div {
                        "data-part": "message",
                        "data-role": "{row.role}",
                        "data-format": "markdown",
                        role: "listitem",
                        style: message_bubble_style(row.role == "user", compact, font_px),
                        "{row.content}"
                        if matches!(row.kind, RowKind::Image | RowKind::Mixed) {
                            img {
                                src: "asset:thumb",
                                alt: "message image",
                                "data-part": "message-image",
                                style: "width:48px;height:32px;background:#3a4a60;"
                            }
                        }
                    }
                }
            }
            if let Some(code) = view.error_code.as_deref() {
                div {
                    "data-part": "error",
                    role: "alert",
                    style: "position:absolute;left:{pad}px;bottom:{composer_h}px;color:#f2b8b5;font-size:{font_px}px;",
                    "{code}"
                }
            }
            div {
                class: "neoui-glass",
                "data-neoui": "glass",
                "data-part": "composer",
                role: "region",
                "aria-label": "Message composer",
                "data-state": if view.streaming { "streaming" } else { "idle" },
                style: "{composer_style}",
                "{composer_label}"
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
