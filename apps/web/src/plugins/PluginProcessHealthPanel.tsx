/**
 * Plugin process health panel (ADR-0066 P3c).
 *
 * Shows what the supervisor knows about one plugin's native process: its state, how
 * many restarts it burned, the last failure reason, and the two operator actions.
 * A browser session has no processes at all, and the panel says that instead of
 * rendering an empty box that looks like a bug.
 */
import { useTranslation } from 'react-i18next';
import { hasPluginProcessHost } from './processHost.js';
import {
  usePluginProcessHealth,
  useResetPluginProcess,
  useStopPluginProcess,
} from './usePluginProcessHealth.js';

const STATE_KEY: Record<string, string> = {
  Stopped: 'plugins:processStateStopped',
  Running: 'plugins:processStateRunning',
  Backoff: 'plugins:processStateBackoff',
  Failed: 'plugins:processStateFailed',
  Unknown: 'plugins:processUnavailable',
};

export interface PluginProcessHealthPanelProps {
  pluginId: string;
}

export function PluginProcessHealthPanel({ pluginId }: PluginProcessHealthPanelProps) {
  const { t } = useTranslation();
  const enabled = hasPluginProcessHost();
  const health = usePluginProcessHealth(pluginId);
  const stop = useStopPluginProcess(pluginId);
  const reset = useResetPluginProcess(pluginId);

  if (!enabled) {
    return (
      <section aria-label={t('plugins:processTitle')} data-part="plugin-process-health">
        <p>{t('plugins:processNoHost')}</p>
      </section>
    );
  }

  const state = health.data?.state ?? 'Unknown';
  return (
    <section aria-label={t('plugins:processTitle')} data-part="plugin-process-health">
      <h3>{t('plugins:processTitle')}</h3>
      {health.isError ? (
        <p role="alert">{t('plugins:processUnavailable')}</p>
      ) : (
        <dl>
          <dt>{t('plugins:processState')}</dt>
          <dd data-state={state}>{t(STATE_KEY[state] ?? 'plugins:processUnavailable')}</dd>
          <dt>{t('plugins:processRestarts')}</dt>
          <dd>{health.data?.restarts ?? 0}</dd>
          {health.data?.lastError ? (
            <>
              <dt>{t('plugins:processLastError')}</dt>
              <dd>{health.data.lastError}</dd>
            </>
          ) : null}
        </dl>
      )}
      <div>
        <button type="button" onClick={() => stop.mutate()} disabled={stop.isPending}>
          {t('plugins:processStop')}
        </button>
        <button type="button" onClick={() => reset.mutate()} disabled={reset.isPending}>
          {t('plugins:processReset')}
        </button>
      </div>
    </section>
  );
}
