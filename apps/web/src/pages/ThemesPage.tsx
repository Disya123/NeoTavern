import { CheckCircle, DownloadSimple, Palette, ShieldCheck, Trash } from '@phosphor-icons/react';
import { useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionBar, ActionBarGroup, Button, ErrorBoundary, cx } from '@neotavern/ui';
import {
  useActivateTheme,
  useDeleteTheme,
  useExitPluginSafeMode,
  useInstallTheme,
  usePlugins,
  useResetTheme,
  useThemes,
} from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import { ConfirmActionDialog } from '../components/ConfirmActionDialog.js';
import { isSafeMode } from '../theme/apply.js';
import styles from './ThemesPage.module.css';

const MAX_THEME_BYTES = 25 * 1024 * 1024;
interface ThemeDeleteTarget {
  id: string;
  name: string;
}

export function ThemesPage() {
  const { t } = useTranslation();
  const themes = useThemes();
  const plugins = usePlugins();
  const install = useInstallTheme();
  const activate = useActivateTheme();
  const reset = useResetTheme();
  const remove = useDeleteTheme();
  const exitPluginSafeMode = useExitPluginSafeMode();
  const errorText = useErrorText();
  const safeMode = isSafeMode();
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ThemeDeleteTarget | null>(null);

  const choosePackage = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice(null);
    setActionError(null);
    if (file.size > MAX_THEME_BYTES) {
      setActionError(t('themes:fileTooLarge'));
      return;
    }
    try {
      const result = await install.mutateAsync(file);
      setNotice(
        t(result.replaced ? 'themes:updatedNotice' : 'themes:installedNotice', {
          name: result.theme.name,
        }),
      );
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const activateTheme = async (id: string, name: string): Promise<void> => {
    setNotice(null);
    setActionError(null);
    try {
      await activate.mutateAsync(id);
      setNotice(t('themes:activatedNotice', { name }));
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const resetTheme = async (): Promise<void> => {
    setNotice(null);
    setActionError(null);
    try {
      await reset.mutateAsync();
      setNotice(t('themes:resetNotice'));
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const deleteTheme = async (): Promise<void> => {
    if (!pendingDelete) return;
    setNotice(null);
    setActionError(null);
    try {
      await remove.mutateAsync(pendingDelete.id);
      setNotice(t('themes:deletedNotice', { name: pendingDelete.name }));
      setPendingDelete(null);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const leaveSafeMode = async (): Promise<void> => {
    setActionError(null);
    window.history.replaceState(null, '', '/themes');
    try {
      await exitPluginSafeMode.mutateAsync();
      window.location.reload();
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const busy =
    install.isPending ||
    activate.isPending ||
    reset.isPending ||
    remove.isPending ||
    exitPluginSafeMode.isPending;

  return (
    <ErrorBoundary name="themes">
      <div className={styles.page} data-component="theme-manager">
        <header className={styles.header}>
          <div>
            <span>{t('themes:eyebrow')}</span>
            <h1>{t('themes:title')}</h1>
            <p>{t('themes:subtitle')}</p>
          </div>
          <Button asChild variant="primary">
            <label>
              <DownloadSimple aria-hidden="true" />
              {install.isPending ? t('themes:installing') : t('themes:install')}
              <input
                className={styles.fileInput}
                type="file"
                accept=".zip,.sttheme,application/zip"
                disabled={busy}
                onChange={(event) => void choosePackage(event)}
              />
            </label>
          </Button>
        </header>

        {safeMode ? (
          <section className={styles.safeBanner} role="status" data-state="active">
            <ShieldCheck weight="duotone" aria-hidden="true" />
            <div>
              <strong>{t('themes:safeModeActive')}</strong>
              <p>{t('themes:safeModeActiveHint')}</p>
            </div>
            <Button
              disabled={!plugins.data?.safeMode || exitPluginSafeMode.isPending}
              onClick={() => void leaveSafeMode()}
            >
              {t('themes:exitSafeMode')}
            </Button>
          </section>
        ) : (
          <section className={styles.safeBanner}>
            <ShieldCheck weight="duotone" aria-hidden="true" />
            <div>
              <strong>{t('themes:safeMode')}</strong>
              <p>{t('themes:safeModeHint')}</p>
            </div>
            <Button asChild>
              <a href="/themes?safe=1">{t('themes:openSafeMode')}</a>
            </Button>
          </section>
        )}

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
              <h2>{t('themes:installed')}</h2>
              <p>{t('themes:installedHint')}</p>
            </div>
            <span>{themes.data?.items.length ?? 0}</span>
          </div>

          {themes.isPending ? (
            <div className={styles.loading} role="status">
              {t('common:loading')}
            </div>
          ) : themes.isError ? (
            <div className={styles.empty} role="alert">
              <p>{errorText(themes.error)}</p>
              <Button onClick={() => void themes.refetch()}>{t('common:retry')}</Button>
            </div>
          ) : themes.data?.items.length === 0 ? (
            <div className={styles.empty}>
              <Palette size={48} weight="duotone" aria-hidden="true" />
              <h3>{t('themes:emptyTitle')}</h3>
              <p>{t('themes:emptyHint')}</p>
            </div>
          ) : (
            <div className={styles.grid}>
              {themes.data?.items.map((theme) => {
                const active = theme.id === themes.data.activeThemeId;
                return (
                  <article
                    key={theme.id}
                    className={cx('st-card', styles.card)}
                    data-component="theme-card"
                    data-state={active ? 'active' : 'inactive'}
                  >
                    <div className={styles.preview}>
                      {theme.previewUrl ? <img src={theme.previewUrl} alt="" /> : <Palette />}
                      {active ? (
                        <span>
                          <CheckCircle weight="fill" aria-hidden="true" />
                          {t('themes:active')}
                        </span>
                      ) : null}
                    </div>
                    <div className={styles.cardBody}>
                      <div className={styles.identity}>
                        <div>
                          <h3>{theme.name}</h3>
                          <p>{theme.id}</p>
                        </div>
                        <span>v{theme.version}</span>
                      </div>
                      <ActionBar
                        collapse="stack"
                        className={styles.actions}
                        data-part="theme-actions"
                      >
                        <ActionBarGroup placement="primary">
                          {!active ? (
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={busy || safeMode}
                              onClick={() => void activateTheme(theme.id, theme.name)}
                            >
                              {t('themes:activate')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              disabled={busy || safeMode}
                              onClick={() => void resetTheme()}
                            >
                              {t('themes:useBuiltIn')}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            startIcon={<Trash />}
                            disabled={busy}
                            aria-label={t('themes:deleteLabel', { name: theme.name })}
                            onClick={() => setPendingDelete({ id: theme.id, name: theme.name })}
                          >
                            {t('common:delete')}
                          </Button>
                        </ActionBarGroup>
                      </ActionBar>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          <section className={styles.creatorKit} data-component="theme-starter-kit">
            <div>
              <h2>{t('themes:creatorKitTitle')}</h2>
              <p>{t('themes:creatorKitHint')}</p>
              <small>{t('themes:creatorKitFiles')}</small>
            </div>
            <ActionBar
              align="end"
              collapse="stack"
              className={styles.creatorActions}
              data-part="theme-starter-actions"
            >
              <ActionBarGroup placement="primary">
                <Button asChild variant="primary">
                  <a href="/theme-starter.zip" download>
                    <DownloadSimple aria-hidden="true" />
                    {t('themes:downloadStarter')}
                  </a>
                </Button>
              </ActionBarGroup>
            </ActionBar>
          </section>

          {themes.data?.activeThemeId ? (
            <ActionBar
              align="split"
              collapse="stack"
              className={styles.resetRow}
              data-part="theme-reset-actions"
            >
              <ActionBarGroup placement="primary">
                <div>
                  <strong>{t('themes:builtInTitle')}</strong>
                  <p>{t('themes:builtInHint')}</p>
                </div>
              </ActionBarGroup>
              <ActionBarGroup placement="secondary">
                <Button disabled={busy || safeMode} onClick={() => void resetTheme()}>
                  {t('themes:useBuiltIn')}
                </Button>
              </ActionBarGroup>
            </ActionBar>
          ) : null}
        </main>
      </div>
      <ConfirmActionDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setPendingDelete(null);
        }}
        title={t('themes:deleteTitle')}
        description={t('themes:deleteConfirm', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common:delete')}
        busy={remove.isPending}
        danger
        onConfirm={() => void deleteTheme()}
      />
    </ErrorBoundary>
  );
}
