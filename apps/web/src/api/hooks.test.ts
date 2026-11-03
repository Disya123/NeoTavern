/** Tests for the TanStack Query hooks (renderHook + real QueryClient). */
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryClient, jsonResponse } from '../../test/helpers.js';
import { getCsrfToken, setCsrfToken } from './client.js';
import {
  useAnalyzeFullBackup,
  useAuthSession,
  useBackgroundImageUrl,
  useBackgrounds,
  useBackups,
  useCharacterGallery,
  useCharacters,
  useCharacterVersions,
  useClearDiagnosticCache,
  useCreateBackup,
  useDeleteBackground,
  useDeleteBackup,
  useDeleteCharacter,
  useDeleteCharacterImage,
  useDiagnostics,
  useDiscardFullBackupAnalysis,
  useExecuteFullBackupImport,
  useImportCharacter,
  useInstructFormats,
  useLogin,
  useLogout,
  usePromptContextAudit,
  usePromptContextPreview,
  usePromptPlan,
  useChatContextAudit,
  useDataActivationStatus,
  useRebuildSearch,
  useReorderChats,
  useRestoreBackup,
  useRestoreCharacter,
  useRestoreCharacterVersion,
  useUploadBackground,
  useUploadCharacterImage,
} from './hooks.js';
import { backend } from './backend.js';
import { UnsupportedError } from '@neotavern/neobackend';
import { ProductError } from '@neotavern/client-sdk';

// Kernel-mode honesty (slice 17): the diagnostics hooks consult
// `isKernelMode`; the default here is the legacy plane so the existing tests
// stay as they were.
const mocks = vi.hoisted(() => ({ isKernelMode: vi.fn(() => false) }));
const assetsMock = vi.hoisted(() => ({
  list: vi.fn(),
  del: vi.fn(),
  uploadBegin: vi.fn(),
  uploadAppend: vi.fn(),
  uploadFinish: vi.fn(),
}));
const importsMock = vi.hoisted(() => ({
  fullBackupAnalyze: vi.fn(),
  fullBackupExecute: vi.fn(),
}));
vi.mock('./backend.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { backend: Record<string, unknown> };
  const realBackend = actual.backend;
  const realAssets = (realBackend as { assets: Record<string, unknown> }).assets;
  // Wrap (never copy) the facade: other tests spy on `backend.characters` etc.,
  // and a spread copy would drop prototype getters.
  const assetsProxy = new Proxy(realAssets, {
    get(target, prop, receiver) {
      if (prop in assetsMock) return assetsMock[prop as keyof typeof assetsMock];
      return Reflect.get(target, prop, receiver);
    },
  });
  const realImports = (realBackend as { imports: Record<string, unknown> }).imports;
  const importsProxy = new Proxy(realImports, {
    get(target, prop, receiver) {
      if (prop in importsMock) return importsMock[prop as keyof typeof importsMock];
      return Reflect.get(target, prop, receiver);
    },
  });
  const backendProxy = new Proxy(realBackend, {
    get(target, prop, receiver) {
      if (prop === 'assets') return assetsProxy;
      if (prop === 'imports') return importsProxy;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, isKernelMode: mocks.isKernelMode, backend: backendProxy };
});

// `usePromptPlan` routes through wireBridge.getPromptPlan; the plan itself is
// mocked so the hook tests stay transport-free. The gallery hooks (M7 Etap-4
// slice) route through the same module for asset data URLs and file reads.
const promptPlanMock = vi.hoisted(() => ({
  getPromptPlan: vi.fn(),
  getChatContextAudit: vi.fn(),
  readAssetContentDataUrl: vi.fn(),
  readFileBase64: vi.fn(),
}));
const activationStatusMock = vi.hoisted(() => ({ getDataActivationStatus: vi.fn() }));
vi.mock('./wireBridge.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getPromptPlan: promptPlanMock.getPromptPlan,
    getChatContextAudit: promptPlanMock.getChatContextAudit,
    getDataActivationStatus: activationStatusMock.getDataActivationStatus,
    readAssetContentDataUrl: promptPlanMock.readAssetContentDataUrl,
    readFileBase64: promptPlanMock.readFileBase64,
  };
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

describe('character trash + version history hooks (M7 Etap-4 cluster 26)', () => {
  const characterDto = {
    id: '018f0000-0000-7000-8000-000000000401',
    name: 'Seraphina',
    description: 'Forest guardian',
    tags: ['fantasy'],
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
  };

  it('useRestoreCharacter restores via the wire op on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const restoreSpy = vi
      .spyOn(backend.characters, 'restore')
      .mockResolvedValue(characterDto as never);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRestoreCharacter(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate(characterDto.id));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(restoreSpy).toHaveBeenCalledWith(characterDto.id);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['characters'] });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useRestoreCharacter posts the legacy restore route on the legacy plane', async () => {
    mocks.isKernelMode.mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { result } = renderHook(() => useRestoreCharacter(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate('char-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v2/characters/char-1/restore');
    expect(init.method).toBe('POST');
  });

  it('useCharacters asks the wire for trashed rows with includeDeleted', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const listSpy = vi.spyOn(backend.characters, 'list').mockResolvedValue({
      items: [
        characterDto,
        {
          ...characterDto,
          id: '018f0000-0000-7000-8000-000000000402',
          deletedAt: '2026-08-14T00:00:00Z',
        },
      ],
      nextCursor: undefined,
    } as never);
    const { result } = renderHook(() => useCharacters({ includeDeleted: true, limit: 50 }), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listSpy).toHaveBeenCalledWith({ limit: 50, includeDeleted: true });
    const items = result.current.data?.pages.flatMap((page) => page.items) ?? [];
    expect(items.map((item) => item.deletedAt)).toEqual([null, Date.parse('2026-08-14T00:00:00Z')]);
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useCharacterVersions maps the wire snapshot list on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const versionsSpy = vi.spyOn(backend.characters, 'versionsList').mockResolvedValue({
      items: [
        {
          id: '018f0000-0000-7000-8000-000000000501',
          characterId: characterDto.id,
          version: 3,
          createdAt: '2026-08-13T00:00:00Z',
        },
      ],
      truncated: false,
    } as never);
    const { result } = renderHook(() => useCharacterVersions(characterDto.id), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(versionsSpy).toHaveBeenCalledWith(characterDto.id);
    expect(result.current.data?.items[0]).toEqual({
      id: '018f0000-0000-7000-8000-000000000501',
      characterId: characterDto.id,
      version: 3,
      createdAt: Date.parse('2026-08-13T00:00:00Z'),
    });
    expect(result.current.data?.truncated).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useRestoreCharacterVersion applies a snapshot via the wire op', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const restoreSpy = vi
      .spyOn(backend.characters, 'versionsRestore')
      .mockResolvedValue(characterDto as never);
    const { result } = renderHook(() => useRestoreCharacterVersion(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate({ characterId: characterDto.id, versionId: 'version-1' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(restoreSpy).toHaveBeenCalledWith({
      characterId: characterDto.id,
      versionId: 'version-1',
    });
    expect(queryClient.getQueryData(['character', characterDto.id])).toMatchObject({
      name: 'Seraphina',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
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

  it('useRebuildSearch rebuilds through the wire op on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const rebuildSpy = vi
      .spyOn(backend.search, 'rebuild')
      .mockResolvedValue({ query: '', items: [] } as never);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRebuildSearch(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['diagnostics'] });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useRebuildSearch posts the legacy rebuild route on the legacy plane', async () => {
    mocks.isKernelMode.mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(jsonResponse({ query: '', results: [] }));
    const { result } = renderHook(() => useRebuildSearch(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v2/search/rebuild');
    expect(init.method).toBe('POST');
  });

  it('useClearDiagnosticCache clears through the wire op on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const clearSpy = vi
      .spyOn(backend.diagnostics, 'cacheClear')
      .mockResolvedValue({ removedFiles: 3, removedBytes: 1024, metadataRowsRemoved: 0 });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useClearDiagnosticCache(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({
      removedFiles: 3,
      removedBytes: 1024,
      metadataRowsRemoved: 0,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['diagnostics'] });
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

  it('useRestoreBackup restores via the wire op on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const restoreSpy = vi
      .spyOn(backend.backups, 'restore')
      .mockResolvedValue({ status: 'committed' });
    const { result } = renderHook(() => useRestoreBackup(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate('b1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(restoreSpy).toHaveBeenCalledWith('b1');
    expect(fetchMock).not.toHaveBeenCalled();
    restoreSpy.mockRestore();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useRestoreBackup maps activation_pending onto restartRequired', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const restoreSpy = vi
      .spyOn(backend.backups, 'restore')
      .mockResolvedValue({ status: 'activation_pending' });
    const { result } = renderHook(() => useRestoreBackup(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate('b1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ restartRequired: true });
    restoreSpy.mockRestore();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useDeleteBackup deletes via the wire op on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const deleteSpy = vi.spyOn(backend.backups, 'del').mockResolvedValue({ deleted: true });
    const { result } = renderHook(() => useDeleteBackup(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate('b1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ deleted: true });
    expect(deleteSpy).toHaveBeenCalledWith('b1');
    expect(fetchMock).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useDeleteBackup uses the legacy DELETE endpoint on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ deleted: true }));
    const { result } = renderHook(() => useDeleteBackup(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate('b1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ deleted: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method?: string }];
    expect(url).toBe('/api/v2/backups/b1');
    expect(init.method).toBe('DELETE');
  });
});

describe('backgrounds hooks (kernel plane: asset catalogue + chunked upload)', () => {
  it('useBackgrounds fetches the legacy list on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: 'bg1' }] }));
    const { result } = renderHook(() => useBackgrounds(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v2/backgrounds');
  });

  it('useBackgrounds reads the background kind from the asset catalogue on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    assetsMock.list.mockResolvedValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'background',
          relativeKey: 'background/abc123.webp',
          checksumSha256: 'a'.repeat(64),
          sizeBytes: 2048,
          createdAt: '2026-11-02T10:00:00Z',
        },
      ],
    });
    const { result } = renderHook(() => useBackgrounds(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(assetsMock.list).toHaveBeenCalledWith({ kind: 'background', limit: 200 });
    expect(result.current.data).toEqual({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'abc123.webp',
          originalUrl: '',
          thumbnailUrl: '',
          sizeBytes: 2048,
          createdAt: Date.parse('2026-11-02T10:00:00Z'),
        },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useUploadBackground stages bounded chunks and publishes one background asset', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    assetsMock.uploadBegin.mockResolvedValue({ uploadId: 'u1', chunkSizeBytes: 3, expiresAt: 'x' });
    // The hook reads the file through `readFileBase64`; 'abcde' base64-encodes
    // to 'YWJjZGU=' (5 raw bytes), staged as 3 + 2 bytes.
    promptPlanMock.readFileBase64.mockReset();
    promptPlanMock.readFileBase64.mockResolvedValue(btoa('abcde'));
    assetsMock.uploadAppend.mockResolvedValue({ uploadId: 'u1', receivedBytes: 0, nextIndex: 0 });
    assetsMock.uploadFinish.mockResolvedValue({
      asset: {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'background',
        relativeKey: 'background/def456.png',
        checksumSha256: 'b'.repeat(64),
        sizeBytes: 5,
        createdAt: '2026-11-02T11:00:00Z',
      },
      deduplicated: false,
    });
    const { result } = renderHook(() => useUploadBackground(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate(new File(['abcde'], 'wall.png', { type: 'image/png' })));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(assetsMock.uploadBegin).toHaveBeenCalledWith({
      kind: 'background',
      filename: 'wall.png',
      contentType: 'image/png',
      totalBytes: 5,
    });
    // 5 raw bytes at a 3-byte chunk size = two sequential appends (3 + 2).
    expect(assetsMock.uploadAppend).toHaveBeenCalledTimes(2);
    expect(assetsMock.uploadAppend.mock.calls.map((call) => call[0].index)).toEqual([0, 1]);
    const bodies = assetsMock.uploadAppend.mock.calls.map(
      (call) => atob(call[0].contentBase64 as string) as string,
    );
    expect(bodies).toEqual(['abc', 'de']);
    // No chunk ever exceeds the size the kernel negotiated.
    expect(bodies.every((body) => body.length <= 3)).toBe(true);
    expect(assetsMock.uploadFinish).toHaveBeenCalledWith({ uploadId: 'u1' });
    expect(result.current.data?.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useDeleteBackground deletes the asset on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    assetsMock.del.mockResolvedValue({});
    const { result } = renderHook(() => useDeleteBackground(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate('asset-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(assetsMock.del).toHaveBeenCalledWith('asset-1');
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useBackgroundImageUrl resolves the wallpaper through assets.content on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    promptPlanMock.readAssetContentDataUrl.mockResolvedValue('data:image/png;base64,AAA');
    const { result } = renderHook(() => useBackgroundImageUrl('asset-1'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current).toBe('data:image/png;base64,AAA'));
    expect(promptPlanMock.readAssetContentDataUrl).toHaveBeenCalledWith('asset-1');
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useBackgroundImageUrl answers null without a wallpaper id on both planes', () => {
    promptPlanMock.readAssetContentDataUrl.mockClear();
    const { result } = renderHook(() => useBackgroundImageUrl(null), {
      wrapper: wrapperFor(queryClient),
    });
    expect(result.current).toBeNull();
    expect(promptPlanMock.readAssetContentDataUrl).not.toHaveBeenCalled();
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

  it('useCharacterGallery maps wire items with asset data URLs on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const listSpy = vi.spyOn(backend.characters, 'galleryList').mockResolvedValue({
      items: [
        {
          id: 'img-1',
          characterId: 'char-1',
          assetId: 'asset-1',
          filename: 'sunset.png',
          createdAt: '2026-08-13T00:00:00Z',
          sizeBytes: 5,
          checksumSha256: 'a'.repeat(64),
        },
      ],
    });
    promptPlanMock.readAssetContentDataUrl.mockResolvedValue('data:image/png;base64,aGVsbG8=');
    const { result } = renderHook(() => useCharacterGallery('char-1', 'newest'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      items: [
        {
          id: 'img-1',
          characterId: 'char-1',
          assetId: 'asset-1',
          name: 'sunset.png',
          mime: 'image/png',
          sizeBytes: 5,
          originalUrl: 'data:image/png;base64,aGVsbG8=',
          thumbnailUrl: 'data:image/png;base64,aGVsbG8=',
          createdAt: Date.parse('2026-08-13T00:00:00Z'),
        },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    listSpy.mockRestore();
    promptPlanMock.readAssetContentDataUrl.mockReset();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useUploadCharacterImage adds via the wire op on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const addSpy = vi.spyOn(backend.characters, 'galleryAdd').mockResolvedValue({
      item: {
        id: 'img-2',
        characterId: 'char-1',
        assetId: 'asset-2',
        filename: 'a.png',
        createdAt: '2026-08-13T00:00:00Z',
        sizeBytes: 1,
        checksumSha256: 'b'.repeat(64),
      },
      deduplicated: false,
    });
    promptPlanMock.readFileBase64.mockResolvedValue('eA==');
    const { result } = renderHook(() => useUploadCharacterImage(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() =>
      result.current.mutate({
        characterId: 'char-1',
        file: new File(['x'], 'a.png', { type: 'image/png' }),
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: 'char-1', filename: 'a.png' }),
    );
    expect(result.current.data?.assetId).toBe('asset-2');
    expect(fetchMock).not.toHaveBeenCalled();
    addSpy.mockRestore();
    promptPlanMock.readFileBase64.mockReset();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useDeleteCharacterImage deletes via the wire op on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const deleteSpy = vi
      .spyOn(backend.characters, 'galleryDelete')
      .mockResolvedValue({ deleted: true });
    const { result } = renderHook(() => useDeleteCharacterImage(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate({ characterId: 'char-1', imageId: 'img1' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ deleted: true });
    expect(deleteSpy).toHaveBeenCalledWith({ characterId: 'char-1', imageId: 'img1' });
    expect(fetchMock).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
    mocks.isKernelMode.mockReturnValue(false);
  });
});

describe('remaining legacy hooks (kernel-plane honesty, slice 22)', () => {
  it('useReorderChats reorders via wire chats.reorder on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const reorderSpy = vi.spyOn(backend.chats, 'reorder').mockResolvedValue({ reordered: 2 });
    const { result } = renderHook(() => useReorderChats(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ characterId: 'char-1', order: ['c1', 'c2'] }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ reordered: 2, invalidIds: [] });
    expect(reorderSpy).toHaveBeenCalledWith({ characterId: 'char-1', order: ['c1', 'c2'] });
    expect(fetchMock).not.toHaveBeenCalled();
    reorderSpy.mockRestore();
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

  it('usePromptPlan resolves the durable plan from generation.prompt.plan', async () => {
    promptPlanMock.getPromptPlan.mockResolvedValue({
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      chatId: 'chat-1',
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      instructFormat: 'chatml',
      tokenizerProfile: 'heuristic',
      approximateTokens: true,
      contextLimit: 8192,
      responseReserved: 1024,
      inputTokens: 1200,
      overBudget: false,
      systemBlocks: [{ source: 'character', text: 'You are Alice.' }],
      messages: [{ role: 'user', content: 'Hello.' }],
      excluded: [],
      createdAt: '2026-06-01T12:00:00.000Z',
    });
    const { result } = renderHook(() => usePromptPlan('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(promptPlanMock.getPromptPlan).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(result.current.data?.inputTokens).toBe(1200);
  });

  it('usePromptPlan resolves null when the run has no recorded plan', async () => {
    promptPlanMock.getPromptPlan.mockRejectedValue(
      new ProductError({
        code: 'PROMPT_PLAN_NOT_FOUND',
        params: { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        traceId: 't',
      }),
    );
    const { result } = renderHook(() => usePromptPlan('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('usePromptPlan resolves null when the plane refuses (honest CAPABILITY_UNAVAILABLE)', async () => {
    promptPlanMock.getPromptPlan.mockRejectedValue(new UnsupportedError('generation.prompt.plan'));
    const { result } = renderHook(() => usePromptPlan('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('useChatContextAudit resolves the chat latest plan from chats.context.audit', async () => {
    const plan = {
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      chatId: 'chat-1',
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      instructFormat: 'chatml',
      tokenizerProfile: 'heuristic',
      approximateTokens: true,
      contextLimit: 8192,
      responseReserved: 1024,
      inputTokens: 940,
      overBudget: false,
      systemBlocks: [{ source: 'character', text: 'You are Alice.' }],
      messages: [{ role: 'user', content: 'Hello.' }],
      excluded: [],
      createdAt: '2026-06-01T12:00:00.000Z',
    };
    promptPlanMock.getChatContextAudit.mockResolvedValue({ plan });
    const { result } = renderHook(() => useChatContextAudit('chat-1'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(promptPlanMock.getChatContextAudit).toHaveBeenCalledWith('chat-1');
    expect(result.current.data?.plan?.inputTokens).toBe(940);
  });

  it('useChatContextAudit resolves null when the chat has no generation yet', async () => {
    promptPlanMock.getChatContextAudit.mockResolvedValue({});
    const { result } = renderHook(() => useChatContextAudit('chat-1'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.plan).toBeUndefined();
  });

  it('useChatContextAudit resolves null when the plane refuses (honest CAPABILITY_UNAVAILABLE)', async () => {
    promptPlanMock.getChatContextAudit.mockRejectedValue(
      new UnsupportedError('chats.context.audit'),
    );
    const { result } = renderHook(() => useChatContextAudit('chat-1'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('useDataActivationStatus resolves the durable activation status on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    activationStatusMock.getDataActivationStatus.mockResolvedValue({
      layoutVersion: 2,
      activeRootId: 'a1b2c3d4',
      activeRoot: '/data/neotavern/roots/root-a1b2c3d4',
      journalFormat: 'neotavern-activation-journal',
      journalFormatVersion: 2,
      entries: [],
    });
    const { result } = renderHook(() => useDataActivationStatus(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.layoutVersion).toBe(2);
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useDataActivationStatus reports an honest error on the legacy plane without a network call', async () => {
    activationStatusMock.getDataActivationStatus.mockRejectedValue(
      new UnsupportedError('data.activation.status'),
    );
    const { result } = renderHook(() => useDataActivationStatus(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useInstructFormats fetches the legacy list on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: 'f1' }] }));
    const { result } = renderHook(() => useInstructFormats(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v2/settings/instruct-formats');
  });

  it('useInstructFormats reads the wire catalog on the kernel plane without a network call', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const spy = vi.spyOn(backend.settings, 'instructFormats').mockResolvedValue({
      formats: [
        { id: 'chatml', version: 1, stopStrings: ['<|im_end|>'] },
        { id: 'llama3', version: 1, stopStrings: ['<|eot_id|>'] },
        { id: 'alpaca', version: 1, stopStrings: ['###'] },
        { id: 'mistral', version: 1, stopStrings: ['</s>'] },
        { id: 'command-r', version: 1, stopStrings: ['<|END_OF_TURN_TOKEN|>'] },
      ],
    });
    const { result } = renderHook(() => useInstructFormats(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.formats.map((f: { id: string }) => f.id)).toEqual([
      'chatml',
      'llama3',
      'alpaca',
      'mistral',
      'command-r',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useAnalyzeFullBackup stages the archive and analyses it by asset id', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    promptPlanMock.readFileBase64.mockResolvedValue('YWJj');
    assetsMock.uploadBegin.mockResolvedValue({
      uploadId: 'u1',
      chunkSizeBytes: 512 * 1024,
      expiresAt: '',
    });
    assetsMock.uploadAppend.mockResolvedValue({});
    assetsMock.uploadFinish.mockResolvedValue({
      asset: { id: 'asset-1', sizeBytes: 3 },
      deduplicated: false,
    });
    importsMock.fullBackupAnalyze.mockResolvedValue({
      sourceHash: 'a'.repeat(64),
      totalCompressedBytes: 3,
      totalExpandedBytes: 9,
      categories: [
        { id: 'characters', discovered: 1, dependentRecords: 0, invalid: 0, sizeBytes: 3 },
        { id: 'chats', discovered: 2, dependentRecords: 40, invalid: 1, sizeBytes: 6 },
      ],
      warningCount: 0,
      warnings: [],
    });
    const { result } = renderHook(() => useAnalyzeFullBackup(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() =>
      result.current.mutate({
        file: new File(['abc'], 'backup.zip'),
        signal: new AbortController().signal,
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(importsMock.fullBackupAnalyze).toHaveBeenCalledWith('asset-1', expect.anything());
    expect(result.current.data).toMatchObject({
      analysisId: 'asset-1',
      sourceName: 'backup.zip',
      conflictCount: 0,
      conflicts: [],
      categories: [
        { id: 'characters', discovered: 1, conflicts: 0 },
        { id: 'chats', discovered: 2, dependentRecords: 40, invalid: 1 },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useExecuteFullBackupImport calls the wire op with the chosen policy (legacyExtensions dropped)', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    importsMock.fullBackupExecute.mockResolvedValue({
      runId: 'run-1',
      sourceHash: 'b'.repeat(64),
      conflictPolicy: 'skip',
      archiveAlreadyImported: false,
      categories: [
        {
          id: 'characters',
          discovered: 1,
          imported: 1,
          reused: 0,
          skipped: 0,
          conflicted: 0,
          invalid: 0,
          dependentImported: 0,
        },
      ],
      totals: {
        discovered: 1,
        imported: 1,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
      warningCount: 0,
      warnings: [],
    });
    const { result } = renderHook(() => useExecuteFullBackupImport(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() =>
      result.current.mutate({
        analysisId: 'a1',
        input: { categories: ['characters', 'legacyExtensions'], conflictPolicy: 'skip' },
        signal: new AbortController().signal,
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(importsMock.fullBackupExecute).toHaveBeenCalledWith(
      { assetId: 'a1', categories: ['characters'], conflictPolicy: 'skip' },
      expect.anything(),
    );
    expect(result.current.data).toMatchObject({
      jobId: 'run-1',
      safetyBackupId: '',
      counts: { characters: { imported: 1, reused: 0, skipped: 0 } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isKernelMode.mockReturnValue(false);
  });

  it('useDiscardFullBackupAnalysis drops the staged asset on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    assetsMock.del.mockResolvedValue({});
    const { result } = renderHook(() => useDiscardFullBackupAnalysis(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate('a1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(assetsMock.del).toHaveBeenCalledWith('a1');
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
