//! Plugin KV state (`plugins.state.*`, M7 Этап-4 cluster 21 part 1).
//!
//! The legacy `/api/v2/plugins/:id/state` store was a CAS-guarded KV object per
//! `(plugin, scope, owner)`, gated by `storage.<scope>`. These tests pin the
//! guarantees the plugin sandbox relies on: the row is durable and revisioned,
//! a stale `expectedRevision` is refused instead of clobbering a concurrent
//! writer, the scopes resolve to the documented owners (and refuse an owner
//! where the scope has none), an un-consented or unknown plugin never reaches
//! the store, and delete is idempotent.

use contracts_generated::generated::{
    decode_result_plugins_state, decode_result_plugins_state_delete,
    decode_result_plugins_state_set,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::Value;

const CHARACTER_ID: &str = "00000000-0000-4000-8000-0000000000d2";
const PLUGIN_ID: &str = "clockwork-state-plugin";

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn with_db<T>(
    root: &std::path::Path,
    f: impl FnOnce(&mut neotavern_storage::open::Database) -> T,
) -> T {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("data root must open");
    f(&mut db)
}

fn seed_character(root: &std::path::Path) {
    with_db(root, |db| {
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
                 VALUES (?1, 'Wren', 'A clockwork mechanic.', NULL, '[]', \
                 '{\"personality\":\"patient\"}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
                rusqlite::params![CHARACTER_ID],
            )
            .expect("seed character");
            Ok::<(), neotavern_storage::StorageError>(())
        })
        .expect("seeding transaction must succeed");
    });
}

fn dispatch(kernel: &Kernel, op: &str, request: Value) -> Value {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    let response = kernel
        .dispatch(op, &bytes, &flag)
        .expect("dispatch must succeed");
    serde_json::from_slice(&response).expect("response must be JSON")
}

/// Dispatches an op that must fail and returns the kernel error.
fn dispatch_error(kernel: &Kernel, op: &str, request: Value) -> runtime_kernel::KernelError {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .expect_err("dispatch must fail")
}

/// The wire product code and params of a failed dispatch (the client-visible
/// error), panicking when the failure is a kernel-level class instead.
fn product_code(error: &runtime_kernel::KernelError) -> (String, Value) {
    let product = error
        .product
        .as_ref()
        .expect("a product error carries a wire code");
    (product.code.clone(), product.params.clone())
}

fn install_plugin(kernel: &Kernel, permissions: &[&str]) {
    dispatch(
        kernel,
        "plugins.install",
        serde_json::json!({
            "id": PLUGIN_ID,
            "name": "Clockwork State",
            "version": "1.0.0",
            "trustState": "locally-trusted",
            "permissions": permissions,
        }),
    );
}

fn set_state(
    kernel: &Kernel,
    scope: &str,
    owner: Option<&str>,
    data: Value,
    expected_revision: Option<i64>,
) -> Value {
    let mut request = serde_json::json!({
        "pluginId": PLUGIN_ID,
        "scope": scope,
        "data": data,
    });
    if let Some(owner) = owner {
        request["ownerId"] = serde_json::json!(owner);
    }
    if let Some(expected) = expected_revision {
        request["expectedRevision"] = serde_json::json!(expected);
    }
    let response = dispatch(kernel, "plugins.state.set", request);
    // The write must decode through the generated checker.
    decode_result_plugins_state_set(
        &serde_json::to_vec(&response).expect("re-serialize set result"),
    )
    .expect("state.set must answer a schema-valid wire.result.plugins.state.set");
    response
}

fn get_state(kernel: &Kernel, scope: &str, owner: Option<&str>) -> Value {
    let mut request = serde_json::json!({ "pluginId": PLUGIN_ID, "scope": scope });
    if let Some(owner) = owner {
        request["ownerId"] = serde_json::json!(owner);
    }
    let response = dispatch(kernel, "plugins.state.get", request);
    decode_result_plugins_state(&serde_json::to_vec(&response).expect("re-serialize state result"))
        .expect("state.get must answer a schema-valid wire.result.plugins.state");
    response
}

fn seeded_kernel(root: &std::path::Path) -> Kernel {
    seed_character(root);
    let kernel = open_kernel(root);
    install_plugin(
        &kernel,
        &[
            "storage.installation",
            "storage.user",
            "storage.workspace",
            "storage.chat",
        ],
    );
    kernel
}

#[test]
fn state_rows_are_durable_and_revisioned() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());

    let (code, _) = product_code(&dispatch_error(
        &kernel,
        "plugins.state.get",
        serde_json::json!({ "pluginId": PLUGIN_ID, "scope": "installation" }),
    ));
    assert_eq!(code, "PLUGIN_STATE_NOT_FOUND", "an empty store has no row");

    let written = set_state(
        &kernel,
        "installation",
        None,
        serde_json::json!({ "lastQuery": "dragons" }),
        Some(0),
    );
    assert_eq!(written["revision"], 1, "the first write is revision 1");

    let read = get_state(&kernel, "installation", None);
    assert_eq!(read["revision"], 1);
    assert_eq!(read["ownerId"], "", "a singleton scope reports no owner");
    assert_eq!(read["data"]["lastQuery"], "dragons");
    assert_eq!(read["schemaVersion"], 1);

    // A whole-value write replaces the object (there is no merge on the wire).
    let written = set_state(
        &kernel,
        "installation",
        None,
        serde_json::json!({ "counter": 2 }),
        Some(1),
    );
    assert_eq!(written["revision"], 2);
    let read = get_state(&kernel, "installation", None);
    assert_eq!(read["data"], serde_json::json!({ "counter": 2 }));
}

#[test]
fn stale_expected_revision_is_refused_not_overwritten() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());
    set_state(&kernel, "user", None, serde_json::json!({ "a": 1 }), None);

    let (code, params) = product_code(&dispatch_error(
        &kernel,
        "plugins.state.set",
        serde_json::json!({
            "pluginId": PLUGIN_ID,
            "scope": "user",
            "data": { "a": 2 },
            "expectedRevision": 0,
        }),
    ));
    assert_eq!(code, "REVISION_CONFLICT");
    assert_eq!(
        params["revision"], "1",
        "the conflict reports the stored revision"
    );
    assert_eq!(
        get_state(&kernel, "user", None)["data"]["a"],
        1,
        "the refused write must not reach the store"
    );

    // The fresh revision is accepted.
    let written = set_state(
        &kernel,
        "user",
        None,
        serde_json::json!({ "a": 2 }),
        Some(1),
    );
    assert_eq!(written["revision"], 2);
}

#[test]
fn scopes_resolve_their_owner_and_refuse_a_misplaced_one() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());

    // workspace is a literal singleton row, chat is owned by the named chat.
    set_state(
        &kernel,
        "workspace",
        None,
        serde_json::json!({ "w": 1 }),
        None,
    );
    assert_eq!(
        get_state(&kernel, "workspace", None)["ownerId"],
        "workspace",
        "the workspace scope reports its literal owner"
    );

    set_state(
        &kernel,
        "chat",
        Some("chat-a"),
        serde_json::json!({ "c": "a" }),
        None,
    );
    set_state(
        &kernel,
        "chat",
        Some("chat-b"),
        serde_json::json!({ "c": "b" }),
        None,
    );
    assert_eq!(get_state(&kernel, "chat", Some("chat-a"))["data"]["c"], "a");
    assert_eq!(
        get_state(&kernel, "chat", Some("chat-b"))["data"]["c"],
        "b",
        "chat rows never leak across chats"
    );

    // A chat write without an owner cannot address an implicit row.
    let error = dispatch_error(
        &kernel,
        "plugins.state.set",
        serde_json::json!({
            "pluginId": PLUGIN_ID,
            "scope": "chat",
            "data": { "c": "orphan" },
        }),
    );
    assert_eq!(
        error.code,
        runtime_kernel::KernelErrorCode::ContractViolation
    );

    // An owner on a singleton scope is equally a caller bug.
    let error = dispatch_error(
        &kernel,
        "plugins.state.set",
        serde_json::json!({
            "pluginId": PLUGIN_ID,
            "scope": "installation",
            "ownerId": "chat-a",
            "data": {},
        }),
    );
    assert_eq!(
        error.code,
        runtime_kernel::KernelErrorCode::ContractViolation
    );
}

#[test]
fn state_requires_the_recorded_capability() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_character(root.path());
    let kernel = open_kernel(root.path());
    // Installed WITHOUT storage.user: the consent moment fixed the grants.
    install_plugin(&kernel, &["storage.installation"]);

    let (code, params) = product_code(&dispatch_error(
        &kernel,
        "plugins.state.set",
        serde_json::json!({
            "pluginId": PLUGIN_ID,
            "scope": "user",
            "data": { "a": 1 },
        }),
    ));
    assert_eq!(code, "PLUGIN_PERMISSION_DENIED");
    assert_eq!(params["capability"], "storage.user");

    // The granted scope works on the same installation.
    set_state(
        &kernel,
        "installation",
        None,
        serde_json::json!({ "a": 1 }),
        None,
    );

    // An unknown plugin is refused before the capability check.
    let (code, _) = product_code(&dispatch_error(
        &kernel,
        "plugins.state.get",
        serde_json::json!({ "pluginId": "not-installed", "scope": "installation" }),
    ));
    assert_eq!(code, "PLUGIN_NOT_FOUND");
}

#[test]
fn delete_is_idempotent_and_quota_is_enforced() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());
    set_state(
        &kernel,
        "installation",
        None,
        serde_json::json!({ "a": 1 }),
        None,
    );

    let first = dispatch(
        &kernel,
        "plugins.state.delete",
        serde_json::json!({ "pluginId": PLUGIN_ID, "scope": "installation" }),
    );
    decode_result_plugins_state_delete(
        &serde_json::to_vec(&first).expect("re-serialize delete result"),
    )
    .expect("state.delete must answer a schema-valid result");
    assert_eq!(first["deleted"], true);

    let second = dispatch(
        &kernel,
        "plugins.state.delete",
        serde_json::json!({ "pluginId": PLUGIN_ID, "scope": "installation" }),
    );
    assert_eq!(
        second["deleted"], false,
        "deleting a missing row is not an error"
    );

    // Too many top-level keys.
    let mut too_many = serde_json::Map::new();
    for index in 0..65 {
        too_many.insert(format!("k{index}"), Value::from(index));
    }
    let (code, _) = product_code(&dispatch_error(
        &kernel,
        "plugins.state.set",
        serde_json::json!({
            "pluginId": PLUGIN_ID,
            "scope": "installation",
            "data": Value::Object(too_many),
        }),
    ));
    assert_eq!(code, "STATE_QUOTA_EXCEEDED");

    // Oversized value (the wire request limit is 256 KiB, so stay below it).
    let big = "x".repeat(70000);
    let (code, _) = product_code(&dispatch_error(
        &kernel,
        "plugins.state.set",
        serde_json::json!({
            "pluginId": PLUGIN_ID,
            "scope": "installation",
            "data": { "blob": big },
        }),
    ));
    assert_eq!(code, "STATE_QUOTA_EXCEEDED");
}
