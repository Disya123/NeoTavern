//! Read-only environment-backed store (ТЗ §SEC-01: Headless «явно
//! настроенный environment/file secret provider»).
//!
//! Values come from process environment variables named
//! `NEOTA_SECRET_<namespace>_<id>`; the store resolves references and lists
//! which configured names are present. It never writes anything.

use std::collections::BTreeMap;

use crate::error::{SecretStoreError, SecretStoreErrorCode};
use crate::refs::SecretRefKind;
use crate::traits::{SecretBackendInfo, SecretRecordMeta, SecretStore};

/// Environment-backed read-only store.
#[derive(Debug)]
pub struct EnvSecretStore {
    prefix: String,
    env: BTreeMap<String, String>,
}

impl EnvSecretStore {
    /// `env` is captured at construction (tests inject their own map); the
    /// default prefix is `NEOTA_SECRET_`.
    pub fn new(prefix: impl Into<String>, env: BTreeMap<String, String>) -> Self {
        Self {
            prefix: prefix.into(),
            env,
        }
    }

    /// Builds from the real process environment.
    pub fn from_process(prefix: impl Into<String>) -> Self {
        Self::new(prefix, std::env::vars().collect())
    }

    fn var(&self, namespace: &str, id: &str) -> Option<String> {
        let name = format!("{}{}_{}", self.prefix, namespace, id);
        self.env.get(&name).filter(|v| !v.is_empty()).cloned()
    }

    fn configured_names(&self) -> Vec<String> {
        self.env
            .keys()
            .filter(|name| name.starts_with(&self.prefix))
            .cloned()
            .collect()
    }
}

impl SecretStore for EnvSecretStore {
    fn is_available(&self) -> bool {
        true
    }

    fn describe(&self) -> SecretBackendInfo {
        SecretBackendInfo {
            kind: "env",
            persistent: true,
            writable: false,
            available: true,
            record_count: self.configured_names().len(),
            format_version: None,
        }
    }

    fn put(&self, _namespace: &str, _id: &str, _value: &str) -> Result<String, SecretStoreError> {
        Err(SecretStoreError::new(
            SecretStoreErrorCode::ReadOnly,
            "env store is read-only",
        ))
    }

    fn get(&self, namespace: &str, id: &str) -> Result<Option<String>, SecretStoreError> {
        Ok(self.var(namespace, id))
    }

    fn delete(&self, _namespace: &str, _id: &str) -> Result<bool, SecretStoreError> {
        Ok(false)
    }

    fn list(&self, namespace: &str) -> Result<Vec<SecretRecordMeta>, SecretStoreError> {
        let marker = format!("{}{}_", self.prefix, namespace);
        Ok(self
            .configured_names()
            .into_iter()
            .filter(|name| name.starts_with(&marker))
            .map(|name| SecretRecordMeta {
                id: name[marker.len()..].to_string(),
                created_at: 0,
                updated_at: 0,
            })
            .collect())
    }

    fn has(&self, namespace: &str, id: &str) -> Result<bool, SecretStoreError> {
        Ok(self.var(namespace, id).is_some())
    }

    fn make_ref(&self, kind: SecretRefKind, namespace: &str, id: &str) -> String {
        crate::refs::make_ref(kind, namespace, id)
    }
}
