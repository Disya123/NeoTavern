//! SecretStore integration tests (ТЗ §SEC-01.1, ADR-0040): roundtrip,
//! wrong passphrase, tamper/corruption, nonce freshness, cross-machine
//! portability, lock, staged re-encryption, session/env/unavailable
//! backends and reference parsing.

use std::collections::BTreeMap;
use std::fs;

use secret_store::{
    parse_ref, EnvSecretStore, FileEncryptedSecretStore, MemorySecretStore, SecretRefKind,
    SecretStore, SecretStoreErrorCode, UnavailableSecretStore,
};

fn portable_in(dir: &std::path::Path) -> FileEncryptedSecretStore {
    FileEncryptedSecretStore::new(dir.join("secrets.enc"))
}

#[test]
fn portable_roundtrip_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let store = portable_in(dir.path());
    store.create("correct horse battery staple").unwrap();

    let ref_a = store.put("provider:openai", "rec-1", "sk-value-1").unwrap();
    assert_eq!(ref_a, "portable:provider:openai:rec-1");
    assert_eq!(
        store.get("provider:openai", "rec-1").unwrap().as_deref(),
        Some("sk-value-1")
    );
    assert!(store.has("provider:openai", "rec-1").unwrap());
    assert_eq!(store.list("provider:openai").unwrap().len(), 1);
    assert!(store.list("other").unwrap().is_empty());

    // A second instance re-opens the same file with the same passphrase.
    let reopened = portable_in(dir.path());
    reopened.open("correct horse battery staple").unwrap();
    assert_eq!(
        reopened.get("provider:openai", "rec-1").unwrap().as_deref(),
        Some("sk-value-1")
    );

    assert!(reopened.delete("provider:openai", "rec-1").unwrap());
    assert!(!reopened.delete("provider:openai", "rec-1").unwrap());
    assert!(reopened.get("provider:openai", "rec-1").unwrap().is_none());
    assert!(!reopened.has("provider:openai", "rec-1").unwrap());
}

#[test]
fn wrong_passphrase_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let store = portable_in(dir.path());
    store.create("right-passphrase").unwrap();
    let sentinel = "super-secret-sentinel-value-42";
    store.put("provider", "k", sentinel).unwrap();

    let other = portable_in(dir.path());
    let err = other.open("wrong-passphrase").unwrap_err();
    assert_eq!(err.code, SecretStoreErrorCode::AuthFailed);
    // The plaintext sentinel must never appear as a contiguous run anywhere
    // in the on-disk file.
    let raw = fs::read(dir.path().join("secrets.enc")).unwrap();
    assert!(raw
        .windows(sentinel.len())
        .all(|w| w != sentinel.as_bytes()));
    assert!(String::from_utf8_lossy(&raw).contains("NEOTASEC"));
}

#[test]
fn tampered_header_is_detected_as_corrupt() {
    let dir = tempfile::tempdir().unwrap();
    let store = portable_in(dir.path());
    store.create("pass").unwrap();
    store.put("provider", "k", "v").unwrap();

    let path = dir.path().join("secrets.enc");
    let mut bytes = fs::read(&path).unwrap();
    // Flip a salt byte: the header is authenticated (AAD), so the change
    // must surface as corruption/tampering, never a silent downgrade.
    bytes[23] ^= 0x01;
    fs::write(&path, &bytes).unwrap();

    let other = portable_in(dir.path());
    let err = other.open("pass").unwrap_err();
    assert!(matches!(
        err.code,
        SecretStoreErrorCode::Corrupt | SecretStoreErrorCode::AuthFailed
    ));
    assert_eq!(err.code, SecretStoreErrorCode::AuthFailed);
}

#[test]
fn tampered_magic_and_legacy_v1_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let store = portable_in(dir.path());
    store.create("pass").unwrap();
    let path = dir.path().join("secrets.enc");

    let mut bytes = fs::read(&path).unwrap();
    bytes[0] = b'X';
    fs::write(&path, &bytes).unwrap();
    let err = portable_in(dir.path()).open("pass").unwrap_err();
    assert_eq!(err.code, SecretStoreErrorCode::Corrupt);
    assert!(err.message.contains("magic"));

    // A legacy v1 (scrypt) header is rejected with an explicit message.
    bytes = fs::read(&path).unwrap();
    bytes[0] = b'N';
    bytes[8..12].copy_from_slice(&1u32.to_be_bytes());
    fs::write(&path, &bytes).unwrap();
    let err = portable_in(dir.path()).open("pass").unwrap_err();
    assert_eq!(err.code, SecretStoreErrorCode::Corrupt);
    assert!(err.message.contains("v1"));
}

#[test]
fn writes_use_a_fresh_nonce() {
    let dir = tempfile::tempdir().unwrap();
    let store = portable_in(dir.path());
    store.create("pass").unwrap();
    store.put("provider", "a", "same-value").unwrap();
    let first = fs::read(dir.path().join("secrets.enc")).unwrap();
    store.put("provider", "b", "same-value").unwrap();
    let second = fs::read(dir.path().join("secrets.enc")).unwrap();
    // Salt is stable (bytes 23..39); the nonce region (39..51) differs.
    assert_eq!(&first[23..39], &second[23..39]);
    assert_ne!(&first[39..51], &second[39..51]);
    assert_ne!(first, second);
}

#[test]
fn portable_store_transfers_across_machines() {
    // ADR-0040 acceptance: file + passphrase only — machine identity is not
    // part of the key derivation. Simulate "another machine" as a fresh
    // store instance over a copied file.
    let dir_a = tempfile::tempdir().unwrap();
    let store = portable_in(dir_a.path());
    store.create("portable-passphrase").unwrap();
    store
        .put("provider:openai", "sk", "sk-transferable-42")
        .unwrap();

    let dir_b = tempfile::tempdir().unwrap();
    let copied = dir_b.path().join("secrets.enc");
    fs::copy(dir_a.path().join("secrets.enc"), &copied).unwrap();

    let other = FileEncryptedSecretStore::new(copied);
    other.open("portable-passphrase").unwrap();
    assert_eq!(
        other.get("provider:openai", "sk").unwrap().as_deref(),
        Some("sk-transferable-42")
    );
    // The machine-bound "wrong device" case is a runtime policy decision:
    // the file itself unlocks anywhere; refs of a different kind fail with
    // the stable unavailable error at the resolver boundary.
    assert_eq!(
        parse_ref("portable:provider:openai:sk").unwrap().kind,
        SecretRefKind::Portable
    );
}

#[test]
fn lock_blocks_reads_and_writes_until_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let store = portable_in(dir.path());
    store.create("pass").unwrap();
    store.put("provider", "k", "v").unwrap();
    store.lock();
    assert!(!store.is_available());
    let err = store.get("provider", "k").unwrap_err();
    assert_eq!(err.code, SecretStoreErrorCode::Locked);
    let err = store.put("provider", "k2", "v2").unwrap_err();
    assert_eq!(err.code, SecretStoreErrorCode::Locked);
    store.open("pass").unwrap();
    assert_eq!(store.get("provider", "k").unwrap().as_deref(), Some("v"));
}

#[test]
fn staged_re_encryption_switches_the_passphrase() {
    let dir = tempfile::tempdir().unwrap();
    let store = portable_in(dir.path());
    store.create("old-passphrase").unwrap();
    store.put("provider", "k", "v").unwrap();

    store.re_encrypt("new-passphrase").unwrap();

    let other = portable_in(dir.path());
    assert_eq!(
        other.open("old-passphrase").unwrap_err().code,
        SecretStoreErrorCode::AuthFailed
    );
    other.open("new-passphrase").unwrap();
    assert_eq!(other.get("provider", "k").unwrap().as_deref(), Some("v"));
}

#[test]
fn session_store_isolates_namespaces() {
    let store = MemorySecretStore::new();
    store.put("a", "value", "va").unwrap();
    store.put("b", "value", "vb").unwrap();
    // Namespace isolation: same id in different namespaces never collides.
    assert_eq!(store.get("a", "value").unwrap().as_deref(), Some("va"));
    assert_eq!(store.get("b", "value").unwrap().as_deref(), Some("vb"));
    assert_eq!(store.list("a").unwrap().len(), 1);
    assert_eq!(store.list("b").unwrap().len(), 1);
    store.clear();
    assert!(store.get("a", "value").unwrap().is_none());
}

#[test]
fn env_store_is_read_only_and_resolves_from_vars() {
    let mut env = BTreeMap::new();
    env.insert(
        "NEOTA_SECRET_provider_openaikey".to_string(),
        "sk-env-1".to_string(),
    );
    env.insert(
        "NEOTA_SECRET_plugin_apikey".to_string(),
        "sk-plugin-env".to_string(),
    );
    let store = EnvSecretStore::new("NEOTA_SECRET_", env);

    assert!(store.is_available());
    assert!(!store.describe().writable);
    assert_eq!(
        store.get("provider", "openaikey").unwrap().as_deref(),
        Some("sk-env-1")
    );
    assert!(store.has("plugin", "apikey").unwrap());
    assert_eq!(store.list("plugin").unwrap().len(), 1);
    let err = store.put("provider", "x", "y").unwrap_err();
    assert_eq!(err.code, SecretStoreErrorCode::ReadOnly);
}

#[test]
fn unavailable_store_refuses_everything() {
    let store = UnavailableSecretStore;
    assert!(!store.is_available());
    assert_eq!(
        store.put("provider", "k", "v").unwrap_err().code,
        SecretStoreErrorCode::Unavailable
    );
    assert_eq!(
        store.get("provider", "k").unwrap_err().code,
        SecretStoreErrorCode::Unavailable
    );
}

#[test]
fn describe_never_leaks_values() {
    let dir = tempfile::tempdir().unwrap();
    let store = portable_in(dir.path());
    store.create("pass").unwrap();
    store
        .put("provider:openai", "sk", "super-secret-value")
        .unwrap();
    let info = store.describe();
    assert_eq!(info.kind, "portable");
    assert!(info.persistent);
    assert!(info.writable);
    assert!(info.available);
    assert_eq!(info.record_count, 1);
    assert_eq!(info.format_version, Some(2));
    let text = format!("{info:?}");
    assert!(!text.contains("super-secret-value"));
}
