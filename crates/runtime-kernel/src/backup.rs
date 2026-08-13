//! Phase 11 portable-data operations: `backups.create` / `backups.list`
//! (ТЗ §40–§41).
//!
//! Both operations require durable storage (they run through
//! `with_db_opt`, so a stateless kernel yields
//! [`KernelErrorCode::StorageFailure`]). Each request is the strict empty
//! `wire.request.empty`; responses are built from the storage
//! [`BackupRecord`](neotavern_storage::backup::BackupRecord) and validated
//! through the generated wire checkers before serialization — the Phase 1
//! `handle_meta_get` pattern. `backups.create` allocates its id via
//! [`crate::product::new_id`] and surfaces quota exhaustion as the product
//! error `QUOTA_EXCEEDED` (mirroring the `*_NOT_FOUND` product-error
//! pattern in `product.rs`), which is among the operation's allowed wire
//! errors.

use contracts_generated::generated::{self, BackupDto, ResultListBackups};
use neotavern_storage::backup::{create_backup, list_backups, MAX_BACKUPS};
use neotavern_storage::open::Database;

use crate::{KernelError, KernelErrorCode};

/// `backups.create` — creates a backup container of the current data root.
///
/// Strict empty request (`wire.request.empty`); the response is the
/// `wire.backup.dto` with `status == "completed"`. Runs synchronously on the
/// writer thread, which serializes it with the single-writer coordinator.
pub(crate) fn backups_create(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_request_empty(request)?;
    let id = crate::product::new_id();
    let record = create_backup(db, &id).map_err(map_storage_error)?;
    let dto = BackupDto {
        id: record.id,
        created_at: record.created_at,
        format_version: record.format_version as f64,
        size_bytes: record.size_bytes,
        checksum_sha256: record.checksum_sha256,
        status: record.status,
    };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize backups.create response: {err}"),
        )
    })?;
    generated::validate_backup_dto(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel backups.create response failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize backups.create response: {err}"),
        )
    })
}

/// `backups.list` — completed backup containers of the data root.
///
/// Strict empty request; the response is the `wire.result.list-backups`
/// DTO validated through the generated checker. Idempotent and safe.
pub(crate) fn backups_list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_request_empty(request)?;
    let records = list_backups(db.root()).map_err(KernelError::from)?;
    let items = records
        .into_iter()
        .map(|record| BackupDto {
            id: record.id,
            created_at: record.created_at,
            format_version: record.format_version as f64,
            size_bytes: record.size_bytes,
            checksum_sha256: record.checksum_sha256,
            status: record.status,
        })
        .collect();
    let dto = ResultListBackups { items };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize backups.list response: {err}"),
        )
    })?;
    generated::validate_result_list_backups(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel backups.list response failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize backups.list response: {err}"),
        )
    })
}

/// Maps a storage failure onto a kernel error. Quota exhaustion becomes the
/// product error `QUOTA_EXCEEDED` (a `KernelError::product` with the wire
/// [`generated::ProductErrorDto`] carrying the stable code and a `limit`
/// param), mirroring how `product.rs` builds `*_NOT_FOUND` product errors.
fn map_storage_error(err: neotavern_storage::StorageError) -> KernelError {
    if err.code == neotavern_storage::StorageErrorCode::QuotaExceeded {
        return KernelError::product(
            "QUOTA_EXCEEDED",
            vec![("limit".to_string(), MAX_BACKUPS.to_string())],
        );
    }
    KernelError::from(err)
}
