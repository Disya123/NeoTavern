/**
 * Provider and secret server-state hooks.
 *
 * Kernel plane (slice 26): the wire contract names provider configs by
 * provider+name (`providers.config.set/get/list/del`) and stores the API key
 * as an opaque value that never crosses a DTO (SEC-01). The legacy plane has
 * an id-based config model with a separate secrets CRUD + model-discovery
 * endpoint. Every hook gates on `isKernelMode()` first: wire-backed reads are
 * translated to the legacy UI shape, and nothing silently falls back to the
 * legacy transport.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GenerationParameterIds,
  ProviderSourceIds,
  type GenerationParameterId,
  type ModelInfo,
  type ProviderCatalogEntry,
  type ProviderCatalogResponse,
  type ProviderCatalogResultDto,
  type ProviderConfig,
  type ProviderConfigCreate,
  type ProviderConfigDto,
  type ProviderConfigUpdate,
  type ProviderSecret,
  type ProviderSecretCreate,
  type ProviderSecretCreated,
  type ProviderSecretDto,
  type ProviderSecretList,
  type ProviderSecretReveal,
  type ProviderSecretUpdate,
  type ProviderSourceId,
  type SecretsExposure,
} from '@neotavern/contracts';
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

const KNOWN_SOURCE_IDS = new Set<string>(ProviderSourceIds);
const KNOWN_PARAMETER_IDS = new Set<string>(GenerationParameterIds);

function isKnownSourceId(id: string): id is ProviderSourceId {
  return KNOWN_SOURCE_IDS.has(id);
}

function isKnownParameterId(id: string): id is GenerationParameterId {
  return KNOWN_PARAMETER_IDS.has(id);
}

/**
 * Translate the canonical wire catalog to the UI catalog shape.
 *
 * The kernel catalog is deliberately smaller and truthful: it lists only the
 * sources the kernel can materialize, all of which are the same
 * OpenAI-compatible HTTP adapter (`adapterKind: 'openai-compatible'`). Entries
 * the UI has no identity for (the test-only `fake` source) are skipped instead
 * of inventing labels or values the backend would reject. `samplerSupport`
 * narrows to the generation parameters the UI knows how to render.
 */
export function translateKernelCatalog(dto: ProviderCatalogResultDto): ProviderCatalogResponse {
  const items: ProviderCatalogEntry[] = [];
  for (const entry of dto.items) {
    if (!isKnownSourceId(entry.id)) continue;
    items.push({
      id: entry.id,
      adapterKind: 'openai-compatible',
      defaultBaseUrl: entry.defaultBaseUrl ?? null,
      apiKeyRequired: entry.apiKeyRequired,
      baseUrlEditable: entry.baseUrlEditable,
      samplerSupport: entry.samplerSupport.filter(isKnownParameterId),
    });
  }
  return { items };
}

/** Translate a wire named-key DTO to the legacy secrets shape. */
export function translateKernelSecret(dto: ProviderSecretDto): ProviderSecret {
  return {
    id: dto.id,
    providerId: dto.providerId,
    label: dto.label ?? null,
    active: dto.active,
    masked: dto.masked,
    // RFC3339 (wire) → epoch-ms (legacy UI shape).
    createdAt: Date.parse(dto.createdAt),
  };
}

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
    queryFn: async () => {
      if (isKernelMode()) {
        // Canonical source catalog (wire `providers.catalog`): the sources the
        // backend can actually materialize, with the per-source hints the
        // editor drives from.
        return translateKernelCatalog(await backend.providers.catalog());
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
        // Live discovery through the addressed kernel config (wire
        // `providers.models`, M7 cluster 8). Ids only from the vendor listing,
        // so the legacy `name ?? id` shape is rebuilt here.
        return backend.providers.models({ providerId: id }).then((result) => ({
          models: result.models.map((model) => ({
            id: model.id,
            name: model.name,
            ...(model.contextLimit !== undefined ? { contextLimit: model.contextLimit } : {}),
            ...(model.maxOutputTokens !== undefined
              ? { maxOutputTokens: model.maxOutputTokens }
              : {}),
          })),
        }));
      }
      return api.get<{ models: ModelInfo[] }>(`/providers/${id}/models`);
    },
  });
}

export function useProviderSecrets(providerId: string | undefined) {
  return useQuery({
    queryKey: providerQueryKeys.secrets(providerId),
    queryFn: async () => {
      if (isKernelMode()) {
        if (providerId === undefined) return { items: [] };
        const result = await backend.providers.secrets.list({ providerId });
        return { items: result.items.map(translateKernelSecret) };
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
    queryFn: async () => {
      if (isKernelMode()) {
        // Host policy (wire `secrets.exposure`). When false, reveal is
        // fail-closed and the UI hides copy/reveal affordances.
        return backend.secrets.exposure();
      }
      return api.get<SecretsExposure>('/secrets/exposure');
    },
    staleTime: 5 * MINUTE,
  });
}

export function useCreateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      providerId,
      input,
    }: {
      providerId: string;
      input: ProviderSecretCreate;
    }): Promise<ProviderSecretCreated> => {
      if (isKernelMode()) {
        return backend.providers.secrets.create({
          providerId,
          value: input.value,
          ...(input.label !== undefined ? { label: input.label } : {}),
        });
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
    mutationFn: async ({
      providerId,
      secretId,
      update,
    }: {
      providerId: string;
      secretId: string;
      update: ProviderSecretUpdate;
    }): Promise<ProviderSecret> => {
      if (isKernelMode()) {
        // Wire label `''` clears the field — the legacy null maps onto it.
        const dto = await backend.providers.secrets.update({
          providerId,
          secretId,
          ...(update.label !== undefined ? { label: update.label ?? '' } : {}),
          ...(update.active !== undefined ? { active: update.active } : {}),
        });
        return translateKernelSecret(dto);
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
    mutationFn: async ({
      providerId,
      secretId,
    }: {
      providerId: string;
      secretId: string;
    }): Promise<{ ok: true }> => {
      if (isKernelMode()) {
        await backend.providers.secrets.del({ providerId, secretId });
        return { ok: true as const };
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
    mutationFn: async ({
      providerId,
      secretId,
    }: {
      providerId: string;
      secretId: string;
    }): Promise<ProviderSecretReveal> => {
      if (isKernelMode()) {
        // The single plaintext-carrying op; the kernel fails closed with
        // `SECRETS_EXPOSURE_DISABLED` unless the host opted in.
        return backend.providers.secrets.reveal({ providerId, secretId });
      }
      return api.post<ProviderSecretReveal>(`/providers/${providerId}/secrets/${secretId}/reveal`);
    },
  });
}
