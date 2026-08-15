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
    self, CharacterDto, ChatDto, LorebookDto, MemoryDto, MemoryScope, MessageDraftDto, MessageDto,
    MessageRevisionDto, MessageRole, MessageVariantDto, PagedCharacters, PagedChats, PagedMessages,
    PersonaDto, PresetDto, RequestListPresets, ResultEmpty, ResultListLorebooks,
    ResultListMemories, ResultListPersonas, ResultListPresets, ResultMessageRevisionList,
    ResultMessageVariantList,
};
use contracts_generated::Issue;
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, OptionalExtension};

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

/// Serializes a validated DTO to response bytes (bounded — plan rev 2.2
/// Layer C): the serializer stops as soon as the registry-wide response
/// limit is produced, so the JSON string is never materialized unbounded.
pub(crate) fn encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, KernelError> {
    encode_limited(value, generated::DEFAULT_RESPONSE_LIMIT_BYTES)
}

/// Bounded serialization with an explicit byte limit (see [`encode`]).
/// A response that reaches `limit` bytes is aborted mid-write with the
/// stable `PAYLOAD_TOO_LARGE` product error instead of building the rest.
pub(crate) fn encode_limited<T: serde::Serialize>(
    value: &T,
    limit: u64,
) -> Result<Vec<u8>, KernelError> {
    let mut buf = Vec::with_capacity(4096);
    {
        let mut writer = LimitedWriter::new(&mut buf, limit);
        serde_json::to_writer(&mut writer, value).map_err(|err| {
            if err.io_error_kind() == Some(std::io::ErrorKind::WriteZero) {
                KernelError::product(
                    "PAYLOAD_TOO_LARGE",
                    vec![("limit".to_string(), limit.to_string())],
                )
            } else {
                KernelError::new(
                    KernelErrorCode::Internal,
                    format!("failed to serialize response dto: {err}"),
                )
            }
        })?;
    }
    Ok(buf)
}

/// A `Write` that refuses more than `limit` bytes: serialization stops AT
/// the limit (mid-write), never after materializing an unbounded string.
pub(crate) struct LimitedWriter<W: std::io::Write> {
    inner: W,
    limit: u64,
    written: u64,
}

impl<W: std::io::Write> LimitedWriter<W> {
    fn new(inner: W, limit: u64) -> Self {
        LimitedWriter {
            inner,
            limit,
            written: 0,
        }
    }
}

impl<W: std::io::Write> std::io::Write for LimitedWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let remaining = self.limit.saturating_sub(self.written);
        if buf.len() as u64 > remaining {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "response exceeds the wire byte limit",
            ));
        }
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Builds a product-level not-found error: stable wire code
/// `"{entity}_NOT_FOUND"` with the camelCase id param mirroring the request
/// DTO field name (`characterId`, `chatId`, `lorebookId`, `presetId`).
fn not_found(entity: &str, id: &str) -> KernelError {
    let param = match entity {
        "CHARACTER" => "characterId",
        "CHAT" => "chatId",
        "MESSAGE" => "messageId",
        "MESSAGE_VARIANT" => "variantId",
        "MESSAGE_REVISION" => "revisionId",
        "MESSAGE_DRAFT" => "draftId",
        "LOREBOOK" => "lorebookId",
        "PRESET" => "presetId",
        "PERSONA" => "personaId",
        "MEMORY" => "memoryId",
        _ => "id",
    };
    KernelError::product(
        format!("{entity}_NOT_FOUND"),
        vec![(param.to_string(), id.to_string())],
    )
}

/// Stable `PRESET_CONFLICT` product error: the `(kind, name)` pair already
/// exists (the canonical `presets` table enforces it via
/// `idx_presets_kind_name`, mirroring the legacy unique index).
fn preset_conflict(kind: &str, name: &str) -> KernelError {
    KernelError::product(
        "PRESET_CONFLICT".to_string(),
        vec![
            ("kind".to_string(), kind.to_string()),
            ("name".to_string(), name.to_string()),
        ],
    )
}

/// Stable `LOREBOOK_ENTRY_NOT_FOUND` product error (`entryId` param).
fn entry_not_found(entry_id: &str) -> KernelError {
    KernelError::product(
        "LOREBOOK_ENTRY_NOT_FOUND".to_string(),
        vec![("entryId".to_string(), entry_id.to_string())],
    )
}

/// Validate an optional character avatar reference: when present, the asset
/// must already be registered (`assets.put`); otherwise `ASSET_NOT_FOUND`.
/// Returns the id to persist, or `None` when the field was absent (Этап 4
/// slice 5 remainder — closes the avatar write path).
fn validate_avatar_asset(
    db: &Database,
    avatar_asset_id: Option<&str>,
) -> Result<Option<String>, KernelError> {
    let Some(id) = avatar_asset_id else {
        return Ok(None);
    };
    let exists: bool = db
        .conn()
        .query_row(
            "SELECT 1 FROM __neotavern_assets WHERE id = ?1",
            params![id],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| sqlite(e, "characters: avatar asset lookup"))?
        .unwrap_or(false);
    if !exists {
        return Err(crate::assets::asset_not_found(id));
    }
    Ok(Some(id.to_string()))
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
/// [`ChatDto`]. Column order: id, title, character_id, persona_id,
/// message_count, created_at, updated_at.
fn row_to_chat(row: &rusqlite::Row) -> Result<ChatDto, KernelError> {
    Ok(ChatDto {
        id: row.get(0).map_err(|e| sqlite(e, "chats: read id"))?,
        title: row.get(1).map_err(|e| sqlite(e, "chats: read title"))?,
        character_id: row
            .get(2)
            .map_err(|e| sqlite(e, "chats: read character_id"))?,
        persona_id: row
            .get(3)
            .map_err(|e| sqlite(e, "chats: read persona_id"))?,
        message_count: row
            .get(4)
            .map_err(|e| sqlite(e, "chats: read message_count"))?,
        created_at: row
            .get(5)
            .map_err(|e| sqlite(e, "chats: read created_at"))?,
        updated_at: row
            .get(6)
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

/// Renders a `presets` row (kind + `settings_json` as the wire `data`) as the
/// wire [`PresetDto`].
fn row_to_preset(row: &rusqlite::Row) -> Result<PresetDto, KernelError> {
    let data: String = row.get(3).map_err(|e| sqlite(e, "presets: read data"))?;
    let data: serde_json::Value = serde_json::from_str(&data).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("presets: invalid settings_json: {err}"),
        )
    })?;
    Ok(PresetDto {
        id: row.get(0).map_err(|e| sqlite(e, "presets: read id"))?,
        kind: row.get(1).map_err(|e| sqlite(e, "presets: read kind"))?,
        name: row.get(2).map_err(|e| sqlite(e, "presets: read name"))?,
        data,
        created_at: row
            .get(4)
            .map_err(|e| sqlite(e, "presets: read created_at"))?,
        updated_at: row
            .get(5)
            .map_err(|e| sqlite(e, "presets: read updated_at"))?,
    })
}

/// Renders a `memories` row as the wire [`MemoryDto`]. `keys_json` and
/// `metadata_json` are JSON text; `enabled`/`scope`/`character_id` map 1:1.
fn row_to_memory(row: &rusqlite::Row) -> Result<MemoryDto, KernelError> {
    let scope: String = row.get(1).map_err(|e| sqlite(e, "memories: read scope"))?;
    let scope = match scope.as_str() {
        "global" => MemoryScope::Global,
        "character" => MemoryScope::Character,
        other => {
            return Err(KernelError::new(
                KernelErrorCode::Internal,
                format!("memories: unexpected scope {other:?}"),
            ))
        }
    };
    let keys: String = row.get(3).map_err(|e| sqlite(e, "memories: read keys"))?;
    let keys: Vec<String> = serde_json::from_str(&keys).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("memories: invalid keys_json: {err}"),
        )
    })?;
    let enabled: i64 = row
        .get(5)
        .map_err(|e| sqlite(e, "memories: read enabled"))?;
    let metadata: String = row
        .get(7)
        .map_err(|e| sqlite(e, "memories: read metadata"))?;
    let metadata: serde_json::Value = serde_json::from_str(&metadata).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("memories: invalid metadata_json: {err}"),
        )
    })?;
    Ok(MemoryDto {
        id: row.get(0).map_err(|e| sqlite(e, "memories: read id"))?,
        scope,
        character_id: row
            .get(2)
            .map_err(|e| sqlite(e, "memories: read character_id"))?,
        keys,
        content: row
            .get(4)
            .map_err(|e| sqlite(e, "memories: read content"))?,
        enabled: enabled != 0,
        position: row
            .get(6)
            .map_err(|e| sqlite(e, "memories: read position"))?,
        metadata,
        created_at: row
            .get(8)
            .map_err(|e| sqlite(e, "memories: read created_at"))?,
        updated_at: row
            .get(9)
            .map_err(|e| sqlite(e, "memories: read updated_at"))?,
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
    // Avatar linkage: the referenced asset must exist (Этап 4 slice 5).
    let avatar = validate_avatar_asset(db, req.avatar_asset_id.as_deref())?;
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6, ?7)",
            params![
                &id,
                &req.name,
                &req.description,
                &avatar,
                &tags_json,
                &now,
                &now
            ],
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
    // Avatar linkage: the referenced asset must exist (Этап 4 slice 5).
    let avatar = validate_avatar_asset(db, req.avatar_asset_id.as_deref())?;
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
        if let Some(avatar) = &avatar {
            sets.push("avatar_asset_id = ?");
            values.push(Value::Text(avatar.clone()));
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
            "SELECT c.id, c.title, c.character_id, c.persona_id, COALESCE(m.cnt, 0), \
             c.created_at, c.updated_at \
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
            "SELECT c.id, c.title, c.character_id, c.persona_id, COALESCE(m.cnt, 0), \
             c.created_at, c.updated_at \
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

fn persona_exists(conn: &rusqlite::Connection, persona_id: &str) -> Result<bool, KernelError> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM personas WHERE id = ?1")
        .map_err(|e| sqlite(e, "persona_exists: prepare"))?;
    let mut rows = stmt
        .query(params![persona_id])
        .map_err(|e| sqlite(e, "persona_exists: query"))?;
    rows.next()
        .map_err(|e| sqlite(e, "persona_exists: row"))
        .map(|row| row.is_some())
}

/// Selects one chat (with message count) back out of the database.
fn query_chat(conn: &rusqlite::Connection, chat_id: &str) -> Result<Option<ChatDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.title, c.character_id, c.persona_id, COALESCE(m.cnt, 0), \
             c.created_at, c.updated_at \
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

/// Selects one `message_variants` row back as the wire [`MessageVariantDto`].
fn query_message_variant(
    conn: &rusqlite::Connection,
    message_id: &str,
    variant_id: &str,
) -> Result<Option<MessageVariantDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, message_id, position, content, created_at \
             FROM message_variants WHERE id = ?1 AND message_id = ?2",
        )
        .map_err(|e| sqlite(e, "query_message_variant: prepare"))?;
    let mut rows = stmt
        .query(params![variant_id, message_id])
        .map_err(|e| sqlite(e, "query_message_variant: query"))?;
    match rows
        .next()
        .map_err(|e| sqlite(e, "query_message_variant: read row"))?
    {
        Some(row) => Ok(Some(MessageVariantDto {
            id: row
                .get(0)
                .map_err(|e| sqlite(e, "query_message_variant: id"))?,
            message_id: row
                .get(1)
                .map_err(|e| sqlite(e, "query_message_variant: message_id"))?,
            position: row
                .get(2)
                .map_err(|e| sqlite(e, "query_message_variant: position"))?,
            content: row
                .get(3)
                .map_err(|e| sqlite(e, "query_message_variant: content"))?,
            created_at: row
                .get(4)
                .map_err(|e| sqlite(e, "query_message_variant: created_at"))?,
        })),
        None => Ok(None),
    }
}

/// Selects one `message_drafts` row as the wire [`MessageDraftDto`]. The
/// chat id scopes the read: a draft id alone does not identify a chat.
fn query_message_draft(
    conn: &rusqlite::Connection,
    chat_id: &str,
    draft_id: &str,
) -> Result<Option<MessageDraftDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, chat_id, role, content, sequence, revision, committed_message_id, \
             created_at, updated_at FROM message_drafts WHERE id = ?1 AND chat_id = ?2",
        )
        .map_err(|e| sqlite(e, "query_message_draft: prepare"))?;
    let mut rows = stmt
        .query(params![draft_id, chat_id])
        .map_err(|e| sqlite(e, "query_message_draft: query"))?;
    match rows
        .next()
        .map_err(|e| sqlite(e, "query_message_draft: read row"))?
    {
        Some(row) => {
            let role: String = row
                .get(2)
                .map_err(|e| sqlite(e, "query_message_draft: read role"))?;
            let role = match role.as_str() {
                "system" => MessageRole::System,
                "user" => MessageRole::User,
                "assistant" => MessageRole::Assistant,
                "tool" => MessageRole::Tool,
                other => {
                    return Err(KernelError::new(
                        KernelErrorCode::Internal,
                        format!("invalid draft role in database: {other}"),
                    ));
                }
            };
            Ok(Some(MessageDraftDto {
                id: row
                    .get(0)
                    .map_err(|e| sqlite(e, "query_message_draft: id"))?,
                chat_id: row
                    .get(1)
                    .map_err(|e| sqlite(e, "query_message_draft: chat_id"))?,
                role,
                content: row
                    .get(3)
                    .map_err(|e| sqlite(e, "query_message_draft: content"))?,
                sequence: row
                    .get(4)
                    .map_err(|e| sqlite(e, "query_message_draft: sequence"))?,
                revision: row
                    .get(5)
                    .map_err(|e| sqlite(e, "query_message_draft: revision"))?,
                committed_message_id: row
                    .get(6)
                    .map_err(|e| sqlite(e, "query_message_draft: committed_message_id"))?,
                created_at: row
                    .get(7)
                    .map_err(|e| sqlite(e, "query_message_draft: created_at"))?,
                updated_at: row
                    .get(8)
                    .map_err(|e| sqlite(e, "query_message_draft: updated_at"))?,
            }))
        }
        None => Ok(None),
    }
}

/// Records the previous text of a message as an immutable content revision
/// when `previous != next`. Returns whether a revision row was inserted.
/// Runs inside the caller's transaction.
fn record_content_revision(
    tx: &rusqlite::Transaction,
    message_id: &str,
    previous: &str,
    next: &str,
    created_at: &str,
) -> Result<bool, StorageError> {
    if previous == next {
        return Ok(false);
    }
    let inserted = tx
        .execute(
            "INSERT INTO message_content_revisions (id, message_id, position, content, created_at) \
             SELECT ?1, ?2, COALESCE(MAX(position) + 1, 0), ?3, ?4 \
             FROM message_content_revisions WHERE message_id = ?2",
            params![&new_id(), message_id, previous, created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "record_content_revision: insert"))?;
    Ok(inserted > 0)
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
    // A provided personaId must reference an existing persona (the FK is
    // enforced by the schema; the pre-check keeps the error stable and
    // product-typed instead of a raw constraint violation).
    if let Some(persona_id) = &req.persona_id {
        if !persona_exists(db.conn(), persona_id)? {
            return Err(not_found("PERSONA", persona_id));
        }
    }
    let id = new_id();
    let now = now();
    let title = req.title.unwrap_or_else(|| "New chat".to_string());
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO chats (id, title, character_id, persona_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&id, &title, &character_id, &req.persona_id, &now, &now],
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

/// `chats.update` — rename and/or re-link the user persona of a chat; missing
/// chat → `CHAT_NOT_FOUND`. A provided `personaId` must reference an existing
/// persona (`PERSONA_NOT_FOUND`); an update with neither field is a no-op
/// (returns the unchanged chat — the wire request has no required fields).
pub fn chats_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_chat(request)?;
    let chat_id = req.chat_id.clone();
    if let Some(persona_id) = &req.persona_id {
        if !persona_exists(db.conn(), persona_id)? {
            return Err(not_found("PERSONA", persona_id));
        }
    }
    let now = now();
    let mut sets: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(title) = &req.title {
        sets.push("title = ?".to_string());
        params.push(Value::Text(title.clone()));
    }
    if let Some(persona_id) = &req.persona_id {
        sets.push("persona_id = ?".to_string());
        params.push(Value::Text(persona_id.clone()));
    }
    if !sets.is_empty() {
        sets.push("updated_at = ?".to_string());
        params.push(Value::Text(now));
        let sql = format!("UPDATE chats SET {} WHERE id = ?", sets.join(", "));
        params.push(Value::Text(chat_id.clone()));
        let changed = db.transaction(|tx| {
            tx.execute(&sql, params_from_iter(params))
                .map_err(|e| StorageError::from_sqlite(e, "chats_update: update"))
        })?;
        if changed == 0 {
            return Err(not_found("CHAT", &chat_id));
        }
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
/// `MESSAGE_NOT_FOUND` (the chat id scopes the update). A content change
/// records the previous text as an immutable `message_content_revisions`
/// row (Этап 4 slice 2); an identical no-op edit is idempotent.
pub fn messages_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_message(request)?;
    let now_ts = now();
    // Pre-check outside the transaction (single-writer dispatch): a missing
    // message is a stable `MESSAGE_NOT_FOUND`, never a storage error.
    let previous: Option<String> = db
        .conn()
        .query_row(
            "SELECT content FROM messages WHERE id = ?1 AND chat_id = ?2",
            params![&req.message_id, &req.chat_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| sqlite(e, "messages_update: read previous"))?;
    let Some(previous) = previous else {
        return Err(not_found("MESSAGE", &req.message_id));
    };
    if previous != req.content {
        db.transaction(|tx| {
            record_content_revision(tx, &req.message_id, &previous, &req.content, &now_ts)?;
            tx.execute(
                "UPDATE messages SET content = ?1, updated_at = ?2 WHERE id = ?3 AND chat_id = ?4",
                params![&req.content, &now_ts, &req.message_id, &req.chat_id],
            )
            .map_err(|e| StorageError::from_sqlite(e, "messages_update: update"))?;
            Ok(())
        })?;
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

/// `chats.messages.variants.list` — all swipe variants of a message in
/// creation order (position ascending); missing message →
/// `MESSAGE_NOT_FOUND` (the chat id scopes the read).
pub fn message_variants_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_message_variants_list(request)?;
    if query_message(db.conn(), &req.chat_id, &req.message_id)?.is_none() {
        return Err(not_found("MESSAGE", &req.message_id));
    }
    let mut items: Vec<MessageVariantDto> = Vec::new();
    {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, message_id, position, content, created_at FROM message_variants \
                 WHERE message_id = ?1 ORDER BY position ASC, created_at ASC",
            )
            .map_err(|e| sqlite(e, "message_variants_list: prepare"))?;
        let mut rows = stmt
            .query(params![&req.message_id])
            .map_err(|e| sqlite(e, "message_variants_list: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "message_variants_list: read row"))?
        {
            items.push(MessageVariantDto {
                id: row
                    .get(0)
                    .map_err(|e| sqlite(e, "message_variants_list: id"))?,
                message_id: row
                    .get(1)
                    .map_err(|e| sqlite(e, "message_variants_list: message_id"))?,
                position: row
                    .get(2)
                    .map_err(|e| sqlite(e, "message_variants_list: position"))?,
                content: row
                    .get(3)
                    .map_err(|e| sqlite(e, "message_variants_list: content"))?,
                created_at: row
                    .get(4)
                    .map_err(|e| sqlite(e, "message_variants_list: created_at"))?,
            });
        }
    }
    let dto = ResultMessageVariantList { items };
    validate(&dto, generated::validate_result_message_variant_list)?;
    encode(&dto)
}

/// `chats.messages.variants.create` — append a swipe variant to a message;
/// missing message → `MESSAGE_NOT_FOUND`. The position is allocated
/// atomically as `MAX(position) + 1` within the message.
pub fn message_variants_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_message_variant_create(request)?;
    if query_message(db.conn(), &req.chat_id, &req.message_id)?.is_none() {
        return Err(not_found("MESSAGE", &req.message_id));
    }
    let id = new_id();
    let now_ts = now();
    let position = db.transaction(|tx| {
        let next: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM message_variants \
                 WHERE message_id = ?1",
                params![&req.message_id],
                |row| row.get(0),
            )
            .map_err(|e| StorageError::from_sqlite(e, "message_variants_create: next position"))?;
        tx.execute(
            "INSERT INTO message_variants (id, message_id, position, content, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&id, &req.message_id, next, &req.content, &now_ts],
        )
        .map_err(|e| StorageError::from_sqlite(e, "message_variants_create: insert"))?;
        Ok(next)
    })?;
    let dto = query_message_variant(db.conn(), &req.message_id, &id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "message_variants_create: insert succeeded but select back found no row",
        )
    })?;
    debug_assert_eq!(dto.position, position);
    validate(&dto, generated::validate_message_variant_dto)?;
    encode(&dto)
}

/// `chats.messages.variants.delete` — remove a swipe variant; missing
/// variant → `MESSAGE_VARIANT_NOT_FOUND` (message id scopes the delete).
pub fn message_variants_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_message_variant_delete(request)?;
    let changed = db.transaction(|tx| {
        tx.execute(
            "DELETE FROM message_variants WHERE id = ?1 AND message_id = ?2",
            params![&req.variant_id, &req.message_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "message_variants_delete: delete"))
    })?;
    if changed == 0 {
        return Err(not_found("MESSAGE_VARIANT", &req.variant_id));
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

/// `chats.messages.variants.activate` — copy a swipe variant's content into
/// the message, atomically (the message text is the active variant). The
/// replaced text is recorded as an immutable content revision. Missing
/// variant → `MESSAGE_VARIANT_NOT_FOUND`.
pub fn message_variants_activate(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_message_variant_activate(request)?;
    // Pre-checks outside the transaction: the single-writer dispatch means
    // the rows cannot change between check and write.
    let variant = query_message_variant(db.conn(), &req.message_id, &req.variant_id)?
        .ok_or_else(|| not_found("MESSAGE_VARIANT", &req.variant_id))?;
    let previous: Option<String> = db
        .conn()
        .query_row(
            "SELECT content FROM messages WHERE id = ?1 AND chat_id = ?2",
            params![&req.message_id, &req.chat_id],
            |row| row.get(0),
        )
        .map_err(|e| sqlite(e, "message_variants_activate: read content"))?;
    let Some(previous) = previous else {
        return Err(not_found("MESSAGE", &req.message_id));
    };
    let now_ts = now();
    db.transaction(|tx| {
        record_content_revision(tx, &req.message_id, &previous, &variant.content, &now_ts)?;
        tx.execute(
            "UPDATE messages SET content = ?1, updated_at = ?2 WHERE id = ?3 AND chat_id = ?4",
            params![&variant.content, &now_ts, &req.message_id, &req.chat_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "message_variants_activate: update"))?;
        Ok(())
    })?;
    let dto = query_message(db.conn(), &req.chat_id, &req.message_id)?
        .ok_or_else(|| not_found("MESSAGE", &req.message_id))?;
    validate(&dto, generated::validate_message_dto)?;
    encode(&dto)
}

/// `chats.messages.revisions.list` — all immutable content revisions of a
/// message in chronological order (position ascending); missing message →
/// `MESSAGE_NOT_FOUND`.
pub fn message_revisions_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_message_revisions_list(request)?;
    if query_message(db.conn(), &req.chat_id, &req.message_id)?.is_none() {
        return Err(not_found("MESSAGE", &req.message_id));
    }
    let mut items: Vec<MessageRevisionDto> = Vec::new();
    {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, message_id, position, content, created_at \
                 FROM message_content_revisions WHERE message_id = ?1 \
                 ORDER BY position ASC, created_at ASC",
            )
            .map_err(|e| sqlite(e, "message_revisions_list: prepare"))?;
        let mut rows = stmt
            .query(params![&req.message_id])
            .map_err(|e| sqlite(e, "message_revisions_list: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "message_revisions_list: read row"))?
        {
            items.push(MessageRevisionDto {
                id: row
                    .get(0)
                    .map_err(|e| sqlite(e, "message_revisions_list: id"))?,
                message_id: row
                    .get(1)
                    .map_err(|e| sqlite(e, "message_revisions_list: message_id"))?,
                position: row
                    .get(2)
                    .map_err(|e| sqlite(e, "message_revisions_list: position"))?,
                content: row
                    .get(3)
                    .map_err(|e| sqlite(e, "message_revisions_list: content"))?,
                created_at: row
                    .get(4)
                    .map_err(|e| sqlite(e, "message_revisions_list: created_at"))?,
            });
        }
    }
    let dto = ResultMessageRevisionList { items };
    validate(&dto, generated::validate_result_message_revision_list)?;
    encode(&dto)
}

/// `chats.messages.drafts.get` — read one server-side draft; missing draft →
/// `MESSAGE_DRAFT_NOT_FOUND` (the chat id scopes the read).
pub fn message_drafts_get(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_message_draft_get(request)?;
    let dto = query_message_draft(db.conn(), &req.chat_id, &req.draft_id)?
        .ok_or_else(|| not_found("MESSAGE_DRAFT", &req.draft_id))?;
    validate(&dto, generated::validate_message_draft_dto)?;
    encode(&dto)
}

/// `chats.messages.drafts.save` — create or update a server-side streaming
/// draft. Idempotent upsert: a save without `draftId` inserts a new draft
/// (revision 1); a save with a known `draftId` bumps `revision`; a save
/// with an unknown `draftId` creates the draft under that id so a retried
/// create replay converges. Missing chat → `CHAT_NOT_FOUND`.
pub fn message_drafts_save(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_message_draft_save(request)?;
    let chat_id = req.chat_id.clone();
    if !chat_exists(db.conn(), &chat_id)? {
        return Err(not_found("CHAT", &chat_id));
    }
    let now_ts = now();
    let id = req.draft_id.clone().unwrap_or_else(new_id);
    let draft_id = id.clone();
    let _inserted = db.transaction(|tx| {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM message_drafts WHERE id = ?1 AND chat_id = ?2)",
                params![&id, &chat_id],
                |row| row.get(0),
            )
            .map_err(|e| StorageError::from_sqlite(e, "message_drafts_save: exists"))?;
        if exists {
            tx.execute(
                "UPDATE message_drafts SET role = ?1, content = ?2, sequence = ?3, \
                 revision = revision + 1, updated_at = ?4 WHERE id = ?5 AND chat_id = ?6",
                params![
                    role_sql(&req.role),
                    &req.content,
                    req.sequence.unwrap_or(0),
                    &now_ts,
                    &id,
                    &chat_id
                ],
            )
            .map_err(|e| StorageError::from_sqlite(e, "message_drafts_save: update"))?;
            Ok(false)
        } else {
            tx.execute(
                "INSERT INTO message_drafts \
                 (id, chat_id, role, content, sequence, revision, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
                params![
                    &id,
                    &chat_id,
                    role_sql(&req.role),
                    &req.content,
                    req.sequence.unwrap_or(0),
                    &now_ts,
                    &now_ts
                ],
            )
            .map_err(|e| StorageError::from_sqlite(e, "message_drafts_save: insert"))?;
            Ok(true)
        }
    })?;
    let dto = query_message_draft(db.conn(), &chat_id, &draft_id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "message_drafts_save: write succeeded but select back found no row",
        )
    })?;
    validate(&dto, generated::validate_message_draft_dto)?;
    encode(&dto)
}

/// `chats.messages.drafts.commit` — materialize a draft as a real message
/// atomically. Idempotent: a committed draft returns its committed message
/// on replay instead of duplicating it (the outbox contract). The chat
/// sequence is allocated atomically at commit. Missing draft →
/// `MESSAGE_DRAFT_NOT_FOUND`.
pub fn message_drafts_commit(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_message_draft_commit(request)?;
    let chat_id = req.chat_id.clone();
    let draft_id = req.draft_id.clone();
    // Pre-check outside the transaction (single-writer dispatch): a missing
    // draft is a stable `MESSAGE_DRAFT_NOT_FOUND`, never a storage error.
    if query_message_draft(db.conn(), &chat_id, &draft_id)?.is_none() {
        return Err(not_found("MESSAGE_DRAFT", &draft_id));
    }
    let message_id = db.transaction(|tx| {
        let (role, content, committed): (String, String, Option<String>) = tx
            .query_row(
                "SELECT role, content, committed_message_id FROM message_drafts \
                 WHERE id = ?1 AND chat_id = ?2",
                params![&draft_id, &chat_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| StorageError::from_sqlite(e, "message_drafts_commit: read draft"))?;
        if let Some(message_id) = committed {
            return Ok(message_id);
        }
        let message_id = new_id();
        let now_ts = now();
        let sequence = next_message_sequence(tx, &chat_id)?;
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            params![&message_id, &chat_id, &role, &content, sequence, &now_ts],
        )
        .map_err(|e| StorageError::from_sqlite(e, "message_drafts_commit: insert message"))?;
        tx.execute(
            "UPDATE message_drafts SET committed_message_id = ?1, revision = revision + 1, \
             updated_at = ?2 WHERE id = ?3 AND chat_id = ?4",
            params![&message_id, &now_ts, &draft_id, &chat_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "message_drafts_commit: mark committed"))?;
        Ok(message_id)
    })?;
    let dto = query_message(db.conn(), &chat_id, &message_id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "message_drafts_commit: commit succeeded but select back found no row",
        )
    })?;
    validate(&dto, generated::validate_message_dto)?;
    encode(&dto)
}

/// `chats.messages.drafts.discard` — delete a server-side draft; missing
/// draft → `MESSAGE_DRAFT_NOT_FOUND`. A committed draft can be discarded
/// without touching the materialized message.
pub fn message_drafts_discard(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_message_draft_discard(request)?;
    let changed = db.transaction(|tx| {
        tx.execute(
            "DELETE FROM message_drafts WHERE id = ?1 AND chat_id = ?2",
            params![&req.draft_id, &req.chat_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "message_drafts_discard: delete"))
    })?;
    if changed == 0 {
        return Err(not_found("MESSAGE_DRAFT", &req.draft_id));
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
///
/// The kernel owns the per-entry `id`, `position`, `metadata` and timestamps
/// (the wire input has none of them) — without this the stored rows would not
/// satisfy the portable `ExportLoreEntry` shape that export/import and the
/// entry-level CRUD rely on (M4 slice 1).
fn entries_json(entries: &[generated::LorebookEntryInput]) -> Result<String, KernelError> {
    let stored: Result<Vec<serde_json::Value>, KernelError> = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| entry_input_to_stored(entry, index as i64))
        .collect();
    serde_json::to_string(&stored?).map_err(|err| {
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

// ---------------------------------------------------------------------------
// Entry-level lorebook operations (M4 slice 1, wire `lorebooks.entries.*`).
//
// The stored `entries_json` array keeps the full portable entry shape
// (`ExportLoreEntry`: id, keys, secondaryKeys, content, enabled, position,
// constant, selective, metadata, createdAt, updatedAt) so the export/import
// format stays lossless and unknown fields survive. The wire DTO only exposes
// the product-owned fields (id + keys/secondaryKeys/content/enabled/constant/
// selective); position/metadata/timestamps are preserved untouched on update.
// ---------------------------------------------------------------------------

/// Decodes the stored `entries_json` column into a JSON array (`[]` on
/// malformed content, never fails the call — unknown shapes are preserved).
fn read_entries_array(entries_json: &str) -> Vec<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(entries_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

/// Serializes the entry array back into the `entries_json` column.
fn write_entries_array(entries: &[serde_json::Value]) -> Result<String, KernelError> {
    serde_json::to_string(entries).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize lorebook entries: {err}"),
        )
    })
}

/// Projects one stored entry object into the wire [`generated::LorebookEntryDto`].
/// Entries without a usable `id` are skipped by callers; unknown fields are
/// ignored here (the DTO is the strict wire subset).
fn entry_to_dto(entry: &serde_json::Value) -> Option<generated::LorebookEntryDto> {
    let obj = entry.as_object()?;
    let id = obj.get("id")?.as_str()?;
    let content = obj.get("content")?.as_str()?;
    let str_vec = |key: &str| -> Vec<String> {
        obj.get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };
    let flag = |key: &str, default: bool| -> bool {
        obj.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
    };
    Some(generated::LorebookEntryDto {
        id: id.to_string(),
        keys: str_vec("keys"),
        secondary_keys: {
            let secondary = str_vec("secondaryKeys");
            if secondary.is_empty() {
                None
            } else {
                Some(secondary)
            }
        },
        content: content.to_string(),
        enabled: flag("enabled", true),
        constant: flag("constant", false),
        selective: flag("selective", false),
    })
}

/// Builds a fresh stored entry object from the wire input: the kernel owns
/// `id`, `position`, `metadata` and the timestamps; unknown input fields are
/// preserved as-is (AGENTS.md §11).
fn entry_input_to_stored(
    input: &generated::LorebookEntryInput,
    position: i64,
) -> Result<serde_json::Value, KernelError> {
    let now = now();
    let mut stored = serde_json::Map::new();
    stored.insert("id".to_string(), serde_json::Value::String(new_id()));
    stored.insert(
        "keys".to_string(),
        serde_json::Value::Array(
            input
                .keys
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    if let Some(secondary) = &input.secondary_keys {
        stored.insert(
            "secondaryKeys".to_string(),
            serde_json::Value::Array(
                secondary
                    .iter()
                    .cloned()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
    }
    stored.insert(
        "content".to_string(),
        serde_json::Value::String(input.content.clone()),
    );
    stored.insert(
        "enabled".to_string(),
        serde_json::Value::Bool(input.enabled.unwrap_or(true)),
    );
    stored.insert(
        "position".to_string(),
        serde_json::Value::Number(position.into()),
    );
    stored.insert(
        "constant".to_string(),
        serde_json::Value::Bool(input.constant.unwrap_or(false)),
    );
    stored.insert(
        "selective".to_string(),
        serde_json::Value::Bool(input.selective.unwrap_or(false)),
    );
    stored.insert(
        "metadata".to_string(),
        serde_json::Value::Object(serde_json::Map::new()),
    );
    stored.insert(
        "createdAt".to_string(),
        serde_json::Value::String(now.clone()),
    );
    stored.insert("updatedAt".to_string(), serde_json::Value::String(now));
    Ok(serde_json::Value::Object(stored))
}

/// Loads the stored entries of one lorebook; missing book → `LOREBOOK_NOT_FOUND`.
fn load_entries(
    db: &mut Database,
    lorebook_id: &str,
) -> Result<Vec<serde_json::Value>, KernelError> {
    let exists: bool = db
        .conn()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM lorebooks WHERE id = ?1)",
            params![lorebook_id],
            |row| row.get(0),
        )
        .map_err(|e| sqlite(e, "lorebooks_entries: book exists"))?;
    if !exists {
        return Err(not_found("LOREBOOK", lorebook_id));
    }
    let entries_json: String = db
        .conn()
        .query_row(
            "SELECT entries_json FROM lorebooks WHERE id = ?1",
            params![lorebook_id],
            |row| row.get(0),
        )
        .map_err(|e| sqlite(e, "lorebooks_entries: read entries"))?;
    Ok(read_entries_array(&entries_json))
}

/// Persists the entry array of one lorebook (bumps `updated_at`).
fn save_entries(
    db: &mut Database,
    lorebook_id: &str,
    entries: &[serde_json::Value],
) -> Result<(), KernelError> {
    let serialized = write_entries_array(entries)?;
    let now = now();
    Ok(db.transaction(|tx| {
        tx.execute(
            "UPDATE lorebooks SET entries_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![&serialized, &now, lorebook_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "lorebooks_entries: update"))?;
        Ok(())
    })?)
}

/// `lorebooks.entries.list` — the entries of one book, in stored order
/// (position-ordered by construction); missing book → `LOREBOOK_NOT_FOUND`.
pub fn lorebooks_entries_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_list_lorebook_entries(request)?;
    let stored = load_entries(db, &req.lorebook_id)?;
    let items: Vec<generated::LorebookEntryDto> = stored.iter().filter_map(entry_to_dto).collect();
    let dto = generated::ResultListLorebookEntries { items };
    validate(&dto, generated::validate_result_list_lorebook_entries)?;
    encode(&dto)
}

/// `lorebooks.entries.create` — append one entry; the kernel assigns the
/// entry id/position/metadata/timestamps. Missing book → `LOREBOOK_NOT_FOUND`.
pub fn lorebooks_entries_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_create_lorebook_entry(request)?;
    let mut stored = load_entries(db, &req.lorebook_id)?;
    let position = stored
        .iter()
        .filter_map(|entry| entry.get("position").and_then(|v| v.as_i64()))
        .max()
        .map(|max| max + 1)
        .unwrap_or(0);
    let new_entry = entry_input_to_stored(&req.entry, position)?;
    stored.push(new_entry.clone());
    save_entries(db, &req.lorebook_id, &stored)?;
    let dto = entry_to_dto(&new_entry).ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "lorebooks_entries.create: stored entry did not project to the wire dto",
        )
    })?;
    validate(&dto, generated::validate_lorebook_entry_dto)?;
    encode(&dto)
}

/// `lorebooks.entries.update` — apply a partial patch to one entry; missing
/// book → `LOREBOOK_NOT_FOUND`, missing entry → `LOREBOOK_ENTRY_NOT_FOUND`.
/// Only the provided fields are replaced; position/metadata/createdAt and
/// unknown fields are preserved.
pub fn lorebooks_entries_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_lorebook_entry(request)?;
    let mut stored = load_entries(db, &req.lorebook_id)?;
    let index = stored
        .iter()
        .position(|entry| entry.get("id").and_then(|v| v.as_str()) == Some(req.entry_id.as_str()));
    let Some(index) = index else {
        return Err(entry_not_found(&req.entry_id));
    };
    let mut entry = stored[index].clone();
    let patch = &req.patch;
    if let Some(keys) = &patch.keys {
        entry["keys"] = serde_json::Value::Array(
            keys.iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        );
    }
    if let Some(secondary) = &patch.secondary_keys {
        entry["secondaryKeys"] = serde_json::Value::Array(
            secondary
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        );
    }
    if let Some(content) = &patch.content {
        entry["content"] = serde_json::Value::String(content.clone());
    }
    if let Some(enabled) = patch.enabled {
        entry["enabled"] = serde_json::Value::Bool(enabled);
    }
    if let Some(constant) = patch.constant {
        entry["constant"] = serde_json::Value::Bool(constant);
    }
    if let Some(selective) = patch.selective {
        entry["selective"] = serde_json::Value::Bool(selective);
    }
    entry["updatedAt"] = serde_json::Value::String(now());
    stored[index] = entry.clone();
    save_entries(db, &req.lorebook_id, &stored)?;
    let dto = entry_to_dto(&entry).ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "lorebooks_entries.update: stored entry did not project to the wire dto",
        )
    })?;
    validate(&dto, generated::validate_lorebook_entry_dto)?;
    encode(&dto)
}

/// `lorebooks.entries.delete` — remove one entry; missing book →
/// `LOREBOOK_NOT_FOUND`, missing entry → `LOREBOOK_ENTRY_NOT_FOUND`.
pub fn lorebooks_entries_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_lorebook_entry(request)?;
    let mut stored = load_entries(db, &req.lorebook_id)?;
    let before = stored.len();
    stored.retain(|entry| entry.get("id").and_then(|v| v.as_str()) != Some(req.entry_id.as_str()));
    if stored.len() == before {
        return Err(entry_not_found(&req.entry_id));
    }
    save_entries(db, &req.lorebook_id, &stored)?;
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

/// `presets.list` — all presets (plain list per the wire contract), newest
/// first, optionally filtered by `kind`.
pub fn presets_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestListPresets = generated::decode_request_list_presets(request)?;
    let mut items: Vec<PresetDto> = Vec::new();
    {
        let conn = db.conn();
        let mut stmt = match &req.kind {
            Some(_) => conn
                .prepare(
                    "SELECT id, kind, name, settings_json, created_at, updated_at \
                     FROM presets WHERE kind = ?1 ORDER BY created_at DESC, id DESC",
                )
                .map_err(|e| sqlite(e, "presets_list: prepare (kind)"))?,
            None => conn
                .prepare(
                    "SELECT id, kind, name, settings_json, created_at, updated_at \
                     FROM presets ORDER BY created_at DESC, id DESC",
                )
                .map_err(|e| sqlite(e, "presets_list: prepare"))?,
        };
        let mut rows = match &req.kind {
            Some(kind) => stmt
                .query([kind])
                .map_err(|e| sqlite(e, "presets_list: query (kind)"))?,
            None => stmt
                .query([])
                .map_err(|e| sqlite(e, "presets_list: query"))?,
        };
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

/// Loads one `presets` row by id; `None` when absent.
fn query_preset(conn: &rusqlite::Connection, id: &str) -> Result<Option<PresetDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, name, settings_json, created_at, updated_at \
             FROM presets WHERE id = ?1",
        )
        .map_err(|e| sqlite(e, "presets_get: prepare"))?;
    let mut rows = stmt
        .query([id])
        .map_err(|e| sqlite(e, "presets_get: query"))?;
    let row = rows
        .next()
        .map_err(|e| sqlite(e, "presets_get: read row"))?;
    row.map(row_to_preset).transpose()
}

/// `presets.get` — one preset; missing → `PRESET_NOT_FOUND`.
pub fn presets_get(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_get_preset(request)?;
    let dto = query_preset(db.conn(), &req.preset_id)?
        .ok_or_else(|| not_found("PRESET", &req.preset_id))?;
    validate(&dto, generated::validate_preset_dto)?;
    encode(&dto)
}

/// `presets.create` — insert a new preset and return it. A duplicate
/// `(kind, name)` → `PRESET_CONFLICT`.
pub fn presets_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_create_preset(request)?;
    let id = new_id();
    let now = now();
    let data = serde_json::to_string(
        req.data
            .as_ref()
            .unwrap_or(&serde_json::Value::Object(Default::default())),
    )
    .map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("presets_create: serialize data: {err}"),
        )
    })?;
    let exists = db
        .conn()
        .query_row(
            "SELECT 1 FROM presets WHERE kind = ?1 AND name = ?2 LIMIT 1",
            params![&req.kind, &req.name],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| sqlite(e, "presets_create: uniqueness check"))?
        .is_some();
    if exists {
        return Err(preset_conflict(&req.kind, &req.name));
    }
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO presets (id, kind, name, settings_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&id, &req.kind, &req.name, &data, &now, &now],
        )
        .map_err(|e| StorageError::from_sqlite(e, "presets_create: insert"))?;
        Ok(())
    })?;
    let dto = query_preset(db.conn(), &id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "presets_create: insert succeeded but select back found no row",
        )
    })?;
    validate(&dto, generated::validate_preset_dto)?;
    encode(&dto)
}

/// `presets.update` — update name/data; missing preset → `PRESET_NOT_FOUND`;
/// a duplicate `(kind, name)` (when renaming) → `PRESET_CONFLICT`.
pub fn presets_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_preset(request)?;
    let id = req.preset_id.clone();
    let now = now();
    if let Some(name) = &req.name {
        let kind: String = db
            .conn()
            .query_row(
                "SELECT kind FROM presets WHERE id = ?1",
                params![&id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| sqlite(e, "presets_update: read kind"))?
            .ok_or_else(|| not_found("PRESET", &id))?;
        let dup = db
            .conn()
            .query_row(
                "SELECT 1 FROM presets WHERE kind = ?1 AND name = ?2 AND id <> ?3 LIMIT 1",
                params![&kind, name, &id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| sqlite(e, "presets_update: uniqueness check"))?
            .is_some();
        if dup {
            return Err(preset_conflict(&kind, name));
        }
    }
    let data = match &req.data {
        Some(data) => Some(serde_json::to_string(data).map_err(|err| {
            KernelError::new(
                KernelErrorCode::Internal,
                format!("presets_update: serialize data: {err}"),
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
        if let Some(data) = &data {
            sets.push("settings_json = ?");
            values.push(Value::Text(data.clone()));
        }
        sets.push("updated_at = ?");
        values.push(Value::Text(now.clone()));
        let sql = format!("UPDATE presets SET {} WHERE id = ?", sets.join(", "));
        values.push(Value::Text(id.clone()));
        tx.execute(&sql, params_from_iter(values))
            .map_err(|e| StorageError::from_sqlite(e, "presets_update: update"))
    })?;
    if changed == 0 {
        return Err(not_found("PRESET", &id));
    }
    let dto = query_preset(db.conn(), &id)?.ok_or_else(|| not_found("PRESET", &id))?;
    validate(&dto, generated::validate_preset_dto)?;
    encode(&dto)
}

/// `presets.delete` — remove a preset; missing → `PRESET_NOT_FOUND`.
pub fn presets_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_preset(request)?;
    let changed = db.transaction(|tx| {
        tx.execute("DELETE FROM presets WHERE id = ?1", params![&req.preset_id])
            .map_err(|e| StorageError::from_sqlite(e, "presets_delete: delete"))
    })?;
    if changed == 0 {
        return Err(not_found("PRESET", &req.preset_id));
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

/// `memories.list` — memories filtered by scope/character/enabled (all three
/// optional), ordered by position then creation time.
pub fn memories_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_list_memories(request)?;
    let mut items: Vec<MemoryDto> = Vec::new();
    {
        let conn = db.conn();
        let mut conditions: Vec<&str> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if let Some(scope) = &req.scope {
            conditions.push("scope = ?");
            values.push(Value::Text(scope_string(scope).to_string()));
        }
        if let Some(character_id) = &req.character_id {
            conditions.push("character_id = ?");
            values.push(Value::Text(character_id.clone()));
        }
        if let Some(enabled) = req.enabled {
            conditions.push("enabled = ?");
            values.push(Value::Integer(i64::from(enabled)));
        }
        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };
        let sql = format!(
            "SELECT id, scope, character_id, keys_json, content, enabled, position, \
             metadata_json, created_at, updated_at FROM memories{where_clause} \
             ORDER BY position ASC, created_at ASC, id ASC"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| sqlite(e, "memories_list: prepare"))?;
        let mut rows = stmt
            .query(params_from_iter(values))
            .map_err(|e| sqlite(e, "memories_list: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "memories_list: read row"))?
        {
            items.push(row_to_memory(row)?);
        }
    }
    let dto = ResultListMemories { items };
    validate(&dto, generated::validate_result_list_memories)?;
    encode(&dto)
}

/// The wire scope enum as the stored column value.
fn scope_string(scope: &MemoryScope) -> &'static str {
    match scope {
        MemoryScope::Global => "global",
        MemoryScope::Character => "character",
    }
}

/// Loads one `memories` row by id; `None` when absent.
fn query_memory(conn: &rusqlite::Connection, id: &str) -> Result<Option<MemoryDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, character_id, keys_json, content, enabled, position, \
             metadata_json, created_at, updated_at FROM memories WHERE id = ?1",
        )
        .map_err(|e| sqlite(e, "memories_get: prepare"))?;
    let mut rows = stmt
        .query([id])
        .map_err(|e| sqlite(e, "memories_get: query"))?;
    let row = rows
        .next()
        .map_err(|e| sqlite(e, "memories_get: read row"))?;
    row.map(row_to_memory).transpose()
}

/// `memories.create` — insert a new memory and return it. A character-scoped
/// memory with an unknown character id is rejected (`CHARACTER_NOT_FOUND`).
pub fn memories_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_create_memory(request)?;
    let scope = req.scope.clone().unwrap_or(MemoryScope::Global);
    let character_id = req.character_id.clone();
    if scope == MemoryScope::Character {
        if let Some(character_id) = &character_id {
            let exists = db
                .conn()
                .query_row(
                    "SELECT 1 FROM characters WHERE id = ?1 LIMIT 1",
                    params![character_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|e| sqlite(e, "memories_create: character check"))?
                .is_some();
            if !exists {
                return Err(not_found("CHARACTER", character_id));
            }
        } else {
            return Err(KernelError::product(
                "VALIDATION".to_string(),
                vec![(
                    "message".to_string(),
                    "character-scoped memory requires characterId".to_string(),
                )],
            ));
        }
    }
    let id = new_id();
    let now = now();
    let keys = serde_json::to_string(req.keys.as_deref().unwrap_or(&[])).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("memories_create: serialize keys: {err}"),
        )
    })?;
    let metadata = serde_json::to_string(
        req.metadata
            .as_ref()
            .unwrap_or(&serde_json::Value::Object(Default::default())),
    )
    .map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("memories_create: serialize metadata: {err}"),
        )
    })?;
    let enabled = req.enabled.unwrap_or(true);
    let position = req.position.unwrap_or(0);
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO memories (id, scope, character_id, keys_json, content, enabled, position, \
             metadata_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                &id,
                scope_string(&scope),
                &character_id,
                &keys,
                &req.content,
                i64::from(enabled),
                position,
                &metadata,
                &now,
                &now
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "memories_create: insert"))?;
        Ok(())
    })?;
    let dto = query_memory(db.conn(), &id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "memories_create: insert succeeded but select back found no row",
        )
    })?;
    validate(&dto, generated::validate_memory_dto)?;
    encode(&dto)
}

/// `memories.update` — update the provided fields; missing memory →
/// `MEMORY_NOT_FOUND`. A character-scoped memory must keep a valid
/// `characterId` (absent scope is left untouched).
pub fn memories_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_memory(request)?;
    let id = req.memory_id.clone();
    let now = now();
    if let (Some(scope), Some(character_id)) = (&req.scope, &req.character_id) {
        if *scope == MemoryScope::Character {
            let exists = db
                .conn()
                .query_row(
                    "SELECT 1 FROM characters WHERE id = ?1 LIMIT 1",
                    params![character_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|e| sqlite(e, "memories_update: character check"))?
                .is_some();
            if !exists {
                return Err(not_found("CHARACTER", character_id));
            }
        }
    }
    let keys = match &req.keys {
        Some(keys) => Some(serde_json::to_string(keys).map_err(|err| {
            KernelError::new(
                KernelErrorCode::Internal,
                format!("memories_update: serialize keys: {err}"),
            )
        })?),
        None => None,
    };
    let metadata = match &req.metadata {
        Some(metadata) => Some(serde_json::to_string(metadata).map_err(|err| {
            KernelError::new(
                KernelErrorCode::Internal,
                format!("memories_update: serialize metadata: {err}"),
            )
        })?),
        None => None,
    };
    let changed = db.transaction(|tx| {
        let mut sets: Vec<&str> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if let Some(scope) = &req.scope {
            sets.push("scope = ?");
            values.push(Value::Text(scope_string(scope).to_string()));
        }
        if let Some(character_id) = &req.character_id {
            sets.push("character_id = ?");
            values.push(Value::Text(character_id.clone()));
        }
        if let Some(keys) = &keys {
            sets.push("keys_json = ?");
            values.push(Value::Text(keys.clone()));
        }
        if let Some(content) = &req.content {
            sets.push("content = ?");
            values.push(Value::Text(content.clone()));
        }
        if let Some(enabled) = req.enabled {
            sets.push("enabled = ?");
            values.push(Value::Integer(i64::from(enabled)));
        }
        if let Some(position) = req.position {
            sets.push("position = ?");
            values.push(Value::Integer(position));
        }
        if let Some(metadata) = &metadata {
            sets.push("metadata_json = ?");
            values.push(Value::Text(metadata.clone()));
        }
        sets.push("updated_at = ?");
        values.push(Value::Text(now.clone()));
        let sql = format!("UPDATE memories SET {} WHERE id = ?", sets.join(", "));
        values.push(Value::Text(id.clone()));
        tx.execute(&sql, params_from_iter(values))
            .map_err(|e| StorageError::from_sqlite(e, "memories_update: update"))
    })?;
    if changed == 0 {
        return Err(not_found("MEMORY", &id));
    }
    let dto = query_memory(db.conn(), &id)?.ok_or_else(|| not_found("MEMORY", &id))?;
    validate(&dto, generated::validate_memory_dto)?;
    encode(&dto)
}

/// `memories.delete` — remove a memory; missing → `MEMORY_NOT_FOUND`.
pub fn memories_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_memory(request)?;
    let changed = db.transaction(|tx| {
        tx.execute(
            "DELETE FROM memories WHERE id = ?1",
            params![&req.memory_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "memories_delete: delete"))
    })?;
    if changed == 0 {
        return Err(not_found("MEMORY", &req.memory_id));
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn limited_writer_refuses_after_the_limit() {
        // The writer must stop at the limit mid-write (never let the caller
        // buffer past it) — plan rev 2.2 Layer C serialization invariant.
        let mut buf = Vec::new();
        {
            let mut writer = LimitedWriter::new(&mut buf, 10);
            assert_eq!(writer.write(b"0123456789").expect("write fits"), 10);
            let err = writer
                .write(b"overflow")
                .expect_err("must refuse past the limit");
            assert_eq!(err.kind(), std::io::ErrorKind::WriteZero);
        }
        assert_eq!(buf.len(), 10, "nothing past the limit may reach the buffer");
    }

    #[test]
    fn encode_limited_returns_payload_too_large_not_panic() {
        // Serializing a DTO whose JSON exceeds the limit must abort with the
        // stable PAYLOAD_TOO_LARGE product error — never a panic, never an
        // unbounded allocation of the JSON string.
        let value = serde_json::json!({ "blob": "x".repeat(64 * 1024) });
        let err = encode_limited(&value, 1024).expect_err("must exceed the 1 KiB limit");
        let product = err
            .product
            .as_ref()
            .expect("must carry the wire product dto");
        assert_eq!(product.code, "PAYLOAD_TOO_LARGE");
        assert_eq!(product.params["limit"], "1024");
    }

    #[test]
    fn encode_limited_under_the_limit_round_trips() {
        let value = serde_json::json!({ "ok": true });
        let bytes = encode_limited(&value, 1024).expect("fits the limit");
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).expect("must be valid JSON");
        assert_eq!(parsed, value);
    }
}
