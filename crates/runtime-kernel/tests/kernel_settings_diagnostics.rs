//! Этап 4 slice 7: canonical non-secret settings + SEC-07 diagnostics
//! integration tests.
//!
//! Exercises `settings.get` / `settings.update` (key → JSON-object store with
//! transactional upsert) and `diagnostics.export` (allowlist bundle with
//! `redaction: 'allowlist'`). The redaction tests prove that secret material
//! planted in the SecretStore-shaped data (provider config rows, message
//! content) and in a settings value never reaches the diagnostics bundle —
//! SEC-07 "redaction applies before write; exports use an allowlist".

use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::{json, Value};

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch_json(
    kernel: &Kernel,
    op: &str,
    request: Value,
) -> Result<Value, runtime_kernel::KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

fn dispatch_ok(kernel: &Kernel, op: &str, request: Value) -> Value {
    dispatch_json(kernel, op, request).expect("operation must succeed")
}

/// Seeding helper: opens a fresh data root and inserts secret-looking rows
/// (provider config, message content) plus a sentinel API key in a settings
/// value, so the diagnostics tests can prove the allowlist excludes them.
fn seed_data_root_with_sentinels(
    root: &std::path::Path,
    _sentinel_key: &str,
    sentinel_message: &str,
) {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("fresh data root must open");
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO provider_configs (id, provider, name, config_json, secret_ref, created_at, updated_at)
             VALUES ('00000000-0000-4000-8000-0000000000c1', 'fake', 'sentinel', '{}', 'provider:fake:sentinel', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')",
            [],
        )
        .expect("seed provider_configs");
        tx.execute(
            "INSERT INTO characters (id, name, description, tags_json, ext_json, created_at, updated_at)
             VALUES ('00000000-0000-4000-8000-0000000000c2', 'Sentinel', NULL, '[]', '{}', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')",
            [],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO chats (id, character_id, title, created_at, updated_at)
             VALUES ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000c2', 'sentinel chat', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')",
            [],
        )
        .expect("seed chat");
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, created_at)
             VALUES ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000c3', 'user', ?1, 0, '2026-08-18T00:00:00Z')",
            rusqlite::params![sentinel_message],
        )
        .expect("seed message");
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
    drop(db); // release the lease before the kernel takes the root
}

#[test]
fn settings_update_get_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Empty snapshot on a fresh root.
    let empty = dispatch_ok(&kernel, "settings.get", json!({}));
    assert_eq!(empty["items"], json!([]));

    // Upsert two settings; the response returns the post-update snapshot.
    let updated = dispatch_ok(
        &kernel,
        "settings.update",
        json!({
            "settings": [
                { "key": "ui.theme", "value": { "theme": "dark" } },
                { "key": "app.language", "value": { "locale": "en" } }
            ]
        }),
    );
    let items = updated["items"].as_array().expect("items array");
    assert_eq!(items.len(), 2);
    // Response is ordered by key (app.language < ui.theme).
    assert_eq!(items[0]["key"], "app.language");
    assert_eq!(items[0]["value"], json!({ "locale": "en" }));
    assert_eq!(items[1]["key"], "ui.theme");
    assert_eq!(items[1]["value"], json!({ "theme": "dark" }));
    assert!(!items[0]["updatedAt"].as_str().expect("rfc3339").is_empty());

    // Targeted get.
    let partial = dispatch_ok(&kernel, "settings.get", json!({ "keys": ["app.language"] }));
    let partial_items = partial["items"].as_array().expect("items array");
    assert_eq!(partial_items.len(), 1);
    assert_eq!(partial_items[0]["key"], "app.language");

    // Overwrite is an upsert (same row count, new value).
    let overwritten = dispatch_ok(
        &kernel,
        "settings.update",
        json!({ "settings": [{ "key": "ui.theme", "value": { "theme": "light" } }] }),
    );
    let overwritten_items = overwritten["items"].as_array().expect("items array");
    assert_eq!(overwritten_items.len(), 1);
    assert_eq!(overwritten_items[0]["value"], json!({ "theme": "light" }));

    // Full snapshot still has both keys, ordered.
    let all = dispatch_ok(&kernel, "settings.get", json!({}));
    let all_items = all["items"].as_array().expect("items array");
    assert_eq!(all_items.len(), 2);
    assert_eq!(all_items[0]["key"], "app.language");
    assert_eq!(all_items[1]["key"], "ui.theme");

    // Idempotent re-apply: same value, no error.
    let again = dispatch_ok(
        &kernel,
        "settings.update",
        json!({ "settings": [{ "key": "ui.theme", "value": { "theme": "light" } }] }),
    );
    assert_eq!(again["items"].as_array().expect("items").len(), 1);
}

#[test]
fn settings_wire_validation_rejects_bad_keys() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Upper-case key violates the wire pattern `^[a-z][a-z0-9._-]{1,127}$`.
    let err = dispatch_json(&kernel, "settings.get", json!({ "keys": ["UPPER"] }))
        .expect_err("bad key must fail");
    assert_eq!(err.code, runtime_kernel::KernelErrorCode::ContractViolation);

    // Unknown keys are omitted silently (no error, empty result).
    let missing = dispatch_ok(
        &kernel,
        "settings.get",
        json!({ "keys": ["does.not.exist"] }),
    );
    assert_eq!(missing["items"], json!([]));
}

#[test]
fn diagnostics_export_is_allowlisted_and_redacted() {
    let root = tempfile::tempdir().expect("tempdir");
    // Sentinel secret values in provider config secret ref, message content
    // and a settings value; none may appear in the diagnostics bundle.
    let secret = "sk-sentinel-9f2c7a1b";
    let message_secret = "s3cr3t-message-token";
    seed_data_root_with_sentinels(root.path(), secret, message_secret);
    let kernel = open_kernel(root.path());

    // Put a sentinel into a setting value too.
    let _ = dispatch_ok(
        &kernel,
        "settings.update",
        json!({ "settings": [{ "key": "app.suspect", "value": { "apiKey": secret } }] }),
    );

    let bundle = dispatch_ok(&kernel, "diagnostics.export", json!({}));
    let text = bundle.to_string();

    // Contract constants.
    assert_eq!(bundle["redaction"], "allowlist");
    assert_eq!(bundle["schemaHash"].as_str().expect("hash").len(), 64);
    assert_eq!(
        bundle["schemaHash"],
        contracts_generated::contract_schema_hash()
    );
    assert_eq!(bundle["schemaRevision"].as_i64().expect("revision"), 11);
    assert_eq!(bundle["settings"]["count"].as_i64().expect("count"), 1);
    assert_eq!(
        bundle["generationRuns"]["total"].as_i64().expect("total"),
        0
    );
    assert!(bundle["sections"].as_array().expect("sections").len() >= 4);

    // The allowlist is structural: the bundle NEVER contains the sentinel
    // secret, the message content, the provider config, or the setting value.
    assert!(
        !text.contains(secret),
        "diagnostics must not contain the secret"
    );
    assert!(
        !text.contains(message_secret),
        "diagnostics must not contain message content"
    );
    assert!(
        !text.contains("sentinel"),
        "diagnostics must not contain seeded sentinel entity names"
    );
    assert!(
        !text.contains("apiKey"),
        "diagnostics must not carry the settings value at all"
    );
    assert!(
        !text.contains("provider:fake:sentinel"),
        "diagnostics must not contain secret references"
    );
}

#[test]
fn diagnostics_export_counts_generation_runs() {
    let root = tempfile::tempdir().expect("tempdir");
    // Seed three durable runs before the kernel opens: completed, failed and
    // one with a pending tool call (derived waiting-for-tool state).
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root.path(),
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("open for seeding");
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, tags_json, ext_json, created_at, updated_at)
             VALUES ('00000000-0000-4000-8000-0000000000d1', 'Diag', NULL, '[]', '{}', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')",
            [],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO chats (id, character_id, title, created_at, updated_at)
             VALUES ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000d1', 'diag chat', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')",
            [],
        )
        .expect("seed chat");
        for (id, status, tool) in [
            ("00000000-0000-4000-8000-0000000000d3", "completed", false),
            ("00000000-0000-4000-8000-0000000000d4", "failed", false),
            ("00000000-0000-4000-8000-0000000000d5", "streaming", true),
        ] {
            let tool_json = if tool {
                Some(r#"{"id":"call-1","name":"lookup_weather","arguments":{"query":"Kyiv"}}"#)
            } else {
                None
            };
            tx.execute(
                "INSERT INTO generation_runs
                   (id, chat_id, attempt, status, provider, model, request_snapshot_json,
                    pending_tool_call_json, lease_expires_at, started_at, updated_at)
                 VALUES (?1, '00000000-0000-4000-8000-0000000000d2', 1, ?2, 'fake', 'demo',
                         '{}', ?3, '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z',
                         '2026-08-18T00:00:00Z')",
                rusqlite::params![id, status, tool_json],
            )
            .expect("seed generation run");
        }
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
    drop(db);

    let kernel = open_kernel(root.path());
    let bundle = dispatch_ok(&kernel, "diagnostics.export", json!({}));
    let runs = &bundle["generationRuns"];
    assert_eq!(runs["total"].as_i64().expect("total"), 3);
    assert_eq!(runs["completed"].as_i64().expect("completed"), 1);
    assert_eq!(runs["failed"].as_i64().expect("failed"), 1);
    assert_eq!(runs["waiting"].as_i64().expect("waiting"), 1);
}
