//! Public backup containers (ТЗ §40–§42, Фаза 11).
//!
//! A backup container captures the entire data root at a consistent point in
//! time: `<root>/backups/<id>.neotavern-backup/` holds
//!
//! - `manifest.json` — written LAST (finalization, atomic temp+rename);
//! - `checksums.json` — the inventory `[{logicalPath, type, size, sha256}]`
//!   sorted by `logicalPath`, always including `database.sqlite`;
//! - `database.sqlite` — a verified Online-Backup snapshot of the live
//!   database ([`snapshot::create_snapshot`]);
//! - `assets/<key>` — exactly the asset set referenced by the snapshot's
//!   `__neotavern_assets` at snapshot time (content is immutable).
//!
//! [`create_backup`] runs the six-step flow of ТЗ §41 (snapshot → pin the
//! asset set → provisional container dir → verified copies → checksums.json →
//! manifest.json last → atomic rename to the final name) with the quota check
//! performed BEFORE any work. [`verify_backup`] re-validates a container
//! (bounded manifest, inventory grammar/existence/checksums, database
//! integrity, total-size guard). [`list_backups`] scans completed containers
//! and garbage-collects stale provisional directories. [`restore_backup`]
//! stages a verified container into a candidate and activates it through the
//! kill-safe machinery in [`crate::restore`] (ТЗ §42).

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::assets::sha256_hex;
use crate::baseline::ConnectionPolicy;
use crate::error::{io_err, Result, StorageError, StorageErrorCode};
use crate::migrations::MigrationProgress;
use crate::open::{open, Database};
use crate::paths::{assets_dir, backups_dir, join_checked, validate_relative_key};
use crate::restore::{activate, finalize_candidate, stage_candidate, Candidate};
use crate::snapshot::{create_snapshot, sha256_file_hex, SnapshotInfo};
use crate::{APPLICATION_ID, CURRENT_SCHEMA, MIN_DIRECT_SCHEMA, STORAGE_FORMAT};

/// Maximum number of completed backups retained per data root (ТЗ §41 quota).
pub const MAX_BACKUPS: usize = 16;

/// Maximum total inventory size of one backup container (1 GiB): the
/// compression-bomb / oversize guard of ТЗ §41 (assets are stored
/// uncompressed, so a ratio attack is moot — the size cap still applies).
pub const MAX_BACKUP_BYTES: i64 = 1_073_741_824;

/// The manifest `format` value identifying a NeoTavern backup container.
pub const BACKUP_FORMAT: &str = "neotavern-backup";

/// Suffix of a completed backup container directory:
/// `<id>.neotavern-backup`.
pub const BACKUP_DIR_SUFFIX: &str = ".neotavern-backup";

/// Marker separating a provisional container name from its sequence number:
/// `<id>.neotavern-backup.tmp-<seq>`.
const TMP_MARKER: &str = ".tmp-";

/// Age after which a provisional (tmp) container directory is garbage
/// collected by [`list_backups`].
const TMP_GRACE_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Upper bound (inclusive) for reading `manifest.json` / `checksums.json`
/// (ТЗ §41: bounded manifest parse).
const MANIFEST_MAX_BYTES: usize = 1024 * 1024;

/// Process-unique sequence number for provisional container directory names.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Metadata describing a stored backup container.
///
/// `size_bytes` is the sum of the inventory sizes and `checksum_sha256` is
/// the SHA-256 of the `checksums.json` bytes — both reproducible from the
/// container alone by [`list_backups`] without re-hashing every file.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupRecord {
    /// The backup id (also the container directory name stem).
    pub id: String,
    /// RFC 3339 UTC timestamp recorded when the backup was created.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// Container format version (1 in this build).
    #[serde(rename = "formatVersion")]
    pub format_version: i64,
    /// Sum of the inventory sizes (database + assets), in bytes.
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    /// Lowercase hex SHA-256 of the `checksums.json` bytes.
    #[serde(rename = "checksumSha256")]
    pub checksum_sha256: String,
    /// Lifecycle status; completed containers are always `"completed"`.
    pub status: String,
}

/// Verified metadata of a backup container ([`verify_backup`] result).
#[derive(Debug, Clone)]
pub struct VerifiedBackup {
    /// The backup id (container directory name stem).
    pub id: String,
    /// RFC 3339 UTC creation timestamp from the manifest.
    pub created_at: String,
    /// Container format version (1 in this build).
    pub format_version: i64,
    /// Sum of the inventory sizes, in bytes (≤ [`MAX_BACKUP_BYTES`]).
    pub size_bytes: i64,
    /// Lowercase hex SHA-256 of the `checksums.json` bytes.
    pub checksum_sha256: String,
    /// Storage format recorded in the manifest (must equal [`STORAGE_FORMAT`]).
    pub storage_format: i64,
    /// Schema revision of the container database, in
    /// `MIN_DIRECT_SCHEMA..=CURRENT_SCHEMA` and matching the manifest.
    pub schema_revision: i64,
}

/// One row of the pinned asset set read from the snapshot's
/// `__neotavern_assets` at snapshot time (ТЗ §41 step 2).
struct AssetPin {
    relative_key: String,
    checksum_sha256: String,
    size_bytes: i64,
}

/// One inventory entry of `checksums.json` (also the manifest's trusted
/// record of what the container must contain).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct InventoryEntry {
    /// `database.sqlite` or `assets/<managed-key>`.
    #[serde(rename = "logicalPath")]
    logical_path: String,
    /// `database` for the database entry, `asset` for assets.
    #[serde(rename = "type")]
    kind: String,
    /// Content length in bytes.
    size: i64,
    /// Lowercase hex SHA-256 of the content bytes.
    sha256: String,
}

/// The container facts computed while building a provisional container.
struct BuiltContainer {
    size_bytes: i64,
    checksum_sha256: String,
}

/// Creates a backup container of the live data root (ТЗ §41 six-step flow).
///
/// 1. Quota check BEFORE any work: completed containers (`list_backups`) at
///    [`MAX_BACKUPS`] → [`StorageErrorCode::QuotaExceeded`] (no silent
///    deletion of user backups).
/// 2. [`snapshot::create_snapshot`] — a consistent, quick_check-verified copy
///    of the live database.
/// 3. The pinned immutable asset set referenced by the snapshot's
///    `__neotavern_assets`.
/// 4. A provisional container dir `<backups>/<id>.neotavern-backup.tmp-<seq>`
///    is filled: the snapshot bytes are copied to `database.sqlite` and each
///    referenced asset is copied from the live root's assets dir, verifying
///    size + sha256 after every copy. A missing referenced asset aborts the
///    whole create (provisional dir deleted) with
///    [`StorageErrorCode::IntegrityViolation`].
/// 5. `checksums.json` (sorted by `logicalPath`) then `manifest.json` last
///    (atomic temp+rename inside the provisional dir).
/// 6. The provisional dir is renamed to the final `<id>.neotavern-backup`
///    and the [`BackupRecord`] is returned.
///
/// `id` must pass the managed-key grammar ([`validate_relative_key`]) so the
/// container directory name can never escape the backups directory.
pub fn create_backup(db: &mut Database, id: &str) -> Result<BackupRecord> {
    validate_relative_key(id).map_err(|_| {
        StorageError::with(
            StorageErrorCode::InvalidAssetKey,
            "backup id failed the managed-key grammar",
            vec![("id".to_string(), id.to_string())],
        )
    })?;

    // 1. Quota check BEFORE any work.
    let existing = list_backups(db.root())?;
    if existing.len() >= MAX_BACKUPS {
        return Err(StorageError::with(
            StorageErrorCode::QuotaExceeded,
            "backup quota reached; no silent deletion of existing backups",
            vec![
                ("limit".to_string(), MAX_BACKUPS.to_string()),
                ("existing".to_string(), existing.len().to_string()),
            ],
        ));
    }

    // 2. Consistent snapshot (quick_check + user_version verified inside).
    let snapshot = create_snapshot(db)?;

    // 3. The pinned immutable asset set referenced by the snapshot.
    let pins = read_snapshot_asset_pins(&snapshot)?;

    // 4+5. Fill a provisional container dir, checksums.json first,
    // manifest.json last (both atomic).
    let backups = backups_dir(db.root());
    fs::create_dir_all(&backups).map_err(|e| io_err(e, "create backups directory"))?;
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_dir = backups.join(format!("{id}{BACKUP_DIR_SUFFIX}{TMP_MARKER}{seq}"));
    let final_dir = backups.join(format!("{id}{BACKUP_DIR_SUFFIX}"));
    let built = match build_container(&assets_dir(db.root()), &snapshot, &pins, &tmp_dir) {
        Ok(built) => built,
        Err(err) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(err);
        }
    };

    // 6. Publish: rename the provisional dir to the final name.
    fs::rename(&tmp_dir, &final_dir).map_err(|e| {
        let _ = fs::remove_dir_all(&tmp_dir);
        io_err(e, "finalize backup container")
    })?;

    Ok(BackupRecord {
        id: id.to_string(),
        created_at: snapshot.created_at,
        format_version: 1,
        size_bytes: built.size_bytes,
        checksum_sha256: built.checksum_sha256,
        status: "completed".to_string(),
    })
}

/// Re-verifies a stored backup container (ТЗ §41): bounded manifest parse,
/// `format`/`formatVersion` checks, inventory grammar + allowlist, every
/// entry exists with matching size and sha256, database deep-checks, and the
/// total-size guard. Nothing is written; a failure classifies the container
/// as corrupt or unsupported.
pub fn verify_backup(container: &Path) -> Result<VerifiedBackup> {
    let name = container
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| StorageError::new(StorageErrorCode::Io, "container path has no name"))?;
    let id = name
        .strip_suffix(BACKUP_DIR_SUFFIX)
        .unwrap_or(name)
        .to_string();

    // Bounded manifest parse; format/formatVersion checks.
    let manifest_bytes = read_bounded(
        &container.join("manifest.json"),
        MANIFEST_MAX_BYTES,
        "backup manifest",
    )?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|e| {
        StorageError::new(StorageErrorCode::Corrupt, format!("bad manifest.json: {e}"))
    })?;
    let format = manifest
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or_else(|| StorageError::new(StorageErrorCode::Corrupt, "manifest missing format"))?;
    if format != BACKUP_FORMAT {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "manifest format is not a NeoTavern backup",
            vec![("found".to_string(), format.to_string())],
        ));
    }
    let format_version = match manifest.get("formatVersion").and_then(|v| v.as_i64()) {
        Some(1) => 1,
        Some(other) => {
            // Unknown REQUIRED section of a future format → controlled
            // Incompatible-class error (this build cannot interpret it).
            return Err(StorageError::with(
                StorageErrorCode::UnsupportedStorageFormat,
                "backup format version is not supported by this build",
                vec![("format_version".to_string(), other.to_string())],
            ));
        }
        None => {
            return Err(StorageError::new(
                StorageErrorCode::Corrupt,
                "manifest missing formatVersion",
            ));
        }
    };
    let created_at = manifest
        .get("createdAt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| StorageError::new(StorageErrorCode::Corrupt, "manifest missing createdAt"))?
        .to_string();
    let storage_format = manifest
        .pointer("/storage/storageFormat")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            StorageError::new(
                StorageErrorCode::Corrupt,
                "manifest missing storage.storageFormat",
            )
        })?;
    if storage_format != STORAGE_FORMAT {
        return Err(StorageError::with(
            StorageErrorCode::UnsupportedStorageFormat,
            "backup storage format is not supported by this build",
            vec![
                ("storage_format".to_string(), storage_format.to_string()),
                ("supported".to_string(), STORAGE_FORMAT.to_string()),
            ],
        ));
    }
    let schema_revision = manifest
        .pointer("/storage/schemaRevision")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            StorageError::new(
                StorageErrorCode::Corrupt,
                "manifest missing storage.schemaRevision",
            )
        })?;

    // Bounded inventory parse + grammar/allowlist/total-size checks.
    let checksums_bytes = read_bounded(
        &container.join("checksums.json"),
        MANIFEST_MAX_BYTES,
        "backup checksums",
    )?;
    let checksum_sha256 = sha256_hex(&checksums_bytes);
    let inventory: Vec<InventoryEntry> = serde_json::from_slice(&checksums_bytes).map_err(|e| {
        StorageError::new(
            StorageErrorCode::Corrupt,
            format!("bad checksums.json: {e}"),
        )
    })?;
    if inventory.is_empty() {
        return Err(StorageError::new(
            StorageErrorCode::Corrupt,
            "backup inventory is empty",
        ));
    }
    let mut db_entries = 0usize;
    let mut total: i64 = 0;
    for entry in &inventory {
        if entry.size < 0 {
            return Err(StorageError::with(
                StorageErrorCode::Corrupt,
                "inventory entry has a negative size",
                vec![("logicalPath".to_string(), entry.logical_path.clone())],
            ));
        }
        validate_logical_path(&entry.logical_path)?;
        if entry.logical_path == "database.sqlite" {
            db_entries += 1;
        }
        total = total.checked_add(entry.size).ok_or_else(|| {
            StorageError::new(StorageErrorCode::Corrupt, "inventory size overflow")
        })?;
    }
    if db_entries == 0 {
        return Err(StorageError::new(
            StorageErrorCode::Corrupt,
            "inventory has no database.sqlite entry",
        ));
    }
    if total > MAX_BACKUP_BYTES {
        return Err(StorageError::with(
            StorageErrorCode::QuotaExceeded,
            "backup exceeds the maximum container size",
            vec![
                ("declared".to_string(), total.to_string()),
                ("limit".to_string(), MAX_BACKUP_BYTES.to_string()),
            ],
        ));
    }

    // Every inventory entry must exist with matching size and sha256.
    for entry in &inventory {
        let path = join_checked(container, &entry.logical_path).map_err(|_| {
            StorageError::with(
                StorageErrorCode::Corrupt,
                "inventory logicalPath escapes the container",
                vec![("logicalPath".to_string(), entry.logical_path.clone())],
            )
        })?;
        let meta = fs::metadata(&path).map_err(|e| {
            StorageError::with(
                StorageErrorCode::Corrupt,
                format!("inventory entry missing: {}", entry.logical_path),
                vec![
                    ("logicalPath".to_string(), entry.logical_path.clone()),
                    ("io".to_string(), e.to_string()),
                ],
            )
        })?;
        if meta.len() != entry.size as u64 {
            return Err(StorageError::with(
                StorageErrorCode::Corrupt,
                "inventory entry size mismatch",
                vec![
                    ("logicalPath".to_string(), entry.logical_path.clone()),
                    ("declared".to_string(), entry.size.to_string()),
                    ("found".to_string(), meta.len().to_string()),
                ],
            ));
        }
        let actual = sha256_file_hex(&path)?;
        if actual != entry.sha256 {
            return Err(StorageError::with(
                StorageErrorCode::Corrupt,
                "inventory entry checksum mismatch",
                vec![
                    ("logicalPath".to_string(), entry.logical_path.clone()),
                    ("declared".to_string(), entry.sha256.clone()),
                    ("found".to_string(), actual),
                ],
            ));
        }
    }

    // Database deep-checks: read-only open, quick_check, application_id,
    // schema window, and cross-check against the manifest.
    let db_revision = verify_container_database(&container.join("database.sqlite"))?;
    if db_revision != schema_revision {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "container database schema revision does not match the manifest",
            vec![
                ("manifest".to_string(), schema_revision.to_string()),
                ("database".to_string(), db_revision.to_string()),
            ],
        ));
    }

    Ok(VerifiedBackup {
        id,
        created_at,
        format_version,
        size_bytes: total,
        checksum_sha256,
        storage_format,
        schema_revision,
    })
}

/// Lists completed backup containers of a data root (ТЗ §41).
///
/// Scans `<backups>/*/manifest.json`: provisional (`.tmp-`-marked)
/// directories are never listed and are removed when older than 24h;
/// directories without the `<id>.neotavern-backup` suffix are ignored. The
/// returned records are reproducible from each container alone (manifest
/// fields + the sha256 of `checksums.json` bytes + the sum of its sizes).
pub fn list_backups(root: &Path) -> Result<Vec<BackupRecord>> {
    let backups = backups_dir(root);
    let Ok(entries) = fs::read_dir(&backups) else {
        // No backups directory yet → nothing to list.
        return Ok(Vec::new());
    };
    let mut records = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| io_err(e, "read backups directory entry"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let tmp_marker = format!("{BACKUP_DIR_SUFFIX}{TMP_MARKER}");
        if name.contains(&tmp_marker) {
            // Provisional container: never listed; garbage-collect when stale.
            if matches!(tmp_dir_is_stale(&path), Ok(true)) {
                let _ = fs::remove_dir_all(&path);
            }
            continue;
        }
        if !name.ends_with(BACKUP_DIR_SUFFIX) {
            continue;
        }
        let id = name
            .strip_suffix(BACKUP_DIR_SUFFIX)
            .map(str::to_string)
            .unwrap_or_else(|| name.to_string());
        records.push(record_from_container(&path, &id)?);
    }
    Ok(records)
}

/// Restores a backup container into `root` (ТЗ §42 staged restore).
///
/// The active root is NEVER touched before activation: the container is
/// verified, staged into a candidate sibling directory, the candidate
/// database is opened read-write (migrations run inside the candidate only)
/// and must pass `PRAGMA foreign_key_check` (empty) and
/// `PRAGMA integrity_check` (`ok`), then the candidate is finalized and
/// activated atomically via [`crate::restore::activate`] (pending marker →
/// previous-root retention → swap → marker removal, kill-safe at every step).
///
/// # Requirements
///
/// The host MUST call this with the kernel CLOSED: no live
/// [`Database`] may hold the data-root lease on `root` (restore is an
/// offline operation; the swap renames the root directory).
pub fn restore_backup(container: &Path, root: &Path) -> Result<()> {
    // 1. Full verification BEFORE any staging.
    verify_backup(container)?;

    // 2. Stage a candidate sibling of the target root.
    let candidate = stage_candidate(root)?;

    // 3+4. Copy db + assets into the candidate (re-verifying checksums),
    // open the candidate (migrations inside), and run the integrity gates.
    if let Err(err) = stage_and_check_candidate(container, &candidate) {
        let _ = fs::remove_dir_all(&candidate.path);
        return Err(err);
    }

    // 5. Finalize (ready marker written last) and activate.
    finalize_candidate(&candidate)?;
    activate(root, &candidate)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Copies the snapshot and every pinned asset into the provisional container
/// dir, then writes `checksums.json` and (last) `manifest.json`.
fn build_container(
    assets_src: &Path,
    snapshot: &SnapshotInfo,
    pins: &[AssetPin],
    tmp_dir: &Path,
) -> Result<BuiltContainer> {
    fs::create_dir_all(tmp_dir).map_err(|e| io_err(e, "create provisional backup dir"))?;

    // database.sqlite — copy the snapshot bytes, verify size + sha256.
    let dst_db = tmp_dir.join("database.sqlite");
    fs::copy(&snapshot.path, &dst_db).map_err(|e| io_err(e, "copy snapshot into container"))?;
    let db_hash = verify_file_copy(&snapshot.path, &dst_db, "database.sqlite")?;
    let db_size = fs::metadata(&dst_db)
        .map_err(|e| io_err(e, "stat container database"))?
        .len() as i64;

    let mut inventory = vec![InventoryEntry {
        logical_path: "database.sqlite".to_string(),
        kind: "database".to_string(),
        size: db_size,
        sha256: db_hash,
    }];

    // assets/<key> — copy each pinned asset from the LIVE root's assets dir
    // (content immutable; verify size + sha256 after every copy).
    for pin in pins {
        let src = join_checked(assets_src, &pin.relative_key).map_err(|_| {
            StorageError::new(
                StorageErrorCode::IntegrityViolation,
                format!(
                    "referenced asset key failed validation: {}",
                    pin.relative_key
                ),
            )
        })?;
        if !src.is_file() {
            return Err(StorageError::with(
                StorageErrorCode::IntegrityViolation,
                "asset referenced by the snapshot is missing from the live root",
                vec![("relative_key".to_string(), pin.relative_key.clone())],
            ));
        }
        let dst = join_checked(&tmp_dir.join("assets"), &pin.relative_key).map_err(|_| {
            StorageError::new(
                StorageErrorCode::IntegrityViolation,
                format!(
                    "referenced asset key failed validation: {}",
                    pin.relative_key
                ),
            )
        })?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| io_err(e, "create container asset dir"))?;
        }
        fs::copy(&src, &dst).map_err(|e| io_err(e, "copy asset into container"))?;
        let meta = fs::metadata(&dst).map_err(|e| io_err(e, "stat container asset"))?;
        if meta.len() as i64 != pin.size_bytes {
            return Err(StorageError::with(
                StorageErrorCode::IntegrityViolation,
                "copied asset size does not match the registry",
                vec![
                    ("relative_key".to_string(), pin.relative_key.clone()),
                    ("declared".to_string(), pin.size_bytes.to_string()),
                    ("found".to_string(), meta.len().to_string()),
                ],
            ));
        }
        let hash = sha256_file_hex(&dst)?;
        if hash != pin.checksum_sha256 {
            return Err(StorageError::with(
                StorageErrorCode::IntegrityViolation,
                "copied asset checksum does not match the registry",
                vec![
                    ("relative_key".to_string(), pin.relative_key.clone()),
                    ("declared".to_string(), pin.checksum_sha256.clone()),
                    ("found".to_string(), hash),
                ],
            ));
        }
        inventory.push(InventoryEntry {
            logical_path: format!("assets/{}", pin.relative_key),
            kind: "asset".to_string(),
            size: pin.size_bytes,
            sha256: pin.checksum_sha256.clone(),
        });
    }

    // checksums.json (sorted by logicalPath), then manifest.json LAST.
    inventory.sort_by(|a, b| a.logical_path.cmp(&b.logical_path));
    let checksums_bytes = serde_json::to_vec(&inventory).map_err(|e| {
        StorageError::new(
            StorageErrorCode::Io,
            format!("serialize checksums.json: {e}"),
        )
    })?;
    let checksum_sha256 = sha256_hex(&checksums_bytes);
    crate::restore::write_atomic(&tmp_dir.join("checksums.json"), &checksums_bytes)?;

    let manifest = serde_json::json!({
        "format": BACKUP_FORMAT,
        "formatVersion": 1,
        "createdAt": snapshot.created_at,
        "createdBy": {
            "appVersion": env!("CARGO_PKG_VERSION"),
            "platform": "kernel",
        },
        "storage": {
            "storageFormat": STORAGE_FORMAT,
            "schemaRevision": snapshot.schema_revision,
        },
    });
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|e| {
        StorageError::new(
            StorageErrorCode::Io,
            format!("serialize manifest.json: {e}"),
        )
    })?;
    crate::restore::write_atomic(&tmp_dir.join("manifest.json"), &manifest_bytes)?;

    let size_bytes: i64 = inventory.iter().map(|e| e.size).sum();
    Ok(BuiltContainer {
        size_bytes,
        checksum_sha256,
    })
}

/// Reads the pinned asset set (`id`-agnostic columns) from the snapshot.
fn read_snapshot_asset_pins(snapshot: &SnapshotInfo) -> Result<Vec<AssetPin>> {
    let conn = Connection::open_with_flags(
        &snapshot.path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| StorageError::from_sqlite(e, "open snapshot read-only"))?;
    let mut stmt = conn
        .prepare("SELECT relative_key, checksum_sha256, size_bytes FROM __neotavern_assets")
        .map_err(|e| StorageError::from_sqlite(e, "read snapshot asset pins"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(AssetPin {
                relative_key: row.get(0)?,
                checksum_sha256: row.get(1)?,
                size_bytes: row.get(2)?,
            })
        })
        .map_err(|e| StorageError::from_sqlite(e, "query snapshot asset pins"))?;
    let mut pins = Vec::new();
    for row in rows {
        pins.push(row.map_err(|e| StorageError::from_sqlite(e, "read snapshot asset pin"))?);
    }
    Ok(pins)
}

/// Validates one inventory `logicalPath` against the managed-key grammar plus
/// the `database.sqlite | assets/` prefix allowlist (traversal rejected).
fn validate_logical_path(logical_path: &str) -> Result<()> {
    match logical_path {
        "database.sqlite" => validate_relative_key(logical_path).map_err(|_| {
            StorageError::new(StorageErrorCode::Corrupt, "invalid database logicalPath")
        }),
        path if path.starts_with("assets/") => {
            let key = &path["assets/".len()..];
            validate_relative_key(key).map_err(|_| {
                StorageError::with(
                    StorageErrorCode::Corrupt,
                    "inventory logicalPath fails the managed-key grammar",
                    vec![("logicalPath".to_string(), logical_path.to_string())],
                )
            })
        }
        other => Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "inventory entry outside the allowed prefixes",
            vec![("logicalPath".to_string(), other.to_string())],
        )),
    }
}

/// Deep-checks the container database: read-only open, `quick_check` == `"ok"`,
/// `application_id` matches, and `MIN_DIRECT_SCHEMA..=CURRENT_SCHEMA`.
/// Returns the database's `user_version`.
fn verify_container_database(path: &Path) -> Result<i64> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| StorageError::from_sqlite(e, "open container database read-only"))?;

    let quick: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "container database quick_check"))?;
    if quick != "ok" {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "container database quick_check failed",
            vec![("found".to_string(), quick)],
        ));
    }

    let app_id: i64 = conn
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "container database application_id"))?;
    if app_id != i64::from(APPLICATION_ID) {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "container database is not a NeoTavern database",
            vec![
                ("application_id".to_string(), format!("0x{app_id:08X}")),
                ("expected".to_string(), format!("0x{APPLICATION_ID:08X}")),
            ],
        ));
    }

    let revision: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "container database user_version"))?;
    if !(MIN_DIRECT_SCHEMA..=CURRENT_SCHEMA).contains(&revision) {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "container database schema revision is outside the openable window",
            vec![
                ("user_version".to_string(), revision.to_string()),
                ("min".to_string(), MIN_DIRECT_SCHEMA.to_string()),
                ("max".to_string(), CURRENT_SCHEMA.to_string()),
            ],
        ));
    }
    Ok(revision)
}

/// Builds a [`BackupRecord`] from a completed container directory.
fn record_from_container(dir: &Path, id: &str) -> Result<BackupRecord> {
    let manifest_bytes = read_bounded(
        &dir.join("manifest.json"),
        MANIFEST_MAX_BYTES,
        "backup manifest",
    )?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|e| {
        StorageError::new(StorageErrorCode::Corrupt, format!("bad manifest.json: {e}"))
    })?;
    let format = manifest
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or_else(|| StorageError::new(StorageErrorCode::Corrupt, "manifest missing format"))?;
    if format != BACKUP_FORMAT {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "manifest format is not a NeoTavern backup",
            vec![("found".to_string(), format.to_string())],
        ));
    }
    let format_version = manifest
        .get("formatVersion")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            StorageError::new(StorageErrorCode::Corrupt, "manifest missing formatVersion")
        })?;
    let created_at = manifest
        .get("createdAt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| StorageError::new(StorageErrorCode::Corrupt, "manifest missing createdAt"))?
        .to_string();

    let checksums_bytes = read_bounded(
        &dir.join("checksums.json"),
        MANIFEST_MAX_BYTES,
        "backup checksums",
    )?;
    let checksum_sha256 = sha256_hex(&checksums_bytes);
    let inventory: Vec<InventoryEntry> = serde_json::from_slice(&checksums_bytes).map_err(|e| {
        StorageError::new(
            StorageErrorCode::Corrupt,
            format!("bad checksums.json: {e}"),
        )
    })?;
    let size_bytes: i64 = inventory.iter().map(|e| e.size).sum();

    Ok(BackupRecord {
        id: id.to_string(),
        created_at,
        format_version,
        size_bytes,
        checksum_sha256,
        status: "completed".to_string(),
    })
}

/// Copies the container's inventory files into the candidate root,
/// re-verifying size + sha256 of every staged copy (ТЗ §42 step 3).
fn copy_container_into_candidate(container: &Path, candidate_root: &Path) -> Result<()> {
    let checksums_bytes = read_bounded(
        &container.join("checksums.json"),
        MANIFEST_MAX_BYTES,
        "backup checksums",
    )?;
    let inventory: Vec<InventoryEntry> = serde_json::from_slice(&checksums_bytes).map_err(|e| {
        StorageError::new(
            StorageErrorCode::Corrupt,
            format!("bad checksums.json: {e}"),
        )
    })?;
    for entry in &inventory {
        validate_logical_path(&entry.logical_path)?;
        let src = join_checked(container, &entry.logical_path).map_err(|_| {
            StorageError::new(
                StorageErrorCode::Corrupt,
                "inventory logicalPath escapes the container",
            )
        })?;
        let dst = join_checked(candidate_root, &entry.logical_path).map_err(|_| {
            StorageError::new(
                StorageErrorCode::Corrupt,
                "inventory logicalPath escapes the candidate",
            )
        })?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| io_err(e, "create candidate dir"))?;
        }
        fs::copy(&src, &dst).map_err(|e| io_err(e, "copy container file into candidate"))?;
        let meta = fs::metadata(&dst).map_err(|e| io_err(e, "stat candidate copy"))?;
        if meta.len() != entry.size as u64 {
            return Err(StorageError::with(
                StorageErrorCode::IntegrityViolation,
                "staged copy size mismatch",
                vec![
                    ("logicalPath".to_string(), entry.logical_path.clone()),
                    ("declared".to_string(), entry.size.to_string()),
                    ("found".to_string(), meta.len().to_string()),
                ],
            ));
        }
        let actual = sha256_file_hex(&dst)?;
        if actual != entry.sha256 {
            return Err(StorageError::with(
                StorageErrorCode::IntegrityViolation,
                "staged copy checksum mismatch",
                vec![
                    ("logicalPath".to_string(), entry.logical_path.clone()),
                    ("declared".to_string(), entry.sha256.clone()),
                    ("found".to_string(), actual),
                ],
            ));
        }
    }
    Ok(())
}

/// Stages the container into the candidate and runs the candidate integrity
/// gates: a writable [`open`] (migrations run inside the candidate only),
/// `PRAGMA foreign_key_check` empty, and `PRAGMA integrity_check` == `"ok"`.
/// The returned [`Database`] is dropped (releasing the candidate's
/// data-root lease) before the caller finalizes.
fn stage_and_check_candidate(container: &Path, candidate: &Candidate) -> Result<()> {
    copy_container_into_candidate(container, &candidate.path)?;

    let mut progress = |_: MigrationProgress| {};
    let db = open(&candidate.path, &ConnectionPolicy::default(), &mut progress)?;

    {
        let mut stmt = db
            .conn()
            .prepare("PRAGMA foreign_key_check")
            .map_err(|e| StorageError::from_sqlite(e, "prepare foreign_key_check"))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| StorageError::from_sqlite(e, "run foreign_key_check"))?;
        if rows
            .next()
            .map_err(|e| StorageError::from_sqlite(e, "read foreign_key_check"))?
            .is_some()
        {
            return Err(StorageError::new(
                StorageErrorCode::IntegrityViolation,
                "restored database failed the foreign-key check",
            ));
        }
    }

    let integrity: String = db
        .conn()
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "run integrity_check"))?;
    if integrity != "ok" {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "restored database failed integrity_check",
            vec![("found".to_string(), integrity)],
        ));
    }

    // Drop the Database: this releases the candidate's data-root lease, so
    // the subsequent finalize/activate rename is unencumbered.
    drop(db);
    Ok(())
}

/// True when `src` and `dst` have equal lengths and SHA-256 (a verified
/// copy). Returns the shared SHA-256.
fn verify_file_copy(src: &Path, dst: &Path, what: &str) -> Result<String> {
    let src_meta = fs::metadata(src).map_err(|e| io_err(e, "stat copy source"))?;
    let dst_meta = fs::metadata(dst).map_err(|e| io_err(e, "stat copy destination"))?;
    if src_meta.len() != dst_meta.len() {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("size mismatch after copying {what}"),
            vec![
                ("source".to_string(), src_meta.len().to_string()),
                ("copy".to_string(), dst_meta.len().to_string()),
            ],
        ));
    }
    let dst_hash = sha256_file_hex(dst)?;
    let src_hash = sha256_file_hex(src)?;
    if dst_hash != src_hash {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("checksum mismatch after copying {what}"),
            vec![
                ("source".to_string(), src_hash),
                ("copy".to_string(), dst_hash),
            ],
        ));
    }
    Ok(dst_hash)
}

/// Whether a provisional container directory is old enough to collect
/// (mtime older than [`TMP_GRACE_AGE`]; clock skew reads as fresh).
fn tmp_dir_is_stale(path: &Path) -> Result<bool> {
    let modified = fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map_err(|e| io_err(e, "read provisional backup dir mtime"))?;
    Ok(modified.elapsed().unwrap_or(Duration::ZERO) > TMP_GRACE_AGE)
}

/// Reads `path` with an inclusive `limit` byte bound; larger files are
/// rejected as [`StorageErrorCode::Corrupt`] (bounded manifest/inventory).
fn read_bounded(path: &Path, limit: usize, what: &str) -> Result<Vec<u8>> {
    let file = fs::File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            StorageError::new(
                StorageErrorCode::Corrupt,
                format!("{what} is missing from the container"),
            )
        } else {
            io_err(e, &format!("open {what}"))
        }
    })?;
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_err(e, &format!("read {what}")))?;
    if bytes.len() > limit {
        return Err(StorageError::new(
            StorageErrorCode::Corrupt,
            format!("{what} exceeds the size bound"),
        ));
    }
    Ok(bytes)
}
