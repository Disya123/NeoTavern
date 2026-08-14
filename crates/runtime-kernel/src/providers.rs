//! Phase 7 provider registry and `providers.list` (ТЗ §55, §60).
//!
//! The registry owns the provider adapters the generation executor routes
//! through ([`ProviderRegistry`]). [`ProviderRegistry::new_builtins`]
//! registers the built-in `fake` provider (portable adapter in
//! `built-in-providers`, byte-identical to the Phase 6 inline fake); hosts
//! can add adapters at runtime via [`register`](Self::register). Listing is
//! stable (registration order), which keeps `providers.list` deterministic.
//!
//! `providers.list` is a stateless operation (like `meta.get`): it needs no
//! data root, so a stateless kernel can answer it.

use crate::generation::RUN_TIMEOUT;
use crate::{KernelError, KernelErrorCode};
use contracts_generated::generated::{
    self, ProviderAvailability, ProviderDto, ProviderModel, ResultListProviders,
};
use provider_sdk::secret::SecretResolver;
use provider_sdk::ProviderAdapter;
use secret_store::SecretStore;
use std::sync::Arc;
use std::time::Duration;

/// The kernel's provider registry: stable-order adapter list.
///
/// Adapters are resolved by [`find`](Self::find) for generation execution
/// and listed by [`list`](Self::list) for `providers.list`.
#[derive(Default, Clone)]
pub struct ProviderRegistry {
    adapters: Vec<Arc<dyn ProviderAdapter>>,
}

impl ProviderRegistry {
    /// A registry pre-populated with the kernel's built-in providers
    /// (today: the deterministic `fake` provider).
    pub fn new_builtins() -> Self {
        let mut registry = Self::default();
        registry.register(Arc::new(built_in_providers::FakeProvider::new()));
        registry
    }

    /// Appends an adapter. Registration order == [`list`](Self::list) order.
    pub fn register(&mut self, adapter: Arc<dyn ProviderAdapter>) {
        self.adapters.push(adapter);
    }

    /// Finds the first registered adapter whose
    /// [`id`](ProviderAdapter::id) equals `id`.
    pub fn find(&self, id: &str) -> Option<Arc<dyn ProviderAdapter>> {
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == id)
            .cloned()
    }

    /// All registered adapters in registration order.
    pub fn list(&self) -> Vec<Arc<dyn ProviderAdapter>> {
        self.adapters.clone()
    }
}

/// The writer thread's provider state: the adapter registry plus the
/// host-provided secret-resolution seam (ТЗ §68) and the per-run timeout.
///
/// The kernel holds only the resolver handle — never resolved values — and
/// passes it to the generation executor for adapters that need secrets
/// (the built-in fake/recorded providers ignore the seam). `run_timeout`
/// defaults to [`RUN_TIMEOUT`] and is settable per kernel via
/// `Kernel::set_run_timeout`.
pub(crate) struct ProviderState {
    /// The adapter registry (built-ins + host-registered adapters).
    pub registry: ProviderRegistry,
    /// Host-provided secret resolution seam; `None` until the host sets one.
    pub secret_resolver: Option<Arc<dyn SecretResolver>>,
    /// Host-provided writable SecretStore seam (ТЗ §9.4, §SEC-01); `None`
    /// until the host sets one via [`Kernel::set_secret_store`]. The
    /// provider-config operations store API keys through this seam and only
    /// the opaque reference reaches the database.
    pub secret_store: Option<Arc<dyn SecretStore>>,
    /// Per-run provider deadline for new generations.
    pub run_timeout: Duration,
}

impl ProviderState {
    /// Fresh writer state: built-in adapters, no resolver, no store, default
    /// timeout.
    pub fn new_builtins() -> Self {
        Self {
            registry: ProviderRegistry::new_builtins(),
            secret_resolver: None,
            secret_store: None,
            run_timeout: RUN_TIMEOUT,
        }
    }
}

/// `providers.list` — stateless registry listing (like `meta.get`, no
/// durable storage required). Strict empty request; the response is
/// validated through the generated checker before serialization.
pub(crate) fn handle_providers_list(
    registry: &ProviderRegistry,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    let items = registry
        .list()
        .iter()
        .map(|adapter| ProviderDto {
            id: adapter.id().to_string(),
            name: adapter.name().to_string(),
            builtin: adapter.builtin(),
            availability: map_availability(&adapter.availability()),
            models: adapter
                .models()
                .iter()
                .map(|model| ProviderModel {
                    id: model.id.clone(),
                    name: model.name.clone(),
                    context_limit: model.context_limit,
                    max_output_tokens: model.max_output_tokens,
                })
                .collect(),
        })
        .collect();
    let dto = ResultListProviders { items };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize providers.list response: {err}"),
        )
    })?;
    generated::validate_result_list_providers(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel providers.list response failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize providers.list response: {err}"),
        )
    })
}

/// Maps the sdk [`Availability`](provider_sdk::Availability) onto the wire
/// [`ProviderAvailability`] enum (same `status`-tagged shape).
fn map_availability(availability: &provider_sdk::Availability) -> ProviderAvailability {
    match availability {
        provider_sdk::Availability::Available => ProviderAvailability::Available,
        provider_sdk::Availability::Degraded { code, detail } => ProviderAvailability::Degraded {
            code: code.clone(),
            detail: detail.clone(),
        },
        provider_sdk::Availability::Unavailable { code, detail } => {
            ProviderAvailability::Unavailable {
                code: code.clone(),
                detail: detail.clone(),
            }
        }
    }
}
