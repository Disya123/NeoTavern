//! Pairing / credential auth for the remote adapter (ТЗ §10, Phase 4
//! hardening / Phase 9).
//!
//! Security posture:
//!
//! - **Scoped, revocable credential, not a master token.** A `pair()` call
//!   issues one random bearer token and returns it exactly once; the store
//!   keeps only its SHA-256 verifier, so a leaked database cannot replay
//!   credentials.
//! - **Bounded.** [`AuthConfig::max_credentials`] caps the store; pairing
//!   beyond the cap fails with [`AuthError::LimitReached`] instead of
//!   growing without bound (§10: bounded credential stores).
//! - **Constant-time verification.** Token comparison folds over the SHA-256
//!   verifier with no early exit, so timing does not leak how many bytes
//!   matched.
//! - **Revocable.** [`PairingStore::revoke`] flips a flag checked on every
//!   verify; long-lived SSE streams re-check the credential per poll batch
//!   and terminate when it is revoked (§10: "SSE ... повторно проверяет
//!   срок действия/revocation credential").
//!
//! The store is deliberately in-memory: the adapter owns no persistent
//! product state (§10 — pairing lives behind the Remote Access boundary, and
//! durable credential persistence is a host concern for Phase 9).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::SystemTime;

use sha2::{Digest, Sha256};

/// Token byte length (32 bytes → 64 hex chars).
const TOKEN_BYTES: usize = 32;
/// Credential id byte length (16 bytes → 32 hex chars).
const ID_BYTES: usize = 16;

/// Pairing configuration: the credential store bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthConfig {
    /// Maximum number of simultaneously live credentials.
    pub max_credentials: usize,
}

/// Why a pairing/auth operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// The credential store is at [`AuthConfig::max_credentials`].
    LimitReached,
    /// The adapter was started without [`RemoteAdapterConfig::auth`] — the
    /// pairing surface is not available.
    AuthDisabled,
    /// `getrandom` failed (OS entropy unavailable) — a startup/issue-time
    /// environment failure, never a payload-driven one.
    EntropyUnavailable,
}

/// One stored credential: id + verifier + lifecycle flags. The raw token is
/// never stored — only its SHA-256 verifier.
#[derive(Debug)]
struct Credential {
    id: String,
    verifier: [u8; 32],
    label: Option<String>,
    created_at: SystemTime,
    revoked: bool,
}

/// A public view of a credential (no token material).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialInfo {
    /// Stable credential id (32 hex chars).
    pub id: String,
    /// Optional human label set at pairing time.
    pub label: Option<String>,
    /// Whether the credential was revoked.
    pub revoked: bool,
    /// When the credential was issued.
    pub created_at: SystemTime,
}

/// Bounded, in-memory pairing store.
pub struct PairingStore {
    max_credentials: usize,
    credentials: Mutex<HashMap<String, Credential>>,
}

impl PairingStore {
    /// A store bounded to `max_credentials` live credentials.
    pub fn new(max_credentials: usize) -> Self {
        Self {
            max_credentials,
            credentials: Mutex::new(HashMap::new()),
        }
    }

    /// Issues a new bearer token. Returns `(id, token)`; the token is
    /// returned exactly once and never stored — only its SHA-256 verifier
    /// is kept. Fails with [`AuthError::LimitReached`] when at capacity.
    pub fn pair(&self, label: Option<String>) -> Result<(String, String), AuthError> {
        let mut token = [0u8; TOKEN_BYTES];
        getrandom::fill(&mut token).map_err(|_| AuthError::EntropyUnavailable)?;
        let mut id_bytes = [0u8; ID_BYTES];
        getrandom::fill(&mut id_bytes).map_err(|_| AuthError::EntropyUnavailable)?;

        let id = hex(&id_bytes);
        let token_hex = hex(&token);

        let mut creds = self
            .credentials
            .lock()
            .expect("pairing store mutex poisoned (adapter bug)");
        if creds.len() >= self.max_credentials {
            return Err(AuthError::LimitReached);
        }
        creds.insert(
            id.clone(),
            Credential {
                id: id.clone(),
                verifier: Sha256::digest(token_hex.as_bytes()).into(),
                label,
                created_at: SystemTime::now(),
                revoked: false,
            },
        );
        Ok((id, token_hex))
    }

    /// Revokes a credential. `false` when the id is unknown (already
    /// revoked ids remain unknown — no oracle for valid-but-revoked vs
    /// never-existed ids beyond the wire id itself, which is not secret).
    pub fn revoke(&self, id: &str) -> bool {
        let mut creds = self
            .credentials
            .lock()
            .expect("pairing store mutex poisoned (adapter bug)");
        match creds.get_mut(id) {
            Some(cred) => {
                cred.revoked = true;
                true
            }
            None => false,
        }
    }

    /// Constant-time check: is `token` a live (unrevoked) credential?
    /// Returns the credential id on success.
    pub fn verify(&self, token: &str) -> Option<String> {
        let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let creds = self
            .credentials
            .lock()
            .expect("pairing store mutex poisoned (adapter bug)");
        let mut matched: Option<&Credential> = None;
        // Constant-time over the whole store: every entry's verifier is
        // folded regardless of match.
        for cred in creds.values() {
            if constant_time_eq(&digest, &cred.verifier) {
                matched = Some(cred);
            }
        }
        matched
            .filter(|cred| !cred.revoked)
            .map(|cred| cred.id.clone())
    }

    /// Whether a credential id is still live (used by SSE streams to
    /// re-check revocation without re-hashing a token).
    pub fn is_live(&self, id: &str) -> bool {
        self.credentials
            .lock()
            .expect("pairing store mutex poisoned (adapter bug)")
            .get(id)
            .map(|cred| !cred.revoked)
            .unwrap_or(false)
    }

    /// Number of stored credentials (for diagnostics).
    pub fn len(&self) -> usize {
        self.credentials
            .lock()
            .expect("pairing store mutex poisoned (adapter bug)")
            .len()
    }

    /// Whether the store holds no credentials at all.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Public snapshot: ids, labels and revocation flags — no token
    /// material ever leaves the store.
    pub fn list(&self) -> Vec<CredentialInfo> {
        self.credentials
            .lock()
            .expect("pairing store mutex poisoned (adapter bug)")
            .values()
            .map(|cred| CredentialInfo {
                id: cred.id.clone(),
                label: cred.label.clone(),
                revoked: cred.revoked,
                created_at: cred.created_at,
            })
            .collect()
    }
}

/// Constant-time byte comparison (both buffers are always 32 bytes, so no
/// length side channel exists).
fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Lowercase hex encoding.
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_returns_token_once_and_verifies() {
        let store = PairingStore::new(4);
        let (id, token) = store.pair(Some("test".to_string())).expect("pair");
        assert_eq!(id.len(), 32);
        assert_eq!(token.len(), 64);
        assert_eq!(store.verify(&token).as_deref(), Some(id.as_str()));
        // The token is not recoverable from the store.
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].label.as_deref() == Some("test"));
    }

    #[test]
    fn revoke_takes_effect_and_wrong_token_rejected() {
        let store = PairingStore::new(4);
        let (_id, token) = store.pair(None).expect("pair");
        assert!(store.verify("deadbeef".repeat(8).as_str()).is_none());
        assert!(store.verify(&token).is_some());
        let mut other = [0u8; TOKEN_BYTES];
        getrandom::fill(&mut other).expect("entropy");
        let other_token = hex(&other);
        assert!(store.verify(&other_token).is_none());
        // Revoke by id.
        let id = store.verify(&token).expect("token live");
        assert!(store.revoke(&id));
        assert!(store.verify(&token).is_none(), "revoked token rejected");
        assert!(!store.is_live(&id));
        // Revoking an existing (already-revoked) credential is idempotent.
        assert!(
            store.revoke(&id),
            "revoke on existing id is idempotent true"
        );
        assert!(
            !store.revoke("00000000000000000000000000000000"),
            "unknown id reports false"
        );
    }

    #[test]
    fn store_is_bounded() {
        let store = PairingStore::new(2);
        store.pair(None).expect("first");
        store.pair(None).expect("second");
        assert_eq!(
            store.pair(None),
            Err(AuthError::LimitReached),
            "third pairing rejected at cap"
        );
    }

    #[test]
    fn constant_time_eq_matches_only_equal() {
        let a = [7u8; 32];
        let b = [7u8; 32];
        let c = [8u8; 32];
        assert!(constant_time_eq(&a, &b));
        assert!(!constant_time_eq(&a, &c));
    }
}
