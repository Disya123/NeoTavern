//! Exclusive data-root lease (ТЗ §22).
//!
//! A [`DataRootLease`] is the application-level ownership primitive for a
//! storage data root. Ownership is enforced by an OS file lock on
//! `<root>/.neotavern.lock` taken with `fs2::FileExt::try_lock_exclusive`; the
//! OS releases the lock automatically when the process exits or crashes, so a
//! lease can never be stranded.
//!
//! The lock file also receives a best-effort `pid <pid> acquired <rfc3339>`
//! marker line. The marker content is **diagnostics only and is NEVER
//! ownership proof** (ТЗ §22): only the OS lock itself decides ownership,
//! never the file contents.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use fs2::FileExt;

use crate::error::Result;
use crate::error::{io_err, StorageError, StorageErrorCode};
use crate::paths::lock_path;

/// Exclusive application-level lease on a data root (ТЗ §22).
///
/// The OS primitive is `fs2::FileExt::try_lock_exclusive` on
/// `<root>/.neotavern.lock`; the OS auto-releases the lock on crash or process
/// exit. The `pid`/timestamp marker written into the lock file is DIAGNOSTICS
/// ONLY and is never ownership proof — only the OS lock decides ownership.
pub struct DataRootLease {
    /// The locked lock-file handle. Closing it (or the OS) releases the lock.
    file: File,
    /// The data root this lease guards.
    root: PathBuf,
}

impl DataRootLease {
    /// Creates `root` (if needed), opens/creates `<root>/.neotavern.lock` and
    /// acquires an exclusive OS lock on it.
    ///
    /// If another process already holds the lease, returns
    /// [`StorageErrorCode::DataRootInUse`] with the `("root", path)` parameter.
    /// After the lock is acquired, a best-effort
    /// `pid <pid> acquired <rfc3339>` diagnostic marker is written into the
    /// lock file; write failures are ignored (the marker is never ownership
    /// proof, ТЗ §22).
    pub fn acquire(root: &Path) -> Result<DataRootLease> {
        fs::create_dir_all(root).map_err(|e| io_err(e, "create data root"))?;

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path(root))
            .map_err(|e| io_err(e, "open data root lock file"))?;

        if let Err(e) = file.try_lock_exclusive() {
            if is_lock_contention(&e) {
                return Err(StorageError::with(
                    StorageErrorCode::DataRootInUse,
                    format!("data root is already in use: {}", root.display()),
                    vec![("root".to_string(), root.display().to_string())],
                ));
            }
            return Err(io_err(e, "lock data root"));
        }

        write_diagnostic_marker(&file);

        Ok(DataRootLease {
            file,
            root: root.to_path_buf(),
        })
    }

    /// Returns the data root guarded by this lease.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Releases the lease: drops the OS lock and syncs the lock file to disk.
    ///
    /// Both steps are best-effort — the OS would release the lock anyway when
    /// the handle closes. Errors are still reported so callers can notice
    /// I/O problems during an orderly shutdown.
    pub fn release(self) -> Result<()> {
        self.file
            .unlock()
            .map_err(|e| io_err(e, "unlock data root lease"))?;
        self.file
            .sync_all()
            .map_err(|e| io_err(e, "sync data root lock file"))?;
        Ok(())
    }
}

impl Drop for DataRootLease {
    fn drop(&mut self) {
        // Best-effort: never let a dropped lease strand the root. Errors are
        // irrelevant — the OS releases the lock when the handle closes.
        let _ = self.file.unlock();
        let _ = self.file.sync_all();
    }
}

impl std::fmt::Debug for DataRootLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DataRootLease")
            .field("root", &self.root)
            .finish()
    }
}

/// Probes whether `root` is currently locked by another process.
///
/// `Ok(true)` means a lease is held elsewhere; `Ok(false)` means the root is
/// lockable (no lock file exists yet, or the probe acquired and immediately
/// dropped the lock). This is a read-only diagnostic: neither the root
/// directory nor the lock file is created here, and a missing lock file is
/// reported as "not locked".
pub fn probe_lock(root: &Path) -> Result<bool> {
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(false)
        .open(lock_path(root))
    {
        Ok(file) => file,
        // No lock file (or no root yet) → nobody can hold the lease.
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(io_err(e, "open data root lock file for probe")),
    };

    match file.try_lock_exclusive() {
        Ok(()) => Ok(false), // Lock acquired; `file` drops and releases it at once.
        Err(e) if is_lock_contention(&e) => Ok(true),
        Err(e) => Err(io_err(e, "probe data root lock")),
    }
}

/// Best-effort diagnostic marker write. The marker content is NEVER ownership
/// proof (ТЗ §22); all errors are deliberately ignored.
fn write_diagnostic_marker(file: &File) {
    let _ = file.set_len(0);
    let line = format!(
        "pid {} acquired {}\n",
        std::process::id(),
        crate::now_utc_rfc3339()
    );
    let mut writer = file;
    let _ = writer.seek(SeekFrom::Start(0));
    let _ = writer.write_all(line.as_bytes());
}

/// Whether a lock error means "someone else holds it".
///
/// POSIX maps contention to `ErrorKind::WouldBlock`; Windows fs2 maps
/// `LockFileEx` contention to io error 33 (`ERROR_LOCK_VIOLATION`) and share
/// violations to 36 (`ERROR_SHARING_VIOLATION`) instead. Both are treated as
/// contention — the caller cannot safely own the root either way.
fn is_lock_contention(e: &std::io::Error) -> bool {
    if e.kind() == ErrorKind::WouldBlock {
        return true;
    }
    matches!(e.raw_os_error(), Some(33) | Some(36))
}
