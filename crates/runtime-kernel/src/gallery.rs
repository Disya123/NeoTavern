//! Character gallery operations (M7 Etap-4 gallery slice, ТЗ §13.1):
//! `characters.gallery.list` / `characters.gallery.add` /
//! `characters.gallery.delete`.
//!
//! The gallery is a list of references into the immutable content-addressed
//! asset store: `add` publishes the bytes through the same
//! [`publish_bytes`](crate::assets::publish_bytes) path as `assets.put`
//! (kind `gallery`, idempotent re-import of identical bytes) and links the
//! asset to the character; `delete` removes only the LINK — the asset record
//! and its bytes are never destroyed (other records may reference the same
//! content-addressed asset). The original avatar file needs no separate op:
//! `characters.avatarAssetId` + `assets.content` serve it directly.
//!
//! All three run through `with_db_opt` (durable storage); responses are
//! validated through the generated wire checkers before serialization.

use contracts_generated::generated::{
    self, CharactersGalleryItem, ResultCharactersGalleryAdd, ResultCharactersGalleryDelete,
    ResultCharactersGalleryList,
};
use neotavern_storage::gallery::{
    add_character_image, list_character_images, remove_character_image, GallerySort,
};
use neotavern_storage::open::Database;

use crate::assets::publish_bytes;
use crate::product::{character_exists, new_id, not_found};
use crate::{KernelError, KernelErrorCode};
use base64::Engine as _;

/// Gallery image kind in the asset store (same grammar as `assets.put`).
const GALLERY_KIND: &str = "gallery";

/// `characters.gallery.list` — a character's gallery in the requested order.
pub(crate) fn characters_gallery_list(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_characters_gallery_list(request)?;
    if !character_exists(db.conn(), &req.character_id)? {
        return Err(not_found("CHARACTER", &req.character_id));
    }
    let sort = match req.sort.as_deref() {
        None | Some("oldest") => GallerySort::Oldest,
        Some("newest") => GallerySort::Newest,
        Some(other) => {
            return Err(KernelError::new(
                KernelErrorCode::ContractViolation,
                format!("characters.gallery.list: unknown sort {other:?}"),
            ));
        }
    };
    let records = list_character_images(db, &req.character_id, sort).map_err(KernelError::from)?;
    let items = records
        .into_iter()
        .map(|record| CharactersGalleryItem {
            id: record.id,
            character_id: record.character_id,
            asset_id: record.asset_id,
            filename: record.filename,
            created_at: record.created_at,
            size_bytes: record.size_bytes,
            checksum_sha256: record.checksum_sha256,
        })
        .collect();
    let dto = ResultCharactersGalleryList { items };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize characters.gallery.list response: {err}"),
        )
    })?;
    generated::validate_result_characters_gallery_list(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel characters.gallery.list response failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize characters.gallery.list response: {err}"),
        )
    })
}

/// `characters.gallery.add` — publish the image bytes (content-addressed,
/// deduplicated like `assets.put`) and link the asset to the character.
pub(crate) fn characters_gallery_add(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_characters_gallery_add(request)?;
    if !character_exists(db.conn(), &req.character_id)? {
        return Err(not_found("CHARACTER", &req.character_id));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(req.content_base64.as_bytes())
        .map_err(|err| {
            KernelError::new(
                KernelErrorCode::ContractViolation,
                format!("characters.gallery.add: contentBase64 is not valid base64: {err}"),
            )
        })?;
    let (asset_id, deduplicated) = publish_bytes(
        db,
        GALLERY_KIND,
        &req.filename,
        &bytes,
        req.content_type.as_deref(),
    )?;
    let link_id = new_id();
    let record = add_character_image(db, &link_id, &req.character_id, &asset_id, &req.filename)
        .map_err(KernelError::from)?;
    let dto = ResultCharactersGalleryAdd {
        item: CharactersGalleryItem {
            id: record.id,
            character_id: record.character_id,
            asset_id: record.asset_id,
            filename: record.filename,
            created_at: record.created_at,
            size_bytes: record.size_bytes,
            checksum_sha256: record.checksum_sha256,
        },
        deduplicated,
    };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize characters.gallery.add response: {err}"),
        )
    })?;
    generated::validate_result_characters_gallery_add(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel characters.gallery.add response failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize characters.gallery.add response: {err}"),
        )
    })
}

/// `characters.gallery.delete` — remove a gallery link. Idempotent:
/// `deleted: false` when the link is gone or belongs to another character
/// (indistinguishable by design so one character cannot probe another's
/// gallery). The referenced asset is never destroyed.
pub(crate) fn characters_gallery_delete(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_characters_gallery_delete(request)?;
    let deleted =
        remove_character_image(db, &req.character_id, &req.image_id).map_err(KernelError::from)?;
    let dto = ResultCharactersGalleryDelete { deleted };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize characters.gallery.delete response: {err}"),
        )
    })?;
    generated::validate_result_characters_gallery_delete(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel characters.gallery.delete response failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize characters.gallery.delete response: {err}"),
        )
    })
}
