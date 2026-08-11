/**
 * Rev4 stage 4 block attachment routes: persistent plugin→message bindings.
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

async function makeChatAndMessage(): Promise<{
  chatId: string;
  otherChatId: string;
  messageId: string;
}> {
  // The FK on plugin_id requires the owning plugin row (uninstall cascade).
  handle.database.repos.plugins.install({
    id: 'neotavern.rev4-blocks',
    name: 'Rev4 Blocks Example',
    version: '1.0.0',
    manifest: {},
    requestedPermissions: [],
  });
  const chat = await handle.app.inject({
    method: 'POST',
    url: '/api/v2/chats',
    payload: { title: 'Blocks' },
  });
  expect(chat.statusCode, chat.payload).toBe(200);
  const other = await handle.app.inject({
    method: 'POST',
    url: '/api/v2/chats',
    payload: { title: 'Other' },
  });
  const message = await handle.app.inject({
    method: 'POST',
    url: `/api/v2/chats/${(chat.json() as { id: string }).id}/messages`,
    payload: { role: 'user', content: 'hi' },
  });
  expect(message.statusCode, message.payload).toBe(200);
  return {
    chatId: (chat.json() as { id: string }).id,
    otherChatId: (other.json() as { id: string }).id,
    messageId: (message.json() as { id: string }).id,
  };
}

describe('message block attachments (rev4 stage 4)', () => {
  it('attaches, batch-reads, persists state and detaches', async () => {
    const { chatId, messageId } = await makeChatAndMessage();

    const attached = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/messages/${messageId}/blocks`,
      payload: {
        blockType: 'rev4-counter',
        rendererId: 'blk:rev4-counter',
        pluginId: 'neotavern.rev4-blocks',
        descriptor: { initial: 3 },
      },
    });
    expect(attached.statusCode, attached.payload).toBe(200);
    const block = attached.json() as {
      id: string;
      messageId: string;
      descriptor: { initial: number };
    };
    expect(block.messageId).toBe(messageId);
    expect(block.descriptor).toEqual({ initial: 3 });

    // Batch read finds it.
    const listed = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chatId}/blocks?messageIds=${messageId}`,
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json() as { items: Array<{ id: string }> };
    expect(page.items.map((item) => item.id)).toEqual([block.id]);

    // State persistence (freeze → PATCH).
    const patched = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v2/blocks/${block.id}`,
      payload: { serializedState: { count: 9 } },
    });
    expect(patched.statusCode, patched.payload).toBe(200);
    expect((patched.json() as { serializedState: { count: number } }).serializedState).toEqual({
      count: 9,
    });

    // Detach.
    const deleted = await handle.app.inject({
      method: 'DELETE',
      url: `/api/v2/blocks/${block.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    const after = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chatId}/blocks?messageIds=${messageId}`,
    });
    expect((after.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('rejects attachments for messages of another chat', async () => {
    const { chatId, otherChatId, messageId } = await makeChatAndMessage();
    const foreign = await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${otherChatId}/messages/${messageId}/blocks`,
      payload: {
        blockType: 'rev4-counter',
        rendererId: 'blk:rev4-counter',
        pluginId: 'neotavern.rev4-blocks',
        descriptor: {},
      },
    });
    expect(foreign.statusCode).toBe(404);
    expect((foreign.json() as { code: string }).code).toBe('MESSAGE_NOT_FOUND');
    expect(chatId.length).toBeGreaterThan(0);
  });

  it('batch read filters foreign messages and unknown chats 404', async () => {
    const { chatId, otherChatId, messageId } = await makeChatAndMessage();
    // Attach to chat A's message, then ask chat B for it: no leakage.
    await handle.app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/messages/${messageId}/blocks`,
      payload: {
        blockType: 'rev4-counter',
        rendererId: 'blk:rev4-counter',
        pluginId: 'neotavern.rev4-blocks',
        descriptor: {},
      },
    });
    const leaked = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/${otherChatId}/blocks?messageIds=${messageId}`,
    });
    expect((leaked.json() as { items: unknown[] }).items).toHaveLength(0);

    const missing = await handle.app.inject({
      method: 'GET',
      url: `/api/v2/chats/no-such-chat/blocks?messageIds=${messageId}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('PATCH and DELETE on unknown blocks answer MESSAGE_NOT_FOUND', async () => {
    const patched = await handle.app.inject({
      method: 'PATCH',
      url: '/api/v2/blocks/no-such-block',
      payload: { serializedState: {} },
    });
    expect(patched.statusCode).toBe(404);
    const deleted = await handle.app.inject({
      method: 'DELETE',
      url: '/api/v2/blocks/no-such-block',
    });
    expect(deleted.statusCode).toBe(404);
  });
});
