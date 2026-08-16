/** Tests for the TanStack Query hooks (renderHook + real QueryClient). */
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryClient, jsonResponse } from '../../test/helpers.js';
import { getCsrfToken, setCsrfToken } from './client.js';
import {
  useAuthSession,
  useBackgrounds,
  useBackups,
  useClearDiagnosticCache,
  useCreateBackup,
  useDeleteBackground,
  useDeleteCharacter,
  useDiagnostics,
  useLogin,
  useRebuildSearch,
  useRestoreBackup,
  useUploadBackground,
} from './hooks.js';
import { backend } from './backend.js';

// Kernel-mode honesty (slice 17): the diagnostics hooks consult
// `isKernelMode`; the default here is the legacy plane so the existing tests
// stay as they were.
const mocks = vi.hoisted(() => ({ isKernelMode: vi.fn(() => false) }));
vi.mock('./backend.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { backend: unknown };
  return { ...actual, isKernelMode: mocks.isKernelMode };
});

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

describe('diagnostics hooks (kernel-plane honesty, slice 17)', () => {
  it('useDiagnostics fetches the legacy snapshot on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ generatedAt: '2026-08-13T00:00:00Z' }));
    const { result } = renderHook(() => useDiagnostics(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v2/diagnostics');
  });

  it('useDiagnostics resolves null on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useDiagnostics(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useRebuildSearch rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useRebuildSearch(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useClearDiagnosticCache rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useClearDiagnosticCache(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });
});

describe('backups hooks (kernel-plane honesty, slice 19)', () => {
  const BACKUP_DTO = {
    id: '018f0000-0000-7000-8000-000000000099',
    createdAt: '2026-08-13T00:00:00.000Z',
    formatVersion: 1,
    sizeBytes: 2048,
    checksumSha256: 'a'.repeat(64),
    status: 'completed',
  } as const;

  it('useBackups fetches the legacy list on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [{ id: 'b1', kind: 'manual', createdAt: 1, sizeBytes: 2 }] }),
    );
    const { result } = renderHook(() => useBackups(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v2/backups');
  });

  it('useBackups maps the wire list on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const listSpy = vi.spyOn(backend.backups, 'list').mockResolvedValue({ items: [BACKUP_DTO] });
    const { result } = renderHook(() => useBackups(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      {
        id: BACKUP_DTO.id,
        kind: 'manual',
        createdAt: Date.parse(BACKUP_DTO.createdAt),
        sizeBytes: 2048,
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    listSpy.mockRestore();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useCreateBackup calls the wire op on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const createSpy = vi.spyOn(backend.backups, 'create').mockResolvedValue(BACKUP_DTO);
    const { result } = renderHook(() => useCreateBackup(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(createSpy).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    createSpy.mockRestore();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useRestoreBackup rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useRestoreBackup(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate('b1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });
});

describe('backgrounds hooks (kernel-plane honesty, slice 20)', () => {
  it('useBackgrounds fetches the legacy list on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: 'bg1' }] }));
    const { result } = renderHook(() => useBackgrounds(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v2/backgrounds');
  });

  it('useBackgrounds resolves an honest empty list on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useBackgrounds(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ items: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useUploadBackground rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useUploadBackground(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate(new File(['x'], 'wall.png', { type: 'image/png' })));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useDeleteBackground rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useDeleteBackground(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate('bg1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });
});
