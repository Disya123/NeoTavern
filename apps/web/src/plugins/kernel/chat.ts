/**
 * Rev4 kernel: chat.* host handlers incl. draft streaming (contract §2).
 *
 * All reads/writes go through the app-origin REST API (same-origin fetch via
 * the shared api client); the sandbox never talks to the server directly.
 * Capability checks run first (rev4 §B2): `chats.read.current` /
 * `chats.read.all` for reads, `chats.write.plugin` for plugin-role messages,
 * `chats.draft` for streaming drafts.
 *
 * Drafts are coalesced at 10Hz (an internal host policy — the sandbox never
 * sees the flush rate) and stream into the server-side draft object
 * (rev4 stage 3): the first flush creates the draft, later flushes PATCH it
 * with a monotonic sequence (replayed PATCHes are idempotent no-ops), and
 * `commit` materializes the final message atomically. A crash never leaves a
 * half-written committed message; abort/session-teardown deletes the draft.
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { CursorPage, Message, MessageDraft } from '@neotavern/contracts';
import { api, ApiError } from '../../api/client.js';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

/** 10Hz draft coalescing — host policy, not part of the plugin contract. */
const FLUSH_INTERVAL_MS = 100;

interface ChatMeta {
  id: string;
  title?: string;
}

interface DraftState {
  draftId: string;
  chatId: string;
  text: string;
  sequence: number;
  /** True while local text has not reached the server (tail-flush on commit). */
  dirty: boolean;
  /** window.setTimeout id (browser runtime; DOM lib returns number). */
  timer: number | null;
  flushing: Promise<void> | null;
}

function draftPath(chatId: string, draftId: string): string {
  return `/chats/${encodeURIComponent(chatId)}/drafts/${encodeURIComponent(draftId)}`;
}

function deny(method: string): KernelError {
  return new KernelError(KernelErrorCode.CAPABILITY_DENIED, { details: { method } });
}

function stringParam(value: unknown, field: string, method: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KernelError(KernelErrorCode.VALIDATION_FAILED, { details: { method, field } });
  }
  return value;
}

/** Map REST error envelopes onto kernel wire codes. */
function toKernelError(error: unknown): KernelError {
  if (error instanceof KernelError) return error;
  if (error instanceof ApiError) {
    const code =
      error.code === 'CHAT_NOT_FOUND' ||
      error.code === 'MESSAGE_NOT_FOUND' ||
      error.code === 'NOT_FOUND'
        ? KernelErrorCode.NOT_FOUND
        : KernelErrorCode.INTERNAL;
    return new KernelError(code, { details: { code: error.code }, cause: error });
  }
  return new KernelError(KernelErrorCode.INTERNAL, {
    details: { message: String(error) },
    cause: error,
  });
}

/** Resolve the target chat: explicit `chatId` param or the focused chat. */
function resolveChatId(
  ctx: KernelHostContext,
  params: { chatId?: unknown },
  method: string,
): string {
  if (params.chatId !== undefined && params.chatId !== null) {
    return stringParam(params.chatId, 'chatId', method);
  }
  const current = ctx.currentChatId();
  if (!current) {
    throw new KernelError(KernelErrorCode.NOT_FOUND, {
      details: { method, reason: 'no-current-chat' },
    });
  }
  return current;
}

function messagePath(chatId: string, messageId?: string): string {
  const base = `/chats/${encodeURIComponent(chatId)}/messages`;
  return messageId === undefined ? base : `${base}/${encodeURIComponent(messageId)}`;
}

export function attachChat(ctx: KernelHostContext): void {
  // ── chat.current ──────────────────────────────────────────────────────────
  ctx.session.handle('chat.current', async () => {
    if (!ctx.hasCapability('chats.read.current')) throw deny('chat.current');
    const chatId = ctx.currentChatId();
    if (!chatId) return null;
    try {
      const chat = await api.get<ChatMeta>(`/chats/${encodeURIComponent(chatId)}`);
      return { chatId, title: chat.title };
    } catch (error) {
      // The focused chat may vanish between the lookup and the call.
      if (
        error instanceof ApiError &&
        (error.code === 'CHAT_NOT_FOUND' || error.code === 'NOT_FOUND')
      ) {
        return null;
      }
      throw toKernelError(error);
    }
  });

  // ── chat.messages.list ────────────────────────────────────────────────────
  ctx.session.handle('chat.messages.list', async (context) => {
    const params = (context.params ?? {}) as {
      chatId?: unknown;
      cursor?: unknown;
      limit?: unknown;
    };
    const wantsOtherChat = params.chatId !== undefined && params.chatId !== null;
    const granted =
      ctx.hasCapability('chats.read.all') ||
      (ctx.hasCapability('chats.read.current') && !wantsOtherChat);
    if (!granted) throw deny('chat.messages.list');
    const chatId = resolveChatId(ctx, params, 'chat.messages.list');
    const query = new URLSearchParams();
    if (typeof params.cursor === 'string' && params.cursor.length > 0) {
      query.set('cursor', params.cursor);
    }
    if (typeof params.limit === 'number' && Number.isInteger(params.limit)) {
      query.set('limit', String(params.limit));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    try {
      const page = await api.get<CursorPage<Message>>(`${messagePath(chatId)}${suffix}`);
      return {
        items: page.items,
        ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
      };
    } catch (error) {
      throw toKernelError(error);
    }
  });

  // ── chat.messages.append ──────────────────────────────────────────────────
  ctx.session.handle('chat.messages.append', async (context) => {
    const params = (context.params ?? {}) as {
      chatId?: unknown;
      role?: unknown;
      content?: unknown;
      idempotencyKey?: unknown;
    };
    if (!ctx.hasCapability('chats.write.plugin')) throw deny('chat.messages.append');
    if (params.role !== 'plugin') {
      throw new KernelError(KernelErrorCode.VALIDATION_FAILED, {
        details: { method: 'chat.messages.append', field: 'role' },
      });
    }
    const content = stringParam(params.content, 'content', 'chat.messages.append');
    const chatId = resolveChatId(ctx, params, 'chat.messages.append');
    // Outbox (rev4 stage 3): a plugin-provided key makes a retried append
    // return the original message instead of duplicating it.
    const body: Record<string, unknown> = { role: 'plugin', content };
    if (typeof params.idempotencyKey === 'string' && params.idempotencyKey.length > 0) {
      body.idempotencyKey = params.idempotencyKey;
    }
    try {
      const message = await api.post<Message>(messagePath(chatId), body);
      return { messageId: message.id };
    } catch (error) {
      throw toKernelError(error);
    }
  });

  // ── drafts (coalesced at 10Hz) ────────────────────────────────────────────
  const drafts = new Map<string, DraftState>();

  function getDraft(draftId: string, method: string): DraftState {
    const draft = drafts.get(draftId);
    if (!draft) {
      throw new KernelError(KernelErrorCode.NOT_FOUND, { details: { method, field: 'draftId' } });
    }
    return draft;
  }

  async function flushDraft(draft: DraftState): Promise<void> {
    // Stream into the server-side draft; the sequence makes replayed writes
    // idempotent no-ops (rev4 stage 3). No committed message exists yet.
    draft.sequence += 1;
    await api.patch<MessageDraft>(draftPath(draft.chatId, draft.draftId), {
      content: draft.text,
      sequence: draft.sequence,
    });
    draft.dirty = false;
  }

  function scheduleFlush(draft: DraftState): void {
    if (draft.timer !== null) return;
    draft.timer = Number(
      window.setTimeout(() => {
        draft.timer = null;
        if (!drafts.has(draft.draftId)) return; // aborted while queued
        // Chain flushes so writes land in order; transient failures are
        // swallowed here (best-effort streaming) — commit/abort surface
        // persistent errors.
        draft.flushing = (draft.flushing ?? Promise.resolve())
          .then(() => flushDraft(draft))
          .catch(() => {});
      }, FLUSH_INTERVAL_MS),
    );
  }

  function clearTimer(draft: DraftState): void {
    if (draft.timer !== null) {
      window.clearTimeout(draft.timer);
      draft.timer = null;
    }
  }

  // Session teardown aborts every live draft (rev4 §0: registrations clean
  // up) — the server-side draft is deleted, nothing half-written survives.
  ctx.session.scope.track({
    dispose: () => {
      for (const draft of [...drafts.values()]) {
        clearTimer(draft);
        void api.del(draftPath(draft.chatId, draft.draftId)).catch(() => {});
      }
      drafts.clear();
    },
  });

  ctx.session.handle('chat.draft.start', async (context) => {
    const params = (context.params ?? {}) as { chatId?: unknown };
    if (!ctx.hasCapability('chats.draft')) throw deny('chat.draft.start');
    const chatId = resolveChatId(ctx, params, 'chat.draft.start');
    try {
      const draft = await api.post<MessageDraft>(`/chats/${encodeURIComponent(chatId)}/drafts`, {
        role: 'assistant',
      });
      drafts.set(draft.id, {
        draftId: draft.id,
        chatId,
        text: '',
        sequence: 0,
        dirty: false,
        timer: null,
        flushing: null,
      });
      return { draftId: draft.id };
    } catch (error) {
      throw toKernelError(error);
    }
  });

  ctx.session.handle('chat.draft.append', async (context) => {
    const params = (context.params ?? {}) as { draftId?: unknown; text?: unknown };
    if (!ctx.hasCapability('chats.draft')) throw deny('chat.draft.append');
    const draft = getDraft(
      stringParam(params.draftId, 'draftId', 'chat.draft.append'),
      'chat.draft.append',
    );
    draft.text += stringParam(params.text, 'text', 'chat.draft.append');
    draft.dirty = true;
    scheduleFlush(draft);
    return {};
  });

  ctx.session.handle('chat.draft.commit', async (context) => {
    const params = (context.params ?? {}) as { draftId?: unknown };
    if (!ctx.hasCapability('chats.draft')) throw deny('chat.draft.commit');
    const draft = getDraft(
      stringParam(params.draftId, 'draftId', 'chat.draft.commit'),
      'chat.draft.commit',
    );
    drafts.delete(draft.draftId);
    clearTimer(draft);
    try {
      // Flush the tail first, then materialize the message server-side. The
      // commit itself is idempotent (alreadyCommitted) — a retry after a
      // lost response returns the same messageId. `dirty` covers appends
      // whose flush was still queued when the timer was cleared: their text
      // must reach the server before the commit or it would be lost.
      if (draft.flushing !== null) await draft.flushing;
      if (draft.dirty) {
        draft.sequence += 1;
        await api.patch<MessageDraft>(draftPath(draft.chatId, draft.draftId), {
          content: draft.text,
          sequence: draft.sequence,
        });
        draft.dirty = false;
      }
      const committed = await api.post<{ messageId: string }>(
        draftPath(draft.chatId, draft.draftId) + '/commit',
        {},
      );
      return { messageId: committed.messageId };
    } catch (error) {
      throw toKernelError(error);
    }
  });

  ctx.session.handle('chat.draft.abort', async (context) => {
    const params = (context.params ?? {}) as { draftId?: unknown };
    if (!ctx.hasCapability('chats.draft')) throw deny('chat.draft.abort');
    const draft = getDraft(
      stringParam(params.draftId, 'draftId', 'chat.draft.abort'),
      'chat.draft.abort',
    );
    drafts.delete(draft.draftId);
    clearTimer(draft);
    if (draft.flushing !== null) {
      await draft.flushing.catch(() => {});
    }
    await api.del(draftPath(draft.chatId, draft.draftId)).catch(() => {});
    return {};
  });
}
