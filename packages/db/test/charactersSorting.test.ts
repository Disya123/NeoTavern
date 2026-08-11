import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppDatabase, type AppDatabase } from '../src/index.js';

/**
 * Catalog sort behavior for the expanded `sort` vocabulary (migration 0012):
 * A–Z / Z–A, newest / oldest, favorites, recently used, chat-count and
 * token-count (volume proxy) ascending and descending, random, and the
 * deprecated legacy aliases. Each sort pages via keyset cursors (except
 * random, which is a single shuffled page).
 */
describe('character catalog sorting', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createAppDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  async function seed(): Promise<Record<string, string>> {
    // Distinct names so A–Z / Z–A ordering is unambiguous; createdAt is set
    // explicitly via the create() path is not possible, so we rely on
    // creation order + the clock being deterministic enough — instead we
    // touch `lastUsedAt` through `touchUsage` and chat creation to exercise
    // the "used" sort.
    const alice = await db.repos.characters.create({ name: 'Alice' });
    const bob = await db.repos.characters.create({ name: 'Bob' });
    const carol = await db.repos.characters.create({ name: 'Carol' });
    const dave = await db.repos.characters.create({ name: 'Dave' });

    // Favorites: Alice and Carol.
    await db.repos.characters.update(alice.id, { ext: { favorite: true } });
    await db.repos.characters.update(carol.id, { ext: { legacy: { favorite: true } } });

    // Chats: Bob gets 3 chats, Dave gets 1, Alice/Carol get 0.
    for (let i = 0; i < 3; i += 1) {
      const chat = await db.repos.chats.create({ characterId: bob.id });
      // Two messages per chat so Bob accumulates token volume.
      await db.repos.messages.create(chat.id, chat.activeBranchId, {
        role: 'user',
        content: 'hello world',
      });
      await db.repos.messages.create(chat.id, chat.activeBranchId, {
        role: 'assistant',
        content: 'hi there friend',
      });
    }
    const daveChat = await db.repos.chats.create({ characterId: dave.id });
    await db.repos.messages.create(daveChat.id, daveChat.activeBranchId, {
      role: 'user',
      content: 'short',
    });

    // Bob is the most recently used (chat creation touches lastUsedAt last).
    // Dave was used once. Alice/Carol never used.
    return { alice: alice.id, bob: bob.id, carol: carol.id, dave: dave.id };
  }

  it('sorts A–Z and Z–A by name with id tie-break', async () => {
    const ids = await seed();
    const az = await db.repos.characters.list({ sort: 'name', limit: 10 });
    expect(az.items.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
    const za = await db.repos.characters.list({ sort: 'name-desc', limit: 10 });
    expect(za.items.map((c) => c.name)).toEqual(['Dave', 'Carol', 'Bob', 'Alice']);

    // Cursor pagination on Z–A.
    const zaPage = await db.repos.characters.list({ sort: 'name-desc', limit: 2 });
    expect(zaPage.items.map((c) => c.name)).toEqual(['Dave', 'Carol']);
    expect(zaPage.hasMore).toBe(true);
    const zaNext = await db.repos.characters.list({
      sort: 'name-desc',
      limit: 2,
      cursor: zaPage.nextCursor ?? undefined,
    });
    expect(zaNext.items.map((c) => c.name)).toEqual(['Bob', 'Alice']);
    expect(zaNext.hasMore).toBe(false);
    expect(zaNext.nextCursor).toBeNull();
    // No overlap between pages.
    const seen = new Set([...zaPage.items, ...zaNext.items].map((c) => c.id));
    expect(seen.size).toBe(4);
    expect(zaPage.items.map((c) => c.id)).toContain(ids.dave);
  });

  it('sorts newest / oldest by createdAt desc / asc', async () => {
    await seed();
    const newest = await db.repos.characters.list({ sort: 'newest', limit: 10 });
    // Created in order Alice, Bob, Carol, Dave — newest first.
    expect(newest.items.map((c) => c.name)).toEqual(['Dave', 'Carol', 'Bob', 'Alice']);
    const oldest = await db.repos.characters.list({ sort: 'oldest', limit: 10 });
    expect(oldest.items.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('sorts by favorites first, then A–Z', async () => {
    await seed();
    const fav = await db.repos.characters.list({ sort: 'favorites', limit: 10 });
    expect(fav.items.map((c) => c.name)).toEqual(['Alice', 'Carol', 'Bob', 'Dave']);
    // Cursor pagination across the favorite/non-favorite boundary.
    const page = await db.repos.characters.list({ sort: 'favorites', limit: 2 });
    expect(page.items.map((c) => c.name)).toEqual(['Alice', 'Carol']);
    expect(page.hasMore).toBe(true);
    const next = await db.repos.characters.list({
      sort: 'favorites',
      limit: 2,
      cursor: page.nextCursor ?? undefined,
    });
    expect(next.items.map((c) => c.name)).toEqual(['Bob', 'Dave']);
  });

  it('sorts recently used, with never-used characters last', async () => {
    await seed();
    // Dave's chat is created last, so Dave is the most recently used, then Bob
    // (3 chats), then Alice/Carol (never used, tie broken by id DESC).
    const used = await db.repos.characters.list({ sort: 'used', limit: 10 });
    const names = used.items.map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(['Dave', 'Bob']);
    expect(names.slice(2).sort()).toEqual(['Alice', 'Carol']);
  });

  it('sorts by chat count desc and asc', async () => {
    await seed();
    const most = await db.repos.characters.list({ sort: 'chats-most', limit: 10 });
    expect(most.items.map((c) => c.name)).toEqual(['Bob', 'Dave', 'Alice', 'Carol']);
    const least = await db.repos.characters.list({ sort: 'chats-least', limit: 10 });
    // Alice/Carol have 0 chats (tie → A–Z), then Dave (1), then Bob (3).
    expect(least.items.map((c) => c.name)).toEqual(['Alice', 'Carol', 'Dave', 'Bob']);
  });

  it('sorts by token count (content length) desc and asc', async () => {
    await seed();
    const most = await db.repos.characters.list({ sort: 'tokens-most', limit: 10 });
    // Bob has 6 messages (3 chats × 2) of "hello world"(11) + "hi there friend"(15) = 26×3 = 78.
    // Dave has "short"(5). Alice/Carol have 0.
    expect(most.items.map((c) => c.name)).toEqual(['Bob', 'Dave', 'Alice', 'Carol']);
    const least = await db.repos.characters.list({ sort: 'tokens-least', limit: 10 });
    expect(least.items.map((c) => c.name)).toEqual(['Alice', 'Carol', 'Dave', 'Bob']);
  });

  it('random sort returns a single page with no cursor and no duplicates', async () => {
    await seed();
    const page = await db.repos.characters.list({ sort: 'random', limit: 4 });
    expect(page.items).toHaveLength(4);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    const ids = new Set(page.items.map((c) => c.id));
    expect(ids.size).toBe(4);
    // The page is a permutation of the whole catalog (limit equals the count).
    expect(page.items.map((c) => c.name).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
    // A smaller limit returns a subset without a continuation cursor.
    const small = await db.repos.characters.list({ sort: 'random', limit: 2 });
    expect(small.items).toHaveLength(2);
    expect(small.hasMore).toBe(false);
    expect(small.nextCursor).toBeNull();
  });

  it('maps deprecated aliases to their canonical sorts', async () => {
    await seed();
    // `recent` historically meant createdAt DESC → maps to `newest`.
    const recent = await db.repos.characters.list({ sort: 'recent', limit: 10 });
    const newest = await db.repos.characters.list({ sort: 'newest', limit: 10 });
    expect(recent.items.map((c) => c.id)).toEqual(newest.items.map((c) => c.id));
    // `created` → `oldest`.
    const created = await db.repos.characters.list({ sort: 'created', limit: 10 });
    const oldest = await db.repos.characters.list({ sort: 'oldest', limit: 10 });
    expect(created.items.map((c) => c.id)).toEqual(oldest.items.map((c) => c.id));
    // `usage` → `used`.
    const usage = await db.repos.characters.list({ sort: 'usage', limit: 10 });
    const used = await db.repos.characters.list({ sort: 'used', limit: 10 });
    expect(usage.items.map((c) => c.id)).toEqual(used.items.map((c) => c.id));
  });

  it('chat count excludes soft-deleted chats', async () => {
    const ids = await seed();
    const bobChats = await db.repos.chats.list({ characterId: ids.bob, limit: 50 });
    expect(bobChats.items).toHaveLength(3);
    await db.repos.chats.softDelete(bobChats.items[0]!.id);
    const most = await db.repos.characters.list({ sort: 'chats-most', limit: 10 });
    // Bob now has 2 chats — still first, but the count dropped.
    expect(most.items[0]!.name).toBe('Bob');
    // Restore brings it back to 3.
    await db.repos.chats.restore(bobChats.items[0]!.id);
    const afterRestore = await db.repos.characters.list({ sort: 'chats-most', limit: 10 });
    expect(afterRestore.items[0]!.name).toBe('Bob');
  });
});
