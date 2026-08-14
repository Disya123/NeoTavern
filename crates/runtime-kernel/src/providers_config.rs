//! Provider configuration CRUD with secrets out of the database
//! (ТЗ §9.4, §SEC-01, Этап 2.4).
//!
//! `provider_configs` rows carry non-secret `config_json` plus an opaque
//! `secret_ref` — never the secret value. The secret (API key) is stored
//! through the host-provided [`SecretStore`] port seam
//! ([`Kernel::set_secret_store`](crate::Kernel::set_secret_store)) under
//! namespace `provider:<provider>` / id `<name>`; the wire DTO reports only
//! `hasApiKey`, so a value can never leak over the wire, into backups,
//! exports or diagnostics.
//!
//! Fail-closed boundary: setting an `apiKey` without a wired store yields a
//! stable `SECRET_UNAVAILABLE` product error — there is no plaintext
//! fallback. Read-only backends (env provider) yield `SECRET_STORE_READ_ONLY`.
//!
//! Config names are wire-constrained to `[a-z0-9-]` slugs, so the derived
//! secret id is colon-free and the persisted reference round-trips through
//! the last-colon `parse_ref` contract (ADR-0040).

use crate::{KernelError, KernelErrorCode};
use contracts_generated::generated::{
    self, ProviderConfigDto, ResultEmpty, ResultListProviderConfigs,
};
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::{params, params_from_iter, types::Value};
use secret_store::error::SecretStoreError;
use secret_store::SecretStore;
use std::sync::Arc;

/// Secret namespace prefix for provider config secrets.
const SECRET_NAMESPACE_PREFIX: &str = "provider:";

/// Renders the SecretStore namespace for a provider's config secrets.
fn secret_namespace(provider: &str) -> String {
    format!("{SECRET_NAMESPACE_PREFIX}{provider}")
}

/// Stable product error for a missing provider config.
fn config_not_found(provider: &str, name: &str) -> KernelError {
    KernelError::product(
        "PROVIDER_CONFIG_NOT_FOUND".to_string(),
        vec![
            ("provider".to_string(), provider.to_string()),
            ("name".to_string(), name.to_string()),
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

/// Renders a `provider_configs` row as the wire [`ProviderConfigDto`].
fn row_to_provider_config(row: &rusqlite::Row) -> Result<ProviderConfigDto, KernelError> {
    let config_json: String = row
        .get(3)
        .map_err(|e| sqlite(e, "provider_configs: read config_json"))?;
    let config: serde_json::Value = serde_json::from_str(&config_json).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("provider_configs.config_json is not valid JSON: {err}"),
        )
    })?;
    let secret_ref: Option<String> = row
        .get(4)
        .map_err(|e| sqlite(e, "provider_configs: read secret_ref"))?;
    Ok(ProviderConfigDto {
        id: row
            .get(0)
            .map_err(|e| sqlite(e, "provider_configs: read id"))?,
        provider: row
            .get(1)
            .map_err(|e| sqlite(e, "provider_configs: read provider"))?,
        name: row
            .get(2)
            .map_err(|e| sqlite(e, "provider_configs: read name"))?,
        config,
        has_api_key: secret_ref.is_some(),
        created_at: row
            .get(5)
            .map_err(|e| sqlite(e, "provider_configs: read created_at"))?,
        updated_at: row
            .get(6)
            .map_err(|e| sqlite(e, "provider_configs: read updated_at"))?,
    })
}

/// Selects one provider config row back out of the database.
fn query_provider_config(
    conn: &rusqlite::Connection,
    provider: &str,
    name: &str,
) -> Result<Option<ProviderConfigDto>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, provider, name, config_json, secret_ref, created_at, updated_at \
             FROM provider_configs WHERE provider = ?1 AND name = ?2",
        )
        .map_err(|e| sqlite(e, "query_provider_config: prepare"))?;
    let mut rows = stmt
        .query(params![provider, name])
        .map_err(|e| sqlite(e, "query_provider_config: query"))?;
    match rows
        .next()
        .map_err(|e| sqlite(e, "query_provider_config: read row"))?
    {
        Some(row) => Ok(Some(row_to_provider_config(row)?)),
        None => Ok(None),
    }
}

/// Validates and serializes a config DTO through the generated checker.
fn finish(dto: &ProviderConfigDto) -> Result<Vec<u8>, KernelError> {
    validate(dto, generated::validate_provider_config_dto)?;
    encode(dto)
}

/// `providers.config.set` — upsert a provider config. `apiKey` (when
/// present) is stored through the SecretStore seam; the row keeps only the
/// opaque reference. A set without `apiKey` updates `config` and leaves the
/// stored secret untouched.
pub(crate) fn set(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_set_provider_config(request)?;
    let provider = req.provider.clone();
    let name = req.name.clone();
    let id = new_id();
    let now = now();
    let config_json = serde_json::to_string(
        req.config
            .as_ref()
            .unwrap_or(&serde_json::Value::Object(Default::default())),
    )
    .map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize provider config: {err}"),
        )
    })?;

    // The secret, when provided, must be persisted BEFORE the row is
    // committed so the reference never dangles (and the store is never
    // written with an uncommitted row).
    let secret_ref: Option<String> = if let Some(api_key) = &req.api_key {
        let store = store.ok_or_else(no_secret_store)?;
        Some(
            store
                .put(&secret_namespace(&provider), &name, api_key)
                .map_err(|e| secret_error(&e))?,
        )
    } else {
        None
    };

    let changed = db.transaction(|tx| {
        let changed = match secret_ref {
            // Replace the key: overwrite the store record (same namespace/id)
            // and the row reference.
            Some(ref r) => tx.execute(
                "INSERT INTO provider_configs (id, provider, name, config_json, secret_ref, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(provider, name) DO UPDATE SET \
                   config_json = excluded.config_json, secret_ref = excluded.secret_ref, updated_at = excluded.updated_at",
                params![&id, &provider, &name, &config_json, r, &now, &now],
            ),
            // No new key: preserve the existing secret_ref.
            None => tx.execute(
                "INSERT INTO provider_configs (id, provider, name, config_json, secret_ref, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6) \
                 ON CONFLICT(provider, name) DO UPDATE SET \
                   config_json = excluded.config_json, updated_at = excluded.updated_at",
                params![&id, &provider, &name, &config_json, &now, &now],
            ),
        }
        .map_err(|e| StorageError::from_sqlite(e, "providers_config_set: upsert"))?;
        Ok(changed)
    })?;
    debug_assert_eq!(changed, 1, "upsert must affect exactly one row");

    let dto = query_provider_config(db.conn(), &provider, &name)?.ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::Internal,
            "providers.config.set: upsert succeeded but select back found no row",
        )
    })?;
    finish(&dto)
}

/// `providers.config.get` — one config; missing → `PROVIDER_CONFIG_NOT_FOUND`.
/// The DTO never carries the secret — only `hasApiKey`.
pub(crate) fn get(
    db: &mut Database,
    _store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_get_provider_config(request)?;
    let dto = query_provider_config(db.conn(), &req.provider, &req.name)?
        .ok_or_else(|| config_not_found(&req.provider, &req.name))?;
    finish(&dto)
}

/// `providers.config.list` — all configs, optionally filtered by provider,
/// ordered by (provider, name).
pub(crate) fn list(
    db: &mut Database,
    _store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_list_provider_configs(request)?;
    let mut items: Vec<ProviderConfigDto> = Vec::new();
    {
        let conn = db.conn();
        let mut sql = String::from(
            "SELECT id, provider, name, config_json, secret_ref, created_at, updated_at \
             FROM provider_configs",
        );
        let mut params: Vec<Value> = Vec::new();
        if let Some(provider) = &req.provider {
            sql.push_str(" WHERE provider = ?");
            params.push(Value::Text(provider.clone()));
        }
        sql.push_str(" ORDER BY provider ASC, name ASC");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| sqlite(e, "providers_config_list: prepare"))?;
        let mut rows = stmt
            .query(params_from_iter(params))
            .map_err(|e| sqlite(e, "providers_config_list: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "providers_config_list: read row"))?
        {
            items.push(row_to_provider_config(row)?);
        }
    }
    let dto = ResultListProviderConfigs { items };
    validate(&dto, generated::validate_result_list_provider_configs)?;
    encode(&dto)
}

/// `providers.config.delete` — remove the config and revoke its stored
/// secret (best-effort store revocation after the row commit; a store
/// failure never fails the deletion — the row is the authority).
pub(crate) fn delete(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_provider_config(request)?;
    let changed = db.transaction(|tx| {
        tx.execute(
            "DELETE FROM provider_configs WHERE provider = ?1 AND name = ?2",
            params![&req.provider, &req.name],
        )
        .map_err(|e| StorageError::from_sqlite(e, "providers_config_delete: delete"))
    })?;
    if changed == 0 {
        return Err(config_not_found(&req.provider, &req.name));
    }
    if let Some(store) = store {
        if let Err(err) = store.delete(&secret_namespace(&req.provider), &req.name) {
            // The row is gone; a failed revocation leaves an orphaned store
            // record at worst — never fail the operation over it.
            eprintln!("providers.config.delete: secret revocation failed: {err}");
        }
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

// --- helpers shared with the rest of the kernel (mirrors product.rs). ---

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
            format!("failed to serialize provider-config dto: {err}"),
        )
    })?;
    check(&json).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "provider-config dto failed wire validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })
}

fn encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, KernelError> {
    serde_json::to_vec(value).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize provider-config response: {err}"),
        )
    })
}
