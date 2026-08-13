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
    pub lorebooks: u64,
    pub presets: u64,
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

/// Maps all five product tables into `tx` (single transaction). Inserts are
/// ordered characters → chats → messages so foreign keys always resolve.
fn convert(legacy: &Connection, tx: &rusqlite::Transaction) -> Result<ConversionReport> {
    let mut report = ConversionReport {
        characters: 0,
        chats: 0,
        messages: 0,
        lorebooks: 0,
        presets: 0,
        skipped: 0,
        orphans: Vec::new(),
    };
    let character_ids = convert_characters(legacy, tx, &mut report)?;
    let chat_ids = convert_chats(legacy, tx, &character_ids, &mut report)?;
    convert_messages(legacy, tx, &chat_ids, &mut report)?;
    convert_lorebooks(legacy, tx, &mut report)?;
    convert_presets(legacy, tx, &mut report)?;
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
            "created_at",
            "updated_at",
        ],
    );
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
        let tags = parse_json_array(get("tags"));
        let ext = parse_json(get("ext"));
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
        &["id", "title", "character_id", "created_at", "updated_at"],
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
) -> Result<()> {
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
    let selected = select_columns(&cols, &["id", "name", "data", "created_at", "updated_at"]);
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
        let Some(created_at) = ms_to_rfc3339_checked(get("created_at")) else {
            skip(report, &format!("preset {id}: invalid created_at"));
            continue;
        };
        let Some(updated_at) = ms_to_rfc3339_checked(get("updated_at")) else {
            skip(report, &format!("preset {id}: invalid updated_at"));
            continue;
        };
        let settings = parse_json(get("data"));
        // The legacy `kind` column (tables.ts) has no kernel equivalent and
        // is intentionally not copied.
        tx.execute(
            "INSERT INTO presets (id, name, settings_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                id,
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
