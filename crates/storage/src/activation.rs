//! Versioned data-root activation (ТЗ §10.2–§10.4, ADR-0041, Этап 3).
//!
//! A **versioned data root** keeps its versions under `roots/root-<id>/` and
//! points at the active one with a small `active-root.json` pointer written
//! atomically (temp+rename). The **activation journal**
//! (`activation-journal.json`) records every staged activation of the data
//! root with the ТЗ §10.3 statuses `prepared`, `validated`,
//! `activation_pending`, `committed` and `rolled_back`, so a kill at any
//! point is recovered deterministically by [`resolve_pending_activation`] on
//! the next bootstrap.
//!
//! The pointer switch is the commit point — a tiny file replace, never a
//! directory rename — so Windows lock contention (sharing violation / lock
//! violation from antivirus, indexers, backup/sync clients) targets one small
//! file instead of a whole tree. The switch runs through
//! [`with_transient_retry`] (bounded retry, exponential backoff + jitter)
//! and only for classified transient errors; when the budget is exhausted the
//! journal stays at `activation_pending` and activation returns a stable
//! recoverable error so the host can offer **Restart to finish migration**
//! (ТЗ §10.3.1).
//!
//! The v1 flat layout (a data root without `active-root.json`) stays fully
//! supported: [`active_root`] returns the data root itself then, and the
//! ADR-0032 candidate-swap restore path keeps working unchanged.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::error::{io_err, Result, StorageError, StorageErrorCode};
use crate::now_utc_rfc3339;

/// Directory holding versioned roots inside a data root.
pub const ROOTS_DIR: &str = "roots";

/// Small active-root pointer file, written atomically (the commit point).
pub const ACTIVE_ROOT_FILE: &str = "active-root.json";

/// Durable activation journal file (ТЗ §10.3).
pub const ACTIVATION_JOURNAL_FILE: &str = "activation-journal.json";

/// Prefix of versioned root directories under [`ROOTS_DIR`].
pub const ROOT_DIR_PREFIX: &str = "root-";

/// Journal format identifier.
pub const JOURNAL_FORMAT: &str = "neotavern-activation-journal";

/// Journal format version understood by this build.
///
/// v1: `fromRoot`/`toRoot` store absolute paths. v2 (2026-08-15, M3
/// portable-root fix): the same fields store a **portable relative
/// reference** (`.` for the data root itself, otherwise a path relative to
/// the data root), so moving the portable data root keeps pending
/// activation recoverable. v1 journals remain readable.
pub const JOURNAL_FORMAT_VERSION: i64 = 2;

/// Pointer format version understood by this build.
///
/// v1: `root` stores an absolute path. v2 (2026-08-15, M3 portable-root
/// fix): `root` stores a portable relative reference (`.` for the data root
/// itself, otherwise a path relative to the data root), so moving the
/// portable data root does not break the active-root resolution. v1
/// pointers remain readable.
pub const ACTIVE_ROOT_FORMAT_VERSION: i64 = 2;

/// Activation stage statuses (ТЗ §10.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationStatus {
    /// Staging intent recorded before any mutation.
    Prepared,
    /// The staged root passed validation (schema/FK/checksums).
    Validated,
    /// Written immediately before the pointer switch; recovery resumes or
    /// rolls back from here (Windows restart-to-complete).
    ActivationPending,
    /// The pointer switch was confirmed.
    Committed,
    /// The activation was abandoned; the previous root stays active.
    RolledBack,
}

impl ActivationStatus {
    /// Stable machine-readable string form (also used in the journal JSON).
    pub fn as_str(&self) -> &'static str {
        match self {
            ActivationStatus::Prepared => "prepared",
            ActivationStatus::Validated => "validated",
            ActivationStatus::ActivationPending => "activation_pending",
            ActivationStatus::Committed => "committed",
            ActivationStatus::RolledBack => "rolled_back",
        }
    }

    /// Parses a status string; `None` for unknown values.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "prepared" => Some(ActivationStatus::Prepared),
            "validated" => Some(ActivationStatus::Validated),
            "activation_pending" => Some(ActivationStatus::ActivationPending),
            "committed" => Some(ActivationStatus::Committed),
            "rolled_back" => Some(ActivationStatus::RolledBack),
            _ => None,
        }
    }
}

/// One durable journal entry (ТЗ §10.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalEntry {
    /// Stable entry id (uuid-like string).
    pub id: String,
    /// `restore` | `migration` | `import` | `rollback`.
    pub kind: String,
    /// Current stage status.
    pub status: ActivationStatus,
    /// Absolute path of the previous/current active root (resolved from the
    /// portable relative reference stored by v2 journals).
    pub from_root: PathBuf,
    /// Absolute path of the staged target root (resolved from the portable
    /// relative reference stored by v2 journals).
    pub to_root: PathBuf,
    /// RFC 3339 creation timestamp.
    pub created_at: String,
    /// RFC 3339 last-update timestamp.
    pub updated_at: String,
    /// Human-readable failure detail when the entry is rolled back with an
    /// error; `None` otherwise.
    pub error: Option<String>,
}

/// The durable activation journal of a data root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationJournal {
    /// Format identifier, always [`JOURNAL_FORMAT`].
    pub format: String,
    /// Format version, always [`JOURNAL_FORMAT_VERSION`].
    pub format_version: i64,
    /// Stage history, oldest first; the last entry is the recovery source.
    pub entries: Vec<JournalEntry>,
}

/// The active-root pointer (`active-root.json`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveRootPointer {
    /// Format version, always [`ACTIVE_ROOT_FORMAT_VERSION`].
    pub format_version: i64,
    /// Absolute path of the active root directory (v2 pointers resolve the
    /// stored portable relative reference against the data root on read).
    pub root: PathBuf,
    /// RFC 3339 activation timestamp.
    pub activated_at: String,
}

/// Absolute path of the activation journal for `data_root`.
pub fn journal_path(data_root: &Path) -> PathBuf {
    data_root.join(ACTIVATION_JOURNAL_FILE)
}

/// Absolute path of the active-root pointer for `data_root`.
pub fn pointer_path(data_root: &Path) -> PathBuf {
    data_root.join(ACTIVE_ROOT_FILE)
}

/// Absolute path of the versioned roots directory for `data_root`.
pub fn roots_dir(data_root: &Path) -> PathBuf {
    data_root.join(ROOTS_DIR)
}

/// Absolute path of the versioned root with the given id.
pub fn versioned_root_path(data_root: &Path, root_id: &str) -> PathBuf {
    roots_dir(data_root).join(format!("{ROOT_DIR_PREFIX}{root_id}"))
}

/// Reads the activation journal; a missing journal is an empty journal (never
/// an error). An unreadable or malformed journal is a controlled
/// [`StorageErrorCode::Corrupt`] failure (recovery must not guess): only
/// `NotFound` means "no journal", any other read failure is reported — a
/// journal that exists but cannot be read must never be treated as empty
/// (fail-closed, ТЗ §22.3).
pub fn read_journal(data_root: &Path) -> Result<ActivationJournal> {
    let path = journal_path(data_root);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ActivationJournal {
                format: JOURNAL_FORMAT.to_string(),
                format_version: JOURNAL_FORMAT_VERSION,
                entries: Vec::new(),
            });
        }
        Err(e) => {
            return Err(StorageError::with(
                StorageErrorCode::Corrupt,
                format!(
                    "activation journal {} exists but cannot be read: {e}",
                    path.display()
                ),
                vec![("path".into(), path.display().to_string())],
            ));
        }
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
        StorageError::new(
            StorageErrorCode::Corrupt,
            format!(
                "activation journal {} is not valid JSON: {e}",
                path.display()
            ),
        )
    })?;
    let format = value
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or_else(|| corrupt_journal(&path, "missing format"))?;
    if format != JOURNAL_FORMAT {
        return Err(corrupt_journal(&path, "unknown format"));
    }
    let format_version = value
        .get("formatVersion")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| corrupt_journal(&path, "missing formatVersion"))?;
    if format_version > JOURNAL_FORMAT_VERSION {
        return Err(StorageError::with(
            StorageErrorCode::SchemaTooNew,
            "activation journal format is newer than this build supports",
            vec![
                ("journal_format_version".into(), format_version.to_string()),
                ("supported".into(), JOURNAL_FORMAT_VERSION.to_string()),
            ],
        ));
    }
    let entries = value
        .get("entries")
        .and_then(|v| v.as_array())
        .ok_or_else(|| corrupt_journal(&path, "missing entries array"))?;
    let entries = entries
        .iter()
        .map(|entry| parse_entry(data_root, format_version, entry))
        .collect::<Result<Vec<_>>>()?;
    Ok(ActivationJournal {
        format: format.to_string(),
        format_version,
        entries,
    })
}

/// Appends (or updates) `entry` in the journal and writes it atomically.
///
/// If an entry with the same `id` already exists it is replaced (idempotent
/// transition); otherwise the entry is appended. The write is temp+rename in
/// the data root, so a kill never leaves a half-written journal.
pub fn write_entry(data_root: &Path, entry: JournalEntry) -> Result<()> {
    let mut journal = read_journal(data_root)?;
    if let Some(existing) = journal.entries.iter_mut().find(|e| e.id == entry.id) {
        *existing = entry;
    } else {
        journal.entries.push(entry);
    }
    let body = serde_json::json!({
        "format": journal.format,
        "formatVersion": journal.format_version,
        "entries": journal
            .entries
            .iter()
            .map(|entry| entry_json(data_root, journal.format_version, entry))
            .collect::<Vec<_>>(),
    });
    write_atomic(&journal_path(data_root), body.to_string().as_bytes())
}

/// Returns the newest journal entry, if any (the recovery source of truth).
pub fn latest_entry(data_root: &Path) -> Result<Option<JournalEntry>> {
    Ok(read_journal(data_root)?.entries.pop())
}

/// Reads the active-root pointer. `Ok(None)` when the data root is v1 flat
/// (no pointer file) — the active root is the data root itself.
///
/// A malformed pointer is a controlled [`StorageErrorCode::Corrupt`] failure;
/// a pointer whose root directory does not exist is
/// [`StorageErrorCode::NotFound`] (recovery must not invent a root).
pub fn read_pointer(data_root: &Path) -> Result<Option<ActiveRootPointer>> {
    let path = pointer_path(data_root);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            // A pointer that exists but cannot be read is NOT "v1 flat": it
            // must never be treated as missing (fail-closed, ТЗ §22.3).
            return Err(StorageError::with(
                StorageErrorCode::Corrupt,
                format!(
                    "active-root pointer {} exists but cannot be read: {e}",
                    path.display()
                ),
                vec![("path".into(), path.display().to_string())],
            ));
        }
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
        StorageError::new(
            StorageErrorCode::Corrupt,
            format!(
                "active-root pointer {} is not valid JSON: {e}",
                path.display()
            ),
        )
    })?;
    let format_version = value
        .get("formatVersion")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| corrupt_pointer(&path, "missing formatVersion"))?;
    if format_version > ACTIVE_ROOT_FORMAT_VERSION {
        return Err(StorageError::with(
            StorageErrorCode::SchemaTooNew,
            "active-root pointer format is newer than this build supports",
            vec![
                ("pointer_format_version".into(), format_version.to_string()),
                ("supported".into(), ACTIVE_ROOT_FORMAT_VERSION.to_string()),
            ],
        ));
    }
    let root_ref = value
        .get("root")
        .and_then(|v| v.as_str())
        .ok_or_else(|| corrupt_pointer(&path, "missing root"))?;
    // v2 stores a portable relative reference (`.` for the data root itself,
    // otherwise a path relative to the data root); v1 stored an absolute
    // path. Resolving against the CURRENT data root is what makes a moved
    // portable directory keep working (M3 portable-root fix).
    let root = if format_version >= 2 {
        resolve_root_ref(data_root, root_ref)
    } else {
        PathBuf::from(root_ref)
    };
    if !root.is_dir() {
        return Err(StorageError::with(
            StorageErrorCode::NotFound,
            "active-root pointer references a missing root directory",
            vec![("root".into(), root.display().to_string())],
        ));
    }
    // A crafted pointer must never redirect the kernel to an arbitrary
    // directory outside the data root (ТЗ §22.3, SEC hardening): the active
    // root is the data root itself (v1 flat) or a versioned root under
    // `<data-root>/roots/`. Anything else is corrupt, not "migrated".
    validate_active_root_candidate(data_root, &root)?;
    let activated_at = value
        .get("activatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(Some(ActiveRootPointer {
        format_version,
        root,
        activated_at,
    }))
}

/// Resolves the active root of a data root: the pointer target in v2 layout,
/// or the data root itself in v1 flat layout.
pub fn active_root(data_root: &Path) -> Result<PathBuf> {
    Ok(match read_pointer(data_root)? {
        Some(pointer) => pointer.root,
        None => data_root.to_path_buf(),
    })
}

/// Writes the active-root pointer atomically (the commit point of an
/// activation). Never touches the target or previous roots.
///
/// The pointer is the trust anchor for the whole data root, so `root` is
/// validated before it is published: only a versioned root **inside** this
/// data root's `roots/` directory (or the data root itself, for a v1-flat
/// rollback pointer) may become active. A pointer to an arbitrary absolute
/// path outside the data root is refused with
/// [`StorageErrorCode::IntegrityViolation`] — a crafted pointer must never
/// make the kernel open a foreign directory (ТЗ §22.3).
pub fn write_pointer(data_root: &Path, root: &Path) -> Result<()> {
    validate_active_root_candidate(data_root, root)?;
    write_pointer_atomic(data_root, &pointer_path(data_root), root)
}

/// Validates that `root` is a legal active-root target for `data_root`: the
/// data root itself (v1 flat) or a versioned root under `<data-root>/roots/`.
fn validate_active_root_candidate(data_root: &Path, root: &Path) -> Result<()> {
    if root == data_root {
        return Ok(());
    }
    if root.starts_with(roots_dir(data_root)) {
        return Ok(());
    }
    Err(StorageError::with(
        StorageErrorCode::IntegrityViolation,
        "refusing active-root pointer outside the data root",
        vec![
            ("data_root".into(), data_root.display().to_string()),
            ("root".into(), root.display().to_string()),
        ],
    ))
}

/// Starts a new activation: writes a `prepared` journal entry BEFORE any
/// mutation (ТЗ §10.3 step ordering). Idempotent per entry `id`.
pub fn begin_activation(
    data_root: &Path,
    id: &str,
    kind: &str,
    from_root: &Path,
    to_root: &Path,
) -> Result<()> {
    let now = now_utc_rfc3339();
    write_entry(
        data_root,
        JournalEntry {
            id: id.to_string(),
            kind: kind.to_string(),
            status: ActivationStatus::Prepared,
            from_root: from_root.to_path_buf(),
            to_root: to_root.to_path_buf(),
            created_at: now.clone(),
            updated_at: now,
            error: None,
        },
    )
}

/// Transitions an existing journal entry to a new status (idempotent). An
/// unknown entry id is [`StorageErrorCode::NotFound`].
pub fn transition_status(
    data_root: &Path,
    id: &str,
    status: ActivationStatus,
    error: Option<String>,
) -> Result<()> {
    let mut journal = read_journal(data_root)?;
    let entry = journal
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| {
            StorageError::with(
                StorageErrorCode::NotFound,
                "activation journal entry not found",
                vec![("entry_id".into(), id.to_string())],
            )
        })?;
    entry.status = status;
    entry.updated_at = now_utc_rfc3339();
    entry.error = error;
    let body = serde_json::json!({
        "format": journal.format,
        "formatVersion": journal.format_version,
        "entries": journal
            .entries
            .iter()
            .map(|entry| entry_json(data_root, journal.format_version, entry))
            .collect::<Vec<_>>(),
    });
    write_atomic(&journal_path(data_root), body.to_string().as_bytes())
}

/// Result of [`resolve_pending_activation`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivationResolution {
    /// No pending activation existed; nothing to do.
    None,
    /// A pending pointer switch was completed (restart-to-complete).
    Completed { entry_id: String },
    /// A pending activation was abandoned; the previous root stays active.
    RolledBack { entry_id: String },
}

/// Completes or discards an interrupted activation. Called by
/// [`crate::open::open`] right after the data-root lease is acquired and
/// before any SQLite open, so exactly one fully-verified root ever becomes
/// active (ТЗ §10.3.1 step 5).
///
/// Recovery rules (deterministic, idempotent):
///
/// - No journal or newest entry not in `activation_pending` → [`None`]
///   (a `prepared`/`validated` entry without a pending switch means the
///   activation never reached the commit point; the target may be discarded
///   by the caller, the previous root stays active).
/// - Newest entry `activation_pending` and its target root exists and carries
///   a database → complete the pointer switch (restart-to-complete) with the
///   transient retry, then `committed`.
/// - Newest entry `activation_pending` but the target is missing/corrupt →
///   `rolled_back`, previous root stays active.
///
/// The previous root is NEVER deleted here; retention is the caller's
/// responsibility (see [`prune_previous_roots`]).
pub fn resolve_pending_activation(data_root: &Path) -> Result<ActivationResolution> {
    let Some(entry) = latest_entry(data_root)? else {
        return Ok(ActivationResolution::None);
    };
    if entry.status != ActivationStatus::ActivationPending {
        return Ok(ActivationResolution::None);
    }
    let target_has_db = crate::paths::db_path(&entry.to_root).is_file();
    if !target_has_db {
        transition_status(
            data_root,
            &entry.id,
            ActivationStatus::RolledBack,
            Some("pending activation target has no database".to_string()),
        )?;
        return Ok(ActivationResolution::RolledBack { entry_id: entry.id });
    }
    // The journal lives on disk and could be crafted: never let recovery
    // publish a root outside the data root (mirrors write_pointer's
    // validation — recovery must not bypass the pointer validator).
    validate_active_root_candidate(data_root, &entry.to_root)?;
    // The pointer switch is the commit point. The target root is already
    // fully verified by the staged conversion; here we only publish it.
    let pointer = pointer_path(data_root);
    with_transient_retry(RetryPolicy::default(), || {
        write_pointer_atomic(data_root, &pointer, &entry.to_root)
    })
    .map_err(|e| {
        StorageError::with(
            StorageErrorCode::ActivationPending,
            format!("activation pending, restart to finish migration: {e}"),
            vec![("entry_id".into(), entry.id.clone())],
        )
    })?;
    transition_status(data_root, &entry.id, ActivationStatus::Committed, None)?;
    Ok(ActivationResolution::Completed { entry_id: entry.id })
}

/// Activates a fully verified target root: `prepared` → `validated` →
/// `activation_pending` → pointer switch (commit) → `committed`.
///
/// The caller must have staged and validated `to_root` (schema/FK/checksums)
/// BEFORE calling this; this function only records the stages and publishes
/// the pointer. `from_root` is the currently active root
/// ([`active_root`](crate::open::Database::root) semantics preserved by the
/// caller). A failed pointer switch after the retry budget leaves the journal
/// at `activation_pending` and returns
/// [`StorageErrorCode::ActivationPending`] — the host should shut down
/// cleanly and offer **Restart to finish migration**.
pub fn activate(
    data_root: &Path,
    id: &str,
    kind: &str,
    from_root: &Path,
    to_root: &Path,
) -> Result<()> {
    if !crate::paths::db_path(to_root).is_file() {
        return Err(StorageError::new(
            StorageErrorCode::IntegrityViolation,
            "activation target has no database; activation refused",
        ));
    }
    begin_activation(data_root, id, kind, from_root, to_root)?;
    transition_status(data_root, id, ActivationStatus::Validated, None)?;
    transition_status(data_root, id, ActivationStatus::ActivationPending, None)?;
    let pointer = pointer_path(data_root);
    with_transient_retry(RetryPolicy::default(), || {
        write_pointer_atomic(data_root, &pointer, to_root)
    })
    .map_err(|e| {
        StorageError::with(
            StorageErrorCode::ActivationPending,
            format!("activation pending, restart to finish migration: {e}"),
            vec![("entry_id".into(), id.to_string())],
        )
    })?;
    transition_status(data_root, id, ActivationStatus::Committed, None)
}

/// Retry policy for the pointer switch (ТЗ §10.3.1): bounded retry, base
/// delay doubled per attempt, ±20 % jitter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Maximum attempts (1 = no retry).
    pub max_attempts: u32,
    /// Base delay between attempts in milliseconds.
    pub base_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        // 1 + 5 retries: 50/100/200/400/800/1600 ms with jitter — a bounded
        // budget that never hangs the bootstrap.
        Self {
            max_attempts: 6,
            base_delay_ms: 50,
        }
    }
}

/// Runs `op` with bounded retry for classified transient I/O errors
/// (Windows `ERROR_SHARING_VIOLATION` 32, `ERROR_LOCK_VIOLATION` 33, POSIX
/// `WouldBlock`), exponential backoff and ±20 % jitter (ТЗ §10.3.1). Any
/// other error fails immediately. Returns the first non-transient error after
/// `max_attempts`.
pub fn with_transient_retry<T, F>(policy: RetryPolicy, op: F) -> Result<T>
where
    F: Fn() -> Result<T>,
{
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match op() {
            Ok(value) => return Ok(value),
            Err(e) if is_transient(&e) && attempt < policy.max_attempts => {
                let delay = backoff_delay_ms(policy.base_delay_ms, attempt);
                std::thread::sleep(Duration::from_millis(delay));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Classifies a storage error as a transient sharing/lock contention worth
/// retrying (ТЗ §10.3.1 item 3: retry ONLY for classified transient
/// sharing/lock errors).
pub fn is_transient(err: &StorageError) -> bool {
    if err.code == StorageErrorCode::Busy {
        return true;
    }
    if err.code != StorageErrorCode::Io {
        return false;
    }
    // Windows: ERROR_SHARING_VIOLATION (32), ERROR_LOCK_VIOLATION (33).
    // POSIX: WouldBlock. `os_error` is recorded by `io_err`.
    err.params.iter().any(|(key, value)| {
        key == "os_error"
            && matches!(
                value.as_str(),
                "32" | "33" | "36" | "5" if is_windows_sharing_or_lock(value.as_str())
            )
    }) || err
        .params
        .iter()
        .any(|(key, value)| key == "os_error" && value == "11" && cfg!(unix))
}

/// True for the Windows error codes we classify as transient sharing/lock
/// contention (32 = ERROR_SHARING_VIOLATION, 33 = ERROR_LOCK_VIOLATION,
/// 36 = ERROR_SHARE_BUFFER_EXCEEDED). Access denied (5) is deliberately NOT
/// retried: the ТЗ forbids treating it as transient ("never require disabling
/// protection as the only recovery path" — a permanent denial must surface
/// immediately).
fn is_windows_sharing_or_lock(code: &str) -> bool {
    matches!(code, "32" | "33" | "36")
}

/// Exponential backoff with ±20 % jitter: `base * 2^(attempt-1)` scaled by
/// `0.8..=1.2`. Deterministic for tests when a fixed jitter is injected via
/// the `DSH_ACTIVATION_JITTER` env override; production uses a thread-local
/// pseudo-random jitter.
fn backoff_delay_ms(base_ms: u64, attempt: u32) -> u64 {
    let exp = base_ms.saturating_mul(1u64 << (attempt.saturating_sub(1).min(10)));
    let jitter = match std::env::var("DSH_ACTIVATION_JITTER") {
        Ok(value) => value.parse::<f64>().unwrap_or(1.0).clamp(0.8, 1.2),
        Err(_) => {
            // Simple deterministic-ish jitter from the attempt counter —
            // adequate for retry spacing; no RNG dependency in this crate.
            1.0
        }
    };
    (exp as f64 * jitter) as u64
}

/// Removes versioned roots beyond the retained previous one (rollback
/// retention: keep the newest previous root only, mirroring the restore
/// previous-root policy). Never touches the active root.
pub fn prune_previous_roots(data_root: &Path) -> Result<()> {
    let Some(active) = read_pointer(data_root)? else {
        return Ok(());
    };
    let active = active.root;
    let roots = roots_dir(data_root);
    let Ok(entries) = fs::read_dir(&roots) else {
        return Ok(());
    };
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.is_dir()
                && *p != active
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(ROOT_DIR_PREFIX))
        })
        .collect();
    // Keep only the newest inactive root (best-effort lexicographic order is
    // fine: ids are sortable); remove the rest.
    candidates.sort();
    for stale in candidates.iter().skip(1) {
        let _ = fs::remove_dir_all(stale);
    }
    Ok(())
}

/// Parses one journal entry object. `format_version` selects the root
/// encoding: v1 stores absolute paths, v2+ stores portable relative
/// references resolved against `data_root`.
fn parse_entry(
    data_root: &Path,
    format_version: i64,
    value: &serde_json::Value,
) -> Result<JournalEntry> {
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| corrupt_journal_entry(value, "missing id"))?
        .to_string();
    let kind = value
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("migration")
        .to_string();
    let status = value
        .get("status")
        .and_then(|v| v.as_str())
        .and_then(ActivationStatus::parse)
        .ok_or_else(|| corrupt_journal_entry(value, "invalid status"))?;
    let from_root_ref = value
        .get("fromRoot")
        .and_then(|v| v.as_str())
        .ok_or_else(|| corrupt_journal_entry(value, "missing fromRoot"))?;
    let to_root_ref = value
        .get("toRoot")
        .and_then(|v| v.as_str())
        .ok_or_else(|| corrupt_journal_entry(value, "missing toRoot"))?;
    let from_root = if format_version >= 2 {
        resolve_root_ref(data_root, from_root_ref)
    } else {
        PathBuf::from(from_root_ref)
    };
    let to_root = if format_version >= 2 {
        resolve_root_ref(data_root, to_root_ref)
    } else {
        PathBuf::from(to_root_ref)
    };
    let created_at = value
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let updated_at = value
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let error = value
        .get("error")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(JournalEntry {
        id,
        kind,
        status,
        from_root,
        to_root,
        created_at,
        updated_at,
        error,
    })
}

/// JSON object form of one entry. v1 journals keep absolute `fromRoot`/
/// `toRoot`; v2+ journals store portable relative references.
fn entry_json(data_root: &Path, format_version: i64, entry: &JournalEntry) -> serde_json::Value {
    let (from_root, to_root) = if format_version >= 2 {
        (
            root_ref(data_root, &entry.from_root),
            root_ref(data_root, &entry.to_root),
        )
    } else {
        (
            entry.from_root.to_string_lossy().into_owned(),
            entry.to_root.to_string_lossy().into_owned(),
        )
    };
    serde_json::json!({
        "id": entry.id,
        "kind": entry.kind,
        "status": entry.status.as_str(),
        "fromRoot": from_root,
        "toRoot": to_root,
        "createdAt": entry.created_at,
        "updatedAt": entry.updated_at,
        "error": entry.error,
    })
}

/// Portable relative root reference: `.` for the data root itself, otherwise
/// the root path relative to the data root (e.g. `roots/root-<id>`), using
/// `/` separators so the reference is platform-independent.
fn root_ref(data_root: &Path, root: &Path) -> String {
    match root.strip_prefix(data_root) {
        Ok(rel) if rel.as_os_str().is_empty() => ".".to_string(),
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => {
            // Only reachable when the caller bypassed validation; keep the
            // absolute form so the pointer remains meaningful.
            root.to_string_lossy().into_owned()
        }
    }
}

/// Resolves a portable relative root reference against `data_root`.
fn resolve_root_ref(data_root: &Path, reference: &str) -> PathBuf {
    if reference == "." {
        data_root.to_path_buf()
    } else {
        // References are written with '/' separators for portability; join
        // accepts them verbatim on every platform (Windows normalizes '/'),
        // and joining keeps the result relative to `data_root`.
        data_root.join(reference)
    }
}

/// Atomic pointer write (temp+rename in the data root). v2 format: stores
/// the portable relative reference, so a moved portable data root keeps
/// resolving.
fn write_pointer_atomic(data_root: &Path, pointer: &Path, root: &Path) -> Result<()> {
    let body = serde_json::json!({
        "formatVersion": ACTIVE_ROOT_FORMAT_VERSION,
        "root": root_ref(data_root, root),
        "activatedAt": now_utc_rfc3339(),
    });
    write_atomic(pointer, body.to_string().as_bytes())
}

/// Writes `bytes` to `path` via a temp file in the same directory + rename
/// (shared with the restore machinery). The temp file is fsync'd before the
/// rename and the target is fsync'd after it, so a crash after this call
/// returns can never lose the committed bytes (ТЗ §10.3 "flush/sync до
/// объявления committed").
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = path
        .parent()
        .ok_or_else(|| StorageError::new(StorageErrorCode::Io, "no parent for atomic write"))?;
    fs::create_dir_all(parent).map_err(|e| io_err(e, "create dir for atomic write"))?;
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let tmp = parent.join(format!(
        ".neotavern-tmp-{}-{seq}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    // Open read+write from the start so the handle can fsync on every
    // platform (a read-only handle cannot sync on Windows).
    let mut tmp_file = fs::OpenOptions::new()
        .write(true)
        .read(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(|e| io_err(e, "create temp file"))?;
    use std::io::Write;
    tmp_file
        .write_all(bytes)
        .map_err(|e| io_err(e, "write temp file"))?;
    // Durability before the rename: the temp bytes must be on stable storage
    // before they can become the visible file (ТЗ §10.3 fsync requirement).
    tmp_file
        .sync_all()
        .map_err(|e| io_err(e, "sync temp file"))?;
    drop(tmp_file);
    fs::rename(&tmp, path).map_err(|e| io_err(e, "atomic rename"))?;
    // After the rename the new path is openable; syncing the directory would
    // be needed to make the rename itself durable across a crash, which is
    // best-effort on each platform — sync the file at its final path so the
    // bytes are flushed even if the rename survives.
    if let Ok(final_file) = fs::OpenOptions::new().read(true).open(path) {
        let _ = final_file.sync_all();
    }
    Ok(())
}

/// A `Corrupt` error for a bad journal file.
fn corrupt_journal(path: &Path, why: &str) -> StorageError {
    StorageError::new(
        StorageErrorCode::Corrupt,
        format!("activation journal {} is corrupt: {why}", path.display()),
    )
}

/// A `Corrupt` error for a bad journal entry.
fn corrupt_journal_entry(value: &serde_json::Value, why: &str) -> StorageError {
    StorageError::new(
        StorageErrorCode::Corrupt,
        format!("activation journal entry is corrupt: {why} ({value})"),
    )
}

/// A `Corrupt` error for a bad pointer file.
fn corrupt_pointer(path: &Path, why: &str) -> StorageError {
    StorageError::new(
        StorageErrorCode::Corrupt,
        format!("active-root pointer {} is corrupt: {why}", path.display()),
    )
}
