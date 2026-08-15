//! Canonical Extensions-context registry (ТЗ §8.1 Extensions, §SEC-05,
//! Этап 4 slice 6).
//!
//! The `plugins` table (schema v12) is the DURABLE lifecycle state of one
//! plugin: version, `enabled`, package-trust state and publisher key
//! fingerprint (SEC-05), the GRANTED permission set and the opaque manifest.
//! It holds NO code, NO secrets and NO runtime handles — execution and
//! cleanup live in the isolated host executor behind the versioned
//! capability protocol (ТЗ §14.1); the kernel records what was verified and
//! consented, fail-closed:
//!
//! - `plugins.install` — the host has ALREADY verified the package
//!   (signature + per-file digest, ZIP traversal/symlink/bomb rejection)
//!   before calling this op; the kernel durably records the trust state.
//!   Re-installing the same id+version is idempotent; a version change that
//!   would LOWER the recorded trust rank (the SEC-05 order `built-in`,
//!   `verified-publisher`, `locally-trusted`, `unsigned-untrusted`, most to
//!   least trusted) is rejected with a Conflict (an unsigned package can
//!   never silently downgrade a verified one — SEC-05). The request
//!   `permissions` ARE the granted set: the install/update request is the
//!   consent moment (ARC-08).
//! - `plugins.enable` / `plugins.disable` — lifecycle flag transitions
//!   (idempotent); runtime handler/timer/DOM cleanup on disable is the
//!   executor's job (SEC-06).
//! - `plugins.uninstall` — durable row removal (executor archive cleanup is
//!   host-side).
//! - `plugins.list` — the full registry snapshot.

use contracts_generated::generated::{
    self, PluginsItem, RequestPluginsDisable, RequestPluginsEnable, RequestPluginsInstall,
    RequestPluginsUninstall, ResultPluginsInstall, ResultPluginsList,
};
use neotavern_storage::open::Database;
use rusqlite::OptionalExtension;

use crate::product::now;
use crate::{KernelError, KernelErrorCode};

/// Trust rank for the SEC-05 ordering (higher = more trusted). An install
/// that would lower the recorded rank is rejected. The wire contract pins
/// the four states (`built-in` / `verified-publisher` / `locally-trusted` /
/// `unsigned-untrusted`); anything else is treated as the lowest rank so a
/// corrupted stored value can never be upgraded implicitly.
fn trust_rank(state: &str) -> u8 {
    match state {
        "built-in" => 3,
        "verified-publisher" => 2,
        "locally-trusted" => 1,
        _ => 0,
    }
}

/// `plugins.list` — full registry snapshot, ordered by id.
pub(crate) fn plugins_list(db: &Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, name, version, enabled, manifest_json, permissions_json, \
                    last_error_code, trust_state, publisher_key_id, installed_at, updated_at \
             FROM plugins ORDER BY id",
        )
        .map_err(|err| sqlite(err, "plugins.list: prepare"))?;
    let rows = stmt
        .query_map([], plugin_row)
        .map_err(|err| sqlite(err, "plugins.list: query"))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|err| sqlite(err, "plugins.list: row"))?);
    }
    encode_list(&ResultPluginsList { items })
}

/// `plugins.install` — durable upsert with SEC-05 trust protection.
pub(crate) fn plugins_install(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsInstall = generated::decode_request_plugins_install(request)?;
    let now = now();

    let existing: Option<(String, String)> = db
        .conn()
        .query_row(
            "SELECT version, trust_state FROM plugins WHERE id = ?1",
            rusqlite::params![req.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| sqlite(err, "plugins.install: lookup"))?;

    let permissions_json = serde_json::to_string(&req.permissions).map_err(serialize_error)?;
    let manifest_json = match &req.manifest {
        Some(manifest) => serde_json::to_string(manifest).map_err(serialize_error)?,
        None => "{}".to_string(),
    };
    let publisher_key_id = req.publisher_key_id.clone();
    let trust_state = req.trust_state.to_string();

    match existing {
        None => {
            db.conn()
                .execute(
                    "INSERT INTO plugins \
                     (id, name, version, enabled, manifest_json, permissions_json, \
                      last_error_code, source_json, trust_state, publisher_key_id, \
                      installed_at, updated_at) \
                     VALUES (?1, ?2, ?3, 0, ?4, ?5, NULL, NULL, ?6, ?7, ?8, ?9)",
                    rusqlite::params![
                        req.id,
                        req.name,
                        req.version,
                        manifest_json,
                        permissions_json,
                        trust_state,
                        publisher_key_id,
                        now,
                        now
                    ],
                )
                .map_err(|err| sqlite(err, "plugins.install: insert"))?;
        }
        Some((existing_version, existing_trust)) => {
            if existing_version != req.version {
                // Version change: the trust rank must never drop (SEC-05).
                if trust_rank(&req.trust_state) < trust_rank(&existing_trust) {
                    return Err(trust_downgrade(&req.id, &existing_version));
                }
            }
            db.conn()
                .execute(
                    "UPDATE plugins \
                     SET name = ?2, version = ?3, manifest_json = ?4, permissions_json = ?5, \
                         trust_state = ?6, publisher_key_id = ?7, updated_at = ?8 \
                     WHERE id = ?1",
                    rusqlite::params![
                        req.id,
                        req.name,
                        req.version,
                        manifest_json,
                        permissions_json,
                        trust_state,
                        publisher_key_id,
                        now
                    ],
                )
                .map_err(|err| sqlite(err, "plugins.install: update"))?;
        }
    }

    let plugin = plugin_by_id(db, &req.id)?;
    encode_install(&ResultPluginsInstall { plugin })
}

/// `plugins.enable` — lifecycle flag on (idempotent).
pub(crate) fn plugins_enable(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsEnable = generated::decode_request_plugins_enable(request)?;
    set_enabled(db, &req.id, true)
}

/// `plugins.disable` — lifecycle flag off (idempotent). Runtime cleanup of
/// handlers/timers/DOM/jobs is the isolated executor's job (SEC-06).
pub(crate) fn plugins_disable(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsDisable = generated::decode_request_plugins_disable(request)?;
    set_enabled(db, &req.id, false)
}

/// `plugins.uninstall` — durable row removal.
pub(crate) fn plugins_uninstall(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsUninstall = generated::decode_request_plugins_uninstall(request)?;
    let changed = db
        .conn()
        .execute(
            "DELETE FROM plugins WHERE id = ?1",
            rusqlite::params![req.id],
        )
        .map_err(|err| sqlite(err, "plugins.uninstall: delete"))?;
    if changed == 0 {
        return Err(plugin_not_found(&req.id));
    }
    encode_empty(&generated::ResultEmpty {})
}

// --- helpers --------------------------------------------------------------

fn set_enabled(db: &mut Database, id: &str, enabled: bool) -> Result<Vec<u8>, KernelError> {
    let now = now();
    let changed = db
        .conn()
        .execute(
            "UPDATE plugins SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![id, enabled as i64, now],
        )
        .map_err(|err| sqlite(err, "plugins: set enabled"))?;
    if changed == 0 {
        return Err(plugin_not_found(id));
    }
    let plugin = plugin_by_id(db, id)?;
    encode_plugin(&plugin)
}

fn plugin_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginsItem> {
    let (
        id,
        name,
        version,
        enabled,
        manifest_json,
        permissions_json,
        last_error_code,
        trust_state,
        publisher_key_id,
        installed_at,
        updated_at,
    ) = (
        row.get::<_, String>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, String>(2)?,
        row.get::<_, bool>(3)?,
        row.get::<_, String>(4)?,
        row.get::<_, String>(5)?,
        row.get::<_, Option<String>>(6)?,
        row.get::<_, String>(7)?,
        row.get::<_, Option<String>>(8)?,
        row.get::<_, String>(9)?,
        row.get::<_, String>(10)?,
    );
    let permissions: Vec<String> = serde_json::from_str(&permissions_json).unwrap_or_default();
    let manifest = serde_json::from_str(&manifest_json).ok();
    Ok(PluginsItem {
        id,
        name,
        version,
        enabled,
        trust_state,
        publisher_key_id,
        permissions,
        last_error_code,
        installed_at,
        updated_at,
        manifest,
    })
}

fn plugin_by_id(db: &Database, id: &str) -> Result<PluginsItem, KernelError> {
    db.conn()
        .query_row(
            "SELECT id, name, version, enabled, manifest_json, permissions_json, \
                    last_error_code, trust_state, publisher_key_id, installed_at, updated_at \
             FROM plugins WHERE id = ?1",
            rusqlite::params![id],
            plugin_row,
        )
        .optional()
        .map_err(|err| sqlite(err, "plugins: row lookup"))?
        .ok_or_else(|| plugin_not_found(id))
}

fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StorageFailure, format!("{context}: {err}"))
}

fn serialize_error(err: serde_json::Error) -> KernelError {
    KernelError::new(
        KernelErrorCode::Internal,
        format!("plugins: serialization failed: {err}"),
    )
}

/// Stable `PLUGIN_NOT_FOUND` product error (`pluginId` param).
fn plugin_not_found(id: &str) -> KernelError {
    KernelError::product(
        "PLUGIN_NOT_FOUND".to_string(),
        vec![("pluginId".to_string(), id.to_string())],
    )
}

/// Stable `PLUGIN_TRUST_DOWNGRADE` product error: installing a lower-trust
/// package over an existing version is forbidden without uninstalling first
/// (SEC-05 — an unsigned package can never silently replace a verified one).
fn trust_downgrade(id: &str, existing_version: &str) -> KernelError {
    KernelError::product(
        "PLUGIN_TRUST_DOWNGRADE".to_string(),
        vec![
            ("pluginId".to_string(), id.to_string()),
            ("existingVersion".to_string(), existing_version.to_string()),
        ],
    )
}

fn encode_list(dto: &ResultPluginsList) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_plugins_list)
}

fn encode_install(dto: &ResultPluginsInstall) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_plugins_install)
}

fn encode_plugin(dto: &PluginsItem) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_plugins_item)
}

fn encode_empty(dto: &generated::ResultEmpty) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_empty)
}

fn encode_checked<T: serde::Serialize>(
    dto: &T,
    validate: fn(&serde_json::Value) -> Result<(), Vec<contracts_generated::Issue>>,
) -> Result<Vec<u8>, KernelError> {
    let value = serde_json::to_value(dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("plugins: response serialization failed: {err}"),
        )
    })?;
    validate(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel plugins dto failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    crate::product::encode(&value)
}
