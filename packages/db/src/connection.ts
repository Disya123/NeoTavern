/**
 * SQLite connection setup with the mandatory pragmas (ТЗ §10.1):
 * foreign_keys ON, WAL journal, busy_timeout, prepared-statement-friendly.
 */
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';

export type SqliteConnection = Database.Database;
type DatabaseConstructor = typeof Database;

const runtimeRequire = createRequire(import.meta.url);

function loadDatabaseConstructor(): DatabaseConstructor {
  const externalPath = process.env['NEOTA_SQLITE_MODULE'];
  // pkg can misread backslash-separated Windows drive paths as the package
  // name `E:`. A slash-normalized absolute file path still loads from the
  // filesystem, including installation folders with spaces.
  const specifier = externalPath?.replaceAll('\\', '/') ?? 'better-sqlite3';
  const loaded: unknown = runtimeRequire(specifier);
  if (typeof loaded !== 'function') {
    throw new TypeError('better-sqlite3 runtime did not export a constructor');
  }
  return loaded as DatabaseConstructor;
}

export interface OpenDatabaseOptions {
  /** File path, or ":memory:" for an in-memory database (tests). */
  path: string;
  /** busy timeout in ms (default 5000). */
  busyTimeoutMs?: number;
  /** synchronous mode (default NORMAL — safe with WAL). */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  /** Open an existing database without mutating its journal configuration. */
  readonly?: boolean;
}

/** Open a SQLite database and apply required pragmas. */
export function openDatabase(options: OpenDatabaseOptions): SqliteConnection {
  const Database = loadDatabaseConstructor();
  const sqlite = new Database(
    options.path,
    options.readonly ? { readonly: true, fileMustExist: true } : undefined,
  );
  if (!options.readonly) {
    // WAL must be set outside a transaction; it persists per-database file.
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  if (!options.readonly) {
    sqlite.pragma(`synchronous = ${options.synchronous ?? 'NORMAL'}`);
  }
  // Reasonable cache size (-64000 = ~64MB page cache).
  sqlite.pragma('cache_size = -64000');
  return sqlite;
}
