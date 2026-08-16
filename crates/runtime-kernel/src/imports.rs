//! Этап 4.5: character-card import (`imports.character.card`).
//!
//! The card file (SillyTavern-compatible V2 JSON, or a PNG carrying the
//! `chara` tEXt chunk with base64-encoded JSON) is staged through
//! `assets.put` (kind `card`); this operation parses it, deduplicates by the
//! sha256 of the original bytes and creates the character.
//!
//! Card fields beyond the canonical character columns
//! (`name`/`description`/`tags`) — personality, scenario, first message,
//! example dialogue, system prompt, post-history instructions, creator,
//! character version, extensions and any unknown fields — are preserved
//! verbatim under `ext_json._card` (AGENTS.md §11: unknown character card
//! fields and extension metadata must not be lost). Over-length scalar
//! columns are truncated with an honest warning; nothing is silently dropped.

use contracts_generated::generated::{self, ResultImportsCharacterCard};
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use crate::{KernelError, KernelErrorCode};

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const CARD_KEYWORD: &str = "chara";
const MAX_NAME_LEN: usize = 120;
const MAX_DESCRIPTION_LEN: usize = 10_000;
const MAX_TAGS: usize = 32;
const MAX_TAG_LEN: usize = 64;

/// Parsed, validated character-card payload.
struct ParsedCard {
    name: String,
    description: Option<String>,
    tags: Vec<String>,
    /// Full card JSON, stored verbatim under `ext_json._card` so nothing is
    /// lost (AGENTS.md §11).
    ext: serde_json::Value,
    /// Avatar for PNG cards: the staged asset itself. JSON cards carry none.
    avatar_asset_id: Option<String>,
    warnings: Vec<String>,
}

/// `imports.character.card` — parse a staged card asset and create the
/// character. Missing asset → `ASSET_NOT_FOUND`; an unparseable card →
/// `CHARACTER_CARD_INVALID`; the same card bytes → the existing character
/// with `created: false`.
pub fn imports_character_card(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_imports_character_card(request)?;

    // 1. The staged card asset must exist.
    let relative_key: String = db
        .conn()
        .query_row(
            "SELECT relative_key FROM __neotavern_assets WHERE id = ?1",
            rusqlite::params![req.asset_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "imports.character.card: asset lookup failed"))?
        .ok_or_else(|| crate::assets::asset_not_found(&req.asset_id))?;

    let path = neotavern_storage::assets::resolve_asset_path(db, &relative_key).map_err(|err| {
        KernelError::new(
            KernelErrorCode::StorageFailure,
            format!("imports.character.card: cannot resolve asset file: {err}"),
        )
    })?;
    let bytes = std::fs::read(&path).map_err(|err| {
        KernelError::new(
            KernelErrorCode::StorageFailure,
            format!("imports.character.card: cannot read asset file: {err}"),
        )
    })?;
    let source_hash = sha256_hex(&bytes);

    // 2. Deduplicate: the same card bytes must not create a second character
    // (AGENTS.md §11 — re-running an import must not create duplicates).
    let existing: Option<String> = db
        .conn()
        .query_row(
            "SELECT id FROM characters WHERE import_hash = ?1 LIMIT 1",
            rusqlite::params![&source_hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "imports.character.card: import lookup failed"))?;
    if let Some(id) = existing {
        let character = crate::product::query_character(db.conn(), &id)?.ok_or_else(|| {
            KernelError::new(
                KernelErrorCode::Internal,
                "imports.character.card: dedupe row disappeared",
            )
        })?;
        let result = ResultImportsCharacterCard {
            character,
            created: false,
            source_hash,
            warnings: Vec::new(),
        };
        return encode_result(&result);
    }

    // 3. Parse and validate the card (PNG `chara` tEXt chunk or JSON).
    let card = parse_card(&bytes, &req.asset_id)?;

    // 4. Insert the character.
    let id = crate::product::new_id();
    let now = crate::product::now();
    let tags_json = serde_json::to_string(&card.tags).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("imports.character.card: serialize tags: {err}"),
        )
    })?;
    let ext_json = serde_json::to_string(&card.ext).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("imports.character.card: serialize ext: {err}"),
        )
    })?;
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters \
             (id, name, description, avatar_asset_id, tags_json, ext_json, profile_id, \
              import_hash, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)",
            rusqlite::params![
                &id,
                &card.name,
                &card.description,
                &card.avatar_asset_id,
                &tags_json,
                &ext_json,
                &source_hash,
                &now,
                &now
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "imports.character.card: insert"))?;
        Ok(())
    })?;
    let character = crate::product::query_character(db.conn(), &id)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "imports.character.card: insert succeeded but select back found no row",
        )
    })?;
    let result = ResultImportsCharacterCard {
        character,
        created: true,
        source_hash,
        warnings: card.warnings,
    };
    encode_result(&result)
}

// --- card parsing ----------------------------------------------------------

/// Detects the card container: PNG signature → PNG `chara` tEXt chunk, else
/// the bytes must be a JSON object. Returns the parsed card JSON.
fn parse_card(bytes: &[u8], asset_id: &str) -> Result<ParsedCard, KernelError> {
    if bytes.starts_with(&PNG_SIGNATURE) {
        let json_bytes = extract_png_character_json(bytes)?;
        let value = parse_json_object(&json_bytes)?;
        build_card(value, Some(asset_id.to_string()))
    } else {
        let value = parse_json_object(bytes)?;
        build_card(value, None)
    }
}

/// Extracts the `chara` tEXt chunk payload from a PNG and returns its
/// base64-decoded bytes.
fn extract_png_character_json(bytes: &[u8]) -> Result<Vec<u8>, KernelError> {
    let mut offset = PNG_SIGNATURE.len();
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .expect("slice bounds checked above"),
        ) as usize;
        let type_start = offset + 4;
        let data_start = type_start + 4;
        let data_end = data_start + length;
        let chunk_end = data_end + 4;
        if chunk_end > bytes.len() {
            return Err(card_invalid("TRUNCATED_PNG_CHUNK"));
        }
        let chunk_type = &bytes[type_start..data_start];
        if chunk_type == b"tEXt" {
            let data = &bytes[data_start..data_end];
            let separator = data.iter().position(|b| *b == 0);
            if let Some(separator) = separator {
                let keyword = std::str::from_utf8(&data[..separator]).unwrap_or("");
                if keyword == CARD_KEYWORD {
                    let encoded = String::from_utf8_lossy(&data[separator + 1..]);
                    let encoded = encoded.trim();
                    return decode_card_base64(encoded);
                }
            }
        }
        if chunk_type == b"IEND" {
            break;
        }
        offset = chunk_end;
    }
    Err(card_invalid("PNG_CARD_METADATA_MISSING"))
}

/// Strict base64 decoding of the `chara` payload (the legacy contour accepts
/// the same alphabet — no padding chars inside, only trailing `=`).
fn decode_card_base64(encoded: &str) -> Result<Vec<u8>, KernelError> {
    use base64::Engine as _;
    if encoded.is_empty()
        || !encoded.len().is_multiple_of(4)
        || !encoded
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
    {
        return Err(card_invalid("INVALID_PNG_CARD_ENCODING"));
    }
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| card_invalid("INVALID_PNG_CARD_ENCODING"))
}

/// Parses bytes as a JSON object.
fn parse_json_object(bytes: &[u8]) -> Result<serde_json::Value, KernelError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| card_invalid("INVALID_JSON"))?;
    if !value.is_object() {
        return Err(card_invalid("INVALID_JSON"));
    }
    Ok(value)
}

/// Projects a card object onto the canonical character columns, preserving
/// everything else under `ext_json._card`.
fn build_card(
    value: serde_json::Value,
    avatar_asset_id: Option<String>,
) -> Result<ParsedCard, KernelError> {
    let mut warnings = Vec::new();
    let obj = value.as_object().expect("checked by parse_json_object");

    let raw_name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let name = truncate_str(raw_name, MAX_NAME_LEN, &mut warnings, "name");

    let raw_description = obj
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let description = if raw_description.is_empty() {
        None
    } else {
        Some(truncate_str(
            raw_description,
            MAX_DESCRIPTION_LEN,
            &mut warnings,
            "description",
        ))
    };

    let mut tags = Vec::new();
    if let Some(raw_tags) = obj.get("tags").and_then(|v| v.as_array()) {
        for raw in raw_tags {
            if let Some(tag) = raw.as_str() {
                if tag.is_empty() {
                    continue;
                }
                tags.push(truncate_str(tag, MAX_TAG_LEN, &mut warnings, "tag"));
            }
            if tags.len() >= MAX_TAGS {
                warnings.push("tags truncated to 32 entries".to_string());
                break;
            }
        }
    }

    Ok(ParsedCard {
        name,
        description,
        tags,
        ext: serde_json::json!({ "_card": value }),
        avatar_asset_id,
        warnings,
    })
}

/// Truncates a card scalar to a column limit, recording an honest warning.
fn truncate_str(value: &str, limit: usize, warnings: &mut Vec<String>, field: &str) -> String {
    if value.chars().count() > limit {
        warnings.push(format!("{field} truncated to {limit} characters"));
        value.chars().take(limit).collect()
    } else {
        value.to_string()
    }
}

// --- errors / helpers ------------------------------------------------------

/// Stable `CHARACTER_CARD_INVALID` product error (params carry the reason).
fn card_invalid(reason: &str) -> KernelError {
    KernelError::product(
        "CHARACTER_CARD_INVALID",
        vec![("reason".to_string(), reason.to_string())],
    )
}

fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StorageFailure, format!("{context}: {err}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn encode_result(dto: &ResultImportsCharacterCard) -> Result<Vec<u8>, KernelError> {
    crate::product::validate(dto, generated::validate_result_imports_character_card)?;
    crate::product::encode(dto)
}
