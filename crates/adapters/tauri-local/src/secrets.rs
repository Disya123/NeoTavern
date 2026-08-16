//! Desktop host secret seams (ТЗ §SEC-01, М5 slice 49).
//!
//! The kernel holds SecretStore/SecretResolver **port handles** — the host
//! must provide the actual backends. The Desktop host currently wires the
//! explicit **session-only** backend:
//!
//! - [`MemorySecretStore`] as the writable store (keys live only in process
//!   memory, gone after restart — the DB keeps opaque `session:` references
//!   and the runtime reports a stable unavailable state until the user
//!   re-enters the key);
//! - [`SessionSecretResolver`] as the execution-time seam, resolving exactly
//!   the `session:` references this store produced.
//!
//! This is an explicit SEC-01 interim: there is never a plaintext fallback —
//! a `portable:`/`env:` reference resolves to a typed `Unavailable` error,
//! and a missing record resolves to `Unknown`. The OS-vault (Installed
//! Desktop) and Android Keystore adapters remain follow-up slices; when they
//! land, only [`wire_session_secrets`] changes.

use runtime_kernel::Kernel;
use secret_store::refs::SecretRefKind;
use secret_store::{MemorySecretStore, SecretStore};
use std::sync::Arc;

use provider_sdk::secret::{SecretRef, SecretResolver, SecretValue};
use provider_sdk::{ProviderError, ProviderErrorCode};

/// Execution-time resolver backed by the same [`MemorySecretStore`] the host
/// wired as the kernel's writable store.
#[derive(Debug, Clone)]
pub struct SessionSecretResolver {
    store: Arc<MemorySecretStore>,
}

impl SessionSecretResolver {
    /// Wraps a session store.
    pub fn new(store: Arc<MemorySecretStore>) -> Self {
        Self { store }
    }
}

impl SecretResolver for SessionSecretResolver {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        let parsed = secret_store::refs::parse_ref(&reference.0).ok_or_else(|| {
            ProviderError::with(
                ProviderErrorCode::Unavailable,
                "unrecognized secret reference",
                vec![("secretRef".to_string(), reference.0.clone())],
            )
        })?;
        if parsed.kind != SecretRefKind::Session {
            return Err(ProviderError::with(
                ProviderErrorCode::Unavailable,
                "session secret store cannot serve this reference kind",
                vec![("kind".to_string(), parsed.kind.prefix().to_string())],
            ));
        }
        match self.store.get(&parsed.namespace, &parsed.id) {
            Ok(Some(value)) => Ok(SecretValue::new(value)),
            Ok(None) => Err(ProviderError::with(
                ProviderErrorCode::Unavailable,
                "secret not present in the session store (restart clears session secrets)",
                vec![
                    ("namespace".to_string(), parsed.namespace),
                    ("id".to_string(), parsed.id),
                ],
            )),
            Err(err) => Err(ProviderError::with(
                ProviderErrorCode::Unavailable,
                "session secret store is unavailable",
                vec![("code".to_string(), err.code.to_string())],
            )),
        }
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
}
