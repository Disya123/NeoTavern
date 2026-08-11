import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { createLogger } from '@neotavern/shared';
import { ensureDataDirs, resolveDataPaths } from '../src/lib/paths.js';
import {
  STARTER_CHARACTER_ID_KEY,
  STARTER_COMPLETE_KEY,
  STARTER_LOREBOOK_ID_KEY,
  defaultStarterAssetsDir,
  seedStarterContent,
} from '../src/lib/starterContent.js';

const databases: AppDatabase[] = [];
const temporaryDirectories: string[] = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'neotavern-starter-'));
  temporaryDirectories.push(root);
  const paths = resolveDataPaths(root);
  ensureDataDirs(paths);
  const database = createAppDatabase(':memory:');
  databases.push(database);
  const logs: string[] = [];
  const logger = createLogger({ sink: (line) => logs.push(line) });
  return { database, paths, logger, logs };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('starter content', () => {
  it('seeds exact Hazel data and four linked Vesper entries once', async () => {
    const { database, paths, logger } = setup();
    const result = await seedStarterContent({ database, paths, logger });
    expect(result.status).toBe('seeded');
    expect(result.characterId).toBeTruthy();
    expect(result.lorebookId).toBeTruthy();

    const character = result.characterId
      ? await database.repos.characters.getById(result.characterId)
      : null;
    const lorebook = result.lorebookId
      ? await database.repos.lorebooks.getById(result.lorebookId)
      : null;
    if (!character || !lorebook) throw new Error('starter content missing after seed');
    expect(character).toMatchObject({
      name: 'Hazel',
      scenario:
        "A stranger follows a dead signal into the rain-soaked underbelly of Vesper and finds Hazel's repair bench in a neon alley.",
      systemPrompt: null,
      postHistoryInstructions: null,
    });
    expect(character.avatar).toMatch(/^\/api\/v2\/assets\/thumbnails\//);
    expect(lorebook).toMatchObject({ name: 'Vesper', characterId: character.id });

    const entries = await database.repos.lorebooks.listEntries(lorebook.id);
    expect(entries).toHaveLength(4);
    expect(entries.every((entry) => entry.selective === false)).toBe(true);
    expect(entries.every((entry) => entry.metadata['promptPlacement'] === 'before')).toBe(true);
    expect(entries.map((entry) => entry.position)).toEqual([100, 100, 100, 100]);
    const authored = JSON.parse(
      readFileSync(join(defaultStarterAssetsDir(), 'Vesper-lore-book.json'), 'utf8'),
    ) as { entries: Record<string, { content: string }> };
    expect(entries.map((entry) => entry.content)).toEqual(
      Object.values(authored.entries).map((entry) => entry.content),
    );

    const second = await seedStarterContent({ database, paths, logger });
    expect(second.status).toBe('already-complete');
    expect((await database.repos.characters.list({ includeDeleted: true })).items).toHaveLength(1);
    expect((await database.repos.lorebooks.list({ includeDeleted: true })).items).toHaveLength(1);
  });

  it('resumes staged markers and missing entries without duplicates', async () => {
    const { database, paths, logger } = setup();
    const unrelated = await database.repos.characters.create({ name: 'Existing user character' });
    const seeded = await seedStarterContent({ database, paths, logger });
    if (!seeded.lorebookId) throw new Error('starter lorebook missing');
    const entries = await database.repos.lorebooks.listEntries(seeded.lorebookId);
    const removed = entries.at(-1);
    if (!removed) throw new Error('starter lorebook entry missing');
    await database.repos.lorebooks.deleteEntry(seeded.lorebookId, removed.id);
    await database.repos.appMeta.delete(STARTER_COMPLETE_KEY);

    const resumed = await seedStarterContent({ database, paths, logger });
    expect(resumed.status).toBe('seeded');
    expect(resumed.characterId).toBe(seeded.characterId);
    expect(resumed.lorebookId).toBe(seeded.lorebookId);
    expect(await database.repos.lorebooks.listEntries(seeded.lorebookId)).toHaveLength(4);
    const allCharacters = (
      await database.repos.characters.list({ includeDeleted: true, limit: 50 })
    ).items;
    expect(allCharacters.map((character) => character.id)).toEqual(
      expect.arrayContaining([unrelated.id, seeded.characterId]),
    );
    expect(allCharacters).toHaveLength(2);
  });

  it('does not recreate user-deleted starter content after completion', async () => {
    const { database, paths, logger } = setup();
    const seeded = await seedStarterContent({ database, paths, logger });
    if (!seeded.characterId) throw new Error('starter character missing');
    await database.repos.characters.hardDelete(seeded.characterId);

    const repeated = await seedStarterContent({ database, paths, logger });
    expect(repeated.status).toBe('already-complete');
    expect(await database.repos.characters.getById(seeded.characterId)).toBeNull();
  });

  it('keeps startup usable and retryable when bundled assets are corrupt', async () => {
    const { database, paths, logger, logs } = setup();
    const assetsDir = join(paths.root, 'corrupt-starter');
    mkdirSync(assetsDir, { recursive: true });
    for (const filename of [
      'default_Hazel_avatar.png',
      'default_Hazel.json',
      'Vesper-lore-book.json',
    ]) {
      writeFileSync(join(assetsDir, filename), 'corrupt');
    }

    const result = await seedStarterContent({ database, paths, logger, assetsDir });
    expect(result.status).toBe('retry');
    expect(await database.repos.appMeta.get(STARTER_COMPLETE_KEY)).toBeNull();
    expect(await database.repos.appMeta.get(STARTER_CHARACTER_ID_KEY)).toBeNull();
    expect(await database.repos.appMeta.get(STARTER_LOREBOOK_ID_KEY)).toBeNull();
    expect(logs.join('\n')).toContain('STARTER_CONTENT_RETRY');
    expect(await database.repos.characters.list({})).toMatchObject({ items: [] });
  });
});
