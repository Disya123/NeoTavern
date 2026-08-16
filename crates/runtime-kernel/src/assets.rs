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
    self, AssetsItem, RequestAssetsContent, RequestAssetsDelete, RequestAssetsGet,
    RequestAssetsPut, ResultAssetsContent, ResultAssetsGet, ResultAssetsPut,
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
