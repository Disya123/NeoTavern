//! Canonical Theme-SDK registry (ТЗ §5.2 theme-sdk, §SEC-05, Этап 4
//! slice 6 part 2).
//!
//! The `themes` table (schema v13) is the DURABLE lifecycle state of one
//! installed theme. A theme is DATA, never code: the opaque manifest plus a
//! content-addressed CSS asset reference (`css_asset_id` → an asset
//! published through `assets.put` with kind `theme-css`, existence
//! validated here at install — AGENTS.md §19: a theme gets no access to
//! chats, API keys or the filesystem, and the table holds no CSS bytes).
//!
//! - `themes.install` — the host has ALREADY verified the package (SEC-05)
//!   and published the CSS before calling this op; the kernel durably
//!   records the verified trust state and version. Re-installing the same
//!   id+version is idempotent; a version change that would LOWER the
//!   recorded SEC-05 trust rank is rejected (Conflict, same rule as
//!   plugins). Install never activates — activation is an explicit
//!   separate consent.
//! - `themes.activate` — switches the single `active` flag (idempotent;
//!   activating the already-active theme is a no-op).
//! - `themes.deactivate` — clears the single `active` flag (idempotent;
//!   no active theme is a successful no-op). The shell falls back to the
//!   default theme (AGENTS.md §19); this is the explicit "stop applying a
//!   theme" consent, distinct from uninstall which also removes the row.
//! - `themes.uninstall` — durable row removal; uninstalling the ACTIVE
//!   theme clears the flag so the shell falls back to the default
//!   (AGENTS.md §19: a broken theme must never block the interface reset).
//! - `themes.list` — the full registry snapshot.
//!
//! Theme-owned settings (М7 Этап-4 cluster 14, ТЗ §6.5):
//!
//! - `themes.settings.get` — the manifest-merged values view for one theme:
//!   every manifest-declared setting id resolves to its persisted value when
//!   that value still validates against the declared type, else the manifest
//!   default (or null). Undeclared stored keys are never surfaced.
//! - `themes.settings.update` — a PARTIAL merge (the legacy PATCH shape):
//!   every supplied key must be declared in the theme manifest and pass its
//!   type validation (color strings are bounded and must not smuggle CSS
//!   constructs — THEME-45; booleans, finite numbers and select options
//!   pass) — one bad key refuses the WHOLE update before any write.
//!
//! Persisted values live in the shared non-secret `settings` table under the
//! legacy `theme.settings.<id>` key, so a future legacy import maps 1:1; the
//! row stores plain values, never CSS bytes and never secrets.

use contracts_generated::generated::{
    self, FreeObject, RequestThemesActivate, RequestThemesInstall, RequestThemesSettingsGet,
    RequestThemesSettingsUpdate, RequestThemesUninstall, ResultThemesInstall, ResultThemesList,
    ResultThemesSettings, ThemesItem,
};
use neotavern_storage::open::Database;
use rusqlite::OptionalExtension;

use crate::product::now;
use crate::{KernelError, KernelErrorCode};

/// Trust rank for the SEC-05 ordering (higher = more trusted); identical to
/// the plugins rule. An install that would lower the recorded rank is
/// rejected.
fn trust_rank(state: &str) -> u8 {
    match state {
        "built-in" => 3,
        "verified-publisher" => 2,
        "locally-trusted" => 1,
        _ => 0,
    }
}

/// `themes.list` — full registry snapshot, ordered by id.
pub(crate) fn themes_list(db: &Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, name, version, active, manifest_json, css_asset_id, \
                    trust_state, publisher_key_id, installed_at, updated_at \
             FROM themes ORDER BY id",
        )
        .map_err(|err| sqlite(err, "themes.list: prepare"))?;
    let rows = stmt
        .query_map([], theme_row)
        .map_err(|err| sqlite(err, "themes.list: query"))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|err| sqlite(err, "themes.list: row"))?);
    }
    encode_list(&ResultThemesList { items })
}

/// `themes.install` — durable upsert with SEC-05 trust protection.
pub(crate) fn themes_install(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestThemesInstall = generated::decode_request_themes_install(request)?;
    let now = now();

    if let Some(css_asset_id) = req.css_asset_id.as_deref() {
        crate::assets::asset_by_id(db, css_asset_id)?;
    }

    let existing: Option<(String, String)> = db
        .conn()
        .query_row(
            "SELECT version, trust_state FROM themes WHERE id = ?1",
            rusqlite::params![req.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| sqlite(err, "themes.install: lookup"))?;

    let manifest_json = match &req.manifest {
        Some(manifest) => serde_json::to_string(manifest).map_err(serialize_error)?,
        None => "{}".to_string(),
    };
    let publisher_key_id = req.publisher_key_id.clone();
    let trust_state = req.trust_state.clone();

    match existing {
        None => {
            db.conn()
                .execute(
                    "INSERT INTO themes \
                     (id, name, version, active, manifest_json, css_asset_id, \
                      trust_state, publisher_key_id, installed_at, updated_at) \
                     VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9)",
                    rusqlite::params![
                        req.id,
                        req.name,
                        req.version,
                        manifest_json,
                        req.css_asset_id,
                        trust_state,
                        publisher_key_id,
                        now,
                        now
                    ],
                )
                .map_err(|err| sqlite(err, "themes.install: insert"))?;
        }
        Some((existing_version, existing_trust)) => {
            if existing_version != req.version {
                // Version change: the trust rank must never drop (SEC-05).
                if trust_rank(&req.trust_state) < trust_rank(&existing_trust) {
                    return Err(trust_downgrade(&req.id, &existing_version));
                }
            }
            db.conn()
                .execute(
                    "UPDATE themes \
                     SET name = ?2, version = ?3, manifest_json = ?4, css_asset_id = ?5, \
                         trust_state = ?6, publisher_key_id = ?7, updated_at = ?8 \
                     WHERE id = ?1",
                    rusqlite::params![
                        req.id,
                        req.name,
                        req.version,
                        manifest_json,
                        req.css_asset_id,
                        trust_state,
                        publisher_key_id,
                        now
                    ],
                )
                .map_err(|err| sqlite(err, "themes.install: update"))?;
        }
    }

    let theme = theme_by_id(db, &req.id)?;
    encode_install(&ResultThemesInstall { theme })
}

/// `themes.activate` — switches the single `active` flag (idempotent).
pub(crate) fn themes_activate(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestThemesActivate = generated::decode_request_themes_activate(request)?;
    let now = now();
    let changed = db
        .conn()
        .execute(
            "UPDATE themes SET active = 1, updated_at = ?2 WHERE id = ?1",
            rusqlite::params![req.id, now],
        )
        .map_err(|err| sqlite(err, "themes.activate: set"))?;
    if changed == 0 {
        return Err(theme_not_found(&req.id));
    }
    // Single active theme: clear every other flag.
    db.conn()
        .execute(
            "UPDATE themes SET active = 0 WHERE id <> ?1",
            rusqlite::params![req.id],
        )
        .map_err(|err| sqlite(err, "themes.activate: clear others"))?;
    let theme = theme_by_id(db, &req.id)?;
    encode_theme(&theme)
}

/// `themes.deactivate` — clears the single `active` flag (idempotent; no
/// active theme is a successful no-op). The shell falls back to the default
/// theme (AGENTS.md §19) — the explicit "stop applying a theme" consent,
/// distinct from uninstall which also removes the row.
pub(crate) fn themes_deactivate(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    db.conn()
        .execute(
            "UPDATE themes SET active = 0, updated_at = ?1 WHERE active = 1",
            rusqlite::params![now()],
        )
        .map_err(|err| sqlite(err, "themes.deactivate: clear"))?;
    encode_empty(&generated::ResultEmpty {})
}

/// `themes.uninstall` — durable row removal; uninstalling the active theme
/// clears the flag (default shell fallback, AGENTS.md §19).
pub(crate) fn themes_uninstall(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestThemesUninstall = generated::decode_request_themes_uninstall(request)?;
    let changed = db
        .conn()
        .execute(
            "DELETE FROM themes WHERE id = ?1",
            rusqlite::params![req.id],
        )
        .map_err(|err| sqlite(err, "themes.uninstall: delete"))?;
    if changed == 0 {
        return Err(theme_not_found(&req.id));
    }
    encode_empty(&generated::ResultEmpty {})
}

/// `themes.settings.get` — the manifest-merged settings view for one theme.
pub(crate) fn themes_settings_get(db: &Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestThemesSettingsGet = generated::decode_request_themes_settings_get(request)?;
    let definitions = theme_setting_definitions(db, &req.id)?;
    let stored = read_stored_settings(db.conn(), &theme_settings_key(&req.id))?;
    encode_settings(&ResultThemesSettings {
        values: FreeObject {
            payload: merged_theme_values(&definitions, &stored),
        },
    })
}

/// `themes.settings.update` — validated partial merge of the persisted
/// values, answered with the post-update merged view.
pub(crate) fn themes_settings_update(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req: RequestThemesSettingsUpdate =
        generated::decode_request_themes_settings_update(request)?;
    let definitions = theme_setting_definitions(db, &req.id)?;
    // Validate the WHOLE patch against the manifest before touching the
    // store: one unknown key or one type-violating value refuses the entire
    // update (the legacy boundary; never a silent partial apply).
    let patch = req.values.payload.as_object().cloned().unwrap_or_default();
    for (setting_id, value) in &patch {
        let valid = definitions
            .get(setting_id)
            .is_some_and(|definition| is_setting_value_valid(definition, value));
        if !valid {
            return Err(invalid_setting(setting_id));
        }
    }

    let key = theme_settings_key(&req.id);
    let conn = db.conn();
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| sqlite(err, "themes.settings.update: begin"))?;
    let mut stored = read_stored_settings(&tx, &key)?;
    for (setting_id, value) in &patch {
        stored.insert(setting_id.clone(), value.clone());
    }
    let value_json = serde_json::to_string(&serde_json::Value::Object(stored.clone()))
        .map_err(serialize_error)?;
    tx.execute(
        "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                         updated_at = excluded.updated_at",
        rusqlite::params![key, value_json, now()],
    )
    .map_err(|err| sqlite(err, "themes.settings.update: upsert"))?;
    tx.commit()
        .map_err(|err| sqlite(err, "themes.settings.update: commit"))?;

    encode_settings(&ResultThemesSettings {
        values: FreeObject {
            payload: merged_theme_values(&definitions, &stored),
        },
    })
}

// --- helpers --------------------------------------------------------------

fn theme_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThemesItem> {
    let (
        id,
        name,
        version,
        active,
        manifest_json,
        css_asset_id,
        trust_state,
        publisher_key_id,
        installed_at,
        updated_at,
    ) = (
        row.get::<_, String>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, String>(2)?,
        row.get::<_, bool>(3)?,
        row.get::<_, String>(4)?,
        row.get::<_, Option<String>>(5)?,
        row.get::<_, String>(6)?,
        row.get::<_, Option<String>>(7)?,
        row.get::<_, String>(8)?,
        row.get::<_, String>(9)?,
    );
    let manifest = serde_json::from_str(&manifest_json).ok();
    Ok(ThemesItem {
        id,
        name,
        version,
        active,
        trust_state,
        publisher_key_id,
        css_asset_id,
        installed_at,
        updated_at,
        manifest,
    })
}

fn theme_by_id(db: &Database, id: &str) -> Result<ThemesItem, KernelError> {
    db.conn()
        .query_row(
            "SELECT id, name, version, active, manifest_json, css_asset_id, \
                    trust_state, publisher_key_id, installed_at, updated_at \
             FROM themes WHERE id = ?1",
            rusqlite::params![id],
            theme_row,
        )
        .optional()
        .map_err(|err| sqlite(err, "themes: row lookup"))?
        .ok_or_else(|| theme_not_found(id))
}

/// Settings-table key for one theme's persisted values (the legacy
/// `repos.settings` spelling, reused verbatim).
fn theme_settings_key(theme_id: &str) -> String {
    format!("theme.settings.{theme_id}")
}

/// Loads the theme row's raw manifest and extracts the `settings` definitions
/// map (`{ settingId: { type, options?, default?, variable? } }`). An unknown
/// theme is `THEME_NOT_FOUND`; a corrupted stored manifest is an internal
/// storage failure (the kernel wrote that JSON) — never a silent "no
/// settings" that would fabricate defaults for a broken package. A manifest
/// without a settings section is a theme without settings.
fn theme_setting_definitions(
    db: &Database,
    theme_id: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, KernelError> {
    let manifest_json: String = db
        .conn()
        .query_row(
            "SELECT manifest_json FROM themes WHERE id = ?1",
            rusqlite::params![theme_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "theme settings: manifest lookup"))?
        .ok_or_else(|| theme_not_found(theme_id))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("theme settings: stored manifest is not valid JSON: {err}"),
        )
    })?;
    Ok(manifest
        .get("settings")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default())
}

/// Reads the persisted settings object for one key; an absent row is an
/// empty map. The kernel writes this row itself, so a corrupted value is an
/// internal storage failure, never a silent reset.
fn read_stored_settings(
    conn: &rusqlite::Connection,
    key: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, KernelError> {
    let value_json: Option<String> = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "theme settings: read"))?;
    let Some(value_json) = value_json else {
        return Ok(serde_json::Map::new());
    };
    let value: serde_json::Value = serde_json::from_str(&value_json).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("theme settings: stored value is not valid JSON: {err}"),
        )
    })?;
    match value {
        serde_json::Value::Object(map) => Ok(map),
        _ => Err(KernelError::new(
            KernelErrorCode::Internal,
            "theme settings: stored value is not a JSON object".to_string(),
        )),
    }
}

/// String setting values must not smuggle CSS constructs: a "color" value is
/// interpolated into a custom property that feeds e.g. `background-image`, so
/// `red url(https://evil)` must not pass (THEME-45 L7 — validation is the
/// boundary; the legacy regex allowed whitespace before the paren).
fn contains_unsafe_css(value: &str) -> bool {
    let lower = value.to_lowercase();
    if lower.contains([';', '{', '}', '<', '>']) {
        return true;
    }
    let function_marker = ["url", "expression"].iter().any(|name| {
        let mut from = 0;
        while let Some(at) = lower[from..].find(name) {
            let after = from + at + name.len();
            if lower[after..].trim_start().starts_with('(') {
                return true;
            }
            from = after;
        }
        false
    });
    function_marker || lower.contains("javascript:")
}

/// Ports the legacy per-definition value validation (THEME-45): a color is a
/// short string without CSS constructs, booleans and finite numbers pass, a
/// select must be one of the declared options; an unknown definition type
/// fails closed.
fn is_setting_value_valid(definition: &serde_json::Value, value: &serde_json::Value) -> bool {
    let Some(definition_type) = definition.get("type").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match definition_type {
        "color" => value
            .as_str()
            .is_some_and(|text| text.len() <= 100 && !contains_unsafe_css(text)),
        "boolean" => value.is_boolean(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "select" => value.as_str().is_some_and(|text| {
            definition
                .get("options")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|options| options.iter().any(|option| option.as_str() == Some(text)))
        }),
        _ => false,
    }
}

/// Manifest-merged values view: every declared setting resolves to its
/// persisted value when that value still validates, else the manifest
/// default (or null). Undeclared stored keys are never surfaced.
fn merged_theme_values(
    definitions: &serde_json::Map<String, serde_json::Value>,
    stored: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    let mut values = serde_json::Map::new();
    for (setting_id, definition) in definitions {
        let resolved = match stored.get(setting_id) {
            Some(value) if is_setting_value_valid(definition, value) => value.clone(),
            _ => definition
                .get("default")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        };
        values.insert(setting_id.clone(), resolved);
    }
    serde_json::Value::Object(values)
}

fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StorageFailure, format!("{context}: {err}"))
}

fn serialize_error(err: serde_json::Error) -> KernelError {
    KernelError::new(
        KernelErrorCode::Internal,
        format!("themes: serialization failed: {err}"),
    )
}

/// Stable `THEME_NOT_FOUND` product error (`themeId` param).
fn theme_not_found(id: &str) -> KernelError {
    KernelError::product(
        "THEME_NOT_FOUND".to_string(),
        vec![("themeId".to_string(), id.to_string())],
    )
}

/// Stable `VALIDATION` product error for a setting that is unknown to the
/// theme manifest or fails its declared type validation (`path` param
/// mirrors the legacy envelope; the raw value is intentionally NOT echoed
/// back — it may itself carry the refused CSS payload).
fn invalid_setting(path: &str) -> KernelError {
    KernelError::product(
        "VALIDATION".to_string(),
        vec![
            ("path".to_string(), path.to_string()),
            (
                "reason".to_string(),
                "invalid theme setting value".to_string(),
            ),
        ],
    )
}

/// Stable `THEME_TRUST_DOWNGRADE` product error: installing a lower-trust
/// package over an existing version is forbidden without uninstalling first
/// (SEC-05 — an unsigned package can never silently replace a verified one).
fn trust_downgrade(id: &str, existing_version: &str) -> KernelError {
    KernelError::product(
        "THEME_TRUST_DOWNGRADE".to_string(),
        vec![
            ("themeId".to_string(), id.to_string()),
            ("existingVersion".to_string(), existing_version.to_string()),
        ],
    )
}

fn encode_list(dto: &ResultThemesList) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_themes_list)
}

fn encode_install(dto: &ResultThemesInstall) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_themes_install)
}

fn encode_theme(dto: &ThemesItem) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_themes_item)
}

fn encode_settings(dto: &ResultThemesSettings) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_themes_settings)
}

fn encode_empty(dto: &generated::ResultEmpty) -> Result<Vec<u8>, KernelError> {
    encode_checked(dto, generated::validate_result_empty)
}

fn encode_checked<T: serde::Serialize>(
    dto: &T,
    validate: fn(&serde_json::Value) -> Result<(), Vec<contracts_generated::Issue>>,
) -> Result<Vec<u8>, KernelError> {
    let value = serde_json::to_value(dto).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("themes: response serialization failed: {err}"),
        )
    })?;
    validate(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel themes dto failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    crate::product::encode(&value)
}
