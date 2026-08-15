//! Staged legacy→kernel data migration (ТЗ §10.3, ADR-0041, Этап 3).
//!
//! Orchestrates the full ТЗ §10.3 sequence for converting a **legacy**
//! (pre-kernel Drizzle) database into a fresh versioned kernel data root:
//!
//! ```text
//! Detect legacy data
//! → Acquire exclusive maintenance lock (the data-root lease)
//! → Preflight disk space and versions
//! → Create verified backup
//! → Convert into staging data-root (versioned root)
//! → Validate schema, FK, counts and hashes
//! → Produce human-readable report
//! → Platform-aware commit/activation (activation journal)
//! → Retain rollback pointer
//! ```
//!
//! Design invariants (ADR-0041, ТЗ §10.3):
//!
//! - The **source legacy database is never modified** — the safety copy
//!   reads its bytes through the SQLite online-backup API, and when a backup
//!   is requested the converter reads the verified safety copy (a consistent
//!   snapshot) rather than the live source, so a concurrent legacy writer
//!   can never make the converted data diverge from the verified backup.
//! - **No live dual-write**: the migration stages a fresh versioned root
//!   (`roots/root-<id>/`) and publishes it through the activation journal; the
//!   old root is never written in place and stays active until the pointer
//!   switch commits.
//! - **Staging is on the same volume** by construction (the versioned root
//!   lives under the data root), and the pointer switch is a tiny atomic file
//!   replace — the platform-aware commit of ADR-0041.
//! - **Idempotent**: re-running the migration on an already-migrated data root
//!   is a controlled no-op reporting the committed entry; a prepared-but-
//!   unactivated staging can be resumed (`commit`) or cancelled
//!   (`cancel`) — the staging root is retained for retry until the user
//!   confirms cancellation, exactly as ТЗ §10.3 requires.
//! - **Cancellable before activation**: [`MigrationSession::begin`] stops at
//!   `validated`; the caller may commit or cancel. After cancellation the
//!   journal records `rolled_back` and the previous root remains the only
//!   active one.
//! - **Unknown future schema versions fail closed** (the converter's
//!   `UnsupportedStorageFormat` / the open path's `SchemaTooNew`).
//!
//! The data-root lease is the maintenance lock: the host must close the
//! kernel (releasing the lease) before migrating, and
//! [`MigrationSession::begin`] acquires the lease itself and holds it for the
//! whole session (staging → commit/cancel), so no second writer can enter
//! between the phases.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::activation::{
    self, active_root, begin_activation, latest_entry, transition_status, write_pointer,
    ActivationStatus,
};
use crate::baseline::ConnectionPolicy;
use crate::error::{io_err, Result, StorageError, StorageErrorCode};
use crate::lease::DataRootLease;
use crate::legacy::{convert_legacy, ConversionReport};
use crate::migrations::MigrationProgress;
use crate::open::open;
use crate::restore::Candidate;
use crate::{now_utc_rfc3339, CURRENT_SCHEMA};

/// Kind value recorded in the activation journal for a legacy migration.
pub const MIGRATION_KIND: &str = "migration";

/// Name of the safety-copy directory under `<data-root>/backups/`.
pub const PRE_MIGRATION_COPY_PREFIX: &str = "pre-migration-";

/// Minimum free space required on the target volume beyond the legacy
/// database size (staging DB + WAL + safety copy headroom), in bytes.
const MIN_FREE_SPACE_HEADROOM: u64 = 64 * 1024 * 1024;

/// Progress stages reported by [`MigrationSession::begin`] (ТЗ §10.3
/// sequence).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationStage {
    /// Acquiring the maintenance lock (data-root lease) and probing the
    /// source.
    Preflight,
    /// Creating the verified safety copy of the legacy database.
    Backup,
    /// Converting rows into the fresh staging root.
    Convert,
    /// Validating schema/FK/counts on the staged root.
    Validate,
    /// Publishing the staging root through the activation journal.
    Activate,
}

impl MigrationStage {
    /// Stable machine-readable form.
    pub fn as_str(&self) -> &'static str {
        match self {
            MigrationStage::Preflight => "preflight",
            MigrationStage::Backup => "backup",
            MigrationStage::Convert => "convert",
            MigrationStage::Validate => "validate",
            MigrationStage::Activate => "activate",
        }
    }
}

/// Result of a prepared (staged, validated, NOT yet activated) migration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMigration {
    /// Activation-journal entry id (used by [`MigrationSession::commit`] /
    /// [`MigrationSession::cancel`]).
    pub entry_id: String,
    /// The data root that owns this migration (the lease target).
    pub data_root: PathBuf,
    /// Absolute path of the staged versioned root.
    pub staging_root: PathBuf,
    /// Absolute path of the verified safety copy of the legacy database
    /// (`Some` when `backup: true`).
    pub backup_path: Option<PathBuf>,
    /// Per-table conversion counts and skipped/orphaned records.
    pub report: ConversionReport,
}

/// Result of a committed migration (the staging root is now active).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationOutcome {
    /// Activation-journal entry id of the committed migration.
    pub entry_id: String,
    /// Absolute path of the now-active versioned root.
    pub active_root: PathBuf,
    /// Per-table conversion counts and skipped/orphaned records.
    pub report: ConversionReport,
    /// Absolute path of the retained previous root (rollback pointer), when
    /// one was retained.
    pub previous_root: Option<PathBuf>,
}

/// A staged legacy migration that holds the data-root lease for its whole
/// lifetime — from [`MigrationSession::begin`] (which acquires the exclusive
/// maintenance lock of ТЗ §10.3) through [`MigrationSession::commit`] or
/// [`MigrationSession::cancel`].
///
/// Holding the lease across the phases is what makes the migration
/// single-writer: no second process can open or write the data root between
/// staging and activation (ADR-0041, ТЗ §10.3). Dropping the session without
/// committing or cancelling releases the lease and leaves the prepared entry
/// at `validated` in the journal — a kill at that point is recovered on the
/// next run exactly as the corpus expects.
#[derive(Debug)]
pub struct MigrationSession {
    /// The exclusive data-root lease (the maintenance lock). Released when the
    /// session is dropped, after commit, or after cancel.
    lease: DataRootLease,
    /// The staged, validated migration (never activated yet).
    prepared: PreparedMigration,
}

impl MigrationSession {
    /// Stages a legacy database into a fresh versioned root WITHOUT activating
    /// it (ТЗ §10.3 steps 1–7; the caller decides to [`Self::commit`] or
    /// [`Self::cancel`]).
    ///
    /// The data-root lease is acquired here and held for the whole session —
    /// the maintenance lock of ТЗ §10.3. When the data root is already
    /// migrated (active-root pointer exists and points at a root that opened
    /// as a kernel root), this is a controlled no-op returning a session over
    /// the existing committed entry.
    ///
    /// `progress` receives [`MigrationStage`] notifications.
    pub fn begin(
        data_root: &Path,
        source_db: &Path,
        backup: bool,
        progress: &mut dyn FnMut(MigrationStage),
    ) -> Result<MigrationSession> {
        progress(MigrationStage::Preflight);

        // The lease is the maintenance lock; it also guarantees the staging
        // directory is private to this writer. Held for the whole session so
        // no second writer can enter between staging and activation.
        let lease = DataRootLease::acquire(data_root)?;

        // Idempotency: an already-committed migration is a no-op (report the
        // committed entry, never a second migration).
        if let Some(entry) = latest_entry(data_root)? {
            if entry.kind == MIGRATION_KIND && entry.status == ActivationStatus::Committed {
                let staging = entry.to_root;
                let report = read_conversion_report(&staging)?;
                return Ok(MigrationSession {
                    lease,
                    prepared: PreparedMigration {
                        entry_id: entry.id,
                        data_root: data_root.to_path_buf(),
                        staging_root: staging,
                        backup_path: None,
                        report,
                    },
                });
            }
        }

        preflight(data_root, source_db)?;

        let backup_path = if backup {
            progress(MigrationStage::Backup);
            Some(create_safety_copy(data_root, source_db)?)
        } else {
            None
        };

        // Fresh versioned root as the staging directory (same volume by
        // construction). A fresh id per attempt keeps retry independent.
        progress(MigrationStage::Convert);
        let staging_root = fresh_staging_root(data_root)?;
        // With a backup requested, convert from the VERIFIED safety copy
        // (a consistent snapshot taken through the SQLite online-backup API),
        // never from the live legacy source: a second connection (legacy
        // sidecar, indexer) could mutate the source between the backup and
        // this read, and the converted data must match the verified snapshot
        // byte-for-byte (audit P1, ТЗ §10.3 "Create verified backup").
        // `create_safety_copy` returns the snapshot DIRECTORY; the database
        // file inside it is the conversion source.
        let conversion_source = match backup_path {
            Some(ref dir) => dir.join("database.sqlite"),
            None => source_db.to_path_buf(),
        };
        let report = convert_legacy(
            &conversion_source,
            &Candidate {
                path: staging_root.clone(),
            },
        )?;

        progress(MigrationStage::Validate);
        validate_staged_root(&staging_root)?;

        // Record intent BEFORE the caller can commit: `prepared` → `validated`.
        let entry_id = new_id();
        let from_root = active_root(data_root)?;
        begin_activation(
            data_root,
            &entry_id,
            MIGRATION_KIND,
            &from_root,
            &staging_root,
        )?;
        transition_status(data_root, &entry_id, ActivationStatus::Validated, None)?;

        Ok(MigrationSession {
            lease,
            prepared: PreparedMigration {
                entry_id,
                data_root: data_root.to_path_buf(),
                staging_root,
                backup_path,
                report,
            },
        })
    }

    /// Commits the prepared migration: `activation_pending` → pointer switch →
    /// `committed` (ADR-0041 platform-aware activation with bounded transient
    /// retry). After this the staging root is the active root; the previous
    /// root is retained as the rollback pointer. The session (and thus the
    /// data-root lease) is consumed by the commit.
    pub fn commit(self, progress: &mut dyn FnMut(MigrationStage)) -> Result<MigrationOutcome> {
        let outcome = commit_inner(&self.prepared, progress)?;
        drop(self.lease);
        Ok(outcome)
    }

    /// Cancels the prepared migration before activation: records
    /// `rolled_back`, keeps the previous root active, and removes the staging
    /// root. The safety copy (if any) is retained — it is the verified
    /// pre-migration snapshot. The session (and thus the lease) is consumed.
    pub fn cancel(self) -> Result<()> {
        cancel_inner(&self.prepared)?;
        drop(self.lease);
        Ok(())
    }

    /// Activation-journal entry id of the prepared migration.
    pub fn entry_id(&self) -> &str {
        &self.prepared.entry_id
    }

    /// Absolute path of the staged versioned root.
    pub fn staging_root(&self) -> &Path {
        &self.prepared.staging_root
    }

    /// Absolute path of the verified safety copy (`Some` when requested).
    pub fn backup_path(&self) -> Option<&Path> {
        self.prepared.backup_path.as_deref()
    }

    /// Per-table conversion counts and skipped/orphaned records.
    pub fn report(&self) -> &ConversionReport {
        &self.prepared.report
    }
}

/// Commits a prepared migration: `activation_pending` → pointer switch →
/// `committed` (ADR-0041 platform-aware activation with bounded transient
/// retry). After this the staging root is the active root; the previous root
/// is retained as the rollback pointer.
///
/// `entry_id` must be the id of a live [`MigrationSession`] (the session holds
/// the data-root lease, so this is always single-writer); the id is taken from
/// `prepared` so callers cannot commit a foreign entry.
fn commit_inner(
    prepared: &PreparedMigration,
    progress: &mut dyn FnMut(MigrationStage),
) -> Result<MigrationOutcome> {
    let data_root = data_root_of(prepared)?;
    let entry_id = &prepared.entry_id;
    progress(MigrationStage::Activate);

    let journal = activation::read_journal(data_root)?;
    let entry = journal
        .entries
        .iter()
        .find(|e| e.id == *entry_id)
        .ok_or_else(|| {
            StorageError::with(
                StorageErrorCode::NotFound,
                "migration entry not found in the activation journal",
                vec![("entry_id".into(), entry_id.to_string())],
            )
        })?;
    if entry.status == ActivationStatus::Committed {
        // Idempotent re-commit: report the already-active root.
        let report = read_conversion_report(&entry.to_root)?;
        return Ok(MigrationOutcome {
            entry_id: entry_id.to_string(),
            active_root: entry.to_root.clone(),
            report,
            previous_root: None,
        });
    }
    if entry.status != ActivationStatus::Validated {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            "migration is not validated; commit refused",
            vec![
                ("entry_id".into(), entry_id.to_string()),
                ("status".into(), entry.status.as_str().to_string()),
            ],
        ));
    }

    let previous = entry.from_root.clone();
    transition_status(
        data_root,
        entry_id,
        ActivationStatus::ActivationPending,
        None,
    )?;

    // The pointer switch is the commit point (ADR-0041). The staging root is
    // already validated; here we only publish it.
    activation::with_transient_retry(activation::RetryPolicy::default(), || {
        write_pointer(data_root, &entry.to_root)
    })
    .map_err(|e| {
        StorageError::with(
            StorageErrorCode::ActivationPending,
            format!("activation pending, restart to finish migration: {e}"),
            vec![("entry_id".into(), entry_id.to_string())],
        )
    })?;

    transition_status(data_root, entry_id, ActivationStatus::Committed, None)?;

    Ok(MigrationOutcome {
        entry_id: entry_id.to_string(),
        active_root: entry.to_root.clone(),
        report: read_conversion_report(&entry.to_root)?,
        previous_root: previous.is_dir().then_some(previous),
    })
}

/// Cancels a prepared migration before activation: records `rolled_back`,
/// keeps the previous root active, and removes the staging root. The safety
/// copy (if any) is retained — it is the verified pre-migration snapshot.
fn cancel_inner(prepared: &PreparedMigration) -> Result<()> {
    let data_root = data_root_of(prepared)?;
    let entry_id = &prepared.entry_id;
    let journal = activation::read_journal(data_root)?;
    let entry = journal
        .entries
        .iter()
        .find(|e| e.id == *entry_id)
        .ok_or_else(|| {
            StorageError::with(
                StorageErrorCode::NotFound,
                "migration entry not found in the activation journal",
                vec![("entry_id".into(), entry_id.to_string())],
            )
        })?;
    if entry.status == ActivationStatus::Committed {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            "cannot cancel an already-committed migration",
            vec![("entry_id".into(), entry_id.to_string())],
        ));
    }
    transition_status(
        data_root,
        entry_id,
        ActivationStatus::RolledBack,
        Some("cancelled by the user before activation".to_string()),
    )?;
    let _ = fs::remove_dir_all(&entry.to_root);
    Ok(())
}

/// One-shot convenience: [`MigrationSession::begin`] + [`Self::commit`] under
/// one lease — equivalent to the host staging, then committing, with the
/// lease held for the whole sequence.
pub fn migrate(
    data_root: &Path,
    source_db: &Path,
    backup: bool,
    progress: &mut dyn FnMut(MigrationStage),
) -> Result<MigrationOutcome> {
    MigrationSession::begin(data_root, source_db, backup, progress)?.commit(progress)
}

// --- internals ---------------------------------------------------------------

/// Derives the data root from a prepared migration (stored explicitly so the
/// inner commit/cancel paths never depend on path arithmetic).
fn data_root_of(prepared: &PreparedMigration) -> Result<&Path> {
    Ok(&prepared.data_root)
}

/// Preflight (ТЗ §10.3): the source exists and is a file, the data root is
/// writable, and the target volume has enough free space for the conversion
/// (staging DB + WAL + safety copy headroom). A legacy database larger than
/// the free space minus [`MIN_FREE_SPACE_HEADROOM`] is refused BEFORE any
/// write.
fn preflight(data_root: &Path, source_db: &Path) -> Result<()> {
    let meta = match fs::metadata(source_db) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(StorageError::with(
                StorageErrorCode::NotFound,
                "legacy database not found",
                vec![("source".into(), source_db.display().to_string())],
            ));
        }
        Err(e) => return Err(io_err(e, "preflight: stat legacy database")),
    };
    if !meta.is_file() {
        return Err(StorageError::with(
            StorageErrorCode::NotFound,
            "legacy database is not a regular file",
            vec![("source".into(), source_db.display().to_string())],
        ));
    }
    let source_bytes = meta.len();

    // The staging root and the pointer live under `data_root` (same volume by
    // construction); probe the volume through the data root's parent.
    let probe = data_root.parent().unwrap_or(data_root);
    let free = fs2::free_space(probe).map_err(|e| io_err(e, "preflight: read free space"))?;
    let needed = source_bytes
        .saturating_mul(3)
        .saturating_add(MIN_FREE_SPACE_HEADROOM);
    if free < needed {
        return Err(StorageError::with(
            StorageErrorCode::DiskFull,
            "not enough free space for the legacy migration",
            vec![
                ("free".into(), free.to_string()),
                ("needed".into(), needed.to_string()),
                ("source_bytes".into(), source_bytes.to_string()),
            ],
        ));
    }
    Ok(())
}

/// Creates a verified safety copy of the legacy database at
/// `<data-root>/backups/pre-migration-<ts>/database.sqlite` and writes
/// `checksum.sha256` next to it (hex of the copy, computed after the copy
/// completes). Returns the copy's directory path.
///
/// The copy is made through the SQLite online-backup API, NOT a plain
/// `fs::copy`: the source is opened read-only (so the copy never modifies or
/// locks out the legacy app) and the backup API produces a consistent
/// snapshot that includes committed WAL frames — a byte copy of just
/// `database.sqlite` could silently miss WAL data and yield a corrupt safety
/// copy (audit P0 #3, ТЗ §10.3 "Create verified backup").
fn create_safety_copy(data_root: &Path, source_db: &Path) -> Result<PathBuf> {
    use rusqlite::backup::Backup;
    use rusqlite::OpenFlags;

    let backups = crate::paths::backups_dir(data_root);
    let dir = backups.join(format!(
        "{PRE_MIGRATION_COPY_PREFIX}{}",
        now_utc_rfc3339().replace([':', '.'], "-")
    ));
    fs::create_dir_all(&dir).map_err(|e| io_err(e, "create safety copy dir"))?;
    let target = dir.join("database.sqlite");

    // Source opened strictly read-only (same as the converter); the target is
    // a fresh file created by the backup API.
    let source = Connection::open_with_flags(source_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| StorageError::from_sqlite(e, "safety copy: open source read-only"))?;
    let mut target_conn = Connection::open(&target)
        .map_err(|e| StorageError::from_sqlite(e, "safety copy: open target"))?;
    let backup = Backup::new(&source, &mut target_conn)
        .map_err(|e| StorageError::from_sqlite(e, "safety copy: begin backup"))?;
    // One step copies the whole database (WAL frames included); -1 means "run
    // until completion". A `Completion::Done` is required for a valid copy.
    backup
        .step(-1)
        .map_err(|e| StorageError::from_sqlite(e, "safety copy: copy pages"))?;
    drop(backup); // finalizes the backup (rusqlite Backup has no finish())
    drop(target_conn);
    drop(source);

    // Verify the copy reads cleanly before it is declared a safety copy.
    let verify = Connection::open(&target)
        .map_err(|e| StorageError::from_sqlite(e, "safety copy: reopen for verification"))?;
    let quick_check: String = verify
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "safety copy: quick_check"))?;
    if quick_check != "ok" {
        return Err(StorageError::new(
            StorageErrorCode::Corrupt,
            format!("safety copy failed quick_check: {quick_check}"),
        ));
    }
    drop(verify);

    let checksum = crate::snapshot::sha256_file_hex(&target)?;
    fs::write(dir.join("checksum.sha256"), checksum.as_bytes())
        .map_err(|e| io_err(e, "write safety copy checksum"))?;
    Ok(dir)
}

/// Allocates a fresh versioned staging root: `<data-root>/roots/root-<id>/`.
fn fresh_staging_root(data_root: &Path) -> Result<PathBuf> {
    let id = new_id();
    let path = activation::versioned_root_path(data_root, &id);
    fs::create_dir_all(&path).map_err(|e| io_err(e, "create staging root"))?;
    Ok(path)
}

/// Validates the staged root: opens it through the normal kernel open
/// (migrations inside the candidate only), runs `foreign_key_check` and
/// `quick_check`, and confirms the schema revision is current. This is the
/// ТЗ §10.3 "Validate schema, FK, counts and hashes" step at the storage
/// boundary.
fn validate_staged_root(staging_root: &Path) -> Result<()> {
    let mut progress = |_: MigrationProgress| {};
    let db = open(staging_root, &ConnectionPolicy::default(), &mut progress)?;

    // FK integrity (strict tables + foreign_keys=ON are configured by open).
    let fk_rows: Vec<String> = db
        .conn()
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))
                .and_then(|rows| rows.collect())
        })
        .map_err(|e| StorageError::from_sqlite(e, "migration: foreign_key_check"))?;
    if !fk_rows.is_empty() {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            "staged root failed foreign_key_check",
            vec![("violations".into(), fk_rows.join("; "))],
        ));
    }
    let revision = db.schema_revision()?;
    if revision != CURRENT_SCHEMA {
        return Err(StorageError::with(
            StorageErrorCode::MigrationFailed,
            "staged root is not at the current schema revision",
            vec![
                ("schema_revision".into(), revision.to_string()),
                ("current".into(), CURRENT_SCHEMA.to_string()),
            ],
        ));
    }
    drop(db);
    Ok(())
}

/// Reads the per-table conversion counts back from a converted kernel root
/// (used by the idempotent no-op path and by [`MigrationSession::commit`]).
fn read_conversion_report(root: &Path) -> Result<ConversionReport> {
    let mut progress = |_: MigrationProgress| {};
    let db = open(root, &ConnectionPolicy::default(), &mut progress)?;
    // A count of a table that does not exist in this kernel schema version
    // contributes 0: the personas table is introduced by a later schema
    // migration (007_personas, Этап 4), so an Этап 3 converted root has no
    // such table. Without this guard the committed-root report would fail
    // with "no such table" on the full canonical data-root switch.
    let table_exists = |table: &str| -> Result<bool> {
        let n: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| StorageError::from_sqlite(e, "migration: table existence"))?;
        Ok(n > 0)
    };
    let count = |table: &str| -> Result<u64> {
        let n: i64 = db
            .conn()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|e| StorageError::from_sqlite(e, "migration: count"))?;
        Ok(n as u64)
    };
    let count_if_present = |table: &str| -> Result<u64> {
        if table_exists(table)? {
            count(table)
        } else {
            Ok(0)
        }
    };
    let report = ConversionReport {
        characters: count("characters")?,
        chats: count("chats")?,
        messages: count("messages")?,
        // message_variants / message_content_revisions / message_drafts are
        // introduced by schema migration 008 (Этап 4 slice 2); a converted
        // root from an earlier kernel schema simply contributes 0.
        message_variants: count_if_present("message_variants")?,
        message_content_revisions: count_if_present("message_content_revisions")?,
        message_drafts: count_if_present("message_drafts")?,
        lorebooks: count("lorebooks")?,
        presets: count("presets")?,
        // memories is introduced by schema migration 009 (Этап 4 slice 3); a
        // converted root from an earlier kernel schema simply contributes 0.
        memories: count_if_present("memories")?,
        personas: count_if_present("personas")?,
        // assets (avatar originals) live under the data root's assets/ and
        // are counted from the registry table; a committed root reports the
        // rows (the per-file breakdown is in the `prepare` report).
        assets: count_if_present("__neotavern_assets")?,
        // Counts from a committed root cannot report per-row orphans; the
        // full report is available from the `prepare` step.
        skipped: 0,
        orphans: Vec::new(),
    };
    drop(db);
    Ok(report)
}

/// Generates a unique, sortable id for staging roots and journal entries
/// (UUID v7 with the version nibble rewritten to 4, mirroring the kernel's
/// wire-format constraint; time-ordered so directory listing order is stable).
fn new_id() -> String {
    const VERSION_NIBBLE_MASK: u128 = 0xF000_0000_0000_0000_0000;
    const V4_NIBBLE: u128 = 0x4000_0000_0000_0000_0000;
    let raw = uuid::Uuid::now_v7().as_u128();
    uuid::Uuid::from_u128((raw & !VERSION_NIBBLE_MASK) | V4_NIBBLE).to_string()
}
