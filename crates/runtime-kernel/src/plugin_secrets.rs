//! Plugin secret store (`plugins.secrets.list|set|delete|reveal`, M7 Этап-4
//! cluster 21 part 2).
//!
//! The canonical counterpart of the legacy `/api/v2/plugins/:id/secrets`
//! routes (ТЗ §54, SEC-01). It is deliberately shaped like
//! [`crate::provider_secrets`], because the security model is the same one the
//! user already approved for provider keys:
//!
//! - a row carries ONLY the opaque [`SecretStore`] reference, never the value;
//!   the plaintext lives in the host store under namespace
//!   `plugin-secret:<pluginId>`, so a database copy, a backup or a diagnostic
//!   export cannot contain key material;
//! - every other DTO is value-free: `masked` is derived from the OPAQUE
//!   REFERENCE (never from the value, never from the key name), so even the
//!   display hint cannot leak anything;
//! - the plaintext crosses the wire through exactly ONE operation,
//!   `plugins.secrets.reveal`, and only while the host enabled the exposure
//!   policy (default OFF, the same `secrets.exposure` gate providers use).
//!
//! Addressing and authorization reuse the KV state rules
//! ([`crate::plugin_state`]): the scope selects the owner (`installation`/`user`
//! are singleton rows persisted with the empty owner marker, `workspace` is the
//! literal workspace row, `chat` REQUIRES an explicit ownerId), and the scope's
//! family capability is `secrets.manageOwn` — the grant recorded at install
//! (ARC-08). `plugins.secrets.reveal` additionally requires `secrets.reveal` on
//! top of the host exposure gate, exactly like the legacy capability mapping.
//!
//! Fail-closed: without a wired store, `set`/`reveal` answer the stable
//! `SECRET_UNAVAILABLE` product error and `list`/`delete` still work on the
//! reference rows (a delete of a row whose store value cannot be revoked is
//! best-effort, the row is the authority). Uninstall drops the rows through the
//! plugin FK cascade; the values are revoked here through [`revoke_values`],
//! which the plugin delete path calls BEFORE the cascade.

use contracts_generated::generated::{
    self, PluginSecret, PluginStateScope, ResultPluginSecrets, ResultPluginsSecretsDelete,
    ResultPluginsSecretsReveal,
};
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::{params, Connection, OptionalExtension};
use secret_store::error::SecretStoreError;
use secret_store::SecretStore;
use std::sync::Arc;

use crate::plugin_state::{require_capability, resolve_owner, scope_name};
use crate::product::{self, now};
use crate::provider_secrets::mask_secret_reference;
use crate::KernelError;

/// SecretStore namespace prefix for plugin-owned secrets.
const PLUGIN_SECRET_NAMESPACE_PREFIX: &str = "plugin-secret:";

/// Capability required to manage the plugin's own secret store.
pub(crate) const CAPABILITY_MANAGE_OWN: &str = "secrets.manageOwn";
/// Capability required (additionally) to read a plaintext back.
pub(crate) const CAPABILITY_REVEAL: &str = "secrets.reveal";

/// SecretStore namespace holding one plugin's secret values.
pub(crate) fn secret_namespace(plugin_id: &str) -> String {
    format!("{PLUGIN_SECRET_NAMESPACE_PREFIX}{plugin_id}")
}

/// The store entry id is DETERMINISTIC on the wire address, so re-setting the
/// same key overwrites the same store entry instead of accumulating orphans:
/// `scope:owner:key`.
fn entry_id(scope: &PluginStateScope, owner_key: &str, key: &str) -> String {
    format!("{}:{owner_key}:{key}", scope_name(scope))
}

/// Product error for a missing key of the addressed scope.
fn secret_not_found(plugin_id: &str, scope: &PluginStateScope, key: &str) -> KernelError {
    KernelError::product(
        "PLUGIN_SECRET_NOT_FOUND",
        vec![
            ("pluginId".to_string(), plugin_id.to_string()),
            ("scope".to_string(), scope_name(scope).to_string()),
            ("key".to_string(), key.to_string()),
        ],
    )
}

/// Maps a SecretStore failure to a product error carrying the stable
/// `SECRET_*` code (never the value).
fn secret_error(err: &SecretStoreError) -> KernelError {
    KernelError::product(err.code.to_string(), vec![])
}

/// Product error when no SecretStore seam is wired (fail-closed).
fn no_secret_store() -> KernelError {
    KernelError::product("SECRET_UNAVAILABLE".to_string(), vec![])
}

/// Product error when the host did not enable plaintext exposure.
fn exposure_disabled() -> KernelError {
    KernelError::product("SECRETS_EXPOSURE_DISABLED".to_string(), vec![])
}

fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::from(StorageError::from_sqlite(err, context))
}

/// One stored reference row (never a value).
struct SecretRow {
    secret_ref: String,
    created_at: String,
    updated_at: String,
}

/// Reads one row scoped to its address.
fn load_row(
    conn: &Connection,
    plugin_id: &str,
    scope: &PluginStateScope,
    owner_key: &str,
    key: &str,
) -> Result<Option<SecretRow>, KernelError> {
    conn.query_row(
        "SELECT secret_ref, created_at, updated_at FROM plugin_secrets \
         WHERE plugin_id = ?1 AND scope = ?2 AND owner_key = ?3 AND key = ?4",
        params![plugin_id, scope_name(scope), owner_key, key],
        |row| {
            Ok(SecretRow {
                secret_ref: row.get(0)?,
                created_at: row.get(1)?,
                updated_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| sqlite(e, "plugin_secrets: select row"))
}

/// Renders a row as the value-free wire DTO.
fn to_dto(scope: &PluginStateScope, key: &str, row: &SecretRow) -> PluginSecret {
    PluginSecret {
        key: key.to_string(),
        scope: scope.clone(),
        masked: mask_secret_reference(&row.secret_ref),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

/// Shared prologue: resolve the owner marker and prove the manage grant.
fn authorize(
    conn: &Connection,
    plugin_id: &str,
    scope: &PluginStateScope,
    owner_id: Option<&str>,
    capability: &str,
) -> Result<String, KernelError> {
    let owner_key = resolve_owner(scope, owner_id)?;
    require_capability(conn, plugin_id, capability)?;
    Ok(owner_key)
}

/// `plugins.secrets.list` — every key of the addressed scope, value-free.
pub(crate) fn list(
    db: &mut Database,
    _store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_plugins_secrets_list(request)?;
    let conn = db.conn();
    let owner_key = authorize(
        conn,
        &req.plugin_id,
        &req.scope,
        req.owner_id.as_deref(),
        CAPABILITY_MANAGE_OWN,
    )?;
    let mut stmt = conn
        .prepare(
            "SELECT key, secret_ref, created_at, updated_at FROM plugin_secrets \
             WHERE plugin_id = ?1 AND scope = ?2 AND owner_key = ?3 ORDER BY key ASC",
        )
        .map_err(|e| sqlite(e, "plugin_secrets_list: prepare"))?;
    let mut rows = stmt
        .query(params![&req.plugin_id, scope_name(&req.scope), owner_key])
        .map_err(|e| sqlite(e, "plugin_secrets_list: query"))?;
    let mut items: Vec<PluginSecret> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| sqlite(e, "plugin_secrets_list: read row"))?
    {
        let key: String = row
            .get(0)
            .map_err(|e| sqlite(e, "plugin_secrets_list: key"))?;
        let stored = SecretRow {
            secret_ref: row
                .get(1)
                .map_err(|e| sqlite(e, "plugin_secrets_list: secret_ref"))?,
            created_at: row
                .get(2)
                .map_err(|e| sqlite(e, "plugin_secrets_list: created_at"))?,
            updated_at: row
                .get(3)
                .map_err(|e| sqlite(e, "plugin_secrets_list: updated_at"))?,
        };
        items.push(to_dto(&req.scope, &key, &stored));
    }
    let dto = ResultPluginSecrets { items };
    product::validate(&dto, generated::validate_result_plugin_secrets)?;
    product::encode(&dto)
}

/// `plugins.secrets.set` — store the value under the deterministic entry id,
/// then upsert the reference row. The store write happens FIRST, so a failed
/// row write cannot leave a row pointing at a missing value (best-effort
/// cleanup mirrors `providers.secrets.create`).
pub(crate) fn set(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_plugins_secrets_set(request)?;
    let store = store.ok_or_else(no_secret_store)?;
    let owner_key = {
        let conn = db.conn();
        authorize(
            conn,
            &req.plugin_id,
            &req.scope,
            req.owner_id.as_deref(),
            CAPABILITY_MANAGE_OWN,
        )?
    };
    let namespace = secret_namespace(&req.plugin_id);
    let id = entry_id(&req.scope, &owner_key, &req.key);
    let reference = store
        .put(&namespace, &id, &req.value)
        .map_err(|e| secret_error(&e))?;
    let created_at = now();
    let updated_at = created_at.clone();
    let written = db.transaction(|tx| {
        tx.execute(
            "INSERT INTO plugin_secrets \
             (plugin_id, scope, owner_key, key, secret_ref, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(plugin_id, scope, owner_key, key) DO UPDATE SET \
             secret_ref = excluded.secret_ref, updated_at = excluded.updated_at",
            params![
                &req.plugin_id,
                scope_name(&req.scope),
                &owner_key,
                &req.key,
                &reference,
                &created_at,
                &updated_at
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "plugin_secrets_set: upsert"))?;
        Ok(())
    });
    if let Err(err) = written {
        if let Err(cleanup) = store.delete(&namespace, &id) {
            eprintln!("plugins.secrets.set: orphan cleanup failed: {cleanup}");
        }
        return Err(KernelError::from(err));
    }
    let conn = db.conn();
    let stored = load_row(conn, &req.plugin_id, &req.scope, &owner_key, &req.key)?
        .ok_or_else(|| secret_not_found(&req.plugin_id, &req.scope, &req.key))?;
    let dto = to_dto(&req.scope, &req.key, &stored);
    product::validate(&dto, generated::validate_plugin_secret)?;
    product::encode(&dto)
}

/// `plugins.secrets.delete` — drop the reference row, then revoke the value
/// (best-effort: the row is the authority, exactly like provider secrets).
/// Deleting a key that was never stored is not an error (`deleted: false`).
pub(crate) fn delete(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_plugins_secrets_delete(request)?;
    let owner_key = {
        let conn = db.conn();
        authorize(
            conn,
            &req.plugin_id,
            &req.scope,
            req.owner_id.as_deref(),
            CAPABILITY_MANAGE_OWN,
        )?
    };
    let existed = {
        let conn = db.conn();
        load_row(conn, &req.plugin_id, &req.scope, &owner_key, &req.key)?.is_some()
    };
    if existed {
        db.transaction(|tx| {
            tx.execute(
                "DELETE FROM plugin_secrets \
                 WHERE plugin_id = ?1 AND scope = ?2 AND owner_key = ?3 AND key = ?4",
                params![&req.plugin_id, scope_name(&req.scope), &owner_key, &req.key],
            )
            .map_err(|e| StorageError::from_sqlite(e, "plugin_secrets_delete: delete"))?;
            Ok(())
        })?;
        if let Some(store) = store {
            let namespace = secret_namespace(&req.plugin_id);
            let id = entry_id(&req.scope, &owner_key, &req.key);
            if let Err(err) = store.delete(&namespace, &id) {
                eprintln!("plugins.secrets.delete: secret revocation failed: {err}");
            }
        }
    }
    let dto = ResultPluginsSecretsDelete { deleted: existed };
    product::validate(&dto, generated::validate_result_plugins_secrets_delete)?;
    product::encode(&dto)
}

/// `plugins.secrets.reveal` — the ONLY operation returning a plaintext. Gated
/// by the host exposure policy first (fail before addressing the store), then
/// by the plugin's own `secrets.reveal` grant.
pub(crate) fn reveal(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    allow_exposure: bool,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_plugins_secrets_reveal(request)?;
    if !allow_exposure {
        return Err(exposure_disabled());
    }
    let owner_key = {
        let conn = db.conn();
        authorize(
            conn,
            &req.plugin_id,
            &req.scope,
            req.owner_id.as_deref(),
            CAPABILITY_REVEAL,
        )?
    };
    {
        let conn = db.conn();
        if load_row(conn, &req.plugin_id, &req.scope, &owner_key, &req.key)?.is_none() {
            return Err(secret_not_found(&req.plugin_id, &req.scope, &req.key));
        }
    }
    let store = store.ok_or_else(no_secret_store)?;
    let namespace = secret_namespace(&req.plugin_id);
    let id = entry_id(&req.scope, &owner_key, &req.key);
    let value = store
        .get(&namespace, &id)
        .map_err(|e| secret_error(&e))?
        .ok_or_else(|| {
            KernelError::product(
                "SECRET_UNAVAILABLE_ON_THIS_DEVICE".to_string(),
                vec![
                    ("pluginId".to_string(), req.plugin_id.clone()),
                    ("key".to_string(), req.key.clone()),
                ],
            )
        })?;
    let dto = ResultPluginsSecretsReveal { value };
    product::validate(&dto, generated::validate_result_plugins_secrets_reveal)?;
    product::encode(&dto)
}

/// Executor-side resolution (ADR-0064): read one `user`-scope secret VALUE for a
/// running job.
///
/// This is the seam the kernel-resident executor uses when it injects a secret
/// into a task. It is deliberately narrower than `plugins.secrets.reveal`:
///
/// - it never crosses the wire, so there is no DTO and no base64;
/// - it requires the same `secrets.reveal` grant recorded at install, checked on
///   EVERY call (a grant revoked mid-run makes the next reveal fail);
/// - it only addresses the `user` scope, which has no owner argument, so a job
///   cannot reach another scope by smuggling an owner id through its payload.
pub(crate) fn resolve_for_executor(
    db: &Database,
    store: Option<&Arc<dyn SecretStore>>,
    plugin_id: &str,
    key: &str,
) -> Result<String, KernelError> {
    let scope = PluginStateScope::User;
    let owner_key = {
        let conn = db.conn();
        authorize(conn, plugin_id, &scope, None, CAPABILITY_REVEAL)?
    };
    {
        let conn = db.conn();
        if load_row(conn, plugin_id, &scope, &owner_key, key)?.is_none() {
            return Err(secret_not_found(plugin_id, &scope, key));
        }
    }
    let store = store.ok_or_else(no_secret_store)?;
    let namespace = secret_namespace(plugin_id);
    let id = entry_id(&scope, &owner_key, key);
    store
        .get(&namespace, &id)
        .map_err(|e| secret_error(&e))?
        .ok_or_else(|| {
            KernelError::product(
                "SECRET_UNAVAILABLE_ON_THIS_DEVICE".to_string(),
                vec![
                    ("pluginId".to_string(), plugin_id.to_string()),
                    ("key".to_string(), key.to_string()),
                ],
            )
        })
}

/// Revoke every stored value of a plugin BEFORE its rows cascade away (called
/// by the plugin delete/uninstall path). Best-effort per entry: an unreadable
/// store must not block the uninstall from dropping the references.
pub(crate) fn revoke_values(
    store: Option<&Arc<dyn SecretStore>>,
    conn: &Connection,
    plugin_id: &str,
) {
    let Some(store) = store else {
        return;
    };
    let namespace = secret_namespace(plugin_id);
    let mut ids: Vec<String> = Vec::new();
    let mut collected = match conn
        .prepare("SELECT scope, owner_key, key FROM plugin_secrets WHERE plugin_id = ?1")
    {
        Ok(stmt) => stmt,
        Err(err) => {
            eprintln!("plugins.secrets.revoke: prepare failed: {err}");
            return;
        }
    };
    match collected.query_map(params![plugin_id], |row| {
        Ok(format!(
            "{}:{}:{}",
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?
        ))
    }) {
        Ok(rows) => {
            for row in rows.flatten() {
                ids.push(row);
            }
        }
        Err(err) => {
            eprintln!("plugins.secrets.revoke: row scan failed: {err}");
            return;
        }
    }
    for id in ids {
        if let Err(err) = store.delete(&namespace, &id) {
            eprintln!("plugins.secrets.revoke: value revocation failed: {err}");
        }
    }
}
