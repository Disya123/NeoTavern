//! Этап 4.5: character-card export (`characters.export.card`).
//!
//! Symmetric to `imports.character.card`: builds the SillyTavern card
//! container for one character and returns it base64-encoded so the UI can
//! download it without a second transport hop. When the character was created
//! by an import, the original card object is preserved verbatim under
//! `ext_json._card` (AGENTS.md §11) and the export round-trips it; a
//! character created without a card container is rebuilt from the canonical
//! columns with an honest warning.
//!
//! Formats:
//! - `json` — the card JSON itself (`application/json`);
//! - `png` — a minimal PNG whose `chara` tEXt chunk carries base64-encoded
//!   card JSON, exactly the container `imports.character.card` accepts, so an
//!   exported card re-imports verbatim (no lossy envelope change).

use base64::Engine as _;
use contracts_generated::generated::{
    self, CardExportFormat, ResultCharactersExportCard, ResultChatsExport,
};
use neotavern_storage::open::Database;
use rusqlite::OptionalExtension;

use crate::{KernelError, KernelErrorCode};

const CARD_KEYWORD: &str = "chara";
const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// `characters.export.card` — export one character as a SillyTavern card
/// container (`json` or `png`). Missing character → `CHARACTER_NOT_FOUND`.
pub fn characters_export_card(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_characters_export_card(request)?;

    // Read the canonical columns plus ext_json (the preserved card container).
    let row = db
        .conn()
        .query_row(
            "SELECT id, name, description, tags_json, ext_json FROM characters WHERE id = ?1",
            [&req.character_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .map_err(|err| {
            if matches!(err, rusqlite::Error::QueryReturnedNoRows) {
                character_not_found(&req.character_id)
            } else {
                crate::product::sqlite(err, "characters.export.card: read character")
            }
        })?;
    let (_id, name, description, tags_json, ext_json) = row;

    let mut warnings: Vec<String> = Vec::new();
    let card = build_card_json(
        &name,
        description.as_deref().unwrap_or(""),
        &tags_json,
        ext_json.as_deref(),
        &mut warnings,
    );

    let (filename, content_type, bytes) = match req.format {
        CardExportFormat::Json => {
            let bytes = serde_json::to_vec(&card).map_err(|err| {
                KernelError::new(
                    KernelErrorCode::Internal,
                    format!("characters.export.card: serialize card JSON: {err}"),
                )
            })?;
            (
                format!("{}.json", slugify(&name)),
                "application/json".to_string(),
                bytes,
            )
        }
        CardExportFormat::Png => {
            let json = serde_json::to_vec(&card).map_err(|err| {
                KernelError::new(
                    KernelErrorCode::Internal,
                    format!("characters.export.card: serialize card JSON: {err}"),
                )
            })?;
            let png = png_with_chara_card(&json);
            (
                format!("{}.png", slugify(&name)),
                "image/png".to_string(),
                png,
            )
        }
    };

    let dto = ResultCharactersExportCard {
        filename,
        content_type,
        content_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        warnings,
    };
    crate::product::validate(&dto, generated::validate_result_characters_export_card)?;
    crate::product::encode(&dto)
}

/// `chats.export` — dump one chat as the `neotavern-chat-export` v2 JSON
/// container (chat metadata + character name + the full message/variant/
/// revision dump), base64-encoded for download. Missing chat →
/// `CHAT_NOT_FOUND`. The container mirrors the legacy contour's shape
/// (`kind`/`version`/`exportedAt`/`chat`/`characterName`/`messages`/
/// `messageVariants`/`messageRevisions`) with canonical wire-visible fields
/// only — nothing is fabricated.
pub fn chats_export(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_chats_export(request)?;

    // 1. Chat row (canonical columns + snapshot trio).
    let chat_row = db
        .conn()
        .query_row(
            "SELECT id, title, character_id, persona_id, created_at, updated_at, \
             parent_chat_id, origin, source_message_id \
             FROM chats WHERE id = ?1",
            [&req.chat_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .map_err(|err| {
            if matches!(err, rusqlite::Error::QueryReturnedNoRows) {
                chat_not_found(&req.chat_id)
            } else {
                crate::product::sqlite(err, "chats.export: read chat")
            }
        })?;
    let (chat_id, title, character_id, persona_id, created_at, updated_at, parent_chat_id, origin, source_message_id) =
        chat_row;

    // 2. Character name for the container (optional; a deleted character
    //    yields null, exactly like the legacy contour).
    let character_name: Option<String> = db
        .conn()
        .query_row(
            "SELECT name FROM characters WHERE id = ?1",
            [&character_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| crate::product::sqlite(err, "chats.export: read character name"))?;

    // 3. Messages (canonical wire-visible fields, ordered by sequence).
    let mut messages: Vec<serde_json::Value> = Vec::new();
    {
        let mut stmt = db
            .conn()
            .prepare(
                "SELECT id, role, content, sequence, meta_json, created_at, \
                 checkpoint_chat_id, generation_run_id \
                 FROM messages WHERE chat_id = ?1 ORDER BY sequence",
            )
            .map_err(|err| crate::product::sqlite(err, "chats.export: prepare messages"))?;
        let mut rows = stmt
            .query(rusqlite::params![&chat_id])
            .map_err(|err| crate::product::sqlite(err, "chats.export: query messages"))?;
        while let Some(row) = rows
            .next()
            .map_err(|err| crate::product::sqlite(err, "chats.export: read message"))?
        {
            let id: String = row.get(0).map_err(|e| crate::product::sqlite(e, "chats.export: id"))?;
            let role: String = row.get(1).map_err(|e| crate::product::sqlite(e, "chats.export: role"))?;
            let content: String = row.get(2).map_err(|e| crate::product::sqlite(e, "chats.export: content"))?;
            let sequence: i64 = row.get(3).map_err(|e| crate::product::sqlite(e, "chats.export: sequence"))?;
            let meta_json: String = row.get(4).map_err(|e| crate::product::sqlite(e, "chats.export: meta"))?;
            let created_at: String = row.get(5).map_err(|e| crate::product::sqlite(e, "chats.export: created_at"))?;
            let checkpoint_chat_id: Option<String> = row.get(6).map_err(|e| crate::product::sqlite(e, "chats.export: checkpoint"))?;
            let generation_run_id: Option<String> = row.get(7).map_err(|e| crate::product::sqlite(e, "chats.export: run"))?;
            let meta: serde_json::Value = serde_json::from_str(&meta_json).unwrap_or_else(|_| serde_json::json!({}));
            let mut message = serde_json::json!({
                "id": id,
                "chatId": chat_id,
                "role": role,
                "content": content,
                "sequence": sequence,
                "createdAt": created_at,
                "meta": meta,
            });
            if let Some(checkpoint) = checkpoint_chat_id {
                message["checkpointChatId"] = serde_json::Value::String(checkpoint);
            }
            if let Some(run) = generation_run_id {
                message["generationRunId"] = serde_json::Value::String(run);
            }
            messages.push(message);
        }
    }

    // 4. Message variants (swipes) and manual content revisions, scoped to
    //    this chat through the message join.
    let variants = dump_variants_or_revisions(db, &chat_id, false)?;
    let revisions = dump_variants_or_revisions(db, &chat_id, true)?;

    let mut warnings: Vec<String> = Vec::new();
    if messages.is_empty() {
        warnings.push("chat has no messages; the container carries an empty dump".to_string());
    }

    let container = serde_json::json!({
        "kind": "neotavern-chat-export",
        "version": 2,
        "exportedAt": crate::product::now(),
        "chat": {
            "id": chat_id,
            "title": title,
            "characterId": character_id,
            "personaId": persona_id,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "parentChatId": parent_chat_id,
            "origin": origin,
            "sourceMessageId": source_message_id,
        },
        "characterName": character_name,
        "messages": messages,
        "messageVariants": variants,
        "messageRevisions": revisions,
    });

    let bytes = serde_json::to_vec(&container).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("chats.export: serialize container: {err}"),
        )
    })?;

    let dto = ResultChatsExport {
        filename: format!("chat-{chat_id}.json"),
        content_type: "application/json".to_string(),
        content_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        warnings,
    };
    crate::product::validate(&dto, generated::validate_result_chats_export)?;
    crate::product::encode(&dto)
}

/// Loads either the message variants or the content revisions of one chat
/// (through the message join), in position order.
fn dump_variants_or_revisions(
    db: &Database,
    chat_id: &str,
    revisions: bool,
) -> Result<Vec<serde_json::Value>, KernelError> {
    let (table, col): (&str, &str) = if revisions {
        ("message_content_revisions", "revision_id")
    } else {
        ("message_variants", "variant_id")
    };
    let sql = format!(
        "SELECT v.id, v.message_id, v.content, v.position, v.created_at \
         FROM {table} v JOIN messages m ON v.message_id = m.id \
         WHERE m.chat_id = ?1 ORDER BY v.position"
    );
    let mut stmt = db
        .conn()
        .prepare(&sql)
        .map_err(|err| crate::product::sqlite(err, "chats.export: prepare dump"))?;
    let mut rows = stmt
        .query(rusqlite::params![chat_id])
        .map_err(|err| crate::product::sqlite(err, "chats.export: query dump"))?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|err| crate::product::sqlite(err, "chats.export: read dump"))?
    {
        let id: String = row.get(0).map_err(|e| crate::product::sqlite(e, "chats.export: dump id"))?;
        let message_id: String = row.get(1).map_err(|e| crate::product::sqlite(e, "chats.export: dump message_id"))?;
        let content: String = row.get(2).map_err(|e| crate::product::sqlite(e, "chats.export: dump content"))?;
        let position: i64 = row.get(3).map_err(|e| crate::product::sqlite(e, "chats.export: dump position"))?;
        let created_at: String = row.get(4).map_err(|e| crate::product::sqlite(e, "chats.export: dump created_at"))?;
        out.push(serde_json::json!({
            "id": id,
            "messageId": message_id,
            "content": content,
            "position": position,
            "createdAt": created_at,
        }));
    }
    let _ = col; // column name is not part of the wire-visible rows
    Ok(out)
}

/// Stable `CHAT_NOT_FOUND` product error (`chatId` param).
fn chat_not_found(id: &str) -> KernelError {
    KernelError::product(
        "CHAT_NOT_FOUND".to_string(),
        vec![("chatId".to_string(), id.to_string())],
    )
}

/// Stable `CHARACTER_NOT_FOUND` product error (`characterId` param).
fn character_not_found(id: &str) -> KernelError {
    KernelError::product(
        "CHARACTER_NOT_FOUND".to_string(),
        vec![("characterId".to_string(), id.to_string())],
    )
}

/// Builds the card JSON for export.
///
/// Priority (AGENTS.md §11 — nothing may be lost):
/// 1. `ext_json._card` carrying its own V2 `spec` envelope → verbatim.
/// 2. `ext_json._card` without an envelope → wrapped in `chara_card_v2` with
///    an honest warning.
/// 3. no preserved container → rebuilt from the canonical columns with an
///    honest warning.
fn build_card_json(
    name: &str,
    description: &str,
    tags_json: &str,
    ext_json: Option<&str>,
    warnings: &mut Vec<String>,
) -> serde_json::Value {
    let preserved: Option<serde_json::Value> = ext_json
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|ext| ext.get("_card").cloned())
        .filter(|card| card.is_object());

    match preserved {
        Some(card) if card.get("spec").is_some() => {
            // Verbatim round trip of the original card file.
            card
        }
        Some(card) => {
            warnings.push(
                "original card had no V2 container envelope; wrapped in chara_card_v2".to_string(),
            );
            serde_json::json!({
                "spec": "chara_card_v2",
                "spec_version": "2.0",
                "data": card,
            })
        }
        None => {
            warnings.push("no original card container; rebuilt from canonical fields".to_string());
            let tags: Vec<String> = serde_json::from_str(tags_json).unwrap_or_default();
            serde_json::json!({
                "spec": "chara_card_v2",
                "spec_version": "2.0",
                "data": {
                    "name": name,
                    "description": description,
                    "personality": "",
                    "scenario": "",
                    "first_mes": "",
                    "mes_example": "",
                    "creator_notes": "",
                    "system_prompt": "",
                    "post_history_instructions": "",
                    "alternate_greetings": [],
                    "tags": tags,
                    "creator": "",
                    "character_version": "",
                    "extensions": {},
                },
            })
        }
    }
}

/// Lowercases `name` and keeps ASCII alphanumerics + `-` so the exported
/// filename is a safe download name; falls back to `character` when empty.
fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "character".to_string()
    } else {
        slug
    }
}

/// Builds a minimal valid PNG (1x1 transparent RGBA) whose `chara` tEXt chunk
/// carries the base64-encoded card JSON — the container shape
/// `imports.character.card` parses, so exports re-import verbatim.
fn png_with_chara_card(card_json: &[u8]) -> Vec<u8> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(card_json);
    let mut text_data = Vec::with_capacity(CARD_KEYWORD.len() + 1 + encoded.len());
    text_data.extend_from_slice(CARD_KEYWORD.as_bytes());
    text_data.push(0);
    text_data.extend_from_slice(encoded.as_bytes());

    // One 1x1 RGBA scanline: filter byte 0 + 4 transparent pixels.
    let raw: [u8; 5] = [0, 0, 0, 0, 0];
    let idat = zlib_stored(&raw);

    let mut png = Vec::with_capacity(64 + text_data.len() + idat.len());
    png.extend_from_slice(&PNG_SIGNATURE);
    push_chunk(&mut png, b"IHDR", &ihdr());
    push_chunk(&mut png, b"tEXt", &text_data);
    push_chunk(&mut png, b"IDAT", &idat);
    push_chunk(&mut png, b"IEND", &[]);
    png
}

fn ihdr() -> [u8; 13] {
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&1u32.to_be_bytes()); // width
    ihdr[4..8].copy_from_slice(&1u32.to_be_bytes()); // height
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    ihdr
}

fn push_chunk(png: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    png.extend_from_slice(chunk_type);
    png.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(chunk_type);
    crc_input.extend_from_slice(data);
    png.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// zlib stream wrapping a single stored (uncompressed) deflate block.
fn zlib_stored(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(6 + raw.len() + 4);
    // CMF 0x78 (deflate, 32K window), FLG 0x01 (FCHECK=1, no dict, fastest).
    out.extend_from_slice(&[0x78, 0x01]);
    // Stored block: BFINAL=1, BTYPE=00.
    out.push(0x01);
    let len = raw.len() as u16;
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&(!len).to_le_bytes());
    out.extend_from_slice(raw);
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65_521;
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + *byte as u32) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    // Standard CRC-32 (ISO-HDLC, reflected), built table-free per byte.
    let mut crc: u32 = 0xFFFF_FFFF;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}
