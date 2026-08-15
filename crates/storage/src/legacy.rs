//! Legacy (pre-kernel) data-root converter (ТЗ §34, Фаза 11).
//!
//! Converts a legacy NeoTavern database — the pre-kernel Drizzle schema
//! (`packages/db/src/schema/tables.ts`) — into a fresh kernel data root
//! staged in a [`Candidate`].
//!
//! # Detection window
//!
//! A source is treated as legacy when it exposes the five product tables
//! (`characters`, `chats`, `messages`, `lorebooks`, `presets`) and has no
//! `__neotavern_meta` table. Anything else — including a kernel database —
//! is rejected with a controlled
//! [`StorageErrorCode::UnsupportedStorageFormat`] error.
//!
//! # Mapping
//!
//! - `characters` → kernel `characters`: `description`/`ext` are mapped
//!   directly; the legacy `avatar` string is NOT copied verbatim (it is not a
//!   managed asset key), but the avatar ORIGINAL under `files/avatars/` is
//!   converted into a canonical `avatar` asset linked via
//!   `characters.avatar_asset_id` (ADR-0046 waiver 8, assets part; ТЗ §34
//!   avatar→asset); an optional `tags` column is read as a JSON array when
//!   present (default `[]`); `created_at`/`updated_at` epoch millis become
//!   RFC 3339.
//! - `chats` → kernel `chats`: `title` defaults to `"New chat"`; chats with
//!   a NULL or unresolvable `character_id` are skipped and reported.
//! - `messages` → kernel `messages`: `role` defaults to `"user"` for missing
//!   or unknown values (legacy `plugin` included), keeping the kernel CHECK
//!   values; `sequence` is taken from the column when present, otherwise
//!   derived as a per-chat row number ordered by `created_at, id`;
//!   messages referencing a skipped or missing chat are skipped and reported.
//!   The legacy `branch_id` has no kernel equivalent (ADR-0046 waiver 8,
//!   branches part): ALL messages — active and side branches alike — are
//!   preserved flattened into the chat sequence in creation order, so no
//!   message data is dropped, while branch semantics themselves are not
//!   reproduced (the canonical model has no branch entity; ТЗ §34 keeps
//!   unknown metadata, the kernel has no branch reader/writer).
//! - `lorebooks` → kernel `lorebooks`: entries come from the legacy
//!   `lore_entries` table (when present) and are stored as `entries_json`.
//! - `presets` → kernel `presets`: `data` becomes `settings_json`; the
//!   legacy `kind` column has no kernel equivalent and is not copied.
//! - `settings` → kernel `settings` (ADR-0046 waiver 8, settings part;
//!   ТЗ §8.1 Configuration): legacy `key → value` (JSON text) becomes
//!   `key → value_json` verbatim; a non-JSON legacy value is preserved as a
//!   JSON string so no setting is silently dropped. The legacy table has no
//!   `updated_at` column — the kernel row takes the conversion timestamp.
//!   The legacy table is optional: a pre-settings source contributes 0 rows.
//! - `personas` → kernel `personas` (Этап 4.1): `is_default` maps from the
//!   legacy boolean column (default 0); the single-default invariant is
//!   enforced on insert. The legacy `personas` table is optional — sources
//!   predating it contribute 0 rows.
//!
//! Provider configs, provider secrets, plugin tables and themes are NEVER
//! copied (ТЗ §43 import rules). The source database is opened strictly
//! read-only and is never modified.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::error::{Result, StorageError, StorageErrorCode};
use crate::export::ExportLoreEntry;
use crate::migrations::fresh_install;
use crate::paths::db_path;
use crate::restore::Candidate;

/// Result of a legacy conversion: per-table inserted row counts plus the
/// skipped (orphaned/invalid) records and their descriptions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversionReport {
    pub characters: u64,
    pub chats: u64,
    pub messages: u64,
    /// Swipe variants copied from the legacy `message_variants` table
    /// (Этап 4 slice 2; optional legacy table — pre-swipe sources give 0).
    pub message_variants: u64,
    /// Immutable content revisions copied from the legacy
    /// `message_content_revisions` table (Этап 4 slice 2; optional).
    pub message_content_revisions: u64,
    /// Server-side drafts copied from the legacy `message_drafts` table
    /// (Этап 4 slice 2; optional). `branch_id`/`name`/`meta` have no kernel
    /// equivalent and are not copied; drafts whose committed message did not
    /// convert are skipped so commit replay can never reference a missing
    /// message.
    pub message_drafts: u64,
    pub lorebooks: u64,
    pub presets: u64,
    /// Memories copied from the legacy `memories` table (Этап 4 slice 3,
    /// ТЗ §4.4 Memory/RAG). The legacy table is optional (FTS-backed,
    /// introduced by migration 0006); a source without it contributes 0.
    /// Character-scoped rows keep their `character_id` even when the
    /// character did not convert (the kernel `memories.character_id` has no
    /// FK, so unknown legacy references survive).
    pub memories: u64,
    /// Personas migrated from the legacy `personas` table (Этап 4.1). The
    /// legacy table is optional: a pre-personas source simply contributes 0.
    pub personas: u64,
    /// Avatar originals converted into canonical assets (ADR-0046 waiver 8,
    /// assets part, ТЗ §34 avatar→asset): one per character whose legacy
    /// `avatar` URL resolved to a file under `files/avatars/`.
    pub assets: u64,
    /// Non-secret settings copied from the legacy `settings` table
    /// (ADR-0046 waiver 8, settings part, ТЗ §8.1 Configuration). The legacy
    /// table is optional — a source without it contributes 0 rows.
    pub settings: u64,
    /// Number of records skipped (orphaned references, invalid values).
    pub skipped: u64,
    /// Human-readable descriptions of every skipped record.
    pub orphans: Vec<String>,
}

/// Kernel `messages.role` CHECK values; anything else maps to `"user"`.
const KERNEL_ROLES: [&str; 4] = ["system", "user", "assistant", "tool"];

/// Converts the legacy database at `source_db` into a fresh kernel data root
/// inside `candidate`.
///
/// The source is opened strictly read-only (no journal writes, no mtime
/// change); the candidate directory is private staging next to the target
/// root (not the active root), so a fresh kernel schema is installed there
/// and the mapped rows are committed in a single transaction.
pub fn convert_legacy(source_db: &Path, candidate: &Candidate) -> Result<ConversionReport> {
    let legacy = Connection::open_with_flags(source_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: open source read-only"))?;

    // Detection (ТЗ §34): legacy roots expose the five product tables and
    // have no kernel meta table.
    if !table_exists(&legacy, "characters")? {
        return Err(incompatible("no characters table (not a legacy data root)"));
    }
    if table_exists(&legacy, "__neotavern_meta")? {
        return Err(incompatible(
            "source is a kernel data root, not a legacy root",
        ));
    }
    for table in ["chats", "messages", "lorebooks", "presets"] {
        if !table_exists(&legacy, table)? {
            return Err(incompatible(&format!("missing legacy table {table}")));
        }
    }

    // Fresh kernel schema into the candidate database. The candidate dir is
    // private staging, so no data-root lease is involved.
    let candidate_db = db_path(&candidate.path);
    let mut fresh = Connection::open(&candidate_db)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: open candidate database"))?;
    fresh_install(&fresh, &mut |_| {})?;

    let tx = fresh
        .transaction()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: begin insert transaction"))?;
    // Legacy avatar originals live next to the legacy database (ТЗ §10.3
    // layout: `<data-dir>/files/avatars/`), while the canonical asset store
    // lives under the candidate data root.
    let legacy_data_dir = source_db
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let report = convert(&legacy, &tx, &legacy_data_dir, &candidate.path)?;
    tx.commit()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: commit insert transaction"))?;
    Ok(report)
}

/// Maps all product tables into `tx` (single transaction). Inserts are
/// ordered characters → chats → messages → variants/revisions/drafts so
/// foreign keys always resolve.
fn convert(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    legacy_data_dir: &Path,
    kernel_root: &Path,
) -> Result<ConversionReport> {
    let mut report = ConversionReport {
        characters: 0,
        chats: 0,
        messages: 0,
        message_variants: 0,
        message_content_revisions: 0,
        message_drafts: 0,
        lorebooks: 0,
        presets: 0,
        memories: 0,
        personas: 0,
        assets: 0,
        settings: 0,
        skipped: 0,
        orphans: Vec::new(),
    };
    let character_ids = convert_characters(legacy, tx, &mut report)?;
    // Avatar originals (ADR-0046 waiver 8, assets part): published into the
    // canonical asset store and linked via `characters.avatar_asset_id`.
    // Runs after convert_characters so the rows exist for the UPDATE.
    convert_avatars(legacy, tx, legacy_data_dir, kernel_root, &mut report)?;
    // Personas convert BEFORE chats: `chats.persona_id` has an FK to
    // `personas` (ON DELETE SET NULL), so the persona rows must exist before
    // any chat row references them (foreign_keys = ON during conversion).
    convert_personas(legacy, tx, &mut report)?;
    let chat_ids = convert_chats(legacy, tx, &character_ids, &mut report)?;
    let message_ids = convert_messages(legacy, tx, &chat_ids, &mut report)?;
    convert_message_variants(legacy, tx, &message_ids, &mut report)?;
    convert_content_revisions(legacy, tx, &message_ids, &mut report)?;
    convert_message_drafts(legacy, tx, &chat_ids, &message_ids, &mut report)?;
    convert_lorebooks(legacy, tx, &character_ids, &mut report)?;
    convert_presets(legacy, tx, &mut report)?;
    convert_memories(legacy, tx, &mut report)?;
    convert_settings(legacy, tx, &mut report)?;
    Ok(report)
}

fn convert_characters(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    report: &mut ConversionReport,
) -> Result<HashSet<String>> {
    let cols = column_names(legacy, "characters")?;
    require_columns(
        &cols,
        "characters",
        &["id", "name", "created_at", "updated_at"],
    )?;
    let selected = select_columns(
        &cols,
        &[
            "id",
            "name",
            "description",
            "avatar",
            "tags",
            "ext",
            "personality",
            "scenario",
            "first_message",
            "example_dialogues",
            "system_prompt",
            "post_history_instructions",
            "creator",
            "creator_notes",
            "deleted_at",
            "created_at",
            "updated_at",
        ],
    );
    // Legacy (Drizzle) stores tags as a `character_tags`/`tags` join; the
    // converter fixture's inline `tags` column is also supported. Either way
    // the merged list lands in the kernel `tags_json`.
    let tags_by_id = read_character_tags(legacy)?;
    let sql = format!(
        "SELECT {} FROM characters ORDER BY id",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare characters"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query characters"))?;
    let mut ids = HashSet::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read characters"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "character: missing id");
            continue;
        };
        // Soft-deleted characters are not revived by the migration
        // (ТЗ §17.4 corpus: orphaned/deleted records are reported, not
        // resurrected).
        if as_i64(get("deleted_at")).is_some() {
            skip(report, &format!("character {id}: soft-deleted, skipped"));
            continue;
        }
        let Some(name) = as_text(get("name")) else {
            skip(report, &format!("character {id}: missing name"));
            continue;
        };
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("character {id}: invalid created_at"));
            continue;
        };
        let Some(updated_at) = ms_to_rfc3339_checked(get("updated_at")) else {
            skip(report, &format!("character {id}: invalid updated_at"));
            continue;
        };
        let description = as_text(get("description")).map(str::to_owned);
        let mut tags = parse_json_array(get("tags"));
        if let Some(joined) = tags_by_id.get(id) {
            for tag in joined {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
        }
        // Known legacy card fields survive into `ext_json` under stable keys
        // (kernel prompt reads `ext_json.personality` / `persona` for the
        // persona block; ТЗ §10.3 "unknown character metadata сохраняются").
        let mut ext = parse_json(get("ext"));
        if !ext.is_object() {
            ext = serde_json::json!({});
        }
        let ext_obj = ext.as_object_mut().expect("ext is an object");
        for (key, column) in [
            ("personality", "personality"),
            ("scenario", "scenario"),
            ("first_message", "first_message"),
            ("example_dialogues", "example_dialogues"),
            ("system_prompt", "system_prompt"),
            ("post_history_instructions", "post_history_instructions"),
            ("creator", "creator"),
            ("creator_notes", "creator_notes"),
        ] {
            if let Some(text) = as_text(get(column)) {
                ext_obj
                    .entry(key)
                    .or_insert_with(|| serde_json::Value::String(text.to_string()));
            }
        }
        // `avatar` is intentionally not copied verbatim: legacy avatar
        // strings are not managed asset keys (ТЗ §34: avatar→asset skip). The
        // original FILE is converted separately by `convert_avatars`, which
        // publishes it into the canonical asset store and links
        // `avatar_asset_id` here.
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                name,
                description,
                None::<String>,
                serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&ext).unwrap_or_else(|_| "{}".to_string()),
                created_at,
                updated_at,
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert character"))?;
        report.characters += 1;
        ids.insert(id.to_string());
    }
    Ok(ids)
}

/// Converts legacy avatar originals (ADR-0046 waiver 8, assets part, ТЗ §34
/// avatar→asset): `characters.avatar` is a content-addressed URL
/// (`/api/v2/assets/avatars/<sha256>.<ext>` or the thumbnail variant
/// `/api/v2/assets/thumbnails/<sha256>-<size>-v<v>.<ext>`); the original file
/// lives at `<data-dir>/files/avatars/<sha256>.<ext>`. Matching files are
/// published into the canonical asset store (kind `avatar`) and the character
/// row gets the asset id (idempotent per content hash — the same bytes
/// re-publish as one record). A missing file or an unrecognizable avatar
/// string is reported as an orphan and the character stays unlinked — no
/// silent data loss.
fn convert_avatars(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    legacy_data_dir: &Path,
    kernel_root: &Path,
    report: &mut ConversionReport,
) -> Result<()> {
    // Pre-avatar legacy schemas (no `avatar` column) contribute nothing.
    let cols = column_names(legacy, "characters")?;
    if !cols.iter().any(|c| c == "avatar") {
        return Ok(());
    }
    let mut stmt = legacy
        .prepare("SELECT id, avatar FROM characters")
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare character avatars"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query character avatars"))?;
    let avatars_dir = legacy_data_dir.join("files").join("avatars");
    for row in rows {
        let (character_id, avatar) =
            row.map_err(|e| StorageError::from_sqlite(e, "legacy: read character avatar"))?;
        let Some(avatar) = avatar else {
            continue;
        };
        let Some(hash) = avatar_hash(&avatar) else {
            report.orphans.push(format!(
                "character {character_id}: avatar is not a managed asset URL ({avatar})"
            ));
            continue;
        };
        let Some(relative_key) = find_avatar_file(&avatars_dir, &hash) else {
            report.skipped += 1;
            report.orphans.push(format!(
                "character {character_id}: avatar original {hash} not found under files/avatars"
            ));
            continue;
        };
        let avatar_path = avatars_dir.join(hash_key_file(&relative_key));
        let bytes = std::fs::read(&avatar_path)
            .map_err(|e| crate::error::io_err(e, "legacy: read avatar original"))?;
        // UUIDv7 with the version nibble rewritten to 4 — same scheme the
        // kernel uses (monotonic ordering, valid wire uuid).
        const VERSION_NIBBLE_MASK: u128 = 0xF000_0000_0000_0000_0000;
        const V4_NIBBLE: u128 = 0x4000_0000_0000_0000_0000;
        let raw = uuid::Uuid::now_v7().as_u128();
        let id = uuid::Uuid::from_u128((raw & !VERSION_NIBBLE_MASK) | V4_NIBBLE).to_string();
        crate::assets::publish_asset_in_tx(kernel_root, tx, &id, "avatar", &relative_key, &bytes)
            .map_err(|e| {
            StorageError::with(
                e.code,
                format!("legacy: publish avatar for character {character_id}: {e}"),
                e.params,
            )
        })?;
        tx.execute(
            "UPDATE characters SET avatar_asset_id = ?1 WHERE id = ?2",
            rusqlite::params![id, character_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: link avatar asset"))?;
        report.assets += 1;
    }
    Ok(())
}

/// Extracts the 64-char content hash from a managed avatar URL — the
/// isolated hex run bounded by non-hex characters (the `/avatars/` or
/// `/thumbnails/` segments plus the extension).
fn avatar_hash(avatar: &str) -> Option<String> {
    let bytes = avatar.as_bytes();
    if bytes.len() < 64 {
        return None;
    }
    for i in 0..=bytes.len() - 64 {
        if !bytes[i..i + 64].iter().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let prev_hex = i > 0 && bytes[i - 1].is_ascii_hexdigit();
        let next_hex = i + 64 < bytes.len() && bytes[i + 64].is_ascii_hexdigit();
        if !prev_hex && !next_hex {
            return Some(avatar[i..i + 64].to_string());
        }
    }
    None
}

/// Supported avatar original extensions (mirrors
/// `apps/server/src/plugins/characterGallery.ts`).
const AVATAR_EXTENSIONS: [&str; 4] = [".png", ".jpg", ".webp", ".gif"];

/// Returns the managed relative key (`avatar/<sha256><ext>`) of the avatar
/// original present under `avatars_dir`, or `None` when no supported file
/// exists.
fn find_avatar_file(avatars_dir: &Path, hash: &str) -> Option<String> {
    for ext in AVATAR_EXTENSIONS {
        let candidate = avatars_dir.join(format!("{hash}{ext}"));
        if candidate.is_file() {
            return Some(format!("avatar/{hash}{ext}"));
        }
    }
    None
}

/// The file name part of a managed avatar key (`avatar/<hash>.<ext>` → the
/// `<hash>.<ext>` file under `files/avatars/`).
fn hash_key_file(relative_key: &str) -> &str {
    relative_key.rsplit('/').next().unwrap_or(relative_key)
}

/// Reads the `character_tags`/`tags` join (the real Drizzle legacy layout)
/// into `character_id → [tag names]` (sorted, deduplicated). Missing join
/// tables → empty map (the inline `tags` column is then the only source).
fn read_character_tags(legacy: &Connection) -> Result<HashMap<String, Vec<String>>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    if !table_exists(legacy, "character_tags")? || !table_exists(legacy, "tags")? {
        return Ok(out);
    }
    let mut stmt = legacy
        .prepare(
            "SELECT ct.character_id, t.name \
             FROM character_tags ct JOIN tags t ON t.id = ct.tag_id \
             ORDER BY t.name",
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare character_tags"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query character_tags"))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read character_tags"))?
    {
        let character_id: String = row
            .get(0)
            .map_err(|e| StorageError::from_sqlite(e, "legacy: tag character id"))?;
        let name: String = row
            .get(1)
            .map_err(|e| StorageError::from_sqlite(e, "legacy: tag name"))?;
        out.entry(character_id).or_default().push(name);
    }
    Ok(out)
}

fn convert_chats(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    character_ids: &HashSet<String>,
    report: &mut ConversionReport,
) -> Result<HashSet<String>> {
    let cols = column_names(legacy, "chats")?;
    require_columns(&cols, "chats", &["id", "created_at", "updated_at"])?;
    let has_persona_id = cols.iter().any(|c| c == "persona_id");
    let mut selected = select_columns(
        &cols,
        &[
            "id",
            "title",
            "character_id",
            "persona_id",
            "deleted_at",
            "created_at",
            "updated_at",
        ],
    );
    if !has_persona_id {
        // Pre-persona legacy roots (chats without the column) convert with a
        // NULL persona — the wire contract keeps personaId optional.
        selected.retain(|c| *c != "persona_id");
    }
    let sql = format!("SELECT {} FROM chats ORDER BY id", quote_columns(&selected));
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare chats"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query chats"))?;
    let mut ids = HashSet::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read chats"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "chat: missing id");
            continue;
        };
        // Soft-deleted chats are not revived either (kernel has no
        // `deleted_at`; resurrection would break FK and user expectations).
        if as_i64(get("deleted_at")).is_some() {
            skip(report, &format!("chat {id}: soft-deleted, skipped"));
            continue;
        }
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("chat {id}: invalid created_at"));
            continue;
        };
        let Some(updated_at) = ms_to_rfc3339_checked(get("updated_at")) else {
            skip(report, &format!("chat {id}: invalid updated_at"));
            continue;
        };
        let title = as_text(get("title")).unwrap_or("New chat").to_string();
        let Some(character_id) = as_text(get("character_id")).map(str::to_owned) else {
            skip(report, &format!("chat {id}: missing character reference"));
            continue;
        };
        if !character_ids.contains(&character_id) {
            skip(
                report,
                &format!("chat {id}: references missing character {character_id}"),
            );
            continue;
        }
        // The legacy persona reference converts verbatim (the kernel FK is
        // `ON DELETE SET NULL` — same semantics as legacy). A dangling
        // persona_id (persona row already gone) survives as-is on the wire
        // just like it did in the source: the FK fires only on *delete*.
        let persona_id: Option<String> = if has_persona_id {
            as_text(get("persona_id")).map(str::to_owned)
        } else {
            None
        };
        tx.execute(
            "INSERT INTO chats (id, title, character_id, persona_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, title, character_id, persona_id, created_at, updated_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert chat"))?;
        report.chats += 1;
        ids.insert(id.to_string());
    }
    Ok(ids)
}

fn convert_messages(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    chat_ids: &HashSet<String>,
    report: &mut ConversionReport,
) -> Result<HashSet<String>> {
    let cols = column_names(legacy, "messages")?;
    require_columns(
        &cols,
        "messages",
        &["id", "chat_id", "content", "created_at"],
    )?;
    let has_sequence = cols.iter().any(|c| c == "sequence");
    let selected = select_columns(
        &cols,
        &["id", "chat_id", "role", "content", "sequence", "created_at"],
    );
    // Without a sequence column, rows are derived as a per-chat row number
    // ordered by created_at, id (the legacy ordering semantics).
    let order = if has_sequence {
        "ORDER BY id"
    } else {
        "ORDER BY chat_id, created_at, id"
    };
    let sql = format!("SELECT {} FROM messages {order}", quote_columns(&selected));
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare messages"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query messages"))?;
    let mut seq_by_chat: HashMap<String, i64> = HashMap::new();
    let mut converted_ids: HashSet<String> = HashSet::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read messages"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "message: missing id");
            continue;
        };
        let Some(chat_id) = as_text(get("chat_id")).map(str::to_owned) else {
            skip(report, &format!("message {id}: missing chat reference"));
            continue;
        };
        if !chat_ids.contains(&chat_id) {
            skip(
                report,
                &format!("message {id}: references missing chat {chat_id}"),
            );
            continue;
        }
        let Some(content) = as_text(get("content")) else {
            skip(report, &format!("message {id}: missing content"));
            continue;
        };
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("message {id}: invalid created_at"));
            continue;
        };
        let role = match as_text(get("role")) {
            Some(role) if KERNEL_ROLES.contains(&role) => role.to_string(),
            _ => "user".to_string(),
        };
        let sequence = if has_sequence {
            match as_i64(get("sequence")) {
                Some(seq) => seq,
                None => {
                    skip(report, &format!("message {id}: invalid sequence"));
                    continue;
                }
            }
        } else {
            let next = seq_by_chat.entry(chat_id.clone()).or_insert(0);
            let seq = *next;
            *next += 1;
            seq
        };
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, chat_id, role, content, sequence, created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert message"))?;
        report.messages += 1;
        converted_ids.insert(id.to_string());
    }
    Ok(converted_ids)
}

/// Maps the legacy `message_variants` (swipe) rows into the kernel
/// `message_variants` table (Этап 4 slice 2). The legacy table is optional
/// (pre-swipe sources contribute 0); a variant whose message did not convert
/// is skipped. Legacy `position` values are preserved (the kernel orders by
/// position and allocates `MAX+1` on create, so holes from the legacy
/// permutation-with-hole model are harmless); a source without the column
/// derives per-message positions in `created_at, id` order.
fn convert_message_variants(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    message_ids: &HashSet<String>,
    report: &mut ConversionReport,
) -> Result<()> {
    if !table_exists(legacy, "message_variants")? {
        return Ok(());
    }
    let cols = column_names(legacy, "message_variants")?;
    require_columns(
        &cols,
        "message_variants",
        &["id", "message_id", "content", "created_at"],
    )?;
    let has_position = cols.iter().any(|c| c == "position");
    let selected = select_columns(
        &cols,
        &["id", "message_id", "content", "position", "created_at"],
    );
    let sql = format!(
        "SELECT {} FROM message_variants ORDER BY message_id, created_at, id",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare message_variants"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query message_variants"))?;
    let mut pos_by_message: HashMap<String, i64> = HashMap::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read message_variants"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "message_variant: missing id");
            continue;
        };
        let Some(message_id) = as_text(get("message_id")).map(str::to_owned) else {
            skip(
                report,
                &format!("message_variant {id}: missing message reference"),
            );
            continue;
        };
        if !message_ids.contains(&message_id) {
            skip(
                report,
                &format!("message_variant {id}: references missing message {message_id}"),
            );
            continue;
        }
        let Some(content) = as_text(get("content")) else {
            skip(report, &format!("message_variant {id}: missing content"));
            continue;
        };
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("message_variant {id}: invalid created_at"));
            continue;
        };
        let position = if has_position {
            match as_i64(get("position")) {
                Some(position) => position,
                None => {
                    skip(report, &format!("message_variant {id}: invalid position"));
                    continue;
                }
            }
        } else {
            let next = pos_by_message.entry(message_id.clone()).or_insert(0);
            let position = *next;
            *next += 1;
            position
        };
        tx.execute(
            "INSERT INTO message_variants (id, message_id, position, content, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, message_id, position, content, created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert message_variant"))?;
        report.message_variants += 1;
    }
    Ok(())
}

/// Maps the legacy `message_content_revisions` rows into the kernel
/// `message_content_revisions` table (Этап 4 slice 2). The legacy table is
/// optional; a revision whose message did not convert is skipped.
fn convert_content_revisions(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    message_ids: &HashSet<String>,
    report: &mut ConversionReport,
) -> Result<()> {
    if !table_exists(legacy, "message_content_revisions")? {
        return Ok(());
    }
    let cols = column_names(legacy, "message_content_revisions")?;
    require_columns(
        &cols,
        "message_content_revisions",
        &["id", "message_id", "content", "created_at"],
    )?;
    let selected = select_columns(
        &cols,
        &["id", "message_id", "position", "content", "created_at"],
    );
    let sql = format!(
        "SELECT {} FROM message_content_revisions ORDER BY message_id, position, created_at, id",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare message_content_revisions"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query message_content_revisions"))?;
    let mut pos_by_message: HashMap<String, i64> = HashMap::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read message_content_revisions"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "content_revision: missing id");
            continue;
        };
        let Some(message_id) = as_text(get("message_id")).map(str::to_owned) else {
            skip(
                report,
                &format!("content_revision {id}: missing message reference"),
            );
            continue;
        };
        if !message_ids.contains(&message_id) {
            skip(
                report,
                &format!("content_revision {id}: references missing message {message_id}"),
            );
            continue;
        }
        let Some(content) = as_text(get("content")) else {
            skip(report, &format!("content_revision {id}: missing content"));
            continue;
        };
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(
                report,
                &format!("content_revision {id}: invalid created_at"),
            );
            continue;
        };
        let position = if cols.iter().any(|c| c == "position") {
            match as_i64(get("position")) {
                Some(position) => position,
                None => {
                    skip(report, &format!("content_revision {id}: invalid position"));
                    continue;
                }
            }
        } else {
            let next = pos_by_message.entry(message_id.clone()).or_insert(0);
            let position = *next;
            *next += 1;
            position
        };
        tx.execute(
            "INSERT INTO message_content_revisions (id, message_id, position, content, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, message_id, position, content, created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert content_revision"))?;
        report.message_content_revisions += 1;
    }
    Ok(())
}

/// Maps the legacy `message_drafts` rows into the kernel `message_drafts`
/// table (Этап 4 slice 2). The legacy table is optional; the legacy
/// `branch_id`/`name`/`meta` columns have no kernel equivalent and are not
/// copied (the kernel keeps one linear sequence per chat). A draft whose
/// chat did not convert, whose role is not kernel-legal, or whose
/// `committed_message_id` references a message that did not convert is
/// skipped — never a dangling outbox reference.
fn convert_message_drafts(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    chat_ids: &HashSet<String>,
    message_ids: &HashSet<String>,
    report: &mut ConversionReport,
) -> Result<()> {
    if !table_exists(legacy, "message_drafts")? {
        return Ok(());
    }
    let cols = column_names(legacy, "message_drafts")?;
    require_columns(
        &cols,
        "message_drafts",
        &["id", "chat_id", "role", "content", "created_at"],
    )?;
    let selected = select_columns(
        &cols,
        &[
            "id",
            "chat_id",
            "role",
            "content",
            "sequence",
            "revision",
            "committed_message_id",
            "created_at",
            "updated_at",
        ],
    );
    let sql = format!(
        "SELECT {} FROM message_drafts ORDER BY id",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare message_drafts"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query message_drafts"))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read message_drafts"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "message_draft: missing id");
            continue;
        };
        let Some(chat_id) = as_text(get("chat_id")).map(str::to_owned) else {
            skip(
                report,
                &format!("message_draft {id}: missing chat reference"),
            );
            continue;
        };
        if !chat_ids.contains(&chat_id) {
            skip(
                report,
                &format!("message_draft {id}: references missing chat {chat_id}"),
            );
            continue;
        }
        let role = match as_text(get("role")) {
            Some(role) if KERNEL_ROLES.contains(&role) => role.to_string(),
            Some(role) => {
                skip(
                    report,
                    &format!("message_draft {id}: role '{role}' has no kernel equivalent"),
                );
                continue;
            }
            None => {
                skip(report, &format!("message_draft {id}: missing role"));
                continue;
            }
        };
        let Some(content) = as_text(get("content")) else {
            skip(report, &format!("message_draft {id}: missing content"));
            continue;
        };
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("message_draft {id}: invalid created_at"));
            continue;
        };
        let updated_at = match ms_to_rfc3339_checked(get("updated_at")) {
            Some(updated_at) => updated_at,
            None => created_at.clone(),
        };
        let sequence = as_i64(get("sequence")).unwrap_or(0);
        let revision = as_i64(get("revision")).unwrap_or(1);
        let committed_message_id = match as_text(get("committed_message_id")) {
            None => None,
            Some(committed) if message_ids.contains(committed) => Some(committed.to_string()),
            Some(committed) => {
                skip(
                    report,
                    &format!("message_draft {id}: committed message {committed} did not convert"),
                );
                continue;
            }
        };
        tx.execute(
            "INSERT INTO message_drafts \
             (id, chat_id, role, content, sequence, revision, committed_message_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                id,
                chat_id,
                role,
                content,
                sequence,
                revision,
                committed_message_id,
                created_at,
                updated_at
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert message_draft"))?;
        report.message_drafts += 1;
    }
    Ok(())
}

fn convert_lorebooks(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    character_ids: &HashSet<String>,
    report: &mut ConversionReport,
) -> Result<()> {
    let cols = column_names(legacy, "lorebooks")?;
    require_columns(
        &cols,
        "lorebooks",
        &["id", "name", "created_at", "updated_at"],
    )?;
    let has_metadata = cols.iter().any(|c| c == "metadata");
    let mut selected = vec!["id", "name", "description", "created_at", "updated_at"];
    if has_metadata {
        selected.push("metadata");
    }
    let sql = format!(
        "SELECT {} FROM lorebooks ORDER BY id",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare lorebooks"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query lorebooks"))?;

    // Book rows are collected first so entries referencing a book that does
    // not survive the conversion can be reported as orphans.
    let mut books: Vec<(String, String, String, String, String, serde_json::Value)> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read lorebooks"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "lorebook: missing id");
            continue;
        };
        let Some(name) = as_text(get("name")) else {
            skip(report, &format!("lorebook {id}: missing name"));
            continue;
        };
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("lorebook {id}: invalid created_at"));
            continue;
        };
        let Some(updated_at) = ms_to_rfc3339_checked(get("updated_at")) else {
            skip(report, &format!("lorebook {id}: invalid updated_at"));
            continue;
        };
        let metadata = if has_metadata {
            parse_json(get("metadata"))
        } else {
            serde_json::Value::Null
        };
        books.push((
            id.to_string(),
            name.to_string(),
            as_text(get("description")).unwrap_or("").to_string(),
            created_at,
            updated_at,
            metadata,
        ));
    }

    let entries_by_book = if table_exists(legacy, "lore_entries")? {
        read_lore_entries(legacy, report)?
    } else {
        HashMap::new()
    };
    let book_ids: HashSet<&str> = books.iter().map(|b| b.0.as_str()).collect();
    for (book_id, entries) in &entries_by_book {
        if !book_ids.contains(book_id.as_str()) {
            report.skipped += entries.len() as u64;
            report
                .orphans
                .push(format!("lore entries reference missing lorebook {book_id}"));
        }
    }

    for (id, name, description, created_at, updated_at, metadata) in &books {
        let entries = entries_by_book.get(id).cloned().unwrap_or_default();
        tx.execute(
            "INSERT INTO lorebooks (id, name, description, entries_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                id,
                name,
                description,
                serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string()),
                created_at,
                updated_at,
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert lorebook"))?;
        report.lorebooks += 1;

        // Character↔lorebook scoping (ADR-0047 waiver 2): the legacy plane
        // records the owner as `lorebooks.metadata.characterId` (Drizzle
        // `json_extract(metadata, '$.characterId')`); convert it into the
        // canonical `character_lorebooks` link. A link to a character that
        // did not survive the conversion is reported as an orphan and the
        // book stays in the shared library (no silent data loss).
        let character_id = metadata.get("characterId").and_then(|v| v.as_str());
        if let Some(character_id) = character_id {
            if character_ids.contains(character_id) {
                tx.execute(
                    "INSERT INTO character_lorebooks (character_id, lorebook_id) VALUES (?1, ?2)",
                    rusqlite::params![character_id, id],
                )
                .map_err(|e| {
                    StorageError::from_sqlite(e, "legacy: insert character_lorebooks link")
                })?;
            } else {
                report.orphans.push(format!(
                    "lorebook {id} references missing character {character_id}"
                ));
            }
        }
    }
    Ok(())
}

fn read_lore_entries(
    legacy: &Connection,
    report: &mut ConversionReport,
) -> Result<HashMap<String, Vec<ExportLoreEntry>>> {
    let cols = column_names(legacy, "lore_entries")?;
    require_columns(
        &cols,
        "lore_entries",
        &["id", "lorebook_id", "content", "created_at", "updated_at"],
    )?;
    let has_position = cols.iter().any(|c| c == "position");
    let selected = select_columns(
        &cols,
        &[
            "id",
            "lorebook_id",
            "keys_json",
            "secondary_keys",
            "content",
            "enabled",
            "position",
            "constant",
            "selective",
            "metadata",
            "created_at",
            "updated_at",
        ],
    );
    let order = if has_position {
        "ORDER BY lorebook_id, position, id"
    } else {
        "ORDER BY lorebook_id, id"
    };
    let sql = format!(
        "SELECT {} FROM lore_entries {order}",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare lore_entries"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query lore_entries"))?;
    let mut by_book: HashMap<String, Vec<ExportLoreEntry>> = HashMap::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read lore_entries"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "lore entry: missing id");
            continue;
        };
        let Some(book_id) = as_text(get("lorebook_id")).map(str::to_owned) else {
            skip(
                report,
                &format!("lore entry {id}: missing lorebook reference"),
            );
            continue;
        };
        let Some(content) = as_text(get("content")).map(str::to_owned) else {
            skip(report, &format!("lore entry {id}: missing content"));
            continue;
        };
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("lore entry {id}: invalid created_at"));
            continue;
        };
        let Some(updated_at) = ms_to_rfc3339_checked(get("updated_at")) else {
            skip(report, &format!("lore entry {id}: invalid updated_at"));
            continue;
        };
        by_book.entry(book_id).or_default().push(ExportLoreEntry {
            id: id.to_string(),
            keys: parse_json_array(get("keys_json")),
            secondary_keys: parse_json_array(get("secondary_keys")),
            content,
            enabled: as_i64(get("enabled")).map(|v| v != 0).unwrap_or(true),
            position: as_i64(get("position")).unwrap_or(0),
            constant: as_i64(get("constant")).map(|v| v != 0).unwrap_or(false),
            selective: as_i64(get("selective")).map(|v| v != 0).unwrap_or(false),
            metadata: parse_json(get("metadata")),
            created_at,
            updated_at,
        });
    }
    Ok(by_book)
}

fn convert_presets(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    report: &mut ConversionReport,
) -> Result<()> {
    let cols = column_names(legacy, "presets")?;
    require_columns(
        &cols,
        "presets",
        &["id", "name", "created_at", "updated_at"],
    )?;
    let selected = select_columns(
        &cols,
        &["id", "kind", "name", "data", "created_at", "updated_at"],
    );
    let sql = format!(
        "SELECT {} FROM presets ORDER BY id",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare presets"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query presets"))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read presets"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "preset: missing id");
            continue;
        };
        let Some(name) = as_text(get("name")) else {
            skip(report, &format!("preset {id}: missing name"));
            continue;
        };
        // The legacy `kind` column (tables.ts, `NOT NULL`) maps 1:1; rows
        // whose kind would fail the wire `^[a-z0-9][a-z0-9-]*$` pattern are
        // skipped (the kernel select-back validation would reject them).
        let Some(kind) = as_text(get("kind")) else {
            skip(report, &format!("preset {id}: missing kind"));
            continue;
        };
        if !is_valid_preset_kind(kind) {
            skip(report, &format!("preset {id}: invalid kind {kind:?}"));
            continue;
        }
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("preset {id}: invalid created_at"));
            continue;
        };
        let Some(updated_at) = ms_to_rfc3339_checked(get("updated_at")) else {
            skip(report, &format!("preset {id}: invalid updated_at"));
            continue;
        };
        let settings = parse_json(get("data"));
        tx.execute(
            "INSERT INTO presets (id, kind, name, settings_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                id,
                kind,
                name,
                serde_json::to_string(&settings).unwrap_or_else(|_| "{}".to_string()),
                created_at,
                updated_at,
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert preset"))?;
        report.presets += 1;
    }
    Ok(())
}

/// The wire `preset.kind` pattern: `^[a-z0-9][a-z0-9-]*$`.
fn is_valid_preset_kind(kind: &str) -> bool {
    let mut chars = kind.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Maps the legacy `memories` table into the kernel `memories` table
/// (Этап 4 slice 3, ТЗ §4.4 Memory/RAG). The legacy table is optional
/// (FTS-backed, migration 0006); a source without it contributes 0 rows.
/// `keys_json`/`metadata` (JSON text) map 1:1 to `keys_json`/`metadata_json`;
/// INTEGER epoch-ms timestamps become RFC 3339. `character_id` is preserved
/// verbatim — the kernel table has no FK, so an orphaned reference from a
/// partially converted source survives instead of dropping user data.
fn convert_memories(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    report: &mut ConversionReport,
) -> Result<()> {
    if !table_exists(legacy, "memories")? {
        return Ok(());
    }
    let cols = column_names(legacy, "memories")?;
    require_columns(
        &cols,
        "memories",
        &["id", "content", "created_at", "updated_at"],
    )?;
    let selected = select_columns(
        &cols,
        &[
            "id",
            "scope",
            "character_id",
            "keys_json",
            "content",
            "enabled",
            "position",
            "metadata",
            "created_at",
            "updated_at",
        ],
    );
    let sql = format!(
        "SELECT {} FROM memories ORDER BY id",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare memories"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query memories"))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read memories"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "memory: missing id");
            continue;
        };
        let Some(content) = as_text(get("content")) else {
            skip(report, &format!("memory {id}: missing content"));
            continue;
        };
        // scope defaults to 'global' in the legacy DDL; anything outside the
        // kernel CHECK is skipped rather than stored as garbage.
        let scope = match as_text(get("scope")).unwrap_or("global") {
            "global" => "global",
            "character" => "character",
            other => {
                skip(report, &format!("memory {id}: invalid scope {other:?}"));
                continue;
            }
        };
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("memory {id}: invalid created_at"));
            continue;
        };
        let Some(updated_at) = ms_to_rfc3339_checked(get("updated_at")) else {
            skip(report, &format!("memory {id}: invalid updated_at"));
            continue;
        };
        let keys = parse_json(get("keys_json"));
        let keys_text = if keys.is_array() {
            serde_json::to_string(&keys).unwrap_or_else(|_| "[]".to_string())
        } else {
            "[]".to_string()
        };
        let metadata = parse_json(get("metadata"));
        let enabled = as_i64(get("enabled")).unwrap_or(1);
        let position = as_i64(get("position")).unwrap_or(0);
        let character_id = as_text(get("character_id"));
        tx.execute(
            "INSERT INTO memories (id, scope, character_id, keys_json, content, enabled, position, \
             metadata_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                id,
                scope,
                character_id,
                keys_text,
                content,
                enabled,
                position,
                serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_string()),
                created_at,
                updated_at,
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert memory"))?;
        report.memories += 1;
    }
    Ok(())
}

/// Maps the legacy `personas` table into the kernel `personas` table
/// (Этап 4.1, ТЗ §8.1). The legacy table is optional; a source without it
/// contributes 0 rows. `is_default` maps from the legacy boolean column
/// (default 0); if a source declares multiple defaults, the first (ordered
/// by id) keeps the flag and the others are stored as non-default so the
/// kernel's single-default invariant holds.
fn convert_personas(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    report: &mut ConversionReport,
) -> Result<()> {
    if !table_exists(legacy, "personas")? {
        return Ok(());
    }
    let cols = column_names(legacy, "personas")?;
    require_columns(
        &cols,
        "personas",
        &["id", "name", "created_at", "updated_at"],
    )?;
    let selected = select_columns(
        &cols,
        &[
            "id",
            "name",
            "description",
            "avatar",
            "is_default",
            "created_at",
            "updated_at",
        ],
    );
    let sql = format!(
        "SELECT {} FROM personas ORDER BY id",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare personas"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query personas"))?;
    let mut default_assigned = false;
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read personas"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(id) = as_text(get("id")) else {
            skip(report, "persona: missing id");
            continue;
        };
        let Some(name) = as_text(get("name")) else {
            skip(report, &format!("persona {id}: missing name"));
            continue;
        };
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("persona {id}: invalid created_at"));
            continue;
        };
        let Some(updated_at) = ms_to_rfc3339_checked(get("updated_at")) else {
            skip(report, &format!("persona {id}: invalid updated_at"));
            continue;
        };
        // Legacy stores the flag as a Drizzle boolean (0/1 integer). Only the
        // first declared default keeps the flag (single-default invariant).
        let legacy_default = as_i64(get("is_default")).unwrap_or(0) != 0;
        let is_default = legacy_default && !default_assigned;
        if legacy_default {
            default_assigned = true;
        }
        tx.execute(
            "INSERT INTO personas (id, name, description, avatar, is_default, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                id,
                name,
                as_text(get("description")).unwrap_or("").to_string(),
                as_text(get("avatar")).map(|s| s.to_string()),
                i64::from(is_default),
                created_at,
                updated_at,
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert persona"))?;
        report.personas += 1;
    }
    Ok(())
}

/// Maps the legacy `settings` table into the kernel `settings` table
/// (ADR-0046 waiver 8, settings part; ТЗ §8.1 Configuration). The legacy
/// table is optional (`packages/db` introduced it as `key → value` JSON
/// text); a source without it contributes 0 rows.
///
/// Legacy `value` is already JSON text and is copied verbatim as the kernel
/// `value_json`; a non-JSON legacy value is preserved as a JSON string so no
/// setting is silently dropped (fail-closed, ТЗ §10.3 "unknown metadata
/// сохраняются"). The legacy table has no `updated_at` column, so the kernel
/// row takes the conversion timestamp. Secret material never lives in either
/// settings table (ТЗ §9.4, SEC-01) — this converts non-secret settings only.
fn convert_settings(
    legacy: &Connection,
    tx: &rusqlite::Transaction,
    report: &mut ConversionReport,
) -> Result<()> {
    if !table_exists(legacy, "settings")? {
        return Ok(());
    }
    let cols = column_names(legacy, "settings")?;
    require_columns(&cols, "settings", &["key", "value"])?;
    let selected = select_columns(&cols, &["key", "value"]);
    let sql = format!(
        "SELECT {} FROM settings ORDER BY key",
        quote_columns(&selected)
    );
    let mut stmt = legacy
        .prepare(&sql)
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare settings"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query settings"))?;
    let mut inserted = 0u64;
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read settings"))?
    {
        let vals = read_values(&selected, row)?;
        let get = |name: &str| selected.iter().position(|c| *c == name).map(|i| &vals[i]);
        let Some(key) = as_text(get("key")) else {
            skip(report, "setting: missing key");
            continue;
        };
        // AppSettings-style legacy keys are camelCase (`maxContextTokens`),
        // which is NOT a valid wire key (`^[a-z][a-z0-9._-]{1,127}$`).
        // Normalize to kebab form so the canonical store stays readable over
        // `settings.get`; keys that still fail the wire pattern are skipped
        // fail-closed (reported, never silently dropped as data loss — the
        // report carries the reason).
        let key = normalize_setting_key(key);
        if !is_valid_setting_key(&key) {
            skip(report, &format!("setting: key {key:?} is not wire-valid"));
            continue;
        }
        let raw = as_text(get("value")).unwrap_or("null");
        let value_json = match serde_json::from_str::<serde_json::Value>(raw) {
            Ok(_) => raw.to_string(),
            Err(_) => serde_json::to_string(raw).map_err(|e| {
                StorageError::with(
                    StorageErrorCode::IntegrityViolation,
                    format!("legacy: serialize non-JSON setting {key:?}: {e}"),
                    vec![],
                )
            })?,
        };
        tx.execute(
            "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![key, value_json, crate::now_utc_rfc3339()],
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy: insert setting"))?;
        inserted += 1;
    }
    report.settings = inserted;
    Ok(())
}

/// Matches the wire `settings` key pattern `^[a-z][a-z0-9._-]{1,127}$`
/// (no regex dependency — a character loop over a small key is cheaper).
fn is_valid_setting_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    let mut len = 1usize;
    for ch in chars {
        len += 1;
        if len > 128 {
            return false;
        }
        if !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-')) {
            return false;
        }
    }
    true
}

/// Normalizes a legacy settings key onto the wire-valid form: already-valid
/// keys pass through unchanged; camelCase keys (`maxContextTokens`,
/// `extensions.legacyFrontend`) become kebab form (`max-context-tokens`,
/// `extensions.legacy-frontend`) so `settings.get` never hits a
/// wire-invalid key in the canonical store.
fn normalize_setting_key(key: &str) -> String {
    if is_valid_setting_key(key) {
        return key.to_string();
    }
    let mut out = String::with_capacity(key.len() + 8);
    let mut prev_was_lower_or_digit = false;
    for (i, ch) in key.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            // A boundary hyphen is inserted only between camel segments
            // (after a lower-case letter or digit), never at the start and
            // never after a separator/dot.
            if i > 0 && prev_was_lower_or_digit {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
            prev_was_lower_or_digit = false;
        } else {
            out.push(ch);
            prev_was_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        }
    }
    out
}

// --- helpers ----------------------------------------------------------------

/// Records a skipped row in the report.
fn skip(report: &mut ConversionReport, why: &str) {
    report.skipped += 1;
    report.orphans.push(why.to_string());
}

/// True when `name` is a table in `conn`.
fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let found = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: probe table"))?;
    Ok(found.is_some())
}

/// Column names of `table` via `PRAGMA table_info`.
fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| StorageError::from_sqlite(e, "legacy: prepare table_info"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| StorageError::from_sqlite(e, "legacy: query table_info"))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: read table_info"))?;
    Ok(names)
}

/// Every one of `required` must exist; a missing required column means the
/// source is outside the documented legacy schema window.
fn require_columns(cols: &[String], table: &str, required: &[&str]) -> Result<()> {
    for name in required {
        if !cols.iter().any(|c| c.as_str() == *name) {
            return Err(incompatible(&format!(
                "{table} table is missing required column {name}"
            )));
        }
    }
    Ok(())
}

/// The subset of `wanted` present in `cols`, preserving `wanted` order.
fn select_columns<'a>(cols: &[String], wanted: &'a [&str]) -> Vec<&'a str> {
    wanted
        .iter()
        .copied()
        .filter(|c| cols.iter().any(|col| col.as_str() == *c))
        .collect()
}

/// Quoted, comma-joined column list for a SELECT.
fn quote_columns(columns: &[&str]) -> String {
    columns
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Reads every selected column of `row` as a [`rusqlite::types::Value`].
fn read_values(selected: &[&str], row: &rusqlite::Row<'_>) -> Result<Vec<rusqlite::types::Value>> {
    let mut values = Vec::with_capacity(selected.len());
    for index in 0..selected.len() {
        values.push(
            row.get::<_, rusqlite::types::Value>(index)
                .map_err(|e| StorageError::from_sqlite(e, "legacy: read column value"))?,
        );
    }
    Ok(values)
}

fn as_text(value: Option<&rusqlite::types::Value>) -> Option<&str> {
    match value {
        Some(rusqlite::types::Value::Text(text)) => Some(text),
        _ => None,
    }
}

fn as_i64(value: Option<&rusqlite::types::Value>) -> Option<i64> {
    match value {
        Some(rusqlite::types::Value::Integer(i)) => Some(*i),
        _ => None,
    }
}

/// Parses an optional JSON array column; missing or unparseable → `[]`.
fn parse_json_array(value: Option<&rusqlite::types::Value>) -> Vec<String> {
    match as_text(value) {
        Some(text) => serde_json::from_str::<Vec<String>>(text).unwrap_or_default(),
        None => Vec::new(),
    }
}

/// Parses an optional JSON object column; missing or unparseable → `{}`.
fn parse_json(value: Option<&rusqlite::types::Value>) -> serde_json::Value {
    match as_text(value) {
        Some(text) => serde_json::from_str(text).unwrap_or_else(|_| serde_json::json!({})),
        None => serde_json::json!({}),
    }
}

/// Legacy epoch-millis timestamp → RFC 3339; `None` for missing, non-integer
/// or out-of-range values (the row is then skipped and reported).
fn ms_to_rfc3339_checked(value: Option<&rusqlite::types::Value>) -> Option<String> {
    let ms = as_i64(value)?;
    ms_to_rfc3339(ms)
}

/// Converts epoch millis to an RFC 3339 UTC timestamp; `None` when the value
/// is outside the `time` crate's supported range.
fn ms_to_rfc3339(ms: i64) -> Option<String> {
    use time::format_description::well_known::Rfc3339;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()?;
    dt.format(&Rfc3339).ok()
}

/// A controlled `UnsupportedStorageFormat` error for a non-legacy source.
fn incompatible(why: &str) -> StorageError {
    StorageError::with(
        StorageErrorCode::UnsupportedStorageFormat,
        format!("not a supported legacy data root: {why}"),
        vec![],
    )
}
