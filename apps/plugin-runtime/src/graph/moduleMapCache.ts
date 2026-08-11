/**
 * Persistent module-map cache (ТЗ v3.2 §6.2/§8.1, plan Stage B).
 *
 * The host builds a signed module graph from canonical package source on
 * every activation. For installed plugins that never change, that build is
 * pure waste; §8.1 allows runtime-generated artifacts on disk as long as the
 * key includes every component that can change the compiled form:
 *
 *   cache key = package source digest + NodeVersion + SESVersion +
 *               EndoCompilerVersion + NeoTavernLoaderVersion
 *
 * Any component upgrade invalidates the cache and the graph is rebuilt from
 * canonical source. The cache is fully removable and automatically
 * rebuildable (§20): entries are plain JSON files written atomically
 * (temp file + rename, §12), and a corrupt/missing entry is simply a miss.
 */
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PluginModuleGraph } from '@neotavern/contracts';

const require = createRequire(import.meta.url);

/** Upper bound for a stored graph (mirrors the host's graph cap, §15.11). */
export const MODULE_MAP_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export interface ModuleMapCacheVersions {
  node: string;
  ses: string;
  endoModuleSource: string;
  neotavernLoader: string;
}

/** Resolve the versioned components that shape the compiled module graph. */
export function resolveModuleMapVersions(): ModuleMapCacheVersions {
  const readVersion = (packageName: string): string => {
    try {
      const manifest = require(`${packageName}/package.json`) as { version?: string };
      return manifest.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
  return {
    node: process.versions.node,
    ses: readVersion('ses'),
    endoModuleSource: readVersion('@endo/module-source'),
    neotavernLoader: readVersion('@neotavern/plugin-runtime'),
  };
}

/** sha256 over the sorted package source files (rel path + content). */
export function packageSourceDigest(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const rel of [...files.keys()].sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(files.get(rel) ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The versioned cache key: source digest + every compiled-form component. */
export function moduleMapCacheKey(sourceDigest: string, versions: ModuleMapCacheVersions): string {
  const hash = createHash('sha256');
  hash.update(sourceDigest);
  hash.update(versions.node);
  hash.update(versions.ses);
  hash.update(versions.endoModuleSource);
  hash.update(versions.neotavernLoader);
  return hash.digest('hex');
}

export interface StoredModuleMap {
  graph: PluginModuleGraph;
  warnings: string[];
}

function isStoredModuleMap(value: unknown): value is StoredModuleMap {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const graph = record['graph'] as Record<string, unknown> | null | undefined;
  if (graph === null || typeof graph !== 'object') return false;
  return (
    typeof graph['pluginId'] === 'string' &&
    typeof graph['entry'] === 'string' &&
    Array.isArray(graph['records']) &&
    Array.isArray(record['warnings'])
  );
}

export class ModuleMapDiskCache {
  constructor(
    private readonly cacheDir: string,
    private readonly versions: ModuleMapCacheVersions = resolveModuleMapVersions(),
  ) {}

  /** Path of the entry for a package source digest. */
  entryPath(sourceDigest: string): string {
    return join(this.cacheDir, `${moduleMapCacheKey(sourceDigest, this.versions)}.json`);
  }

  /** Cache hit → stored graph; miss/corrupt → undefined (rebuild from source). */
  async get(sourceDigest: string): Promise<StoredModuleMap | undefined> {
    try {
      const raw = await readFile(this.entryPath(sourceDigest), 'utf8');
      if (raw.length > MODULE_MAP_CACHE_MAX_ENTRY_BYTES) return undefined;
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredModuleMap(parsed)) return undefined;
      return parsed;
    } catch {
      // Missing or corrupt entry: a miss — the graph is rebuilt from the
      // canonical source (§8.1) and the entry is replaced on the next put.
      return undefined;
    }
  }

  /** Store the built graph atomically (temp file + rename, §12). */
  async put(sourceDigest: string, entry: StoredModuleMap): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const target = this.entryPath(sourceDigest);
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(temporary, JSON.stringify(entry), 'utf8');
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /** Drop every entry (the cache is fully removable, §20). */
  async clear(): Promise<void> {
    await rm(this.cacheDir, { recursive: true, force: true });
  }

  /** Entry count (tests, diagnostics). */
  async size(): Promise<number> {
    try {
      return (await readdir(this.cacheDir)).length;
    } catch {
      return 0;
    }
  }
}
