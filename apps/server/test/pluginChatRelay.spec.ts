/**
 * Rev4 chats slice (contract §6 A5): `plugin.chat.updated` relay.
 *
 * The relay re-emits chat message lifecycle events on the app bus as the
 * plugin-namespaced `plugin.chat.updated` event. Payloads carry identifiers
 * and role only — never message content. The event must also be present on
 * the browser SSE whitelist so sandboxed frontends can subscribe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { EventBus, type AppEventMap } from '@neotavern/plugin-sdk';
import { createLogger, sleep } from '@neotavern/shared';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppInstance, type AppContext, type TypedApp } from '../src/types.js';
import { registerErrorHandler } from '../src/lib/errors.js';
import { registerEventStreamRoutes } from '../src/plugins/events.js';
import {
  PLUGIN_CHAT_UPDATED_EVENT,
  registerPluginChatRelay,
  type PluginChatUpdatedPayload,
} from '../src/plugins/pluginChatRelay.js';

let database: AppDatabase;
let bus: EventBus<AppEventMap>;
let app: TypedApp;
let unsubscribe: (() => void) | null;
let port: number;

beforeEach(async () => {
  database = createAppDatabase(':memory:');
  bus = new EventBus<AppEventMap>();
  const logger = createLogger({ level: 'error' });
  app = createAppInstance();
  registerErrorHandler(app, logger);
  const ctx = { database, events: bus, logger } as unknown as AppContext;
  unsubscribe = registerPluginChatRelay(app, ctx);
  await registerEventStreamRoutes(app, ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
  await app.ready();
});

afterEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  await app.close();
  database.close();
});

function relayed(bus: EventBus<AppEventMap>): () => PluginChatUpdatedPayload[] {
  const payloads: PluginChatUpdatedPayload[] = [];
  bus.on(PLUGIN_CHAT_UPDATED_EVENT, (payload) => {
    payloads.push(payload as PluginChatUpdatedPayload);
  });
  return () => [...payloads];
}

interface SseConnection {
  frames(): Array<Record<string, unknown>>;
  close(): void;
}

function connectSse(port: number): Promise<SseConnection> {
  return new Promise((resolveSse, rejectSse) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/v2/events', method: 'GET' },
      (res) => {
        let buffer = '';
        const frames = (): Array<Record<string, unknown>> =>
          buffer
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          if (frames().some((frame) => frame['type'] === 'ready')) {
            resolveSse({
              frames,
              close: () => {
                res.destroy();
                req.destroy();
              },
            });
          }
        });
        res.on('error', rejectSse);
      },
    );
    req.on('error', rejectSse);
    req.end();
  });
}

describe('plugin chat relay (rev4 §6 A5)', () => {
  it('re-emits created/updated/deleted as plugin.chat.updated with identifiers and role', async () => {
    const received = relayed(bus);
    bus.emit('chat.message.created', {
      chatId: 'chat-1',
      messageId: 'msg-1',
      role: 'user',
    });
    bus.emit('chat.message.updated', {
      chatId: 'chat-1',
      messageId: 'msg-1',
      role: 'user',
    });
    bus.emit('chat.message.deleted', { chatId: 'chat-1', messageId: 'msg-2' });
    await sleep(20);
    expect(received()).toEqual([
      { chatId: 'chat-1', messageId: 'msg-1', role: 'user' },
      { chatId: 'chat-1', messageId: 'msg-1', role: 'user' },
      { chatId: 'chat-1', messageId: 'msg-2' },
    ]);
  });

  it('never forwards message content in the payload', async () => {
    const received = relayed(bus);
    bus.emit('chat.message.created', {
      chatId: 'chat-1',
      messageId: 'msg-1',
      role: 'user',
      content: 'secret chat text',
      extra: { anything: true },
    });
    await sleep(20);
    const [payload] = received();
    expect(payload).toEqual({ chatId: 'chat-1', messageId: 'msg-1', role: 'user' });
    expect(payload).not.toHaveProperty('content');
    expect(payload).not.toHaveProperty('extra');
  });

  it('stops relaying after unsubscribe (plugin teardown)', async () => {
    const received = relayed(bus);
    bus.emit('chat.message.created', { chatId: 'chat-1', messageId: 'msg-1' });
    await sleep(10);
    unsubscribe?.();
    unsubscribe = null;
    bus.emit('chat.message.created', { chatId: 'chat-1', messageId: 'msg-2' });
    bus.emit('chat.message.updated', { chatId: 'chat-1', messageId: 'msg-2' });
    bus.emit('chat.message.deleted', { chatId: 'chat-1', messageId: 'msg-2' });
    await sleep(10);
    expect(received()).toEqual([{ chatId: 'chat-1', messageId: 'msg-1' }]);
  });
});

describe('plugin chat relay SSE surface', () => {
  it('announces plugin.chat.updated on the browser event stream', async () => {
    const stream = await connectSse(port);
    try {
      const ready = stream.frames().find((frame) => frame['type'] === 'ready') as {
        events: string[];
      };
      expect(ready.events).toContain(PLUGIN_CHAT_UPDATED_EVENT);
    } finally {
      stream.close();
    }
  });

  it('streams plugin.chat.updated envelopes to a connected browser', async () => {
    const stream = await connectSse(port);
    try {
      bus.emit('chat.message.deleted', { chatId: 'chat-9', messageId: 'msg-9', role: 'assistant' });
      await sleep(50);
      const envelope = stream
        .frames()
        .find((frame) => frame['type'] === 'event' && frame['event'] === PLUGIN_CHAT_UPDATED_EVENT);
      expect(envelope).toEqual({
        type: 'event',
        event: PLUGIN_CHAT_UPDATED_EVENT,
        payload: { chatId: 'chat-9', messageId: 'msg-9', role: 'assistant' },
      });
    } finally {
      stream.close();
    }
  });
});
