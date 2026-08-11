import {
  CheckCircle,
  Cube,
  DownloadSimple,
  GitBranch,
  LockKey,
  Package,
  ShieldCheck,
  Trash,
} from '@phosphor-icons/react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionBar, ActionBarGroup, Button, ErrorBoundary, TextField, cx } from '@neotavern/ui';
import {
  useActivatePlugin,
  useDeletePlugin,
  useDisablePlugin,
  useExitPluginSafeMode,
  useInstallPlugin,
  useInstallPluginFromGit,
  usePlugins,
} from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import { SystemSurfaceLink } from '../components/SystemSurfaceLink.js';
import { ConfirmActionDialog } from '../components/ConfirmActionDialog.js';
import { PluginAuthDialog, extractAuthClients } from '../components/PluginAuthDialog.js';
import { usePluginRegistrations } from '../plugins/runtime.js';
import { isSafeMode } from '../theme/apply.js';
import styles from './PluginsPage.module.css';

const MAX_PLUGIN_BYTES = 25 * 1024 * 1024;
interface PluginDeleteTarget {
  id: string;
  name: string;
  requiresReload: boolean;
}

export function PluginsPage() {
  const { t } = useTranslation();
  const plugins = usePlugins();
  const install = useInstallPlugin();
  const installFromGit = useInstallPluginFromGit();
  const activate = useActivatePlugin();
  const disable = useDisablePlugin();
  const remove = useDeletePlugin();
  const exitSafeMode = useExitPluginSafeMode();
  const pages = usePluginRegistrations('pages');
  const errorText = useErrorText();
  const querySafeMode = isSafeMode();
  const safeMode = querySafeMode || Boolean(plugins.data?.safeMode);
  const [approvals, setApprovals] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PluginDeleteTarget | null>(null);
  const [authTarget, setAuthTarget] = useState<{ id: string; name: string } | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('');

  const choosePackage = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice(null);
    setActionError(null);
    if (file.size > MAX_PLUGIN_BYTES) {
      setActionError(t('plugins:fileTooLarge'));
      return;
    }
    try {
      const result = await install.mutateAsync(file);
      setApprovals((current) => ({
        ...current,
        [result.plugin.id]: result.plugin.grantedPermissions,
      }));
      setNotice(
        t(result.replaced ? 'plugins:updatedNotice' : 'plugins:installedNotice', {
          name: result.plugin.name,
        }),
      );
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const submitGitInstall = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    setActionError(null);
    const url = gitUrl.trim();
    if (!url) {
      setActionError(t('plugins:gitUrlRequired'));
      return;
    }
    try {
      const ref = gitRef.trim();
      const result = await installFromGit.mutateAsync(ref ? { url, ref } : { url });
      setApprovals((current) => ({
        ...current,
        [result.plugin.id]: result.plugin.grantedPermissions,
      }));
      setNotice(
        t(result.replaced ? 'plugins:updatedNotice' : 'plugins:installedNotice', {
          name: result.plugin.name,
        }),
      );
      setGitUrl('');
      setGitRef('');
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const activatePlugin = async (id: string, name: string, permissions: string[]): Promise<void> => {
    setNotice(null);
    setActionError(null);
    try {
      await activate.mutateAsync({ id, input: { grantedPermissions: permissions } });
      setNotice(t('plugins:activatedNotice', { name }));
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const disablePlugin = async (
    id: string,
    name: string,
    requiresReload: boolean,
  ): Promise<void> => {
    setNotice(null);
    setActionError(null);
    try {
      await disable.mutateAsync(id);
      if (requiresReload) {
        window.location.assign('/plugins');
        return;
      }
      setNotice(t('plugins:disabledNotice', { name }));
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const deletePlugin = async (): Promise<void> => {
    if (!pendingDelete) return;
    setNotice(null);
    setActionError(null);
    try {
      await remove.mutateAsync(pendingDelete.id);
      if (pendingDelete.requiresReload) {
        window.location.assign('/plugins');
        return;
      }
      setNotice(t('plugins:deletedNotice', { name: pendingDelete.name }));
      setPendingDelete(null);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const busy =
    install.isPending ||
    installFromGit.isPending ||
    activate.isPending ||
    disable.isPending ||
    remove.isPending ||
    exitSafeMode.isPending;

  return (
    <ErrorBoundary name="plugins">
      <div className={styles.page} data-component="plugin-manager">
        <header className={styles.header}>
          <div>
            <span>{t('plugins:eyebrow')}</span>
            <h1>{t('plugins:title')}</h1>
            <p>{t('plugins:subtitle')}</p>
          </div>
          <Button asChild variant="primary">
            <label>
              <DownloadSimple aria-hidden="true" />
              {install.isPending ? t('plugins:installing') : t('plugins:install')}
              <input
                className={styles.fileInput}
                type="file"
                accept=".zip,.stplugin,application/zip"
                disabled={busy}
                onChange={(event) => void choosePackage(event)}
              />
            </label>
          </Button>
        </header>

        <section className={styles.security}>
          <LockKey weight="duotone" aria-hidden="true" />
          <div>
            <strong>{t('plugins:isolationTitle')}</strong>
            <p>{t('plugins:isolationHint')}</p>
          </div>
        </section>

        <form
          className={styles.gitInstall}
          data-component="plugin-git-install"
          onSubmit={(event) => void submitGitInstall(event)}
        >
          <div className={styles.gitInstallHeading}>
            <GitBranch weight="duotone" aria-hidden="true" />
            <div>
              <strong>{t('plugins:installFromGitTitle')}</strong>
              <p>{t('plugins:installFromGitHint')}</p>
            </div>
          </div>
          <div className={styles.gitInstallFields}>
            <TextField
              label={t('plugins:gitUrlLabel')}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('plugins:gitUrlPlaceholder')}
              value={gitUrl}
              disabled={busy}
              onChange={(event) => setGitUrl(event.target.value)}
            />
            <TextField
              label={t('plugins:gitRefLabel')}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('plugins:gitRefPlaceholder')}
              value={gitRef}
              disabled={busy}
              onChange={(event) => setGitRef(event.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy || gitUrl.trim().length === 0}>
              {installFromGit.isPending
                ? t('plugins:installingFromGit')
                : t('plugins:installFromGit')}
            </Button>
          </div>
        </form>

        <section className={styles.safeBanner} data-state={safeMode ? 'active' : 'inactive'}>
          <ShieldCheck weight="duotone" aria-hidden="true" />
          <div>
            <strong>{t(safeMode ? 'plugins:safeModeActive' : 'plugins:safeMode')}</strong>
            <p>{t(safeMode ? 'plugins:safeModeActiveHint' : 'plugins:safeModeHint')}</p>
          </div>
          {safeMode ? (
            <Button
              disabled={exitSafeMode.isPending}
              onClick={() => {
                window.history.replaceState(null, '', '/plugins');
                void exitSafeMode.mutateAsync().then(() => window.location.reload());
              }}
            >
              {t('plugins:exitSafeMode')}
            </Button>
          ) : (
            <Button asChild>
              <a href="/plugins?safe=1">{t('plugins:openSafeMode')}</a>
            </Button>
          )}
        </section>

        {notice ? (
          <p className={styles.notice} role="status">
            <CheckCircle weight="fill" aria-hidden="true" />
            {notice}
          </p>
        ) : null}
        {actionError ? (
          <p className={styles.error} role="alert">
            {actionError}
          </p>
        ) : null}

        <main className={styles.content}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>{t('plugins:installed')}</h2>
              <p>{t('plugins:installedHint')}</p>
            </div>
            <span>{plugins.data?.items.length ?? 0}</span>
          </div>

          {plugins.isPending ? (
            <div className={styles.empty} role="status">
              {t('common:loading')}
            </div>
          ) : plugins.isError ? (
            <div className={styles.empty} role="alert">
              <p>{errorText(plugins.error)}</p>
              <Button onClick={() => void plugins.refetch()}>{t('common:retry')}</Button>
            </div>
          ) : plugins.data?.items.length === 0 ? (
            <div className={styles.empty}>
              <Cube size={48} weight="duotone" aria-hidden="true" />
              <h3>{t('plugins:emptyTitle')}</h3>
              <p>{t('plugins:emptyHint')}</p>
            </div>
          ) : (
            <div className={styles.list}>
              {plugins.data?.items.map((plugin) => {
                const selected = approvals[plugin.id] ?? plugin.grantedPermissions;
                const allApproved = plugin.requestedPermissions.every((permission) =>
                  selected.includes(permission),
                );
                const pluginPage = pages.find((page) => page.pluginId === plugin.id);
                return (
                  <article
                    key={plugin.id}
                    className={cx('st-card', styles.card)}
                    data-component="plugin-card"
                    data-state={plugin.status}
                  >
                    <div className={styles.cardHeader}>
                      <span className={styles.pluginIcon}>
                        <Cube weight="duotone" aria-hidden="true" />
                      </span>
                      <div className={styles.identity}>
                        <div>
                          <h3>{plugin.name}</h3>
                          <p>{plugin.id}</p>
                        </div>
                        <span>v{plugin.version}</span>
                      </div>
                      <div className={styles.cardMeta}>
                        <span
                          className={styles.sourceBadge}
                          data-source={plugin.source?.type ?? 'zip'}
                          title={
                            plugin.source?.type === 'git'
                              ? t('plugins:sourceUrl', { url: plugin.source.url })
                              : undefined
                          }
                        >
                          {plugin.source?.type === 'git' ? (
                            <GitBranch aria-hidden="true" />
                          ) : (
                            <Package aria-hidden="true" />
                          )}
                          {t(
                            plugin.source?.type === 'git'
                              ? 'plugins:sourceGit'
                              : 'plugins:sourceFile',
                          )}
                        </span>
                        <span className={styles.status}>
                          {t(`plugins:status_${plugin.status}`)}
                        </span>
                      </div>
                    </div>

                    {plugin.compatibilityLevel === 'legacy-trusted' ? (
                      <div className={styles.legacyWarning} role="note">
                        <LockKey aria-hidden="true" />
                        <div>
                          <strong>{t('plugins:legacyTrustedTitle')}</strong>
                          <p>{t('plugins:legacyTrustedHint')}</p>
                        </div>
                      </div>
                    ) : null}

                    {plugin.dependencies && plugin.dependencies.length > 0 ? (
                      <div className={styles.depsWarning} role="note">
                        <Package aria-hidden="true" />
                        <div>
                          <strong>{t('plugins:depsWarningTitle')}</strong>
                          <p>{t('plugins:depsWarningHint')}</p>
                          <details className={styles.depsList}>
                            <summary>
                              {t('plugins:depsTitle')} ({plugin.dependencies.length})
                            </summary>
                            <ul>
                              {plugin.dependencies.map((dependency) => (
                                <li key={`${dependency.name}@${dependency.version}`}>
                                  <code>{dependency.name}</code>
                                  <span>v{dependency.version}</span>
                                </li>
                              ))}
                            </ul>
                            <p className={styles.depsHint}>{t('plugins:depsHint')}</p>
                          </details>
                        </div>
                      </div>
                    ) : null}

                    {plugin.requestedPermissions.length > 0 ? (
                      <fieldset className={styles.permissions}>
                        <legend>{t('plugins:permissions')}</legend>
                        <p>{t('plugins:permissionsHint')}</p>
                        {plugin.requestedPermissions.map((permission) => {
                          const added = plugin.addedPermissions.includes(permission);
                          return (
                            <label key={permission}>
                              <input
                                type="checkbox"
                                checked={selected.includes(permission)}
                                disabled={plugin.enabled || busy}
                                onChange={(event) => {
                                  setApprovals((current) => {
                                    const values = new Set(
                                      current[plugin.id] ?? plugin.grantedPermissions,
                                    );
                                    if (event.target.checked) values.add(permission);
                                    else values.delete(permission);
                                    return { ...current, [plugin.id]: [...values] };
                                  });
                                }}
                              />
                              <span>
                                <code>{permission}</code>
                                {added ? <strong>{t('plugins:newPermission')}</strong> : null}
                              </span>
                            </label>
                          );
                        })}
                      </fieldset>
                    ) : (
                      <p className={styles.noPermissions}>{t('plugins:noPermissions')}</p>
                    )}

                    <ActionBar
                      collapse="stack"
                      className={styles.actions}
                      data-part="plugin-actions"
                    >
                      <ActionBarGroup placement="primary">
                        {plugin.enabled ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void disablePlugin(plugin.id, plugin.name, plugin.hasLegacyFrontend)
                            }
                          >
                            {t('plugins:disable')}
                          </Button>
                        ) : (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={busy || safeMode || !allApproved}
                            onClick={() => void activatePlugin(plugin.id, plugin.name, selected)}
                          >
                            {t('plugins:activate')}
                          </Button>
                        )}
                        {pluginPage ? (
                          <Button asChild size="sm">
                            <SystemSurfaceLink
                              to={`/plugins/${encodeURIComponent(plugin.id)}${pluginPage.definition.path}`}
                            >
                              {t('plugins:openPage')}
                            </SystemSurfaceLink>
                          </Button>
                        ) : null}
                        {extractAuthClients(plugin.manifest).length > 0 ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => setAuthTarget({ id: plugin.id, name: plugin.name })}
                          >
                            {t('plugins:authButton')}
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          startIcon={<Trash />}
                          disabled={busy}
                          aria-label={t('plugins:deleteLabel', { name: plugin.name })}
                          onClick={() =>
                            setPendingDelete({
                              id: plugin.id,
                              name: plugin.name,
                              requiresReload: plugin.hasLegacyFrontend && plugin.enabled,
                            })
                          }
                        >
                          {t('common:delete')}
                        </Button>
                      </ActionBarGroup>
                    </ActionBar>
                  </article>
                );
              })}
            </div>
          )}
        </main>
      </div>
      <ConfirmActionDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setPendingDelete(null);
        }}
        title={t('plugins:deleteTitle')}
        description={t('plugins:deleteConfirm', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common:delete')}
        busy={remove.isPending}
        danger
        onConfirm={() => void deletePlugin()}
      />
      <PluginAuthDialog
        pluginId={authTarget?.id ?? null}
        authClients={
          authTarget
            ? extractAuthClients(
                plugins.data?.items.find((p) => p.id === authTarget.id)?.manifest ?? {},
              )
            : []
        }
        onOpenChange={(open) => {
          if (!open) setAuthTarget(null);
        }}
      />
    </ErrorBoundary>
  );
}
