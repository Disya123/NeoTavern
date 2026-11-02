//! Plugin KV state (`plugins.state.get|set|delete`, M7 Этап-4 cluster 21
//! part 1).
//!
//! The canonical counterpart of the legacy
//! `/api/v2/plugins/:id/state?scope=…&ownerId=…` store: one STRICT row per
//! `(plugin, scope, owner)` holding the plugin-authored object, a CAS
//! `revision` and the plugin's own `schema_version`.
//!
//! Rules that matter for correctness:
//!
//! - the scope selects the owner AND the capability: `installation`/`user`
//!   are singleton rows (persisted with an empty `owner_key`, reported back as
//!   the empty string because the wire has no nullable field), `workspace` is
//!   the literal `workspace` row, and `chat` requires an explicit owner — a
//!   plugin can never address another chat's state by default;
//! - the plugin must exist and must have been granted `storage.<scope>` at
//!   install (the recorded permission set IS the consent moment), so a plugin
//!   that never asked for the capability is refused instead of silently
//!   writing;
//! - a write is a CAS transition: `expectedRevision` is the revision the
//!   caller observed, `0` means "expect an empty store", and a stale value is
//!   `REVISION_CONFLICT` carrying the current revision, never a silent
//!   overwrite;
//! - the documented key/byte quota applies on write only (existing rows are
//!   never invalidated by a later limit change).
//!
//! Blob storage (`/plugins/:id/blobs*`) stays on the legacy plane for now: the
//! wire has no binary body in v1, so those routes are recorded as transport
//! boundaries in the Этап-4 registry rather than half-modelled here.
use contracts_generated::generated::{
    self, FreeObject, PluginStateScope, RequestPluginsStateGet, RequestPluginsStateSet,
    ResultPluginsState, ResultPluginsStateDelete, ResultPluginsStateSet,
};
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::product::{self, now};
use crate::{KernelError, KernelErrorCode};

/// Top-level keys allowed in one state object (the legacy
/// `DEFAULT_PLUGIN_LIMITS.storage.kvKeys`).
pub(crate) const MAX_STATE_KEYS: usize = 64;
/// UTF-8 bytes allowed in one serialized state object (the legacy
/// `DEFAULT_PLUGIN_LIMITS.storage.kvBytes`).
pub(crate) const MAX_STATE_BYTES: usize = 65536;

/// `VALIDATION` refusal for a semantic rule the wire schema cannot express.
pub(crate) fn validation(detail: &str) -> KernelError {
    KernelError::new(
        KernelErrorCode::ContractViolation,
        format!("plugin state: {detail}"),
    )
}

/// The persisted `owner_key` for a scope (see the module docs).
pub(crate) fn resolve_owner(
    scope: &PluginStateScope,
    owner_id: Option<&str>,
) -> Result<String, KernelError> {
    match scope {
        PluginStateScope::Installation | PluginStateScope::User => {
            // A supplied owner for a singleton scope is a caller bug: refuse
            // instead of quietly writing into a slot the caller did not mean to
            // address.
            if owner_id.is_some() {
                return Err(validation("ownerId is only valid for the chat scope"));
            }
            Ok(String::new())
        }
        PluginStateScope::Workspace => Ok("workspace".to_string()),
        PluginStateScope::Chat => owner_id
            .map(str::to_string)
            .ok_or_else(|| validation("the chat scope requires an ownerId")),
    }
}

/// The capability a scope requires (`storage.<scope>`).
fn scope_capability(scope: &PluginStateScope) -> &'static str {
    match scope {
        PluginStateScope::Installation => "storage.installation",
        PluginStateScope::User => "storage.user",
        PluginStateScope::Workspace => "storage.workspace",
        PluginStateScope::Chat => "storage.chat",
    }
}

/// Scope as it is persisted (the DTO enum's wire name).
pub(crate) fn scope_name(scope: &PluginStateScope) -> &'static str {
    match scope {
        PluginStateScope::Installation => "installation",
        PluginStateScope::User => "user",
        PluginStateScope::Workspace => "workspace",
        PluginStateScope::Chat => "chat",
    }
}

/// Prove the plugin exists and holds `capability` in its recorded grant set.
///
/// The recorded set is what the user consented to at install (ARC-08), so this
/// is the single gate every plugin-scoped family (KV state, secrets, …) shares:
/// a plugin that never asked for the capability is refused instead of being
/// silently served, and an uninstalled plugin is `PLUGIN_NOT_FOUND`.
pub(crate) fn require_capability(
    conn: &Connection,
    plugin_id: &str,
    capability: &str,
) -> Result<(), KernelError> {
    let permissions: Option<String> = conn
        .query_row(
            "SELECT permissions_json FROM plugins WHERE id = ?1",
            params![plugin_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| product::sqlite(e, "plugin: select permissions"))?;
    let Some(permissions) = permissions else {
        return Err(product::not_found("PLUGIN", plugin_id));
    };
    let granted: Vec<String> = serde_json::from_str(&permissions).unwrap_or_default();
    if !granted.iter().any(|permission| permission == capability) {
        return Err(KernelError::product(
            "PLUGIN_PERMISSION_DENIED",
            vec![
                ("pluginId".to_string(), plugin_id.to_string()),
                ("capability".to_string(), capability.to_string()),
            ],
        ));
    }
    Ok(())
}

/// Prove the plugin exists and consented to `storage.<scope>`.
fn require_access(
    conn: &Connection,
    plugin_id: &str,
    scope: &PluginStateScope,
) -> Result<(), KernelError> {
    require_capability(conn, plugin_id, scope_capability(scope))
}

struct StoredRow {
    revision: i64,
    schema_version: i64,
    data_json: String,
    updated_at: String,
}

fn read_row(
    conn: &Connection,
    plugin_id: &str,
    scope: &PluginStateScope,
    owner_key: &str,
) -> Result<Option<StoredRow>, KernelError> {
    conn.query_row(
        "SELECT revision, schema_version, data_json, updated_at FROM plugin_state \
         WHERE plugin_id = ?1 AND scope = ?2 AND owner_key = ?3",
        params![plugin_id, scope_name(scope), owner_key],
        |row| {
            Ok(StoredRow {
                revision: row.get(0)?,
                schema_version: row.get(1)?,
                data_json: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|e| product::sqlite(e, "plugin_state: select row"))
}

fn parse_object(data_json: &str) -> Value {
    // Corruption degrades to an empty object instead of a decode failure: the
    // row is still a legitimate (empty) state for the plugin.
    match serde_json::from_str::<Value>(data_json) {
        Ok(Value::Object(map)) => Value::Object(map),
        _ => Value::Object(serde_json::Map::new()),
    }
}

fn state_not_found(plugin_id: &str) -> KernelError {
    KernelError::product(
        "PLUGIN_STATE_NOT_FOUND",
        vec![("pluginId".to_string(), plugin_id.to_string())],
    )
}

/// `plugins.state.get` — the stored object with its CAS revision;
/// `PLUGIN_STATE_NOT_FOUND` when the scope was never written.
pub(crate) fn state_get(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsStateGet = generated::decode_request_plugins_state_get(request)?;
    let owner_key = resolve_owner(&req.scope, req.owner_id.as_deref())?;
    let conn = db.conn();
    require_access(conn, &req.plugin_id, &req.scope)?;
    let Some(row) = read_row(conn, &req.plugin_id, &req.scope, &owner_key)? else {
        return Err(state_not_found(&req.plugin_id));
    };
    let dto = ResultPluginsState {
        plugin_id: req.plugin_id,
        scope: req.scope.clone(),
        owner_id: owner_key,
        revision: row.revision,
        schema_version: row.schema_version,
        data: FreeObject {
            payload: parse_object(&row.data_json),
        },
        updated_at: row.updated_at,
    };
    product::validate(&dto, generated::validate_result_plugins_state)?;
    product::encode(&dto)
}

/// Outcome of the CAS inside the write transaction: a stored revision, or the
/// observed revision that refused the write.
enum CasOutcome {
    Written(i64),
    Conflict { expected: i64, observed: i64 },
}

/// `plugins.state.set` — whole-value CAS write; `REVISION_CONFLICT` on a stale
/// `expectedRevision`, `STATE_QUOTA_EXCEEDED` before anything is written.
pub(crate) fn state_set(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsStateSet = generated::decode_request_plugins_state_set(request)?;
    let owner_key = resolve_owner(&req.scope, req.owner_id.as_deref())?;
    let data = req.data.payload.clone();
    let Value::Object(map) = &data else {
        // The wire schema guarantees an object; this is a belt-and-braces
        // refusal for a hand-built request.
        return Err(validation("the state must be a JSON object"));
    };
    if map.len() > MAX_STATE_KEYS {
        return Err(KernelError::product(
            "STATE_QUOTA_EXCEEDED",
            vec![
                ("limitKeys".to_string(), MAX_STATE_KEYS.to_string()),
                ("keys".to_string(), map.len().to_string()),
            ],
        ));
    }
    let serialized = data.to_string();
    if serialized.len() > MAX_STATE_BYTES {
        return Err(KernelError::product(
            "STATE_QUOTA_EXCEEDED",
            vec![
                ("limitBytes".to_string(), MAX_STATE_BYTES.to_string()),
                ("bytes".to_string(), serialized.len().to_string()),
            ],
        ));
    }

    let scope = scope_name(&req.scope);
    let plugin_id = req.plugin_id.clone();
    {
        let conn = db.conn();
        require_access(conn, &plugin_id, &req.scope)?;
    }
    let updated_at = now();
    let expected = req.expected_revision;

    let outcome = db
        .transaction(|tx| {
            let observed: Option<i64> = tx
                .query_row(
                    "SELECT revision FROM plugin_state \
                     WHERE plugin_id = ?1 AND scope = ?2 AND owner_key = ?3",
                    params![plugin_id, scope, owner_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|err| StorageError::from_sqlite(err, "plugins.state.set: revision"))?;
            let observed = observed.unwrap_or(0);
            if let Some(expected) = expected {
                if expected != observed {
                    return Ok(CasOutcome::Conflict { expected, observed });
                }
            }
            let next = observed + 1;
            tx.execute(
                "INSERT INTO plugin_state \
                     (plugin_id, scope, owner_key, revision, schema_version, data_json, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6) \
                 ON CONFLICT (plugin_id, scope, owner_key) DO UPDATE SET \
                     revision = excluded.revision, \
                     data_json = excluded.data_json, \
                     updated_at = excluded.updated_at",
                params![plugin_id, scope, owner_key, next, serialized, updated_at],
            )
            .map_err(|err| StorageError::from_sqlite(err, "plugins.state.set: upsert"))?;
            Ok(CasOutcome::Written(next))
        })
        .map_err(KernelError::from)?;

    let revision = match outcome {
        CasOutcome::Written(revision) => revision,
        CasOutcome::Conflict { expected, observed } => {
            return Err(KernelError::product(
                "REVISION_CONFLICT",
                vec![
                    ("expectedRevision".to_string(), expected.to_string()),
                    ("revision".to_string(), observed.to_string()),
                ],
            ));
        }
    };
    let dto = ResultPluginsStateSet {
        revision,
        updated_at,
    };
    product::validate(&dto, generated::validate_result_plugins_state_set)?;
    product::encode(&dto)
}

/// `plugins.state.delete` — idempotent removal of the whole scope row.
pub(crate) fn state_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsStateGet = generated::decode_request_plugins_state_get(request)?;
    let owner_key = resolve_owner(&req.scope, req.owner_id.as_deref())?;
    let conn = db.conn();
    require_access(conn, &req.plugin_id, &req.scope)?;
    let deleted = conn
        .execute(
            "DELETE FROM plugin_state WHERE plugin_id = ?1 AND scope = ?2 AND owner_key = ?3",
            params![req.plugin_id, scope_name(&req.scope), owner_key],
        )
        .map_err(|e| product::sqlite(e, "plugin_state: delete"))?
        > 0;
    let dto = ResultPluginsStateDelete { deleted };
    product::validate(&dto, generated::validate_result_plugins_state_delete)?;
    product::encode(&dto)
}
