//! Data-lifecycle status over the product wire: `data.activation.status`
//! (ТЗ §10.2–§10.3, M5 slice 38).
//!
//! The kernel owns the durable activation journal and the active-root
//! pointer of its data root (ADR-0041): `versioned roots/root-<id>/`
//! directories, a small `active-root.json` pointer as the commit point and
//! `activation-journal.json` recording every staged activation with the
//! ТЗ statuses `prepared` / `validated` / `activation_pending` /
//! `committed` / `rolled_back`. `resolve_pending_activation` already runs on
//! every bootstrap (in `open::open`) before the database is opened, so a
//! pending activation reported here is either being retried by the host or
//! waiting for the documented **Restart to finish** flow (ТЗ §10.3.1).
//!
//! This operation is strictly read-only: it renders the honest journal and
//! layout state so the UI can show the user which root is active, what was
//! activated and whether an activation is pending. The v1 flat layout (no
//! `roots/` directory) is reported as `layoutVersion: 1` with no root id.

use contracts_generated::generated::{
    self, DataActivationEntry, DataActivationPending, ResultDataActivationStatus,
};
use neotavern_storage::activation::ActivationStatus;
use neotavern_storage::open::Database;

use crate::{KernelError, KernelErrorCode};

/// `data.activation.status` — strict empty request; the response reports the
/// data-root layout version, the active root, the full durable activation
/// journal and whether an activation is pending. Idempotent and safe.
pub(crate) fn data_activation_status(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    generated::decode_request_empty(request)?;
    let data_root = db.data_root();
    let active = db.root();

    let journal =
        neotavern_storage::activation::read_journal(data_root).map_err(KernelError::from)?;
    let roots_dir = neotavern_storage::activation::roots_dir(data_root);
    let layout_version: i64 = if roots_dir.is_dir() { 2 } else { 1 };

    // In the v2 layout the active root lives under `roots/root-<id>/`; the
    // id is its directory name without the `root-` prefix. The v1 flat
    // layout has no root id.
    let active_root_id = if layout_version == 2 {
        active
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(neotavern_storage::activation::ROOT_DIR_PREFIX))
            .map(|id| id.to_string())
    } else {
        None
    };

    let entries = journal
        .entries
        .iter()
        .map(|entry| DataActivationEntry {
            id: entry.id.clone(),
            kind: entry.kind.clone(),
            status: entry.status.as_str().to_string(),
            from_root: entry.from_root.display().to_string(),
            to_root: entry.to_root.display().to_string(),
            created_at: entry.created_at.clone(),
            updated_at: entry.updated_at.clone(),
            error: entry.error.clone(),
        })
        .collect();

    // The newest `activation_pending` journal entry is the recovery source
    // of truth (Windows restart-to-complete, ТЗ §10.3.1).
    let pending = journal
        .entries
        .iter()
        .rev()
        .find(|entry| entry.status == ActivationStatus::ActivationPending)
        .map(|entry| DataActivationPending {
            kind: entry.kind.clone(),
            entry_id: entry.id.clone(),
            created_at: entry.created_at.clone(),
        });

    let dto = ResultDataActivationStatus {
        layout_version,
        active_root_id,
        active_root: active.display().to_string(),
        journal_format: journal.format.clone(),
        journal_format_version: journal.format_version,
        entries,
        pending,
    };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize data.activation.status response: {err}"),
        )
    })?;
    generated::validate_result_data_activation_status(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel data.activation.status response failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    serde_json::to_vec(&value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize data.activation.status response: {err}"),
        )
    })
}
