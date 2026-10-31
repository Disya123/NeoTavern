//! Headless secret seams (ТЗ §SEC-01, SEC-01.1).
//!
//! Every backend wires BOTH kernel seams — the writable
//! [`SecretStore`](secret_store::SecretStore) (so `providers.config.set
//! apiKey` commits) and the execution-time
//! [`SecretResolver`](provider_sdk::secret::SecretResolver) (so a generation
//! run resolves the key at the point of use). The desktop host carries the
//! same pattern in `crates/adapters/tauri-local/src/secrets.rs`; the glue is
//! deliberately duplicated per composition root because it maps
//! kernel-plane reference kinds onto the provider SDK's resolver port.
//!
//! There is never a plaintext fallback: a reference of a foreign kind or a
//! missing record resolves to a typed `Unavailable` error, a wrong master
//! passphrase fails the startup, and the fail-closed backend resolves
//! nothing at all.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use provider_sdk::secret::{SecretRef, SecretResolver, SecretValue};
use provider_sdk::{ProviderError, ProviderErrorCode};
use runtime_kernel::Kernel;
use secret_store::refs::SecretRefKind;
use secret_store::{
    EnvSecretStore, FileEncryptedSecretStore, MemorySecretStore, SecretStore,
    UnavailableSecretStore,
};

use crate::SecretBackend;

/// Execution-time resolver over one concrete store kind: parses the opaque
/// reference, refuses any other kind (fail-closed — a store never serves a
/// reference it did not produce) and resolves the value at the point of use.
#[derive(Clone)]
pub(crate) struct HeadlessStoreResolver {
    kind: SecretRefKind,
    store: Arc<dyn SecretStore>,
    /// Human label for the unavailable diagnostic (never a value).
    label: &'static str,
}

impl HeadlessStoreResolver {
    pub(crate) fn new(
        kind: SecretRefKind,
        store: Arc<dyn SecretStore>,
        label: &'static str,
    ) -> Self {
        Self { kind, store, label }
    }
}

impl SecretResolver for HeadlessStoreResolver {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        let parsed = secret_store::refs::parse_ref(&reference.0).ok_or_else(|| {
            ProviderError::with(
                ProviderErrorCode::Unavailable,
                "unrecognized secret reference",
                vec![("secretRef".to_string(), reference.0.clone())],
            )
        })?;
        if parsed.kind != self.kind {
            return Err(ProviderError::with(
                ProviderErrorCode::Unavailable,
                format!("{} store cannot serve this reference kind", self.label),
                vec![("kind".to_string(), parsed.kind.prefix().to_string())],
            ));
        }
        match self.store.get(&parsed.namespace, &parsed.id) {
            Ok(Some(value)) => Ok(SecretValue::new(value)),
            Ok(None) => Err(ProviderError::with(
                ProviderErrorCode::Unavailable,
                format!("secret not present in the {} store", self.label),
                vec![
                    ("namespace".to_string(), parsed.namespace),
                    ("id".to_string(), parsed.id),
                ],
            )),
            Err(err) => Err(ProviderError::with(
                ProviderErrorCode::Unavailable,
                format!("{} store is unavailable", self.label),
                vec![("code".to_string(), err.code.to_string())],
            )),
        }
    }
}

/// The fail-closed backend resolves nothing: every reference is a typed
/// `Unavailable`, never a value.
#[derive(Clone, Default)]
pub(crate) struct UnavailableSecretResolver;

impl SecretResolver for UnavailableSecretResolver {
    fn resolve(&self, _reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        Err(ProviderError::with(
            ProviderErrorCode::Unavailable,
            "the fail-closed secret backend serves no references",
            vec![],
        ))
    }
}

/// Wires the selected backend's store AND resolver into the kernel.
///
/// Returns the store handle (for tests/diagnostics). The portable backend
/// fails the startup (`Err`) when the master passphrase is wrong or the
/// file is corrupt — it never falls back to a different store kind.
pub(crate) fn wire_secrets(
    kernel: &Kernel,
    backend: &SecretBackend,
) -> Result<Arc<dyn SecretStore>, String> {
    let (store, resolver): (Arc<dyn SecretStore>, Arc<dyn SecretResolver>) = match backend {
        SecretBackend::Env => {
            let store: Arc<dyn SecretStore> =
                Arc::new(EnvSecretStore::from_process("NEOTA_SECRET_"));
            let resolver: Arc<dyn SecretResolver> = Arc::new(HeadlessStoreResolver::new(
                SecretRefKind::Env,
                Arc::clone(&store),
                "env",
            ));
            (store, resolver)
        }
        SecretBackend::Session => {
            let store: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
            let resolver: Arc<dyn SecretResolver> = Arc::new(HeadlessStoreResolver::new(
                SecretRefKind::Session,
                Arc::clone(&store),
                "session",
            ));
            (store, resolver)
        }
        SecretBackend::Unavailable => (
            Arc::new(UnavailableSecretStore),
            Arc::new(UnavailableSecretResolver),
        ),
        SecretBackend::Portable {
            enc_path,
            passphrase_path,
        } => {
            let store: Arc<dyn SecretStore> = open_portable(enc_path, passphrase_path)?;
            let resolver: Arc<dyn SecretResolver> = Arc::new(HeadlessStoreResolver::new(
                SecretRefKind::Portable,
                Arc::clone(&store),
                "portable",
            ));
            (store, resolver)
        }
    };
    kernel.set_secret_store(Arc::clone(&store));
    kernel.set_secret_resolver(resolver);
    Ok(store)
}

/// Opens an existing `secrets.enc` or creates it on first launch (ADR-0040
/// §2 first-launch semantics). The passphrase comes from a file — never
/// argv (process lists) and never an env value (environments leak); only
/// the file PATH may arrive through argv/env.
fn open_portable(
    enc_path: &Path,
    passphrase_path: &Path,
) -> Result<Arc<FileEncryptedSecretStore>, String> {
    let passphrase = read_passphrase(passphrase_path)?;
    let store = Arc::new(FileEncryptedSecretStore::new(enc_path));
    if enc_path.exists() {
        store.open(&passphrase).map_err(|err| {
            format!(
                "secrets.enc open failed ({}) — wrong master passphrase or \
                 corrupt file; failing closed, never a plaintext fallback",
                err.code
            )
        })?;
    } else {
        store
            .create(&passphrase)
            .map_err(|err| format!("secrets.enc create failed ({}) — failing closed", err.code))?;
    }
    Ok(store)
}

/// Reads the master passphrase from `path`, stripping exactly one trailing
/// `\r\n` or `\n` (the convention `printf '%s\n' passphrase > file`
/// produces). An empty file is a usage error, not an empty passphrase.
fn read_passphrase(path: &Path) -> Result<String, String> {
    let raw = fs::read_to_string(path).map_err(|err| {
        format!(
            "secret passphrase file {} is unreadable: {err}",
            path.display()
        )
    })?;
    let trimmed = raw
        .strip_suffix("\r\n")
        .or_else(|| raw.strip_suffix('\n'))
        .unwrap_or(&raw);
    if trimmed.is_empty() {
        return Err(format!(
            "secret passphrase file {} is empty — refusing to create/open \
             secrets.enc with an empty master passphrase",
            path.display()
        ));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_kernel::KernelConfig;

    fn open_kernel(root: &Path) -> Kernel {
        Kernel::open(KernelConfig {
            expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
            ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
            data_root: Some(root.to_path_buf()),
        })
        .expect("kernel opens")
    }

    #[test]
    fn portable_backend_creates_opens_and_resolves() {
        let root = tempfile::tempdir().expect("tempdir");
        let enc = root.path().join("secrets.enc");
        let pass = root.path().join("passphrase.txt");
        fs::write(&pass, b"correct horse battery\n").expect("passphrase file");

        let kernel = open_kernel(root.path());
        let backend = SecretBackend::Portable {
            enc_path: enc.clone(),
            passphrase_path: pass.clone(),
        };

        // First launch: the file does not exist yet — created, then wired.
        let store = wire_secrets(&kernel, &backend).expect("first launch creates");
        assert!(enc.exists(), "secrets.enc created on first launch");
        let reference = store
            .put("provider:openai", "headless", "sk-sentinel")
            .expect("put");
        assert!(reference.starts_with("portable:"), "portable ref");

        // The kernel-side resolver serves the value back at the point of use.
        let resolver =
            HeadlessStoreResolver::new(SecretRefKind::Portable, Arc::clone(&store), "portable");
        let value = resolver
            .resolve(&SecretRef(reference.clone()))
            .expect("resolves");
        assert_eq!(value.expose(), "sk-sentinel");
        drop(kernel); // release the exclusive data-root lease
    }

    #[test]
    fn portable_backend_reopens_an_existing_file_and_keeps_records() {
        let root = tempfile::tempdir().expect("tempdir");
        let enc = root.path().join("secrets.enc");
        let pass = root.path().join("passphrase.txt");
        fs::write(&pass, "restart-pass").expect("passphrase file");
        let backend = SecretBackend::Portable {
            enc_path: enc.clone(),
            passphrase_path: pass.clone(),
        };

        let kernel = open_kernel(root.path());
        let store = wire_secrets(&kernel, &backend).expect("first launch creates");
        store
            .put("provider:openai", "durable", "sk-persisted")
            .expect("put");
        drop(kernel);
        drop(store);

        // Second launch: the file exists — opened with the same passphrase,
        // records survive.
        let kernel = open_kernel(root.path());
        let store = wire_secrets(&kernel, &backend).expect("reopen");
        let found = store.get("provider:openai", "durable").expect("get");
        assert_eq!(found.as_deref(), Some("sk-persisted"));
        drop(kernel);
    }

    #[test]
    fn wrong_passphrase_fails_closed_and_wires_nothing() {
        let root = tempfile::tempdir().expect("tempdir");
        let enc = root.path().join("secrets.enc");
        let pass = root.path().join("passphrase.txt");
        fs::write(&pass, "right-passphrase").expect("passphrase file");

        let kernel = open_kernel(root.path());
        let backend = SecretBackend::Portable {
            enc_path: enc.clone(),
            passphrase_path: pass.clone(),
        };
        wire_secrets(&kernel, &backend).expect("create with the right passphrase");
        drop(kernel);

        let kernel = open_kernel(root.path());
        let wrong_pass = root.path().join("wrong.txt");
        fs::write(&wrong_pass, "wrong-passphrase").expect("wrong passphrase file");
        let backend = SecretBackend::Portable {
            enc_path: enc,
            passphrase_path: wrong_pass,
        };
        let err = match wire_secrets(&kernel, &backend) {
            Ok(_) => panic!("wrong passphrase must fail closed"),
            Err(err) => err,
        };
        assert!(err.contains("failing closed"), "{err}");

        // The kernel was left without a store seam: a provider key write
        // fails with the stable unavailable error (dispatch-level Conflict
        // carrying the product code), never plaintext and never a fallback
        // store.
        let flag = runtime_kernel::CancellationFlag::new();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "provider": "openai",
            "name": "local",
            "config": { "baseUrl": "https://api.openai.com/v1", "model": "mock-1" },
            "apiKey": "sk-x",
        }))
        .expect("serialize");
        match kernel.dispatch("providers.config.set", &bytes, &flag) {
            Err(err) => {
                let rendered = format!("{err:?}");
                assert!(
                    rendered.contains("SECRET_UNAVAILABLE"),
                    "unexpected dispatch error: {rendered}"
                );
            }
            Ok(body) => {
                let response: serde_json::Value =
                    serde_json::from_slice(&body).expect("response json");
                assert_eq!(
                    response["error"]["code"],
                    serde_json::json!("SECRET_UNAVAILABLE")
                );
            }
        }
    }

    #[test]
    fn empty_passphrase_file_is_a_startup_error() {
        let root = tempfile::tempdir().expect("tempdir");
        let enc = root.path().join("secrets.enc");
        let pass = root.path().join("passphrase.txt");
        fs::write(&pass, b"\n").expect("newline-only file");
        let kernel = open_kernel(root.path());
        let backend = SecretBackend::Portable {
            enc_path: enc,
            passphrase_path: pass,
        };
        let err = match wire_secrets(&kernel, &backend) {
            Ok(_) => panic!("empty passphrase refused"),
            Err(err) => err,
        };
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn unavailable_backend_resolves_nothing() {
        let root = tempfile::tempdir().expect("tempdir");
        let kernel = open_kernel(root.path());
        wire_secrets(&kernel, &SecretBackend::Unavailable).expect("wires");
        let resolver = UnavailableSecretResolver;
        let err = resolver
            .resolve(&SecretRef("portable:ns:id".to_string()))
            .expect_err("fail-closed");
        assert_eq!(err.code, ProviderErrorCode::Unavailable);
    }
}
