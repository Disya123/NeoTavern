//! Live provider access operations (M7 Etap-4 cluster 8):
//! `providers.models` (model discovery) and `providers.test` (one small
//! non-streaming test message).
//!
//! Both address ONE stored config by id and run on the kernel writer thread:
//! the kernel is a synchronous single writer, so a provider round-trip blocks
//! the writer exactly like one generation step does. The adapter is
//! materialized from THAT row (`config_adapter`) so the endpoint and the key
//! follow the addressed config instead of "the adapter registered for this
//! provider kind"; built-in adapters (`fake`) fall back to the registry.
//!
//! Secrets: the API key is resolved per config (ACTIVE named key first, else
//! the config-level `secret_ref`) through the host `SecretResolver` seam and is
//! used only to build the outgoing request — never logged, stored or echoed
//! (the DTOs carry no key material at all). No reference at all is `Ok(None)`:
//! the adapter decides, and a keyless adapter reports its own typed error.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use contracts_generated::generated::{
    self, ProviderModel, ProviderTestUsage, ResultProviderModels, ResultProviderTest,
};
use neotavern_storage::open::Database;
use provider_sdk::policy::Deadline;
use provider_sdk::secret::SecretResolver;
use provider_sdk::{
    CancelToken, EmitStatus, PromptMessage, ProviderAdapter, ProviderError, ProviderErrorCode,
    ProviderEvent, ProviderRequest,
};

use crate::providers::{config_adapter, ProviderRegistry};
use crate::providers_config;
use crate::{KernelError, KernelErrorCode};

/// Deadline for one model-discovery round-trip (a `/models` listing).
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);
/// Deadline for the test message: the legacy route used `readMs * 4`.
const TEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Upper bound on captured test text (the wire DTO is bounded at 65536).
const TEST_TEXT_MAX_CHARS: usize = 60_000;

/// Product error for a config id that no row owns.
fn config_not_found(provider_id: &str) -> KernelError {
    KernelError::product(
        "PROVIDER_CONFIG_NOT_FOUND".to_string(),
        vec![("providerId".to_string(), provider_id.to_string())],
    )
}

/// Product error for a config that names no model (the test op needs one).
fn model_required(provider_id: &str) -> KernelError {
    KernelError::product(
        "PROVIDER_MODEL_REQUIRED".to_string(),
        vec![("providerId".to_string(), provider_id.to_string())],
    )
}

/// Maps a normalized provider error to a stable product code (documented in
/// `docs/architecture/providers.md`): the message stays in the kernel log, the
/// wire carries only the code plus non-secret params.
pub(crate) fn provider_error(err: &ProviderError) -> KernelError {
    let code = match err.code {
        ProviderErrorCode::Timeout => "PROVIDER_TIMEOUT",
        ProviderErrorCode::Cancelled => "CANCELLED",
        ProviderErrorCode::Unavailable => "PROVIDER_UNAVAILABLE",
        ProviderErrorCode::RequestInvalid => "PROVIDER_MODEL_INVALID",
        ProviderErrorCode::StepFailed => "PROVIDER_STEP_FAILED",
        ProviderErrorCode::NetworkFault => "PROVIDER_NETWORK_FAULT",
        ProviderErrorCode::CapabilityUnavailable => "CAPABILITY_UNAVAILABLE",
    };
    let params = err
        .params
        .iter()
        .filter(|(key, _)| matches!(key.as_str(), "provider" | "model" | "httpStatus"))
        .cloned()
        .collect();
    KernelError::product(code.to_string(), params)
}

/// Resolves the adapter for one addressed config: a fresh per-config adapter
/// for known kinds (openai / openai-compatible), else the registered built-in
/// adapter of that provider id (`fake`). No adapter at all is an honest
/// `CAPABILITY_UNAVAILABLE`, never a fabricated result.
pub(crate) fn resolve_adapter(
    registry: &ProviderRegistry,
    provider: &str,
    config: &serde_json::Value,
) -> Result<Arc<dyn ProviderAdapter>, KernelError> {
    config_adapter(provider, config)
        .or_else(|| registry.find(provider))
        .ok_or_else(|| {
            KernelError::product(
                "CAPABILITY_UNAVAILABLE".to_string(),
                vec![("provider".to_string(), provider.to_string())],
            )
        })
}

/// Reads the model the config names: the hoisted `model` string first, then
/// `models[0].id` (the adapter's own fallback default is not guessed here — the
/// test op must be explicit about which model it billable-pings).
pub(crate) fn config_model(config: &serde_json::Value) -> Option<String> {
    let hoisted = config.get("model").and_then(|value| value.as_str());
    let listed = config
        .get("models")
        .and_then(|value| value.as_array())
        .and_then(|models| models.first())
        .and_then(|model| model.get("id"))
        .and_then(|value| value.as_str());
    hoisted
        .or(listed)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
}

/// `providers.models` — live model discovery for the addressed config.
pub(crate) fn models(
    db: &mut Database,
    registry: &ProviderRegistry,
    resolver: Option<&dyn SecretResolver>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_provider_models(request)?;
    let (provider, config) = providers_config::load_config_by_id(db.conn(), &req.provider_id)?
        .ok_or_else(|| config_not_found(&req.provider_id))?;
    let adapter = resolve_adapter(registry, &provider, &config)?;
    let api_key =
        providers_config::resolve_config_api_key(db.conn(), resolver, &req.provider_id, &provider)?;
    let discovered = adapter
        .discover_models(api_key.as_deref(), Some(Deadline::after(DISCOVERY_TIMEOUT)))
        .map_err(|err| provider_error(&err))?;
    let dto = ResultProviderModels {
        models: discovered
            .into_iter()
            .map(|model| ProviderModel {
                id: model.id,
                name: model.name,
                context_limit: model.context_limit,
                max_output_tokens: model.max_output_tokens,
            })
            .collect(),
    };
    validate(&dto, generated::validate_result_provider_models)?;
    encode(&dto)
}

/// `providers.test` — ONE non-streaming message through the addressed config
/// (legacy `/providers/:id/test` parity): the answer text plus the kernel
/// attempt accounting. Fails with the normalized provider product code; the
/// message never reaches the wire.
pub(crate) fn test(
    db: &mut Database,
    registry: &ProviderRegistry,
    resolver: Option<&dyn SecretResolver>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_provider_test(request)?;
    let (provider, config) = providers_config::load_config_by_id(db.conn(), &req.provider_id)?
        .ok_or_else(|| config_not_found(&req.provider_id))?;
    let model = req
        .model
        .clone()
        .or_else(|| config_model(&config))
        .ok_or_else(|| model_required(&req.provider_id))?;
    let adapter = resolve_adapter(registry, &provider, &config)?;
    let api_key =
        providers_config::resolve_config_api_key(db.conn(), resolver, &req.provider_id, &provider)?;
    let run_key = format!("provider-test|{}|{}", req.provider_id, uuid::Uuid::now_v7());
    let messages = [PromptMessage {
        role: "user",
        content: &req.message,
        tool_calls: None,
        tool_call_id: None,
    }];
    let provider_request = ProviderRequest {
        provider_id: &provider,
        model: &model,
        input: &req.message,
        run_key: &run_key,
        deadline: Some(Deadline::after(TEST_TIMEOUT)),
        api_key: api_key.as_deref(),
        messages: Some(&messages),
        tools: None,
    };
    let cancel = AtomicBool::new(false);
    let mut text = String::new();
    let usage = adapter
        .generate(&provider_request, CancelToken::new(&cancel), &mut |event| {
            if let ProviderEvent::Delta { text: delta } = event {
                if text.chars().count() < TEST_TEXT_MAX_CHARS {
                    text.push_str(&delta);
                }
            }
            EmitStatus::Continue
        })
        .map_err(|err| provider_error(&err))?;
    let dto = ResultProviderTest {
        text,
        usage: ProviderTestUsage {
            steps: usage.steps as i64,
            output_chars: usage.output_chars as i64,
        },
    };
    validate(&dto, generated::validate_result_provider_test)?;
    encode(&dto)
}

// --- helpers (mirrors provider_secrets / providers_config). ---

fn validate<T: serde::Serialize>(
    value: &T,
    check: fn(&serde_json::Value) -> Result<(), Vec<contracts_generated::Issue>>,
) -> Result<(), KernelError> {
    let json = serde_json::to_value(value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize provider-access dto: {err}"),
        )
    })?;
    check(&json).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "provider-access dto failed wire validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })
}

fn encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, KernelError> {
    // Bounded serialization (plan rev 2.2 Layer C) — shared LimitedWriter.
    crate::product::encode(value)
}
