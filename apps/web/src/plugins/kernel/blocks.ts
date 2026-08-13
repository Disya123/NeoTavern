/**
 * Rev4 kernel: blocks.* host handlers (contract §2).
 *
 * Message blocks let a plugin attach rich DOM panels to individual chat
 * messages. The plugin registers a renderer per `blockType`
 * (`blocks.registerRenderer`, capability `ui.messageBlock`), then attaches
 * block instances to messages (`blocks.attach`).
 *
 * Attachments are persistent (rev4 stage 4): they live in the server DB and
 * survive page reloads. The host keeps a module-level cache that
 * `MessageBubble` fills via `ensureBlocksLoaded` (one batch GET per message,
 * cached for the session) and reads via `getBlocksForMessage`;
 * `mountBlockContainers` drives the mount lifecycle: the sandbox creates the
 * clipped container (`blocks.mount`), the host tracks its geometry through
 * the v2 overlay machinery (`runtime.mountPage`) and on unmount the
 * serialized renderer state is captured (`blocks.freeze`) and persisted
 * (`PATCH /api/v2/blocks/:id`) so a reload restores it (`blocks.unfreeze`).
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { MessageBlock } from '@neotavern/contracts';
import { legacyRaw } from '../../api/backend.js';
import { ApiError } from '../../api/client.js';
import type { PluginUiRegistration } from '../runtime.js';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

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

/** Window event dispatched whenever a message's block attachments change. */
export const BLOCKS_CHANGED_EVENT = 'neotavern-plugin-blocks-changed';
/** Window event dispatched when a plugin registers a renderer (reload race). */
export const BLOCK_RENDERER_REGISTERED_EVENT = 'neotavern-plugin-renderer-registered';

/** One plugin block attached to a chat message. */
export interface BlockAttachment {
  blockId: string;
  messageId: string;
  chatId: string;
  blockType: string;
  pluginId: string;
  rendererId: string;
  descriptor: unknown;
  /** Captured by `blocks.freeze` on unmount; replayed via `blocks.unfreeze`. */
  serializedState?: unknown;
  attachedAt: number;
}

interface BlockRendererEntry {
  rendererId: string;
  blockType: string;
  title: string;
  ctx: KernelHostContext;
}

const BLOCK_CAPABILITY = 'ui.messageBlock';
const MAX_BLOCK_TYPE_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_ID_LENGTH = 200;
const MAX_RENDERER_ID_LENGTH = 4 + MAX_BLOCK_TYPE_LENGTH;
const MAX_DESCRIPTOR_JSON_BYTES = 256 * 1024;
const MAX_BLOCKS_PER_MESSAGE = 32;
const BLOCK_RPC_DEADLINE_MS = 5000;

/** pluginId → blockType → renderer entry (replaced on re-attach). */
const renderers = new Map<string, Map<string, BlockRendererEntry>>();
/** messageId → attachments in attach order (server-backed session cache). */
const attachments = new Map<string, BlockAttachment[]>();
/** `${chatId}:${messageId}` → server state already loaded into the cache. */
const loadedMessages = new Set<string>();
/** Dedupe concurrent loads of the same message. */
const inflightLoads = new Map<string, Promise<void>>();

function cacheKey(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`;
}

/**
 * Load a message's persistent attachments from the server into the cache
 * (once per session; `chat.message.block.changed` invalidates). Bubbles call
 * this on mount so blocks render after a reload.
 */
export function ensureBlocksLoaded(chatId: string, messageId: string): Promise<void> {
  const key = cacheKey(chatId, messageId);
  if (loadedMessages.has(key)) return Promise.resolve();
  const existing = inflightLoads.get(key);
  if (existing) return existing;
  const load = (async (): Promise<void> => {
    try {
      const page = await legacyRaw().request<{ items: MessageBlock[] }>(
        'GET',
        `/chats/${encodeURIComponent(chatId)}/blocks?messageIds=${encodeURIComponent(messageId)}`,
      );
      const list = page.items.map((block): BlockAttachment => ({
        blockId: block.id,
        messageId: block.messageId,
        chatId,
        blockType: block.blockType,
        pluginId: block.pluginId,
        rendererId: block.rendererId,
        descriptor: block.descriptor,
        ...(block.serializedState !== undefined ? { serializedState: block.serializedState } : {}),
        attachedAt: block.createdAt,
      }));
      attachments.set(messageId, list);
      loadedMessages.add(key);
      globalThis.dispatchEvent?.(new CustomEvent(BLOCKS_CHANGED_EVENT, { detail: { messageId } }));
    } catch {
      // Server unreachable or chat gone: keep the current cache; the next
      // change event or bubble mount retries.
    } finally {
      inflightLoads.delete(key);
    }
  })();
  inflightLoads.set(key, load);
  return load;
}

function fail(code: string, details?: Record<string, unknown>): KernelError {
  return new KernelError(code, { details });
}

function requireCapability(ctx: KernelHostContext): void {
  if (!ctx.hasCapability(BLOCK_CAPABILITY)) {
    throw fail(KernelErrorCode.CAPABILITY_DENIED, { capability: BLOCK_CAPABILITY });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function isBoundedDescriptor(descriptor: unknown): boolean {
  if (descriptor === undefined) return true;
  try {
    return JSON.stringify(descriptor).length <= MAX_DESCRIPTOR_JSON_BYTES;
  } catch {
    return false;
  }
}

/** Current block attachments of a message (empty when none). */
export function getBlocksForMessage(messageId: string): readonly BlockAttachment[] {
  const list = attachments.get(messageId);
  return list ? [...list] : [];
}

let purgeListenerInstalled = false;

/** Drop renderers/attachments of fully removed plugins (no leaks, rev4 §0). */
function ensurePurgeListener(): void {
  if (purgeListenerInstalled || typeof globalThis.addEventListener !== 'function') return;
  purgeListenerInstalled = true;
  globalThis.addEventListener('neotavern-plugin-removed', (event: Event) => {
    const detail = (event as CustomEvent<{ pluginId?: unknown }>).detail;
    const pluginId = typeof detail?.pluginId === 'string' ? detail.pluginId : null;
    if (!pluginId) return;
    renderers.delete(pluginId);
    const affected: string[] = [];
    for (const [messageId, list] of attachments) {
      const kept = list.filter((attachment) => attachment.pluginId !== pluginId);
      if (kept.length !== list.length) {
        if (kept.length === 0) attachments.delete(messageId);
        else attachments.set(messageId, kept);
        affected.push(messageId);
      }
    }
    for (const messageId of affected) {
      globalThis.dispatchEvent?.(new CustomEvent(BLOCKS_CHANGED_EVENT, { detail: { messageId } }));
    }
  });
}

/**
 * Mount every block attached to `messageId` into `rootEl` (one host container
 * div per block). Returns a cleanup that freezes renderer state back onto the
 * attachments and tears the containers down.
 *
 * When `anchorEl` is provided (and `IntersectionObserver` exists), blocks use
 * overscan: they are mounted only while the anchor intersects the viewport.
 * Leaving the viewport freezes renderer state and removes host containers;
 * returning remounts and restores the state (`blocks.unfreeze`). This is what
 * keeps long chats with many attached blocks cheap. Without `anchorEl` (or
 * without IntersectionObserver) every block stays mounted, preserving the
 * pre-overscan behavior.
 */
export function mountBlockContainers(
  messageId: string,
  rootEl: HTMLElement,
  anchorEl?: HTMLElement,
): () => void {
  const cleanups: Array<() => void> = [];
  let mounted = false;
  let observer: IntersectionObserver | null = null;
  let disposed = false;

  const mountAll = (): void => {
    if (disposed || mounted) return;
    mounted = true;
    for (const attachment of getBlocksForMessage(messageId)) {
      cleanups.push(mountOne(attachment, rootEl));
    }
  };

  const unmountAll = (): void => {
    if (!mounted) return;
    mounted = false;
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  };

  if (anchorEl && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((entries) => {
      const visible = entries[0]?.isIntersecting ?? false;
      if (visible) mountAll();
      else unmountAll();
    });
    observer.observe(anchorEl);
  } else {
    mountAll();
  }

  return () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    unmountAll();
  };
}

function mountOne(attachment: BlockAttachment, rootEl: HTMLElement): () => void {
  const container = document.createElement('div');
  container.dataset.part = 'plugin-block';
  container.dataset.blockId = attachment.blockId;
  rootEl.append(container);

  let removed = false;
  let mounted = false;
  let unmountOverlay: (() => void) | null = null;
  let unsubscribeRetry: (() => void) | null = null;
  let session: kernel.KernelSession | null = null;

  const attempt = (): void => {
    if (removed || mounted) return;
    const entry = renderers.get(attachment.pluginId)?.get(attachment.blockType);
    if (!entry || entry.ctx.session.isDisposed || !entry.ctx.hasCapability(BLOCK_CAPABILITY)) {
      // Renderer gone or not yet registered (reload race, rev4 stage 4):
      // keep the empty slot and retry in place when it appears — no RPCs,
      // no freeze, no remount storm.
      if (unsubscribeRetry === null) {
        const onRegistered = (event: Event): void => {
          const detail = (event as CustomEvent<{ pluginId?: unknown; blockType?: unknown }>).detail;
          if (
            detail?.pluginId !== attachment.pluginId ||
            detail?.blockType !== attachment.blockType
          ) {
            return;
          }
          unsubscribeRetry?.();
          unsubscribeRetry = null;
          attempt();
        };
        globalThis.addEventListener(BLOCK_RENDERER_REGISTERED_EVENT, onRegistered);
        unsubscribeRetry = () =>
          globalThis.removeEventListener(BLOCK_RENDERER_REGISTERED_EVENT, onRegistered);
      }
      return;
    }
    mounted = true;
    unsubscribeRetry?.();
    unsubscribeRetry = null;
    session = entry.ctx.session;
    const { runtime } = entry.ctx;
    void (async (): Promise<void> => {
      try {
        // The sandbox must own its container before the first layout publish
        // runs, so the mount RPC goes out first and overlay tracking starts
        // only after the sandbox container exists.
        await session.call(
          'blocks.mount',
          {
            rendererId: attachment.rendererId,
            blockId: attachment.blockId,
            descriptor: attachment.descriptor,
          },
          { deadlineMs: BLOCK_RPC_DEADLINE_MS },
        );
        if (removed || session.isDisposed) return;
        if (attachment.serializedState !== undefined) {
          await session
            .call(
              'blocks.unfreeze',
              { blockId: attachment.blockId, state: attachment.serializedState },
              { deadlineMs: BLOCK_RPC_DEADLINE_MS },
            )
            .catch(() => undefined);
          if (removed || session.isDisposed) return;
        }
        const registration: PluginUiRegistration = {
          pluginId: attachment.pluginId,
          pluginName: entry.ctx.frame.plugin.name,
          registrationId: attachment.blockId,
          kind: 'messageBlocks',
          definition: { id: attachment.blockType, title: entry.title },
        };
        unmountOverlay = runtime.mountPage(registration, container);
      } catch {
        // Degraded: the host container stays empty (rev4 §0 explicit degradation).
      }
    })();
  };

  attempt();

  return () => {
    if (removed) return;
    removed = true;
    unsubscribeRetry?.();
    unsubscribeRetry = null;
    if (!mounted) {
      container.remove();
      return;
    }
    // Freeze only runs for a block that was actually mounted (rev4 stage 4):
    // never clobbers server state with a stale DOM — unmounts happen on
    // overscan/chat switches, not on attach/registration churn.
    void (async (): Promise<void> => {
      try {
        const result = (await session?.call(
          'blocks.freeze',
          { blockId: attachment.blockId },
          { deadlineMs: BLOCK_RPC_DEADLINE_MS },
        )) as { serializedState?: unknown } | null;
        if (result && typeof result === 'object' && 'serializedState' in result) {
          attachment.serializedState = result.serializedState;
          // Persist the frozen state: a reload must remount the block with
          // the same renderer state. Best-effort — the cache already has it.
          void legacyRaw()
            .request<MessageBlock>('PATCH', `/blocks/${encodeURIComponent(attachment.blockId)}`, {
              serializedState: result.serializedState,
            })
            .catch(() => undefined);
        }
      } catch {
        // Plugin gone or crashed: serialized state is lost, container still torn down.
      }
      container.remove();
      unmountOverlay?.();
    })();
  };
}

export function attachBlocks(ctx: KernelHostContext): void {
  ensurePurgeListener();

  // Cross-tab sync (rev4 stage 4): when any client changes a message's
  // blocks, drop the session cache entry and reload from the server so this
  // tab remounts with the fresh state.
  const unsubscribeChanged = ctx.runtime.onAppEvent('chat.message.block.changed', (payload) => {
    const detail = payload as { chatId?: unknown; messageId?: unknown };
    if (typeof detail.chatId !== 'string' || typeof detail.messageId !== 'string') return;
    loadedMessages.delete(cacheKey(detail.chatId, detail.messageId));
    void ensureBlocksLoaded(detail.chatId, detail.messageId);
  });
  ctx.session.scope.track({ dispose: () => unsubscribeChanged() });

  ctx.session.handle('blocks.registerRenderer', (request) => {
    requireCapability(ctx);
    const params = asRecord(request.params);
    const blockType = boundedString(params?.blockType, MAX_BLOCK_TYPE_LENGTH);
    const title = boundedString(params?.title, MAX_TITLE_LENGTH);
    if (!blockType || !title) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, {
        method: 'blocks.registerRenderer',
        reason: 'invalid-params',
      });
    }
    let byPlugin = renderers.get(ctx.pluginId);
    if (!byPlugin) {
      byPlugin = new Map();
      renderers.set(ctx.pluginId, byPlugin);
    }
    if (byPlugin.has(blockType)) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, {
        method: 'blocks.registerRenderer',
        reason: 'duplicate-block-type',
        blockType,
      });
    }
    const rendererId = `blk:${blockType}`;
    const registration: PluginUiRegistration = {
      pluginId: ctx.pluginId,
      pluginName: ctx.frame.plugin.name,
      registrationId: rendererId,
      kind: 'messageBlocks',
      definition: { id: blockType, title },
    };
    ctx.runtime.kernelAddRegistration(registration);
    byPlugin.set(blockType, { rendererId, blockType, title, ctx });
    // Reload race (rev4 stage 4): attachments load from the server before
    // this plugin re-registers its renderers; empty block slots retry in
    // place when the renderer appears (mountOne subscribes to this event).
    globalThis.dispatchEvent?.(
      new CustomEvent(BLOCK_RENDERER_REGISTERED_EVENT, {
        detail: { pluginId: ctx.pluginId, blockType },
      }),
    );
    return { rendererId };
  });

  ctx.session.handle('blocks.unregisterRenderer', (request) => {
    requireCapability(ctx);
    const params = asRecord(request.params);
    const rendererId = boundedString(params?.rendererId, MAX_RENDERER_ID_LENGTH);
    const byPlugin = renderers.get(ctx.pluginId);
    const entry = rendererId
      ? [...(byPlugin?.values() ?? [])].find((value) => value.rendererId === rendererId)
      : undefined;
    if (!entry || !byPlugin) return {};
    byPlugin.delete(entry.blockType);
    ctx.runtime.kernelRemoveRegistration(entry.rendererId);
    return {};
  });

  ctx.session.handle('blocks.attach', async (request) => {
    requireCapability(ctx);
    const params = asRecord(request.params);
    const messageId = boundedString(params?.messageId, MAX_MESSAGE_ID_LENGTH);
    const blockType = boundedString(params?.blockType, MAX_BLOCK_TYPE_LENGTH);
    if (!messageId || !blockType) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, {
        method: 'blocks.attach',
        reason: 'invalid-params',
      });
    }
    const entry = renderers.get(ctx.pluginId)?.get(blockType);
    if (!entry) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, {
        method: 'blocks.attach',
        reason: 'unknown-block-type',
        blockType,
      });
    }
    const descriptor = params?.descriptor;
    if (!isBoundedDescriptor(descriptor)) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, {
        method: 'blocks.attach',
        reason: 'descriptor-too-large',
      });
    }
    const chatId = ctx.currentChatId();
    if (!chatId) {
      throw fail(KernelErrorCode.NOT_FOUND, {
        method: 'blocks.attach',
        reason: 'no-current-chat',
      });
    }
    const list = attachments.get(messageId) ?? [];
    if (list.length >= MAX_BLOCKS_PER_MESSAGE) {
      throw fail(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
        messageId,
        limit: MAX_BLOCKS_PER_MESSAGE,
      });
    }
    // The attachment is durable data (rev4 stage 4): persist first, then
    // update the session cache. The server rejects messages outside the
    // current chat with MESSAGE_NOT_FOUND.
    let created: MessageBlock;
    try {
      created = await legacyRaw().request<MessageBlock>(
        'POST',
        `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/blocks`,
        {
          blockType,
          rendererId: entry.rendererId,
          pluginId: ctx.pluginId,
          descriptor,
        },
      );
    } catch (error) {
      throw toKernelError(error);
    }
    const attachment: BlockAttachment = {
      blockId: created.id,
      messageId,
      chatId,
      blockType,
      pluginId: ctx.pluginId,
      rendererId: entry.rendererId,
      descriptor,
      attachedAt: created.createdAt,
    };
    list.push(attachment);
    attachments.set(messageId, list);
    loadedMessages.add(cacheKey(chatId, messageId));
    globalThis.dispatchEvent?.(new CustomEvent(BLOCKS_CHANGED_EVENT, { detail: { messageId } }));
    return { blockId: attachment.blockId };
  });
}
