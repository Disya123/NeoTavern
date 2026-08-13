//! Portable Export / import primitives (ТЗ §43, Фаза 11).
//!
//! # Container layout
//!
//! A portable export is a self-contained directory:
//!
//! ```text
//! <dest>/
//!   characters.ndjson   one JSON object per line, rows ordered by id
//!   chats.ndjson
//!   messages.ndjson
//!   lorebooks.ndjson
//!   presets.ndjson
//!   assets/<key>        byte copies of every referenced asset
//!   manifest.json       written LAST (atomic), the container inventory
//! ```
//!
//! Record field names are camelCase and mirror the kernel columns
//! (`characters.avatarAssetId` ← `avatar_asset_id`, `chats.characterId` ←
//! `character_id`, `messages.chatId` ← `chat_id`, `createdAt`/`updatedAt`,
//! `ext`/`settings`/`entries` JSON payloads). Records carry stable ids and
//! explicit references — there is no hidden ordering semantics beyond
//! "ordered by id".
//!
//! # Bounds
//!
//! The manifest is parsed with a 1 MiB cap; every NDJSON file is bounded at
//! 1 000 000 lines of at most 1 MiB each. Violations are rejected — as
//! `Corrupt`, or as `UnsupportedStorageFormat` for a newer format version —
//! at [`verify_export`] time, before any import write.
//!
//! # Import
//!
//! [`apply_import`] verifies the container, parses and validates ALL records,
//! checks referential integrity (chats referencing missing characters, and
//! messages referencing missing chats, are skipped and reported — never
//! invented), then applies the record set in a single transaction under the
//! chosen [`DuplicatePolicy`]. Re-running under `Reject` adds nothing.
//!
//! Asset bytes are copied into the container at export time (checksum-
//! verified) and re-verified by [`verify_export`]; [`apply_import`] applies
//! the record set and preserves `avatarAssetId` references verbatim so the
//! kernel can publish the carried assets when it activates an import.
//!
//! # Remap ids
//!
//! [`DuplicatePolicy::Remap`] assigns a fresh id to every incoming record.
//! The storage crate deliberately has no id generator (the kernel owns
//! `product::new_id`), so ids come from the local `uuid_v7()` helper:
//! RFC 9562 UUIDv7 — 48 bits of Unix-epoch milliseconds, version nibble 7,
//! RFC 4122 variant bits, and 74 random bits drawn from `std`'s OS-seeded
//! `RandomState` — time-ordered like the kernel's ids so id-ordering stays
//! chronological.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use rusqlite::OptionalExtension;

use crate::error::{io_err, Result, StorageError, StorageErrorCode};
use crate::now_utc_rfc3339;
use crate::open::Database;
use crate::paths::{assets_dir, join_checked, validate_relative_key};
use crate::restore::write_atomic;
use crate::snapshot::sha256_file_hex;

/// Name of the portable-export container format.
pub const EXPORT_FORMAT: &str = "neotavern-export";

/// Format version written by this build.
pub const EXPORT_FORMAT_VERSION: u64 = 1;

/// Maximum size of the parsed manifest in bytes.
pub const MAX_MANIFEST_BYTES: u64 = 1 << 20;

/// Maximum size of a single NDJSON line in bytes.
pub const MAX_NDJSON_LINE_BYTES: u64 = 1 << 20;

/// Maximum number of NDJSON lines per section file.
pub const MAX_NDJSON_LINES: u64 = 1_000_000;

/// The five NDJSON section files of the container, in canonical order.
const NDJSON_FILES: [&str; 5] = [
    "characters.ndjson",
    "chats.ndjson",
    "messages.ndjson",
    "lorebooks.ndjson",
    "presets.ndjson",
];

/// How duplicate ids (records whose id already exists in the target
/// database) are treated by [`apply_import`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplicatePolicy {
    /// Skip records whose id already exists; report them in
    /// [`ImportReport::skipped`]. Re-running under `Reject` adds nothing.
    Reject,
    /// Update the existing row with the incoming record's fields.
    Replace,
    /// Assign a fresh id (via the local `uuid_v7()` helper) to every incoming
    /// record and remap child references (`chats.characterId`,
    /// `messages.chatId`) to the new ids. Nothing is ever overwritten.
    Remap,
}

/// Per-section record counts of an export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportCounts {
    pub characters: u64,
    pub chats: u64,
    pub messages: u64,
    pub lorebooks: u64,
    pub presets: u64,
}

/// Result of [`create_export`]: section counts, asset count and total bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportReport {
    pub counts: ExportCounts,
    /// Number of asset files copied into `dest/assets/`.
    pub assets: u64,
    /// Sum of the sizes of every inventoried file (NDJSON + assets).
    pub size_bytes: u64,
    /// RFC 3339 UTC creation timestamp (seconds precision).
    pub created_at: String,
}

/// Result of [`verify_export`]: a fully checked container's declared facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedExport {
    pub format_version: u64,
    pub created_at: String,
    pub records: ExportCounts,
    /// Sum of inventory sizes (NDJSON + assets; the manifest is not part of
    /// its own inventory).
    pub size_bytes: u64,
}

/// Result of [`apply_import`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportReport {
    /// Records inserted as new rows.
    pub inserted: u64,
    /// Existing rows updated (`DuplicatePolicy::Replace`).
    pub updated: u64,
    /// Records skipped: duplicates under `Reject` plus orphaned records.
    pub skipped: u64,
    /// Human-readable descriptions of every skipped orphan, e.g.
    /// `"chat c1: references missing character missing"`.
    pub orphans: Vec<String>,
}

/// One inventory entry of the container manifest.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    pub logical_path: String,
    pub size: u64,
    pub sha256: String,
}

/// Portable character record (kernel `characters` row, camelCase fields).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCharacter {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub avatar_asset_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_json_object")]
    pub ext: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

/// Portable chat record.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChat {
    pub id: String,
    pub title: String,
    pub character_id: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Portable message record.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMessage {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub sequence: u64,
    pub created_at: String,
}

/// Portable lorebook entry (one item of `lorebooks.entries`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLoreEntry {
    pub id: String,
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub secondary_keys: Vec<String>,
    pub content: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub position: i64,
    #[serde(default)]
    pub constant: bool,
    #[serde(default)]
    pub selective: bool,
    #[serde(default = "default_json_object")]
    pub metadata: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

/// Portable lorebook record.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLorebook {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub entries: Vec<ExportLoreEntry>,
    pub created_at: String,
    pub updated_at: String,
}

/// Portable preset record.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    pub id: String,
    pub name: String,
    #[serde(default = "default_json_object")]
    pub settings: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

fn default_json_object() -> serde_json::Value {
    serde_json::json!({})
}

fn default_true() -> bool {
    true
}

/// Writes a portable export of `db`'s product data into `dest`.
///
/// `dest` must be absent or an empty directory. Product tables are read
/// ordered by id and written as NDJSON; every referenced asset
/// (`characters.avatar_asset_id` → `__neotavern_assets`) is byte-copied into
/// `dest/assets/<key>` and size+sha256 verified after the copy; the inventory
/// (sorted by logical path) and the `manifest.json` are written LAST via an
/// atomic temp+rename, so a partially-written container never carries a
/// manifest.
pub fn create_export(db: &Database, dest: &Path) -> Result<ExportReport> {
    if dest.exists() {
        if !dest.is_dir() {
            return Err(StorageError::new(
                StorageErrorCode::Io,
                "export destination is not a directory",
            ));
        }
        if fs::read_dir(dest)
            .map_err(|e| io_err(e, "inspect export destination"))?
            .next()
            .is_some()
        {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "export destination must be empty or absent",
            ));
        }
    }
    fs::create_dir_all(dest).map_err(|e| io_err(e, "create export destination"))?;

    let characters = read_characters(db)?;
    let chats = read_chats(db)?;
    let messages = read_messages(db)?;
    let lorebooks = read_lorebooks(db)?;
    let presets = read_presets(db)?;

    write_ndjson(&dest.join("characters.ndjson"), &characters)?;
    write_ndjson(&dest.join("chats.ndjson"), &chats)?;
    write_ndjson(&dest.join("messages.ndjson"), &messages)?;
    write_ndjson(&dest.join("lorebooks.ndjson"), &lorebooks)?;
    write_ndjson(&dest.join("presets.ndjson"), &presets)?;

    let counts = ExportCounts {
        characters: characters.len() as u64,
        chats: chats.len() as u64,
        messages: messages.len() as u64,
        lorebooks: lorebooks.len() as u64,
        presets: presets.len() as u64,
    };

    // Referenced assets, deterministic order (sorted, deduped ids).
    let mut referenced: Vec<&str> = characters
        .iter()
        .filter_map(|c| c.avatar_asset_id.as_deref())
        .collect();
    referenced.sort_unstable();
    referenced.dedup();
    let mut inventory: Vec<InventoryEntry> =
        Vec::with_capacity(referenced.len() + NDJSON_FILES.len());
    for id in referenced {
        inventory.push(copy_asset(db, id, dest)?);
    }

    // NDJSON inventory entries.
    for file in NDJSON_FILES {
        let path = dest.join(file);
        let size = fs::metadata(&path)
            .map_err(|e| io_err(e, "stat export file"))?
            .len();
        let sha = sha256_file_hex(&path)?;
        inventory.push(InventoryEntry {
            logical_path: file.to_string(),
            size,
            sha256: sha,
        });
    }
    inventory.sort_by(|a, b| a.logical_path.cmp(&b.logical_path));
    let size_bytes = inventory.iter().map(|e| e.size).sum();

    let created_at = now_utc_rfc3339();
    let manifest = serde_json::json!({
        "exportFormat": EXPORT_FORMAT,
        "formatVersion": EXPORT_FORMAT_VERSION,
        "createdAt": created_at,
        "producer": {
            "appVersion": env!("CARGO_PKG_VERSION"),
            "platform": "kernel",
        },
        "records": {
            "characters": counts.characters,
            "chats": counts.chats,
            "messages": counts.messages,
            "lorebooks": counts.lorebooks,
            "presets": counts.presets,
        },
        "inventory": inventory,
    });
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize manifest: {e}")))?;
    write_atomic(&dest.join("manifest.json"), &bytes)?;

    Ok(ExportReport {
        counts,
        assets: inventory
            .iter()
            .filter(|e| e.logical_path.starts_with("assets/"))
            .count() as u64,
        size_bytes,
        created_at,
    })
}

/// Verifies a portable export container without mutating anything.
///
/// Checks, in order: bounded manifest parse (≤ [`MAX_MANIFEST_BYTES`]), the
/// `exportFormat`/`formatVersion` fields (a newer format version → controlled
/// [`StorageErrorCode::UnsupportedStorageFormat`]), the declared records and
/// inventory (logical paths validated against traversal, every entry present
/// with matching size and sha256, no stray files), and the NDJSON line bounds
/// (≤ [`MAX_NDJSON_LINE_BYTES`] per line, ≤ [`MAX_NDJSON_LINES`] per file)
/// with per-section line counts matching the manifest records.
pub fn verify_export(source: &Path) -> Result<VerifiedExport> {
    let manifest_path = source.join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path).map_err(|e| io_err(e, "read export manifest"))?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(StorageError::new(
            StorageErrorCode::Corrupt,
            "export manifest exceeds the 1 MiB parse bound",
        ));
    }
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|e| {
        StorageError::new(
            StorageErrorCode::Corrupt,
            format!("invalid export manifest: {e}"),
        )
    })?;

    let format = manifest
        .get("exportFormat")
        .and_then(|v| v.as_str())
        .ok_or_else(|| manifest_corrupt("manifest missing exportFormat"))?;
    if format != EXPORT_FORMAT {
        return Err(StorageError::with(
            StorageErrorCode::UnsupportedStorageFormat,
            "export container format is not supported",
            vec![
                ("format".to_string(), format.to_string()),
                ("expected".to_string(), EXPORT_FORMAT.to_string()),
            ],
        ));
    }
    let format_version = manifest
        .get("formatVersion")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| manifest_corrupt("manifest missing formatVersion"))?;
    if format_version > EXPORT_FORMAT_VERSION {
        // Unknown REQUIRED section (future formatVersion) → controlled
        // Incompatible error, per the frozen design.
        return Err(StorageError::with(
            StorageErrorCode::UnsupportedStorageFormat,
            "export format version is newer than this build supports",
            vec![("formatVersion".to_string(), format_version.to_string())],
        ));
    }
    if format_version != EXPORT_FORMAT_VERSION {
        return Err(manifest_corrupt("invalid formatVersion"));
    }

    let created_at = manifest
        .get("createdAt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| manifest_corrupt("manifest missing createdAt"))?
        .to_string();

    let records_value = manifest
        .get("records")
        .filter(|v| v.is_object())
        .ok_or_else(|| manifest_corrupt("manifest missing records"))?;
    let mut records = ExportCounts {
        characters: 0,
        chats: 0,
        messages: 0,
        lorebooks: 0,
        presets: 0,
    };
    for (name, slot) in [
        ("characters", &mut records.characters),
        ("chats", &mut records.chats),
        ("messages", &mut records.messages),
        ("lorebooks", &mut records.lorebooks),
        ("presets", &mut records.presets),
    ] {
        *slot = records_value
            .get(name)
            .and_then(|v| v.as_u64())
            .ok_or_else(|| manifest_corrupt(&format!("records.{name} missing or invalid")))?;
    }

    let inventory_value = manifest
        .get("inventory")
        .and_then(|v| v.as_array())
        .ok_or_else(|| manifest_corrupt("manifest missing inventory"))?;
    let mut inventory: Vec<InventoryEntry> = Vec::with_capacity(inventory_value.len());
    let mut seen: HashSet<String> = HashSet::new();
    for (index, item) in inventory_value.iter().enumerate() {
        let entry: InventoryEntry = serde_json::from_value(item.clone()).map_err(|e| {
            manifest_corrupt(&format!(
                "inventory[{index}] is not an inventory entry: {e}"
            ))
        })?;
        validate_relative_key(&entry.logical_path).map_err(|_| {
            manifest_corrupt(&format!(
                "invalid inventory logicalPath {:?}",
                entry.logical_path
            ))
        })?;
        if !is_container_path(&entry.logical_path) {
            return Err(manifest_corrupt(&format!(
                "inventory logicalPath {:?} is outside the container layout",
                entry.logical_path
            )));
        }
        if !seen.insert(entry.logical_path.clone()) {
            return Err(manifest_corrupt(&format!(
                "duplicate inventory entry {:?}",
                entry.logical_path
            )));
        }
        if !is_sha256_hex(&entry.sha256) {
            return Err(manifest_corrupt(&format!(
                "inventory entry {:?} has a non-sha256 checksum",
                entry.logical_path
            )));
        }
        inventory.push(entry);
    }

    // Every inventory entry must exist with matching size and checksum.
    for entry in &inventory {
        let path = join_checked(source, &entry.logical_path).map_err(|_| {
            manifest_corrupt(&format!(
                "inventory logicalPath {:?} escapes the container",
                entry.logical_path
            ))
        })?;
        let meta = fs::metadata(&path).map_err(|_| {
            manifest_corrupt(&format!("inventory entry missing: {}", entry.logical_path))
        })?;
        if !meta.is_file() {
            return Err(manifest_corrupt(&format!(
                "inventory entry is not a file: {}",
                entry.logical_path
            )));
        }
        if meta.len() != entry.size {
            return Err(manifest_corrupt(&format!(
                "inventory size mismatch for {}: declared {}, found {}",
                entry.logical_path,
                entry.size,
                meta.len()
            )));
        }
        let actual = sha256_file_hex(&path)?;
        if actual != entry.sha256 {
            return Err(manifest_corrupt(&format!(
                "inventory checksum mismatch for {}",
                entry.logical_path
            )));
        }
    }

    // No stray files: every file under the container is the manifest or an
    // inventoried payload.
    let mut on_disk: Vec<String> = Vec::new();
    collect_container_files(source, Path::new(""), true, &mut on_disk)?;
    let inventoried: HashSet<&str> = inventory.iter().map(|e| e.logical_path.as_str()).collect();
    for file in &on_disk {
        if file == "manifest.json" {
            continue;
        }
        if !inventoried.contains(file.as_str()) {
            return Err(manifest_corrupt(&format!(
                "unexpected file in export container: {file}"
            )));
        }
    }

    // NDJSON bounds + per-section line counts.
    for (file, expected) in [
        ("characters.ndjson", records.characters),
        ("chats.ndjson", records.chats),
        ("messages.ndjson", records.messages),
        ("lorebooks.ndjson", records.lorebooks),
        ("presets.ndjson", records.presets),
    ] {
        let (lines, _) = ndjson_bounds(&source.join(file))?;
        if lines != expected {
            return Err(manifest_corrupt(&format!(
                "{file}: declared {expected} records, found {lines} lines"
            )));
        }
    }

    let size_bytes = inventory.iter().map(|e| e.size).sum();
    Ok(VerifiedExport {
        format_version,
        created_at,
        records,
        size_bytes,
    })
}

/// Applies a verified portable export into `db` under `policy`.
///
/// Order: the container is fully verified ([`verify_export`]) and ALL records
/// are parsed and validated (typed parse, role/sequence checks, referential
/// integrity) BEFORE any write; the record set is then applied in a single
/// transaction. Orphaned records (chats referencing missing characters,
/// messages referencing missing chats) are skipped and reported, never
/// invented. `DuplicatePolicy::Reject` skips existing ids (a re-run adds
/// nothing), `Replace` updates them, `Remap` assigns fresh `uuid_v7()` ids
/// and remaps child references.
pub fn apply_import(
    source: &Path,
    db: &mut Database,
    policy: DuplicatePolicy,
) -> Result<ImportReport> {
    // Integrity first, before any write.
    let verified = verify_export(source)?;

    let characters = parse_ndjson::<ExportCharacter>(
        &source.join("characters.ndjson"),
        verified.records.characters,
    )?;
    let chats = parse_ndjson::<ExportChat>(&source.join("chats.ndjson"), verified.records.chats)?;
    let messages =
        parse_ndjson::<ExportMessage>(&source.join("messages.ndjson"), verified.records.messages)?;
    let lorebooks = parse_ndjson::<ExportLorebook>(
        &source.join("lorebooks.ndjson"),
        verified.records.lorebooks,
    )?;
    let presets =
        parse_ndjson::<ExportPreset>(&source.join("presets.ndjson"), verified.records.presets)?;

    reject_duplicate_ids(&characters, |c| c.id.as_str(), "characters")?;
    reject_duplicate_ids(&chats, |c| c.id.as_str(), "chats")?;
    reject_duplicate_ids(&messages, |m| m.id.as_str(), "messages")?;
    reject_duplicate_ids(&lorebooks, |b| b.id.as_str(), "lorebooks")?;
    reject_duplicate_ids(&presets, |p| p.id.as_str(), "presets")?;

    for message in &messages {
        if !matches!(
            message.role.as_str(),
            "system" | "user" | "assistant" | "tool"
        ) {
            return Err(StorageError::new(
                StorageErrorCode::Corrupt,
                format!(
                    "messages.ndjson: record {} has invalid role {:?}",
                    message.id, message.role
                ),
            ));
        }
        if message.sequence > i64::MAX as u64 {
            return Err(StorageError::new(
                StorageErrorCode::Corrupt,
                format!(
                    "messages.ndjson: record {} sequence out of range",
                    message.id
                ),
            ));
        }
    }

    // Referential integrity within the incoming set: orphans are skipped and
    // reported, never invented.
    let character_ids: HashSet<&str> = characters.iter().map(|c| c.id.as_str()).collect();
    let mut orphans: Vec<String> = Vec::new();
    let mut kept_chats: Vec<&ExportChat> = Vec::new();
    for chat in &chats {
        if !character_ids.contains(chat.character_id.as_str()) {
            orphans.push(format!(
                "chat {}: references missing character {}",
                chat.id, chat.character_id
            ));
        } else {
            kept_chats.push(chat);
        }
    }
    let kept_chat_ids: HashSet<&str> = kept_chats.iter().map(|c| c.id.as_str()).collect();
    let mut kept_messages: Vec<&ExportMessage> = Vec::new();
    for message in &messages {
        if !kept_chat_ids.contains(message.chat_id.as_str()) {
            orphans.push(format!(
                "message {}: references missing chat {}",
                message.id, message.chat_id
            ));
        } else {
            kept_messages.push(message);
        }
    }
    let orphan_count = orphans.len() as u64;

    let mut inserted = 0u64;
    let mut updated = 0u64;
    let mut skipped = orphan_count;
    db.transaction(|tx| {
        match policy {
            DuplicatePolicy::Reject => {
                for character in &characters {
                    if row_exists(tx, "characters", &character.id)? {
                        skipped += 1;
                    } else {
                        insert_character(tx, character)?;
                        inserted += 1;
                    }
                }
                for chat in &kept_chats {
                    if row_exists(tx, "chats", &chat.id)? {
                        skipped += 1;
                    } else {
                        insert_chat(tx, chat)?;
                        inserted += 1;
                    }
                }
                for message in &kept_messages {
                    if row_exists(tx, "messages", &message.id)? {
                        skipped += 1;
                    } else {
                        insert_message(tx, message)?;
                        inserted += 1;
                    }
                }
                for book in &lorebooks {
                    if row_exists(tx, "lorebooks", &book.id)? {
                        skipped += 1;
                    } else {
                        insert_lorebook(tx, book)?;
                        inserted += 1;
                    }
                }
                for preset in &presets {
                    if row_exists(tx, "presets", &preset.id)? {
                        skipped += 1;
                    } else {
                        insert_preset(tx, preset)?;
                        inserted += 1;
                    }
                }
            }
            DuplicatePolicy::Replace => {
                for character in &characters {
                    if row_exists(tx, "characters", &character.id)? {
                        update_character(tx, character)?;
                        updated += 1;
                    } else {
                        insert_character(tx, character)?;
                        inserted += 1;
                    }
                }
                for chat in &kept_chats {
                    if row_exists(tx, "chats", &chat.id)? {
                        update_chat(tx, chat)?;
                        updated += 1;
                    } else {
                        insert_chat(tx, chat)?;
                        inserted += 1;
                    }
                }
                for message in &kept_messages {
                    if row_exists(tx, "messages", &message.id)? {
                        update_message(tx, message)?;
                        updated += 1;
                    } else {
                        insert_message(tx, message)?;
                        inserted += 1;
                    }
                }
                for book in &lorebooks {
                    if row_exists(tx, "lorebooks", &book.id)? {
                        update_lorebook(tx, book)?;
                        updated += 1;
                    } else {
                        insert_lorebook(tx, book)?;
                        inserted += 1;
                    }
                }
                for preset in &presets {
                    if row_exists(tx, "presets", &preset.id)? {
                        update_preset(tx, preset)?;
                        updated += 1;
                    } else {
                        insert_preset(tx, preset)?;
                        inserted += 1;
                    }
                }
            }
            DuplicatePolicy::Remap => {
                let character_ids: HashMap<&str, String> = characters
                    .iter()
                    .map(|c| (c.id.as_str(), uuid_v7()))
                    .collect();
                for character in &characters {
                    insert_character(
                        tx,
                        &ExportCharacter {
                            id: character_ids[character.id.as_str()].clone(),
                            ..character.clone()
                        },
                    )?;
                    inserted += 1;
                }
                let chat_ids: HashMap<&str, String> = kept_chats
                    .iter()
                    .map(|c| (c.id.as_str(), uuid_v7()))
                    .collect();
                for chat in kept_chats {
                    let new_character_id = character_ids
                        .get(chat.character_id.as_str())
                        .ok_or_else(|| {
                            StorageError::new(
                                StorageErrorCode::IntegrityViolation,
                                "internal remap error: chat character reference missing",
                            )
                        })?;
                    insert_chat(
                        tx,
                        &ExportChat {
                            id: chat_ids[chat.id.as_str()].clone(),
                            character_id: new_character_id.clone(),
                            ..chat.clone()
                        },
                    )?;
                    inserted += 1;
                }
                for message in kept_messages {
                    let new_chat_id = chat_ids.get(message.chat_id.as_str()).ok_or_else(|| {
                        StorageError::new(
                            StorageErrorCode::IntegrityViolation,
                            "internal remap error: message chat reference missing",
                        )
                    })?;
                    insert_message(
                        tx,
                        &ExportMessage {
                            id: uuid_v7(),
                            chat_id: new_chat_id.clone(),
                            ..message.clone()
                        },
                    )?;
                    inserted += 1;
                }
                for book in &lorebooks {
                    insert_lorebook(
                        tx,
                        &ExportLorebook {
                            id: uuid_v7(),
                            ..book.clone()
                        },
                    )?;
                    inserted += 1;
                }
                for preset in &presets {
                    insert_preset(
                        tx,
                        &ExportPreset {
                            id: uuid_v7(),
                            ..preset.clone()
                        },
                    )?;
                    inserted += 1;
                }
            }
        }
        Ok(())
    })?;

    Ok(ImportReport {
        inserted,
        updated,
        skipped,
        orphans,
    })
}

// --- export readers --------------------------------------------------------

fn read_characters(db: &Database) -> Result<Vec<ExportCharacter>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at \
             FROM characters ORDER BY id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare characters"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read characters"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read characters"))?;
        let tags: Vec<String> = serde_json::from_str(&tags_json).map_err(|e| {
            StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!("character {id}: invalid tags_json: {e}"),
                vec![("id".to_string(), id.clone())],
            )
        })?;
        let ext: serde_json::Value = serde_json::from_str(&ext_json).map_err(|e| {
            StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!("character {id}: invalid ext_json: {e}"),
                vec![("id".to_string(), id.clone())],
            )
        })?;
        out.push(ExportCharacter {
            id,
            name,
            description,
            avatar_asset_id,
            tags,
            ext,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

fn read_chats(db: &Database) -> Result<Vec<ExportChat>> {
    let mut stmt = db
        .conn()
        .prepare("SELECT id, title, character_id, created_at, updated_at FROM chats ORDER BY id")
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare chats"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read chats"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, character_id, created_at, updated_at) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read chats"))?;
        out.push(ExportChat {
            id,
            title,
            character_id,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

fn read_messages(db: &Database) -> Result<Vec<ExportMessage>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, chat_id, role, content, sequence, created_at FROM messages ORDER BY id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare messages"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read messages"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, chat_id, role, content, sequence, created_at) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read messages"))?;
        out.push(ExportMessage {
            id,
            chat_id,
            role,
            content,
            sequence: sequence as u64,
            created_at,
        });
    }
    Ok(out)
}

fn read_lorebooks(db: &Database) -> Result<Vec<ExportLorebook>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, name, description, entries_json, created_at, updated_at FROM lorebooks ORDER BY id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare lorebooks"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read lorebooks"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, description, entries_json, created_at, updated_at) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read lorebooks"))?;
        let entries: Vec<ExportLoreEntry> = serde_json::from_str(&entries_json).map_err(|e| {
            StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!("lorebook {id}: invalid entries_json: {e}"),
                vec![("id".to_string(), id.clone())],
            )
        })?;
        out.push(ExportLorebook {
            id,
            name,
            description,
            entries,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

fn read_presets(db: &Database) -> Result<Vec<ExportPreset>> {
    let mut stmt = db
        .conn()
        .prepare("SELECT id, name, settings_json, created_at, updated_at FROM presets ORDER BY id")
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare presets"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read presets"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, settings_json, created_at, updated_at) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read presets"))?;
        let settings: serde_json::Value = serde_json::from_str(&settings_json).map_err(|e| {
            StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!("preset {id}: invalid settings_json: {e}"),
                vec![("id".to_string(), id.clone())],
            )
        })?;
        out.push(ExportPreset {
            id,
            name,
            settings,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

/// Copies one referenced asset from the live root into `dest/assets/<key>`,
/// verifying size and sha256 after the copy. The logical path used in the
/// inventory is `assets/<relative_key>`.
fn copy_asset(db: &Database, id: &str, dest: &Path) -> Result<InventoryEntry> {
    let row = db
        .conn()
        .query_row(
            "SELECT relative_key, checksum_sha256, size_bytes FROM __neotavern_assets WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
        )
        .optional()
        .map_err(|e| StorageError::from_sqlite(e, "export: read asset registry"))?;
    let Some((relative_key, checksum, size)) = row else {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("avatar asset {id} is referenced but not registered"),
            vec![("id".to_string(), id.to_string())],
        ));
    };

    let src = join_checked(&assets_dir(db.root()), &relative_key).map_err(|_| {
        StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("asset {id}: registry key fails validation"),
            vec![("id".to_string(), id.to_string())],
        )
    })?;
    let assets_out = dest.join("assets");
    let dst = join_checked(&assets_out, &relative_key).map_err(|_| {
        StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("asset {id}: registry key fails validation"),
            vec![("id".to_string(), id.to_string())],
        )
    })?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(e, "create export asset dirs"))?;
    }
    fs::copy(&src, &dst).map_err(|e| {
        StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("asset {id}: copy failed: {e}"),
            vec![("id".to_string(), id.to_string())],
        )
    })?;
    let actual_size = fs::metadata(&dst)
        .map_err(|e| io_err(e, "stat exported asset"))?
        .len();
    if actual_size != size as u64 {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("asset {id}: size mismatch after copy"),
            vec![("id".to_string(), id.to_string())],
        ));
    }
    let actual = sha256_file_hex(&dst)?;
    if actual != checksum {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("asset {id}: checksum mismatch after copy"),
            vec![("id".to_string(), id.to_string())],
        ));
    }
    Ok(InventoryEntry {
        logical_path: format!("assets/{relative_key}"),
        size: size as u64,
        sha256: checksum,
    })
}

// --- NDJSON helpers --------------------------------------------------------

/// Writes `records` as NDJSON (one compact JSON object per line).
fn write_ndjson<T: serde::Serialize>(path: &Path, records: &[T]) -> Result<()> {
    let mut out = fs::File::create(path).map_err(|e| io_err(e, "create export NDJSON file"))?;
    for record in records {
        let line = serde_json::to_string(record).map_err(|e| {
            StorageError::new(
                StorageErrorCode::Io,
                format!("serialize export record: {e}"),
            )
        })?;
        out.write_all(line.as_bytes())
            .map_err(|e| io_err(e, "write export NDJSON line"))?;
        out.write_all(b"\n")
            .map_err(|e| io_err(e, "write export NDJSON newline"))?;
    }
    out.flush().map_err(|e| io_err(e, "flush export NDJSON"))?;
    Ok(())
}

/// Reads an NDJSON file enforcing the line bounds; returns `(lines, longest
/// line length in bytes)`. A missing file is an error (containers always
/// carry all five section files, even when empty).
fn ndjson_bounds(path: &Path) -> Result<(u64, usize)> {
    let file = fs::File::open(path).map_err(|e| io_err(e, "open export NDJSON"))?;
    let mut reader = BufReader::new(file);
    let mut lines = 0u64;
    let mut longest = 0usize;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| io_err(e, "read export NDJSON"))?;
        if n == 0 {
            break;
        }
        lines += 1;
        if lines > MAX_NDJSON_LINES {
            return Err(StorageError::new(
                StorageErrorCode::Corrupt,
                format!("{}: more than {MAX_NDJSON_LINES} lines", path.display()),
            ));
        }
        let mut len = buf.len();
        if buf.last() == Some(&b'\n') {
            len -= 1;
            if len > 0 && buf[len - 1] == b'\r' {
                len -= 1;
            }
        }
        if len as u64 > MAX_NDJSON_LINE_BYTES {
            return Err(StorageError::new(
                StorageErrorCode::Corrupt,
                format!(
                    "{}: line {lines} exceeds {MAX_NDJSON_LINE_BYTES} bytes",
                    path.display()
                ),
            ));
        }
        longest = longest.max(len);
    }
    Ok((lines, longest))
}

/// Parses an NDJSON file into typed records, requiring exactly `expected`
/// lines (already bounded by [`ndjson_bounds`] via [`verify_export`]).
fn parse_ndjson<T: serde::de::DeserializeOwned>(path: &Path, expected: u64) -> Result<Vec<T>> {
    let file = fs::File::open(path).map_err(|e| io_err(e, "open export NDJSON"))?;
    let mut reader = BufReader::new(file);
    let mut out = Vec::new();
    let mut line_no = 0u64;
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = reader.read_line(&mut buf).map_err(|e| {
            if e.kind() == std::io::ErrorKind::InvalidData {
                StorageError::new(
                    StorageErrorCode::Corrupt,
                    format!("{}: non-UTF-8 line", path.display()),
                )
            } else {
                io_err(e, "read export NDJSON")
            }
        })?;
        if n == 0 {
            break;
        }
        line_no += 1;
        let trimmed = buf.trim_end_matches(['\n', '\r']);
        let record: T = serde_json::from_str(trimmed).map_err(|e| {
            StorageError::new(
                StorageErrorCode::Corrupt,
                format!("{}: line {line_no}: {e}", path.display()),
            )
        })?;
        out.push(record);
    }
    if line_no != expected {
        return Err(StorageError::new(
            StorageErrorCode::Corrupt,
            format!(
                "{}: expected {expected} records, found {line_no} lines",
                path.display()
            ),
        ));
    }
    Ok(out)
}

fn reject_duplicate_ids<T>(records: &[T], id_of: impl Fn(&T) -> &str, section: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for record in records {
        let id = id_of(record);
        if !seen.insert(id) {
            return Err(StorageError::new(
                StorageErrorCode::Corrupt,
                format!("{section}.ndjson: duplicate record id {id}"),
            ));
        }
    }
    Ok(())
}

// --- import writers --------------------------------------------------------

fn row_exists(tx: &rusqlite::Transaction, table: &str, id: &str) -> Result<bool> {
    let sql = format!("SELECT 1 FROM {table} WHERE id = ?1");
    let found = tx
        .query_row(&sql, [id], |r| r.get::<_, i64>(0))
        .optional()
        .map_err(|e| StorageError::from_sqlite(e, "import: probe record"))?;
    Ok(found.is_some())
}

fn insert_character(tx: &rusqlite::Transaction, c: &ExportCharacter) -> Result<()> {
    let tags = serde_json::to_string(&c.tags)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize tags: {e}")))?;
    let ext = serde_json::to_string(&c.ext)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize ext: {e}")))?;
    tx.execute(
        "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            c.id,
            c.name,
            c.description,
            c.avatar_asset_id,
            tags,
            ext,
            c.created_at,
            c.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert character"))?;
    Ok(())
}

fn update_character(tx: &rusqlite::Transaction, c: &ExportCharacter) -> Result<()> {
    let tags = serde_json::to_string(&c.tags)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize tags: {e}")))?;
    let ext = serde_json::to_string(&c.ext)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize ext: {e}")))?;
    tx.execute(
        "UPDATE characters SET name = ?2, description = ?3, avatar_asset_id = ?4, tags_json = ?5, \
         ext_json = ?6, created_at = ?7, updated_at = ?8 WHERE id = ?1",
        rusqlite::params![
            c.id,
            c.name,
            c.description,
            c.avatar_asset_id,
            tags,
            ext,
            c.created_at,
            c.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update character"))?;
    Ok(())
}

fn insert_chat(tx: &rusqlite::Transaction, chat: &ExportChat) -> Result<()> {
    tx.execute(
        "INSERT INTO chats (id, title, character_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![chat.id, chat.title, chat.character_id, chat.created_at, chat.updated_at],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert chat"))?;
    Ok(())
}

fn update_chat(tx: &rusqlite::Transaction, chat: &ExportChat) -> Result<()> {
    tx.execute(
        "UPDATE chats SET title = ?2, character_id = ?3, created_at = ?4, updated_at = ?5 WHERE id = ?1",
        rusqlite::params![chat.id, chat.title, chat.character_id, chat.created_at, chat.updated_at],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update chat"))?;
    Ok(())
}

fn insert_message(tx: &rusqlite::Transaction, message: &ExportMessage) -> Result<()> {
    tx.execute(
        "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            message.id,
            message.chat_id,
            message.role,
            message.content,
            message.sequence as i64,
            message.created_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert message"))?;
    Ok(())
}

fn update_message(tx: &rusqlite::Transaction, message: &ExportMessage) -> Result<()> {
    tx.execute(
        "UPDATE messages SET chat_id = ?2, role = ?3, content = ?4, sequence = ?5, created_at = ?6 WHERE id = ?1",
        rusqlite::params![
            message.id,
            message.chat_id,
            message.role,
            message.content,
            message.sequence as i64,
            message.created_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update message"))?;
    Ok(())
}

fn insert_lorebook(tx: &rusqlite::Transaction, book: &ExportLorebook) -> Result<()> {
    let entries = serde_json::to_string(&book.entries)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize entries: {e}")))?;
    tx.execute(
        "INSERT INTO lorebooks (id, name, description, entries_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            book.id,
            book.name,
            book.description,
            entries,
            book.created_at,
            book.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert lorebook"))?;
    Ok(())
}

fn update_lorebook(tx: &rusqlite::Transaction, book: &ExportLorebook) -> Result<()> {
    let entries = serde_json::to_string(&book.entries)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize entries: {e}")))?;
    tx.execute(
        "UPDATE lorebooks SET name = ?2, description = ?3, entries_json = ?4, created_at = ?5, updated_at = ?6 WHERE id = ?1",
        rusqlite::params![
            book.id,
            book.name,
            book.description,
            entries,
            book.created_at,
            book.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update lorebook"))?;
    Ok(())
}

fn insert_preset(tx: &rusqlite::Transaction, preset: &ExportPreset) -> Result<()> {
    let settings = serde_json::to_string(&preset.settings)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize settings: {e}")))?;
    tx.execute(
        "INSERT INTO presets (id, name, settings_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![preset.id, preset.name, settings, preset.created_at, preset.updated_at],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert preset"))?;
    Ok(())
}

fn update_preset(tx: &rusqlite::Transaction, preset: &ExportPreset) -> Result<()> {
    let settings = serde_json::to_string(&preset.settings)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize settings: {e}")))?;
    tx.execute(
        "UPDATE presets SET name = ?2, settings_json = ?3, created_at = ?4, updated_at = ?5 WHERE id = ?1",
        rusqlite::params![preset.id, preset.name, settings, preset.created_at, preset.updated_at],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update preset"))?;
    Ok(())
}

// --- shared helpers --------------------------------------------------------

/// True when `logical_path` is one of the five NDJSON files or lives under
/// the `assets/` prefix (after [`validate_relative_key`] already rejected
/// traversal).
fn is_container_path(logical_path: &str) -> bool {
    NDJSON_FILES.contains(&logical_path) || logical_path.starts_with("assets/")
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Collects every regular file under `dir` (relative to `source`, `/`-
/// separated). Rejects symlinks and top-level directories other than
/// `assets`.
fn collect_container_files(
    dir: &Path,
    rel: &Path,
    top: bool,
    files: &mut Vec<String>,
) -> Result<()> {
    for entry in fs::read_dir(dir).map_err(|e| io_err(e, "read export container"))? {
        let entry = entry.map_err(|e| io_err(e, "read export container entry"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| io_err(e, "stat export container entry"))?;
        let rel_path = rel.join(entry.file_name());
        let rel_str = rel_path
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if file_type.is_symlink() {
            return Err(manifest_corrupt(&format!(
                "unexpected symlink in export container: {rel_str}"
            )));
        }
        if file_type.is_dir() {
            if top && rel_str != "assets" {
                return Err(manifest_corrupt(&format!(
                    "unexpected directory in export container: {rel_str}"
                )));
            }
            collect_container_files(&entry.path(), &rel_path, false, files)?;
        } else if file_type.is_file() {
            files.push(rel_str);
        }
    }
    Ok(())
}

/// A `Corrupt` error for a container-level validation failure.
fn manifest_corrupt(why: &str) -> StorageError {
    StorageError::new(
        StorageErrorCode::Corrupt,
        format!("invalid export container: {why}"),
    )
}

/// Generates an RFC 9562 UUIDv7 identifier using only `std`.
///
/// Layout: 48 bits of Unix-epoch milliseconds, a version nibble of 7, the
/// RFC 4122 variant bits (`10xx`), and 74 random bits drawn from
/// [`std::collections::hash_map::RandomState`] — `std`'s OS-seeded hash
/// state, the only randomness source available without extra dependencies.
/// Like the kernel's ids, the timestamp prefix keeps ids time-ordered.
fn uuid_v7() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entropy = || {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(ms);
        hasher.finish()
    };
    let rand_a = entropy();
    let rand_b = entropy();

    let mut out = String::with_capacity(36);
    push_hex(&mut out, ms >> 16, 8);
    out.push('-');
    push_hex(&mut out, ms & 0xFFFF, 4);
    out.push('-');
    push_hex(&mut out, 0x7000 | ((rand_a >> 12) & 0x0FFF), 4);
    out.push('-');
    push_hex(&mut out, 0x8000 | (rand_a & 0x3FFF), 4);
    out.push('-');
    push_hex(&mut out, rand_b, 12);
    out
}

/// Appends the low `digits` hex digits of `value` (0–16) to `out`.
fn push_hex(out: &mut String, value: u64, digits: u32) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for shift in (0..digits).rev() {
        let nibble = ((value >> (shift * 4)) & 0xF) as usize;
        out.push(HEX[nibble] as char);
    }
}
