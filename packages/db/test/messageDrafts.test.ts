import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppDatabase, type AppDatabase } from '../src/index.js';

/**
 * Rev4 stage 3 repository contracts: message CAS (revision bump + conflict)
 * and the draft sweep (crash recovery for server-side streaming drafts).
 */
describe('message CAS repository', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createAppDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  async function seedChatMessage(): Promise<{
    chatId: string;
    branchId: string;
    messageId: string;
  }> {
    const character = await db.repos.characters.create({ name: 'CAS' });
    const chat = await db.repos.chats.create({ characterId: character.id, title: 'CAS chat' });
    const branch = chat.activeBranchId ?? (await db.repos.chats.createBranch(chat.id, 'main'));
    const message = await db.repos.messages.create(chat.id, branch, {
      role: 'user',
      content: 'first',
    });
    return { chatId: chat.id, branchId: branch, messageId: message.id };
  }

  it('bumps revision and records updatedAt on unconditional updates', async () => {
    const { messageId } = await seedChatMessage();
    const first = await db.repos.messages.update(messageId, { content: 'second' });
    expect(first.status).toBe('updated');
    if (first.status !== 'updated') return;
    expect(first.message.revision).toBe(2);
    expect(first.message.updatedAt).not.toBeNull();
  });

  it('rejects a stale expectedRevision and reports the current one', async () => {
    const { messageId } = await seedChatMessage();
    await db.repos.messages.update(messageId, { content: 'winner' });
    const conflict = await db.repos.messages.update(messageId, { content: 'loser' }, 1);
    expect(conflict).toEqual({ status: 'conflict', currentRevision: 2 });
  });

  it('applies a fresh expectedRevision atomically', async () => {
    const { messageId } = await seedChatMessage();
    const applied = await db.repos.messages.update(messageId, { content: 'retried' }, 1);
    expect(applied.status).toBe('updated');
    if (applied.status !== 'updated') return;
    expect(applied.message.content).toBe('retried');
    expect(applied.message.revision).toBe(2);
  });

  it('reports missing for unknown message ids', async () => {
    const result = await db.repos.messages.update('nope', { content: 'x' });
    expect(result).toEqual({ status: 'missing' });
  });

  it('dedupes replayed idempotency keys', async () => {
    const { chatId, branchId } = await seedChatMessage();
    const first = await db.repos.messages.create(chatId, branchId, {
      role: 'plugin',
      content: 'ping',
      idempotencyKey: 'outbox-1',
    });
    const replay = await db.repos.messages.create(chatId, branchId, {
      role: 'plugin',
      content: 'ping',
      idempotencyKey: 'outbox-1',
    });
    expect(replay.id).toBe(first.id);
  });
});

describe('message draft repository', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createAppDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  async function seedDraft(): Promise<{ chatId: string; branchId: string; draftId: string }> {
    const character = await db.repos.characters.create({ name: 'Drafts' });
    const chat = await db.repos.chats.create({ characterId: character.id, title: 'Draft chat' });
    const branch = chat.activeBranchId ?? (await db.repos.chats.createBranch(chat.id, 'main'));
    const draft = await db.repos.messageDrafts.create(chat.id, branch, { role: 'assistant' });
    return { chatId: chat.id, branchId: branch, draftId: draft.id };
  }

  it('commit creates the message once and stays retry-safe', async () => {
    const { draftId } = await seedDraft();
    await db.repos.messageDrafts.update(draftId, { content: 'hello', sequence: 1 });
    const first = await db.repos.messageDrafts.commit(draftId);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.result.alreadyCommitted).toBe(false);

    const replay = await db.repos.messageDrafts.commit(draftId);
    expect(replay.status).toBe('ok');
    if (replay.status !== 'ok') return;
    expect(replay.result.alreadyCommitted).toBe(true);
    expect(replay.result.messageId).toBe(first.result.messageId);
  });

  it('sweep removes stale uncommitted and committed drafts by TTL', async () => {
    const clock = { now: 10_000 };
    db.close();
    db = createAppDatabase(':memory:', {
      clock: () => clock.now,
    });
    const character = await db.repos.characters.create({ name: 'Sweep' });
    const chat = await db.repos.chats.create({ characterId: character.id, title: 'Sweep chat' });
    const branch = chat.activeBranchId ?? (await db.repos.chats.createBranch(chat.id, 'main'));

    // Fresh uncommitted draft: survives.
    const fresh = await db.repos.messageDrafts.create(chat.id, branch, { role: 'assistant' });
    // Old uncommitted draft (crashed writer): swept.
    const stale = await db.repos.messageDrafts.create(chat.id, branch, { role: 'assistant' });
    // Old committed draft: swept after committed TTL.
    const committed = await db.repos.messageDrafts.create(chat.id, branch, { role: 'assistant' });
    await db.repos.messageDrafts.commit(committed.id);

    clock.now = 10_000 + 2 * 60 * 60 * 1000; // 2h later
    const removed = await db.repos.messageDrafts.sweep(
      clock.now,
      60 * 60 * 1000,
      24 * 60 * 60 * 1000,
    );
    // Only the committed draft outlived its 1h TTL; both uncommitted drafts
    // are still younger than the 24h crashed-writer TTL.
    expect(removed).toBe(1);
    expect(await db.repos.messageDrafts.getById(committed.id)).toBeNull();
    expect(await db.repos.messageDrafts.getById(stale.id)).not.toBeNull();
    expect(await db.repos.messageDrafts.getById(fresh.id)).not.toBeNull();

    clock.now = 10_000 + 2 * 24 * 60 * 60 * 1000; // 2 days later
    const removed2 = await db.repos.messageDrafts.sweep(
      clock.now,
      60 * 60 * 1000,
      24 * 60 * 60 * 1000,
    );
    // Both uncommitted drafts crossed the 24h TTL.
    expect(removed2).toBe(2);
    expect(await db.repos.messageDrafts.getById(stale.id)).toBeNull();
    expect(await db.repos.messageDrafts.getById(fresh.id)).toBeNull();
  });
});

describe('message block repository (rev4 stage 4)', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createAppDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  async function seed(): Promise<{
    chatId: string;
    branchId: string;
    messageId: string;
    pluginId: string;
  }> {
    const character = await db.repos.characters.create({ name: 'Blocks' });
    const chat = await db.repos.chats.create({ characterId: character.id, title: 'Blocks chat' });
    const branch = chat.activeBranchId ?? (await db.repos.chats.createBranch(chat.id, 'main'));
    const message = await db.repos.messages.create(chat.id, branch, {
      role: 'assistant',
      content: 'with a block',
    });
    const installed = db.repos.plugins.install({
      id: 'neotavern.test-blocks',
      name: 'Test Blocks',
      version: '1.0.0',
      manifest: {},
      requestedPermissions: [],
    });
    return {
      chatId: chat.id,
      branchId: branch,
      messageId: message.id,
      pluginId: installed.plugin.id,
    };
  }

  it('creates, lists by message, updates state and deletes', async () => {
    const { chatId, messageId, pluginId } = await seed();
    const created = await db.repos.messageBlocks.create(messageId, {
      blockType: 'rev4-counter',
      rendererId: 'blk:rev4-counter',
      pluginId,
      descriptor: { initial: 3 },
    });
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.descriptor).toEqual({ initial: 3 });
    expect(created.serializedState).toBeUndefined();

    const listed = await db.repos.messageBlocks.listByMessage(messageId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const updated = await db.repos.messageBlocks.update(created.id, {
      serializedState: { count: 9 },
    });
    expect(updated?.serializedState).toEqual({ count: 9 });
    expect(updated?.descriptor).toEqual({ initial: 3 });

    // Explicit null clears the stored state.
    const cleared = await db.repos.messageBlocks.update(created.id, { serializedState: null });
    expect(cleared?.serializedState).toBeUndefined();

    const batch = await db.repos.messageBlocks.listByMessages([messageId, 'foreign']);
    expect(batch).toHaveLength(1);
    expect(await db.repos.messageBlocks.delete(created.id)).toBe(true);
    expect(await db.repos.messageBlocks.listByMessage(messageId)).toHaveLength(0);
    expect(chatId.length).toBeGreaterThan(0);
  });

  it('cascades with message deletion and with plugin uninstall', async () => {
    const { messageId, pluginId } = await seed();
    const created = await db.repos.messageBlocks.create(messageId, {
      blockType: 'rev4-counter',
      rendererId: 'blk:rev4-counter',
      pluginId,
      descriptor: {},
    });

    // Deleting the message removes its attachments (FK cascade).
    await db.repos.messages.delete(messageId);
    expect(await db.repos.messageBlocks.getById(created.id)).toBeNull();

    const second = await seed();
    const attached = await db.repos.messageBlocks.create(second.messageId, {
      blockType: 'rev4-counter',
      rendererId: 'blk:rev4-counter',
      pluginId: second.pluginId,
      descriptor: {},
    });
    // Deleting the plugin removes its attachments (FK cascade) — the
    // uninstall cleanup contract.
    const removed = await db.repos.messageBlocks.deleteByPlugin(second.pluginId);
    expect(removed).toBe(1);
    expect(await db.repos.messageBlocks.getById(attached.id)).toBeNull();
  });
});
