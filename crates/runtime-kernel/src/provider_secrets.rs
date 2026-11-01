//! Named provider secrets with exactly one ACTIVE key per config (ТЗ §9.4,
//! SEC-01; M7 Etap-4 cluster 7).
//!
//! A provider config may hold several labelled API keys. The rows
//! (`provider_secrets`, schema v24) carry only the opaque SecretStore
//! reference — never the value — and the plaintext lives in the host-provided
//! [`SecretStore`] under namespace `provider-secret:<configId>` /
//! id `<secretId>`. The value crosses the wire through exactly ONE operation,
//! `providers.secrets.reveal`, and only while the host enabled the exposure
//! policy (default OFF, mirroring the legacy `NEOTA_ALLOW_SECRETS_EXPOSURE`
//! gate). Every other DTO is value-free: list/update report a `masked` display
//! hint derived from the OPAQUE REFERENCE (never from the key), so even the
//! masked tail cannot leak key material.
//!
//! Semantics mirror the legacy `provider_secrets` repository:
//! - create → the new key becomes active and deactivates every sibling;
//! - update(`active: true`) → atomically deactivates siblings first (the
//!   partial unique index `idx_provider_secrets_active` enforces one active
//!   row per config at the storage layer);
//! - delete → when the active key is removed, the most recently created
//!   remaining key is reactivated so the provider keeps a usable key;
//! - a config delete revokes every named store value BEFORE the rows cascade
//!   (see [`crate::providers_config::delete`]).
//!
//! Fail-closed: without a wired store, create/reveal return the stable
//! `SECRET_UNAVAILABLE` product error; a store failure surfaces its own
//! `SECRET_*` code. There is no plaintext fallback.

use crate::{KernelError, KernelErrorCode};
use contracts_generated::generated::{
    self, ProviderSecretDto, ResultEmpty, ResultProviderSecretCreated, ResultProviderSecretReveal,
    ResultProviderSecrets, ResultSecretsExposure,
};
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::{params, OptionalExtension};
use secret_store::error::SecretStoreError;
use secret_store::SecretStore;
use std::sync::Arc;

/// SecretStore namespace prefix for named provider keys.
const NAMED_SECRET_NAMESPACE_PREFIX: &str = "provider-secret:";

/// SecretStore namespace holding one provider config's named keys.
pub(crate) fn secret_namespace(config_id: &str) -> String {
    format!("{NAMED_SECRET_NAMESPACE_PREFIX}{config_id}")
}

/// Mask a stored OPAQUE REFERENCE for display: bullets plus at most the last
/// four characters (legacy `maskSecretValue` shape). The input is the
/// SecretStore reference, never the key — the mask cannot leak key material.
pub(crate) fn mask_secret_reference(reference: &str) -> String {
    let chars: Vec<char> = reference.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    const VISIBLE_SUFFIX: usize = 4;
    if chars.len() <= VISIBLE_SUFFIX {
        return "•".repeat(chars.len());
    }
    let bullets = std::cmp::min(8, chars.len() - VISIBLE_SUFFIX);
    let tail: String = chars[chars.len() - VISIBLE_SUFFIX..].iter().collect();
    format!("{}{tail}", "•".repeat(bullets))
}

/// Product error for a missing provider config.
fn config_not_found(provider_id: &str) -> KernelError {
    KernelError::product(
        "PROVIDER_CONFIG_NOT_FOUND".to_string(),
        vec![("providerId".to_string(), provider_id.to_string())],
    )
}

/// Product error for a missing named secret of the addressed config.
fn secret_not_found(provider_id: &str, secret_id: &str) -> KernelError {
    KernelError::product(
        "PROVIDER_SECRET_NOT_FOUND".to_string(),
        vec![
            ("providerId".to_string(), provider_id.to_string()),
            ("secretId".to_string(), secret_id.to_string()),
        ],
    )
}

/// Maps a SecretStore failure to a product error carrying the stable
/// `SECRET_*` code (never the value, never the message verbatim).
fn secret_error(err: &SecretStoreError) -> KernelError {
    KernelError::product(err.code.to_string(), vec![])
}

/// Product error when no SecretStore seam is wired (fail-closed; §9.4).
fn no_secret_store() -> KernelError {
    KernelError::product("SECRET_UNAVAILABLE".to_string(), vec![])
}

/// Product error when the host did not enable plaintext exposure.
fn exposure_disabled() -> KernelError {
    KernelError::product("SECRETS_EXPOSURE_DISABLED".to_string(), vec![])
}

/// Normalizes an incoming label: trimmed; blank becomes "no label".
fn normalize_label(label: Option<String>) -> Option<String> {
    label.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// Ensures the addressed provider config exists (`PROVIDER_CONFIG_NOT_FOUND`
/// otherwise) — the legacy route's 404 parity.
fn ensure_config(conn: &rusqlite::Connection, provider_id: &str) -> Result<(), KernelError> {
    let exists: i64 = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM provider_configs WHERE id = ?1)",
            params![provider_id],
            |row| row.get(0),
        )
        .map_err(|e| sqlite(e, "provider_secrets: ensure_config"))?;
    if exists == 0 {
        return Err(config_not_found(provider_id));
    }
    Ok(())
}

/// One stored row: id, label, opaque reference, active flag, created stamp.
struct SecretRow {
    id: String,
    label: Option<String>,
    secret_ref: String,
    active: bool,
    created_at: String,
}

/// Reads one row scoped to its owning config.
fn load_secret(
    conn: &rusqlite::Connection,
    provider_id: &str,
    secret_id: &str,
) -> Result<Option<SecretRow>, KernelError> {
    conn.query_row(
        "SELECT id, label, secret_ref, active, created_at FROM provider_secrets \
         WHERE id = ?1 AND config_id = ?2",
        params![secret_id, provider_id],
        |row| {
            Ok(SecretRow {
                id: row.get(0)?,
                label: row.get(1)?,
                secret_ref: row.get(2)?,
                active: row.get::<_, i64>(3)? == 1,
                created_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| sqlite(e, "provider_secrets: load"))
}

/// Renders a row as the value-free wire DTO.
fn to_dto(provider_id: &str, row: &SecretRow) -> ProviderSecretDto {
    ProviderSecretDto {
        id: row.id.clone(),
        provider_id: provider_id.to_string(),
        label: row.label.clone(),
        active: row.active,
        masked: mask_secret_reference(&row.secret_ref),
        created_at: row.created_at.clone(),
    }
}

/// `providers.secrets.list` — the config's named keys, active first then by
/// creation order. Masked display hints only; the DTO never carries a value.
pub(crate) fn list(
    db: &mut Database,
    _store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_list_provider_secrets(request)?;
    let conn = db.conn();
    ensure_config(conn, &req.provider_id)?;
    let mut items: Vec<ProviderSecretDto> = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT id, label, secret_ref, active, created_at FROM provider_secrets \
             WHERE config_id = ?1 ORDER BY active DESC, created_at ASC, rowid ASC",
        )
        .map_err(|e| sqlite(e, "provider_secrets_list: prepare"))?;
    let mut rows = stmt
        .query(params![&req.provider_id])
        .map_err(|e| sqlite(e, "provider_secrets_list: query"))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| sqlite(e, "provider_secrets_list: read row"))?
    {
        let secret = SecretRow {
            id: row
                .get(0)
                .map_err(|e| sqlite(e, "provider_secrets_list: id"))?,
            label: row
                .get(1)
                .map_err(|e| sqlite(e, "provider_secrets_list: label"))?,
            secret_ref: row
                .get(2)
                .map_err(|e| sqlite(e, "provider_secrets_list: secret_ref"))?,
            active: row
                .get::<_, i64>(3)
                .map_err(|e| sqlite(e, "provider_secrets_list: active"))?
                == 1,
            created_at: row
                .get(4)
                .map_err(|e| sqlite(e, "provider_secrets_list: created_at"))?,
        };
        items.push(to_dto(&req.provider_id, &secret));
    }
    let dto = ResultProviderSecrets { items };
    validate(&dto, generated::validate_result_provider_secrets)?;
    encode(&dto)
}

/// `providers.secrets.create` — store the value, then insert the row; the new
/// key becomes the active one (legacy parity). The store write happens BEFORE
/// the insert, so a rolled-back insert can never leave a reference pointing at
/// a missing value (it is cleaned up best-effort on failure).
pub(crate) fn create(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_create_provider_secret(request)?;
    let store = store.ok_or_else(no_secret_store)?;
    {
        let conn = db.conn();
        ensure_config(conn, &req.provider_id)?;
    }
    let secret_id = new_id();
    let namespace = secret_namespace(&req.provider_id);
    let reference = store
        .put(&namespace, &secret_id, &req.value)
        .map_err(|e| secret_error(&e))?;
    let label = normalize_label(req.label);
    let created_at = now();
    let inserted =
        db.transaction(|tx| {
            tx.execute(
                "UPDATE provider_secrets SET active = 0 WHERE config_id = ?1 AND active = 1",
                params![&req.provider_id],
            )
            .map_err(|e| {
                StorageError::from_sqlite(e, "provider_secrets_create: deactivate siblings")
            })?;
            tx.execute(
            "INSERT INTO provider_secrets (id, config_id, label, secret_ref, active, created_at) \
             VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            params![&secret_id, &req.provider_id, &label, &reference, &created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "provider_secrets_create: insert"))
        });
    if let Err(err) = inserted {
        // Never orphan the value behind a row that does not exist.
        if let Err(cleanup) = store.delete(&namespace, &secret_id) {
            eprintln!("providers.secrets.create: orphan cleanup failed: {cleanup}");
        }
        return Err(KernelError::from(err));
    }
    let dto = ResultProviderSecretCreated { id: secret_id };
    validate(&dto, generated::validate_result_provider_secret_created)?;
    encode(&dto)
}

/// `providers.secrets.update` — rename and/or activate. Activating one key
/// deactivates its siblings inside the same transaction; `label: ''` clears
/// the stored label. The response is the updated value-free DTO.
pub(crate) fn update(
    db: &mut Database,
    _store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_update_provider_secret(request)?;
    let label_provided = req.label.is_some();
    let label = normalize_label(req.label);
    {
        let conn = db.conn();
        if load_secret(conn, &req.provider_id, &req.secret_id)?.is_none() {
            return Err(secret_not_found(&req.provider_id, &req.secret_id));
        }
    }
    db.transaction(|tx| {
        if req.active == Some(true) {
            tx.execute(
                "UPDATE provider_secrets SET active = 0 WHERE config_id = ?1 AND active = 1",
                params![&req.provider_id],
            )
            .map_err(|e| StorageError::from_sqlite(e, "provider_secrets_update: deactivate"))?;
            tx.execute(
                "UPDATE provider_secrets SET active = 1 WHERE id = ?1 AND config_id = ?2",
                params![&req.secret_id, &req.provider_id],
            )
            .map_err(|e| StorageError::from_sqlite(e, "provider_secrets_update: activate"))?;
        } else if req.active == Some(false) {
            tx.execute(
                "UPDATE provider_secrets SET active = 0 WHERE id = ?1 AND config_id = ?2",
                params![&req.secret_id, &req.provider_id],
            )
            .map_err(|e| StorageError::from_sqlite(e, "provider_secrets_update: deactivate one"))?;
        }
        if label_provided {
            tx.execute(
                "UPDATE provider_secrets SET label = ?1 WHERE id = ?2 AND config_id = ?3",
                params![&label, &req.secret_id, &req.provider_id],
            )
            .map_err(|e| StorageError::from_sqlite(e, "provider_secrets_update: label"))?;
        }
        Ok(())
    })?;
    let conn = db.conn();
    let secret = load_secret(conn, &req.provider_id, &req.secret_id)?
        .ok_or_else(|| secret_not_found(&req.provider_id, &req.secret_id))?;
    let dto = to_dto(&req.provider_id, &secret);
    validate(&dto, generated::validate_provider_secret_dto)?;
    encode(&dto)
}

/// `providers.secrets.delete` — remove the row, reactivate the most recently
/// created remaining key when the active one was deleted (legacy parity), then
/// revoke the store value (best-effort: the row is the authority).
pub(crate) fn delete(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_provider_secret(request)?;
    let existing = {
        let conn = db.conn();
        load_secret(conn, &req.provider_id, &req.secret_id)?
            .ok_or_else(|| secret_not_found(&req.provider_id, &req.secret_id))?
    };
    db.transaction(|tx| {
        tx.execute(
            "DELETE FROM provider_secrets WHERE id = ?1 AND config_id = ?2",
            params![&req.secret_id, &req.provider_id],
        )
        .map_err(|e| StorageError::from_sqlite(e, "provider_secrets_delete: delete"))?;
        if existing.active {
            // Keep the provider usable: the most recent remaining key becomes
            // active (`rowid` is the stable insertion-order tie-break when
            // timestamps collide).
            let next: Option<String> = tx
                .query_row(
                    "SELECT id FROM provider_secrets WHERE config_id = ?1 \
                     ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    params![&req.provider_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| StorageError::from_sqlite(e, "provider_secrets_delete: next"))?;
            if let Some(next_id) = next {
                tx.execute(
                    "UPDATE provider_secrets SET active = 1 WHERE id = ?1",
                    params![&next_id],
                )
                .map_err(|e| {
                    StorageError::from_sqlite(e, "provider_secrets_delete: reactivate next")
                })?;
            }
        }
        Ok(())
    })?;
    if let Some(store) = store {
        let namespace = secret_namespace(&req.provider_id);
        if let Err(err) = store.delete(&namespace, &req.secret_id) {
            eprintln!("providers.secrets.delete: secret revocation failed: {err}");
        }
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

/// `providers.secrets.reveal` — the ONLY operation that returns a plaintext
/// value, gated by the host exposure policy (`secrets.exposure`, default off).
/// With the policy off the op fails with `SECRETS_EXPOSURE_DISABLED` before
/// the store is even addressed.
pub(crate) fn reveal(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    allow_exposure: bool,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_reveal_provider_secret(request)?;
    if !allow_exposure {
        return Err(exposure_disabled());
    }
    {
        let conn = db.conn();
        if load_secret(conn, &req.provider_id, &req.secret_id)?.is_none() {
            return Err(secret_not_found(&req.provider_id, &req.secret_id));
        }
    }
    let store = store.ok_or_else(no_secret_store)?;
    let namespace = secret_namespace(&req.provider_id);
    let value = store
        .get(&namespace, &req.secret_id)
        .map_err(|e| secret_error(&e))?
        .ok_or_else(|| {
            KernelError::product(
                "SECRET_UNAVAILABLE_ON_THIS_DEVICE".to_string(),
                vec![
                    ("providerId".to_string(), req.provider_id.clone()),
                    ("secretId".to_string(), req.secret_id.clone()),
                ],
            )
        })?;
    let dto = ResultProviderSecretReveal { value };
    validate(&dto, generated::validate_result_provider_secret_reveal)?;
    encode(&dto)
}

/// `secrets.exposure` — value-free host policy surface: whether plaintext
/// reveal is enabled (`NEOTA_ALLOW_SECRETS_EXPOSURE`, default off).
pub(crate) fn exposure(allow_exposure: bool, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    let dto = ResultSecretsExposure {
        allow_secrets_exposure: allow_exposure,
    };
    validate(&dto, generated::validate_result_secrets_exposure)?;
    encode(&dto)
}

// --- helpers shared with the rest of the kernel (mirrors providers_config). ---

fn now() -> String {
    neotavern_storage::now_utc_rfc3339()
}

/// Generates a fresh record id (same scheme as product.rs).
fn new_id() -> String {
    const VERSION_NIBBLE_MASK: u128 = 0xF000_0000_0000_0000_0000;
    const V4_NIBBLE: u128 = 0x4000_0000_0000_0000_0000;
    let raw = uuid::Uuid::now_v7().as_u128();
    uuid::Uuid::from_u128((raw & !VERSION_NIBBLE_MASK) | V4_NIBBLE).to_string()
}

fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::from(StorageError::from_sqlite(err, context))
}

fn validate<T: serde::Serialize>(
    value: &T,
    check: fn(&serde_json::Value) -> Result<(), Vec<contracts_generated::Issue>>,
) -> Result<(), KernelError> {
    let json = serde_json::to_value(value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize provider-secret dto: {err}"),
        )
    })?;
    check(&json).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "provider-secret dto failed wire validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })
}

fn encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, KernelError> {
    // Bounded serialization (plan rev 2.2 Layer C) — shared LimitedWriter.
    crate::product::encode(value)
}
