//! `secrets.enc` v1 → v2 converter (ADR-0040 §3).
//!
//! The legacy contour (packages/secret-store, scrypt) wrote format v1; the
//! kernel store reads v2 only (Argon2id). This module is the explicit,
//! fail-closed bridge the v2 reader's rejection message names: it decrypts a
//! v1 file with the master passphrase and writes a v2 file seeded with the
//! SAME records (values and timestamps preserved).
//!
//! v1 on-disk layout (all multi-byte integers big-endian, per the legacy
//! contour's `file.ts`):
//!
//! ```text
//! offset  size  field
//! 0       8     magic        ASCII "NEOTASEC"
//! 8       4     formatVer    = 1
//! 12      1     kdfId        = 1 (scrypt)
//! 13      4     scrypt N     (from the header, authenticated)
//! 17      1     scrypt r
//! 18      1     scrypt p
//! 19      16    salt
//! 35      12    nonce
//! 47      …     ciphertext   AES-256-GCM, tag appended
//! ```
//!
//! AAD = header bytes `[0, 35)` (magic … salt). The key is scrypt(passphrase,
//! salt, 32 bytes, N/r/p from the header) — the header parameters are used as
//! written, never downgraded.
//!
//! Safety properties (user-data preservation first):
//!
//! - the v1 file is NEVER modified or deleted — the converter only reads it;
//! - the v2 target is never overwritten: an existing target fails with
//!   `Corrupt` before anything is written;
//! - a wrong v1 passphrase or any tampering fails closed (`AuthFailed` /
//!   `Corrupt`) with no output file;
//! - the v2 write reuses the store's staged path (temp sibling + verify +
//!   atomic rename).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit as _, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use scrypt::scrypt;
use serde::Deserialize;
use zeroize::Zeroizing;

use crate::error::{SecretStoreError, SecretStoreErrorCode};
use crate::file::{FileEncryptedSecretStore, Record, MAGIC, NONCE_LEN, SALT_LEN};

/// v1 `kdfId` (scrypt).
const KDF_ID_SCRYPT: u8 = 1;
/// v1 authenticated header length (magic … salt).
const V1_AAD_LEN: usize = 8 + 4 + 1 + 4 + 1 + 1 + SALT_LEN;
/// v1 full header length (AAD + nonce).
const V1_HEADER_LEN: usize = V1_AAD_LEN + NONCE_LEN;

/// One decrypted v1 record — the same shape v2 stores (`value` plus the
/// millisecond timestamps), preserved verbatim by the conversion.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct V1Record {
    pub value: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

/// Decrypted v1 records: `namespace → id → record`.
pub type V1Records = BTreeMap<String, BTreeMap<String, V1Record>>;

/// Parsed v1 header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V1Header {
    pub scrypt_n: u32,
    pub scrypt_r: u8,
    pub scrypt_p: u8,
    pub salt: [u8; SALT_LEN],
    pub nonce: [u8; NONCE_LEN],
}

/// Parses and authenticates-adjacent fields of the v1 header. Format/KDF
/// mismatches are `Corrupt` — the converter never guesses parameters.
fn parse_v1_header(bytes: &[u8]) -> Result<V1Header, SecretStoreError> {
    if bytes.len() < V1_HEADER_LEN {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            "legacy secrets file header is truncated",
        ));
    }
    if &bytes[0..8] != MAGIC {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            "not a NeoTavern secrets file (bad magic)",
        ));
    }
    let version = u32::from_be_bytes(bytes[8..12].try_into().expect("4 bytes"));
    if version != 1 {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!("not a legacy v1 secrets file (formatVer {version})"),
        ));
    }
    if bytes[12] != KDF_ID_SCRYPT {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!("unsupported legacy KDF id {}", bytes[12]),
        ));
    }
    let scrypt_n = u32::from_be_bytes(bytes[13..17].try_into().expect("4 bytes"));
    if scrypt_n == 0 || !scrypt_n.is_power_of_two() {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!("invalid legacy scrypt N {scrypt_n}"),
        ));
    }
    if bytes[17] == 0 || bytes[18] == 0 {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            "invalid legacy scrypt r/p (zero)",
        ));
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[19..V1_AAD_LEN]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[V1_AAD_LEN..V1_HEADER_LEN]);
    Ok(V1Header {
        scrypt_n,
        scrypt_r: bytes[17],
        scrypt_p: bytes[18],
        salt,
        nonce,
    })
}

/// Derives the v1 AES-256 key with the header's authenticated scrypt
/// parameters. Scrypt failures are `AuthFailed` (parameter/out-length
/// problems cannot be caused by user input here). The accepted legacy
/// parameterization (N=32768, r=8) needs a 32 MiB work area;
/// `scrypt::Params::new` validates the parameter bounds itself.
fn derive_v1_key(
    passphrase: &str,
    header: &V1Header,
) -> Result<Zeroizing<Vec<u8>>, SecretStoreError> {
    let log_n = (31 - header.scrypt_n.leading_zeros()) as u8;
    let params = scrypt::Params::new(
        log_n,
        u32::from(header.scrypt_r),
        u32::from(header.scrypt_p),
        32,
    )
    .map_err(|err| {
        SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!("invalid legacy scrypt parameters: {err}"),
        )
    })?;
    let mut key = Zeroizing::new(vec![0u8; 32]);
    scrypt(
        passphrase.as_bytes(),
        &header.salt,
        &params,
        key.as_mut_slice(),
    )
    .map_err(|err| {
        SecretStoreError::new(
            SecretStoreErrorCode::AuthFailed,
            format!("legacy scrypt derivation failed: {err}"),
        )
    })?;
    Ok(key)
}

/// Decrypts the v1 payload. Distinguishes a wrong passphrase / corrupted
/// ciphertext (`AuthFailed`) from header damage (`Corrupt`).
fn decrypt_v1(bytes: &[u8], passphrase: &str) -> Result<V1Records, SecretStoreError> {
    let header = parse_v1_header(bytes)?;
    let key = derive_v1_key(passphrase, &header)?;
    let ciphertext = &bytes[V1_HEADER_LEN..];
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|err| {
        SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!("invalid derived key: {err}"),
        )
    })?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&header.nonce),
            Payload {
                msg: ciphertext,
                aad: &bytes[..V1_AAD_LEN],
            },
        )
        .map_err(|_| {
            SecretStoreError::new(
                SecretStoreErrorCode::AuthFailed,
                "legacy passphrase mismatch or corrupted legacy file",
            )
        })?;
    #[derive(Deserialize)]
    struct V1Payload {
        format: String,
        version: u32,
        records: V1Records,
    }
    let payload: V1Payload = serde_json::from_slice(&plaintext).map_err(|err| {
        SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!("legacy secrets payload is not valid JSON: {err}"),
        )
    })?;
    if payload.format != "neotavern-secrets" || payload.version != 1 {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!(
                "legacy secrets payload mismatch (format {}, version {})",
                payload.format, payload.version
            ),
        ));
    }
    Ok(payload.records)
}

/// Reads a legacy v1 `secrets.enc` and returns its decrypted records
/// (diagnostics/migration-report surface — never a kernel store).
pub fn read_v1_records(path: &Path, passphrase: &str) -> Result<V1Records, SecretStoreError> {
    let bytes = fs::read(path).map_err(|err| {
        SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!("cannot read legacy secrets file {}: {err}", path.display()),
        )
    })?;
    decrypt_v1(&bytes, passphrase)
}

/// Converts a legacy v1 `secrets.enc` into a canonical v2 file (ADR-0040 §3).
///
/// The v1 file is read-only for this function and is left in place (it stays
/// the operator's pre-conversion backup). The v2 target must not exist — an
/// existing file fails with `Corrupt` and is never overwritten. Returns the
/// converted record count.
pub fn convert_v1_file(
    v1_path: &Path,
    v1_passphrase: &str,
    v2_path: &Path,
    v2_passphrase: &str,
) -> Result<usize, SecretStoreError> {
    let records = read_v1_records(v1_path, v1_passphrase)?;
    let count: usize = records.values().map(BTreeMap::len).sum();
    if v2_path.exists() {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!(
                "conversion target {} already exists — refusing to overwrite",
                v2_path.display()
            ),
        ));
    }
    let seeded: BTreeMap<String, BTreeMap<String, Record>> = records
        .into_iter()
        .map(|(namespace, entries)| {
            (
                namespace,
                entries
                    .into_iter()
                    .map(|(id, record)| {
                        (
                            id,
                            Record {
                                value: record.value,
                                created_at: record.created_at,
                                updated_at: record.updated_at,
                            },
                        )
                    })
                    .collect(),
            )
        })
        .collect();
    let store = FileEncryptedSecretStore::new(v2_path);
    store.create_seeded(v2_passphrase, &seeded)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Builds a legacy v1 file exactly the way the TS contour does.
    fn write_v1_fixture(
        path: &Path,
        passphrase: &str,
        records: &BTreeMap<String, BTreeMap<String, (String, i64, i64)>>,
    ) {
        use rand::RngCore;
        let mut salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let mut nonce = [0u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce);

        let log_n = 15u8; // N = 32768
        let params = scrypt::Params::new(log_n, 8, 1, 32).expect("params");
        let mut key = vec![0u8; 32];
        scrypt(passphrase.as_bytes(), &salt, &params, &mut key).expect("derive");

        let mut header = Vec::with_capacity(V1_HEADER_LEN);
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&1u32.to_be_bytes());
        header.push(KDF_ID_SCRYPT);
        header.extend_from_slice(&32768u32.to_be_bytes());
        header.push(8u8);
        header.push(1u8);
        header.extend_from_slice(&salt);
        header.extend_from_slice(&nonce);
        debug_assert_eq!(header.len(), V1_HEADER_LEN);

        let mut payload = BTreeMap::new();
        for (namespace, entries) in records {
            let mut scope = BTreeMap::new();
            for (id, (value, created_at, updated_at)) in entries {
                scope.insert(
                    id.clone(),
                    serde_json::json!({
                        "value": value,
                        "createdAt": created_at,
                        "updatedAt": updated_at,
                    }),
                );
            }
            payload.insert(namespace.clone(), scope);
        }
        let plaintext = serde_json::to_vec(&serde_json::json!({
            "format": "neotavern-secrets",
            "version": 1,
            "records": payload,
        }))
        .expect("payload json");

        let cipher = Aes256Gcm::new_from_slice(&key).expect("key");
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: &header[..V1_AAD_LEN],
                },
            )
            .expect("encrypt");
        let mut file = header;
        file.extend_from_slice(&ciphertext);
        fs::write(path, file).expect("write fixture");
    }

    #[test]
    fn converts_v1_to_v2_preserving_values_and_timestamps() {
        use crate::traits::SecretStore as _;

        let temp = tempfile::tempdir().expect("tempdir");
        let v1 = temp.path().join("v1.enc");
        let v2 = temp.path().join("v2.enc");
        let mut records: BTreeMap<String, BTreeMap<String, (String, i64, i64)>> = BTreeMap::new();
        let mut scope = BTreeMap::new();
        scope.insert("local".to_string(), ("sk-sentinel-1".to_string(), 111, 222));
        scope.insert(
            "backup".to_string(),
            ("sk-sentinel-2".to_string(), 333, 444),
        );
        records.insert("provider:openai".to_string(), scope);

        write_v1_fixture(&v1, "legacy-pass", &records);
        let count = convert_v1_file(&v1, "legacy-pass", &v2, "new-pass").expect("converts");
        assert_eq!(count, 2, "two records converted");
        assert!(v1.exists(), "the v1 file is left in place as the backup");

        let store = FileEncryptedSecretStore::new(&v2);
        store.open("new-pass").expect("v2 opens");
        assert_eq!(
            store
                .get("provider:openai", "local")
                .expect("get")
                .as_deref(),
            Some("sk-sentinel-1")
        );
        assert_eq!(
            store
                .get("provider:openai", "backup")
                .expect("get")
                .as_deref(),
            Some("sk-sentinel-2")
        );
        let mut listed = store.list("provider:openai").expect("list");
        listed.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(listed.len(), 2, "both records listed");
        assert_eq!(listed[0].id, "backup");
        assert_eq!(listed[0].created_at, 333, "createdAt preserved");
        assert_eq!(listed[0].updated_at, 444, "updatedAt preserved");
        assert_eq!(listed[1].id, "local");
        assert_eq!(listed[1].created_at, 111, "createdAt preserved");
        assert_eq!(listed[1].updated_at, 222, "updatedAt preserved");
    }

    #[test]
    fn wrong_v1_passphrase_fails_without_writing_the_target() {
        let temp = tempfile::tempdir().expect("tempdir");
        let v1 = temp.path().join("v1.enc");
        let v2 = temp.path().join("v2.enc");
        write_v1_fixture(&v1, "legacy-pass", &BTreeMap::new());
        let err = convert_v1_file(&v1, "wrong", &v2, "new-pass").expect_err("fails");
        assert_eq!(err.code, SecretStoreErrorCode::AuthFailed, "{err}");
        assert!(!v2.exists(), "no output file on failure");
    }

    #[test]
    fn existing_v2_target_is_never_overwritten() {
        let temp = tempfile::tempdir().expect("tempdir");
        let v1 = temp.path().join("v1.enc");
        let v2 = temp.path().join("v2.enc");
        write_v1_fixture(&v1, "legacy-pass", &BTreeMap::new());
        fs::write(&v2, b"precious existing v2").expect("existing target");

        let err = convert_v1_file(&v1, "legacy-pass", &v2, "new-pass").expect_err("refuses");
        assert_eq!(err.code, SecretStoreErrorCode::Corrupt, "{err}");
        assert_eq!(
            fs::read(&v2).expect("read"),
            b"precious existing v2",
            "target untouched"
        );
    }

    #[test]
    fn tampered_v1_header_fails_closed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let v1 = temp.path().join("v1.enc");
        let v2 = temp.path().join("v2.enc");
        write_v1_fixture(&v1, "legacy-pass", &BTreeMap::new());

        // Flip a bit inside the AAD (the scrypt N field). The converter must
        // fail closed with no output file — the precise stable code depends
        // on whether the flipped value is still a valid parameter (here it
        // is not: Corrupt from parameter validation; a valid-but-different
        // N would surface AuthFailed from the GCM tag check).
        let mut bytes = fs::read(&v1).expect("read");
        bytes[13] ^= 0x01;
        fs::write(&v1, &bytes).expect("write tampered");

        let err = convert_v1_file(&v1, "legacy-pass", &v2, "new-pass").expect_err("fails");
        assert!(
            err.code == SecretStoreErrorCode::Corrupt
                || err.code == SecretStoreErrorCode::AuthFailed,
            "{err}"
        );
        assert!(!v2.exists());
    }

    #[test]
    fn v2_file_masquerading_as_v1_is_refused() {
        let temp = tempfile::tempdir().expect("tempdir");
        let v2 = temp.path().join("v2.enc");
        let target = temp.path().join("out.enc");
        let store = FileEncryptedSecretStore::new(&v2);
        store.create("some-pass").expect("create v2");

        let err = convert_v1_file(&v2, "some-pass", &target, "new-pass").expect_err("refused");
        assert_eq!(err.code, SecretStoreErrorCode::Corrupt, "{err}");
        assert!(!target.exists());
    }

    #[test]
    fn read_v1_records_surfaces_the_payload_for_migration_reports() {
        let temp = tempfile::tempdir().expect("tempdir");
        let v1 = temp.path().join("v1.enc");
        let mut records: BTreeMap<String, BTreeMap<String, (String, i64, i64)>> = BTreeMap::new();
        let mut scope = BTreeMap::new();
        scope.insert("local".to_string(), ("sk-x".to_string(), 1, 2));
        records.insert("provider:openai".to_string(), scope);
        write_v1_fixture(&v1, "legacy-pass", &records);

        let read = read_v1_records(&v1, "legacy-pass").expect("reads");
        let record = read
            .get("provider:openai")
            .and_then(|scope| scope.get("local"))
            .expect("record present");
        assert_eq!(record.value, "sk-x");
        assert_eq!(record.created_at, 1);
    }
}
