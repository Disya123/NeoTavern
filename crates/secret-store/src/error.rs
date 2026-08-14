//! SecretStore error model (ТЗ §SEC-01, ADR-0040).
//!
//! Stable machine-readable codes, mirrored 1:1 to the product wire error
//! vocabulary (`SECRET_UNAVAILABLE_ON_THIS_DEVICE` / `SECRET_STORE_READ_ONLY`
//! at the transport boundary; the kernel maps `Locked`/`Corrupt`/`AuthFailed`
//! to `SECRET_UNAVAILABLE_ON_THIS_DEVICE`, `ReadOnly` to
//! `SECRET_STORE_READ_ONLY`). Messages never contain secret values.

/// Stable SecretStore error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretStoreErrorCode {
    /// The store exists but is locked (derived key dropped); re-open or
    /// re-unlock first.
    Locked,
    /// The store file is missing, malformed, or was tampered with (bad
    /// magic/version, AAD mismatch — a header change that would downgrade
    /// the KDF is always detected).
    Corrupt,
    /// The passphrase does not match, or the ciphertext failed
    /// authentication (wrong passphrase or corrupted ciphertext).
    AuthFailed,
    /// The backend is read-only (env provider): writes are refused.
    ReadOnly,
    /// The requested secret does not exist.
    NotFound,
    /// A concurrent write is in progress (mutex held); retry.
    Busy,
    /// No backend is configured (unavailable store). Callers surface this as
    /// `SECRET_UNAVAILABLE_ON_THIS_DEVICE` — never a plaintext fallback.
    Unavailable,
}

impl std::fmt::Display for SecretStoreErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::Locked => "SECRET_STORE_LOCKED",
            Self::Corrupt => "SECRET_STORE_CORRUPT",
            Self::AuthFailed => "SECRET_STORE_AUTH_FAILED",
            Self::ReadOnly => "SECRET_STORE_READ_ONLY",
            Self::NotFound => "SECRET_NOT_FOUND",
            Self::Busy => "SECRET_STORE_BUSY",
            Self::Unavailable => "SECRET_UNAVAILABLE",
        };
        f.write_str(text)
    }
}

/// A SecretStore failure carrying the stable [`SecretStoreErrorCode`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretStoreError {
    pub code: SecretStoreErrorCode,
    pub message: String,
}

impl SecretStoreError {
    pub fn new(code: SecretStoreErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SecretStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SecretStoreError {}

impl From<argon2::Error> for SecretStoreError {
    fn from(err: argon2::Error) -> Self {
        // Argon2 errors are key-derivation failures; a wrong passphrase or an
        // invalid parameter set both surface as auth failures at the boundary.
        Self::new(
            SecretStoreErrorCode::AuthFailed,
            format!("KDF error: {err}"),
        )
    }
}
