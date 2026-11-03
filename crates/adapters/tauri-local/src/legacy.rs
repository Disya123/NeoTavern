//! Desktop legacy-import host commands (release gates G7/G8, user-facing
//! half; ADR-0062).
//!
//! The Settings → Data flow runs the ADR-0062 staged-root lifecycle over the
//! kernel's data root while the kernel stays open: `plan` is a dry run,
//! `execute` stages + validates + activates (the root pointer moves; the
//! switch applies on the next app start — the running kernel keeps serving
//! its open database, proven by the packaged smoke's migration walk), and
//! `rollback` returns the pointer to the previous root.
//!
//! These are HOST commands, not Product Wire operations: they read a
//! user-picked legacy `app.db` from the filesystem and write only inside the
//! kernel data root, so they live at the adapter boundary (ТЗ §2: host /
//! HTTP-boundary concerns stay out of the kernel).

use std::path::{Path, PathBuf};

use neotavern_storage::{activation, legacy_import};
use serde::{Deserialize, Serialize};

/// One entity family in an import report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyFamilyReport {
    /// Kernel family name (mirrors the receipt's `entity_family`).
    pub family: String,
    /// Rows in the legacy source (plan) or converted rows (execute).
    pub count: u64,
    /// `false` when a mandatory family's table is missing from the source.
    pub present: bool,
}

/// `legacy_import_plan` result: what an import WOULD copy. Reading the
/// source is the only side effect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyImportPlanReport {
    /// Absolute path of the inspected source database.
    pub source_db: String,
    /// `true` when `execute` may be called.
    pub ready: bool,
    /// Why the run group refuses the import, when it does.
    pub problems: Vec<String>,
    /// Per-family source row counts.
    pub families: Vec<LegacyFamilyReport>,
}

/// `legacy_import_execute` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyImportExecuteReport {
    /// Root id of the staged + activated import root (`root-<id>`).
    pub staged_root_id: String,
    /// Absolute path the root pointer pointed at before activation (the
    /// rollback target).
    pub previous_root: String,
    /// Per-family converted row counts.
    pub families: Vec<LegacyFamilyReport>,
    /// Always `true`: the running kernel keeps serving the database it
    /// opened; the app must restart to switch to the imported root.
    pub restart_required: bool,
}

/// `legacy_import_rollback` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyRollbackReport {
    /// Absolute path of the root the pointer was restored to.
    pub restored_root: String,
    /// Always `true`: applies on the next app start.
    pub restart_required: bool,
}

/// Stable machine-readable failure of a legacy host operation (AGENTS §5:
/// the frontend localizes; the code is the contract).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyOpError {
    pub code: &'static str,
    pub message: String,
}

impl LegacyOpError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for LegacyOpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

fn storage_error(error: neotavern_storage::StorageError, op: &'static str) -> LegacyOpError {
    LegacyOpError::new("LEGACY_STORAGE", format!("{op}: {error}"))
}

/// Dry-runs the import: reads the source, reports per-family counts and
/// readiness. Writes nothing.
pub fn plan_import(source: &Path) -> Result<LegacyImportPlanReport, LegacyOpError> {
    let plan = legacy_import::plan(source)
        .map_err(|error| LegacyOpError::new("LEGACY_SOURCE_UNREADABLE", error.to_string()))?;
    Ok(LegacyImportPlanReport {
        source_db: plan.source_db.display().to_string(),
        ready: plan.ready,
        problems: plan.problems,
        families: plan
            .families
            .iter()
            .map(|family| LegacyFamilyReport {
                family: family.family.to_string(),
                count: family.count,
                present: family.present,
            })
            .collect(),
    })
}

/// Stages, validates and activates the import against `data_root`. The root
/// pointer moves immediately; the running kernel is untouched (restart
/// applies). The previous root is returned as the rollback target.
pub fn execute_import(
    data_root: &Path,
    source: &Path,
) -> Result<LegacyImportExecuteReport, LegacyOpError> {
    let previous = activation::active_root(data_root)
        .map_err(|error| storage_error(error, "resolve active root"))?;
    let staged =
        legacy_import::stage(source, data_root).map_err(|error| storage_error(error, "stage"))?;
    legacy_import::validate_staged(&staged)
        .map_err(|error| storage_error(error, "validate staged root"))?;
    legacy_import::activate_staged(data_root, &staged, &previous)
        .map_err(|error| storage_error(error, "activate"))?;
    Ok(LegacyImportExecuteReport {
        staged_root_id: staged.root_id.clone(),
        previous_root: previous.display().to_string(),
        families: conversion_report_families(&staged.report),
        restart_required: true,
    })
}

/// Flattens the converter's named-field report into the per-family rows the
/// Settings UI shows (stable order, one row per copied family).
fn conversion_report_families(
    report: &neotavern_storage::legacy::ConversionReport,
) -> Vec<LegacyFamilyReport> {
    #[inline]
    fn row(family: &str, count: u64) -> LegacyFamilyReport {
        LegacyFamilyReport {
            family: family.to_string(),
            count,
            present: true,
        }
    }
    vec![
        row("characters", report.characters),
        row("chats", report.chats),
        row("messages", report.messages),
        row("message_variants", report.message_variants),
        row(
            "message_content_revisions",
            report.message_content_revisions,
        ),
        row("message_drafts", report.message_drafts),
        row("lorebooks", report.lorebooks),
        row("presets", report.presets),
        row("memories", report.memories),
        row("personas", report.personas),
    ]
}

/// Restores the root pointer to where the last committed IMPORT switched
/// from. The target is the journal's `fromRoot` (it may be the flat data
/// root itself — the pre-first-import layout), so exactly one rollback per
/// import: a second call refuses (`LEGACY_NO_ROLLBACK_TARGET`). Applies on
/// the next app start.
pub fn rollback_import(data_root: &Path) -> Result<LegacyRollbackReport, LegacyOpError> {
    let refusal = || {
        LegacyOpError::new(
            "LEGACY_NO_ROLLBACK_TARGET",
            "the last journal entry is not a committed import to roll back",
        )
    };
    let entry = activation::latest_entry(data_root)
        .map_err(|error| storage_error(error, "read journal"))?
        .ok_or_else(refusal)?;
    if entry.kind != "import" || entry.status != activation::ActivationStatus::Committed {
        return Err(refusal());
    }
    activation::rollback_to(data_root, &entry.from_root)
        .map_err(|error| storage_error(error, "rollback"))?;
    Ok(LegacyRollbackReport {
        restored_root: entry.from_root.display().to_string(),
        restart_required: true,
    })
}

/// The kernel data root this host owns, when it owns one (stateless hosts
/// serve none and refuse the legacy ops).
pub fn host_data_root(host: &crate::KernelHost) -> Result<PathBuf, LegacyOpError> {
    host.data_root().map(Path::to_path_buf).ok_or_else(|| {
        LegacyOpError::new(
            "LEGACY_NO_DATA_ROOT",
            "the host kernel runs stateless and owns no data root",
        )
    })
}
