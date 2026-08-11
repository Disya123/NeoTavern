/**
 * App shell with named regions (ТЗ §5.2). Themes/plugins target these via
 * data-component hooks; layout is a grid that collapses on narrow screens.
 */
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from '@neotavern/ui';
import { Sidebar } from './Sidebar.js';
import { PluginToolbar } from './PluginToolbar.js';
import { LegacyIslands } from './LegacyIslands.js';
import { PluginRuntimeUi } from './PluginRuntimeUi.js';
import { PluginConsentDialog } from './PluginConsentDialog.js';
import { ConnectivityStatus } from './ConnectivityStatus.js';
import { useUiStore } from '../state/ui.js';
import styles from './AppShell.module.css';

export function AppShell() {
  const { t } = useTranslation();
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  return (
    <div
      className={styles.shell}
      data-component="app-shell"
      data-slot="app.shell"
      data-sidebar={sidebarOpen ? 'open' : 'closed'}
    >
      <a className={styles.skipLink} href="#chat-workspace">
        {t('accessibility:skipToChat')}
      </a>
      <Sidebar />
      <main
        id="chat-workspace"
        tabIndex={-1}
        className={sidebarOpen ? styles.mainShifted : styles.main}
        data-component="main-area"
        data-slot="chat.viewport"
      >
        <PluginToolbar />
        <ErrorBoundary name="main-region">
          <Outlet />
        </ErrorBoundary>
      </main>
      <div className={styles.statusArea} data-slot="status.area">
        <ConnectivityStatus />
      </div>
      <div data-component="plugin-runtime-layer" data-slot="modal.layer" />
      <LegacyIslands />
      <PluginRuntimeUi />
      <PluginConsentDialog />
    </div>
  );
}
