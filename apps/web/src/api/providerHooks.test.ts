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
const mocks = vi.hoisted(() => ({ isKernelMode: vi.fn(() => true) }));
vi.mock('./backend.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { backend: unknown };
  // A closed backend exposes no writable methods, so the mock supplies a stub
  // tree whose every path materializes a `vi.fn()` (descriptor included, which
  // `vi.spyOn` needs before it can replace a method).
  const stubNode = (path = ''): unknown => {
    const feature = () => (path.length === 0 ? 'stub:closed' : path);
    const fn = vi.fn().mockRejectedValue(new UnsupportedError(feature())) as unknown as Record<
      string | symbol,
      unknown
    >;
    const materialize = (t: Record<string | symbol, unknown>, p: string | symbol) => {
      if (!(p in t)) {
        const next = path.length === 0 ? String(p) : `${path}.${p}`;
        Object.defineProperty(t, p, {
          value: stubNode(next),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      return t[p];
    };
    return new Proxy(fn, {
      get: (t, p) => (p === 'then' ? undefined : materialize(t as never, p)),
      getOwnPropertyDescriptor: (t, p) => {
        const tt = t as unknown as Record<string | symbol, unknown>;
        materialize(tt, p);
        return { value: tt[p], configurable: true, enumerable: true, writable: true };
      },
    });
  };
  const target: Record<string | symbol, unknown> = {};
  const backendProxy = new Proxy(function stubBackend() {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (!(prop in target)) {
        Object.defineProperty(target, prop, {
          value: stubNode(String(prop)),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      return target[prop];
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (!(prop in target)) {
        Object.defineProperty(target, prop, {
          value: stubNode(String(prop)),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      return { value: target[prop], configurable: true, enumerable: true, writable: true };
    },
  });
  return { ...actual, isKernelMode: mocks.isKernelMode, backend: backendProxy };
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

describe('model discovery and secrets (kernel plane, cluster 7)', () => {
  it('model discovery maps the wire listing onto the legacy ModelInfo shape', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const modelsSpy = vi.spyOn(backend.providers, 'models').mockResolvedValue({
      models: [
        { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
        { id: 'gpt-4.1', name: 'GPT-4.1', contextLimit: 1000000 },
      ],
    });
    const { result } = renderHook(() => useDiscoverProviderModels(), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate('cfg-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(modelsSpy).toHaveBeenCalledWith({ providerId: 'cfg-1' });
    expect(result.current.data).toEqual({
      models: [
        { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
        { id: 'gpt-4.1', name: 'GPT-4.1', contextLimit: 1000000 },
      ],
    });
  });

  it('catalog maps the wire sources onto the UI shape and drops unknown ids', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const catalogSpy = vi.spyOn(backend.providers, 'catalog').mockResolvedValue({
      items: [
        {
          id: 'openai',
          adapterKind: 'openai',
          defaultBaseUrl: 'https://api.openai.com/v1',
          apiKeyRequired: true,
          baseUrlEditable: true,
          samplerSupport: ['temperature', 'not-a-real-parameter'],
        },
        {
          id: 'fake',
          adapterKind: 'fake',
          apiKeyRequired: false,
          baseUrlEditable: false,
          samplerSupport: [],
        },
      ],
    });
    const { result } = renderHook(() => useProviderCatalog(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(catalogSpy).toHaveBeenCalled();
    // The test-only `fake` source has no UI identity and is skipped; the
    // sampler list narrows to known generation parameters.
    expect(result.current.data).toEqual({
      items: [
        {
          id: 'openai',
          adapterKind: 'openai-compatible',
          defaultBaseUrl: 'https://api.openai.com/v1',
          apiKeyRequired: true,
          baseUrlEditable: true,
          samplerSupport: ['temperature'],
        },
      ],
    });
  });

  it('secret list maps wire DTOs (RFC3339 dates, optional label) without fetching', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const listSpy = vi.spyOn(backend.providers.secrets, 'list').mockResolvedValue({
      items: [
        {
          id: 'sec-1',
          providerId: 'cfg-1',
          active: true,
          masked: '••••••aB9z',
          createdAt: '2026-08-13T00:00:00Z',
        },
      ],
    });
    const { result } = renderHook(() => useProviderSecrets('cfg-1'), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listSpy).toHaveBeenCalledWith({ providerId: 'cfg-1' });
    expect(result.current.data?.items[0]).toEqual({
      id: 'sec-1',
      providerId: 'cfg-1',
      label: null,
      active: true,
      masked: '••••••aB9z',
      createdAt: Date.parse('2026-08-13T00:00:00Z'),
    });
  });

  it('exposure reflects the host policy from the facade without fetching', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const exposureSpy = vi
      .spyOn(backend.secrets, 'exposure')
      .mockResolvedValue({ allowSecretsExposure: true });
    const { result } = renderHook(() => useSecretsExposure(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exposureSpy).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ allowSecretsExposure: true });
  });

  it('secret mutations forward the canonical wire payloads and map the results', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const createSpy = vi
      .spyOn(backend.providers.secrets, 'create')
      .mockResolvedValue({ id: 'sec-new' });
    const updateSpy = vi.spyOn(backend.providers.secrets, 'update').mockResolvedValue({
      id: 'sec-new',
      providerId: 'cfg-1',
      label: 'prod',
      active: true,
      masked: '••••••aB9z',
      createdAt: '2026-08-13T00:00:00Z',
    });
    const deleteSpy = vi.spyOn(backend.providers.secrets, 'del').mockResolvedValue({});
    const revealSpy = vi
      .spyOn(backend.providers.secrets, 'reveal')
      .mockResolvedValue({ value: 'sk-plain' });

    const create = renderHook(() => useCreateSecret(), { wrapper: wrapperFor(queryClient) });
    act(() =>
      create.result.current.mutate({
        providerId: 'cfg-1',
        input: { value: 'sk-test', label: 'prod' },
      }),
    );
    await waitFor(() => expect(create.result.current.isSuccess).toBe(true));
    expect(create.result.current.data).toEqual({ id: 'sec-new' });
    expect(createSpy).toHaveBeenCalledWith({
      providerId: 'cfg-1',
      value: 'sk-test',
      label: 'prod',
    });

    const update = renderHook(() => useUpdateSecret(), { wrapper: wrapperFor(queryClient) });
    act(() =>
      update.result.current.mutate({
        providerId: 'cfg-1',
        secretId: 'sec-new',
        // The legacy null label clears the field on the wire.
        update: { label: null, active: true },
      }),
    );
    await waitFor(() => expect(update.result.current.isSuccess).toBe(true));
    expect(updateSpy).toHaveBeenCalledWith({
      providerId: 'cfg-1',
      secretId: 'sec-new',
      label: '',
      active: true,
    });
    expect(update.result.current.data).toMatchObject({
      id: 'sec-new',
      label: 'prod',
      active: true,
    });

    const del = renderHook(() => useDeleteSecret(), { wrapper: wrapperFor(queryClient) });
    act(() => del.result.current.mutate({ providerId: 'cfg-1', secretId: 'sec-new' }));
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));
    expect(deleteSpy).toHaveBeenCalledWith({ providerId: 'cfg-1', secretId: 'sec-new' });
    expect(del.result.current.data).toEqual({ ok: true });

    const reveal = renderHook(() => useRevealSecret(), { wrapper: wrapperFor(queryClient) });
    act(() => reveal.result.current.mutate({ providerId: 'cfg-1', secretId: 'sec-new' }));
    await waitFor(() => expect(reveal.result.current.isSuccess).toBe(true));
    expect(revealSpy).toHaveBeenCalledWith({ providerId: 'cfg-1', secretId: 'sec-new' });
    expect(reveal.result.current.data).toEqual({ value: 'sk-plain' });

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
