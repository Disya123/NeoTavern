/**
 * ST1 message-actions parity routes: swipe (CAS-guarded variant swap),
 * checkpoint/branch snapshots, and regenerate with regenerateMessageId
 * (archive-at-done, fail-fast stale targets).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMessageGenerationMeta } from '@neotavern/contracts';
import { createTestApp, type TestAppHandle } from './helpers.js';

let handle: TestAppHandle;

beforeEach(async () => {
  handle = await createTestApp();
});

afterEach(async () => {
  await handle.app.close();
  handle.database.close();
});

async function makeChat(title = 'ST1 probe'): Promise<{ id: string }> {
  const created = await handle.app.inject({
    method: 'POST',
    url: '/api/v2/chats',
    payload: { title },
  });
  expect(created.statusCode, created.payload).toBe(200);
  return created.json() as { id: string };
}

async function postMessage(
  chatId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const created = await handle.app.inject({
    method: 'POST',
    url: `/api/v2/chats/${chatId}/messages`,
    payload,
  });
  expect(created.statusCode, created.payload).toBe(200);
  return created.json() as Record<string, unknown>;
}

/**
 * Seed stored variants through the atomic regenerate write (the only path
 * that archives content; there is no API for adding variants directly).
 * After `count` replacements the message has `count + 1` variants total,
 * active at position `count`, content `c{count}`.
 */
async function seedVariants(messageId: string, count: number): Promise<void> {
  const messages = handle.database.repos.messages;
  let previous = await messages.getById(messageId);
  for (let i = 1; i <= count; i += 1) {
    const archived = previous?.content ?? '';
    await messages.replaceContentAsVariant(messageId, {
      archiveContent: archived,
      content: `c${i}`,
      meta: {},
    });
    previous = await messages.getById(messageId);
  }
}

describe('swipe (variant CAS, ST1)', () => {
  it('swaps content non-destructively and preserves both texts', async () => {
    const chat = await makeChat();
    const message = await postMessage(chat.id, { role: 'assistant', content: 'c0' });
    const messages = handle.database.repos.messages;

    await seedVariants(message['id'] as string, 2);
    const seeded = await messages.getById(message['id'] as string);
    expect(seeded?.content).toBe('c2');
    expect(seeded?.variantCount).toBe(3);
    expect(seeded?.activeVariantPosition).toBe(2);

    const swiped = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}/swipe`,
      payload: { position: 0 },
    });
    expect(swiped.statusCode, swiped.payload).toBe(200);
    const body = swiped.json() as Record<string, unknown>;
    expect(body['content']).toBe('c0');
    expect(body['variantCount']).toBe(3);
    expect(body['activeVariantPosition']).toBe(0);
    expect(body['revision']).toBe(4);

    // The swap is a permutation: the activated text left its variant slot
    // and the old active text now occupies the old active position.
    const variants = await messages.listVariants(message['id'] as string);
    expect(variants.find((v) => v.position === 1)?.content).toBe('c1');
    expect(variants.find((v) => v.position === 2)?.content).toBe('c2');
    expect(variants.some((v) => v.position === 0)).toBe(false);
  });

  it('rejects a stale expectedRevision with 409 MESSAGE_CONFLICT and currentRevision', async () => {
    const chat = await makeChat();
    const message = await postMessage(chat.id, { role: 'assistant', content: 'c0' });
    await seedVariants(message['id'] as string, 2); // revision now 3

    const stale = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}/swipe`,
      payload: { position: 1, expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const error = stale.json() as { code: string; params: Record<string, unknown> };
    expect(error.code).toBe('MESSAGE_CONFLICT');
    expect(error.params['currentRevision']).toBe(3);
    expect(error.params['expectedRevision']).toBe(1);

    // Nothing was written by the losing swipe.
    const after = await handle.database.repos.messages.getById(message['id'] as string);
    expect(after?.content).toBe('c2');
    expect(after?.revision).toBe(3);
  });

  it('answers MESSAGE_NOT_FOUND for foreign or missing messages', async () => {
    const chat = await makeChat();
    const other = await makeChat('other');
    const message = await postMessage(chat.id, { role: 'assistant', content: 'x' });

    const foreign = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${other.id}/messages/${message['id']}/swipe`,
      payload: { position: 0 },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe('MESSAGE_NOT_FOUND');

    const missing = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/messages/no-such-message/swipe`,
      payload: { position: 0 },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('MESSAGE_NOT_FOUND');
  });
});

describe('legacy variant activation (ST1)', () => {
  it('still works via variantId and honors the optional expectedRevision', async () => {
    const chat = await makeChat();
    const message = await postMessage(chat.id, { role: 'assistant', content: 'c0' });
    const messages = handle.database.repos.messages;
    await seedVariants(message['id'] as string, 2); // active 'c2' at position 2, revision 3

    const variants = await messages.listVariants(message['id'] as string);
    const target = variants.find((v) => v.content === 'c1');
    expect(target).toBeDefined();
    const targetId = target?.id as string;

    // A stale CAS fails before the swap; the variant stays put.
    const stale = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}/variants/${targetId}/activate`,
      payload: { expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const error = stale.json() as { code: string; params: Record<string, unknown> };
    expect(error.code).toBe('MESSAGE_CONFLICT');
    expect(error.params['currentRevision']).toBe(3);

    // Matching CAS activates the variant (non-destructive swap).
    const activated = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}/variants/${targetId}/activate`,
      payload: { expectedRevision: 3 },
    });
    expect(activated.statusCode, activated.payload).toBe(200);
    const body = activated.json() as Record<string, unknown>;
    expect(body['content']).toBe('c1');
    expect(body['activeVariantPosition']).toBe(1);

    // An empty body is still accepted (backward compatibility); the other
    // variant survived the swap.
    const remaining = await messages.listVariants(message['id'] as string);
    const other = remaining.find((v) => v.content === 'c0');
    expect(other).toBeDefined();
    const bare = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}/variants/${other?.id}/activate`,
      payload: {},
    });
    expect(bare.statusCode, bare.payload).toBe(200);
    expect(bare.json()['content']).toBe('c0');
  });
});

describe('snapshots (checkpoint/branch child chats, ST1)', () => {
  it('creates a checkpoint child chat and links the source message', async () => {
    const parent = await makeChat('Parent');
    await postMessage(parent.id, { role: 'user', content: 'hello' });
    const assistant = await postMessage(parent.id, { role: 'assistant', content: 'world' });

    const created = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${parent.id}/snapshots`,
      payload: { messageId: assistant['id'], kind: 'checkpoint' },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const body = created.json() as { chat: Record<string, unknown>; copiedMessages: number };
    expect(body.chat['origin']).toBe('checkpoint');
    expect(body.chat['parentChatId']).toBe(parent.id);
    expect(body.chat['sourceMessageId']).toBe(assistant['id']);
    expect(body.chat['title']).toBe('Parent — checkpoint');
    expect(body.copiedMessages).toBe(2);

    // The child chat is a real, fetchable chat.
    const child = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${body.chat['id'] as string}`,
    });
    expect(child.statusCode, child.payload).toBe(200);

    // The source message carries the checkpoint link (bumped revision).
    const linked = await handle.database.repos.messages.getById(assistant['id'] as string);
    expect(linked?.checkpointChatId).toBe(body.chat['id']);
    expect(linked?.revision).toBe(2);
  });

  it('creates a branch child chat without touching the checkpoint flag', async () => {
    const parent = await makeChat('Parent');
    const assistant = await postMessage(parent.id, { role: 'assistant', content: 'world' });

    const created = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${parent.id}/snapshots`,
      payload: { messageId: assistant['id'], kind: 'branch' },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const body = created.json() as { chat: Record<string, unknown>; copiedMessages: number };
    expect(body.chat['origin']).toBe('branch');
    expect(body.copiedMessages).toBe(1);

    const source = await handle.database.repos.messages.getById(assistant['id'] as string);
    expect(source?.checkpointChatId).toBeNull();
  });

  it('rejects a message that does not belong to the chat', async () => {
    const chat = await makeChat();
    const other = await makeChat('other');
    const foreign = await postMessage(other.id, { role: 'assistant', content: 'elsewhere' });

    const res = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/snapshots`,
      payload: { messageId: foreign['id'], kind: 'checkpoint' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('MESSAGE_NOT_FOUND');
  });

  it('rejects a missing message', async () => {
    const chat = await makeChat();
    const res = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/snapshots`,
      payload: { messageId: 'no-such-message', kind: 'checkpoint' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('MESSAGE_NOT_FOUND');
  });

  it('rejects a message outside the active branch', async () => {
    const chat = await makeChat();
    await postMessage(chat.id, { role: 'user', content: 'main branch' });

    // A second branch with a message of its own (repo-level; the API only
    // writes into the active branch).
    const altBranchId = await handle.database.repos.chats.createBranch(chat.id, 'alt');
    const altMessage = await handle.database.repos.messages.create(chat.id, altBranchId, {
      role: 'assistant',
      content: 'alt branch reply',
    });

    const res = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/snapshots`,
      payload: { messageId: altMessage.id, kind: 'checkpoint' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('CHAT_BRANCH_NOT_FOUND');
  });
});

describe('regenerate (archive-at-done, ST1)', () => {
  it('rejects a stale regenerateMessageId before streaming and archives nothing', async () => {
    const chat = await makeChat();
    await postMessage(chat.id, { role: 'user', content: 'first' });
    const reply1 = await postMessage(chat.id, { role: 'assistant', content: 'reply-1' });
    await postMessage(chat.id, { role: 'user', content: 'second' });
    const reply2 = await postMessage(chat.id, { role: 'assistant', content: 'reply-2' });

    const res = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/generate`,
      payload: { regenerateMessageId: reply1['id'] },
    });
    expect(res.statusCode).toBe(200);
    // The hijacked SSE reply carries the error event, not a stream.
    expect(res.payload).toContain('REGENERATE_TARGET_MOVED');
    expect(res.payload).not.toContain('"type":"delta"');

    // No archive, no rewrite — the stale target is untouched.
    const variants = await handle.database.repos.messages.listVariants(reply1['id'] as string);
    expect(variants).toHaveLength(0);
    const revisions = await handle.database.repos.messages.listContentRevisions(
      reply1['id'] as string,
    );
    expect(revisions.items).toHaveLength(0);
    const stored = await handle.database.repos.messages.getById(reply1['id'] as string);
    expect(stored?.content).toBe('reply-1');
    const last = await handle.database.repos.messages.getById(reply2['id'] as string);
    expect(last?.content).toBe('reply-2');
  });

  it('rewrites the target at done, archives the old content, and suppresses userMessage', async () => {
    const chat = await makeChat();
    await postMessage(chat.id, { role: 'user', content: 'hello' });
    const assistant = await postMessage(chat.id, { role: 'assistant', content: 'old reply' });

    const res = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/generate`,
      payload: {
        regenerateMessageId: assistant['id'],
        userMessage: 'must be ignored on regenerate',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"type":"done"');

    const updated = await handle.database.repos.messages.getById(assistant['id'] as string);
    expect(updated?.content).toBe('You said: "hello". This is the offline echo provider.');
    expect(updated?.revision).toBe(2);
    expect(updated?.variantCount).toBe(2);
    expect(updated?.activeVariantPosition).toBe(1);
    expect(updated?.contentRevisionCount).toBe(0);

    // The atomic regenerate write persists terminal generation metadata too.
    const generation = parseMessageGenerationMeta(updated?.meta['generation']);
    expect(generation).not.toBeNull();
    expect(generation?.generationId.length).toBeGreaterThan(0);
    expect(generation?.model).toBe('echo');
    expect(generation?.providerKind).toBeNull(); // echo fallback: no configured provider
    expect(generation?.durationMs).toBeGreaterThanOrEqual(0);
    expect(generation?.usage).not.toBeNull();
    // The legacy top-level meta.model stays in place.
    expect(updated?.meta['model']).toBe('echo');

    // The old reply is archived as a variant exactly when the new content lands.
    const variants = await handle.database.repos.messages.listVariants(assistant['id'] as string);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.content).toBe('old reply');
    expect(variants[0]?.position).toBe(0);
    const revisions = await handle.database.repos.messages.listContentRevisions(
      assistant['id'] as string,
    );
    expect(revisions.items).toHaveLength(0);

    // The user message sent alongside a regenerate is suppressed.
    const branchId = updated?.branchId;
    const all = await handle.database.repos.messages.recentAscending(
      chat.id,
      branchId as string,
      10,
    );
    expect(all.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('legacy regenerate:true derives the last assistant message', async () => {
    const chat = await makeChat();
    await postMessage(chat.id, { role: 'user', content: 'legacy' });
    const assistant = await postMessage(chat.id, { role: 'assistant', content: 'legacy reply' });

    const res = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/generate`,
      payload: { regenerate: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"type":"done"');

    const updated = await handle.database.repos.messages.getById(assistant['id'] as string);
    expect(updated?.content).toBe('You said: "legacy". This is the offline echo provider.');

    const variants = await handle.database.repos.messages.listVariants(assistant['id'] as string);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.content).toBe('legacy reply');
  });
});
