/** Tests for the TanStack Query hooks (renderHook + real QueryClient). */
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryClient, jsonResponse } from '../../test/helpers.js';
import { getCsrfToken, setCsrfToken } from './client.js';
import { useAuthSession, useDeleteCharacter, useLogin } from './hooks.js';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let queryClient: QueryClient;

beforeEach(() => {
  setCsrfToken(null);
  // Standard test client: retries off for both queries and mutations.
  queryClient = createQueryClient();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setCsrfToken(null);
});

describe('useAuthSession', () => {
  it('loads the session and keeps the CSRF token in memory only', async () => {
    const session = { required: true, authenticated: true, csrfToken: 'c'.repeat(43) };
    fetchMock.mockResolvedValueOnce(jsonResponse(session));
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useAuthSession(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/auth/session');
    expect(result.current.data).toEqual(session);
    expect(getCsrfToken()).toBe('c'.repeat(43));
    expect(storageSpy).not.toHaveBeenCalled();
  });
});

describe('useLogin', () => {
  it('posts the token, caches the session and stores the CSRF token in memory', async () => {
    const session = { required: true, authenticated: true, csrfToken: 'd'.repeat(43) };
    fetchMock.mockResolvedValueOnce(jsonResponse(session));
    const { result } = renderHook(() => useLogin(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ token: 'remote-secret' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v2/auth/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'remote-secret' });
    expect(getCsrfToken()).toBe('d'.repeat(43));
    expect(queryClient.getQueryData(['auth-session'])).toEqual(session);
  });
});

describe('useDeleteCharacter', () => {
  it('deletes via DELETE and invalidates the character list', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteCharacter(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate('char-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v2/characters/char-1');
    expect(init.method).toBe('DELETE');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['characters'] });
  });
});
