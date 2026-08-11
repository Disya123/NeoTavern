/**
 * Persistent module-map cache (ТЗ v3.2 §8.1): key stability across identical
 * source, invalidation when any compiled-form component changes, atomic
 * writes, corruption tolerance and full removability (§20).
 */
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginModuleGraph } from '@neotavern/contracts';
import {
  ModuleMapDiskCache,
  moduleMapCacheKey,
  packageSourceDigest,
  type ModuleMapCacheVersions,
  type StoredModuleMap,
} from './moduleMapCache.js';

const VERSIONS: ModuleMapCacheVersions = {
  node: '24.0.0',
  ses: '2.2.0',
  endoModuleSource: '1.4.1',
  neotavernLoader: '0.1.0',
};

function graphOf(pluginId: string): PluginModuleGraph {
  return {
    pluginId,
    entry: 'src/index.js',
    records: [
      {
        id: 'src/index.js',
        location: `neotavern-plugin://${pluginId}/src/index.js`,
        kind: 'js',
        digest: 'abc',
        imports: [],
        exports: ['marker'],
        resolvedImports: {},
        source: 'export const marker = 1;',
      },
    ],
  };
}

function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'neotavern-module-map-'));
}

describe('packageSourceDigest', () => {
  it('is stable for equal file sets regardless of insertion order', () => {
    const a = new Map([
      ['src/index.js', 'x'],
      ['src/a.js', 'y'],
    ]);
    const b = new Map([
      ['src/a.js', 'y'],
      ['src/index.js', 'x'],
    ]);
    expect(packageSourceDigest(a)).toBe(packageSourceDigest(b));
  });

  it('changes when any file content or path changes', () => {
    const base = new Map([['src/index.js', 'x']]);
    const changed = new Map([['src/index.js', 'y']]);
    const renamed = new Map([['src/other.js', 'x']]);
    expect(packageSourceDigest(changed)).not.toBe(packageSourceDigest(base));
    expect(packageSourceDigest(renamed)).not.toBe(packageSourceDigest(base));
  });
});

describe('moduleMapCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(moduleMapCacheKey('digest', VERSIONS)).toBe(moduleMapCacheKey('digest', VERSIONS));
  });

  it('changes when ANY compiled-form component changes (§8.1)', () => {
    const base = moduleMapCacheKey('digest', VERSIONS);
    for (const key of ['node', 'ses', 'endoModuleSource', 'neotavernLoader'] as const) {
      const changed = moduleMapCacheKey('digest', { ...VERSIONS, [key]: 'other' });
      expect(changed).not.toBe(base);
    }
    expect(moduleMapCacheKey('other-digest', VERSIONS)).not.toBe(base);
  });
});

describe('ModuleMapDiskCache', () => {
  it('round-trips a stored graph and warnings', async () => {
    const dir = tempCacheDir();
    try {
      const cache = new ModuleMapDiskCache(dir, VERSIONS);
      const entry: StoredModuleMap = { graph: graphOf('test.roundtrip'), warnings: ['dynamic'] };
      const digest = packageSourceDigest(new Map([['src/index.js', 'x']]));
      await cache.put(digest, entry);
      const loaded = await cache.get(digest);
      expect(loaded).toEqual(entry);
      expect(await cache.size()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a miss for unknown source digests', async () => {
    const dir = tempCacheDir();
    try {
      const cache = new ModuleMapDiskCache(dir, VERSIONS);
      expect(await cache.get('unknown-digest')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats corrupt entries as a miss (self-rebuilding, §20)', async () => {
    const dir = tempCacheDir();
    try {
      const cache = new ModuleMapDiskCache(dir, VERSIONS);
      const digest = 'corrupt-digest';
      // Valid key, garbage content.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, `${moduleMapCacheKey(digest, VERSIONS)}.json`), '{not json');
      expect(await cache.get(digest)).toBeUndefined();
      // A malformed-but-parseable entry is also a miss.
      const { writeFileSync: write2 } = await import('node:fs');
      write2(join(dir, `${moduleMapCacheKey('wrong-shape', VERSIONS)}.json`), '{"graph":42}');
      expect(await cache.get('wrong-shape')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes atomically and leaves no temp files behind', async () => {
    const dir = tempCacheDir();
    try {
      const cache = new ModuleMapDiskCache(dir, VERSIONS);
      await cache.put('atomic-digest', { graph: graphOf('test.atomic'), warnings: [] });
      const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
      expect(existsSync(join(dir, `${moduleMapCacheKey('atomic-digest', VERSIONS)}.json`))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is fully removable via clear() (§20)', async () => {
    const dir = tempCacheDir();
    try {
      const cache = new ModuleMapDiskCache(dir, VERSIONS);
      await cache.put('a', { graph: graphOf('test.a'), warnings: [] });
      await cache.put('b', { graph: graphOf('test.b'), warnings: [] });
      expect(await cache.size()).toBe(2);
      await cache.clear();
      expect(await cache.size()).toBe(0);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalidates when versions change (same source, different components)', async () => {
    const dir = tempCacheDir();
    try {
      const digest = 'versioned-digest';
      const cacheA = new ModuleMapDiskCache(dir, VERSIONS);
      await cacheA.put(digest, { graph: graphOf('test.a'), warnings: [] });
      const cacheB = new ModuleMapDiskCache(dir, { ...VERSIONS, ses: '2.3.0' });
      expect(await cacheB.get(digest)).toBeUndefined();
      expect(await cacheA.get(digest)).toBeDefined();
      expect(await cacheA.size()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
