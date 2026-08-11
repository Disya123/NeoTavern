/**
 * Integration tests for the SSE event stream (src/plugins/events.ts). The
 * hijacked SSE reply cannot be driven through inject(), so the app listens on
 * an ephemeral port and the test subscribes with a real HTTP client. Other
 * routes are still exercised via inject(); they share the app's event bus,
 * which the test holds a reference to (passed into buildApp).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { DEFAULT_PROVIDER_TIMEOUTS, ProviderRegistry } from '@neotavern/provider-sdk';
import { EventBus, type AppEventMap } from '@neotavern/plugin-sdk';
import { createLogger, sleep } from '@neotavern/shared';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, resolveDataPaths } from '../src/lib/paths.js';
import type { TypedApp } from '../src/types.js';
import { ContextStrategyRegistry } from '../src/pipeline/contextShift.js';
import { PostProcessorRegistry } from '../src/pipeline/postProcess.js';
import { multipartFile } from './helpers.js';
import * as yazl from 'yazl';

type Frame = Record<string, unknown>;

/** Collects SSE frames from a real HTTP connection to /api/v2/events. */
class EventStream {
  readonly opened: Promise<{ statusCode: number; headers: IncomingMessage['headers'] }>;

  private readonly received: Frame[] = [];

  private waiters: Array<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
  }> = [];

  private buffer = '';

  private readonly req: ClientRequest;

  constructor(port: number) {
    let resolveOpened!: (value: {
      statusCode: number;
      headers: IncomingMessage['headers'];
    }) => void;
    let rejectOpened!: (cause: Error) => void;
    this.opened = new Promise((resolve, reject) => {
      resolveOpened = resolve;
      rejectOpened = reject;
    });
    this.req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v2/events',
        headers: { accept: 'text/event-stream' },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => this.onChunk(chunk));
        resolveOpened({ statusCode: res.statusCode ?? 0, headers: res.headers });
      },
    );
    this.req.on('error', (cause) => rejectOpened(cause));
    this.req.end();
  }

  get frameCount(): number {
    return this.received.length;
  }

  /** Resolves with the first frame (past or future) matching the predicate. */
  waitForFrame(
    predicate: (frame: Frame) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<Frame> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(
          new Error(`Timed out waiting for ${label}; received: ${JSON.stringify(this.received)}`),
        );
      }, timeoutMs);
      const wrapped = (frame: Frame): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push({ predicate, resolve: wrapped });
    });
  }

  close(): void {
    this.req.destroy();
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let separator: number;
    while ((separator = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const dataLines = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) continue; // comment keep-alive ("": ping) or blank
      const frame = JSON.parse(dataLines.join('')) as Frame;
      this.received.push(frame);
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.predicate(frame)) {
          waiter.resolve(frame);
          return false;
        }
        return true;
      });
    }
  }
}

let app: TypedApp;
let database: AppDatabase;
let bus: EventBus<AppEventMap>;
let port: number;
let stream: EventStream | null = null;

const delay = (ms: number): Promise<void> => sleep(ms);

// Kept on a hand-rolled buildApp (not createTestApp from ./helpers.js): the
// whitelist assertions emit non-whitelisted events on the app's own bus, so
// the suite must inject its EventBus via buildApp's `events` input — the
// helper exposes no events option and buildApp does not surface the bus on
// the app instance.
beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'neotavern-events-test-'));
  const paths = resolveDataPaths(dataDir);
  ensureDataDirs(paths);
  database = createAppDatabase(':memory:');
  bus = new EventBus<AppEventMap>();
  app = await buildApp({
    database,
    providers: new ProviderRegistry(),
    contextStrategies: new ContextStrategyRegistry(),
    postProcessors: new PostProcessorRegistry(),
    events: bus,
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      webDir: null,
      logLevel: 'error',
      corsOrigin: 'http://127.0.0.1:5173',
      remoteAccess: false,
      publicOrigin: 'http://127.0.0.1:5173',
      remoteTokenHash: null,
      secureSessionCookies: false,
      safeMode: false,
      pluginNodePath: process.execPath,
      pluginWorkerPath: null,
      pluginLoaderPath: null,
      providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS,
    },
    logger: createLogger({ level: 'error' }),
    paths,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  stream?.close();
  // Let the server-side socket observe the client disconnect before closing.
  await delay(100);
  await app.close();
  database.close();
});

describe('SSE event stream', () => {
  it('opens with SSE headers, announces the whitelist and forwards chat.created', async () => {
    stream = new EventStream(port);
    const { statusCode, headers } = await stream.opened;
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toContain('text/event-stream');
    expect(headers['cache-control']).toContain('no-cache');

    // The ready frame arrives first and names the full whitelist.
    const ready = await stream.waitForFrame((frame) => frame.type === 'ready', 2000, 'ready frame');
    expect(ready.events).toEqual([
      'chat.created',
      'chat.opened',
      'chat.message.created',
      'chat.message.updated',
      'chat.message.deleted',
      'character.selected',
      'generation.started',
      'generation.delta',
      'generation.finished',
      'generation.error',
      'plugin.capability.revoked',
      'plugin.job.due',
      'plugin.chat.updated',
      'plugin.chat.message',
      'plugin.auth.connected',
      'plugin.auth.revoked',
      'plugin.auth.expired',
      'plugin.installed',
      'plugin.updating',
      'plugin.updated',
      'plugin.rollback',
      'plugin.activated',
      'plugin.disabled',
      'plugin.uninstalling',
      'plugin.deleted',
      'chat.message.block.changed',
    ]);

    // A chat created through the API produces a chat.created frame.
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'SSE probe' },
    });
    expect(chat.statusCode, chat.payload).toBe(200);
    const chatCreated = await stream.waitForFrame(
      (frame) => frame.type === 'event' && frame.event === 'chat.created',
      2000,
      'chat.created frame',
    );
    expect(chatCreated.payload).toEqual({ chatId: chat.json().id });

    // Non-whitelisted app events stay inside the bus.
    const before = stream.frameCount;
    bus.emit('theme.changed', { themeId: null });
    bus.emit('test.custom', { value: 1 });
    await delay(250);
    expect(stream.frameCount).toBe(before);

    stream.close();
    stream = null;
  });
});

describe('plugin lifecycle events (rev4 §J2)', () => {
  const pluginId = 'test.lifecycle-events';

  function pluginArchive(version: string, frontendBody: string): Promise<Buffer> {
    const zip = new yazl.ZipFile();
    zip.addBuffer(
      Buffer.from(
        JSON.stringify({
          id: pluginId,
          name: 'Lifecycle Events',
          version,
          apiVersion: 2,
          frontend: 'frontend.js',
          permissions: [],
        }),
      ),
      'plugin.json',
    );
    zip.addBuffer(Buffer.from(frontendBody), 'frontend.js');
    zip.end();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.on('error', reject);
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  it('announces updating/updated around an update and uninstalling before delete', async () => {
    stream = new EventStream(port);
    await stream.opened;
    await stream.waitForFrame((frame) => frame.type === 'ready', 2000, 'ready frame');

    const install = async (version: string): Promise<number> => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/plugins/install',
        ...multipartFile(
          await pluginArchive(version, 'export default { activate() {} };'),
          `${pluginId}.stplugin`,
          'application/zip',
        ),
      });
      return response.statusCode;
    };

    // Fresh install: only plugin.installed (no update lifecycle).
    expect(await install('1.0.0')).toBe(200);
    await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: [] },
    });

    // Update over the existing installation: updating + updated pair with
    // the version transition.
    expect(await install('2.0.0')).toBe(200);
    const updating = await stream.waitForFrame(
      (frame) => frame.type === 'event' && frame.event === 'plugin.updating',
      3000,
      'plugin.updating frame',
    );
    expect(updating.payload).toEqual({
      pluginId,
      version: '2.0.0',
      previousVersion: '1.0.0',
    });
    const updated = await stream.waitForFrame(
      (frame) => frame.type === 'event' && frame.event === 'plugin.updated',
      3000,
      'plugin.updated frame',
    );
    expect(updated.payload).toEqual({
      pluginId,
      version: '2.0.0',
      previousVersion: '1.0.0',
    });

    // Delete: uninstalling precedes the deleted frame.
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v2/plugins/${pluginId}`,
    });
    expect(removed.json()).toEqual({ deleted: true });
    const uninstalling = await stream.waitForFrame(
      (frame) => frame.type === 'event' && frame.event === 'plugin.uninstalling',
      3000,
      'plugin.uninstalling frame',
    );
    expect(uninstalling.payload).toEqual({ pluginId });
    await stream.waitForFrame(
      (frame) => frame.type === 'event' && frame.event === 'plugin.deleted',
      3000,
      'plugin.deleted frame',
    );

    stream.close();
    stream = null;
  });
});
