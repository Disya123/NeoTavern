//! Storage error types (ТЗ Фаза 2).
//!
//! A single hand-written error type, [`StorageError`], carries a
//! machine-readable [`StorageErrorCode`], a human-readable message, and a
//! `(key, value)` parameter list for diagnostics. There is deliberately NO
//! blanket `From<rusqlite::Error>` implementation: callers classify SQLite
//! failures explicitly via [`StorageError::from_sqlite`] so every error
//! carries the storage context it happened in.

use std::fmt;

/// Machine-readable classification of a storage failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageErrorCode {
    /// Filesystem/OS-level failure (including unclassified SQLite failures).
    Io,
    /// The data root is already leased by another process.
    DataRootInUse,
    /// SQLite baseline or connection-policy verification failed.
    BaselineViolation,
    /// The database storage format is not supported by this build.
    UnsupportedStorageFormat,
    /// The schema revision is newer than this build understands.
    SchemaTooNew,
    /// The schema revision is older than the minimum directly openable.
    SchemaTooOld,
    /// The migration ledger checksum does not match the declared migration.
    MigrationChecksumMismatch,
    /// A migration failed to apply.
    MigrationFailed,
    /// The database image is corrupt (quick_check/integrity_check failed).
    Corrupt,
    /// The database requires recovery mode before normal use.
    RecoveryRequired,
    /// SQLite reported `SQLITE_BUSY`/`SQLITE_LOCKED` (or an extended busy code).
    Busy,
    /// SQLite reported `SQLITE_FULL` (or the OS reported no-space-left).
    DiskFull,
    /// A managed relative asset key failed validation.
    InvalidAssetKey,
    /// The requested asset does not exist.
    AssetNotFound,
    /// An asset size/quota limit was exceeded.
    QuotaExceeded,
    /// A required record or object does not exist.
    NotFound,
    /// A uniqueness/state conflict (e.g. duplicate asset key or id).
    Conflict,
    /// A database integrity invariant was violated.
    IntegrityViolation,
}

/// A storage error: code + message + diagnostic parameters.
#[derive(Debug, Clone)]
pub struct StorageError {
    /// Machine-readable classification.
    pub code: StorageErrorCode,
    /// Human-readable description.
    pub message: String,
    /// `(key, value)` diagnostic parameters.
    pub params: Vec<(String, String)>,
}

impl StorageError {
    /// Creates an error without parameters.
    pub fn new(code: StorageErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            params: Vec::new(),
        }
    }

    /// Creates an error with diagnostic parameters.
    pub fn with(
        code: StorageErrorCode,
        message: impl Into<String>,
        params: Vec<(String, String)>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            params,
        }
    }

    /// Classifies a `rusqlite` failure in the given storage `context`.
    ///
    /// Classification:
    /// - `SQLITE_BUSY`/`SQLITE_LOCKED` — primary codes 5/6 and extended codes
    ///   261 (`BUSY_RECOVERY`) / 517 (`BUSY_SNAPSHOT`) — map to
    ///   [`StorageErrorCode::Busy`];
    /// - `SQLITE_FULL` (code 13) or an ENOSPC-flavoured failure map to
    ///   [`StorageErrorCode::DiskFull`];
    /// - everything else maps to [`StorageErrorCode::Io`].
    ///
    /// Always adds `("context", context)` and, for `SqliteFailure`,
    /// `("sqlite_code", <extended code>)` parameters (plus the SQLite message
    /// when one is present).
    pub fn from_sqlite(err: rusqlite::Error, context: &str) -> Self {
        use rusqlite::ffi::ErrorCode as SqliteErrorCode;

        const SQLITE_BUSY: i32 = 5;
        const SQLITE_LOCKED: i32 = 6;
        const SQLITE_BUSY_RECOVERY: i32 = 261; // 5 | (1 << 8)
        const SQLITE_BUSY_SNAPSHOT: i32 = 517; // 5 | (2 << 8)
        const SQLITE_FULL: i32 = 13;

        let mut code = StorageErrorCode::Io;
        let mut params = vec![("context".to_string(), context.to_string())];

        if let rusqlite::Error::SqliteFailure(ffi_err, message) = &err {
            let sqlite_code = ffi_err.extended_code;
            params.push(("sqlite_code".to_string(), sqlite_code.to_string()));
            if let Some(msg) = message {
                params.push(("sqlite_message".to_string(), msg.clone()));
            }

            if ffi_err.code == SqliteErrorCode::DatabaseBusy
                || ffi_err.code == SqliteErrorCode::DatabaseLocked
                || matches!(
                    sqlite_code,
                    SQLITE_BUSY | SQLITE_LOCKED | SQLITE_BUSY_RECOVERY | SQLITE_BUSY_SNAPSHOT
                )
            {
                code = StorageErrorCode::Busy;
            } else if ffi_err.code == SqliteErrorCode::DiskFull
                || sqlite_code == SQLITE_FULL
                || message.as_deref().is_some_and(mentions_no_space)
            {
                code = StorageErrorCode::DiskFull;
            }
        }

        StorageError::with(code, format!("{context}: {err}"), params)
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)?;
        if !self.params.is_empty() {
            write!(f, " (")?;
            for (i, (key, value)) in self.params.iter().enumerate() {
                if i > 0 {
                    write!(f, ", ")?;
                }
                write!(f, "{key}={value}")?;
            }
            write!(f, ")")?;
        }
        Ok(())
    }
}

impl std::error::Error for StorageError {}

/// Convenience result alias for storage operations.
///
/// Defaults to [`StorageError`]; the error type stays overridable for precise
/// errors (project rule: defaulted error parameter).
pub type Result<T, E = StorageError> = std::result::Result<T, E>;

/// Wraps an OS I/O failure into a [`StorageError`] with the given context.
pub fn io_err(e: std::io::Error, context: &str) -> StorageError {
    let os_error = match e.raw_os_error() {
        Some(n) => n.to_string(),
        None => String::from("unknown"),
    };
    StorageError::with(
        StorageErrorCode::Io,
        format!("{context}: {e}"),
        vec![
            ("context".to_string(), context.to_string()),
            ("os_error".to_string(), os_error),
        ],
    )
}

/// True when a SQLite message text looks like an OS no-space-left condition:
/// errno 28 / ENOSPC on POSIX, "not enough space" on Windows.
fn mentions_no_space(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("no space left on device")
        || lower.contains("enospc")
        || lower.contains("not enough space")
}
