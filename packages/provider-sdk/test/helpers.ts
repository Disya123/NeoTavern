/** Shared test helpers for provider adapter suites (DUP-26). */
import type { GenerationEvent, GenerationRequest } from '@neotavern/contracts';

/** Single-chunk byte stream, used to feed SSE payloads into adapters. */
export function streamFromString(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Drain an adapter's event stream into an array. */
export async function collect(events: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Canonical streaming request; spread local overrides where a test needs drift. */
export const baseRequest: GenerationRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'The story begins' }],
  maxTokens: 64,
  temperature: 0.8,
  stream: true,
};
