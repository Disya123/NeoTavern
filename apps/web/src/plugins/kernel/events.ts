/**
 * Rev4 kernel: events.* host handlers (contract §2, §J1).
 *
 * The events slice gives a sandboxed plugin a kernel-port subscription to
 * whitelisted app events, distinct from the legacy v2 postMessage bus
 * (`runtime.ts` `neotavern.plugin.event.subscribe` path). The host relays app-bus
 * events it already intercepts (`runtime.onAppEvent`, the same host-side
 * channel the jobs slice uses) and delivers each subscribed event as an
 * `evt.emit` envelope on the session port.
 *
 * §J1 cursor/replay + backpressure (the async-iterator surface):
 * - every app event is retained in a bounded ring buffer before listener
 *   dispatch (`runtime.recordAppEvent`); `events.subscribe {event, cursor}`
 *   replays the retained events after the cursor, then continues live —
 *   a re-subscribed consumer recovers exactly what it missed, at-least-once;
 * - each `evt.emit` carries `cursor` (`"<event>:<seq>"`, the stable dedupe
 *   key) and the host tracks delivered-but-unacked sequences per
 *   subscription; `events.ack {event, sequence}` confirms handling and
 *   delivery pauses at `maxInFlight` (default 64) until acks arrive —
 *   a slow consumer cannot grow host memory (the ring buffer is the bound);
 * - cursors outside the retained window are rejected with
 *   `EVENT_CURSOR_EXPIRED` (explicit degradation, rev4 §0 invariant 8);
 *   future cursors are VALIDATION_FAILED;
 * - `window.background.changed` is host-generated (rev4 §J3) and bypasses
 *   this relay — the windows slice pushes it directly.
 *
 * Gates, mirroring the legacy bus and backendHost.ts:
 * - the event name must be on the allowlist (events the app itself streams
 *   over `/api/v2/events`); anything else is VALIDATION_FAILED;
 * - events carrying chat content (generation.*, chat.message.*) additionally
 *   require the `chats.read.current` capability — subscribing to them without
 *   it is CAPABILITY_DENIED, and a revoked grant stops delivery at emit time.
 *
 * Subscriptions live in the session scope, so frame reset / session dispose
 * cannot leak host-side listeners (rev4 §0 invariant 6).
 */
import { BROWSER_APP_EVENTS } from '@neotavern/contracts';
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

/** Max event name length (matches the legacy bus cap). */
const MAX_EVENT_NAME_LENGTH = 200;
/** Default per-subscription in-flight (delivered, not acked) cap. */
const DEFAULT_MAX_IN_FLIGHT = 64;
const MAX_IN_FLIGHT_LIMIT = 256;

/**
 * Events the kernel slice may relay. Source of truth is the SSE stream
 * whitelist (apps/server/src/plugins/events.ts STREAM_EVENTS) — the plugin
 * can only ever receive events the app itself streams to browsers.
 */
const ALLOWED_EVENTS = new Set<string>([
  ...BROWSER_APP_EVENTS,
  'plugin.capability.revoked',
  'plugin.job.due',
  'plugin.chat.updated',
  'plugin.chat.message',
  'plugin.auth.connected',
  'plugin.auth.revoked',
  'plugin.auth.expired',
  'chat.message.block.changed',
]);

/**
 * App events carrying chat content. Mirror of CHAT_CONTENT_EVENTS in
 * runtime.ts and backendHost.ts — they require the `chats.read.current`
 * capability (rev4 §E1 gate).
 */
const CHAT_CONTENT_EVENTS = new Set<string>([
  'generation.started',
  'generation.delta',
  'generation.finished',
  'generation.error',
  'chat.message.created',
  'chat.message.updated',
  'chat.message.deleted',
]);

interface Subscription {
  event: string;
  /** Highest delivered sequence (replay resumes after it). */
  lastDeliveredSeq: number;
  /** Delivered but not yet acked sequences (bounded by maxInFlight). */
  pending: Set<number>;
  maxInFlight: number;
  paused: boolean;
}

function fail(code: string, details?: Record<string, unknown>): KernelError {
  return new KernelError(code, { details });
}

function cursorOf(event: string, seq: number): string {
  return `${event}:${seq}`;
}

/** Parse `"<event>:<seq>"`; null when malformed. */
function parseCursor(event: string, cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const prefix = `${event}:`;
  if (!cursor.startsWith(prefix)) return null;
  const seqText = cursor.slice(prefix.length);
  if (!/^\d+$/.test(seqText)) return null;
  const seq = Number(seqText);
  return Number.isSafeInteger(seq) ? seq : null;
}

export function attachEvents(ctx: KernelHostContext): void {
  const { session } = ctx;

  /** event → runtime.onAppEvent unsubscribe; registered on first subscribe. */
  const relays = new Map<string, () => void>();
  /** One subscription per event per session (legacy shape: the sandbox's
   *  callback registrations share one host subscription). */
  const subscriptions = new Map<string, Subscription>();

  const deliver = (sub: Subscription): void => {
    if (sub.paused) return;
    const window = ctx.runtime.kernelAppEventHistoryAfter(sub.event, sub.lastDeliveredSeq);
    for (const record of window.records) {
      if (sub.pending.size >= sub.maxInFlight) {
        sub.paused = true;
        return;
      }
      if (sub.pending.has(record.seq)) continue; // idempotent resume
      sub.lastDeliveredSeq = record.seq;
      sub.pending.add(record.seq);
      session.emitEvent(sub.event, record.payload, cursorOf(sub.event, record.seq));
    }
  };

  const relay = (event: string): void => {
    const unsubscribe = ctx.runtime.onAppEvent(event, () => {
      if (CHAT_CONTENT_EVENTS.has(event) && !ctx.hasCapability('chats.read.current')) {
        return;
      }
      const sub = subscriptions.get(event);
      if (sub) deliver(sub);
    });
    relays.set(event, unsubscribe);
    session.scope.track({ dispose: unsubscribe });
  };

  const removeSubscription = (event: string): void => {
    subscriptions.delete(event);
    const unsubscribe = relays.get(event);
    if (unsubscribe) {
      unsubscribe();
      relays.delete(event);
    }
  };

  session.handle('events.subscribe', (request) => {
    const params =
      typeof request.params === 'object' && request.params !== null
        ? (request.params as Record<string, unknown>)
        : {};
    const event = params['event'];
    if (typeof event !== 'string' || event.length === 0 || event.length > MAX_EVENT_NAME_LENGTH) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, {
        method: 'events.subscribe',
        reason: 'invalid-event-name',
      });
    }
    if (!ALLOWED_EVENTS.has(event)) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, {
        method: 'events.subscribe',
        reason: 'event-not-allowed',
        event,
      });
    }
    if (CHAT_CONTENT_EVENTS.has(event) && !ctx.hasCapability('chats.read.current')) {
      throw fail(KernelErrorCode.CAPABILITY_DENIED, { capability: 'chats.read.current' });
    }

    let maxInFlight = DEFAULT_MAX_IN_FLIGHT;
    if (params['maxInFlight'] !== undefined) {
      const value = params['maxInFlight'];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw fail(KernelErrorCode.VALIDATION_FAILED, {
          method: 'events.subscribe',
          reason: 'invalid-max-in-flight',
        });
      }
      maxInFlight = Math.min(value, MAX_IN_FLIGHT_LIMIT);
    }

    let existing = subscriptions.get(event);
    const cursor = params['cursor'];
    if (cursor !== undefined) {
      const seq = parseCursor(event, cursor);
      if (seq === null) {
        throw fail(KernelErrorCode.VALIDATION_FAILED, {
          method: 'events.subscribe',
          reason: 'invalid-cursor',
          event,
        });
      }
      const window = ctx.runtime.kernelAppEventHistoryAfter(event, seq);
      if (window.headSeq !== null && seq > window.headSeq) {
        throw fail(KernelErrorCode.VALIDATION_FAILED, {
          method: 'events.subscribe',
          reason: 'future-cursor',
          event,
          cursor,
        });
      }
      if (window.lowestSeq !== null && seq < window.lowestSeq - 1) {
        throw fail(KernelErrorCode.EVENT_CURSOR_EXPIRED, {
          method: 'events.subscribe',
          reason: 'cursor-expired',
          event,
          cursor,
          retainedFrom: window.lowestSeq,
        });
      }
      // Resume at the cursor (at-least-once reconnect): drop delivery state
      // and replay what the consumer missed.
      existing = { event, lastDeliveredSeq: seq, pending: new Set(), maxInFlight, paused: false };
      subscriptions.set(event, existing);
    } else if (!existing) {
      // Fresh subscription: live from now — skip everything already retained
      // (cursor-less re-subscribes never replay the past; at-least-once
      // recovery is explicit via `cursor`).
      const head = ctx.runtime.kernelAppEventHistoryAfter(event, 0).headSeq ?? 0;
      existing = { event, lastDeliveredSeq: head, pending: new Set(), maxInFlight, paused: false };
      subscriptions.set(event, existing);
    }

    if (!relays.has(event)) relay(event);
    deliver(existing);
    return {};
  });

  session.handle('events.ack', (request) => {
    const params =
      typeof request.params === 'object' && request.params !== null
        ? (request.params as Record<string, unknown>)
        : {};
    const event = params['event'];
    const sequence = params['sequence'];
    if (typeof event !== 'string' || typeof sequence !== 'number') return {};
    const sub = subscriptions.get(event);
    if (!sub) return {}; // idempotent: subscription already gone
    if (!sub.pending.delete(sequence)) return {}; // idempotent: already acked
    if (sub.paused && sub.pending.size < sub.maxInFlight) {
      sub.paused = false;
      deliver(sub);
    }
    return {};
  });

  session.handle('events.unsubscribe', (request) => {
    const params =
      typeof request.params === 'object' && request.params !== null
        ? (request.params as Record<string, unknown>)
        : {};
    const event = params['event'];
    if (typeof event !== 'string') return {};
    removeSubscription(event);
    return {};
  });
}
