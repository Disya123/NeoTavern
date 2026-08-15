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
//! - `themes.uninstall` — durable row removal; uninstalling the ACTIVE
//!   theme clears the flag so the shell falls back to the default
//!   (AGENTS.md §19: a broken theme must never block the interface reset).
//! - `themes.list` — the full registry snapshot.

use contracts_generated::generated::{
    self, RequestThemesActivate, RequestThemesInstall, RequestThemesUninstall, ResultThemesInstall,
    ResultThemesList, ThemesItem,
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
