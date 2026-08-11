/**
 * Mirrors the active provider config id into the frontend plugin runtime so
 * `models.list` (rev4 kernel slice) resolves an omitted `providerId` to the
 * provider the user is actually using — the plugin model menu works without
 * hardcoding a provider id.
 */
import { useEffect } from 'react';
import { frontendPluginRuntime } from '../plugins/runtime.js';
import { useSettings } from '../api/hooks.js';

export function PluginProviderSync() {
  const settings = useSettings();
  const activeProviderConfigId = settings.data?.activeProviderConfigId ?? null;
  useEffect(() => {
    frontendPluginRuntime.setActiveProviderConfigId(activeProviderConfigId);
  }, [activeProviderConfigId]);
  return null;
}
