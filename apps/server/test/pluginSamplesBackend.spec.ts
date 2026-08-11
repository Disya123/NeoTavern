/**
 * Rev4 sample plugins — backend integration (contract §6 A5, §D, worker).
 *
 * Spawns the real `plugins/rev4-agent` worker and exercises it end to end
 * through the HTTP dispatcher: JSON routes, the chat relay (`plugin.chat.updated`
 * → worker storage) and lifecycle teardown.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { EventBus, type AppEventMap, type PluginManifest } from '@neotavern/plugin-sdk';
import { createLogger, sleep } from '@neotavern/shared';
import { BackendPluginHost } from '../src/plugin/backendHost.js';
import { createAppInstance, type AppContext, type TypedApp } from '../src/types.js';
import { registerErrorHandler } from '../src/lib/errors.js';
import { registerPluginChatRelay } from '../src/plugins/pluginChatRelay.js';

const PLUGIN_ID = 'neotavern.rev4-agent';
const SAMPLE_ROOT = resolve(import.meta.dirname, '../../../plugins/rev4-agent');

let database: AppDatabase;
let bus: EventBus<AppEventMap>;
let app: TypedApp;
let host: BackendPluginHost;
let dataDir: string;

beforeEach(async () => {
  database = createAppDatabase(':memory:');
  bus = new EventBus<AppEventMap>();
  dataDir = mkdtempSync(join(tmpdir(), 'neotavern-agent-sample-'));
  const logger = createLogger({ level: 'error' });
  app = createAppInstance();
  registerErrorHandler(app, logger);
  const ctx = {
    database,
    events: bus,
    logger,
    config: { pluginNodePath: process.execPath },
    paths: { plugins: dataDir, cache: join(dataDir, 'cache') },
  } as unknown as AppContext;
  host = new BackendPluginHost(app, ctx);
  host.registerDispatcher();
  registerPluginChatRelay(app, ctx);
  await app.ready();
});

afterEach(async () => {
  await host.close();
  await app.close();
  database.close();
  await removeEventually(dataDir);
});

async function removeEventually(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
    }
  }
}

describe('rev4-agent sample backend', () => {
  it('serves JSON routes through the dispatcher', async () => {
    const manifest: PluginManifest = {
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      version: '1.0.0',
      apiVersion: 2,
      backend: 'backend.mjs',
    };
    await host.activate(manifest, SAMPLE_ROOT, ['server.routes']);

    const tick = await app.inject({
      method: 'POST',
      url: `/api/plugins/${PLUGIN_ID}/agent/tick`,
      payload: { source: 'test', nonce: 7 },
    });
    expect(tick.statusCode).toBe(200);
    const tickBody = tick.json() as { ok: boolean; tick: number; echo: Record<string, unknown> };
    expect(tickBody.ok).toBe(true);
    expect(tickBody.tick).toBe(1);
    expect(tickBody.echo).toEqual({ source: 'test', nonce: 7 });

    const status = await app.inject({
      method: 'GET',
      url: `/api/plugins/${PLUGIN_ID}/agent/status`,
    });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json() as { ticks: number; seen: { messages: number } };
    expect(statusBody.ticks).toBe(1);
    expect(statusBody.seen.messages).toBe(0);
  });

  it('relays chat lifecycle events into the worker without content', async () => {
    const manifest: PluginManifest = {
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      version: '1.0.0',
      apiVersion: 2,
      backend: 'backend.mjs',
    };
    await host.activate(manifest, SAMPLE_ROOT, ['server.routes']);

    bus.emit('chat.message.created', {
      chatId: 'chat-42',
      messageId: 'msg-1',
      role: 'user',
      content: 'secret chat text',
    });
    bus.emit('chat.message.updated', { chatId: 'chat-42', messageId: 'msg-1', role: 'user' });
    await sleep(150);

    const status = await app.inject({
      method: 'GET',
      url: `/api/plugins/${PLUGIN_ID}/agent/status`,
    });
    const statusBody = status.json() as { seen: { messages: number; chats: number } };
    expect(statusBody.seen.messages).toBe(2);
  });

  it('tears the worker down on deactivate', async () => {
    const manifest: PluginManifest = {
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      version: '1.0.0',
      apiVersion: 2,
      backend: 'backend.mjs',
    };
    await host.activate(manifest, SAMPLE_ROOT, ['server.routes']);
    await host.deactivate(PLUGIN_ID);

    const status = await app.inject({
      method: 'GET',
      url: `/api/plugins/${PLUGIN_ID}/agent/status`,
    });
    expect(status.statusCode).toBe(404);
  });
});
