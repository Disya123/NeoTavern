//! Phase 11 profile export: `profile.export` (SEC-02).
//!
//! The operation builds a **logical allowlist container** of the canonical
//! product data: characters, chats, messages, lorebooks and presets (plus,
//! optionally, the referenced asset bytes) via the storage
//! [`create_export`](neotavern_storage::export::create_export) primitive.
//! It never reads provider configs, secrets, session data or any table that
//! can carry secret material — the container inventory and the negative
//! kernel test (`kernel_profile_export.rs`) prove that a sentinel secret in
//! the SecretStore never reaches the archive or its manifest.
//!
//! Since the Configuration profiles model (M14), a request MAY carry
//! `profileId` (SEC-02, ADR-0047 waiver 4): the export is then scoped to
//! that profile — only its characters and, transitively, their chats and
//! messages are exported; lorebooks and presets are the shared library and
//! always included in full. An unknown profile id is `PROFILE_NOT_FOUND`
//! (validated before any container directory is created); the result echoes
//! the scope. A full library export is the `profileId`-absent default, so
//! the migration path for existing single-user installs is unchanged.
//!
//! The container is written beneath the data root's `exports/` directory
//! (a fresh subdirectory per call, so a partially-written container never
//! carries a manifest); the response carries the verified report and the
//! relative `containerPath` so a host can resolve and stream the archive
//! without transport-specific knowledge of the format. Runs synchronously
//! on the writer thread, serialized with the single-writer coordinator.

use contracts_generated::generated::{self, ProfileExportCounts, ResultProfileExport};
use neotavern_storage::export::{create_export, verify_export};
use neotavern_storage::open::Database;
use neotavern_storage::paths::exports_dir;
use neotavern_storage::snapshot::sha256_file_hex;
use rusqlite::OptionalExtension;

use crate::{KernelError, KernelErrorCode};

/// `profile.export` — creates a verified logical profile export container.
///
/// Request: `wire.request.profile-export` (`{ includeAssets?: boolean,
/// profileId?: string }`, assets default to included). Response:
/// `wire.result.profile-export` with the verified report, the container path
/// relative to the data root, and the optional `profileId` echo.
pub(crate) fn profile_export(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_profile_export(request)?;
    let include_assets = req.include_assets.unwrap_or(true);

    // SEC-02 waiver 4: a scoped export must name an existing profile.
    if let Some(profile_id) = &req.profile_id {
        validate_profile_exists(db, profile_id)?;
    }

    // Fresh destination per call; a uuid-named subdirectory under exports/.
    let id = crate::product::new_id();
    let dir_name = format!("profile-export-{id}");
    let dest = exports_dir(db.root()).join(&dir_name);

    let report = create_export(db, &dest, include_assets, req.profile_id.as_deref())
        .map_err(KernelError::from)?;
    let verified = verify_export(&dest).map_err(KernelError::from)?;
    let manifest_sha256 = sha256_file_hex(&dest.join("manifest.json"))
        .map_err(|err| KernelError::new(KernelErrorCode::StorageFailure, err.to_string()))?;

    let dto = ResultProfileExport {
        container_path: format!("exports/{dir_name}/"),
        format_version: verified.format_version as i64,
        created_at: verified.created_at,
        records: ProfileExportCounts {
            characters: verified.records.characters as i64,
            chats: verified.records.chats as i64,
            messages: verified.records.messages as i64,
            lorebooks: verified.records.lorebooks as i64,
            presets: verified.records.presets as i64,
        },
        assets: report.assets as i64,
        size_bytes: report.size_bytes as i64,
        manifest_sha256,
        profile_id: req.profile_id,
    };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize profile.export response: {err}"),
        )
    })?;
    generated::validate_result_profile_export(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel profile.export response failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize profile.export response: {err}"),
        )
    })
}

/// Verifies a scoped export's profile id resolves to an existing profile;
/// `PROFILE_NOT_FOUND` otherwise.
fn validate_profile_exists(db: &Database, profile_id: &str) -> Result<(), KernelError> {
    let found = db
        .conn()
        .query_row("SELECT 1 FROM profiles WHERE id = ?1", [profile_id], |r| {
            r.get::<_, i64>(0)
        })
        .optional()
        .map_err(|e| crate::product::sqlite(e, "profile_export: probe profile"))?;
    if found.is_none() {
        return Err(KernelError::product(
            "PROFILE_NOT_FOUND".to_string(),
            vec![("profileId".to_string(), profile_id.to_string())],
        ));
    }
    Ok(())
}
