//! SEC-01.1 value-free secret-backend surface (Этап 4 slice 7 remainder).
//!
//! `secrets.status` reports the explicit secret-store MODE through the wire
//! without ever touching a value: the backend kind (`portable` = encrypted
//! `secrets.enc` inside the portable data root, `env`, `session` = session-
//! only memory store, `unavailable` = no store wired), persistence,
//! writability, availability and the portable format version. The UI renders
//! the honest mode state (SEC-01.1: portable encrypted / machine-bound /
//! session-only, and the fail-closed `SECRET_UNAVAILABLE` state) from this
//! DTO; no `get` is ever invoked, so a value can never cross the boundary.

use contracts_generated::generated::{self, ResultSecretsStatus};
use secret_store::SecretStore;
use std::sync::Arc;

use crate::KernelError;

/// `secrets.status` — stateless (host-provided seam, no storage required).
pub(crate) fn secrets_status(
    store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;

    let (kind, persistent, writable, available, record_count, format_version) = match store {
        Some(store) => {
            let info = store.describe();
            (
                info.kind.to_string(),
                info.persistent,
                info.writable,
                info.available,
                info.record_count as i64,
                info.format_version.map(|v| v as i64),
            )
        }
        None => ("unavailable".to_string(), false, false, false, 0, None),
    };

    let dto = ResultSecretsStatus {
        kind,
        persistent,
        writable,
        available,
        record_count,
        format_version,
    };
    let value = serde_json::to_value(&dto).map_err(|err| {
        KernelError::new(
            crate::KernelErrorCode::Internal,
            format!("failed to serialize secrets status response: {err}"),
        )
    })?;
    generated::validate_result_secrets_status(&value).map_err(|issues| KernelError {
        code: crate::KernelErrorCode::ContractViolation,
        message: "kernel secrets-status dto failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    crate::product::encode(&value)
}
