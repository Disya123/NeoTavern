/**
 * Bundled theme seeding (ТЗ §6.5 / docs/theme-sdk). The distribution ships a
 * curated set of theme packages under `apps/server/assets/themes/`; on first
 * boot each one is copied into `data/themes/<id>/` and registered, so the
 * Themes manager shows real themes out of the box instead of an empty list.
 *
 * Semantics mirror `seedStarterContent`:
 * - an `app_meta` marker records the set of theme ids already seeded;
 * - only ids missing from the marker are installed, so themes added in a later
 *   release appear on update while user-deleted ones stay deleted;
 * - bundled packages with a higher `version` than the installed copy are
 *   refreshed on the next boot (files under `data/themes/` + registry row);
 * - the built-in light/dark token defaults remain the safe-mode/reset fallback;
 * - seeding never activates a theme — the user picks one in the manager;
 * - a failed seed logs a warning and retries on the next boot.
 */
import { cp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  containsForbiddenCssConstruct,
  validateThemeManifest,
  type ThemeManifest,
} from '@neotavern/theme-sdk';
import type { AppDatabase } from '@neotavern/db';
import { randomToken, type Logger } from '@neotavern/shared';
import type { DataPaths } from './paths.js';

export const BUNDLED_THEMES_MARKER_KEY = 'themes.bundled.v1';

interface BundledThemesSeedOptions {
  database: AppDatabase;
  paths: DataPaths;
  logger: Logger;
  /** Bundled theme package sources. Defaults to the package assets directory. */
  assetsDir?: string;
}

export interface BundledThemesSeedResult {
  status: 'seeded' | 'already-complete' | 'retry';
  seededIds: string[];
}

export function defaultBundledThemesAssetsDir(): string {
  return fileURLToPath(new URL('../../assets/themes/', import.meta.url));
}

/**
 * Parse the seeded-id marker. Unknown shapes degrade to an empty set, which
 * causes a re-seed — safe and self-healing if the marker is ever corrupted.
 */
async function readSeededIds(database: AppDatabase): Promise<Set<string>> {
  const raw = await database.repos.appMeta.get(BUNDLED_THEMES_MARKER_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

async function writeSeededIds(database: AppDatabase, ids: Iterable<string>): Promise<void> {
  await database.repos.appMeta.set(BUNDLED_THEMES_MARKER_KEY, JSON.stringify([...ids].sort()));
}

/** Validate a bundled package's manifest and CSS against the Theme SDK contract. */
function validateBundledPackage(
  manifest: ThemeManifest,
  css: ReadonlyArray<{ name: string; content: string }>,
): void {
  for (const { name, content } of css) {
    if (containsForbiddenCssConstruct(content)) {
      throw new Error(`BUNDLED_THEME_UNSAFE_CSS:${name}`);
    }
  }
  for (const field of ['componentsCss', 'shell'] as const) {
    const path = manifest[field];
    if (path && !css.some((entry) => entry.name === path)) {
      throw new Error(`BUNDLED_THEME_MISSING_CSS:${field}:${path}`);
    }
  }
}

async function readBundledManifest(themeDir: string): Promise<ThemeManifest> {
  const manifestPath = join(themeDir, 'theme.json');
  const manifestInput = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const result = validateThemeManifest(manifestInput);
  if (!result.ok) throw new Error(`BUNDLED_THEME_INVALID_MANIFEST:${themeDir}`);
  return result.value;
}

function compareThemeVersions(next: string, current: string): number {
  const parse = (value: string): number[] =>
    value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(next);
  const right = parse(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function shouldSeedBundledTheme(
  bundledId: string,
  bundledVersion: string,
  seededIds: ReadonlySet<string>,
  database: AppDatabase,
): boolean {
  if (!seededIds.has(bundledId)) return true;
  const installed = database.repos.themes.getById(bundledId);
  if (!installed) return false;
  return compareThemeVersions(bundledVersion, installed.version) > 0;
}

async function seedOne(themeDir: string, paths: DataPaths, database: AppDatabase): Promise<string> {
  const manifest = await readBundledManifest(themeDir);

  const cssEntries: { name: string; content: string }[] = [];
  for (const field of ['componentsCss', 'shell'] as const) {
    const path = manifest[field];
    if (!path) continue;
    cssEntries.push({ name: path, content: await readFile(join(themeDir, path), 'utf8') });
  }
  validateBundledPackage(manifest, cssEntries);

  const targetPath = join(paths.themes, manifest.id);
  const incomingPath = join(paths.themes, `.incoming-${randomSuffix()}`);
  await cp(themeDir, incomingPath, { recursive: true });
  let rollbackPath: string | null = null;
  if (await pathExists(targetPath)) {
    rollbackPath = join(paths.themes, `.rollback-${randomSuffix()}`);
    await rename(targetPath, rollbackPath);
  }
  try {
    await rename(incomingPath, targetPath);
    if (rollbackPath)
      await rm(rollbackPath, { recursive: true, force: true }).catch(() => undefined);
    database.repos.themes.install({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      manifest: manifestRecord(manifest),
    });
    return manifest.id;
  } catch (cause) {
    await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    if (rollbackPath) await rename(rollbackPath, targetPath).catch(() => undefined);
    await rm(incomingPath, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

export async function seedBundledThemes({
  database,
  paths,
  logger,
  assetsDir = defaultBundledThemesAssetsDir(),
}: BundledThemesSeedOptions): Promise<BundledThemesSeedResult> {
  const seededIds = await readSeededIds(database);
  let sourceEntries: Dirent[];
  try {
    sourceEntries = await readdir(assetsDir, { withFileTypes: true });
  } catch {
    logger.warn('bundled themes source directory unavailable', {
      code: 'BUNDLED_THEMES_RETRY',
      assetsDir,
    });
    return { status: 'retry', seededIds: [...seededIds] };
  }

  const pending = sourceEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  const installed: string[] = [];
  try {
    for (const id of pending) {
      const themeDir = join(assetsDir, id);
      const manifestPath = join(themeDir, 'theme.json');
      if (!(await pathExists(manifestPath))) continue;
      const manifest = await readBundledManifest(themeDir);
      if (!shouldSeedBundledTheme(manifest.id, manifest.version, seededIds, database)) continue;
      const seededId = await seedOne(themeDir, paths, database);
      seededIds.add(seededId);
      installed.push(seededId);
      await writeSeededIds(database, seededIds);
    }
    if (installed.length === 0) {
      return { status: 'already-complete', seededIds: [...seededIds] };
    }
    logger.info('bundled themes ready', { count: installed.length, ids: installed });
    return { status: 'seeded', seededIds: [...seededIds] };
  } catch (error) {
    logger.warn('bundled themes seeding interrupted; will retry next start', {
      code: 'BUNDLED_THEMES_RETRY',
      error: error instanceof Error ? error.message : String(error),
      installed,
    });
    return { status: 'retry', seededIds: [...seededIds] };
  }
}

function manifestRecord(manifest: ThemeManifest): Record<string, unknown> {
  return Object.fromEntries(Object.entries(manifest));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() || info.isDirectory();
  } catch {
    return false;
  }
}

function randomSuffix(): string {
  return randomToken(5);
}
