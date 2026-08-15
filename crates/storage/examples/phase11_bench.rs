//! Phase 11 benchmark harness (ТЗ §84): builds a fixed reference fixture and
//! measures backup/restore/export throughput. Prints a machine-readable
//! report; the numbers feed `docs/architecture/benchmarks.md`.

use std::path::Path;
use std::time::Instant;

use neotavern_storage::backup::{create_backup, restore_backup};
use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::export::create_export;
use neotavern_storage::open;

fn nop(_: neotavern_storage::migrations::MigrationProgress) {}

fn main() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("data");
    let mut db = open::open(&root, &ConnectionPolicy::default(), &mut nop).expect("open");

    let started = Instant::now();
    db.transaction(|tx| {
        for c in 0..200 {
            tx.execute(
                "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
                 VALUES (printf('%08d-0000-7000-8000-000000000000', ?1), ?2, ?3, NULL, '[\"t1\",\"t2\"]', '{\"k\":\"v\"}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![c, format!("Character {c}"), "x".repeat(512)],
            )
            .map_err(|e| neotavern_storage::StorageError::from_sqlite(e, "seed char"))?;
        }
        for h in 0..50 {
            let chat = format!("{h:08}-1111-7111-8111-111111111111");
            let chr = format!("{:08}-0000-7000-8000-000000000000", h % 200);
            tx.execute(
                "INSERT INTO chats (id, title, character_id, created_at, updated_at) VALUES (?1, ?2, ?3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![chat, format!("Chat {h}"), chr],
            )
            .map_err(|e| neotavern_storage::StorageError::from_sqlite(e, "seed chat"))?;
            for m in 0..100 {
                tx.execute(
                    "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at) \
                     VALUES (printf('%08d-%04d-7222-8222-222222222222', ?1, ?2), ?3, 'user', ?4, ?5, NULL, '2026-01-01T00:00:00Z')",
                    rusqlite::params![h, m, chat, "message content ".repeat(16), m],
                )
                .map_err(|e| neotavern_storage::StorageError::from_sqlite(e, "seed msg"))?;
            }
        }
        Ok(())
    })
    .expect("seed fixture");
    drop(db);
    let seed_ms = started.elapsed().as_millis();

    let db_size = std::fs::metadata(root.join("database.sqlite"))
        .expect("db meta")
        .len();

    // Backup
    let mut db = open::open(&root, &ConnectionPolicy::default(), &mut nop).expect("open");
    let started = Instant::now();
    let record = create_backup(&mut db, "22222222-3333-7333-8333-333333333333").expect("backup");
    let backup_ms = started.elapsed().as_millis();
    drop(db);

    // Restore into a fresh root (container lives under <root>/backups/).
    let container = root
        .join("backups")
        .join("22222222-3333-7333-8333-333333333333.neotavern-backup");
    let restored = temp.path().join("restored");
    let started = Instant::now();
    restore_backup(&container, &restored).expect("restore");
    let restore_ms = started.elapsed().as_millis();

    // Export
    let db = open::open(&root, &ConnectionPolicy::default(), &mut nop).expect("open");
    let export_dir = temp.path().join("export");
    let started = Instant::now();
    let report = create_export(&db, &export_dir, true, None).expect("export");
    let export_ms = started.elapsed().as_millis();
    drop(db);

    println!("BENCH fixture: 200 characters, 50 chats, 5000 messages");
    println!("BENCH db_bytes={db_size} seed_ms={seed_ms}");
    println!(
        "BENCH backup_ms={backup_ms} backup_bytes={} throughput_mbs={:.1}",
        record.size_bytes,
        record.size_bytes as f64 / 1_048_576.0 / (backup_ms.max(1) as f64 / 1000.0)
    );
    println!(
        "BENCH restore_ms={restore_ms} throughput_mbs={:.1}",
        record.size_bytes as f64 / 1_048_576.0 / (restore_ms.max(1) as f64 / 1000.0)
    );
    println!(
        "BENCH export_ms={export_ms} export_bytes={} throughput_mbs={:.1}",
        report.size_bytes,
        report.size_bytes as f64 / 1_048_576.0 / (export_ms.max(1) as f64 / 1000.0)
    );
    let _ = Path::new("");
}
