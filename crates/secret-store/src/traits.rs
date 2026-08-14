//! The `SecretStore` port contract (ТЗ §5.1 Ports, §SEC-01, ADR-0040).
//!
//! Every backend implements this trait. Implementations never log, serialize
//! or expose values except through [`SecretStore::get`]; the caller wraps
//! returned values in `provider_sdk::secret::SecretValue` at the point of
//! use.

use crate::error::SecretStoreError;
use crate::refs::SecretRefKind;

/// A stored secret record's metadata (no value).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretRecordMeta {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Verifiable backend metadata — never contains secret values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretBackendInfo {
    pub kind: &'static str,
    pub persistent: bool,
    pub writable: bool,
    pub available: bool,
    pub record_count: usize,
    /// Portable-only: the on-disk format version (`None` for other kinds).
    pub format_version: Option<u32>,
}

/// The SecretStore port.
pub trait SecretStore: Send + Sync {
    /// Whether the backend can currently serve reads (and writes).
    fn is_available(&self) -> bool;

    /// Verifiable metadata for diagnostics (no values).
    fn describe(&self) -> SecretBackendInfo;

    /// Stores `value` under `namespace`/`id` and returns the opaque
    /// reference the caller persists in the database.
    fn put(&self, namespace: &str, id: &str, value: &str) -> Result<String, SecretStoreError>;

    /// Resolves a stored value; `None` when the record does not exist.
    fn get(&self, namespace: &str, id: &str) -> Result<Option<String>, SecretStoreError>;

    /// Removes a record. Returns `false` when it did not exist.
    fn delete(&self, namespace: &str, id: &str) -> Result<bool, SecretStoreError>;

    /// Lists record metadata for a namespace (no values).
    fn list(&self, namespace: &str) -> Result<Vec<SecretRecordMeta>, SecretStoreError>;

    /// Whether the record exists.
    fn has(&self, namespace: &str, id: &str) -> Result<bool, SecretStoreError>;

    /// Renders the opaque reference for `namespace`/`id`.
    fn make_ref(&self, kind: SecretRefKind, namespace: &str, id: &str) -> String;

    /// Drops derived key material in memory (portable backend). Other
    /// backends no-op. Read/write after `lock()` fail with `Locked`.
    fn lock(&self) {}

    /// Re-encrypts a portable store with a new passphrase (staged: the new
    /// file is verified before the old one is replaced). Non-portable
    /// backends return `Err(ReadOnly)`.
    fn re_encrypt(&self, _new_passphrase: &str) -> Result<(), SecretStoreError> {
        Err(crate::error::SecretStoreError::new(
            crate::error::SecretStoreErrorCode::ReadOnly,
            "backend does not support re-encryption",
        ))
    }

    /// Best-effort cleanup of any process-wide resources. Default: no-op.
    fn clear(&self) {}
}
