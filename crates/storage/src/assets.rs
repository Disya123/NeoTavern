//! Immutable asset publishing, resolution, orphan GC, and deletion (ТЗ §25).
//!
//! Assets are immutable byte blobs stored under `<root>/assets/` and
//! registered in the STRICT `__neotavern_assets` table (part of the migration
//! ledger schema). Every path is derived from a *managed relative key*
//! validated by [`validate_relative_key`] and [`join_checked`]; symlink
//! escapes are rejected by [`resolve_asset_path`].
//!
//! Publish is crash-safe: content is written to a hidden temp file
//! (`.tmp-<id>-<counter>`) inside the assets directory itself (so the rename
//! never crosses filesystems), `sync_all`ed, size-verified, then atomically
//! renamed into place, and only afterwards is the registry row inserted with
//! the same transaction discipline as every other write. If the INSERT fails
//! after the rename, the published file is removed best-effort so the orphan
//! GC can never be tricked into keeping an unregistered blob.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use crate::error::Result;
use crate::error::{io_err, StorageError, StorageErrorCode};
use crate::now_utc_rfc3339;
use crate::open::Database;
use crate::paths::{assets_dir, join_checked, validate_relative_key};

/// Maximum directory nesting depth of the orphan walk; anything deeper is
/// left untouched.
const GC_MAX_DEPTH: usize = 8;

const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// A row of the asset registry (`__neotavern_assets`).
///
/// Serde-serializable so the registry can be exported, compared, or embedded
/// in diagnostics (snapshot/recovery tooling).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AssetRecord {
    /// Immutable asset identifier (registry primary key).
    pub id: String,
    /// Asset kind: `1..=64` chars matching `[a-z][a-z0-9.-]*`.
    pub kind: String,
    /// Managed relative key under the assets directory.
    pub relative_key: String,
    /// Lowercase hex SHA-256 of the content bytes.
    pub checksum_sha256: String,
    /// Content length in bytes.
    pub size_bytes: i64,
    /// Opaque application metadata JSON (`"{}"` when not set).
    pub metadata_json: String,
    /// RFC 3339 UTC creation timestamp (seconds precision).
    pub created_at: String,
}

/// Lowercase hex encoding of the SHA-256 digest of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(HEX_DIGITS[(b >> 4) as usize] as char);
        out.push(HEX_DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

/// Publish an immutable asset (ТЗ §25).
///
/// `id` becomes the registry primary key, `kind` must be `1..=64` chars
/// matching `[a-z][a-z0-9.-]*`, and `relative_key` must pass
/// [`validate_relative_key`]. `content` is written to a hidden temp file
/// (`.tmp-<id>-<counter>`) in the assets directory (same filesystem),
/// `sync_all`ed, size-verified, and atomically renamed to
/// `join_checked(assets_dir, key)` after parent directories are created; only
/// then is the row INSERTed inside [`Database::transaction`]. The registered
/// checksum is the SHA-256 computed here over `content` (never re-read from
/// the file).
///
/// If the INSERT fails after the rename (e.g. duplicate `id` or
/// `relative_key`), the published file is removed best-effort — the orphan
/// GC safety net — and the original DB error is returned.
pub fn publish_asset(
    db: &mut Database,
    id: &str,
    kind: &str,
    relative_key: &str,
    content: &[u8],
) -> Result<AssetRecord> {
    validate_relative_key(relative_key)?;
    validate_kind(kind)?;

    let assets = assets_dir(db.root());
    fs::create_dir_all(&assets).map_err(|e| io_err(e, "create assets dir"))?;
    let target = join_checked(&assets, relative_key)?;

    let (temp_path, mut temp_file) = create_temp_file(&assets, id)?;
    if let Err(e) = write_verified(&mut temp_file, content) {
        let _ = fs::remove_file(&temp_path);
        return Err(io_err(e, "write temp asset file"));
    }
    drop(temp_file);

    let checksum = sha256_hex(content);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(e, "create asset parent dirs"))?;
    }
    if let Err(e) = fs::rename(&temp_path, &target) {
        let _ = fs::remove_file(&temp_path);
        return Err(rename_error(e, db, id, relative_key));
    }

    let created_at = now_utc_rfc3339();
    let inserted = db.transaction(|tx| {
        tx.execute(
            "INSERT INTO __neotavern_assets \
             (id, type, relative_key, checksum_sha256, size_bytes, metadata_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6)",
            rusqlite::params![
                id,
                kind,
                relative_key,
                checksum,
                content.len() as i64,
                created_at
            ],
        )
        .map_err(|e| sqlite_error(e, "insert asset row"))?;
        Ok(())
    });
    if let Err(e) = inserted {
        let _ = fs::remove_file(&target);
        return Err(e);
    }

    Ok(AssetRecord {
        id: id.to_string(),
        kind: kind.to_string(),
        relative_key: relative_key.to_string(),
        checksum_sha256: checksum,
        size_bytes: content.len() as i64,
        metadata_json: "{}".to_string(),
        created_at,
    })
}

/// Resolve a managed relative key to its absolute on-disk path, symlink-safe.
///
/// Re-validates the key and re-runs [`join_checked`], then canonicalizes the
/// parent directory: the canonical parent must stay inside the canonical
/// assets directory (a symlinked intermediate component would move it
/// elsewhere), and the final component must not itself be a symlink. Any
/// violation — including an unresolvable parent or missing file — is reported
/// as [`StorageErrorCode::InvalidAssetKey`]. The returned path is the
/// canonical parent joined with the (non-symlink) final component.
pub fn resolve_asset_path(db: &Database, relative_key: &str) -> Result<PathBuf> {
    validate_relative_key(relative_key)?;
    let assets = assets_dir(db.root());
    let joined = join_checked(&assets, relative_key)?;

    let canonical_assets = fs::canonicalize(&assets)
        .map_err(|e| invalid_key(relative_key, &format!("cannot resolve assets dir: {e}")))?;
    let parent = joined
        .parent()
        .ok_or_else(|| invalid_key(relative_key, "asset key has no parent directory"))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|e| invalid_key(relative_key, &format!("cannot resolve asset parent: {e}")))?;
    if !canonical_parent.starts_with(&canonical_assets) {
        return Err(invalid_key(
            relative_key,
            "asset parent escapes the assets dir",
        ));
    }

    let meta = fs::symlink_metadata(&joined)
        .map_err(|e| invalid_key(relative_key, &format!("cannot stat asset: {e}")))?;
    if meta.file_type().is_symlink() {
        return Err(invalid_key(
            relative_key,
            "asset final component is a symlink",
        ));
    }

    let file_name = joined
        .file_name()
        .ok_or_else(|| invalid_key(relative_key, "asset key has no file name"))?;
    Ok(canonical_parent.join(file_name))
}

/// Result of an orphan GC pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GcReport {
    /// Relative keys of files deleted by this pass (unreferenced and past
    /// the grace period).
    pub removed: Vec<String>,
    /// Relative keys that are referenced by the registry but missing on
    /// disk — integrity-violation evidence, never auto-fixed.
    pub missing: Vec<String>,
}

/// Remove orphaned files under the assets directory.
///
/// Walks `assets_dir` recursively (max depth [`GC_MAX_DEPTH`], skipping names
/// that start with `.`) and deletes any file that is NOT referenced by
/// `__neotavern_assets` and whose mtime is older than `grace_period`. Files
/// that ARE referenced but absent on disk are collected in
/// [`GcReport::missing`] instead of being auto-fixed. A missing assets
/// directory is treated as an empty one (nothing to GC; referenced keys are
/// then reported missing).
pub fn gc_orphans(db: &Database, grace_period: Duration) -> Result<GcReport> {
    let assets = assets_dir(db.root());
    let referenced = referenced_keys(db)?;

    let mut removed = Vec::new();
    match fs::metadata(&assets) {
        Ok(_) => walk_assets(&assets, &assets, 0, &referenced, grace_period, &mut removed)?,
        Err(e) if e.kind() == ErrorKind::NotFound => {} // no assets dir yet: nothing to GC
        Err(e) => return Err(io_err(e, "stat assets dir")),
    }

    let mut missing = Vec::new();
    for key in &referenced {
        if !asset_exists(db, &assets, key) {
            missing.push(key.to_string());
        }
    }

    Ok(GcReport { removed, missing })
}

/// Delete an asset (ТЗ §25).
///
/// The registry row is deleted first inside [`Database::transaction`]; only
/// then is the file removed, best-effort — a removal failure is not reported
/// because the orphan GC eventually reclaims the leftover file (delayed-GC
/// safety net). Returns [`StorageErrorCode::AssetNotFound`] when `id` is not
/// registered.
pub fn delete_asset(db: &mut Database, id: &str) -> Result<()> {
    let relative_key = db.transaction(|tx| {
        let key: Option<String> = tx
            .query_row(
                "SELECT relative_key FROM __neotavern_assets WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| sqlite_error(e, "look up asset row"))?;
        let key = key.ok_or_else(|| {
            StorageError::with(
                StorageErrorCode::AssetNotFound,
                format!("no asset with id {id:?}"),
                vec![("id".to_string(), id.to_string())],
            )
        })?;
        tx.execute(
            "DELETE FROM __neotavern_assets WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| sqlite_error(e, "delete asset row"))?;
        Ok(key)
    })?;

    // Best-effort file removal; the orphan GC covers failures.
    let assets = assets_dir(db.root());
    if let Ok(path) = join_checked(&assets, &relative_key) {
        let _ = fs::remove_file(&path);
    }
    Ok(())
}

// --- private helpers ------------------------------------------------------

/// Validate `kind`: `1..=64` chars matching `[a-z][a-z0-9.-]*`.
fn validate_kind(kind: &str) -> Result<()> {
    let bytes = kind.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return Err(StorageError::with(
            StorageErrorCode::InvalidAssetKey,
            format!("asset kind must be 1..=64 chars, got {}", bytes.len()),
            vec![
                ("kind".to_string(), kind.to_string()),
                ("rule".to_string(), "kind_length".to_string()),
            ],
        ));
    }
    if !bytes[0].is_ascii_lowercase() {
        return Err(StorageError::with(
            StorageErrorCode::InvalidAssetKey,
            format!("asset kind {kind:?} must start with a lowercase letter"),
            vec![
                ("kind".to_string(), kind.to_string()),
                ("rule".to_string(), "kind_first_char".to_string()),
            ],
        ));
    }
    for &b in &bytes[1..] {
        if !(b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-') {
            return Err(StorageError::with(
                StorageErrorCode::InvalidAssetKey,
                format!("asset kind {kind:?} contains invalid char {b:?}"),
                vec![
                    ("kind".to_string(), kind.to_string()),
                    ("rule".to_string(), "kind_charset".to_string()),
                ],
            ));
        }
    }
    Ok(())
}

/// Create `.tmp-<id>-<counter>` in the assets dir with `create_new`, so
/// concurrent publishes never collide. Returns the path and the open file.
fn create_temp_file(assets: &Path, id: &str) -> Result<(PathBuf, fs::File)> {
    let mut counter: u64 = 0;
    loop {
        let candidate = assets.join(format!(".tmp-{id}-{counter}"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => counter += 1,
            Err(e) => return Err(io_err(e, "create temp asset file")),
        }
    }
}

/// Write all content, `sync_all`, and verify the on-disk size matches.
fn write_verified(file: &mut fs::File, content: &[u8]) -> std::io::Result<()> {
    file.write_all(content)?;
    file.sync_all()?;
    let written = file.metadata()?.len();
    if written != content.len() as u64 {
        return Err(std::io::Error::other(format!(
            "temp asset size mismatch: wrote {written}, expected {}",
            content.len()
        )));
    }
    Ok(())
}

/// Error path for a failed rename. On Windows a rename onto an existing
/// destination fails; when the destination is already registered (same `id`
/// or `relative_key`) the real answer is a duplicate-key
/// [`StorageErrorCode::Conflict`], so that is reported. Otherwise the
/// failure is a plain IO error.
fn rename_error(e: std::io::Error, db: &Database, id: &str, relative_key: &str) -> StorageError {
    if e.kind() == ErrorKind::AlreadyExists {
        let registered = db
            .conn()
            .query_row(
                "SELECT 1 FROM __neotavern_assets WHERE id = ?1 OR relative_key = ?2 LIMIT 1",
                rusqlite::params![id, relative_key],
                |_| Ok(()),
            )
            .optional();
        if matches!(registered, Ok(Some(()))) {
            return StorageError::with(
                StorageErrorCode::Conflict,
                "asset id or relative_key already registered",
                vec![
                    ("id".to_string(), id.to_string()),
                    ("relative_key".to_string(), relative_key.to_string()),
                ],
            );
        }
    }
    io_err(e, "rename temp asset into place")
}

/// Build a [`StorageErrorCode::InvalidAssetKey`] error for `key`.
fn invalid_key(key: &str, why: &str) -> StorageError {
    StorageError::with(
        StorageErrorCode::InvalidAssetKey,
        format!("invalid asset key {key:?}: {why}"),
        vec![
            ("relative_key".to_string(), key.to_string()),
            ("rule".to_string(), why.to_string()),
        ],
    )
}

/// Convert a rusqlite error: constraint violations are duplicates →
/// [`StorageErrorCode::Conflict`]; everything else is classified by
/// [`StorageError::from_sqlite`].
fn sqlite_error(err: rusqlite::Error, context: &str) -> StorageError {
    if let rusqlite::Error::SqliteFailure(ffi_err, _) = &err {
        if ffi_err.code == rusqlite::ErrorCode::ConstraintViolation {
            return StorageError::with(
                StorageErrorCode::Conflict,
                format!("{context}: constraint violation"),
                vec![(
                    "sqlite_code".to_string(),
                    format!("{}", ffi_err.extended_code),
                )],
            );
        }
    }
    StorageError::from_sqlite(err, context)
}

/// All `relative_key`s currently registered in `__neotavern_assets`.
fn referenced_keys(db: &Database) -> Result<HashSet<String>> {
    let mut set = HashSet::new();
    let mut stmt = db
        .conn()
        .prepare("SELECT relative_key FROM __neotavern_assets")
        .map_err(|e| sqlite_error(e, "prepare asset registry read"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| sqlite_error(e, "read asset registry"))?;
    for row in rows {
        let key = row.map_err(|e| sqlite_error(e, "read asset registry row"))?;
        set.insert(key);
    }
    Ok(set)
}

/// Recursive orphan walk: max depth [`GC_MAX_DEPTH`], skipping names that
/// start with `.`. Unreferenced files older than `grace_period` are deleted
/// and their relative keys appended to `removed`.
fn walk_assets(
    assets: &Path,
    dir: &Path,
    depth: usize,
    referenced: &HashSet<String>,
    grace_period: Duration,
    removed: &mut Vec<String>,
) -> Result<()> {
    if depth >= GC_MAX_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| io_err(e, "walk assets dir"))?;
    for entry in entries {
        let entry = entry.map_err(|e| io_err(e, "read assets dir entry"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| io_err(e, "stat assets dir entry"))?;
        if file_type.is_dir() {
            walk_assets(assets, &path, depth + 1, referenced, grace_period, removed)?;
        } else if file_type.is_file() {
            let key = relative_key_of(assets, &path);
            if referenced.contains(&key) {
                continue;
            }
            let meta = fs::metadata(&path).map_err(|e| io_err(e, "stat asset file"))?;
            let modified = meta.modified().map_err(|e| io_err(e, "asset file mtime"))?;
            let age = match modified.elapsed() {
                Ok(age) => age,
                // mtime in the future (clock skew): not old enough.
                Err(_) => continue,
            };
            if age >= grace_period {
                fs::remove_file(&path).map_err(|e| io_err(e, "remove orphan asset"))?;
                removed.push(key);
            }
        }
    }
    Ok(())
}

/// Relative key of `path` under `assets`, always `/`-separated.
fn relative_key_of(assets: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(assets).unwrap_or(path);
    let mut key = String::new();
    for (i, comp) in rel.components().enumerate() {
        if i > 0 {
            key.push('/');
        }
        key.push_str(&comp.as_os_str().to_string_lossy());
    }
    key
}

/// Does the registered key have a real file on disk (symlink-safe)?
///
/// A key whose file exists only through an escaped symlink is NOT reported
/// missing here — resolution failures fall back to a plain existence probe.
fn asset_exists(db: &Database, assets: &Path, key: &str) -> bool {
    match resolve_asset_path(db, key) {
        Ok(path) => fs::symlink_metadata(&path).is_ok(),
        Err(_) => match join_checked(assets, key) {
            Ok(path) => fs::symlink_metadata(&path).is_ok(),
            Err(_) => false,
        },
    }
}
