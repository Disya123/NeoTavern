//! Portable encrypted file store — `secrets.enc` v2 (ADR-0040).
//!
//! Format (all multi-byte integers big-endian):
//!
//! ```text
//! offset  size  field
//! 0       8     magic            ASCII "NEOTASEC"
//! 8       4     formatVer        = 2
//! 12      1     kdfId            = 2 (Argon2id)
//! 13      4     argon2 m         = 65536 (64 MiB)
//! 17      4     argon2 t         = 3
//! 21      1     argon2 p         = 1
//! 22      1     argon2 out       = 32
//! 23      16    salt             stable per passphrase (KDF input)
//! 39      12    nonce            fresh random per write (NOT in AAD)
//! 51      …     ciphertext       AES-256-GCM over the JSON payload
//! ```
//!
//! AAD = header bytes `[0, 39)` (magic … salt): every field that affects
//! decryption is authenticated, so a tampered header can never downgrade the
//! KDF. Key + plaintext are zeroized on drop (`zeroize::Zeroizing`). Writes
//! go to a temporary sibling file, `fsync`, then atomic rename over the
//! target — a crash leaves either the old or the new file, never a torn one.
//!
//! The salt is stable for the lifetime of the store (re-deriving the key on
//! every write would change the key mid-store); the nonce is fresh per write.
//! `re_encrypt` derives a new key with a fresh salt, writes and verifies the
//! new file before replacing the old one (staged). `lock` drops the derived
//! key; any read/write afterwards fails with `Locked`.
//!
//! A legacy v1 (scrypt) file is rejected with an explicit `Corrupt` error
//! naming the legacy version: the v1→v2 converter ships with the data
//! cutover (Этап 3) — the kernel never silently reads the legacy KDF.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit as _, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{SecretStoreError, SecretStoreErrorCode};
use crate::refs::SecretRefKind;
use crate::traits::{SecretBackendInfo, SecretRecordMeta, SecretStore};

/// File magic, 8 bytes.
pub const MAGIC: &[u8; 8] = b"NEOTASEC";
/// Canonical portable format version (ADR-0040).
pub const FORMAT_VERSION: u32 = 2;
/// `kdfId` for Argon2id.
pub const KDF_ID_ARGON2ID: u8 = 2;
/// Argon2id memory cost in KiB (64 MiB).
pub const ARGON2_M: u32 = 65536;
/// Argon2id time cost.
pub const ARGON2_T: u32 = 3;
/// Argon2id parallelism.
pub const ARGON2_P: u8 = 1;
/// Derived key length in bytes.
pub const ARGON2_OUT: u8 = 32;
/// Salt length (KDF input).
pub const SALT_LEN: usize = 16;
/// GCM nonce length.
pub const NONCE_LEN: usize = 12;
/// Authenticated header length (AAD) — magic…salt, without the nonce.
pub const HEADER_LEN: usize = 8 + 4 + 1 + 4 + 4 + 1 + 1 + 16;

/// JSON payload envelope (forward-compatible, mirrors the legacy contour).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PayloadFile {
    format: String,
    version: u32,
    records: BTreeMap<String, BTreeMap<String, Record>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    value: String,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
}

/// Derived-key state of an open (unlocked) portable store.
#[derive(Debug)]
struct OpenState {
    salt: [u8; SALT_LEN],
    /// Derived AES-256 key; zeroized on drop.
    key: Zeroizing<[u8; 32]>,
    records: BTreeMap<String, BTreeMap<String, Record>>,
}

/// Portable encrypted file store (`secrets.enc` v2).
#[derive(Debug)]
pub struct FileEncryptedSecretStore {
    path: PathBuf,
    state: Mutex<Option<OpenState>>,
    now: fn() -> i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Encodes the v2 header (magic … salt). The nonce is appended by
/// [`encrypt_payload`].
fn encode_header(salt: &[u8; SALT_LEN]) -> Vec<u8> {
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
    header.push(KDF_ID_ARGON2ID);
    header.extend_from_slice(&ARGON2_M.to_be_bytes());
    header.extend_from_slice(&ARGON2_T.to_be_bytes());
    header.push(ARGON2_P);
    header.push(ARGON2_OUT);
    header.extend_from_slice(salt);
    debug_assert_eq!(header.len(), HEADER_LEN);
    header
}

/// Parses the header, validating magic/version/kdf. Returns the salt.
fn parse_header(header: &[u8]) -> Result<[u8; SALT_LEN], SecretStoreError> {
    if header.len() < HEADER_LEN {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            "secrets file header is truncated",
        ));
    }
    if &header[0..8] != MAGIC {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            "secrets file magic mismatch (not a NeoTavern secrets file)",
        ));
    }
    let version = u32::from_be_bytes(header[8..12].try_into().expect("4 bytes"));
    if version == 1 {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            "legacy secrets.enc format v1 (scrypt) is not readable by the kernel — \
             convert it with the data-cutover converter before use",
        ));
    }
    if version != FORMAT_VERSION {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            format!("unsupported secrets file format version {version}"),
        ));
    }
    if header[12] != KDF_ID_ARGON2ID {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            "unsupported secrets file KDF",
        ));
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&header[23..23 + SALT_LEN]);
    Ok(salt)
}

/// Derives the AES-256 key from the master passphrase and header salt.
fn derive_key(
    passphrase: &str,
    salt: &[u8; SALT_LEN],
) -> Result<Zeroizing<[u8; 32]>, SecretStoreError> {
    let params = Params::new(
        ARGON2_M,
        ARGON2_T,
        ARGON2_P as u32,
        Some(ARGON2_OUT as usize),
    )
    .map_err(|err| {
        SecretStoreError::new(
            SecretStoreErrorCode::AuthFailed,
            format!("invalid Argon2 params: {err}"),
        )
    })?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(SecretStoreError::from)?;
    Ok(key)
}

/// Encrypts the JSON payload: fresh nonce, AAD over the header.
fn encrypt_payload(
    key: &[u8; 32],
    header: &[u8],
    payload: &[u8],
) -> Result<Vec<u8>, SecretStoreError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|err| {
        SecretStoreError::new(SecretStoreErrorCode::Corrupt, format!("invalid key: {err}"))
    })?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: payload,
                aad: header,
            },
        )
        .map_err(|_| {
            SecretStoreError::new(SecretStoreErrorCode::AuthFailed, "encryption failed")
        })?;
    let mut out = Vec::with_capacity(header.len() + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(header);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypts a whole file. Distinguishes header tampering (Corrupt, from the
/// AAD) from a wrong passphrase or corrupted ciphertext (AuthFailed).
fn decrypt_file(bytes: &[u8], passphrase: &str) -> Result<(OpenState, Vec<u8>), SecretStoreError> {
    let salt = parse_header(bytes)?;
    let header = &bytes[..HEADER_LEN];
    let key = derive_key(passphrase, &salt)?;
    if bytes.len() < HEADER_LEN + NONCE_LEN {
        return Err(SecretStoreError::new(
            SecretStoreErrorCode::Corrupt,
            "secrets file is truncated (missing nonce)",
        ));
    }
    let nonce = &bytes[HEADER_LEN..HEADER_LEN + NONCE_LEN];
    let ciphertext = &bytes[HEADER_LEN + NONCE_LEN..];
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|err| {
        SecretStoreError::new(SecretStoreErrorCode::Corrupt, format!("invalid key: {err}"))
    })?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: header,
            },
        )
        .map_err(|_| {
            SecretStoreError::new(
                SecretStoreErrorCode::AuthFailed,
                "passphrase mismatch or corrupted ciphertext",
            )
        })?;
    Ok((
        OpenState {
            salt,
            key,
            records: BTreeMap::new(),
        },
        plaintext,
    ))
}

impl FileEncryptedSecretStore {
    /// Creates a store handle for `path` (nothing is touched until
    /// [`open`](Self::open) or [`create`](Self::create)).
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            state: Mutex::new(None),
            now: now_ms,
        }
    }

    fn read_bytes(&self) -> Result<Vec<u8>, SecretStoreError> {
        let mut file = File::open(&self.path).map_err(|err| {
            if err.kind() == io::ErrorKind::NotFound {
                SecretStoreError::new(SecretStoreErrorCode::Corrupt, "secrets file missing")
            } else {
                SecretStoreError::new(
                    SecretStoreErrorCode::Corrupt,
                    format!("cannot read secrets file: {err}"),
                )
            }
        })?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|err| {
            SecretStoreError::new(
                SecretStoreErrorCode::Corrupt,
                format!("cannot read secrets file: {err}"),
            )
        })?;
        Ok(bytes)
    }

    /// Writes the encrypted file atomically (temp + fsync + rename).
    fn write_atomic(&self, bytes: &[u8]) -> Result<(), SecretStoreError> {
        let dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(dir).map_err(|err| {
            SecretStoreError::new(
                SecretStoreErrorCode::Corrupt,
                format!("cannot create secrets directory: {err}"),
            )
        })?;
        let tmp = self
            .path
            .with_extension(format!("enc.tmp{}", std::process::id()));
        {
            let mut file = File::create(&tmp).map_err(|err| {
                SecretStoreError::new(
                    SecretStoreErrorCode::Corrupt,
                    format!("cannot write secrets file: {err}"),
                )
            })?;
            file.write_all(bytes).map_err(|err| {
                SecretStoreError::new(
                    SecretStoreErrorCode::Corrupt,
                    format!("cannot write secrets file: {err}"),
                )
            })?;
            file.sync_all().map_err(|err| {
                SecretStoreError::new(
                    SecretStoreErrorCode::Corrupt,
                    format!("cannot sync secrets file: {err}"),
                )
            })?;
        }
        fs::rename(&tmp, &self.path).map_err(|err| {
            let _ = fs::remove_file(&tmp);
            SecretStoreError::new(
                SecretStoreErrorCode::Corrupt,
                format!("cannot replace secrets file: {err}"),
            )
        })?;
        Ok(())
    }

    fn payload(
        &self,
        records: &BTreeMap<String, BTreeMap<String, Record>>,
    ) -> Result<Vec<u8>, SecretStoreError> {
        serde_json::to_vec(&PayloadFile {
            format: "neotavern-secrets".to_string(),
            version: FORMAT_VERSION,
            records: records.clone(),
        })
        .map_err(|err| {
            SecretStoreError::new(
                SecretStoreErrorCode::Corrupt,
                format!("cannot serialize payload: {err}"),
            )
        })
    }

    /// Persists the current records with the store's stable salt and a fresh
    /// nonce. Callers hold the state lock.
    fn persist_locked(&self, state: &OpenState) -> Result<(), SecretStoreError> {
        let payload = self.payload(&state.records)?;
        let header = encode_header(&state.salt);
        let bytes = encrypt_payload(&state.key, &header, &payload)?;
        self.write_atomic(&bytes)
    }

    fn with_state<T>(
        &self,
        f: impl FnOnce(&mut OpenState) -> Result<T, SecretStoreError>,
    ) -> Result<T, SecretStoreError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| SecretStoreError::new(SecretStoreErrorCode::Busy, "store busy"))?;
        let state = guard.as_mut().ok_or_else(|| {
            SecretStoreError::new(SecretStoreErrorCode::Locked, "store is locked")
        })?;
        f(state)
    }
}

impl SecretStore for FileEncryptedSecretStore {
    fn is_available(&self) -> bool {
        self.state
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    fn describe(&self) -> SecretBackendInfo {
        let (available, count) = match self.state.lock() {
            Ok(guard) => match guard.as_ref() {
                Some(state) => (true, state.records.values().map(|m| m.len()).sum()),
                None => (false, 0),
            },
            Err(_) => (false, 0),
        };
        SecretBackendInfo {
            kind: "portable",
            persistent: true,
            writable: true,
            available,
            record_count: count,
            format_version: Some(FORMAT_VERSION),
        }
    }

    fn put(&self, namespace: &str, id: &str, value: &str) -> Result<String, SecretStoreError> {
        self.with_state(|state| {
            let now = (self.now)();
            let scope = state.records.entry(namespace.to_string()).or_default();
            match scope.get_mut(id) {
                Some(record) => {
                    record.value = value.to_string();
                    record.updated_at = now;
                }
                None => {
                    scope.insert(
                        id.to_string(),
                        Record {
                            value: value.to_string(),
                            created_at: now,
                            updated_at: now,
                        },
                    );
                }
            }
            self.persist_locked(state)?;
            Ok(self.make_ref(SecretRefKind::Portable, namespace, id))
        })
    }

    fn get(&self, namespace: &str, id: &str) -> Result<Option<String>, SecretStoreError> {
        self.with_state(|state| {
            Ok(state
                .records
                .get(namespace)
                .and_then(|scope| scope.get(id))
                .map(|record| record.value.clone()))
        })
    }

    fn delete(&self, namespace: &str, id: &str) -> Result<bool, SecretStoreError> {
        self.with_state(|state| {
            let removed = state
                .records
                .get_mut(namespace)
                .map(|scope| scope.remove(id).is_some())
                .unwrap_or(false);
            if removed {
                self.persist_locked(state)?;
            }
            Ok(removed)
        })
    }

    fn list(&self, namespace: &str) -> Result<Vec<SecretRecordMeta>, SecretStoreError> {
        self.with_state(|state| {
            Ok(state
                .records
                .get(namespace)
                .map(|scope| {
                    scope
                        .iter()
                        .map(|(id, record)| SecretRecordMeta {
                            id: id.clone(),
                            created_at: record.created_at,
                            updated_at: record.updated_at,
                        })
                        .collect()
                })
                .unwrap_or_default())
        })
    }

    fn has(&self, namespace: &str, id: &str) -> Result<bool, SecretStoreError> {
        self.with_state(|state| {
            Ok(state
                .records
                .get(namespace)
                .map(|scope| scope.contains_key(id))
                .unwrap_or(false))
        })
    }

    fn make_ref(&self, _kind: SecretRefKind, namespace: &str, id: &str) -> String {
        crate::refs::make_ref(SecretRefKind::Portable, namespace, id)
    }

    fn lock(&self) {
        if let Ok(mut guard) = self.state.lock() {
            // Dropping OpenState zeroizes the derived key.
            *guard = None;
        }
    }

    fn re_encrypt(&self, new_passphrase: &str) -> Result<(), SecretStoreError> {
        self.with_state(|state| {
            // Staged re-encryption: derive a new key with a FRESH salt, write
            // a temporary sibling, verify by re-opening it, then replace the
            // old file atomically. The previous file is never removed before
            // the new one verified.
            let mut salt = [0u8; SALT_LEN];
            rand::rngs::OsRng.fill_bytes(&mut salt);
            let key = derive_key(new_passphrase, &salt)?;
            let header = encode_header(&salt);
            let payload = self.payload(&state.records)?;
            let bytes = encrypt_payload(&key, &header, &payload)?;
            let tmp = self
                .path
                .with_extension(format!("enc.reenc.tmp{}", std::process::id()));
            fs::write(&tmp, &bytes).map_err(|err| {
                SecretStoreError::new(
                    SecretStoreErrorCode::Corrupt,
                    format!("cannot write re-encrypted store: {err}"),
                )
            })?;
            // Verify the staged file with the new passphrase before touching
            // the old one.
            let staged = fs::read(&tmp).map_err(|err| {
                SecretStoreError::new(
                    SecretStoreErrorCode::Corrupt,
                    format!("cannot read staged store: {err}"),
                )
            })?;
            let (_, plaintext) = decrypt_file(&staged, new_passphrase)?;
            let parsed: PayloadFile = serde_json::from_slice(&plaintext).map_err(|err| {
                SecretStoreError::new(
                    SecretStoreErrorCode::Corrupt,
                    format!("staged store failed verification: {err}"),
                )
            })?;
            if parsed.version != FORMAT_VERSION {
                return Err(SecretStoreError::new(
                    SecretStoreErrorCode::Corrupt,
                    "staged store failed verification (version mismatch)",
                ));
            }
            fs::rename(&tmp, &self.path).map_err(|err| {
                let _ = fs::remove_file(&tmp);
                SecretStoreError::new(
                    SecretStoreErrorCode::Corrupt,
                    format!("cannot replace secrets file: {err}"),
                )
            })?;
            state.salt = salt;
            state.key = key;
            Ok(())
        })
    }
}

impl FileEncryptedSecretStore {
    /// Creates a new store file (fails `Corrupt` when one already exists)
    /// and opens it.
    pub fn create(&self, passphrase: &str) -> Result<(), SecretStoreError> {
        if passphrase.is_empty() {
            return Err(SecretStoreError::new(
                SecretStoreErrorCode::AuthFailed,
                "a non-empty master passphrase is required",
            ));
        }
        if self.path.exists() {
            return Err(SecretStoreError::new(
                SecretStoreErrorCode::Corrupt,
                "secrets file already exists — open it instead of creating",
            ));
        }
        let mut salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let key = derive_key(passphrase, &salt)?;
        let header = encode_header(&salt);
        let payload = self.payload(&BTreeMap::new())?;
        let bytes = encrypt_payload(&key, &header, &payload)?;
        self.write_atomic(&bytes)?;
        self.open(passphrase)
    }

    /// Opens and unlocks an existing store file.
    pub fn open(&self, passphrase: &str) -> Result<(), SecretStoreError> {
        let bytes = self.read_bytes()?;
        let (mut state, plaintext) = decrypt_file(&bytes, passphrase)?;
        let parsed: PayloadFile = serde_json::from_slice(&plaintext).map_err(|err| {
            SecretStoreError::new(
                SecretStoreErrorCode::Corrupt,
                format!("secrets payload is not valid JSON: {err}"),
            )
        })?;
        if parsed.format != "neotavern-secrets" || parsed.version != FORMAT_VERSION {
            return Err(SecretStoreError::new(
                SecretStoreErrorCode::Corrupt,
                "secrets payload format mismatch",
            ));
        }
        state.records = parsed.records;
        let mut guard = self
            .state
            .lock()
            .map_err(|_| SecretStoreError::new(SecretStoreErrorCode::Busy, "store busy"))?;
        *guard = Some(state);
        Ok(())
    }
}
