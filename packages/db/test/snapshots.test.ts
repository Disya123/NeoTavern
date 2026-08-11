import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppDatabase, type AppDatabase } from '../src/index.js';
import type { Message } from '@neotavern/contracts';

/**
 * ST1 checkpoint/branch snapshots: the active-branch prefix of a chat is
 * copied into a fresh child chat — batched by keyset so a huge conversation
 * is never loaded at once, with old→new id remapping keeping the parentId
 * chain intact, meta copied as RAW TEXT, and variants + plugin block
 * attachments riding along.
 */
describe('snapshot repository', () => {
  let db: AppDatabase;

  beforeEach(() => {
    let now = 10_000;
    db = createAppDatabase(':memory:', { clock: () => now++ });
  });
  afterEach(() => {
    db.close();
  });

  async function seedParent(): Promise<{ chatId: string; branchId: string }> {
    const character = await db.repos.characters.create({ name: 'Snapshot character' });
    const chat = await db.repos.chats.create({
      characterId: character.id,
      title: 'Parent chat',
    });
    const branchId = chat.activeBranchId as string;
    // Background + summary are inherited by child chats.
    await db.repos.chats.update(chat.id, { backgroundId: 'wallpaper.png', summary: 'rolling' });
    return { chatId: chat.id, branchId };
  }

  /** Install a plugin so block attachments can be created (FK to plugin_registry). */
  function installPlugin(target: AppDatabase, id: string): void {
    target.repos.plugins.install({
      id,
      name: `Plugin ${id}`,
      version: '1.0.0',
      manifest: { id, name: `Plugin ${id}`, version: '1.0.0', apiVersion: 2 },
      requestedPermissions: [],
    });
  }

  it('copies the prefix up to the target with remapped ids, meta verbatim, variants and blocks', async () => {
    // Local database whose clock jumps per call, so the raw-SQL message can
    // be timestamped strictly between two repo-created messages.
    let now = 10_000;
    const local = createAppDatabase(':memory:', { clock: () => (now += 10_000) });
    try {
      const character = await local.repos.characters.create({ name: 'Snapshot character' });
      const parent = await local.repos.chats.create({
        characterId: character.id,
        title: 'Parent chat',
      });
      const chatId = parent.id;
      const branchId = parent.activeBranchId as string;
      await local.repos.chats.update(chatId, { backgroundId: 'wallpaper.png', summary: 'rolling' });
      const RAW_META = '{"unknownField":{"nested":[1,2,{"x":true}]},"spacing": "kept as-is"}';

      const m1 = await local.repos.messages.create(chatId, branchId, {
        role: 'user',
        content: 'hello',
        meta: { tools: ['a', 'b'] },
      });
      // Direct insert with a distinctive raw meta blob — the snapshot must
      // copy the TEXT verbatim, not a re-serialization.
      local.sqlite
        .prepare(
          `INSERT INTO messages (
             id, chat_id, branch_id, parent_id, role, content, name, meta,
             created_at, revision, variant_count, active_variant_position
           ) VALUES (?, ?, ?, ?, 'user', 'raw meta message', NULL, ?, ?, 1, 1, 0)`,
        )
        .run('raw-1', chatId, branchId, m1.id, RAW_META, m1.createdAt + 1);
      const m2 = await local.repos.messages.create(chatId, branchId, {
        role: 'assistant',
        content: 'first reply',
        parentId: 'raw-1',
      });
      // Give m2 a stored variant: 'first reply' is archived, 'regenerated reply' active.
      const regenerated = await local.repos.messages.replaceContentAsVariant(m2.id, {
        archiveContent: 'first reply',
        content: 'regenerated reply',
        meta: { regenerated: true },
      });
      expect(regenerated.status).toBe('updated');
      installPlugin(local, 'test.blocker');
      const sourceBlock = await local.repos.messageBlocks.create(m2.id, {
        pluginId: 'test.blocker',
        blockType: 'action',
        rendererId: 'test.blocker.renderer',
        descriptor: { label: 'Do it' },
      });
      // Serialized renderer state is stored via update; the snapshot must
      // copy it verbatim.
      await local.repos.messageBlocks.update(sourceBlock.id, {
        serializedState: { pressed: true },
      });
      // A message AFTER the target must not be copied.
      const m3 = await local.repos.messages.create(chatId, branchId, {
        role: 'assistant',
        content: 'after target',
        parentId: m2.id,
      });

      const result = await local.repos.snapshots.createSnapshot({
        parentChatId: chatId,
        sourceMessageId: m2.id,
        kind: 'checkpoint',
      });
      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.copiedMessages).toBe(3);

      const child = result.chat;
      expect(child.id).not.toBe(chatId);
      expect(child).toMatchObject({
        parentChatId: chatId,
        origin: 'checkpoint',
        sourceMessageId: m2.id,
        title: 'Parent chat — checkpoint',
        messageCount: 3,
        characterId: character.id,
        personaId: null,
        backgroundId: 'wallpaper.png',
        summary: 'rolling',
        deletedAt: null,
      });
      expect(child.activeBranchId).toBeTruthy();
      const [branch] = local.sqlite
        .prepare('SELECT name FROM chat_branches WHERE chat_id = ?')
        .all(child.id) as Array<{ name: string }>;
      expect(branch?.name).toBe('main');

      // The copied prefix keeps order and the parentId chain (remapped), and
      // never includes the post-target message.
      const page = await local.repos.messages.list(child.id, { order: 'asc', limit: 10 });
      expect(page.items).toHaveLength(3);
      const [c1, cRaw, c2] = page.items;
      expect(c1?.parentId).toBeNull();
      expect(cRaw?.parentId).toBe(c1?.id);
      expect(c2?.parentId).toBe(cRaw?.id);
      expect(page.items.map((m) => m.id)).not.toContain(m3.id);
      expect(page.items.map((m) => m.content)).toEqual([
        'hello',
        'raw meta message',
        'regenerated reply',
      ]);

      // Fresh copies: revision 1, updatedAt null, no checkpoint link, ids remapped.
      for (const copy of page.items) {
        expect(copy.revision).toBe(1);
        expect(copy.updatedAt).toBeNull();
        expect(copy.checkpointChatId).toBeNull();
        expect([m1.id, 'raw-1', m2.id]).not.toContain(copy.id);
      }
      // The raw meta blob survived byte-for-byte.
      const rawCopy = local.sqlite
        .prepare('SELECT meta FROM messages WHERE id = ?')
        .get(cRaw?.id) as { meta: string };
      expect(rawCopy.meta).toBe(RAW_META);
      expect(cRaw?.meta).toEqual(JSON.parse(RAW_META));
      expect(c2?.meta).toEqual({ regenerated: true });

      // Variants and their positions are copied with the new message id.
      expect(c2).toMatchObject({ variantCount: 2, activeVariantPosition: 1 });
      const variants = await local.repos.messages.listVariants(c2?.id as string);
      expect(variants.map((v) => [v.position, v.content])).toEqual([[0, 'first reply']]);

      // Block attachments copied verbatim (serialized state included).
      const blocks = await local.repos.messageBlocks.listByMessage(c2?.id as string);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        pluginId: 'test.blocker',
        blockType: 'action',
        rendererId: 'test.blocker.renderer',
        descriptor: { label: 'Do it' },
        serializedState: { pressed: true },
      });
      // The parent's own block attachment is untouched.
      expect(await local.repos.messageBlocks.listByMessage(m2.id)).toHaveLength(1);

      // A message with no variants keeps variantCount 1.
      expect(c1).toMatchObject({ variantCount: 1, activeVariantPosition: 0 });
    } finally {
      local.close();
    }
  });

  it('honors an explicit title and the branch origin', async () => {
    const { chatId, branchId } = await seedParent();
    const m1 = await db.repos.messages.create(chatId, branchId, { role: 'user', content: 'hi' });

    const result = await db.repos.snapshots.createSnapshot({
      parentChatId: chatId,
      sourceMessageId: m1.id,
      kind: 'branch',
      title: 'Working copy',
    });
    expect(result).not.toBeNull();
    expect(result?.chat).toMatchObject({
      title: 'Working copy',
      origin: 'branch',
      parentChatId: chatId,
      sourceMessageId: m1.id,
      messageCount: 1,
    });
    expect(result?.copiedMessages).toBe(1);
  });

  it('returns null for a missing parent, missing message, other chat, or other branch', async () => {
    const { chatId, branchId } = await seedParent();
    const message = await db.repos.messages.create(chatId, branchId, {
      role: 'user',
      content: 'x',
    });

    await expect(
      db.repos.snapshots.createSnapshot({
        parentChatId: 'no-such-chat',
        sourceMessageId: message.id,
        kind: 'checkpoint',
      }),
    ).resolves.toBeNull();
    await expect(
      db.repos.snapshots.createSnapshot({
        parentChatId: chatId,
        sourceMessageId: 'no-such-message',
        kind: 'checkpoint',
      }),
    ).resolves.toBeNull();

    // The message exists but belongs to a different chat.
    const other = await db.repos.chats.create({ title: 'Other' });
    const foreign = await db.repos.messages.create(other.id, other.activeBranchId as string, {
      role: 'user',
      content: 'foreign',
    });
    await expect(
      db.repos.snapshots.createSnapshot({
        parentChatId: chatId,
        sourceMessageId: foreign.id,
        kind: 'checkpoint',
      }),
    ).resolves.toBeNull();

    // The message lives in a non-active branch of the parent chat.
    const sideBranch = await db.repos.chats.createBranch(chatId, 'side');
    const side = await db.repos.messages.create(chatId, sideBranch, {
      role: 'user',
      content: 'side',
    });
    await expect(
      db.repos.snapshots.createSnapshot({
        parentChatId: chatId,
        sourceMessageId: side.id,
        kind: 'checkpoint',
      }),
    ).resolves.toBeNull();
  });

  it('copies more than one batch without loading the whole chat', async () => {
    const { chatId, branchId } = await seedParent();
    // 1200 chained messages → 3 keyset batches of 500.
    let previous: string | null = null;
    let lastId = '';
    for (let i = 0; i < 1200; i += 1) {
      const message = await db.repos.messages.create(chatId, branchId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
        ...(previous ? { parentId: previous } : {}),
      });
      previous = message.id;
      lastId = message.id;
    }

    const result = await db.repos.snapshots.createSnapshot({
      parentChatId: chatId,
      sourceMessageId: lastId,
      kind: 'checkpoint',
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.copiedMessages).toBe(1200);
    expect(result.chat.messageCount).toBe(1200);

    // All copies present, in order, with the chain intact at both ends.
    const page = await db.repos.messages.list(result.chat.id, { order: 'asc', limit: 2000 });
    expect(page.items).toHaveLength(1200);
    expect(page.items[0]?.parentId).toBeNull();
    for (let i = 1; i < page.items.length; i += 1) {
      expect(page.items[i]?.parentId).toBe(page.items[i - 1]?.id);
    }
    const lastCopy: Message | undefined = page.items[page.items.length - 1];
    expect(lastCopy?.content).toBe('message 1199');
    // Old ids were remapped, not reused.
    expect(page.items.map((m) => m.id)).not.toContain(lastId);
  });
});
