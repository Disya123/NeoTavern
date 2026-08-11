import { describe, it, expect } from 'vitest';
import {
  OpenAICompatibleAdapter,
  TextCompletionAdapter,
  applyCustomBody,
  applyCustomHeaders,
} from '../src/index.js';
import { baseRequest, collect, streamFromString } from './helpers.js';

describe('applyCustomBody', () => {
  it('merges customIncludeBody into a copy without mutating the input', () => {
    const body = { model: 'm', temperature: 0.7 };
    const result = applyCustomBody(body, { customIncludeBody: { top_k: 40, logprobs: true } });
    expect(result).toEqual({ model: 'm', temperature: 0.7, top_k: 40, logprobs: true });
    // Input is untouched.
    expect(body).toEqual({ model: 'm', temperature: 0.7 });
  });

  it('never merges adapter-reserved keys (stream, model, messages, …)', () => {
    // A `stream: false` override would make the provider answer with JSON
    // while the adapter parses SSE — an empty generation reported as success.
    const result = applyCustomBody(
      { model: 'm', stream: true, messages: [] },
      {
        customIncludeBody: {
          stream: false,
          stream_options: { include_usage: false },
          model: 'spoofed',
          messages: [{ role: 'user', content: 'spoofed' }],
          prompt: 'spoofed',
          input: 'spoofed',
          top_k: 40,
        },
      },
    );
    expect(result).toEqual({ model: 'm', stream: true, messages: [], top_k: 40 });
  });

  it('deletes customExcludeBody keys after the merge', () => {
    const result = applyCustomBody(
      { model: 'm', stream: true, logit_bias: { '1': 2 } },
      {
        customIncludeBody: { injected: 1 },
        customExcludeBody: ['logit_bias', 'injected'],
      },
    );
    expect(result).toEqual({ model: 'm', stream: true });
  });

  it('never removes adapter-reserved keys via customExcludeBody', () => {
    const result = applyCustomBody(
      { model: 'm', stream: true, stream_options: { include_usage: true } },
      { customExcludeBody: ['stream', 'stream_options', 'model', 'messages', 'prompt', 'input'] },
    );
    expect(result).toEqual({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('ignores malformed include/exclude settings defensively', () => {
    const body = { model: 'm', logit_bias: {} };
    expect(applyCustomBody(body, { customIncludeBody: 'not-an-object' })).toEqual(body);
    expect(applyCustomBody(body, { customIncludeBody: [1, 2] })).toEqual(body);
    expect(applyCustomBody(body, { customExcludeBody: 'logit_bias' })).toEqual(body);
    expect(applyCustomBody(body, { customExcludeBody: ['logit_bias', 42, null] })).toEqual({
      model: 'm',
    });
  });

  it('returns an equivalent copy when no additional params are set', () => {
    const body = { model: 'm', max_tokens: 64 };
    expect(applyCustomBody(body, {})).toEqual(body);
  });
});

describe('applyCustomHeaders', () => {
  it('merges customIncludeHeaders into a copy without mutating the input', () => {
    const headers = { 'Content-Type': 'application/json' };
    const result = applyCustomHeaders(headers, {
      customIncludeHeaders: { 'X-Trace': 'abc', 'X-Region': 'eu' },
    });
    expect(result).toEqual({
      'Content-Type': 'application/json',
      'X-Trace': 'abc',
      'X-Region': 'eu',
    });
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('never overrides forbidden headers, case-insensitively', () => {
    const result = applyCustomHeaders(
      { 'Content-Type': 'application/json', Authorization: 'Bearer real' },
      {
        customIncludeHeaders: {
          authorization: 'Bearer evil',
          'CONTENT-TYPE': 'text/plain',
          'Content-Length': '999',
          'X-Allowed': 'ok',
        },
      },
    );
    expect(result['Authorization']).toBe('Bearer real');
    expect(result['Content-Type']).toBe('application/json');
    expect(result).not.toHaveProperty('Content-Length');
    expect(result).not.toHaveProperty('content-length');
    expect(result['X-Allowed']).toBe('ok');
  });

  it('skips non-string header values and malformed settings', () => {
    const headers = { 'Content-Type': 'application/json' };
    expect(
      applyCustomHeaders(headers, { customIncludeHeaders: { 'X-Bad': 42, 'X-Ok': 'yes' } }),
    ).toEqual({ 'Content-Type': 'application/json', 'X-Ok': 'yes' });
    expect(applyCustomHeaders(headers, { customIncludeHeaders: 'nope' })).toEqual(headers);
  });
});

describe('TextCompletionAdapter additional parameters (wire)', () => {
  it('applies custom body include/exclude and headers to the /completions request', async () => {
    let sentHeaders: Record<string, string> = {};
    let sentBody: Record<string, unknown> = {};
    const sse = 'data: ' + JSON.stringify({ choices: [{ text: 'ok' }] }) + '\n\ndata: [DONE]\n\n';
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(streamFromString(sse), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new TextCompletionAdapter({
      baseUrl: 'http://localhost:5000/v1',
      model: 'test-model',
      apiKey: 'real-key',
      settings: {
        source: 'ooba',
        customIncludeBody: { grammar: 'custom.gbnf', echo: true, stream: false },
        customExcludeBody: ['echo', 'stream_options'],
        customIncludeHeaders: { 'X-Ooba': '1', Authorization: 'Bearer evil' },
      },
      fetchImpl,
    });
    await collect(adapter.generate(baseRequest, new AbortController().signal));

    // Include merged, then exclude removed the non-reserved `echo`.
    expect(sentBody['grammar']).toBe('custom.gbnf');
    expect(sentBody).not.toHaveProperty('echo');
    // Reserved keys are untouchable: the `stream: false` override and the
    // `stream_options` exclusion are both ignored, so the wire format stays
    // in sync with what the adapter parses.
    expect(sentBody['stream']).toBe(true);
    expect(sentBody['stream_options']).toEqual({ include_usage: true });
    // Custom header applied; forbidden Authorization keeps the real credential.
    expect(sentHeaders['X-Ooba']).toBe('1');
    expect(sentHeaders['Authorization']).toBe('Bearer real-key');
  });
});

describe('OpenAICompatibleAdapter additional parameters (wire)', () => {
  it('applies custom body include/exclude and headers to the /chat/completions request', async () => {
    let sentUrl = '';
    let sentHeaders: Record<string, string> = {};
    let sentBody: Record<string, unknown> = {};
    const sse =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) +
      '\n\ndata: [DONE]\n\n';
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sentUrl = String(input);
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(streamFromString(sse), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost:8000/v1',
      model: 'test-model',
      apiKey: 'real-key',
      settings: {
        source: 'openai-compatible',
        customIncludeBody: { logprobs: true, model: 'spoofed', stream: false },
        customExcludeBody: ['stream_options'],
        customIncludeHeaders: { 'X-Custom': 'v', 'content-type': 'text/plain' },
      },
      fetchImpl,
    });
    await collect(adapter.generate(baseRequest, new AbortController().signal));

    expect(sentUrl).toBe('http://localhost:8000/v1/chat/completions');
    expect(sentBody['logprobs']).toBe(true);
    // Reserved keys are untouchable: model/stream overrides and the
    // stream_options exclusion are ignored (PROV-30).
    expect(sentBody['model']).toBe('test-model');
    expect(sentBody['stream']).toBe(true);
    expect(sentBody['stream_options']).toEqual({ include_usage: true });
    expect(sentHeaders['X-Custom']).toBe('v');
    expect(sentHeaders['Content-Type']).toBe('application/json');
    expect(sentHeaders['Authorization']).toBe('Bearer real-key');
  });
});
