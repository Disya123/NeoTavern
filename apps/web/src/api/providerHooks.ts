/**
 * Provider and secret server-state hooks.
 *
 * Kernel plane (slice 26): the wire contract names provider configs by
 * provider+name (`providers.config.set/get/list/del`) and stores the API key
 * as an opaque value that never crosses a DTO (SEC-01). The legacy plane has
 * an id-based config model with a separate secrets CRUD + model-discovery
 * endpoint. Every hook gates on `isKernelMode()` first: wire-backed reads are
 * translated to the legacy UI shape, wire-absent capabilities throw an honest
 * `UnsupportedError`, and nothing silently falls back to the legacy transport.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ModelInfo,
  ProviderCatalogResponse,
  ProviderConfig,
  ProviderConfigCreate,
  ProviderConfigDto,
  ProviderConfigUpdate,
  ProviderSecret,
  ProviderSecretCreate,
  ProviderSecretCreated,
  ProviderSecretList,
  ProviderSecretReveal,
  ProviderSecretUpdate,
  SecretsExposure,
} from '@neotavern/contracts';
import { UnsupportedError } from '@neotavern/neobackend';
import { ApiError, api } from './client.js';
import { backend, isKernelMode } from './backend.js';

const MINUTE = 60_000;

/**
 * Translate a wire provider config into the legacy UI shape. The wire model
 * stores connection fields (`baseUrl`/`model`/`enabled`) inside the opaque
 * `config` record; the legacy shape hoists them. Timestamps convert from
 * RFC3339 (wire) to epoch-ms (legacy).
 */
export function translateProviderConfig(dto: ProviderConfigDto): ProviderConfig {
  const config = dto.config as Record<string, unknown>;
  return {
    id: dto.id,
    kind: dto.provider,
    name: dto.name,
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : null,
    model: typeof config.model === 'string' ? config.model : null,
    enabled: typeof config.enabled === 'boolean' ? config.enabled : true,
    hasApiKey: dto.hasApiKey,
    settings: config,
    createdAt: Date.parse(dto.createdAt),
    updatedAt: Date.parse(dto.updatedAt),
  };
}

/**
 * The legacy model keeps exactly one config per provider kind, so the wire
 * spelling of a legacy create/update is a single named config per provider.
 */
const LEGACY_CONFIG_NAME = 'default';

/** Stable keys shared by provider editors and precise mutation invalidations. */
export const providerQueryKeys = {
  all: ['providers'] as const,
  catalog: ['provider-catalog'] as const,
  models: (id: string) => ['provider-models', id] as const,
  secrets: (providerId?: string) => ['provider-secrets', providerId] as const,
};

export function useProviders() {
  return useQuery({
    queryKey: providerQueryKeys.all,
    queryFn: async () => {
      if (isKernelMode()) {
        const result = await backend.providers.config.list({});
        return { items: result.items.map(translateProviderConfig) };
      }
      return api.get<{ items: ProviderConfig[] }>('/providers');
    },
    staleTime: 2 * MINUTE,
  });
}

export function useProviderCatalog() {
  return useQuery({
    queryKey: providerQueryKeys.catalog,
    queryFn: () => {
      if (isKernelMode()) {
        // The static provider catalog (adapter kind, default base URLs, sampler
        // support) is a legacy-contour registry; the wire plane has no catalog
        // operation. The editor degrades to the built-in 'openai-compatible'
        // default draft, so creating a config still works.
        return Promise.reject(new UnsupportedError('providers.catalog'));
      }
      return api.get<ProviderCatalogResponse>('/providers/catalog');
    },
    staleTime: Infinity,
  });
}

/** Hoist the wire `config` blob back into the legacy connection fields. */
function configPayloadFor(input: ProviderConfigCreate): Record<string, unknown> {
  const config: Record<string, unknown> = { ...input.settings };
  if (input.baseUrl !== undefined && input.baseUrl !== null) config.baseUrl = input.baseUrl;
  if (input.model !== undefined && input.model !== null) config.model = input.model;
  if (input.enabled !== undefined) config.enabled = input.enabled;
  return config;
}

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProviderConfigCreate) => {
      if (isKernelMode()) {
        const dto = await backend.providers.config.set({
          provider: input.kind,
          name: LEGACY_CONFIG_NAME,
          config: configPayloadFor(input),
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        });
        return translateProviderConfig(dto);
      }
      return api.post<ProviderConfig>('/providers', input);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: providerQueryKeys.all }),
  });
}

/** Locate the wire config behind a legacy id (legacy ids are wire uuids). */
async function findConfigOrThrow(id: string): Promise<ProviderConfigDto> {
  const { items } = await backend.providers.config.list({});
  const current = items.find((item) => item.id === id);
  if (!current) {
    throw new ApiError({ code: 'PROVIDER_CONFIG_NOT_FOUND', params: { id } });
  }
  return current;
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: ProviderConfigUpdate }) => {
      if (isKernelMode()) {
        const current = await findConfigOrThrow(id);
        const config: Record<string, unknown> = { ...current.config };
        if (update.baseUrl !== undefined) {
          if (update.baseUrl === null) delete config.baseUrl;
          else config.baseUrl = update.baseUrl;
        }
        if (update.model !== undefined) {
          if (update.model === null) delete config.model;
          else config.model = update.model;
        }
        if (update.enabled !== undefined) config.enabled = update.enabled;
        if (update.settings !== undefined) Object.assign(config, update.settings);
        const dto = await backend.providers.config.set({
          provider: current.provider,
          name: current.name,
          config,
          ...(update.apiKey ? { apiKey: update.apiKey } : {}),
        });
        return translateProviderConfig(dto);
      }
      return api.patch<ProviderConfig>(`/providers/${id}`, update);
    },
    onSuccess: (provider) => {
      void qc.invalidateQueries({ queryKey: providerQueryKeys.all });
      void qc.invalidateQueries({ queryKey: providerQueryKeys.models(provider.id) });
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (isKernelMode()) {
        const current = await findConfigOrThrow(id);
        await backend.providers.config.del(current.provider, current.name);
        return { ok: true as const };
      }
      return api.del<{ ok: true }>(`/providers/${id}`);
    },
    onSuccess: (_result, id) => {
      void qc.invalidateQueries({ queryKey: providerQueryKeys.all });
      qc.removeQueries({ queryKey: providerQueryKeys.models(id) });
    },
  });
}

export function useDiscoverProviderModels() {
  return useMutation({
    mutationFn: (id: string) => {
      if (isKernelMode()) {
        // Model discovery is a kernel-side provider capability with no wire
        // operation (same honest boundary as `warmProviderModels`).
        return Promise.reject(new UnsupportedError('providers.models.discovery'));
      }
      return api.get<{ models: ModelInfo[] }>(`/providers/${id}/models`);
    },
  });
}

export function useProviderSecrets(providerId: string | undefined) {
  return useQuery({
    queryKey: providerQueryKeys.secrets(providerId),
    queryFn: () => {
      if (isKernelMode()) {
        // The wire plane has no secrets CRUD: the API key lives inside the
        // provider config (`providers.config.set apiKey`, SEC-01) and its value
        // never crosses a DTO. A separate key manager is legacy-only.
        return Promise.reject(new UnsupportedError('providers.secrets.list'));
      }
      return api.get<ProviderSecretList>(`/providers/${providerId}/secrets`);
    },
    enabled: providerId !== undefined,
    staleTime: 30_000,
  });
}

export function useSecretsExposure() {
  return useQuery({
    queryKey: ['secrets-exposure'],
    queryFn: () => {
      if (isKernelMode()) {
        // The legacy 'allow secrets exposure' toggle gates reveal controls that
        // cannot exist on the wire plane (a secret value never crosses a DTO),
        // so the honest fail-closed answer is `false`.
        return Promise.resolve<SecretsExposure>({ allowSecretsExposure: false });
      }
      return api.get<SecretsExposure>('/secrets/exposure');
    },
    staleTime: 5 * MINUTE,
  });
}

export function useCreateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, input }: { providerId: string; input: ProviderSecretCreate }) => {
      if (isKernelMode()) {
        // Keys are stored through `providers.config.set` on the wire plane.
        return Promise.reject(new UnsupportedError('providers.secrets.create'));
      }
      return api.post<ProviderSecretCreated>(`/providers/${providerId}/secrets`, input);
    },
    onSuccess: (_result, { providerId }) => {
      void qc.invalidateQueries({ queryKey: providerQueryKeys.secrets(providerId) });
      void qc.invalidateQueries({ queryKey: providerQueryKeys.all });
    },
  });
}

export function useUpdateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      providerId,
      secretId,
      update,
    }: {
      providerId: string;
      secretId: string;
      update: ProviderSecretUpdate;
    }) => {
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('providers.secrets.update'));
      }
      return api.patch<ProviderSecret>(`/providers/${providerId}/secrets/${secretId}`, update);
    },
    onSuccess: (_result, { providerId }) => {
      void qc.invalidateQueries({ queryKey: providerQueryKeys.secrets(providerId) });
      void qc.invalidateQueries({ queryKey: providerQueryKeys.all });
    },
  });
}

export function useDeleteSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, secretId }: { providerId: string; secretId: string }) => {
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('providers.secrets.delete'));
      }
      return api.del<{ ok: true }>(`/providers/${providerId}/secrets/${secretId}`);
    },
    onSuccess: (_result, { providerId }) => {
      void qc.invalidateQueries({ queryKey: providerQueryKeys.secrets(providerId) });
      void qc.invalidateQueries({ queryKey: providerQueryKeys.all });
    },
  });
}

export function useRevealSecret() {
  return useMutation({
    mutationFn: ({ providerId, secretId }: { providerId: string; secretId: string }) => {
      if (isKernelMode()) {
        // A secret value can never cross the wire DTO boundary (SEC-01).
        return Promise.reject(new UnsupportedError('providers.secrets.reveal'));
      }
      return api.post<ProviderSecretReveal>(`/providers/${providerId}/secrets/${secretId}/reveal`);
    },
  });
}
