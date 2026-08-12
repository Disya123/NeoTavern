//! Open/inspect entry points for the storage crate (ТЗ §31, Фаза 2).
//!
//! [`inspect`] is a strictly read-only probe of a data root's database file
//! (no file creation, no pragma writes); [`open`] is the full writable open
//! sequence (lease → inspect → compatibility decision → configure → migrate);
//! [`open_read_only`] is the recovery-mode read-only handle (no lease, no
//! writes).
//!
//! Writer coordination: the single writable [`Database`] connection IS the
//! write coordinator for its data root — all mutations must flow through it
//! (see [`Database::transaction`]). There is no read pool in v1.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::OpenFlags;

use crate::{
    baseline::{
        assert_baseline, configure_connection, sqlite_libversion, verify_connection,
        ConnectionPolicy,
    },
    error::*,
    lease::DataRootLease,
    migrations::{fresh_install, migrate, verify_ledger, MigrationProgress},
    paths::{db_path, lock_path},
    APPLICATION_ID, CURRENT_SCHEMA, META_KEY_STORAGE_FORMAT, MIN_DIRECT_SCHEMA, STORAGE_FORMAT,
};

/// Result of a read-only [`inspect`] of a data root's database file.
///
/// When the database file is absent or 0 bytes, `fresh` is `true`, all value
/// fields are `None` and `checksums_ok` is `true` (nothing is created or
/// written by the inspection itself).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspection {
    /// `PRAGMA application_id` of the database, when the database sets one
    /// (value 0 — "not set" — is reported as `None`, as is an absent/empty
    /// file). A database that sets a value different from `APPLICATION_ID`
    /// fails [`inspect`] with `Corrupt` instead of being reported here.
    pub application_id: Option<i32>,
    /// `storageFormat` value from the `__neotavern_meta` table, when the meta
    /// table exists and the row is present; `None` otherwise.
    pub storage_format: Option<i64>,
    /// `PRAGMA user_version` (schema revision) of the database; `None` when
    /// the value is 0 (never migrated) or the file is absent/empty.
    pub schema_revision: Option<i64>,
    /// `true` when the database file is absent or 0 bytes. An inspection never
    /// creates the file.
    pub fresh: bool,
    /// `false` when the `__neotavern_migrations` ledger table exists but
    /// fails [`verify_ledger`] (unknown migration id or checksum mismatch).
    /// `true` when the ledger verifies, or when it does not exist yet
    /// (fresh/foreign database). A mismatch here is reported as a flag, NOT an
    /// error from [`inspect`].
    pub checksums_ok: bool,
}

/// Read-only inspection WITHOUT mutation (ТЗ §31).
///
/// Opens the database with `SQLITE_OPEN_READ_ONLY` — no file is created and no
/// pragma is written. The connection reads through the WAL (a plain read-only
/// open, NOT `immutable=1`: the latter would bypass `-wal` and could report a
/// stale, pre-crash view after a process was killed). Reads `PRAGMA
/// application_id`, `PRAGMA user_version` and the `storageFormat` meta row;
/// when the migrations ledger table exists it also runs [`verify_ledger`] — a
/// checksum mismatch or unknown migration id yields `checksums_ok == false`
/// rather than an error.
///
/// - File absent or 0 bytes → `Inspection { fresh: true, .. }` with all value
///   fields `None` and `checksums_ok: true`; the file is never created.
/// - A database that sets a non-zero `application_id` different from
///   [`APPLICATION_ID`] is not ours → `StorageError` with
///   [`StorageErrorCode::Corrupt`] and the `application_id`/`expected` params.
/// - A non-empty file that is not a SQLite database → `Corrupt` (with the
///   SQLite error message as a param).
pub fn inspect(root: &Path) -> Result<Inspection> {
    let path = db_path(root);
    match fs::metadata(&path) {
        // Absent or empty file → fresh; nothing is created or written.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(fresh_inspection()),
        Ok(md) if md.is_file() && md.len() == 0 => return Ok(fresh_inspection()),
        Ok(_) => {} // existing non-empty file (or a directory — the open below fails then)
        Err(e) => return Err(io_err(e, "inspect: stat database file")),
    }

    // Plain read-only open: reads committed WAL frames (no `immutable=1`).
    let conn = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| classify_open_error(e, "inspect: open read-only"))?;

    // application_id: 0 means "not set" → None. A foreign non-zero value means
    let raw_application_id: i64 = conn
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "inspect: read application_id"))?;
    if raw_application_id != 0 && raw_application_id != APPLICATION_ID as i64 {
        return Err(StorageError::with(
            StorageErrorCode::Corrupt,
            "database file is not a NeoTavern database (foreign application_id)",
            vec![
                (
                    "application_id".into(),
                    format!("0x{raw_application_id:08X}"),
                ),
                ("expected".into(), format!("0x{APPLICATION_ID:08X}")),
            ],
        ));
    }
    let application_id = (raw_application_id != 0).then_some(raw_application_id as i32);

    let schema_revision: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "inspect: read user_version"))?;
    let schema_revision = (schema_revision != 0).then_some(schema_revision);

    let storage_format = if table_exists(&conn, "__neotavern_meta")? {
        read_storage_format(&conn)?
    } else {
        None
    };
    let checksums_ok = if table_exists(&conn, "__neotavern_migrations")? {
        match verify_ledger(&conn) {
            Ok(()) => true,
            // Diagnostic-only: a ledger problem never fails `inspect` itself.
            Err(_) => false,
        }
    } else {
        true
    };

    Ok(Inspection {
        application_id,
        storage_format,
        schema_revision,
        fresh: false,
        checksums_ok,
    })
}

/// Writable handle to a data root's database (ТЗ §31).
///
/// The single writable connection IS the write coordinator for its data root:
/// all mutations MUST flow through [`Database::transaction`] so they serialize
/// on one connection (there is no read pool in v1). The handle holds the
/// exclusive [`DataRootLease`] for its lifetime; dropping it releases the
/// lease.
pub struct Database {
    conn: rusqlite::Connection,
    root: PathBuf,
    writable: bool,
    lease: Option<DataRootLease>,
}

impl std::fmt::Debug for Database {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Database")
            .field("root", &self.root)
            .field("writable", &self.writable)
            .finish_non_exhaustive()
    }
}

impl Database {
    /// The underlying SQLite connection (single-writer coordinator).
    pub fn conn(&self) -> &rusqlite::Connection {
        &self.conn
    }

    /// The data root directory this database belongs to.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Whether this handle may write to the database (always `true` for
    /// handles produced by [`open`]; kept as state for future read-only
    /// handles).
    pub fn writable(&self) -> bool {
        self.writable
    }

    /// Run `f` inside a transaction and commit; on error, roll back and return
    /// the error.
    ///
    /// `f`'s [`StorageError`] is propagated as-is after a best-effort
    /// rollback; transaction begin/commit failures are classified via
    /// [`StorageError::from_sqlite`]. Because this connection is the write
    /// coordinator, all writes in this data root serialize here.
    pub fn transaction<T, F>(&mut self, f: F) -> Result<T>
    where
        F: FnOnce(&rusqlite::Transaction) -> Result<T>,
    {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| StorageError::from_sqlite(e, "transaction: begin"))?;
        match f(&tx) {
            Ok(value) => {
                tx.commit()
                    .map_err(|e| StorageError::from_sqlite(e, "transaction: commit"))?;
                Ok(value)
            }
            Err(err) => {
                // Rollback failure cannot override the original error; the
                // dropped transaction would roll back anyway.
                let _ = tx.rollback();
                Err(err)
            }
        }
    }

    /// Current `storageFormat` value from the `__neotavern_meta` table.
    ///
    /// A missing row or a non-integer value is `Corrupt` (the database is
    /// inconsistent with what [`open`] accepted).
    pub fn storage_format(&self) -> Result<i64> {
        read_storage_format(&self.conn)?.ok_or_else(|| {
            StorageError::new(
                StorageErrorCode::Corrupt,
                "meta row storageFormat is missing",
            )
        })
    }

    /// Current schema revision (`PRAGMA user_version`).
    pub fn schema_revision(&self) -> Result<i64> {
        self.conn
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .map_err(|e| StorageError::from_sqlite(e, "schema_revision: read user_version"))
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        // Best-effort orderly lease release before the OS auto-releases the
        // lock when the file handle closes.
        if let Some(lease) = self.lease.take() {
            let _ = lease.release();
        }
    }
}

/// Full open sequence (ТЗ §31) for a data root.
///
/// 1. [`assert_baseline`] on the bundled SQLite version.
/// 2. Acquire the exclusive [`DataRootLease`] on `<root>/.neotavern.lock`.
/// 3. [`inspect`] the database read-only (never creates a file).
/// 4. Compatibility decision BEFORE any writable open:
///    - fresh → [`fresh_install`] on a NEW writable connection;
///    - `storageFormat != 1` → [`StorageErrorCode::UnsupportedStorageFormat`];
///    - `schemaRevision > CURRENT_SCHEMA` → [`StorageErrorCode::SchemaTooNew`]
///      (the database is NEVER opened writable on this path);
///    - `schemaRevision < MIN_DIRECT_SCHEMA` → [`StorageErrorCode::SchemaTooOld`]
///      (legacy conversion is outside this crate);
///    - `MIN_DIRECT_SCHEMA..=CURRENT_SCHEMA` → open writable, configure,
///      [`verify_ledger`], then [`migrate`] with `snapshot_verified = false`
///      (v1 has only Low-risk migrations; Medium/High require a verified
///      snapshot and fail with `MigrationFailed` "snapshot_required").
/// 5. `PRAGMA quick_check` must return the single row `"ok"` (else
///    [`StorageErrorCode::Corrupt`]).
///
/// The returned [`Database`] holds the lease and is the write coordinator for
/// `root`. `progress` receives [`MigrationProgress`] notifications for every
/// applied migration (including the fresh-install migration).
pub fn open(
    root: &Path,
    policy: &ConnectionPolicy,
    progress: &mut dyn FnMut(MigrationProgress),
) -> Result<Database> {
    assert_baseline(sqlite_libversion())?;

    let lease = DataRootLease::acquire(root).map_err(|mut e| {
        // Diagnostics: which lock file was contended.
        e.params.push((
            "lock_path".to_string(),
            lock_path(root).display().to_string(),
        ));
        e
    })?;

    let inspection = inspect(root)?;

    // Compatibility decision — before any writable open, so the SchemaTooNew
    // and UnsupportedStorageFormat paths can never touch a writable connection.
    if !inspection.fresh {
        if let Some(format) = inspection.storage_format {
            if format != STORAGE_FORMAT {
                return Err(StorageError::with(
                    StorageErrorCode::UnsupportedStorageFormat,
                    "database storage format is not supported by this build",
                    vec![
                        ("storage_format".into(), format.to_string()),
                        ("supported".into(), STORAGE_FORMAT.to_string()),
                    ],
                ));
            }
        }
        let revision = inspection.schema_revision.unwrap_or(0);
        if revision > CURRENT_SCHEMA {
            return Err(StorageError::with(
                StorageErrorCode::SchemaTooNew,
                "database schema revision is newer than this build supports",
                vec![
                    ("schema_revision".into(), revision.to_string()),
                    ("current_schema".into(), CURRENT_SCHEMA.to_string()),
                ],
            ));
        }
        if revision < MIN_DIRECT_SCHEMA {
            return Err(StorageError::with(
                StorageErrorCode::SchemaTooOld,
                "database schema revision predates direct opening; legacy conversion is outside this crate",
                vec![
                    ("schema_revision".into(), revision.to_string()),
                    ("min_direct_schema".into(), MIN_DIRECT_SCHEMA.to_string()),
                ],
            ));
        }
    }

    // Only now open writable. The lease already created the root directory.
    let path = db_path(root);
    let conn = rusqlite::Connection::open(&path)
        .map_err(|e| StorageError::from_sqlite(e, "open: connect database"))?;
    configure_connection(&conn, policy)?;

    if inspection.fresh {
        fresh_install(&conn, progress)?;
    } else {
        verify_ledger(&conn)?;
        let revision = inspection.schema_revision.unwrap_or(0);
        migrate(&conn, revision, CURRENT_SCHEMA, false, progress)?;
    }

    quick_check_ok(&conn, "open")?;

    Ok(Database {
        conn,
        root: root.to_path_buf(),
        writable: true,
        lease: Some(lease),
    })
}

/// Read-only handle for Recovery Mode (ТЗ §86).
///
/// NO lease, NO writes, NO migrations, and no connection-configure writes —
/// only [`verify_connection`], which reads. `PRAGMA quick_check` must return
/// the single row `"ok"` on open (else `Corrupt`).
pub struct ReadOnlyDatabase {
    conn: rusqlite::Connection,
    root: PathBuf,
}

impl ReadOnlyDatabase {
    /// The underlying read-only SQLite connection.
    pub fn conn(&self) -> &rusqlite::Connection {
        &self.conn
    }

    /// The data root directory this handle belongs to.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// Read-only open for Recovery Mode (ТЗ §86).
///
/// No lease is taken and no writes are performed: the connection opens
/// `mode=ro`, [`verify_connection`] runs read-only checks, and
/// `PRAGMA quick_check` must return the single row `"ok"` (else
/// [`StorageErrorCode::Corrupt`]). The database file must already exist —
/// a missing file is reported as an error (a fresh root has nothing to
/// diagnose).
pub fn open_read_only(root: &Path) -> Result<ReadOnlyDatabase> {
    assert_baseline(sqlite_libversion())?;

    let path = db_path(root);
    let conn = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| classify_open_error(e, "open_read_only: open read-only"))?;

    // Read-only verification: foreign_keys == 1 (no pragma writes).
    verify_connection(&conn)?;
    quick_check_ok(&conn, "open_read_only")?;

    Ok(ReadOnlyDatabase {
        conn,
        root: root.to_path_buf(),
    })
}

/// An `Inspection` for an absent/empty database file: fresh, all `None`,
/// checksums trivially ok. Nothing is created or written.
fn fresh_inspection() -> Inspection {
    Inspection {
        application_id: None,
        storage_format: None,
        schema_revision: None,
        fresh: true,
        checksums_ok: true,
    }
}

/// Whether a table with the given name exists in the database.
fn table_exists(conn: &rusqlite::Connection, name: &str) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [name],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|e| StorageError::from_sqlite(e, "inspect: query sqlite_master"))
}

/// Read the `storageFormat` value from the `__neotavern_meta` table.
///
/// `Ok(None)` when the row is absent; a present but non-integer value is
/// `Corrupt` (tampered/inconsistent database).
fn read_storage_format(conn: &rusqlite::Connection) -> Result<Option<i64>> {
    match conn.query_row(
        "SELECT value FROM __neotavern_meta WHERE key = ?1",
        [META_KEY_STORAGE_FORMAT],
        |row| row.get::<_, String>(0),
    ) {
        Ok(value) => value.trim().parse::<i64>().map(Some).map_err(|_| {
            StorageError::with(
                StorageErrorCode::Corrupt,
                "meta row storageFormat is not an integer",
                vec![("storageFormat".into(), value)],
            )
        }),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(StorageError::from_sqlite(
            e,
            "inspect: read meta storageFormat",
        )),
    }
}

/// Run `PRAGMA quick_check`; require exactly one row equal to `"ok"`, else
/// `Corrupt` with the quick_check output as a param.
fn quick_check_ok(conn: &rusqlite::Connection, context: &str) -> Result<()> {
    let mut stmt = conn
        .prepare("PRAGMA quick_check")
        .map_err(|e| StorageError::from_sqlite(e, context))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| StorageError::from_sqlite(e, context))?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| StorageError::from_sqlite(e, context))?);
    }
    if results.len() == 1 && results[0].trim() == "ok" {
        Ok(())
    } else {
        Err(StorageError::with(
            StorageErrorCode::Corrupt,
            format!("{context}: quick_check failed"),
            vec![("quick_check".into(), results.join("; "))],
        ))
    }
}

/// Classify a connection-open failure: a file that is not a SQLite database
/// (`SQLITE_NOTADB`) is `Corrupt`; everything else follows
/// [`StorageError::from_sqlite`] (Busy/DiskFull/Io).
fn classify_open_error(e: rusqlite::Error, context: &str) -> StorageError {
    if let rusqlite::Error::SqliteFailure(f, Some(message)) = &e {
        if f.code == rusqlite::ErrorCode::NotADatabase {
            return StorageError::with(
                StorageErrorCode::Corrupt,
                format!("{context}: file is not a SQLite database"),
                vec![("sqlite_error".into(), message.clone())],
            );
        }
    }
    StorageError::from_sqlite(e, context)
}
