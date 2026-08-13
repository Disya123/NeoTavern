/**
 * Restores and re-validates the last confirmed connection on launch — the
 * classic SillyTavern "Auto-connect to Last Server" behaviour. When
 * `settings.autoConnect` is on and `settings.lastServer` references an enabled
 * provider, this re-asserts it as the active provider and warms the model
 * discovery cache to confirm the endpoint is reachable. Failures are non-fatal:
 * the user can still connect manually from the API panel.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ModelInfo } from '@neotavern/contracts';
import { legacyRaw } from '../api/backend.js';
import { useProviders, useSettings, useUpdateSettings } from '../api/hooks.js';

export function AutoConnectSync() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const providers = useProviders();
  const updateSettings = useUpdateSettings();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    const current = settings.data;
    const list = providers.data;
    if (!current || !list) return;
    const lastServer = current.lastServer;
    if (!current.autoConnect || !lastServer) return;
    const target = list.items.find((item) => item.id === lastServer.providerConfigId);
    if (!target || !target.enabled) return;
    ran.current = true;

    if (current.activeProviderConfigId !== target.id) {
      void updateSettings.mutateAsync({ activeProviderConfigId: target.id }).catch(() => undefined);
    }
    void queryClient
      .prefetchQuery<{ models: ModelInfo[] }>({
        queryKey: ['provider-models', target.id],
        queryFn: () => legacyRaw().request<{ models: ModelInfo[] }>('GET', `/providers/${target.id}/models`),
      })
      .catch(() => undefined);
  }, [settings.data, providers.data, queryClient, updateSettings]);

  return null;
}
