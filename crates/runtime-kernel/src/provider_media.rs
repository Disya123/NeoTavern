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

use contracts_generated::generated::{self, ResultProviderTranscribe, ResultProvidersSpeech};
use neotavern_storage::open::Database;
use provider_sdk::policy::Deadline;
use provider_sdk::secret::SecretResolver;
use provider_sdk::{SpeechRequest, TranscriptionRequest};
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
/// Hard cap on produced speech (ADR-0063): identical to the op's response
/// budget, so a provider cannot make the kernel stage an unbounded file.
pub(crate) const MAX_SPEECH_BYTES: usize = 8 * 1024 * 1024;

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

fn empty_speech() -> KernelError {
    KernelError::product(
        "SPEECH_EMPTY_AUDIO".to_string(),
        vec![(
            "reason".to_string(),
            "provider returned no bytes".to_string(),
        )],
    )
}

/// Wire enum → the token a provider expects. Keeping this explicit means a new
/// format in the contract is a compile error here instead of a silent `""`.
fn format_str(value: &generated::ProvidersSpeechFormat) -> &'static str {
    use generated::ProvidersSpeechFormat as Format;
    match value {
        Format::Mp3 => "mp3",
        Format::Opus => "opus",
        Format::Aac => "aac",
        Format::Flac => "flac",
        Format::Wav => "wav",
        Format::Pcm => "pcm",
    }
}

/// Keeps the staged filename honest: the extension follows the content type the
/// provider actually produced, never the requested format.
fn extension_for(content_type: &str) -> &'static str {
    match content_type {
        "audio/mpeg" => "mp3",
        "audio/ogg" | "audio/opus" => "opus",
        "audio/aac" => "aac",
        "audio/flac" => "flac",
        "audio/wav" | "audio/x-wav" => "wav",
        _ => "bin",
    }
}

/// `providers.speech` — synthesize text and stage the produced audio.
///
/// The direction of travel is the opposite of transcription: the caller sends
/// text, the kernel publishes the bytes as a `generated-audio` asset
/// (`assets.publish_bytes`, content-addressed, so identical audio dedupes) and
/// answers the asset id. A provider that cannot synthesize answers
/// `CAPABILITY_UNAVAILABLE` through the adapter default; an empty body is a
/// product error rather than a zero-byte asset.
pub(crate) fn speech(
    db: &mut Database,
    registry: &ProviderRegistry,
    resolver: Option<&dyn SecretResolver>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_providers_speech(request)?;
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

    let audio = adapter
        .synthesize(&SpeechRequest {
            provider_id: &provider,
            model: &model,
            text: &req.text,
            voice: req.voice.as_deref(),
            format: req.format.as_ref().map(format_str),
            deadline: Some(Deadline::after(TRANSCRIBE_TIMEOUT)),
            api_key: api_key.as_deref(),
        })
        .map_err(|err| provider_error(&err))?;
    if audio.bytes.is_empty() {
        return Err(empty_speech());
    }
    if audio.bytes.len() > MAX_SPEECH_BYTES {
        return Err(KernelError::product(
            "AUDIO_TOO_LARGE".to_string(),
            vec![
                ("providerId".to_string(), req.provider_id.clone()),
                ("sizeBytes".to_string(), audio.bytes.len().to_string()),
                ("limitBytes".to_string(), MAX_SPEECH_BYTES.to_string()),
            ],
        ));
    }

    let filename = format!("speech.{}", extension_for(&audio.content_type));
    let (asset_id, _) = crate::assets::publish_bytes(
        db,
        "generated-audio",
        &filename,
        &audio.bytes,
        Some(&audio.content_type),
    )?;

    let dto = ResultProvidersSpeech {
        asset_id,
        content_type: audio.content_type,
        size_bytes: audio.bytes.len() as i64,
        model,
        duration_ms: audio.duration_ms.map(|value| value as i64),
    };
    crate::product::validate(&dto, generated::validate_result_providers_speech)?;
    crate::product::encode(&dto)
}
