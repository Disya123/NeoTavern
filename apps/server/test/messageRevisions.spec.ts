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

const messagePath = (chatId: string, messageId: string): string =>
  '/api/v2/chats/' + chatId + '/messages/' + messageId;
const revisionsPath = (chatId: string, messageId: string): string =>
  messagePath(chatId, messageId) + '/revisions';

async function makeChat(): Promise<string> {
  const response = await handle.app.inject({
    method: 'POST',
    url: '/api/v2/chats',
    payload: { title: 'Revision API chat' },
  });
  expect(response.statusCode, response.payload).toBe(200);
  return (response.json() as { id: string }).id;
}

async function makeMessage(
  chatId: string,
  content = 'original',
  meta: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await handle.app.inject({
    method: 'POST',
    url: '/api/v2/chats/' + chatId + '/messages',
    payload: { role: 'assistant', content, meta },
  });
  expect(response.statusCode, response.payload).toBe(200);
  return response.json() as Record<string, unknown>;
}

describe('message content revision API', () => {
  it('archives content PATCHes, ignores metadata/no-op PATCHes, and paginates newest first', async () => {
    const chatId = await makeChat();
    let message = await makeMessage(chatId);
    const id = message['id'] as string;

    const first = await handle.app.inject({
      method: 'PATCH',
      url: messagePath(chatId, id),
      payload: { content: 'first edit', expectedRevision: 1 },
    });
    expect(first.statusCode, first.payload).toBe(200);
    message = first.json() as Record<string, unknown>;
    expect(message).toMatchObject({ revision: 2, contentRevisionCount: 1 });

    const metadata = await handle.app.inject({
      method: 'PATCH',
      url: messagePath(chatId, id),
      payload: { meta: { tagged: true }, expectedRevision: 2 },
    });
    expect(metadata.statusCode, metadata.payload).toBe(200);
    message = metadata.json() as Record<string, unknown>;
    expect(message).toMatchObject({ revision: 3, contentRevisionCount: 1 });

    const noOp = await handle.app.inject({
      method: 'PATCH',
      url: messagePath(chatId, id),
      payload: { content: 'first edit', expectedRevision: 3 },
    });
    expect(noOp.statusCode, noOp.payload).toBe(200);
    message = noOp.json() as Record<string, unknown>;
    expect(message).toMatchObject({ revision: 4, contentRevisionCount: 1 });

    const second = await handle.app.inject({
      method: 'PATCH',
      url: messagePath(chatId, id),
      payload: { content: 'second edit', expectedRevision: 4 },
    });
    expect(second.statusCode, second.payload).toBe(200);
    message = second.json() as Record<string, unknown>;
    expect(message).toMatchObject({ revision: 5, contentRevisionCount: 2 });

    const firstPage = await handle.app.inject({
      method: 'GET',
      url: revisionsPath(chatId, id) + '?limit=1',
    });
    expect(firstPage.statusCode, firstPage.payload).toBe(200);
    const page = firstPage.json() as {
      items: Array<{ id: string; position: number; content: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page.items).toMatchObject([{ position: 1, content: 'first edit' }]);
    expect(page.hasMore).toBe(true);

    const nextPage = await handle.app.inject({
      method: 'GET',
      url:
        revisionsPath(chatId, id) +
        '?limit=1&cursor=' +
        encodeURIComponent(page.nextCursor as string),
    });
    expect(nextPage.statusCode, nextPage.payload).toBe(200);
    expect(nextPage.json()).toMatchObject({
      items: [{ position: 0, content: 'original' }],
      hasMore: false,
    });
  });

  it('restores non-destructively and rejects stale expectedRevision without extra history', async () => {
    const chatId = await makeChat();
    let message = await makeMessage(chatId);
    const id = message['id'] as string;
    for (const content of ['first edit', 'second edit']) {
      const patched = await handle.app.inject({
        method: 'PATCH',
        url: messagePath(chatId, id),
        payload: { content, expectedRevision: message['revision'] },
      });
      expect(patched.statusCode, patched.payload).toBe(200);
      message = patched.json() as Record<string, unknown>;
    }

    const list = await handle.app.inject({ method: 'GET', url: revisionsPath(chatId, id) });
    const revisions = (list.json() as { items: Array<{ id: string; content: string }> }).items;
    const original = revisions.find((item) => item.content === 'original');
    expect(original).toBeDefined();
    const restoreUrl = revisionsPath(chatId, id) + '/' + original?.id + '/restore';

    const stale = await handle.app.inject({
      method: 'POST',
      url: restoreUrl,
      payload: { expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'MESSAGE_CONFLICT',
      params: { expectedRevision: 1, currentRevision: 3 },
    });
    expect((await handle.database.repos.messages.listContentRevisions(id)).items).toHaveLength(2);

    const restored = await handle.app.inject({
      method: 'POST',
      url: restoreUrl,
      payload: { expectedRevision: 3 },
    });
    expect(restored.statusCode, restored.payload).toBe(200);
    expect(restored.json()).toMatchObject({
      content: 'original',
      revision: 4,
      contentRevisionCount: 3,
    });

    const after = await handle.app.inject({ method: 'GET', url: revisionsPath(chatId, id) });
    expect(after.json()).toMatchObject({
      items: [
        { position: 2, content: 'second edit' },
        { position: 1, content: 'first edit' },
        { position: 0, content: 'original' },
      ],
    });
  });

  it('keeps greeting swipes out of edit history and exports both histories as v2', async () => {
    const chatId = await makeChat();
    const message = await makeMessage(chatId, 'hello', {
      greeting: true,
      swipes: ['hello', 'alternate'],
      swipeId: 0,
    });
    const id = message['id'] as string;

    const swiped = await handle.app.inject({
      method: 'PATCH',
      url: messagePath(chatId, id),
      payload: {
        content: 'alternate',
        meta: { greeting: true, swipes: ['hello', 'alternate'], swipeId: 1 },
        expectedRevision: 1,
      },
    });
    expect(swiped.statusCode, swiped.payload).toBe(200);
    expect(swiped.json()).toMatchObject({ contentRevisionCount: 0 });

    await handle.database.repos.messages.replaceContentAsVariant(id, {
      archiveContent: 'alternate',
      content: 'generated',
      meta: {},
    });
    await handle.database.repos.messages.update(id, { content: 'manual edit' });

    const exported = await handle.app.inject({
      method: 'GET',
      url: '/api/v2/chats/' + chatId + '/export',
    });
    expect(exported.statusCode, exported.payload).toBe(200);
    expect(exported.json()).toMatchObject({
      kind: 'neotavern-chat-export',
      version: 2,
      messageVariants: [{ messageId: id, content: 'alternate' }],
      messageRevisions: [{ messageId: id, content: 'generated' }],
    });
  });
});
