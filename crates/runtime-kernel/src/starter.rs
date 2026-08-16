//! Bundled Hazel character + Vesper lorebook (same files as the Fastify pack).
//!
//! Seeded once per data root when [`crate::SEED_STARTER_ENV`] is `1`/`true`.
//! The avatar PNG is larger than the wire `assets.put` limit, so this module
//! publishes bytes on the writer thread and never goes through dispatch.
//! After the `.complete` marker, deleting or editing the starter is user
//! intent — the next open does not restore it.

use contracts_generated::generated::{
    self, LorebookEntryInput, RequestCreateLorebook, RequestImportsCharacterCard,
    RequestUpdateCharacter,
};
use neotavern_storage::open::Database;
use rusqlite::OptionalExtension;

use crate::assets::publish_bytes;
use crate::imports::imports_character_card;
use crate::product::{characters_update, lorebooks_create, sqlite};
use crate::{KernelError, KernelErrorCode, SEED_STARTER_ENV};

const STARTER_VERSION: &str = "hazel-v1";
const COMPLETE_KEY: &str = "starter.hazel.v1.complete";
const CHARACTER_ID_KEY: &str = "starter.hazel.v1.characterId";
const LOREBOOK_ID_KEY: &str = "starter.hazel.v1.lorebookId";

const CARD_JSON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/server/assets/starter/default_Hazel.json"
));
const AVATAR_PNG: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/server/assets/starter/default_Hazel_avatar.png"
));
const LOREBOOK_JSON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/server/assets/starter/Vesper-lore-book.json"
));

/// Best-effort first-run seed. Failures log and leave the kernel open.
pub(crate) fn seed_if_needed(db: &mut Database) {
    if !seed_requested() {
        return;
    }
    match seed(db) {
        Ok(()) => {}
        Err(err) => eprintln!("kernel: starter content retry: {err}"),
    }
}

fn seed_requested() -> bool {
    matches!(
        std::env::var(SEED_STARTER_ENV).as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn seed(db: &mut Database) -> Result<(), KernelError> {
    if meta_get(db, COMPLETE_KEY)?.is_some() {
        return Ok(());
    }

    let card_id = publish_bytes(
        db,
        "card",
        "default_Hazel.json",
        CARD_JSON,
        Some("application/json"),
    )?
    .0;
    let imported = imports_character_card(
        db,
        &encode_json(&RequestImportsCharacterCard { asset_id: card_id })?,
    )?;
    let imported = generated::decode_result_imports_character_card(&imported)?;
    let character_id = imported.character.id;
    meta_set(db, CHARACTER_ID_KEY, &character_id)?;

    if imported.character.avatar_asset_id.is_none() {
        let avatar_id = publish_bytes(
            db,
            "avatar",
            "default_Hazel_avatar.png",
            AVATAR_PNG,
            Some("image/png"),
        )?
        .0;
        characters_update(
            db,
            &encode_json(&RequestUpdateCharacter {
                character_id: character_id.clone(),
                name: None,
                description: None,
                tags: None,
                avatar_asset_id: Some(avatar_id),
                profile_id: None,
            })?,
        )?;
    }

    let lorebook_id = match linked_lorebook(db, &character_id)? {
        Some(id) => id,
        None => create_vesper_lorebook(db, &character_id)?,
    };
    meta_set(db, LOREBOOK_ID_KEY, &lorebook_id)?;
    meta_set(db, COMPLETE_KEY, "1")?;
    eprintln!(
        "kernel: starter content ready bundle={STARTER_VERSION} characterId={character_id} lorebookId={lorebook_id}"
    );
    Ok(())
}

fn create_vesper_lorebook(db: &mut Database, character_id: &str) -> Result<String, KernelError> {
    let entries = parse_lorebook_entries(LOREBOOK_JSON)?;
    let bytes = lorebooks_create(
        db,
        &encode_json(&RequestCreateLorebook {
            name: "Vesper".to_string(),
            description: None,
            entries: Some(entries),
            character_id: Some(character_id.to_string()),
        })?,
    )?;
    Ok(generated::decode_lorebook_dto(&bytes)?.id)
}

fn parse_lorebook_entries(bytes: &[u8]) -> Result<Vec<LorebookEntryInput>, KernelError> {
    let root: serde_json::Value = serde_json::from_slice(bytes).map_err(|err| {
        KernelError::with_params(
            KernelErrorCode::Internal,
            format!("starter lorebook JSON: {err}"),
            Vec::new(),
        )
    })?;
    let Some(map) = root.get("entries").and_then(|value| value.as_object()) else {
        return Err(KernelError::with_params(
            KernelErrorCode::Internal,
            "starter lorebook entries missing",
            Vec::new(),
        ));
    };
    let mut entries = Vec::new();
    for (_source_id, value) in map {
        let Some(obj) = value.as_object() else {
            continue;
        };
        let keys = string_array(obj.get("key"));
        if keys.is_empty() {
            continue;
        }
        let content = obj
            .get("content")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .trim();
        if content.is_empty() {
            continue;
        }
        let secondary = string_array(obj.get("keysecondary"));
        let selective = obj.get("selective").and_then(|item| item.as_bool()) == Some(true)
            && !secondary.is_empty();
        entries.push(LorebookEntryInput {
            keys,
            secondary_keys: if secondary.is_empty() {
                None
            } else {
                Some(secondary)
            },
            content: content.to_string(),
            enabled: Some(obj.get("disable").and_then(|item| item.as_bool()) != Some(true)),
            constant: obj.get("constant").and_then(|item| item.as_bool()),
            selective: Some(selective),
        });
    }
    if entries.len() != 4 {
        return Err(KernelError::with_params(
            KernelErrorCode::Internal,
            format!("starter lorebook expected 4 entries, got {}", entries.len()),
            Vec::new(),
        ));
    }
    Ok(entries)
}

fn string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    let Some(items) = value.and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn linked_lorebook(db: &Database, character_id: &str) -> Result<Option<String>, KernelError> {
    db.conn()
        .query_row(
            "SELECT lorebook_id FROM character_lorebooks WHERE character_id = ?1 LIMIT 1",
            rusqlite::params![character_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "starter: linked lorebook lookup"))
}

fn meta_get(db: &Database, key: &str) -> Result<Option<String>, KernelError> {
    db.conn()
        .query_row(
            "SELECT value FROM __neotavern_meta WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "starter: meta get"))
}

fn meta_set(db: &Database, key: &str, value: &str) -> Result<(), KernelError> {
    db.conn()
        .execute(
            "INSERT INTO __neotavern_meta (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|err| sqlite(err, "starter: meta set"))?;
    Ok(())
}

fn encode_json<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, KernelError> {
    serde_json::to_vec(value).map_err(|err| {
        KernelError::with_params(
            KernelErrorCode::Internal,
            format!("starter: serialize request: {err}"),
            Vec::new(),
        )
    })
}
