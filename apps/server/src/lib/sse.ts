/**
 * Server-Sent Events helpers for streaming generation (ТЗ §4.2). Generation
 * streams over SSE; WebSocket is reserved for genuine bidirectional needs.
 */
import type { FastifyReply } from 'fastify';
import type { GenerationEvent } from '@neotavern/contracts';
import { sseSecurityHeaders } from './security.js';

/** Begin an SSE response (writes headers on the raw stream). */
export function initSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering so tokens flush immediately.
    'X-Accel-Buffering': 'no',
    // Hijacked replies bypass the app-level onSend hook, so security headers
    // are applied here (ТЗ §13).
    ...sseSecurityHeaders(),
  });
  // An unlistened 'error' on the raw socket would crash the process; client
  // disconnects are handled by each route's own 'close' listener.
  reply.raw.on('error', () => undefined);
  reply.raw.write('\n');
}

/** Write a single generation event. Returns false when the stream is dead. */
export function sendSseEvent(reply: FastifyReply, event: GenerationEvent): boolean {
  return writeSse(reply, `data: ${JSON.stringify(event)}\n\n`);
}

/** Write a comment keep-alive. Returns false when the stream is dead. */
export function sendSsePing(reply: FastifyReply): boolean {
  return writeSse(reply, ': ping\n\n');
}

/**
 * Resolve once the socket drains — or dies. Await after a write returned
 * false to honor backpressure instead of buffering without bound for slow
 * clients (ТЗ §18 streaming behavior).
 */
export function waitForDrain(reply: FastifyReply): Promise<void> {
  const raw = reply.raw;
  if (raw.destroyed || raw.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      raw.off('drain', done);
      raw.off('close', done);
      raw.off('error', done);
      resolve();
    };
    raw.once('drain', done);
    raw.once('close', done);
    raw.once('error', done);
  });
}

function writeSse(reply: FastifyReply, chunk: string): boolean {
  const raw = reply.raw;
  if (raw.destroyed || raw.writableEnded) return false;
  return raw.write(chunk);
}

export function endSse(reply: FastifyReply): void {
  if (!reply.raw.writableEnded) reply.raw.end();
}
