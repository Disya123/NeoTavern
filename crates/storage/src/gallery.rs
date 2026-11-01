//! Character gallery links (M7 Etap-4 gallery slice, ТЗ §13.1): a character's
//! gallery is a list of references into the immutable content-addressed
//! asset store (`__neotavern_assets`), not a file store of its own.
//!
//! The `character_images` table (schema v20) holds the owner link; the image
//! bytes live in the asset store and are served through the existing
//! `assets.content` / `assets.thumb` ops. Deleting a gallery image removes
//! only the LINK — the asset record and its bytes are never destroyed here,
//! because other records may reference the same content-addressed asset.
//! Links cascade with their owner row (character or asset deletion).

use crate::error::{Result, StorageError, StorageErrorCode};
use crate::now_utc_rfc3339;
use crate::open::Database;
use rusqlite::{params, OptionalExtension};

/// Sort order for [`list_character_images`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GallerySort {
    /// Oldest first (stable: `created_at`, then `id`).
    Oldest,
    /// Newest first (stable: `created_at DESC`, then `id`).
    Newest,
}

/// One gallery entry: the link plus the joined asset metadata needed to
/// render and serve it (`assets.content` takes `asset_id`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharacterImageRecord {
    /// The gallery-link id (stable string id, UUIDv7).
    pub id: String,
    /// Owning character id.
    pub character_id: String,
    /// The referenced content-addressed asset.
    pub asset_id: String,
    /// Original upload filename (display-only; empty for imported rows).
    pub filename: String,
    /// RFC3339 UTC creation time of the link.
    pub created_at: String,
    /// Asset byte size (joined from the asset store).
    pub size_bytes: i64,
    /// Asset sha256 checksum (joined from the asset store).
    pub checksum_sha256: String,
}

/// Links `asset_id` into `character_id`'s gallery and returns the created
/// record.
///
/// Fails with [`StorageErrorCode::NotFound`] when the character or the asset
/// does not exist (the FK would reject the row anyway; the explicit checks
/// give the caller a machine-readable cause). Re-adding the same asset to
/// the same character creates a SECOND link (deduplication is the caller's
/// policy — content-addressed assets already collapse identical bytes).
pub fn add_character_image(
    db: &mut Database,
    id: &str,
    character_id: &str,
    asset_id: &str,
    filename: &str,
) -> Result<CharacterImageRecord> {
    db.transaction(|tx| {
        let exists = |sql: &str, key: &str| -> Result<bool> {
            tx.query_row(sql, params![key], |_| Ok(()))
                .optional()
                .map(|row| row.is_some())
                .map_err(|e| {
                    StorageError::new(StorageErrorCode::Io, format!("gallery lookup: {e}"))
                })
        };
        if !exists("SELECT 1 FROM characters WHERE id = ?1", character_id)? {
            return Err(StorageError::new(
                StorageErrorCode::NotFound,
                format!("character {character_id} does not exist"),
            ));
        }
        if !exists("SELECT 1 FROM __neotavern_assets WHERE id = ?1", asset_id)? {
            return Err(StorageError::new(
                StorageErrorCode::NotFound,
                format!("asset {asset_id} does not exist"),
            ));
        }
        let created_at = now_utc_rfc3339();
        tx.execute(
            "INSERT INTO character_images (id, character_id, asset_id, filename, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, character_id, asset_id, filename, created_at],
        )
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("gallery insert: {e}")))?;
        let (size_bytes, checksum_sha256): (i64, String) = tx
            .query_row(
                "SELECT size_bytes, checksum_sha256 FROM __neotavern_assets WHERE id = ?1",
                params![asset_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| {
                StorageError::new(StorageErrorCode::Io, format!("gallery asset read: {e}"))
            })?;
        Ok(CharacterImageRecord {
            id: id.to_string(),
            character_id: character_id.to_string(),
            asset_id: asset_id.to_string(),
            filename: filename.to_string(),
            created_at,
            size_bytes,
            checksum_sha256,
        })
    })
}

/// Lists a character's gallery in the requested order.
///
/// Missing character → [`StorageErrorCode::NotFound`]; an existing character
/// with an empty gallery → `Ok(vec![])`.
pub fn list_character_images(
    db: &Database,
    character_id: &str,
    sort: GallerySort,
) -> Result<Vec<CharacterImageRecord>> {
    let conn = db.conn();
    let exists = conn
        .query_row(
            "SELECT 1 FROM characters WHERE id = ?1",
            params![character_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("gallery owner read: {e}")))?;
    if exists.is_none() {
        return Err(StorageError::new(
            StorageErrorCode::NotFound,
            format!("character {character_id} does not exist"),
        ));
    }
    let order = match sort {
        GallerySort::Oldest => "ci.created_at ASC, ci.id ASC",
        GallerySort::Newest => "ci.created_at DESC, ci.id ASC",
    };
    let sql = format!(
        "SELECT ci.id, ci.character_id, ci.asset_id, ci.filename, ci.created_at, \
         a.size_bytes, a.checksum_sha256 \
         FROM character_images ci \
         JOIN __neotavern_assets a ON a.id = ci.asset_id \
         WHERE ci.character_id = ?1 ORDER BY {order}"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("gallery list: {e}")))?;
    let rows = stmt
        .query_map(params![character_id], |row| {
            Ok(CharacterImageRecord {
                id: row.get(0)?,
                character_id: row.get(1)?,
                asset_id: row.get(2)?,
                filename: row.get(3)?,
                created_at: row.get(4)?,
                size_bytes: row.get(5)?,
                checksum_sha256: row.get(6)?,
            })
        })
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("gallery list: {e}")))?;
    let mut records = Vec::new();
    for row in rows {
        records.push(
            row.map_err(|e| StorageError::new(StorageErrorCode::Io, format!("gallery row: {e}")))?,
        );
    }
    Ok(records)
}

/// Removes a gallery link. `Ok(false)` when the link does not exist or does
/// not belong to `character_id` (owner-scoped: one character cannot delete
/// another's link); `Ok(true)` when the link row was removed. The referenced
/// asset is intentionally left in place (see the module docs).
pub fn remove_character_image(
    db: &mut Database,
    character_id: &str,
    image_id: &str,
) -> Result<bool> {
    db.transaction(|tx| {
        let removed = tx
            .execute(
                "DELETE FROM character_images WHERE id = ?1 AND character_id = ?2",
                params![image_id, character_id],
            )
            .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("gallery delete: {e}")))?;
        Ok(removed > 0)
    })
}

/// True when the asset record exists (helper for kernel-side messaging).
pub fn asset_exists(db: &Database, asset_id: &str) -> Result<bool> {
    db.conn()
        .query_row(
            "SELECT 1 FROM __neotavern_assets WHERE id = ?1",
            params![asset_id],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|e| StorageError::new(StorageErrorCode::Io, format!("asset lookup: {e}")))
}
