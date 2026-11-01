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
use rusqlite::{params, params_from_iter, types::Value, OptionalExtension};
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
///
/// `has_active_secret` is the caller-computed answer to "does this config own
/// an ACTIVE named key" (`provider_secrets`, v24) — the DTO reports the
/// logical state (`hasApiKey`) without ever reading a value (SEC-01).
fn row_to_provider_config(
    row: &rusqlite::Row,
    has_active_secret: bool,
) -> Result<ProviderConfigDto, KernelError> {
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
        has_api_key: secret_ref.is_some() || has_active_secret,
        created_at: row
            .get(5)
            .map_err(|e| sqlite(e, "provider_configs: read created_at"))?,
        updated_at: row
            .get(6)
            .map_err(|e| sqlite(e, "provider_configs: read updated_at"))?,
    })
}

/// Whether a provider config owns an ACTIVE named key (v24
/// `provider_secrets`). Reads no secret value — the answer is a row
/// existence check, so it can never leak a key.
pub(crate) fn has_active_secret(
    conn: &rusqlite::Connection,
    config_id: &str,
) -> Result<bool, KernelError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM provider_secrets WHERE config_id = ?1 AND active = 1)",
        params![config_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|found| found == 1)
    .map_err(|e| sqlite(e, "provider_secrets: has_active"))
}

/// Resolves the execution-time API key for ONE addressed config (cluster 8
/// provider-access ops): the ACTIVE named key (`provider_secrets`, v24) first,
/// else the config-level `secret_ref`. Mirrors the generation-side resolution
/// but keyed by config id instead of "the first config of the provider".
///
/// * No reference at all → `Ok(None)` (the adapter decides; a keyless adapter
///   reports its own typed error).
/// * A reference but no resolver seam → fail-closed `SECRET_UNAVAILABLE`
///   (no plaintext fallback; §9.4/§87).
/// * Resolver failures keep their stable `SECRET_*` product code.
pub(crate) fn resolve_config_api_key(
    conn: &rusqlite::Connection,
    resolver: Option<&dyn provider_sdk::secret::SecretResolver>,
    config_id: &str,
    provider: &str,
) -> Result<Option<String>, KernelError> {
    let config_ref: Option<String> = conn
        .query_row(
            "SELECT secret_ref FROM provider_configs WHERE id = ?1",
            params![config_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| sqlite(e, "provider_configs: read secret_ref"))?
        .flatten();
    let active_ref: Option<String> = conn
        .query_row(
            "SELECT secret_ref FROM provider_secrets WHERE config_id = ?1 AND active = 1 LIMIT 1",
            params![config_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| sqlite(e, "provider_secrets: read active secret_ref"))?;
    let Some(reference) = active_ref.or(config_ref) else {
        return Ok(None);
    };
    let resolver = resolver.ok_or_else(|| {
        KernelError::product(
            "SECRET_UNAVAILABLE".to_string(),
            vec![("provider".to_string(), provider.to_string())],
        )
    })?;
    let value = resolver
        .resolve(&provider_sdk::secret::SecretRef(reference))
        .map_err(|err| {
            KernelError::product(
                err.code.to_string(),
                vec![("provider".to_string(), provider.to_string())],
            )
        })?;
    Ok(Some(value.expose().to_string()))
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
        Some(row) => {
            let id: String = row
                .get(0)
                .map_err(|e| sqlite(e, "query_provider_config: read id"))?;
            let has_active = has_active_secret(conn, &id)?;
            Ok(Some(row_to_provider_config(row, has_active)?))
        }
        None => Ok(None),
    }
}

/// Loads one provider config row by its stable id — the durable
/// selection chain of UI-01/ADR-0057 Phase 2: `generation.start` without
/// explicit provider/model resolves the ACTIVE profile through this read
/// (INV-1: the Kernel resolves its own state; sessions never do).
/// `None` = no row with that id (the caller maps it to a stable error).
pub(crate) fn load_config_by_id(
    conn: &rusqlite::Connection,
    id: &str,
) -> Result<Option<(String, serde_json::Value)>, KernelError> {
    let mut stmt = conn
        .prepare("SELECT provider, config_json FROM provider_configs WHERE id = ?1")
        .map_err(|e| sqlite(e, "load_config_by_id: prepare"))?;
    let mut rows = stmt
        .query(params![id])
        .map_err(|e| sqlite(e, "load_config_by_id: query"))?;
    match rows
        .next()
        .map_err(|e| sqlite(e, "load_config_by_id: read row"))?
    {
        Some(row) => {
            let provider: String = row
                .get(0)
                .map_err(|e| sqlite(e, "load_config_by_id: provider"))?;
            let config_json: String = row
                .get(1)
                .map_err(|e| sqlite(e, "load_config_by_id: config_json"))?;
            let config: serde_json::Value = serde_json::from_str(&config_json).map_err(|err| {
                KernelError::new(
                    KernelErrorCode::Internal,
                    format!("provider_configs.config_json is not valid JSON: {err}"),
                )
            })?;
            Ok(Some((provider, config)))
        }
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
///
/// The adapter registry is hydrated right after the commit (М5 slice 48): a
/// saved config for a known provider kind is immediately generatable — the
/// UI never has to wait for a kernel restart.
pub(crate) fn set(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    registry: &mut crate::providers::ProviderRegistry,
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
    // Hydrate the adapter for the saved config (best-effort: an unknown kind
    // is simply not registered; a malformed config logs and is skipped).
    crate::providers::register_config_adapter(registry, &provider, &dto.config);
    finish(&dto)
}

/// Hydrates every stored provider config into the adapter registry (М5 slice
/// 48). Runs once at kernel startup so saved configs survive restarts; an
/// unknown kind or a malformed config is skipped with a diagnostic, never a
/// startup failure.
pub(crate) fn hydrate(
    db: &Database,
    registry: &mut crate::providers::ProviderRegistry,
) -> Result<(), KernelError> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare(
            "SELECT provider, config_json FROM provider_configs \
             ORDER BY provider ASC, name ASC",
        )
        .map_err(|e| sqlite(e, "providers_config_hydrate: prepare"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| sqlite(e, "providers_config_hydrate: query"))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| sqlite(e, "providers_config_hydrate: read row"))?
    {
        let provider: String = row
            .get(0)
            .map_err(|e| sqlite(e, "providers_config_hydrate: provider"))?;
        let config_json: String = row
            .get(1)
            .map_err(|e| sqlite(e, "providers_config_hydrate: config_json"))?;
        let config: serde_json::Value = match serde_json::from_str(&config_json) {
            Ok(config) => config,
            Err(err) => {
                eprintln!("kernel: provider config hydration skipped ({provider}): {err}");
                continue;
            }
        };
        crate::providers::register_config_adapter(registry, &provider, &config);
    }
    Ok(())
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
            let id: String = row
                .get(0)
                .map_err(|e| sqlite(e, "providers_config_list: read id"))?;
            let has_active = has_active_secret(conn, &id)?;
            items.push(row_to_provider_config(row, has_active)?);
        }
    }
    let dto = ResultListProviderConfigs { items };
    validate(&dto, generated::validate_result_list_provider_configs)?;
    encode(&dto)
}

/// `providers.config.delete` — remove the config, every named key row and the
/// stored secret values (best-effort store revocation after the row commit; a
/// store failure never fails the deletion — the row is the authority).
///
/// SEC-01 cascade: named keys (`provider_secrets`, v24) are revoked BEFORE
/// the row delete cascades them, so a store value can never orphan behind a
/// reference that no longer exists.
pub(crate) fn delete(
    db: &mut Database,
    store: Option<&Arc<dyn SecretStore>>,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_delete_provider_config(request)?;
    // Read what has to be revoked before the cascading delete hides it.
    let config_id: Option<String> = {
        let conn = db.conn();
        conn.query_row(
            "SELECT id FROM provider_configs WHERE provider = ?1 AND name = ?2",
            params![&req.provider, &req.name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| sqlite(e, "providers_config_delete: select id"))?
    };
    let mut named_secret_ids: Vec<String> = Vec::new();
    if let Some(config_id) = &config_id {
        let conn = db.conn();
        let mut stmt = conn
            .prepare("SELECT id FROM provider_secrets WHERE config_id = ?1")
            .map_err(|e| sqlite(e, "providers_config_delete: prepare secret ids"))?;
        let mut rows = stmt
            .query(params![config_id])
            .map_err(|e| sqlite(e, "providers_config_delete: query secret ids"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "providers_config_delete: read secret id"))?
        {
            named_secret_ids.push(
                row.get(0)
                    .map_err(|e| sqlite(e, "providers_config_delete: secret id"))?,
            );
        }
    }
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
        if let Some(config_id) = &config_id {
            let namespace = crate::provider_secrets::secret_namespace(config_id);
            for secret_id in &named_secret_ids {
                if let Err(err) = store.delete(&namespace, secret_id) {
                    // The row is gone; a failed revocation leaves an orphaned
                    // store record at worst — never fail the operation.
                    eprintln!("providers.config.delete: named secret revocation failed: {err}");
                }
            }
        }
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
    // Bounded serialization (plan rev 2.2 Layer C) — shared LimitedWriter.
    crate::product::encode(value)
}
