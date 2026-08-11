/**
 * Real-time application event channel: GET /api/v2/events (SSE).
 *
 * Browsers subscribe once and receive whitelisted app events (chat lifecycle,
 * generation lifecycle) for TanStack Query invalidation and multi-tab sync
 * (ТЗ §4.2 SSE for events, §11.1 invalidation after backend events). Only
 * events the app itself emits are forwarded; plugin-namespaced events stay
 * inside the plugin bus.
 */
import { BROWSER_APP_EVENTS, type AppEventEnvelope } from '@neotavern/contracts';
import type { EventBus } from '@neotavern/plugin-sdk';
import { initSse, sendSsePing } from '../lib/sse.js';
import type { AppContext, TypedApp } from '../types.js';

/** Events safe and useful to forward to browsers (single source: contracts). */
const STREAM_EVENTS = [
  ...BROWSER_APP_EVENTS,
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
] as const;

const KEEPALIVE_INTERVAL_MS = 25_000;

export async function registerEventStreamRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  app.get('/api/v2/events', async (_req, reply) => {
    reply.hijack();
    initSse(reply);

    // Untyped forward: payloads are passed through as opaque JSON; per-event
    // typing lives in the bus definition, not in this relay.
    const bus = ctx.events as unknown as EventBus<Record<string, unknown>>;
    const unsubscribes = STREAM_EVENTS.map((event) =>
      bus.on(event, (payload) => {
        if (reply.raw.destroyed) return;
        const envelope: AppEventEnvelope = { type: 'event', event, payload };
        reply.raw.write(`data: ${JSON.stringify(envelope)}\n\n`);
      }),
    );

    const keepAlive = setInterval(() => {
      if (!reply.raw.destroyed) sendSsePing(reply);
    }, KEEPALIVE_INTERVAL_MS);
    keepAlive.unref?.();

    const cleanup = (): void => {
      clearInterval(keepAlive);
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

    // Announce readiness so clients can distinguish open from buffering.
    reply.raw.write(`data: ${JSON.stringify({ type: 'ready', events: STREAM_EVENTS })}\n\n`);
  });
}
