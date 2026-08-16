/** Tests for the TanStack Query hooks (renderHook + real QueryClient). */
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryClient, jsonResponse } from '../../test/helpers.js';
import { getCsrfToken, setCsrfToken } from './client.js';
import {
  useAnalyzeSillyTavern,
  useAuthSession,
  useBackgrounds,
  useBackups,
  useCharacterGallery,
  useClearDiagnosticCache,
  useCreateBackup,
  useDeleteBackground,
  useDeleteCharacter,
  useDeleteCharacterImage,
  useDiagnostics,
  useDiscardSillyTavernAnalysis,
  useExecuteSillyTavernImport,
  useImportCharacter,
  useInstructFormats,
  useLogin,
  useLogout,
  usePromptContextAudit,
  usePromptContextPreview,
  useRebuildSearch,
  useReorderChats,
  useRestoreBackup,
  useUploadBackground,
  useUploadCharacterImage,
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

describe('character gallery hooks (kernel-plane honesty, slice 21)', () => {
  it('useCharacterGallery fetches the legacy list on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [{ id: 'img1', name: 'a.png', thumbnailUrl: '/x.png' }] }),
    );
    const { result } = renderHook(() => useCharacterGallery('char-1', 'newest'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v2/characters/char-1/gallery?sort=newest');
  });

  it('useCharacterGallery resolves an honest empty list on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useCharacterGallery('char-1', 'newest'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ items: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useUploadCharacterImage rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useUploadCharacterImage(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() =>
      result.current.mutate({
        characterId: 'char-1',
        file: new File(['x'], 'a.png', { type: 'image/png' }),
      }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useDeleteCharacterImage rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useDeleteCharacterImage(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate({ characterId: 'char-1', imageId: 'img1' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });
});

describe('remaining legacy hooks (kernel-plane honesty, slice 22)', () => {
  it('useReorderChats rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useReorderChats(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ characterId: 'char-1', order: ['c1', 'c2'] }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('usePromptContextAudit rejects with UnsupportedError on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => usePromptContextAudit('chat-1'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useInstructFormats fetches the legacy list on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: 'f1' }] }));
    const { result } = renderHook(() => useInstructFormats(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v2/settings/instruct-formats');
  });

  it('useInstructFormats resolves an honest empty list on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useInstructFormats(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ formats: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useAnalyzeSillyTavern rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useAnalyzeSillyTavern(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() =>
      result.current.mutate({
        file: new File(['x'], 'st.zip'),
        signal: new AbortController().signal,
      }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useExecuteSillyTavernImport rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useExecuteSillyTavernImport(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() =>
      result.current.mutate({
        analysisId: 'a1',
        input: { categories: ['characters'], conflictPolicy: 'skip' },
        signal: new AbortController().signal,
      }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useDiscardSillyTavernAnalysis rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useDiscardSillyTavernAnalysis(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate('a1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });
});

describe('auth hooks (kernel-plane honesty, slice 23)', () => {
  it('useAuthSession resolves an honest local session on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useAuthSession(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ required: false, authenticated: true });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useLogin rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useLogin(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ token: 'secret' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useLogout rejects with UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useLogout(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });
});

describe('prompt context preview hook (kernel-plane honesty, slice 24)', () => {
  it('usePromptContextPreview fetches the legacy preview on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ preview: { providerConfigId: 'p1' } }));
    const { result } = renderHook(
      () =>
        usePromptContextPreview({
          characterId: 'char-1',
          userMessage: 'hi',
        }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v2/context-preview');
  });

  it('usePromptContextPreview rejects with UnsupportedError on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(
      () =>
        usePromptContextPreview({
          characterId: 'char-1',
          userMessage: 'hi',
        }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });
});

describe('character import hook (kernel-plane wire flow, slice 32)', () => {
  const ASSET_ID = '7a7b7c7d-7e7f-4a8b-9c0d-1e2f3a4b5c6d';
  const IMPORT_DTO = {
    character: {
      id: '9f8e7d6c-5b4a-4932-81f0-123456789abc',
      name: 'Ada Lovelace',
      description: 'First programmer',
      tags: ['analytical'],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    },
    created: true,
    sourceHash: 'a'.repeat(64),
    warnings: [],
  } as const;

  it('useImportCharacter stages the card via assets.put and imports through imports.character.card', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const putSpy = vi.spyOn(backend.assets, 'put').mockResolvedValue({
      asset: {
        id: ASSET_ID,
        kind: 'card',
        relativeKey: 'card/abc',
        checksumSha256: 'a'.repeat(64),
        sizeBytes: 3,
        createdAt: '2026-08-13T00:00:00.000Z',
      },
      deduplicated: false,
    });
    const importSpy = vi
      .spyOn(backend.imports, 'characterCard')
      .mockResolvedValue(IMPORT_DTO as never);
    const { result } = renderHook(() => useImportCharacter(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate(new File(['abc'], 'card.png', { type: 'image/png' })));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(putSpy).toHaveBeenCalledOnce();
    expect(importSpy).toHaveBeenCalledWith(ASSET_ID);
    // The wire result is mapped onto the legacy CharacterImportResult shape.
    expect(result.current.data).toMatchObject({
      created: true,
      sourceHash: 'a'.repeat(64),
      character: { id: IMPORT_DTO.character.id, name: 'Ada Lovelace' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    putSpy.mockRestore();
    importSpy.mockRestore();
    mocks.isKernelMode.mockReturnValue(false);
  });
});
