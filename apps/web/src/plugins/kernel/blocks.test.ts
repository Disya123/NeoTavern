/**
 * Unit tests for the blocks kernel host handlers (kernel/blocks.ts): the
 * capability gate on registerRenderer, attachment storage + change events,
 * the mount/freeze/unfreeze roundtrip against a fake session and renderer
 * cleanup on unregister.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import type { PluginUiRegistration, RuntimeFrame } from '../runtime.js';
import {
  BLOCKS_CHANGED_EVENT,
  attachBlocks,
  ensureBlocksLoaded,
  getBlocksForMessage,
  mountBlockContainers,
} from './blocks.js';
import type { KernelHostContext } from './types.js';

interface FakeRpcContext {
  params: unknown;
  signal: AbortSignal;
}

interface FakeSession {
  handle: (method: string, handler: (ctx: FakeRpcContext) => unknown) => () => void;
  call: (method: string, params?: unknown, opts?: unknown) => Promise<unknown>;
  isDisposed: boolean;
  handlers: Map<string, (ctx: FakeRpcContext) => unknown>;
  calls: Array<{ method: string; params: unknown }>;
  responders: Map<string, (params: unknown) => unknown>;
  disposables: Array<{ dispose: () => void }>;
  scope: { track: (item: { dispose: () => void }) => void };
}

function makeSession(): FakeSession {
  const session: FakeSession = {
    handlers: new Map(),
    calls: [],
    responders: new Map(),
    isDisposed: false,
    disposables: [],
    handle(method, handler) {
      session.handlers.set(method, handler);
      return () => session.handlers.delete(method);
    },
    async call(method, params) {
      session.calls.push({ method, params });
      const responder = session.responders.get(method);
      return responder ? responder(params) : {};
    },
    scope: {
      track(item) {
        session.disposables.push(item);
      },
    },
  };
  return session;
}

function makeContext(options: { granted?: boolean; chatId?: string | null } = {}) {
  const session = makeSession();
  const addedRegistrations: PluginUiRegistration[] = [];
  const removedRegistrations: string[] = [];
  const appEventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const ctx: KernelHostContext = {
    pluginId: 'plugin.test',
    frame: { plugin: { name: 'Test Plugin' } } as unknown as RuntimeFrame,
    session: session as unknown as kernel.KernelSession,
    runtime: {
      kernelAddRegistration: (registration: PluginUiRegistration) => {
        addedRegistrations.push(registration);
      },
      kernelRemoveRegistration: (registrationId: string) => {
        removedRegistrations.push(registrationId);
      },
      mountPage: vi.fn(() => vi.fn()),
      onAppEvent: (event: string, listener: (payload: unknown) => void) => {
        const set = appEventListeners.get(event) ?? new Set();
        set.add(listener);
        appEventListeners.set(event, set);
        return () => set.delete(listener);
      },
    } as unknown as KernelHostContext['runtime'],
    hasCapability: () => options.granted ?? true,
    currentChatId: () => options.chatId ?? null,
    currentProviderId: () => null,
  };
  return {
    ctx,
    session,
    addedRegistrations,
    removedRegistrations,
    appEventListeners,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeBlock(
  id: string,
  messageId: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    id,
    messageId,
    pluginId: 'plugin.test',
    blockType: 'meter',
    rendererId: 'blk:meter',
    descriptor: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body =
      init?.body != null ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    if (method === 'POST' && url.startsWith('/api/v2/chats/chat-1/messages/')) {
      const messageId = url.split('/')[6] ?? 'msg-1';
      return jsonResponse(
        makeBlock(`blk-${messageId}`, messageId, { blockType: String(body?.blockType) }),
      );
    }
    if (method === 'PATCH' && url.startsWith('/api/v2/blocks/')) {
      const id = url.split('/').pop();
      return jsonResponse(
        makeBlock(String(id), 'msg-1', { serializedState: body?.serializedState }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v2/chats/chat-1/blocks')) {
      return jsonResponse({ items: [] });
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'no route' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function callHandler(
  session: FakeSession,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const handler = session.handlers.get(method);
  expect(handler, `handler registered for ${method}`).toBeTruthy();
  const controller = new AbortController();
  return handler!({ params, signal: controller.signal });
}

async function settle(): Promise<void> {
  // The mount/freeze chains are pure promise hops; flushing microtasks is
  // deterministic and adds no wall-clock time.
  for (let turn = 0; turn < 16; turn++) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachBlocks capability gate', () => {
  it('registers the three plugin→host methods from contract §2', () => {
    const { ctx, session } = makeContext();
    attachBlocks(ctx);
    for (const method of [
      'blocks.registerRenderer',
      'blocks.unregisterRenderer',
      'blocks.attach',
    ]) {
      expect(session.handlers.has(method), method).toBe(true);
    }
  });

  it('denies registerRenderer/attach with CAPABILITY_DENIED when not granted', async () => {
    const { ctx, session } = makeContext({ granted: false });
    attachBlocks(ctx);
    await expect(
      callHandler(session, 'blocks.registerRenderer', { blockType: 'chart', title: 'Chart' }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.CAPABILITY_DENIED,
      details: { capability: 'ui.messageBlock' },
    });
    await expect(
      callHandler(session, 'blocks.attach', { messageId: 'm1', blockType: 'chart' }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.CAPABILITY_DENIED });
  });

  it('rejects duplicate block types and invalid params with VALIDATION_FAILED', async () => {
    const { ctx, session } = makeContext();
    attachBlocks(ctx);
    await callHandler(session, 'blocks.registerRenderer', { blockType: 'dup', title: 'Dup' });
    await expect(
      callHandler(session, 'blocks.registerRenderer', { blockType: 'dup', title: 'Dup 2' }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.VALIDATION_FAILED,
      details: { reason: 'duplicate-block-type' },
    });
    await expect(
      callHandler(session, 'blocks.registerRenderer', { blockType: '', title: 'X' }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.VALIDATION_FAILED });
  });
});

describe('attachBlocks registration + attach', () => {
  it('registers a messageBlocks registration and returns blk:<blockType>', async () => {
    const { ctx, session, addedRegistrations } = makeContext();
    attachBlocks(ctx);
    const result = await callHandler(session, 'blocks.registerRenderer', {
      blockType: 'chart',
      title: 'Chart',
    });
    expect(result).toEqual({ rendererId: 'blk:chart' });
    expect(addedRegistrations).toEqual([
      expect.objectContaining({
        pluginId: 'plugin.test',
        registrationId: 'blk:chart',
        kind: 'messageBlocks',
        definition: { id: 'chart', title: 'Chart' },
      }),
    ]);
  });

  it('persists the attachment server-side, emits the change event and exposes it to the UI', async () => {
    const { ctx, session } = makeContext({ chatId: 'chat-1' });
    attachBlocks(ctx);
    await callHandler(session, 'blocks.registerRenderer', { blockType: 'meter', title: 'Meter' });

    const events: Array<{ messageId?: unknown }> = [];
    const listener = (event: Event): void => {
      events.push((event as CustomEvent<{ messageId?: unknown }>).detail);
    };
    globalThis.addEventListener(BLOCKS_CHANGED_EVENT, listener);
    try {
      const result = (await callHandler(session, 'blocks.attach', {
        messageId: 'msg-1',
        blockType: 'meter',
        descriptor: { value: 7 },
      })) as { blockId: string };
      expect(result.blockId).toBe('blk-msg-1');
      // The attachment went through the REST create first (server-owned id).
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v2/chats/chat-1/messages/msg-1/blocks',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"blockType":"meter"'),
        }),
      );

      const blocks = getBlocksForMessage('msg-1');
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        blockId: 'blk-msg-1',
        messageId: 'msg-1',
        chatId: 'chat-1',
        blockType: 'meter',
        pluginId: 'plugin.test',
        rendererId: 'blk:meter',
        descriptor: { value: 7 },
      });
      expect(events).toEqual([{ messageId: 'msg-1' }]);
      expect(getBlocksForMessage('other')).toHaveLength(0);
    } finally {
      globalThis.removeEventListener(BLOCKS_CHANGED_EVENT, listener);
    }
  });

  it('rejects attach without a focused chat (NOT_FOUND, no server call)', async () => {
    const { ctx, session } = makeContext({ chatId: null });
    attachBlocks(ctx);
    await callHandler(session, 'blocks.registerRenderer', {
      blockType: 'meter-nochat',
      title: 'Meter',
    });
    await expect(
      callHandler(session, 'blocks.attach', {
        messageId: 'msg-x',
        blockType: 'meter-nochat',
      }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.NOT_FOUND,
      details: { reason: 'no-current-chat' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects attach for an unregistered block type', async () => {
    const { ctx, session } = makeContext();
    attachBlocks(ctx);
    await expect(
      callHandler(session, 'blocks.attach', { messageId: 'm2', blockType: 'nope' }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.VALIDATION_FAILED,
      details: { reason: 'unknown-block-type' },
    });
  });

  it('unregisterRenderer removes the registration and blocks further attach', async () => {
    const { ctx, session, removedRegistrations } = makeContext();
    attachBlocks(ctx);
    await callHandler(session, 'blocks.registerRenderer', { blockType: 'gauge', title: 'Gauge' });
    await callHandler(session, 'blocks.unregisterRenderer', { rendererId: 'blk:gauge' });
    expect(removedRegistrations).toEqual(['blk:gauge']);
    await expect(
      callHandler(session, 'blocks.attach', { messageId: 'm3', blockType: 'gauge' }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.VALIDATION_FAILED,
      details: { reason: 'unknown-block-type' },
    });
  });
});

describe('mountBlockContainers lifecycle', () => {
  it('mounts via blocks.mount, freezes state on cleanup and unfreezes on remount', async () => {
    const { ctx, session } = makeContext({ chatId: 'chat-1' });
    attachBlocks(ctx);
    await callHandler(session, 'blocks.registerRenderer', { blockType: 'graph', title: 'Graph' });
    const attached = (await callHandler(session, 'blocks.attach', {
      messageId: 'msg-live',
      blockType: 'graph',
      descriptor: { series: [1, 2] },
    })) as { blockId: string };

    session.responders.set('blocks.freeze', () => ({ serializedState: { v: 42 } }));

    const root = document.createElement('div');
    document.body.append(root);
    const cleanup = mountBlockContainers('msg-live', root);
    await settle();

    const mountCall = session.calls.find((call) => call.method === 'blocks.mount');
    expect(mountCall).toBeTruthy();
    expect(mountCall!.params).toEqual({
      rendererId: 'blk:graph',
      blockId: attached.blockId,
      descriptor: { series: [1, 2] },
    });
    expect(root.querySelector('[data-part="plugin-block"]')).not.toBeNull();
    expect(root.querySelector('[data-block-id]')?.getAttribute('data-block-id')).toBe(
      attached.blockId,
    );

    cleanup();
    await settle();

    const freezeCall = session.calls.find((call) => call.method === 'blocks.freeze');
    expect(freezeCall).toBeTruthy();
    expect(freezeCall!.params).toEqual({ blockId: attached.blockId });
    expect(getBlocksForMessage('msg-live')[0]?.serializedState).toEqual({ v: 42 });
    expect(root.querySelector('[data-part="plugin-block"]')).toBeNull();

    const remount = mountBlockContainers('msg-live', root);
    await settle();
    const unfreezeCall = session.calls.find((call) => call.method === 'blocks.unfreeze');
    expect(unfreezeCall).toBeTruthy();
    expect(unfreezeCall!.params).toEqual({ blockId: attached.blockId, state: { v: 42 } });
    remount();
    await settle();
    root.remove();
  });

  it('keeps an empty container and skips RPC when the renderer was unregistered', async () => {
    const { ctx, session } = makeContext({ chatId: 'chat-1' });
    attachBlocks(ctx);
    await callHandler(session, 'blocks.registerRenderer', { blockType: 'ghost', title: 'Ghost' });
    await callHandler(session, 'blocks.attach', {
      messageId: 'msg-ghost',
      blockType: 'ghost',
    });
    await callHandler(session, 'blocks.unregisterRenderer', { rendererId: 'blk:ghost' });

    const root = document.createElement('div');
    document.body.append(root);
    const cleanup = mountBlockContainers('msg-ghost', root);
    await settle();
    expect(root.querySelector('[data-part="plugin-block"]')).not.toBeNull();
    expect(session.calls.some((call) => call.method === 'blocks.mount')).toBe(false);
    cleanup();
    await settle();
    expect(root.querySelector('[data-part="plugin-block"]')).toBeNull();
    root.remove();
  });
});

describe('mountBlockContainers overscan', () => {
  class FakeIntersectionObserver {
    static instances: FakeIntersectionObserver[] = [];
    readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void;
    readonly observed: HTMLElement[] = [];

    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      this.callback = callback;
      FakeIntersectionObserver.instances.push(this);
    }

    observe(element: HTMLElement): void {
      this.observed.push(element);
    }

    disconnect(): void {
      FakeIntersectionObserver.instances = FakeIntersectionObserver.instances.filter(
        (instance) => instance !== this,
      );
    }

    trigger(visible: boolean): void {
      this.callback([{ isIntersecting: visible }]);
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeIntersectionObserver.instances = [];
  });

  it('mounts on viewport entry, freezes on exit and restores on re-entry', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { ctx, session } = makeContext({ chatId: 'chat-1' });
    attachBlocks(ctx);
    await callHandler(session, 'blocks.registerRenderer', { blockType: 'spark', title: 'Spark' });
    await callHandler(session, 'blocks.attach', {
      messageId: 'msg-ov',
      blockType: 'spark',
      descriptor: { seed: 1 },
    });
    session.responders.set('blocks.freeze', () => ({ serializedState: { v: 7 } }));

    const root = document.createElement('div');
    const anchor = document.createElement('article');
    document.body.append(root, anchor);
    const cleanup = mountBlockContainers('msg-ov', root, anchor);

    // Off-screen initially: no mount RPC, no containers.
    await settle();
    expect(session.calls.some((call) => call.method === 'blocks.mount')).toBe(false);
    expect(root.querySelector('[data-part="plugin-block"]')).toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(FakeIntersectionObserver.instances[0]?.observed).toEqual([anchor]);

    // Scroll into view: mount.
    FakeIntersectionObserver.instances[0]?.trigger(true);
    await settle();
    expect(session.calls.filter((call) => call.method === 'blocks.mount')).toHaveLength(1);
    expect(root.querySelector('[data-part="plugin-block"]')).not.toBeNull();

    // Scroll away: freeze + tear down.
    FakeIntersectionObserver.instances[0]?.trigger(false);
    await settle();
    const freezeCall = session.calls.find((call) => call.method === 'blocks.freeze');
    expect(freezeCall).toBeTruthy();
    expect(getBlocksForMessage('msg-ov')[0]?.serializedState).toEqual({ v: 7 });
    expect(root.querySelector('[data-part="plugin-block"]')).toBeNull();

    // Scroll back: remount + restore.
    FakeIntersectionObserver.instances[0]?.trigger(true);
    await settle();
    expect(session.calls.filter((call) => call.method === 'blocks.mount')).toHaveLength(2);
    const unfreezeCall = session.calls.find((call) => call.method === 'blocks.unfreeze');
    expect(unfreezeCall).toBeTruthy();
    expect(unfreezeCall!.params).toEqual({
      blockId: 'blk-msg-ov',
      state: { v: 7 },
    });
    expect(root.querySelector('[data-part="plugin-block"]')).not.toBeNull();

    cleanup();
    await settle();
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    root.remove();
    anchor.remove();
  });

  it('mounts immediately when IntersectionObserver is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { ctx, session } = makeContext({ chatId: 'chat-1' });
    attachBlocks(ctx);
    await callHandler(session, 'blocks.registerRenderer', { blockType: 'plain', title: 'Plain' });
    await callHandler(session, 'blocks.attach', { messageId: 'msg-plain', blockType: 'plain' });

    const root = document.createElement('div');
    const anchor = document.createElement('article');
    document.body.append(root, anchor);
    const cleanup = mountBlockContainers('msg-plain', root, anchor);
    await settle();
    expect(session.calls.some((call) => call.method === 'blocks.mount')).toBe(true);
    expect(root.querySelector('[data-part="plugin-block"]')).not.toBeNull();
    cleanup();
    await settle();
    root.remove();
    anchor.remove();
  });
});

describe('persistent block loading (rev4 stage 4)', () => {
  it('loads server attachments into the cache and dispatches the change event', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/v2/chats/chat-1/blocks')) {
        return jsonResponse({
          items: [makeBlock('blk-loaded', 'msg-loaded', { descriptor: { seed: 1 } })],
        });
      }
      return jsonResponse({ code: 'NOT_FOUND', message: 'no route' }, 404);
    });
    const events: string[] = [];
    const listener = (event: Event): void => {
      events.push((event as CustomEvent<{ messageId?: string }>).detail?.messageId ?? '');
    };
    globalThis.addEventListener(BLOCKS_CHANGED_EVENT, listener);
    try {
      await ensureBlocksLoaded('chat-1', 'msg-loaded');
      expect(events).toEqual(['msg-loaded']);
      const blocks = getBlocksForMessage('msg-loaded');
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        blockId: 'blk-loaded',
        descriptor: { seed: 1 },
      });
    } finally {
      globalThis.removeEventListener(BLOCKS_CHANGED_EVENT, listener);
    }
  });

  it('restores serialized renderer state loaded from the server', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/v2/chats/chat-1/blocks')) {
        return jsonResponse({
          items: [makeBlock('blk-state', 'msg-state', { serializedState: { count: 9 } })],
        });
      }
      return jsonResponse({ code: 'NOT_FOUND', message: 'no route' }, 404);
    });
    await ensureBlocksLoaded('chat-1', 'msg-state');
    expect(getBlocksForMessage('msg-state')[0]?.serializedState).toEqual({ count: 9 });
  });

  it('caches per session: a second load does not refetch', async () => {
    fetchMock.mockClear();
    await ensureBlocksLoaded('chat-1', 'msg-cached');
    await ensureBlocksLoaded('chat-1', 'msg-cached');
    const blockFetches = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/blocks?messageIds=msg-cached'),
    );
    expect(blockFetches).toHaveLength(1);
  });

  it('the block.changed app event invalidates the cache and refetches', async () => {
    const { ctx, session, appEventListeners } = makeContext({ chatId: 'chat-1' });
    attachBlocks(ctx);
    await callHandler(session, 'blocks.registerRenderer', {
      blockType: 'meter-sync',
      title: 'Meter',
    });
    await callHandler(session, 'blocks.attach', {
      messageId: 'msg-sync',
      blockType: 'meter-sync',
    });

    // Another client changed the attachment: the host listener drops the
    // session cache and reloads from the server.
    fetchMock.mockClear();
    const listeners = appEventListeners.get('chat.message.block.changed');
    expect(listeners?.size).toBe(1);
    for (const listener of listeners ?? []) {
      listener({ chatId: 'chat-1', messageId: 'msg-sync', blockId: 'blk-msg-sync' });
    }
    await settle();
    const refetch = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/blocks?messageIds=msg-sync'),
    );
    expect(refetch).toBeTruthy();
    // The listener is session-scoped and disposed with the session.
    expect(session.disposables).toHaveLength(1);
  });
});
