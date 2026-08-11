/**
 * Integration tests for smart FTS5 character search:
 * tag:/author:/name:/desc: filters, phrases, negation and cursor pagination.
 */
import { describe, expect, it } from 'vitest';
import { createAppDatabase, type AppDatabase } from '../src/index.js';

function makeDb(): AppDatabase {
  return createAppDatabase(':memory:');
}

async function seed(db: AppDatabase): Promise<void> {
  await db.repos.characters.create({
    name: 'Sir Magnus',
    description: 'Он держит магический меч в руках',
    personality: 'brave knight',
    scenario: 'battlefield',
    creator: 'Tidyup',
    tags: ['NSFW', 'knight'],
  });
  await db.repos.characters.create({
    name: 'Lady Luna',
    description: 'Меч был магический, но сломан напополам',
    personality: 'clever mage',
    scenario: 'castle',
    creator: 'Tidyup',
    tags: ['fantasy', 'sfw'],
  });
  await db.repos.characters.create({
    name: 'Old Swordsman',
    description: 'A retired warrior',
    personality: 'grim',
    scenario: 'village',
    creator: 'Anonymous Author',
    tags: ['NSFW', 'beta'],
  });
}

describe('smart character search', () => {
  it('finds characters by free text with the default sort (FTS, not LIKE)', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'retired' });
    expect(page.items.map((c) => c.name)).toEqual(['Old Swordsman']);
  });

  it('filters by tag with tag:', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:NSFW' });
    expect(page.items.map((c) => c.name).sort()).toEqual(['Old Swordsman', 'Sir Magnus']);
  });

  it('applies multiple tag: filters as AND', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:NSFW tag:knight' });
    expect(page.items.map((c) => c.name)).toEqual(['Sir Magnus']);
  });

  it('excludes tags with -tag:', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:NSFW -tag:beta' });
    expect(page.items.map((c) => c.name)).toEqual(['Sir Magnus']);
  });

  it('matches tag values case-insensitively', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:nsfw' });
    expect(page.items).toHaveLength(2);
  });

  it('matches tag prefixes so partial names like tag:sf find sfw', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:sf' });
    expect(page.items.map((c) => c.name)).toEqual(['Lady Luna']);
    const full = await db.repos.characters.list({ q: 'tag:sfw' });
    expect(full.items.map((c) => c.name)).toEqual(['Lady Luna']);
  });

  it('matches tag prefixes case-insensitively and in the FTS path', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:NSF меч' });
    expect(page.items.map((c) => c.name)).toEqual(['Sir Magnus']);
  });

  it('excludes tags by prefix with -tag:', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:NSFW -tag:bet' });
    expect(page.items.map((c) => c.name)).toEqual(['Sir Magnus']);
  });

  it('keeps the legacy tag query param an exact match', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: '', tag: 'sf' });
    expect(page.items).toHaveLength(0);
    const exact = await db.repos.characters.list({ q: '', tag: 'NSFW' });
    expect(exact.items).toHaveLength(2);
  });

  it('filters by author substring with author:', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'author:Tidyup' });
    expect(page.items.map((c) => c.name).sort()).toEqual(['Lady Luna', 'Sir Magnus']);
  });

  it('excludes authors with -author:', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: '-author:tidy' });
    expect(page.items.map((c) => c.name)).toEqual(['Old Swordsman']);
  });

  it('matches exact quoted phrases only (not scattered words)', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: '"магический меч"' });
    expect(page.items.map((c) => c.name)).toEqual(['Sir Magnus']);
  });

  it('combines tag, author and phrase filters', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:NSFW author:Tidyup "магический меч"' });
    expect(page.items.map((c) => c.name)).toEqual(['Sir Magnus']);
  });

  it('scopes search to the name column with name:', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'name:Luna' });
    expect(page.items.map((c) => c.name)).toEqual(['Lady Luna']);
  });

  it('scopes search to the description column with desc:', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'desc:retired' });
    expect(page.items.map((c) => c.name)).toEqual(['Old Swordsman']);
  });

  it('excludes names with -name:', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:NSFW -name:swordsman' });
    expect(page.items.map((c) => c.name)).toEqual(['Sir Magnus']);
  });

  it('applies structured filters without text in the plain sort path', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:NSFW', sort: 'name' });
    expect(page.items.map((c) => c.name)).toEqual(['Old Swordsman', 'Sir Magnus']);
  });

  it('combines the tag query param with tag:', async () => {
    const db = makeDb();
    await seed(db);
    const page = await db.repos.characters.list({ q: 'tag:knight', tag: 'NSFW' });
    expect(page.items.map((c) => c.name)).toEqual(['Sir Magnus']);
  });

  it('excludes soft-deleted characters from filtered search', async () => {
    const db = makeDb();
    await seed(db);
    const sir = await db.repos.characters.list({ q: 'name:Magnus' });
    await db.repos.characters.softDelete(sir.items[0]!.id);
    const page = await db.repos.characters.list({ q: 'tag:NSFW' });
    expect(page.items.map((c) => c.name)).toEqual(['Old Swordsman']);
  });

  it('cursor-paginates through filtered FTS results without overlap', async () => {
    const db = createAppDatabase(':memory:');
    for (let index = 0; index < 7; index += 1) {
      await db.repos.characters.create({
        name: `Knight ${index}`,
        description: 'master of the ancient sword',
        tags: ['NSFW'],
      });
    }
    const p1 = await db.repos.characters.list({ q: 'tag:NSFW sword', limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    const p2 = await db.repos.characters.list({
      q: 'tag:NSFW sword',
      limit: 3,
      cursor: p1.nextCursor ?? undefined,
    });
    const seen = new Set([...p1.items, ...p2.items].map((c) => c.id));
    expect(seen.size).toBe(6);
    expect(p2.hasMore).toBe(true);
    const p3 = await db.repos.characters.list({
      q: 'tag:NSFW sword',
      limit: 3,
      cursor: p2.nextCursor ?? undefined,
    });
    expect(p3.items).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
  });

  it('degrades gracefully on malformed input instead of throwing', async () => {
    const db = makeDb();
    await seed(db);
    for (const q of ['tag:', '"', '----', '""', '-tag:']) {
      const page = await db.repos.characters.list({ q });
      expect(Array.isArray(page.items)).toBe(true);
    }
  });
});
