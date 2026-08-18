/**
 * Provider SDK contract tests (ТЗ §83 Provider SDK): config, models, stream,
 * cancellation, normalized errors, usage, and secret/config separation.
 * The offline EchoAdapter exercises the full streaming pipeline without any
 * network or API key; error normalization and timeout primitives are tested
 * directly.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '@neotavern/shared';
import {
  EchoAdapter,
  DEFAULT_PROVIDER_TIMEOUTS,
  DeadlineController,
  classifyHttpStatus,
  httpProviderError,
  normalizeProviderError,
  parseProviderErrorDetail,
  resolveTimeouts,
  validateHttpBaseUrl,
} from '../src/index.js';

function echoConfig(
  overrides: Partial<Record<'baseUrl' | 'model' | 'apiKey', string | null>> = {},
) {
  return {
    baseUrl: overrides.baseUrl ?? null,
    model: overrides.model ?? 'echo',
    apiKey: overrides.apiKey ?? null,
    settings: {},
  };
}

function request(messages: Array<{ role: string; content: string }>) {
  return { model: 'echo', messages };
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('config validation (§83 config)', () => {
  it('accepts http(s) base URLs', () => {
    expect(validateHttpBaseUrl('https://api.example.com/v1', { required: true })).toEqual([]);
    expect(validateHttpBaseUrl('http://127.0.0.1:8080', { required: true })).toEqual([]);
  });

  it('rejects non-http schemes, garbage and missing-required', () => {
    expect(validateHttpBaseUrl('ftp://example.com', { required: true })).not.toEqual([]);
    expect(validateHttpBaseUrl('file:///etc/passwd', { required: true })).not.toEqual([]);
    expect(validateHttpBaseUrl('not a url', { required: true })).not.toEqual([]);
    expect(validateHttpBaseUrl(null, { required: true })).not.toEqual([]);
    expect(validateHttpBaseUrl(null, { required: false })).toEqual([]);
  });

  it('echo validateConfig is valid without network', async () => {
    const adapter = new EchoAdapter(echoConfig());
    await expect(adapter.validateConfig()).resolves.toEqual({ valid: true, issues: [] });
  });
});

describe('models (§83 models)', () => {
  it('lists the offline model', async () => {
    const adapter = new EchoAdapter(echoConfig());
    const models = await adapter.listModels(new AbortController().signal);
    expect(models).toEqual([{ id: 'echo', name: 'Echo (offline)', contextLimit: 8192 }]);
  });
});

describe('stream contract (§6.3/§83 stream)', () => {
  it('yields exactly one terminal event and valid usage arithmetic', async () => {
    const adapter = new EchoAdapter(echoConfig());
    const events = await collect(
      adapter.generate(
        request([{ role: 'user', content: 'hello world' }]),
        new AbortController().signal,
      ),
    );
    const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminals).toHaveLength(1);
    expect(events[0].type).toBe('start');
    expect(typeof events[0].requestId).toBe('string');
    // Text accumulates from deltas into the terminal done.text.
    const deltas = events.filter((e) => e.type === 'delta');
    const done = events[events.length - 1];
    expect(done.type).toBe('done');
    expect(done.text).toBe(deltas.map((d) => d.text).join(''));
    const { promptTokens, completionTokens, totalTokens } = done.usage;
    expect(promptTokens + completionTokens).toBe(totalTokens);
    expect(totalTokens).toBeGreaterThan(0);
  });

  it('modalities and capabilities are declared', () => {
    const adapter = new EchoAdapter(echoConfig());
    expect(adapter.kind).toBe('echo');
    expect(adapter.modalities).toContain('text');
    expect(adapter.modalities).toContain('image');
    expect(adapter.capabilities?.assistantPrefill).toBe(true);
  });
});

describe('cancellation (§83 cancellation)', () => {
  it('aborting mid-stream yields GENERATION_CANCELLED, never done after', async () => {
    const adapter = new EchoAdapter(echoConfig());
    const controller = new AbortController();
    const events: unknown[] = [];
    // Abort after the first delta lands.
    const iterator = adapter.generate(
      request([{ role: 'user', content: 'a '.repeat(200) }]),
      controller.signal,
    );
    for await (const event of iterator) {
      events.push(event);
      if (event.type === 'delta') controller.abort();
    }
    const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe('error');
    expect(terminals[0].code).toBe(ErrorCodes.GENERATION_CANCELLED);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('DeadlineController fires on caller abort with the caller reason', async () => {
    const caller = new AbortController();
    const deadline = new DeadlineController(caller.signal);
    const reason = new Error('caller-stop');
    caller.abort(reason);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(reason);
    deadline.dispose();
  });

  it('DeadlineController deadline abort carries a TIMEOUT AppError', async () => {
    const caller = new AbortController();
    const deadline = new DeadlineController(caller.signal);
    deadline.arm(1, 'connect deadline hit');
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(deadline.signal.aborted).toBe(true);
    const reason = deadline.signal.reason;
    expect(reason).toBeInstanceOf(Error);
    expect(reason.code).toBe(ErrorCodes.TIMEOUT);
    deadline.dispose();
  });
});

describe('normalized errors (§83 normalized errors)', () => {
  it('classifies upstream statuses to stable codes', () => {
    expect(classifyHttpStatus(401)).toBe(ErrorCodes.UNAUTHORIZED);
    expect(classifyHttpStatus(403)).toBe(ErrorCodes.UNAUTHORIZED);
    expect(classifyHttpStatus(404)).toBe(ErrorCodes.MODEL_NOT_FOUND);
    expect(classifyHttpStatus(408)).toBe(ErrorCodes.TIMEOUT);
    expect(classifyHttpStatus(429)).toBe(ErrorCodes.RATE_LIMITED);
    expect(classifyHttpStatus(500)).toBe(ErrorCodes.GENERATION_FAILED);
    expect(classifyHttpStatus(200)).toBe(ErrorCodes.GENERATION_FAILED);
  });

  it('abort and timeout errors normalize to their stable codes', () => {
    const abort = new DOMException('aborted', 'AbortError');
    expect(normalizeProviderError(abort).code).toBe(ErrorCodes.GENERATION_CANCELLED);
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    expect(normalizeProviderError(timeout).code).toBe(ErrorCodes.TIMEOUT);
    const network = new TypeError('fetch failed');
    expect(normalizeProviderError(network).message).toMatch(/Network error/);
  });

  it('httpProviderError surfaces only capped structured detail, never raw bodies', () => {
    const err = httpProviderError(404, 'generation', '{"error":{"message":"no such model"}}');
    expect(err.code).toBe(ErrorCodes.MODEL_NOT_FOUND);
    expect(err.message).toMatch(/no such model/);
    // Raw upstream text (HTML, dumps) is discarded entirely.
    const html = httpProviderError(500, 'generation', '<html>secret stack trace</html>');
    expect(html.message).not.toMatch(/secret stack trace/);
    expect(parseProviderErrorDetail('<html>junk</html>')).toBeNull();
    expect(parseProviderErrorDetail('{"unrelated":1}')).toBeNull();
  });
});

describe('timeouts (§83 timeouts)', () => {
  it('defaults are sane and partial overrides merge', () => {
    expect(DEFAULT_PROVIDER_TIMEOUTS.connectMs).toBeGreaterThan(0);
    expect(DEFAULT_PROVIDER_TIMEOUTS.idleMs).toBeGreaterThan(DEFAULT_PROVIDER_TIMEOUTS.connectMs);
    expect(resolveTimeouts({ connectMs: 100 })).toEqual({
      ...DEFAULT_PROVIDER_TIMEOUTS,
      connectMs: 100,
    });
  });
});
