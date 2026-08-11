/** API client tests: URL joining, JSON handling, error envelopes, CSRF, no storage. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../../test/helpers.js';
import { ApiError, ApiNetworkError, api, getCsrfToken, setCsrfToken, sseUrl } from './client.js';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setCsrfToken(null);
  fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setCsrfToken(null);
});

describe('url joining', () => {
  it('joins every verb onto the /api/v2 base', async () => {
    await api.get('/characters');
    await api.post('/chats', {});
    await api.patch('/settings', {});
    await api.del('/chats/chat-1');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/v2/characters',
      '/api/v2/chats',
      '/api/v2/settings',
      '/api/v2/chats/chat-1',
    ]);
  });

  it('builds SSE URLs on the same base', () => {
    expect(sseUrl('/events')).toBe('/api/v2/events');
  });
});

describe('json handling', () => {
  it('parses JSON success bodies and returns undefined for 204', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    await expect(api.get('/providers')).resolves.toEqual({ items: [] });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.del('/chats/chat-1')).resolves.toBeUndefined();
  });

  it('sends a JSON body and content type only when a body is present', async () => {
    await api.get('/characters');
    await api.post('/characters', { name: 'Ada' });
    await api.post('/themes/neo/activate');
    const inits = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
    expect(inits[0]).toMatchObject({ method: 'GET', body: undefined, credentials: 'same-origin' });
    expect(inits[0]?.headers).toEqual({});
    expect(inits[1]).toMatchObject({ method: 'POST', body: '{"name":"Ada"}' });
    expect(inits[1]?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(inits[2]).toMatchObject({ method: 'POST', body: undefined });
    expect(inits[2]?.headers).toEqual({});
  });

  it('forwards an abort signal to fetch', async () => {
    const controller = new AbortController();
    await api.post('/imports/sillytavern/execute', { all: true }, controller.signal);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
  });
});

describe('error envelopes', () => {
  it('surfaces code, params and traceId from the envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { code: 'NOT_FOUND', params: { id: 'chat-9' }, traceId: 'trace-1' },
        { status: 404 },
      ),
    );
    const error = await api.get('/chats/chat-9').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.name).toBe('ApiError');
    expect(apiError.message).toBe('NOT_FOUND');
    expect(apiError.code).toBe('NOT_FOUND');
    expect(apiError.params).toEqual({ id: 'chat-9' });
    expect(apiError.traceId).toBe('trace-1');
  });

  it('falls back to INTERNAL when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>proxy exploded</html>', { status: 502 }));
    const error = await api.get('/settings').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('INTERNAL');
    expect((error as ApiError).params).toEqual({});
    expect((error as ApiError).traceId).toBeUndefined();
  });

  it('clears the CSRF token and announces auth-required on UNAUTHORIZED', async () => {
    setCsrfToken('c'.repeat(43));
    const authRequired = vi.fn();
    window.addEventListener('neotavern-auth-required', authRequired);
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'UNAUTHORIZED' }, { status: 401 }));
      const error = await api
        .post('/chats', { characterId: 'char-1' })
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('UNAUTHORIZED');
      expect(getCsrfToken()).toBeNull();
      expect(authRequired).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('neotavern-auth-required', authRequired);
    }
  });
});

describe('csrf token', () => {
  it('attaches X-CSRF-Token only to mutating requests while a token is known', async () => {
    const token = 'c'.repeat(43);
    setCsrfToken(token);
    await api.get('/characters');
    await api.post('/characters', { name: 'Ada' });
    await api.del('/characters/char-1');
    setCsrfToken(null);
    await api.post('/characters', { name: 'Grace' });
    const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers);
    expect(headers[0]).toEqual({});
    expect(headers[1]).toEqual({ 'Content-Type': 'application/json', 'X-CSRF-Token': token });
    expect(headers[2]).toEqual({ 'X-CSRF-Token': token });
    expect(headers[3]).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('transport failures', () => {
  it('wraps network failures in ApiNetworkError preserving the cause', async () => {
    const failure = new TypeError('fetch failed');
    fetchMock.mockRejectedValueOnce(failure);
    const error = await api.get('/themes').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect((error as ApiNetworkError).name).toBe('ApiNetworkError');
    expect((error as ApiNetworkError).message).toBe('API_NETWORK_ERROR');
    expect((error as ApiNetworkError).cause).toBe(failure);
  });

  it('rethrows AbortError without wrapping it', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValueOnce(abort);
    await expect(api.get('/settings')).rejects.toBe(abort);
  });
});

describe('uploads', () => {
  it('sends files as FormData with the CSRF header and parses the result', async () => {
    const token = 'c'.repeat(43);
    setCsrfToken(token);
    fetchMock.mockResolvedValueOnce(jsonResponse({ installed: true }));
    const file = new File(['PK'], 'theme.zip', { type: 'application/zip' });
    await expect(api.upload('/themes/install', file)).resolves.toEqual({ installed: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v2/themes/install');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'X-CSRF-Token': token });
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const sent = form.get('file') as File;
    expect(sent).toBeInstanceOf(File);
    expect(sent.name).toBe('theme.zip');
  });

  it('surfaces upload error envelopes as ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'PAYLOAD_TOO_LARGE', params: { maxBytes: 10 } }, { status: 413 }),
    );
    const error = await api
      .upload('/characters/import', new File(['x'], 'character.png'))
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PAYLOAD_TOO_LARGE');
    expect((error as ApiError).params).toEqual({ maxBytes: 10 });
  });
});

describe('browser storage', () => {
  it('never reads or writes browser storage for secrets', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const clear = vi.spyOn(Storage.prototype, 'clear');
    setCsrfToken('c'.repeat(43));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'char-1' }));
    await api.get('/characters/char-1');
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'char-2' }, { status: 201 }));
    await api.post('/characters', { name: 'Ada' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'FORBIDDEN' }, { status: 403 }));
    await expect(api.get('/providers')).rejects.toBeInstanceOf(ApiError);
    fetchMock.mockResolvedValueOnce(jsonResponse({ required: false, authenticated: true }));
    await api.upload('/themes/install', new File(['z'], 't.zip'));
    setCsrfToken(null);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(getCsrfToken()).toBeNull();
  });
});
