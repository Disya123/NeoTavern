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
    let report = create_export(&db_a, &dest, true, None)?;
    assert_eq!(report.counts.characters, 2);
    assert_eq!(report.counts.chats, 2);
    assert_eq!(report.counts.messages, 3);
    assert_eq!(report.counts.lorebooks, 2);
    assert_eq!(report.counts.presets, 1);
    assert_eq!(report.assets, 1, "one referenced asset is copied");
    assert!(report.size_bytes > 0, "export must carry payload bytes");
    assert!(!report.created_at.is_empty());

    let verified = verify_export(&dest)?;
    assert_eq!(verified.format_version, 2, "this build writes format v2");
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
    let report_no_assets = create_export(&db_a, &dest_no_assets, false, None)?;
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
    let err = create_export(&db_a, &dest2, true, None).unwrap_err();
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
    create_export(&db, &dest, true, None)?;

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

    // Unknown required section (formatVersion > EXPORT_FORMAT_VERSION) →
    // controlled Incompatible.
    manifest["formatVersion"] = serde_json::json!(3);
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
    create_export(&db, &dest, true, None)?;
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

#[test]
fn scoped_profile_export_filters_characters_chats_messages_only(
) -> Result<(), Box<dyn std::error::Error>> {
    // SEC-02 waiver 4: a scoped export carries only the profile's characters
    // and, transitively, their chats/messages; lorebooks and presets (the
    // shared library) are always included in full.
    let dir = tempfile::tempdir()?;
    let root_a = dir.path().join("a");
    let mut db_a = open_root(&root_a)?;
    db_a.transaction(|tx| {
        tx.execute(
            "INSERT INTO profiles (id, name, created_at, updated_at) \
             VALUES ('prof-a', 'Profile A', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), \
                    ('prof-b', 'Profile B', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed profiles"))?;
        for (id, name, profile) in [
            ("char-a1", "Alice A", "prof-a"),
            ("char-a2", "Bob A", "prof-a"),
            ("char-b1", "Carol B", "prof-b"),
        ] {
            tx.execute(
                "INSERT INTO characters (id, name, profile_id, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z')",
                rusqlite::params![id, name, profile],
            )
            .map_err(|e| StorageError::from_sqlite(e, "seed scoped characters"))?;
        }
        for (id, character) in [("chat-a1", "char-a1"), ("chat-a2", "char-a2"), ("chat-b1", "char-b1")] {
            tx.execute(
                "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
                 VALUES (?1, 'chat', ?2, '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z')",
                rusqlite::params![id, character],
            )
            .map_err(|e| StorageError::from_sqlite(e, "seed scoped chats"))?;
        }
        for (id, chat) in [("msg-a1", "chat-a1"), ("msg-a2", "chat-a2"), ("msg-b1", "chat-b1")] {
            tx.execute(
                "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) \
                 VALUES (?1, ?2, 'user', 'hi', 0, '2026-01-05T00:00:00Z')",
                rusqlite::params![id, chat],
            )
            .map_err(|e| StorageError::from_sqlite(e, "seed scoped messages"))?;
        }
        tx.execute(
            "INSERT INTO lorebooks (id, name, created_at, updated_at) \
             VALUES ('lb-shared', 'Shared lore', '2026-01-06T00:00:00Z', '2026-01-06T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed shared lorebook"))?;
        tx.execute(
            "INSERT INTO presets (id, name, settings_json, created_at, updated_at) \
             VALUES ('preset-shared', 'Shared preset', '{}', '2026-01-07T00:00:00Z', '2026-01-07T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed shared preset"))?;
        Ok(())
    })?;

    let dest = dir.path().join("scoped");
    let report = create_export(&db_a, &dest, false, Some("prof-a"))?;
    assert_eq!(report.counts.characters, 2, "only profile A characters");
    assert_eq!(report.counts.chats, 2, "only profile A chats");
    assert_eq!(report.counts.messages, 2, "only profile A messages");
    assert_eq!(report.counts.lorebooks, 1, "shared library always included");
    assert_eq!(report.counts.presets, 1, "shared library always included");

    // The manifest records the scope.
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dest.join("manifest.json"))?)?;
    assert_eq!(
        manifest["profileId"], "prof-a",
        "manifest carries the scope"
    );
    let verified = verify_export(&dest)?;
    assert_eq!(verified.records, report.counts, "verified counts match");

    // Import into a fresh root B: profile A exists there? No — so the
    // characters land unassigned and are reported as orphans, never dropped.
    let root_b = dir.path().join("b");
    let mut db_b = open_root(&root_b)?;
    db_b.transaction(|tx| {
        tx.execute(
            "INSERT INTO profiles (id, name, created_at, updated_at) \
             VALUES ('prof-a', 'Profile A', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed target profile"))
    })?;
    let imported = apply_import(&dest, &mut db_b, DuplicatePolicy::Reject)?;
    assert_eq!(
        imported.inserted, 8,
        "2 chars + 2 chats + 2 messages + shared lorebook/preset"
    );
    assert!(imported.orphans.is_empty(), "profile exists → binding kept");

    // Import into a root C WITHOUT the profile: characters become unassigned
    // and reported, data preserved.
    let root_c = dir.path().join("c");
    let mut db_c = open_root(&root_c)?;
    let imported_c = apply_import(&dest, &mut db_c, DuplicatePolicy::Reject)?;
    assert_eq!(
        imported_c.inserted, 8,
        "data never dropped for missing profile"
    );
    assert_eq!(
        imported_c.skipped, 2,
        "the two unassigned characters are the reported orphans"
    );
    assert_eq!(
        imported_c.orphans.len(),
        2,
        "both profile-A characters reported as unassigned"
    );
    let unassigned: i64 = db_c.conn().query_row(
        "SELECT COUNT(*) FROM characters WHERE profile_id IS NULL",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(unassigned, 2, "characters landed unassigned, not dropped");
    Ok(())
}

// ---------------------------------------------------------------------------
// v2 container: new sections + lost columns (audit C4)
// ---------------------------------------------------------------------------

/// Seeds the full v2 surface: persona, persona-bound chat, snapshot child
/// chat, message meta/run/checkpoint columns, variants/revisions/drafts,
/// character-lorebook link, preset kind, memories, settings.
fn seed_v2_db(db: &mut Database) -> Result<(), Box<dyn std::error::Error>> {
    seed_kernel_db(db)?;
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO personas (id, name, description, is_default, created_at, updated_at) \
             VALUES ('persona-1', 'Aria', 'The user persona', 1, '2026-01-11T00:00:00Z', '2026-01-11T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed persona"))?;
        tx.execute(
            "UPDATE chats SET persona_id = 'persona-1' WHERE id = 'chat-1'",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "link chat persona"))?;
        tx.execute(
            "INSERT INTO chats (id, title, character_id, parent_chat_id, origin, source_message_id, created_at, updated_at) \
             VALUES ('chat-1-child', 'Branch', 'char-1', 'chat-1', 'checkpoint', 'msg-2', \
                     '2026-01-12T00:00:00Z', '2026-01-12T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed child chat"))?;
        tx.execute(
            "UPDATE messages SET meta_json = '{\"swipe\":2}', generation_run_id = 'run-9', updated_at = '2026-01-13T00:00:00Z' \
             WHERE id = 'msg-2'",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "decorate message"))?;
        tx.execute(
            "UPDATE messages SET checkpoint_chat_id = 'chat-1-child' WHERE id = 'msg-2'",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "checkpoint link"))?;
        tx.execute(
            "INSERT INTO message_variants (id, message_id, position, content, created_at) \
             VALUES ('var-1', 'msg-2', 1, 'Alternative reply', '2026-01-14T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed variant"))?;
        tx.execute(
            "INSERT INTO message_content_revisions (id, message_id, position, content, created_at) \
             VALUES ('rev-1', 'msg-2', 0, 'Original reply', '2026-01-15T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed revision"))?;
        tx.execute(
            "INSERT INTO message_drafts (id, chat_id, role, content, sequence, revision, committed_message_id, created_at, updated_at) \
             VALUES ('draft-1', 'chat-1', 'user', 'Draft text', 0, 1, 'msg-1', '2026-01-16T00:00:00Z', '2026-01-16T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed draft"))?;
        tx.execute(
            "INSERT INTO character_lorebooks (character_id, lorebook_id) VALUES ('char-1', 'lb-1')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed lorebook link"))?;
        tx.execute(
            "UPDATE presets SET kind = 'instruct' WHERE id = 'preset-1'",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "preset kind"))?;
        tx.execute(
            "INSERT INTO memories (id, scope, character_id, keys_json, content, enabled, position, metadata_json, created_at, updated_at) \
             VALUES ('mem-1', 'character', 'char-1', '[\"crystal\"]', 'The crystal hums.', 1, 0, '{}', \
                     '2026-01-17T00:00:00Z', '2026-01-17T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed memory"))?;
        tx.execute(
            "INSERT INTO memories (id, scope, keys_json, content, enabled, position, metadata_json, created_at, updated_at) \
             VALUES ('mem-2', 'global', '[]', 'Global note', 1, 0, '{}', \
                     '2026-01-18T00:00:00Z', '2026-01-18T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed global memory"))?;
        tx.execute(
            "INSERT INTO settings (key, value_json, updated_at) \
             VALUES ('ui.density', '\"compact\"', '2026-01-19T00:00:00Z')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed setting"))?;
        tx.execute(
            "UPDATE characters SET import_hash = 'deadbeef' WHERE id = 'char-1'",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "seed import hash"))?;
        Ok(())
    })?;
    Ok(())
}

#[test]
fn v2_round_trip_carries_new_sections_and_columns() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root_a = dir.path().join("a");
    let mut db_a = open_root(&root_a)?;
    seed_v2_db(&mut db_a)?;

    let dest = dir.path().join("export");
    let report = create_export(&db_a, &dest, false, None)?;
    assert_eq!(report.counts.personas, 1);
    assert_eq!(report.counts.chats, 3, "2 base + 1 snapshot child");
    assert_eq!(report.counts.message_variants, 1);
    assert_eq!(report.counts.message_content_revisions, 1);
    assert_eq!(report.counts.message_drafts, 1);
    assert_eq!(report.counts.character_lorebooks, 1);
    assert_eq!(report.counts.memories, 2);
    assert_eq!(report.counts.settings, 1);

    let verified = verify_export(&dest)?;
    assert_eq!(verified.format_version, 2);
    assert_eq!(verified.records, report.counts);

    let root_b = dir.path().join("b");
    let mut db_b = open_root(&root_b)?;
    let imported = apply_import(&dest, &mut db_b, DuplicatePolicy::Reject)?;
    assert!(
        imported.orphans.is_empty(),
        "orphans: {:?}",
        imported.orphans
    );
    assert_eq!(imported.skipped, 0);
    // 10 base + 1 persona + 1 child chat + 1 variant + 1 revision + 1 draft
    // + 1 link + 2 memories + 1 setting = 19.
    assert_eq!(imported.inserted, 19, "every record inserted");

    // Field fidelity of the v2 columns.
    let persona: Option<String> = db_b.conn().query_row(
        "SELECT persona_id FROM chats WHERE id = 'chat-1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(persona.as_deref(), Some("persona-1"), "persona link");
    let (parent, origin, source): (Option<String>, Option<String>, Option<String>) =
        db_b.conn().query_row(
            "SELECT parent_chat_id, origin, source_message_id FROM chats WHERE id = 'chat-1-child'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
    assert_eq!(parent.as_deref(), Some("chat-1"), "parent link");
    assert_eq!(origin.as_deref(), Some("checkpoint"));
    assert_eq!(source.as_deref(), Some("msg-2"));
    let (meta, run, checkpoint, updated): (String, Option<String>, Option<String>, Option<String>) =
        db_b
            .conn()
            .query_row(
                "SELECT meta_json, generation_run_id, checkpoint_chat_id, updated_at FROM messages WHERE id = 'msg-2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?;
    assert_eq!(meta, r#"{"swipe":2}"#, "meta preserved");
    assert_eq!(run.as_deref(), Some("run-9"), "run link verbatim");
    assert_eq!(checkpoint.as_deref(), Some("chat-1-child"));
    assert_eq!(updated.as_deref(), Some("2026-01-13T00:00:00Z"));
    let variant: String = db_b.conn().query_row(
        "SELECT content FROM message_variants WHERE id = 'var-1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(variant, "Alternative reply");
    let revision: String = db_b.conn().query_row(
        "SELECT content FROM message_content_revisions WHERE id = 'rev-1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(revision, "Original reply");
    let draft_committed: Option<String> = db_b.conn().query_row(
        "SELECT committed_message_id FROM message_drafts WHERE id = 'draft-1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(draft_committed.as_deref(), Some("msg-1"));
    let link: (String, String) = db_b.conn().query_row(
        "SELECT character_id, lorebook_id FROM character_lorebooks",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(link.0, "char-1");
    assert_eq!(link.1, "lb-1");
    let (kind, preset_settings): (String, String) = db_b.conn().query_row(
        "SELECT kind, settings_json FROM presets WHERE id = 'preset-1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(kind, "instruct", "preset kind preserved");
    assert_eq!(preset_settings, r#"{"temp":0.7}"#);
    let scoped: Option<String> = db_b.conn().query_row(
        "SELECT character_id FROM memories WHERE id = 'mem-1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(scoped.as_deref(), Some("char-1"), "character memory link");
    let unscoped: Option<String> = db_b.conn().query_row(
        "SELECT character_id FROM memories WHERE id = 'mem-2'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(unscoped, None, "global memory has no character");
    let value: String = db_b.conn().query_row(
        "SELECT value_json FROM settings WHERE key = 'ui.density'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(value, r#""compact""#);
    let import_hash: Option<String> = db_b.conn().query_row(
        "SELECT import_hash FROM characters WHERE id = 'char-1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(import_hash.as_deref(), Some("deadbeef"));

    // Re-import under Reject adds nothing.
    let again = apply_import(&dest, &mut db_b, DuplicatePolicy::Reject)?;
    assert_eq!(again.inserted, 0, "re-import is idempotent");
    assert_eq!(again.skipped, 19);
    assert_eq!(count_rows(&db_b, "memories")?, 2);
    Ok(())
}

/// The seven v2 sections a v1 container lacks import as empty, and the v1
/// record fields take their defaults (preset kind = 'generation').
#[test]
fn v1_container_imports_with_defaults() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root_a = dir.path().join("a");
    let mut db_a = open_root(&root_a)?;
    seed_v2_db(&mut db_a)?;

    let dest = dir.path().join("export");
    create_export(&db_a, &dest, false, None)?;

    // Downgrade the container to v1: drop the v2 section files and their
    // manifest records, and strip the v2-only fields from the base section
    // records (a real v1 container never carries them).
    for file in [
        "personas.ndjson",
        "message_variants.ndjson",
        "message_content_revisions.ndjson",
        "message_drafts.ndjson",
        "character_lorebooks.ndjson",
        "memories.ndjson",
        "settings.ndjson",
    ] {
        std::fs::remove_file(dest.join(file))?;
    }
    let strip_fields = |name: &str, fields: &[&str]| -> std::io::Result<()> {
        let path = dest.join(name);
        let text = std::fs::read_to_string(&path)?;
        let mut out = String::new();
        for line in text.lines() {
            let mut value: serde_json::Value =
                serde_json::from_str(line).map_err(|e| std::io::Error::other(e.to_string()))?;
            if let Some(obj) = value.as_object_mut() {
                for field in fields {
                    obj.remove(*field);
                }
            }
            out.push_str(
                &serde_json::to_string(&value).map_err(|e| std::io::Error::other(e.to_string()))?,
            );
            out.push('\n');
        }
        std::fs::write(&path, out)
    };
    strip_fields(
        "chats.ndjson",
        &["personaId", "parentChatId", "origin", "sourceMessageId"],
    )?;
    strip_fields(
        "messages.ndjson",
        &["meta", "generationRunId", "checkpointChatId", "updatedAt"],
    )?;
    strip_fields("characters.ndjson", &["importHash"])?;
    strip_fields("presets.ndjson", &["kind"])?;
    let manifest_path = dest.join("manifest.json");
    let mut manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
    manifest["formatVersion"] = serde_json::json!(1);
    let records = manifest["records"].as_object_mut().unwrap();
    for key in [
        "personas",
        "messageVariants",
        "messageContentRevisions",
        "messageDrafts",
        "characterLorebooks",
        "memories",
        "settings",
    ] {
        records.remove(key);
    }
    let base = [
        "characters.ndjson",
        "chats.ndjson",
        "messages.ndjson",
        "lorebooks.ndjson",
        "presets.ndjson",
    ];
    manifest["inventory"] = serde_json::Value::Array(
        manifest["inventory"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| {
                let path = e["logicalPath"].as_str().unwrap_or("");
                base.contains(&path) || path.starts_with("assets/")
            })
            .cloned()
            .collect(),
    );
    // The rewritten base files changed size and content: refresh their
    // inventory entries (size + sha256) before the manifest is written.
    let inventory = manifest["inventory"].as_array_mut().unwrap();
    for entry in inventory.iter_mut() {
        let path = entry["logicalPath"].as_str().unwrap_or("").to_string();
        if !base.contains(&path.as_str()) {
            continue;
        }
        let bytes = std::fs::read(dest.join(&path))?;
        entry["size"] = serde_json::json!(bytes.len() as u64);
        entry["sha256"] = serde_json::json!(neotavern_storage::assets::sha256_hex(&bytes));
    }
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;

    let verified = verify_export(&dest)?;
    assert_eq!(verified.format_version, 1);
    assert_eq!(verified.records.personas, 0);
    assert_eq!(verified.records.memories, 0);

    let root_b = dir.path().join("b");
    let mut db_b = open_root(&root_b)?;
    let imported = apply_import(&dest, &mut db_b, DuplicatePolicy::Reject)?;
    assert!(
        imported.orphans.is_empty(),
        "orphans: {:?}",
        imported.orphans
    );
    // 2 characters + 3 chats (incl. the snapshot child) + 3 messages
    // + 2 lorebooks + 1 preset — the v2-only sections contributed nothing.
    assert_eq!(imported.inserted, 11, "only the five base sections");
    assert_eq!(count_rows(&db_b, "personas")?, 0);
    assert_eq!(count_rows(&db_b, "memories")?, 0);
    assert_eq!(count_rows(&db_b, "message_variants")?, 0);
    // The stripped v2 link columns land NULL.
    let (persona, parent): (Option<String>, Option<String>) = db_b.conn().query_row(
        "SELECT persona_id, parent_chat_id FROM chats WHERE id = 'chat-1-child'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(persona, None, "stripped personaId imports NULL");
    assert_eq!(parent, None, "stripped parentChatId imports NULL");
    // Preset kind falls back to the migration default.
    let kind: String =
        db_b.conn()
            .query_row("SELECT kind FROM presets WHERE id = 'preset-1'", [], |r| {
                r.get(0)
            })?;
    assert_eq!(kind, "generation", "v1 preset kind default");
    Ok(())
}

/// `DuplicatePolicy::Remap` on a v2 container: every id is fresh, and the
/// child links (persona, snapshot trio, variants/revisions/drafts, lorebook
/// link, memory scope) follow to the new ids.
#[test]
fn remap_reassigns_ids_and_remaps_links() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let root_a = dir.path().join("a");
    let mut db_a = open_root(&root_a)?;
    seed_v2_db(&mut db_a)?;

    let dest = dir.path().join("export");
    create_export(&db_a, &dest, false, None)?;

    let root_b = dir.path().join("b");
    let mut db_b = open_root(&root_b)?;
    let imported = apply_import(&dest, &mut db_b, DuplicatePolicy::Remap)?;
    assert!(
        imported.orphans.is_empty(),
        "orphans: {:?}",
        imported.orphans
    );
    assert_eq!(imported.inserted, 19);

    // Ids are fresh.
    let old_chat_gone: i64 =
        db_b.conn()
            .query_row("SELECT COUNT(*) FROM chats WHERE id = 'chat-1'", [], |r| {
                r.get(0)
            })?;
    assert_eq!(old_chat_gone, 0, "chat ids are remapped");
    let chat_count: i64 = db_b
        .conn()
        .query_row("SELECT COUNT(*) FROM chats", [], |r| r.get(0))?;
    assert_eq!(chat_count, 3);

    // Every internal link resolves inside the target.
    let broken_links: i64 = db_b
        .conn()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM chats c LEFT JOIN characters ch ON ch.id = c.character_id WHERE ch.id IS NULL) \
             + (SELECT COUNT(*) FROM chats c LEFT JOIN personas p ON p.id = c.persona_id WHERE c.persona_id IS NOT NULL AND p.id IS NULL) \
             + (SELECT COUNT(*) FROM chats c LEFT JOIN chats p2 ON p2.id = c.parent_chat_id WHERE c.parent_chat_id IS NOT NULL AND p2.id IS NULL) \
             + (SELECT COUNT(*) FROM message_variants v LEFT JOIN messages m ON m.id = v.message_id WHERE m.id IS NULL) \
             + (SELECT COUNT(*) FROM message_content_revisions r LEFT JOIN messages m ON m.id = r.message_id WHERE m.id IS NULL) \
             + (SELECT COUNT(*) FROM message_drafts d LEFT JOIN chats c ON c.id = d.chat_id WHERE c.id IS NULL) \
             + (SELECT COUNT(*) FROM character_lorebooks l LEFT JOIN lorebooks b ON b.id = l.lorebook_id WHERE b.id IS NULL) \
             + (SELECT COUNT(*) FROM memories mem LEFT JOIN characters ch ON ch.id = mem.character_id WHERE mem.character_id IS NOT NULL AND ch.id IS NULL)",
            [],
            |r| r.get(0),
        )?;
    assert_eq!(broken_links, 0, "all remapped links resolve");

    // The persona default flag survived the remap.
    let defaults: i64 = db_b.conn().query_row(
        "SELECT COUNT(*) FROM personas WHERE is_default = 1",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(defaults, 1);

    // The global memory stayed unscoped.
    let unscoped: i64 = db_b.conn().query_row(
        "SELECT COUNT(*) FROM memories WHERE scope = 'global' AND character_id IS NULL",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(unscoped, 1);
    Ok(())
}
