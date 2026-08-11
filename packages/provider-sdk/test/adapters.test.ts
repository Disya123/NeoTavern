import { describe, it, expect } from 'vitest';
import type { GenerationEvent, GenerationRequest } from '@neotavern/contracts';
import {
  parseSseStream,
  EchoAdapter,
  AnthropicAdapter,
  OpenAICompatibleAdapter,
  ProviderRegistry,
  TokenizerRegistry,
  estimateTokens,
} from '../src/index.js';
import { baseRequest, collect, streamFromString } from './helpers.js';

describe('parseSseStream', () => {
  it('yields data payloads and ignores empty lines', async () => {
    const stream = streamFromString('data: one\n\ndata: two\n\n');
    const out: string[] = [];
    for await (const data of parseSseStream(stream)) out.push(data);
    expect(out).toEqual(['one', 'two']);
  });

  it('handles chunked delivery across reads', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: hel'));
        controller.enqueue(encoder.encode('lo\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const data of parseSseStream(stream)) out.push(data);
    expect(out).toEqual(['hello', '[DONE]']);
  });
});

describe('EchoAdapter', () => {
  it('streams start, deltas and a terminal done', async () => {
    const adapter = new EchoAdapter({ baseUrl: null, model: 'echo', apiKey: null, settings: {} });
    const controller = new AbortController();
    // The echo assertions depend on this exact prompt (kept from the local drift).
    const request: GenerationRequest = {
      ...baseRequest,
      messages: [{ role: 'user', content: 'Hello there' }],
    };
    const events = await collect(adapter.generate(request, controller.signal));

    expect(events[0]?.type).toBe('start');
    expect(events[events.length - 1]?.type).toBe('done');
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(0);

    const done = events[events.length - 1];
    if (done?.type === 'done') {
      expect(done.text).toContain('Hello there');
      expect(done.usage?.totalTokens).toBeGreaterThan(0);
    }
  });

  it('emits an error event when aborted mid-stream', async () => {
    const adapter = new EchoAdapter({ baseUrl: null, model: 'echo', apiKey: null, settings: {} });
    const controller = new AbortController();
    controller.abort();
    const events = await collect(adapter.generate(baseRequest, controller.signal));
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.code).toBe('GENERATION_CANCELLED');
  });
});

describe('OpenAICompatibleAdapter', () => {
  it('parses a streamed chat completion', async () => {
    const sse =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: '!' } }] }) +
      '\n\n' +
      'data: [DONE]\n\n';

    const fetchImpl = (async () =>
      new Response(streamFromString(sse), { status: 200 })) as unknown as typeof fetch;

    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      apiKey: 'sk-x',
      settings: {},
      fetchImpl,
    });

    const controller = new AbortController();
    const events = await collect(adapter.generate(baseRequest, controller.signal));
    const deltas = events
      .filter((e): e is Extract<GenerationEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(deltas).toBe('Hi!');
    const done = events[events.length - 1];
    expect(done?.type).toBe('done');
  });

  it('yields an error event on non-200 responses', async () => {
    const fetchImpl = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      apiKey: null,
      settings: {},
      fetchImpl,
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeTruthy();
  });

  it('serializes extended custom sampling parameters and handles a non-stream response', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [{ message: { content: 'Complete reply' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    }) as typeof fetch;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      apiKey: null,
      settings: { source: 'openai-compatible', samplerCompatibility: 'extended' },
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
          frequencyPenalty: 0.2,
          presencePenalty: 0.3,
          seed: 12,
          reasoning: true,
          reasoningEffort: 'max',
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
      frequency_penalty: 0.2,
      presence_penalty: 0.3,
      seed: 12,
      reasoning_effort: 'max',
    });
    expect(events).toContainEqual({ type: 'delta', text: 'Complete reply' });
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'Complete reply' });
  });

  it.each([
    {
      source: 'deepseek',
      expected: ['temperature', 'top_p'],
      omitted: [
        'top_k',
        'min_p',
        'top_a',
        'repetition_penalty',
        'frequency_penalty',
        'presence_penalty',
        'seed',
        'reasoning_effort',
      ],
    },
    {
      source: 'openai',
      expected: [
        'temperature',
        'top_p',
        'frequency_penalty',
        'presence_penalty',
        'seed',
        'reasoning_effort',
      ],
      omitted: ['top_k', 'min_p', 'top_a', 'repetition_penalty'],
    },
    {
      source: 'nanogpt',
      expected: [
        'temperature',
        'top_p',
        'top_k',
        'min_p',
        'top_a',
        'repetition_penalty',
        'frequency_penalty',
        'presence_penalty',
        'seed',
        'reasoning_effort',
      ],
      omitted: [],
    },
    {
      source: 'google-ai-studio',
      expected: ['temperature', 'top_p', 'reasoning_effort'],
      omitted: [
        'top_k',
        'min_p',
        'top_a',
        'repetition_penalty',
        'frequency_penalty',
        'presence_penalty',
        'seed',
      ],
    },
  ])('sends only $source-supported sampling parameters', async ({ source, expected, omitted }) => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      apiKey: null,
      settings: { source },
      fetchImpl,
    });

    await collect(
      adapter.generate(
        {
          ...baseRequest,
          stream: false,
          topP: 0.9,
          topK: 40,
          minP: 0.05,
          topA: 0.1,
          repetitionPenalty: 1.1,
          frequencyPenalty: 0.2,
          presencePenalty: 0.3,
          seed: 12,
          reasoning: true,
          reasoningEffort: 'medium',
        },
        new AbortController().signal,
      ),
    );

    for (const key of expected) expect(sentBody).toHaveProperty(key);
    for (const key of omitted) expect(sentBody).not.toHaveProperty(key);
  });

  it('omits reasoning efforts outside the NanoGPT capability profile', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://nano-gpt.com/api/v1',
      model: 'test',
      apiKey: null,
      settings: { source: 'nanogpt' },
      fetchImpl,
    });

    await collect(
      adapter.generate(
        { ...baseRequest, stream: false, reasoningEffort: 'max' },
        new AbortController().signal,
      ),
    );

    expect(sentBody).not.toHaveProperty('reasoning_effort');
  });

  it('defaults an explicit custom source to standard sampler compatibility', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      apiKey: null,
      settings: { source: 'openai-compatible' },
      fetchImpl,
    });

    await collect(
      adapter.generate(
        { ...baseRequest, stream: false, topP: 0.9, topK: 40 },
        new AbortController().signal,
      ),
    );

    expect(sentBody).toHaveProperty('temperature');
    expect(sentBody).toHaveProperty('top_p');
    expect(sentBody).not.toHaveProperty('top_k');
  });

  it('validates config requires baseUrl', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: null,
      model: 'test',
      apiKey: null,
      settings: {},
    });
    const result = await adapter.validateConfig();
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe('baseUrl');
  });
});

describe('AnthropicAdapter', () => {
  it('uses native messages, caches the leading system prefix, and preserves late system order', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'Native reply', citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 3 },
      });
    }) as typeof fetch;
    const adapter = new AnthropicAdapter({
      baseUrl: null,
      model: 'claude-opus-4-7',
      apiKey: 'anthropic-secret',
      settings: { source: 'anthropic' },
      fetchImpl,
    });

    const events = await collect(
      adapter.generate(
        {
          ...baseRequest,
          model: 'claude-opus-4-7',
          stream: false,
          reasoning: true,
          reasoningEffort: 'minimal',
          messages: [
            { role: 'system', content: 'Stable one' },
            { role: 'system', content: 'Stable two' },
            { role: 'user', content: 'First turn' },
            { role: 'assistant', content: 'Prior answer' },
            { role: 'system', content: 'Late instruction' },
            { role: 'tool', name: 'lookup', content: 'Tool result' },
            { role: 'system', content: 'Trailing instruction' },
          ],
        },
        new AbortController().signal,
      ),
    );

    expect(sentBody).toMatchObject({
      model: 'claude-opus-4-7',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
    expect(sentBody).not.toHaveProperty('temperature');
    expect(sentBody).not.toHaveProperty('top_p');
    expect(sentBody['system']).toEqual([
      { type: 'text', text: 'Stable one' },
      {
        type: 'text',
        text: 'Stable two',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    const messages = sentBody['messages'] as Array<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]?.content).toContain(
      '<system-reminder>\nLate instruction\n</system-reminder>',
    );
    expect(messages[2]?.content).toContain('--- tool message (lookup) ---');
    expect(messages[2]?.content).toContain(
      '<system-reminder>\nTrailing instruction\n</system-reminder>',
    );
    expect(events).toContainEqual({ type: 'delta', text: 'Native reply' });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      text: 'Native reply',
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
  });

  it('paginates model discovery and uses the SDK token-count endpoint', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requestedUrls.push(url);
      if (url.includes('count_tokens')) return Response.json({ input_tokens: 37 });
      const secondPage = url.includes('after_id=');
      return Response.json({
        data: secondPage
          ? [
              {
                id: 'claude-2',
                display_name: 'Claude 2',
                type: 'model',
                created_at: '2026-01-01T00:00:00Z',
                max_input_tokens: 200000,
                max_tokens: 64000,
                capabilities: null,
              },
            ]
          : [
              {
                id: 'claude-1',
                display_name: 'Claude 1',
                type: 'model',
                created_at: '2026-01-01T00:00:00Z',
                max_input_tokens: 100000,
                max_tokens: 32000,
                capabilities: null,
              },
            ],
        has_more: !secondPage,
        first_id: secondPage ? 'claude-2' : 'claude-1',
        last_id: secondPage ? 'claude-2' : 'claude-1',
      });
    }) as typeof fetch;
    const adapter = new AnthropicAdapter({
      baseUrl: null,
      model: 'claude-opus-4-7',
      apiKey: 'anthropic-secret',
      settings: { source: 'anthropic' },
      fetchImpl,
    });

    await expect(adapter.listModels(new AbortController().signal)).resolves.toEqual([
      { id: 'claude-1', name: 'Claude 1', contextLimit: 100000 },
      { id: 'claude-2', name: 'Claude 2', contextLimit: 200000 },
    ]);
    await expect(
      adapter.countTokens({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'Count this' }],
      }),
    ).resolves.toEqual({ tokens: 37, approximate: false });
    expect(requestedUrls.some((url) => url.includes('after_id=claude-1'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('count_tokens'))).toBe(true);
  });

  it('streams text and emits one terminal done event', async () => {
    const sse = [
      {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: null },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          container: null,
        },
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens_details: null,
          server_tool_use: null,
        },
      },
      { type: 'message_stop' },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('');
    const fetchImpl = (async () =>
      new Response(streamFromString(sse), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    const adapter = new AnthropicAdapter({
      baseUrl: null,
      model: 'claude-opus-4-7',
      apiKey: 'anthropic-secret',
      settings: { source: 'anthropic' },
      fetchImpl,
    });

    const events = await collect(
      adapter.generate({ ...baseRequest, model: 'claude-opus-4-7' }, new AbortController().signal),
    );
    expect(events).toContainEqual({ type: 'delta', text: 'Hi' });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('maps caller cancellation and typed authentication errors without leaking secrets', async () => {
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })) as unknown as typeof fetch;
    const cancelledAdapter = new AnthropicAdapter({
      baseUrl: null,
      model: 'claude-opus-4-7',
      apiKey: 'do-not-leak',
      settings: { source: 'anthropic' },
      fetchImpl: hangingFetch,
    });
    const caller = new AbortController();
    caller.abort();
    const cancelled = await collect(
      cancelledAdapter.generate({ ...baseRequest, model: 'claude-opus-4-7' }, caller.signal),
    );
    expect(cancelled.at(-1)).toMatchObject({ type: 'error', code: 'GENERATION_CANCELLED' });

    const authAdapter = new AnthropicAdapter({
      baseUrl: null,
      model: 'claude-opus-4-7',
      apiKey: 'do-not-leak',
      settings: { source: 'anthropic' },
      fetchImpl: (async () =>
        Response.json(
          {
            type: 'error',
            error: { type: 'authentication_error', message: 'do-not-leak is invalid' },
          },
          { status: 401 },
        )) as typeof fetch,
    });
    const unauthorized = await collect(
      authAdapter.generate(
        { ...baseRequest, model: 'claude-opus-4-7', stream: false },
        new AbortController().signal,
      ),
    );
    expect(unauthorized.at(-1)).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    expect(JSON.stringify(unauthorized)).not.toContain('do-not-leak');
  });
});

describe('provider timeouts', () => {
  // Mimics undici: fetch rejects with the signal's abort reason when aborted.
  function hangingFetch(): typeof fetch {
    return ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never settles: a truly hung provider
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        void resolve;
      })) as unknown as typeof fetch;
  }

  it('aborts a hung connection after connectMs with a TIMEOUT error event', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      apiKey: null,
      settings: {},
      fetchImpl: hangingFetch(),
      timeouts: { connectMs: 15, idleMs: 5000, readMs: 5000 },
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.code).toBe('TIMEOUT');
  });

  it('aborts a stream that goes silent after idleMs', async () => {
    const encoder = new TextEncoder();
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`,
            ),
          );
          // Then silence: no more chunks, stream never closes.
          const onAbort = (): void =>
            controller.error(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      apiKey: null,
      settings: {},
      fetchImpl,
      timeouts: { connectMs: 5000, idleMs: 15, readMs: 5000 },
    });
    const events = await collect(adapter.generate(baseRequest, new AbortController().signal));
    expect(events).toContainEqual({ type: 'delta', text: 'Hi' });
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.code).toBe('TIMEOUT');
  });

  it('listModels rejects with TIMEOUT when the provider hangs', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      apiKey: null,
      settings: {},
      fetchImpl: hangingFetch(),
      timeouts: { connectMs: 5000, idleMs: 5000, readMs: 15 },
    });
    await expect(adapter.listModels(new AbortController().signal)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('caller abort still maps to GENERATION_CANCELLED', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      apiKey: null,
      settings: {},
      fetchImpl: hangingFetch(),
      timeouts: { connectMs: 5000, idleMs: 5000, readMs: 5000 },
    });
    const caller = new AbortController();
    caller.abort();
    const events = await collect(adapter.generate(baseRequest, caller.signal));
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.code).toBe('GENERATION_CANCELLED');
  });
});

describe('ProviderRegistry', () => {
  it('registers built-ins and creates adapters', () => {
    const registry = new ProviderRegistry();
    expect(registry.has('openai-compatible')).toBe(true);
    expect(registry.has('echo')).toBe(true);
    const adapter = registry.create('echo', {
      baseUrl: null,
      model: 'echo',
      apiKey: null,
      settings: {},
    });
    expect(adapter.kind).toBe('echo');
  });

  it('returns a cleanup function that unregisters', () => {
    const registry = new ProviderRegistry(false);
    const unregister = registry.register(
      'custom',
      () => new EchoAdapter({ baseUrl: null, model: 'x', apiKey: null, settings: {} }),
    );
    expect(registry.has('custom')).toBe(true);
    unregister();
    expect(registry.has('custom')).toBe(false);
  });

  it('throws PROVIDER_NOT_FOUND for unknown kinds', () => {
    const registry = new ProviderRegistry(false);
    expect(() =>
      registry.create('nope', { baseUrl: null, model: 'x', apiKey: null, settings: {} }),
    ).toThrow();
  });
});

describe('tokenizer', () => {
  it('estimates tokens and is monotonic', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hi')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('a longer string of text')).toBeGreaterThan(estimateTokens('hi'));
  });

  it('registers exact offline Tiktoken profiles for known OpenAI models', async () => {
    const registry = new ProviderRegistry();
    const o200k = await registry.tokenizers.resolve('openai/gpt-4o-mini');
    expect(o200k).toMatchObject({ profile: 'openai:o200k_base', approximate: false });
    await expect(o200k.count('hello world')).resolves.toBe(2);

    const cl100k = await registry.tokenizers.resolve('gpt-3.5-turbo');
    expect(cl100k).toMatchObject({ profile: 'openai:cl100k_base', approximate: false });
    await expect(cl100k.count('hello world')).resolves.toBe(2);

    expect(await registry.tokenizers.resolve('local/unknown-model')).toMatchObject({
      profile: 'approximate-character-v1',
      approximate: true,
    });
  });

  it('resolves model-specific profiles by priority and cleans them up', async () => {
    const registry = new TokenizerRegistry();
    const removeGeneric = registry.register({
      id: 'generic',
      priority: 1,
      approximate: false,
      matches: (model) => model.startsWith('gpt-'),
      count: (text) => text.length,
    });
    const removeSpecific = registry.register({
      id: 'specific',
      priority: 10,
      approximate: false,
      matches: (model) => model === 'gpt-test',
      count: (text) => text.split(/\s+/).filter(Boolean).length,
    });

    const specific = await registry.resolve('gpt-test');
    expect(specific.profile).toBe('specific');
    await expect(specific.count('one two')).resolves.toBe(2);

    removeSpecific();
    expect((await registry.resolve('gpt-test')).profile).toBe('generic');
    removeGeneric();
    expect(await registry.resolve('gpt-test')).toMatchObject({
      profile: 'approximate-character-v1',
      approximate: true,
    });
  });

  it('degrades to the character estimate when a tokenizer plugin returns invalid counts', async () => {
    const registry = new TokenizerRegistry();
    registry.register({
      id: 'broken',
      approximate: false,
      matches: () => true,
      count: () => Number.NaN,
    });
    const tokenizer = await registry.resolve('model');
    // A failing exact tokenizer must not take the pipeline down (ADR-0007):
    // it falls back to the offline estimate instead of rejecting.
    await expect(tokenizer.count('text')).resolves.toBe(estimateTokens('text'));
  });
});
