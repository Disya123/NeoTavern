//! Durable plugin→message block attachments (rev4 stage 4, M7 Этап-4
//! cluster 15).
//!
//! A plugin attaches a block instance to one chat message; the host calls
//! these operations after its `blocks.attach` RPC once the plugin's
//! `ui.messageBlock` capability was granted HOST-side (the wire never trusts a
//! plugin-claimed grant). The attachment is durable DATA — owning plugin,
//! block type, renderer id, the immutable attach-time descriptor and the
//! renderer state captured by `blocks.freeze` on unmount — so a reload (or any
//! other client) remounts the block with the same state, while the renderer
//! itself stays host state: an attachment without a live renderer shows an
//! empty slot (AGENTS.md §17).
//!
//! - `chats.blocks.list` — batched read for a rendered page of messages (the
//!   legacy `GET /chats/:id/blocks` plus its 100-id cap): one query, no N+1,
//!   and only attachments of messages that actually belong to `chatId` are
//!   returned (ids of other chats are ignored, never leaked).
//! - `chats.blocks.attach` — one durable row per call (non-idempotent). The
//!   message must belong to the chat (`MESSAGE_NOT_FOUND`) and the plugin must
//!   be in the registry (`PLUGIN_NOT_FOUND`); a missing plugin is refused
//!   explicitly instead of surfacing a raw FK failure.
//! - `blocks.update` — replace the descriptor and/or persist (or explicitly
//!   clear) the renderer state. Supplying `serializedState` together with
//!   `clearSerializedState` is a `VALIDATION` refusal, never silent precedence.
//! - `blocks.delete` — detach one block (`BLOCK_NOT_FOUND` when already gone).
//!
//! `descriptor` and `serializedState` are free-form JSON OBJECTS on the wire:
//! the legacy plane stored any JSON value, and the honest kernel answer for a
//! non-object is `VALIDATION` (the wire cannot express a bare `unknown`).
//!
//! There is no cross-client change event here yet: the legacy plane emits
//! `chat.message.block.changed`, and the kernel event plane is cluster 18
//! (`events.*` SSE), still missing — so kernel-mode block changes are visible
//! to the client that made them (the host dispatches its own local event) and
//! to every other client on its next load, but not pushed live.

use contracts_generated::generated::{
    self, FreeObject, MessageBlockItem, RequestBlocksDelete, RequestBlocksUpdate,
    RequestChatsBlocksAttach, RequestChatsBlocksList, ResultChatsBlocksList,
};
use neotavern_storage::open::Database;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, OptionalExtension};

use crate::product::{self, new_id, now};
use crate::KernelError;

/// `chats.blocks.list` — batched read for one rendered page of messages.
pub(crate) fn chats_blocks_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestChatsBlocksList = generated::decode_request_chats_blocks_list(request)?;
    require_chat(db, &req.chat_id)?;

    // `?1` addresses the chat, `?2..` the requested messages; the JOIN keeps
    // the answer scoped to the chat even if a caller mixes ids from elsewhere.
    let mut sql = String::from(
        "SELECT b.id, b.message_id, b.plugin_id, b.block_type, b.renderer_id, \
                b.descriptor_json, b.serialized_state_json, b.created_at, b.updated_at \
         FROM message_blocks b JOIN messages m ON m.id = b.message_id \
         WHERE m.chat_id = ?1 AND b.message_id IN (",
    );
    for index in 0..req.message_ids.len() {
        if index > 0 {
            sql.push_str(", ");
        }
        sql.push('?');
    }
    sql.push_str(") ORDER BY b.created_at, b.id");

    let mut values: Vec<Value> = Vec::with_capacity(req.message_ids.len() + 1);
    values.push(Value::Text(req.chat_id.clone()));
    for message_id in &req.message_ids {
        values.push(Value::Text(message_id.clone()));
    }

    let mut stmt = db
        .conn()
        .prepare(&sql)
        .map_err(|err| sqlite(err, "chats.blocks.list: prepare"))?;
    let rows = stmt
        .query_map(params_from_iter(values), block_row)
        .map_err(|err| sqlite(err, "chats.blocks.list: query"))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|err| sqlite(err, "chats.blocks.list: row"))?);
    }
    encode_list(&ResultChatsBlocksList { items })
}

/// `chats.blocks.attach` — durably bind one block to a message.
pub(crate) fn chats_blocks_attach(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req: RequestChatsBlocksAttach = generated::decode_request_chats_blocks_attach(request)?;
    require_chat(db, &req.chat_id)?;
    require_message_in_chat(db, &req.chat_id, &req.message_id)?;
    require_plugin(db, &req.plugin_id)?;

    let id = new_id();
    let timestamp = now();
    let descriptor_json = descriptor_json(req.descriptor.as_ref())?;
    db.conn()
        .execute(
            "INSERT INTO message_blocks \
             (id, message_id, plugin_id, block_type, renderer_id, descriptor_json, \
              serialized_state_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
            params![
                id,
                req.message_id,
                req.plugin_id,
                req.block_type,
                req.renderer_id,
                descriptor_json,
                timestamp
            ],
        )
        .map_err(|err| sqlite(err, "chats.blocks.attach: insert"))?;
    encode_block(&block_by_id(db, &id)?)
}

/// `blocks.update` — replace the descriptor / persist (or clear) the state.
pub(crate) fn blocks_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestBlocksUpdate = generated::decode_request_blocks_update(request)?;
    if req.serialized_state.is_some() && req.clear_serialized_state == Some(true) {
        return Err(KernelError::product(
            "VALIDATION".to_string(),
            vec![(
                "message".to_string(),
                "serializedState and clearSerializedState are mutually exclusive".to_string(),
            )],
        ));
    }
    // An existing row is required even for a no-op patch: the legacy plane
    // answered MESSAGE_NOT_FOUND for a vanished attachment, and the kernel
    // keeps that single honest not-found answer.
    let existing = block_by_id(db, &req.block_id)?;

    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(descriptor) = req.descriptor.as_ref() {
        sets.push("descriptor_json = ?");
        values.push(Value::Text(descriptor_json(Some(descriptor))?));
    }
    if let Some(state) = req.serialized_state.as_ref() {
        sets.push("serialized_state_json = ?");
        values.push(Value::Text(descriptor_json(Some(state))?));
    } else if req.clear_serialized_state == Some(true) {
        sets.push("serialized_state_json = NULL");
    }
    // A bare `{ blockId }` patch keeps the row untouched (no updated_at bump),
    // exactly like the legacy repository.
    if sets.is_empty() {
        return encode_block(&existing);
    }
    sets.push("updated_at = ?");
    values.push(Value::Text(now()));
    values.push(Value::Text(req.block_id.clone()));

    let sql = format!("UPDATE message_blocks SET {} WHERE id = ?", sets.join(", "));
    let changed = db
        .conn()
        .execute(&sql, params_from_iter(values))
        .map_err(|err| sqlite(err, "blocks.update: update"))?;
    if changed == 0 {
        return Err(block_not_found(&req.block_id));
    }
    encode_block(&block_by_id(db, &req.block_id)?)
}

/// `blocks.delete` — detach one block by id.
pub(crate) fn blocks_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestBlocksDelete = generated::decode_request_blocks_delete(request)?;
    let changed = db
        .conn()
        .execute(
            "DELETE FROM message_blocks WHERE id = ?1",
            params![req.block_id],
        )
        .map_err(|err| sqlite(err, "blocks.delete: delete"))?;
    if changed == 0 {
        return Err(block_not_found(&req.block_id));
    }
    product::validate(&generated::ResultEmpty {}, generated::validate_result_empty)?;
    product::encode(&generated::ResultEmpty {})
}

// --- helpers --------------------------------------------------------------

const BLOCK_COLUMNS: &str = "id, message_id, plugin_id, block_type, renderer_id, \
                             descriptor_json, serialized_state_json, created_at, updated_at";

/// `CHAT_NOT_FOUND` product error (`chatId` param).
fn chat_not_found(chat_id: &str) -> KernelError {
    KernelError::product(
        "CHAT_NOT_FOUND".to_string(),
        vec![("chatId".to_string(), chat_id.to_string())],
    )
}

/// `MESSAGE_NOT_FOUND` product error (`messageId` param): the message does not
/// exist in this chat (the legacy plane answered the same for a foreign chat).
fn message_not_found(message_id: &str) -> KernelError {
    KernelError::product(
        "MESSAGE_NOT_FOUND".to_string(),
        vec![("messageId".to_string(), message_id.to_string())],
    )
}

/// `PLUGIN_NOT_FOUND` product error (`pluginId` param) — an attachment may only
/// belong to a plugin the registry knows (uninstall cascades it away).
fn plugin_not_found(plugin_id: &str) -> KernelError {
    KernelError::product(
        "PLUGIN_NOT_FOUND".to_string(),
        vec![("pluginId".to_string(), plugin_id.to_string())],
    )
}

fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    product::sqlite(err, context)
}

fn require_chat(db: &Database, chat_id: &str) -> Result<(), KernelError> {
    let exists: i64 = db
        .conn()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chats WHERE id = ?1)",
            params![chat_id],
            |row| row.get(0),
        )
        .map_err(|err| sqlite(err, "blocks: chat exists"))?;
    if exists == 0 {
        return Err(chat_not_found(chat_id));
    }
    Ok(())
}

fn require_message_in_chat(
    db: &Database,
    chat_id: &str,
    message_id: &str,
) -> Result<(), KernelError> {
    let exists: i64 = db
        .conn()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE id = ?1 AND chat_id = ?2)",
            params![message_id, chat_id],
            |row| row.get(0),
        )
        .map_err(|err| sqlite(err, "blocks: message exists"))?;
    if exists == 0 {
        return Err(message_not_found(message_id));
    }
    Ok(())
}

fn require_plugin(db: &Database, plugin_id: &str) -> Result<(), KernelError> {
    let exists: i64 = db
        .conn()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM plugins WHERE id = ?1)",
            params![plugin_id],
            |row| row.get(0),
        )
        .map_err(|err| sqlite(err, "blocks: plugin exists"))?;
    if exists == 0 {
        return Err(plugin_not_found(plugin_id));
    }
    Ok(())
}

/// `BLOCK_NOT_FOUND` product error (`blockId` param).
fn block_not_found(block_id: &str) -> KernelError {
    KernelError::product(
        "BLOCK_NOT_FOUND".to_string(),
        vec![("blockId".to_string(), block_id.to_string())],
    )
}

/// Stored JSON TEXT for a free-form wire object (`{}` when absent, matching the
/// legacy repository default).
fn descriptor_json(value: Option<&FreeObject>) -> Result<String, KernelError> {
    match value {
        None => Ok("{}".to_string()),
        Some(free) => serde_json::to_string(free).map_err(|err| {
            KernelError::new(
                crate::KernelErrorCode::Internal,
                format!("blocks: descriptor serialization failed: {err}"),
            )
        }),
    }
}

fn block_by_id(db: &Database, id: &str) -> Result<MessageBlockItem, KernelError> {
    db.conn()
        .query_row(
            &format!("SELECT {BLOCK_COLUMNS} FROM message_blocks WHERE id = ?1"),
            params![id],
            block_row,
        )
        .optional()
        .map_err(|err| sqlite(err, "blocks: row lookup"))?
        .ok_or_else(|| block_not_found(id))
}

fn block_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageBlockItem> {
    let descriptor_json: String = row.get(5)?;
    let serialized_state_json: Option<String> = row.get(6)?;
    Ok(MessageBlockItem {
        id: row.get(0)?,
        message_id: row.get(1)?,
        plugin_id: row.get(2)?,
        block_type: row.get(3)?,
        renderer_id: row.get(4)?,
        descriptor: parse_free_object(&descriptor_json, "descriptor_json")?,
        serialized_state: match serialized_state_json {
            Some(text) => Some(parse_free_object(&text, "serialized_state_json")?),
            None => None,
        },
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

/// A stored JSON document that no longer parses is storage corruption, never a
/// silent "no descriptor": it surfaces as a storage failure.
fn parse_free_object(text: &str, column: &str) -> rusqlite::Result<FreeObject> {
    serde_json::from_str::<FreeObject>(text).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("message_blocks.{column}: corrupted JSON document: {err}"),
            )),
        )
    })
}

fn encode_list(dto: &ResultChatsBlocksList) -> Result<Vec<u8>, KernelError> {
    product::validate(dto, generated::validate_result_chats_blocks_list)?;
    product::encode(dto)
}

fn encode_block(dto: &MessageBlockItem) -> Result<Vec<u8>, KernelError> {
    product::validate(dto, generated::validate_message_block_item)?;
    product::encode(dto)
}
