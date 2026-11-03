//! Этап 4.5 cluster 10: full-data archive analysis
//! (`imports.fullbackup.analyze`).
//!
//! The archive reaches the kernel through the chunked `assets.put` ingestion
//! contract (ADR-0061) and is addressed by `assetId`, so a backup up to the
//! legacy 4 GiB cap never rides a JSON request. This operation is **read-only**:
//! it walks the ZIP central directory, classifies every entry by the
//! full-data archive layout, counts what an import would touch and reports
//! honest warnings. Nothing is written, so the operation is idempotent.
//!
//! Deliberate scope (documented, not silently missing):
//!
//! - **Conflicts are an execute-time concern.** The legacy analyzer matched
//!   names against the database before the user picked a conflict policy; the
//!   kernel reports facts and lets `imports.fullbackup.execute` resolve
//!   collisions under the chosen policy.
//! - **No `analysisId`/`expiresAt` staging tuple.** The staged asset already
//!   owns the archive's lifetime, so the analysis needs no server-side state.
//! - **Nested payloads are read with a bounded budget.** A chat line is
//!   validated as JSON only while the archive's read budget lasts; when it runs
//!   out the walk keeps counting lines and reports `ANALYSIS_BUDGET_EXHAUSTED`
//!   instead of pretending the rest was validated.

use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};

use contracts_generated::generated::{
    self, ImportsFullbackupCategory, ImportsFullbackupCategoryAnalysis, ImportsFullbackupWarning,
    ResultImportsFullbackupAnalyze,
};
use neotavern_storage::open::Database;
use rusqlite::OptionalExtension;
use zip::ZipArchive;

use crate::{KernelError, KernelErrorCode};

/// Bounded warning sample (the contract caps the array; `warningCount` carries
/// the full total).
pub(crate) const MAX_WARNING_SAMPLE: usize = 64;
/// Total bytes the walk may decompress while validating nested payloads.
const READ_BUDGET_BYTES: u64 = 256 * 1024 * 1024;
/// Refuse absurd archives before touching them (zip-bomb guard).
pub(crate) const MAX_EXPANDED_BYTES: i64 = 8 * 1024 * 1024 * 1024;
/// Refuse archives with an absurd number of entries.
pub(crate) const MAX_ENTRIES: usize = 400_000;
/// Legacy per-file caps (mirrored so the analysis reports the same verdicts).
pub(crate) const MAX_CHARACTER_BYTES: i64 = 25 * 1024 * 1024;
pub(crate) const MAX_SETTINGS_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_WORLD_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_PRESET_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_CHAT_LINE_CHARS: usize = 16 * 1024 * 1024;
pub(crate) const MAX_BACKGROUND_BYTES: i64 = 64 * 1024 * 1024;

/// Directories that mark a full-data archive root (lowercase).
const ROOT_MARKERS: [&str; 16] = [
    "characters",
    "chats",
    "worlds",
    "user avatars",
    "instruct",
    "context",
    "sysprompt",
    "reasoning",
    "koboldai settings",
    "novelai settings",
    "openai settings",
    "textgen settings",
    "groups",
    "group chats",
    "extensions",
    "themes",
];

/// Preset directories (lowercase); `openai settings` doubles as the API-settings
/// bucket exactly like the legacy analyzer.
pub(crate) const PRESET_DIRECTORIES: [&str; 8] = [
    "instruct",
    "context",
    "sysprompt",
    "reasoning",
    "koboldai settings",
    "novelai settings",
    "openai settings",
    "textgen settings",
];

pub(crate) const IMAGE_EXTENSIONS: [&str; 5] = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

/// Canonical category order of the result array.
pub(crate) const CATEGORY_ORDER: [ImportsFullbackupCategory; 11] = [
    ImportsFullbackupCategory::Characters,
    ImportsFullbackupCategory::Chats,
    ImportsFullbackupCategory::Personas,
    ImportsFullbackupCategory::Lorebooks,
    ImportsFullbackupCategory::Presets,
    ImportsFullbackupCategory::Groups,
    ImportsFullbackupCategory::Backgrounds,
    ImportsFullbackupCategory::ExtensionSettings,
    ImportsFullbackupCategory::ApiSettings,
    ImportsFullbackupCategory::LegacyExtensions,
    ImportsFullbackupCategory::Themes,
];

pub(crate) fn category_index(id: ImportsFullbackupCategory) -> usize {
    match id {
        ImportsFullbackupCategory::Characters => 0,
        ImportsFullbackupCategory::Chats => 1,
        ImportsFullbackupCategory::Personas => 2,
        ImportsFullbackupCategory::Lorebooks => 3,
        ImportsFullbackupCategory::Presets => 4,
        ImportsFullbackupCategory::Groups => 5,
        ImportsFullbackupCategory::Backgrounds => 6,
        ImportsFullbackupCategory::ExtensionSettings => 7,
        ImportsFullbackupCategory::ApiSettings => 8,
        ImportsFullbackupCategory::LegacyExtensions => 9,
        ImportsFullbackupCategory::Themes => 10,
    }
}

/// One archive entry as recorded in the central directory.
pub(crate) struct Entry {
    /// Archive path with forward slashes, exactly as stored.
    pub(crate) name: String,
    /// Lowercase path used for matching.
    pub(crate) lower: String,
    pub(crate) size: i64,
    pub(crate) is_dir: bool,
}

/// Whole central directory: the entries, the ancestor directory set (for root
/// detection) and the byte totals. Shared by `analyze` and `execute` so both
/// halves classify the same archive shape the same way.
pub(crate) struct ArchiveIndex {
    pub(crate) entries: Vec<Entry>,
    pub(crate) dirs: BTreeSet<String>,
    pub(crate) total_expanded: i64,
    pub(crate) total_compressed: i64,
}

/// Indexes the ZIP central directory (two passes: root detection needs the
/// whole shape, classification needs the entries).
pub(crate) fn index_archive(archive: &mut ZipArchive<File>) -> Result<ArchiveIndex, KernelError> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    let mut total_expanded: i64 = 0;
    let mut total_compressed: i64 = 0;
    if archive.len() > MAX_ENTRIES {
        return Err(archive_too_large(MAX_EXPANDED_BYTES));
    }
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index_raw(index) else {
            continue;
        };
        let name = entry.name().replace('\\', "/");
        let is_dir = entry.is_dir();
        let size = entry.size() as i64;
        let compressed_size = entry.compressed_size() as i64;
        total_expanded = total_expanded.saturating_add(size);
        total_compressed = total_compressed.saturating_add(compressed_size);
        if total_expanded > MAX_EXPANDED_BYTES {
            return Err(archive_too_large(MAX_EXPANDED_BYTES));
        }
        let lower = name.to_lowercase();
        dirs.insert(lower.trim_end_matches('/').to_string());
        // Every ancestor directory counts, not only explicit directory
        // entries: a flat ZIP from the legacy exporter has no dir rows.
        let mut cursor = if is_dir {
            lower.trim_end_matches('/').to_string()
        } else {
            parent_of(&lower).trim_end_matches('/').to_string()
        };
        loop {
            dirs.insert(format!("{cursor}/"));
            match cursor.rfind('/') {
                Some(index) => cursor.truncate(index),
                None => break,
            }
        }
        entries.push(Entry {
            name,
            lower,
            size,
            is_dir,
        });
    }
    Ok(ArchiveIndex {
        entries,
        dirs,
        total_expanded,
        total_compressed,
    })
}

/// Accumulated analysis state.
struct Analysis {
    categories: [ImportsFullbackupCategoryAnalysis; 11],
    warnings: Vec<ImportsFullbackupWarning>,
    warning_count: i64,
    read_budget: u64,
    budget_exhausted: bool,
}

impl Analysis {
    fn new() -> Self {
        Self {
            categories: CATEGORY_ORDER.map(|id| ImportsFullbackupCategoryAnalysis {
                id,
                discovered: 0,
                dependent_records: 0,
                invalid: 0,
                size_bytes: 0,
            }),
            warnings: Vec::new(),
            warning_count: 0,
            read_budget: READ_BUDGET_BYTES,
            budget_exhausted: false,
        }
    }

    fn bump(
        &mut self,
        id: ImportsFullbackupCategory,
        f: impl FnOnce(&mut ImportsFullbackupCategoryAnalysis),
    ) {
        f(&mut self.categories[category_index(id)]);
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

    fn take_budget(&mut self, bytes: u64) -> bool {
        if self.read_budget < bytes {
            if !self.budget_exhausted {
                self.budget_exhausted = true;
                self.warn("ANALYSIS_BUDGET_EXHAUSTED", None);
            }
            return false;
        }
        self.read_budget -= bytes;
        true
    }
}

pub(crate) fn archive_invalid(reason: &str) -> KernelError {
    KernelError::product(
        "FULLBACKUP_ARCHIVE_INVALID".to_string(),
        vec![("reason".to_string(), reason.to_string())],
    )
}

pub(crate) fn data_root_missing() -> KernelError {
    KernelError::product("FULLBACKUP_DATA_ROOT_NOT_FOUND".to_string(), Vec::new())
}

fn archive_too_large(limit: i64) -> KernelError {
    KernelError::product(
        "FULLBACKUP_ARCHIVE_TOO_LARGE".to_string(),
        vec![("limitBytes".to_string(), limit.to_string())],
    )
}

pub(crate) fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StorageFailure, format!("{context}: {err}"))
}

pub(crate) fn storage(message: String) -> KernelError {
    KernelError::new(KernelErrorCode::StorageFailure, message)
}

fn encode_result(dto: &ResultImportsFullbackupAnalyze) -> Result<Vec<u8>, KernelError> {
    crate::product::validate(dto, generated::validate_result_imports_fullbackup_analyze)?;
    crate::product::encode(dto)
}

/// `imports.fullbackup.analyze` — inspect a staged legacy full-data user-data
/// archive without writing anything.
pub fn imports_fullbackup_analyze(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_imports_fullbackup_analyze(request)?;

    // 1. The staged archive asset must exist; its published checksum IS the
    //    sha256 of the archive bytes, so the analysis never re-hashes a
    //    multi-gigabyte file.
    let row: Option<(String, String, i64)> = db
        .conn()
        .query_row(
            "SELECT relative_key, checksum_sha256, size_bytes FROM __neotavern_assets WHERE id = ?1",
            rusqlite::params![req.asset_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| sqlite(err, "imports.fullbackup.analyze: asset lookup"))?;
    let (relative_key, source_hash, _size_bytes) =
        row.ok_or_else(|| crate::assets::asset_not_found(&req.asset_id))?;

    let path = neotavern_storage::assets::resolve_asset_path(db, &relative_key)
        .map_err(|err| storage(format!("imports.fullbackup.analyze: {err}")))?;
    let file = File::open(&path)
        .map_err(|err| storage(format!("imports.fullbackup.analyze: cannot open: {err}")))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|err| archive_invalid(&format!("not a readable zip: {err}")))?;

    // 2. Index the central directory.
    let index = index_archive(&mut archive)?;
    let entries = &index.entries;
    let dirs = &index.dirs;
    let total_expanded = index.total_expanded;
    let total_compressed = index.total_compressed;

    // 3. Detect the user-data root.
    let root = detect_root(entries, dirs).ok_or_else(data_root_missing)?;

    // 4. Classify.
    let mut analysis = Analysis::new();

    // Unsafe / unsupported archive shape first: an absolute path or a `..`
    // segment never reaches a category (the importer would refuse it too).
    for entry in entries {
        if entry.is_dir {
            continue;
        }
        if is_unsafe_path(&entry.name) {
            analysis.warn("ARCHIVE_ENTRY_UNSAFE", Some(&entry.name));
        }
    }

    // settings.json drives personas / extension settings / API preset counts.
    let settings_entry = entries
        .iter()
        .find(|entry| !entry.is_dir && entry.lower == format!("{root}settings.json"))
        .map(|entry| entry.name.clone());
    let settings_value = match &settings_entry {
        Some(name) => read_json(&mut archive, name, &mut analysis, MAX_SETTINGS_BYTES),
        None => None,
    };
    if settings_entry.is_some() {
        analysis.warn(
            "SETTINGS_PARTIALLY_IMPORTED",
            Some(&format!("{root}settings.json")),
        );
    }
    let secrets = entries
        .iter()
        .find(|entry| !entry.is_dir && entry.lower == format!("{root}secrets.json"));
    if let Some(entry) = secrets {
        analysis.warn("SECRETS_SKIPPED", Some(&entry.name));
    }
    let legacy_plugins = entries
        .iter()
        .any(|entry| !entry.is_dir && entry.lower.starts_with(&format!("{root}extensions/")));
    if legacy_plugins {
        analysis.warn(
            "LEGACY_EXTENSIONS_SKIPPED",
            Some(&format!("{root}extensions")),
        );
    }

    // 4a. Characters: `characters/*.png` (and `.json` only when no sibling png).
    let character_names: Vec<&str> = entries
        .iter()
        .filter(|entry| {
            !entry.is_dir
                && entry.lower.starts_with(&format!("{root}characters/"))
                && (entry.lower.ends_with(".png") || entry.lower.ends_with(".json"))
        })
        .map(|entry| entry.name.as_str())
        .collect();
    for name in &character_names {
        let lower = name.to_lowercase();
        if lower.ends_with(".json")
            && character_names
                .iter()
                .any(|other| other.to_lowercase() == lower.replace(".json", ".png"))
        {
            continue;
        }
        let size = entries
            .iter()
            .find(|entry| entry.name == *name)
            .map(|entry| entry.size)
            .unwrap_or(0);
        analysis.bump(ImportsFullbackupCategory::Characters, |category| {
            category.discovered += 1;
            category.size_bytes += size;
        });
        if size > MAX_CHARACTER_BYTES {
            analysis.bump(ImportsFullbackupCategory::Characters, |category| {
                category.invalid += 1;
            });
            analysis.warn("CHARACTER_TOO_LARGE", Some(name));
            continue;
        }
        if lower.ends_with(".json") {
            let parsed = read_json(
                &mut archive,
                name,
                &mut analysis,
                MAX_CHARACTER_BYTES as u64,
            );
            if parsed.is_none() {
                analysis.bump(ImportsFullbackupCategory::Characters, |category| {
                    category.invalid += 1;
                });
                analysis.warn("CHARACTER_IMPORT_FAILED", Some(name));
            }
        }
    }

    // 4b. Chats: `chats/*.jsonl`, counting records and validating lines while
    //     the read budget lasts.
    let chat_names: Vec<String> = entries
        .iter()
        .filter(|entry| {
            !entry.is_dir
                && entry.lower.starts_with(&format!("{root}chats/"))
                && entry.lower.ends_with(".jsonl")
        })
        .map(|entry| entry.name.clone())
        .collect();
    for name in &chat_names {
        let size = entries
            .iter()
            .find(|entry| entry.name == *name)
            .map(|entry| entry.size)
            .unwrap_or(0);
        analysis.bump(ImportsFullbackupCategory::Chats, |category| {
            category.discovered += 1;
            category.size_bytes += size;
        });
        let (records, invalid) = scan_chat(&mut archive, name, &mut analysis);
        analysis.bump(ImportsFullbackupCategory::Chats, |category| {
            category.dependent_records += records;
            category.invalid += invalid;
        });
    }

    // 4c. Lorebooks: `worlds/*.json`, counting entry objects.
    let world_names: Vec<String> = entries
        .iter()
        .filter(|entry| {
            !entry.is_dir
                && entry.lower.starts_with(&format!("{root}worlds/"))
                && entry.lower.ends_with(".json")
        })
        .map(|entry| entry.name.clone())
        .collect();
    for name in &world_names {
        let size = entries
            .iter()
            .find(|entry| entry.name == *name)
            .map(|entry| entry.size)
            .unwrap_or(0);
        analysis.bump(ImportsFullbackupCategory::Lorebooks, |category| {
            category.discovered += 1;
            category.size_bytes += size;
        });
        match read_json(&mut archive, name, &mut analysis, MAX_WORLD_BYTES) {
            Some(value) => {
                let entries_map = value.get("entries").and_then(|value| value.as_object());
                let mut valid = 0i64;
                let mut invalid = 0i64;
                if let Some(map) = entries_map {
                    for entry in map.values() {
                        if entry.is_object() {
                            valid += 1;
                        } else {
                            invalid += 1;
                        }
                    }
                }
                analysis.bump(ImportsFullbackupCategory::Lorebooks, |category| {
                    category.dependent_records += valid;
                    category.invalid += invalid;
                });
                if invalid > 0 {
                    analysis.warn("LORE_ENTRY_INVALID", Some(name));
                }
            }
            None => {
                analysis.bump(ImportsFullbackupCategory::Lorebooks, |category| {
                    category.invalid += 1;
                });
                analysis.warn("LOREBOOK_IMPORT_FAILED", Some(name));
            }
        }
    }

    // 4d. Presets: the eight preset directories; `openai settings` also feeds
    //     the API-settings bucket.
    for directory in PRESET_DIRECTORIES {
        let prefix = format!("{root}{directory}/");
        let names: Vec<String> = entries
            .iter()
            .filter(|entry| {
                !entry.is_dir && entry.lower.starts_with(&prefix) && entry.lower.ends_with(".json")
            })
            .map(|entry| entry.name.clone())
            .collect();
        for name in &names {
            let size = entries
                .iter()
                .find(|entry| entry.name == *name)
                .map(|entry| entry.size)
                .unwrap_or(0);
            analysis.bump(ImportsFullbackupCategory::Presets, |category| {
                category.discovered += 1;
                category.size_bytes += size;
            });
            if directory == "openai settings" {
                analysis.bump(ImportsFullbackupCategory::ApiSettings, |category| {
                    category.discovered += 1;
                    category.size_bytes += size;
                });
            }
            if read_json(&mut archive, name, &mut analysis, MAX_PRESET_BYTES).is_none() {
                analysis.bump(ImportsFullbackupCategory::Presets, |category| {
                    category.invalid += 1;
                });
                analysis.warn("PRESET_IMPORT_FAILED", Some(name));
            }
        }
    }

    // 4e. Groups: `groups/*.json` plus the linked `group chats/<id>.jsonl`.
    let group_names: Vec<String> = entries
        .iter()
        .filter(|entry| {
            !entry.is_dir
                && entry.lower.starts_with(&format!("{root}groups/"))
                && entry.lower.ends_with(".json")
        })
        .map(|entry| entry.name.clone())
        .collect();
    for name in &group_names {
        let size = entries
            .iter()
            .find(|entry| entry.name == *name)
            .map(|entry| entry.size)
            .unwrap_or(0);
        analysis.bump(ImportsFullbackupCategory::Groups, |category| {
            category.discovered += 1;
            category.size_bytes += size;
        });
        let parsed = read_json(&mut archive, name, &mut analysis, MAX_PRESET_BYTES);
        let Some(value) = parsed else {
            analysis.bump(ImportsFullbackupCategory::Groups, |category| {
                category.invalid += 1;
            });
            analysis.warn("GROUP_IMPORT_FAILED", Some(name));
            continue;
        };
        let named = value
            .get("name")
            .and_then(|value| value.as_str())
            .is_some_and(|name| !name.trim().is_empty());
        if !named {
            analysis.bump(ImportsFullbackupCategory::Groups, |category| {
                category.invalid += 1;
            });
        }
        if let Some(id) = value.get("id").and_then(|value| value.as_str()) {
            let transcript = format!("{root}group chats/{id}.jsonl");
            if let Some(entry) = entries
                .iter()
                .find(|entry| !entry.is_dir && entry.lower == transcript.to_lowercase())
            {
                let entry_name = entry.name.clone();
                analysis.bump(ImportsFullbackupCategory::Groups, |category| {
                    category.size_bytes += entry.size;
                });
                let (records, invalid) = scan_chat(&mut archive, &entry_name, &mut analysis);
                analysis.bump(ImportsFullbackupCategory::Groups, |category| {
                    category.dependent_records += records;
                    category.invalid += invalid;
                });
            }
        }
    }

    // 4f. Personas: `settings.json#power_user.personas` plus the avatar sizes.
    if let Some(settings) = &settings_value {
        let power_user = settings.get("power_user").unwrap_or(settings);
        if let Some(personas) = power_user
            .get("personas")
            .and_then(|value| value.as_object())
        {
            let mut discovered = 0i64;
            let mut invalid = 0i64;
            for (avatar_id, name) in personas {
                discovered += 1;
                // legacy full-data stores an object per avatar id (`{name, description}`)
                // and older backups a bare string; anything else is invalid.
                let valid = match name {
                    serde_json::Value::String(text) => !text.trim().is_empty(),
                    serde_json::Value::Object(map) => map
                        .get("name")
                        .and_then(|value| value.as_str())
                        .is_some_and(|text| !text.trim().is_empty()),
                    _ => false,
                };
                if !valid {
                    invalid += 1;
                    analysis.warn(
                        "PERSONA_INVALID",
                        Some(&format!(
                            "{root}settings.json#power_user.personas.{avatar_id}"
                        )),
                    );
                    continue;
                }
                let avatar_path = format!("{root}user avatars/{}", avatar_id.to_lowercase());
                if let Some(entry) = entries
                    .iter()
                    .find(|entry| !entry.is_dir && entry.lower.starts_with(&avatar_path))
                {
                    let size = entry.size;
                    analysis.bump(ImportsFullbackupCategory::Personas, |category| {
                        category.size_bytes += size;
                    });
                }
            }
            let settings_size = settings_entry
                .as_ref()
                .and_then(|name| entries.iter().find(|entry| entry.name == *name))
                .map(|entry| entry.size)
                .unwrap_or(0);
            analysis.bump(ImportsFullbackupCategory::Personas, |category| {
                category.discovered += discovered;
                category.invalid += invalid;
                category.size_bytes += settings_size;
            });
        }
        // 4g. Extension settings: one row per extension namespace.
        if let Some(extensions) = settings
            .get("extension_settings")
            .and_then(|value| value.as_object())
        {
            let namespaces = extensions.len() as i64;
            let settings_size = settings_entry
                .as_ref()
                .and_then(|name| entries.iter().find(|entry| entry.name == *name))
                .map(|entry| entry.size)
                .unwrap_or(0);
            analysis.bump(ImportsFullbackupCategory::ExtensionSettings, |category| {
                category.discovered += namespaces;
                category.size_bytes += settings_size;
            });
        }
    }

    // 4h. Backgrounds: image files under `backgrounds/`.
    for entry in entries {
        if entry.is_dir
            || !entry.lower.starts_with(&format!("{root}backgrounds/"))
            || !IMAGE_EXTENSIONS
                .iter()
                .any(|extension| entry.lower.ends_with(extension))
        {
            continue;
        }
        let size = entry.size;
        analysis.bump(ImportsFullbackupCategory::Backgrounds, |category| {
            category.discovered += 1;
            category.size_bytes += size;
            if size > MAX_BACKGROUND_BYTES {
                category.invalid += 1;
            }
        });
        if size > MAX_BACKGROUND_BYTES {
            analysis.warn("BACKGROUND_TOO_LARGE", Some(&entry.name));
        }
    }

    // 4i. Legacy extensions: `extensions/<dir>/index.js` and its tree size.
    let mut extension_dirs: HashMap<String, (bool, i64)> = HashMap::new();
    for entry in entries {
        if !entry.lower.starts_with(&format!("{root}extensions/")) {
            continue;
        }
        let rest = &entry.lower[format!("{root}extensions/").len()..];
        let dir = rest.split('/').next().unwrap_or_default().to_string();
        if dir.is_empty() {
            continue;
        }
        let slot = extension_dirs.entry(dir).or_insert((false, 0));
        if entry.lower.ends_with("/index.js") {
            slot.0 = true;
        }
        if !entry.is_dir {
            slot.1 += entry.size;
        }
    }
    for (_dir, (has_index, size)) in extension_dirs {
        if !has_index {
            continue;
        }
        analysis.bump(ImportsFullbackupCategory::LegacyExtensions, |category| {
            category.discovered += 1;
            category.size_bytes += size;
        });
    }

    // 4j. Themes: `themes/*.css` / `*.json`.
    for entry in entries {
        if entry.is_dir || !entry.lower.starts_with(&format!("{root}themes/")) {
            continue;
        }
        if !entry.lower.ends_with(".css") && !entry.lower.ends_with(".json") {
            continue;
        }
        let size = entry.size;
        analysis.bump(ImportsFullbackupCategory::Themes, |category| {
            category.discovered += 1;
            category.size_bytes += size;
        });
    }

    let dto = ResultImportsFullbackupAnalyze {
        source_hash,
        total_compressed_bytes: total_compressed,
        total_expanded_bytes: total_expanded,
        categories: analysis.categories.to_vec(),
        warning_count: analysis.warning_count,
        warnings: analysis.warnings,
    };
    encode_result(&dto)
}

/// Parent directory of a lowercase archive path ("" for a top-level file).
pub(crate) fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[..index + 1],
        None => "",
    }
}

/// Absolute paths, drive letters and `..` segments are refused by the importer.
pub(crate) fn is_unsafe_path(path: &str) -> bool {
    if path.starts_with('/') || path.starts_with('\\') {
        return true;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return true;
    }
    path.split('/').any(|segment| segment == "..")
}

/// Scores every directory that looks like a full-data archive root.
pub(crate) fn detect_root(entries: &[Entry], dirs: &BTreeSet<String>) -> Option<String> {
    let mut candidates: Vec<String> = dirs
        .iter()
        .filter(|dir| dir.is_empty() || dir.ends_with('/'))
        .cloned()
        .collect();
    if !candidates.iter().any(|dir| dir.is_empty()) {
        candidates.push(String::new());
    }
    let mut best: Option<(i64, usize, String)> = None;
    for candidate in candidates {
        let mut score: i64 = 0;
        if entries
            .iter()
            .any(|entry| !entry.is_dir && entry.lower == format!("{candidate}settings.json"))
        {
            score += 3;
        }
        for marker in ROOT_MARKERS {
            if dirs.contains(&format!("{candidate}{marker}/")) {
                score += 1;
            }
        }
        let basename = candidate
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        if basename == "default-user" {
            score += 2;
        }
        let depth = candidate.matches('/').count();
        let better = match &best {
            None => true,
            Some((best_score, best_depth, _)) => {
                score > *best_score || (score == *best_score && depth < *best_depth)
            }
        };
        if better && score > 0 {
            best = Some((score, depth, candidate));
        }
    }
    best.map(|(_, _, dir)| dir)
}

/// Reads an entry and parses it as a JSON object, honouring the read budget.
fn read_json(
    archive: &mut ZipArchive<File>,
    name: &str,
    analysis: &mut Analysis,
    cap: u64,
) -> Option<serde_json::Value> {
    let Ok(mut entry) = archive.by_name(name) else {
        return None;
    };
    let size = entry.size();
    if size > cap {
        return None;
    }
    if !analysis.take_budget(size) {
        return None;
    }
    let mut buffer = Vec::with_capacity(size as usize);
    if entry.read_to_end(&mut buffer).is_err() {
        return None;
    }
    serde_json::from_slice::<serde_json::Value>(&buffer)
        .ok()
        .filter(|value| value.is_object())
}

/// Streams a chat transcript: counts records and flags lines that are not JSON.
fn scan_chat(archive: &mut ZipArchive<File>, name: &str, analysis: &mut Analysis) -> (i64, i64) {
    let Ok(entry) = archive.by_name(name) else {
        return (0, 1);
    };
    let mut records = 0i64;
    let mut invalid = 0i64;
    let mut reader = BufReader::new(entry);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(count) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if count > MAX_CHAT_LINE_CHARS {
                    invalid += 1;
                    analysis.warn("CHAT_LINE_TOO_LARGE", Some(name));
                    continue;
                }
                records += 1;
                if analysis.take_budget(count as u64)
                    && serde_json::from_str::<serde_json::Value>(trimmed).is_err()
                {
                    invalid += 1;
                    analysis.warn("CHAT_RECORD_INVALID", Some(name));
                }
            }
            Err(_) => {
                invalid += 1;
                analysis.warn("CHAT_IMPORT_FAILED", Some(name));
                break;
            }
        }
    }
    (records, invalid)
}
