import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppDatabase, type AppDatabase } from '../src/index.js';

describe('message manual content revisions', () => {
  let db: AppDatabase;

  beforeEach(() => {
    let now = 1_000;
    db = createAppDatabase(':memory:', { clock: () => now++ });
  });

  afterEach(() => {
    db.close();
  });

  async function seed(content = 'v0') {
    const chat = await db.repos.chats.create({ title: 'Revision chat' });
    const message = await db.repos.messages.create(chat.id, chat.activeBranchId as string, {
      role: 'assistant',
      content,
    });
    return { chat, message };
  }

  it('archives only real content changes and paginates newest first', async () => {
    const { message } = await seed('original');

    const first = await db.repos.messages.update(message.id, { content: 'first edit' }, 1);
    expect(first).toMatchObject({
      status: 'updated',
      message: { content: 'first edit', revision: 2, contentRevisionCount: 1 },
    });

    const metadata = await db.repos.messages.update(message.id, { meta: { tagged: true } }, 2);
    expect(metadata).toMatchObject({
      status: 'updated',
      message: { revision: 3, contentRevisionCount: 1 },
    });

    const noOp = await db.repos.messages.update(message.id, { content: 'first edit' }, 3);
    expect(noOp).toMatchObject({
      status: 'updated',
      message: { revision: 4, contentRevisionCount: 1 },
    });

    const second = await db.repos.messages.update(message.id, { content: 'second edit' }, 4);
    expect(second).toMatchObject({
      status: 'updated',
      message: { content: 'second edit', revision: 5, contentRevisionCount: 2 },
    });

    const firstPage = await db.repos.messages.listContentRevisions(message.id, { limit: 1 });
    expect(firstPage.items.map((item) => [item.position, item.content])).toEqual([
      [1, 'first edit'],
    ]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await db.repos.messages.listContentRevisions(message.id, {
      limit: 1,
      cursor: firstPage.nextCursor as string,
    });
    expect(secondPage.items.map((item) => [item.position, item.content])).toEqual([
      [0, 'original'],
    ]);
    expect(secondPage.hasMore).toBe(false);
  });

  it('restores non-destructively and rejects stale CAS without adding a revision', async () => {
    const { message } = await seed('original');
    const first = await db.repos.messages.update(message.id, { content: 'first edit' }, 1);
    expect(first.status).toBe('updated');
    const second = await db.repos.messages.update(message.id, { content: 'second edit' }, 2);
    expect(second.status).toBe('updated');

    let revisions = await db.repos.messages.listContentRevisions(message.id);
    const original = revisions.items.find((item) => item.content === 'original');
    expect(original).toBeDefined();

    const conflict = await db.repos.messages.restoreContentRevision(
      message.id,
      original?.id as string,
      1,
    );
    expect(conflict).toEqual({ status: 'conflict', currentRevision: 3 });
    expect((await db.repos.messages.listContentRevisions(message.id)).items).toHaveLength(2);

    const restored = await db.repos.messages.restoreContentRevision(
      message.id,
      original?.id as string,
      3,
    );
    expect(restored).toMatchObject({
      status: 'updated',
      message: { content: 'original', revision: 4, contentRevisionCount: 3 },
    });

    revisions = await db.repos.messages.listContentRevisions(message.id);
    expect(revisions.items.map((item) => [item.position, item.content])).toEqual([
      [2, 'second edit'],
      [1, 'first edit'],
      [0, 'original'],
    ]);

    const missing = await db.repos.messages.restoreContentRevision(
      message.id,
      'no-such-revision',
      4,
    );
    expect(missing).toEqual({ status: 'revision-missing' });
    expect((await db.repos.messages.listContentRevisions(message.id)).items).toHaveLength(3);
  });

  it('keeps swipe/regenerate variants separate and cascades revisions on delete', async () => {
    const { message } = await seed('original');
    await db.repos.messages.replaceContentAsVariant(message.id, {
      archiveContent: 'original',
      content: 'regenerated',
      meta: {},
    });
    let stored = await db.repos.messages.getById(message.id);
    expect(stored).toMatchObject({ contentRevisionCount: 0, variantCount: 2 });

    await db.repos.messages.setActiveVariant(message.id, 0, stored?.revision);
    stored = await db.repos.messages.getById(message.id);
    expect(stored).toMatchObject({ content: 'original', contentRevisionCount: 0 });
    expect((await db.repos.messages.listContentRevisions(message.id)).items).toHaveLength(0);

    await db.repos.messages.update(message.id, { content: 'manual edit' }, stored?.revision);
    expect((await db.repos.messages.listContentRevisions(message.id)).items).toHaveLength(1);
    await db.repos.messages.delete(message.id);
    expect((await db.repos.messages.listContentRevisions(message.id)).items).toHaveLength(0);
  });

  it('copies revisions and swipe variants into checkpoint/branch snapshots', async () => {
    const { chat, message } = await seed('original');
    await db.repos.messages.update(message.id, { content: 'manual edit' }, 1);
    await db.repos.messages.replaceContentAsVariant(message.id, {
      archiveContent: 'manual edit',
      content: 'regenerated',
      meta: {},
    });

    const snapshot = await db.repos.snapshots.createSnapshot({
      parentChatId: chat.id,
      sourceMessageId: message.id,
      kind: 'branch',
    });
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    const copiedPage = await db.repos.messages.list(snapshot.chat.id, { order: 'asc' });
    const copied = copiedPage.items[0];
    expect(copied).toMatchObject({ contentRevisionCount: 1, variantCount: 2 });
    expect(
      (await db.repos.messages.listContentRevisions(copied?.id as string)).items,
    ).toMatchObject([{ position: 0, content: 'original' }]);
    expect(await db.repos.messages.listVariants(copied?.id as string)).toMatchObject([
      { position: 0, content: 'manual edit' },
    ]);
  });
});
