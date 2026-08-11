/** Synchronize enabled frontend plugins into opaque-origin sandbox iframes. */
import { useEffect } from 'react';
import { useEnterPluginSafeMode, usePlugins } from '../api/hooks.js';
import { frontendPluginRuntime } from '../plugins/runtime.js';
import { legacyFrontendRuntime } from '../plugins/legacyRuntime.js';
import { isSafeMode } from '../theme/apply.js';

export function PluginSync() {
  const plugins = usePlugins();
  const enterSafeMode = useEnterPluginSafeMode();
  const querySafeMode = isSafeMode();

  useEffect(() => {
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
  }, [enterSafeMode, plugins.data, querySafeMode]);

  return null;
}
