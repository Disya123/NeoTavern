//! `providers.transcribe` (ADR-0063 media operations): transcription of a
//! STAGED audio asset through the addressed provider config.
//!
//! Proves the exchange contract the ADR fixes:
//!
//! - bytes travel as an asset id (ADR-0061 staging), never inside the request;
//! - the addressed config decides adapter/model/key, not "whatever provider
//!   happens to be registered";
//! - a provider without the capability answers `CAPABILITY_UNAVAILABLE`
//!   (the adapter default) instead of returning an empty transcript;
//! - unknown config/asset ids answer product codes, not internal failures;
//! - the deterministic fake provider gives byte-identical results for identical
//!   audio, so the result DTO shape is pinned without a network.

use contracts_generated::generated::{
    ProviderConfigDto, ResultProviderModels, ResultProviderTranscribe, ResultProvidersImages,
    ResultProvidersSpeech,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError};
use serde_json::{json, Value};

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

fn dispatch_decoded<T: serde::de::DeserializeOwned>(
    kernel: &Kernel,
    op: &str,
    request: Value,
) -> Result<T, KernelError> {
    dispatch_json(kernel, op, request).map(|value| {
        serde_json::from_value(value).expect("response must decode as the expected DTO")
    })
}

fn set_config(kernel: &Kernel, provider: &str, name: &str, config: Value) -> ProviderConfigDto {
    dispatch_decoded::<ProviderConfigDto>(
        kernel,
        "providers.config.set",
        json!({ "provider": provider, "name": name, "config": config }),
    )
    .expect("config set must succeed")
}

fn stage_audio(kernel: &Kernel, bytes: &[u8]) -> String {
    let encoded = base64_encode(bytes);
    let asset = dispatch_json(
        kernel,
        "assets.put",
        json!({
            "kind": "audio",
            "filename": "clip.wav",
            "contentType": "audio/wav",
            "contentBase64": encoded,
        }),
    )
    .expect("assets.put must succeed");
    asset["asset"]["id"].as_str().expect("asset id").to_string()
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

fn product_code(err: &KernelError) -> String {
    err.product
        .as_ref()
        .expect("expected a product error")
        .code
        .clone()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn transcribes_a_staged_asset_through_the_addressed_fake_config() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let config = set_config(&kernel, "fake", "local-fake", json!({ "model": "fake-1" }));
    let audio: Vec<u8> = (0..2048u32).map(|i| (i % 251) as u8).collect();
    let asset_id = stage_audio(&kernel, &audio);

    let result = dispatch_decoded::<ResultProviderTranscribe>(
        &kernel,
        "providers.transcribe",
        json!({ "providerId": config.id, "audioAssetId": asset_id, "language": "en" }),
    )
    .expect("transcription must succeed");

    assert_eq!(result.model, "fake-1", "the config's model is used");
    assert_eq!(result.language.as_deref(), Some("en"));
    assert_eq!(result.duration_ms, Some(2048 / 32), "32 bytes per ms");
    assert!(
        result
            .text
            .starts_with("fake transcript: 2048 bytes, sha256 "),
        "unexpected transcript: {}",
        result.text
    );

    // Deterministic: the same bytes must answer the same transcript.
    let again = dispatch_decoded::<ResultProviderTranscribe>(
        &kernel,
        "providers.transcribe",
        json!({ "providerId": config.id, "audioAssetId": asset_id }),
    )
    .expect("second transcription must succeed");
    assert_eq!(again.text, result.text);
    // The fake echoes the request's language hint; without one it reports none
    // rather than inventing a language it did not detect.
    assert_eq!(again.language, None);
}

#[test]
fn request_model_overrides_the_config_model() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let config = set_config(&kernel, "fake", "local-fake", json!({ "model": "fake-1" }));
    let asset_id = stage_audio(&kernel, &[7u8; 64]);

    let result = dispatch_decoded::<ResultProviderTranscribe>(
        &kernel,
        "providers.transcribe",
        json!({ "providerId": config.id, "audioAssetId": asset_id, "model": "fake-2" }),
    )
    .expect("transcription must succeed");
    assert_eq!(result.model, "fake-2");
}

#[test]
fn unknown_config_and_asset_answer_product_codes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let config = set_config(&kernel, "fake", "local-fake", json!({ "model": "fake-1" }));
    let asset_id = stage_audio(&kernel, &[1u8; 32]);

    let missing_config = dispatch_json(
        &kernel,
        "providers.transcribe",
        json!({
            "providerId": "00000000-0000-4000-8000-000000000000",
            "audioAssetId": asset_id,
        }),
    )
    .expect_err("unknown config must fail");
    assert_eq!(product_code(&missing_config), "PROVIDER_CONFIG_NOT_FOUND");

    let missing_asset = dispatch_json(
        &kernel,
        "providers.transcribe",
        json!({
            "providerId": config.id,
            "audioAssetId": "00000000-0000-4000-8000-000000000001",
        }),
    )
    .expect_err("unknown asset must fail");
    assert_eq!(product_code(&missing_asset), "ASSET_NOT_FOUND");
}

#[test]
fn a_provider_without_transcription_answers_capability_unavailable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    // `recorded` replays canned chat turns and inherits the adapter default for
    // media: it must refuse honestly instead of returning an empty transcript.
    let config = set_config(&kernel, "recorded", "replay", json!({ "model": "fake-1" }));
    let asset_id = stage_audio(&kernel, &[3u8; 16]);

    let err = dispatch_json(
        &kernel,
        "providers.transcribe",
        json!({ "providerId": config.id, "audioAssetId": asset_id }),
    )
    .expect_err("a non-media provider must refuse");
    assert_eq!(product_code(&err), "CAPABILITY_UNAVAILABLE");
}

#[test]
fn transcribe_is_listed_and_discoverable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let config = set_config(&kernel, "fake", "local-fake", json!({ "model": "fake-1" }));
    let models = dispatch_decoded::<ResultProviderModels>(
        &kernel,
        "providers.models",
        json!({ "providerId": config.id }),
    )
    .expect("model discovery must succeed");
    assert!(
        models
            .models
            .iter()
            .any(|model| model.id == "fake-1" || model.id == "fake-2"),
        "the fake provider advertises its models"
    );
}

// ---------------------------------------------------------------------------
// Speech synthesis (the other direction of travel)
// ---------------------------------------------------------------------------

#[test]
fn speech_stages_the_produced_audio_as_a_generated_audio_asset() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let config = set_config(&kernel, "fake", "local-fake", json!({ "model": "fake-1" }));

    let result = dispatch_decoded::<ResultProvidersSpeech>(
        &kernel,
        "providers.speech",
        json!({ "providerId": config.id, "text": "hello", "voice": "alloy", "format": "wav" }),
    )
    .expect("synthesis must succeed");

    assert_eq!(result.content_type, "audio/wav");
    assert_eq!(result.model, "fake-1");
    // 5 characters → 5 × 160 samples at 16 kHz → 50 ms.
    assert_eq!(result.duration_ms, Some(50));
    assert_eq!(result.size_bytes, 44 + 5 * 160 * 2, "header + PCM payload");

    let asset = dispatch_json(&kernel, "assets.get", json!({ "assetId": result.asset_id }))
        .expect("the produced asset must be addressable");
    assert_eq!(asset["asset"]["kind"], "generated-audio");
    assert_eq!(asset["asset"]["sizeBytes"], result.size_bytes);

    // The bytes are actually stored, not only counted: RIFF header survives.
    let content = dispatch_json(
        &kernel,
        "assets.content",
        json!({ "assetId": result.asset_id }),
    )
    .expect("content must be readable");
    let encoded = content["contentBase64"].as_str().expect("base64 body");
    assert!(
        encoded.starts_with("UklGR"),
        "expected a RIFF header, got {encoded:.12}"
    );
}

#[test]
fn identical_speech_dedupes_to_one_asset() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let config = set_config(&kernel, "fake", "local-fake", json!({ "model": "fake-1" }));
    let request = json!({ "providerId": config.id, "text": "same words" });
    let first =
        dispatch_decoded::<ResultProvidersSpeech>(&kernel, "providers.speech", request.clone())
            .expect("first synthesis");
    let second = dispatch_decoded::<ResultProvidersSpeech>(&kernel, "providers.speech", request)
        .expect("second synthesis");
    assert_eq!(
        first.asset_id, second.asset_id,
        "content-addressed publish must reuse the row for identical audio"
    );
}

#[test]
fn speech_refuses_honestly_without_the_capability_or_the_config() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let replay = set_config(&kernel, "recorded", "replay", json!({ "model": "fake-1" }));

    let unsupported = dispatch_json(
        &kernel,
        "providers.speech",
        json!({ "providerId": replay.id, "text": "hello" }),
    )
    .expect_err("a non-media provider must refuse");
    assert_eq!(product_code(&unsupported), "CAPABILITY_UNAVAILABLE");

    let unknown = dispatch_json(
        &kernel,
        "providers.speech",
        json!({
            "providerId": "00000000-0000-4000-8000-000000000000",
            "text": "hello",
        }),
    )
    .expect_err("unknown config must fail");
    assert_eq!(product_code(&unknown), "PROVIDER_CONFIG_NOT_FOUND");
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

#[test]
fn images_stage_a_generated_image_asset() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let config = set_config(&kernel, "fake", "local-fake", json!({ "model": "fake-1" }));

    let result = dispatch_decoded::<ResultProvidersImages>(
        &kernel,
        "providers.images",
        json!({ "providerId": config.id, "prompt": "a lighthouse", "size": "512x512" }),
    )
    .expect("generation must succeed");

    assert_eq!(result.content_type, "image/png");
    assert_eq!((result.width, result.height), (Some(1), Some(1)));
    assert_eq!(result.size_bytes, 70);

    let asset = dispatch_json(&kernel, "assets.get", json!({ "assetId": result.asset_id }))
        .expect("the produced asset must be addressable");
    assert_eq!(asset["asset"]["kind"], "generated-image");
    assert_eq!(asset["asset"]["sizeBytes"], 70);

    let content = dispatch_json(
        &kernel,
        "assets.content",
        json!({ "assetId": result.asset_id }),
    )
    .expect("content must be readable");
    let encoded = content["contentBase64"].as_str().expect("base64 body");
    assert!(
        encoded.starts_with("iVBOR"),
        "expected a PNG signature, got {encoded:.12}"
    );
}

#[test]
fn images_refuse_honestly_without_the_capability() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    let replay = set_config(&kernel, "recorded", "replay", json!({ "model": "fake-1" }));
    let err = dispatch_json(
        &kernel,
        "providers.images",
        json!({ "providerId": replay.id, "prompt": "a lighthouse" }),
    )
    .expect_err("a non-media provider must refuse");
    assert_eq!(product_code(&err), "CAPABILITY_UNAVAILABLE");
}
