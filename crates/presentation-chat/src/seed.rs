use contracts_generated::generated::{
    decode_character_dto, decode_chat_dto, decode_message_dto, decode_paged_chats, ChatDto,
    MessageRole, PagedChats, RequestCreateCharacter, RequestCreateChat, RequestCreateMessage,
    RequestGetChat, RequestListChats,
};
use neotavern_presentation_dioxus_shell::assert_registered_command;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::ChatRouteError;
use crate::wire::ProductWire;

pub const ISOLATED_10K_PROFILE: &str = "isolated-10k";
pub const ISOLATED_10K_TITLE: &str = "Isolated 10k";
pub const ISOLATED_10K_COUNT: u32 = 10_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IsolatedSeedReport {
    pub chat_id: String,
    pub character_id: String,
    pub kernel_message_count: u32,
    pub created: u32,
    pub skipped: bool,
}

pub fn is_isolated_10k_profile(profile: Option<&str>) -> bool {
    profile.map(str::trim) == Some(ISOLATED_10K_PROFILE)
}

pub fn isolated_message_content(index: u32) -> String {
    if index.is_multiple_of(5) {
        format!("![photo {index}](asset:thumb-{index})")
    } else {
        format!("**msg {index}**\n\n- item one\n- `code`")
    }
}

/// Seed an isolated 10k chat through existing Product Wire ops only.
/// Skips when `chats.get.messageCount` is already 10_000.
pub fn ensure_isolated_10k_workspace<W: ProductWire>(
    wire: &mut W,
) -> Result<IsolatedSeedReport, ChatRouteError> {
    if let Some(existing) = find_isolated_chat(wire)? {
        let current = u32::try_from(existing.message_count.max(0)).unwrap_or(0);
        if current >= ISOLATED_10K_COUNT {
            return Ok(IsolatedSeedReport {
                chat_id: existing.id,
                character_id: existing.character_id,
                kernel_message_count: current,
                created: 0,
                skipped: true,
            });
        }
        let created = fill_messages(wire, &existing.id, current)?;
        let chat = get_chat(wire, &existing.id)?;
        return Ok(IsolatedSeedReport {
            chat_id: chat.id,
            character_id: chat.character_id,
            kernel_message_count: u32::try_from(chat.message_count.max(0)).unwrap_or(0),
            created,
            skipped: false,
        });
    }

    let character = call_decode(
        wire,
        "characters.create",
        &RequestCreateCharacter {
            name: ISOLATED_10K_TITLE.into(),
            description: Some("isolated Product Wire 10k fixture".into()),
            tags: Some(vec!["isolated-10k".into()]),
            avatar_asset_id: None,
            profile_id: None,
        },
        decode_character_dto,
    )?;
    let chat = call_decode(
        wire,
        "chats.create",
        &RequestCreateChat {
            character_id: character.id.clone(),
            title: Some(ISOLATED_10K_TITLE.into()),
            persona_id: None,
        },
        decode_chat_dto,
    )?;
    let created = fill_messages(wire, &chat.id, 0)?;
    let chat = get_chat(wire, &chat.id)?;
    Ok(IsolatedSeedReport {
        chat_id: chat.id,
        character_id: chat.character_id,
        kernel_message_count: u32::try_from(chat.message_count.max(0)).unwrap_or(0),
        created,
        skipped: false,
    })
}

fn find_isolated_chat<W: ProductWire>(wire: &mut W) -> Result<Option<ChatDto>, ChatRouteError> {
    let page: PagedChats = call_decode(
        wire,
        "chats.list",
        &RequestListChats {
            character_id: None,
            cursor: None,
            limit: Some(200),
        },
        decode_paged_chats,
    )?;
    Ok(page
        .items
        .into_iter()
        .find(|chat| chat.title == ISOLATED_10K_TITLE))
}

fn get_chat<W: ProductWire>(wire: &mut W, chat_id: &str) -> Result<ChatDto, ChatRouteError> {
    call_decode(
        wire,
        "chats.get",
        &RequestGetChat {
            chat_id: chat_id.to_string(),
        },
        decode_chat_dto,
    )
}

fn fill_messages<W: ProductWire>(
    wire: &mut W,
    chat_id: &str,
    already: u32,
) -> Result<u32, ChatRouteError> {
    let mut created = 0u32;
    for index in already..ISOLATED_10K_COUNT {
        let role = if index.is_multiple_of(2) {
            MessageRole::User
        } else {
            MessageRole::Assistant
        };
        let _ = call_decode(
            wire,
            "chats.messages.create",
            &RequestCreateMessage {
                chat_id: chat_id.to_string(),
                role,
                content: isolated_message_content(index),
                generation_run_id: None,
            },
            decode_message_dto,
        )?;
        created += 1;
    }
    Ok(created)
}

fn call_decode<W: ProductWire, T: Serialize, R: DeserializeOwned>(
    wire: &mut W,
    operation_id: &str,
    payload: &T,
    decode: fn(&[u8]) -> Result<R, contracts_generated::WireError>,
) -> Result<R, ChatRouteError> {
    assert_registered_command(operation_id)?;
    let value = serde_json::to_value(payload)?;
    let call = wire.call(operation_id, value)?;
    let bytes = serde_json::to_vec(&call.result)?;
    decode(&bytes).map_err(|err| ChatRouteError::Wire(err.message))
}

pub fn seed_trace_line(report: &IsolatedSeedReport) -> String {
    format!(
        "chat_seed profile={} chatId={} characterId={} kernelMessageCount={} created={} skipped={} production_cutover=false",
        ISOLATED_10K_PROFILE,
        report.chat_id,
        report.character_id,
        report.kernel_message_count,
        report.created,
        report.skipped,
    )
}
