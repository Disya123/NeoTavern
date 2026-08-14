import {
  ArrowClockwise,
  Broom,
  DownloadSimple,
  MagnifyingGlass,
  ShieldCheck,
  ArrowsClockwise,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ActionBar, ActionBarGroup, Button } from '@neotavern/ui';
import { backend } from '../api/backend.js';
import { useClearDiagnosticCache, useDiagnostics, useRebuildSearch } from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import { ConfirmActionDialog } from './ConfirmActionDialog.js';
import {
  checkCoreUpdate,
  getDesktopBackendMode,
  installCoreUpdate,
  isDesktopShell,
  type CoreUpdateStatus,
} from '../lib/desktop.js';
import styles from './DiagnosticsPanel.module.css';

type Action = 'diagnostics' | 'cache' | 'search' | 'update' | null;

export function DiagnosticsPanel() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  // Diagnostics snapshot and cache/search actions are server state (ARCH-06):
  // cached and invalidated by TanStack Query, not hand-rolled fetch + state.
  const diagnosticsQuery = useDiagnostics();
  const rebuildSearchMutation = useRebuildSearch();
  const clearCacheMutation = useClearDiagnosticCache();
  const snapshot = diagnosticsQuery.data ?? null;
  const [activeAction, setActiveAction] = useState<Action>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [desktop] = useState(() => isDesktopShell());
  const [updateStatus, setUpdateStatus] = useState<CoreUpdateStatus | null>(null);
  const [cacheConfirmOpen, setCacheConfirmOpen] = useState(false);
  // Resolved backend mode ("kernel" | "sidecar" | null). The panel marks the
  // Kernel as an explicit Preview (ADR-0038) only when the shell reports the
  // Kernel is the ACTIVE backend — never when the sidecar is running.
  const [backendMode, setBackendMode] = useState<'kernel' | 'sidecar' | null>(null);
  useEffect(() => {
    if (!desktop) return;
    void getDesktopBackendMode().then(setBackendMode);
  }, [desktop]);
  // Phase 3 local kernel slice: the desktop shell reads kernel metadata over
  // the NeoBackend facade (React → LocalBackend → Tauri IPC → Runtime
  // Kernel). Disabled in the browser where no kernel transport exists.
  const kernelQuery = useQuery({
    queryKey: ['kernel-meta'],
    queryFn: () => backend.meta(),
    enabled: desktop,
    staleTime: 60_000,
    retry: false,
  });
  const kernelBackupsQuery = useQuery({
    queryKey: ['kernel-backups'],
    queryFn: () => backend.backups.list(),
    enabled: desktop,
    staleTime: 60_000,
    retry: false,
  });

  const checkUpdates = async (): Promise<void> => {
    setActiveAction('update');
    setError(null);
    try {
      setUpdateStatus(await checkCoreUpdate());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setActiveAction(null);
    }
  };

  // Desktop shells probe for a core update once on open (ТЗ §19 update
  // channels); browsers get no section at all.
  // Runs once per mounted panel: `desktop` never changes, so the updater
  // probe fires exactly once (checkUpdates is re-runnable via the button).
  useEffect(() => {
    if (desktop) void checkUpdates();
  }, [desktop]);

  const installUpdate = async (): Promise<void> => {
    setActiveAction('update');
    setMessage(null);
    setError(null);
    try {
      const installed = await installCoreUpdate();
      setMessage(
        installed
          ? t('settings:updateInstalled')
          : t('settings:updateUpToDate', {
              version: updateStatus?.currentVersion ?? '',
            }),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setActiveAction(null);
    }
  };

  const refresh = async (): Promise<void> => {
    setActiveAction('diagnostics');
    setMessage(null);
    setError(null);
    const result = await diagnosticsQuery.refetch();
    if (result.error) setError(errorText(result.error));
    setActiveAction(null);
  };

  const download = (): void => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `neotavern-diagnostics-${new Date(snapshot.generatedAt)
      .toISOString()
      .replaceAll(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const rebuildSearch = async (): Promise<void> => {
    setActiveAction('search');
    setMessage(null);
    setError(null);
    try {
      await rebuildSearchMutation.mutateAsync();
      setMessage(t('settings:diagnosticsSearchRebuilt'));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setActiveAction(null);
    }
  };

  const clearCache = async (): Promise<void> => {
    setActiveAction('cache');
    setMessage(null);
    setError(null);
    try {
      const result = await clearCacheMutation.mutateAsync();
      setMessage(
        t('settings:diagnosticsCacheCleared', {
          files: result.removedFiles,
          size: formatBytes(result.removedBytes, i18n.language),
        }),
      );
      setCacheConfirmOpen(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setActiveAction(null);
    }
  };

  const enterSafeMode = (): void => {
    const url = new URL(window.location.href);
    url.searchParams.set('safe', '1');
    window.location.assign(url.href);
  };

  return (
    <div className={styles.panel} data-component="diagnostics-panel">
      <ActionBar collapse="stack" className={styles.actions} data-part="diagnostic-actions">
        <ActionBarGroup placement="primary">
          <Button
            variant="primary"
            startIcon={<ArrowClockwise />}
            disabled={activeAction !== null}
            onClick={() => void refresh()}
          >
            {activeAction === 'diagnostics'
              ? t('settings:diagnosticsRunning')
              : t('settings:diagnosticsRun')}
          </Button>
          <Button
            variant="ghost"
            startIcon={<DownloadSimple />}
            disabled={!snapshot}
            onClick={download}
          >
            {t('settings:diagnosticsDownload')}
          </Button>
        </ActionBarGroup>
      </ActionBar>

      {desktop && backendMode !== 'sidecar' ? (
        <section data-part="kernel-diagnostics" aria-label={t('settings:diagnosticsKernel')}>
          {backendMode === 'kernel' ? (
            <p className={styles.kernelPreview} data-part="kernel-preview">
              <strong>{t('settings:diagnosticsKernelPreview')}</strong>
              <span>{t('settings:diagnosticsKernelPreviewNote')}</span>
            </p>
          ) : null}
          <div className={styles.summary}>
            {kernelQuery.data ? (
              <>
                <DiagnosticMetric
                  label={t('settings:diagnosticsKernel')}
                  value={kernelQuery.data.appVersion}
                  state="ok"
                />
                <DiagnosticMetric
                  label={t('settings:diagnosticsKernelWire')}
                  value={`${kernelQuery.data.productWire.major}.${kernelQuery.data.productWire.minor}`}
                />
                <DiagnosticMetric
                  label={t('settings:diagnosticsKernelFeatures')}
                  value={t('settings:diagnosticsKernelFeaturesValue', {
                    count: Object.keys(kernelQuery.data.features).length,
                  })}
                />
                <DiagnosticMetric
                  label={t('settings:diagnosticsKernelBackups')}
                  value={
                    kernelBackupsQuery.data
                      ? t('settings:diagnosticsKernelBackupsValue', {
                          count: kernelBackupsQuery.data.items.length,
                        })
                      : t('settings:diagnosticsKernelUnavailable')
                  }
                  state={kernelBackupsQuery.data ? 'ok' : 'error'}
                />
              </>
            ) : kernelQuery.isError ? (
              <DiagnosticMetric
                label={t('settings:diagnosticsKernel')}
                value={t('settings:diagnosticsKernelUnavailable')}
                state="error"
              />
            ) : (
              <DiagnosticMetric
                label={t('settings:diagnosticsKernel')}
                value={t('settings:diagnosticsRunning')}
              />
            )}
          </div>
        </section>
      ) : null}

      {snapshot ? (
        <>
          <div className={styles.summary} aria-label={t('settings:diagnosticsSummary')}>
            <DiagnosticMetric
              label={t('settings:diagnosticsDatabase')}
              value={
                snapshot.database.integrity === 'ok'
                  ? t('settings:diagnosticsHealthy')
                  : t('settings:diagnosticsUnhealthy')
              }
              state={snapshot.database.integrity}
            />
            <DiagnosticMetric
              label={t('settings:diagnosticsSchema')}
              value={t('settings:diagnosticsSchemaValue', {
                version: snapshot.database.schemaVersion,
                count: snapshot.database.migrationCount,
              })}
            />
            <DiagnosticMetric
              label={t('settings:diagnosticsLibrary')}
              value={t('settings:diagnosticsLibraryValue', {
                characters: snapshot.database.entities.characters,
                chats: snapshot.database.entities.chats,
                messages: snapshot.database.entities.messages,
              })}
            />
            <DiagnosticMetric
              label={t('settings:diagnosticsStorage')}
              value={t('settings:diagnosticsStorageValue', {
                files: formatBytes(snapshot.storage.filesBytes, i18n.language),
                cache: formatBytes(snapshot.storage.cacheBytes, i18n.language),
                free:
                  snapshot.storage.freeBytes === null
                    ? t('settings:diagnosticsUnknown')
                    : formatBytes(snapshot.storage.freeBytes, i18n.language),
              })}
            />
            <DiagnosticMetric
              label={t('settings:diagnosticsExtensions')}
              value={t('settings:diagnosticsExtensionsValue', {
                providers: snapshot.providers.configured,
                plugins: snapshot.plugins.installed,
                themes: snapshot.themes.installed,
              })}
            />
            <DiagnosticMetric
              label={t('settings:diagnosticsRuntime')}
              value={t('settings:diagnosticsRuntimeValue', {
                version: snapshot.app.version,
                nodeVersion: snapshot.app.nodeVersion,
                platform: snapshot.app.platform,
                architecture: snapshot.app.architecture,
              })}
            />
          </div>
          <p className={styles.privacy}>
            <ShieldCheck aria-hidden="true" />
            {t('settings:diagnosticsPrivacy')}
          </p>
        </>
      ) : (
        <p className={styles.empty}>{t('settings:diagnosticsEmpty')}</p>
      )}

      <ActionBar collapse="stack" className={styles.maintenance} data-part="maintenance-actions">
        <ActionBarGroup placement="primary">
          <Button
            variant="ghost"
            startIcon={<MagnifyingGlass />}
            disabled={activeAction !== null}
            onClick={() => void rebuildSearch()}
          >
            {activeAction === 'search'
              ? t('settings:diagnosticsRebuildingSearch')
              : t('settings:diagnosticsRebuildSearch')}
          </Button>
          <Button
            variant="ghost"
            startIcon={<Broom />}
            disabled={activeAction !== null}
            onClick={() => setCacheConfirmOpen(true)}
          >
            {activeAction === 'cache'
              ? t('settings:diagnosticsClearingCache')
              : t('settings:diagnosticsClearCache')}
          </Button>
          <Button
            variant="ghost"
            startIcon={<ShieldCheck />}
            disabled={activeAction !== null}
            onClick={enterSafeMode}
          >
            {t('settings:safeMode')}
          </Button>
        </ActionBarGroup>
      </ActionBar>
      <p className={styles.safeHint}>{t('settings:safeModeHint')}</p>

      {desktop ? (
        <ActionBar
          collapse="stack"
          className={styles.maintenance}
          data-part="update-actions"
          aria-label={t('settings:updates')}
        >
          <ActionBarGroup placement="primary">
            <Button
              variant="ghost"
              startIcon={<ArrowsClockwise />}
              disabled={activeAction !== null}
              onClick={() => void checkUpdates()}
            >
              {activeAction === 'update' && !updateStatus?.availableVersion
                ? t('settings:updateChecking')
                : t('settings:updateCheck')}
            </Button>
            {updateStatus?.availableVersion ? (
              <Button
                variant="primary"
                startIcon={<DownloadSimple />}
                disabled={activeAction !== null}
                onClick={() => void installUpdate()}
              >
                {activeAction === 'update'
                  ? t('settings:updateInstalling')
                  : t('settings:updateInstall')}
              </Button>
            ) : null}
          </ActionBarGroup>
          {updateStatus ? (
            <p className={styles.message} role="status">
              {updateStatus.availableVersion
                ? t('settings:updateAvailable', { version: updateStatus.availableVersion })
                : updateStatus.configured
                  ? t('settings:updateUpToDate', { version: updateStatus.currentVersion })
                  : t('settings:updateNotConfigured', { version: updateStatus.currentVersion })}
            </p>
          ) : null}
        </ActionBar>
      ) : null}

      {message ? (
        <p className={styles.message} role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <ConfirmActionDialog
        open={cacheConfirmOpen}
        onOpenChange={(open) => {
          if (activeAction !== 'cache') setCacheConfirmOpen(open);
        }}
        title={t('settings:diagnosticsClearCache')}
        description={t('settings:diagnosticsClearCacheConfirm')}
        confirmLabel={t('settings:diagnosticsClearCache')}
        busy={activeAction === 'cache'}
        danger
        onConfirm={() => void clearCache()}
      />
    </div>
  );
}

function DiagnosticMetric({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state?: 'ok' | 'error';
}) {
  return (
    <div className={styles.metric} data-state={state}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatBytes(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[index],
    unitDisplay: 'short',
    maximumFractionDigits: value < 10 && index > 0 ? 1 : 0,
  }).format(value);
}
