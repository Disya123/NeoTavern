import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, ErrorBoundary } from '@neotavern/ui';
import { frontendPluginRuntime, usePluginRegistrations } from '../plugins/runtime.js';
import { SystemSurfaceLink } from '../components/SystemSurfaceLink.js';
import styles from './PluginSurfacePage.module.css';

export interface PluginSurfacePageProps {
  pluginId?: string;
  path?: string;
}

export function PluginSurfacePage({
  pluginId: explicitPluginId,
  path: explicitPath,
}: PluginSurfacePageProps = {}) {
  const { t } = useTranslation();
  const params = useParams();
  const container = useRef<HTMLDivElement>(null);
  const pages = usePluginRegistrations('pages');
  const pluginId = explicitPluginId ?? params['pluginId'];
  const requestedPath = explicitPath ?? `/${params['*'] ?? ''}`;
  const registration = pages.find(
    (item) => item.pluginId === pluginId && item.definition.path === requestedPath,
  );

  useEffect(() => {
    if (!registration || !container.current) return;
    return frontendPluginRuntime.mountPage(registration, container.current);
  }, [registration]);

  return (
    <ErrorBoundary name="plugin-page">
      <div className={styles.page} data-component="plugin-page">
        {registration ? (
          <>
            <header className={styles.header}>
              <span>{registration.pluginName}</span>
              <h1>{registration.definition.title}</h1>
            </header>
            <div ref={container} className={styles.frameHost} data-part="sandbox-host" />
          </>
        ) : (
          <section className={styles.unavailable} role="status">
            <h1>{t('plugins:pageUnavailable')}</h1>
            <p>{t('plugins:pageUnavailableHint')}</p>
            <Button asChild>
              <SystemSurfaceLink to="/plugins">{t('plugins:backToManager')}</SystemSurfaceLink>
            </Button>
          </section>
        )}
      </div>
    </ErrorBoundary>
  );
}
