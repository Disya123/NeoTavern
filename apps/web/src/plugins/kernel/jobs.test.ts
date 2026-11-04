/**
 * Kernel jobs slice (web host side): capability gates, the kernel job queue over
 * the facade, the honest refusal of host-only verbs, and the due-event ->
 * `jobs.run` forwarding. Mirrors commands.test.ts fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import { attachJobs } from './jobs.js';
import type { KernelHostContext } from './types.js';

const { KernelErrorCode } = kernel;

const { fakeJobs } = vi.hoisted(() => ({
  fakeJobs: {
    enqueue: vi.fn(),
    list: vi.fn(),
    cancel: vi.fn(),
  },
}));

import type * as BackendModule from '../../api/backend.js';

vi.mock('../../api/backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendModule>();
  return {
    ...actual,
    backend: {
      ...actual.backend,
      plugins: {
        ...actual.backend.plugins,
        jobsEnqueue: fakeJobs.enqueue,
        jobsList: fakeJobs.list,
        jobsCancel: fakeJobs.cancel,
      },
    },
  };
});

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
  fakeJobs.enqueue.mockReset();
  fakeJobs.cancel.mockReset();
  fakeJobs.list.mockReset();
  fakeJobs.enqueue.mockResolvedValue({ job: { id: 'j1' } });
  fakeJobs.cancel.mockResolvedValue({ job: { id: 'j1' } });
  fakeJobs.list.mockResolvedValue({
    items: [
      {
        id: 'j1',
        pluginId: 'test.jobs',
        kind: 'nightly',
        state: 'queued',
        payloadJson: '{"a":1}',
        attempts: 0,
        maxAttempts: 1,
        runAt: '2025-01-01T00:00:00Z',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    ],
  });
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

  it('jobs.schedule enqueues through the kernel facade', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    const runAt = 1730000000000;
    const result = (await invoke(fake.handlers, 'jobs.schedule', {
      name: 'nightly',
      runAt,
      payload: { a: 1 },
    })) as { jobId: string };
    expect(result.jobId).toBe('j1');
    expect(fakeJobs.enqueue).toHaveBeenCalledWith({
      pluginId: 'test.jobs',
      kind: 'nightly',
      payloadJson: '{"a":1}',
      runAt: new Date(runAt).toISOString(),
      maxAttempts: 1,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('jobs.schedule refuses recurring schedules honestly', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    await expect(
      invoke(fake.handlers, 'jobs.schedule', { name: 'hourly', cron: '0 * * * *', retries: 3 }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.PROTOCOL_UNSUPPORTED }));
    expect(fakeJobs.enqueue).not.toHaveBeenCalled();
  });

  it('jobs.schedule rejects cron and runAt together', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    await expect(
      invoke(fake.handlers, 'jobs.schedule', { name: 'bad', cron: '* * * * *', runAt: 1 }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }));
  });

  it('jobs.ack and jobs.retry refuse: completion is the executor report', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    await expect(
      invoke(fake.handlers, 'jobs.ack', { jobId: 'j1', ok: false }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.PROTOCOL_UNSUPPORTED }));
    await expect(invoke(fake.handlers, 'jobs.retry', { jobId: 'j1' })).rejects.toThrowError(
      expect.objectContaining({ code: KernelErrorCode.PROTOCOL_UNSUPPORTED }),
    );
  });

  it('jobs.cancel and jobs.list go through the facade', async () => {
    const fake = fakeContext(new Set(['jobs.background']));
    attachJobs(fake.ctx);
    await invoke(fake.handlers, 'jobs.cancel', { jobId: 'j1' });
    expect(fakeJobs.cancel).toHaveBeenCalledWith({ pluginId: 'test.jobs', jobId: 'j1' });
    const listed = (await invoke(fake.handlers, 'jobs.list', {})) as {
      jobs: Array<{ jobId: string; name: string; payload: unknown }>;
    };
    expect(listed.jobs).toEqual([
      {
        jobId: 'j1',
        name: 'nightly',
        state: 'queued',
        runAt: '2025-01-01T00:00:00Z',
        attempts: 0,
        maxAttempts: 1,
        payload: { a: 1 },
      },
    ]);
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
