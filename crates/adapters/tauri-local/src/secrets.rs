//! Desktop host secret seams (ТЗ §SEC-01, M5 slice 49 + 58).
//!
//! The kernel holds SecretStore/SecretResolver **port handles** — the host
//! must provide the actual backends. The Desktop host wires one of:
//!
//! - [`MemorySecretStore`] + [`SessionSecretResolver`] — explicit
//!   **session-only** backend (keys live only in process memory, gone after
//!   restart — the DB keeps opaque `session:` references and the runtime
//!   reports a stable unavailable state until the user re-enters the key);
//! - `os-vault` feature: [`OsVaultSecretStore`] +
//!   [`OsvaultSecretResolver`] — machine-bound OS credential vault (Windows
//!   Credential Manager / macOS Keychain / Linux Secret Service); a
//!   non-reachable vault reports `SECRET_UNAVAILABLE_ON_THIS_DEVICE`, never
//!   a plaintext fallback;
//! - the portable `secrets.enc` backend is a follow-up slice (passphrase
//!   unlock UX) — when it lands, only the wiring below changes.
//!
//! There is never a plaintext fallback: a reference of a foreign kind (e.g.
//! `portable:`/`env:` against the session store) resolves to a typed
//! `Unavailable` error, and a missing record resolves to `Unknown`.

use runtime_kernel::Kernel;
use secret_store::refs::SecretRefKind;
use secret_store::{MemorySecretStore, SecretStore};
use std::sync::Arc;

use provider_sdk::secret::{SecretRef, SecretResolver, SecretValue};
use provider_sdk::{ProviderError, ProviderErrorCode};

/// Execution-time resolver over one concrete store kind: parses the opaque
/// reference, refuses any other kind (fail-closed — a store never serves a
/// reference it did not produce) and resolves the value at the point of use.
#[derive(Clone)]
pub struct StoreSecretResolver {
    kind: SecretRefKind,
    store: Arc<dyn SecretStore>,
    /// Human label for the unavailable diagnostic (never a value).
    label: &'static str,
}

impl StoreSecretResolver {
    /// Wraps `store` as the resolver for references of `kind`.
    pub fn new(kind: SecretRefKind, store: Arc<dyn SecretStore>, label: &'static str) -> Self {
        Self { kind, store, label }
    }
}

impl SecretResolver for StoreSecretResolver {
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

/// Execution-time resolver backed by the same [`MemorySecretStore`] the host
/// wired as the kernel's writable session store.
#[derive(Clone)]
pub struct SessionSecretResolver {
    inner: StoreSecretResolver,
}

impl SessionSecretResolver {
    /// Wraps a session store.
    pub fn new(store: Arc<MemorySecretStore>) -> Self {
        Self {
            inner: StoreSecretResolver::new(
                SecretRefKind::Session,
                store as Arc<dyn SecretStore>,
                "session",
            ),
        }
    }
}

impl SecretResolver for SessionSecretResolver {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        self.inner.resolve(reference)
    }
}

/// Wires the session-only secret seams into a freshly opened kernel: the
/// writable store (so `providers.config.set apiKey` succeeds for the session)
/// and the execution-time resolver (so a run can resolve the key at the point
/// of use). Returns the store handle for diagnostics/tests.
pub fn wire_session_secrets(kernel: &Kernel) -> Arc<MemorySecretStore> {
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(Arc::clone(&store) as Arc<dyn SecretStore>);
    kernel.set_secret_resolver(Arc::new(SessionSecretResolver::new(Arc::clone(&store))));
    store
}

/// Execution-time resolver for machine-bound OS vault references.
#[cfg(feature = "os-vault")]
#[derive(Clone)]
pub struct OsvaultSecretResolver {
    inner: StoreSecretResolver,
}

#[cfg(feature = "os-vault")]
impl OsvaultSecretResolver {
    /// Wraps the OS vault store.
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self {
            inner: StoreSecretResolver::new(SecretRefKind::OsVault, store, "os vault"),
        }
    }
}

#[cfg(feature = "os-vault")]
impl SecretResolver for OsvaultSecretResolver {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        self.inner.resolve(reference)
    }
}

/// Wires the machine-bound OS vault seams (SEC-01.1 machine-bound mode) into
/// a freshly opened kernel. The vault must be reachable; when it is not, the
/// kernel reports the stable `SECRET_UNAVAILABLE_ON_THIS_DEVICE` — never a
/// plaintext fallback and never a silently empty store.
#[cfg(feature = "os-vault")]
pub fn wire_osvault_secrets(kernel: &Kernel) -> Arc<secret_store::OsVaultSecretStore> {
    let store = Arc::new(secret_store::OsVaultSecretStore::new());
    kernel.set_secret_store(Arc::clone(&store) as Arc<dyn SecretStore>);
    kernel.set_secret_resolver(Arc::new(OsvaultSecretResolver::new(
        Arc::clone(&store) as Arc<dyn SecretStore>
    )));
    store
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolver_serves_session_refs_written_by_the_store() {
        let store = Arc::new(MemorySecretStore::new());
        let resolver = SessionSecretResolver::new(Arc::clone(&store));
        let reference = store
            .put("provider:openai", "local", "sk-sentinel")
            .expect("put");
        assert!(reference.starts_with("session:"), "opaque session ref");

        let value = resolver.resolve(&SecretRef(reference)).expect("resolves");
        assert_eq!(value.expose(), "sk-sentinel");
    }

    #[test]
    fn resolver_fails_closed_for_missing_and_foreign_kinds() {
        let store = Arc::new(MemorySecretStore::new());
        let resolver = SessionSecretResolver::new(Arc::clone(&store));

        // Session ref to a record that does not exist → Unavailable, not a
        // value and never a plaintext fallback.
        let missing = store.make_ref(SecretRefKind::Session, "provider:openai", "absent");
        let err = resolver
            .resolve(&SecretRef(missing))
            .expect_err("must fail");
        assert_eq!(err.code, ProviderErrorCode::Unavailable);

        // A portable ref cannot be served by the session store → Unavailable.
        let portable =
            secret_store::refs::make_ref(SecretRefKind::Portable, "provider:openai", "rec-1");
        let err = resolver
            .resolve(&SecretRef(portable))
            .expect_err("must fail");
        assert_eq!(err.code, ProviderErrorCode::Unavailable);

        // Garbage → Unavailable.
        let err = resolver
            .resolve(&SecretRef("not-a-ref".to_string()))
            .expect_err("must fail");
        assert_eq!(err.code, ProviderErrorCode::Unavailable);
    }

    #[test]
    fn wire_session_secrets_makes_the_kernel_store_writable() {
        let root = tempfile::tempdir().expect("tempdir");
        let kernel = runtime_kernel::Kernel::open(runtime_kernel::KernelConfig {
            expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
            ffi_abi_version: 1,
            data_root: Some(root.path().to_path_buf()),
        })
        .expect("kernel opens");
        let store = wire_session_secrets(&kernel);

        // The store seam is the same handle the resolver reads from.
        let reference = store.put("provider:openai", "local", "sk-x").expect("put");
        assert!(reference.starts_with("session:"));

        // kernel-side: a provider config with apiKey now commits instead of
        // failing SECRET_UNAVAILABLE (the host previously wired no store).
        let flag = runtime_kernel::CancellationFlag::new();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "provider": "openai",
            "name": "local",
            "config": { "baseUrl": "https://api.openai.com/v1", "model": "mock-1" },
            "apiKey": "sk-x",
        }))
        .expect("serialize");
        let response: serde_json::Value = serde_json::from_slice(
            &kernel
                .dispatch("providers.config.set", &bytes, &flag)
                .expect("dispatch"),
        )
        .expect("response json");
        assert_eq!(response["hasApiKey"], serde_json::json!(true));

        // And the resolver serves the key back at execution time.
        let resolver = SessionSecretResolver::new(store);
        let value = resolver.resolve(&SecretRef(reference)).expect("resolves");
        assert_eq!(value.expose(), "sk-x");
    }

    #[cfg(feature = "os-vault")]
    #[test]
    fn osvault_resolver_serves_osvault_refs_and_refuses_foreign_kinds() {
        use secret_store::OsVaultSecretStore;

        let store = Arc::new(OsVaultSecretStore::new());
        let resolver = OsvaultSecretResolver::new(Arc::clone(&store) as Arc<dyn SecretStore>);

        // Foreign kinds always fail with Unavailable — no vault needed.
        let session =
            secret_store::refs::make_ref(SecretRefKind::Session, "provider:openai", "rec-1");
        let err = resolver
            .resolve(&SecretRef(session))
            .expect_err("session ref must fail");
        assert_eq!(err.code, ProviderErrorCode::Unavailable);

        // Garbage → Unavailable.
        let err = resolver
            .resolve(&SecretRef("not-a-ref".to_string()))
            .expect_err("garbage must fail");
        assert_eq!(err.code, ProviderErrorCode::Unavailable);

        // A real round trip needs a reachable OS vault (headless CI runners
        // often have none — skip, never fail).
        if !store.is_available() {
            return;
        }
        let reference = store
            .put("provider:openai", "dsh-slice-58", "sk-sentinel")
            .expect("put on an available vault");
        assert!(reference.starts_with("osvault:"));
        // Sandboxed runners may accept CredWrite without persisting the
        // credential (see os_vault module docs); skip visibility assertions
        // there instead of failing the machine's vault limitations.
        match resolver.resolve(&SecretRef(reference)) {
            Ok(value) => assert_eq!(value.expose(), "sk-sentinel"),
            Err(_) => {
                eprintln!("runner OS vault does not persist writes; skipping resolver visibility");
                let _ = store.delete("provider:openai", "dsh-slice-58");
                return;
            }
        }
        assert!(store
            .delete("provider:openai", "dsh-slice-58")
            .expect("delete"));
    }

    #[cfg(feature = "os-vault")]
    #[test]
    fn wire_osvault_secrets_wires_the_kernel_store_seam() {
        let root = tempfile::tempdir().expect("tempdir");
        let kernel = runtime_kernel::Kernel::open(runtime_kernel::KernelConfig {
            expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
            ffi_abi_version: 1,
            data_root: Some(root.path().to_path_buf()),
        })
        .expect("kernel opens");
        let store = wire_osvault_secrets(&kernel);

        // The store seam is wired; a config commit must not hit the
        // fail-closed "no store" path. When the vault is reachable the
        // commit succeeds; when it is not, the operation fails with the
        // stable SECRET_UNAVAILABLE code — never a plaintext fallback.
        let flag = runtime_kernel::CancellationFlag::new();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "provider": "openai",
            "name": "local",
            "config": { "baseUrl": "https://api.openai.com/v1", "model": "mock-1" },
            "apiKey": "sk-x",
        }))
        .expect("serialize");
        let response: serde_json::Value = serde_json::from_slice(
            &kernel
                .dispatch("providers.config.set", &bytes, &flag)
                .expect("dispatch"),
        )
        .expect("response json");
        let store_info = store.describe();
        if store_info.available {
            assert_eq!(response["hasApiKey"], serde_json::json!(true));
        } else {
            assert_eq!(
                response["error"]["code"],
                serde_json::json!("SECRET_UNAVAILABLE")
            );
        }
    }
}
