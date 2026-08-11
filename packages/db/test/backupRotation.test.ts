import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rotatePrefixedBackups } from '../src/backupRotation.js';
import { makeDir } from './helpers.js';

function touch(dir: string, name: string, mtimeMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, name);
  const mtime = new Date(mtimeMs);
  utimesSync(path, mtime, mtime);
  return path;
}

describe('rotatePrefixedBackups', () => {
  it('keeps only the newest `keep` prefixed .db files', () => {
    const dir = makeDir('neotavern-backup-rotation-');
    const oldest = touch(dir, 'auto-pre-migration-v0.db', 1000);
    const middle = touch(dir, 'auto-pre-migration-v1.db', 2000);
    const older = touch(dir, 'auto-pre-migration-v2.db', 3000);
    touch(dir, 'auto-pre-migration-v3.db', 4000);
    touch(dir, 'auto-pre-migration-v4.db', 5000);

    const removed = rotatePrefixedBackups(dir, 'auto-pre-migration-', 2);

    expect(removed.sort()).toEqual([middle, oldest, older].sort());
    for (const path of removed) expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([
      'auto-pre-migration-v3.db',
      'auto-pre-migration-v4.db',
    ]);
  });

  it('leaves non-matching names and extensions untouched', () => {
    const dir = makeDir('neotavern-backup-rotation-');
    touch(dir, 'auto-pre-migration-v0.db', 1000);
    touch(dir, 'manual-copy.db', 500);
    touch(dir, 'auto-pre-migration-notes.txt', 100);
    touch(dir, 'auto-pre-migration-v0.db.tmp', 9000);

    const removed = rotatePrefixedBackups(dir, 'auto-pre-migration-', 1);

    expect(removed).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([
      'auto-pre-migration-notes.txt',
      'auto-pre-migration-v0.db',
      'auto-pre-migration-v0.db.tmp',
      'manual-copy.db',
    ]);
  });

  it('removes nothing when at or under the retention limit', () => {
    const dir = makeDir('neotavern-backup-rotation-');
    touch(dir, 'auto-pre-migration-v0.db', 1000);
    touch(dir, 'auto-pre-migration-v1.db', 2000);
    expect(rotatePrefixedBackups(dir, 'auto-pre-migration-', 2)).toEqual([]);
    expect(rotatePrefixedBackups(dir, 'auto-pre-migration-', 5)).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('is a no-op for a missing directory', () => {
    const missing = join(makeDir('neotavern-backup-rotation-'), 'does-not-exist');
    expect(rotatePrefixedBackups(missing, 'auto-pre-migration-', 3)).toEqual([]);
  });

  it('returns nothing for an empty directory', () => {
    expect(
      rotatePrefixedBackups(makeDir('neotavern-backup-rotation-'), 'auto-pre-migration-', 3),
    ).toEqual([]);
  });

  it('rejects non-positive or fractional retention', () => {
    const dir = makeDir('neotavern-backup-rotation-');
    expect(() => rotatePrefixedBackups(dir, 'p-', 0)).toThrow(/positive integer/);
    expect(() => rotatePrefixedBackups(dir, 'p-', -2)).toThrow(/positive integer/);
    expect(() => rotatePrefixedBackups(dir, 'p-', 1.5)).toThrow(/positive integer/);
  });
});
