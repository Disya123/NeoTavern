/** Tests for the provider/secret hooks (renderHook + real QueryClient). */
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  ProviderConfigCreate,
  ProviderConfigDto,
  ProviderConfigUpdate,
} from '@neotavern/contracts';
import { createQueryClient, jsonResponse } from '../../test/helpers.js';
import { UnsupportedError } from '@neotavern/neobackend';
import {
  translateProviderConfig,
  useCreateProvider,
  useCreateSecret,
  useDeleteProvider,
  useDeleteSecret,
  useDiscoverProviderModels,
  useProviderCatalog,
  useProviderSecrets,
  useProviders,
  useRevealSecret,
  useSecretsExposure,
  useUpdateProvider,
  useUpdateSecret,
} from './providerHooks.js';
import { backend } from './backend.js';

// Kernel-mode honesty (slice 26): the provider hooks consult `isKernelMode`;
// the default here is the legacy plane so the existing behavior stays tested.
const mocks = vi.hoisted(() => ({ isKernelMode: vi.fn(() => false) }));
vi.mock('./backend.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { backend: unknown };
  return { ...actual, isKernelMode: mocks.isKernelMode };
});

const PROVIDER_DTO: ProviderConfigDto = {
  id: 'cfg-1',
  provider: 'openai-compatible',
  name: 'default',
  config: { baseUrl: 'https://api.example.com/v1', model: 'gpt-4o', enabled: true },
  hasApiKey: true,
  createdAt: '2026-08-13T00:00:00Z',
  updatedAt: '2026-08-13T01:00:00Z',
};

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = createQueryClient();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  mocks.isKernelMode.mockReturnValue(false);
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('translateProviderConfig', () => {
  it('translates the wire config into the legacy UI shape (epoch-ms timestamps)', () => {
    const legacy = translateProviderConfig(PROVIDER_DTO);
    expect(legacy).toEqual({
      id: 'cfg-1',
      kind: 'openai-compatible',
      name: 'default',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
      enabled: true,
      hasApiKey: true,
      settings: { baseUrl: 'https://api.example.com/v1', model: 'gpt-4o', enabled: true },
      createdAt: Date.parse('2026-08-13T00:00:00Z'),
      updatedAt: Date.parse('2026-08-13T01:00:00Z'),
    });
  });

  it('falls back to null/true for missing connection fields', () => {
    const legacy = translateProviderConfig({
      ...PROVIDER_DTO,
      config: {},
      hasApiKey: false,
    });
    expect(legacy.baseUrl).toBeNull();
    expect(legacy.model).toBeNull();
    expect(legacy.enabled).toBe(true);
    expect(legacy.hasApiKey).toBe(false);
  });
});

describe('useProviders', () => {
  it('lists wire configs on the kernel plane without fetching', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const listSpy = vi
      .spyOn(backend.providers.config, 'list')
      .mockResolvedValue({ items: [PROVIDER_DTO] });
    const { result } = renderHook(() => useProviders(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(result.current.data?.items[0]).toMatchObject({
      id: 'cfg-1',
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
    });
  });

  it('fetches the legacy list on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    const { result } = renderHook(() => useProviders(), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/providers');
  });
});

describe('useProviderCatalog', () => {
  it('is an honest UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useProviderCatalog(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeInstanceOf(UnsupportedError);
    expect((result.current.error as UnsupportedError).feature).toBe('providers.catalog');
  });

  it('fetches the legacy catalog on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    const { result } = renderHook(() => useProviderCatalog(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/providers/catalog');
  });
});

describe('provider config mutations', () => {
  it('creates via wire providers.config.set with the legacy single-config name', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const setSpy = vi.spyOn(backend.providers.config, 'set').mockResolvedValue(PROVIDER_DTO);
    const input: ProviderConfigCreate = {
      kind: 'openai-compatible',
      name: 'my-api',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
      enabled: true,
      apiKey: 'sk-test',
      settings: { source: 'openai-compatible' },
    };
    const { result } = renderHook(() => useCreateProvider(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate(input));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      name: 'default',
      config: {
        source: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o',
        enabled: true,
      },
      apiKey: 'sk-test',
    });
    expect(result.current.data).toMatchObject({ id: 'cfg-1', kind: 'openai-compatible' });
  });

  it('creates via the legacy POST on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'cfg-9' }));
    const { result } = renderHook(() => useCreateProvider(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate({ kind: 'echo', name: 'x' } satisfies ProviderConfigCreate));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v2/providers');
    expect(init.method).toBe('POST');
  });

  it('updates via wire config.set, merging over the located config', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    vi.spyOn(backend.providers.config, 'list').mockResolvedValue({ items: [PROVIDER_DTO] });
    const setSpy = vi
      .spyOn(backend.providers.config, 'set')
      .mockResolvedValue({ ...PROVIDER_DTO, config: { ...PROVIDER_DTO.config, model: 'gpt-5' } });
    const update: ProviderConfigUpdate = { model: 'gpt-5' };
    const { result } = renderHook(() => useUpdateProvider(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate({ id: 'cfg-1', update }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      name: 'default',
      config: {
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-5',
        enabled: true,
      },
    });
  });

  it('reports PROVIDER_CONFIG_NOT_FOUND for an unknown legacy id', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    vi.spyOn(backend.providers.config, 'list').mockResolvedValue({ items: [PROVIDER_DTO] });
    const { result } = renderHook(() => useUpdateProvider(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate({ id: 'cfg-nope', update: { enabled: false } }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('PROVIDER_CONFIG_NOT_FOUND');
  });

  it('deletes via wire config.del on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    vi.spyOn(backend.providers.config, 'list').mockResolvedValue({ items: [PROVIDER_DTO] });
    const delSpy = vi.spyOn(backend.providers.config, 'del').mockResolvedValue({});
    const { result } = renderHook(() => useDeleteProvider(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate('cfg-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(delSpy).toHaveBeenCalledWith('openai-compatible', 'default');
    expect(result.current.data).toEqual({ ok: true });
  });
});

describe('model discovery and secrets (kernel-plane honesty)', () => {
  it('model discovery is an honest UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useDiscoverProviderModels(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate('cfg-1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeInstanceOf(UnsupportedError);
    expect((result.current.error as UnsupportedError).feature).toBe('providers.models.discovery');
  });

  it('secret list is an honest UnsupportedError on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useProviderSecrets('cfg-1'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeInstanceOf(UnsupportedError);
    expect((result.current.error as UnsupportedError).feature).toBe('providers.secrets.list');
  });

  it('reports allowSecretsExposure=false on the kernel plane without fetching', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const { result } = renderHook(() => useSecretsExposure(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({ allowSecretsExposure: false });
  });

  it('secret mutations are honest UnsupportedErrors on the kernel plane', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const create = renderHook(() => useCreateSecret(), { wrapper: wrapperFor(queryClient) });
    act(() => create.result.current.mutate({ providerId: 'cfg-1', input: { value: 'sk-test' } }));
    await waitFor(() => expect(create.result.current.isError).toBe(true));
    expect(create.result.current.error).toBeInstanceOf(UnsupportedError);
    expect((create.result.current.error as UnsupportedError).feature).toBe(
      'providers.secrets.create',
    );

    const update = renderHook(() => useUpdateSecret(), { wrapper: wrapperFor(queryClient) });
    act(() =>
      update.result.current.mutate({
        providerId: 'cfg-1',
        secretId: 'sec-1',
        update: { active: true },
      }),
    );
    await waitFor(() => expect(update.result.current.isError).toBe(true));
    expect((update.result.current.error as UnsupportedError).feature).toBe(
      'providers.secrets.update',
    );

    const del = renderHook(() => useDeleteSecret(), { wrapper: wrapperFor(queryClient) });
    act(() => del.result.current.mutate({ providerId: 'cfg-1', secretId: 'sec-1' }));
    await waitFor(() => expect(del.result.current.isError).toBe(true));
    expect((del.result.current.error as UnsupportedError).feature).toBe('providers.secrets.delete');

    const reveal = renderHook(() => useRevealSecret(), { wrapper: wrapperFor(queryClient) });
    act(() => reveal.result.current.mutate({ providerId: 'cfg-1', secretId: 'sec-1' }));
    await waitFor(() => expect(reveal.result.current.isError).toBe(true));
    expect((reveal.result.current.error as UnsupportedError).feature).toBe(
      'providers.secrets.reveal',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('secret list fetches the legacy endpoint on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    const { result } = renderHook(() => useProviderSecrets('cfg-1'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/providers/cfg-1/secrets');
  });

  it('secrets exposure fetches the legacy endpoint on the legacy plane', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ allowSecretsExposure: true }));
    const { result } = renderHook(() => useSecretsExposure(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/secrets/exposure');
  });
});
