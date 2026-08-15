//! Canonical Configuration bounded context — profiles (ТЗ §8.1
//! Configuration: "profiles, non-secret settings, capabilities"; Этап 4
//! slice 5 remainder part 2).
//!
//! The `profiles` table (schema v14) holds named user contexts, mirroring
//! the legacy minimal shape (`profiles.id/name/created_at`, packages/db
//! schema) plus `updated_at` for renames. Nothing references a profile yet
//! — the per-profile FK columns on product tables and SEC-02 export
//! filtering (ADR-0047 waiver 4) are the slice-5 remainder follow-up this
//! model unblocks. Ops:
//!
//! - `profiles.list` — full snapshot, ordered by name (case-insensitive).
//! - `profiles.create` — new uuid-v7 profile (idempotent by nature: each
//!   call creates a distinct row; the request carries no idempotency key).
//! - `profiles.rename` — name update with fresh `updated_at`; unknown id
//!   is `PROFILE_NOT_FOUND`.
//! - `profiles.delete` — durable row removal; unknown id is
//!   `PROFILE_NOT_FOUND`.

use contracts_generated::generated::{
    self, ProfilesItem, RequestProfilesCreate, RequestProfilesDelete, RequestProfilesRename,
    ResultProfilesCreate, ResultProfilesList,
};
use neotavern_storage::open::Database;
use rusqlite::OptionalExtension;

use crate::product::{encode, new_id, now, sqlite};
use crate::KernelError;

/// `profiles.list` — full snapshot, ordered by name (case-insensitive).
pub(crate) fn profiles_list(db: &Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    let mut stmt = db
        .conn()
        .prepare("SELECT id, name, created_at, updated_at FROM profiles ORDER BY name COLLATE NOCASE, id")
        .map_err(|err| sqlite(err, "profiles.list: prepare"))?;
    let rows = stmt
        .query_map([], profile_row)
        .map_err(|err| sqlite(err, "profiles.list: query"))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|err| sqlite(err, "profiles.list: row"))?);
    }
    encode(&ResultProfilesList { items })
}

/// `profiles.create` — new uuid-v7 profile.
pub(crate) fn profiles_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestProfilesCreate = generated::decode_request_profiles_create(request)?;
    let id = new_id();
    let now = now();
    db.conn()
        .execute(
            "INSERT INTO profiles (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, req.name, now, now],
        )
        .map_err(|err| sqlite(err, "profiles.create: insert"))?;
    let profile = profile_by_id(db, &id)?;
    encode(&ResultProfilesCreate { profile })
}

/// `profiles.rename` — name update with fresh `updated_at`.
pub(crate) fn profiles_rename(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestProfilesRename = generated::decode_request_profiles_rename(request)?;
    let now = now();
    let changed = db
        .conn()
        .execute(
            "UPDATE profiles SET name = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![req.id, req.name, now],
        )
        .map_err(|err| sqlite(err, "profiles.rename: update"))?;
    if changed == 0 {
        return Err(profile_not_found(&req.id));
    }
    let profile = profile_by_id(db, &req.id)?;
    encode(&profile)
}

/// `profiles.delete` — durable row removal.
pub(crate) fn profiles_delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestProfilesDelete = generated::decode_request_profiles_delete(request)?;
    let changed = db
        .conn()
        .execute(
            "DELETE FROM profiles WHERE id = ?1",
            rusqlite::params![req.id],
        )
        .map_err(|err| sqlite(err, "profiles.delete: delete"))?;
    if changed == 0 {
        return Err(profile_not_found(&req.id));
    }
    encode(&generated::ResultEmpty {})
}

// --- helpers --------------------------------------------------------------

fn profile_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProfilesItem> {
    Ok(ProfilesItem {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn profile_by_id(db: &Database, id: &str) -> Result<ProfilesItem, KernelError> {
    db.conn()
        .query_row(
            "SELECT id, name, created_at, updated_at FROM profiles WHERE id = ?1",
            rusqlite::params![id],
            profile_row,
        )
        .optional()
        .map_err(|err| sqlite(err, "profiles: row lookup"))?
        .ok_or_else(|| profile_not_found(id))
}

/// Stable `PROFILE_NOT_FOUND` product error (`profileId` param).
fn profile_not_found(id: &str) -> KernelError {
    KernelError::product(
        "PROFILE_NOT_FOUND".to_string(),
        vec![("profileId".to_string(), id.to_string())],
    )
}
