//! Consistent database snapshots via the SQLite Online Backup API (ТЗ §38, Фаза 2).
//!
//! A snapshot is a self-contained copy of the live database taken through
//! [`rusqlite::backup::Backup`] (the SQLite Online Backup API) — never a raw
//! file copy of an open database — stored in `<root>/snapshots/` under a
//! content-addressed name:
//!
//! `snapshot-<rfc3339-sanitized>-<short-hash>.sqlite`
//!
//! where `<short-hash>` is the first 12 hex characters of the snapshot file's
//! SHA-256. Each snapshot is verified after creation (read-only open,
//! `PRAGMA quick_check` must return `"ok"`, and `user_version` must equal
//! [`CURRENT_SCHEMA`]) — a failed verification is classified as
//! [`StorageErrorCode::Corrupt`] and the file is deleted — and carries its
//! recorded checksum for later [`verify_snapshot`] checks.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

use crate::error::{io_err, Result, StorageError, StorageErrorCode};
use crate::open::Database;
use crate::paths::snapshots_dir;
use crate::{now_utc_rfc3339, CURRENT_SCHEMA};

/// Default number of database pages copied per online-backup step.
const BACKUP_PAGES_PER_STEP: i32 = 100;

/// Hex characters of the snapshot SHA-256 embedded in the snapshot file name.
const SHORT_HASH_CHARS: usize = 12;

/// Read buffer size used while streaming the snapshot file hash.
const HASH_BUF_SIZE: usize = 64 * 1024;

/// Process-unique sequence number for provisional (temp) snapshot file names.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Metadata describing a stored recovery snapshot.
#[derive(Debug, Clone)]
pub struct SnapshotInfo {
    /// Path of the snapshot file:
    /// `<root>/snapshots/snapshot-<rfc3339-sanitized>-<short-hash>.sqlite`.
    pub path: PathBuf,
    /// `user_version` of the snapshot (equals [`CURRENT_SCHEMA`] at creation time).
    pub schema_revision: i64,
    /// Lowercase hex SHA-256 of the snapshot file bytes.
    pub checksum_sha256: String,
    /// RFC 3339 UTC timestamp recorded when the snapshot was taken.
    pub created_at: String,
}

/// Create a consistent recovery snapshot of the live database.
///
/// Copies the database through the SQLite Online Backup API
/// ([`rusqlite::backup::Backup`], default 100 pages/step) from the live
/// connection into a temporary file in `<root>/snapshots/` (directory created
/// on demand), then verifies the result: a read-only open must pass
/// `PRAGMA quick_check` with `"ok"` and report `user_version == CURRENT_SCHEMA`
/// — otherwise the snapshot is considered corrupt and the file is deleted.
/// Finally the file bytes are SHA-256 hashed (streamed, no full-file copy) and
/// the file is renamed to its content-addressed final name.
pub fn create_snapshot(db: &Database) -> Result<SnapshotInfo> {
    let created_at = now_utc_rfc3339();
    let stamp = sanitize_rfc3339(&created_at);
    let snap_dir = snapshots_dir(db.root());
    fs::create_dir_all(&snap_dir).map_err(|e| io_err(e, "create snapshots directory"))?;

    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = snap_dir.join(format!(
        ".tmp-snapshot-{}-{}-{}.sqlite",
        stamp,
        std::process::id(),
        seq
    ));

    // 1. Online Backup API — consistent copy from the LIVE connection.
    if let Err(e) = backup_to(&tmp_path, db) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    // 2. Verify: ro open, quick_check == "ok", user_version == CURRENT_SCHEMA.
    let schema_revision = match verify_snapshot_file(&tmp_path) {
        Ok(rev) => rev,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            return Err(e);
        }
    };

    // 3. SHA-256 of the snapshot file bytes (streamed).
    let checksum_sha256 = match sha256_file_hex(&tmp_path) {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            return Err(e);
        }
    };

    // 4. Content-addressed final name, then publish.
    let short_hash: String = checksum_sha256.chars().take(SHORT_HASH_CHARS).collect();
    let final_path = snap_dir.join(format!("snapshot-{}-{}.sqlite", stamp, short_hash));
    if final_path.exists() {
        // A byte-identical snapshot from the same second already exists: keep it.
        let _ = fs::remove_file(&tmp_path);
    } else {
        fs::rename(&tmp_path, &final_path).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            io_err(e, "finalize snapshot file")
        })?;
    }

    Ok(SnapshotInfo {
        path: final_path,
        schema_revision,
        checksum_sha256,
        created_at,
    })
}

/// Re-verify a stored snapshot: read-only open, `quick_check` == `"ok"`, and
/// the file's current SHA-256 must equal the recorded
/// [`SnapshotInfo::checksum_sha256`]. Returns the snapshot's `user_version`.
pub fn verify_snapshot(info: &SnapshotInfo) -> Result<i64> {
    let revision = verify_snapshot_file(&info.path)?;
    let actual = sha256_file_hex(&info.path)?;
    if actual != info.checksum_sha256 {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "snapshot checksum does not match the recorded value",
            vec![
                ("expected".to_string(), info.checksum_sha256.clone()),
                ("found".to_string(), actual),
            ],
        ));
    }
    Ok(revision)
}

/// Run the Online Backup API from the live connection into `path`.
fn backup_to(path: &Path, db: &Database) -> Result<()> {
    let mut dst = Connection::open(path)
        .map_err(|e| StorageError::from_sqlite(e, "open snapshot destination"))?;
    let backup = Backup::new(db.conn(), &mut dst)
        .map_err(|e| StorageError::from_sqlite(e, "initialize online backup"))?;
    backup
        .run_to_completion(BACKUP_PAGES_PER_STEP, Duration::ZERO, None)
        .map_err(|e| StorageError::from_sqlite(e, "run online backup"))
}

/// Open `path` read-only, require `quick_check` == `"ok"`, and return
/// `user_version` (which must equal [`CURRENT_SCHEMA`]).
fn verify_snapshot_file(path: &Path) -> Result<i64> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| StorageError::from_sqlite(e, "open snapshot read-only"))?;
    quick_check_ok(&conn)?;
    let revision: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "read snapshot user_version"))?;
    if revision != CURRENT_SCHEMA {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "snapshot schema revision does not match the current schema",
            vec![
                ("expected".to_string(), CURRENT_SCHEMA.to_string()),
                ("found".to_string(), revision.to_string()),
            ],
        ));
    }
    Ok(revision)
}

/// `PRAGMA quick_check` must return exactly one non-empty row: `"ok"`.
fn quick_check_ok(conn: &Connection) -> Result<()> {
    let mut stmt = conn
        .prepare("PRAGMA quick_check")
        .map_err(|e| StorageError::from_sqlite(e, "prepare quick_check"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| StorageError::from_sqlite(e, "run quick_check"))?;
    let mut results: Vec<String> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| StorageError::from_sqlite(e, "read quick_check row"))?
    {
        if let Some(text) = row
            .get::<_, Option<String>>(0)
            .map_err(|e| StorageError::from_sqlite(e, "read quick_check result"))?
        {
            if !text.is_empty() {
                results.push(text);
            }
        }
    }
    if results == ["ok"] {
        Ok(())
    } else {
        Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "snapshot integrity check (quick_check) failed",
            vec![("found".to_string(), results.join(" | "))],
        ))
    }
}

/// Streamed lowercase-hex SHA-256 of the file at `path`.
fn sha256_file_hex(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|e| io_err(e, "open snapshot for hashing"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; HASH_BUF_SIZE];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| io_err(e, "read snapshot for hashing"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

/// Lowercase hex encoding of `bytes` (used for the digest).
fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // Writing to a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Make an RFC 3339 timestamp safe as a file-name component: `:` is illegal
/// in Windows file names and is replaced with `-`.
fn sanitize_rfc3339(ts: &str) -> String {
    ts.replace(':', "-")
}
