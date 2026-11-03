//! Этап 4.5 cluster 10: full-data archive import
//! (`imports.fullbackup.execute`) — the destructive half of cutover-registry
//! row 10.
//!
//! The archive is the SAME staged asset the analysis read (`assetId` produced
//! by the chunked `assets.put` ingestion contract, ADR-0061), opened read-only.
//! Nothing is extracted to disk: bytes go straight from the ZIP into the
//! product tables or into the content-addressed asset store, so a multi-gigabyte
//! backup never becomes a second copy of itself on the data root.
//!
//! ## What lands where
//!
//! | Category | Destination |
//! |----------|-------------|
//! | characters | `characters` (+ `avatar` asset, full card under `ext_json._card`) |
//! | chats | `chats` + `messages` (+ `personas` link when the archive has it) |
//! | personas | `personas` (+ `avatar` asset) |
//! | lorebooks | `lorebooks` (`entries_json` keeps every entry object) |
//! | presets | `presets` (legacy directory → kind map, settings verbatim) |
//! | groups | `settings` document `fullbackup.groups` (no kernel group model) |
//! | backgrounds | `background` assets (the canonical wallpaper kind) |
//! | extensionSettings | `settings` document `fullbackup.extension_settings` |
//! | apiSettings | `settings` document `fullbackup.api_settings` (never secrets) |
//! | themes | `theme-css` / `theme-json` assets, ready for `themes.install` |
//! | legacyExtensions | NOT imported (ADR-0059) — analysis warning only |
//!
//! The three document categories are preserved verbatim instead of fake-modelled:
//! the kernel owns no group table, no extension-settings store and no
//! unsolicited provider-config registry, so inventing rows in `presets` or
//! `provider_configs` would corrupt real product surface. A settings document is
//! bounded (one row), non-secret, readable through `settings.get` and reversible
//! — and every run that writes one says so with `*_PRESERVED_NOT_MODELED`.
//!
//! ## Conflict policy
//!
//! `conflictPolicy` mirrors the legacy `DataImportConflictPolicy`
//! (`skip`/`copy`/`merge`/`replace`) and is required: execute writes product
//! data, so there is no silent default. A conflict is a target row this archive
//! did NOT create (same character/lorebook/preset/persona name, or a chat whose
//! source path was imported from different bytes). Entities are resolved in this
//! order:
//!
//! 1. **Receipt** — `import_receipts` (schema v31) records
//!    `(entity_family, source_id) → target_id` plus the entity's own sha256. A
//!    receipt with the SAME checksum is `reused` under every policy: nothing is
//!    touched, which is what makes re-running the same archive idempotent (and
//!    is the legacy `preserve` policy).
//! 2. **Content dedupe** — a character whose card bytes are already in the
//!    library (`characters.import_hash`, i.e. previously imported through
//!    `imports.character.card`) is `reused`, never duplicated (AGENTS.md §11).
//! 3. **Name conflict** — otherwise a case-insensitive name match that is not
//!    this source's target is resolved by the policy: `skip` keeps the existing
//!    row (`conflicted` + `skipped`), `copy` writes a second row under the same
//!    name, `merge` fills the existing row's empty fields from the archive, and
//!    `replace` overwrites it after snapshotting a character into
//!    `character_versions` so the overwrite stays reversible.
//!
//! Receipts are written only for rows this run actually wrote, so a `skip`ped
//! conflict is still a conflict on the next run instead of silently becoming
//! "already imported".
//!
//! ## No silent partial success
//!
//! Every discovered entity lands in exactly one of `imported` / `reused` /
//! `skipped` / `invalid`, so `discovered == imported + reused + skipped +
//! invalid` holds per category and the counters reconcile against
//! `imports.fullbackup.analyze`. `conflicted` is an overlay (it may overlap
//! `imported`), `dependentImported` counts nested rows, and every entity that
//! could not be imported as-is raises a stable warning code (the response keeps
//! a bounded 64-entry sample plus the full `warningCount`).
//!
//! ## Deliberate limits
//!
//! - Secrets are never imported: `secrets.json` is skipped with
//!   `SECRETS_SKIPPED` (the kernel has its own secret store, ТЗ §9.4).
//! - legacy full-data-era extensions are never installed (ADR-0059).
//! - Message timestamps fall back to the import time when legacy full-data's
//!   `send_date` is not RFC 3339 (its format is locale-dependent); transcript
//!   ORDER is always preserved by `messages.sequence`.
//! - The transaction boundary is one entity, not one archive: a 4 GiB import
//!   must stay resumable, and a single bad card must not roll back a whole
//!   library. Receipts make the resume exact.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};

use contracts_generated::generated::{
    self, ImportsFullbackupCategory, ImportsFullbackupCategoryExecute,
    ImportsFullbackupConflictPolicy, ImportsFullbackupTotals, ImportsFullbackupWarning,
    ResultImportsFullbackupExecute,
};
use neotavern_storage::open::Database;
use neotavern_storage::{StorageError, StorageErrorCode};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::imports_full_backup::{
    category_index, data_root_missing, detect_root, index_archive, is_unsafe_path, storage, Entry,
    CATEGORY_ORDER, IMAGE_EXTENSIONS, MAX_BACKGROUND_BYTES, MAX_CHARACTER_BYTES,
    MAX_CHAT_LINE_CHARS, MAX_PRESET_BYTES, MAX_SETTINGS_BYTES, MAX_WARNING_SAMPLE, MAX_WORLD_BYTES,
    PRESET_DIRECTORIES,
};
use crate::{KernelError, KernelErrorCode};

/// Receipt families. Prefixed so they can never be confused with the legacy
/// `app.db` conversion families the same ledger records (ADR-0062), whose
/// `source_id` is `family:<name>`.
const RECEIPT_CHARACTER: &str = "fullbackup.character";
const RECEIPT_CHAT: &str = "fullbackup.chat";
const RECEIPT_PERSONA: &str = "fullbackup.persona";
const RECEIPT_LOREBOOK: &str = "fullbackup.lorebook";
const RECEIPT_PRESET: &str = "fullbackup.preset";

/// Non-secret settings documents for the categories the kernel does not model.
const SETTINGS_GROUPS: &str = "fullbackup.groups";
const SETTINGS_EXTENSION_SETTINGS: &str = "fullbackup.extension_settings";
const SETTINGS_API_SETTINGS: &str = "fullbackup.api_settings";

/// Legacy preset directory → kernel `presets.kind` (same map the analyzer and
/// the legacy importer use).
const PRESET_KINDS: [(&str, &str); 8] = [
    ("instruct", "instruct"),
    ("context", "context"),
    ("sysprompt", "system-prompt"),
    ("reasoning", "reasoning"),
    ("koboldai settings", "koboldai"),
    ("novelai settings", "novelai"),
    ("openai settings", "openai"),
    ("textgen settings", "textgen"),
];

/// The primary counter a discovered entity lands in. Exactly one per entity, so
/// the per-category sum reconciles with the analysis.
#[derive(Clone, Copy)]
enum Outcome {
    Imported,
    Reused,
    Skipped,
    Invalid,
}

/// Import state for one run: counters, bounded warnings and the receipt group.
struct Execution {
    run_id: String,
    policy: ImportsFullbackupConflictPolicy,
    now: String,
    selected: [bool; 11],
    categories: [ImportsFullbackupCategoryExecute; 11],
    warnings: Vec<ImportsFullbackupWarning>,
    warning_count: i64,
    wrote: bool,
    saw: bool,
}

impl Execution {
    fn new(policy: ImportsFullbackupConflictPolicy, selected: [bool; 11]) -> Self {
        Self {
            run_id: crate::product::new_id(),
            policy,
            now: neotavern_storage::now_utc_rfc3339(),
            selected,
            categories: CATEGORY_ORDER.map(|id| ImportsFullbackupCategoryExecute {
                id,
                imported: 0,
                reused: 0,
                skipped: 0,
                conflicted: 0,
                invalid: 0,
                dependent_imported: 0,
            }),
            warnings: Vec::new(),
            warning_count: 0,
            wrote: false,
            saw: false,
        }
    }

    fn selected(&self, id: ImportsFullbackupCategory) -> bool {
        self.selected[category_index(id)]
    }

    fn bump(&mut self, id: ImportsFullbackupCategory, outcome: Outcome) {
        self.saw = true;
        let row = &mut self.categories[category_index(id)];
        match outcome {
            Outcome::Imported => {
                row.imported += 1;
                self.wrote = true;
            }
            Outcome::Reused => row.reused += 1,
            Outcome::Skipped => row.skipped += 1,
            Outcome::Invalid => row.invalid += 1,
        }
    }

    fn conflict(&mut self, id: ImportsFullbackupCategory) {
        self.saw = true;
        self.categories[category_index(id)].conflicted += 1;
    }

    fn dependent(&mut self, id: ImportsFullbackupCategory, count: i64) {
        self.categories[category_index(id)].dependent_imported += count;
    }

    fn warn(&mut self, code: &str, path: Option<&str>) {
        self.warning_count += 1;
        if self.warnings.len() < MAX_WARNING_SAMPLE {
            self.warnings.push(ImportsFullbackupWarning {
                code: code.to_string(),
                path: path.map(str::to_string),
            });
        }
    }

    fn totals(&self) -> ImportsFullbackupTotals {
        let mut totals = ImportsFullbackupTotals {
            imported: 0,
            reused: 0,
            skipped: 0,
            conflicted: 0,
            invalid: 0,
        };
        for row in &self.categories {
            totals.imported += row.imported;
            totals.reused += row.reused;
            totals.skipped += row.skipped;
            totals.conflicted += row.conflicted;
            totals.invalid += row.invalid;
        }
        totals
    }
}

/// `imports.fullbackup.execute` — import a staged legacy full-data user-data
/// archive into the canonical product tables.
///
/// Errors: `ASSET_NOT_FOUND` for an unknown staged asset, `VALIDATION` for a
/// non-ZIP archive (`reason: FULLBACKUP_ARCHIVE_INVALID`) or an explicitly
/// requested unsupported category (`reason: FULLBACKUP_CATEGORY_UNSUPPORTED`),
/// and `FULLBACKUP_DATA_ROOT_NOT_FOUND` when the archive has no recognisable
/// user-data root. Per-entity problems never abort the run: they land in the
/// counters and the warning sample.
pub fn imports_fullbackup_execute(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_imports_fullbackup_execute(request)?;
    let selected = select_categories(req.categories.as_deref())?;

    // 1. The staged archive: the same asset the analysis read, opened read-only.
    let row: Option<(String, String)> = db
        .conn()
        .query_row(
            "SELECT relative_key, checksum_sha256 FROM __neotavern_assets WHERE id = ?1",
            rusqlite::params![req.asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| sqlite(err, "imports.fullbackup.execute: asset lookup"))?;
    let (relative_key, source_hash) =
        row.ok_or_else(|| crate::assets::asset_not_found(&req.asset_id))?;

    let path = neotavern_storage::assets::resolve_asset_path(db, &relative_key)
        .map_err(|err| storage(format!("imports.fullbackup.execute: {err}")))?;
    let file = File::open(&path)
        .map_err(|err| storage(format!("imports.fullbackup.execute: cannot open: {err}")))?;
    let mut archive = ZipArchive::new(file).map_err(|err| {
        validation(
            "FULLBACKUP_ARCHIVE_INVALID",
            &format!("not a readable zip: {err}"),
        )
    })?;

    // 2. Index the central directory and locate the user-data root.
    let index = index_archive(&mut archive)?;
    let entries = &index.entries;
    let root = detect_root(entries, &index.dirs).ok_or_else(data_root_missing)?;

    let mut exec = Execution::new(req.conflict_policy.clone(), selected);

    // 3. Archive-level honesty: the same facts the analysis reported.
    if entries
        .iter()
        .any(|entry| !entry.is_dir && entry.lower == format!("{root}secrets.json"))
    {
        exec.warn("SECRETS_SKIPPED", Some(&format!("{root}secrets.json")));
    }
    if entries
        .iter()
        .any(|entry| !entry.is_dir && entry.lower.starts_with(&format!("{root}extensions/")))
    {
        exec.warn(
            "LEGACY_EXTENSIONS_SKIPPED",
            Some(&format!("{root}extensions")),
        );
    }
    if entries
        .iter()
        .any(|entry| !entry.is_dir && entry.lower == format!("{root}settings.json"))
    {
        exec.warn(
            "SETTINGS_PARTIALLY_IMPORTED",
            Some(&format!("{root}settings.json")),
        );
    }
    for entry in entries {
        if !entry.is_dir && is_unsafe_path(&entry.name) {
            exec.warn("ARCHIVE_ENTRY_UNSAFE", Some(&entry.name));
        }
    }

    // 4. Import in dependency order: characters and personas first (chats bind
    //    to both), then the independent buckets.
    if exec.selected(ImportsFullbackupCategory::Characters) {
        import_characters(&mut archive, entries, &root, db, &mut exec)?;
    }
    if exec.selected(ImportsFullbackupCategory::Personas) {
        import_personas(&mut archive, entries, &root, db, &mut exec)?;
    }
    if exec.selected(ImportsFullbackupCategory::Chats) {
        import_chats(&mut archive, entries, &root, db, &mut exec)?;
    }
    if exec.selected(ImportsFullbackupCategory::Lorebooks) {
        import_lorebooks(&mut archive, entries, &root, db, &mut exec)?;
    }
    if exec.selected(ImportsFullbackupCategory::Presets) {
        import_presets(&mut archive, entries, &root, db, &mut exec)?;
    }
    if exec.selected(ImportsFullbackupCategory::Groups) {
        import_groups(&mut archive, entries, &root, db, &mut exec)?;
    }
    if exec.selected(ImportsFullbackupCategory::Backgrounds) {
        import_backgrounds(&mut archive, entries, &root, db, &mut exec)?;
    }
    if exec.selected(ImportsFullbackupCategory::ExtensionSettings) {
        import_extension_settings(&mut archive, entries, &root, db, &mut exec)?;
    }
    if exec.selected(ImportsFullbackupCategory::ApiSettings) {
        import_api_settings(&mut archive, entries, &root, db, &mut exec)?;
    }
    if exec.selected(ImportsFullbackupCategory::Themes) {
        import_themes(&mut archive, entries, &root, db, &mut exec)?;
    }

    let totals = exec.totals();
    let dto = ResultImportsFullbackupExecute {
        run_id: exec.run_id,
        source_hash,
        conflict_policy: exec.policy.clone(),
        archive_already_imported: exec.saw && !exec.wrote,
        categories: exec.categories.to_vec(),
        totals,
        warning_count: exec.warning_count,
        warnings: exec.warnings,
    };
    crate::product::validate(&dto, generated::validate_result_imports_fullbackup_execute)?;
    crate::product::encode(&dto)
}

/// Resolves the requested category subset. Absent = every supported category;
/// `legacyExtensions` is refused when explicitly requested (ADR-0059) instead of
/// being silently dropped.
fn select_categories(
    requested: Option<&[ImportsFullbackupCategory]>,
) -> Result<[bool; 11], KernelError> {
    let mut selected = [true; 11];
    selected[category_index(ImportsFullbackupCategory::LegacyExtensions)] = false;
    if let Some(list) = requested {
        selected = [false; 11];
        for id in list {
            if *id == ImportsFullbackupCategory::LegacyExtensions {
                return Err(validation(
                    "FULLBACKUP_CATEGORY_UNSUPPORTED",
                    "legacyExtensions are not importable (ADR-0059)",
                ));
            }
            selected[category_index(id.clone())] = true;
        }
    }
    Ok(selected)
}

// --- characters -------------------------------------------------------------

fn import_characters(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let prefix = format!("{root}characters/");
    let names: Vec<String> = entries
        .iter()
        .filter(|entry| {
            !entry.is_dir
                && entry.lower.starts_with(&prefix)
                && (entry.lower.ends_with(".png") || entry.lower.ends_with(".json"))
        })
        .map(|entry| entry.name.clone())
        .collect();

    for name in &names {
        let lower = name.to_lowercase();
        // The `.json` sibling of a `.png` card describes the same character.
        if lower.ends_with(".json")
            && names
                .iter()
                .any(|other| other.to_lowercase() == lower.replace(".json", ".png"))
        {
            continue;
        }
        let stem = lower
            .trim_start_matches(&prefix)
            .rsplit_once('.')
            .map(|(stem, _)| stem.to_string())
            .unwrap_or_else(|| lower.trim_start_matches(&prefix).to_string());
        let source_id = format!("characters/{stem}");

        exec.saw = true;
        let Some(bytes) = read_entry(archive, name, MAX_CHARACTER_BYTES as u64) else {
            exec.bump(ImportsFullbackupCategory::Characters, Outcome::Invalid);
            exec.warn("CHARACTER_TOO_LARGE", Some(name));
            continue;
        };
        let checksum = sha256_hex(&bytes);

        // 1. This exact source was imported by an earlier run.
        if let Some((target, seen)) = receipt(db, RECEIPT_CHARACTER, &source_id)? {
            if seen == checksum && target_exists(db, "characters", &target)? {
                exec.bump(ImportsFullbackupCategory::Characters, Outcome::Reused);
                continue;
            }
        }

        // 2. Parse the card.
        let parsed = match parse_import_card(&bytes) {
            Ok(parsed) => parsed,
            Err(_) => {
                exec.bump(ImportsFullbackupCategory::Characters, Outcome::Invalid);
                exec.warn("CHARACTER_IMPORT_FAILED", Some(name));
                continue;
            }
        };
        let mut card_name = parsed.name.trim().to_string();
        if card_name.is_empty() {
            card_name = stem.rsplit('/').next().unwrap_or("Character").to_string();
            exec.warn("CHARACTER_NAME_MISSING", Some(name));
        }
        let ext_json = character_ext(&parsed.card, name, &checksum);
        let tags_json = serde_json::to_string(&parsed.tags).map_err(|err| {
            KernelError::new(
                KernelErrorCode::Internal,
                format!("imports.fullbackup.execute: serialize tags: {err}"),
            )
        })?;
        let avatar_bytes = bytes
            .starts_with(&PNG_SIGNATURE)
            .then_some(bytes.as_slice());

        // 3. The same card bytes are already in the library
        //    (`imports.character.card` deduplicates on the same hash).
        let by_hash: Option<String> = db
            .conn()
            .query_row(
                "SELECT id FROM characters WHERE import_hash = ?1 LIMIT 1",
                rusqlite::params![&checksum],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| sqlite(err, "imports.fullbackup.execute: card dedupe"))?;
        if let Some(target) = by_hash {
            if target_exists(db, "characters", &target)? {
                record_receipt(db, exec, RECEIPT_CHARACTER, &source_id, &target, &checksum)?;
                exec.bump(ImportsFullbackupCategory::Characters, Outcome::Reused);
                continue;
            }
        }

        // 4. Name conflict with a row this archive did not create.
        let conflict = find_by_name(db, "characters", &card_name)?;
        if let Some(existing) = conflict {
            exec.conflict(ImportsFullbackupCategory::Characters);
            match exec.policy {
                ImportsFullbackupConflictPolicy::Skip => {
                    exec.bump(ImportsFullbackupCategory::Characters, Outcome::Skipped);
                    exec.warn("CHARACTER_CONFLICT", Some(name));
                }
                ImportsFullbackupConflictPolicy::Copy => {
                    let avatar = publish_avatar(db, &stem, avatar_bytes)?;
                    let copy_id = copy_source_id(&source_id, exec);
                    insert_character(
                        db,
                        exec,
                        &card_name,
                        &parsed.description,
                        avatar.as_deref(),
                        &tags_json,
                        &ext_json,
                        &checksum,
                        &copy_id,
                    )?;
                    exec.bump(ImportsFullbackupCategory::Characters, Outcome::Imported);
                    exec.warn("CHARACTER_CONFLICT", Some(name));
                }
                ImportsFullbackupConflictPolicy::Merge
                | ImportsFullbackupConflictPolicy::Replace => {
                    let replace = matches!(exec.policy, ImportsFullbackupConflictPolicy::Replace);
                    if replace {
                        snapshot_character(db, &existing, &exec.now)?;
                    }
                    let avatar = publish_avatar(db, &stem, avatar_bytes)?;
                    update_character(
                        db,
                        exec,
                        &existing,
                        &card_name,
                        &parsed.description,
                        avatar.as_deref(),
                        &tags_json,
                        &ext_json,
                        &checksum,
                        &source_id,
                        replace,
                    )?;
                    exec.bump(ImportsFullbackupCategory::Characters, Outcome::Imported);
                    exec.warn("CHARACTER_CONFLICT", Some(name));
                }
            }
        } else {
            let avatar = publish_avatar(db, &stem, avatar_bytes)?;
            insert_character(
                db,
                exec,
                &card_name,
                &parsed.description,
                avatar.as_deref(),
                &tags_json,
                &ext_json,
                &checksum,
                &source_id,
            )?;
            exec.bump(ImportsFullbackupCategory::Characters, Outcome::Imported);
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_character(
    db: &mut Database,
    exec: &Execution,
    name: &str,
    description: &Option<String>,
    avatar_asset_id: Option<&str>,
    tags_json: &str,
    ext_json: &str,
    checksum: &str,
    source_id: &str,
) -> Result<(), KernelError> {
    let id = crate::product::new_id();
    let now = exec.now.clone();
    let run_id = exec.run_id.clone();
    let family = RECEIPT_CHARACTER.to_string();
    let source_id = source_id.to_string();
    let checksum = checksum.to_string();
    let name = name.to_string();
    let description = description.clone();
    let avatar = avatar_asset_id.map(str::to_string);
    let tags_json = tags_json.to_string();
    let ext_json = ext_json.to_string();
    let target = id.clone();
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters \
             (id, name, description, avatar_asset_id, tags_json, ext_json, profile_id, \
              import_hash, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)",
            rusqlite::params![
                &target,
                &name,
                &description,
                &avatar,
                &tags_json,
                &ext_json,
                &checksum,
                &now,
                &now
            ],
        )
        .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: character insert"))?;
        put_receipt(tx, &run_id, &family, &source_id, &target, &checksum, &now)
    })?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn update_character(
    db: &mut Database,
    exec: &Execution,
    id: &str,
    name: &str,
    description: &Option<String>,
    avatar_asset_id: Option<&str>,
    tags_json: &str,
    ext_json: &str,
    checksum: &str,
    source_id: &str,
    replace: bool,
) -> Result<(), KernelError> {
    let current: Option<(String, String, Option<String>, String, String)> = db
        .conn()
        .query_row(
            "SELECT name, COALESCE(description, ''), avatar_asset_id, tags_json, ext_json \
             FROM characters WHERE id = ?1",
            rusqlite::params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|err| sqlite(err, "fullbackup import: character lookup"))?;
    let Some((old_name, old_description, old_avatar, old_tags, old_ext)) = current else {
        return Err(storage(format!(
            "imports.fullbackup.execute: character {id} vanished mid-run"
        )));
    };
    let merged_name = if replace {
        name.to_string()
    } else {
        prefer_existing(&old_name, name)
    };
    let incoming_description = description.clone().unwrap_or_default();
    let merged_description = if replace {
        incoming_description
    } else {
        prefer_existing(&old_description, &incoming_description)
    };
    let merged_avatar = if replace {
        avatar_asset_id.map(str::to_string).or(old_avatar)
    } else {
        old_avatar.or_else(|| avatar_asset_id.map(str::to_string))
    };
    let merged_tags = if replace || old_tags.trim().is_empty() || old_tags == "[]" {
        tags_json.to_string()
    } else {
        old_tags
    };
    let merged_ext = if replace {
        ext_json.to_string()
    } else {
        fill_json_object(&old_ext, ext_json)
    };
    let now = exec.now.clone();
    let run_id = exec.run_id.clone();
    let target = id.to_string();
    let checksum = checksum.to_string();
    let source_id = source_id.to_string();
    db.transaction(|tx| {
        tx.execute(
            "UPDATE characters \
             SET name = ?2, description = ?3, avatar_asset_id = ?4, tags_json = ?5, \
                 ext_json = ?6, import_hash = ?7, updated_at = ?8, deleted_at = NULL \
             WHERE id = ?1",
            rusqlite::params![
                &target,
                &merged_name,
                &merged_description,
                &merged_avatar,
                &merged_tags,
                &merged_ext,
                &checksum,
                &now
            ],
        )
        .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: character update"))?;
        put_receipt(
            tx,
            &run_id,
            RECEIPT_CHARACTER,
            &source_id,
            &target,
            &checksum,
            &now,
        )
    })?;
    Ok(())
}

/// `replace` is reversible: the row it is about to overwrite is snapshotted into
/// `character_versions`, which `characters.versions.restore` can bring back.
fn snapshot_character(db: &mut Database, id: &str, now: &str) -> Result<(), KernelError> {
    type SnapRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
        String,
    );
    let row: Option<SnapRow> = db
        .conn()
        .query_row(
            "SELECT name, COALESCE(description, ''), avatar_asset_id, profile_id, tags_json, \
                    ext_json, import_hash, updated_at FROM characters WHERE id = ?1",
            rusqlite::params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()
        .map_err(|err| sqlite(err, "fullbackup import: character snapshot lookup"))?;
    let Some((name, description, avatar, profile_id, tags, ext, import_hash, updated_at)) = row
    else {
        return Ok(());
    };
    let version: i64 = db
        .conn()
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM character_versions WHERE character_id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|err| sqlite(err, "fullbackup import: character version lookup"))?;
    let snapshot = json!({
        "name": name,
        "description": description,
        "avatarAssetId": avatar,
        "profileId": profile_id,
        "tagsJson": tags,
        "extJson": ext,
        "importHash": import_hash,
        "updatedAt": updated_at,
        "capturedBy": "imports.fullbackup.execute",
    });
    let text = serde_json::to_string(&snapshot).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("imports.fullbackup.execute: snapshot encode: {err}"),
        )
    })?;
    let snapshot_id = crate::product::new_id();
    let target = id.to_string();
    let now = now.to_string();
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO character_versions (id, character_id, version, snapshot_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![&snapshot_id, &target, version, &text, &now],
        )
        .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: snapshot insert"))?;
        Ok(())
    })?;
    Ok(())
}

/// Publishes a card PNG as an `avatar` asset (content-addressed, deduped).
fn publish_avatar(
    db: &mut Database,
    stem: &str,
    bytes: Option<&[u8]>,
) -> Result<Option<String>, KernelError> {
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    let filename = format!(
        "{}.png",
        stem.rsplit('/').next().unwrap_or("card").replace('/', "-")
    );
    let (id, _deduplicated) =
        crate::assets::publish_bytes(db, "avatar", &filename, bytes, Some("image/png"))?;
    Ok(Some(id))
}

// --- personas ---------------------------------------------------------------

fn import_personas(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let settings_name = format!("{root}settings.json");
    let Some(settings_entry) = entries
        .iter()
        .find(|entry| !entry.is_dir && entry.lower == settings_name)
    else {
        return Ok(());
    };
    let Some(settings) = read_json_value(archive, &settings_entry.name, MAX_SETTINGS_BYTES) else {
        return Ok(());
    };
    let power_user = settings.get("power_user").unwrap_or(&settings);
    let Some(personas) = power_user.get("personas").and_then(Value::as_object) else {
        return Ok(());
    };
    let default_persona = power_user
        .get("default_persona")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();

    for (avatar_id, value) in personas {
        exec.saw = true;
        let Some((name, description)) = persona_fields(value) else {
            exec.bump(ImportsFullbackupCategory::Personas, Outcome::Invalid);
            exec.warn(
                "PERSONA_INVALID",
                Some(&format!(
                    "{root}settings.json#power_user.personas.{avatar_id}"
                )),
            );
            continue;
        };
        let source_id = format!("personas/{}", avatar_id.to_lowercase());
        let checksum = sha256_hex(value.to_string().as_bytes());

        if let Some((target, seen)) = receipt(db, RECEIPT_PERSONA, &source_id)? {
            if seen == checksum && target_exists(db, "personas", &target)? {
                exec.bump(ImportsFullbackupCategory::Personas, Outcome::Reused);
                continue;
            }
        }

        let display_name = if name.trim().is_empty() {
            exec.warn("PERSONA_NAME_MISSING", Some(avatar_id));
            avatar_id.clone()
        } else {
            name
        };
        let is_default = !default_persona.is_empty() && avatar_id.to_lowercase() == default_persona;
        let conflict = find_by_name(db, "personas", &display_name)?;

        if conflict.is_some() && matches!(exec.policy, ImportsFullbackupConflictPolicy::Skip) {
            exec.conflict(ImportsFullbackupCategory::Personas);
            exec.bump(ImportsFullbackupCategory::Personas, Outcome::Skipped);
            exec.warn("PERSONA_CONFLICT", Some(avatar_id));
            continue;
        }
        let avatar_asset = publish_persona_avatar(archive, entries, root, avatar_id, db, exec)?;

        match conflict {
            Some(existing) => {
                exec.conflict(ImportsFullbackupCategory::Personas);
                match exec.policy {
                    ImportsFullbackupConflictPolicy::Skip => {
                        unreachable!("handled before the avatar publish")
                    }
                    ImportsFullbackupConflictPolicy::Copy => {
                        let copy_id = copy_source_id(&source_id, exec);
                        insert_persona(
                            db,
                            exec,
                            &display_name,
                            &description,
                            avatar_asset.as_deref(),
                            is_default,
                            &copy_id,
                            &checksum,
                        )?;
                        exec.bump(ImportsFullbackupCategory::Personas, Outcome::Imported);
                        exec.warn("PERSONA_CONFLICT", Some(avatar_id));
                    }
                    ImportsFullbackupConflictPolicy::Merge
                    | ImportsFullbackupConflictPolicy::Replace => {
                        let replace =
                            matches!(exec.policy, ImportsFullbackupConflictPolicy::Replace);
                        update_persona(
                            db,
                            exec,
                            &existing,
                            &display_name,
                            &description,
                            avatar_asset.as_deref(),
                            replace,
                            &source_id,
                            &checksum,
                        )?;
                        exec.bump(ImportsFullbackupCategory::Personas, Outcome::Imported);
                        exec.warn("PERSONA_CONFLICT", Some(avatar_id));
                    }
                }
            }
            None => {
                insert_persona(
                    db,
                    exec,
                    &display_name,
                    &description,
                    avatar_asset.as_deref(),
                    is_default,
                    &source_id,
                    &checksum,
                )?;
                exec.bump(ImportsFullbackupCategory::Personas, Outcome::Imported);
            }
        }
    }
    Ok(())
}

/// Publishes one persona's `user avatars/<avatarId>.<image>` file, if any.
fn publish_persona_avatar(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    avatar_id: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<Option<String>, KernelError> {
    let prefix = format!("{root}user avatars/{}", avatar_id.to_lowercase());
    let entry = entries.iter().find(|entry| {
        !entry.is_dir
            && entry.lower.starts_with(&prefix)
            && IMAGE_EXTENSIONS
                .iter()
                .any(|extension| entry.lower.ends_with(extension))
    });
    let Some(entry) = entry else {
        exec.warn("PERSONA_AVATAR_MISSING", Some(avatar_id));
        return Ok(None);
    };
    let entry_name = entry.name.clone();
    let Some(bytes) = read_entry(archive, &entry_name, MAX_CHARACTER_BYTES as u64) else {
        exec.warn("PERSONA_AVATAR_INVALID", Some(&entry_name));
        return Ok(None);
    };
    let filename = entry_name
        .rsplit('/')
        .next()
        .unwrap_or("avatar.png")
        .to_string();
    let (id, _deduplicated) = crate::assets::publish_bytes(
        db,
        "avatar",
        &filename,
        &bytes,
        Some(content_type(&entry_name)),
    )?;
    Ok(Some(id))
}

#[allow(clippy::too_many_arguments)]
fn insert_persona(
    db: &mut Database,
    exec: &Execution,
    name: &str,
    description: &Option<String>,
    avatar: Option<&str>,
    is_default: bool,
    source_id: &str,
    checksum: &str,
) -> Result<(), KernelError> {
    let id = crate::product::new_id();
    let now = exec.now.clone();
    let run_id = exec.run_id.clone();
    let name = name.to_string();
    let description = description.clone();
    let avatar = avatar.map(str::to_string);
    let source_id = source_id.to_string();
    let checksum = checksum.to_string();
    let target = id.clone();
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO personas \
             (id, name, description, avatar, is_default, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                &target,
                &name,
                &description,
                &avatar,
                is_default as i64,
                &now,
                &now
            ],
        )
        .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: persona insert"))?;
        put_receipt(
            tx,
            &run_id,
            RECEIPT_PERSONA,
            &source_id,
            &target,
            &checksum,
            &now,
        )
    })?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn update_persona(
    db: &mut Database,
    exec: &Execution,
    id: &str,
    name: &str,
    description: &Option<String>,
    avatar: Option<&str>,
    replace: bool,
    source_id: &str,
    checksum: &str,
) -> Result<(), KernelError> {
    let current: Option<(String, String, Option<String>)> = db
        .conn()
        .query_row(
            "SELECT name, COALESCE(description, ''), avatar FROM personas WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| sqlite(err, "fullbackup import: persona lookup"))?;
    let Some((old_name, old_description, old_avatar)) = current else {
        return Err(storage(format!(
            "imports.fullbackup.execute: persona {id} vanished mid-run"
        )));
    };
    let incoming_description = description.clone().unwrap_or_default();
    let merged_name = if replace {
        name.to_string()
    } else {
        prefer_existing(&old_name, name)
    };
    let merged_description = if replace {
        incoming_description
    } else {
        prefer_existing(&old_description, &incoming_description)
    };
    let merged_avatar = if replace {
        avatar.map(str::to_string).or(old_avatar)
    } else {
        old_avatar.or_else(|| avatar.map(str::to_string))
    };
    let now = exec.now.clone();
    let run_id = exec.run_id.clone();
    let target = id.to_string();
    let source_id = source_id.to_string();
    let checksum = checksum.to_string();
    db.transaction(|tx| {
        tx.execute(
            "UPDATE personas SET name = ?2, description = ?3, avatar = ?4, updated_at = ?5 \
             WHERE id = ?1",
            rusqlite::params![
                &target,
                &merged_name,
                &merged_description,
                &merged_avatar,
                &now
            ],
        )
        .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: persona update"))?;
        put_receipt(
            tx,
            &run_id,
            RECEIPT_PERSONA,
            &source_id,
            &target,
            &checksum,
            &now,
        )
    })?;
    Ok(())
}

// --- chats ------------------------------------------------------------------

fn import_chats(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let prefix = format!("{root}chats/");
    let names: Vec<String> = entries
        .iter()
        .filter(|entry| {
            !entry.is_dir && entry.lower.starts_with(&prefix) && entry.lower.ends_with(".jsonl")
        })
        .map(|entry| entry.name.clone())
        .collect();
    for name in &names {
        import_chat(archive, name, &prefix, db, exec)?;
    }
    Ok(())
}

/// How one transcript lands, once its receipt and the policy are known.
enum ChatPlan {
    Fresh,
    Replace(String),
    Copy,
    Merge(String),
}

fn import_chat(
    archive: &mut ZipArchive<File>,
    name: &str,
    prefix: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let relative = name.to_lowercase().trim_start_matches(prefix).to_string();
    let source_id = format!("chats/{relative}");
    exec.saw = true;

    let Some(checksum) = hash_entry(archive, name) else {
        exec.bump(ImportsFullbackupCategory::Chats, Outcome::Invalid);
        exec.warn("CHAT_IMPORT_FAILED", Some(name));
        return Ok(());
    };

    // 1. Receipt: same source, same bytes → already imported.
    let mut previous_chat: Option<String> = None;
    if let Some((target, seen)) = receipt(db, RECEIPT_CHAT, &source_id)? {
        if target_exists(db, "chats", &target)? {
            if seen == checksum {
                exec.bump(ImportsFullbackupCategory::Chats, Outcome::Reused);
                return Ok(());
            }
            previous_chat = Some(target);
        }
    }

    // 2. A transcript belongs to a character the kernel knows: `chats.character_id`
    //    is NOT NULL and legacy full-data stores one directory per character.
    let character_stem = relative
        .split_once('/')
        .map(|(stem, _)| stem.to_string())
        .unwrap_or_default();
    let Some(character_id) = resolve_chat_character(db, &character_stem)? else {
        exec.bump(ImportsFullbackupCategory::Chats, Outcome::Skipped);
        exec.warn("CHAT_CHARACTER_NOT_FOUND", Some(name));
        return Ok(());
    };

    let file_stem = relative
        .rsplit('/')
        .next()
        .unwrap_or("chat")
        .trim_end_matches(".jsonl")
        .to_string();
    let title: String = if file_stem.is_empty() {
        "Imported chat".to_string()
    } else {
        file_stem.chars().take(500).collect()
    };

    // 3. Resolve the conflict, deciding where the transcript continues.
    let plan = match previous_chat {
        None => ChatPlan::Fresh,
        Some(existing) => {
            exec.conflict(ImportsFullbackupCategory::Chats);
            match exec.policy {
                ImportsFullbackupConflictPolicy::Skip => {
                    exec.bump(ImportsFullbackupCategory::Chats, Outcome::Skipped);
                    exec.warn("CHAT_CONFLICT", Some(name));
                    return Ok(());
                }
                ImportsFullbackupConflictPolicy::Replace => ChatPlan::Replace(existing),
                ImportsFullbackupConflictPolicy::Copy => ChatPlan::Copy,
                ImportsFullbackupConflictPolicy::Merge => ChatPlan::Merge(existing),
            }
        }
    };
    let (chat_id, delete_existing, insert_row, start_sequence, receipt_source) = match plan {
        ChatPlan::Fresh => (
            crate::product::new_id(),
            false,
            true,
            0i64,
            source_id.clone(),
        ),
        ChatPlan::Replace(existing) => (existing, true, true, 0, source_id.clone()),
        ChatPlan::Copy => (
            crate::product::new_id(),
            false,
            true,
            0,
            copy_source_id(&source_id, exec),
        ),
        ChatPlan::Merge(existing) => {
            let existing_count = count_messages(db, &existing)?;
            (existing, false, false, existing_count, source_id.clone())
        }
    };

    // 4. Chat header: legacy full-data's first line may be `chat_metadata`, which is
    //    not a message (the legacy importer skipped it the same way).
    let header = read_first_record(archive, name);
    let metadata = header
        .as_ref()
        .and_then(|record| record.get("chat_metadata"));
    let created_at = metadata
        .and_then(|metadata| metadata.get("create_date"))
        .and_then(timestamp_value)
        .unwrap_or_else(|| exec.now.clone());
    let persona_id = metadata
        .and_then(|metadata| metadata.get("persona"))
        .and_then(Value::as_str)
        .and_then(|avatar_id| {
            receipt(
                db,
                RECEIPT_PERSONA,
                &format!("personas/{}", avatar_id.to_lowercase()),
            )
            .ok()
            .flatten()
            .map(|(target, _)| target)
        });
    let sort_order: i64 = db
        .conn()
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM chats WHERE character_id = ?1",
            rusqlite::params![&character_id],
            |row| row.get(0),
        )
        .map_err(|err| sqlite(err, "fullbackup import: chat order"))?;

    let now = exec.now.clone();
    let run_id = exec.run_id.clone();
    let checksum_owned = checksum.clone();
    let receipt_source_owned = receipt_source.clone();
    let title_owned = title.clone();
    let created_at_owned = created_at.clone();
    let chat_id_owned = chat_id.clone();
    let character_owned = character_id.clone();
    let source_name = name.to_string();

    let (inserted, invalid_lines) = db.transaction(|tx| {
        if delete_existing {
            tx.execute(
                "DELETE FROM chats WHERE id = ?1",
                rusqlite::params![&chat_id_owned],
            )
            .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: chat replace"))?;
        }
        if insert_row {
            tx.execute(
                "INSERT INTO chats \
                 (id, title, character_id, created_at, updated_at, persona_id, sort_order) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    &chat_id_owned,
                    &title_owned,
                    &character_owned,
                    &created_at_owned,
                    &now,
                    &persona_id,
                    sort_order
                ],
            )
            .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: chat insert"))?;
        }
        let (inserted, invalid) =
            append_messages(tx, archive, &source_name, &chat_id_owned, start_sequence)?;
        put_receipt(
            tx,
            &run_id,
            RECEIPT_CHAT,
            &receipt_source_owned,
            &chat_id_owned,
            &checksum_owned,
            &now,
        )?;
        Ok((inserted, invalid))
    })?;

    exec.dependent(ImportsFullbackupCategory::Chats, inserted);
    if invalid_lines > 0 {
        exec.warn("CHAT_MESSAGE_INVALID", Some(name));
    }
    exec.bump(ImportsFullbackupCategory::Chats, Outcome::Imported);
    Ok(())
}

/// Streams the transcript into `messages`, skipping `start_sequence` leading
/// records (a `merge` keeps what the chat already has) and returning
/// `(inserted, invalid_lines)`.
fn append_messages(
    tx: &rusqlite::Transaction,
    archive: &mut ZipArchive<File>,
    name: &str,
    chat_id: &str,
    start_sequence: i64,
) -> Result<(i64, i64), StorageError> {
    let entry = archive.by_name(name).map_err(|_| {
        StorageError::with(
            StorageErrorCode::Io,
            "fullbackup import: chat entry disappeared",
            vec![],
        )
    })?;
    let mut reader = BufReader::new(entry);
    let mut line = String::new();
    let mut inserted = 0i64;
    let mut invalid = 0i64;
    let mut seen = 0i64;
    let mut sequence = start_sequence;
    let mut header_seen = false;
    let now = neotavern_storage::now_utc_rfc3339();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(count) => {
                if count > MAX_CHAT_LINE_CHARS {
                    invalid += 1;
                    continue;
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(record) = serde_json::from_str::<Value>(trimmed) else {
                    invalid += 1;
                    continue;
                };
                if !header_seen {
                    header_seen = true;
                    if record.get("chat_metadata").is_some() {
                        continue;
                    }
                }
                let Some(message) = chat_message(&record) else {
                    invalid += 1;
                    continue;
                };
                seen += 1;
                if seen <= start_sequence {
                    continue;
                }
                tx.execute(
                    "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![
                        crate::product::new_id(),
                        chat_id,
                        message.role,
                        message.content,
                        sequence,
                        message.created_at.unwrap_or_else(|| now.clone())
                    ],
                )
                .map_err(|err| {
                    StorageError::from_sqlite(err, "fullbackup import: message insert")
                })?;
                sequence += 1;
                inserted += 1;
            }
            Err(_) => {
                invalid += 1;
                break;
            }
        }
    }
    Ok((inserted, invalid))
}

struct ChatMessage {
    role: &'static str,
    content: String,
    created_at: Option<String>,
}

/// Maps one legacy full-data transcript record onto a message (same rules as the
/// legacy importer: `mes` or `extra.display_text`, `is_user`/`is_system`, tool
/// extras).
fn chat_message(record: &Value) -> Option<ChatMessage> {
    let content = record
        .get("mes")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            record
                .get("extra")
                .and_then(|extra| extra.get("display_text"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })?;
    let role = if record.get("is_system").and_then(Value::as_bool) == Some(true) {
        "system"
    } else if record.get("is_user").and_then(Value::as_bool) == Some(true) {
        "user"
    } else if record
        .get("extra")
        .and_then(|extra| extra.get("type"))
        .and_then(Value::as_str)
        == Some("tool")
    {
        "tool"
    } else {
        "assistant"
    };
    Some(ChatMessage {
        role,
        content,
        created_at: record.get("send_date").and_then(timestamp_value),
    })
}

/// Character a transcript belongs to: `chats/<character>/<chat>.jsonl` resolves
/// through the character receipt first, then through an exact (case-insensitive)
/// name match.
fn resolve_chat_character(db: &Database, stem: &str) -> Result<Option<String>, KernelError> {
    if stem.is_empty() {
        return Ok(None);
    }
    if let Some((target, _)) = receipt(db, RECEIPT_CHARACTER, &format!("characters/{stem}"))? {
        if target_exists(db, "characters", &target)? {
            return Ok(Some(target));
        }
    }
    find_by_name(db, "characters", stem)
}

fn count_messages(db: &Database, chat_id: &str) -> Result<i64, KernelError> {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE chat_id = ?1",
            rusqlite::params![chat_id],
            |row| row.get(0),
        )
        .map_err(|err| sqlite(err, "fullbackup import: message count"))
}

/// Reads the first transcript record (used for `chat_metadata`).
fn read_first_record(archive: &mut ZipArchive<File>, name: &str) -> Option<Value> {
    let entry = archive.by_name(name).ok()?;
    let mut reader = BufReader::new(entry);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return None,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                return serde_json::from_str::<Value>(trimmed).ok();
            }
            Err(_) => return None,
        }
    }
}

// --- lorebooks --------------------------------------------------------------

fn import_lorebooks(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let prefix = format!("{root}worlds/");
    let names: Vec<String> = entries
        .iter()
        .filter(|entry| {
            !entry.is_dir && entry.lower.starts_with(&prefix) && entry.lower.ends_with(".json")
        })
        .map(|entry| entry.name.clone())
        .collect();
    for name in &names {
        exec.saw = true;
        let lower = name.to_lowercase();
        let stem = lower
            .trim_start_matches(&prefix)
            .trim_end_matches(".json")
            .to_string();
        let source_id = format!("lorebooks/{stem}");
        let Some(bytes) = read_entry(archive, name, MAX_WORLD_BYTES) else {
            exec.bump(ImportsFullbackupCategory::Lorebooks, Outcome::Invalid);
            exec.warn("LOREBOOK_IMPORT_FAILED", Some(name));
            continue;
        };
        let checksum = sha256_hex(&bytes);
        if let Some((target, seen)) = receipt(db, RECEIPT_LOREBOOK, &source_id)? {
            if seen == checksum && target_exists(db, "lorebooks", &target)? {
                exec.bump(ImportsFullbackupCategory::Lorebooks, Outcome::Reused);
                continue;
            }
        }
        let Some(value) = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(Value::is_object)
        else {
            exec.bump(ImportsFullbackupCategory::Lorebooks, Outcome::Invalid);
            exec.warn("LOREBOOK_IMPORT_FAILED", Some(name));
            continue;
        };
        let fallback = stem.rsplit('/').next().unwrap_or("Lorebook").to_string();
        let lorebook_name = value
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or(fallback);
        let description = value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut entry_values: Vec<Value> = Vec::new();
        let mut invalid_entries = 0i64;
        if let Some(map) = value.get("entries").and_then(Value::as_object) {
            for entry in map.values() {
                if entry.is_object() {
                    entry_values.push(entry.clone());
                } else {
                    invalid_entries += 1;
                }
            }
        }
        if invalid_entries > 0 {
            exec.warn("LORE_ENTRY_INVALID", Some(name));
        }
        let entries_json = serde_json::to_string(&entry_values).map_err(|err| {
            KernelError::new(
                KernelErrorCode::Internal,
                format!("imports.fullbackup.execute: serialize lorebook: {err}"),
            )
        })?;
        let entry_count = entry_values.len() as i64;

        let conflict = find_by_name(db, "lorebooks", &lorebook_name)?;
        match conflict {
            Some(existing) => {
                exec.conflict(ImportsFullbackupCategory::Lorebooks);
                match exec.policy {
                    ImportsFullbackupConflictPolicy::Skip => {
                        exec.bump(ImportsFullbackupCategory::Lorebooks, Outcome::Skipped);
                        exec.warn("LOREBOOK_CONFLICT", Some(name));
                    }
                    ImportsFullbackupConflictPolicy::Copy => {
                        let copy_id = copy_source_id(&source_id, exec);
                        insert_lorebook(
                            db,
                            exec,
                            &lorebook_name,
                            &description,
                            &entries_json,
                            &copy_id,
                            &checksum,
                        )?;
                        exec.bump(ImportsFullbackupCategory::Lorebooks, Outcome::Imported);
                        exec.dependent(ImportsFullbackupCategory::Lorebooks, entry_count);
                        exec.warn("LOREBOOK_CONFLICT", Some(name));
                    }
                    ImportsFullbackupConflictPolicy::Merge
                    | ImportsFullbackupConflictPolicy::Replace => {
                        let replace =
                            matches!(exec.policy, ImportsFullbackupConflictPolicy::Replace);
                        let current: Option<String> = db
                            .conn()
                            .query_row(
                                "SELECT entries_json FROM lorebooks WHERE id = ?1",
                                rusqlite::params![&existing],
                                |row| row.get(0),
                            )
                            .optional()
                            .map_err(|err| {
                                sqlite(err, "fullbackup import: lorebook entries lookup")
                            })?;
                        let keep_existing_entries = !replace
                            && current
                                .as_deref()
                                .map(|raw| {
                                    let trimmed = raw.trim();
                                    !trimmed.is_empty() && trimmed != "[]"
                                })
                                .unwrap_or(false);
                        let entries_owned = if keep_existing_entries {
                            current.unwrap_or_else(|| entries_json.clone())
                        } else {
                            entries_json.clone()
                        };
                        let now = exec.now.clone();
                        let run_id = exec.run_id.clone();
                        let target = existing.clone();
                        let name_owned = lorebook_name.clone();
                        let description_owned = description.clone();
                        let source_owned = source_id.clone();
                        let checksum_owned = checksum.clone();
                        db.transaction(|tx| {
                            tx.execute(
                                "UPDATE lorebooks SET name = ?2, description = ?3, \
                                 entries_json = ?4, updated_at = ?5 WHERE id = ?1",
                                rusqlite::params![
                                    &target,
                                    &name_owned,
                                    &description_owned,
                                    &entries_owned,
                                    &now
                                ],
                            )
                            .map_err(|err| {
                                StorageError::from_sqlite(err, "fullbackup import: lorebook update")
                            })?;
                            put_receipt(
                                tx,
                                &run_id,
                                RECEIPT_LOREBOOK,
                                &source_owned,
                                &target,
                                &checksum_owned,
                                &now,
                            )
                        })?;
                        exec.bump(ImportsFullbackupCategory::Lorebooks, Outcome::Imported);
                        if !keep_existing_entries {
                            exec.dependent(ImportsFullbackupCategory::Lorebooks, entry_count);
                        }
                        exec.warn("LOREBOOK_CONFLICT", Some(name));
                    }
                }
            }
            None => {
                insert_lorebook(
                    db,
                    exec,
                    &lorebook_name,
                    &description,
                    &entries_json,
                    &source_id,
                    &checksum,
                )?;
                exec.bump(ImportsFullbackupCategory::Lorebooks, Outcome::Imported);
                exec.dependent(ImportsFullbackupCategory::Lorebooks, entry_count);
            }
        }
    }
    Ok(())
}

fn insert_lorebook(
    db: &mut Database,
    exec: &Execution,
    name: &str,
    description: &str,
    entries_json: &str,
    source_id: &str,
    checksum: &str,
) -> Result<(), KernelError> {
    let id = crate::product::new_id();
    let now = exec.now.clone();
    let run_id = exec.run_id.clone();
    let name = name.to_string();
    let description = description.to_string();
    let entries_json = entries_json.to_string();
    let source_id = source_id.to_string();
    let checksum = checksum.to_string();
    let target = id.clone();
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO lorebooks (id, name, description, entries_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![&target, &name, &description, &entries_json, &now, &now],
        )
        .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: lorebook insert"))?;
        put_receipt(
            tx,
            &run_id,
            RECEIPT_LOREBOOK,
            &source_id,
            &target,
            &checksum,
            &now,
        )
    })?;
    Ok(())
}

// --- presets ----------------------------------------------------------------

fn import_presets(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    for directory in PRESET_DIRECTORIES {
        let kind = PRESET_KINDS
            .iter()
            .find(|(name, _)| *name == directory)
            .map(|(_, kind)| *kind)
            .unwrap_or(directory);
        let prefix = format!("{root}{directory}/");
        let names: Vec<String> = entries
            .iter()
            .filter(|entry| {
                !entry.is_dir && entry.lower.starts_with(&prefix) && entry.lower.ends_with(".json")
            })
            .map(|entry| entry.name.clone())
            .collect();
        for name in &names {
            exec.saw = true;
            let lower = name.to_lowercase();
            let stem = lower
                .trim_start_matches(&prefix)
                .trim_end_matches(".json")
                .to_string();
            let source_id = format!("presets/{kind}/{stem}");
            let Some(bytes) = read_entry(archive, name, MAX_PRESET_BYTES) else {
                exec.bump(ImportsFullbackupCategory::Presets, Outcome::Invalid);
                exec.warn("PRESET_IMPORT_FAILED", Some(name));
                continue;
            };
            let checksum = sha256_hex(&bytes);
            if let Some((target, seen)) = receipt(db, RECEIPT_PRESET, &source_id)? {
                if seen == checksum && target_exists(db, "presets", &target)? {
                    exec.bump(ImportsFullbackupCategory::Presets, Outcome::Reused);
                    continue;
                }
            }
            let Some(value) = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .filter(Value::is_object)
            else {
                exec.bump(ImportsFullbackupCategory::Presets, Outcome::Invalid);
                exec.warn("PRESET_IMPORT_FAILED", Some(name));
                continue;
            };
            let fallback = stem.rsplit('/').next().unwrap_or("Preset").to_string();
            let preset_name = value
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .unwrap_or(fallback);
            let settings_json = serde_json::to_string(&value).map_err(|err| {
                KernelError::new(
                    KernelErrorCode::Internal,
                    format!("imports.fullbackup.execute: serialize preset: {err}"),
                )
            })?;
            let conflict = find_preset_conflict(db, kind, &preset_name)?;
            match conflict {
                Some(existing) => {
                    exec.conflict(ImportsFullbackupCategory::Presets);
                    match exec.policy {
                        ImportsFullbackupConflictPolicy::Skip => {
                            exec.bump(ImportsFullbackupCategory::Presets, Outcome::Skipped);
                            exec.warn("PRESET_CONFLICT", Some(name));
                        }
                        ImportsFullbackupConflictPolicy::Copy => {
                            let copy_id = copy_source_id(&source_id, exec);
                            insert_preset(
                                db,
                                exec,
                                kind,
                                &preset_name,
                                &settings_json,
                                &copy_id,
                                &checksum,
                            )?;
                            exec.bump(ImportsFullbackupCategory::Presets, Outcome::Imported);
                            exec.warn("PRESET_CONFLICT", Some(name));
                        }
                        ImportsFullbackupConflictPolicy::Merge
                        | ImportsFullbackupConflictPolicy::Replace => {
                            let replace =
                                matches!(exec.policy, ImportsFullbackupConflictPolicy::Replace);
                            let current: Option<String> = db
                                .conn()
                                .query_row(
                                    "SELECT settings_json FROM presets WHERE id = ?1",
                                    rusqlite::params![&existing],
                                    |row| row.get(0),
                                )
                                .optional()
                                .map_err(|err| sqlite(err, "fullbackup import: preset lookup"))?;
                            let settings_owned = if replace {
                                settings_json.clone()
                            } else {
                                current.unwrap_or_else(|| settings_json.clone())
                            };
                            let now = exec.now.clone();
                            let run_id = exec.run_id.clone();
                            let target = existing.clone();
                            let name_owned = preset_name.clone();
                            let source_owned = source_id.clone();
                            let checksum_owned = checksum.clone();
                            db.transaction(|tx| {
                                tx.execute(
                                    "UPDATE presets SET name = ?2, settings_json = ?3, \
                                     updated_at = ?4 WHERE id = ?1",
                                    rusqlite::params![&target, &name_owned, &settings_owned, &now],
                                )
                                .map_err(|err| {
                                    StorageError::from_sqlite(
                                        err,
                                        "fullbackup import: preset update",
                                    )
                                })?;
                                put_receipt(
                                    tx,
                                    &run_id,
                                    RECEIPT_PRESET,
                                    &source_owned,
                                    &target,
                                    &checksum_owned,
                                    &now,
                                )
                            })?;
                            exec.bump(ImportsFullbackupCategory::Presets, Outcome::Imported);
                            exec.warn("PRESET_CONFLICT", Some(name));
                        }
                    }
                }
                None => {
                    insert_preset(
                        db,
                        exec,
                        kind,
                        &preset_name,
                        &settings_json,
                        &source_id,
                        &checksum,
                    )?;
                    exec.bump(ImportsFullbackupCategory::Presets, Outcome::Imported);
                }
            }
        }
    }
    Ok(())
}

fn insert_preset(
    db: &mut Database,
    exec: &Execution,
    kind: &str,
    name: &str,
    settings_json: &str,
    source_id: &str,
    checksum: &str,
) -> Result<(), KernelError> {
    let id = crate::product::new_id();
    let now = exec.now.clone();
    let run_id = exec.run_id.clone();
    let kind = kind.to_string();
    let name = name.to_string();
    let settings_json = settings_json.to_string();
    let source_id = source_id.to_string();
    let checksum = checksum.to_string();
    let target = id.clone();
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO presets (id, kind, name, settings_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![&target, &kind, &name, &settings_json, &now, &now],
        )
        .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: preset insert"))?;
        put_receipt(
            tx,
            &run_id,
            RECEIPT_PRESET,
            &source_id,
            &target,
            &checksum,
            &now,
        )
    })?;
    Ok(())
}

fn find_preset_conflict(
    db: &Database,
    kind: &str,
    name: &str,
) -> Result<Option<String>, KernelError> {
    db.conn()
        .query_row(
            "SELECT id FROM presets WHERE kind = ?1 AND name = ?2 COLLATE NOCASE LIMIT 1",
            rusqlite::params![kind, name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "fullbackup import: preset conflict lookup"))
}

// --- groups / extension settings / api settings (settings documents) --------

fn import_groups(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let prefix = format!("{root}groups/");
    let names: Vec<String> = entries
        .iter()
        .filter(|entry| {
            !entry.is_dir && entry.lower.starts_with(&prefix) && entry.lower.ends_with(".json")
        })
        .map(|entry| entry.name.clone())
        .collect();
    let mut records: Vec<(String, Value)> = Vec::new();
    for name in &names {
        exec.saw = true;
        let Some(value) = read_json_value(archive, name, MAX_PRESET_BYTES) else {
            exec.bump(ImportsFullbackupCategory::Groups, Outcome::Invalid);
            exec.warn("GROUP_IMPORT_FAILED", Some(name));
            continue;
        };
        let display_name = value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if display_name.is_empty() {
            exec.bump(ImportsFullbackupCategory::Groups, Outcome::Invalid);
            exec.warn("GROUP_INVALID", Some(name));
            continue;
        }
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .unwrap_or_else(|| {
                name.to_lowercase()
                    .trim_start_matches(&prefix)
                    .trim_end_matches(".json")
                    .to_string()
            });
        records.push((id, value));
    }
    if records.is_empty() {
        return Ok(());
    }
    import_settings_document(
        db,
        exec,
        ImportsFullbackupCategory::Groups,
        SETTINGS_GROUPS,
        &records,
    )?;
    if exec.categories[category_index(ImportsFullbackupCategory::Groups)].imported > 0 {
        exec.warn(
            "GROUPS_PRESERVED_NOT_MODELED",
            Some(&format!("{root}groups")),
        );
    }
    Ok(())
}

fn import_extension_settings(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let settings_name = format!("{root}settings.json");
    let Some(settings_entry) = entries
        .iter()
        .find(|entry| !entry.is_dir && entry.lower == settings_name)
    else {
        return Ok(());
    };
    let Some(settings) = read_json_value(archive, &settings_entry.name, MAX_SETTINGS_BYTES) else {
        return Ok(());
    };
    let Some(namespaces) = settings
        .get("extension_settings")
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    let mut records: Vec<(String, Value)> = Vec::new();
    for (namespace, value) in namespaces {
        exec.saw = true;
        if !value.is_object() {
            exec.bump(
                ImportsFullbackupCategory::ExtensionSettings,
                Outcome::Invalid,
            );
            exec.warn("EXTENSION_SETTINGS_IMPORT_FAILED", Some(namespace));
            continue;
        }
        records.push((namespace.to_lowercase(), value.clone()));
    }
    if records.is_empty() {
        return Ok(());
    }
    import_settings_document(
        db,
        exec,
        ImportsFullbackupCategory::ExtensionSettings,
        SETTINGS_EXTENSION_SETTINGS,
        &records,
    )?;
    if exec.categories[category_index(ImportsFullbackupCategory::ExtensionSettings)].imported > 0 {
        exec.warn(
            "EXTENSION_SETTINGS_PRESERVED_NOT_MODELED",
            Some(&format!("{root}settings.json")),
        );
    }
    Ok(())
}

fn import_api_settings(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let prefix = format!("{root}openai settings/");
    let names: Vec<String> = entries
        .iter()
        .filter(|entry| {
            !entry.is_dir && entry.lower.starts_with(&prefix) && entry.lower.ends_with(".json")
        })
        .map(|entry| entry.name.clone())
        .collect();
    let mut records: Vec<(String, Value)> = Vec::new();
    for name in &names {
        exec.saw = true;
        let Some(value) = read_json_value(archive, name, MAX_PRESET_BYTES) else {
            exec.bump(ImportsFullbackupCategory::ApiSettings, Outcome::Invalid);
            exec.warn("API_SETTINGS_IMPORT_FAILED", Some(name));
            continue;
        };
        let id = name
            .to_lowercase()
            .trim_start_matches(&prefix)
            .trim_end_matches(".json")
            .to_string();
        let stem = id.rsplit('/').next().unwrap_or("preset").to_string();
        let model = value
            .get("openai_model")
            .and_then(Value::as_str)
            .or_else(|| value.get("model").and_then(Value::as_str))
            .unwrap_or_default();
        let per_model = value.get("api_url_per_model").and_then(Value::as_object);
        let base_url = per_model
            .and_then(|map| map.get(model))
            .and_then(Value::as_str)
            .or_else(|| value.get("api_url").and_then(Value::as_str))
            .unwrap_or_default();
        let model_value = if model.is_empty() {
            Value::Null
        } else {
            Value::String(model.to_string())
        };
        let base_url_value = if base_url.is_empty() {
            Value::Null
        } else {
            Value::String(base_url.to_string())
        };
        records.push((
            id,
            json!({
                "name": format!("legacy full-data: {stem}"),
                "provider": "openai-compatible",
                "model": model_value,
                "baseUrl": base_url_value,
                "enabled": false,
                "settings": value,
            }),
        ));
    }
    if records.is_empty() {
        return Ok(());
    }
    import_settings_document(
        db,
        exec,
        ImportsFullbackupCategory::ApiSettings,
        SETTINGS_API_SETTINGS,
        &records,
    )?;
    if exec.categories[category_index(ImportsFullbackupCategory::ApiSettings)].imported > 0 {
        exec.warn(
            "API_SETTINGS_PRESERVED_NOT_MODELED",
            Some(&format!("{root}openai settings")),
        );
    }
    exec.warn(
        "API_SETTINGS_NO_SECRETS",
        Some(&format!("{root}secrets.json")),
    );
    Ok(())
}

/// Merges `records` into one settings document, one row per category, applying
/// the conflict policy per RECORD (a document is not one entity). Bounded by
/// construction: a category is one `settings` row, so `settings.get`
/// (`maxItems: 64`) can never overflow from an import with many namespaces.
fn import_settings_document(
    db: &mut Database,
    exec: &mut Execution,
    category: ImportsFullbackupCategory,
    key: &str,
    records: &[(String, Value)],
) -> Result<(), KernelError> {
    let raw: Option<String> = db
        .conn()
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "fullbackup import: settings document lookup"))?;
    let mut document: BTreeMap<String, Value> = raw
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value.as_object().cloned())
        .map(|map| map.into_iter().collect())
        .unwrap_or_default();
    let existed = raw.is_some();
    let mut changed = false;

    for (id, value) in records {
        let current = document.get(id).cloned();
        match current {
            None => {
                document.insert(id.clone(), value.clone());
                exec.bump(category.clone(), Outcome::Imported);
                changed = true;
            }
            Some(current) if &current == value => {
                exec.bump(category.clone(), Outcome::Reused);
            }
            Some(current) => {
                exec.conflict(category.clone());
                match exec.policy {
                    ImportsFullbackupConflictPolicy::Skip => {
                        exec.bump(category.clone(), Outcome::Skipped);
                        exec.warn("SETTINGS_DOCUMENT_CONFLICT", Some(id));
                    }
                    ImportsFullbackupConflictPolicy::Replace => {
                        document.insert(id.clone(), value.clone());
                        exec.bump(category.clone(), Outcome::Imported);
                        changed = true;
                    }
                    ImportsFullbackupConflictPolicy::Merge => {
                        let merged_text =
                            fill_json_object(&current.to_string(), &value.to_string());
                        let merged_value: Value =
                            serde_json::from_str(&merged_text).unwrap_or_else(|_| value.clone());
                        if merged_value == current {
                            exec.bump(category.clone(), Outcome::Reused);
                        } else {
                            document.insert(id.clone(), merged_value);
                            exec.bump(category.clone(), Outcome::Imported);
                            changed = true;
                        }
                    }
                    ImportsFullbackupConflictPolicy::Copy => {
                        let copy_id = copy_document_key(&document, id);
                        document.insert(copy_id, value.clone());
                        exec.bump(category.clone(), Outcome::Imported);
                        changed = true;
                    }
                }
            }
        }
    }

    if !changed && existed {
        return Ok(());
    }
    let text =
        serde_json::to_string(&Value::Object(document.into_iter().collect())).map_err(|err| {
            KernelError::new(
                KernelErrorCode::Internal,
                format!("imports.fullbackup.execute: serialize settings document: {err}"),
            )
        })?;
    let now = exec.now.clone();
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, \
             updated_at = excluded.updated_at",
            rusqlite::params![key, &text, &now],
        )
        .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: settings document"))?;
        Ok(())
    })?;
    Ok(())
}

/// `copy` needs a key the document does not use yet.
fn copy_document_key(document: &BTreeMap<String, Value>, id: &str) -> String {
    for index in 1..=9999 {
        let candidate = format!("{id}.copy-{index}");
        if !document.contains_key(&candidate) {
            return candidate;
        }
    }
    format!("{id}.copy-overflow")
}

fn copy_source_id(source_id: &str, exec: &Execution) -> String {
    let suffix: String = exec.run_id.chars().take(8).collect();
    format!("{source_id}#copy:{suffix}")
}

// --- backgrounds / themes (asset plane) -------------------------------------

fn import_backgrounds(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let prefix = format!("{root}backgrounds/");
    for entry in entries {
        if entry.is_dir
            || !entry.lower.starts_with(&prefix)
            || !IMAGE_EXTENSIONS
                .iter()
                .any(|extension| entry.lower.ends_with(extension))
        {
            continue;
        }
        exec.saw = true;
        if entry.size > MAX_BACKGROUND_BYTES {
            exec.bump(ImportsFullbackupCategory::Backgrounds, Outcome::Invalid);
            exec.warn("BACKGROUND_TOO_LARGE", Some(&entry.name));
            continue;
        }
        let Some(bytes) = read_entry(archive, &entry.name, MAX_BACKGROUND_BYTES as u64) else {
            exec.bump(ImportsFullbackupCategory::Backgrounds, Outcome::Invalid);
            exec.warn("BACKGROUND_IMPORT_FAILED", Some(&entry.name));
            continue;
        };
        let filename = entry
            .name
            .rsplit('/')
            .next()
            .unwrap_or("background.png")
            .to_string();
        match crate::assets::publish_bytes(
            db,
            "background",
            &filename,
            &bytes,
            Some(content_type(&entry.name)),
        ) {
            Ok((_id, deduplicated)) => {
                let outcome = if deduplicated {
                    Outcome::Reused
                } else {
                    Outcome::Imported
                };
                exec.bump(ImportsFullbackupCategory::Backgrounds, outcome);
            }
            Err(_) => {
                exec.bump(ImportsFullbackupCategory::Backgrounds, Outcome::Invalid);
                exec.warn("BACKGROUND_IMPORT_FAILED", Some(&entry.name));
            }
        }
    }
    Ok(())
}

fn import_themes(
    archive: &mut ZipArchive<File>,
    entries: &[Entry],
    root: &str,
    db: &mut Database,
    exec: &mut Execution,
) -> Result<(), KernelError> {
    let prefix = format!("{root}themes/");
    for entry in entries {
        if entry.is_dir || !entry.lower.starts_with(&prefix) {
            continue;
        }
        let is_css = entry.lower.ends_with(".css");
        let is_json = entry.lower.ends_with(".json");
        if !is_css && !is_json {
            continue;
        }
        exec.saw = true;
        // Themes are DATA (ТЗ §19): publish the bytes as `theme-css` /
        // `theme-json` assets so a later `themes.install` can register them with
        // a real SEC-05 trust decision instead of an import inventing one.
        let kind = if is_css { "theme-css" } else { "theme-json" };
        let Some(bytes) = read_entry(archive, &entry.name, MAX_PRESET_BYTES) else {
            exec.bump(ImportsFullbackupCategory::Themes, Outcome::Invalid);
            exec.warn("THEME_IMPORT_FAILED", Some(&entry.name));
            continue;
        };
        let filename = entry
            .name
            .rsplit('/')
            .next()
            .unwrap_or("theme.css")
            .to_string();
        match crate::assets::publish_bytes(
            db,
            kind,
            &filename,
            &bytes,
            Some(content_type(&entry.name)),
        ) {
            Ok((_id, deduplicated)) => {
                let outcome = if deduplicated {
                    Outcome::Reused
                } else {
                    Outcome::Imported
                };
                exec.bump(ImportsFullbackupCategory::Themes, outcome);
            }
            Err(_) => {
                exec.bump(ImportsFullbackupCategory::Themes, Outcome::Invalid);
                exec.warn("THEME_IMPORT_FAILED", Some(&entry.name));
            }
        }
    }
    Ok(())
}

// --- receipts ---------------------------------------------------------------

/// `(target_id, source_checksum)` for one entity, when this ledger already
/// imported it.
fn receipt(
    db: &Database,
    family: &str,
    source_id: &str,
) -> Result<Option<(String, String)>, KernelError> {
    db.conn()
        .query_row(
            "SELECT target_id, source_checksum FROM import_receipts \
             WHERE entity_family = ?1 AND source_id = ?2",
            rusqlite::params![family, source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| sqlite(err, "fullbackup import: receipt lookup"))
}

/// A receipt whose target was deleted by the user must not count as "already
/// imported" — the row is simply gone.
fn target_exists(db: &Database, table: &str, id: &str) -> Result<bool, KernelError> {
    // Fixed table names only: never caller-controlled SQL.
    let sql = match table {
        "characters" => "SELECT COUNT(*) FROM characters WHERE id = ?1",
        "chats" => "SELECT COUNT(*) FROM chats WHERE id = ?1",
        "personas" => "SELECT COUNT(*) FROM personas WHERE id = ?1",
        "lorebooks" => "SELECT COUNT(*) FROM lorebooks WHERE id = ?1",
        "presets" => "SELECT COUNT(*) FROM presets WHERE id = ?1",
        other => {
            return Err(storage(format!(
                "imports.fullbackup.execute: unknown receipt table {other}"
            )))
        }
    };
    let count: i64 = db
        .conn()
        .query_row(sql, rusqlite::params![id], |row| row.get(0))
        .map_err(|err| sqlite(err, "fullbackup import: receipt target lookup"))?;
    Ok(count > 0)
}

fn record_receipt(
    db: &mut Database,
    exec: &Execution,
    family: &str,
    source_id: &str,
    target_id: &str,
    checksum: &str,
) -> Result<(), KernelError> {
    let run_id = exec.run_id.clone();
    let now = exec.now.clone();
    let family = family.to_string();
    let source_id = source_id.to_string();
    let target_id = target_id.to_string();
    let checksum = checksum.to_string();
    db.transaction(|tx| {
        put_receipt(
            tx, &run_id, &family, &source_id, &target_id, &checksum, &now,
        )
    })?;
    Ok(())
}

fn put_receipt(
    tx: &rusqlite::Transaction,
    run_id: &str,
    family: &str,
    source_id: &str,
    target_id: &str,
    checksum: &str,
    now: &str,
) -> Result<(), StorageError> {
    tx.execute(
        "INSERT INTO import_receipts \
         (id, run_id, entity_family, source_id, target_id, source_checksum, imported_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(entity_family, source_id) DO UPDATE SET \
             run_id = excluded.run_id, target_id = excluded.target_id, \
             source_checksum = excluded.source_checksum, imported_at = excluded.imported_at",
        rusqlite::params![
            crate::product::new_id(),
            run_id,
            family,
            source_id,
            target_id,
            checksum,
            now
        ],
    )
    .map_err(|err| StorageError::from_sqlite(err, "fullbackup import: receipt write"))?;
    Ok(())
}

// --- archive helpers --------------------------------------------------------

fn read_entry(archive: &mut ZipArchive<File>, name: &str, cap: u64) -> Option<Vec<u8>> {
    let mut entry = archive.by_name(name).ok()?;
    if entry.size() > cap {
        return None;
    }
    let mut buffer = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buffer).ok()?;
    Some(buffer)
}

/// SHA-256 of one entry, streamed (a chat transcript may be hundreds of MB).
fn hash_entry(archive: &mut ZipArchive<File>, name: &str) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = entry.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(hex(hasher.finalize()))
}

fn read_json_value(archive: &mut ZipArchive<File>, name: &str, cap: u64) -> Option<Value> {
    let bytes = read_entry(archive, name, cap)?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(hasher.finalize())
}

fn hex(digest: impl AsRef<[u8]>) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(64);
    for byte in digest.as_ref() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Content type for a stored file, by extension (NEVER guessed from bytes).
fn content_type(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".css") {
        "text/css"
    } else {
        "application/json"
    }
}

// --- card parsing -----------------------------------------------------------

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const CARD_KEYWORD: &str = "chara";
const MAX_NAME_LEN: usize = 120;
const MAX_DESCRIPTION_LEN: usize = 10_000;
const MAX_TAGS: usize = 32;
const MAX_TAG_LEN: usize = 64;

struct ImportCard {
    name: String,
    description: Option<String>,
    tags: Vec<String>,
    /// The original card object, stored verbatim under `ext_json._card`.
    card: Value,
}

/// Parses a staged card the way `imports.character.card` does, with one
/// addition the archive needs: a V2 card keeps its fields under `data`, so the
/// canonical columns are read from there when present. The ORIGINAL object still
/// rides into `ext_json._card` untouched (AGENTS.md §11: unknown card fields are
/// never lost).
fn parse_import_card(bytes: &[u8]) -> Result<ImportCard, KernelError> {
    let value: Value = if bytes.starts_with(&PNG_SIGNATURE) {
        let json_bytes = extract_png_character_json(bytes)?;
        serde_json::from_slice(&json_bytes).map_err(|_| card_invalid())?
    } else {
        serde_json::from_slice(bytes).map_err(|_| card_invalid())?
    };
    if !value.is_object() {
        return Err(card_invalid());
    }
    let source = value
        .get("data")
        .filter(|data| data.is_object())
        .unwrap_or(&value);
    let name = source
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(MAX_NAME_LEN)
        .collect::<String>();
    let description = source
        .get("description")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(MAX_DESCRIPTION_LEN).collect::<String>());
    let mut tags = Vec::new();
    if let Some(list) = source.get("tags").and_then(Value::as_array) {
        for tag in list.iter().filter_map(Value::as_str) {
            if tag.is_empty() || tags.len() >= MAX_TAGS {
                continue;
            }
            tags.push(tag.chars().take(MAX_TAG_LEN).collect::<String>());
        }
    }
    Ok(ImportCard {
        name,
        description,
        tags,
        card: value,
    })
}

fn extract_png_character_json(bytes: &[u8]) -> Result<Vec<u8>, KernelError> {
    let mut offset = PNG_SIGNATURE.len();
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .expect("slice bounds checked above"),
        ) as usize;
        let type_start = offset + 4;
        let data_start = type_start + 4;
        let data_end = data_start + length;
        let chunk_end = data_end + 4;
        if chunk_end > bytes.len() {
            return Err(card_invalid());
        }
        let chunk_type = &bytes[type_start..data_start];
        if chunk_type == b"tEXt" {
            let data = &bytes[data_start..data_end];
            if let Some(separator) = data.iter().position(|byte| *byte == 0) {
                let keyword = std::str::from_utf8(&data[..separator]).unwrap_or("");
                if keyword == CARD_KEYWORD {
                    let encoded = String::from_utf8_lossy(&data[separator + 1..]);
                    let encoded = encoded.trim();
                    use base64::Engine as _;
                    return base64::engine::general_purpose::STANDARD
                        .decode(encoded.as_bytes())
                        .map_err(|_| card_invalid());
                }
            }
        }
        if chunk_type == b"IEND" {
            break;
        }
        offset = chunk_end;
    }
    Err(card_invalid())
}

fn card_invalid() -> KernelError {
    validation("CHARACTER_CARD_INVALID", "unparseable card")
}

/// `ext_json` for an imported character: the original card plus the same
/// `_st2` provenance block the legacy importer wrote.
fn character_ext(card: &Value, path: &str, checksum: &str) -> String {
    let value = json!({
        "_card": card,
        "_st2": {
            "migrationSource": "fullbackup",
            "sourcePath": path,
            "sourceHash": checksum,
        },
    });
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

// --- general helpers --------------------------------------------------------

fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StorageFailure, format!("{context}: {err}"))
}

fn validation(reason: &str, detail: &str) -> KernelError {
    KernelError::product(
        "VALIDATION",
        vec![
            ("reason".to_string(), reason.to_string()),
            ("detail".to_string(), detail.to_string()),
        ],
    )
}

fn prefer_existing(existing: &str, incoming: &str) -> String {
    if existing.trim().is_empty() {
        incoming.to_string()
    } else {
        existing.to_string()
    }
}

/// `merge`: keep every key the existing object already has (recursively for
/// nested objects) and add the archive's missing ones.
fn fill_json_object(existing: &str, incoming: &str) -> String {
    let mut base = serde_json::from_str::<Value>(existing)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let Some(incoming) = serde_json::from_str::<Value>(incoming)
        .ok()
        .filter(Value::is_object)
    else {
        return base.to_string();
    };
    fill_object(&mut base, &incoming);
    base.to_string()
}

fn fill_object(base: &mut Value, incoming: &Value) {
    let (Some(base_map), Some(incoming_map)) = (base.as_object_mut(), incoming.as_object()) else {
        return;
    };
    for (key, value) in incoming_map {
        match base_map.get_mut(key) {
            None => {
                base_map.insert(key.clone(), value.clone());
            }
            Some(existing) if existing.is_object() && value.is_object() => {
                fill_object(existing, value);
            }
            Some(_) => {}
        }
    }
}

/// Case-insensitive name lookup (the same collision rule the legacy repository
/// used for characters, personas and lorebooks).
fn find_by_name(db: &Database, table: &str, name: &str) -> Result<Option<String>, KernelError> {
    let sql = match table {
        "characters" => {
            "SELECT id FROM characters WHERE name = ?1 COLLATE NOCASE AND deleted_at IS NULL \
             ORDER BY created_at LIMIT 1"
        }
        "personas" => {
            "SELECT id FROM personas WHERE name = ?1 COLLATE NOCASE ORDER BY created_at LIMIT 1"
        }
        "lorebooks" => {
            "SELECT id FROM lorebooks WHERE name = ?1 COLLATE NOCASE ORDER BY created_at LIMIT 1"
        }
        other => {
            return Err(storage(format!(
                "imports.fullbackup.execute: unknown conflict table {other}"
            )))
        }
    };
    db.conn()
        .query_row(sql, rusqlite::params![name], |row| row.get(0))
        .optional()
        .map_err(|err| sqlite(err, "fullbackup import: conflict lookup"))
}

/// Persona descriptor → `(name, description)`. legacy full-data stores an object per
/// avatar id; a bare string is an older/alternate shape the analyzer accepts too.
fn persona_fields(value: &Value) -> Option<(String, Option<String>)> {
    match value {
        Value::String(name) => Some((name.clone(), None)),
        Value::Object(map) => {
            let name = map
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if name.trim().is_empty() {
                return None;
            }
            let description = map
                .get("description")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string);
            Some((name, description))
        }
        _ => None,
    }
}

/// Epoch milliseconds (or a numeric string) → RFC 3339.
fn timestamp_value(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        if let Ok(parsed) =
            time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        {
            return parsed
                .format(&time::format_description::well_known::Rfc3339)
                .ok();
        }
        if let Ok(number) = text.trim().parse::<i64>() {
            return epoch_millis(number);
        }
        return None;
    }
    value.as_i64().and_then(epoch_millis)
}

/// legacy full-data mixes seconds and milliseconds depending on version; anything
/// below 1e11 is seconds.
fn epoch_millis(raw: i64) -> Option<String> {
    let millis = if raw.abs() < 100_000_000_000 {
        raw.checked_mul(1000)?
    } else {
        raw
    };
    let nanos = (millis as i128).checked_mul(1_000_000)?;
    let stamp = time::OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    stamp
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}
