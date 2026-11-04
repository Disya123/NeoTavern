//! Plugin bundle store (ADR-0066 P2b).
//!
//! A plugin is not only a descriptor: it can ship code and assets. This module is
//! the host half of that — it takes a verified source directory and publishes it
//! under `<data root>/plugin-bundles/<pluginId>/<version>/`, so the UI frame and the
//! native supervisor have a place to read bytes from that belongs to the plugin and
//! to nothing else.
//!
//! Rules that matter, and why:
//!
//! - every declared file is hashed before publication; a mismatch aborts the whole
//!   install, so a half-verified bundle is never visible to a plugin host;
//! - relative paths are validated segment by segment — a bundle that names
//!   `../escape.js` is rejected before any copy, not after;
//! - publication is atomic: files land in `.staging-<random>`, then one rename makes
//!   the version directory appear. A reader never sees a partial bundle;
//! - limits are enforced before reading (file count, per-file and total bytes), so a
//!   bundle cannot be used to fill the disk;
//! - this module never executes anything. Staging bytes is a storage operation; what
//!   runs them is the supervisor (P3), and it is not this code.
//!
//! The wire surface and the kernel dispatch for `plugins.bundle.*` are the next
//! slice: today the host calls these functions directly, exactly like the job
//! claim/report seam.

use std::fs;
use std::io::{Read as _, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest as _, Sha256};

/// One executable or asset the package declares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleFile {
    /// Package-relative path (`ui/app.js`, `native/windows-x64/agent.exe`).
    pub path: String,
    /// Lowercase sha256 of the bytes.
    pub sha256: String,
}

/// What a caller asks to publish.
#[derive(Clone, Debug)]
pub struct BundleRequest {
    pub plugin_id: String,
    pub version: String,
    pub files: Vec<BundleFile>,
}

impl BundleRequest {
    /// Builds a request from the manifest `checksums` map plus optional executables.
    pub fn from_checksums(
        plugin_id: impl Into<String>,
        version: impl Into<String>,
        checksums: &[(impl AsRef<str>, impl AsRef<str>)],
    ) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            version: version.into(),
            files: checksums
                .iter()
                .map(|(path, digest)| BundleFile {
                    path: path.as_ref().to_string(),
                    sha256: digest.as_ref().to_string(),
                })
                .collect(),
        }
    }
}

/// A published bundle, as the host reads it back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledBundle {
    pub plugin_id: String,
    pub version: String,
    pub files: Vec<BundleFile>,
    pub total_bytes: u64,
}

/// Why a bundle was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BundleError {
    InvalidPluginId(String),
    InvalidVersion(String),
    /// A declared path is absolute, contains `..`, a drive prefix or a separator
    /// that is not `/`.
    UnsafePath(String),
    /// The source file is missing.
    Missing(String),
    /// Declared digest is malformed.
    MalformedDigest(String),
    /// Bytes do not match the declared digest.
    DigestMismatch {
        path: String,
    },
    TooManyFiles(usize),
    FileTooLarge {
        path: String,
        bytes: u64,
    },
    BundleTooLarge(u64),
    Io(String),
}

impl BundleError {
    /// Stable product-style code for logs and (later) wire errors.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidPluginId(_) => "PLUGIN_INVALID",
            Self::InvalidVersion(_) => "PLUGIN_INVALID",
            Self::UnsafePath(_) => "BUNDLE_UNSAFE_PATH",
            Self::Missing(_) => "BUNDLE_FILE_MISSING",
            Self::MalformedDigest(_) => "BUNDLE_DIGEST_INVALID",
            Self::DigestMismatch { .. } => "BUNDLE_DIGEST_MISMATCH",
            Self::TooManyFiles(_) => "BUNDLE_TOO_MANY_FILES",
            Self::FileTooLarge { .. } => "BUNDLE_FILE_TOO_LARGE",
            Self::BundleTooLarge(_) => "BUNDLE_TOO_LARGE",
            Self::Io(_) => "BUNDLE_IO",
        }
    }
}

/// Package limits. Deliberately generous for models, hard against disk filling.
pub const MAX_FILES: usize = 512;
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_BUNDLE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Largest range a single read may ask for.
pub const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;

const ID_RE: &str = "abcdefghijklmnopqrstuvwxyz0123456789_-.";

fn valid_plugin_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| ID_RE.contains(c))
        && !value.starts_with('.')
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+')
        && !value.contains("..")
        && !value.starts_with('.')
}

/// True when `path` is a clean package-relative path.
fn safe_relative(path: &str) -> bool {
    if path.is_empty() || path.len() > 1024 || path.contains('\\') || path.starts_with('/') {
        return false;
    }
    if path.len() > 1 && path.as_bytes()[1] == b':' {
        return false; // `C:/...`
    }
    path.split('/').all(|segment| {
        !segment.is_empty() && segment != "." && segment != ".." && !segment.contains('\0')
    })
}

fn join_checked(root: &Path, relative: &str) -> Result<PathBuf, BundleError> {
    if !safe_relative(relative) {
        return Err(BundleError::UnsafePath(relative.to_string()));
    }
    let joined = root.join(relative);
    // Belt and braces: the resolved path must stay under the root even if a
    // segment somehow slips past the textual check.
    if !joined.starts_with(root) {
        return Err(BundleError::UnsafePath(relative.to_string()));
    }
    Ok(joined)
}

fn sha256_file(path: &Path) -> Result<String, BundleError> {
    let mut file = fs::File::open(path).map_err(|error| BundleError::Io(error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| BundleError::Io(error.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Path of one published version.
pub fn bundle_dir(data_root: &Path, plugin_id: &str, version: &str) -> PathBuf {
    data_root
        .join("plugin-bundles")
        .join(plugin_id)
        .join(version)
}

/// Installs `request` from `source_dir` into the bundle store.
///
/// Verification happens entirely before publication: every file is hashed, limits
/// are checked, and only then is the staging directory renamed into place.
pub fn install_bundle(
    data_root: &Path,
    source_dir: &Path,
    request: &BundleRequest,
) -> Result<InstalledBundle, BundleError> {
    if !valid_plugin_id(&request.plugin_id) {
        return Err(BundleError::InvalidPluginId(request.plugin_id.clone()));
    }
    if !valid_version(&request.version) {
        return Err(BundleError::InvalidVersion(request.version.clone()));
    }
    if request.files.len() > MAX_FILES {
        return Err(BundleError::TooManyFiles(request.files.len()));
    }
    if request.files.is_empty() {
        return Err(BundleError::Missing("<no files declared>".to_string()));
    }

    let mut seen = std::collections::BTreeSet::new();
    for file in &request.files {
        if !safe_relative(&file.path) {
            return Err(BundleError::UnsafePath(file.path.clone()));
        }
        if file.sha256.len() != 64 || !file.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(BundleError::MalformedDigest(file.path.clone()));
        }
        if !seen.insert(file.path.to_ascii_lowercase()) {
            // Case-insensitive duplicates are how a package smuggles two files that
            // collide on Windows; refuse rather than pick one.
            return Err(BundleError::UnsafePath(file.path.clone()));
        }
    }

    // Verify before touching the destination.
    let mut total_bytes = 0u64;
    for file in &request.files {
        let source = join_checked(source_dir, &file.path)?;
        let metadata =
            fs::metadata(&source).map_err(|_| BundleError::Missing(file.path.clone()))?;
        if !metadata.is_file() {
            return Err(BundleError::Missing(file.path.clone()));
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(BundleError::FileTooLarge {
                path: file.path.clone(),
                bytes: metadata.len(),
            });
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_BUNDLE_BYTES {
            return Err(BundleError::BundleTooLarge(total_bytes));
        }
        let digest = sha256_file(&source)?;
        if !digest.eq_ignore_ascii_case(&file.sha256) {
            return Err(BundleError::DigestMismatch {
                path: file.path.clone(),
            });
        }
    }

    let target = bundle_dir(data_root, &request.plugin_id, &request.version);
    let parent = target
        .parent()
        .ok_or_else(|| BundleError::Io("bundle path has no parent".to_string()))?;
    fs::create_dir_all(parent).map_err(|error| BundleError::Io(error.to_string()))?;

    let staging = parent.join(format!(
        ".staging-{}-{}",
        std::process::id(),
        now_millis_for_staging()
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|error| BundleError::Io(error.to_string()))?;
    }
    fs::create_dir_all(&staging).map_err(|error| BundleError::Io(error.to_string()))?;

    let publish = || -> Result<(), BundleError> {
        for file in &request.files {
            let source = join_checked(source_dir, &file.path)?;
            let destination = join_checked(&staging, &file.path)?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| BundleError::Io(error.to_string()))?;
            }
            fs::copy(&source, &destination).map_err(|error| BundleError::Io(error.to_string()))?;
        }
        Ok(())
    };
    if let Err(error) = publish() {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    // Replacing an existing version: remove the old directory first, so the rename
    // never has to merge into a half-populated tree.
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| BundleError::Io(error.to_string()))?;
    }
    fs::rename(&staging, &target).map_err(|error| {
        let _ = fs::remove_dir_all(&staging);
        BundleError::Io(error.to_string())
    })?;

    Ok(InstalledBundle {
        plugin_id: request.plugin_id.clone(),
        version: request.version.clone(),
        files: request.files.clone(),
        total_bytes,
    })
}

/// Reads a bounded range of one published file.
///
/// `offset`/`length` are clamped to [`MAX_READ_BYTES`]; the caller learns the real
/// extent from the returned tuple, so the frame can loop over a large file without
/// asking for more than it can hold in memory.
pub fn read_bundle_file(
    data_root: &Path,
    plugin_id: &str,
    version: &str,
    relative: &str,
    offset: u64,
    length: u64,
) -> Result<(Vec<u8>, u64, bool), BundleError> {
    if !valid_plugin_id(plugin_id) {
        return Err(BundleError::InvalidPluginId(plugin_id.to_string()));
    }
    if !valid_version(version) {
        return Err(BundleError::InvalidVersion(version.to_string()));
    }
    let root = bundle_dir(data_root, plugin_id, version);
    let path = join_checked(&root, relative)?;
    let mut file = fs::File::open(&path).map_err(|_| BundleError::Missing(relative.to_string()))?;
    let size = file
        .metadata()
        .map_err(|error| BundleError::Io(error.to_string()))?
        .len();
    let take = length.min(MAX_READ_BYTES).min(size.saturating_sub(offset));
    file.seek(SeekFrom::Start(offset.min(size)))
        .map_err(|error| BundleError::Io(error.to_string()))?;
    let mut buffer = vec![0u8; take as usize];
    let mut filled = 0usize;
    while filled < buffer.len() {
        let read = file
            .read(&mut buffer[filled..])
            .map_err(|error| BundleError::Io(error.to_string()))?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    let next = offset.saturating_add(filled as u64);
    Ok((buffer, size, next >= size))
}

/// Removes one version, or every version of a plugin when `version` is `None`.
pub fn remove_bundle(
    data_root: &Path,
    plugin_id: &str,
    version: Option<&str>,
) -> Result<bool, BundleError> {
    if !valid_plugin_id(plugin_id) {
        return Err(BundleError::InvalidPluginId(plugin_id.to_string()));
    }
    let plugin_root = data_root.join("plugin-bundles").join(plugin_id);
    let target = match version {
        Some(version) => {
            if !valid_version(version) {
                return Err(BundleError::InvalidVersion(version.to_string()));
            }
            bundle_dir(data_root, plugin_id, version)
        }
        None => plugin_root,
    };
    if !target.exists() {
        return Ok(false);
    }
    // A symlinked plugin root is not a bundle store entry; refuse rather than follow
    // it out of the data root.
    let metadata =
        fs::symlink_metadata(&target).map_err(|error| BundleError::Io(error.to_string()))?;
    if metadata.file_type().is_symlink() {
        return Err(BundleError::UnsafePath(plugin_id.to_string()));
    }
    if !target.starts_with(data_root.join("plugin-bundles")) {
        return Err(BundleError::UnsafePath(plugin_id.to_string()));
    }
    fs::remove_dir_all(&target).map_err(|error| BundleError::Io(error.to_string()))?;
    Ok(true)
}

/// Lists published versions of one plugin, newest directory name first.
pub fn list_versions(data_root: &Path, plugin_id: &str) -> Result<Vec<String>, BundleError> {
    if !valid_plugin_id(plugin_id) {
        return Err(BundleError::InvalidPluginId(plugin_id.to_string()));
    }
    let root = data_root.join("plugin-bundles").join(plugin_id);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(BundleError::Io(error.to_string())),
    };
    let mut versions = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(".staging-") || !valid_version(&name) {
            continue;
        }
        if entry.path().is_dir() {
            versions.push(name);
        }
    }
    versions.sort();
    versions.reverse();
    Ok(versions)
}

/// The only place this module touches the clock, kept out of the pure helpers so
/// unit tests never depend on it.
pub(crate) fn now_millis_for_staging() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// Convenience for callers that already hold an absolute path component set.
pub fn is_safe_relative(path: &str) -> bool {
    safe_relative(path) && {
        let candidate = Path::new(path);
        candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    }
}
