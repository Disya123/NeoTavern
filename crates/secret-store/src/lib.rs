//! NeoTavern SecretStore port (ТЗ §SEC-01, ADR-0040).
//!
//! Explicit backends only — there is never a silent plaintext fallback:
//!
//! - [`FileEncryptedSecretStore`] — portable `secrets.enc` v2: AES-256-GCM
//!   with an Argon2id-derived key, authenticated header (a tampered header
//!   can never downgrade the KDF), fresh nonce per write, atomic writes,
//!   machine-independent key derivation, `lock()` and staged re-encryption;
//! - [`MemorySecretStore`] — session-only values (gone after restart);
//! - [`EnvSecretStore`] — read-only `NEOTA_SECRET_*` provider for headless;
//! - [`UnavailableSecretStore`] — explicit no-backend error backend;
//! - [`OsVaultSecretStore`] — machine-bound OS credential vault (Windows
//!   Credential Manager / macOS Keychain / Linux Secret Service, `os-vault`
//!   feature); credentials do not travel with the data folder.
//!
//! The database stores only opaque references ([`parse_ref`] /
//! [`make_ref`]): `portable:<namespace>:<id>`, `session:<namespace>:<id>`,
//! `env:<namespace>:<id>`, `osvault:<namespace>:<id>` — never values.

pub mod env;
pub mod error;
pub mod file;
pub mod memory;
pub mod refs;
pub mod traits;

#[cfg(feature = "os-vault")]
pub mod os_vault;

pub use env::EnvSecretStore;
pub use error::{SecretStoreError, SecretStoreErrorCode};
pub use file::{FileEncryptedSecretStore, FORMAT_VERSION, MAGIC};
pub use memory::{MemorySecretStore, UnavailableSecretStore};
pub use refs::{make_ref, parse_ref, SecretRef, SecretRefKind};
pub use traits::{SecretBackendInfo, SecretRecordMeta, SecretStore};

#[cfg(feature = "os-vault")]
pub use os_vault::OsVaultSecretStore;
