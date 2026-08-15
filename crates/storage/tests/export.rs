//! Integration tests for portable export/import
//! (`neotavern_storage::export`): create → verify → import round-trip,
//! idempotent re-import under `Reject`, orphan reporting, the
//! `Replace`/`Remap` policies, and rejection of corrupted containers
//! (tampered checksum, traversal path, unknown format version).

use neotavern_storage::assets::publish_asset;
use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::export::{apply_import, create_export, verify_export, DuplicatePolicy};
use neotavern_storage::migrations::MigrationProgress;
use neotavern_storage::open::{open, Database};
use neotavern_storage::{StorageError, StorageErrorCode};

fn seed_kernel_db(db: &mut Database) -> Result<(), Box<dyn std::error::Error>> {
    publish_asset(db, "ast1", "image", "avatar.png", b"\x89PNG-fake-avatar")?;
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                "char-1",
                "Alice",
                "A test character",
                "ast1",
                r#"["main","protagonist"]"#,
                r#"{"source":"seed"}"#,
                "2026-01-01T00:00:00Z",
                "2026-01-02T00:00:00Z",
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed characters"))?;
        tx.execute(
            "INSERT INTO characters (id, name, description, tags_json, created_at, updated_at) \
             VALUES ('char-2', 'Bob', NULL, '[]', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed character 2"))?;
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
             VALUES ('chat-1', 'First chat', 'char-1', '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed chat 1"))?;
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
             VALUES ('chat-2', 'Second chat', 'char-2', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed chat 2"))?;
        for (id, chat, role, content, seq, created) in [
            ("msg-1", "chat-1", "user", "Hello", 0, "2026-01-06T00:00:00Z"),
            ("msg-2", "chat-1", "assistant", "Hi there", 1, "2026-01-06T00:00:01Z"),
            ("msg-3", "chat-2", "system", "Setup", 0, "2026-01-07T00:00:00Z"),
        ] {
            tx.execute(
                "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, chat, role, content, seq, created],
            )
            .map_err(|e| StorageError::from_sqlite(e, "seed messages"))?;
        }
        tx.execute(
            "INSERT INTO lorebooks (id, name, description, entries_json, created_at, updated_at) \
             VALUES ('lb-1', 'Sword lore', 'Lore about swords', \
                     '[{\"id\":\"e1\",\"keys\":[\"sword\"],\"content\":\"A sharp sword.\",\"createdAt\":\"2026-01-08T00:00:00Z\",\"updatedAt\":\"2026-01-08T00:00:00Z\"}]', \
                     '2026-01-08T00:00:00Z', '2026-01-08T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed lorebook 1"))?;
        tx.execute(
            "INSERT INTO lorebooks (id, name, created_at, updated_at) \
             VALUES ('lb-2', 'Empty book', '2026-01-09T00:00:00Z', '2026-01-09T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed lorebook 2"))?;
        tx.execute(
            "INSERT INTO presets (id, name, settings_json, created_at, updated_at) \
             VALUES ('preset-1', 'Preset A', '{\"temp\":0.7}', '2026-01-10T00:00:00Z', '2026-01-10T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed preset"))?;
        Ok(())
    })?;
    Ok(())
}

fn open_root(root: &std::path::Path) -> Result<Database, Box<dyn std::error::Error>> {
    let mut noop: Box<dyn FnMut(MigrationProgress)> = Box::new(|_| {});
    Ok(open(root, &ConnectionPolicy::default(), &mut noop)?)
}

fn count_rows(db: &Database, table: &str) -> Result<i64, Box<dyn std::error::Error>> {
    Ok(db
        .conn()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?)
}

#[test]
fn export_verify_import_round_trip_and_idempotent_reimport(
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root_a = dir.path().join("a");
    let mut db_a = open_root(&root_a)?;
    seed_kernel_db(&mut db_a)?;

    let dest = dir.path().join("export");
    let report = create_export(&db_a, &dest, true)?;
    assert_eq!(report.counts.characters, 2);
    assert_eq!(report.counts.chats, 2);
    assert_eq!(report.counts.messages, 3);
    assert_eq!(report.counts.lorebooks, 2);
    assert_eq!(report.counts.presets, 1);
    assert_eq!(report.assets, 1, "one referenced asset is copied");
    assert!(report.size_bytes > 0, "export must carry payload bytes");
    assert!(!report.created_at.is_empty());

    let verified = verify_export(&dest)?;
    assert_eq!(verified.format_version, 1);
    assert_eq!(verified.records, report.counts);
    assert_eq!(verified.size_bytes, report.size_bytes);

    // Import into a fresh root B.
    let root_b = dir.path().join("b");
    let mut db_b = open_root(&root_b)?;
    let imported = apply_import(&dest, &mut db_b, DuplicatePolicy::Reject)?;
    assert_eq!(imported.inserted, 10, "all records inserted");
    assert_eq!(imported.updated, 0);
    assert_eq!(imported.skipped, 0);
    assert!(imported.orphans.is_empty());

    // Counts equal.
    for (table, expected) in [
        ("characters", 2),
        ("chats", 2),
        ("messages", 3),
        ("lorebooks", 2),
        ("presets", 1),
    ] {
        assert_eq!(count_rows(&db_b, table)?, expected, "{table} count");
    }

    // Field fidelity.
    let (avatar, tags, ext, created): (Option<String>, String, String, String) = db_b
        .conn()
        .query_row(
            "SELECT avatar_asset_id, tags_json, ext_json, created_at FROM characters WHERE id = 'char-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    assert_eq!(avatar.as_deref(), Some("ast1"), "avatarAssetId preserved");
    assert_eq!(tags, r#"["main","protagonist"]"#);
    assert_eq!(ext, r#"{"source":"seed"}"#);
    assert_eq!(created, "2026-01-01T00:00:00Z");
    let chat_character: String = db_b.conn().query_row(
        "SELECT character_id FROM chats WHERE id = 'chat-1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(chat_character, "char-1");
    let (role, seq): (String, i64) = db_b.conn().query_row(
        "SELECT role, sequence FROM messages WHERE id = 'msg-2'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(role, "assistant");
    assert_eq!(seq, 1);
    let entries: String = db_b.conn().query_row(
        "SELECT entries_json FROM lorebooks WHERE id = 'lb-1'",
        [],
        |r| r.get(0),
    )?;
    assert!(entries.contains("sword"), "entries_json: {entries}");
    let settings: String = db_b.conn().query_row(
        "SELECT settings_json FROM presets WHERE id = 'preset-1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(settings, r#"{"temp":0.7}"#);

    // Re-import under Reject adds nothing.
    let again = apply_import(&dest, &mut db_b, DuplicatePolicy::Reject)?;
    assert_eq!(again.inserted, 0, "re-import under Reject inserts nothing");
    assert_eq!(again.updated, 0);
    assert_eq!(again.skipped, 10);
    assert!(again.orphans.is_empty());
    assert_eq!(count_rows(&db_b, "characters")?, 2);

    // Data-only export (include_assets = false): same records, no assets.
    let dest_no_assets = dir.path().join("export-no-assets");
    let report_no_assets = create_export(&db_a, &dest_no_assets, false)?;
    assert_eq!(report_no_assets.counts, report.counts, "records unaffected");
    assert_eq!(report_no_assets.assets, 0, "no asset bytes when skipped");
    assert!(!dest_no_assets.join("assets").exists(), "assets dir absent");
    let verified_no_assets = verify_export(&dest_no_assets)?;
    assert_eq!(verified_no_assets.records, report.counts);
    assert_eq!(verified_no_assets.size_bytes, report_no_assets.size_bytes);

    // Import into a non-empty destination is refused before any write.
    let dest2 = dir.path().join("export2");
    std::fs::create_dir_all(&dest2)?;
    std::fs::write(dest2.join("stray.txt"), b"x")?;
    let err = create_export(&db_a, &dest2, true).unwrap_err();
    assert_eq!(err.code, StorageErrorCode::Conflict);
    Ok(())
}

#[test]
fn tampered_checksum_traversal_and_unknown_version_rejected(
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("root");
    let mut db = open_root(&root)?;
    seed_kernel_db(&mut db)?;
    let dest = dir.path().join("export");
    create_export(&db, &dest, true)?;

    // 1. Tampered payload byte → inventory checksum mismatch at verify.
    let chars_path = dest.join("characters.ndjson");
    let mut bytes = std::fs::read(&chars_path)?;
    bytes[0] ^= 0xFF;
    std::fs::write(&chars_path, &bytes)?;
    let err = verify_export(&dest).unwrap_err();
    assert_eq!(err.code, StorageErrorCode::Corrupt, "tampered file: {err}");
    assert!(err.message.contains("checksum"), "message: {}", err.message);

    // apply_import must also reject the corrupted container before writing.
    let root_b = dir.path().join("b");
    let mut db_b = open_root(&root_b)?;
    let err = apply_import(&dest, &mut db_b, DuplicatePolicy::Reject).unwrap_err();
    assert_eq!(
        err.code,
        StorageErrorCode::Corrupt,
        "apply_import on tampered: {err}"
    );
    assert_eq!(
        count_rows(&db_b, "characters")?,
        0,
        "no write before verification"
    );

    // Restore the payload and craft a manifest with a traversal path.
    let manifest_path = dest.join("manifest.json");
    let mut manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
    manifest["inventory"] = serde_json::json!([{
        "logicalPath": "../evil",
        "size": 0,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    }]);
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
    let err = verify_export(&dest).unwrap_err();
    assert_eq!(err.code, StorageErrorCode::Corrupt, "traversal: {err}");
    assert!(
        err.message.contains("logicalPath"),
        "message: {}",
        err.message
    );

    // Unknown required section (formatVersion > 1) → controlled Incompatible.
    manifest["formatVersion"] = serde_json::json!(2);
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
    let err = verify_export(&dest).unwrap_err();
    assert_eq!(
        err.code,
        StorageErrorCode::UnsupportedStorageFormat,
        "future version: {err}"
    );

    // Foreign format name → Incompatible as well.
    manifest["formatVersion"] = serde_json::json!(1);
    manifest["exportFormat"] = serde_json::json!("someone-elses-export");
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
    let err = verify_export(&dest).unwrap_err();
    assert_eq!(
        err.code,
        StorageErrorCode::UnsupportedStorageFormat,
        "foreign format: {err}"
    );
    Ok(())
}

#[test]
fn import_reports_orphans_and_applies_policies() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("root");
    let mut db = open_root(&root)?;
    seed_kernel_db(&mut db)?;

    // Insert referential orphans with FK enforcement off (the kernel schema
    // forbids them, but the export must survive and import must report them).
    db.conn().execute_batch("PRAGMA foreign_keys = OFF")?;
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
             VALUES ('chat-orphan', 'Orphan', 'missing-char', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed orphan chat"))?;
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) \
             VALUES ('msg-orphan', 'missing-chat', 'user', 'dangling', 0, '2026-02-02T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed orphan message"))?;
        Ok(())
    })?;
    db.conn().execute_batch("PRAGMA foreign_keys = ON")?;

    let dest = dir.path().join("export");
    create_export(&db, &dest, true)?;
    let verified = verify_export(&dest)?;
    assert_eq!(verified.records.chats, 3);
    assert_eq!(verified.records.messages, 4);

    // Reject: orphans skipped + reported, everything else inserted.
    let root_b = dir.path().join("b");
    let mut db_b = open_root(&root_b)?;
    let imported = apply_import(&dest, &mut db_b, DuplicatePolicy::Reject)?;
    assert_eq!(imported.inserted, 10, "orphans are excluded from inserts");
    assert_eq!(imported.updated, 0);
    assert_eq!(imported.skipped, 2);
    assert_eq!(imported.orphans.len(), 2);
    assert!(
        imported.orphans.iter().any(|o| o.contains("chat-orphan")),
        "{:?}",
        imported.orphans
    );
    assert!(
        imported.orphans.iter().any(|o| o.contains("msg-orphan")),
        "{:?}",
        imported.orphans
    );
    assert_eq!(count_rows(&db_b, "chats")?, 2);
    assert_eq!(count_rows(&db_b, "messages")?, 3);

    // Replace: an existing id is updated in place.
    let root_c = dir.path().join("c");
    let mut db_c = open_root(&root_c)?;
    db_c.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, tags_json, created_at, updated_at) \
             VALUES ('char-1', 'Old Name', NULL, '[]', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed replacement target"))?;
        Ok(())
    })?;
    let replaced = apply_import(&dest, &mut db_c, DuplicatePolicy::Replace)?;
    assert!(replaced.updated >= 1, "existing character updated");
    let name: String =
        db_c.conn()
            .query_row("SELECT name FROM characters WHERE id = 'char-1'", [], |r| {
                r.get(0)
            })?;
    assert_eq!(name, "Alice", "Replace policy overwrote the row");

    // Remap: every record gets a fresh id; child references remapped.
    let root_d = dir.path().join("d");
    let mut db_d = open_root(&root_d)?;
    let remapped = apply_import(&dest, &mut db_d, DuplicatePolicy::Remap)?;
    assert_eq!(remapped.inserted, 10);
    assert_eq!(remapped.updated, 0);
    assert_eq!(remapped.skipped, 2, "orphans skipped under Remap too");
    let source_id_count: i64 = db_d.conn().query_row(
        "SELECT COUNT(*) FROM characters WHERE id IN ('char-1', 'char-2')",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(source_id_count, 0, "no source ids survive under Remap");
    let dangling_chats: i64 = db_d
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM chats c LEFT JOIN characters ch ON c.character_id = ch.id WHERE ch.id IS NULL",
            [],
            |r| r.get(0),
        )?;
    assert_eq!(
        dangling_chats, 0,
        "chat references remapped to new character ids"
    );
    let dangling_messages: i64 = db_d.conn().query_row(
        "SELECT COUNT(*) FROM messages m LEFT JOIN chats c ON m.chat_id = c.id WHERE c.id IS NULL",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(
        dangling_messages, 0,
        "message references remapped to new chat ids"
    );
    Ok(())
}
