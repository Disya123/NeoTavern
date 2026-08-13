//! Staged restore / candidate activation (ТЗ §42, Фаза 11).
//!
//! A **candidate** is a complete data-root directory (database + assets)
//! staged next to the target root. Activation swaps it in atomically at
//! directory granularity and is kill-safe at every step: a pending marker in
//! the root's parent records the intent, and [`resolve_pending_restore`] —
//! invoked by [`crate::open::open`] right after the data-root lease is
//! acquired — completes or discards the swap deterministically, so a kill at
//! any point leaves exactly one fully-verified state active (the current
//! root or the validated candidate). The previous root is retained until the
//! first successful open after activation, per ТЗ §42 step 12.
//!
//! The machinery never extracts, copies or renames over the active data root
//! before the swap; a failed or interrupted restore leaves the current state
//! active and untouched.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{io_err, Result};
use crate::paths::{assets_dir, db_path};
use crate::snapshot::sha256_file_hex;
use crate::{now_utc_rfc3339, StorageError, StorageErrorCode};

/// Name of the marker file a completed candidate carries (written last by the
/// stage builder).
pub const CANDIDATE_READY_FILE: &str = ".neotavern-candidate-ready";

/// Name of the pending-activation marker written into the root's parent.
pub const PENDING_MARKER_FILE: &str = ".neotavern-restore-pending.json";

/// Prefix of staged candidate directories.
pub const CANDIDATE_DIR_PREFIX: &str = ".neotavern-candidate-";

/// Prefix of retained previous-root directories.
pub const PREVIOUS_DIR_PREFIX: &str = ".neotavern-previous-";

/// Maximum retained previous-root directories (the newest survives until the
/// first successful open after activation).
const MAX_PREVIOUS_DIRS: usize = 1;

/// Process-unique sequence for candidate directory names.
static STAGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// A staged candidate data root.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// Absolute path of the candidate directory.
    pub path: PathBuf,
}

/// Creates a fresh empty candidate directory next to `root`
/// (`<root-parent>/.neotavern-candidate-<ms>-<seq>/`).
pub fn stage_candidate(root: &Path) -> Result<Candidate> {
    let parent = root
        .parent()
        .ok_or_else(|| StorageError::new(StorageErrorCode::Io, "data root has no parent"))?;
    fs::create_dir_all(parent).map_err(|e| io_err(e, "create candidate parent"))?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = STAGE_SEQ.fetch_add(1, Ordering::SeqCst);
    let path = parent.join(format!("{CANDIDATE_DIR_PREFIX}{ms}-{seq}"));
    fs::create_dir(&path).map_err(|e| io_err(e, "create candidate dir"))?;
    Ok(Candidate { path })
}

/// Marks the candidate complete: streams the sha256 of its database into the
/// ready file (written last, atomic temp+rename). After this call the
/// candidate is eligible for activation.
pub fn finalize_candidate(candidate: &Candidate) -> Result<()> {
    let db = db_path(&candidate.path);
    let checksum = sha256_file_hex(&db)?;
    write_atomic(
        &candidate.path.join(CANDIDATE_READY_FILE),
        checksum.as_bytes(),
    )
}

/// True when the candidate directory carries a ready marker whose checksum
/// matches the candidate database.
pub fn candidate_is_ready(candidate: &Candidate) -> Result<bool> {
    let ready = candidate.path.join(CANDIDATE_READY_FILE);
    let Ok(recorded) = fs::read_to_string(&ready) else {
        return Ok(false);
    };
    let db = db_path(&candidate.path);
    if !db.is_file() {
        return Ok(false);
    }
    let actual = sha256_file_hex(&db)?;
    Ok(recorded.trim() == actual)
}

/// True when a pending-activation marker exists for `root` (cheap probe used
/// by [`crate::open::open`] to decide whether the lease must be released
/// across the resolution: completing a swap renames the root, which on
/// Windows requires the lock-file handle to be closed first).
pub fn pending_marker_exists(root: &Path) -> bool {
    let Some(parent) = root.parent() else {
        return false;
    };
    parent.join(PENDING_MARKER_FILE).is_file()
}

/// Atomically activates a READY candidate over `root` (ТЗ §42 steps 11–12):
/// pending marker → previous-root retention → swap → marker removal.
///
/// The caller must hold the data-root lease on `root` (the kernel open path
/// does). A non-ready candidate is rejected without touching the root.
pub fn activate(root: &Path, candidate: &Candidate) -> Result<()> {
    if !candidate_is_ready(candidate)? {
        return Err(StorageError::new(
            StorageErrorCode::IntegrityViolation,
            "candidate is not finalized; activation refused",
        ));
    }
    let parent = root
        .parent()
        .ok_or_else(|| StorageError::new(StorageErrorCode::Io, "data root has no parent"))?;
    // 1. Record intent (kill before swap ⇒ resolve discards the candidate).
    let marker = parent.join(PENDING_MARKER_FILE);
    let body = serde_json::json!({
        "root": root.to_string_lossy(),
        "candidate": candidate.path.to_string_lossy(),
        "createdAt": now_utc_rfc3339(),
    });
    write_atomic(&marker, body.to_string().as_bytes())?;
    // 2. Retain the previous root (if it holds a database) before the swap.
    retain_or_discard_previous(root)?;
    // 3. Swap the validated candidate in.
    fs::rename(&candidate.path, root).map_err(|e| io_err(e, "activate candidate"))?;
    // 4. Clear the intent marker; the swap is durable.
    let _ = fs::remove_file(&marker);
    Ok(())
}

/// Completes or discards an interrupted activation. Called by
/// [`crate::open::open`] immediately after lease acquisition and before any
/// database open, so exactly one fully-verified state ever becomes active.
pub fn resolve_pending_restore(root: &Path) -> Result<()> {
    let Some(parent) = root.parent() else {
        return Ok(());
    };
    let marker = parent.join(PENDING_MARKER_FILE);
    if marker.is_file() {
        let candidate = read_marker_candidate(&marker)?;
        match candidate {
            Some(candidate) if candidate_is_ready(&candidate)? => {
                // Kill after finalize, before/during swap: complete it.
                retain_or_discard_previous(root)?;
                fs::rename(&candidate.path, root).map_err(|e| io_err(e, "complete swap"))?;
            }
            Some(candidate) => {
                // Candidate incomplete/corrupt: discard it, keep current root.
                let _ = fs::remove_dir_all(&candidate.path);
            }
            None => {}
        }
        let _ = fs::remove_file(&marker);
    }
    // Retention policy: keep the newest previous root only, and only until a
    // successful open has happened (this function runs inside open, after the
    // lease — reaching here means the active root is the good one).
    prune_previous_dirs(parent)?;
    Ok(())
}

/// Parses the pending marker; `None` when the recorded candidate path is
/// missing or not under the expected parent.
fn read_marker_candidate(marker: &Path) -> Result<Option<Candidate>> {
    let bytes = fs::read(marker).map_err(|e| io_err(e, "read pending marker"))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
        StorageError::new(
            StorageErrorCode::Corrupt,
            format!("bad pending marker: {e}"),
        )
    })?;
    let Some(candidate) = value.get("candidate").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let path = PathBuf::from(candidate);
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return Ok(None);
    };
    if !name.starts_with(CANDIDATE_DIR_PREFIX) {
        return Ok(None);
    }
    Ok(Some(Candidate { path }))
}

/// Removes retained previous-root directories beyond the newest one.
fn prune_previous_dirs(parent: &Path) -> Result<()> {
    let mut previous: Vec<PathBuf> = fs::read_dir(parent)
        .map_err(|e| io_err(e, "read root parent"))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(PREVIOUS_DIR_PREFIX))
        })
        .collect();
    previous.sort();
    previous.reverse(); // newest (largest ms suffix) first
    for stale in previous.iter().skip(MAX_PREVIOUS_DIRS) {
        let _ = fs::remove_dir_all(stale);
    }
    Ok(())
}

/// Retains `root` as a `.neotavern-previous-*` directory when it holds a
/// database (user data worth keeping until the next successful open), or
/// discards it when it does not (e.g. a root containing only the lease lock
/// file carries no user data).
fn retain_or_discard_previous(root: &Path) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    if db_path(root).is_file() {
        let parent = root
            .parent()
            .ok_or_else(|| StorageError::new(StorageErrorCode::Io, "data root has no parent"))?;
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let previous = parent.join(format!("{PREVIOUS_DIR_PREFIX}{ms}"));
        fs::rename(root, &previous).map_err(|e| io_err(e, "retain previous root"))?;
    } else {
        fs::remove_dir_all(root).map_err(|e| io_err(e, "discard database-less root"))?;
    }
    Ok(())
}

/// Copies the database and the whole assets tree of `source_root` into the
/// candidate directory (used by restore/import/converter staging).
pub fn copy_data_root_into(source_root: &Path, candidate: &Candidate) -> Result<()> {
    let src_db = db_path(source_root);
    let dst_db = db_path(&candidate.path);
    fs::copy(&src_db, &dst_db).map_err(|e| io_err(e, "copy candidate database"))?;
    copy_assets_tree(&assets_dir(source_root), &assets_dir(&candidate.path))?;
    Ok(())
}

fn copy_assets_tree(src: &Path, dst: &Path) -> Result<()> {
    if !src.is_dir() {
        return Ok(());
    }
    copy_dir_recursive(src, dst)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).map_err(|e| io_err(e, "create candidate assets dir"))?;
    for entry in fs::read_dir(src).map_err(|e| io_err(e, "read assets dir"))? {
        let entry = entry.map_err(|e| io_err(e, "read assets entry"))?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else if path.is_file() {
            fs::copy(&path, &target).map_err(|e| io_err(e, "copy asset file"))?;
        }
    }
    Ok(())
}

/// Writes `bytes` to `path` via a temp file in the same directory + rename.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| StorageError::new(StorageErrorCode::Io, "no parent for atomic write"))?;
    fs::create_dir_all(parent).map_err(|e| io_err(e, "create dir for atomic write"))?;
    let seq = STAGE_SEQ.fetch_add(1, Ordering::SeqCst);
    let tmp = parent.join(format!(
        ".neotavern-tmp-{}-{seq}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    fs::write(&tmp, bytes).map_err(|e| io_err(e, "write temp file"))?;
    fs::rename(&tmp, path).map_err(|e| io_err(e, "atomic rename"))?;
    Ok(())
}
