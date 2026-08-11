/** Provider and secret server-state hooks. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ModelInfo,
  ProviderCatalogResponse,
  ProviderConfig,
  ProviderConfigCreate,
  ProviderConfigUpdate,
  ProviderSecret,
  ProviderSecretCreate,
  ProviderSecretCreated,
  ProviderSecretList,
  ProviderSecretReveal,
  ProviderSecretUpdate,
  SecretsExposure,
} from '@neotavern/contracts';
import { api } from './client.js';

const MINUTE = 60_000;

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
    queryFn: () => api.get<{ items: ProviderConfig[] }>('/providers'),
    staleTime: 2 * MINUTE,
  });
}

export function useProviderCatalog() {
  return useQuery({
    queryKey: providerQueryKeys.catalog,
    queryFn: () => api.get<ProviderCatalogResponse>('/providers/catalog'),
    staleTime: Infinity,
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderConfigCreate) => api.post<ProviderConfig>('/providers', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: providerQueryKeys.all }),
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: ProviderConfigUpdate }) =>
      api.patch<ProviderConfig>(`/providers/${id}`, update),
    onSuccess: (provider) => {
      void qc.invalidateQueries({ queryKey: providerQueryKeys.all });
      void qc.invalidateQueries({ queryKey: providerQueryKeys.models(provider.id) });
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/providers/${id}`),
    onSuccess: (_result, id) => {
      void qc.invalidateQueries({ queryKey: providerQueryKeys.all });
      qc.removeQueries({ queryKey: providerQueryKeys.models(id) });
    },
  });
}

export function useDiscoverProviderModels() {
  return useMutation({
    mutationFn: (id: string) => api.get<{ models: ModelInfo[] }>(`/providers/${id}/models`),
  });
}

export function useProviderSecrets(providerId: string | undefined) {
  return useQuery({
    queryKey: providerQueryKeys.secrets(providerId),
    queryFn: () => api.get<ProviderSecretList>(`/providers/${providerId}/secrets`),
    enabled: providerId !== undefined,
    staleTime: 30_000,
  });
}

export function useSecretsExposure() {
  return useQuery({
    queryKey: ['secrets-exposure'],
    queryFn: () => api.get<SecretsExposure>('/secrets/exposure'),
    staleTime: 5 * MINUTE,
  });
}

export function useCreateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, input }: { providerId: string; input: ProviderSecretCreate }) =>
      api.post<ProviderSecretCreated>(`/providers/${providerId}/secrets`, input),
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
    }) => api.patch<ProviderSecret>(`/providers/${providerId}/secrets/${secretId}`, update),
    onSuccess: (_result, { providerId }) => {
      void qc.invalidateQueries({ queryKey: providerQueryKeys.secrets(providerId) });
      void qc.invalidateQueries({ queryKey: providerQueryKeys.all });
    },
  });
}

export function useDeleteSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, secretId }: { providerId: string; secretId: string }) =>
      api.del<{ ok: true }>(`/providers/${providerId}/secrets/${secretId}`),
    onSuccess: (_result, { providerId }) => {
      void qc.invalidateQueries({ queryKey: providerQueryKeys.secrets(providerId) });
      void qc.invalidateQueries({ queryKey: providerQueryKeys.all });
    },
  });
}

export function useRevealSecret() {
  return useMutation({
    mutationFn: ({ providerId, secretId }: { providerId: string; secretId: string }) =>
      api.post<ProviderSecretReveal>(`/providers/${providerId}/secrets/${secretId}/reveal`),
  });
}
