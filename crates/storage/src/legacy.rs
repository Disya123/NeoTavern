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
//!   directly; the legacy `avatar` string is NOT copied (it is not a managed
//!   asset key); an optional `tags` column is read as a JSON array when
//!   present (default `[]`); `created_at`/`updated_at` epoch millis become
//!   RFC 3339.
//! - `chats` → kernel `chats`: `title` defaults to `"New chat"`; chats with
//!   a NULL or unresolvable `character_id` are skipped and reported.
//! - `messages` → kernel `messages`: `role` defaults to `"user"` for missing
//!   or unknown values (legacy `plugin` included), keeping the kernel CHECK
//!   values; `sequence` is taken from the column when present, otherwise
//!   derived as a per-chat row number ordered by `created_at, id`;
//!   messages referencing a skipped or missing chat are skipped and reported.
//! - `lorebooks` → kernel `lorebooks`: entries come from the legacy
//!   `lore_entries` table (when present) and are stored as `entries_json`.
//! - `presets` → kernel `presets`: `data` becomes `settings_json`; the
//!   legacy `kind` column has no kernel equivalent and is not copied.
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
    let report = convert(&legacy, &tx)?;
    tx.commit()
        .map_err(|e| StorageError::from_sqlite(e, "legacy: commit insert transaction"))?;
    Ok(report)
}

/// Maps all product tables into `tx` (single transaction). Inserts are
/// ordered characters → chats → messages → variants/revisions/drafts so
/// foreign keys always resolve.
fn convert(legacy: &Connection, tx: &rusqlite::Transaction) -> Result<ConversionReport> {
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
        skipped: 0,
        orphans: Vec::new(),
    };
    let character_ids = convert_characters(legacy, tx, &mut report)?;
    let chat_ids = convert_chats(legacy, tx, &character_ids, &mut report)?;
    let message_ids = convert_messages(legacy, tx, &chat_ids, &mut report)?;
    convert_message_variants(legacy, tx, &message_ids, &mut report)?;
    convert_content_revisions(legacy, tx, &message_ids, &mut report)?;
    convert_message_drafts(legacy, tx, &chat_ids, &message_ids, &mut report)?;
    convert_lorebooks(legacy, tx, &mut report)?;
    convert_presets(legacy, tx, &mut report)?;
    convert_memories(legacy, tx, &mut report)?;
    convert_personas(legacy, tx, &mut report)?;
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
        // `avatar` is intentionally not copied: legacy avatar strings are
        // not managed asset keys (ТЗ §34: avatar→asset skip).
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
    let selected = select_columns(
        &cols,
        &[
            "id",
            "title",
            "character_id",
            "deleted_at",
            "created_at",
            "updated_at",
        ],
    );
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
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, title, character_id, created_at, updated_at],
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
            skip(report, &format!("message_variant {id}: missing message reference"));
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
            skip(report, &format!("content_revision {id}: missing message reference"));
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
            skip(report, &format!("content_revision {id}: invalid created_at"));
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
            skip(report, &format!("message_draft {id}: missing chat reference"));
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
    report: &mut ConversionReport,
) -> Result<()> {
    let cols = column_names(legacy, "lorebooks")?;
    require_columns(
        &cols,
        "lorebooks",
        &["id", "name", "created_at", "updated_at"],
    )?;
    let selected = select_columns(
        &cols,
        &["id", "name", "description", "created_at", "updated_at"],
    );
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
    let mut books: Vec<(String, String, String, String, String)> = Vec::new();
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
        books.push((
            id.to_string(),
            name.to_string(),
            as_text(get("description")).unwrap_or("").to_string(),
            created_at,
            updated_at,
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

    for (id, name, description, created_at, updated_at) in &books {
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
