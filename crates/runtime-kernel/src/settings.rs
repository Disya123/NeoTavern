//! Canonical non-secret settings + SEC-07 diagnostics export
//! (ТЗ §8.1 Configuration, §15 Observability, Этап 4 slice 7).
//!
//! `settings` is a key → JSON-object store for **non-secret** application
//! settings (language, theme, active persona, context strategy, …). Secrets
//! NEVER live here: provider keys live in the SecretStore (ТЗ §9.4, SEC-01),
//! and the table carries no secret material by design.
//!
//! `diagnostics.export` (SEC-07) builds an ALLOWLIST diagnostic bundle:
//! versions, storage meta, the setting COUNT (never values) and
//! generation-run counters. It never includes provider configs, secret
//! references, setting values or message content — redaction is fail-closed
//! by omission. The wire contract pins `redaction: 'allowlist'`, and the
//! kernel tests prove a sentinel secret never reaches the bundle.

use contracts_generated::generated::{
    self, ResultDiagnosticsExport, ResultDiagnosticsExportGenerationRuns,
    ResultDiagnosticsExportSettings, ResultDiagnosticsExportWireVersion, ResultSettings,
    SettingsItem,
};
use neotavern_storage::open::Database;

use crate::{KernelError, KernelErrorCode};

/// Maps a SQLite failure to a kernel error.
fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StorageFailure, format!("{context}: {err}"))
}

/// `settings.get` — reads a subset (`keys`) or the full settings snapshot.
///
/// Request: `wire.request.settings.get` (`{ keys?: string[] }`; absent = all).
/// Response: `wire.result.settings`.
pub(crate) fn settings_get(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_settings_get(request)?;
    let items = match req.keys {
        Some(keys) => query_settings_by_keys(db, &keys)?,
        None => query_all_settings(db)?,
    };
    let dto = ResultSettings { items };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize settings response: {err}"),
        )
    })?;
    generated::validate_result_settings(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel settings dto failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    crate::product::encode(&value)
}

/// `settings.update` — upserts the requested settings transactionally and
/// returns the post-update snapshot of the touched keys.
///
/// Request: `wire.request.settings.update`; response: `wire.result.settings`.
/// Idempotent by design: re-applying the same key/value yields the same row.
pub(crate) fn settings_update(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_settings_update(request)?;

    let conn = db.conn();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| sqlite(e, "settings.update begin transaction"))?;
    let mut keys: Vec<String> = Vec::with_capacity(req.settings.len());
    for item in &req.settings {
        let value_json = serde_json::to_string(&item.value).map_err(|err| {
            KernelError::new(
                KernelErrorCode::Internal,
                format!("settings.update: failed to serialize value: {err}"),
            )
        })?;
        let updated_at = crate::product::now();
        tx.execute(
            "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                             updated_at = excluded.updated_at",
            rusqlite::params![item.key, value_json, updated_at],
        )
        .map_err(|e| sqlite(e, "settings.update upsert"))?;
        keys.push(item.key.clone());
    }
    tx.commit()
        .map_err(|e| sqlite(e, "settings.update commit"))?;

    let items = query_settings_by_keys(db, &keys)?;
    let dto = ResultSettings { items };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize settings response: {err}"),
        )
    })?;
    generated::validate_result_settings(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel settings dto failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    crate::product::encode(&value)
}

/// Runs a `settings` SELECT statement (already bound to the connection) and
/// maps every row through the column reader.
fn collect_rows(
    conn: &rusqlite::Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
    context: &str,
) -> Result<Vec<SettingsItem>, KernelError> {
    let mut stmt = conn.prepare(sql).map_err(|e| sqlite(e, context))?;
    let rows = stmt
        .query_map(params, |row| {
            let key: String = row.get(0)?;
            let value_json: String = row.get(1)?;
            let updated_at: String = row.get(2)?;
            Ok((key, value_json, updated_at))
        })
        .map_err(|e| sqlite(e, context))?;
    let mut items = Vec::new();
    for row in rows {
        let (key, value_json, updated_at) = row.map_err(|e| sqlite(e, context))?;
        let value: serde_json::Value = serde_json::from_str(&value_json).map_err(|err| {
            KernelError::new(
                KernelErrorCode::Internal,
                format!("settings.value_json is not valid JSON: {err}"),
            )
        })?;
        items.push(SettingsItem {
            key,
            // The wire `settings.item` value is a JSON object; the legacy
            // contour stored scalar preferences (e.g. `"ru"` for `language`)
            // as bare JSON scalars, and the legacy conversion copies them
            // verbatim (ADR-0046 waiver 8). Wrap non-object values in the
            // documented scalar form `{ "value": <scalar> }` so the response
            // always validates against the wire contract.
            value: normalize_settings_value(value),
            updated_at,
        });
    }
    Ok(items)
}

/// Maps a stored settings value onto the wire form: JSON objects pass
/// through unchanged, every non-object scalar is wrapped as `{ "value": X }`
/// (the documented scalar representation of `wire.settings.item`).
fn normalize_settings_value(value: serde_json::Value) -> serde_json::Value {
    if value.is_object() {
        value
    } else {
        serde_json::json!({ "value": value })
    }
}

/// Queries the settings table by explicit keys (unknown keys are omitted —
/// the response carries only what exists).
fn query_settings_by_keys(
    db: &mut Database,
    keys: &[String],
) -> Result<Vec<SettingsItem>, KernelError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<String> = keys.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "SELECT key, value_json, updated_at FROM settings WHERE key IN ({}) ORDER BY key",
        placeholders.join(", ")
    );
    let params: Vec<&dyn rusqlite::ToSql> =
        keys.iter().map(|k| k as &dyn rusqlite::ToSql).collect();
    collect_rows(db.conn(), &sql, &params, "settings.get")
}

/// Queries the full settings snapshot.
fn query_all_settings(db: &mut Database) -> Result<Vec<SettingsItem>, KernelError> {
    collect_rows(
        db.conn(),
        "SELECT key, value_json, updated_at FROM settings ORDER BY key",
        &[],
        "settings.get",
    )
}

/// `diagnostics.export` — SEC-07 allowlist diagnostics bundle.
///
/// Request: `wire.request.empty`; response: `wire.result.diagnostics-export`.
/// The bundle is built exclusively from allowlisted counters and metadata —
/// setting VALUES, provider configs, secret refs and message content are
/// never read, so redaction is structural (fail-closed by omission).
pub(crate) fn diagnostics_export(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;

    let conn = db.conn();
    let schema_revision: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| sqlite(e, "diagnostics.export read user_version"))?;
    let storage_format: Option<i64> = conn
        .query_row(
            "SELECT value FROM __neotavern_meta WHERE key = 'storageFormat'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| sqlite(e, "diagnostics.export read storageFormat"))
        .ok()
        .and_then(|v| v.parse::<i64>().ok());
    let settings_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
        .map_err(|e| sqlite(e, "diagnostics.export count settings"))?;
    let runs_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM generation_runs", [], |row| row.get(0))
        .map_err(|e| sqlite(e, "diagnostics.export count runs"))?;
    let runs_completed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_runs WHERE status = 'completed'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| sqlite(e, "diagnostics.export count completed"))?;
    let runs_failed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_runs WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| sqlite(e, "diagnostics.export count failed"))?;
    let runs_waiting: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_runs WHERE pending_tool_call_json IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| sqlite(e, "diagnostics.export count waiting"))?;

    let dto = ResultDiagnosticsExport {
        generated_at: crate::product::now(),
        trace_id: crate::product::new_id(),
        schema_hash: contracts_generated::contract_schema_hash().to_string(),
        schema_revision,
        storage_format,
        sqlite_version: rusqlite::version().to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        wire_version: ResultDiagnosticsExportWireVersion { major: 1, minor: 0 },
        redaction: "allowlist".to_string(),
        sections: vec![
            "meta".to_string(),
            "storage".to_string(),
            "settings".to_string(),
            "generation".to_string(),
        ],
        settings: ResultDiagnosticsExportSettings {
            count: settings_count,
        },
        generation_runs: ResultDiagnosticsExportGenerationRuns {
            total: runs_total,
            completed: runs_completed,
            failed: runs_failed,
            waiting: runs_waiting,
        },
    };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize diagnostics response: {err}"),
        )
    })?;
    generated::validate_result_diagnostics_export(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel diagnostics dto failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    crate::product::encode(&value)
}
