import { describe, it, expect } from 'vitest';
import type { GenerationEvent } from '@neotavern/contracts';
import {
  AIHordeAdapter,
  KoboldAIAdapter,
  NovelAIAdapter,
  PROVIDER_CATALOG,
  ProviderRegistry,
  TextCompletionAdapter,
  findProviderCatalogEntry,
  getProviderCatalogEntry,
  promptFromMessages,
} from '../src/index.js';
import { baseRequest, collect, streamFromString } from './helpers.js';

describe('promptFromMessages', () => {
  it('flattens a single rendered instruct message to its content', () => {
    expect(promptFromMessages([{ role: 'user', content: 'rendered prompt' }])).toBe(
      'rendered prompt',
    );
  });

  it('joins multiple messages and drops empty content', () => {
    expect(
      promptFromMessages([
        { role: 'system', content: 'a' },
        { role: 'user', content: '' },
        { role: 'assistant', content: 'b' },
      ]),
    ).toBe('a\nb');
  });
});

describe('catalog (text-completion + classic backends)', () => {
  it('exposes a catalog entry for every provider source id', () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(getProviderCatalogEntry(entry.id).adapterKind).toBe(entry.adapterKind);
    }
    const expected: ReadonlyArray<[string, string]> = [
      ['text-completion', 'text-completion'],
      ['ooba', 'text-completion'],
      ['koboldcpp', 'text-completion'],
      ['vllm', 'text-completion'],
      ['ollama', 'text-completion'],
      ['novelai', 'novelai'],
      ['ai-horde', 'ai-horde'],
      ['koboldai', 'koboldai'],
    ];
    for (const [id, adapterKind] of expected) {
      expect(findProviderCatalogEntry(id)?.adapterKind).toBe(adapterKind);
    }
  });

  it('marks local text backends as key-optional and base-url editable', () => {
    const ooba = getProviderCatalogEntry('ooba');
    expect(ooba.apiKeyRequired).toBe(false);
    expect(ooba.baseUrlEditable).toBe(true);
    expect(ooba.defaultBaseUrl).toBe('http://127.0.0.1:5000/v1');
    expect(getProviderCatalogEntry('novelai').apiKeyRequired).toBe(true);
    expect(getProviderCatalogEntry('ai-horde').apiKeyRequired).toBe(false);
  });
});

describe('TextCompletionAdapter', () => {
  it('posts a serialized prompt to /completions and parses streamed text', async () => {
    let sentUrl = '';
    let sentBody: Record<string, unknown> = {};
    const sse =
      'data: ' +
      JSON.stringify({ choices: [{ text: 'Once' }] }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({ choices: [{ text: ' upon' }] }) +
      '\n\n' +
      'data: [DONE]\n\n';
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sentUrl = String(input);
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(streamFromString(sse), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new TextCompletionAdapter({
      baseUrl: 'http://localhost:5000/v1',
      model: 'test-model',
      apiKey: null,
      settings: { source: 'ooba' },
      fetchImpl,
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));

    expect(sentUrl).toBe('http://localhost:5000/v1/completions');
    expect(sentBody).toMatchObject({
      model: 'test-model',
      prompt: 'The story begins',
      stream: true,
      temperature: 0.8,
    });
    expect(sentBody).not.toHaveProperty('messages');
    const deltas = events
      .filter((e): e is Extract<GenerationEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(deltas).toBe('Once upon');
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'Once upon' });
  });

  it('handles a non-stream response and sends extended local samplers', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [{ text: 'Complete reply' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    }) as typeof fetch;
    const adapter = new TextCompletionAdapter({
      baseUrl: 'http://localhost:5001/v1/',
      model: 'test-model',
      apiKey: 'secret-key',
      settings: { source: 'koboldcpp' },
      fetchImpl,
    });
    const events = await collect(
      adapter.generate(
        {
          ...baseRequest,
          stream: false,
          topP: 0.9,
          topK: 40,
          minP: 0.05,
          topA: 0.1,
          repetitionPenalty: 1.1,
        },
        new AbortController().signal,
      ),
    );

    expect(sentBody).toMatchObject({
      stream: false,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      top_a: 0.1,
      repetition_penalty: 1.1,
    });
    expect(events).toContainEqual({ type: 'delta', text: 'Complete reply' });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      text: 'Complete reply',
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    });
  });

  it('yields an error event on non-200 responses', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const adapter = new TextCompletionAdapter({
      baseUrl: 'http://localhost:5000/v1',
      model: 'test-model',
      apiKey: null,
      settings: { source: 'ooba' },
      fetchImpl,
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));
    expect(events.find((e) => e.type === 'error')).toBeTruthy();
  });

  it('validates config requires baseUrl', async () => {
    const adapter = new TextCompletionAdapter({
      baseUrl: null,
      model: 'test-model',
      apiKey: null,
      settings: {},
    });
    const result = await adapter.validateConfig();
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe('baseUrl');
  });
});

describe('NovelAIAdapter', () => {
  it('sends Bearer auth and a parameters body, parsing output text', async () => {
    let sentUrl = '';
    let sentHeaders: Record<string, string> = {};
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sentUrl = String(input);
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ output: 'A novel reply' });
    }) as typeof fetch;
    const adapter = new NovelAIAdapter({
      baseUrl: 'https://api.novelai.net',
      model: 'kayra-v1',
      apiKey: 'nai-secret',
      settings: { source: 'novelai' },
      fetchImpl,
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));

    expect(sentUrl).toBe('https://api.novelai.net/ai/generate');
    expect(sentHeaders['Authorization']).toBe('Bearer nai-secret');
    expect(sentBody).toMatchObject({ input: 'The story begins', model: 'test-model' });
    expect(sentBody['parameters']).toMatchObject({ max_length: 64, temperature: 0.8 });
    expect(events).toContainEqual({ type: 'delta', text: 'A novel reply' });
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'A novel reply' });
  });

  it('requires an apiKey', async () => {
    const adapter = new NovelAIAdapter({
      baseUrl: null,
      model: 'kayra-v1',
      apiKey: null,
      settings: {},
    });
    const result = await adapter.validateConfig();
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe('apiKey');
  });

  it('maps a 401 to UNAUTHORIZED without leaking the configured key', async () => {
    const fetchImpl = (async () =>
      Response.json({ message: 'invalid api key' }, { status: 401 })) as typeof fetch;
    const adapter = new NovelAIAdapter({
      baseUrl: null,
      model: 'kayra-v1',
      apiKey: 'nai-secret',
      settings: {},
      fetchImpl,
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.code).toBe('UNAUTHORIZED');
    expect(JSON.stringify(events)).not.toContain('nai-secret');
  });
});

describe('KoboldAIAdapter', () => {
  it('posts a prompt to /api/v1/generate and reads results[0].text', async () => {
    let sentUrl = '';
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sentUrl = String(input);
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ results: [{ text: 'Kobold reply' }] });
    }) as typeof fetch;
    const adapter = new KoboldAIAdapter({
      baseUrl: 'http://localhost:5000',
      model: 'local-model',
      apiKey: null,
      settings: { source: 'koboldai' },
      fetchImpl,
    });
    const events = await collect(
      adapter.generate(
        { ...baseRequest, topP: 0.9, topK: 40, repetitionPenalty: 1.2 },
        new AbortController().signal,
      ),
    );

    expect(sentUrl).toBe('http://localhost:5000/api/v1/generate');
    expect(sentBody).toMatchObject({
      prompt: 'The story begins',
      max_length: 64,
      temperature: 0.8,
      top_p: 0.9,
      top_k: 40,
      rep_pen: 1.2,
    });
    expect(events).toContainEqual({ type: 'delta', text: 'Kobold reply' });
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'Kobold reply' });
  });

  it('discovers the loaded model from /api/v1/model', async () => {
    const fetchImpl = (async () => Response.json({ result: 'pygmalion-6b' })) as typeof fetch;
    const adapter = new KoboldAIAdapter({
      baseUrl: 'http://localhost:5000',
      model: null,
      apiKey: null,
      settings: {},
      fetchImpl,
    });
    await expect(adapter.listModels(new AbortController().signal)).resolves.toEqual([
      { id: 'pygmalion-6b', name: 'pygmalion-6b' },
    ]);
  });
});

describe('AIHordeAdapter', () => {
  it('submits a job then polls until done', async () => {
    const requestedUrls: string[] = [];
    let statusCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith('/api/v2/generate/text/async')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ prompt: 'The story begins', models: ['test-model'] });
        return Response.json({ id: 'job-123', kudos: 5 });
      }
      if (url.includes('/api/v2/generate/text/status/job-123')) {
        statusCalls += 1;
        if (statusCalls < 2) {
          return Response.json({ done: false, wait_time: 3 });
        }
        return Response.json({
          done: true,
          generations: [{ text: 'Horde reply', model: 'test-model', state: 'ok' }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const adapter = new AIHordeAdapter({
      baseUrl: 'https://stablehorde.net',
      model: 'test-model',
      apiKey: 'horde-key',
      settings: { source: 'ai-horde', pollIntervalMs: 1 },
      fetchImpl,
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));

    expect(requestedUrls[0]).toBe('https://stablehorde.net/api/v2/generate/text/async');
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(events).toContainEqual({ type: 'delta', text: 'Horde reply' });
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'Horde reply' });
  });

  it('sends the anonymous key and maps a faulted job to an error', async () => {
    let sentHeaders: Record<string, string> = {};
    let phase = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v2/generate/text/async')) {
        sentHeaders = (init?.headers ?? {}) as Record<string, string>;
        return Response.json({ id: 'job-fault' });
      }
      phase += 1;
      return Response.json({ done: true, faulted: true });
    }) as typeof fetch;
    const adapter = new AIHordeAdapter({
      baseUrl: null,
      model: 'test-model',
      apiKey: null,
      settings: {},
      fetchImpl,
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));
    expect(sentHeaders['apikey']).toBe('0000000000');
    expect(phase).toBeGreaterThanOrEqual(1);
    expect(events.find((e) => e.type === 'error')).toBeTruthy();
  });

  it('maps a 429 submission to RATE_LIMITED', async () => {
    const fetchImpl = (async () =>
      Response.json({ message: 'slow down' }, { status: 429 })) as typeof fetch;
    const adapter = new AIHordeAdapter({
      baseUrl: null,
      model: 'test-model',
      apiKey: null,
      settings: {},
      fetchImpl,
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.code).toBe('RATE_LIMITED');
  });
});

describe('ProviderRegistry (text + classic kinds)', () => {
  it('creates adapters for every new built-in kind', () => {
    const registry = new ProviderRegistry();
    for (const kind of ['text-completion', 'novelai', 'koboldai', 'ai-horde']) {
      expect(registry.has(kind)).toBe(true);
      const adapter = registry.create(kind, {
        baseUrl: 'http://localhost:1',
        model: 'm',
        apiKey: null,
        settings: {},
      });
      expect(adapter.kind).toBe(kind);
    }
  });
});
