/**
 * Rev4 kernel jobs slice (web host side): capability gates, REST delegation
 * and the due-event -> `jobs.run` forwarding. Mirrors commands.test.ts fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import { attachJobs } from './jobs.js';
import type { KernelHostContext } from './types.js';

const { KernelErrorCode } = kernel;

interface FakeFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { forEach: (cb: (value: string, key: string) => void) => void };
}

function fakeContext(capabilities: ReadonlySet<string>) {
  const handlers = new Map<string, (ctx: { params: unknown }) => unknown>();
  const tracked: Array<{ dispose: () => void }> = [];
  const dueListeners: Array<{ event: string; listener: (payload: unknown) => void }> = [];
  const session = {
    handle: vi.fn((method: string, handler: (ctx: { params: unknown }) => unknown) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    call: vi.fn(async () => ({})),
    scope: {
      track: vi.fn((item: { dispose: () => void }) => {
        tracked.push(item);
        return item;
      }),
    },
  };
  const runtime = {
    onAppEvent: vi.fn((event: string, listener: (payload: unknown) => void) => {
      dueListeners.push({ event, listener });
      return () => {
        const index = dueListeners.findIndex((entry) => entry.listener === listener);
        if (index >= 0) dueListeners.splice(index, 1);
      };
    }),
  };
  const ctx = {
    pluginId: 'test.jobs',
    frame: {},
    session,
    runtime,
    hasCapability: (name: string, scope?: unknown) => {
      if (name === 'network.domains') {
        const requested = scope as { kind?: string } | undefined;
        return requested?.kind === 'all' && capabilities.has('network.domains');
      }
      return capabilities.has(name);
    },
    currentChatId: () => null,
  } as unknown as KernelHostContext;
  return { ctx, handlers, session, runtime, tracked, dueListeners };
}

function invoke(
  handlers: Map<string, (ctx: { params: unknown }) => unknown>,
  method: string,
  params: unknown,
) {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`no handler for ${method}`);
  return handler({ params });
}

function fetchResponse(status: number, body: unknown, text = ''): FakeFetchResponse {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => text,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => fetchResponse(200, { jobId: 'j1', name: 'n' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kernel jobs', () => {
  it('registers jobs, network and actions wire methods', () => {
    const fake = fakeContext(new Set());
    attachJobs(fake.ctx);
    expect([...fake.handlers.keys()].sort()).toEqual([
      'actions.perform',
      'jobs.ack',
      'jobs.cancel',
      'jobs.list',
      'jobs.retry',
      'jobs.schedule',
      'network.fetch',
    ]);
    expect(fake.dueListeners.map((entry) => entry.event)).toEqual(['plugin.job.due']);
    expect(fake.tracked).toHaveLength(1);
  });

  it('jobs.schedule requires the jobs.background capability', async () => {
    const fake = fakeContext(new Set());
    attachJobs(fake.ctx);
    await expect(
      invoke(fake.handlers, 'jobs.schedule', { name: 'x', runAt: 1 }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.CAPABILITY_DENIED }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('jobs.schedule posts to the REST route and returns the jobId', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    const result = (await invoke(fake.handlers, 'jobs.schedule', {
      name: 'nightly',
      runAt: 123,
      payload: { a: 1 },
    })) as { jobId: string };
    expect(result.jobId).toBe('j1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/v2/plugins/test.jobs/jobs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'nightly', runAt: 123, payload: { a: 1 } });
  });

  it('jobs.schedule forwards cron and retry options (stage 5)', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    await invoke(fake.handlers, 'jobs.schedule', {
      name: 'hourly',
      cron: '0 * * * *',
      retries: 3,
      retryDelayMs: 10_000,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      name: 'hourly',
      cron: '0 * * * *',
      retries: 3,
      retryDelayMs: 10_000,
    });

    // cron and runAt together are still rejected client-side.
    await expect(
      invoke(fake.handlers, 'jobs.schedule', { name: 'bad', cron: '* * * * *', runAt: 1 }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }));
  });

  it('jobs.ack posts the outcome to the ack route', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    fetchMock.mockResolvedValueOnce(fetchResponse(200, { acknowledged: true }));
    const result = (await invoke(fake.handlers, 'jobs.ack', {
      jobId: 'j1',
      ok: false,
      error: 'boom',
    })) as { acknowledged: boolean };
    expect(result.acknowledged).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/v2/plugins/test.jobs/jobs/j1/ack');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ ok: false, error: 'boom' });
  });

  it('jobs.ack validates jobId/ok', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    await expect(invoke(fake.handlers, 'jobs.ack', { jobId: 'j1' })).rejects.toThrowError(
      expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }),
    );
    await expect(invoke(fake.handlers, 'jobs.ack', { ok: true })).rejects.toThrowError(
      expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }),
    );
  });

  it('jobs.retry posts to the retry route (stage 5)', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    fetchMock.mockResolvedValueOnce(fetchResponse(200, { jobId: 'j1', name: 'n' }));
    await invoke(fake.handlers, 'jobs.retry', { jobId: 'j1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers?: object }];
    expect(url).toBe('/api/v2/plugins/test.jobs/jobs/j1/retry');
    expect(init.method).toBe('POST');
    // Bodyless POSTs must not carry `content-type: application/json`
    // (Fastify rejects an empty JSON body with 400).
    expect(init.headers).toBeUndefined();
  });

  it('maps REST failures onto kernel error codes', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    fetchMock.mockResolvedValueOnce(fetchResponse(403, { code: 'PLUGIN_PERMISSION_DENIED' }));
    await expect(invoke(fake.handlers, 'jobs.list', {})).rejects.toThrowError(
      expect.objectContaining({ code: KernelErrorCode.CAPABILITY_DENIED }),
    );
    fetchMock.mockResolvedValueOnce(fetchResponse(404, { code: 'NOT_FOUND' }));
    await expect(invoke(fake.handlers, 'jobs.cancel', { jobId: 'missing' })).rejects.toThrowError(
      expect.objectContaining({ code: KernelErrorCode.NOT_FOUND }),
    );
  });

  it('forwards due events for this plugin to the live session', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    const listener = fake.dueListeners[0]?.listener;
    if (!listener) throw new Error('no due listener registered');
    listener({ pluginId: 'test.jobs', jobId: 'j1', name: 'tick', payload: { a: 1 } });
    await vi.waitFor(() =>
      expect(fake.session.call).toHaveBeenCalledWith('jobs.run', {
        jobId: 'j1',
        name: 'tick',
        payload: { a: 1 },
      }),
    );

    // Other plugins' due events are not forwarded.
    listener({ pluginId: 'other.plugin', jobId: 'j2', name: 'tick' });
    await Promise.resolve();
    expect(fake.session.call).toHaveBeenCalledTimes(1);
  });

  it('drops due events once the grant is gone', async () => {
    const fake = fakeContext(new Set());
    attachJobs(fake.ctx);
    const listener = fake.dueListeners[0]?.listener;
    if (!listener) throw new Error('no due listener registered');
    await Promise.resolve();
    expect(fake.session.call).not.toHaveBeenCalled();
  });

  it('actions.perform gates per-action capabilities and user activation', async () => {
    const denied = fakeContext(new Set());
    attachJobs(denied.ctx);
    await expect(
      invoke(denied.handlers, 'actions.perform', { action: 'clipboard.read', params: {} }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.CAPABILITY_DENIED }));

    // Granted but no user gesture in jsdom (navigator.userActivation absent).
    const granted = fakeContext(new Set(['clipboard.read']));
    attachJobs(granted.ctx);
    await expect(
      invoke(granted.handlers, 'actions.perform', { action: 'clipboard.read', params: {} }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: KernelErrorCode.CAPABILITY_DENIED,
        details: expect.objectContaining({ reason: 'user-activation-required' }),
      }),
    );

    await expect(
      invoke(granted.handlers, 'actions.perform', { action: 'teleport', params: {} }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }));
  });

  it('network.fetch enforces the network.domains grant scope', async () => {
    const denied = fakeContext(new Set());
    attachJobs(denied.ctx);
    await expect(
      invoke(denied.handlers, 'network.fetch', { url: 'https://api.example.com/x' }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.CAPABILITY_DENIED }));
    expect(fetchMock).not.toHaveBeenCalled();

    const granted = fakeContext(new Set(['network.domains']));
    attachJobs(granted.ctx);
    fetchMock.mockResolvedValueOnce(fetchResponse(200, {}, 'hello'));
    const result = (await invoke(granted.handlers, 'network.fetch', {
      url: 'https://api.example.com/x',
      method: 'GET',
    })) as { status: number; bodyText: string; headers: Record<string, string> };
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe('hello');
    expect(result.headers['content-type']).toBe('application/json');
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/x', { method: 'GET' });
  });
});
