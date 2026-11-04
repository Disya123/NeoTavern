/**
 * Host container for a plugin-owned UI surface (ADR-0066 D4).
 *
 * The shell asks this component what to render; the plugin never mounts itself into
 * the React tree. When a plugin owns the window, the stock UI is replaced by an
 * isolated frame, and the host draws the only control that can bring the user back —
 * so a hung or malicious plugin cannot trap them.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { shellMode } from './shellMode.js';

export interface PluginSurfaceHostProps {
  /**
   * Renders the stock application. Called with no arguments; the host container only
   * decides whether it appears.
   */
  children: React.ReactNode;
}

export function PluginSurfaceHost({ children }: PluginSurfaceHostProps) {
  const { t } = useTranslation();
  const [activePluginId, setActivePluginId] = useState<string | null>(shellMode.activePluginId());

  useEffect(() => shellMode.subscribe(setActivePluginId), []);

  if (activePluginId === null) return <>{children}</>;

  return (
    <div data-part="plugin-shell">
      <button
        type="button"
        data-part="plugin-shell-exit"
        onClick={() => shellMode.restore()}
        aria-label={t('plugins:shellExit')}
      >
        {t('plugins:shellExit')}
      </button>
      {/*
        The frame gets an opaque origin: `allow-scripts` without `allow-same-origin`
        means no access to the app's DOM, storage, cookies or Tauri bridge. It learns
        what to render over postMessage, like every other plugin surface.
      */}
      <iframe
        key={activePluginId}
        title={t('plugins:shellTitle')}
        src={`/plugin-sandbox.html?plugin=${encodeURIComponent(activePluginId)}&frame=shell`}
        sandbox="allow-scripts"
        data-part="plugin-shell-frame"
        data-plugin-id={activePluginId}
        style={{ border: 0, width: '100%', height: '100%' }}
      />
    </div>
  );
}
