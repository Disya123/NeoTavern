/**
 * Transactional migration runner.
 *
 * Each migration runs inside its own transaction; on error it rolls back and
 * the database stays at the previous version (ТЗ §10.4). Applied versions are
 * tracked in `_migrations`, so migrations run exactly once and are idempotent
 * across restarts. Before applying pending migrations, an automatic snapshot
 * is taken when configured (ТЗ §10.4), with retention of the last few.
 */
import type { SqliteConnection } from './connection.js';
import { migrations } from './migrations/index.js';
import type { Migration } from './migrations/types.js';
import { rotatePrefixedBackups } from './backupRotation.js';
import { AppError, ErrorCodes, createLogger, type Logger } from '@neotavern/shared';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

/**
 * Automatic pre-migration backup settings (ТЗ §10.4: «перед миграцией
 * создаётся backup; хранится несколько последних автоматических backup»).
 */
export interface MigrationAutoBackupOptions {
  /** Directory for automatic backups (created when missing). */
  backupDir: string;
  /** How many automatic pre-migration backups to retain. Defaults to 5. */
  keep?: number;
}

export interface RunMigrationsOptions {
  autoBackup?: MigrationAutoBackupOptions;
}

/** Prefix marking automatic pre-migration snapshots (retention + UI listing). */
export const PRE_MIGRATION_BACKUP_PREFIX = 'auto-pre-migration-';

/**
 * Apply all pending migrations in order. Returns which versions were applied.
 * Throws {@link AppError} with MIGRATION_FAILED if any migration errors.
 * When `autoBackup` is configured and migrations are pending, a consistent
 * snapshot is taken first via `VACUUM INTO` (safe under WAL) and automatic
 * snapshots beyond the retention limit are removed.
 */
export function runMigrations(
  sqlite: SqliteConnection,
  logger: Logger = createLogger({ scope: 'db:migrate' }),
  migrationList: readonly Migration[] = migrations,
  options: RunMigrationsOptions = {},
): MigrationResult {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version      INTEGER PRIMARY KEY,
       name         TEXT NOT NULL,
       applied_at   INTEGER NOT NULL,
       content_hash TEXT
     ) STRICT;`,
  );
  // Pre-content_hash databases: add the column once, then backfill below.
  try {
    sqlite.exec(`ALTER TABLE _migrations ADD COLUMN content_hash TEXT`);
  } catch {
    // Column already exists.
  }

  const rows = sqlite
    .prepare('SELECT version, content_hash FROM _migrations ORDER BY version')
    .all() as Array<{ version: number; content_hash: string | null }>;
  const appliedSet = new Set(rows.map((r) => r.version));

  // Integrity gate: an already-applied migration whose SQL changed underneath
  // us must never be silently accepted (ТЗ §10.4 data safety). Rows without a
  // hash predate the check and are backfilled on first sight.
  const byVersion = new Map(migrationList.map((m) => [m.version, m]));
  const backfill = sqlite.prepare('UPDATE _migrations SET content_hash = ? WHERE version = ?');
  for (const row of rows) {
    const migration = byVersion.get(row.version);
    if (!migration) continue;
    const hash = migrationHash(migration);
    if (row.content_hash === null) {
      backfill.run(hash, row.version);
    } else if (row.content_hash !== hash) {
      throw new AppError({
        code: ErrorCodes.MIGRATION_FAILED,
        params: { version: row.version, name: migration.name, reason: 'CONTENT_HASH_MISMATCH' },
        message: `Applied migration ${migration.name} was modified after being applied`,
      });
    }
  }

  const pending = migrationList
    .filter((m) => !appliedSet.has(m.version))
    .sort((a, b) => a.version - b.version);

  if (pending.length > 0 && options.autoBackup) {
    const fromVersion = rows.length > 0 ? Math.max(...rows.map((r) => r.version)) : -1;
    createPreMigrationBackup(sqlite, options.autoBackup, fromVersion, pending, logger);
  }

  const applied: number[] = [];
  for (const migration of pending) {
    const apply = sqlite.transaction(() => {
      sqlite.exec(migration.up);
      sqlite
        .prepare(
          'INSERT INTO _migrations (version, name, applied_at, content_hash) VALUES (?, ?, ?, ?)',
        )
        .run(migration.version, migration.name, Date.now(), migrationHash(migration));
    });
    try {
      apply();
      applied.push(migration.version);
      logger.info(`applied migration ${migration.name}`, { version: migration.version });
    } catch (cause) {
      throw new AppError({
        code: ErrorCodes.MIGRATION_FAILED,
        params: { version: migration.version, name: migration.name },
        message: `Migration ${migration.name} failed`,
        cause,
      });
    }
  }

  const current = sqlite.prepare('SELECT MAX(version) AS v FROM _migrations').get() as
    { v: number | null } | undefined;
  return { applied, currentVersion: current?.v ?? -1 };
}

/** Fingerprint of a migration's SQL so post-apply edits are detectable. */
function migrationHash(migration: Migration): string {
  return createHash('sha256').update(migration.up).digest('hex');
}

function createPreMigrationBackup(
  sqlite: SqliteConnection,
  options: MigrationAutoBackupOptions,
  fromVersion: number,
  pending: readonly Migration[],
  logger: Logger,
): void {
  const toVersion = pending[pending.length - 1]?.version ?? fromVersion;
  mkdirSync(options.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const file = join(
    options.backupDir,
    `${PRE_MIGRATION_BACKUP_PREFIX}v${fromVersion}-to-v${toVersion}-${stamp}.db`,
  );
  // VACUUM INTO writes a consistent snapshot and is safe under WAL. Single
  // quotes in the (generated) path are escaped per SQLite string literals.
  sqlite.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  logger.info('created pre-migration backup', { file });
  const removed = rotatePrefixedBackups(
    options.backupDir,
    PRE_MIGRATION_BACKUP_PREFIX,
    options.keep ?? 5,
  );
  for (const old of removed) {
    logger.info('rotated old pre-migration backup', { file: old });
  }
}
