//! Staged legacy `app.db` import (ADR-0062) — the release-gate G7 data plane.
//!
//! The importer never touches the active data root: it converts the legacy
//! database into a NEW staged versioned root (ADR-0041
//! `roots/root-<id>/`), records per-family receipts in that root's
//! `import_receipts` ledger (v31), validates the mandatory run group
//! (integrity, foreign keys, counts, receipts) and only then hands the root
//! to [`crate::activation::activate`] with `kind: "import"`. A failure at any
//! point leaves the staged root on disk for inspection and the previous root
//! active — "keep the old root" is the rollback.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::activation;
use crate::baseline::ConnectionPolicy;
use crate::error::{Result, StorageError, StorageErrorCode};
use crate::legacy::{convert_legacy, ConversionReport};
use crate::migrations::MigrationProgress;
use crate::restore::Candidate;

/// The families a legacy source MUST provide (the mandatory run group,
/// ADR-0062: if any refuses, the whole run refuses before any commit).
/// `personas`, `memories` and `settings` are optional in old sources and are
/// reported with count 0 when absent, never as failures.
const MANDATORY_FAMILIES: [&str; 5] = ["characters", "chats", "messages", "lorebooks", "presets"];
/// Families counted for the plan/receipts beyond the mandatory group.
const OPTIONAL_FAMILIES: [&str; 3] = ["personas", "memories", "settings"];

/// Source-row counts (and fingerprints) of one entity family.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamilyPlan {
    /// Kernel family name (also the `entity_family` receipt value).
    pub family: &'static str,
    /// Rows in the legacy source (`0` for an absent optional table).
    pub count: u64,
    /// sha256 over the source ids sorted lexically — the receipt's
    /// `source_checksum`, so a later plan against a changed source is a
    /// different fingerprint. Absent for optional families that do not exist.
    pub fingerprint: Option<String>,
    /// `false` when the mandatory family's table is missing from the source.
    pub present: bool,
}

/// Dry-run result: what a staged import WOULD copy. Reading the source is the
/// only side effect; nothing is written anywhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyImportPlan {
    pub source_db: PathBuf,
    pub families: Vec<FamilyPlan>,
    /// Why the run group refuses the import, when it does.
    pub problems: Vec<String>,
    /// `true` when [`stage`] may be called.
    pub ready: bool,
}

/// One staged, validated import, ready for activation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedImport {
    /// Root id (`root-<id>` directory name suffix); also the journal entry id
    /// and the receipts' `run_id`.
    pub root_id: String,
    /// Absolute path of the staged root (`<data-root>/roots/root-<id>/`).
    pub staged_root: PathBuf,
    /// Per-family row counts reported by the converter.
    pub report: ConversionReport,
}

fn open_legacy_readonly(source_db: &Path) -> Result<Connection> {
    Connection::open_with_flags(source_db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| StorageError::from_sqlite(e, "legacy import: open source read-only"))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    let found: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get(0),
        )
        .map_err(|e| StorageError::from_sqlite(e, "legacy import: table lookup"))?;
    Ok(found > 0)
}

/// sha256 over the family's source ids sorted lexically (`,`-joined): a
/// deterministic fingerprint of exactly which rows the import saw.
fn family_fingerprint(conn: &Connection, table: &str) -> Result<String> {
    let mut statement = conn
        .prepare(&format!("SELECT id FROM {table} ORDER BY id"))
        .map_err(|e| StorageError::from_sqlite(e, "legacy import: fingerprint query"))?;
    let mut hasher = Sha256::new();
    let mut first = true;
    let rows = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| StorageError::from_sqlite(e, "legacy import: fingerprint rows"))?;
    for id in rows {
        let id = id.map_err(|e| StorageError::from_sqlite(e, "legacy import: fingerprint row"))?;
        if !first {
            hasher.update(b",");
        }
        hasher.update(id.as_bytes());
        first = false;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn count_rows(conn: &Connection, table: &str) -> Result<u64> {
    let count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "legacy import: count query"))?;
    Ok(u64::try_from(count).unwrap_or(0))
}

/// Dry-run: counts every family in the legacy source and checks the mandatory
/// run group. Writes nothing anywhere.
pub fn plan(source_db: &Path) -> Result<LegacyImportPlan> {
    let legacy = open_legacy_readonly(source_db)?;
    let mut families = Vec::new();
    let mut problems = Vec::new();

    for family in MANDATORY_FAMILIES {
        if !table_exists(&legacy, family)? {
            problems.push(format!("mandatory legacy table {family} is missing"));
            families.push(FamilyPlan {
                family,
                count: 0,
                fingerprint: None,
                present: false,
            });
            continue;
        }
        let count = count_rows(&legacy, family)?;
        let fingerprint = family_fingerprint(&legacy, family)?;
        if count == 0 {
            problems.push(format!("mandatory legacy table {family} has no rows"));
        }
        families.push(FamilyPlan {
            family,
            count,
            fingerprint: Some(fingerprint),
            present: true,
        });
    }
    for family in OPTIONAL_FAMILIES {
        let present = table_exists(&legacy, family)?;
        let count = if present {
            count_rows(&legacy, family)?
        } else {
            0
        };
        let fingerprint = if present {
            Some(family_fingerprint(&legacy, family)?)
        } else {
            None
        };
        families.push(FamilyPlan {
            family,
            count,
            fingerprint,
            present,
        });
    }

    let ready = problems.is_empty();
    Ok(LegacyImportPlan {
        source_db: source_db.to_path_buf(),
        families,
        problems,
        ready,
    })
}

/// Stages the import: converts the legacy source into a new staged root under
/// `<data-root>/roots/root-<id>/` (fresh kernel schema, single conversion
/// transaction) and records one receipt per imported family in that root's
/// ledger. The active root and the activation journal are untouched; a failed
/// conversion leaves the partial staged directory in place for inspection and
/// returns the error.
pub fn stage(source_db: &Path, data_root: &Path) -> Result<StagedImport> {
    let plan = plan(source_db)?;
    if !plan.ready {
        return Err(StorageError::with(
            StorageErrorCode::UnsupportedStorageFormat,
            "legacy source fails the mandatory run group",
            plan.problems
                .into_iter()
                .map(|p| ("problem".into(), p))
                .collect(),
        ));
    }

    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let root_id = format!("import-{millis}");
    let staged_root = activation::versioned_root_path(data_root, &root_id);
    std::fs::create_dir_all(&staged_root).map_err(|e| {
        StorageError::with(
            StorageErrorCode::Io,
            format!("legacy import: create staged root failed: {e}"),
            vec![],
        )
    })?;

    let report = convert_legacy(
        source_db,
        &Candidate {
            path: staged_root.clone(),
        },
    )?;

    // Receipts: one row per family the conversion actually imported, with the
    // source fingerprint recorded so a later run against a changed source is a
    // detectable conflict, not a silent overwrite.
    let staged = {
        let mut progress = |_: MigrationProgress| {};
        crate::open::open(&staged_root, &ConnectionPolicy::default(), &mut progress)?
    };
    {
        let tx = staged.conn();
        for family in &plan.families {
            let imported = family_count(&report, family.family);
            if imported == 0 {
                continue;
            }
            let fingerprint = family.fingerprint.as_deref().unwrap_or("absent");
            tx.execute(
                "INSERT INTO import_receipts
                 (id, run_id, entity_family, source_id, target_id, source_checksum, imported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    format!("rcpt-{}", family.family),
                    root_id,
                    family.family,
                    format!("family:{}", family.family),
                    root_id,
                    fingerprint,
                    crate::now_utc_rfc3339(),
                ],
            )
            .map_err(|e| StorageError::from_sqlite(e, "legacy import: write receipt"))?;
        }
    }
    drop(staged);

    Ok(StagedImport {
        root_id,
        staged_root,
        report,
    })
}

fn family_count(report: &ConversionReport, family: &str) -> u64 {
    match family {
        "characters" => report.characters,
        "chats" => report.chats,
        "messages" => report.messages,
        "message_variants" => report.message_variants,
        "message_content_revisions" => report.message_content_revisions,
        "message_drafts" => report.message_drafts,
        "lorebooks" => report.lorebooks,
        "presets" => report.presets,
        "memories" => report.memories,
        "personas" => report.personas,
        "settings" => report.settings,
        _ => 0,
    }
}

/// Validates a staged root BEFORE activation: SQLite integrity, no foreign-key
/// violations, target counts equal to the conversion report, and a receipt for
/// every family that has rows.
pub fn validate_staged(staged: &StagedImport) -> Result<()> {
    let conn = Connection::open_with_flags(
        crate::paths::db_path(&staged.staged_root),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| StorageError::from_sqlite(e, "legacy import: open staged root"))?;

    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "legacy import: integrity_check"))?;
    if integrity != "ok" {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("staged root failed integrity_check: {integrity}"),
            vec![],
        ));
    }
    let fk_violations: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .map_err(|e| StorageError::from_sqlite(e, "legacy import: foreign_key_check"))?;
    if fk_violations != 0 {
        return Err(StorageError::with(
            StorageErrorCode::IntegrityViolation,
            format!("staged root has {fk_violations} foreign-key violations"),
            vec![],
        ));
    }

    for family in [
        "characters",
        "chats",
        "messages",
        "message_variants",
        "message_content_revisions",
        "message_drafts",
        "lorebooks",
        "presets",
        "memories",
        "personas",
        "settings",
    ] {
        let expected = family_count(&staged.report, family);
        if !table_exists(&conn, family)? {
            if expected == 0 {
                continue;
            }
            return Err(StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!("staged root is missing family table {family}"),
                vec![],
            ));
        }
        let actual = count_rows(&conn, family)?;
        if actual != expected {
            return Err(StorageError::with(
                StorageErrorCode::IntegrityViolation,
                format!(
                    "staged root family {family} has {actual} rows, converter reported {expected}"
                ),
                vec![],
            ));
        }
        if expected > 0 {
            let receipts: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM import_receipts WHERE entity_family = ?1",
                    [family],
                    |r| r.get(0),
                )
                .map_err(|e| StorageError::from_sqlite(e, "legacy import: receipt lookup"))?;
            if receipts != 1 {
                return Err(StorageError::with(
                    StorageErrorCode::IntegrityViolation,
                    format!("family {family} has {receipts} receipts, expected 1"),
                    vec![],
                ));
            }
        }
    }
    Ok(())
}

/// Activates a staged import through the ADR-0041 journal (`kind: "import"`):
/// validation runs first; a failed pointer switch leaves `activation_pending`
/// (restart-to-complete), anything earlier keeps the previous root active.
pub fn activate_staged(data_root: &Path, staged: &StagedImport, from_root: &Path) -> Result<()> {
    validate_staged(staged)?;
    activation::activate(
        data_root,
        &staged.root_id,
        "import",
        from_root,
        &staged.staged_root,
    )
}
