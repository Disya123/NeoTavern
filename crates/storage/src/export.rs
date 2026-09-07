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
///
/// v2 (2026-09-07, audit C4) extends v1 with the sections
/// `personas`, `message_variants`, `message_content_revisions`,
/// `message_drafts`, `character_lorebooks`, `memories`, `settings` and the
/// lost columns (`chats.persona_id`/`parentChatId`/`origin`/`sourceMessageId`,
/// `messages.meta`/`generationRunId`/`checkpointChatId`/`updatedAt`,
/// `characters.importHash`, `presets.kind`). v1 containers stay importable:
/// a missing section is empty and missing record fields take their defaults.
pub const EXPORT_FORMAT_VERSION: u64 = 2;

/// Maximum size of the parsed manifest in bytes.
pub const MAX_MANIFEST_BYTES: u64 = 1 << 20;

/// Maximum size of a single NDJSON line in bytes.
pub const MAX_NDJSON_LINE_BYTES: u64 = 1 << 20;

/// Maximum number of NDJSON lines per section file.
pub const MAX_NDJSON_LINES: u64 = 1_000_000;

/// The NDJSON section files of a v2 container, in canonical (FK-safe import)
/// order: personas before chats (`chats.persona_id`), messages before their
/// variants/revisions/drafts, lorebooks before the character links.
const NDJSON_FILES: [&str; 12] = [
    "characters.ndjson",
    "personas.ndjson",
    "chats.ndjson",
    "messages.ndjson",
    "message_variants.ndjson",
    "message_content_revisions.ndjson",
    "message_drafts.ndjson",
    "lorebooks.ndjson",
    "character_lorebooks.ndjson",
    "presets.ndjson",
    "memories.ndjson",
    "settings.ndjson",
];

/// The five NDJSON section files a v1 container carries (imported as the
/// base sections; the v2-only sections are absent → empty).
const NDJSON_FILES_V1: [&str; 5] = [
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
    pub personas: u64,
    pub chats: u64,
    pub messages: u64,
    pub message_variants: u64,
    pub message_content_revisions: u64,
    pub message_drafts: u64,
    pub lorebooks: u64,
    pub character_lorebooks: u64,
    pub presets: u64,
    pub memories: u64,
    pub settings: u64,
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
    /// Container format version of the applied verified export.
    pub format_version: u64,
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
/// `profile_id` (optional) carries the Configuration profile binding
/// (ADR-0047 waiver 4): a scoped export emits only the characters of one
/// profile; on import the binding is preserved only when the profile already
/// exists in the target (otherwise the character lands unassigned and the
/// loss is reported in [`ImportReport::orphans`] — never silently dropped).
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
    #[serde(default)]
    pub profile_id: Option<String>,
    /// sha256 of the original character-card file (v2; migration 19) — the
    /// re-import idempotency key.
    #[serde(default)]
    pub import_hash: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Portable persona record (v2 section; kernel `personas`, migration 5).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPersona {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Portable chat record.
///
/// v2 carries the persona/snapshot columns (migrations 10/18). `persona_id`
/// is FK-checked on import (unresolvable → NULL + orphan report);
/// `parent_chat_id`/`source_message_id` are soft links (no FK in the
/// schema) — unresolvable links are nulled and reported the same way.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChat {
    pub id: String,
    pub title: String,
    pub character_id: String,
    #[serde(default)]
    pub persona_id: Option<String>,
    #[serde(default)]
    pub parent_chat_id: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub source_message_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Portable message record.
///
/// v2 carries `updatedAt` (migration 8), the free-form `meta` object
/// (migration 17), the generation run link and the checkpoint link
/// (migration 18). `generationRunId` is carried verbatim WITHOUT a
/// reference check — generation runs are kernel journals deliberately
/// outside the container (the run row may legitimately not exist in the
/// target).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMessage {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub sequence: u64,
    #[serde(default)]
    pub generation_run_id: Option<String>,
    #[serde(default = "default_json_object")]
    pub meta: serde_json::Value,
    #[serde(default)]
    pub checkpoint_chat_id: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub created_at: String,
}

/// Portable message variant record (v2 section; migration 8).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMessageVariant {
    pub id: String,
    pub message_id: String,
    pub position: i64,
    pub content: String,
    pub created_at: String,
}

/// Portable message content-revision record (v2 section; migration 8).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMessageContentRevision {
    pub id: String,
    pub message_id: String,
    pub position: i64,
    pub content: String,
    pub created_at: String,
}

/// Portable message-draft record (v2 section; migration 8).
/// `committed_message_id` is a soft link to the message the draft produced.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMessageDraft {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub sequence: i64,
    #[serde(default = "default_one")]
    pub revision: i64,
    #[serde(default)]
    pub committed_message_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
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

/// Portable preset record. `kind` is the v2 addition (migration 9, the
/// `(kind, name)` uniqueness pair); v1 containers carry no kind — the
/// migration default `'generation'` is applied.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    pub id: String,
    pub name: String,
    #[serde(default = "default_preset_kind")]
    pub kind: String,
    #[serde(default = "default_json_object")]
    pub settings: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

/// Portable memory record (v2 section; migration 9). `characterId` is
/// FK-checked on import (unresolvable → NULL + orphan report).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMemory {
    pub id: String,
    #[serde(default = "default_memory_scope")]
    pub scope: String,
    #[serde(default)]
    pub character_id: Option<String>,
    #[serde(default)]
    pub keys: Vec<String>,
    pub content: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub position: i64,
    #[serde(default = "default_json_object")]
    pub metadata: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

/// Portable non-secret setting record (v2 section; migration 11). The
/// primary key is `key`, not `id`. Secrets never appear here (ТЗ §9.4).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSetting {
    pub key: String,
    pub value: serde_json::Value,
    pub updated_at: String,
}

/// Portable character↔lorebook link record (v2 section; migration 16).
/// Composite-key record without its own id; `lorebook_id` is UNIQUE (one
/// book binds to one character).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCharacterLorebook {
    pub character_id: String,
    pub lorebook_id: String,
}

fn default_json_object() -> serde_json::Value {
    serde_json::json!({})
}

fn default_true() -> bool {
    true
}

fn default_one() -> i64 {
    1
}

fn default_preset_kind() -> String {
    "generation".to_string()
}

fn default_memory_scope() -> String {
    "global".to_string()
}

/// Writes a portable export of `db`'s product data into `dest`.
///
/// `dest` must be absent or an empty directory. Product tables are read
/// ordered by id and written as NDJSON; when `include_assets` is true, every
/// referenced asset (`characters.avatar_asset_id` → `__neotavern_assets`) is
/// byte-copied into `dest/assets/<key>` and size+sha256 verified after the
/// copy; the inventory (sorted by logical path) and the `manifest.json` are
/// written LAST via an atomic temp+rename, so a partially-written container
/// never carries a manifest.
///
/// When `profile_id` is `Some`, the export is scoped to that Configuration
/// profile (SEC-02, ADR-0047 waiver 4): only the profile's characters — and,
/// transitively, their chats and messages — are exported. Lorebooks and
/// presets are the shared library and are always included in full, which the
/// manifest records (`profileId` present on a scoped export).
pub fn create_export(
    db: &Database,
    dest: &Path,
    include_assets: bool,
    profile_id: Option<&str>,
) -> Result<ExportReport> {
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

    let characters = read_characters(db, profile_id)?;
    let character_ids: HashSet<&str> = characters.iter().map(|c| c.id.as_str()).collect();
    // Scoped exports carry only the profile's chats and their messages.
    let chats = read_chats(db, profile_id, &character_ids)?;
    let chat_ids: HashSet<&str> = chats.iter().map(|c| c.id.as_str()).collect();
    let messages = read_messages(db, profile_id, &chat_ids)?;
    let message_ids: HashSet<&str> = messages.iter().map(|m| m.id.as_str()).collect();
    let lorebooks = read_lorebooks(db)?;
    let presets = read_presets(db)?;
    let personas = read_personas(db)?;
    let variants = read_message_variants(db, &message_ids)?;
    let content_revisions = read_message_content_revisions(db, &message_ids)?;
    let drafts = read_message_drafts(db, &chat_ids)?;
    let character_lorebooks = read_character_lorebooks(db)?;
    let memories = read_memories(db)?;
    let settings = read_settings(db)?;

    write_ndjson(&dest.join("characters.ndjson"), &characters)?;
    write_ndjson(&dest.join("personas.ndjson"), &personas)?;
    write_ndjson(&dest.join("chats.ndjson"), &chats)?;
    write_ndjson(&dest.join("messages.ndjson"), &messages)?;
    write_ndjson(&dest.join("message_variants.ndjson"), &variants)?;
    write_ndjson(
        &dest.join("message_content_revisions.ndjson"),
        &content_revisions,
    )?;
    write_ndjson(&dest.join("message_drafts.ndjson"), &drafts)?;
    write_ndjson(&dest.join("lorebooks.ndjson"), &lorebooks)?;
    write_ndjson(
        &dest.join("character_lorebooks.ndjson"),
        &character_lorebooks,
    )?;
    write_ndjson(&dest.join("presets.ndjson"), &presets)?;
    write_ndjson(&dest.join("memories.ndjson"), &memories)?;
    write_ndjson(&dest.join("settings.ndjson"), &settings)?;

    let counts = ExportCounts {
        characters: characters.len() as u64,
        personas: personas.len() as u64,
        chats: chats.len() as u64,
        messages: messages.len() as u64,
        message_variants: variants.len() as u64,
        message_content_revisions: content_revisions.len() as u64,
        message_drafts: drafts.len() as u64,
        lorebooks: lorebooks.len() as u64,
        character_lorebooks: character_lorebooks.len() as u64,
        presets: presets.len() as u64,
        memories: memories.len() as u64,
        settings: settings.len() as u64,
    };

    // Referenced assets, deterministic order (sorted, deduped ids). Skipped
    // entirely when the caller asked for a data-only export (SEC-02 allows
    // the UI to omit asset bytes for lightweight transfers).
    let mut inventory: Vec<InventoryEntry> = Vec::with_capacity(NDJSON_FILES.len());
    if include_assets {
        let mut referenced: Vec<&str> = characters
            .iter()
            .filter_map(|c| c.avatar_asset_id.as_deref())
            .collect();
        referenced.sort_unstable();
        referenced.dedup();
        for id in referenced {
            inventory.push(copy_asset(db, id, dest)?);
        }
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
    let mut manifest = serde_json::json!({
        "exportFormat": EXPORT_FORMAT,
        "formatVersion": EXPORT_FORMAT_VERSION,
        "createdAt": created_at,
        "producer": {
            "appVersion": env!("CARGO_PKG_VERSION"),
            "platform": "kernel",
        },
        "records": {
            "characters": counts.characters,
            "personas": counts.personas,
            "chats": counts.chats,
            "messages": counts.messages,
            "messageVariants": counts.message_variants,
            "messageContentRevisions": counts.message_content_revisions,
            "messageDrafts": counts.message_drafts,
            "lorebooks": counts.lorebooks,
            "characterLorebooks": counts.character_lorebooks,
            "presets": counts.presets,
            "memories": counts.memories,
            "settings": counts.settings,
        },
        "inventory": inventory,
    });
    if let Some(profile_id) = profile_id {
        // Scoped export marker (SEC-02 waiver 4): a host can tell a full
        // library export from a single-profile one by this field alone.
        manifest["profileId"] = serde_json::json!(profile_id);
    }
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
    if !(1..=EXPORT_FORMAT_VERSION).contains(&format_version) {
        return Err(manifest_corrupt("invalid formatVersion"));
    }
    // v1 containers carry only the five base sections; v2 adds the seven
    // extended ones. `section_files` drives the inventory bounds checks.
    let section_files: &[&str] = if format_version == 1 {
        &NDJSON_FILES_V1
    } else {
        &NDJSON_FILES
    };

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
        personas: 0,
        chats: 0,
        messages: 0,
        message_variants: 0,
        message_content_revisions: 0,
        message_drafts: 0,
        lorebooks: 0,
        character_lorebooks: 0,
        presets: 0,
        memories: 0,
        settings: 0,
    };
    // The five base sections are required at every format version; the seven
    // v2 sections are required in a v2 manifest and default to 0 for v1.
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
    for (name, slot) in [
        ("personas", &mut records.personas),
        ("messageVariants", &mut records.message_variants),
        (
            "messageContentRevisions",
            &mut records.message_content_revisions,
        ),
        ("messageDrafts", &mut records.message_drafts),
        ("characterLorebooks", &mut records.character_lorebooks),
        ("memories", &mut records.memories),
        ("settings", &mut records.settings),
    ] {
        *slot = records_value
            .get(name)
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if format_version >= 2 && records_value.get(name).is_none() {
            return Err(manifest_corrupt(&format!("records.{name} missing")));
        }
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

    // NDJSON bounds + per-section line counts. v1 containers carry only the
    // five base sections.
    let section_counts: [(&str, u64); 12] = [
        ("characters.ndjson", records.characters),
        ("personas.ndjson", records.personas),
        ("chats.ndjson", records.chats),
        ("messages.ndjson", records.messages),
        ("message_variants.ndjson", records.message_variants),
        (
            "message_content_revisions.ndjson",
            records.message_content_revisions,
        ),
        ("message_drafts.ndjson", records.message_drafts),
        ("lorebooks.ndjson", records.lorebooks),
        ("character_lorebooks.ndjson", records.character_lorebooks),
        ("presets.ndjson", records.presets),
        ("memories.ndjson", records.memories),
        ("settings.ndjson", records.settings),
    ];
    for (file, expected) in section_counts
        .iter()
        .filter(|(f, _)| section_files.contains(f))
    {
        let (lines, _) = ndjson_bounds(&source.join(file))?;
        if lines != *expected {
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
    // v1 containers lack the v2 sections → parsed as empty (the missing
    // section is empty, never an error).
    let v2_sections = verified.format_version >= 2;

    let mut characters = parse_ndjson::<ExportCharacter>(
        &source.join("characters.ndjson"),
        verified.records.characters,
    )?;
    let personas = parse_optional_ndjson::<ExportPersona>(
        &source.join("personas.ndjson"),
        verified.records.personas,
        v2_sections,
    )?;
    let mut chats = parse_optional_ndjson::<ExportChat>(
        &source.join("chats.ndjson"),
        verified.records.chats,
        true,
    )?;
    let mut messages = parse_optional_ndjson::<ExportMessage>(
        &source.join("messages.ndjson"),
        verified.records.messages,
        true,
    )?;
    let variants = parse_optional_ndjson::<ExportMessageVariant>(
        &source.join("message_variants.ndjson"),
        verified.records.message_variants,
        v2_sections,
    )?;
    let content_revisions = parse_optional_ndjson::<ExportMessageContentRevision>(
        &source.join("message_content_revisions.ndjson"),
        verified.records.message_content_revisions,
        v2_sections,
    )?;
    let drafts = parse_optional_ndjson::<ExportMessageDraft>(
        &source.join("message_drafts.ndjson"),
        verified.records.message_drafts,
        v2_sections,
    )?;
    let lorebooks = parse_optional_ndjson::<ExportLorebook>(
        &source.join("lorebooks.ndjson"),
        verified.records.lorebooks,
        true,
    )?;
    let character_lorebooks = parse_optional_ndjson::<ExportCharacterLorebook>(
        &source.join("character_lorebooks.ndjson"),
        verified.records.character_lorebooks,
        v2_sections,
    )?;
    let presets = parse_optional_ndjson::<ExportPreset>(
        &source.join("presets.ndjson"),
        verified.records.presets,
        true,
    )?;
    let mut memories = parse_optional_ndjson::<ExportMemory>(
        &source.join("memories.ndjson"),
        verified.records.memories,
        v2_sections,
    )?;
    let settings = parse_optional_ndjson::<ExportSetting>(
        &source.join("settings.ndjson"),
        verified.records.settings,
        v2_sections,
    )?;

    reject_duplicate_ids(&characters, |c| c.id.as_str(), "characters")?;
    reject_duplicate_ids(&personas, |p| p.id.as_str(), "personas")?;
    reject_duplicate_ids(&chats, |c| c.id.as_str(), "chats")?;
    reject_duplicate_ids(&messages, |m| m.id.as_str(), "messages")?;
    reject_duplicate_ids(&variants, |v| v.id.as_str(), "message_variants")?;
    reject_duplicate_ids(
        &content_revisions,
        |r| r.id.as_str(),
        "message_content_revisions",
    )?;
    reject_duplicate_ids(&drafts, |d| d.id.as_str(), "message_drafts")?;
    reject_duplicate_ids(&lorebooks, |b| b.id.as_str(), "lorebooks")?;
    reject_duplicate_ids(
        &character_lorebooks,
        |l| l.lorebook_id.as_str(),
        "character_lorebooks",
    )?;
    reject_duplicate_ids(&presets, |p| p.id.as_str(), "presets")?;
    reject_duplicate_ids(&memories, |m| m.id.as_str(), "memories")?;
    reject_duplicate_ids(&settings, |s| s.key.as_str(), "settings")?;

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
    // Referential integrity within the incoming set: orphans are skipped and
    // reported, never invented.
    let mut orphans: Vec<String> = Vec::new();
    //
    // Profile bindings (SEC-02 waiver 4): a character whose `profileId`
    // references a profile that does not exist in the target keeps its data
    // but lands unassigned (NULL), reported as an orphan — a scoped export of
    // one profile must not invent profiles in another library, and the data
    // must never be dropped for a missing binding.
    let profile_ids: HashSet<&str> = characters
        .iter()
        .filter_map(|c| c.profile_id.as_deref())
        .collect();
    let mut missing_profiles: HashSet<String> = HashSet::new();
    for profile_id in &profile_ids {
        let found = db
            .conn()
            .query_row("SELECT 1 FROM profiles WHERE id = ?1", [profile_id], |r| {
                r.get::<_, i64>(0)
            })
            .optional()
            .map_err(|e| StorageError::from_sqlite(e, "import: probe profile"))?;
        if found.is_none() {
            missing_profiles.insert(profile_id.to_string());
        }
    }
    for character in &mut characters {
        if let Some(profile_id) = character.profile_id.clone() {
            if missing_profiles.contains(&profile_id) {
                orphans.push(format!(
                    "character {}: references missing profile {} (unassigned)",
                    character.id, profile_id
                ));
                character.profile_id = None;
            }
        }
    }

    let character_ids: HashSet<&str> = characters.iter().map(|c| c.id.as_str()).collect();
    let incoming_lorebook_ids: HashSet<&str> = lorebooks.iter().map(|b| b.id.as_str()).collect();

    // v2 persona/snapshot links (migrations 8/10/18): a link is kept when it
    // resolves against the container OR the target library; an unresolvable
    // persona (FK column) NULLs the chat, snapshot links (no FK) NULL too —
    // both are reported as orphans, never silently dropped. Dangling
    // `generation_run_id` stays verbatim: runs are kernel journals
    // deliberately outside the container.
    let persona_ids: HashSet<&str> = personas.iter().map(|p| p.id.as_str()).collect();
    let incoming_chat_ids: HashSet<String> = chats.iter().map(|c| c.id.clone()).collect();
    let incoming_message_ids: HashSet<String> = messages.iter().map(|m| m.id.clone()).collect();
    for chat in &mut chats {
        if let Some(pid) = chat.persona_id.clone() {
            if !persona_ids.contains(pid.as_str()) && !record_exists(db.conn(), "personas", &pid)? {
                orphans.push(format!(
                    "chat {}: references missing persona {} (persona-less)",
                    chat.id, pid
                ));
                chat.persona_id = None;
            }
        }
        if let Some(parent) = chat.parent_chat_id.clone() {
            if !incoming_chat_ids.contains(parent.as_str())
                && !record_exists(db.conn(), "chats", &parent)?
            {
                orphans.push(format!(
                    "chat {}: references missing parent chat {} (unlinked)",
                    chat.id, parent
                ));
                chat.parent_chat_id = None;
            }
        }
        if let Some(source) = chat.source_message_id.clone() {
            if !incoming_message_ids.contains(source.as_str())
                && !record_exists(db.conn(), "messages", &source)?
            {
                orphans.push(format!(
                    "chat {}: references missing source message {} (unlinked)",
                    chat.id, source
                ));
                chat.source_message_id = None;
            }
        }
    }
    for message in &mut messages {
        if let Some(child) = message.checkpoint_chat_id.clone() {
            if !incoming_chat_ids.contains(child.as_str())
                && !record_exists(db.conn(), "chats", &child)?
            {
                orphans.push(format!(
                    "message {}: references missing checkpoint chat {} (unlinked)",
                    message.id, child
                ));
                message.checkpoint_chat_id = None;
            }
        }
    }

    // Kept sets: children whose parents resolve against the container or the
    // target; the rest are skipped and reported.
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
    let kept_message_ids: HashSet<&str> = kept_messages.iter().map(|m| m.id.as_str()).collect();
    let mut kept_variants: Vec<&ExportMessageVariant> = Vec::new();
    for variant in &variants {
        if !kept_message_ids.contains(variant.message_id.as_str())
            && !record_exists(db.conn(), "messages", &variant.message_id)?
        {
            orphans.push(format!(
                "message variant {}: references missing message {}",
                variant.id, variant.message_id
            ));
        } else {
            kept_variants.push(variant);
        }
    }
    let mut kept_content_revisions: Vec<&ExportMessageContentRevision> = Vec::new();
    for revision in &content_revisions {
        if !kept_message_ids.contains(revision.message_id.as_str())
            && !record_exists(db.conn(), "messages", &revision.message_id)?
        {
            orphans.push(format!(
                "content revision {}: references missing message {}",
                revision.id, revision.message_id
            ));
        } else {
            kept_content_revisions.push(revision);
        }
    }
    let mut kept_drafts: Vec<&ExportMessageDraft> = Vec::new();
    for draft in &drafts {
        if !kept_chat_ids.contains(draft.chat_id.as_str())
            && !record_exists(db.conn(), "chats", &draft.chat_id)?
        {
            orphans.push(format!(
                "message draft {}: references missing chat {}",
                draft.id, draft.chat_id
            ));
        } else {
            kept_drafts.push(draft);
        }
    }
    let kept_character_ids: HashSet<&str> = kept_chats
        .iter()
        .map(|c| c.character_id.as_str())
        .chain(character_ids.iter().copied())
        .collect();
    let mut kept_character_lorebooks: Vec<&ExportCharacterLorebook> = Vec::new();
    for link in &character_lorebooks {
        let character_ok = kept_character_ids.contains(link.character_id.as_str())
            || record_exists(db.conn(), "characters", &link.character_id)?;
        let lorebook_ok = incoming_lorebook_ids.contains(link.lorebook_id.as_str())
            || record_exists(db.conn(), "lorebooks", &link.lorebook_id)?;
        if character_ok && lorebook_ok {
            kept_character_lorebooks.push(link);
        } else {
            orphans.push(format!(
                "character-lorebook link {}: references missing character {} or lorebook {}",
                link.lorebook_id, link.character_id, link.lorebook_id
            ));
        }
    }
    for memory in &mut memories {
        if let Some(cid) = memory.character_id.clone() {
            if !kept_character_ids.contains(cid.as_str())
                && !record_exists(db.conn(), "characters", &cid)?
            {
                orphans.push(format!(
                    "memory {}: references missing character {} (unscoped)",
                    memory.id, cid
                ));
                memory.character_id = None;
            }
        }
    }
    let orphan_count = orphans.len() as u64;

    let mut inserted = 0u64;
    let mut updated = 0u64;
    let mut skipped = orphan_count;
    db.transaction(|tx| {
        // Import order is FK-safe: personas before chats (`chats.persona_id`),
        // messages before their variants/revisions/drafts, lorebooks before
        // the character links.
        match policy {
            DuplicatePolicy::Reject => {
                for persona in &personas {
                    if row_exists(tx, "personas", &persona.id)? {
                        skipped += 1;
                    } else {
                        insert_persona(tx, persona)?;
                        inserted += 1;
                    }
                }
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
                for variant in &kept_variants {
                    if row_exists(tx, "message_variants", &variant.id)? {
                        skipped += 1;
                    } else {
                        insert_message_variant(tx, variant)?;
                        inserted += 1;
                    }
                }
                for revision in &kept_content_revisions {
                    if row_exists(tx, "message_content_revisions", &revision.id)? {
                        skipped += 1;
                    } else {
                        insert_message_content_revision(tx, revision)?;
                        inserted += 1;
                    }
                }
                for draft in &kept_drafts {
                    if row_exists(tx, "message_drafts", &draft.id)? {
                        skipped += 1;
                    } else {
                        insert_message_draft(tx, draft)?;
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
                for link in &kept_character_lorebooks {
                    if link_exists(tx, &link.character_id, &link.lorebook_id)? {
                        skipped += 1;
                    } else {
                        insert_character_lorebook(tx, link)?;
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
                for memory in &memories {
                    if row_exists(tx, "memories", &memory.id)? {
                        skipped += 1;
                    } else {
                        insert_memory(tx, memory)?;
                        inserted += 1;
                    }
                }
                for setting in &settings {
                    if setting_exists(tx, &setting.key)? {
                        skipped += 1;
                    } else {
                        insert_setting(tx, setting)?;
                        inserted += 1;
                    }
                }
            }
            DuplicatePolicy::Replace => {
                for persona in &personas {
                    if row_exists(tx, "personas", &persona.id)? {
                        update_persona(tx, persona)?;
                        updated += 1;
                    } else {
                        insert_persona(tx, persona)?;
                        inserted += 1;
                    }
                }
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
                for variant in &kept_variants {
                    if row_exists(tx, "message_variants", &variant.id)? {
                        update_message_variant(tx, variant)?;
                        updated += 1;
                    } else {
                        insert_message_variant(tx, variant)?;
                        inserted += 1;
                    }
                }
                for revision in &kept_content_revisions {
                    if row_exists(tx, "message_content_revisions", &revision.id)? {
                        update_message_content_revision(tx, revision)?;
                        updated += 1;
                    } else {
                        insert_message_content_revision(tx, revision)?;
                        inserted += 1;
                    }
                }
                for draft in &kept_drafts {
                    if row_exists(tx, "message_drafts", &draft.id)? {
                        update_message_draft(tx, draft)?;
                        updated += 1;
                    } else {
                        insert_message_draft(tx, draft)?;
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
                for link in &kept_character_lorebooks {
                    if !link_exists(tx, &link.character_id, &link.lorebook_id)? {
                        insert_character_lorebook(tx, link)?;
                        inserted += 1;
                    }
                    // A link has no updatable payload: an existing link is a
                    // no-op under Replace.
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
                for memory in &memories {
                    if row_exists(tx, "memories", &memory.id)? {
                        update_memory(tx, memory)?;
                        updated += 1;
                    } else {
                        insert_memory(tx, memory)?;
                        inserted += 1;
                    }
                }
                for setting in &settings {
                    if setting_exists(tx, &setting.key)? {
                        update_setting(tx, setting)?;
                        updated += 1;
                    } else {
                        insert_setting(tx, setting)?;
                        inserted += 1;
                    }
                }
            }
            DuplicatePolicy::Remap => {
                let persona_ids: HashMap<&str, String> = personas
                    .iter()
                    .map(|p| (p.id.as_str(), uuid_v7()))
                    .collect();
                for persona in &personas {
                    insert_persona(
                        tx,
                        &ExportPersona {
                            id: persona_ids[persona.id.as_str()].clone(),
                            ..persona.clone()
                        },
                    )?;
                    inserted += 1;
                }
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
                    // A persona outside the container keeps its target id.
                    let new_persona_id = chat.persona_id.as_ref().map(|pid| {
                        persona_ids
                            .get(pid.as_str())
                            .cloned()
                            .unwrap_or_else(|| pid.clone())
                    });
                    insert_chat(
                        tx,
                        &ExportChat {
                            id: chat_ids[chat.id.as_str()].clone(),
                            character_id: new_character_id.clone(),
                            persona_id: new_persona_id,
                            parent_chat_id: remap_opt(&chat.parent_chat_id, &chat_ids),
                            ..chat.clone()
                        },
                    )?;
                    inserted += 1;
                }
                let message_ids: HashMap<&str, String> = kept_messages
                    .iter()
                    .map(|m| (m.id.as_str(), uuid_v7()))
                    .collect();
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
                            // From the map, never a fresh id: children
                            // (variants/revisions/drafts) remap through it.
                            id: message_ids[message.id.as_str()].clone(),
                            chat_id: new_chat_id.clone(),
                            checkpoint_chat_id: remap_opt(&message.checkpoint_chat_id, &chat_ids),
                            ..message.clone()
                        },
                    )?;
                    inserted += 1;
                }
                for variant in kept_variants {
                    let new_message_id =
                        message_ids
                            .get(variant.message_id.as_str())
                            .ok_or_else(|| {
                                StorageError::new(
                                    StorageErrorCode::IntegrityViolation,
                                    "internal remap error: variant message reference missing",
                                )
                            })?;
                    insert_message_variant(
                        tx,
                        &ExportMessageVariant {
                            id: uuid_v7(),
                            message_id: new_message_id.clone(),
                            ..variant.clone()
                        },
                    )?;
                    inserted += 1;
                }
                for revision in kept_content_revisions {
                    let new_message_id =
                        message_ids
                            .get(revision.message_id.as_str())
                            .ok_or_else(|| {
                                StorageError::new(
                                    StorageErrorCode::IntegrityViolation,
                                    "internal remap error: revision message reference missing",
                                )
                            })?;
                    insert_message_content_revision(
                        tx,
                        &ExportMessageContentRevision {
                            id: uuid_v7(),
                            message_id: new_message_id.clone(),
                            ..revision.clone()
                        },
                    )?;
                    inserted += 1;
                }
                for draft in kept_drafts {
                    let new_chat_id = chat_ids.get(draft.chat_id.as_str()).ok_or_else(|| {
                        StorageError::new(
                            StorageErrorCode::IntegrityViolation,
                            "internal remap error: draft chat reference missing",
                        )
                    })?;
                    insert_message_draft(
                        tx,
                        &ExportMessageDraft {
                            id: uuid_v7(),
                            chat_id: new_chat_id.clone(),
                            committed_message_id: remap_opt(
                                &draft.committed_message_id,
                                &message_ids,
                            ),
                            ..draft.clone()
                        },
                    )?;
                    inserted += 1;
                }
                let lorebook_ids: HashMap<&str, String> = lorebooks
                    .iter()
                    .map(|b| (b.id.as_str(), uuid_v7()))
                    .collect();
                for book in &lorebooks {
                    insert_lorebook(
                        tx,
                        &ExportLorebook {
                            id: lorebook_ids[book.id.as_str()].clone(),
                            ..book.clone()
                        },
                    )?;
                    inserted += 1;
                }
                for link in &kept_character_lorebooks {
                    let new_character_id = character_ids
                        .get(link.character_id.as_str())
                        .cloned()
                        .unwrap_or_else(|| link.character_id.clone());
                    let new_lorebook_id = lorebook_ids
                        .get(link.lorebook_id.as_str())
                        .cloned()
                        .unwrap_or_else(|| link.lorebook_id.clone());
                    insert_character_lorebook(
                        tx,
                        &ExportCharacterLorebook {
                            character_id: new_character_id,
                            lorebook_id: new_lorebook_id,
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
                for memory in &memories {
                    let new_character_id = memory.character_id.as_ref().map(|cid| {
                        character_ids
                            .get(cid.as_str())
                            .cloned()
                            .unwrap_or_else(|| cid.clone())
                    });
                    insert_memory(
                        tx,
                        &ExportMemory {
                            id: uuid_v7(),
                            character_id: new_character_id,
                            ..memory.clone()
                        },
                    )?;
                    inserted += 1;
                }
                for setting in &settings {
                    // Settings are keyed, not id'd: Remap ("nothing is ever
                    // overwritten") must not clobber a target setting with
                    // the same key.
                    if setting_exists(tx, &setting.key)? {
                        skipped += 1;
                    } else {
                        insert_setting(tx, setting)?;
                        inserted += 1;
                    }
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
        format_version: verified.format_version,
    })
}

// --- export readers --------------------------------------------------------

fn read_characters(db: &Database, profile_id: Option<&str>) -> Result<Vec<ExportCharacter>> {
    let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match profile_id {
        Some(profile_id) => (
            "SELECT id, name, description, avatar_asset_id, tags_json, ext_json, profile_id, import_hash, created_at, updated_at \
             FROM characters WHERE profile_id = ?1 ORDER BY id"
                .to_string(),
            vec![Box::new(profile_id.to_string())],
        ),
        None => (
            "SELECT id, name, description, avatar_asset_id, tags_json, ext_json, profile_id, import_hash, created_at, updated_at \
             FROM characters ORDER BY id"
                .to_string(),
            Vec::new(),
        ),
    };
    let mut stmt = db
        .conn()
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare characters"))?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: read characters"))?;
    let mut out = Vec::new();
    for row in rows {
        let (
            id,
            name,
            description,
            avatar_asset_id,
            tags_json,
            ext_json,
            profile_id,
            import_hash,
            created_at,
            updated_at,
        ) = row.map_err(|e| StorageError::from_sqlite(e, "export: read characters"))?;
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
            profile_id,
            import_hash,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

fn read_chats(
    db: &Database,
    profile_id: Option<&str>,
    character_ids: &HashSet<&str>,
) -> Result<Vec<ExportChat>> {
    let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match profile_id {
        Some(profile_id) => (
            "SELECT id, title, character_id, persona_id, parent_chat_id, origin, source_message_id, created_at, updated_at \
             FROM chats \
             WHERE character_id IN (SELECT id FROM characters WHERE profile_id = ?1) ORDER BY id"
                .to_string(),
            vec![Box::new(profile_id.to_string())],
        ),
        None => (
            "SELECT id, title, character_id, persona_id, parent_chat_id, origin, source_message_id, created_at, updated_at \
             FROM chats ORDER BY id"
                .to_string(),
            Vec::new(),
        ),
    };
    // When scoped, cross-check against the actually exported character ids
    // (defense in depth: chat rows must reference a profile character).
    let mut stmt = db
        .conn()
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare chats"))?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: read chats"))?;
    let mut out = Vec::new();
    for row in rows {
        let (
            id,
            title,
            character_id,
            persona_id,
            parent_chat_id,
            origin,
            source_message_id,
            created_at,
            updated_at,
        ) = row.map_err(|e| StorageError::from_sqlite(e, "export: read chats"))?;
        if profile_id.is_some() && !character_ids.contains(character_id.as_str()) {
            continue;
        }
        out.push(ExportChat {
            id,
            title,
            character_id,
            persona_id,
            parent_chat_id,
            origin,
            source_message_id,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

fn read_messages(
    db: &Database,
    profile_id: Option<&str>,
    chat_ids: &HashSet<&str>,
) -> Result<Vec<ExportMessage>> {
    let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match profile_id {
        Some(profile_id) => (
            "SELECT id, chat_id, role, content, sequence, generation_run_id, meta_json, checkpoint_chat_id, updated_at, created_at \
             FROM messages \
             WHERE chat_id IN (SELECT id FROM chats WHERE character_id IN \
               (SELECT id FROM characters WHERE profile_id = ?1)) ORDER BY id"
                .to_string(),
            vec![Box::new(profile_id.to_string())],
        ),
        None => (
            "SELECT id, chat_id, role, content, sequence, generation_run_id, meta_json, checkpoint_chat_id, updated_at, created_at \
             FROM messages ORDER BY id"
                .to_string(),
            Vec::new(),
        ),
    };
    let mut stmt = db
        .conn()
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare messages"))?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: read messages"))?;
    let mut out = Vec::new();
    for row in rows {
        let (
            id,
            chat_id,
            role,
            content,
            sequence,
            generation_run_id,
            meta_json,
            checkpoint_chat_id,
            updated_at,
            created_at,
        ) = row.map_err(|e| StorageError::from_sqlite(e, "export: read messages"))?;
        if profile_id.is_some() && !chat_ids.contains(chat_id.as_str()) {
            continue;
        }
        let meta: serde_json::Value = serde_json::from_str(&meta_json).map_err(|e| {
            StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!("message {id}: invalid meta_json: {e}"),
                vec![("id".to_string(), id.clone())],
            )
        })?;
        out.push(ExportMessage {
            id,
            chat_id,
            role,
            content,
            sequence: sequence as u64,
            generation_run_id,
            meta,
            checkpoint_chat_id,
            updated_at,
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
        .prepare(
            "SELECT id, name, kind, settings_json, created_at, updated_at FROM presets ORDER BY id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare presets"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read presets"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, kind, settings_json, created_at, updated_at) =
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
            kind,
            settings,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

// --- v2 section readers -----------------------------------------------------

fn read_personas(db: &Database) -> Result<Vec<ExportPersona>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, name, description, avatar, is_default, created_at, updated_at \
             FROM personas ORDER BY id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare personas"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read personas"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, description, avatar, is_default, created_at, updated_at) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read personas"))?;
        out.push(ExportPersona {
            id,
            name,
            description,
            avatar,
            is_default: is_default != 0,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

fn read_message_variants(
    db: &Database,
    message_ids: &HashSet<&str>,
) -> Result<Vec<ExportMessageVariant>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, message_id, position, content, created_at \
             FROM message_variants ORDER BY message_id, position, id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare message variants"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read message variants"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, message_id, position, content, created_at) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read message variants"))?;
        if !message_ids.contains(message_id.as_str()) {
            continue;
        }
        out.push(ExportMessageVariant {
            id,
            message_id,
            position,
            content,
            created_at,
        });
    }
    Ok(out)
}

fn read_message_content_revisions(
    db: &Database,
    message_ids: &HashSet<&str>,
) -> Result<Vec<ExportMessageContentRevision>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, message_id, position, content, created_at \
             FROM message_content_revisions ORDER BY message_id, position, id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare content revisions"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read content revisions"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, message_id, position, content, created_at) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read content revisions"))?;
        if !message_ids.contains(message_id.as_str()) {
            continue;
        }
        out.push(ExportMessageContentRevision {
            id,
            message_id,
            position,
            content,
            created_at,
        });
    }
    Ok(out)
}

fn read_message_drafts(db: &Database, chat_ids: &HashSet<&str>) -> Result<Vec<ExportMessageDraft>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, chat_id, role, content, sequence, revision, committed_message_id, created_at, updated_at \
             FROM message_drafts ORDER BY chat_id, sequence, id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare drafts"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read drafts"))?;
    let mut out = Vec::new();
    for row in rows {
        let (
            id,
            chat_id,
            role,
            content,
            sequence,
            revision,
            committed_message_id,
            created_at,
            updated_at,
        ) = row.map_err(|e| StorageError::from_sqlite(e, "export: read drafts"))?;
        if !chat_ids.contains(chat_id.as_str()) {
            continue;
        }
        out.push(ExportMessageDraft {
            id,
            chat_id,
            role,
            content,
            sequence,
            revision,
            committed_message_id,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

fn read_character_lorebooks(db: &Database) -> Result<Vec<ExportCharacterLorebook>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT character_id, lorebook_id FROM character_lorebooks ORDER BY lorebook_id, character_id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare character lorebooks"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read character lorebooks"))?;
    let mut out = Vec::new();
    for row in rows {
        let (character_id, lorebook_id) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read character lorebooks"))?;
        out.push(ExportCharacterLorebook {
            character_id,
            lorebook_id,
        });
    }
    Ok(out)
}

fn read_memories(db: &Database) -> Result<Vec<ExportMemory>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, scope, character_id, keys_json, content, enabled, position, metadata_json, created_at, updated_at \
             FROM memories ORDER BY id",
        )
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare memories"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read memories"))?;
    let mut out = Vec::new();
    for row in rows {
        let (
            id,
            scope,
            character_id,
            keys_json,
            content,
            enabled,
            position,
            metadata_json,
            created_at,
            updated_at,
        ) = row.map_err(|e| StorageError::from_sqlite(e, "export: read memories"))?;
        let keys: Vec<String> = serde_json::from_str(&keys_json).map_err(|e| {
            StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!("memory {id}: invalid keys_json: {e}"),
                vec![("id".to_string(), id.clone())],
            )
        })?;
        let metadata: serde_json::Value = serde_json::from_str(&metadata_json).map_err(|e| {
            StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!("memory {id}: invalid metadata_json: {e}"),
                vec![("id".to_string(), id.clone())],
            )
        })?;
        out.push(ExportMemory {
            id,
            scope,
            character_id,
            keys,
            content,
            enabled: enabled != 0,
            position,
            metadata,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

fn read_settings(db: &Database) -> Result<Vec<ExportSetting>> {
    let mut stmt = db
        .conn()
        .prepare("SELECT key, value_json, updated_at FROM settings ORDER BY key")
        .map_err(|e| StorageError::from_sqlite(e, "export: prepare settings"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "export: read settings"))?;
    let mut out = Vec::new();
    for row in rows {
        let (key, value_json, updated_at) =
            row.map_err(|e| StorageError::from_sqlite(e, "export: read settings"))?;
        let value: serde_json::Value = serde_json::from_str(&value_json).map_err(|e| {
            StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!("setting {key}: invalid value_json: {e}"),
                vec![("key".to_string(), key.clone())],
            )
        })?;
        out.push(ExportSetting {
            key,
            value,
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

/// Parses a v2 section NDJSON file. `required == false` (a v1 container)
/// treats a MISSING file as an empty section — the missing section is empty,
/// never an error; a v1 manifest that still DECLARES records for a missing
/// file is corrupt.
fn parse_optional_ndjson<T: serde::de::DeserializeOwned>(
    path: &Path,
    expected: u64,
    required: bool,
) -> Result<Vec<T>> {
    if !required && !path.exists() {
        if expected != 0 {
            return Err(manifest_corrupt(&format!(
                "{}: manifest declares {expected} records but the file is missing",
                path.display()
            )));
        }
        return Ok(Vec::new());
    }
    parse_ndjson(path, expected)
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

/// Probe on the live connection (single writer): `record_exists(conn, table,
/// id)` — used during import referential checks BEFORE the transaction, the
/// tx probe is [`row_exists`].
fn record_exists(conn: &rusqlite::Connection, table: &str, id: &str) -> Result<bool> {
    let sql = format!("SELECT 1 FROM {table} WHERE id = ?1");
    let found = conn
        .query_row(&sql, [id], |r| r.get::<_, i64>(0))
        .optional()
        .map_err(|e| StorageError::from_sqlite(e, "import: probe record"))?;
    Ok(found.is_some())
}

fn row_exists(tx: &rusqlite::Transaction, table: &str, id: &str) -> Result<bool> {
    let sql = format!("SELECT 1 FROM {table} WHERE id = ?1");
    let found = tx
        .query_row(&sql, [id], |r| r.get::<_, i64>(0))
        .optional()
        .map_err(|e| StorageError::from_sqlite(e, "import: probe record"))?;
    Ok(found.is_some())
}

/// Composite-PK probe of the `character_lorebooks` link.
fn link_exists(tx: &rusqlite::Transaction, character_id: &str, lorebook_id: &str) -> Result<bool> {
    let found = tx
        .query_row(
            "SELECT 1 FROM character_lorebooks WHERE character_id = ?1 AND lorebook_id = ?2",
            [character_id, lorebook_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| StorageError::from_sqlite(e, "import: probe lorebook link"))?;
    Ok(found.is_some())
}

/// Key-PK probe of the `settings` table (settings have no id column).
fn setting_exists(tx: &rusqlite::Transaction, key: &str) -> Result<bool> {
    let found = tx
        .query_row("SELECT 1 FROM settings WHERE key = ?1", [key], |r| {
            r.get::<_, i64>(0)
        })
        .optional()
        .map_err(|e| StorageError::from_sqlite(e, "import: probe setting"))?;
    Ok(found.is_some())
}

/// Remaps an optional child reference under `DuplicatePolicy::Remap`; a
/// reference outside the container (target-only or unlinked) keeps its id.
fn remap_opt(id: &Option<String>, map: &HashMap<&str, String>) -> Option<String> {
    id.as_ref().map(|value| {
        map.get(value.as_str())
            .cloned()
            .unwrap_or_else(|| value.clone())
    })
}

fn insert_character(tx: &rusqlite::Transaction, c: &ExportCharacter) -> Result<()> {
    let tags = serde_json::to_string(&c.tags)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize tags: {e}")))?;
    let ext = serde_json::to_string(&c.ext)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize ext: {e}")))?;
    tx.execute(
        "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, profile_id, import_hash, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            c.id,
            c.name,
            c.description,
            c.avatar_asset_id,
            tags,
            ext,
            c.profile_id,
            c.import_hash,
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
         ext_json = ?6, profile_id = ?7, import_hash = ?8, created_at = ?9, updated_at = ?10 WHERE id = ?1",
        rusqlite::params![
            c.id,
            c.name,
            c.description,
            c.avatar_asset_id,
            tags,
            ext,
            c.profile_id,
            c.import_hash,
            c.created_at,
            c.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update character"))?;
    Ok(())
}

fn insert_chat(tx: &rusqlite::Transaction, chat: &ExportChat) -> Result<()> {
    tx.execute(
        "INSERT INTO chats (id, title, character_id, persona_id, parent_chat_id, origin, source_message_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            chat.id,
            chat.title,
            chat.character_id,
            chat.persona_id,
            chat.parent_chat_id,
            chat.origin,
            chat.source_message_id,
            chat.created_at,
            chat.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert chat"))?;
    Ok(())
}

fn update_chat(tx: &rusqlite::Transaction, chat: &ExportChat) -> Result<()> {
    tx.execute(
        "UPDATE chats SET title = ?2, character_id = ?3, persona_id = ?4, parent_chat_id = ?5, \
         origin = ?6, source_message_id = ?7, created_at = ?8, updated_at = ?9 WHERE id = ?1",
        rusqlite::params![
            chat.id,
            chat.title,
            chat.character_id,
            chat.persona_id,
            chat.parent_chat_id,
            chat.origin,
            chat.source_message_id,
            chat.created_at,
            chat.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update chat"))?;
    Ok(())
}

fn insert_message(tx: &rusqlite::Transaction, message: &ExportMessage) -> Result<()> {
    let meta = serde_json::to_string(&message.meta)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize meta: {e}")))?;
    tx.execute(
        "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, meta_json, checkpoint_chat_id, updated_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            message.id,
            message.chat_id,
            message.role,
            message.content,
            message.sequence as i64,
            message.generation_run_id,
            meta,
            message.checkpoint_chat_id,
            message.updated_at,
            message.created_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert message"))?;
    Ok(())
}

fn update_message(tx: &rusqlite::Transaction, message: &ExportMessage) -> Result<()> {
    let meta = serde_json::to_string(&message.meta)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize meta: {e}")))?;
    tx.execute(
        "UPDATE messages SET chat_id = ?2, role = ?3, content = ?4, sequence = ?5, \
         generation_run_id = ?6, meta_json = ?7, checkpoint_chat_id = ?8, updated_at = ?9, created_at = ?10 WHERE id = ?1",
        rusqlite::params![
            message.id,
            message.chat_id,
            message.role,
            message.content,
            message.sequence as i64,
            message.generation_run_id,
            meta,
            message.checkpoint_chat_id,
            message.updated_at,
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
        "INSERT INTO presets (id, name, kind, settings_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            preset.id,
            preset.name,
            preset.kind,
            settings,
            preset.created_at,
            preset.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert preset"))?;
    Ok(())
}

fn update_preset(tx: &rusqlite::Transaction, preset: &ExportPreset) -> Result<()> {
    let settings = serde_json::to_string(&preset.settings)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize settings: {e}")))?;
    tx.execute(
        "UPDATE presets SET name = ?2, kind = ?3, settings_json = ?4, created_at = ?5, updated_at = ?6 WHERE id = ?1",
        rusqlite::params![
            preset.id,
            preset.name,
            preset.kind,
            settings,
            preset.created_at,
            preset.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update preset"))?;
    Ok(())
}

// --- v2 section writers -----------------------------------------------------

fn insert_persona(tx: &rusqlite::Transaction, persona: &ExportPersona) -> Result<()> {
    tx.execute(
        "INSERT INTO personas (id, name, description, avatar, is_default, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            persona.id,
            persona.name,
            persona.description,
            persona.avatar,
            i64::from(persona.is_default),
            persona.created_at,
            persona.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert persona"))?;
    Ok(())
}

fn update_persona(tx: &rusqlite::Transaction, persona: &ExportPersona) -> Result<()> {
    tx.execute(
        "UPDATE personas SET name = ?2, description = ?3, avatar = ?4, is_default = ?5, \
         created_at = ?6, updated_at = ?7 WHERE id = ?1",
        rusqlite::params![
            persona.id,
            persona.name,
            persona.description,
            persona.avatar,
            i64::from(persona.is_default),
            persona.created_at,
            persona.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update persona"))?;
    Ok(())
}

fn insert_message_variant(
    tx: &rusqlite::Transaction,
    variant: &ExportMessageVariant,
) -> Result<()> {
    tx.execute(
        "INSERT INTO message_variants (id, message_id, position, content, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            variant.id,
            variant.message_id,
            variant.position,
            variant.content,
            variant.created_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert message variant"))?;
    Ok(())
}

fn update_message_variant(
    tx: &rusqlite::Transaction,
    variant: &ExportMessageVariant,
) -> Result<()> {
    tx.execute(
        "UPDATE message_variants SET message_id = ?2, position = ?3, content = ?4, created_at = ?5 WHERE id = ?1",
        rusqlite::params![
            variant.id,
            variant.message_id,
            variant.position,
            variant.content,
            variant.created_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update message variant"))?;
    Ok(())
}

fn insert_message_content_revision(
    tx: &rusqlite::Transaction,
    revision: &ExportMessageContentRevision,
) -> Result<()> {
    tx.execute(
        "INSERT INTO message_content_revisions (id, message_id, position, content, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            revision.id,
            revision.message_id,
            revision.position,
            revision.content,
            revision.created_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert content revision"))?;
    Ok(())
}

fn update_message_content_revision(
    tx: &rusqlite::Transaction,
    revision: &ExportMessageContentRevision,
) -> Result<()> {
    tx.execute(
        "UPDATE message_content_revisions SET message_id = ?2, position = ?3, content = ?4, created_at = ?5 WHERE id = ?1",
        rusqlite::params![
            revision.id,
            revision.message_id,
            revision.position,
            revision.content,
            revision.created_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update content revision"))?;
    Ok(())
}

fn insert_message_draft(tx: &rusqlite::Transaction, draft: &ExportMessageDraft) -> Result<()> {
    tx.execute(
        "INSERT INTO message_drafts (id, chat_id, role, content, sequence, revision, committed_message_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            draft.id,
            draft.chat_id,
            draft.role,
            draft.content,
            draft.sequence,
            draft.revision,
            draft.committed_message_id,
            draft.created_at,
            draft.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert message draft"))?;
    Ok(())
}

fn update_message_draft(tx: &rusqlite::Transaction, draft: &ExportMessageDraft) -> Result<()> {
    tx.execute(
        "UPDATE message_drafts SET chat_id = ?2, role = ?3, content = ?4, sequence = ?5, \
         revision = ?6, committed_message_id = ?7, created_at = ?8, updated_at = ?9 WHERE id = ?1",
        rusqlite::params![
            draft.id,
            draft.chat_id,
            draft.role,
            draft.content,
            draft.sequence,
            draft.revision,
            draft.committed_message_id,
            draft.created_at,
            draft.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update message draft"))?;
    Ok(())
}

fn insert_character_lorebook(
    tx: &rusqlite::Transaction,
    link: &ExportCharacterLorebook,
) -> Result<()> {
    tx.execute(
        "INSERT INTO character_lorebooks (character_id, lorebook_id) VALUES (?1, ?2)",
        rusqlite::params![link.character_id, link.lorebook_id],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert lorebook link"))?;
    Ok(())
}

fn insert_memory(tx: &rusqlite::Transaction, memory: &ExportMemory) -> Result<()> {
    let keys = serde_json::to_string(&memory.keys)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize keys: {e}")))?;
    let metadata = serde_json::to_string(&memory.metadata)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize metadata: {e}")))?;
    tx.execute(
        "INSERT INTO memories (id, scope, character_id, keys_json, content, enabled, position, metadata_json, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            memory.id,
            memory.scope,
            memory.character_id,
            keys,
            memory.content,
            i64::from(memory.enabled),
            memory.position,
            metadata,
            memory.created_at,
            memory.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert memory"))?;
    Ok(())
}

fn update_memory(tx: &rusqlite::Transaction, memory: &ExportMemory) -> Result<()> {
    let keys = serde_json::to_string(&memory.keys)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize keys: {e}")))?;
    let metadata = serde_json::to_string(&memory.metadata)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize metadata: {e}")))?;
    tx.execute(
        "UPDATE memories SET scope = ?2, character_id = ?3, keys_json = ?4, content = ?5, \
         enabled = ?6, position = ?7, metadata_json = ?8, created_at = ?9, updated_at = ?10 WHERE id = ?1",
        rusqlite::params![
            memory.id,
            memory.scope,
            memory.character_id,
            keys,
            memory.content,
            i64::from(memory.enabled),
            memory.position,
            metadata,
            memory.created_at,
            memory.updated_at,
        ],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update memory"))?;
    Ok(())
}

fn insert_setting(tx: &rusqlite::Transaction, setting: &ExportSetting) -> Result<()> {
    let value = serde_json::to_string(&setting.value)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize value: {e}")))?;
    tx.execute(
        "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![setting.key, value, setting.updated_at],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: insert setting"))?;
    Ok(())
}

fn update_setting(tx: &rusqlite::Transaction, setting: &ExportSetting) -> Result<()> {
    let value = serde_json::to_string(&setting.value)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("serialize value: {e}")))?;
    tx.execute(
        "UPDATE settings SET value_json = ?2, updated_at = ?3 WHERE key = ?1",
        rusqlite::params![setting.key, value, setting.updated_at],
    )
    .map_err(|e| StorageError::from_sqlite(e, "import: update setting"))?;
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
/// Generates a wire-compatible fresh id for remapped records.
///
/// Layout: 48 bits of Unix-epoch milliseconds, the RFC 4122 version nibble
/// of 4, the variant bits (`10xx`), and 74 random bits drawn from
/// [`std::collections::hash_map::RandomState`] — `std`'s OS-seeded hash
/// state, the only randomness source available without extra dependencies.
/// The version nibble is pinned to 4 exactly like the kernel's `new_id`
/// (timestamp-ordered, but wire-format compatible: the Product Wire uuid
/// format only admits versions 1–5), and the timestamp prefix keeps ids
/// time-ordered.
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
    push_hex(&mut out, 0x4000 | ((rand_a >> 12) & 0x0FFF), 4);
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
