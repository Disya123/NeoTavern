//! Phase 3 product CRUD operations (ТЗ §78 Фаза 3).
//!
//! Each operation decodes its request through the generated wire checkers
//! (`contracts_generated::generated::decode_*`), executes SQL over the
//! kernel's single writable connection, builds the wire result DTO, validates
//! it through the generated checkers and serializes it — the Phase 1
//! `handle_meta_get` pattern. Product-level failures (not found) surface as
//! [`KernelError`] values carrying the wire [`generated::ProductErrorDto`]
//! via [`KernelError::product`]; the host glue copies that DTO into the
//! response envelope verbatim.
//!
//! All requests are decoded through the generated checkers first, so
//! malformed input is a [`KernelErrorCode::ContractViolation`] — never a
//! panic. All writes flow through `Database::transaction` (the single-writer
//! coordinator); reads use prepared statements on `Database::conn()`.

use crate::{KernelError, KernelErrorCode};
use contracts_generated::generated::{
    self, CharacterDto, ChatDto, LorebookDto, MessageDto, MessageRole, PagedCharacters, PagedChats,
    PagedMessages, PersonaDto, PresetDto, ResultEmpty, ResultListLorebooks, ResultListPersonas,
    ResultListPresets,
};
use contracts_generated::Issue;
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter};

/// UTC now as an RFC 3339 wire timestamp (seconds precision).
pub(crate) fn now() -> String {
    neotavern_storage::now_utc_rfc3339()
}

/// Generates a fresh record id.
///
/// The frozen wire `uuid` format constrains the version nibble to 1–5
/// (`packages/contracts/src/wire/formats.ts`), which excludes RFC 9562 v7.
/// `Uuid::now_v7()` is used for its time-ordered uniqueness — stable cursor
/// pagination even for rows created within the same second — and the version
/// nibble is rewritten to 4 so the string satisfies the wire pattern.
pub(crate) fn new_id() -> String {
    const VERSION_NIBBLE_MASK: u128 = 0xF000_0000_0000_0000_0000;
    const V4_NIBBLE: u128 = 0x4000_0000_0000_0000_0000;
    let raw = uuid::Uuid::now_v7().as_u128();
    uuid::Uuid::from_u128((raw & !VERSION_NIBBLE_MASK) | V4_NIBBLE).to_string()
}

/// Encodes an opaque pagination cursor: base64url (no padding) of
/// `"{created_at}|{id}"`.
fn encode_cursor(created_at: &str, id: &str) -> String {
    encode_parts(&[created_at, id])
}

/// Encodes an opaque message pagination cursor: base64url (no padding) of
/// `"{sequence}|{id}"`.
fn encode_message_cursor(sequence: i64, id: &str) -> String {
    encode_parts(&[&sequence.to_string(), id])
}

fn encode_parts(parts: &[&str]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(parts.join("|"))
}

/// Decodes a `"{created_at}|{id}"` cursor. Malformed input is a
/// [`KernelErrorCode::ContractViolation`] — never a panic.
fn decode_cursor(cursor: &str) -> Result<(String, String), KernelError> {
    let text = decode_cursor_text(cursor)?;
    match text.split_once('|') {
        Some((created_at, id)) if !created_at.is_empty() && !id.is_empty() => {
            Ok((created_at.to_string(), id.to_string()))
        }
        _ => Err(malformed_cursor()),
    }
}

/// Decodes a `"{sequence}|{id}"` cursor (messages, ascending order).
fn decode_message_cursor(cursor: &str) -> Result<(i64, String), KernelError> {
    let text = decode_cursor_text(cursor)?;
    match text.split_once('|') {
        Some((sequence, id)) if !id.is_empty() => {
            let sequence = sequence.parse::<i64>().map_err(|_| malformed_cursor())?;
            Ok((sequence, id.to_string()))
        }
        _ => Err(malformed_cursor()),
    }
}

fn decode_cursor_text(cursor: &str) -> Result<String, KernelError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| malformed_cursor())?;
    String::from_utf8(bytes).map_err(|_| malformed_cursor())
}

fn malformed_cursor() -> KernelError {
    KernelError::new(KernelErrorCode::ContractViolation, "malformed cursor")
}

/// Page size: default 50, clamped into the wire bounds `1..=200`.
pub(crate) fn page_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(50).clamp(1, 200)
}

/// Classifies a SQLite failure as a kernel storage error in `context`.
pub(crate) fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::from(StorageError::from_sqlite(err, context))
}

/// Validates a result DTO against its generated wire checker. Failures are
/// [`KernelErrorCode::ContractViolation`] — a kernel-internal DTO bug, never
/// a payload problem (the DTO is built by this crate).
pub(crate) fn validate<T: serde::Serialize>(
    value: &T,
    check: fn(&serde_json::Value) -> Result<(), Vec<Issue>>,
) -> Result<(), KernelError> {
    let json = serde_json::to_value(value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize response dto: {err}"),
        )
    })?;
    check(&json).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "response dto failed wire validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })
}

/// Serializes a validated DTO to response bytes.
pub(crate) fn encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, KernelError> {
    let value = serde_json::to_value(value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize response dto: {err}"),
        )
    })?;
    serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize response dto: {err}"),
        )
    })
}

/// Builds a product-level not-found error: stable wire code
/// `"{entity}_NOT_FOUND"` with the camelCase id param mirroring the request
/// DTO field name (`characterId`, `chatId`, `lorebookId`, `presetId`).
fn not_found(entity: &str, id: &str) -> KernelError {
    let param = match entity {
        "CHARACTER" => "characterId",
        "CHAT" => "chatId",
        "MESSAGE" => "messageId",
        "LOREBOOK" => "lorebookId",
        "PRESET" => "presetId",
        "PERSONA" => "personaId",
        _ => "id",
    };
    KernelError::product(
        format!("{entity}_NOT_FOUND"),
        vec![(param.to_string(), id.to_string())],
    )
}

/// Renders a `characters` row as the wire [`CharacterDto`].
fn row_to_character(row: &rusqlite::Row) -> Result<CharacterDto, KernelError> {
    let tags_json: String = row
        .get(4)
        .map_err(|e| sqlite(e, "characters: read tags_json"))?;
    // The column is TEXT (STRICT); a malformed JSON value degrades to no
    // tags instead of a hard failure.
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    Ok(CharacterDto {
        id: row.get(0).map_err(|e| sqlite(e, "characters: read id"))?,
        name: row.get(1).map_err(|e| sqlite(e, "characters: read name"))?,
        description: row
            .get(2)
            .map_err(|e| sqlite(e, "characters: read description"))?,
        avatar_asset_id: row
            .get(3)
            .map_err(|e| sqlite(e, "characters: read avatar_asset_id"))?,
        tags,
        created_at: row
            .get(5)
            .map_err(|e| sqlite(e, "characters: read created_at"))?,
        updated_at: row
            .get(6)
            .map_err(|e| sqlite(e, "characters: read updated_at"))?,
    })
}

/// Renders a joined `chats` row (with `message_count`) as the wire
/// [`ChatDto`].
fn row_to_chat(row: &rusqlite::Row) -> Result<ChatDto, KernelError> {
    Ok(ChatDto {
        id: row.get(0).map_err(|e| sqlite(e, "chats: read id"))?,
        title: row.get(1).map_err(|e| sqlite(e, "chats: read title"))?,
        character_id: row
            .get(2)
            .map_err(|e| sqlite(e, "chats: read character_id"))?,
        message_count: row
            .get(3)
            .map_err(|e| sqlite(e, "chats: read message_count"))?,
        created_at: row
            .get(4)
            .map_err(|e| sqlite(e, "chats: read created_at"))?,
        updated_at: row
            .get(5)
            .map_err(|e| sqlite(e, "chats: read updated_at"))?,
    })
}

/// Renders a `messages` row as the wire [`MessageDto`].
pub(crate) fn row_to_message(row: &rusqlite::Row) -> Result<MessageDto, KernelError> {
    let role: String = row.get(2).map_err(|e| sqlite(e, "messages: read role"))?;
    let role = match role.as_str() {
        "system" => MessageRole::System,
        "user" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "tool" => MessageRole::Tool,
        other => {
            // The CHECK constraint makes this unreachable unless the database
            // was tampered with; a controlled error beats a panic.
            return Err(KernelError::new(
                KernelErrorCode::Internal,
                format!("invalid message role in database: {other}"),
            ));
        }
    };
    Ok(MessageDto {
        id: row.get(0).map_err(|e| sqlite(e, "messages: read id"))?,
        chat_id: row
            .get(1)
            .map_err(|e| sqlite(e, "messages: read chat_id"))?,
        role,
        content: row
            .get(3)
            .map_err(|e| sqlite(e, "messages: read content"))?,
        created_at: row
            .get(4)
            .map_err(|e| sqlite(e, "messages: read created_at"))?,
        sequence: row
            .get(5)
            .map_err(|e| sqlite(e, "messages: read sequence"))?,
        generation_run_id: row
            .get(6)
            .map_err(|e| sqlite(e, "messages: read generation_run_id"))?,
    })
}

/// Renders a `lorebooks` row (with `entry_count` from
/// `json_array_length(entries_json)`) as the wire [`LorebookDto`].
fn row_to_lorebook(row: &rusqlite::Row) -> Result<LorebookDto, KernelError> {
    Ok(LorebookDto {
        id: row.get(0).map_err(|e| sqlite(e, "lorebooks: read id"))?,
        name: row.get(1).map_err(|e| sqlite(e, "lorebooks: read name"))?,
        description: row
            .get(2)
            .map_err(|e| sqlite(e, "lorebooks: read description"))?,
        entry_count: row
            .get(3)
            .map_err(|e| sqlite(e, "lorebooks: read entry_count"))?,
        created_at: row
            .get(4)
            .map_err(|e| sqlite(e, "lorebooks: read created_at"))?,
        updated_at: row
            .get(5)
            .map_err(|e| sqlite(e, "lorebooks: read updated_at"))?,
    })
}

/// Renders a `presets` row as the wire [`PresetDto`].
fn row_to_preset(row: &rusqlite::Row) -> Result<PresetDto, KernelError> {
    Ok(PresetDto {
        id: row.get(0).map_err(|e| sqlite(e, "presets: read id"))?,
        name: row.get(1).map_err(|e| sqlite(e, "presets: read name"))?,
        created_at: row
            .get(2)
            .map_err(|e| sqlite(e, "presets: read created_at"))?,
        updated_at: row
            .get(3)
            .map_err(|e| sqlite(e, "presets: read updated_at"))?,
    })
}

/// Renders a `personas` row (with the integer `is_default` flag as the wire
/// boolean) as the wire [`PersonaDto`].
fn row_to_persona(row: &rusqlite::Row) -> Result<PersonaDto, KernelError> {
    let is_default: i64 = row
        .get(4)
        .map_err(|e| sqlite(e, "personas: read is_default"))?;
    Ok(PersonaDto {
        id: row.get(0).map_err(|e| sqlite(e, "personas: read id"))?,
        name: row.get(1).map_err(|e| sqlite(e, "personas: read name"))?,
        description: row
            .get(2)
            .map_err(|e| sqlite(e, "personas: read description"))?,
        avatar: row.get(3).map_err(|e| sqlite(e, "personas: read avatar"))?,
        is_default: is_default != 0,
        created_at: row
            .get(5)
            .map_err(|e| sqlite(e, "personas: read created_at"))?,
        updated_at: row
            .get(6)
            .map_err(|e| sqlite(e, "personas: read updated_at"))?,
    })
}

/// Loads one persona by id; `None` when absent.
fn query_persona(conn: &rusqlite::Connection, id: &str) -> Result<Option<PersonaDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, avatar, is_default, created_at, updated_at \
             FROM personas WHERE id = ?1",
        )
        .map_err(|e| sqlite(e, "personas_get: prepare"))?;
    let mut rows = stmt
        .query([id])
        .map_err(|e| sqlite(e, "personas_get: query"))?;
    let row = rows
        .next()
        .map_err(|e| sqlite(e, "personas_get: read row"))?;
    row.map(row_to_persona).transpose()
}

/// Clears the `is_default` flag on every persona — the single-default
/// invariant (legacy `PersonaRepository.clearDefault`), called on create and
/// update before a persona is marked default, inside the caller's
/// transaction. Returns [`StorageError`] so the `Database::transaction`
/// closure can `?` it directly.
fn clear_persona_default(tx: &rusqlite::Transaction) -> Result<(), StorageError> {
    tx.execute(
        "UPDATE personas SET is_default = 0 WHERE is_default = 1",
        [],
    )
    .map_err(|e| StorageError::from_sqlite(e, "personas: clear default"))?;
    Ok(())
}

/// Loads one character by id; `None` when absent.
fn query_character(
    conn: &rusqlite::Connection,
    id: &str,
) -> Result<Option<CharacterDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, avatar_asset_id, tags_json, created_at, updated_at \
             FROM characters WHERE id = ?1",
        )
        .map_err(|e| sqlite(e, "characters_get: prepare"))?;
    let mut rows = stmt
        .query(params![id])
        .map_err(|e| sqlite(e, "characters_get: query"))?;
    match rows
        .next()
        .map_err(|e| sqlite(e, "characters_get: read row"))?
    {
        Some(row) => Ok(Some(row_to_character(row)?)),
        None => Ok(None),
    }
}

/// `characters.list` — paginated characters, newest first.
pub fn characters_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_list_characters(request)?;
    let limit = page_limit(req.limit);
    let mut items: Vec<CharacterDto> = Vec::new();
    let mut next_cursor: Option<String> = None;
    {
        let conn = db.conn();
        let mut sql = String::from(
            "SELECT id, name, description, avatar_asset_id, tags_json, created_at, updated_at \
             FROM characters",
        );
        let mut params: Vec<Value> = Vec::new();
        if let Some(cursor) = &req.cursor {
            let (created_at, id) = decode_cursor(cursor)?;
            sql.push_str(" WHERE (created_at < ?) OR (created_at = ? AND id < ?)");
            params.push(Value::Text(created_at.clone()));
            params.push(Value::Text(created_at));
            params.push(Value::Text(id));
        }
        sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");
        // Probe one row past the page so the last exact page carries no cursor.
        params.push(Value::Integer(limit + 1));
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| sqlite(e, "characters_list: prepare"))?;
        let mut rows = stmt
            .query(params_from_iter(params))
            .map_err(|e| sqlite(e, "characters_list: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "characters_list: read row"))?
        {
            items.push(row_to_character(row)?);
        }
    }
    if items.len() > limit as usize {
        let last = &items[limit as usize - 1];
        next_cursor = Some(encode_cursor(&last.created_at, &last.id));
        items.truncate(limit as usize);
    }
    let dto = PagedCharacters { items, next_cursor };
    validate(&dto, generated::validate_paged_characters)?;
    encode(&dto)
}

/// `characters.get` — one character by id; missing character →
/// `CHARACTER_NOT_FOUND`.
pub fn characters_get(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_get_character(request)?;
    let dto = query_character(db.conn(), &req.character_id)?
        .ok_or_else(|| not_found("CHARACTER", &req.character_id))?;
    validate(&dto, generated::validate_character_dto)?;
    encode(&dto)
}

/// `characters.create` — insert a new character and return it.
pub fn characters_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_create_character(request)?;
    let id = new_id();
    let now = now();
    let tags = req.tags.unwrap_or_default();
    let tags_json = serde_json::to_string(&tags).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize tags: {err}"),
        )
    })?;
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, NULL, ?4, '{}', ?5, ?6)",
            params![&id, &req.name, &req.description, &tags_json, &now, &now],
        )
        .map_err(|e| StorageError::from_sqlite(e, "characters_create: insert"))?;
        Ok(())
    })?;
    let dto = query_character(db.conn(), &id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "characters_create: insert succeeded but select back found no row",
        )
    })?;
    validate(&dto, generated::validate_character_dto)?;
    encode(&dto)
}

/// `characters.update` — update the provided fields; missing character →
/// `CHARACTER_NOT_FOUND`.
pub fn characters_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_character(request)?;
    let id = req.character_id.clone();
    let now = now();
    let tags_json = match &req.tags {
        Some(tags) => Some(serde_json::to_string(tags).map_err(|err| {
            KernelError::new(
                KernelErrorCode::Internal,
                format!("failed to serialize tags: {err}"),
            )
        })?),
        None => None,
    };
    let changed = db.transaction(|tx| {
        let mut sets: Vec<&str> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if let Some(name) = &req.name {
            sets.push("name = ?");
            values.push(Value::Text(name.clone()));
        }
        if let Some(description) = &req.description {
            sets.push("description = ?");
            values.push(Value::Text(description.clone()));
        }
        if let Some(tags_json) = &tags_json {
            sets.push("tags_json = ?");
            values.push(Value::Text(tags_json.clone()));
        }
        sets.push("updated_at = ?");
        values.push(Value::Text(now.clone()));
        let sql = format!("UPDATE characters SET {} WHERE id = ?", sets.join(", "));
        values.push(Value::Text(id.clone()));
        tx.execute(&sql, params_from_iter(values))
            .map_err(|e| StorageError::from_sqlite(e, "characters_update: update"))
    })?;
    if changed == 0 {
        return Err(not_found("CHARACTER", &id));
    }
    let dto = query_character(db.conn(), &id)?.ok_or_else(|| not_found("CHARACTER", &id))?;
    validate(&dto, generated::validate_character_dto)?;
    encode(&dto)
}

/// `characters.delete` — remove a character (cascades to its chats and
/// messages); missing character → `CHARACTER_NOT_FOUND`.
pub fn characters_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_character(request)?;
    let changed = db.transaction(|tx| {
        tx.execute(
            "DELETE FROM characters WHERE id = ?1",
            params![&req.character_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "characters_delete: delete"))
    })?;
    if changed == 0 {
        return Err(not_found("CHARACTER", &req.character_id));
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

/// `chats.list` — paginated chats (optionally filtered by character), newest
/// first, each with its message count.
pub fn chats_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_list_chats(request)?;
    let limit = page_limit(req.limit);
    let mut items: Vec<ChatDto> = Vec::new();
    let mut next_cursor: Option<String> = None;
    {
        let conn = db.conn();
        let mut sql = String::from(
            "SELECT c.id, c.title, c.character_id, COALESCE(m.cnt, 0), c.created_at, c.updated_at \
             FROM chats c \
             LEFT JOIN (SELECT chat_id, COUNT(*) AS cnt FROM messages GROUP BY chat_id) m \
               ON m.chat_id = c.id",
        );
        let mut params: Vec<Value> = Vec::new();
        let mut where_clauses: Vec<&str> = Vec::new();
        if let Some(character_id) = &req.character_id {
            where_clauses.push("c.character_id = ?");
            params.push(Value::Text(character_id.clone()));
        }
        if let Some(cursor) = &req.cursor {
            let (created_at, id) = decode_cursor(cursor)?;
            where_clauses.push("(c.created_at < ?) OR (c.created_at = ? AND c.id < ?)");
            params.push(Value::Text(created_at.clone()));
            params.push(Value::Text(created_at));
            params.push(Value::Text(id));
        }
        if !where_clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY c.created_at DESC, c.id DESC LIMIT ?");
        // Probe one row past the page so the last exact page carries no cursor.
        params.push(Value::Integer(limit + 1));
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| sqlite(e, "chats_list: prepare"))?;
        let mut rows = stmt
            .query(params_from_iter(params))
            .map_err(|e| sqlite(e, "chats_list: query"))?;
        while let Some(row) = rows.next().map_err(|e| sqlite(e, "chats_list: read row"))? {
            items.push(row_to_chat(row)?);
        }
    }
    if items.len() > limit as usize {
        let last = &items[limit as usize - 1];
        next_cursor = Some(encode_cursor(&last.created_at, &last.id));
        items.truncate(limit as usize);
    }
    let dto = PagedChats { items, next_cursor };
    validate(&dto, generated::validate_paged_chats)?;
    encode(&dto)
}

/// `chats.get` — one chat by id with its message count; missing chat →
/// `CHAT_NOT_FOUND`.
pub fn chats_get(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_get_chat(request)?;
    let conn = db.conn();
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.title, c.character_id, COALESCE(m.cnt, 0), c.created_at, c.updated_at \
             FROM chats c \
             LEFT JOIN (SELECT chat_id, COUNT(*) AS cnt FROM messages GROUP BY chat_id) m \
               ON m.chat_id = c.id \
             WHERE c.id = ?1",
        )
        .map_err(|e| sqlite(e, "chats_get: prepare"))?;
    let mut rows = stmt
        .query(params![&req.chat_id])
        .map_err(|e| sqlite(e, "chats_get: query"))?;
    let dto = match rows.next().map_err(|e| sqlite(e, "chats_get: read row"))? {
        Some(row) => row_to_chat(row)?,
        None => return Err(not_found("CHAT", &req.chat_id)),
    };
    validate(&dto, generated::validate_chat_dto)?;
    encode(&dto)
}

/// `chats.messages.list` — paginated messages of one chat, walking the
/// durable `(sequence, id)` order either forward (`order: "asc"`, the
/// default, oldest first) or backward (`order: "desc"`, newest first);
/// missing chat → `CHAT_NOT_FOUND`.
pub fn messages_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_list_messages(request)?;
    let chat_id = req.chat_id.clone();
    // The wire op carries only a chatId; a missing chat is a product-level
    // CHAT_NOT_FOUND, not an empty page.
    if !chat_exists(db.conn(), &chat_id)? {
        return Err(not_found("CHAT", &chat_id));
    }
    let limit = page_limit(req.limit);
    let descending = req.order.as_deref() == Some("desc");
    let mut items: Vec<MessageDto> = Vec::new();
    let mut next_cursor: Option<String> = None;
    {
        let conn = db.conn();
        let mut sql = String::from(
            "SELECT id, chat_id, role, content, created_at, sequence, generation_run_id \
             FROM messages WHERE chat_id = ?",
        );
        let mut params: Vec<Value> = vec![Value::Text(chat_id.clone())];
        if let Some(cursor) = &req.cursor {
            let (sequence, id) = decode_message_cursor(cursor)?;
            if descending {
                // Strictly older than the cursor message.
                sql.push_str(" AND ((sequence < ?) OR (sequence = ? AND id < ?))");
            } else {
                sql.push_str(" AND ((sequence > ?) OR (sequence = ? AND id > ?))");
            }
            params.push(Value::Integer(sequence));
            params.push(Value::Integer(sequence));
            params.push(Value::Text(id));
        }
        if descending {
            sql.push_str(" ORDER BY sequence DESC, id DESC LIMIT ?");
        } else {
            sql.push_str(" ORDER BY sequence ASC, id ASC LIMIT ?");
        }
        // Probe one row past the page so the last exact page carries no cursor.
        params.push(Value::Integer(limit + 1));
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| sqlite(e, "messages_list: prepare"))?;
        let mut rows = stmt
            .query(params_from_iter(params))
            .map_err(|e| sqlite(e, "messages_list: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "messages_list: read row"))?
        {
            items.push(row_to_message(row)?);
        }
    }
    if items.len() > limit as usize {
        let last = &items[limit as usize - 1];
        next_cursor = Some(encode_message_cursor(last.sequence, &last.id));
        items.truncate(limit as usize);
    }
    let dto = PagedMessages { items, next_cursor };
    validate(&dto, generated::validate_paged_messages)?;
    encode(&dto)
}

pub(crate) fn chat_exists(conn: &rusqlite::Connection, chat_id: &str) -> Result<bool, KernelError> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM chats WHERE id = ?1")
        .map_err(|e| sqlite(e, "chat_exists: prepare"))?;
    let mut rows = stmt
        .query(params![chat_id])
        .map_err(|e| sqlite(e, "chat_exists: query"))?;
    rows.next()
        .map_err(|e| sqlite(e, "chat_exists: row"))
        .map(|row| row.is_some())
}

fn character_exists(conn: &rusqlite::Connection, character_id: &str) -> Result<bool, KernelError> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM characters WHERE id = ?1")
        .map_err(|e| sqlite(e, "character_exists: prepare"))?;
    let mut rows = stmt
        .query(params![character_id])
        .map_err(|e| sqlite(e, "character_exists: query"))?;
    rows.next()
        .map_err(|e| sqlite(e, "character_exists: row"))
        .map(|row| row.is_some())
}

/// Selects one chat (with message count) back out of the database.
fn query_chat(conn: &rusqlite::Connection, chat_id: &str) -> Result<Option<ChatDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.title, c.character_id, COALESCE(m.cnt, 0), c.created_at, c.updated_at \
             FROM chats c \
             LEFT JOIN (SELECT chat_id, COUNT(*) AS cnt FROM messages GROUP BY chat_id) m \
               ON m.chat_id = c.id \
             WHERE c.id = ?1",
        )
        .map_err(|e| sqlite(e, "query_chat: prepare"))?;
    let mut rows = stmt
        .query(params![chat_id])
        .map_err(|e| sqlite(e, "query_chat: query"))?;
    match rows.next().map_err(|e| sqlite(e, "query_chat: read row"))? {
        Some(row) => Ok(Some(row_to_chat(row)?)),
        None => Ok(None),
    }
}

/// Selects one message back out of the database, scoped to its chat.
fn query_message(
    conn: &rusqlite::Connection,
    chat_id: &str,
    message_id: &str,
) -> Result<Option<MessageDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, chat_id, role, content, created_at, sequence, generation_run_id \
             FROM messages WHERE id = ?1 AND chat_id = ?2",
        )
        .map_err(|e| sqlite(e, "query_message: prepare"))?;
    let mut rows = stmt
        .query(params![message_id, chat_id])
        .map_err(|e| sqlite(e, "query_message: query"))?;
    match rows
        .next()
        .map_err(|e| sqlite(e, "query_message: read row"))?
    {
        Some(row) => Ok(Some(row_to_message(row)?)),
        None => Ok(None),
    }
}

/// Returns the next message sequence for a chat: `MAX(sequence) + 1`, or 0
/// for an empty chat. Runs inside the caller's transaction so the sequence
/// is allocated and consumed atomically.
fn next_message_sequence(conn: &rusqlite::Connection, chat_id: &str) -> Result<i64, StorageError> {
    conn.query_row(
        "SELECT COALESCE(MAX(sequence) + 1, 0) FROM messages WHERE chat_id = ?1",
        params![chat_id],
        |row| row.get(0),
    )
    .map_err(|e| StorageError::from_sqlite(e, "next_message_sequence: query"))
}

fn role_sql(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

/// `chats.create` — create a chat for an existing character and return it;
/// missing character → `CHARACTER_NOT_FOUND`. A missing title defaults to
/// "New chat".
pub fn chats_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_create_chat(request)?;
    let character_id = req.character_id.clone();
    if !character_exists(db.conn(), &character_id)? {
        return Err(not_found("CHARACTER", &character_id));
    }
    let id = new_id();
    let now = now();
    let title = req.title.unwrap_or_else(|| "New chat".to_string());
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&id, &title, &character_id, &now, &now],
        )
        .map_err(|e| StorageError::from_sqlite(e, "chats_create: insert"))?;
        Ok(())
    })?;
    let dto = query_chat(db.conn(), &id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "chats_create: insert succeeded but select back found no row",
        )
    })?;
    validate(&dto, generated::validate_chat_dto)?;
    encode(&dto)
}

/// `chats.update` — rename a chat; missing chat → `CHAT_NOT_FOUND`.
pub fn chats_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_chat(request)?;
    let chat_id = req.chat_id.clone();
    let now = now();
    let changed = db.transaction(|tx| {
        tx.execute(
            "UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![&req.title, &now, &chat_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "chats_update: update"))
    })?;
    if changed == 0 {
        return Err(not_found("CHAT", &chat_id));
    }
    let dto = query_chat(db.conn(), &chat_id)?.ok_or_else(|| not_found("CHAT", &chat_id))?;
    validate(&dto, generated::validate_chat_dto)?;
    encode(&dto)
}

/// `chats.delete` — delete a chat (cascades to its messages); missing chat →
/// `CHAT_NOT_FOUND`.
pub fn chats_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_chat(request)?;
    let changed = db.transaction(|tx| {
        tx.execute("DELETE FROM chats WHERE id = ?1", params![&req.chat_id])
            .map_err(|e| StorageError::from_sqlite(e, "chats_delete: delete"))
    })?;
    if changed == 0 {
        return Err(not_found("CHAT", &req.chat_id));
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

/// `chats.messages.create` — append a message to a chat; missing chat →
/// `CHAT_NOT_FOUND`. The sequence is allocated atomically as
/// `MAX(sequence) + 1` within the chat.
pub fn messages_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_create_message(request)?;
    let chat_id = req.chat_id.clone();
    if !chat_exists(db.conn(), &chat_id)? {
        return Err(not_found("CHAT", &chat_id));
    }
    let id = new_id();
    let now = now();
    let role = role_sql(&req.role);
    let sequence = db.transaction(|tx| {
        let sequence = next_message_sequence(tx, &chat_id)?;
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &id,
                &chat_id,
                role,
                &req.content,
                sequence,
                &req.generation_run_id,
                &now
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "messages_create: insert"))?;
        Ok(sequence)
    })?;
    let dto = query_message(db.conn(), &chat_id, &id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "messages_create: insert succeeded but select back found no row",
        )
    })?;
    debug_assert_eq!(dto.sequence, sequence);
    validate(&dto, generated::validate_message_dto)?;
    encode(&dto)
}

/// `chats.messages.update` — edit a message's content; missing message →
/// `MESSAGE_NOT_FOUND` (the chat id scopes the update).
pub fn messages_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_message(request)?;
    let changed = db.transaction(|tx| {
        tx.execute(
            "UPDATE messages SET content = ?1 WHERE id = ?2 AND chat_id = ?3",
            params![&req.content, &req.message_id, &req.chat_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "messages_update: update"))
    })?;
    if changed == 0 {
        return Err(not_found("MESSAGE", &req.message_id));
    }
    let dto = query_message(db.conn(), &req.chat_id, &req.message_id)?
        .ok_or_else(|| not_found("MESSAGE", &req.message_id))?;
    validate(&dto, generated::validate_message_dto)?;
    encode(&dto)
}

/// `chats.messages.delete` — delete a message; missing message →
/// `MESSAGE_NOT_FOUND` (the chat id scopes the delete).
pub fn messages_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_message(request)?;
    let changed = db.transaction(|tx| {
        tx.execute(
            "DELETE FROM messages WHERE id = ?1 AND chat_id = ?2",
            params![&req.message_id, &req.chat_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "messages_delete: delete"))
    })?;
    if changed == 0 {
        return Err(not_found("MESSAGE", &req.message_id));
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

/// `lorebooks.list` — all lorebooks (plain list per the wire contract),
/// newest first, each with its entry count.
pub fn lorebooks_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    let mut items: Vec<LorebookDto> = Vec::new();
    {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, json_array_length(entries_json), created_at, updated_at \
                 FROM lorebooks ORDER BY created_at DESC, id DESC",
            )
            .map_err(|e| sqlite(e, "lorebooks_list: prepare"))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| sqlite(e, "lorebooks_list: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "lorebooks_list: read row"))?
        {
            items.push(row_to_lorebook(row)?);
        }
    }
    let dto = ResultListLorebooks { items };
    validate(&dto, generated::validate_result_list_lorebooks)?;
    encode(&dto)
}

/// Loads one lorebook row by id; `None` when absent.
fn query_lorebook(
    conn: &rusqlite::Connection,
    id: &str,
) -> Result<Option<LorebookDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, json_array_length(entries_json), created_at, updated_at \
             FROM lorebooks WHERE id = ?1",
        )
        .map_err(|e| sqlite(e, "lorebooks_get: prepare"))?;
    let mut rows = stmt
        .query([id])
        .map_err(|e| sqlite(e, "lorebooks_get: query"))?;
    let row = rows
        .next()
        .map_err(|e| sqlite(e, "lorebooks_get: read row"))?;
    row.map(row_to_lorebook).transpose()
}

/// Serializes the wire entry inputs into the stored `entries_json` array.
fn entries_json(entries: &[generated::LorebookEntryInput]) -> Result<String, KernelError> {
    serde_json::to_string(entries).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize lorebook entries: {err}"),
        )
    })
}

/// `lorebooks.get` — one lorebook; missing → `LOREBOOK_NOT_FOUND`.
pub fn lorebooks_get(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_get_lorebook(request)?;
    let dto = query_lorebook(db.conn(), &req.lorebook_id)?
        .ok_or_else(|| not_found("LOREBOOK", &req.lorebook_id))?;
    validate(&dto, generated::validate_lorebook_dto)?;
    encode(&dto)
}

/// `lorebooks.create` — insert a new lorebook (with optional entries) and
/// return it.
pub fn lorebooks_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_create_lorebook(request)?;
    let id = new_id();
    let now = now();
    let entries = entries_json(req.entries.as_deref().unwrap_or(&[]))?;
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO lorebooks (id, name, description, entries_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&id, &req.name, &req.description, &entries, &now, &now],
        )
        .map_err(|e| StorageError::from_sqlite(e, "lorebooks_create: insert"))?;
        Ok(())
    })?;
    let dto = query_lorebook(db.conn(), &id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "lorebooks_create: insert succeeded but select back found no row",
        )
    })?;
    validate(&dto, generated::validate_lorebook_dto)?;
    encode(&dto)
}

/// `lorebooks.update` — update the provided fields (name, description,
/// entries); missing lorebook → `LOREBOOK_NOT_FOUND`.
pub fn lorebooks_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_lorebook(request)?;
    let id = req.lorebook_id.clone();
    let now = now();
    let entries = match &req.entries {
        Some(entries) => Some(entries_json(entries)?),
        None => None,
    };
    let changed = db.transaction(|tx| {
        let mut sets: Vec<&str> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if let Some(name) = &req.name {
            sets.push("name = ?");
            values.push(Value::Text(name.clone()));
        }
        if let Some(description) = &req.description {
            sets.push("description = ?");
            values.push(Value::Text(description.clone()));
        }
        if let Some(entries) = &entries {
            sets.push("entries_json = ?");
            values.push(Value::Text(entries.clone()));
        }
        sets.push("updated_at = ?");
        values.push(Value::Text(now.clone()));
        let sql = format!("UPDATE lorebooks SET {} WHERE id = ?", sets.join(", "));
        values.push(Value::Text(id.clone()));
        tx.execute(&sql, params_from_iter(values))
            .map_err(|e| StorageError::from_sqlite(e, "lorebooks_update: update"))
    })?;
    if changed == 0 {
        return Err(not_found("LOREBOOK", &id));
    }
    let dto = query_lorebook(db.conn(), &id)?.ok_or_else(|| not_found("LOREBOOK", &id))?;
    validate(&dto, generated::validate_lorebook_dto)?;
    encode(&dto)
}

/// `lorebooks.delete` — remove a lorebook; missing → `LOREBOOK_NOT_FOUND`.
pub fn lorebooks_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_lorebook(request)?;
    let changed = db.transaction(|tx| {
        tx.execute(
            "DELETE FROM lorebooks WHERE id = ?1",
            params![&req.lorebook_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "lorebooks_delete: delete"))
    })?;
    if changed == 0 {
        return Err(not_found("LOREBOOK", &req.lorebook_id));
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

/// `presets.list` — all presets (plain list per the wire contract), newest
/// first.
pub fn presets_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    let mut items: Vec<PresetDto> = Vec::new();
    {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, created_at, updated_at \
                 FROM presets ORDER BY created_at DESC, id DESC",
            )
            .map_err(|e| sqlite(e, "presets_list: prepare"))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| sqlite(e, "presets_list: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "presets_list: read row"))?
        {
            items.push(row_to_preset(row)?);
        }
    }
    let dto = ResultListPresets { items };
    validate(&dto, generated::validate_result_list_presets)?;
    encode(&dto)
}

/// `personas.list` — all personas (plain list per the wire contract), newest
/// first.
pub fn personas_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    let mut items: Vec<PersonaDto> = Vec::new();
    {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, avatar, is_default, created_at, updated_at \
                 FROM personas ORDER BY created_at DESC, id DESC",
            )
            .map_err(|e| sqlite(e, "personas_list: prepare"))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| sqlite(e, "personas_list: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "personas_list: read row"))?
        {
            items.push(row_to_persona(row)?);
        }
    }
    let dto = ResultListPersonas { items };
    validate(&dto, generated::validate_result_list_personas)?;
    encode(&dto)
}

/// `personas.get` — one persona; missing → `PERSONA_NOT_FOUND`.
pub fn personas_get(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_get_persona(request)?;
    let dto = query_persona(db.conn(), &req.persona_id)?
        .ok_or_else(|| not_found("PERSONA", &req.persona_id))?;
    validate(&dto, generated::validate_persona_dto)?;
    encode(&dto)
}

/// `personas.create` — insert a new persona and return it. Marking it default
/// clears the previous default (single-default invariant).
pub fn personas_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_create_persona(request)?;
    let id = new_id();
    let now = now();
    let is_default = req.is_default.unwrap_or(false);
    db.transaction(|tx| {
        if is_default {
            clear_persona_default(tx)?;
        }
        tx.execute(
            "INSERT INTO personas (id, name, description, avatar, is_default, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &id,
                &req.name,
                &req.description,
                &req.avatar,
                is_default as i64,
                &now,
                &now
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "personas_create: insert"))?;
        Ok(())
    })?;
    let dto = query_persona(db.conn(), &id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "personas_create: insert succeeded but select back found no row",
        )
    })?;
    validate(&dto, generated::validate_persona_dto)?;
    encode(&dto)
}

/// `personas.update` — update the provided fields (name, description, avatar,
/// is_default); missing persona → `PERSONA_NOT_FOUND`. Marking default clears
/// the previous default.
pub fn personas_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_persona(request)?;
    let id = req.persona_id.clone();
    let now = now();
    let changed = db.transaction(|tx| {
        if req.is_default == Some(true) {
            clear_persona_default(tx)?;
        }
        let mut sets: Vec<&str> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if let Some(name) = &req.name {
            sets.push("name = ?");
            values.push(Value::Text(name.clone()));
        }
        if let Some(description) = &req.description {
            sets.push("description = ?");
            values.push(Value::Text(description.clone()));
        }
        if let Some(avatar) = &req.avatar {
            sets.push("avatar = ?");
            values.push(Value::Text(avatar.clone()));
        }
        if let Some(is_default) = req.is_default {
            sets.push("is_default = ?");
            values.push(Value::Integer(is_default as i64));
        }
        sets.push("updated_at = ?");
        values.push(Value::Text(now.clone()));
        let sql = format!("UPDATE personas SET {} WHERE id = ?", sets.join(", "));
        values.push(Value::Text(id.clone()));
        tx.execute(&sql, params_from_iter(values))
            .map_err(|e| StorageError::from_sqlite(e, "personas_update: update"))
    })?;
    if changed == 0 {
        return Err(not_found("PERSONA", &id));
    }
    let dto = query_persona(db.conn(), &id)?.ok_or_else(|| not_found("PERSONA", &id))?;
    validate(&dto, generated::validate_persona_dto)?;
    encode(&dto)
}

/// `personas.delete` — remove a persona; missing → `PERSONA_NOT_FOUND`.
pub fn personas_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_persona(request)?;
    let changed = db.transaction(|tx| {
        tx.execute(
            "DELETE FROM personas WHERE id = ?1",
            params![&req.persona_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "personas_delete: delete"))
    })?;
    if changed == 0 {
        return Err(not_found("PERSONA", &req.persona_id));
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}
