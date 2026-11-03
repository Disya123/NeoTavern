//! Media provider operations (ADR-0063): transcription.
//!
//! The operation exchanges ASSETS, never bytes: the caller stages the audio
//! through the ADR-0061 ingestion family and passes `audioAssetId`, the kernel
//! reads the staged bytes (bounded by [`MAX_AUDIO_BYTES`]) and hands them to the
//! addressed provider adapter once. A provider that cannot transcribe answers
//! `CAPABILITY_UNAVAILABLE` through the adapter's default implementation, so a
//! missing capability is reported honestly instead of being masked by an empty
//! transcript.
//!
//! Behavioural rules that matter:
//!
//! - the adapter is materialized from the ADDRESSED config (`config_adapter`),
//!   so endpoint and key follow that row rather than "the adapter registered for
//!   this provider kind";
//! - the audio size is checked BEFORE the file is read, so a hostile 1 GiB asset
//!   cannot be pulled into memory on the writer thread;
//! - the model is explicit (request override, else the config's model) — the
//!   kernel never guesses a transcription model;
//! - cancellation/deadline belong to the adapter call, exactly like the chat
//!   path.

use std::time::Duration;

use contracts_generated::generated::{self, ResultProviderTranscribe};
use neotavern_storage::open::Database;
use provider_sdk::policy::Deadline;
use provider_sdk::secret::SecretResolver;
use provider_sdk::TranscriptionRequest;
use rusqlite::OptionalExtension;

use crate::provider_access::{config_model, provider_error, resolve_adapter};
use crate::providers::ProviderRegistry;
use crate::providers_config;
use crate::{KernelError, KernelErrorCode};

/// Deadline for one transcription call: audio upload plus decoding on the
/// provider side, so it is deliberately larger than a test message.
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(180);
/// Hard cap on the audio handed to an adapter (ADR-0063).
pub(crate) const MAX_AUDIO_BYTES: i64 = 64 * 1024 * 1024;

fn config_not_found(provider_id: &str) -> KernelError {
    KernelError::product(
        "PROVIDER_CONFIG_NOT_FOUND".to_string(),
        vec![("providerId".to_string(), provider_id.to_string())],
    )
}

fn model_required(provider_id: &str) -> KernelError {
    KernelError::product(
        "PROVIDER_MODEL_REQUIRED".to_string(),
        vec![("providerId".to_string(), provider_id.to_string())],
    )
}

fn audio_too_large(asset_id: &str, size: i64) -> KernelError {
    KernelError::product(
        "AUDIO_TOO_LARGE".to_string(),
        vec![
            ("assetId".to_string(), asset_id.to_string()),
            ("sizeBytes".to_string(), size.to_string()),
            ("limitBytes".to_string(), MAX_AUDIO_BYTES.to_string()),
        ],
    )
}

/// The staged audio's relative key and size, plus its declared content type when
/// the asset metadata carries one.
struct StagedAudio {
    relative_key: String,
    size_bytes: i64,
    content_type: String,
}

fn load_audio(db: &Database, asset_id: &str) -> Result<StagedAudio, KernelError> {
    let row: Option<(String, i64, String)> = db
        .conn()
        .query_row(
            "SELECT relative_key, size_bytes, metadata_json FROM __neotavern_assets WHERE id = ?1",
            rusqlite::params![asset_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| crate::product::sqlite(err, "providers.transcribe: asset lookup"))?;
    let Some((relative_key, size_bytes, metadata_json)) = row else {
        return Err(crate::assets::asset_not_found(asset_id));
    };
    if size_bytes > MAX_AUDIO_BYTES {
        return Err(audio_too_large(asset_id, size_bytes));
    }
    let content_type = serde_json::from_str::<serde_json::Value>(&metadata_json)
        .ok()
        .and_then(|value| {
            value
                .get("contentType")
                .and_then(|inner| inner.as_str())
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    Ok(StagedAudio {
        relative_key,
        size_bytes,
        content_type,
    })
}

/// `providers.transcribe` — one transcription through the addressed config.
pub(crate) fn transcribe(
    db: &mut Database,
    registry: &ProviderRegistry,
    resolver: Option<&dyn SecretResolver>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_provider_transcribe(request)?;
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

    let audio = load_audio(db, &req.audio_asset_id)?;
    let path =
        neotavern_storage::assets::resolve_asset_path(db, &audio.relative_key).map_err(|err| {
            KernelError::new(
                KernelErrorCode::StorageFailure,
                format!("providers.transcribe: cannot resolve asset file: {err}"),
            )
        })?;
    let bytes = std::fs::read(&path).map_err(|err| {
        KernelError::new(
            KernelErrorCode::StorageFailure,
            format!("providers.transcribe: cannot read asset file: {err}"),
        )
    })?;
    if bytes.len() as i64 != audio.size_bytes {
        return Err(KernelError::new(
            KernelErrorCode::StorageFailure,
            format!(
                "providers.transcribe: asset size mismatch (row {}, file {})",
                audio.size_bytes,
                bytes.len()
            ),
        ));
    }

    let transcription = adapter
        .transcribe(&TranscriptionRequest {
            provider_id: &provider,
            model: &model,
            audio: &bytes,
            content_type: &audio.content_type,
            language: req.language.as_deref(),
            deadline: Some(Deadline::after(TRANSCRIBE_TIMEOUT)),
            api_key: api_key.as_deref(),
        })
        .map_err(|err| provider_error(&err))?;

    let dto = ResultProviderTranscribe {
        text: transcription.text,
        model,
        language: transcription.language.or_else(|| req.language.clone()),
        duration_ms: transcription.duration_ms.map(|value| value as i64),
    };
    crate::product::validate(&dto, generated::validate_result_provider_transcribe)?;
    crate::product::encode(&dto)
}
