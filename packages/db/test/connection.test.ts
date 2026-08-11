import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/connection.js';
import { connections, createConnection, makeDir } from './helpers.js';

function tempDbPath(): string {
  return join(makeDir('neotavern-connection-'), 'app.db');
}

describe('openDatabase', () => {
  it('applies the mandatory pragmas', () => {
    const sqlite = createConnection({ path: ':memory:' });
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(sqlite.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(sqlite.pragma('cache_size', { simple: true })).toBe(-64000);
  });

  it('honors custom busy timeout and synchronous mode', () => {
    const sqlite = createConnection({ path: ':memory:', busyTimeoutMs: 250, synchronous: 'FULL' });
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(250);
    expect(sqlite.pragma('synchronous', { simple: true })).toBe(2); // FULL
  });

  it('enforces foreign keys at runtime', () => {
    const sqlite = createConnection({ path: ':memory:' });
    sqlite.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parent(id)
      );
    `);
    expect(() =>
      sqlite.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c1', 'missing'),
    ).toThrow(/FOREIGN KEY/);
  });

  it('uses WAL journal mode for file databases', () => {
    const path = tempDbPath();
    const sqlite = createConnection({ path });
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(existsSync(path)).toBe(true);
  });

  it('persists data across reopens of a file database', () => {
    const path = tempDbPath();
    const first = createConnection({ path });
    first.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)');
    first.prepare('INSERT INTO notes (text) VALUES (?)').run('persisted');
    first.close();
    connections.length = 0;

    const second = createConnection({ path });
    expect(second.prepare('SELECT text FROM notes').all()).toEqual([{ text: 'persisted' }]);
  });

  it('opens an existing database read-only and refuses writes', () => {
    const path = tempDbPath();
    const writable = createConnection({ path });
    writable.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
    writable.close();
    connections.length = 0;

    const readonly = createConnection({ path, readonly: true });
    expect(readonly.prepare('SELECT COUNT(*) AS count FROM items').get()).toEqual({ count: 0 });
    expect(() => readonly.prepare('INSERT INTO items DEFAULT VALUES').run()).toThrow(/readonly/i);
  });

  it('refuses to open a missing file read-only', () => {
    expect(() =>
      openDatabase({ path: join(makeDir('neotavern-connection-'), 'missing.db'), readonly: true }),
    ).toThrow();
  });
});
