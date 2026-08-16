//! Phase 11 portable-data operations: `backups.create` / `backups.list`
//! (ТЗ §40–§41) and, М5 slice 39, `backups.restore` (ТЗ §10.4).
//!
//! All three require durable storage (they run through `with_db_opt`, so a
//! stateless kernel yields [`KernelErrorCode::StorageFailure`]).
//! `backups.create` / `backups.list` take the strict empty
//! `wire.request.empty`; responses are built from the storage
//! [`BackupRecord`](neotavern_storage::backup::BackupRecord) and validated
//! through the generated wire checkers before serialization — the Phase 1
//! `handle_meta_get` pattern. `backups.create` allocates its id via
//! [`crate::product::new_id`] and surfaces quota exhaustion as the product
//! error `QUOTA_EXCEEDED` (mirroring the `*_NOT_FOUND` product-error
//! pattern in `product.rs`), which is among the operation's allowed wire
//! errors.
//!
//! `backups.restore` is the offline restore path (ТЗ §10.4): it is handled
//! directly by the writer thread (see [`crate::restore_main`]), which owns
//! the [`Database`]. The handler takes the handle by value, closes the
//! connection and the data-root lease, restores the verified candidate via
//! the storage staged-restore + activation protocol, re-opens the database
//! on the (possibly swapped) active root and records the durable journal
//! entry. The restored root then serves the same kernel instance — no
//! restart required for the `committed` outcome.

use contracts_generated::generated::{self, BackupDto, ResultListBackups};
use neotavern_storage::backup::{create_backup, list_backups, restore_backup, BACKUP_DIR_SUFFIX, MAX_BACKUPS};
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

/// `backups.restore` — activate a verified backup container over the active
/// data root (ТЗ §10.4, М5 slice 39).
///
/// Runs on the writer thread which owns the [`Database`] by value: the
/// handler closes the connection + data-root lease, restores the candidate
/// through the storage staged-restore + activation protocol (the active root
/// is renamed; Windows requires every handle inside it to be closed first),
/// re-opens the database on the swapped active root, appends the durable
/// journal entry (`kind = restore`, `status = committed`) and returns
/// `{ status: "committed" }`. A failure at any stage leaves the previous
/// root active (the pending-marker protocol completes or discards the swap
/// at next open); the re-opened database is still returned so the kernel
/// stays usable.
pub(crate) fn backups_restore(
    db: Database,
    request: &[u8],
) -> (Database, Result<Vec<u8>, KernelError>) {
    let request = match generated::decode_request_backups_restore(request) {
        Ok(request) => request,
        Err(err) => return (db, Err(KernelError::from(err))),
    };
    let backup_id = request.backup_id;

    let root = db.root().to_path_buf();
    let container = neotavern_storage::paths::backups_dir(&root).join(format!(
        "{backup_id}{BACKUP_DIR_SUFFIX}"
    ));
    if !container.is_dir() {
        let err = KernelError::product(
            "NOT_FOUND",
            vec![("backupId".to_string(), backup_id.clone())],
        );
        return (db, Err(err));
    }

    // 1. Close the connection (WAL checkpoint) and release the data-root
    //    lease — restore_backup renames the active root directory.
    let mut db = db;
    if let Err(err) = db.close() {
        return (db, Err(KernelError::from(err)));
    }

    // 2. Staged restore + activation (kill-safe via the pending marker).
    let restore_result = restore_backup(&container, &root);

    // 3. Re-open the database on the active root. If the restore failed, the
    //    previous root is still active (or `open` resolves a pending swap);
    //    either way the kernel comes back usable and the caller sees the
    //    original error.
    let mut progress = |p: neotavern_storage::migrations::MigrationProgress| {
        eprintln!("storage: applying migration {} ({})", p.id, p.name);
    };
    let reopened = neotavern_storage::open::open(
        &root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    );
    let db = match reopened {
        Ok(db) => db,
        Err(err) => return (db, Err(KernelError::from(err))),
    };
    if let Err(err) = restore_result {
        return (db, Err(KernelError::from(err)));
    }

    // 4. Record the durable activation-journal entry (ТЗ §10.3/§10.4): the
    //    swap replaced the active root contents, so the journal records a
    //    completed restore from the previous root onto the same root path.
    let entry = neotavern_storage::activation::JournalEntry {
        id: crate::product::new_id(),
        kind: "restore".to_string(),
        status: neotavern_storage::activation::ActivationStatus::Committed,
        from_root: root.clone(),
        to_root: root.clone(),
        created_at: neotavern_storage::now_utc_rfc3339(),
        updated_at: neotavern_storage::now_utc_rfc3339(),
        error: None,
    };
    if let Err(err) = neotavern_storage::activation::write_entry(db.data_root(), entry) {
        return (db, Err(KernelError::from(err)));
    }

    let value = serde_json::json!({ "status": "committed" });
    let bytes = serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize backups.restore response: {err}"),
        )
    });
    (db, bytes)
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
