/** Synchronize enabled frontend plugins into opaque-origin sandbox iframes. */
import { useEffect } from 'react';
import { useEnterPluginSafeMode, usePlugins, useSettings } from '../api/hooks.js';
import { frontendPluginRuntime } from '../plugins/runtime.js';
import { legacyFrontendRuntime, readLegacyFrontendSetting } from '../plugins/legacyRuntime.js';
import { isSafeMode } from '../theme/apply.js';

export function PluginSync() {
  const plugins = usePlugins();
  const settings = useSettings();
  const enterSafeMode = useEnterPluginSafeMode();
  const querySafeMode = isSafeMode();
  // App-level legacy frontend opt-in (`extensions.legacyFrontend`, default
  // off, ТЗ §10/§87): legacy entries inject into the main document, so they
  // additionally require the admin toggle on top of per-plugin consent.
  const legacyGateEnabled = readLegacyFrontendSetting(settings.data);

  useEffect(() => {
    legacyFrontendRuntime.setAppGateEnabled(legacyGateEnabled);
    if (querySafeMode || plugins.data?.safeMode) {
      frontendPluginRuntime.clear();
      legacyFrontendRuntime.clear();
      if (querySafeMode && plugins.data && !plugins.data.safeMode && !enterSafeMode.isPending) {
        enterSafeMode.mutate();
      }
      return;
    }
    frontendPluginRuntime.sync(plugins.data?.items ?? []);
    legacyFrontendRuntime.sync(plugins.data?.items ?? []);
  }, [enterSafeMode, legacyGateEnabled, plugins.data, querySafeMode]);

  return null;
}
