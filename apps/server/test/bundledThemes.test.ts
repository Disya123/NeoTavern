import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { createLogger } from '@neotavern/shared';
import { ensureDataDirs, resolveDataPaths } from '../src/lib/paths.js';
import {
  BUNDLED_THEMES_MARKER_KEY,
  defaultBundledThemesAssetsDir,
  seedBundledThemes,
} from '../src/lib/bundledThemes.js';

const databases: AppDatabase[] = [];
const temporaryDirectories: string[] = [];

const RED = {
  id: 'neotavern.red-test',
  name: 'Red Test',
  version: '1.0.0',
  apiVersion: 1,
  modes: ['dark'],
  tokens: { dark: { 'color-accent': '#e02020', 'color-surface-canvas': '#1a0a0a' } },
  componentsCss: 'components.css',
  shell: 'shell.css',
};
const BLUE = {
  id: 'neotavern.blue-test',
  name: 'Blue Test',
  version: '1.0.0',
  apiVersion: 1,
  modes: ['dark'],
  tokens: { dark: { 'color-accent': '#2050e0', 'color-surface-canvas': '#0a0a1a' } },
  componentsCss: 'components.css',
  shell: 'shell.css',
};

const SAFE_CSS =
  "@layer theme { [data-slot='app.shell'] { background: var(--st-color-surface-canvas); } }";

async function buildFixture(root: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    const manifest = id === RED.id ? RED : BLUE;
    await writeFile(join(dir, 'theme.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(dir, 'components.css'), SAFE_CSS, 'utf8');
    await writeFile(join(dir, 'shell.css'), SAFE_CSS, 'utf8');
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'neotavern-bundled-themes-'));
  temporaryDirectories.push(root);
  const paths = resolveDataPaths(root);
  ensureDataDirs(paths);
  const database = createAppDatabase(':memory:');
  databases.push(database);
  const logs: string[] = [];
  const logger = createLogger({ sink: (line) => logs.push(line) });
  return { root, paths, database, logger, logs };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('bundled themes', () => {
  it('seeds every bundled package into the registry and themes directory once', async () => {
    const { root, paths, database, logger } = setup();
    const assetsDir = join(root, 'assets', 'themes');
    await buildFixture(assetsDir, [RED.id, BLUE.id]);

    const result = await seedBundledThemes({ database, paths, logger, assetsDir });
    expect(result.status).toBe('seeded');
    expect(result.seededIds.sort()).toEqual([BLUE.id, RED.id]);

    const items = database.repos.themes.list();
    expect(items.map((item) => item.id).sort()).toEqual([BLUE.id, RED.id]);
    expect(items.every((item) => item.enabled === false)).toBe(true);
    for (const id of [RED.id, BLUE.id]) {
      const manifestPath = join(paths.themes, id, 'theme.json');
      expect(readFileSync(manifestPath, 'utf8')).toContain(`"${id}"`);
    }

    const marker = await database.repos.appMeta.get(BUNDLED_THEMES_MARKER_KEY);
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker ?? '[]')).toEqual([BLUE.id, RED.id]);

    const second = await seedBundledThemes({ database, paths, logger, assetsDir });
    expect(second.status).toBe('already-complete');
    expect(database.repos.themes.list()).toHaveLength(2);
  });

  it('respects user deletion: a removed bundled theme is not re-seeded', async () => {
    const { root, paths, database, logger } = setup();
    const assetsDir = join(root, 'assets', 'themes');
    await buildFixture(assetsDir, [RED.id, BLUE.id]);

    await seedBundledThemes({ database, paths, logger, assetsDir });
    database.repos.themes.delete(RED.id);

    const result = await seedBundledThemes({ database, paths, logger, assetsDir });
    expect(result.status).toBe('already-complete');
    expect(database.repos.themes.list().map((item) => item.id)).toEqual([BLUE.id]);
  });

  it('seeds new bundled themes added in a later release without touching prior ones', async () => {
    const { root, paths, database, logger } = setup();
    const assetsDir = join(root, 'assets', 'themes');
    await buildFixture(assetsDir, [RED.id]);
    await seedBundledThemes({ database, paths, logger, assetsDir });

    await buildFixture(assetsDir, [BLUE.id]);
    const result = await seedBundledThemes({ database, paths, logger, assetsDir });
    expect(result.status).toBe('seeded');
    expect(result.seededIds.sort()).toEqual([BLUE.id, RED.id]);
    const red = database.repos.themes.getById(RED.id);
    const blue = database.repos.themes.getById(BLUE.id);
    expect(red?.enabled).toBe(false);
    expect(blue?.enabled).toBe(false);
  });

  it('re-seeds a theme whose registry entry was lost (crash between copy and install)', async () => {
    const { root, paths, database, logger } = setup();
    const assetsDir = join(root, 'assets', 'themes');
    await buildFixture(assetsDir, [RED.id]);
    await seedBundledThemes({ database, paths, logger, assetsDir });

    // Simulate a crash that left the directory but removed the registry row.
    database.repos.themes.delete(RED.id);
    expect(database.repos.themes.getById(RED.id)).toBeNull();
    // The directory still exists from the first seed; the marker is set, so a
    // normal re-run skips it. Clearing the marker (corrupt marker / manual
    // repair) must re-seed and restore the registry entry.
    await database.repos.appMeta.delete(BUNDLED_THEMES_MARKER_KEY);

    const result = await seedBundledThemes({ database, paths, logger, assetsDir });
    expect(result.status).toBe('seeded');
    expect(database.repos.themes.getById(RED.id)).not.toBeNull();
  });

  it('refreshes a bundled theme when its shipped version increases', async () => {
    const { root, paths, database, logger } = setup();
    const assetsDir = join(root, 'assets', 'themes');
    await buildFixture(assetsDir, [RED.id]);
    await seedBundledThemes({ database, paths, logger, assetsDir });

    const upgraded = { ...RED, version: '1.1.0' };
    await writeFile(join(assetsDir, RED.id, 'theme.json'), JSON.stringify(upgraded), 'utf8');
    await writeFile(
      join(assetsDir, RED.id, 'shell.css'),
      "@layer theme { [data-slot='app.shell'] { outline: 1px solid red; } }",
      'utf8',
    );

    const result = await seedBundledThemes({ database, paths, logger, assetsDir });
    expect(result.status).toBe('seeded');
    expect(result.seededIds).toEqual([RED.id]);
    expect(database.repos.themes.getById(RED.id)?.version).toBe('1.1.0');
    expect(readFileSync(join(paths.themes, RED.id, 'shell.css'), 'utf8')).toContain('outline');
  });

  it('keeps startup usable and retryable when the bundled source is unavailable', async () => {
    const { root, paths, database, logger, logs } = setup();
    const assetsDir = join(root, 'missing', 'themes');
    const result = await seedBundledThemes({ database, paths, logger, assetsDir });
    expect(result.status).toBe('retry');
    expect(database.repos.themes.list()).toHaveLength(0);
    expect(logs.join('\n')).toContain('BUNDLED_THEMES_RETRY');
  });

  it('all shipped bundled themes pass manifest and CSS validation', async () => {
    const { paths, database, logger } = setup();
    const assetsDir = defaultBundledThemesAssetsDir();
    const result = await seedBundledThemes({ database, paths, logger, assetsDir });
    // The shipped set is non-empty and every package validates; a forbidden
    // construct or invalid manifest would throw and surface as `retry`.
    expect(result.status).not.toBe('retry');
    expect(result.seededIds.length).toBeGreaterThanOrEqual(10);
    expect(database.repos.themes.list().length).toBeGreaterThanOrEqual(10);
  });
});
