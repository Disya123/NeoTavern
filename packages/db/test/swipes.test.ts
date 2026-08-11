import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppDatabase, type AppDatabase } from '../src/index.js';

/**
 * ST1 swipe history (migration 0020): non-destructive variant activation,
 * CAS-guarded swipes, atomic regenerate-archive, and the checkpoint link.
 *
 * Positions form a permutation of 0..variant_count-1 with exactly one hole —
 * the active position. `replaceContentAsVariant` grows the variant set by
 * archiving the current text; `setActiveVariant` swaps a stored variant in.
 */
describe('message swipes (variants)', () => {
  let db: AppDatabase;

  beforeEach(() => {
    let now = 1_000;
    db = createAppDatabase(':memory:', { clock: () => now++ });
  });
  afterEach(() => {
    db.close();
  });

  /** Seed a chat with a single assistant message and return its id. */
  async function seedMessage(content = 'v0'): Promise<string> {
    const chat = await db.repos.chats.create({ title: 'Swipe chat' });
    const message = await db.repos.messages.create(chat.id, chat.activeBranchId as string, {
      role: 'assistant',
      content,
      meta: { source: 'seed' },
    });
    return message.id;
  }

  it('replaceContentAsVariant archives the old text and grows variant_count', async () => {
    const messageId = await seedMessage('original reply');

    const result = await db.repos.messages.replaceContentAsVariant(messageId, {
      archiveContent: 'original reply',
      content: 'rewritten reply',
      meta: { note: 'regenerated' },
    });
    expect(result).toMatchObject({ status: 'updated' });
    if (result.status !== 'updated') return;

    expect(result.message).toMatchObject({
      id: messageId,
      content: 'rewritten reply',
      variantCount: 2,
      activeVariantPosition: 1,
      revision: 2,
      meta: { note: 'regenerated' },
    });
    expect(result.message.updatedAt).not.toBeNull();

    // The archived text sits at the old active position 0.
    const variants = await db.repos.messages.listVariants(messageId);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ position: 0, content: 'original reply' });

    // Regenerating again stacks the previous active text at position 1.
    await db.repos.messages.replaceContentAsVariant(messageId, {
      archiveContent: 'rewritten reply',
      content: 'third take',
      meta: {},
    });
    const again = await db.repos.messages.listVariants(messageId);
    expect(again.map((v) => [v.position, v.content])).toEqual([
      [0, 'original reply'],
      [1, 'rewritten reply'],
    ]);
    const message = await db.repos.messages.getById(messageId);
    expect(message).toMatchObject({
      content: 'third take',
      variantCount: 3,
      activeVariantPosition: 2,
    });

    // Missing message → {status:'missing'}.
    await expect(
      db.repos.messages.replaceContentAsVariant('no-such-message', {
        archiveContent: 'a',
        content: 'b',
        meta: {},
      }),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('setActiveVariant swaps contents non-destructively and stays stable', async () => {
    const messageId = await seedMessage('v0');
    await db.repos.messages.replaceContentAsVariant(messageId, {
      archiveContent: 'v0',
      content: 'v1',
      meta: {},
    });
    await db.repos.messages.replaceContentAsVariant(messageId, {
      archiveContent: 'v1',
      content: 'v2',
      meta: {},
    });
    // Stored variants: position 0 → 'v0', position 1 → 'v1'; active 'v2' @ 2.

    const swap = await db.repos.messages.setActiveVariant(messageId, 0);
    expect(swap).toMatchObject({ status: 'updated' });
    if (swap.status !== 'updated') return;

    // 'v0' is active again; 'v2' is archived at the old active position.
    expect(swap.message).toMatchObject({
      content: 'v0',
      activeVariantPosition: 0,
      variantCount: 3,
    });
    let variants = await db.repos.messages.listVariants(messageId);
    expect(variants.map((v) => [v.position, v.content])).toEqual([
      [1, 'v1'],
      [2, 'v2'],
    ]);

    // Swapping back round-trips without losing either text.
    const roundTrip = await db.repos.messages.setActiveVariant(messageId, 2);
    expect(roundTrip).toMatchObject({ status: 'updated' });
    if (roundTrip.status !== 'updated') return;
    expect(roundTrip.message).toMatchObject({ content: 'v2', activeVariantPosition: 2 });
    variants = await db.repos.messages.listVariants(messageId);
    expect(variants.map((v) => [v.position, v.content])).toEqual([
      [0, 'v0'],
      [1, 'v1'],
    ]);
  });

  it('setActiveVariant enforces the CAS guard and reports missing targets', async () => {
    const messageId = await seedMessage('v0');
    await db.repos.messages.replaceContentAsVariant(messageId, {
      archiveContent: 'v0',
      content: 'v1',
      meta: {},
    });

    // Stale revision → conflict with the current revision.
    const conflict = await db.repos.messages.setActiveVariant(messageId, 0, 999);
    expect(conflict).toEqual({ status: 'conflict', currentRevision: 2 });
    // The message is untouched after a rejected CAS.
    const unchanged = await db.repos.messages.getById(messageId);
    expect(unchanged).toMatchObject({ content: 'v1', revision: 2, activeVariantPosition: 1 });

    // Correct revision applies.
    const ok = await db.repos.messages.setActiveVariant(messageId, 0, 2);
    expect(ok).toMatchObject({ status: 'updated' });

    // Missing variant position (the active position is a hole) → missing.
    await expect(db.repos.messages.setActiveVariant(messageId, 0)).resolves.toEqual({
      status: 'missing',
    });
    // Missing message → missing.
    await expect(db.repos.messages.setActiveVariant('no-such-message', 0)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('legacy activateVariant resolves the id to a position and swaps', async () => {
    const messageId = await seedMessage('v0');
    await db.repos.messages.replaceContentAsVariant(messageId, {
      archiveContent: 'v0',
      content: 'v1',
      meta: {},
    });
    const [variant] = await db.repos.messages.listVariants(messageId);
    expect(variant).toBeDefined();

    const result = await db.repos.messages.activateVariant(
      messageId,
      (variant as { id: string }).id,
    );
    expect(result).toMatchObject({ status: 'updated' });
    if (result.status !== 'updated') return;
    expect(result.message.content).toBe('v0');

    // Unknown variant id → missing.
    await expect(db.repos.messages.activateVariant(messageId, 'no-such-variant')).resolves.toEqual({
      status: 'missing',
    });
  });

  it('linkCheckpoint sets and overwrites the flag; update can unlink it', async () => {
    const messageId = await seedMessage('v0');
    const chat = await db.repos.chats.create({ title: 'Checkpoint child' });

    expect(await db.repos.messages.linkCheckpoint('no-such-message', chat.id)).toBe(false);
    expect(await db.repos.messages.linkCheckpoint(messageId, chat.id)).toBe(true);

    let message = await db.repos.messages.getById(messageId);
    expect(message?.checkpointChatId).toBe(chat.id);
    expect(message?.revision).toBe(2);

    // Repointing overwrites the link.
    const other = await db.repos.chats.create({ title: 'Replacement child' });
    expect(await db.repos.messages.linkCheckpoint(messageId, other.id)).toBe(true);
    message = await db.repos.messages.getById(messageId);
    expect(message?.checkpointChatId).toBe(other.id);

    // The generic update patch can unlink the checkpoint flag.
    const updated = await db.repos.messages.update(messageId, { checkpointChatId: null });
    expect(updated).toMatchObject({ status: 'updated' });
    if (updated.status !== 'updated') return;
    expect(updated.message.checkpointChatId).toBeNull();
  });
});
