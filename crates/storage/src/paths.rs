//! Data-root path layout and managed relative-key validation (ТЗ §25, Фаза 2).
//!
//! All on-disk artifacts of a data root live at fixed relative paths beneath
//! the root: the SQLite database, the assets directory, the snapshots
//! directory and the lease lock file. [`validate_relative_key`] enforces the
//! managed-key grammar for asset storage, and [`join_checked`] performs a
//! lexical containment check before any key is turned into a path.

use std::path::{Component, Path, PathBuf};

use crate::error::{Result, StorageError, StorageErrorCode};
use crate::MAX_RELATIVE_KEY_LEN;

/// SQLite database file name inside a data root.
pub const DB_FILE_NAME: &str = "database.sqlite";

/// Assets directory name inside a data root.
pub const ASSETS_DIR: &str = "assets";

/// Snapshots directory name inside a data root.
pub const SNAPSHOTS_DIR: &str = "snapshots";

/// Lease lock file name inside a data root.
pub const LOCK_FILE: &str = ".neotavern.lock";

/// Absolute path of the SQLite database for `root`.
pub fn db_path(root: &Path) -> PathBuf {
    root.join(DB_FILE_NAME)
}

/// Absolute path of the assets directory for `root`.
pub fn assets_dir(root: &Path) -> PathBuf {
    root.join(ASSETS_DIR)
}

/// Absolute path of the snapshots directory for `root`.
pub fn snapshots_dir(root: &Path) -> PathBuf {
    root.join(SNAPSHOTS_DIR)
}

/// Absolute path of the lease lock file for `root`.
pub fn lock_path(root: &Path) -> PathBuf {
    root.join(LOCK_FILE)
}

/// Validates a managed relative key for asset storage.
///
/// Rules (every violation → [`StorageErrorCode::InvalidAssetKey`] with the
/// rule name as a `rule` parameter):
///
/// 1. no NUL or control characters (`char::is_control`);
/// 2. `/`-separated components only: no `\`, no empty components, no `.` or
///    `..` components;
/// 3. no leading or trailing `/`; total length in UTF-8 bytes `1..=MAX_RELATIVE_KEY_LEN`;
/// 4. no component is a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`,
///    `COM1..COM9`, `LPT1..LPT9`), case-insensitive, with or without an
///    extension;
/// 5. no component ends with `.` or a space.
pub fn validate_relative_key(key: &str) -> Result<()> {
    let rule = |rule: &str| -> Result<()> {
        Err(StorageError::with(
            StorageErrorCode::InvalidAssetKey,
            format!("invalid managed relative key {key:?}: rule {rule}"),
            vec![
                ("rule".to_string(), rule.to_string()),
                ("key".to_string(), key.to_string()),
            ],
        ))
    };

    // Rule 3 (part 1): length in UTF-8 bytes.
    let len = key.len();
    if len == 0 {
        return rule("empty");
    }
    if len > MAX_RELATIVE_KEY_LEN {
        return rule("too_long");
    }

    // Rule 3 (part 2): no boundary slashes.
    if key.starts_with('/') || key.ends_with('/') {
        return rule("leading_or_trailing_slash");
    }

    // Rule 1: no control characters.
    if key.chars().any(char::is_control) {
        return rule("control_char");
    }

    // Rule 2: only '/' separators.
    if key.contains('\\') {
        return rule("backslash");
    }

    // Rules 2, 4, 5: per-component checks.
    for component in key.split('/') {
        if component.is_empty() {
            return rule("empty_component");
        }
        if component == "." || component == ".." {
            return rule("dot_component");
        }
        if is_reserved_windows_name(component) {
            return rule("reserved_name");
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return rule("trailing_dot_or_space");
        }
    }

    Ok(())
}

/// True when `component` is a Windows reserved device name, with or without an
/// extension: `CON`, `PRN`, `AUX`, `NUL`, `COM1..COM9`, `LPT1..LPT9`,
/// case-insensitive. Enforced on every platform to keep keys portable.
fn is_reserved_windows_name(component: &str) -> bool {
    // Windows reservedness applies to the base name before the first dot.
    let base = component.split('.').next().unwrap_or(component);
    let upper = base.to_ascii_uppercase();

    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }

    // COM1..COM9 / LPT1..LPT9: exactly 4 chars, digit 1..=9 in position 4.
    let is_com_lpt = |prefix: &str| {
        upper.len() == 4 && upper.starts_with(prefix) && {
            let digit = upper.as_bytes()[3];
            digit.is_ascii_digit() && digit != b'0'
        }
    };
    is_com_lpt("COM") || is_com_lpt("LPT")
}

/// Joins `root` with a validated `key`, verifying the result stays inside
/// `root` lexically.
///
/// [`validate_relative_key`] already rules out absolute keys and `..`
/// components, so the component-wise prefix check is a defense-in-depth guard
/// against any future weakening of the grammar; the caller's symlink check in
/// `assets.rs` additionally canonicalizes the parent directory.
pub fn join_checked(root: &Path, key: &str) -> Result<PathBuf> {
    validate_relative_key(key)?;
    let joined = root.join(key);

    let root_components: Vec<Component<'_>> = root.components().collect();
    let joined_components: Vec<Component<'_>> = joined.components().collect();
    if joined_components.len() < root_components.len()
        || !joined_components.starts_with(&root_components)
    {
        return Err(StorageError::with(
            StorageErrorCode::InvalidAssetKey,
            format!("joined path {joined:?} escapes root {root:?}"),
            vec![
                ("rule".to_string(), String::from("escape")),
                ("root".to_string(), root.display().to_string()),
                ("key".to_string(), key.to_string()),
            ],
        ));
    }
    Ok(joined)
}
