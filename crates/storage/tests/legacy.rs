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
            id TEXT PRIMARY KEY, title TEXT, character_id TEXT, persona_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT, content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE message_variants (
            id TEXT PRIMARY KEY, message_id TEXT NOT NULL, content TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        CREATE TABLE message_content_revisions (
            id TEXT PRIMARY KEY, message_id TEXT NOT NULL, position INTEGER NOT NULL,
            content TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE message_drafts (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '', sequence INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 1, committed_message_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
        CREATE TABLE memories (
            id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'global', character_id TEXT,
            keys_json TEXT NOT NULL DEFAULT '[]', content TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
            metadata TEXT NOT NULL DEFAULT '{}',
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
        "INSERT INTO chats (id, title, character_id, persona_id, created_at, updated_at) \
         VALUES ('leg-h1', 'First chat', 'leg-c1', 'leg-p1', 1700000004000, 1700000005000)",
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
    for (id, message, position, content, created) in [
        ("leg-v1", "leg-m1", 0, "Hello (swipe)", 1_700_000_020_000i64),
        ("leg-v2", "leg-m1", 1, "Hello (swipe 2)", 1_700_000_021_000i64),
        // orphan: leg-m4 sits in the orphan chat and never converts
        ("leg-v3", "leg-m4", 0, "orphan swipe", 1_700_000_022_000i64),
    ] {
        conn.execute(
            "INSERT INTO message_variants (id, message_id, content, position, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, message, content, position, created],
        )?;
    }
    for (id, message, position, content, created) in [
        ("leg-r1", "leg-m2", 0, "Hi!", 1_700_000_023_000i64),
        ("leg-r2", "leg-m4", 0, "orphan revision", 1_700_000_024_000i64),
    ] {
        conn.execute(
            "INSERT INTO message_content_revisions (id, message_id, position, content, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, message, position, content, created],
        )?;
    }
    for (id, chat, role, content, sequence, revision, committed, created, updated) in [
        (
            "leg-d1",
            "leg-h1",
            "assistant",
            "Streaming…",
            0,
            3,
            None::<String>,
            1_700_000_025_000i64,
            1_700_000_026_000i64,
        ),
        // plugin role has no kernel equivalent
        (
            "leg-d2",
            "leg-h1",
            "plugin",
            "x",
            0,
            1,
            None::<String>,
            1_700_000_027_000i64,
            1_700_000_027_000i64,
        ),
        // orphan chat
        (
            "leg-d3",
            "leg-h2",
            "user",
            "y",
            0,
            1,
            None::<String>,
            1_700_000_028_000i64,
            1_700_000_028_000i64,
        ),
        // committed message did not convert — never a dangling outbox ref
        (
            "leg-d4",
            "leg-h1",
            "user",
            "z",
            0,
            1,
            Some("leg-m9".to_string()),
            1_700_000_029_000i64,
            1_700_000_029_000i64,
        ),
        // committed message converted — the outbox reference is preserved
        (
            "leg-d5",
            "leg-h1",
            "user",
            "committed",
            0,
            2,
            Some("leg-m2".to_string()),
            1_700_000_030_000i64,
            1_700_000_031_000i64,
        ),
    ] {
        conn.execute(
            "INSERT INTO message_drafts (id, chat_id, role, content, sequence, revision, \
             committed_message_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                id, chat, role, content, sequence, revision, committed, created, updated
            ],
        )?;
    }
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
    // memories: global + character-scoped (referencing a converted character),
    // a character-scoped memory whose character did NOT convert (the kernel
    // keeps the dangling reference), and an invalid-scope row that must be
    // skipped.
    conn.execute(
        "INSERT INTO memories (id, scope, character_id, keys_json, content, enabled, position, \
         metadata, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            "leg-mem1",
            "global",
            None::<String>,
            r#"["city"]"#,
            "The city sleeps.",
            1,
            0,
            r#"{"source":"manual"}"#,
            1_700_000_040_000i64,
            1_700_000_041_000i64,
        ],
    )?;
    conn.execute(
        "INSERT INTO memories (id, scope, character_id, keys_json, content, enabled, position, \
         metadata, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            "leg-mem2",
            "character",
            "leg-c1",
            r#"["alice","tea"]"#,
            "Alice likes tea.",
            1,
            0,
            "{}",
            1_700_000_042_000i64,
            1_700_000_043_000i64,
        ],
    )?;
    conn.execute(
        "INSERT INTO memories (id, scope, character_id, keys_json, content, enabled, position, \
         metadata, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            "leg-mem3",
            "character",
            "leg-ghost",
            "[]",
            "Ghost memory.",
            1,
            0,
            "{}",
            1_700_000_044_000i64,
            1_700_000_045_000i64,
        ],
    )?;
    conn.execute(
        "INSERT INTO memories (id, scope, keys_json, content, created_at, updated_at) \
         VALUES ('leg-mem4', 'weird', '[]', 'Bad scope.', 1700000046000, 1700000047000)",
        [],
    )?;
    // personas: two rows; both legacy-declared defaults collapse to ONE kernel
    // default (the single-default invariant). leg-h1 references leg-p1.
    conn.execute(
        "CREATE TABLE personas (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, avatar TEXT,
            is_default INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "INSERT INTO personas (id, name, description, is_default, created_at, updated_at) \
         VALUES ('leg-p1', 'Aria', 'The user.', 1, 1700000048000, 1700000049000)",
        [],
    )?;
    conn.execute(
        "INSERT INTO personas (id, name, description, is_default, created_at, updated_at) \
         VALUES ('leg-p2', 'Zoe', 'Second user.', 1, 1700000050000, 1700000051000)",
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
    assert_eq!(report.message_variants, 2, "orphan swipe skipped");
    assert_eq!(
        report.message_content_revisions, 1,
        "orphan revision skipped"
    );
    assert_eq!(
        report.message_drafts, 2,
        "plugin-role, orphan-chat and dangling-commit drafts skipped"
    );
    assert_eq!(report.lorebooks, 2);
    assert_eq!(report.presets, 1);
    assert_eq!(
        report.memories, 3,
        "global + character-scoped + dangling-character memories convert; invalid scope skipped"
    );
    assert_eq!(
        report.personas, 2,
        "both personas convert; only the first legacy default keeps the flag"
    );
    assert_eq!(
        report.skipped, 8,
        "orphan chat + orphan message + orphan swipe + orphan revision + 3 drafts + invalid-scope memory"
    );
    assert_eq!(report.orphans.len(), 8);

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
        ("message_variants", 2),
        ("message_content_revisions", 1),
        ("message_drafts", 2),
        ("lorebooks", 2),
        ("presets", 1),
        ("memories", 3),
        ("personas", 2),
    ] {
        let count: i64 =
            db.conn()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        assert_eq!(count, expected, "{table} count");
    }

    // Swipe variants: positions and RFC 3339 timestamps preserved.
    let (position, content, created): (i64, String, String) = db.conn().query_row(
        "SELECT position, content, created_at FROM message_variants WHERE id = 'leg-v2'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(position, 1);
    assert_eq!(content, "Hello (swipe 2)");
    assert_eq!(created, "2023-11-14T22:13:41Z", "variant ms timestamp maps");

    // Content revisions preserved with their message reference.
    let (message_id, content): (String, String) = db.conn().query_row(
        "SELECT message_id, content FROM message_content_revisions WHERE id = 'leg-r1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(message_id, "leg-m2");
    assert_eq!(content, "Hi!");

    // Drafts: kernel-legal roles only; the committed outbox reference is
    // preserved only when the referenced message converted.
    let (role, revision, committed): (String, i64, Option<String>) = db.conn().query_row(
        "SELECT role, revision, committed_message_id FROM message_drafts WHERE id = 'leg-d1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(role, "assistant");
    assert_eq!(revision, 3);
    assert_eq!(committed, None);
    let (role, committed): (String, Option<String>) = db.conn().query_row(
        "SELECT role, committed_message_id FROM message_drafts WHERE id = 'leg-d5'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(role, "user");
    assert_eq!(committed.as_deref(), Some("leg-m2"));

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

    // Chat mapping: character + persona references preserved; orphan chat skipped.
    let (character_id, persona_id, title): (String, Option<String>, String) = db.conn().query_row(
        "SELECT character_id, persona_id, title FROM chats WHERE id = 'leg-h1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(character_id, "leg-c1");
    assert_eq!(persona_id.as_deref(), Some("leg-p1"), "legacy persona reference maps");
    assert_eq!(title, "First chat");

    // Personas: names/timestamps converted; only ONE default survives the
    // single-default invariant.
    let (name, is_default, created): (String, i64, String) = db.conn().query_row(
        "SELECT name, is_default, created_at FROM personas WHERE id = 'leg-p1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(name, "Aria");
    assert_eq!(is_default, 1);
    assert_eq!(created, "2023-11-14T22:14:08Z", "persona ms timestamp maps");
    let is_default: i64 = db
        .conn()
        .query_row("SELECT is_default FROM personas WHERE id = 'leg-p2'", [], |r| r.get(0))?;
    assert_eq!(is_default, 0, "second legacy default demoted");

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

    // Presets: legacy data → settings_json; legacy kind maps 1:1.
    let (settings, kind): (String, String) = db.conn().query_row(
        "SELECT settings_json, kind FROM presets WHERE id = 'leg-p1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(settings, r#"{"temp":0.7}"#);
    assert_eq!(kind, "default");

    // Memories: scope/keys/content/metadata mapped, timestamps RFC 3339; the
    // dangling character reference of leg-mem3 is preserved (no FK).
    let (scope, character_id, keys, content, created): (String, Option<String>, String, String, String) =
        db.conn().query_row(
            "SELECT scope, character_id, keys_json, content, created_at \
             FROM memories WHERE id = 'leg-mem1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
    assert_eq!(scope, "global");
    assert_eq!(character_id, None);
    assert_eq!(keys, r#"["city"]"#);
    assert_eq!(content, "The city sleeps.");
    assert_eq!(created, "2023-11-14T22:14:00Z", "memory ms timestamp maps");
    let (scope, character_id, keys, metadata): (String, Option<String>, String, String) = db.conn()
        .query_row(
            "SELECT scope, character_id, keys_json, metadata_json \
             FROM memories WHERE id = 'leg-mem1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    assert_eq!(scope, "global");
    assert_eq!(character_id, None);
    assert_eq!(keys, r#"["city"]"#);
    assert_eq!(metadata, r#"{"source":"manual"}"#);
    let (scope, character_id, keys, content): (String, String, String, String) = db.conn()
        .query_row(
            "SELECT scope, character_id, keys_json, content \
             FROM memories WHERE id = 'leg-mem2'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    assert_eq!(scope, "character");
    assert_eq!(character_id, "leg-c1");
    assert_eq!(keys, r#"["alice","tea"]"#);
    assert_eq!(content, "Alice likes tea.");
    let (scope, character_id): (String, Option<String>) = db.conn().query_row(
        "SELECT scope, character_id FROM memories WHERE id = 'leg-mem3'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(scope, "character");
    assert_eq!(character_id.as_deref(), Some("leg-ghost"));

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
