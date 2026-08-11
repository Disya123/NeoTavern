/**
 * Unit tests for the chat kernel host handlers (kernel/chat.ts) against a
 * fake KernelHostContext: capability gates fire per method, draft appends
 * coalesce at 10Hz into a single remote write per window, commit finalizes
 * the message as role `assistant`, abort/dispose delete the draft message.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import type { RuntimeFrame } from '../runtime.js';
import { attachChat } from './chat.js';
import type { KernelHostContext } from './types.js';

interface FakeRpcContext {
  params: unknown;
  signal: AbortSignal;
}

interface FakeSession {
  handle: (method: string, handler: (ctx: FakeRpcContext) => Promise<unknown>) => () => void;
  handlers: Map<string, (ctx: FakeRpcContext) => Promise<unknown> | unknown>;
  scope: { track: (item: { dispose: () => void }) => void };
  disposables: Array<{ dispose: () => void }>;
}

function makeSession(): FakeSession {
  const session: FakeSession = {
    handlers: new Map(),
    disposables: [],
    handle(method, handler) {
      session.handlers.set(method, handler);
      return () => session.handlers.delete(method);
    },
    scope: {
      track(item) {
        session.disposables.push(item);
      },
    },
  };
  return session;
}

function makeContext(options: { capabilities?: string[]; chatId?: string | null } = {}) {
  const session = makeSession();
  const capabilities = new Set(options.capabilities ?? []);
  const ctx: KernelHostContext = {
    pluginId: 'plugin.test',
    frame: {} as unknown as RuntimeFrame,
    session: session as unknown as kernel.KernelSession,
    runtime: {} as unknown as KernelHostContext['runtime'],
    hasCapability: (name) => capabilities.has(name),
    currentChatId: () => options.chatId ?? null,
    currentProviderId: () => null,
  };
  return { ctx, session };
}

async function callHandler(
  session: FakeSession,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = session.handlers.get(method);
  expect(handler, `handler registered for ${method}`).toBeTruthy();
  const controller = new AbortController();
  return handler!({ params, signal: controller.signal });
}

interface RecordedCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: Mock;
let calls: RecordedCall[];
let messageSequence: number;

beforeEach(() => {
  calls = [];
  messageSequence = 0;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body =
      init?.body != null ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    if (method === 'GET' && url === '/api/v2/chats/chat-1') {
      return jsonResponse({ id: 'chat-1', title: 'Test Chat' });
    }
    if (method === 'GET' && url === '/api/v2/chats/missing') {
      return jsonResponse({ code: 'CHAT_NOT_FOUND', message: 'gone' }, 404);
    }
    if (method === 'GET' && url.startsWith('/api/v2/chats/chat-1/messages')) {
      return jsonResponse({
        items: [{ id: 'msg-0', role: 'user', content: 'hi' }],
        nextCursor: null,
        hasMore: false,
      });
    }
    if (method === 'POST' && url === '/api/v2/chats/chat-1/messages') {
      messageSequence += 1;
      return jsonResponse({
        id: `msg-${messageSequence}`,
        role: body?.role,
        content: body?.content,
      });
    }
    if (method === 'PATCH' && url.startsWith('/api/v2/chats/chat-1/messages/')) {
      const id = url.split('/').pop();
      return jsonResponse({ id, role: body?.role ?? 'plugin', content: body?.content });
    }
    if (method === 'DELETE' && url.startsWith('/api/v2/chats/chat-1/messages/')) {
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url === '/api/v2/chats/chat-1/drafts') {
      return jsonResponse({
        id: 'draft-1',
        chatId: 'chat-1',
        branchId: 'branch-1',
        role: body?.role ?? 'assistant',
        content: '',
        name: null,
        meta: {},
        sequence: 0,
        revision: 1,
        committedMessageId: null,
        createdAt: 0,
        updatedAt: 0,
      });
    }
    if (method === 'PATCH' && url.startsWith('/api/v2/chats/chat-1/drafts/')) {
      const id = url.split('/').pop();
      return jsonResponse({
        id,
        chatId: 'chat-1',
        branchId: 'branch-1',
        role: body?.role ?? 'assistant',
        content: body?.content ?? '',
        name: null,
        meta: {},
        sequence: body?.sequence ?? 0,
        revision: 1,
        committedMessageId: null,
        createdAt: 0,
        updatedAt: 0,
      });
    }
    if (method === 'POST' && url.endsWith('/commit')) {
      messageSequence += 1;
      return jsonResponse({ messageId: `msg-${messageSequence}`, alreadyCommitted: false });
    }
    if (method === 'DELETE' && url.startsWith('/api/v2/chats/chat-1/drafts/')) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'no route' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ALL_CHAT_CAPS = ['chats.read.current', 'chats.read.all', 'chats.write.plugin', 'chats.draft'];

describe('attachChat capability gates', () => {
  it('registers every chat.* method from contract §2', () => {
    const { ctx, session } = makeContext();
    attachChat(ctx);
    for (const method of [
      'chat.current',
      'chat.messages.list',
      'chat.messages.append',
      'chat.draft.start',
      'chat.draft.append',
      'chat.draft.commit',
      'chat.draft.abort',
    ]) {
      expect(session.handlers.has(method), method).toBe(true);
    }
  });

  it('denies every method with CAPABILITY_DENIED and never hits the network', async () => {
    const { ctx, session } = makeContext({ capabilities: [], chatId: 'chat-1' });
    attachChat(ctx);
    for (const method of [
      'chat.current',
      'chat.messages.list',
      'chat.messages.append',
      'chat.draft.start',
      'chat.draft.append',
      'chat.draft.commit',
      'chat.draft.abort',
    ]) {
      await expect(
        callHandler(session, method, { role: 'plugin', content: 'x' }),
      ).rejects.toMatchObject({
        code: kernel.KernelErrorCode.CAPABILITY_DENIED,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scopes message list reads: current-only denies foreign chats', async () => {
    const { ctx, session } = makeContext({
      capabilities: ['chats.read.current'],
      chatId: 'chat-1',
    });
    attachChat(ctx);
    await expect(
      callHandler(session, 'chat.messages.list', { chatId: 'other' }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.CAPABILITY_DENIED,
    });
    const page = (await callHandler(session, 'chat.messages.list', {})) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(page.items).toHaveLength(1);
    expect(page).not.toHaveProperty('nextCursor');
    const { ctx: allCtx, session: allSession } = makeContext({
      capabilities: ['chats.read.all'],
      chatId: 'chat-1',
    });
    attachChat(allCtx);
    await expect(
      callHandler(allSession, 'chat.messages.list', { chatId: 'other' }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.NOT_FOUND,
    });
  });
});

describe('chat.current', () => {
  it('returns the focused chat meta', async () => {
    const { ctx, session } = makeContext({
      capabilities: ['chats.read.current'],
      chatId: 'chat-1',
    });
    attachChat(ctx);
    await expect(callHandler(session, 'chat.current')).resolves.toEqual({
      chatId: 'chat-1',
      title: 'Test Chat',
    });
  });

  it('returns null when no chat is focused and when the chat vanished', async () => {
    const { ctx, session } = makeContext({ capabilities: ['chats.read.current'], chatId: null });
    attachChat(ctx);
    await expect(callHandler(session, 'chat.current')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const gone = makeContext({ capabilities: ['chats.read.current'], chatId: 'missing' });
    attachChat(gone.ctx);
    await expect(callHandler(gone.session, 'chat.current')).resolves.toBeNull();
  });
});

describe('chat.messages.append', () => {
  it('creates a plugin-role message', async () => {
    const { ctx, session } = makeContext({
      capabilities: ['chats.write.plugin'],
      chatId: 'chat-1',
    });
    attachChat(ctx);
    await expect(
      callHandler(session, 'chat.messages.append', { role: 'plugin', content: 'hello' }),
    ).resolves.toEqual({ messageId: 'msg-1' });
    expect(calls).toEqual([
      {
        method: 'POST',
        url: '/api/v2/chats/chat-1/messages',
        body: { role: 'plugin', content: 'hello' },
      },
    ]);
  });

  it('rejects non-plugin roles with VALIDATION_FAILED', async () => {
    const { ctx, session } = makeContext({ capabilities: ALL_CHAT_CAPS, chatId: 'chat-1' });
    attachChat(ctx);
    await expect(
      callHandler(session, 'chat.messages.append', { role: 'assistant', content: 'x' }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.VALIDATION_FAILED });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('draft streaming (server-side object)', () => {
  it('streams into the server draft at 10Hz and commits it', async () => {
    vi.useFakeTimers();
    const { ctx, session } = makeContext({ capabilities: ALL_CHAT_CAPS, chatId: 'chat-1' });
    attachChat(ctx);
    const { draftId } = (await callHandler(session, 'chat.draft.start', {})) as { draftId: string };
    expect(draftId).toBe('draft-1');

    for (const chunk of ['a', 'b', 'c', 'd', 'e']) {
      await callHandler(session, 'chat.draft.append', { draftId, text: chunk });
    }
    await vi.advanceTimersByTimeAsync(100);
    // One draft POST, one coalesced PATCH with a monotonic sequence — no
    // committed message is ever touched.
    const creates = calls.filter((call) => call.url === '/api/v2/chats/chat-1/drafts');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toEqual({ role: 'assistant' });
    const firstPatch = calls.find((call) => call.method === 'PATCH');
    expect(firstPatch?.url).toBe('/api/v2/chats/chat-1/drafts/draft-1');
    expect(firstPatch?.body).toEqual({ content: 'abcde', sequence: 1 });

    await callHandler(session, 'chat.draft.append', { draftId, text: 'f' });
    await vi.advanceTimersByTimeAsync(100);
    const patches = calls.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]?.body).toEqual({ content: 'abcdef', sequence: 2 });

    const committed = (await callHandler(session, 'chat.draft.commit', { draftId })) as {
      messageId: string;
    };
    expect(committed.messageId).toBe('msg-1');
    const commitCall = calls.at(-1);
    expect(commitCall?.method).toBe('POST');
    expect(commitCall?.url).toBe('/api/v2/chats/chat-1/drafts/draft-1/commit');
  });

  it('commit flushes the tail when nothing was flushed yet', async () => {
    vi.useFakeTimers();
    const { ctx, session } = makeContext({ capabilities: ALL_CHAT_CAPS, chatId: 'chat-1' });
    attachChat(ctx);
    const { draftId } = (await callHandler(session, 'chat.draft.start', {})) as { draftId: string };
    await callHandler(session, 'chat.draft.append', { draftId, text: 'done' });
    const committed = (await callHandler(session, 'chat.draft.commit', { draftId })) as {
      messageId: string;
    };
    expect(committed.messageId).toBe('msg-1');
    // Tail flush (sequence 1) then the idempotent commit.
    const patches = calls.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ content: 'done', sequence: 1 });
    expect(calls.at(-1)?.url).toBe('/api/v2/chats/chat-1/drafts/draft-1/commit');
  });

  it('abort deletes the server draft and forgets it', async () => {
    vi.useFakeTimers();
    const { ctx, session } = makeContext({ capabilities: ALL_CHAT_CAPS, chatId: 'chat-1' });
    attachChat(ctx);
    const { draftId } = (await callHandler(session, 'chat.draft.start', {})) as { draftId: string };
    await callHandler(session, 'chat.draft.append', { draftId, text: 'x' });
    await vi.advanceTimersByTimeAsync(100);
    await callHandler(session, 'chat.draft.abort', { draftId });
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: '/api/v2/chats/chat-1/drafts/draft-1',
    });
    await expect(
      callHandler(session, 'chat.draft.append', { draftId, text: 'y' }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.NOT_FOUND,
    });
  });

  it('session dispose aborts live drafts (DELETE best-effort)', async () => {
    vi.useFakeTimers();
    const { ctx, session } = makeContext({ capabilities: ALL_CHAT_CAPS, chatId: 'chat-1' });
    attachChat(ctx);
    const { draftId } = (await callHandler(session, 'chat.draft.start', {})) as { draftId: string };
    await callHandler(session, 'chat.draft.append', { draftId, text: 'leak' });
    await vi.advanceTimersByTimeAsync(100);
    expect(session.disposables).toHaveLength(1);
    for (const item of session.disposables) item.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: '/api/v2/chats/chat-1/drafts/draft-1',
    });
  });

  it('append passes a plugin-provided idempotencyKey to the REST create', async () => {
    const { ctx, session } = makeContext({
      capabilities: ['chats.write.plugin'],
      chatId: 'chat-1',
    });
    attachChat(ctx);
    await callHandler(session, 'chat.messages.append', {
      role: 'plugin',
      content: 'retry me',
      idempotencyKey: 'outbox-1',
    });
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v2/chats/chat-1/messages',
      body: { role: 'plugin', content: 'retry me', idempotencyKey: 'outbox-1' },
    });
  });
});
