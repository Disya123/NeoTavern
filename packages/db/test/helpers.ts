/**
 * Shared temp-dir/connection lifecycle for database tests (DUP-26): every
 * connection opened through `createConnection` is closed and every directory
 * created through `makeDir` is removed recursively after each test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { openDatabase, type SqliteConnection } from '../src/connection.js';

/** Connections opened by tests; closed automatically after each test. */
export const connections: SqliteConnection[] = [];

/** Temp directories created by tests; removed automatically after each test. */
export const directories: string[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Open a tracked connection (closed by the shared afterEach). */
export function createConnection(options: Parameters<typeof openDatabase>[0]): SqliteConnection {
  const sqlite = openDatabase(options);
  connections.push(sqlite);
  return sqlite;
}

/** Create a tracked temp directory (removed by the shared afterEach). */
export function makeDir(prefix = 'neotavern-db-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}
