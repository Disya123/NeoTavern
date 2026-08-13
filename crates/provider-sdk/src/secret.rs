//! Secret handling seams (§55, §68).
//!
//! Provider configuration separates non-secret settings from **secret
//! references**; the actual value is resolved by a host-provided
//! [`SecretResolver`] (OS keychain on Desktop, Keystore on Android, restricted
//! file/env on Headless) and wrapped in [`SecretValue`], an opaque box whose
//! `Debug` prints `<redacted>`. Values are never serialized, logged, or
//! included in request snapshots, backups or diagnostics.

use crate::{ProviderError, ProviderErrorCode};

/// An opaque reference to a secret stored by the host's secure storage.
///
/// This is what lives in provider configuration rows — never the value.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SecretRef(pub String);

/// An opaque secret value.
///
/// The only accessor is [`SecretValue::expose`], intended for the exact point
/// of use (building a provider request). `Debug` redacts the content so a
/// value cannot leak through `{:?}`/logging paths (§85).
pub struct SecretValue(String);

impl SecretValue {
    /// Wraps a secret value.
    pub fn new(v: impl Into<String>) -> Self {
        Self(v.into())
    }

    /// The raw secret — use only at the point of consumption.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretValue(<redacted>)")
    }
}

/// Host-provided secret resolution seam (§68).
///
/// The kernel holds only a resolver handle, never values. Unavailable/locked
/// secure storage must yield a typed [`ProviderErrorCode::Unavailable`]
/// error — silent plaintext fallback is forbidden (§87).
pub trait SecretResolver: Send + Sync {
    /// Resolves a reference to a value, or a typed error when the secure
    /// store is unavailable, locked, or the reference is unknown.
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ProviderError>;
}

/// A resolver that always fails with `Unavailable` — the safe default when a
/// host provides no secure storage integration.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableSecretResolver;

impl SecretResolver for UnavailableSecretResolver {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        Err(ProviderError::with(
            ProviderErrorCode::Unavailable,
            "secure storage is not available",
            vec![("secretRef".to_string(), reference.0.clone())],
        ))
    }
}
