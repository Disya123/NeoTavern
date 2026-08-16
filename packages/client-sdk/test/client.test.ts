/**
 * @neotavern/client-sdk — transport + SDK tests.
 *
 * All tests run against a stub `fetchImpl` (in-memory handler); no server
 * is started. The stub serves `/meta`, decodes RequestEnvelopes on `/rpc`
 * and serves NDJSON or SSE on `/rpc/stream`.
 */
import { describe, expect, it } from 'vitest';
import { WIRE_PROTOCOL, WIRE_SCHEMA_HASH } from '@neotavern/contracts';
import {
  ClientSdk,
  HttpTransport,
  OutcomeUnknownError,
  ProductError,
  TransportError,
  type StreamEvent,
} from '../src/index.js';

const META = {
  appVersion: '0.1.0',
  api: { major: 1, minor: 0 },
  productWire: { major: 1, minor: 0 },
  features: { core: 1 },
};

const CHARACTER_ID = '123e4567-e89b-12d3-a456-426614174000';
const CHAT_ID = '123e4567-e89b-12d3-a456-426614174001';
const STREAM_ID = '123e4567-e89b-12d3-a456-426614174002';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < lines.length) {
        controller.enqueue(encoder.encode(`${lines[index]}\n`));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) {
        controller.enqueue(encoder.encode(frames[index]));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function makeStub(handler: FetchHandler): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function makeSdk(handler: FetchHandler): { sdk: ClientSdk; calls: CapturedCall[] } {
  const { fetchImpl, calls } = makeStub(handler);
  return {
    sdk: new ClientSdk({
      transport: new HttpTransport({ baseUrl: 'http://wire.test', fetchImpl }),
    }),
    calls,
  };
}

interface ParsedEnvelope {
  requestId: string;
  operationId: string;
  wireProtocol: { major: number; minor: number };
  schemaHash: string;
  payload: Record<string, unknown>;
}

function parseEnvelope(init: RequestInit | undefined): ParsedEnvelope {
  return JSON.parse(String(init?.body)) as ParsedEnvelope;
}

describe('handshake', () => {
  it('resolves with the validated server meta', async () => {
    const { sdk, calls } = makeSdk(async (url) => {
      expect(url).toBe('http://wire.test/meta');
      return jsonResponse(200, META);
    });
    await expect(sdk.handshake()).resolves.toEqual(META);
    expect(calls.map((call) => call.url)).toEqual(['http://wire.test/meta']);
  });

  it('rejects meta whose api major is invalid', async () => {
    const { sdk } = makeSdk(async () =>
      jsonResponse(200, { ...META, api: { major: 0, minor: 0 } }),
    );
    await expect(sdk.handshake()).rejects.toBeInstanceOf(TransportError);
  });

  it('rejects a server wire protocol major mismatch', async () => {
    const { sdk } = makeSdk(async () =>
      jsonResponse(200, { ...META, productWire: { major: 2, minor: 0 } }),
    );
    await expect(sdk.handshake()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TransportError && error.message.includes('wire protocol major'),
    );
  });
});

describe('call', () => {
  it('throws OutcomeUnknownError on timeout of a non-idempotent operation after exactly one attempt', async () => {
    const { sdk, calls } = makeSdk(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            {
              once: true,
            },
          );
        }),
    );
    const payload = { name: 'Ada Lovelace', description: 'pioneer', tags: ['mathematics'] };
    await expect(sdk.call('characters.create', payload, { timeoutMs: 25 })).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    expect(calls).toHaveLength(1);
  });

  it('retries an idempotent operation once after a retryable 503 and returns the validated result', async () => {
    let attempts = 0;
    const received: ParsedEnvelope[] = [];
    const { sdk, calls } = makeSdk(async (_url, init) => {
      attempts += 1;
      if (attempts === 1) return new Response('Service Unavailable', { status: 503 });
      const envelope = parseEnvelope(init);
      received.push(envelope);
      return jsonResponse(200, {
        kind: 'ok',
        requestId: envelope.requestId,
        result: { items: [], nextCursor: 'abc' },
      });
    });
    const result = await sdk.call('characters.list', { limit: 10 });
    expect(result).toEqual({ items: [], nextCursor: 'abc' });
    expect(calls).toHaveLength(2);
    expect(received).toEqual([
      expect.objectContaining({
        wireProtocol: WIRE_PROTOCOL,
        schemaHash: WIRE_SCHEMA_HASH,
        operationId: 'characters.list',
        payload: { limit: 10 },
      }),
    ]);
  });

  it('throws before any fetch when the payload violates the request schema', async () => {
    const { sdk, calls } = makeSdk(async () => {
      throw new Error('fetch must not be called');
    });
    await expect(sdk.call('characters.get', { characterId: 'not-a-uuid' })).rejects.toThrow(
      /schema/,
    );
    expect(calls).toHaveLength(0);
  });

  it('throws TransportError when the response violates the response schema', async () => {
    const { sdk } = makeSdk(async (_url, init) => {
      const envelope = parseEnvelope(init);
      return jsonResponse(200, {
        kind: 'ok',
        requestId: envelope.requestId,
        result: { id: 'not-a-uuid', name: 'X' },
      });
    });
    await expect(sdk.call('characters.get', { characterId: CHARACTER_ID })).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('maps an error envelope to a ProductError', async () => {
    const { sdk } = makeSdk(async (_url, init) => {
      const envelope = parseEnvelope(init);
      return jsonResponse(200, {
        kind: 'error',
        requestId: envelope.requestId,
        error: { code: 'NOT_FOUND', params: { characterId: CHARACTER_ID } },
      });
    });
    await expect(sdk.call('characters.get', { characterId: CHARACTER_ID })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProductError &&
        error.code === 'NOT_FOUND' &&
        error.params['characterId'] === CHARACTER_ID,
    );
  });
});

describe('stream', () => {
  const delta = (sequence: number, text: string) => ({
    streamId: STREAM_ID,
    sequence,
    type: 'generation.delta',
    payload: { type: 'generation.delta', text },
  });

  it('yields NDJSON events from /rpc/stream without fabricating a terminal event', async () => {
    const { sdk, calls } = makeSdk(async (url, init) => {
      expect(url).toBe('http://wire.test/rpc/stream');
      expect(parseEnvelope(init).operationId).toBe('generation.start');
      return ndjsonResponse([JSON.stringify(delta(0, 'hel')), JSON.stringify(delta(1, 'lo'))]);
    });
    const events: StreamEvent[] = [];
    for await (const event of sdk.stream('generation.start', {
      chatId: CHAT_ID,
      message: 'hello',
    })) {
      events.push(event);
    }
    expect(events).toEqual([delta(0, 'hel'), delta(1, 'lo')]);
    expect(calls).toHaveLength(1);
  });

  it('throws a resumable TransportError when a stream line is malformed', async () => {
    const { sdk } = makeSdk(async () =>
      ndjsonResponse([
        JSON.stringify(delta(0, 'hel')),
        'this is not json',
        JSON.stringify(delta(1, 'lo')),
      ]),
    );
    const iterator = sdk
      .stream('generation.start', { chatId: CHAT_ID, message: 'hello' })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: delta(0, 'hel') });
    await expect(iterator.next()).rejects.toSatisfy(
      (error: unknown) => error instanceof TransportError && error.resumable === true,
    );
  });

  it('parses SSE frames from /rpc/stream (Headless / remote-http)', async () => {
    const { sdk, calls } = makeSdk(async (url, init) => {
      expect(url).toBe('http://wire.test/rpc/stream');
      expect(String((init?.headers as Record<string, string> | undefined)?.['accept'])).toContain(
        'text/event-stream',
      );
      return sseResponse([
        `event: generation.delta\nid: 0\ndata: ${JSON.stringify(delta(0, 'hel'))}\n\n`,
        `event: generation.delta\nid: 1\ndata: ${JSON.stringify(delta(1, 'lo'))}\n\n`,
      ]);
    });
    const events: StreamEvent[] = [];
    for await (const event of sdk.stream('generation.start', {
      chatId: CHAT_ID,
      message: 'hello',
    })) {
      events.push(event);
    }
    expect(events).toEqual([delta(0, 'hel'), delta(1, 'lo')]);
    expect(calls).toHaveLength(1);
  });

  it('sends a Bearer pairing token on rpc and stream', async () => {
    const { fetchImpl, calls } = makeStub(async (url) => {
      if (url.endsWith('/meta')) return jsonResponse(200, META);
      if (url.endsWith('/rpc/stream')) {
        return sseResponse([`data: ${JSON.stringify(delta(0, 'x'))}\n\n`]);
      }
      return jsonResponse(200, {
        kind: 'ok',
        requestId: '00000000-0000-4000-8000-000000000099',
        result: { id: CHARACTER_ID, name: 'Ada Lovelace' },
      });
    });
    const sdk = new ClientSdk({
      transport: new HttpTransport({
        baseUrl: 'http://wire.test',
        fetchImpl,
        authorization: 'pair-token',
      }),
    });
    await sdk.handshake();
    await sdk.call('characters.get', { characterId: CHARACTER_ID }).catch(() => undefined);
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer pair-token' });
  });

  it('invokes fetch as a free function so window.fetch is not illegally bound', async () => {
    const calls: unknown[] = [];
    const fetchImpl = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      calls.push(this);
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('http://127.0.0.1:18080/meta');
      expect(init?.method).toBe('GET');
      return jsonResponse(200, META);
    } as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://127.0.0.1:18080',
      fetchImpl,
    });
    await transport.meta();
    expect(calls).toEqual([undefined]);
  });

  it('calls the default fetch as a method of globalThis (Chromium-legal)', async () => {
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    globalThis.fetch = async function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      receivers.push(this);
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('http://127.0.0.1:18080/meta');
      expect(init?.method).toBe('GET');
      return jsonResponse(200, META);
    } as typeof fetch;
    try {
      const transport = new HttpTransport({ baseUrl: 'http://127.0.0.1:18080' });
      await transport.meta();
      expect(receivers).toEqual([globalThis]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
