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
