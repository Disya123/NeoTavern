//! SQLite runtime baseline and connection policy (ТЗ §23, Фаза 2).
//!
//! [`assert_baseline`] enforces the minimum bundled SQLite version, and
//! [`configure_connection`] applies and *verifies* the strict connection
//! policy on every writable connection: foreign keys on, busy timeout set,
//! WAL journal mode, FULL (or NORMAL) synchronous, and `trusted_schema` off.

use rusqlite::types::ValueRef;

use crate::error::{Result, StorageError, StorageErrorCode};
use crate::{DEFAULT_BUSY_TIMEOUT_MS, MAX_BUSY_TIMEOUT_MS};

/// Minimum SQLite library version required by the storage engine (ТЗ §23).
pub const REQUIRED_MIN_SQLITE: &str = "3.51.3";

/// SQLite journal mode used for managed data roots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalMode {
    /// Write-ahead logging — the default for managed data roots.
    Wal,
    /// Legacy rollback journal (DELETE mode).
    Delete,
}

/// Connection configuration applied by [`configure_connection`].
#[derive(Debug, Clone)]
pub struct ConnectionPolicy {
    /// Busy timeout in milliseconds, clamped into `1..=MAX_BUSY_TIMEOUT_MS`.
    pub busy_timeout_ms: u32,
    /// Journal mode; defaults to [`JournalMode::Wal`].
    pub journal_mode: JournalMode,
    /// `PRAGMA synchronous = FULL` when true, NORMAL otherwise. Defaults to
    /// true; false is an explicit opt-in for tests/scratch connections only.
    pub synchronous_full: bool,
}

impl ConnectionPolicy {
    /// Builds a policy, clamping `busy_timeout_ms` into `1..=MAX_BUSY_TIMEOUT_MS`.
    pub fn new(busy_timeout_ms: u32, journal_mode: JournalMode, synchronous_full: bool) -> Self {
        Self {
            busy_timeout_ms: busy_timeout_ms.clamp(1, MAX_BUSY_TIMEOUT_MS),
            journal_mode,
            synchronous_full,
        }
    }
}

impl Default for ConnectionPolicy {
    /// 5000 ms busy timeout, WAL journal mode, FULL synchronous.
    fn default() -> Self {
        Self::new(DEFAULT_BUSY_TIMEOUT_MS, JournalMode::Wal, true)
    }
}

/// The SQLite library version linked into this build (e.g. `"3.53.2"`).
pub fn sqlite_libversion() -> &'static str {
    rusqlite::version()
}

/// Semantic-version compare `version` >= [`REQUIRED_MIN_SQLITE`].
///
/// Only the numeric `major.minor.patch` triple is compared; extra suffixes
/// (`"-alpha"`, `" (bundled)"`, …) and missing patch/minor components are
/// ignored. A version that is unparseable or below the minimum yields
/// [`StorageErrorCode::BaselineViolation`] with `required`/`found` parameters.
pub fn assert_baseline(version: &str) -> Result<()> {
    let required = parse_version_triple(REQUIRED_MIN_SQLITE);
    let found = parse_version_triple(version);
    match (required, found) {
        (Some(req), Some(fnd)) if fnd >= req => Ok(()),
        _ => Err(StorageError::with(
            StorageErrorCode::BaselineViolation,
            format!(
                "SQLite library version {version:?} does not meet the required minimum {REQUIRED_MIN_SQLITE:?}"
            ),
            vec![
                ("required".to_string(), REQUIRED_MIN_SQLITE.to_string()),
                ("found".to_string(), version.to_string()),
            ],
        )),
    }
}

/// Parses `MAJOR.MINOR.PATCH[.suffix…]` into a numeric triple. Missing minor
/// or patch parts default to 0; each part is truncated at the first
/// non-digit; a non-numeric leading part yields `None`.
fn parse_version_triple(version: &str) -> Option<(u32, u32, u32)> {
    let mut parts = version.split('.');
    let mut triple = [0u32; 3];
    for slot in triple.iter_mut() {
        let part = match parts.next() {
            Some(p) => p,
            None => break, // e.g. "3.51" == "3.51.0"
        };
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        *slot = digits.parse().ok()?;
    }
    Some((triple[0], triple[1], triple[2]))
}

/// Applies and verifies the connection policy on `conn`:
///
/// 1. `PRAGMA foreign_keys = ON`; echo must be `1`.
/// 2. `busy_timeout` set to the clamped policy value; echo must equal it.
/// 3. journal mode `WAL` (echo `"wal"`; `"memory"` allowed for in-memory
///    databases) or `DELETE` (echo `"delete"`).
/// 4. synchronous `FULL` (or `NORMAL` when `synchronous_full` is false);
///    echo compared case-insensitively.
/// 5. `PRAGMA trusted_schema = OFF`; echo must be `0`.
///
/// Any echo mismatch is a [`StorageErrorCode::BaselineViolation`]; pragma
/// execution failures are classified via [`StorageError::from_sqlite`].
pub fn configure_connection(conn: &rusqlite::Connection, policy: &ConnectionPolicy) -> Result<()> {
    // 1. Foreign keys ON, verified.
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| StorageError::from_sqlite(e, "configure_connection: foreign_keys"))?;
    let foreign_keys: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "configure_connection: foreign_keys"))?;
    if foreign_keys != 1 {
        return Err(StorageError::with(
            StorageErrorCode::BaselineViolation,
            format!("PRAGMA foreign_keys echo is {foreign_keys}, expected 1"),
            vec![("foreign_keys".to_string(), foreign_keys.to_string())],
        ));
    }

    // 2. Busy timeout, verified by echo.
    let busy_ms = policy.busy_timeout_ms.clamp(1, MAX_BUSY_TIMEOUT_MS);
    conn.busy_timeout(std::time::Duration::from_millis(u64::from(busy_ms)))
        .map_err(|e| StorageError::from_sqlite(e, "configure_connection: busy_timeout"))?;
    let echoed_busy_ms: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "configure_connection: busy_timeout"))?;
    if echoed_busy_ms != i64::from(busy_ms) {
        return Err(StorageError::with(
            StorageErrorCode::BaselineViolation,
            format!("PRAGMA busy_timeout echo is {echoed_busy_ms}, expected {busy_ms}"),
            vec![("busy_timeout_ms".to_string(), busy_ms.to_string())],
        ));
    }

    // 3. Journal mode, verified by echo.
    match policy.journal_mode {
        JournalMode::Wal => {
            let mode: String = conn
                .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
                .map_err(|e| StorageError::from_sqlite(e, "configure_connection: journal_mode"))?;
            // In-memory databases report "memory" instead of "wal"; treat it
            // as the WAL-equivalent for the verification.
            if mode != "wal" && mode != "memory" {
                return Err(StorageError::with(
                    StorageErrorCode::BaselineViolation,
                    format!(
                        "PRAGMA journal_mode returned {mode:?}, expected \"wal\" (or \"memory\" for in-memory databases)"
                    ),
                    vec![("journal_mode".to_string(), mode)],
                ));
            }
        }
        JournalMode::Delete => {
            let mode: String = conn
                .query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))
                .map_err(|e| StorageError::from_sqlite(e, "configure_connection: journal_mode"))?;
            if mode != "delete" {
                return Err(StorageError::with(
                    StorageErrorCode::BaselineViolation,
                    format!("PRAGMA journal_mode returned {mode:?}, expected \"delete\""),
                    vec![("journal_mode".to_string(), mode)],
                ));
            }
        }
    }

    // 4. Synchronous, verified by echo.
    let desired = if policy.synchronous_full {
        "FULL"
    } else {
        "NORMAL"
    };
    conn.pragma_update(None, "synchronous", desired)
        .map_err(|e| StorageError::from_sqlite(e, "configure_connection: synchronous"))?;
    // Bundled SQLite 3.53.2 reports the read form as an integer
    // (safety_level - 1: 0=off 1=normal 2=full 3=extra); normalize it to
    // text so the echo comparison is version-independent.
    let echo = conn
        .query_row("PRAGMA synchronous", [], |row| match row.get_ref(0)? {
            ValueRef::Integer(v) => Ok(match v {
                0 => String::from("off"),
                1 => String::from("normal"),
                2 => String::from("full"),
                3 => String::from("extra"),
                other => format!("unknown({other})"),
            }),
            ValueRef::Text(t) => Ok(String::from_utf8_lossy(t).into_owned()),
            _ => Ok(String::new()),
        })
        .map_err(|e| StorageError::from_sqlite(e, "configure_connection: synchronous"))?;
    let expected = if policy.synchronous_full {
        "full"
    } else {
        "normal"
    };
    if !echo.eq_ignore_ascii_case(expected) {
        return Err(StorageError::with(
            StorageErrorCode::BaselineViolation,
            format!("PRAGMA synchronous echo is {echo:?}, expected {expected:?}"),
            vec![("synchronous".to_string(), echo)],
        ));
    }

    // 5. trusted_schema OFF, verified.
    conn.pragma_update(None, "trusted_schema", "OFF")
        .map_err(|e| StorageError::from_sqlite(e, "configure_connection: trusted_schema"))?;
    let trusted_schema: i64 = conn
        .query_row("PRAGMA trusted_schema", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "configure_connection: trusted_schema"))?;
    if trusted_schema != 0 {
        return Err(StorageError::with(
            StorageErrorCode::BaselineViolation,
            format!("PRAGMA trusted_schema is {trusted_schema}, expected 0"),
            vec![("trusted_schema".to_string(), trusted_schema.to_string())],
        ));
    }

    Ok(())
}

/// Re-verifies `PRAGMA foreign_keys == 1` on a connection.
///
/// Read-only; called after open to catch later tampering with the policy.
pub fn verify_connection(conn: &rusqlite::Connection) -> Result<()> {
    let foreign_keys: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "verify_connection: foreign_keys"))?;
    if foreign_keys != 1 {
        return Err(StorageError::with(
            StorageErrorCode::BaselineViolation,
            format!("PRAGMA foreign_keys is {foreign_keys}, expected 1"),
            vec![("foreign_keys".to_string(), foreign_keys.to_string())],
        ));
    }
    Ok(())
}
