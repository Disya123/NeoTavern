/**
 * Rev4 stage 3 chat contracts: message CAS (revision), idempotent creates
 * (outbox) and the server-side draft/commit lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from './helpers.js';

let handle: TestAppHandle;

beforeEach(async () => {
  handle = await createTestApp();
});

afterEach(async () => {
  await handle.app.close();
  handle.database.close();
});

async function makeChat(title = 'CAS probe'): Promise<{ id: string }> {
  const created = await handle.app.inject({
    method: 'POST',
    url: '/api/v2/chats',
    payload: { title },
  });
  expect(created.statusCode, created.payload).toBe(200);
  return created.json();
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

describe('message CAS (rev4 stage 3)', () => {
  it('starts at revision 1 and bumps on every update', async () => {
    const chat = await makeChat();
    const message = await postMessage(chat.id, { role: 'user', content: 'first' });
    expect(message['revision']).toBe(1);
    expect(message['updatedAt']).toBeNull();

    const updated = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}`,
      payload: { content: 'second' },
    });
    expect(updated.statusCode, updated.payload).toBe(200);
    const body = updated.json() as Record<string, unknown>;
    expect(body['revision']).toBe(2);
    expect(body['content']).toBe('second');
    expect(body['updatedAt']).not.toBeNull();
  });

  it('rejects a stale expectedRevision with MESSAGE_CONFLICT and the current revision', async () => {
    const chat = await makeChat();
    const message = await postMessage(chat.id, { role: 'user', content: 'first' });
    // Someone else wins the race: revision 1 → 2.
    const winner = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}`,
      payload: { content: 'winner' },
    });
    expect(winner.statusCode).toBe(200);

    const loser = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}`,
      payload: { content: 'loser', expectedRevision: 1 },
    });
    expect(loser.statusCode).toBe(409);
    const error = loser.json() as { code: string; params: Record<string, unknown> };
    expect(error.code).toBe('MESSAGE_CONFLICT');
    expect(error.params['currentRevision']).toBe(2);
    expect(error.params['expectedRevision']).toBe(1);

    // The winner's content is untouched.
    const after = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}`,
    });
    // GET single message is not a route; verify through the list instead.
    expect(after.statusCode).toBe(404);
    const list = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chat.id}/messages?limit=10`,
    });
    const page = list.json() as { items: Array<{ id: string; content: string }> };
    const stored = page.items.find((item) => item.id === message['id']);
    expect(stored?.content).toBe('winner');
  });

  it('retrying with the fresh revision succeeds', async () => {
    const chat = await makeChat();
    const message = await postMessage(chat.id, { role: 'user', content: 'first' });
    await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}`,
      payload: { content: 'winner' },
    });
    const retry = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/messages/${message['id']}`,
      payload: { content: 'retried', expectedRevision: 2 },
    });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as Record<string, unknown>)['revision']).toBe(3);
  });
});

describe('idempotent creates (outbox, rev4 stage 3)', () => {
  it('returns the original message for a replayed idempotencyKey', async () => {
    const chat = await makeChat();
    const first = await postMessage(chat.id, {
      role: 'plugin',
      content: 'ping',
      idempotencyKey: 'retry-1',
    });
    const replay = await postMessage(chat.id, {
      role: 'plugin',
      content: 'ping',
      idempotencyKey: 'retry-1',
    });
    expect(replay['id']).toBe(first['id']);

    // Exactly one message exists.
    const list = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chat.id}/messages?limit=10`,
    });
    const page = list.json() as { items: Array<{ id: string }> };
    expect(page.items.filter((item) => item.id === first['id'])).toHaveLength(1);
  });

  it('treats different keys as different messages', async () => {
    const chat = await makeChat();
    const first = await postMessage(chat.id, {
      role: 'plugin',
      content: 'a',
      idempotencyKey: 'key-a',
    });
    const second = await postMessage(chat.id, {
      role: 'plugin',
      content: 'b',
      idempotencyKey: 'key-b',
    });
    expect(second['id']).not.toBe(first['id']);
  });
});

describe('draft lifecycle (rev4 stage 3)', () => {
  it('streams into a draft and commits it as a real message once', async () => {
    const chat = await makeChat();
    const created = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/drafts`,
      payload: { role: 'assistant' },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const draft = created.json() as {
      id: string;
      content: string;
      sequence: number;
      revision: number;
    };
    expect(draft.content).toBe('');
    expect(draft.sequence).toBe(0);

    const patched = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}`,
      payload: { content: 'Hello, streaming world', sequence: 1 },
    });
    expect(patched.statusCode, patched.payload).toBe(200);
    const patchedBody = patched.json() as { content: string; revision: number };
    expect(patchedBody.content).toBe('Hello, streaming world');
    expect(patchedBody.revision).toBe(2);

    // The draft is NOT a message yet.
    const before = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chat.id}/messages?limit=10`,
    });
    expect((before.json() as { items: unknown[] }).items).toHaveLength(0);

    const committed = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}/commit`,
      payload: {},
    });
    expect(committed.statusCode, committed.payload).toBe(200);
    const commitBody = committed.json() as { messageId: string; alreadyCommitted: boolean };
    expect(commitBody.alreadyCommitted).toBe(false);

    const after = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chat.id}/messages?limit=10`,
    });
    const page = after.json() as { items: Array<{ id: string; role: string; content: string }> };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(commitBody.messageId);
    expect(page.items[0]?.role).toBe('assistant');
    expect(page.items[0]?.content).toBe('Hello, streaming world');
  });

  it('commit is retry-safe: a replay returns the same messageId', async () => {
    const chat = await makeChat();
    const created = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/drafts`,
      payload: { role: 'assistant' },
    });
    const draft = created.json() as { id: string };
    await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}`,
      payload: { content: 'once', sequence: 1 },
    });
    const first = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}/commit`,
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const replay = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}/commit`,
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = replay.json() as { messageId: string; alreadyCommitted: boolean };
    expect(replayBody.messageId).toBe((first.json() as { messageId: string }).messageId);
    expect(replayBody.alreadyCommitted).toBe(true);

    const after = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chat.id}/messages?limit=10`,
    });
    expect((after.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it('a stale sequence is an idempotent no-op', async () => {
    const chat = await makeChat();
    const created = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/drafts`,
      payload: { role: 'assistant' },
    });
    const draft = created.json() as { id: string };
    await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}`,
      payload: { content: 'newer', sequence: 2 },
    });
    const replay = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}`,
      payload: { content: 'older', sequence: 1 },
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { content: string }).content).toBe('newer');
  });

  it('abort discards the draft without creating a message', async () => {
    const chat = await makeChat();
    const created = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.id}/drafts`,
      payload: { role: 'assistant' },
    });
    const draft = created.json() as { id: string };
    await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}`,
      payload: { content: 'half-written', sequence: 1 },
    });
    const aborted = await handle.app.inject({
      method: 'DELETE',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}`,
    });
    expect(aborted.statusCode).toBe(200);

    const missing = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chat.id}/drafts/${draft.id}`,
      payload: { content: 'late', sequence: 2 },
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe('MESSAGE_DRAFT_NOT_FOUND');

    const after = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chat.id}/messages?limit=10`,
    });
    expect((after.json() as { items: unknown[] }).items).toHaveLength(0);
  });
});
