//! Canonical AssetStore surface (Этап 4 slice 5 remainder, ТЗ §5.1
//! AssetStore port, AGENTS.md §11/§12).
//!
//! Assets are immutable, content-addressed byte blobs stored under the data
//! root's `assets/` directory by `neotavern_storage::assets` (crash-safe
//! temp-write + rename + registry INSERT, symlink-safe resolution, orphan
//! GC). This module exposes the four wire operations:
//!
//! - `assets.put` — publish with a content-derived managed key
//!   `<kind>/<sha256>[.<ext>]`; re-publishing identical bytes under the same
//!   kind is an idempotent re-import (`deduplicated: true`, existing record
//!   returned) — AGENTS.md: "Import must support re-running without creating
//!   duplicates". An optional `contentType` is persisted in the asset
//!   metadata (the registry has no dedicated column).
//! - `assets.get` — metadata by id.
//! - `assets.content` — base64 of the ORIGINAL bytes (never lossy-compressed;
//!   the wire response limit caps the servable size, larger assets are
//!   addressed by `relativeKey` through host transports).
//! - `assets.delete` — registry row first, file removal best-effort (the
//!   orphan GC reclaims leftovers).
//!
//! Secrets, provider configs and other users' profiles are never reachable:
//! the only path builder is the validated `<kind>/<sha256>` key under the
//! assets directory, and `resolve_asset_path` re-checks containment.

use base64::Engine as _;
use contracts_generated::generated::{
    self, AssetThumbFormat, AssetsItem, RequestAssetsContent, RequestAssetsDelete,
    RequestAssetsGet, RequestAssetsPut, RequestAssetsThumb, ResultAssetsContent, ResultAssetsGet,
    ResultAssetsPut, ResultAssetsThumb,
};
use neotavern_storage::assets::resolve_asset_path;
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::OptionalExtension;

use crate::product::new_id;
use crate::{KernelError, KernelErrorCode};

/// Max length of the extension derived from the request `filename`
/// (including the leading dot, e.g. `.png`).
const MAX_EXT_LEN: usize = 16;

/// `assets.put` — content-addressed publish with idempotent re-import.
pub(crate) fn assets_put(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestAssetsPut = generated::decode_request_assets_put(request)?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(req.content_base64.as_bytes())
        .map_err(|err| {
            KernelError::new(
                KernelErrorCode::ContractViolation,
                format!("assets.put: contentBase64 is not valid base64: {err}"),
            )
        })?;

    let (id, deduplicated) = publish_bytes(
        db,
        &req.kind,
        &req.filename,
        &bytes,
        req.content_type.as_deref(),
    )?;
    let asset = asset_by_id(db, &id)?;
    let dto = ResultAssetsPut {
        asset,
        deduplicated,
        deduplicated_from_id: if deduplicated { Some(id) } else { None },
    };
    encode_result_put(&dto)
}

/// Content-addressed publish that bypasses the wire `assets.put` size cap.
/// The starter pack avatar is larger than 1 MiB; the writer thread uses this
/// instead of dispatch. Identical bytes under the same kind reuse the row.
pub(crate) fn publish_bytes(
    db: &mut Database,
    kind: &str,
    filename: &str,
    bytes: &[u8],
    content_type: Option<&str>,
) -> Result<(String, bool), KernelError> {
    let checksum = neotavern_storage::assets::sha256_hex(bytes);
    let ext = extension_of(filename);
    let relative_key = format!("{kind}/{checksum}{ext}");

    let existing: Option<String> = db
        .conn()
        .query_row(
            "SELECT id FROM __neotavern_assets \
             WHERE checksum_sha256 = ?1 AND type = ?2 LIMIT 1",
            rusqlite::params![checksum, kind],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "assets.publish: dedupe lookup failed"))?;
    if let Some(id) = existing {
        persist_content_type(db, &id, content_type)?;
        return Ok((id, true));
    }

    let id = new_id();
    neotavern_storage::assets::publish_asset(db, &id, kind, &relative_key, bytes).map_err(
        |err| map_asset_error(err, "assets.publish: publish failed", &id, &relative_key),
    )?;
    persist_content_type(db, &id, content_type)?;
    Ok((id, false))
}

/// `assets.get` — metadata by id.
pub(crate) fn assets_get(db: &Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestAssetsGet = generated::decode_request_assets_get(request)?;
    let dto = ResultAssetsGet {
        asset: asset_by_id(db, &req.asset_id)?,
    };
    encode_result_get(&dto)
}

/// `assets.content` — base64 of the original bytes.
pub(crate) fn assets_content(db: &Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestAssetsContent = generated::decode_request_assets_content(request)?;
    let (relative_key, content_type): (String, Option<String>) = db
        .conn()
        .query_row(
            "SELECT relative_key, metadata_json FROM __neotavern_assets WHERE id = ?1",
            rusqlite::params![req.asset_id],
            |row| {
                let key: String = row.get(0)?;
                let meta: String = row.get(1)?;
                Ok((key, content_type_from_metadata(&meta)))
            },
        )
        .optional()
        .map_err(|err| sqlite(err, "assets.content: registry lookup failed"))?
        .ok_or_else(|| asset_not_found(&req.asset_id))?;

    // The wire response limit bounds the servable size; read through the
    // symlink-safe resolver (never trusts the stored key).
    let path = resolve_asset_path(db, &relative_key).map_err(|err| {
        KernelError::new(
            KernelErrorCode::StorageFailure,
            format!("assets.content: cannot resolve asset file: {err}"),
        )
    })?;
    let bytes = std::fs::read(&path).map_err(|err| {
        KernelError::new(
            KernelErrorCode::StorageFailure,
            format!("assets.content: cannot read asset file: {err}"),
        )
    })?;

    let dto = ResultAssetsContent {
        asset_id: req.asset_id,
        content_type,
        content_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    };
    encode_result_content(&dto)
}

/// Bump when the thumbnail encoding pipeline changes (AGENTS.md §12.6: the
/// cache key must include the algorithm version so stale entries rebuild).
const THUMB_ALGO_VERSION: u32 = 1;

/// Hard decode preflight for `assets.thumb` (mirror of the presentation
/// layer's `check_image_limits` philosophy): a hostile `assets.put` payload
/// must not be able to force an unbounded raster on the kernel either.
const THUMB_MAX_ORIGINAL_BYTES: u64 = 64 * 1024 * 1024;
const THUMB_MAX_AXIS_PX: u32 = 16_384;
const THUMB_MAX_PIXELS: u64 = 64_000_000;

/// `assets.thumb` — kernel-side, aspect-preserving thumbnail (image audit
/// stage C). The longest side is `maxPx` (wire-validated 16..=1024); JPEG q82
/// when the source has no alpha channel, PNG when it does. Thumbnails are
/// CACHE (AGENTS.md §12): stored under `<data-root>/cache/thumbnails/` keyed
/// by the original's sha256 + maxPx + algorithm version, written atomically
/// (temp + rename), fully deletable and rebuilt on demand. The original
/// bytes are never served through this operation.
pub(crate) fn assets_thumb(db: &Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestAssetsThumb = generated::decode_request_assets_thumb(request)?;
    let max_px = u32::try_from(req.max_px)
        .map_err(|_| contract_violation("assets.thumb: maxPx out of range"))?;

    let (relative_key, checksum): (String, String) = db
        .conn()
        .query_row(
            "SELECT relative_key, checksum_sha256 FROM __neotavern_assets WHERE id = ?1",
            rusqlite::params![req.asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| sqlite(err, "assets.thumb: registry lookup failed"))?
        .ok_or_else(|| asset_not_found(&req.asset_id))?;

    let path = resolve_asset_path(db, &relative_key).map_err(|err| {
        KernelError::new(
            KernelErrorCode::StorageFailure,
            format!("assets.thumb: cannot resolve asset file: {err}"),
        )
    })?;

    // Cache lookup keyed by (original sha256, maxPx, algorithm version).
    // A corrupt or unreadable entry is DELETED and regenerated below (AGENTS
    // §12/§20: the cache is regenerable and must recover automatically), never
    // allowed to fail the request.
    let cache_dir = db.data_root().join("cache").join("thumbnails");
    for (ext, format) in [
        ("jpg", AssetThumbFormat::Jpeg),
        ("png", AssetThumbFormat::Png),
    ] {
        let cached = cache_dir.join(format!("{checksum}-{max_px}-v{THUMB_ALGO_VERSION}.{ext}"));
        if !cached.is_file() {
            continue;
        }
        let bytes = match std::fs::read(&cached) {
            Ok(bytes) => bytes,
            Err(_) => {
                let _ = std::fs::remove_file(&cached);
                continue;
            }
        };
        let (width, height) = match thumb_dimensions(&bytes) {
            Ok(dims) => dims,
            Err(_) => {
                let _ = std::fs::remove_file(&cached);
                continue;
            }
        };
        return encode_thumb_response(&req.asset_id, format, width, height, &bytes);
    }

    // Cache miss: read + preflight + decode the ORIGINAL, then downscale.
    let original_len = std::fs::metadata(&path)
        .map_err(|err| {
            KernelError::new(
                KernelErrorCode::StorageFailure,
                format!("assets.thumb: cannot stat asset file: {err}"),
            )
        })?
        .len();
    if original_len > THUMB_MAX_ORIGINAL_BYTES {
        return Err(contract_violation(
            "assets.thumb: original exceeds the 64 MiB decode cap",
        ));
    }
    let bytes = std::fs::read(&path).map_err(|err| {
        KernelError::new(
            KernelErrorCode::StorageFailure,
            format!("assets.thumb: cannot read asset file: {err}"),
        )
    })?;
    let (width, height) = preflight_dimensions(&bytes)?;
    if width > THUMB_MAX_AXIS_PX || height > THUMB_MAX_AXIS_PX {
        return Err(contract_violation(
            "assets.thumb: original axes exceed the 16384 px decode cap",
        ));
    }
    if u64::from(width) * u64::from(height) > THUMB_MAX_PIXELS {
        return Err(contract_violation(
            "assets.thumb: original pixel count exceeds the 64 MP decode cap",
        ));
    }
    let image = image::load_from_memory(&bytes).map_err(|err| {
        KernelError::new(
            KernelErrorCode::ContractViolation,
            format!("assets.thumb: original is not a decodable raster: {err}"),
        )
    })?;
    let (format, encoded, tw, th) = encode_thumb_with_ladder(&image, max_px)?;

    // Atomic cache write (AGENTS.md §12: temp file + rename); a failed cache
    // write must not fail the request — the next call regenerates.
    let ext = match format {
        AssetThumbFormat::Jpeg => "jpg",
        AssetThumbFormat::Png => "png",
    };
    let final_path = cache_dir.join(format!("{checksum}-{max_px}-v{THUMB_ALGO_VERSION}.{ext}"));
    if std::fs::create_dir_all(&cache_dir).is_ok() {
        let tmp = cache_dir.join(format!(
            ".{}.tmp-{}",
            final_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("thumb"),
            std::process::id()
        ));
        if std::fs::write(&tmp, &encoded).is_ok() && std::fs::rename(&tmp, &final_path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    encode_thumb_response(&req.asset_id, format, tw, th, &encoded)
}

/// Cached-thumbnail dimension probe (header-only decode; the cache only ever
/// holds files this operation itself encoded).
fn thumb_dimensions(bytes: &[u8]) -> Result<(u32, u32), KernelError> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| {
            KernelError::new(
                KernelErrorCode::StorageFailure,
                format!("assets.thumb: cannot probe the cached thumbnail: {err}"),
            )
        })?;
    let (width, height) = reader.into_dimensions().map_err(|err| {
        KernelError::new(
            KernelErrorCode::StorageFailure,
            format!("assets.thumb: cached thumbnail is corrupt: {err}"),
        )
    })?;
    Ok((width, height))
}

/// Header-only dimension preflight of the original bytes (no pixel decode).
fn preflight_dimensions(bytes: &[u8]) -> Result<(u32, u32), KernelError> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| {
            KernelError::new(
                KernelErrorCode::ContractViolation,
                format!("assets.thumb: cannot probe the original: {err}"),
            )
        })?;
    reader.into_dimensions().map_err(|err| {
        KernelError::new(
            KernelErrorCode::ContractViolation,
            format!("assets.thumb: original is not a decodable raster: {err}"),
        )
    })
}

/// Encode a thumbnail of `image` under the op's wire response cap. The cap
/// bounds the BASE64 payload (AGENTS §23: the limit comes from the registry,
/// never a hard-coded constant), and a 1024px PNG with a noisy alpha channel
/// can legitimately exceed it, so the encode walks a ladder instead of
/// failing: (1) a fully OPAQUE alpha channel is dropped in favor of JPEG
/// (renders identically, 5–10× smaller), then (2) the thumbnail shrinks by
/// 25% per step down to a floor. Returns the format, the encoded bytes and
/// the final thumbnail dimensions; an encoding that still exceeds the cap at
/// the floor is a stable `PAYLOAD_TOO_LARGE` product error.
pub(crate) fn encode_thumb_with_ladder(
    image: &image::DynamicImage,
    max_px: u32,
) -> Result<(AssetThumbFormat, Vec<u8>, u32, u32), KernelError> {
    let response_limit = generated::operation_response_limit("assets.thumb")
        .unwrap_or(generated::DEFAULT_RESPONSE_LIMIT_BYTES) as usize;
    let min_px = max_px.clamp(16, 256);
    let mut step_max = max_px;
    let mut opaque_alpha: Option<bool> = None;
    loop {
        let thumb = image.thumbnail(step_max, step_max);
        let has_alpha = matches!(
            thumb.color(),
            image::ColorType::Rgba8
                | image::ColorType::Rgba16
                | image::ColorType::La8
                | image::ColorType::La16
        );
        // One probe per request: `to_rgba8` normalizes 16-bit channels, so a
        // single `== 255` comparison is correct for every color type.
        let drop_alpha = has_alpha
            && *opaque_alpha
                .get_or_insert_with(|| thumb.to_rgba8().pixels().all(|px| px[3] == 255));
        let (format, encoded): (AssetThumbFormat, Vec<u8>) = if has_alpha && !drop_alpha {
            let mut png = Vec::new();
            let encoder = image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut png));
            thumb.write_with_encoder(encoder).map_err(encode_failure)?;
            (AssetThumbFormat::Png, png)
        } else {
            // The JPEG encoder has no RGBA support (and the opaque-alpha path
            // can reach it with an RGBA thumbnail) — collapse to RGB8 first.
            let rgb = image::DynamicImage::ImageRgb8(thumb.to_rgb8());
            let mut out = Vec::new();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82);
            rgb.write_with_encoder(encoder).map_err(encode_failure)?;
            (AssetThumbFormat::Jpeg, out)
        };
        let b64_len = (encoded.len() + 2) / 3 * 4;
        if b64_len <= response_limit {
            return Ok((format, encoded, thumb.width(), thumb.height()));
        }
        if step_max <= min_px {
            return Err(KernelError::product(
                "PAYLOAD_TOO_LARGE".to_string(),
                vec![
                    ("operationId".to_string(), "assets.thumb".to_string()),
                    ("bytes".to_string(), b64_len.to_string()),
                    ("limit".to_string(), response_limit.to_string()),
                ],
            ));
        }
        step_max = (step_max * 3 / 4).max(min_px);
    }
}

fn encode_failure(err: image::ImageError) -> KernelError {
    KernelError::new(
        KernelErrorCode::Internal,
        format!("assets.thumb: thumbnail encoding failed: {err}"),
    )
}

fn contract_violation(message: &str) -> KernelError {
    KernelError::new(KernelErrorCode::ContractViolation, message)
}

fn encode_thumb_response(
    asset_id: &str,
    format: AssetThumbFormat,
    width: u32,
    height: u32,
    encoded: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let dto = ResultAssetsThumb {
        asset_id: asset_id.to_string(),
        format,
        width: i64::from(width),
        height: i64::from(height),
        content_base64: base64::engine::general_purpose::STANDARD.encode(encoded),
    };
    encode_checked(&dto, generated::validate_result_assets_thumb)
}

/// `assets.delete` — registry row first, file best-effort (orphan GC covers).
pub(crate) fn assets_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestAssetsDelete = generated::decode_request_assets_delete(request)?;
    neotavern_storage::assets::delete_asset(db, &req.asset_id)
        .map_err(|err| map_asset_error(err, "assets.delete failed", &req.asset_id, ""))?;
    encode_result_empty(&generated::ResultEmpty {})
}

// --- helpers --------------------------------------------------------------

fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StorageFailure, format!("{context}: {err}"))
}

pub(crate) fn asset_by_id(db: &Database, id: &str) -> Result<AssetsItem, KernelError> {
    let row: Option<(String, String, String, String, i64, String)> = db
        .conn()
        .query_row(
            "SELECT id, type, relative_key, checksum_sha256, size_bytes, created_at \
             FROM __neotavern_assets WHERE id = ?1",
            rusqlite::params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|err| sqlite(err, "assets: registry lookup failed"))?;
    let (id, kind, relative_key, checksum, size_bytes, created_at) =
        row.ok_or_else(|| asset_not_found(id))?;
    Ok(AssetsItem {
        id,
        kind,
        relative_key,
        checksum_sha256: checksum,
        size_bytes,
        created_at,
    })
}

/// Persist the optional `contentType` in the asset metadata JSON
/// (`{"contentType": "..."}`), reusing the opaque registry column. Absent
/// content type leaves the existing metadata untouched.
fn persist_content_type(
    db: &mut Database,
    id: &str,
    content_type: Option<&str>,
) -> Result<(), KernelError> {
    let Some(content_type) = content_type else {
        return Ok(());
    };
    let metadata = serde_json::json!({ "contentType": content_type }).to_string();
    db.conn()
        .execute(
            "UPDATE __neotavern_assets SET metadata_json = ?1 WHERE id = ?2",
            rusqlite::params![metadata, id],
        )
        .map_err(|err| sqlite(err, "assets: persist content type"))?;
    Ok(())
}

/// Read the `contentType` out of the stored metadata JSON.
fn content_type_from_metadata(metadata: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(metadata)
        .ok()
        .and_then(|v| {
            v.get("contentType")
                .and_then(|ct| ct.as_str())
                .map(|s| s.to_string())
        })
}

fn encode_result_put(dto: &ResultAssetsPut) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_assets_put)
}

fn encode_result_get(dto: &ResultAssetsGet) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_assets_get)
}

fn encode_result_content(dto: &ResultAssetsContent) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_assets_content)
}

fn encode_result_empty(dto: &generated::ResultEmpty) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_empty)
}

fn encode_checked<T: serde::Serialize>(
    dto: &T,
    validate: fn(&serde_json::Value) -> Result<(), Vec<contracts_generated::Issue>>,
) -> Result<Vec<u8>, KernelError> {
    let value = serde_json::to_value(dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("assets: response serialization failed: {err}"),
        )
    })?;
    validate(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel assets dto failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    crate::product::encode(&value)
}

/// Stable `ASSET_NOT_FOUND` product error (`assetId` param).
pub(crate) fn asset_not_found(id: &str) -> KernelError {
    KernelError::product(
        "ASSET_NOT_FOUND".to_string(),
        vec![("assetId".to_string(), id.to_string())],
    )
}

/// Map a storage-layer asset error onto the kernel error contract.
fn map_asset_error(err: StorageError, context: &str, id: &str, key: &str) -> KernelError {
    match err.code {
        neotavern_storage::StorageErrorCode::AssetNotFound => asset_not_found(id),
        neotavern_storage::StorageErrorCode::InvalidAssetKey => KernelError {
            code: KernelErrorCode::ContractViolation,
            message: format!("{context}: {err}"),
            issues: Vec::new(),
            params: vec![("relativeKey".to_string(), key.to_string())],
            product: None,
        },
        neotavern_storage::StorageErrorCode::Conflict => KernelError {
            code: KernelErrorCode::Conflict,
            message: format!("{context}: {err}"),
            issues: Vec::new(),
            params: vec![("id".to_string(), id.to_string())],
            product: None,
        },
        _ => KernelError::new(KernelErrorCode::StorageFailure, format!("{context}: {err}")),
    }
}

/// Lowercase-safe extension of `filename` (including the leading dot,
/// truncated to [`MAX_EXT_LEN`]), or an empty string when there is none.
fn extension_of(filename: &str) -> String {
    match filename.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() => {
            let mut out = String::with_capacity(ext.len() + 1);
            out.push('.');
            for ch in ext.chars().take(MAX_EXT_LEN - 1) {
                if ch.is_ascii_alphanumeric() {
                    out.push(ch.to_ascii_lowercase());
                } else {
                    out.push('-');
                }
            }
            out
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod thumb_ladder_tests {
    use super::*;

    /// Deterministic LCG noise: incompressible per-pixel content without a
    /// rand dependency.
    struct Lcg(u64);
    impl Lcg {
        fn next_byte(&mut self) -> u8 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) as u8
        }
    }

    fn noise_rgba8(width: u32, height: u32, opaque_alpha: bool) -> image::DynamicImage {
        let mut rng = Lcg(0x9E3779B97F4A7C15);
        let mut buffer = image::RgbaImage::new(width, height);
        for px in buffer.pixels_mut() {
            *px = image::Rgba([
                rng.next_byte(),
                rng.next_byte(),
                rng.next_byte(),
                if opaque_alpha { 255 } else { rng.next_byte() },
            ]);
        }
        image::DynamicImage::ImageRgba8(buffer)
    }

    /// A noisy RGBA source at maxPx 1024 overflows the base64 response cap as
    /// a 1024px PNG; the ladder must step the size down (and stay under the
    /// registry limit) instead of failing with PAYLOAD_TOO_LARGE.
    #[test]
    fn ladder_steps_noisy_alpha_png_under_the_response_cap() {
        let image = noise_rgba8(2000, 1400, false);
        let (format, encoded, tw, th) =
            encode_thumb_with_ladder(&image, 1024).expect("ladder must find a fitting encode");
        assert_eq!(format, AssetThumbFormat::Png, "translucent noise stays PNG");
        let limit = generated::operation_response_limit("assets.thumb")
            .expect("assets.thumb declares a response limit");
        assert!(
            (encoded.len() + 2) / 3 * 4 <= limit as usize,
            "base64 {} exceeds limit {}",
            (encoded.len() + 2) / 3 * 4,
            limit
        );
        // `thumbnail` preserves the 10:7 source aspect (longest side = step).
        let aspect = f64::from(th) / f64::from(tw);
        assert!(
            (aspect - 0.7).abs() < 0.01,
            "aspect must be preserved: {tw}x{th}"
        );
        assert!(
            tw < 1024,
            "must have stepped below the requested maxPx: {tw}"
        );
    }

    /// A fully opaque alpha channel renders identically as JPEG and encodes
    /// several times smaller — the ladder must drop it instead of keeping an
    /// oversized PNG.
    #[test]
    fn ladder_drops_fully_opaque_alpha_to_jpeg() {
        let image = noise_rgba8(2000, 1400, true);
        let (format, _encoded, _tw, _th) =
            encode_thumb_with_ladder(&image, 1024).expect("ladder must succeed");
        assert_eq!(format, AssetThumbFormat::Jpeg);
    }
}
