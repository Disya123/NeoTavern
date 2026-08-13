//! Integration tests for the legacy converter
//! (`neotavern_storage::legacy`): a rusqlite-built legacy database converts
//! into a staged candidate with mapped rows, referential orphans skipped and
//! reported, provider secrets never copied, and the source file's bytes and
//! mtime unchanged. Kernel/foreign databases are rejected as incompatible.

use std::fs;
use std::path::Path;

use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::legacy::convert_legacy;
use neotavern_storage::migrations::MigrationProgress;
use neotavern_storage::open::open;
use neotavern_storage::restore::stage_candidate;
use neotavern_storage::StorageErrorCode;

/// Builds a legacy Drizzle-schema database (ms epoch timestamps) including a
/// `provider_configs` table carrying a fake API key that must NOT be copied.
fn build_legacy(path: &Path) -> rusqlite::Result<()> {
    let conn = rusqlite::Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE characters (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, avatar TEXT,
            ext TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE chats (
            id TEXT PRIMARY KEY, title TEXT, character_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT, content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE lorebooks (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE lore_entries (
            id TEXT PRIMARY KEY, lorebook_id TEXT NOT NULL, keys_json TEXT, secondary_keys TEXT,
            content TEXT NOT NULL, enabled INTEGER DEFAULT 1, position INTEGER DEFAULT 0,
            constant INTEGER DEFAULT 0, selective INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE presets (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE provider_configs (
            id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, config TEXT, api_key TEXT
        );",
    )?;
    conn.execute(
        "INSERT INTO characters (id, name, description, avatar, ext, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            "leg-c1",
            "Alice",
            "A legacy character",
            "avatar.png",
            r#"{"legacy":true}"#,
            1_700_000_000_000i64,
            1_700_000_001_000i64,
        ],
    )?;
    conn.execute(
        "INSERT INTO characters (id, name, created_at, updated_at) \
         VALUES ('leg-c2', 'Bob', 1700000002000, 1700000003000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
         VALUES ('leg-h1', 'First chat', 'leg-c1', 1700000004000, 1700000005000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
         VALUES ('leg-h2', 'Orphan chat', NULL, 1700000006000, 1700000007000)",
        [],
    )?;
    for (id, chat, role, content, created) in [
        ("leg-m1", "leg-h1", "user", "Hello", 1_700_000_008_000i64),
        ("leg-m2", "leg-h1", "assistant", "Hi!", 1_700_000_009_000i64),
        (
            "leg-m3",
            "leg-h1",
            "plugin",
            "Tool result",
            1_700_000_010_000i64,
        ),
        (
            "leg-m4",
            "leg-h2",
            "user",
            "In orphan chat",
            1_700_000_011_000i64,
        ),
    ] {
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, chat, role, content, created],
        )?;
    }
    conn.execute(
        "INSERT INTO lorebooks (id, name, description, created_at, updated_at) \
         VALUES ('leg-l1', 'Sword lore', 'Lore about swords', 1700000012000, 1700000013000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO lorebooks (id, name, created_at, updated_at) \
         VALUES ('leg-l2', 'Empty', 1700000014000, 1700000015000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO lore_entries (id, lorebook_id, keys_json, secondary_keys, content, enabled, \
         position, constant, selective, metadata, created_at, updated_at) \
         VALUES (?1, 'leg-l1', ?2, ?3, ?4, 1, 0, 0, 0, '{}', 1700000016000, 1700000017000)",
        rusqlite::params!["leg-e1", r#"["sword"]"#, "[]", "A sharp sword."],
    )?;
    conn.execute(
        "INSERT INTO presets (id, kind, name, data, created_at, updated_at) \
         VALUES ('leg-p1', 'default', 'Preset A', '{\"temp\":0.7}', 1700000018000, 1700000019000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO provider_configs (id, provider, name, config, api_key) \
         VALUES ('pc1', 'openai', 'default', '{}', 'sk-fake-api-key-123')",
        [],
    )?;
    Ok(())
}

fn open_candidate(
    candidate: &neotavern_storage::restore::Candidate,
) -> Result<neotavern_storage::open::Database, Box<dyn std::error::Error>> {
    let mut noop: Box<dyn FnMut(MigrationProgress)> = Box::new(|_| {});
    Ok(open(
        &candidate.path,
        &ConnectionPolicy::default(),
        &mut noop,
    )?)
}

#[test]
fn legacy_conversion_maps_rows_skips_orphans_and_never_copies_secrets(
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let legacy_path = dir.path().join("legacy.db");
    build_legacy(&legacy_path)?;
    let original_bytes = fs::read(&legacy_path)?;
    let original_mtime = fs::metadata(&legacy_path)?.modified()?;

    let target_root = dir.path().join("root");
    let candidate = stage_candidate(&target_root)?;
    let report = convert_legacy(&legacy_path, &candidate)?;
    assert_eq!(report.characters, 2);
    assert_eq!(report.chats, 1);
    assert_eq!(report.messages, 3);
    assert_eq!(report.lorebooks, 2);
    assert_eq!(report.presets, 1);
    assert_eq!(report.skipped, 2, "orphan chat + orphan message");
    assert_eq!(report.orphans.len(), 2);

    // The source file is byte- and mtime-identical (opened strictly read-only).
    assert_eq!(
        fs::read(&legacy_path)?,
        original_bytes,
        "source bytes unchanged"
    );
    assert_eq!(
        fs::metadata(&legacy_path)?.modified()?,
        original_mtime,
        "source mtime unchanged"
    );

    // The candidate opens as a full kernel database with the mapped rows.
    let db = open_candidate(&candidate)?;
    for (table, expected) in [
        ("characters", 2),
        ("chats", 1),
        ("messages", 3),
        ("lorebooks", 2),
        ("presets", 1),
    ] {
        let count: i64 =
            db.conn()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        assert_eq!(count, expected, "{table} count");
    }

    // Character mapping: ext preserved, ms timestamps → RFC 3339, avatar skipped.
    let (ext, created, updated): (String, String, String) = db.conn().query_row(
        "SELECT ext_json, created_at, updated_at FROM characters WHERE id = 'leg-c1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(ext, r#"{"legacy":true}"#);
    assert_eq!(
        created, "2023-11-14T22:13:20Z",
        "1700000000000 ms maps correctly"
    );
    assert_eq!(updated, "2023-11-14T22:13:21Z");
    let tags: String = db.conn().query_row(
        "SELECT tags_json FROM characters WHERE id = 'leg-c2'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(tags, "[]", "no legacy tags column → default");

    // Chat mapping: character reference preserved; orphan chat skipped.
    let (character_id, title): (String, String) = db.conn().query_row(
        "SELECT character_id, title FROM chats WHERE id = 'leg-h1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(character_id, "leg-c1");
    assert_eq!(title, "First chat");

    // Messages: no legacy sequence column → per-chat row numbers ordered by
    // created_at; plugin role mapped to the kernel-legal "user".
    let rows: Vec<(String, String, i64)> = {
        let mut stmt = db.conn().prepare(
            "SELECT id, role, sequence FROM messages WHERE chat_id = 'leg-h1' ORDER BY sequence",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    assert_eq!(
        rows,
        vec![
            ("leg-m1".to_string(), "user".to_string(), 0),
            ("leg-m2".to_string(), "assistant".to_string(), 1),
            ("leg-m3".to_string(), "user".to_string(), 2),
        ],
        "sequence derived per chat; plugin role → user"
    );

    // Lorebook entries mapped into entries_json.
    let entries: String = db.conn().query_row(
        "SELECT entries_json FROM lorebooks WHERE id = 'leg-l1'",
        [],
        |r| r.get(0),
    )?;
    let parsed: serde_json::Value = serde_json::from_str(&entries)?;
    assert_eq!(
        parsed.as_array().map(|a| a.len()),
        Some(1),
        "entries_json: {entries}"
    );
    assert_eq!(parsed[0]["keys"], serde_json::json!(["sword"]));
    assert_eq!(parsed[0]["content"], "A sharp sword.");
    let empty: String = db.conn().query_row(
        "SELECT entries_json FROM lorebooks WHERE id = 'leg-l2'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(empty, "[]");

    // Presets: legacy data → settings_json; legacy kind is not copied.
    let settings: String = db.conn().query_row(
        "SELECT settings_json FROM presets WHERE id = 'leg-p1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(settings, r#"{"temp":0.7}"#);

    // Provider secrets are NEVER copied: the v4 schema table exists but is
    // empty (the legacy fake api_key row is absent).
    let secrets: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM provider_configs", [], |r| r.get(0))?;
    assert_eq!(secrets, 0, "provider configs must not be copied");

    // The candidate is a valid kernel data root, ready for the caller to
    // finalize and activate via restore.rs.
    let candidate_version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |r| r.get(0))?;
    assert_eq!(candidate_version, neotavern_storage::CURRENT_SCHEMA);
    Ok(())
}

#[test]
fn legacy_detection_rejects_kernel_and_foreign_databases() -> Result<(), Box<dyn std::error::Error>>
{
    let dir = tempfile::tempdir()?;

    // A kernel data root is not legacy (has __neotavern_meta).
    let kernel_root = dir.path().join("kernel");
    let mut noop: Box<dyn FnMut(MigrationProgress)> = Box::new(|_| {});
    open(&kernel_root, &ConnectionPolicy::default(), &mut noop)?;
    let candidate = stage_candidate(&dir.path().join("target"))?;
    let err = convert_legacy(&kernel_root.join("database.sqlite"), &candidate).unwrap_err();
    assert_eq!(
        err.code,
        StorageErrorCode::UnsupportedStorageFormat,
        "kernel db: {err}"
    );

    // A foreign SQLite database without a characters table is not legacy.
    let foreign = dir.path().join("foreign.db");
    {
        let conn = rusqlite::Connection::open(&foreign)?;
        conn.execute_batch("CREATE TABLE foo (id TEXT PRIMARY KEY)")?;
    }
    let err = convert_legacy(&foreign, &candidate).unwrap_err();
    assert_eq!(
        err.code,
        StorageErrorCode::UnsupportedStorageFormat,
        "foreign db: {err}"
    );

    // A legacy root missing one of the five product tables is incompatible.
    let partial = dir.path().join("partial.db");
    {
        let conn = rusqlite::Connection::open(&partial)?;
        conn.execute_batch(
            "CREATE TABLE characters (id TEXT PRIMARY KEY); CREATE TABLE chats (id TEXT PRIMARY KEY);",
        )?;
    }
    let err = convert_legacy(&partial, &candidate).unwrap_err();
    assert_eq!(
        err.code,
        StorageErrorCode::UnsupportedStorageFormat,
        "partial legacy db: {err}"
    );
    assert!(err.message.contains("messages"), "message: {}", err.message);
    Ok(())
}
