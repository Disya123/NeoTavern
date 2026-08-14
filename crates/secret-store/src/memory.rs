//! Session-only and unavailable backends (ТЗ §SEC-01).
//!
//! Session-only: values exist only in process memory and are gone after
//! restart — the DB keeps an opaque reference and the runtime reports a
//! stable "secret unavailable on this device" state until the user re-enters
//! the key. Unavailable: an explicit configuration error backend that refuses
//! every operation — never a silent plaintext fallback.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{SecretStoreError, SecretStoreErrorCode};
use crate::refs::SecretRefKind;
use crate::traits::{SecretBackendInfo, SecretRecordMeta, SecretStore};

/// Session-only store. Records are keyed by `namespace\0id` so namespaces
/// never collide.
#[derive(Debug)]
pub struct MemorySecretStore {
    records: Mutex<HashMap<String, (String, i64, i64)>>,
    now: fn() -> i64,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
            now: || {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0)
            },
        }
    }

    fn key(namespace: &str, id: &str) -> String {
        format!("{namespace}\u{0}{id}")
    }
}

impl Default for MemorySecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for MemorySecretStore {
    fn is_available(&self) -> bool {
        true
    }

    fn describe(&self) -> SecretBackendInfo {
        SecretBackendInfo {
            kind: "session",
            persistent: false,
            writable: true,
            available: true,
            record_count: self.records.lock().map(|r| r.len()).unwrap_or(0),
            format_version: None,
        }
    }

    fn put(&self, namespace: &str, id: &str, value: &str) -> Result<String, SecretStoreError> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| SecretStoreError::new(SecretStoreErrorCode::Busy, "store busy"))?;
        let now = (self.now)();
        records.insert(Self::key(namespace, id), (value.to_string(), now, now));
        Ok(self.make_ref(SecretRefKind::Session, namespace, id))
    }

    fn get(&self, namespace: &str, id: &str) -> Result<Option<String>, SecretStoreError> {
        let records = self
            .records
            .lock()
            .map_err(|_| SecretStoreError::new(SecretStoreErrorCode::Busy, "store busy"))?;
        Ok(records
            .get(&Self::key(namespace, id))
            .map(|(value, _, _)| value.clone()))
    }

    fn delete(&self, namespace: &str, id: &str) -> Result<bool, SecretStoreError> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| SecretStoreError::new(SecretStoreErrorCode::Busy, "store busy"))?;
        Ok(records.remove(&Self::key(namespace, id)).is_some())
    }

    fn list(&self, namespace: &str) -> Result<Vec<SecretRecordMeta>, SecretStoreError> {
        let records = self
            .records
            .lock()
            .map_err(|_| SecretStoreError::new(SecretStoreErrorCode::Busy, "store busy"))?;
        let prefix = format!("{namespace}\u{0}");
        Ok(records
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(key, (_, created, updated))| SecretRecordMeta {
                id: key[prefix.len()..].to_string(),
                created_at: *created,
                updated_at: *updated,
            })
            .collect())
    }

    fn has(&self, namespace: &str, id: &str) -> Result<bool, SecretStoreError> {
        let records = self
            .records
            .lock()
            .map_err(|_| SecretStoreError::new(SecretStoreErrorCode::Busy, "store busy"))?;
        Ok(records.contains_key(&Self::key(namespace, id)))
    }

    fn make_ref(&self, kind: SecretRefKind, namespace: &str, id: &str) -> String {
        crate::refs::make_ref(kind, namespace, id)
    }

    fn clear(&self) {
        if let Ok(mut records) = self.records.lock() {
            records.clear();
        }
    }
}

/// Explicit "no backend" store: every operation fails with `Unavailable`.
/// The runtime maps this to `SECRET_UNAVAILABLE_ON_THIS_DEVICE` at the
/// boundary — plaintext is never stored anywhere.
#[derive(Debug, Default)]
pub struct UnavailableSecretStore;

impl SecretStore for UnavailableSecretStore {
    fn is_available(&self) -> bool {
        false
    }

    fn describe(&self) -> SecretBackendInfo {
        SecretBackendInfo {
            kind: "unavailable",
            persistent: false,
            writable: false,
            available: false,
            record_count: 0,
            format_version: None,
        }
    }

    fn put(&self, _namespace: &str, _id: &str, _value: &str) -> Result<String, SecretStoreError> {
        Err(SecretStoreError::new(
            SecretStoreErrorCode::Unavailable,
            "no secret backend is configured",
        ))
    }

    fn get(&self, _namespace: &str, _id: &str) -> Result<Option<String>, SecretStoreError> {
        Err(SecretStoreError::new(
            SecretStoreErrorCode::Unavailable,
            "no secret backend is configured",
        ))
    }

    fn delete(&self, _namespace: &str, _id: &str) -> Result<bool, SecretStoreError> {
        Err(SecretStoreError::new(
            SecretStoreErrorCode::Unavailable,
            "no secret backend is configured",
        ))
    }

    fn list(&self, _namespace: &str) -> Result<Vec<SecretRecordMeta>, SecretStoreError> {
        Err(SecretStoreError::new(
            SecretStoreErrorCode::Unavailable,
            "no secret backend is configured",
        ))
    }

    fn has(&self, _namespace: &str, _id: &str) -> Result<bool, SecretStoreError> {
        Err(SecretStoreError::new(
            SecretStoreErrorCode::Unavailable,
            "no secret backend is configured",
        ))
    }

    fn make_ref(&self, _kind: SecretRefKind, namespace: &str, id: &str) -> String {
        // Mirrors the legacy port: an inert session-shaped ref. `put` always
        // fails, so this is never persisted; keep it parseable so nothing
        // malformed can reach the DB.
        crate::refs::make_ref(SecretRefKind::Session, namespace, id)
    }
}
