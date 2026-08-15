//! Schema migration engine (ТЗ §22-§23, Фаза 2).
//!
//! Owns the ordered migration list (`MIGRATIONS`), the migration ledger
//! (`__neotavern_migrations`) and its integrity verification, plus the two
//! entry points used by `open.rs`: `fresh_install` (new database) and
//! `migrate` (revision bump). All migrations, ledger rows and the
//! `user_version` pragma are committed in the same transaction for
//! transactional migrations, and checksums are recomputed at runtime so a
//! tampered migration text can never be applied silently.
//!
//! The data root lease is held by the caller (`open.rs`); these functions
//! assume a single writer connection.

use crate::error::{Result, StorageError, StorageErrorCode};
use crate::schema::{
    schema_fingerprint, FRESH_SCHEMA_SQL, MIGRATION_10_CHECKSUM, MIGRATION_10_NAME,
    MIGRATION_10_SQL, MIGRATION_11_CHECKSUM, MIGRATION_11_NAME, MIGRATION_11_SQL,
    MIGRATION_12_CHECKSUM, MIGRATION_12_NAME, MIGRATION_12_SQL, MIGRATION_13_CHECKSUM,
    MIGRATION_13_NAME, MIGRATION_13_SQL, MIGRATION_14_CHECKSUM, MIGRATION_14_NAME,
    MIGRATION_14_SQL, MIGRATION_15_CHECKSUM, MIGRATION_15_NAME, MIGRATION_15_SQL,
    MIGRATION_16_CHECKSUM, MIGRATION_16_NAME, MIGRATION_16_SQL, MIGRATION_17_CHECKSUM,
    MIGRATION_17_NAME, MIGRATION_17_SQL, MIGRATION_1_CHECKSUM, MIGRATION_1_NAME, MIGRATION_1_SQL,
    MIGRATION_2_CHECKSUM, MIGRATION_2_NAME, MIGRATION_2_SQL, MIGRATION_3_CHECKSUM,
    MIGRATION_3_NAME, MIGRATION_3_SQL, MIGRATION_4_CHECKSUM, MIGRATION_4_NAME, MIGRATION_4_SQL,
    MIGRATION_5_CHECKSUM, MIGRATION_5_NAME, MIGRATION_5_SQL, MIGRATION_6_CHECKSUM,
    MIGRATION_6_NAME, MIGRATION_6_SQL, MIGRATION_7_CHECKSUM, MIGRATION_7_NAME, MIGRATION_7_SQL,
    MIGRATION_8_CHECKSUM, MIGRATION_8_NAME, MIGRATION_8_SQL, MIGRATION_9_CHECKSUM,
    MIGRATION_9_NAME, MIGRATION_9_SQL,
};
use crate::{
    now_utc_rfc3339, APPLICATION_ID, CURRENT_SCHEMA, META_KEY_STORAGE_FORMAT, STORAGE_FORMAT,
};
use sha2::{Digest, Sha256};

/// Risk class of a migration (ТЗ §23): determines whether a verified snapshot
/// is required before the migration may run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationRisk {
    /// Cheap, safe, resumable DDL/DML. Runs automatically on open.
    Low,
    /// Destructive or long-running; requires an operator decision.
    Medium,
    /// Irreversible; always requires a verified snapshot and explicit approval.
    High,
}

/// A single schema migration entry.
pub struct Migration {
    /// Migration sequence number; must equal the target `user_version`.
    pub id: i64,
    /// Stable human-readable migration name (also recorded in the ledger).
    pub name: &'static str,
    /// Risk class; anything above `Low` needs `snapshot_verified: true`.
    pub risk: MigrationRisk,
    /// `true` → SQL + ledger row + `user_version` are one transaction.
    pub transactional: bool,
    /// Migration SQL, applied via `execute_batch`.
    pub sql: &'static str,
    /// Lowercase sha256 hex of `sql` bytes; verified at runtime before apply.
    pub checksum: &'static str,
}

/// Ordered migration list. v1 (`001_initial_schema`) builds the three STRICT
/// foundation tables; v2 (`002_product_core`) adds the STRICT product tables;
/// v3 (`003_generation_durability`) adds the recoverable generation workflow
/// tables (`generation_runs`, `generation_events`); v4 (`004_provider_configs`)
/// adds the user-configured provider table (`provider_configs`). A fresh
/// install runs `FRESH_SCHEMA_SQL` — the concatenation of all four — and
/// records every migration in the ledger.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        id: 1,
        name: MIGRATION_1_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_1_SQL,
        checksum: MIGRATION_1_CHECKSUM,
    },
    Migration {
        id: 2,
        name: MIGRATION_2_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_2_SQL,
        checksum: MIGRATION_2_CHECKSUM,
    },
    Migration {
        id: 3,
        name: MIGRATION_3_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_3_SQL,
        checksum: MIGRATION_3_CHECKSUM,
    },
    Migration {
        id: 4,
        name: MIGRATION_4_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_4_SQL,
        checksum: MIGRATION_4_CHECKSUM,
    },
    Migration {
        id: 5,
        name: MIGRATION_5_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_5_SQL,
        checksum: MIGRATION_5_CHECKSUM,
    },
    Migration {
        id: 6,
        name: MIGRATION_6_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_6_SQL,
        checksum: MIGRATION_6_CHECKSUM,
    },
    Migration {
        id: 7,
        name: MIGRATION_7_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_7_SQL,
        checksum: MIGRATION_7_CHECKSUM,
    },
    Migration {
        id: 8,
        name: MIGRATION_8_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_8_SQL,
        checksum: MIGRATION_8_CHECKSUM,
    },
    Migration {
        id: 9,
        name: MIGRATION_9_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_9_SQL,
        checksum: MIGRATION_9_CHECKSUM,
    },
    Migration {
        id: 10,
        name: MIGRATION_10_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_10_SQL,
        checksum: MIGRATION_10_CHECKSUM,
    },
    Migration {
        id: 11,
        name: MIGRATION_11_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_11_SQL,
        checksum: MIGRATION_11_CHECKSUM,
    },
    Migration {
        id: 12,
        name: MIGRATION_12_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_12_SQL,
        checksum: MIGRATION_12_CHECKSUM,
    },
    Migration {
        id: 13,
        name: MIGRATION_13_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_13_SQL,
        checksum: MIGRATION_13_CHECKSUM,
    },
    Migration {
        id: 14,
        name: MIGRATION_14_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_14_SQL,
        checksum: MIGRATION_14_CHECKSUM,
    },
    Migration {
        id: 15,
        name: MIGRATION_15_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_15_SQL,
        checksum: MIGRATION_15_CHECKSUM,
    },
    Migration {
        id: 16,
        name: MIGRATION_16_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_16_SQL,
        checksum: MIGRATION_16_CHECKSUM,
    },
    Migration {
        id: 17,
        name: MIGRATION_17_NAME,
        risk: MigrationRisk::Low,
        transactional: true,
        sql: MIGRATION_17_SQL,
        checksum: MIGRATION_17_CHECKSUM,
    },
];

/// Progress notification emitted before a migration is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationProgress {
    /// Sequence number of the migration about to be applied.
    pub id: i64,
    /// Name of the migration about to be applied.
    pub name: &'static str,
}

/// Fresh install (ТЗ §31): build the schema and record it, all in ONE
/// transaction.
///
/// Emits one `MigrationProgress` per declared migration (in `MIGRATIONS`
/// order), executes `FRESH_SCHEMA_SQL`, sets the `application_id` pragma to
/// `APPLICATION_ID`, sets `user_version` to `CURRENT_SCHEMA`, inserts the
/// `storageFormat` meta row and a migration ledger row for EVERY entry in
/// `MIGRATIONS` (id, name, checksum, RFC 3339 timestamp), then commits. On
/// success returns the fresh-install fingerprint (`schema_fingerprint()`). The
/// caller must hold the data-root lease.
pub fn fresh_install(
    conn: &rusqlite::Connection,
    progress: &mut dyn FnMut(MigrationProgress),
) -> Result<String> {
    for migration in MIGRATIONS {
        progress(MigrationProgress {
            id: migration.id,
            name: migration.name,
        });
    }

    // `unchecked_transaction` is safe here: the architecture guarantees a
    // single writable connection (the Database coordinator in open.rs), so no
    // other code can interleave statements on `conn`.
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| StorageError::from_sqlite(e, "fresh_install begin transaction"))?;
    tx.execute_batch(FRESH_SCHEMA_SQL)
        .map_err(|e| StorageError::from_sqlite(e, "fresh_install create schema"))?;
    tx.pragma_update(None, "application_id", APPLICATION_ID)
        .map_err(|e| StorageError::from_sqlite(e, "fresh_install set application_id"))?;
    tx.pragma_update(None, "user_version", CURRENT_SCHEMA)
        .map_err(|e| StorageError::from_sqlite(e, "fresh_install set user_version"))?;
    tx.execute(
        "INSERT INTO __neotavern_meta (key, value) VALUES (?1, ?2)",
        rusqlite::params![META_KEY_STORAGE_FORMAT, STORAGE_FORMAT.to_string()],
    )
    .map_err(|e| StorageError::from_sqlite(e, "fresh_install meta row"))?;
    for migration in MIGRATIONS {
        tx.execute(
            "INSERT INTO __neotavern_migrations (id, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![migration.id, migration.name, migration.checksum, now_utc_rfc3339()],
        )
        .map_err(|e| StorageError::from_sqlite(e, "fresh_install ledger row"))?;
    }
    tx.commit()
        .map_err(|e| StorageError::from_sqlite(e, "fresh_install commit"))?;
    Ok(schema_fingerprint())
}

/// Verify the migration ledger against `MIGRATIONS`.
///
/// Every row of `__neotavern_migrations` must carry the checksum declared in
/// `MIGRATIONS` for its id. An id that is not declared in `MIGRATIONS`, or a
/// checksum that differs from the declared one, yields
/// `MigrationChecksumMismatch` with the `("id", id)` param.
pub fn verify_ledger(conn: &rusqlite::Connection) -> Result<()> {
    let mut stmt = conn
        .prepare("SELECT id, name, checksum FROM __neotavern_migrations ORDER BY id")
        .map_err(|e| StorageError::from_sqlite(e, "verify_ledger prepare"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "verify_ledger query"))?;
    for row in rows {
        let (id, _name, ledger_checksum) =
            row.map_err(|e| StorageError::from_sqlite(e, "verify_ledger row"))?;
        let declared = MIGRATIONS
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.checksum)
            .ok_or_else(|| ledger_unknown_id(id))?;
        if ledger_checksum != declared {
            return Err(ledger_mismatch(id, &ledger_checksum, declared));
        }
    }
    Ok(())
}

/// Run migrations from `from` (exclusive) to `to` (inclusive), sequentially.
///
/// For each migration, in order:
/// 1. Emits `MigrationProgress { id, name }` BEFORE applying.
/// 2. Precondition: current `user_version` must equal `id - 1`, else `Corrupt`
///    (with `expected`/`found` params).
/// 3. Recomputes sha256 of the migration SQL and asserts it equals the
///    declared checksum (runtime self-check), else `Corrupt` with `("id", id)`.
/// 4. If `risk != Low` and `snapshot_verified` is false → `MigrationFailed`
///    `"snapshot_required"` (all declared migrations are `Low`).
/// 5. Applies: for transactional migrations the SQL, the ledger row and
///    `user_version = id` are committed in ONE transaction; any error rolls
///    back and yields `MigrationFailed` with `("id", id)`. Non-transactional
///    migrations run the SQL first, then ledger + `user_version` in one
///    transaction (documented resume gap; none declared).
///
/// After the loop asserts `user_version == to`, else `Corrupt`.
pub fn migrate(
    conn: &rusqlite::Connection,
    from: i64,
    to: i64,
    snapshot_verified: bool,
    progress: &mut dyn FnMut(MigrationProgress),
) -> Result<()> {
    for id in (from + 1)..=to {
        let migration = MIGRATIONS
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| unknown_migration(id))?;

        progress(MigrationProgress {
            id,
            name: migration.name,
        });

        let current = read_user_version(conn)?;
        if current != id - 1 {
            return Err(corrupt_revision(id - 1, current));
        }

        let computed = sha256_hex(migration.sql.as_bytes());
        if computed != migration.checksum {
            return Err(corrupt_checksum(id, migration.checksum, &computed));
        }

        if migration.risk != MigrationRisk::Low && !snapshot_verified {
            return Err(snapshot_required(id));
        }

        if migration.transactional {
            apply_transactional(conn, migration)?;
        } else {
            apply_non_transactional(conn, migration)?;
        }
    }

    let final_version = read_user_version(conn)?;
    if final_version != to {
        return Err(corrupt_revision(to, final_version));
    }
    Ok(())
}

/// Apply a transactional migration: SQL + ledger row + `user_version` commit
/// together; any failure rolls back.
fn apply_transactional(conn: &rusqlite::Connection, migration: &Migration) -> Result<()> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| migration_failed(migration.id, e))?;
    let apply = || -> rusqlite::Result<()> {
        tx.execute_batch(migration.sql)?;
        insert_ledger_row(&tx, migration)
    };
    if let Err(err) = apply() {
        drop(tx); // rollback
        return Err(migration_failed(migration.id, err));
    }
    tx.commit().map_err(|e| migration_failed(migration.id, e))
}

/// Apply a non-transactional migration: SQL first (outside a transaction),
/// then ledger row + `user_version` in one transaction. A crash between the
/// two steps leaves the SQL applied but unrecorded — the documented resume
/// gap. No declared migration is non-transactional.
fn apply_non_transactional(conn: &rusqlite::Connection, migration: &Migration) -> Result<()> {
    if let Err(err) = conn.execute_batch(migration.sql) {
        return Err(migration_failed(migration.id, err));
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| migration_failed(migration.id, e))?;
    let apply = || -> rusqlite::Result<()> { insert_ledger_row(&tx, migration) };
    if let Err(err) = apply() {
        drop(tx); // rollback
        return Err(migration_failed(migration.id, err));
    }
    tx.commit().map_err(|e| migration_failed(migration.id, e))
}

/// Record the ledger row and bump `user_version` for `migration`.
fn insert_ledger_row(tx: &rusqlite::Transaction, migration: &Migration) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO __neotavern_migrations (id, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![migration.id, migration.name, migration.checksum, now_utc_rfc3339()],
    )?;
    tx.pragma_update(None, "user_version", migration.id)?;
    Ok(())
}

/// Read the `user_version` pragma.
fn read_user_version(conn: &rusqlite::Connection) -> Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "read user_version pragma"))
}

/// Lowercase sha256 hex of `bytes`.
fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing to a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `MigrationFailed` for a failed or unknown migration step.
fn migration_failed(id: i64, cause: impl std::fmt::Display) -> StorageError {
    StorageError::with(
        StorageErrorCode::MigrationFailed,
        format!("migration {id} failed: {cause}"),
        vec![("id".to_string(), id.to_string())],
    )
}

/// `MigrationFailed` for an id absent from `MIGRATIONS`.
fn unknown_migration(id: i64) -> StorageError {
    StorageError::with(
        StorageErrorCode::MigrationFailed,
        format!("unknown migration id {id}: not declared in MIGRATIONS"),
        vec![("id".to_string(), id.to_string())],
    )
}

/// `MigrationFailed` for a non-Low migration without a verified snapshot.
fn snapshot_required(id: i64) -> StorageError {
    StorageError::with(
        StorageErrorCode::MigrationFailed,
        format!("snapshot_required: migration {id} is not Low-risk and no verified snapshot was supplied"),
        vec![("id".to_string(), id.to_string())],
    )
}

/// `Corrupt` for a `user_version` mismatch.
fn corrupt_revision(expected: i64, found: i64) -> StorageError {
    StorageError::with(
        StorageErrorCode::Corrupt,
        format!("database schema revision mismatch: expected {expected}, found {found}"),
        vec![
            ("expected".to_string(), expected.to_string()),
            ("found".to_string(), found.to_string()),
        ],
    )
}

/// `Corrupt` for a runtime checksum mismatch on a migration's SQL text.
fn corrupt_checksum(id: i64, declared: &str, computed: &str) -> StorageError {
    StorageError::with(
        StorageErrorCode::Corrupt,
        format!(
            "migration {id} runtime checksum mismatch: declared {declared} != computed {computed}"
        ),
        vec![("id".to_string(), id.to_string())],
    )
}

/// `MigrationChecksumMismatch` for a ledger id not declared in `MIGRATIONS`.
fn ledger_unknown_id(id: i64) -> StorageError {
    StorageError::with(
        StorageErrorCode::MigrationChecksumMismatch,
        format!("migration ledger contains id {id} which is not declared in MIGRATIONS"),
        vec![("id".to_string(), id.to_string())],
    )
}

/// `MigrationChecksumMismatch` for a ledger row whose checksum differs from
/// the declared one.
fn ledger_mismatch(id: i64, ledger: &str, declared: &str) -> StorageError {
    StorageError::with(
        StorageErrorCode::MigrationChecksumMismatch,
        format!("migration ledger checksum mismatch for id {id}: ledger {ledger} != declared {declared}"),
        vec![("id".to_string(), id.to_string())],
    )
}
