/**
 * Schema ↔ migration parity: the Drizzle models in `src/schema/tables.ts` must
 * mirror the SQL applied by `src/migrations/`. A fresh ':memory:' database
 * (migrated from scratch) is compared against the Drizzle definitions so any
 * future drift between the two fails CI instead of silently breaking queries.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { is, Table } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { createAppDatabase, type AppDatabase, type SqliteConnection } from '../src/index.js';
import * as schemaTables from '../src/schema/tables.js';

const drizzleTables = Object.values(schemaTables).filter((value): value is Table =>
  is(value, Table),
);

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

/** Column-name tuples of every UNIQUE index on a table, in index order. */
function uniqueIndexColumnTuples(sqlite: SqliteConnection, table: string): string[][] {
  const indexes = sqlite.prepare(`PRAGMA index_list('${table}')`).all() as IndexListRow[];
  return indexes
    .filter((index) => index.unique === 1)
    .map((index) =>
      (sqlite.prepare(`PRAGMA index_info('${index.name}')`).all() as IndexInfoRow[]).map(
        (column) => column.name,
      ),
    );
}

describe('schema ↔ migration parity', () => {
  let app: AppDatabase;

  beforeEach(() => {
    app = createAppDatabase(':memory:');
  });

  afterEach(() => {
    app.close();
  });

  it('discovers every table defined in the Drizzle schema', () => {
    // Guard: if drizzle-orm's entity detection ever breaks, the loop below
    // would pass vacuously. The schema currently defines 25 tables.
    expect(drizzleTables.length).toBeGreaterThanOrEqual(25);
  });

  it('live SQLite tables exist with exactly the schema column names', () => {
    for (const table of drizzleTables) {
      const config = getTableConfig(table);
      const rows = app.sqlite.prepare(`PRAGMA table_info('${config.name}')`).all() as Array<{
        name: string;
      }>;
      expect(rows.length, `migrated table "${config.name}" must exist`).toBeGreaterThan(0);

      const liveColumns = rows.map((row) => row.name).sort();
      const schemaColumns = config.columns.map((column) => column.name).sort();
      expect(liveColumns, `columns of table "${config.name}"`).toEqual(schemaColumns);
    }
  });

  it('declares UNIQUE (character_id, version) on character_versions', () => {
    expect(uniqueIndexColumnTuples(app.sqlite, 'character_versions')).toContainEqual([
      'character_id',
      'version',
    ]);
  });

  it('declares UNIQUE (kind, name) on presets', () => {
    expect(uniqueIndexColumnTuples(app.sqlite, 'presets')).toContainEqual(['kind', 'name']);
  });

  it('declares UNIQUE (owner_type, owner_id, content_hash) on attachments', () => {
    expect(uniqueIndexColumnTuples(app.sqlite, 'attachments')).toContainEqual([
      'owner_type',
      'owner_id',
      'content_hash',
    ]);
  });

  it('enforces the documented uniqueness at runtime', () => {
    const now = Date.now();
    app.sqlite
      .prepare('INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('char-1', 'Alice', now, now);
    const insertVersion = app.sqlite.prepare(
      'INSERT INTO character_versions (id, character_id, version, snapshot, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    insertVersion.run('v-1', 'char-1', 1, '{}', now);
    expect(() => insertVersion.run('v-2', 'char-1', 1, '{}', now)).toThrow(/UNIQUE/i);

    const insertPreset = app.sqlite.prepare(
      'INSERT INTO presets (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    insertPreset.run('p-1', 'instruct', 'default', now, now);
    expect(() => insertPreset.run('p-2', 'instruct', 'default', now, now)).toThrow(/UNIQUE/i);
    insertPreset.run('p-3', 'context', 'default', now, now); // same name, other kind: allowed

    const insertAttachment = app.sqlite.prepare(
      `INSERT INTO attachments
         (id, owner_type, owner_id, logical_name, relative_path, content_hash, mime, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const hash = 'f'.repeat(64);
    insertAttachment.run(
      'a-1',
      'character',
      'char-1',
      'a.png',
      'files/a.png',
      hash,
      'image/png',
      1,
      now,
    );
    expect(() =>
      insertAttachment.run(
        'a-2',
        'character',
        'char-1',
        'b.png',
        'files/b.png',
        hash,
        'image/png',
        1,
        now,
      ),
    ).toThrow(/UNIQUE/i);
    insertAttachment.run(
      'a-3',
      'character',
      'char-2',
      'a.png',
      'files/a.png',
      hash,
      'image/png',
      1,
      now,
    ); // same hash, other owner: allowed
  });
});
