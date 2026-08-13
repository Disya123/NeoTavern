//! Read-only recovery diagnostics (ТЗ §86, Фаза 2).
//!
//! [`diagnose`] inspects a data root without ever writing to it and classifies
//! its recoverability into a [`RecoveryDiagnosis`] carrying a safe
//! human-readable summary. [`integrity_check`] runs the full
//! `PRAGMA integrity_check` on a read-only connection and returns the result
//! rows.

use std::path::Path;

use rusqlite::Connection;

use crate::error::{Result, StorageError, StorageErrorCode};
use crate::open::{inspect, open_read_only, ReadOnlyDatabase};

/// Read-only summary of a data root's recoverability.
#[derive(Debug, Clone)]
pub struct RecoveryDiagnosis {
    /// Whether the database could be opened read-only for recovery.
    pub openable: bool,
    /// Detected `application_id` (None when absent or not inspectable).
    pub application_id: Option<i32>,
    /// Detected storage format from `__neotavern_meta` (None when unknown).
    pub storage_format: Option<i64>,
    /// Detected schema revision (`PRAGMA user_version`; None when unknown).
    pub schema_revision: Option<i64>,
    /// Migration-ledger checksum state: Some(true) = ok, Some(false) = mismatch,
    /// None = unknown (no tables / not inspectable).
    pub ledger_ok: Option<bool>,
    /// True when `quick_check` != "ok" or a
    /// [`StorageErrorCode::Corrupt`]-classified error occurred.
    pub corrupt: bool,
    /// Safe human-readable summary of the diagnosis; contains no secrets.
    pub message: String,
}

/// Diagnose the data root at `root` without panicking and without writing
/// anything. Uses [`inspect`] and [`open_read_only`]; every failure is
/// classified into the returned struct. A fresh root (no database file) is
/// reported as not openable and not corrupt.
pub fn diagnose(root: &Path) -> RecoveryDiagnosis {
    let mut d = RecoveryDiagnosis {
        openable: false,
        application_id: None,
        storage_format: None,
        schema_revision: None,
        ledger_ok: None,
        corrupt: false,
        message: String::new(),
    };
    let mut reason: Option<String> = None;

    match inspect(root) {
        Ok(ins) => {
            d.application_id = ins.application_id;
            d.storage_format = ins.storage_format;
            d.schema_revision = ins.schema_revision;
            if ins.fresh {
                d.message =
                    "No database file present; the data root is fresh and needs no recovery."
                        .to_string();
                return d;
            }
            d.ledger_ok = Some(ins.checksums_ok);
            match open_read_only(root) {
                Ok(rdb) => match quick_check_ok(rdb.conn()) {
                    Ok(()) => d.openable = true,
                    Err(_) => d.corrupt = true,
                },
                Err(e) => {
                    if e.code == StorageErrorCode::Corrupt {
                        d.corrupt = true;
                    }
                    reason = Some(format!("{:?}: {}", e.code, e.message));
                }
            }
        }
        Err(e) => {
            if e.code == StorageErrorCode::Corrupt {
                d.corrupt = true;
                for (k, v) in &e.params {
                    if k == "application_id" {
                        d.application_id = v.parse::<i32>().ok();
                    }
                }
            }
            reason = Some(format!("{:?}: {}", e.code, e.message));
        }
    }

    d.message = build_message(&d, reason.as_deref());
    d
}

/// Run `PRAGMA integrity_check` on the read-only database and return the
/// result rows (empty/null rows excluded). A healthy database yields
/// `vec!["ok"]`; corruption yields one row per problem.
pub fn integrity_check(db: &ReadOnlyDatabase) -> Result<Vec<String>> {
    let mut stmt = db
        .conn()
        .prepare("PRAGMA integrity_check")
        .map_err(|e| StorageError::from_sqlite(e, "integrity_check: prepare"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "integrity_check: run"))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "integrity_check: step"))?
    {
        if let Some(text) = row
            .get::<_, Option<String>>(0)
            .map_err(|e| StorageError::from_sqlite(e, "integrity_check: read row"))?
        {
            if !text.is_empty() {
                out.push(text);
            }
        }
    }
    Ok(out)
}

/// `PRAGMA quick_check` must return exactly one non-empty row: `"ok"`.
fn quick_check_ok(conn: &Connection) -> Result<()> {
    let mut stmt = conn
        .prepare("PRAGMA quick_check")
        .map_err(|e| StorageError::from_sqlite(e, "prepare quick_check"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "run quick_check"))?;
    let mut results: Vec<String> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "read quick_check row"))?
    {
        if let Some(text) = row
            .get::<_, Option<String>>(0)
            .map_err(|e| StorageError::from_sqlite(e, "read quick_check result"))?
        {
            if !text.is_empty() {
                results.push(text);
            }
        }
    }
    if results == ["ok"] {
        Ok(())
    } else {
        Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "integrity check (quick_check) failed",
            vec![("found".to_string(), results.join(" | "))],
        ))
    }
}

/// Compose the safe human-readable summary from the diagnosis fields.
fn build_message(d: &RecoveryDiagnosis, reason: Option<&str>) -> String {
    if d.corrupt {
        return match reason {
            Some(r) => format!("Database is corrupt or not a NeoTavern database: {r}"),
            None => "Database is corrupt: quick_check failed.".to_string(),
        };
    }
    if d.openable {
        let storage_format = d
            .storage_format
            .map(|v| v.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let schema_revision = d
            .schema_revision
            .map(|v| v.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let ledger = match d.ledger_ok {
            Some(true) => "ok",
            Some(false) => "checksum mismatch",
            None => "unknown",
        };
        return format!(
            "Database is openable and consistent: storage format {storage_format}, schema revision {schema_revision}, migration ledger {ledger}."
        );
    }
    match reason {
        Some(r) => format!("Database exists but could not be opened read-only: {r}"),
        None => "Database exists but could not be opened read-only.".to_string(),
    }
}
