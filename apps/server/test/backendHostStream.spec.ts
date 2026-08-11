/**
 * Rev4 §D: streamed route bodies in BackendPluginHost.
 *
 * Part A (white-box): drives BackendProcess with a fake child process and
 * asserts the host-side stream contract — open resolves the invocation with a
 * stream marker, chunks flow into the pipe with ack credit, quota/size
 * violations tear the stream down, abort destroys the pipe and aborts the
 * worker's pump.
 *
 * Part B (end to end): spawns a real plugin worker (node + plugin-worker.mjs)
 * and exercises a ReadableStream route through the HTTP dispatcher.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PassThrough } from 'node:stream';
import type { ChildProcess, Serializable } from 'node:child_process';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { EventBus, type AppEventMap, type PluginManifest } from '@neotavern/plugin-sdk';
import { createLogger } from '@neotavern/shared';
import { BackendPluginHost, BackendProcess } from '../src/plugin/backendHost.js';
import { createAppInstance, type AppContext, type TypedApp } from '../src/types.js';
import { registerErrorHandler } from '../src/lib/errors.js';

interface FakeChild {
  listeners: Array<[string, (eventData: unknown) => void]>;
  sent: Serializable[];
  exitCode: number | null;
  signalCode: number | null;
  on(event: string, fn: (eventData: unknown) => void): void;
  once(event: string, fn: (eventData: unknown) => void): void;
  send(message: Serializable): void;
  kill(): void;
}

function fakeChild(): FakeChild {
  const child: FakeChild = {
    listeners: [],
    sent: [],
    exitCode: null,
    signalCode: null,
    on(event, fn) {
      child.listeners.push([event, fn]);
    },
    once(event, fn) {
      child.listeners.push([event, fn]);
    },
    send(message) {
      child.sent.push(message);
    },
    kill() {
      // no-op
    },
  };
  return child;
}

function emit(child: FakeChild, event: string, data: unknown): void {
  for (const [listenerEvent, fn] of child.listeners) {
    if (listenerEvent === event) fn(data);
  }
}

/** Minimal BackendPluginHost stand-in: only what BackendProcess touches. */
function fakeHost(): { logPluginMessage: () => void; logWorkerOutput: () => void } {
  return {
    logPluginMessage: () => undefined,
    logWorkerOutput: () => undefined,
  };
}

function collectPipe(pipe: PassThrough): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pipe.on('data', (chunk: Buffer) => chunks.push(chunk));
    pipe.on('end', () => resolve(Buffer.concat(chunks)));
    pipe.on('error', (error) => reject(error));
  });
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

interface StreamHarness {
  process: BackendProcess;
  child: FakeChild;
  emitMessage(message: Record<string, unknown>): void;
  invoke(): Promise<unknown>;
}

function streamHarness(): StreamHarness {
  const child = fakeChild();
  const process = new BackendProcess(
    'test.stream',
    [],
    child as unknown as ChildProcess,
    fakeHost() as unknown as BackendPluginHost,
  );
  const emitMessage = (message: Record<string, unknown>): void => emit(child, 'message', message);
  const invoke = (): Promise<unknown> =>
    process.invoke('route:r1', { params: {} }, new AbortController().signal);
  return { process, child, emitMessage, invoke };
}

function invocationId(harness: StreamHarness): string {
  const message = harness.child.sent[0] as { type: string; invocationId: string };
  expect(message.type).toBe('route.invoke');
  return message.invocationId;
}

interface StreamMarker {
  kind: 'stream-response';
  status?: unknown;
  headers?: unknown;
  pipe: PassThrough;
}

describe('backend host streamed route bodies (rev4 §D)', () => {
  it('resolves the invocation with a stream marker and pipes chunks to EOF', async () => {
    const harness = streamHarness();
    const pending = harness.invoke();
    const id = invocationId(harness);
    harness.emitMessage({
      type: 'route.body.open',
      invocationId: id,
      status: 201,
      headers: { 'content-type': 'text/plain' },
    });
    const marker = (await pending) as StreamMarker;
    expect(marker.kind).toBe('stream-response');
    expect(marker.status).toBe(201);
    expect(marker.headers).toEqual({ 'content-type': 'text/plain' });

    harness.emitMessage({
      type: 'route.body.chunk',
      invocationId: id,
      seq: 1,
      data: base64('alpha:'),
      bytes: 6,
    });
    harness.emitMessage({
      type: 'route.body.chunk',
      invocationId: id,
      seq: 2,
      data: base64('beta'),
      bytes: 4,
    });
    harness.emitMessage({ type: 'route.body.end', invocationId: id });
    // Chunks that arrive before Fastify attaches its consumer must remain
    // buffered rather than being drained by host-side credit bookkeeping.
    const body = collectPipe(marker.pipe);
    await expect(body).resolves.toEqual(Buffer.from('alpha:beta', 'utf8'));
  });

  it('grants credit back to the worker as the consumer drains the pipe', async () => {
    const harness = streamHarness();
    const pending = harness.invoke();
    const id = invocationId(harness);
    harness.emitMessage({ type: 'route.body.open', invocationId: id });
    const marker = (await pending) as StreamMarker;
    const acks: number[] = [];
    marker.pipe.on('data', (chunk: Buffer) => {
      acks.push(chunk.byteLength);
    });
    const body = collectPipe(marker.pipe);
    harness.emitMessage({
      type: 'route.body.chunk',
      invocationId: id,
      seq: 1,
      data: base64('hello'),
      bytes: 5,
    });
    harness.emitMessage({
      type: 'route.body.chunk',
      invocationId: id,
      seq: 2,
      data: base64(' world'),
      bytes: 6,
    });
    harness.emitMessage({ type: 'route.body.end', invocationId: id });
    await body;
    const ackMessages = harness.child.sent.filter(
      (message) => (message as { type?: string }).type === 'route.body.ack',
    );
    expect(ackMessages.length).toBeGreaterThan(0);
    expect((ackMessages as Array<{ bytes: number }>).reduce((sum, ack) => sum + ack.bytes, 0)).toBe(
      11,
    );
    expect(acks.reduce((sum, size) => sum + size, 0)).toBe(11);
  });

  it('tears the stream down when the worker fails mid-stream', async () => {
    const harness = streamHarness();
    const pending = harness.invoke();
    const id = invocationId(harness);
    harness.emitMessage({ type: 'route.body.open', invocationId: id });
    const marker = (await pending) as StreamMarker;
    const body = collectPipe(marker.pipe);
    harness.emitMessage({
      type: 'route.body.error',
      invocationId: id,
      message: 'backend exploded',
    });
    await expect(body).rejects.toThrow();
  });

  it('rejects a chunk above the per-chunk cap and aborts the worker pump', async () => {
    const harness = streamHarness();
    const pending = harness.invoke();
    const id = invocationId(harness);
    harness.emitMessage({ type: 'route.body.open', invocationId: id });
    const marker = (await pending) as StreamMarker;
    const body = collectPipe(marker.pipe);
    harness.emitMessage({
      type: 'route.body.chunk',
      invocationId: id,
      seq: 1,
      data: base64('x'.repeat(2 * 1024 * 1024)),
      bytes: 2 * 1024 * 1024,
    });
    await expect(body).rejects.toThrow();
    const aborts = harness.child.sent.filter(
      (message) => (message as { type?: string }).type === 'route.abort',
    );
    expect(aborts.length).toBeGreaterThan(0);
  });

  it('rejects a chunk whose declared size does not match its bytes', async () => {
    const harness = streamHarness();
    const pending = harness.invoke();
    const id = invocationId(harness);
    harness.emitMessage({ type: 'route.body.open', invocationId: id });
    const marker = (await pending) as StreamMarker;
    const body = collectPipe(marker.pipe);
    harness.emitMessage({
      type: 'route.body.chunk',
      invocationId: id,
      seq: 1,
      data: base64('hello'),
      bytes: 99,
    });
    await expect(body).rejects.toThrow();
  });

  it('tears the stream down past the total body quota', async () => {
    const harness = streamHarness();
    const pending = harness.invoke();
    const id = invocationId(harness);
    harness.emitMessage({ type: 'route.body.open', invocationId: id });
    const marker = (await pending) as StreamMarker;
    const body = collectPipe(marker.pipe);
    const megabyte = base64('a'.repeat(1024 * 1024));
    for (let index = 0; index < 9; index += 1) {
      harness.emitMessage({
        type: 'route.body.chunk',
        invocationId: id,
        seq: index + 1,
        data: megabyte,
        bytes: 1024 * 1024,
      });
    }
    await expect(body).rejects.toThrow();
  });

  it('ignores chunks and ends for unknown streams (late worker messages)', async () => {
    const harness = streamHarness();
    const pending = harness.invoke();
    const id = invocationId(harness);
    harness.emitMessage({ type: 'route.body.open', invocationId: id });
    const marker = (await pending) as StreamMarker;
    const body = collectPipe(marker.pipe);
    harness.emitMessage({
      type: 'route.body.chunk',
      invocationId: id,
      seq: 1,
      data: base64('ok'),
      bytes: 2,
    });
    harness.emitMessage({ type: 'route.body.end', invocationId: id });
    // Late traffic for a finished stream must be a no-op, not a throw.
    harness.emitMessage({
      type: 'route.body.chunk',
      invocationId: id,
      seq: 2,
      data: base64('late'),
      bytes: 4,
    });
    harness.emitMessage({ type: 'route.body.end', invocationId: id });
    await expect(body).resolves.toEqual(Buffer.from('ok', 'utf8'));
  });

  it('tears the stream down when the invocation is aborted', async () => {
    const harness = streamHarness();
    const controller = new AbortController();
    const pending = harness.process.invoke('route:r1', {}, controller.signal);
    const id = invocationId(harness);
    harness.emitMessage({ type: 'route.body.open', invocationId: id });
    const marker = (await pending) as StreamMarker;
    const body = collectPipe(marker.pipe);
    controller.abort();
    await expect(body).rejects.toThrow();
    const aborts = harness.child.sent.filter(
      (message) => (message as { type?: string }).type === 'route.abort',
    );
    expect(aborts.length).toBeGreaterThan(0);
  });
});

const PLUGIN_ID = 'test.stream';

let database: AppDatabase;
let bus: EventBus<AppEventMap>;
let app: TypedApp;
let host: BackendPluginHost;
let dataDir: string;
let packageRoot: string;

beforeEach(async () => {
  database = createAppDatabase(':memory:');
  bus = new EventBus<AppEventMap>();
  dataDir = mkdtempSync(join(tmpdir(), 'neotavern-stream-data-'));
  packageRoot = mkdtempSync(join(tmpdir(), 'neotavern-stream-plugin-'));
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
  await app.ready();
});

afterEach(async () => {
  await host.close();
  await app.close();
  database.close();
  await removeEventually(dataDir);
  await removeEventually(packageRoot);
});

/** Windows keeps worker-loaded files locked briefly after child.kill(). */
async function removeEventually(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function writePlugin(backendSource: string): PluginManifest {
  writeFileSync(join(packageRoot, 'backend.mjs'), backendSource, 'utf8');
  return {
    id: PLUGIN_ID,
    name: PLUGIN_ID,
    version: '1.0.0',
    apiVersion: 2,
    backend: 'backend.mjs',
  };
}

describe('backend host streamed route bodies end to end', () => {
  it(
    'streams a ReadableStream route body through the HTTP dispatcher',
    { timeout: 30_000 },
    async () => {
      const manifest = writePlugin(`
        export default {
          activate(api) {
            api.routes.post('/echo-stream', async () => {
              const encoder = new TextEncoder();
              return {
                status: 201,
                headers: { 'content-type': 'text/plain' },
                body: new ReadableStream({
                  start(controller) {
                    controller.enqueue(encoder.encode('alpha:'));
                    controller.enqueue(encoder.encode('beta'));
                    controller.close();
                  },
                }),
              };
            });
            api.routes.get('/text', async () => ({ status: 200, body: 'plain' }));
            api.routes.get('/large-stream', async () => {
              const encoder = new TextEncoder();
              return new ReadableStream({
                start(controller) {
                  controller.enqueue(encoder.encode('x'.repeat(80 * 1024)));
                  controller.close();
                },
              });
            });
          },
        };
      `);
      await host.activate(manifest, packageRoot, ['server.routes']);

      const streamed = await app.inject({
        method: 'POST',
        url: `/api/plugins/${PLUGIN_ID}/echo-stream`,
      });
      expect(streamed.statusCode).toBe(201);
      expect(streamed.headers['content-type']).toBe('text/plain');
      expect(streamed.body).toBe('alpha:beta');

      const large = await app.inject({
        method: 'GET',
        url: `/api/plugins/${PLUGIN_ID}/large-stream`,
      });
      expect(large.statusCode).toBe(200);
      expect(large.body).toHaveLength(80 * 1024);
      expect(large.body).toMatch(/^x+$/u);

      const plain = await app.inject({
        method: 'GET',
        url: `/api/plugins/${PLUGIN_ID}/text`,
      });
      expect(plain.statusCode).toBe(200);
      expect(plain.body).toBe('plain');
    },
  );

  it(
    'allows package-local imports through a canonicalized package-root alias',
    { timeout: 30_000 },
    async () => {
      writeFileSync(join(packageRoot, 'helper.mjs'), "export const marker = 'alias-ok';", 'utf8');
      const manifest = writePlugin(`
        import { marker } from './helper.mjs';
        export default {
          activate(api) {
            api.routes.get('/alias', async () => ({ marker }));
          },
        };
      `);
      const aliasParent = mkdtempSync(join(tmpdir(), 'neotavern-stream-alias-'));
      const aliasRoot = join(aliasParent, 'plugin');
      symlinkSync(packageRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        await host.activate(manifest, aliasRoot, ['server.routes']);
        const response = await app.inject({
          method: 'GET',
          url: `/api/plugins/${PLUGIN_ID}/alias`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ marker: 'alias-ok' });
      } finally {
        await host.deactivate(PLUGIN_ID).catch(() => undefined);
        await removeEventually(aliasParent);
      }
    },
  );
});
