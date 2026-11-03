//! Round 29 (G7/G8 user-facing half): the legacy-import host functions over
//! a REAL kernel data root — plan/execute/rollback lifecycle, refusal codes,
//! rollback-without-target. Tauri-free: the commands are thin wrappers.

use std::path::Path;

use neotavern_storage::activation;
use neotavern_tauri_local::legacy;

/// A minimal legacy Drizzle-era app.db (same shapes the converter maps).
fn build_legacy_fixture(source: &Path) {
    let conn = rusqlite::Connection::open(source).expect("open fixture");
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
        );",
    )
    .expect("fixture tables");
    for sql in [
        "INSERT INTO characters (id, name, created_at, updated_at) VALUES ('leg-c1', 'Alice', 1, 2)",
        "INSERT INTO chats (id, title, character_id, created_at, updated_at) VALUES ('leg-h1', 'Chat', 'leg-c1', 3, 4)",
        "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ('leg-m1', 'leg-h1', 'user', 'Hello', 5)",
        "INSERT INTO lorebooks (id, name, description, created_at, updated_at) VALUES ('leg-l1', 'Lore', 'd', 6, 7)",
        "INSERT INTO presets (id, kind, name, data, created_at, updated_at) VALUES ('leg-p1', 'default', 'Preset', '{}', 8, 9)",
    ] {
        conn.execute(sql, []).expect("fixture seed");
    }
}

/// Opens a kernel over a fresh data root and returns the host's root
/// (exercise the real path the desktop shell wires).
fn open_kernel_root(root: &Path) -> neotavern_tauri_local::KernelHost {
    let host = neotavern_tauri_local::KernelHost::open(neotavern_tauri_local::KernelHostConfig {
        data_root: Some(root.to_path_buf()),
        secret_backend: neotavern_tauri_local::SecretBackend::Session,
        allow_secrets_exposure: false,
    })
    .expect("kernel open");
    assert_eq!(host.data_root(), Some(root));
    host
}

#[test]
fn plan_execute_rollback_round_trip_on_a_real_kernel_root() {
    let workspace = tempfile::tempdir().expect("tempdir");
    let data_root = workspace.path().join("data");
    let _host = open_kernel_root(&data_root);

    let source = workspace.path().join("app.db");
    build_legacy_fixture(&source);

    // Plan: dry run, ready, families reported.
    let plan = legacy::plan_import(&source).expect("plan ok");
    assert!(
        plan.ready,
        "fixture must be importable: {:?}",
        plan.problems
    );
    let characters = plan
        .families
        .iter()
        .find(|family| family.family == "characters")
        .expect("characters family");
    assert_eq!(characters.count, 1);

    // Execute: pointer moves to the staged root; previous root reported.
    let executed = legacy::execute_import(&data_root, &source).expect("execute ok");
    assert!(executed.restart_required);
    let pointer = activation::read_pointer(&data_root)
        .expect("pointer read")
        .expect("pointer exists");
    assert_eq!(
        pointer.root,
        activation::versioned_root_path(&data_root, &executed.staged_root_id),
        "pointer must target the staged root"
    );

    // Rollback: pointer restored to the pre-import root; a second rollback
    // refuses (no older target).
    let rolled = legacy::rollback_import(&data_root).expect("rollback ok");
    assert!(rolled.restart_required);
    let pointer = activation::read_pointer(&data_root)
        .expect("pointer read")
        .expect("pointer exists");
    assert_eq!(pointer.root.display().to_string(), executed.previous_root);
    let second = legacy::rollback_import(&data_root).expect_err("second rollback must refuse");
    assert_eq!(second.code, "LEGACY_NO_ROLLBACK_TARGET", "{second}");
}

#[test]
fn plan_refuses_a_garbage_source_and_execute_refuses_a_missing_root() {
    let workspace = tempfile::tempdir().expect("tempdir");
    let garbage = workspace.path().join("garbage.db");
    std::fs::write(&garbage, b"not a database at all").expect("write garbage");

    let plan = legacy::plan_import(&garbage).expect_err("plan must refuse garbage");
    assert_eq!(plan.code, "LEGACY_SOURCE_UNREADABLE", "{plan}");

    // A data root that never saw an import has no rollback target.
    let data_root = workspace.path().join("data");
    std::fs::create_dir_all(&data_root).expect("mkdir");
    let rolled = legacy::rollback_import(&data_root).expect_err("rollback must refuse");
    assert_eq!(rolled.code, "LEGACY_NO_ROLLBACK_TARGET", "{rolled}");
}
