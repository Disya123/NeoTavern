/**
 * NeoBackend facade tests (ТЗ §15): Local/Remote parity, local kernel
 * validation, and LegacyBackend mapping. No server is started — the local
 * transport is faked and the remote transport runs over a stub fetch.
 */
import { describe, expect, it } from 'vitest';
import {
  WIRE_SCHEMA_HASH,
  type CharacterDto,
  type GenerationRunDto,
  type MetaDto,
  type PagedCharactersDto,
  type PagedGenerationEventsDto,
  type WireGenerationEvent,
} from '@neotavern/contracts';
import { ClientSdk, HttpTransport, ProductError, type StreamEvent } from '@neotavern/client-sdk';
import {
  ContractMismatchError,
  LegacyBackend,
  LocalBackend,
  RemoteBackend,
  UnsupportedError,
  ValidationError,
  type LocalCallResult,
  type LocalTransport,
} from '../src/index.js';

const CHARACTER: CharacterDto = {
  id: '9f8e7d6c-5b4a-4932-81f0-123456789abc',
  name: 'Ada Lovelace',
  description: 'First programmer; canonical fixture.',
  tags: ['scientist', 'pioneer'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const PAGED_CHARACTERS: PagedCharactersDto = {
  items: [CHARACTER],
  nextCursor: 'page-2',
};

const META: MetaDto = {
  appVersion: '0.1.0',
  api: { major: 2, minor: 0 },
  productWire: { major: 1, minor: 0 },
  features: { core: 1 },
};

// --- Canonical generation fixtures (ТЗ §62–64, Phase 6). ---
const RUN_ID = '6f5e4d3c-2b1a-4f0e-9d8c-7a6b5c4d3e2f';
const CHAT_ID = '01234567-89ab-4cde-8f01-23456789abcd';
const MESSAGE_ID = '12345678-90ab-4cde-8f01-23456789abcd';
const TIMESTAMP = '2026-06-01T12:00:00.000Z';

const GENERATION_RUN: GenerationRunDto = {
  runId: RUN_ID,
  chatId: CHAT_ID,
  attempt: 2,
  status: 'completed',
  provider: 'fake',
  model: 'steps=4',
  revision: 12,
  lastEventSequence: 9,
  partialTextLength: 0,
  partialTruncated: false,
  messageId: MESSAGE_ID,
  startedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

/** `generation.keep` response: run kept as a final assistant message. */
const KEEP_RUN: GenerationRunDto = { ...GENERATION_RUN, status: 'failed' };

/** `generation.discard` response: partial output dropped. */
const DISCARD_RUN: GenerationRunDto = { ...GENERATION_RUN, status: 'interrupted' };

/** `generation.events` response: canonical event page. */
const GENERATION_EVENTS: PagedGenerationEventsDto = {
  items: [
    {
      streamId: RUN_ID,
      sequence: 0,
      type: 'generation.delta',
      payload: { type: 'generation.delta', text: 'Hello' },
    },
    {
      streamId: RUN_ID,
      sequence: 1,
      type: 'generation.checkpoint',
      payload: { type: 'generation.checkpoint', sequence: 1, partialLength: 5 },
    },
  ],
  hasMore: false,
};

const FINAL_MESSAGE = {
  id: MESSAGE_ID,
  chatId: CHAT_ID,
  role: 'assistant',
  content: 'Attempt two: hello world.',
  createdAt: '2026-06-02T10:00:00.000Z',
  sequence: 0,
  generationRunId: RUN_ID,
};

/** Events streamed by `generation.start` / `generation.retry` (identical on both transports). */
const GENERATION_STREAM_EVENTS: WireGenerationEvent[] = [
  { type: 'generation.delta', text: 'Attempt two: hello ' },
  { type: 'generation.delta', text: 'world.' },
  { type: 'generation.checkpoint', sequence: 1, partialLength: 21 },
  { type: 'generation.completed', finalMessage: FINAL_MESSAGE },
];

/** In-process kernel transport returning canned canonical wire values. */
class FakeKernelTransport implements LocalTransport {
  calls = 0;

  async call(
    operationId: string,
    _payload: unknown,
    _opts: { signal?: AbortSignal },
  ): Promise<LocalCallResult> {
    this.calls += 1;
    switch (operationId) {
      case 'characters.list':
        return { ok: true, value: PAGED_CHARACTERS };
      case 'generation.get':
        return { ok: true, value: GENERATION_RUN };
      case 'generation.events':
        return { ok: true, value: GENERATION_EVENTS };
      case 'generation.keep':
        return { ok: true, value: KEEP_RUN };
      case 'generation.discard':
        return { ok: true, value: DISCARD_RUN };
      default:
        return { ok: false, error: { code: 'NOT_FOUND', params: {}, traceId: 'kernel-trace' } };
    }
  }

  async *stream(
    operationId: string,
    _payload: unknown,
    _opts: { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent> {
    if (operationId === 'generation.start' || operationId === 'generation.retry') {
      for (const [index, event] of GENERATION_STREAM_EVENTS.entries()) {
        yield { streamId: RUN_ID, sequence: index, type: event.type, payload: event };
      }
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Canonical `POST /rpc` result for an operation (null when not stubbed). */
function rpcResult(operationId: string | undefined): unknown {
  switch (operationId) {
    case 'characters.list':
      return PAGED_CHARACTERS;
    case 'generation.get':
      return GENERATION_RUN;
    case 'generation.events':
      return GENERATION_EVENTS;
    case 'generation.keep':
      return KEEP_RUN;
    case 'generation.discard':
      return DISCARD_RUN;
    default:
      return null;
  }
}

/**
 * Stub fetch serving the ClientSdk HttpTransport surface: `GET /meta` for the
 * handshake, `POST /rpc` with a canonical RequestEnvelope → ResponseEnvelope,
 * and `POST /stream` with NDJSON event envelopes for streaming operations.
 */
class StubFetch {
  readonly rpcRequests: Array<{ operationId: string; requestId: string }> = [];

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(url).pathname;
    if (pathname === '/meta') {
      return jsonResponse(META);
    }
    const envelope = JSON.parse(String(init?.body ?? '{}')) as {
      operationId?: string;
      requestId?: string;
      payload?: unknown;
    };
    if (pathname === '/stream') {
      if (envelope.operationId === 'generation.start' || envelope.operationId === 'generation.retry') {
        const body = GENERATION_STREAM_EVENTS.map(
          (event, index) =>
            JSON.stringify({ streamId: RUN_ID, sequence: index, type: event.type, payload: event }),
        ).join('\n');
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      return jsonResponse({ code: 'INTERNAL', params: {}, traceId: 'stub' }, 404);
    }
    if (pathname === '/rpc') {
      this.rpcRequests.push({
        operationId: envelope.operationId ?? '',
        requestId: envelope.requestId ?? '',
      });
      return jsonResponse({
        kind: 'ok',
        requestId: envelope.requestId ?? 'missing',
        result: rpcResult(envelope.operationId),
      });
    }
    return jsonResponse({ code: 'INTERNAL', params: {}, traceId: 'stub' }, 404);
  };
}

function makeRemoteBackend(): RemoteBackend {
  return new RemoteBackend({
    sdk: new ClientSdk({
      transport: new HttpTransport({ baseUrl: 'http://stub.local', fetchImpl: stub.handle }),
    }),
  });
}

const stub = new StubFetch();

describe('Local vs Remote parity', () => {
  it('characters.list returns deep-equal canonical DTOs from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.characters.list({ limit: 10 }),
      remote.characters.list({ limit: 10 }),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(PAGED_CHARACTERS);
  });

  it('remote handshake surfaces validated MetaDto', async () => {
    const remote = makeRemoteBackend();
    await expect(remote.meta()).resolves.toEqual(META);
  });
});

describe('Generation Local vs Remote parity (Phase 6)', () => {
  it('generation.get returns deep-equal canonical GenerationRunDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.generation.get(RUN_ID),
      remote.generation.get(RUN_ID),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(GENERATION_RUN);
  });

  it('generation.events returns deep-equal canonical PagedGenerationEventsDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const req = { workflowId: RUN_ID, afterSequence: -1, limit: 50 };
    const [localResult, remoteResult] = await Promise.all([
      local.generation.events(req),
      remote.generation.events(req),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(GENERATION_EVENTS);
  });

  it('generation.keep returns deep-equal canonical GenerationRunDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.generation.keep(RUN_ID),
      remote.generation.keep(RUN_ID),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(KEEP_RUN);
  });

  it('generation.discard returns deep-equal canonical GenerationRunDto from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const [localResult, remoteResult] = await Promise.all([
      local.generation.discard(RUN_ID),
      remote.generation.discard(RUN_ID),
    ]);

    expect(localResult).toEqual(remoteResult);
    expect(localResult).toEqual(DISCARD_RUN);
  });

  it('generation.start streams the same canonical events from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();
    const req = { chatId: CHAT_ID, message: 'Hello there' };

    const localEvents: WireGenerationEvent[] = [];
    for await (const event of local.generation.start(req)) {
      localEvents.push(event);
    }
    const remoteEvents: WireGenerationEvent[] = [];
    for await (const event of remote.generation.start(req)) {
      remoteEvents.push(event);
    }

    expect(localEvents).toEqual(remoteEvents);
    expect(localEvents).toEqual(GENERATION_STREAM_EVENTS);
  });

  it('generation.retry streams the same canonical events from both backends', async () => {
    const local = new LocalBackend({ transport: new FakeKernelTransport() });
    const remote = makeRemoteBackend();

    const localEvents: WireGenerationEvent[] = [];
    for await (const event of local.generation.retry(RUN_ID)) {
      localEvents.push(event);
    }
    const remoteEvents: WireGenerationEvent[] = [];
    for await (const event of remote.generation.retry(RUN_ID)) {
      remoteEvents.push(event);
    }

    expect(localEvents).toEqual(remoteEvents);
    expect(localEvents).toEqual(GENERATION_STREAM_EVENTS);
  });
});

describe('LocalBackend generation validation (Phase 6)', () => {
  it('generation.get with a non-uuid workflowId throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.generation.get('not-a-uuid')).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });

  it('generation.retry with a non-uuid sourceRunId throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    const collect = async (): Promise<WireGenerationEvent[]> => {
      const events: WireGenerationEvent[] = [];
      for await (const event of backend.generation.retry('not-a-uuid')) {
        events.push(event);
      }
      return events;
    };
    await expect(collect()).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });
});

describe('LocalBackend handshake', () => {
  it('throws ContractMismatchError for a wrong expectedSchemaHash', () => {
    expect(
      () =>
        new LocalBackend({
          transport: new FakeKernelTransport(),
          expectedSchemaHash: 'deadbeef'.repeat(8),
        }),
    ).toThrow(ContractMismatchError);
  });

  it('accepts the canonical schema hash', () => {
    expect(
      () =>
        new LocalBackend({
          transport: new FakeKernelTransport(),
          expectedSchemaHash: WIRE_SCHEMA_HASH,
        }),
    ).not.toThrow();
  });
});

describe('LocalBackend outbound validation', () => {
  it('characters.get with a non-uuid id throws ValidationError before any transport call', async () => {
    const kernel = new FakeKernelTransport();
    const backend = new LocalBackend({ transport: kernel });

    await expect(backend.characters.get('not-a-uuid')).rejects.toThrow(ValidationError);
    expect(kernel.calls).toBe(0);
  });
});

describe('LegacyBackend', () => {
  const VERSION = { name: 'NeoTavern', version: '0.1.0', apiVersion: 2 };
  const HEALTH = { status: 'ok', uptime: 42 };
  const SUMMARY = {
    id: '9f8e7d6c-5b4a-4932-81f0-123456789abc',
    name: 'Ada Lovelace',
    avatar: '/api/v2/assets/avatars/ada.png',
    description: 'First programmer; legacy fixture.',
    tags: ['scientist'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const PAGE = { items: [SUMMARY], nextCursor: 'next-page', hasMore: true };
  const FULL = {
    ...SUMMARY,
    personality: 'analytical',
    scenario: 'Victorian London',
    firstMessage: 'Good day.',
    exampleDialogues: '',
    systemPrompt: null,
    postHistoryInstructions: null,
    creator: null,
    creatorNotes: null,
    ext: {},
    lastUsedAt: null,
    deletedAt: null,
  };

  function makeLegacyBackend(routes: Map<string, unknown>): LegacyBackend {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(url).pathname;
      const route = routes.get(pathname);
      if (route === undefined) {
        return jsonResponse({ code: 'NOT_FOUND', params: {}, traceId: 'legacy' }, 404);
      }
      return jsonResponse(route);
    };
    return new LegacyBackend({ baseUrl: 'http://legacy.local', fetchImpl });
  }

  it('meta() maps /api/v2/version and /api/v2/health to MetaDto', async () => {
    const backend = makeLegacyBackend(
      new Map([
        ['/api/v2/version', VERSION],
        ['/api/v2/health', HEALTH],
      ]),
    );
    await expect(backend.meta()).resolves.toEqual({
      appVersion: '0.1.0',
      api: { major: 2, minor: 0 },
      productWire: { major: 1, minor: 0 },
      features: { core: 1 },
    });
  });

  it('characters.list() maps items and passes cursor/limit as query params', async () => {
    const backend = makeLegacyBackend(new Map([['/api/v2/characters', PAGE]]));
    await expect(backend.characters.list({ cursor: 'c1', limit: 25 })).resolves.toEqual({
      items: [
        {
          id: SUMMARY.id,
          name: SUMMARY.name,
          description: SUMMARY.description,
          tags: SUMMARY.tags,
          createdAt: SUMMARY.createdAt,
          updatedAt: SUMMARY.updatedAt,
        },
      ],
      nextCursor: 'next-page',
    });
  });

  it('characters.get() maps a full legacy character to the canonical DTO', async () => {
    const backend = makeLegacyBackend(
      new Map([['/api/v2/characters/9f8e7d6c-5b4a-4932-81f0-123456789abc', FULL]]),
    );
    await expect(backend.characters.get(CHARACTER.id)).resolves.toEqual({
      id: SUMMARY.id,
      name: SUMMARY.name,
      description: SUMMARY.description,
      tags: SUMMARY.tags,
      createdAt: SUMMARY.createdAt,
      updatedAt: SUMMARY.updatedAt,
    });
  });

  it('maps legacy error envelopes to ProductError with code passthrough', async () => {
    const backend = makeLegacyBackend(new Map());
    const promise = backend.characters.get(CHARACTER.id);
    await expect(promise).rejects.toBeInstanceOf(ProductError);
    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND', traceId: 'legacy' });
  });

  it('generation.start throws UnsupportedError', () => {
    const backend = makeLegacyBackend(new Map());
    expect(() => backend.generation.start({ chatId: CHARACTER.id, message: 'hello' })).toThrow(
      UnsupportedError,
    );
  });

  it('generation.get throws UnsupportedError', () => {
    const backend = makeLegacyBackend(new Map());
    expect(() => backend.generation.get(RUN_ID)).toThrow(UnsupportedError);
  });

  it('raw passthrough forwards the host transport for unmigrated routes (ТЗ Фаза 0)', async () => {
    const calls: Array<{
      method: string;
      path: string;
      body?: unknown;
      signal?: AbortSignal;
    }> = [];
    const backend = new LegacyBackend({
      baseUrl: 'http://legacy.local',
      transport: {
        request: async (method, path, body, signal) => {
          calls.push({ method, path, body, signal });
          return { items: [] };
        },
      },
    });
    const result = await backend.raw.request<{ items: never[] }>('GET', '/chats/c1/messages');
    expect(result).toEqual({ items: [] });
    expect(calls).toEqual([{ method: 'GET', path: '/chats/c1/messages', body: undefined, signal: undefined }]);
  });

  it('raw passthrough throws UnsupportedError without a transport', () => {
    const backend = makeLegacyBackend(new Map());
    expect(() => backend.raw).toThrow(UnsupportedError);
  });

  it('raw passthrough is stable across accesses', () => {
    const transport = { request: async () => ({ ok: true }) };
    const backend = new LegacyBackend({
      baseUrl: 'http://legacy.local',
      transport,
    });
    expect(backend.raw.request).toBe(transport.request);
  });
});
