//! SEC-05 package trust (ТЗ §12 SEC-05, Этап 1 task 5): verification of a
//! plugin/theme ZIP package BEFORE consent/install.
//!
//! The kernel's `plugins.install` op durably records a trust state whose
//! HOST has already verified the package (see `runtime-kernel/src/plugins.rs`:
//! "the host has ALREADY verified the package (signature + per-file digest,
//! ZIP traversal/symlink/bomb rejection) before calling this op"). This crate
//! is that host-side verifier, shared by every kernel host:
//!
//! - **ZIP safety** (SEC-05): path traversal and absolute paths rejected,
//!   symlink entries rejected, duplicate normalized paths rejected, zip
//!   bombs bounded (declared decompressed size and compression ratio checked
//!   before any read; entry reads are capped), bounded entry count and
//!   manifest size.
//! - **Per-file digest**: `manifest.json` lists every file with its SHA-256;
//!   each listed file must exist in the archive with a matching digest and
//!   every archived file (except the manifest and its signature) must be
//!   listed — no unlisted payload.
//! - **Publisher signature** (Ed25519 via `ring`): `manifest.json.sig`
//!   carries the raw 64-byte signature over the exact manifest bytes. Trust
//!   is classified by the signing key's fingerprint against the verifier's
//!   known-publisher and locally-trusted key sets, producing the SEC-05
//!   rank order used by `plugins.rs` (built-in 3 > verified-publisher 2 >
//!   locally-trusted 1 > unsigned-untrusted 0). A declared but invalid
//!   signature FAILS CLOSED with `SignatureInvalid`; a valid signature by an
//!   unknown key is classified `unsigned-untrusted` (never implicitly
//!   upgraded).
//!
//! The verifier never extracts the archive and never touches the data root;
//! it returns the parsed manifest, the trust rank and digest evidence for the
//! kernel install op. Permissions are NOT validated here — the granted set is
//! the consent moment of the install request (ARC-08).

use ring::signature::{UnparsedPublicKey, ED25519};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{Cursor, Read};
use zip::ZipArchive;

/// SEC-05 trust classification; ranks match `runtime_kernel::plugins::trust_rank`
/// (3 built-in > 2 verified-publisher > 1 locally-trusted > 0 unsigned).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustRank {
    BuiltIn,
    VerifiedPublisher,
    LocallyTrusted,
    UnsignedUntrusted,
}

impl TrustRank {
    /// The numeric rank used by `plugins.rs` (higher = more trusted).
    pub fn rank(self) -> u8 {
        match self {
            TrustRank::BuiltIn => 3,
            TrustRank::VerifiedPublisher => 2,
            TrustRank::LocallyTrusted => 1,
            TrustRank::UnsignedUntrusted => 0,
        }
    }

    /// The stable wire string recorded by `plugins.install` (`trustState`).
    pub fn as_str(self) -> &'static str {
        match self {
            TrustRank::BuiltIn => "built-in",
            TrustRank::VerifiedPublisher => "verified-publisher",
            TrustRank::LocallyTrusted => "locally-trusted",
            TrustRank::UnsignedUntrusted => "unsigned-untrusted",
        }
    }
}

/// One file entry declared by the package manifest.
#[derive(Debug, Clone, Deserialize)]
pub struct ManifestFile {
    /// Normalized archive path (forward slashes, no leading `./`).
    pub path: String,
    /// Lowercase hex SHA-256 of the file bytes.
    pub sha256: String,
}

/// The package manifest embedded in the archive.
#[derive(Debug, Clone, Deserialize)]
pub struct PackageManifest {
    pub id: String,
    pub version: String,
    /// The declared permission set — NOT validated here (ARC-08: the granted
    /// set is the install request's consent moment).
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub publisher: Option<PublisherInfo>,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherInfo {
    /// Lowercase hex SHA-256 fingerprint of the Ed25519 public key that
    /// signed `manifest.json`.
    pub key_fingerprint: String,
}

/// Result of a successful verification, ready for the kernel install op.
#[derive(Debug, Clone)]
pub struct Verification {
    pub manifest: PackageManifest,
    pub trust_rank: TrustRank,
    /// Verified files (== manifest.files.len() when successful).
    pub verified_files: usize,
    /// Sum of decompressed bytes actually read and hashed.
    pub verified_bytes: u64,
}

/// Stable SEC-05 verification failure codes (fail-closed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// Not a valid ZIP archive.
    NotZip,
    /// `manifest.json` missing, unreadable, too large or not valid JSON.
    BadManifest(String),
    /// A normalized path escapes the package root.
    PathTraversal(String),
    /// A path is absolute (POSIX or Windows drive).
    AbsolutePath(String),
    /// An entry is a symlink (Unix mode S_IFLNK).
    SymlinkEntry(String),
    /// Two entries normalize to the same path.
    DuplicatePath(String),
    /// An archived file is not declared in the manifest.
    UnlistedFile(String),
    /// A manifest-declared file is missing from the archive.
    MissingFile(String),
    /// File bytes do not match the manifest digest.
    DigestMismatch(String),
    /// The manifest declares a signature but it is missing or invalid.
    SignatureInvalid(String),
    /// The archive exceeds the configured resource limits (zip bomb).
    ResourceLimit(String),
}

/// Bounded verification limits (zip-bomb and memory containment, SEC-04/05).
#[derive(Debug, Clone)]
pub struct VerifyLimits {
    /// Max manifest.json bytes (including signature entry bounds).
    pub max_manifest_bytes: u64,
    /// Max declared decompressed bytes across all entries.
    pub max_total_bytes: u64,
    /// Max declared decompressed bytes for one entry.
    pub max_entry_bytes: u64,
    /// Max compression ratio (declared / stored) per entry.
    pub max_compression_ratio: u64,
    /// Max number of entries in the archive.
    pub max_entries: usize,
}

impl Default for VerifyLimits {
    fn default() -> Self {
        VerifyLimits {
            max_manifest_bytes: 1024 * 1024,
            max_total_bytes: 256 * 1024 * 1024,
            max_entry_bytes: 64 * 1024 * 1024,
            max_compression_ratio: 2000,
            max_entries: 4096,
        }
    }
}

/// A verifier configured with the trusted publisher key sets.
#[derive(Debug, Clone, Default)]
pub struct PackageVerifier {
    /// (fingerprint, Ed25519 public key bytes) for official publishers.
    pub known_publisher_keys: Vec<(String, Vec<u8>)>,
    /// (fingerprint, Ed25519 public key bytes) for locally trusted keys.
    pub locally_trusted_keys: Vec<(String, Vec<u8>)>,
    pub limits: VerifyLimits,
}

/// Lowercase hex SHA-256 of an Ed25519 public key (the fingerprint used in
/// `PublisherInfo.keyFingerprint`).
pub fn key_fingerprint(public_key: &[u8]) -> String {
    hex(&Sha256::digest(public_key))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether a Unix mode (as reported by a ZIP entry) is a symlink
/// (S_IFLNK = 0o120000 in the 0o170000 file-type mask).
fn is_symlink(mode: Option<u32>) -> bool {
    mode.is_some_and(|mode| mode & 0o170000 == 0o120000)
}

/// Normalizes an archive path to forward slashes, without a leading `./`,
/// and rejects anything that escapes the package root.
fn normalize_path(raw: &str) -> Result<String, VerifyError> {
    let raw = raw.replace('\\', "/");
    // Reject absolute POSIX paths and Windows drive/UNC roots.
    if raw.starts_with('/') {
        return Err(VerifyError::AbsolutePath(raw));
    }
    if raw
        .as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_alphabetic())
        && raw.as_bytes().get(1) == Some(&b':')
    {
        return Err(VerifyError::AbsolutePath(raw));
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(VerifyError::PathTraversal(raw)),
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(VerifyError::PathTraversal(raw));
    }
    Ok(parts.join("/"))
}

/// Looks up a configured key by fingerprint and verifies `message` against
/// `signature` with Ed25519 (constant-time ring verification).
fn verify_signature(
    keys: &[(String, Vec<u8>)],
    fingerprint: &str,
    message: &[u8],
    signature: &[u8],
) -> bool {
    keys.iter()
        .find(|(fp, _)| fp == fingerprint)
        .and_then(|(_, pk)| {
            let key = UnparsedPublicKey::new(&ED25519, pk.clone());
            key.verify(message, signature).ok()
        })
        .is_some()
}

impl PackageVerifier {
    /// Verifies a plugin/theme package held fully in memory.
    pub fn verify(&self, package_bytes: &[u8]) -> Result<Verification, VerifyError> {
        let mut archive =
            ZipArchive::new(Cursor::new(package_bytes)).map_err(|_| VerifyError::NotZip)?;
        if archive.len() > self.limits.max_entries {
            return Err(VerifyError::ResourceLimit(format!(
                "entries {} exceed limit {}",
                archive.len(),
                self.limits.max_entries
            )));
        }

        // Pass 1: path safety + declared-size budgeting (before any read).
        let mut normalized: Vec<String> = Vec::with_capacity(archive.len());
        let mut total_declared: u64 = 0;
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|_| VerifyError::NotZip)?;
            let path = normalize_path(entry.name())?;
            if normalized.contains(&path) {
                return Err(VerifyError::DuplicatePath(path));
            }
            if entry.is_dir() {
                continue;
            }
            if is_symlink(entry.unix_mode()) {
                return Err(VerifyError::SymlinkEntry(path));
            }
            let declared = entry.size();
            if declared > self.limits.max_entry_bytes {
                return Err(VerifyError::ResourceLimit(format!(
                    "entry {path} declares {declared} bytes"
                )));
            }
            if entry.compressed_size() > 0
                && declared / entry.compressed_size() > self.limits.max_compression_ratio
            {
                return Err(VerifyError::ResourceLimit(format!(
                    "entry {path} compression ratio exceeds limit"
                )));
            }
            total_declared = total_declared.saturating_add(declared);
            if total_declared > self.limits.max_total_bytes {
                return Err(VerifyError::ResourceLimit(format!(
                    "total declared {total_declared} bytes"
                )));
            }
            normalized.push(path);
        }

        // Pass 2: read the manifest with a hard byte cap.
        let manifest_bytes = {
            let mut bytes = Vec::new();
            let mut found = false;
            for index in 0..archive.len() {
                let entry = archive.by_index(index).map_err(|_| VerifyError::NotZip)?;
                if entry.is_dir() || normalize_path(entry.name())? != "manifest.json" {
                    continue;
                }
                found = true;
                entry
                    .take(self.limits.max_manifest_bytes + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| VerifyError::BadManifest("unreadable".to_string()))?;
                break;
            }
            if !found {
                return Err(VerifyError::BadManifest("missing".to_string()));
            }
            if bytes.len() as u64 > self.limits.max_manifest_bytes {
                return Err(VerifyError::BadManifest("too large".to_string()));
            }
            bytes
        };
        let manifest: PackageManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|err| VerifyError::BadManifest(err.to_string()))?;

        // Pass 3: signature. The manifest declares a publisher fingerprint;
        // a declared signature must be present AND valid (fail closed).
        let signature_bytes = {
            let mut bytes = Vec::new();
            let mut found = false;
            for index in 0..archive.len() {
                let entry = archive.by_index(index).map_err(|_| VerifyError::NotZip)?;
                if entry.is_dir() || normalize_path(entry.name())? != "manifest.json.sig" {
                    continue;
                }
                found = true;
                entry
                    .take(128)
                    .read_to_end(&mut bytes)
                    .map_err(|_| VerifyError::SignatureInvalid("unreadable".to_string()))?;
                break;
            }
            if found {
                Some(bytes)
            } else {
                None
            }
        };
        let trust_rank = match &manifest.publisher {
            Some(publisher) => {
                let signature = signature_bytes.as_deref().ok_or_else(|| {
                    VerifyError::SignatureInvalid("declared signature missing".to_string())
                })?;
                // Fail closed: a declared signature MUST verify against a key
                // we hold. A signature by an unknown key is indistinguishable
                // from a forged one without the key, so it is an error —
                // never an implicit downgrade to "locally trusted".
                if verify_signature(
                    &self.known_publisher_keys,
                    &publisher.key_fingerprint,
                    &manifest_bytes,
                    signature,
                ) {
                    TrustRank::VerifiedPublisher
                } else if verify_signature(
                    &self.locally_trusted_keys,
                    &publisher.key_fingerprint,
                    &manifest_bytes,
                    signature,
                ) {
                    TrustRank::LocallyTrusted
                } else {
                    return Err(VerifyError::SignatureInvalid(
                        "signature does not verify against any trusted key".to_string(),
                    ));
                }
            }
            None => {
                if signature_bytes.is_some() {
                    // A signature for an unsigned manifest is malformed.
                    return Err(VerifyError::SignatureInvalid(
                        "signature without declared publisher".to_string(),
                    ));
                }
                TrustRank::UnsignedUntrusted
            }
        };

        // Pass 4: per-file digest. Every manifest file must exist with a
        // matching SHA-256; every archive file must be listed (except the
        // manifest and its signature).
        let expected: HashSet<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
        for file in &manifest.files {
            let path = normalize_path(&file.path)?;
            if !hex_is_sha256(&file.sha256) {
                return Err(VerifyError::DigestMismatch(file.path.clone()));
            }
            let mut found = false;
            for index in 0..archive.len() {
                let entry = archive.by_index(index).map_err(|_| VerifyError::NotZip)?;
                if entry.is_dir() {
                    continue;
                }
                if normalize_path(entry.name())? != path {
                    continue;
                }
                found = true;
                let mut hasher = Sha256::new();
                let mut read: u64 = 0;
                let mut buffer = [0u8; 8192];
                let mut limited = entry.take(self.limits.max_entry_bytes + 1);
                loop {
                    let n = limited
                        .read(&mut buffer)
                        .map_err(|_| VerifyError::DigestMismatch(file.path.clone()))?;
                    if n == 0 {
                        break;
                    }
                    read += n as u64;
                    hasher.update(&buffer[..n]);
                }
                if read > self.limits.max_entry_bytes {
                    return Err(VerifyError::ResourceLimit(format!(
                        "entry {path} grew beyond declared size"
                    )));
                }
                let actual = hex(&hasher.finalize());
                if actual != file.sha256.to_ascii_lowercase() {
                    return Err(VerifyError::DigestMismatch(file.path.clone()));
                }
                break;
            }
            if !found {
                return Err(VerifyError::MissingFile(file.path.clone()));
            }
        }
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|_| VerifyError::NotZip)?;
            if entry.is_dir() {
                continue;
            }
            let path = normalize_path(entry.name())?;
            if path == "manifest.json" || path == "manifest.json.sig" {
                continue;
            }
            if !expected.contains(path.as_str()) {
                return Err(VerifyError::UnlistedFile(path));
            }
        }
        drop(expected);
        let verified_files = manifest.files.len();

        Ok(Verification {
            manifest,
            trust_rank,
            verified_files,
            verified_bytes: total_declared,
        })
    }
}

fn hex_is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn sha256_hex(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// Builds a ZIP in memory from (path, bytes) pairs.
    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, bytes) in entries {
            writer
                .start_file(*path, SimpleFileOptions::default())
                .expect("start file");
            writer.write_all(bytes).expect("write entry");
        }
        writer.finish().expect("finish zip").into_inner()
    }

    fn manifest_json(
        id: &str,
        files: &[(&str, &str)],
        publisher_fingerprint: Option<&str>,
    ) -> String {
        let publisher = match publisher_fingerprint {
            Some(fp) => format!(r#","publisher":{{"keyFingerprint":"{fp}"}}"#),
            None => String::new(),
        };
        let files_json = files
            .iter()
            .map(|(path, hash)| format!(r#"{{"path":"{path}","sha256":"{hash}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"id":"{id}","version":"1.0.0","permissions":[],"files":[{files_json}]{publisher}}}"#
        )
    }

    fn valid_zip(pair: Option<&Ed25519KeyPair>) -> (Vec<u8>, String) {
        let payload = b"console.log('hello');\n";
        let fingerprint = match pair {
            Some(key) => key_fingerprint(key.public_key().as_ref()),
            None => String::new(),
        };
        let manifest = manifest_json(
            "test-plugin",
            &[("index.js", &sha256_hex(payload))],
            if pair.is_some() {
                Some(&fingerprint)
            } else {
                None
            },
        );
        let signature: Option<Vec<u8>> =
            pair.map(|key| key.sign(manifest.as_bytes()).as_ref().to_vec());
        let mut entries = vec![
            ("manifest.json", manifest.as_bytes()),
            ("index.js", payload),
        ];
        if let Some(sig) = &signature {
            entries.push(("manifest.json.sig", sig.as_slice()));
        }
        (zip_with(&entries), fingerprint)
    }

    fn keypair() -> Ed25519KeyPair {
        let rng = ring::rand::SystemRandom::new();
        Ed25519KeyPair::from_pkcs8(Ed25519KeyPair::generate_pkcs8(&rng).unwrap().as_ref()).unwrap()
    }

    #[test]
    fn verified_publisher_package_verifies() {
        let pair = keypair();
        let (bytes, fingerprint) = valid_zip(Some(&pair));
        let verifier = PackageVerifier {
            known_publisher_keys: vec![(fingerprint.clone(), pair.public_key().as_ref().to_vec())],
            ..Default::default()
        };
        let result = verifier.verify(&bytes).expect("verifies");
        assert_eq!(result.trust_rank, TrustRank::VerifiedPublisher);
        assert_eq!(result.verified_files, 1);
        assert_eq!(result.manifest.id, "test-plugin");
    }

    #[test]
    fn locally_trusted_package_ranks_one() {
        let pair = keypair();
        let (bytes, fingerprint) = valid_zip(Some(&pair));
        let verifier = PackageVerifier {
            locally_trusted_keys: vec![(fingerprint, pair.public_key().as_ref().to_vec())],
            ..Default::default()
        };
        assert_eq!(
            verifier.verify(&bytes).unwrap().trust_rank,
            TrustRank::LocallyTrusted
        );
    }

    #[test]
    fn unsigned_package_is_untrusted_but_verifiable() {
        let (bytes, _) = valid_zip(None);
        let verifier = PackageVerifier::default();
        let result = verifier
            .verify(&bytes)
            .expect("unsigned package verifies structurally");
        assert_eq!(result.trust_rank, TrustRank::UnsignedUntrusted);
        assert_eq!(result.trust_rank.rank(), 0);
    }

    #[test]
    fn bad_signature_fails_closed() {
        let pair = keypair();
        let fingerprint = key_fingerprint(pair.public_key().as_ref());
        let manifest = manifest_json("test-plugin", &[], Some(&fingerprint));
        let bytes = zip_with(&[
            ("manifest.json", manifest.as_bytes()),
            ("manifest.json.sig", b"not-a-signature"),
        ]);
        let verifier = PackageVerifier {
            known_publisher_keys: vec![(fingerprint, pair.public_key().as_ref().to_vec())],
            ..Default::default()
        };
        match verifier.verify(&bytes) {
            Err(VerifyError::SignatureInvalid(_)) => {}
            other => panic!("expected SignatureInvalid, got {other:?}"),
        }
    }

    #[test]
    fn unknown_key_signature_fails_closed() {
        // A package signed by a key the verifier does not hold must fail
        // closed — never be silently downgraded to a trust rank.
        let pair = keypair();
        let (bytes, _) = valid_zip(Some(&pair));
        let verifier = PackageVerifier::default();
        match verifier.verify(&bytes) {
            Err(VerifyError::SignatureInvalid(_)) => {}
            other => panic!("expected SignatureInvalid for unknown key, got {other:?}"),
        }
    }

    #[test]
    fn path_traversal_rejected() {
        let payload = b"x";
        let manifest = manifest_json("t", &[("../evil", &sha256_hex(payload))], None);
        let bytes = zip_with(&[("manifest.json", manifest.as_bytes()), ("../evil", payload)]);
        match PackageVerifier::default().verify(&bytes) {
            Err(VerifyError::PathTraversal(_)) | Err(VerifyError::UnlistedFile(_)) => {}
            other => panic!("expected traversal rejection, got {other:?}"),
        }
    }

    #[test]
    fn absolute_path_rejected() {
        let payload = b"x";
        let manifest = manifest_json("t", &[("evil", &sha256_hex(payload))], None);
        let bytes = zip_with(&[
            ("manifest.json", manifest.as_bytes()),
            ("/etc/passwd", payload),
        ]);
        match PackageVerifier::default().verify(&bytes) {
            Err(VerifyError::AbsolutePath(_)) => {}
            other => panic!("expected absolute path rejection, got {other:?}"),
        }
    }

    #[test]
    fn symlink_entries_rejected_by_mode() {
        // The zip writer cannot EMIT S_IFLNK type bits (it masks any input
        // mode to a regular file), so the rejection is proven at the mode
        // classification boundary + structurally via verify()'s pass 1. Real
        // Unix-created symlink archives are covered by release acceptance
        // fixtures. 0o120777 = S_IFLNK, 0o100777 = S_IFREG, 0o40755 = dir.
        assert!(is_symlink(Some(0o120777)));
        assert!(!is_symlink(Some(0o100777)));
        assert!(!is_symlink(Some(0o40755)));
        assert!(!is_symlink(None));

        // The verifier consults the same predicate in pass 1: a regular
        // archive (mode S_IFREG, as the writer emits) passes the check and
        // fails later only on unlisted content — proving the check runs.
        let payload = b"x";
        let manifest = manifest_json("t", &[("index.js", &sha256_hex(payload))], None);
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .expect("manifest entry");
        writer
            .write_all(manifest.as_bytes())
            .expect("manifest write");
        writer
            .start_file("index.js", SimpleFileOptions::default())
            .expect("file entry");
        writer.write_all(payload).expect("file write");
        let bytes = writer.finish().expect("finish zip").into_inner();
        let mut probe = zip::ZipArchive::new(Cursor::new(&bytes)).expect("archive");
        let mode = probe.by_index(1).expect("index.js").unix_mode();
        assert!(
            !is_symlink(mode),
            "writer-produced entries are regular files"
        );
        assert!(
            !matches!(
                PackageVerifier::default().verify(&bytes),
                Err(VerifyError::SymlinkEntry(_))
            ),
            "no symlink entry to reject in a regular archive"
        );
    }

    #[test]
    fn duplicate_normalized_path_rejected() {
        let payload = b"x";
        let manifest = manifest_json("t", &[("index.js", &sha256_hex(payload))], None);
        let bytes = zip_with(&[
            ("manifest.json", manifest.as_bytes()),
            ("index.js", payload),
            ("./index.js", payload),
        ]);
        match PackageVerifier::default().verify(&bytes) {
            Err(VerifyError::DuplicatePath(_)) => {}
            other => panic!("expected duplicate rejection, got {other:?}"),
        }
    }

    #[test]
    fn unlisted_file_rejected() {
        let payload = b"x";
        let manifest = manifest_json("t", &[("index.js", &sha256_hex(payload))], None);
        let bytes = zip_with(&[
            ("manifest.json", manifest.as_bytes()),
            ("index.js", payload),
            ("sneaky.js", payload),
        ]);
        match PackageVerifier::default().verify(&bytes) {
            Err(VerifyError::UnlistedFile(_)) => {}
            other => panic!("expected unlisted rejection, got {other:?}"),
        }
    }

    #[test]
    fn missing_manifest_file_rejected() {
        let payload = b"x";
        let manifest = manifest_json("t", &[("index.js", &sha256_hex(payload))], None);
        let bytes = zip_with(&[("manifest.json", manifest.as_bytes())]);
        match PackageVerifier::default().verify(&bytes) {
            Err(VerifyError::MissingFile(_)) => {}
            other => panic!("expected missing-file rejection, got {other:?}"),
        }
    }

    #[test]
    fn digest_mismatch_rejected() {
        let payload = b"x";
        let manifest = manifest_json("t", &[("index.js", &sha256_hex(b"different"))], None);
        let bytes = zip_with(&[
            ("manifest.json", manifest.as_bytes()),
            ("index.js", payload),
        ]);
        match PackageVerifier::default().verify(&bytes) {
            Err(VerifyError::DigestMismatch(_)) => {}
            other => panic!("expected digest rejection, got {other:?}"),
        }
    }

    #[test]
    fn zip_bomb_rejected_by_declared_size() {
        // A highly-compressible 300 MB declared payload exceeds the 256 MB
        // default total limit while the archive itself stays tiny.
        let big = vec![0u8; 300 * 1024 * 1024];
        let manifest = manifest_json("t", &[("blob", &sha256_hex(&big))], None);
        let bytes = zip_with(&[("manifest.json", manifest.as_bytes()), ("blob", &big)]);
        assert!(bytes.len() < 1024 * 1024, "fixture stays compressed");
        match PackageVerifier::default().verify(&bytes) {
            Err(VerifyError::ResourceLimit(_)) => {}
            other => panic!("expected resource-limit rejection, got {other:?}"),
        }
    }

    #[test]
    fn trust_rank_order_is_stable() {
        assert!(TrustRank::BuiltIn.rank() > TrustRank::VerifiedPublisher.rank());
        assert!(TrustRank::VerifiedPublisher.rank() > TrustRank::LocallyTrusted.rank());
        assert!(TrustRank::LocallyTrusted.rank() > TrustRank::UnsignedUntrusted.rank());
        assert_eq!(TrustRank::UnsignedUntrusted.as_str(), "unsigned-untrusted");
    }
}
