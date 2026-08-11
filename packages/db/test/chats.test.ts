import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppDatabase, type AppDatabase } from '../src/index.js';

/**
 * Chat repository ordering (migration 0013): manual `sort_order` for the
 * sidebar panel, cursor pagination over the effective order, content search
 * via messages_fts, and transactional reorder validation.
 */
describe('chat repository ordering & content search', () => {
  let db: AppDatabase;

  beforeEach(() => {
    let now = 1_000;
    db = createAppDatabase(':memory:', { clock: () => now++ });
  });
  afterEach(() => {
    db.close();
  });

  async function seedCharacter(): Promise<string> {
    const character = await db.repos.characters.create({ name: 'Order Me' });
    return character.id;
  }

  it('lists new chats on top (sort_order 0) ordered by updated_at DESC', async () => {
    const characterId = await seedCharacter();
    const first = await db.repos.chats.create({ characterId, title: 'First' });
    await db.repos.chats.create({ characterId, title: 'Second' });

    // second is newer → first in the default ordering.
    let page = await db.repos.chats.list({ characterId, limit: 10 });
    expect(page.items.map((c) => c.title)).toEqual(['Second', 'First']);

    // Bumping the older chat's updatedAt surfaces it on top.
    await db.repos.chats.touch(first.id);
    page = await db.repos.chats.list({ characterId, limit: 10 });
    expect(page.items.map((c) => c.title)).toEqual(['First', 'Second']);

    // Other characters are never returned.
    const other = await db.repos.characters.create({ name: 'Other' });
    await db.repos.chats.create({ characterId: other.id, title: 'Foreign' });
    page = await db.repos.chats.list({ characterId, limit: 10 });
    expect(page.items.map((c) => c.title)).toEqual(['First', 'Second']);
  });

  it('finds a greeting-only chat until the user starts it', async () => {
    const characterId = await seedCharacter();
    const chat = await db.repos.chats.create(
      { characterId, title: 'New conversation' },
      'Hello from the character',
    );

    await expect(db.repos.chats.findUnstarted(characterId, null)).resolves.toMatchObject({
      id: chat.id,
      messageCount: 1,
    });

    await db.repos.messages.create(chat.id, chat.activeBranchId, {
      role: 'user',
      content: 'Now this conversation is started',
    });
    await expect(db.repos.chats.findUnstarted(characterId, null)).resolves.toBeNull();
  });

  it('persists manual reorder and pages correctly over the new order', async () => {
    const characterId = await seedCharacter();
    const a = await db.repos.chats.create({ characterId, title: 'A' });
    const b = await db.repos.chats.create({ characterId, title: 'B' });
    const c = await db.repos.chats.create({ characterId, title: 'C' });
    const d = await db.repos.chats.create({ characterId, title: 'D' });

    await db.repos.chats.reorder(characterId, [c.id, a.id, d.id, b.id]);
    const page = await db.repos.chats.list({ characterId, limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([c.id, a.id, d.id, b.id]);

    // Keyset pagination over sort_order (2 per page, no overlap).
    const p1 = await db.repos.chats.list({ characterId, limit: 2 });
    expect(p1.items.map((item) => item.id)).toEqual([c.id, a.id]);
    const p2 = await db.repos.chats.list({
      characterId,
      limit: 2,
      cursor: p1.nextCursor ?? undefined,
    });
    expect(p2.items.map((item) => item.id)).toEqual([d.id, b.id]);
    expect(p2.hasMore).toBe(false);
    expect(p2.nextCursor).toBeNull();
  });

  it('lists recent chats independently of manual order with a dedicated cursor', async () => {
    const characterId = await seedCharacter();
    const a = await db.repos.chats.create({ characterId, title: 'A' });
    const b = await db.repos.chats.create({ characterId, title: 'B' });
    const c = await db.repos.chats.create({ characterId, title: 'C' });
    const d = await db.repos.chats.create({ characterId, title: 'D' });
    await db.repos.chats.reorder(characterId, [a.id, b.id, c.id, d.id]);

    const firstPage = await db.repos.chats.list({
      characterId,
      limit: 2,
      sort: 'recent',
    });
    expect(firstPage.items.map((item) => item.id)).toEqual([d.id, c.id]);
    expect(firstPage.items[0]).toMatchObject({
      characterName: 'Order Me',
      characterAvatar: null,
    });

    const secondPage = await db.repos.chats.list({
      characterId,
      limit: 2,
      sort: 'recent',
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.items.map((item) => item.id)).toEqual([b.id, a.id]);

    const other = await db.repos.characters.create({ name: 'Other' });
    const foreign = await db.repos.chats.create({ characterId: other.id, title: 'Foreign' });
    const global = await db.repos.chats.list({ limit: 1, sort: 'recent' });
    expect(global.items[0]?.id).toBe(foreign.id);

    await db.repos.chats.softDelete(d.id);
    const afterDelete = await db.repos.chats.list({ characterId, limit: 2, sort: 'recent' });
    expect(afterDelete.items.map((item) => item.id)).toEqual([c.id, b.id]);
  });

  it('keeps unlisted chats in relative order below the reordered block', async () => {
    const characterId = await seedCharacter();
    const a = await db.repos.chats.create({ characterId, title: 'A' });
    const b = await db.repos.chats.create({ characterId, title: 'B' });
    const c = await db.repos.chats.create({ characterId, title: 'C' });
    const d = await db.repos.chats.create({ characterId, title: 'D' });

    // Partial reorder: only the first two are moved; the rest stay relative.
    await db.repos.chats.reorder(characterId, [b.id, a.id]);
    const page = await db.repos.chats.list({ characterId, limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([b.id, a.id, d.id, c.id]);
  });

  it('rejects duplicates and reports ids that do not belong to the character', async () => {
    const characterId = await seedCharacter();
    const a = await db.repos.chats.create({ characterId, title: 'A' });
    const other = await db.repos.characters.create({ name: 'Other' });
    const foreign = await db.repos.chats.create({ characterId: other.id, title: 'Foreign' });

    await expect(db.repos.chats.reorder(characterId, [a.id, a.id])).rejects.toThrow(
      'CHAT_REORDER_DUPLICATE_IDS',
    );

    const result = await db.repos.chats.reorder(characterId, [a.id, foreign.id]);
    expect(result).toEqual({ reordered: 1, invalidIds: [foreign.id] });
    const page = await db.repos.chats.list({ characterId, limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([a.id]);
  });

  it('finds chats by message content via messages_fts', async () => {
    const characterId = await seedCharacter();
    const chatA = await db.repos.chats.create({ characterId, title: 'Groceries' });
    await db.repos.messages.create(chatA.id, chatA.activeBranchId, {
      role: 'user',
      content: 'remember to buy paprika at the market',
    });

    const chatB = await db.repos.chats.create({ characterId, title: 'Work' });
    await db.repos.messages.create(chatB.id, chatB.activeBranchId, {
      role: 'user',
      content: 'deadline moved to friday',
    });

    // Title match for "groceries".
    const byTitle = await db.repos.chats.list({ characterId, q: 'grocer', limit: 10 });
    expect(byTitle.items.map((item) => item.id)).toContain(chatA.id);

    // Content match: "paprika" only exists inside a message.
    const byContent = await db.repos.chats.list({ characterId, q: 'paprika', limit: 10 });
    expect(byContent.items.map((item) => item.id)).toEqual([chatA.id]);

    // Content match scoped to another character returns nothing.
    const byOther = await db.repos.chats.list({ q: 'paprika', limit: 10 });
    expect(byOther.items.map((item) => item.id)).toEqual([chatA.id]);
    const other = await db.repos.characters.create({ name: 'Scoped' });
    const scoped = await db.repos.chats.list({ characterId: other.id, q: 'paprika', limit: 10 });
    expect(scoped.items).toEqual([]);

    // No match at all.
    const noMatch = await db.repos.chats.list({ characterId, q: 'nonexistenttermxyz', limit: 10 });
    expect(noMatch.items).toEqual([]);
  });
});
