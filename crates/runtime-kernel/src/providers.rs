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

    /// Registers an adapter under its [`id`](ProviderAdapter::id), replacing
    /// any previously registered adapter of the same id (kernel hydration of
    /// a re-saved provider config must not accumulate duplicates).
    pub fn register_or_replace(&mut self, adapter: Arc<dyn ProviderAdapter>) {
        let id = adapter.id().to_string();
        self.adapters.retain(|existing| existing.id() != id);
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
    /// The kernel's declarative tool registry (ТЗ §8.3, Этап 2.7): the
    /// contracts the executor validates provider tool calls against. Tools
    /// are never executed by the kernel — the host performs the effect and
    /// submits the result via `generation.tool.result`.
    pub tools: crate::tools::ToolRegistry,
}

impl ProviderState {
    /// Fresh writer state: built-in adapters, no resolver, no store, default
    /// timeout, empty tool registry.
    pub fn new_builtins() -> Self {
        Self {
            registry: ProviderRegistry::new_builtins(),
            secret_resolver: None,
            secret_store: None,
            run_timeout: RUN_TIMEOUT,
            tools: crate::tools::ToolRegistry::new(),
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
            capabilities: {
                let caps = adapter.capabilities();
                generated::ProviderCapabilities {
                    tools: caps.tools,
                    vision: caps.vision,
                    thinking: caps.thinking,
                    json_mode: caps.json_mode,
                    streaming: caps.streaming,
                }
            },
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
    // Bounded serialization (plan rev 2.2 Layer C) — shared LimitedWriter.
    crate::product::encode(&value)
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

// ---------------------------------------------------------------------------
// Adapter hydration from stored provider configs (M5 slice 48)
// ---------------------------------------------------------------------------

/// Builds the production adapter for a stored provider config, when the kernel
/// knows how to materialize that provider kind (today: `openai`).
///
/// The wire `config` blob is the non-secret settings object the UI stores
/// through `providers.config.set` (connection fields like `baseUrl`/`model`
/// hoisted by the bridge). Returns `None` for unknown kinds and logs a
/// one-line diagnostic (never the config contents — SEC-07) when a known kind
/// fails to parse. Host-registered adapters are untouched: registration is
/// keyed by adapter id, and `register_or_replace` replaces only the
/// kernel-hydrated instance of the same kind.
pub(crate) fn register_config_adapter(
    registry: &mut ProviderRegistry,
    provider: &str,
    config: &serde_json::Value,
) {
    let adapter: Option<Arc<dyn ProviderAdapter>> = match provider {
        "openai" => {
            let normalized = normalize_openai_config(config);
            match provider_openai_compat::OpenAICompatProvider::from_config("openai", &normalized) {
                Ok(adapter) => Some(Arc::new(adapter)),
                Err(err) => {
                    eprintln!("kernel: provider 'openai' config rejected: {err}");
                    None
                }
            }
        }
        _ => None,
    };
    if let Some(adapter) = adapter {
        registry.register_or_replace(adapter);
    }
}

/// Translates the wire openai config blob into the adapter's
/// [`ProviderConfig`](provider_openai_compat::ProviderConfig) shape.
///
/// The UI stores a single `model` string (legacy hoist); the adapter expects
/// the `models` array. A missing `models` array is derived from `model` so a
/// config saved through the production UI is immediately generatable.
fn normalize_openai_config(config: &serde_json::Value) -> serde_json::Value {
    let config = config.as_object().cloned().unwrap_or_default();
    let models = config
        .get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .filter(|items| !items.is_empty());
    let models: serde_json::Value = match models {
        Some(items) => serde_json::Value::Array(items),
        None => match config.get("model").and_then(|m| m.as_str()) {
            Some(model) => serde_json::json!([{ "id": model }]),
            None => serde_json::json!([]),
        },
    };
    let mut normalized = serde_json::Map::new();
    for key in [
        "baseUrl",
        "timeoutMs",
        "organization",
        "maxResponseBytes",
        "maxTokens",
    ] {
        if let Some(value) = config.get(key) {
            normalized.insert(key.to_string(), value.clone());
        }
    }
    normalized.insert("models".to_string(), models);
    serde_json::Value::Object(normalized)
}
